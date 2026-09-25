/* ============================================================================
   Risk Heat Map — a Probability x Impact grid view of the SAME riskRegister
   data the Risk Register card already reads (project doc field
   riskRegister[]), for an at-a-glance "where's our risk exposure clustered"
   read that a table can't give. Read-only, no writes, no new Firestore
   field — pure re-presentation, same precedent as Executive Roadmap.

   Grid: Impact 5 (top) down to 1 (bottom) on the rows, Probability 1 (left)
   to 5 (right) on the columns — the standard PM risk-matrix orientation.
   Each cell shows how many OPEN risks (status not resolved/closed, same
   "open" definition riskAssumptions.js already uses) landed at that exact
   probability/impact pair, colored by score (probability x impact) using
   the same severity thresholds riskAssumptions.js's riskSeverity() already
   uses (>=15 high, >=8 medium, else low). Click a cell to see which risks
   are in it.

   Firestore: businesses/{biz}/projects/{proj} — project doc field
   riskRegister[]  (read-only here; owned by riskAssumptions.js)
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[risk-heat-map]';
  var ctx = { biz: null, proj: null, isOwner: false, risks: [] };
  var card, gridEl;

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function isOpen(status) { return !/^(closed|resolved)$/i.test(String(status || '').trim()); }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
  function severityClass(score) { return score >= 15 ? 'rhm-high' : score >= 8 ? 'rhm-medium' : 'rhm-low'; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }

  function openRisksAt(p, i) {
    return ctx.risks.filter(function (r) { return num(r.probability) === p && num(r.impact) === i && isOpen(r.status); });
  }

  function render() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('riskHeatMapCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !gridEl) return;

    var openRisks = ctx.risks.filter(function (r) { return isOpen(r.status); });
    var empty = document.getElementById('rhmEmpty');
    if (!openRisks.length) {
      gridEl.hidden = true;
      if (empty) empty.hidden = false;
      if (window.drInsight) window.drInsight.set('riskHeatMapCard', '');
      return;
    }
    if (empty) empty.hidden = true;
    gridEl.hidden = false;

    var rowsHtml = '';
    for (var impact = 5; impact >= 1; impact--) {
      rowsHtml += '<div class="rhm-row-label">' + impact + '</div>';
      for (var prob = 1; prob <= 5; prob++) {
        var cellRisks = openRisksAt(prob, impact);
        var score = prob * impact;
        var cls = cellRisks.length ? severityClass(score) : 'rhm-empty-cell';
        rowsHtml += '<div class="rhm-cell ' + cls + '" data-prob="' + prob + '" data-impact="' + impact + '" title="Probability ' + prob + ' x Impact ' + impact + ' = ' + score + '">' +
          (cellRisks.length ? cellRisks.length : '') + '</div>';
      }
    }
    var axisRow = '<div class="rhm-row-label"></div>';
    for (var pAxis = 1; pAxis <= 5; pAxis++) axisRow += '<div class="rhm-col-label">' + pAxis + '</div>';

    gridEl.innerHTML = '<div class="rhm-grid-inner">' + rowsHtml + axisRow + '</div>';

    if (window.drInsight) {
      var high = openRisks.filter(function (r) { return (num(r.probability) || 0) * (num(r.impact) || 0) >= 15; }).length;
      var med = openRisks.filter(function (r) { var s = (num(r.probability) || 0) * (num(r.impact) || 0); return s >= 8 && s < 15; }).length;
      var low = openRisks.length - high - med;
      window.drInsight.set('riskHeatMapCard', openRisks.length + ' open risk' + (openRisks.length === 1 ? '' : 's') + ' plotted — ' + high + ' high, ' + med + ' medium, ' + low + ' low exposure.');
    }
  }

  function showCellDetail(prob, impact) {
    var risks = openRisksAt(prob, impact);
    if (!window.drModal) return;
    var html = risks.length ? '<ul style="margin:0;padding-left:18px;">' + risks.map(function (r) {
      return '<li style="margin-bottom:8px;"><strong>' + esc(r.description || r.id || 'Untitled risk') + '</strong>' +
        (r.owner ? ' — ' + esc(r.owner) : '') + (r.status ? ' <em>(' + esc(r.status) + ')</em>' : '') + '</li>';
    }).join('') + '</ul>' : '<p>No open risks in this cell.</p>';
    window.drModal.open({ title: 'Probability ' + prob + ' x Impact ' + impact + ' (score ' + (prob * impact) + ')', bodyHtml: html });
  }

  function bindGridEvents() {
    if (!gridEl) return;
    gridEl.addEventListener('click', function (ev) {
      var cell = ev.target.closest('.rhm-cell');
      if (!cell) return;
      showCellDetail(parseInt(cell.getAttribute('data-prob'), 10), parseInt(cell.getAttribute('data-impact'), 10));
    });
  }

  function listenRisks() {
    var ref = projRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      ctx.risks = Array.isArray(data.riskRegister) ? data.riskRegister : [];
      render();
    }, function (err) { console.warn(ns, 'listen error (expected if not granted view access)', err && err.code); });
  }

  function init() {
    card = document.getElementById('riskHeatMapCard');
    gridEl = document.getElementById('rhmGrid');
    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    if (!ctx.biz || !card) return;

    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    var userEmail = (user && user.email) || '';
    ctx.isOwner = !!userEmail && userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();

    bindGridEvents();
    listenRisks();
    if (window.drAccess) window.drAccess.whenReady().then(render);
    else render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
