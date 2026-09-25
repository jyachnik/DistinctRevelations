/* ============================================================================
   Risk Reserve / Contingency Burn-down — tracks the contingency reserve
   dollars set aside for known risks, and how much has been drawn down as
   those risks were actually realized, over time. Distinct from CPI/EVM
   (which measure cost efficiency against the whole budget) — a mature
   PMO tracks contingency reserve separately, since drawing on it is
   expected/planned-for, not itself a cost overrun signal.

   Owner sets the Total Reserve once (editable); each draw against it is an
   append-only ledger entry (amount, date, optional linked risk, note) —
   no edit, only add/delete, same "ledger, not a draft" reasoning
   Project Closure's saved reports and Team Directory's email log use.
   The burn-down chart is a plain step-line SVG (same hand-rolled-chart
   precedent as Benefits Realization's sparkline, scaled up with axis
   labels) — remaining reserve over time as draws land.

   Firestore:
     businesses/{biz}/projects/{proj}/riskReserve/main
       { totalAmount, setAt, setBy }
     businesses/{biz}/projects/{proj}/reserveDraws/{id}
       { amount, date, riskId, riskTitle, note, createdAt, createdBy, createdByUid }
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[risk-reserve]';
  var ctx = { biz: null, proj: null, userEmail: '', userUid: '', isOwner: false, reserve: {}, draws: [], risks: [] };
  var card, chartEl, tbody, totalInput, saveTotalBtn, totalStatusEl;
  var amountInput, dateInput, riskSel, noteInput, addBtn;

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function toDate(v) { if (!v) return null; if (v.toDate) return v.toDate(); var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtDate(v) { var d = toDate(v); return d ? (window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString()) : '—'; }
  function toDateInput(v) { var d = toDate(v); return d ? (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')) : ''; }
  function fmtMoney(v) { return typeof v === 'number' && !isNaN(v) ? ('$' + Math.round(v).toLocaleString()) : '—'; }
  function isSample(id) { return String(id || '').indexOf('sample-') === 0; }
  function canWrite() { return ctx.isOwner; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }
  function reserveDocRef() { var p = projRef(); return p ? p.collection('riskReserve').doc('main') : null; }
  function drawsRef() { var p = projRef(); return p ? p.collection('reserveDraws') : null; }

  // Same lookback-window concept the shared Time Frame dropdown uses
  // elsewhere, adapted for this chart's shape: unlike Burndown/EVM/etc.
  // (which bucket the WHOLE project at different resolutions), this chart
  // is a continuous step-line of real draw EVENTS, so "Time Frame" here
  // crops the VISIBLE date range to a recent lookback from today instead
  // — Week zooms into the last 7 days, Month the last 30, and so on.
  // 'total' (or no reading yet) shows the full history, unchanged.
  var TIMEFRAME_LOOKBACK_DAYS = { week: 7, month: 30, '3month': 90, '6month': 180, year: 365 };

  // ---------------------------------------------------------------------------
  // Burn-down chart — a step line: flat until a draw lands, then drops.
  // ---------------------------------------------------------------------------
  function buildBurndown() {
    var total = typeof ctx.reserve.totalAmount === 'number' ? ctx.reserve.totalAmount : null;
    if (total == null) return null;
    var draws = ctx.draws.slice().sort(function (a, b) { return toDate(a.date) - toDate(b.date); });
    var startDate = ctx.reserve.setAt ? toDate(ctx.reserve.setAt) : (draws.length ? toDate(draws[0].date) : new Date());
    var points = [{ date: startDate, value: total }];
    var running = total;
    draws.forEach(function (d) {
      var dd = toDate(d.date);
      if (!dd) return;
      points.push({ date: dd, value: running });
      running -= (typeof d.amount === 'number' ? d.amount : 0);
      points.push({ date: dd, value: running });
    });
    var today = new Date();
    if (today > points[points.length - 1].date) points.push({ date: today, value: running });

    // The Total/Drawn/Remaining stat row above stays whole-project (same
    // "as of today" convention as Cash Flow's own stat row) — only the
    // chart's own visible date range crops to the selected window.
    var unit = window.drBurndownInternals ? window.drBurndownInternals.getGlobalTimeframeUnit() : 'total';
    var lookbackDays = TIMEFRAME_LOOKBACK_DAYS[unit];
    var windowStart = startDate;
    if (lookbackDays != null) {
      var candidate = new Date(today.getTime() - lookbackDays * 86400000);
      if (candidate > windowStart) windowStart = candidate;
    }
    var visiblePoints = points.filter(function (p) { return p.date >= windowStart; });
    // Carry the reserve LEVEL at the moment the window starts, so a
    // cropped chart doesn't start mid-air at whatever the first draw
    // inside the window happens to be — it reads as "here's the line
    // coming into this window," same as every other point already does.
    if (!visiblePoints.length || visiblePoints[0].date.getTime() !== windowStart.getTime()) {
      var levelAtStart = total;
      for (var i = 0; i < points.length; i++) {
        if (points[i].date <= windowStart) levelAtStart = points[i].value; else break;
      }
      visiblePoints.unshift({ date: windowStart, value: levelAtStart });
    }

    return { points: visiblePoints, total: total, remaining: running, drawn: total - running };
  }

  // "Nice" round step (1/2/5 x 10^n) for an axis with ~`divisions` grid
  // lines — same rounding approach charts conventionally use so labels
  // read as $25,000/$50,000 rather than some arbitrary fraction of the max.
  function niceStep(range, divisions) {
    var rough = (range || 1) / divisions;
    var mag = Math.pow(10, Math.floor(Math.log10(rough)));
    var norm = rough / mag;
    var step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    return step * mag;
  }
  var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function renderChart(bd) {
    if (!chartEl) return;
    if (!bd) { chartEl.innerHTML = ''; return; }
    var W = 620, H = 190, PADL = 66, PADR = 14, PADT = 14, PADB = 30;
    var minDate = bd.points[0].date, maxDate = bd.points[bd.points.length - 1].date;
    var span = (maxDate - minDate) || 86400000;
    var maxVal = Math.max(bd.total, 1), minVal = Math.min(0, bd.remaining);
    var valSpan = (maxVal - minVal) || 1;
    function x(d) { return PADL + ((d - minDate) / span) * (W - PADL - PADR); }
    function y(v) { return PADT + (1 - (v - minVal) / valSpan) * (H - PADT - PADB); }
    var pct = bd.total > 0 ? (bd.remaining / bd.total) * 100 : 0;
    var color = pct <= 20 ? '#dd3333' : pct <= 50 ? '#e0a800' : '#2f9e44';
    var pathPts = bd.points.map(function (p) { return x(p.date).toFixed(1) + ',' + y(p.value).toFixed(1); }).join(' ');
    var last = bd.points[bd.points.length - 1];

    // Y axis — dollar increments (gridline + label every "nice" step from
    // $0 up to/above the total), instead of just the two endpoint labels.
    var yStep = niceStep(maxVal - minVal, 4);
    var yLines = '', yLabels = '';
    for (var v = Math.ceil(minVal / yStep) * yStep; v <= maxVal + 0.01; v += yStep) {
      var yy = y(v).toFixed(1);
      yLines += '<line x1="' + PADL + '" y1="' + yy + '" x2="' + (W - PADR) + '" y2="' + yy + '" stroke="#e5e5e5" stroke-width="1" />';
      yLabels += '<text x="' + (PADL - 6) + '" y="' + (parseFloat(yy) + 3.5) + '" font-size="10" fill="#666" text-anchor="end">' + esc(fmtMoney(v)) + '</text>';
    }

    // X axis — one tick + month label (e.g. "Jan '26") at the 1st of every
    // month spanned by the chart, instead of just the start/end dates.
    var xTicks = '';
    var monthCursor = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    var baseY = (H - PADB).toFixed(1);
    while (monthCursor <= maxDate) {
      if (monthCursor >= minDate) {
        var mx = x(monthCursor).toFixed(1);
        var label = MONTH_ABBR[monthCursor.getMonth()] + " '" + String(monthCursor.getFullYear()).slice(2);
        xTicks += '<line x1="' + mx + '" y1="' + PADT + '" x2="' + mx + '" y2="' + baseY + '" stroke="#eee" stroke-width="1" />' +
          '<text x="' + mx + '" y="' + (H - PADB + 13) + '" font-size="9.5" fill="#666" text-anchor="middle">' + esc(label) + '</text>';
      }
      monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
    }

    var svg = '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" class="rr-chart-svg">' +
      yLines + xTicks + yLabels +
      '<line x1="' + PADL + '" y1="' + PADT + '" x2="' + PADL + '" y2="' + baseY + '" stroke="#ccc" stroke-width="1" />' +
      '<line x1="' + PADL + '" y1="' + baseY + '" x2="' + (W - PADR) + '" y2="' + baseY + '" stroke="#ccc" stroke-width="1" />' +
      '<polyline points="' + pathPts + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />' +
      '<circle cx="' + x(last.date).toFixed(1) + '" cy="' + y(last.value).toFixed(1) + '" r="4.5" fill="' + color + '" stroke="#fff" stroke-width="1.5" />' +
      '</svg>';
    chartEl.innerHTML = svg;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('riskReserveCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView) return;

    if (window.drBurndownInternals) window.drBurndownInternals.applyTimeframeBadge('riskReserveCard', window.drBurndownInternals.getGlobalTimeframeUnit());

    if (totalInput && document.activeElement !== totalInput) totalInput.value = typeof ctx.reserve.totalAmount === 'number' ? ctx.reserve.totalAmount : '';

    var summaryEl = document.getElementById('rrSummary');
    var bd = buildBurndown();
    if (summaryEl) {
      summaryEl.innerHTML = bd
        ? '<span class="rr-stat"><strong>' + esc(fmtMoney(bd.total)) + '</strong> total</span>' +
          '<span class="rr-stat"><strong>' + esc(fmtMoney(bd.drawn)) + '</strong> drawn</span>' +
          '<span class="rr-stat"><strong>' + esc(fmtMoney(bd.remaining)) + '</strong> remaining</span>'
        : '<span class="rr-stat">Set a Total Reserve below to start tracking.</span>';
    }
    renderChart(bd);

    if (!tbody) return;
    var rows = ctx.draws.slice().sort(function (a, b) { return toDate(b.date) - toDate(a.date); });
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="metrics-empty">No draws logged yet.</td></tr>';
    } else {
      tbody.innerHTML = rows.map(function (r) {
        var delBtn = '<button type="button" class="delete-btn rr-del" data-id="' + esc(r.id) + '"' + (canWrite() ? '' : ' disabled aria-disabled="true" title="Owner only"') + '>🗑️</button>';
        return '<tr data-id="' + esc(r.id) + '">' +
          '<td>' + esc(fmtDate(r.date)) + '</td>' +
          '<td>' + esc(fmtMoney(r.amount)) + '</td>' +
          '<td>' + (r.riskTitle ? esc(r.riskTitle) : '—') + '</td>' +
          '<td class="wrap-text">' + esc(r.note) + '</td>' +
          '<td>' + delBtn + '</td></tr>';
      }).join('');
    }

    if (window.drInsight) {
      window.drInsight.set('riskReserveCard', bd
        ? fmtMoney(bd.remaining) + ' of ' + fmtMoney(bd.total) + ' contingency reserve remaining (' + Math.round((bd.remaining / bd.total) * 100) + '%), across ' + ctx.draws.length + ' draw' + (ctx.draws.length === 1 ? '' : 's') + '.'
        : '');
    }
  }

  // ---------------------------------------------------------------------------
  // Writes (owner only)
  // ---------------------------------------------------------------------------
  function saveTotal() {
    if (!canWrite() || !totalInput) return;
    var val = parseFloat(totalInput.value);
    if (isNaN(val) || val < 0) { if (totalStatusEl) totalStatusEl.textContent = 'Enter a valid amount.'; return; }
    var ref = reserveDocRef();
    if (!ref) return;
    ref.set({ totalAmount: val, setAt: ctx.reserve.setAt || new Date(), setBy: ctx.userEmail || '' }, { merge: true })
      .then(function () { if (totalStatusEl) totalStatusEl.textContent = 'Saved.'; })
      .catch(function (err) { console.error(ns, 'saveTotal error', err); if (totalStatusEl) totalStatusEl.textContent = 'Could not save: ' + (err && err.message ? err.message : err); });
  }

  function readDrawForm() {
    var risk = ctx.risks.find(function (r) { return r.id === (riskSel && riskSel.value); });
    return {
      amount: amountInput && amountInput.value !== '' ? parseFloat(amountInput.value) : null,
      date: dateInput && dateInput.value ? new Date(dateInput.value + 'T00:00:00') : new Date(),
      riskId: risk ? risk.id : '', riskTitle: risk ? risk.title : '',
      note: noteInput ? noteInput.value.trim() : ''
    };
  }
  function clearDrawForm() {
    [amountInput, dateInput, noteInput].forEach(function (el) { if (el) el.value = ''; });
    if (riskSel) riskSel.value = '';
  }
  function addDraw() {
    if (!canWrite()) return;
    var data = readDrawForm();
    if (typeof data.amount !== 'number' || isNaN(data.amount) || data.amount <= 0) { alert('Enter a positive draw amount.'); return; }
    var ref = drawsRef();
    if (!ref) return;
    data.createdAt = new Date(); data.createdBy = ctx.userEmail || ''; data.createdByUid = ctx.userUid || '';
    ref.add(data).catch(function (err) { console.error(ns, 'addDraw error', err); alert('Could not save — please try again: ' + (err && err.message ? err.message : err)); });
    clearDrawForm();
  }
  function deleteDraw(id) {
    if (!canWrite() || isSample(id)) return;
    var ref = drawsRef();
    if (!ref) return;
    var confirmed = window.drConfirm ? window.drConfirm('Delete this reserve draw? This cannot be undone.', { title: 'Delete Reserve Draw' }) : Promise.resolve(window.confirm('Delete this reserve draw?'));
    confirmed.then(function (ok) { if (ok) ref.doc(id).delete().catch(function (err) { console.error(ns, 'deleteDraw error', err); }); });
  }

  function setOptions(sel, placeholder, emptyText, items) {
    if (!sel) return;
    var keep = sel.value;
    sel.innerHTML = '<option value="">' + (items.length ? placeholder : emptyText) + '</option>' +
      items.map(function (i) { return '<option value="' + esc(i.id) + '">' + esc(i.label) + '</option>'; }).join('');
    sel.value = keep;
  }
  function listenRisks() {
    var p = projRef();
    if (!p) return;
    p.onSnapshot(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      ctx.risks = (Array.isArray(data.riskRegister) ? data.riskRegister : []).filter(function (r) { return r && r.id; })
        .map(function (r) { return { id: String(r.id), title: r.description || r.id }; });
      setOptions(riskSel, 'Linked risk (optional)', 'No risks in this project yet',
        ctx.risks.map(function (r) { return { id: r.id, label: r.id + ' — ' + r.title }; }));
    }, function (err) { console.warn(ns, 'project doc listen error (risk link)', err && err.code); });
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  function bindEvents() {
    if (saveTotalBtn) saveTotalBtn.addEventListener('click', saveTotal);
    if (addBtn) addBtn.addEventListener('click', addDraw);
    if (tbody) tbody.addEventListener('click', function (ev) {
      var t = ev.target.closest('.rr-del');
      if (t) deleteDraw(t.getAttribute('data-id'));
    });
  }

  function listenReserve() {
    var ref = reserveDocRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      ctx.reserve = (snap.exists && snap.data()) || {};
      paint();
    }, function (err) { console.warn(ns, 'reserve listen error', err && err.code); });
  }
  function listenDraws() {
    var ref = drawsRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.draws = rows;
      paint();
    }, function (err) { console.warn(ns, 'draws listen error', err && err.code); });
  }

  function applyAccess() {
    var els = document.querySelectorAll('.rr-add-only');
    for (var i = 0; i < els.length; i++) els[i].style.display = canWrite() ? '' : 'none';
    paint();
  }

  function detectContext() {
    card = document.getElementById('riskReserveCard');
    chartEl = document.getElementById('rrChart');
    tbody = document.querySelector('#riskReserveTable tbody');
    totalInput = document.getElementById('rr-total'); saveTotalBtn = document.getElementById('rr-save-total'); totalStatusEl = document.getElementById('rr-total-status');
    amountInput = document.getElementById('rr-amount'); dateInput = document.getElementById('rr-date');
    riskSel = document.getElementById('rr-risk'); noteInput = document.getElementById('rr-note'); addBtn = document.getElementById('rr-add');

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.userUid = (user && user.uid) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function init() {
    detectContext();
    if (!ctx.biz || !card) return;
    bindEvents();
    listenRisks();
    listenReserve();
    listenDraws();
    // Same global Time Frame control burndown.js's charts follow —
    // broadcast via a custom event since this is a separate script with
    // no shared module (same pattern as resourceHours.js).
    window.addEventListener('dr-timeframe-changed', paint);
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
