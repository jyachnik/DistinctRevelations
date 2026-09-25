/* ============================================================================
   Baseline Change / Rebaseline Log — a governance record of WHEN and WHY the
   project's schedule/cost BASELINE ITSELF was formally reset, distinct from
   the Change Control Log (which tracks individual change REQUESTS, not the
   resulting rebaseline decision). Real-time add/edit/delete, modeled on
   decisionLog.js's structure (live subcollection, filters, sort,
   pagination, sample rows, a live-listener "linked change request"
   dropdown), owner-only write (a rebaseline is a governance action, same
   trust level as Stakeholder Register/Team Directory, not matrix-governed).

   Firestore: businesses/{biz}/projects/{proj}/baselineChanges/{doc}
   Fields: title, reason, oldFinishDate, newFinishDate, oldBudget, newBudget,
     approvedBy, dateApproved, linkedChangeRequestId/linkedChangeRequestTitle,
     notes, createdAt/By/ByUid, updatedAt/By
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[baselineChange]';
  var CARD_ID = 'baselineChangeCard';
  var PAGE_SIZE = 15;

  var ctx = {
    biz: null, proj: null, userEmail: '', userUid: '', isOwner: false,
    rows: [], changeRequests: [], editingId: null,
    sort: { key: 'dateApproved', dir: 'desc' }, page: 1
  };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var SAMPLE_BASELINE_CHANGES = [
    { id: 'sample-1', title: 'Q3 2026 Schedule Rebaseline', reason: 'Approved 3-week scope addition pushed the finish date; baseline reset to reflect the new plan rather than showing permanent variance.', oldFinishDate: new Date(2026, 10, 1), newFinishDate: new Date(2026, 10, 22), oldBudget: null, newBudget: null, approvedBy: 'Executive Sponsor', dateApproved: new Date(2026, 6, 10), linkedChangeRequestTitle: '', notes: '' }
  ];

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projDocRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }
  function baselineRef() { var p = projDocRef(); return p ? p.collection('baselineChanges') : null; }
  function serverTs() { return window.firebase.firestore.FieldValue.serverTimestamp(); }
  function toDate(v) { if (!v) return null; if (v.toDate) return v.toDate(); var d = v instanceof Date ? v : new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtDate(v) { var d = toDate(v); return d ? (window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString()) : '—'; }
  function toDateInput(v) { var d = toDate(v); return d ? (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')) : ''; }
  function fmtMoney(v) { return typeof v === 'number' && !isNaN(v) ? ('$' + Math.round(v).toLocaleString()) : '—'; }
  function isSample(id) { return String(id || '').indexOf('sample-') === 0; }
  function canWrite() { return ctx.isOwner; }
  function canActOn(id) { return canWrite() && !isSample(id); }

  var card, tbody, titleInput, reasonInput, oldFinishInput, newFinishInput, oldBudgetInput, newBudgetInput,
      approvedByInput, dateApprovedInput, crSel, notesInput, addBtn, cancelBtn;

  function setOptions(sel, placeholder, emptyText, items) {
    if (!sel) return;
    var keep = sel.value;
    sel.innerHTML = '<option value="">' + (items.length ? placeholder : emptyText) + '</option>' +
      items.map(function (i) { return '<option value="' + esc(i.id) + '">' + esc(i.label) + '</option>'; }).join('');
    sel.value = keep;
  }
  // Live listener, not a one-time fetch-on-click — same reasoning as
  // decisionLog.js's identical picker (a fetch-on-mousedown always shows
  // one click stale against the native <select>'s open timing).
  function listenChangeRequests() {
    var p = projDocRef();
    if (!p) return;
    p.collection('changeRequests').onSnapshot(function (snap) {
      ctx.changeRequests = [];
      snap.forEach(function (d) { ctx.changeRequests.push({ id: d.id, title: (d.data() || {}).title || d.id }); });
      setOptions(crSel, 'Linked change request (optional)', 'No change requests in this project yet',
        ctx.changeRequests.map(function (c) { return { id: c.id, label: c.title }; }));
    }, function (err) { console.warn(ns, 'change requests listen error', err && err.code); });
  }

  function sortValue(r, key) {
    if (key === 'dateApproved') { var d = toDate(r.dateApproved); return d ? d.getTime() : 0; }
    if (key === 'oldBudget' || key === 'newBudget') return typeof r[key] === 'number' ? r[key] : -Infinity;
    return String(r[key] || '').toLowerCase();
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    var usingSample = !ctx.rows.length;
    var banner = document.getElementById('baselineChangeSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var rows = usingSample ? SAMPLE_BASELINE_CHANGES : ctx.rows;

    var key = ctx.sort.key, dir = ctx.sort.dir === 'desc' ? -1 : 1;
    rows = rows.slice().sort(function (a, b) {
      var av = sortValue(a, key), bv = sortValue(b, key);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    var totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (ctx.page > totalPages) ctx.page = totalPages;
    if (ctx.page < 1) ctx.page = 1;
    var pageRows = rows.slice((ctx.page - 1) * PAGE_SIZE, ctx.page * PAGE_SIZE);

    var info = document.getElementById('baselineChangePageInfo');
    var prev = document.getElementById('baselineChangePagePrev');
    var next = document.getElementById('baselineChangePageNext');
    if (info) info.textContent = 'Page ' + ctx.page + ' of ' + totalPages + ' (' + rows.length + (rows.length === 1 ? ' rebaseline' : ' rebaselines') + ')';
    if (prev) prev.disabled = ctx.page <= 1;
    if (next) next.disabled = ctx.page >= totalPages;

    document.querySelectorAll('#baselineChangeTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === ctx.sort.key) th.classList.add(ctx.sort.dir);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="metrics-empty">No baseline changes logged yet.</td></tr>';
      if (window.drInsight) window.drInsight.set(CARD_ID, '');
      return;
    }

    tbody.innerHTML = pageRows.map(function (r) {
      var tip = isSample(r.id) ? 'Sample data — add a real entry to edit' : 'Owner only';
      var editBtn = '<button type="button" class="edit-btn bc-edit" data-id="' + esc(r.id) + '"' + (canActOn(r.id) ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>✏️</button>';
      var delBtn = '<button type="button" class="delete-btn bc-del" data-id="' + esc(r.id) + '"' + (canActOn(r.id) ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>🗑️</button>';
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td>' + esc(r.title) + '</td>' +
        '<td>' + esc(fmtDate(r.oldFinishDate)) + '</td>' +
        '<td>' + esc(fmtDate(r.newFinishDate)) + '</td>' +
        '<td>' + esc(fmtMoney(r.oldBudget)) + '</td>' +
        '<td>' + esc(fmtMoney(r.newBudget)) + '</td>' +
        '<td>' + esc(r.approvedBy) + '</td>' +
        '<td>' + esc(fmtDate(r.dateApproved)) + '</td>' +
        '<td>' + (r.linkedChangeRequestTitle ? esc(r.linkedChangeRequestTitle) : '—') + '</td>' +
        '<td>' + editBtn + delBtn + '</td></tr>';
    }).join('');

    if (window.drInsight) {
      var latest = rows.slice().sort(function (a, b) { return sortValue(b, 'dateApproved') - sortValue(a, 'dateApproved'); })[0];
      var text = rows.length + ' baseline change' + (rows.length === 1 ? '' : 's') + ' logged.';
      if (latest && latest.title) text += ' Most recent: "' + latest.title + '" (' + fmtDate(latest.dateApproved) + ').';
      if (usingSample) text += ' (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  function readForm() {
    var cr = ctx.changeRequests.find(function (c) { return c.id === (crSel && crSel.value); });
    return {
      title: titleInput.value.trim(),
      reason: reasonInput.value.trim(),
      oldFinishDate: oldFinishInput.value ? new Date(oldFinishInput.value + 'T00:00:00') : null,
      newFinishDate: newFinishInput.value ? new Date(newFinishInput.value + 'T00:00:00') : null,
      oldBudget: oldBudgetInput.value !== '' ? parseFloat(oldBudgetInput.value) : null,
      newBudget: newBudgetInput.value !== '' ? parseFloat(newBudgetInput.value) : null,
      approvedBy: approvedByInput.value.trim(),
      dateApproved: dateApprovedInput.value ? new Date(dateApprovedInput.value + 'T00:00:00') : null,
      linkedChangeRequestId: cr ? cr.id : '',
      linkedChangeRequestTitle: cr ? cr.title : '',
      notes: notesInput.value.trim()
    };
  }
  function clearForm() {
    [titleInput, reasonInput, oldFinishInput, newFinishInput, oldBudgetInput, newBudgetInput, approvedByInput, dateApprovedInput, notesInput].forEach(function (el) { if (el) el.value = ''; });
    if (crSel) crSel.value = '';
  }
  function resetEditMode() {
    ctx.editingId = null;
    addBtn.textContent = 'Add';
    cancelBtn.style.display = 'none';
    clearForm();
  }

  function save() {
    if (!canWrite() || !titleInput.value.trim()) return;
    var ref = baselineRef();
    if (!ref) return;
    var payload = readForm();

    if (ctx.editingId) {
      payload.updatedAt = serverTs();
      payload.updatedBy = ctx.userEmail;
      ref.doc(ctx.editingId).update(payload).catch(function (err) {
        console.error(ns, 'update failed', err);
        alert('Could not save — please try again: ' + (err && err.message ? err.message : err));
      });
      resetEditMode();
      return;
    }
    payload.createdAt = serverTs();
    payload.createdBy = ctx.userEmail;
    payload.createdByUid = ctx.userUid;
    ref.add(payload).catch(function (err) {
      console.error(ns, 'add failed', err);
      alert('Could not save — please try again: ' + (err && err.message ? err.message : err));
    });
    clearForm();
  }

  function startEdit(id) {
    var r = ctx.rows.find(function (x) { return x.id === id; });
    if (!r || !canActOn(id)) return;
    ctx.editingId = id;
    titleInput.value = r.title || '';
    reasonInput.value = r.reason || '';
    oldFinishInput.value = toDateInput(r.oldFinishDate);
    newFinishInput.value = toDateInput(r.newFinishDate);
    oldBudgetInput.value = typeof r.oldBudget === 'number' ? r.oldBudget : '';
    newBudgetInput.value = typeof r.newBudget === 'number' ? r.newBudget : '';
    approvedByInput.value = r.approvedBy || '';
    dateApprovedInput.value = toDateInput(r.dateApproved);
    if (crSel) crSel.value = r.linkedChangeRequestId || '';
    notesInput.value = r.notes || '';
    addBtn.textContent = 'Update';
    cancelBtn.style.display = '';
  }

  function remove(id) {
    if (!canActOn(id)) return;
    var confirmed = window.drConfirm
      ? window.drConfirm('Delete this baseline change record? This cannot be undone.', { title: 'Delete Baseline Change' })
      : Promise.resolve(window.confirm('Delete this baseline change record?'));
    confirmed.then(function (ok) { if (ok) baselineRef().doc(id).delete().catch(function (err) { console.error(ns, 'delete failed', err); }); });
  }

  function bindEvents() {
    tbody.addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t) return;
      var id = t.getAttribute('data-id');
      if (t.classList.contains('bc-edit')) startEdit(id);
      else if (t.classList.contains('bc-del')) remove(id);
    });

    var prev = document.getElementById('baselineChangePagePrev');
    var next = document.getElementById('baselineChangePageNext');
    if (prev) prev.addEventListener('click', function () { ctx.page--; paint(); });
    if (next) next.addEventListener('click', function () { ctx.page++; paint(); });

    addBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', resetEditMode);

    var thead = document.querySelector('#baselineChangeTable thead');
    if (thead) thead.addEventListener('click', function (ev) {
      var th = ev.target.closest('th[data-sort]');
      if (!th) return;
      var key = th.getAttribute('data-sort');
      if (ctx.sort.key === key) ctx.sort.dir = ctx.sort.dir === 'asc' ? 'desc' : 'asc';
      else { ctx.sort.key = key; ctx.sort.dir = 'asc'; }
      paint();
    });
  }

  function listen() {
    var ref = baselineRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.rows = rows;
      paint();
    }, function (err) { console.warn(ns, 'listen error (expected if not a project member)', err && err.code); });
  }

  function applyAccess() {
    var els = document.querySelectorAll('.bc-add-only');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.id === 'bc-cancel-edit') { if (!canWrite()) el.style.display = 'none'; continue; }
      el.style.display = canWrite() ? '' : 'none';
    }
    paint();
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    tbody = $('#baselineChangeTable tbody');
    titleInput = $('#bc-title'); reasonInput = $('#bc-reason');
    oldFinishInput = $('#bc-old-finish'); newFinishInput = $('#bc-new-finish');
    oldBudgetInput = $('#bc-old-budget'); newBudgetInput = $('#bc-new-budget');
    approvedByInput = $('#bc-approved-by'); dateApprovedInput = $('#bc-date-approved');
    crSel = $('#bc-cr'); notesInput = $('#bc-notes');
    addBtn = $('#bc-add'); cancelBtn = $('#bc-cancel-edit');

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.userUid = (user && user.uid) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function init() {
    detectContext();
    if (!ctx.biz || !card || !tbody || !addBtn) return;
    bindEvents();
    listenChangeRequests();
    listen();
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
