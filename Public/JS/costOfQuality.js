/* ============================================================================
   Cost of Quality (COQ) — a PMBOK Quality Management metric distinct from
   the Quality/Defects Log's raw defect count: what quality is actually
   COSTING the project, split into the standard four categories:

     Conformance (money spent to prevent/catch defects):
       - Prevention      — training, process design, quality planning
       - Appraisal       — testing, inspections, reviews
     Non-conformance (money spent because something already went wrong):
       - Internal Failure — rework, scrap, found before delivery
       - External Failure — warranty work, liability, found by the client

   A healthy trend is conformance spend catching problems BEFORE they become
   (much more expensive) failure spend — the card's own ratio makes that
   comparison explicit. Real-time add/delete, modeled on Risk Reserve's
   ledger (append-only entries, no edit — a financial log, not a draft),
   with an optional link to a Quality/Defects Log entry (read live from the
   project doc, same as Risk Reserve's linked-risk picker).

   Firestore: businesses/{biz}/projects/{proj}/costOfQuality/{id}
   Fields: { category, description, amount, date, linkedDefectId,
     linkedDefectTitle, notes, createdAt, createdBy, createdByUid }
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[cost-of-quality]';
  var CATEGORIES = ['Prevention', 'Appraisal', 'Internal Failure', 'External Failure'];
  var CONFORMANCE = { Prevention: true, Appraisal: true };

  var ctx = { biz: null, proj: null, userEmail: '', userUid: '', isOwner: false, rows: [], defects: [] };
  var card, summaryEl, chartEl, tbody, catSel, descInput, amountInput, dateInput, defectSel, notesInput, addBtn;

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function toDate(v) { if (!v) return null; if (v.toDate) return v.toDate(); var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtDate(v) { var d = toDate(v); return d ? (window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString()) : '—'; }
  function toDateInput(v) { var d = toDate(v) || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function fmtMoney(v) { return typeof v === 'number' && !isNaN(v) ? ('$' + Math.round(v).toLocaleString()) : '$0'; }
  function isSample(id) { return String(id || '').indexOf('sample-') === 0; }
  function canWrite() { return ctx.isOwner; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }
  function coqRef() { var p = projRef(); return p ? p.collection('costOfQuality') : null; }

  function totalsByCategory() {
    var totals = {};
    CATEGORIES.forEach(function (c) { totals[c] = 0; });
    ctx.rows.forEach(function (r) { if (totals.hasOwnProperty(r.category)) totals[r.category] += (typeof r.amount === 'number' ? r.amount : 0); });
    return totals;
  }

  function renderChart(totals, maxVal) {
    if (!chartEl) return;
    if (!maxVal) { chartEl.innerHTML = ''; return; }
    chartEl.innerHTML = CATEGORIES.map(function (c) {
      var pct = Math.max(2, (totals[c] / maxVal) * 100);
      var cls = CONFORMANCE[c] ? 'coq-bar-good' : 'coq-bar-bad';
      return '<div class="coq-bar-row"><span class="coq-bar-label">' + esc(c) + '</span>' +
        '<div class="coq-bar-track"><div class="coq-bar ' + cls + '" style="width:' + pct.toFixed(1) + '%"></div></div>' +
        '<span class="coq-bar-value">' + esc(fmtMoney(totals[c])) + '</span></div>';
    }).join('');
  }

  function render() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('costOfQualityCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView) return;

    var totals = totalsByCategory();
    var conformance = totals.Prevention + totals.Appraisal;
    var nonConformance = totals['Internal Failure'] + totals['External Failure'];
    var grandTotal = conformance + nonConformance;
    var maxVal = Math.max(totals.Prevention, totals.Appraisal, totals['Internal Failure'], totals['External Failure']);

    if (summaryEl) {
      summaryEl.innerHTML = '<span class="rr-stat"><strong>' + fmtMoney(conformance) + '</strong> conformance (prevention + appraisal)</span>' +
        '<span class="rr-stat"><strong>' + fmtMoney(nonConformance) + '</strong> non-conformance (failure)</span>' +
        '<span class="rr-stat"><strong>' + fmtMoney(grandTotal) + '</strong> total</span>';
    }
    renderChart(totals, maxVal);

    if (tbody) {
      var rows = ctx.rows.slice().sort(function (a, b) { return toDate(b.date) - toDate(a.date); });
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="metrics-empty">No cost of quality entries logged yet.</td></tr>';
      } else {
        tbody.innerHTML = rows.map(function (r) {
          var delBtn = '<button type="button" class="delete-btn coq-del" data-id="' + esc(r.id) + '"' + (canWrite() && !isSample(r.id) ? '' : ' disabled aria-disabled="true" title="Owner only"') + '>🗑️</button>';
          return '<tr data-id="' + esc(r.id) + '">' +
            '<td>' + esc(fmtDate(r.date)) + '</td>' +
            '<td>' + esc(r.category) + '</td>' +
            '<td class="wrap-text">' + esc(r.description) + '</td>' +
            '<td>' + esc(fmtMoney(r.amount)) + '</td>' +
            '<td>' + (r.linkedDefectTitle ? esc(r.linkedDefectTitle) : '—') + '</td>' +
            '<td>' + delBtn + '</td></tr>';
        }).join('');
      }
    }

    if (window.drInsight) {
      window.drInsight.set('costOfQualityCard', grandTotal
        ? fmtMoney(grandTotal) + ' total cost of quality — ' + fmtMoney(conformance) + ' conformance vs. ' + fmtMoney(nonConformance) + ' failure (' + Math.round((nonConformance / grandTotal) * 100) + '% of total).'
        : '');
    }
  }

  function readForm() {
    var d = ctx.defects.find(function (x) { return x.id === (defectSel && defectSel.value); });
    return {
      category: catSel.value || 'Prevention',
      description: descInput.value.trim(),
      amount: amountInput.value !== '' ? parseFloat(amountInput.value) : null,
      date: dateInput.value ? new Date(dateInput.value + 'T00:00:00') : new Date(),
      linkedDefectId: d ? d.id : '', linkedDefectTitle: d ? d.title : '',
      notes: notesInput.value.trim()
    };
  }
  function clearForm() {
    [descInput, amountInput, notesInput].forEach(function (el) { if (el) el.value = ''; });
    if (dateInput) dateInput.value = toDateInput(new Date());
    if (defectSel) defectSel.value = '';
    if (catSel) catSel.value = 'Prevention';
  }

  function addEntry() {
    if (!canWrite()) return;
    var data = readForm();
    if (!data.description || typeof data.amount !== 'number' || isNaN(data.amount) || data.amount <= 0) { alert('Enter a description and a positive amount.'); return; }
    var ref = coqRef();
    if (!ref) return;
    data.createdAt = new Date(); data.createdBy = ctx.userEmail || ''; data.createdByUid = ctx.userUid || '';
    ref.add(data).catch(function (err) { console.error(ns, 'addEntry error', err); alert('Could not save — please try again: ' + (err && err.message ? err.message : err)); });
    clearForm();
  }
  function deleteEntry(id) {
    if (!canWrite() || isSample(id)) return;
    var ref = coqRef();
    if (!ref) return;
    var confirmed = window.drConfirm ? window.drConfirm('Delete this cost of quality entry? This cannot be undone.', { title: 'Delete Entry' }) : Promise.resolve(window.confirm('Delete this entry?'));
    confirmed.then(function (ok) { if (ok) ref.doc(id).delete().catch(function (err) { console.error(ns, 'deleteEntry error', err); }); });
  }

  function setDefectOptions() {
    if (!defectSel) return;
    var keep = defectSel.value;
    defectSel.innerHTML = '<option value="">' + (ctx.defects.length ? 'Linked defect (optional)' : 'No defects in this project yet') + '</option>' +
      ctx.defects.map(function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.title) + '</option>'; }).join('');
    defectSel.value = keep;
  }
  function listenDefects() {
    var p = projRef();
    if (!p) return;
    p.onSnapshot(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      ctx.defects = (Array.isArray(data.qualityDefects) ? data.qualityDefects : []).filter(function (d) { return d && d.id; })
        .map(function (d) { return { id: String(d.id), title: d.id + ' — ' + (d.description || 'Untitled defect') }; });
      setDefectOptions();
    }, function (err) { console.warn(ns, 'defects listen error', err && err.code); });
  }

  function bindEvents() {
    if (addBtn) addBtn.addEventListener('click', addEntry);
    if (tbody) tbody.addEventListener('click', function (ev) {
      var t = ev.target.closest('.coq-del');
      if (t) deleteEntry(t.getAttribute('data-id'));
    });
  }

  function listenEntries() {
    var ref = coqRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.rows = rows;
      render();
    }, function (err) { console.warn(ns, 'entries listen error', err && err.code); });
  }

  function applyAccess() {
    var els = document.querySelectorAll('.coq-add-only');
    for (var i = 0; i < els.length; i++) els[i].style.display = canWrite() ? '' : 'none';
    render();
  }

  function init() {
    card = document.getElementById('costOfQualityCard');
    summaryEl = document.getElementById('coqSummary');
    chartEl = document.getElementById('coqChart');
    tbody = document.querySelector('#costOfQualityTable tbody');
    catSel = document.getElementById('coq-category'); descInput = document.getElementById('coq-description');
    amountInput = document.getElementById('coq-amount'); dateInput = document.getElementById('coq-date');
    defectSel = document.getElementById('coq-defect'); notesInput = document.getElementById('coq-notes');
    addBtn = document.getElementById('coq-add');
    if (catSel && !catSel.options.length) catSel.innerHTML = CATEGORIES.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    if (dateInput && !dateInput.value) dateInput.value = toDateInput(new Date());

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    if (!ctx.biz || !card) return;

    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.userUid = (user && user.uid) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();

    bindEvents();
    listenDefects();
    listenEntries();
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
