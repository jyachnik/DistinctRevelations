/* ============================================================================
   Resource Overallocation / Capacity — a forward-looking view of the SAME
   time-phased data Resource Hours already imports (project doc field
   resourceHoursWeekly[], from MS Project's Resource Usage report), showing
   which resources are scheduled for MORE work than their available
   capacity in each remaining week of the project — the "who's over-
   committed in the upcoming weeks" gap the Resource Hours card's own
   totals don't answer (those are whole-project sums, not week-by-week).
   Read-only, no writes, no new Firestore field.

   Split into two collapsible groups — "Project Team - Internal" and
   "Project Team - External Vendors" — by whether the resource's name
   contains "vendor" (case-insensitive). Each group has its own sticky
   header row (period/date labels) and sticky first column (resource
   names), same real-scroll-container + position:sticky technique as the
   combined WBS/Gantt view (gantt.js) — no JS scroll syncing needed since
   each group's own grid is a single scrolling box, not two panes.

   Each imported period row already carries both figures needed for this —
   workAvailability (capacity) and work (scheduled/assigned) — so
   "overallocated" is just work > workAvailability, no new computation
   model, same >100% convention that would show up in MS Project itself.
   Periods shown are every upcoming period present in the imported data
   (periodStart >= today) — since that import only ever covers the
   project's own schedule, "all upcoming periods" already IS "the
   remaining weeks of the project," with no separate end-date lookup
   needed.

   Firestore: businesses/{biz}/projects/{proj} — project doc field
   resourceHoursWeekly[]  (read-only here; owned by resourceHours.js)
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[resource-capacity]';
  var VENDOR_RE = /vendor/i;

  var ctx = { biz: null, proj: null, isOwner: false, weeklyRows: [] };
  var collapsed = { internal: false, external: true }; // vendors start collapsed by default
  var card, bodyEl;

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function toDate(v) { if (!v) return null; var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function dateOnly(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function fmtHours(v) { return (typeof v === 'number' && !isNaN(v)) ? v.toFixed(1) + 'h' : '—'; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }

  function allocPct(cell) {
    if (!cell || !(cell.workAvailability > 0)) return null;
    return (cell.work / cell.workAvailability) * 100;
  }
  function severityClass(pct) {
    if (pct == null) return 'rc-empty-cell';
    if (pct > 110) return 'rc-high';
    if (pct >= 90) return 'rc-medium';
    return 'rc-low';
  }

  function buildMatrix() {
    var today = dateOnly(new Date());
    var upcoming = (ctx.weeklyRows || []).filter(function (r) { var d = toDate(r.periodStart); return d && dateOnly(d) >= today; });

    var periodsByLabel = {};
    upcoming.forEach(function (r) { if (!periodsByLabel[r.periodLabel]) periodsByLabel[r.periodLabel] = { label: r.periodLabel, start: toDate(r.periodStart) }; });
    // No cap — every remaining period in the imported schedule, since that
    // import already only ever spans the project's own remaining weeks.
    var periods = Object.keys(periodsByLabel).map(function (k) { return periodsByLabel[k]; })
      .sort(function (a, b) { return a.start - b.start; });
    var periodLabelSet = {};
    periods.forEach(function (p) { periodLabelSet[p.label] = true; });

    var internalResources = [], externalResources = [];
    var seen = {};
    upcoming.forEach(function (r) {
      if (seen[r.resource]) return;
      seen[r.resource] = true;
      (VENDOR_RE.test(r.resource || '') ? externalResources : internalResources).push(r.resource);
    });
    internalResources.sort();
    externalResources.sort();

    var cellByKey = {};
    upcoming.forEach(function (r) { if (periodLabelSet[r.periodLabel]) cellByKey[r.resource + '|' + r.periodLabel] = r; });

    return { periods: periods, internalResources: internalResources, externalResources: externalResources, cellByKey: cellByKey };
  }

  function renderGroupGrid(groupKey, resources, matrix) {
    var cols = matrix.periods.length;
    var html = '<div class="rc-grid" id="rcGrid-' + groupKey + '"><div class="rc-grid-inner" style="grid-template-columns:96px repeat(' + cols + ', minmax(34px, 1fr));">';
    html += '<div class="rc-corner"></div>';
    matrix.periods.forEach(function (p) { html += '<div class="rc-col-label">' + esc(p.label) + '</div>'; });
    resources.forEach(function (res) {
      html += '<div class="rc-row-label">' + esc(res) + '</div>';
      matrix.periods.forEach(function (p) {
        var cell = matrix.cellByKey[res + '|' + p.label];
        var pct = allocPct(cell);
        var cls = severityClass(pct);
        var text = pct == null ? '' : Math.round(pct) + '%';
        html += '<div class="rc-cell ' + cls + '" data-res="' + esc(res) + '" data-period="' + esc(p.label) + '" title="' + esc(res) + ' — ' + esc(p.label) + '">' + text + '</div>';
      });
    });
    html += '</div></div>';
    return html;
  }

  function renderGroup(groupKey, label, resources, matrix) {
    if (!resources.length) return '';
    var isCollapsed = !!collapsed[groupKey];
    var html = '<div class="rc-group">' +
      '<button type="button" class="rc-group-toggle" data-group="' + groupKey + '" aria-expanded="' + (!isCollapsed) + '">' +
      '<span class="rc-group-arrow">' + (isCollapsed ? '▸' : '▾') + '</span>' + esc(label) +
      ' <span class="rc-group-count">(' + resources.length + ')</span></button>';
    if (!isCollapsed) html += renderGroupGrid(groupKey, resources, matrix);
    html += '</div>';
    return html;
  }

  function render() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('resourceCapacityCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !bodyEl) return;

    var empty = document.getElementById('rcEmpty');
    var matrix = buildMatrix();
    var totalResources = matrix.internalResources.length + matrix.externalResources.length;
    if (!totalResources || !matrix.periods.length) {
      bodyEl.hidden = true;
      if (empty) empty.hidden = false;
      if (window.drInsight) window.drInsight.set('resourceCapacityCard', '');
      return;
    }
    if (empty) empty.hidden = true;
    bodyEl.hidden = false;

    bodyEl.innerHTML =
      renderGroup('internal', 'Project Team - Internal', matrix.internalResources, matrix) +
      renderGroup('external', 'Project Team - External Vendors', matrix.externalResources, matrix);

    if (window.drInsight) {
      var nextPeriodLabel = matrix.periods[0] ? matrix.periods[0].label : null;
      var allResources = matrix.internalResources.concat(matrix.externalResources);
      var overNext = 0, overAny = {};
      allResources.forEach(function (res) {
        matrix.periods.forEach(function (p) {
          var pct = allocPct(matrix.cellByKey[res + '|' + p.label]);
          if (pct != null && pct > 100) {
            overAny[res] = true;
            if (p.label === nextPeriodLabel) overNext++;
          }
        });
      });
      var overAnyCount = Object.keys(overAny).length;
      var text = overAnyCount
        ? overAnyCount + ' resource' + (overAnyCount === 1 ? '' : 's') + ' over capacity in at least one of the remaining ' + matrix.periods.length + ' week' + (matrix.periods.length === 1 ? '' : 's') + (overNext ? ', ' + overNext + ' of them already over in ' + nextPeriodLabel + '.' : '.')
        : 'No resource is over capacity in the remaining ' + matrix.periods.length + ' week' + (matrix.periods.length === 1 ? '' : 's') + '.';
      window.drInsight.set('resourceCapacityCard', text);
    }
  }

  function showCellDetail(res, periodLabel) {
    var matrix = buildMatrix();
    var cell = matrix.cellByKey[res + '|' + periodLabel];
    if (!window.drModal) return;
    var html = cell
      ? '<p><strong>Available:</strong> ' + fmtHours(cell.workAvailability) + '</p>' +
        '<p><strong>Scheduled:</strong> ' + fmtHours(cell.work) + '</p>' +
        '<p><strong>Remaining Availability:</strong> ' + fmtHours(cell.remainingAvailability) + '</p>' +
        '<p><strong>Actual so far:</strong> ' + fmtHours(cell.actualWork) + '</p>'
      : '<p>No data for this resource/period.</p>';
    window.drModal.open({ title: esc(res) + ' — ' + esc(periodLabel), bodyHtml: html });
  }

  function bindBodyEvents() {
    if (!bodyEl) return;
    bodyEl.addEventListener('click', function (ev) {
      var toggle = ev.target.closest('.rc-group-toggle');
      if (toggle) {
        var g = toggle.getAttribute('data-group');
        collapsed[g] = !collapsed[g];
        render();
        return;
      }
      var cell = ev.target.closest('.rc-cell');
      if (cell) showCellDetail(cell.getAttribute('data-res'), cell.getAttribute('data-period'));
    });
  }

  function listenWeekly() {
    var ref = projRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      ctx.weeklyRows = Array.isArray(data.resourceHoursWeekly) ? data.resourceHoursWeekly : [];
      render();
    }, function (err) { console.warn(ns, 'listen error (expected if not granted view access)', err && err.code); });
  }

  function init() {
    card = document.getElementById('resourceCapacityCard');
    bodyEl = document.getElementById('rcBody');
    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    if (!ctx.biz || !card) return;

    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    var userEmail = (user && user.email) || '';
    ctx.isOwner = !!userEmail && userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();

    bindBodyEvents();
    listenWeekly();
    if (window.drAccess) window.drAccess.whenReady().then(render);
    else render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
