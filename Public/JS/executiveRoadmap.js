/* ============================================================================
   Executive Roadmap — a read-only, simplified view of the SAME schedule
   data the Gantt Timeline already shows: only top-level phases (as
   date-range bars) and milestones (as dots) on one horizontal line, colored
   by the same RAG convention as every other card, for a five-second "where
   are we" read. No writes, no new Firestore collection — pure
   re-presentation of milestones/activities.

   "Phase" isn't a stored flag — a WBS summary row (isSummary===true) can be
   a top phase ("1.0 Planning") or a nested one ("1.1 Requirements"), both
   flagged the same way, and WBS numbering isn't consistent between imports
   ("1" vs "1.0"). So top-level is DERIVED: compute each summary row's WBS
   depth and treat only the shallowest depth present as phases — adapts to
   whichever numbering convention the import used.

   Reuses window.drBurndownInternals.normalizeTask() (burndown.js) for the
   milestone/activity -> task shape, and window.drRag.compute() (dr-rag.js)
   for status coloring — the exact same functions Gantt/Burndown use, so
   this card can never show a different verdict than they do.

   Firestore: businesses/{biz}/projects/{proj}/milestones   (read-only here)
              businesses/{biz}/projects/{proj}/activities   (read-only here)
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[executiveRoadmap]';
  var CARD_ID = 'executiveRoadmapCard';
  var SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var ctx = { biz: null, proj: null, isOwner: false, milestoneDocs: [], activityDocs: [], phases: [], milestones: [] };
  var card;

  function $(sel) { return document.querySelector(sel); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function fmtShort(d) { return d ? (SHORT_MONTHS[d.getMonth()] + ' ' + d.getDate()) : ''; }

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() { return getDB().collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default'); }

  // Top-level phases: NOT simply the shallowest WBS depth among summary rows — real schedules
  // (confirmed against this project's actual data) have a single whole-project wrapper row at
  // the shallowest depth (WBS "0", and often one lone "1" immediately under it spanning nearly
  // the entire project) before the schedule actually subdivides into real phases one level
  // deeper. A single all-encompassing bar isn't a useful roadmap. So: drop the conventional
  // WBS "0" project-root row outright, then walk depths shallowest-first and use the first one
  // that has MORE THAN ONE row — a level with just one summary is still a wrapper, not a
  // breakdown; a level with several is the real phase list, whatever depth that happens to be.
  function wbsDepth(wbs) { return wbs ? (String(wbs).match(/\./g) || []).length : 0; }
  function topLevelPhases(summaries) {
    var real = summaries.filter(function (s) { return String(s.wbs) !== '0'; });
    if (!real.length) return [];
    var byDepth = {};
    real.forEach(function (s) { var d = wbsDepth(s.wbs); (byDepth[d] = byDepth[d] || []).push(s); });
    var depths = Object.keys(byDepth).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < depths.length; i++) {
      if (byDepth[depths[i]].length > 1) return byDepth[depths[i]];
    }
    return byDepth[depths[0]]; // fallback: the data only ever has one summary row, period
  }

  function recompute() {
    var BI = window.drBurndownInternals;
    if (!BI) { ctx.phases = []; ctx.milestones = []; render(); return; }
    var all = [];
    ctx.milestoneDocs.forEach(function (item) { var t = BI.normalizeTask(item, 'milestones'); if (t) all.push(t); });
    ctx.activityDocs.forEach(function (item) { var t = BI.normalizeTask(item, 'activities'); if (t) all.push(t); });
    var summaries = all.filter(function (t) { return t.isSummary; });
    ctx.phases = topLevelPhases(summaries).filter(function (t) { return t.start && t.due; });
    ctx.milestones = all.filter(function (t) { return t.isMilestone && !t.isSummary && t.due; });
    render();
  }

  function statusCode(t) {
    if (!window.drRag) return t.bucket === 'completed' ? 'done' : 'green';
    return window.drRag.compute(t.start, t.due, t.bucket === 'completed').code;
  }
  function colorClass(code) {
    if (code === 'red') return 'roadmap-red';
    if (code === 'amber') return 'roadmap-amber';
    if (code === 'done') return 'roadmap-done';
    if (code === 'none') return 'roadmap-none';
    return 'roadmap-green';
  }

  function render() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView) return;

    var wrap = $('#roadmapWrap'), empty = $('#roadmapEmpty');
    var phasesEl = $('#roadmapPhases'), msEl = $('#roadmapMilestones'), axisEl = $('#roadmapAxis'), todayEl = $('#roadmapToday');
    if (!wrap) return;

    var phases = ctx.phases, milestones = ctx.milestones;
    var dated = phases.concat(milestones);
    if (!dated.length) { wrap.hidden = true; if (empty) empty.hidden = false; return; }
    if (empty) empty.hidden = true;
    wrap.hidden = false;

    var today = new Date(); today.setHours(0, 0, 0, 0);
    var minDate = dated.reduce(function (m, t) { return t.start < m ? t.start : m; }, dated[0].start || dated[0].due);
    var maxDate = dated.reduce(function (m, t) { return t.due > m ? t.due : m; }, dated[0].due);
    if (today < minDate) minDate = today;
    if (today > maxDate) maxDate = today;
    // Padding below is only to keep a bar/dot sitting exactly at the edge
    // from looking visually clipped — it never changes what's actually on
    // the timeline, just leaves it a little breathing room at each end.
    var span0 = maxDate - minDate || 86400000;
    var pad = span0 * 0.04;
    minDate = new Date(minDate.getTime() - pad);
    maxDate = new Date(maxDate.getTime() + pad);
    var span = maxDate - minDate;

    function pct(d) { return Math.max(0, Math.min(100, (d - minDate) / span * 100)); }

    phasesEl.hidden = !phases.length;
    // Waterfall stacking, not one crowded row — phases with overlapping
    // date ranges are real (parallel workstreams), so cramming them onto
    // a single row would silently hide the overlap by drawing one bar on
    // top of another. Instead: sort by start date, greedily place each
    // bar in the first row whose last-placed bar doesn't overlap it
    // (same "first available row" technique the milestone label
    // collision-avoidance below already uses, just keyed off real
    // date-range overlap in % instead of a minimum pixel gap), and grow
    // the track only as many rows deep as this data actually needs.
    if (phases.length) {
      var BAR_HEIGHT = 24, BAR_TOP0 = 8, BAR_ROW_GAP = 6;
      var sortedPhases = phases.slice().sort(function (a, b) { return a.start - b.start; });
      var rowEndPct = [], maxPhaseRow = 0;
      phasesEl.innerHTML = sortedPhases.map(function (t) {
        var left = pct(t.start), width = Math.max(pct(t.due) - left, 1.2);
        var right = left + width;
        var row = 0;
        while (rowEndPct[row] != null && left < rowEndPct[row]) row++;
        rowEndPct[row] = right;
        maxPhaseRow = Math.max(maxPhaseRow, row);
        var top = BAR_TOP0 + row * (BAR_HEIGHT + BAR_ROW_GAP);
        var code = statusCode(t);
        return '<div class="roadmap-bar ' + colorClass(code) + '" style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%;top:' + top + 'px" title="' +
          esc(t.title) + ' (' + fmtShort(t.start) + '–' + fmtShort(t.due) + ')"><span class="roadmap-bar-label">' + esc(t.title) + '</span></div>';
      }).join('');
      phasesEl.style.height = (BAR_TOP0 + (maxPhaseRow + 1) * (BAR_HEIGHT + BAR_ROW_GAP)) + 'px';
    } else {
      phasesEl.innerHTML = '';
      phasesEl.style.height = '';
    }

    msEl.hidden = !milestones.length;
    // Real collision avoidance, not a fixed above/below alternation — a plain odd/even
    // alternation still collides once 3+ milestones cluster within the same few pixels (two
    // "below" labels, or two "above" labels, can still land on top of each other). Instead:
    // sort by date, measure the track's actual rendered width, and greedily place each label
    // into the first vertical "row" whose most recently placed label is far enough away in
    // real pixels; rows alternate below/above/below-farther/above-farther/... so the layout
    // grows only as many tiers as the current data actually needs.
    if (milestones.length) {
      var trackWidth = msEl.getBoundingClientRect().width || msEl.offsetWidth || 600;
      var sortedMs = milestones.slice().sort(function (a, b) { return a.due - b.due; });
      // The label now carries the milestone's FULL title (never truncated
      // with "…" — see .roadmap-dot-desc's wrap in metrics.css), wrapped
      // to a fixed ~170px-wide block rather than clipped to one line. Two
      // labels sharing a row need real horizontal room to keep those
      // wider, possibly multi-line blocks from touching — MIN_GAP_PX and
      // TIER_STEP are sized for that worst case (a long title wrapping to
      // 3 lines), not just a short one.
      var MIN_GAP_PX = 190, TIER_GAP = 16, TIER_STEP = 62;
      var rowLastPx = [], maxAboveTier = 0, maxBelowTier = 0;
      msEl.innerHTML = sortedMs.map(function (t) {
        var leftPct = pct(t.due), code = statusCode(t);
        var px = leftPct / 100 * trackWidth;
        var row = 0;
        while (rowLastPx[row] != null && (px - rowLastPx[row]) < MIN_GAP_PX) row++;
        rowLastPx[row] = px;
        var tier = Math.floor(row / 2), above = row % 2 === 1;
        if (above) maxAboveTier = Math.max(maxAboveTier, tier); else maxBelowTier = Math.max(maxBelowTier, tier);
        var offset = TIER_GAP + tier * TIER_STEP;
        var dateStyle = above ? ('bottom:' + offset + 'px;top:auto') : ('top:' + offset + 'px');
        // A visible leader line from the dot out to its label, alternating
        // up/down with the label itself — without it, a label offset into
        // a farther tier reads as floating, disconnected from which dot
        // it actually belongs to once several cluster close together.
        var lineStyle = above ? ('bottom:12px;top:auto;height:' + offset + 'px') : ('top:12px;height:' + offset + 'px');
        return '<div class="roadmap-dot ' + colorClass(code) + '" style="left:' + leftPct.toFixed(2) + '%" title="' +
          esc(t.title) + ' (' + fmtShort(t.due) + ')"><span class="roadmap-dot-line" style="' + lineStyle + '"></span>' +
          '<span class="roadmap-dot-date" style="' + dateStyle + '"><span class="roadmap-dot-desc">' + esc(t.title) + '</span>' +
          '<span class="roadmap-dot-date-value">' + fmtShort(t.due) + '</span></span></div>';
      }).join('');
      // Grow the dot's headroom/legroom (and the track itself) to fit however many tiers this
      // data actually needed, so labels never spill into the phase bar above or the axis below.
      var dotTop = TIER_GAP + (maxAboveTier + 1) * TIER_STEP + 6;
      msEl.querySelectorAll('.roadmap-dot').forEach(function (el) { el.style.top = dotTop + 'px'; });
      msEl.style.height = (dotTop + 12 + TIER_GAP + (maxBelowTier + 1) * TIER_STEP) + 'px';
    } else {
      msEl.innerHTML = '';
      msEl.style.height = '';
    }

    var todayLeft = pct(today);
    if (todayEl) todayEl.style.left = todayLeft.toFixed(2) + '%';
    // No start/end date labels here anymore (per explicit request) — the
    // Today line plus each phase/milestone's own date already say
    // everything the axis used to, without a redundant boundary date.
    if (axisEl) axisEl.innerHTML = '';
  }

  function listen() {
    projRef().collection('milestones').onSnapshot(function (snap) {
      ctx.milestoneDocs = snap.docs.map(function (d) { return { id: d.id, data: d.data() || {} }; });
      recompute();
    }, function (err) { console.warn(ns, 'milestones listen error', err && err.code); });
    projRef().collection('activities').onSnapshot(function (snap) {
      ctx.activityDocs = snap.docs.map(function (d) { return { id: d.id, data: d.data() || {} }; });
      recompute();
    }, function (err) { console.warn(ns, 'activities listen error', err && err.code); });
  }

  function init() {
    card = document.getElementById(CARD_ID);
    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    if (!ctx.biz || !card) return;
    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    var userEmail = (user && user.email) || '';
    ctx.isOwner = !!userEmail && userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
    listen();
    if (window.drAccess) window.drAccess.whenReady().then(render);
    else render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
