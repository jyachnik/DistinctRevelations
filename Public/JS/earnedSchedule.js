/* ============================================================================
   Earned Schedule (ES) — an extension to EVM that expresses schedule
   performance in TIME rather than dollars, fixing a known limitation of the
   dollar-based Schedule Variance/SPI shown on the EVM card: SV($) converges
   to zero as a project nears its planned finish even if it's genuinely
   running late (once all planned work's due dates have passed, PV stops
   growing, so EV can "catch up" to PV in dollar terms without the project
   actually finishing on time). Earned Schedule doesn't have that problem —
   it keeps measuring real time lost/gained all the way to actual finish.

   Computed from the EXACT SAME PV/EV curve the EVM card itself builds
   (window.drBurndownInternals.computeEVM/buildPeriodTimeline/buildTasksFrom
   — the same normalizer/curve-builder Executive Roadmap and the EVM card
   already use), so this can never disagree with EVM's own numbers. Nothing
   new is stored — pure read-only re-derivation.

     ES  = the point on the PV curve where cumulative PV equals today's
           actual Earned Value (interpolated between the two nearest
           weekly PV samples)
     AT  = actual time elapsed (today - project start)
     SV(t)  = ES - AT            (days ahead of/behind schedule)
     SPI(t) = ES / AT            (time-based schedule performance index)
     Forecast finish (time-based) = project start + (planned duration / SPI(t))

   Firestore: businesses/{biz}/projects/{proj}/milestones, /activities
   (read-only here; owned by gantt.js/burndown.js), project doc field
   projectCPI (read-only, same field the EVM card itself reads)
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[earned-schedule]';
  var ctx = { biz: null, proj: null, isOwner: false, milestoneDocs: [], activityDocs: [], projectCPI: null };
  var card, bodyEl;

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function fmtDate(d) { return d ? (window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString()) : '—'; }
  function fmtDays(n) { return (typeof n === 'number' && !isNaN(n)) ? (Math.round(n * 10) / 10) + ' day' + (Math.abs(Math.round(n * 10) / 10) === 1 ? '' : 's') : '—'; }
  function lastKnown(arr) { for (var i = arr.length - 1; i >= 0; i--) { if (arr[i] != null) return arr[i]; } return null; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }

  function computeES(BI) {
    var tasks = BI.buildTasksFrom(ctx.milestoneDocs, ctx.activityDocs, false);
    if (!tasks.length) return null;
    var today = new Date();
    var timeline = BI.buildPeriodTimeline(tasks, 'week', today);
    if (!timeline.length) return null;
    var evmData = BI.computeEVM(tasks, timeline, today, ctx.projectCPI);
    if (!evmData.hasCostData) return null;

    var evNow = lastKnown(evmData.ev);
    if (evNow == null) return null;

    var pv = evmData.pv;
    var esDate = null;
    if (evNow <= pv[0]) esDate = timeline[0];
    else if (evNow >= pv[pv.length - 1]) esDate = timeline[timeline.length - 1];
    else {
      for (var i = 0; i < pv.length - 1; i++) {
        if (pv[i] <= evNow && evNow <= pv[i + 1]) {
          var frac = (pv[i + 1] - pv[i]) > 0 ? (evNow - pv[i]) / (pv[i + 1] - pv[i]) : 0;
          esDate = new Date(timeline[i].getTime() + frac * (timeline[i + 1].getTime() - timeline[i].getTime()));
          break;
        }
      }
      if (!esDate) esDate = timeline[timeline.length - 1];
    }

    var projectStart = timeline[0], plannedFinish = timeline[timeline.length - 1];
    var atDays = Math.max(0, (today - projectStart) / 86400000);
    var esDays = Math.max(0, (esDate - projectStart) / 86400000);
    var svDays = esDays - atDays;
    var spiT = atDays > 0 ? esDays / atDays : null;
    var plannedDurationDays = (plannedFinish - projectStart) / 86400000;
    var forecastFinish = (spiT && spiT > 0) ? new Date(projectStart.getTime() + (plannedDurationDays / spiT) * 86400000) : null;

    return { esDate: esDate, atDays: atDays, esDays: esDays, svDays: svDays, spiT: spiT, projectStart: projectStart, plannedFinish: plannedFinish, forecastFinish: forecastFinish };
  }

  function statusClass(spiT) {
    if (spiT == null) return 'severity-unknown';
    if (spiT >= 1) return 'severity-low';
    if (spiT >= 0.9) return 'severity-medium';
    return 'severity-high';
  }

  function render() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('earnedScheduleCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !bodyEl) return;

    var BI = window.drBurndownInternals;
    var empty = document.getElementById('esEmpty');
    var es = BI ? computeES(BI) : null;

    if (!es) {
      bodyEl.hidden = true;
      if (empty) empty.hidden = false;
      if (window.drInsight) window.drInsight.set('earnedScheduleCard', '');
      return;
    }
    if (empty) empty.hidden = true;
    bodyEl.hidden = false;

    var cls = statusClass(es.spiT);
    bodyEl.innerHTML =
      '<div class="es-tiles">' +
      '<div class="es-tile"><span class="es-label">Actual Time (AT)</span><span class="es-value">' + fmtDays(es.atDays) + '</span></div>' +
      '<div class="es-tile"><span class="es-label">Earned Schedule (ES)</span><span class="es-value">' + fmtDays(es.esDays) + '</span></div>' +
      '<div class="es-tile"><span class="es-label">SV(t)</span><span class="es-value"><span class="severity-badge ' + cls + '">' + (es.svDays >= 0 ? '+' : '') + fmtDays(es.svDays) + '</span></span></div>' +
      '<div class="es-tile"><span class="es-label">SPI(t)</span><span class="es-value"><span class="severity-badge ' + cls + '">' + (es.spiT != null ? es.spiT.toFixed(2) : '—') + '</span></span></div>' +
      '<div class="es-tile"><span class="es-label">Forecast Finish (time-based)</span><span class="es-value">' + fmtDate(es.forecastFinish) + '</span></div>' +
      '<div class="es-tile"><span class="es-label">Planned Finish</span><span class="es-value">' + fmtDate(es.plannedFinish) + '</span></div>' +
      '</div>' +
      '<p class="es-note">SV(t)/SPI(t) measure schedule performance in TIME, not dollars — unlike EVM\'s dollar-based SV/SPI, this stays meaningful all the way to actual finish, even once planned work\'s due dates have passed.</p>';

    if (window.drInsight) {
      var behindAhead = es.svDays >= 0 ? 'ahead of' : 'behind';
      window.drInsight.set('earnedScheduleCard', 'Earned Schedule is ' + fmtDays(es.esDays) + ' against ' + fmtDays(es.atDays) + ' elapsed — ' +
        fmtDays(Math.abs(es.svDays)) + ' ' + behindAhead + ' schedule (SPI(t) ' + (es.spiT != null ? es.spiT.toFixed(2) : '—') + '), forecast finish ' + fmtDate(es.forecastFinish) + '.');
    }
  }

  function listen() {
    var p = projRef();
    if (!p) return;
    p.onSnapshot(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      ctx.projectCPI = typeof data.projectCPI === 'number' ? data.projectCPI : null;
      render();
    }, function (err) { console.warn(ns, 'project doc listen error', err && err.code); });
    p.collection('milestones').onSnapshot(function (snap) {
      ctx.milestoneDocs = snap.docs.map(function (d) { return { id: d.id, data: d.data() || {} }; });
      render();
    }, function (err) { console.warn(ns, 'milestones listen error', err && err.code); });
    p.collection('activities').onSnapshot(function (snap) {
      ctx.activityDocs = snap.docs.map(function (d) { return { id: d.id, data: d.data() || {} }; });
      render();
    }, function (err) { console.warn(ns, 'activities listen error', err && err.code); });
  }

  function init() {
    card = document.getElementById('earnedScheduleCard');
    bodyEl = document.getElementById('esBody');
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
