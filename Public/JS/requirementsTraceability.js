/* ============================================================================
   Requirements Traceability Matrix (RTM) — links each requirement to the
   deliverable that satisfies it and its test/acceptance status, a core
   Scope Management artifact. Real-time add/edit/delete, modeled on
   decisionLog.js/baselineChange.js (live subcollection, filters, sort,
   pagination, sample rows, a live-listener "linked deliverable" dropdown
   sourced from Deliverable Sign-off's own signoffs collection), owner-only
   write.

   Firestore: businesses/{biz}/projects/{proj}/requirements/{doc}
   Fields: reqId, description, source, priority, status, testStatus,
     linkedDeliverableId/linkedDeliverableTitle, notes,
     createdAt/By/ByUid, updatedAt/By
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[rtm]';
  var CARD_ID = 'requirementsTraceabilityCard';
  var PAGE_SIZE = 15;

  var ctx = {
    biz: null, proj: null, userEmail: '', userUid: '', isOwner: false,
    rows: [], deliverables: [], editingId: null,
    sort: { key: 'reqId', dir: 'asc' }, page: 1
  };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var PRIORITIES = ['High', 'Medium', 'Low'];
  var STATUSES = ['Not Started', 'In Progress', 'Met', 'Not Met', 'Deferred'];
  var TEST_STATUSES = ['Not Tested', 'Passed', 'Failed'];

  var SAMPLE_REQUIREMENTS = [
    { id: 'sample-1', reqId: 'REQ-001', description: 'Users can reset their own password without contacting support.', source: 'Client Co. — IT', priority: 'High', status: 'Met', testStatus: 'Passed', linkedDeliverableTitle: 'Authentication Module', notes: '' },
    { id: 'sample-2', reqId: 'REQ-002', description: 'System must support at least 500 concurrent users.', source: 'Executive Sponsor', priority: 'High', status: 'In Progress', testStatus: 'Not Tested', linkedDeliverableTitle: '', notes: 'Load test scheduled for UAT.' },
    { id: 'sample-3', reqId: 'REQ-003', description: 'Reports export to PDF and CSV.', source: 'Finance Director', priority: 'Medium', status: 'Not Started', testStatus: 'Not Tested', linkedDeliverableTitle: '', notes: '' }
  ];

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projDocRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }
  function requirementsRef() { var p = projDocRef(); return p ? p.collection('requirements') : null; }
  function serverTs() { return window.firebase.firestore.FieldValue.serverTimestamp(); }
  function isSample(id) { return String(id || '').indexOf('sample-') === 0; }
  function canWrite() { return ctx.isOwner; }
  function canActOn(id) { return canWrite() && !isSample(id); }

  function statusBadgeClass(s) {
    if (s === 'Met') return 'severity-low';
    if (s === 'In Progress') return 'severity-medium';
    if (s === 'Not Met') return 'severity-high';
    return 'severity-unknown'; // Not Started, Deferred
  }
  function testBadgeClass(s) {
    if (s === 'Passed') return 'severity-low';
    if (s === 'Failed') return 'severity-high';
    return 'severity-unknown'; // Not Tested
  }

  var card, tbody, reqIdInput, descInput, sourceInput, prioritySel, statusSel, testSel, deliverableSel, notesInput,
      addBtn, cancelBtn, fStatus, fPriority;

  function fillSelect(sel, placeholder, values) {
    if (!sel || sel.options.length) return;
    var o0 = document.createElement('option');
    o0.value = ''; o0.textContent = placeholder;
    sel.appendChild(o0);
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    });
  }
  function populateStaticSelects() {
    fillSelect(prioritySel, 'Priority', PRIORITIES);
    fillSelect(statusSel, 'Status', STATUSES);
    fillSelect(testSel, 'Test Status', TEST_STATUSES);
    fillSelect(fStatus, 'All Status', STATUSES);
    fillSelect(fPriority, 'All Priorities', PRIORITIES);
  }

  // Live listener, not a one-time fetch-on-click — same reasoning as
  // decisionLog.js's/baselineChange.js's identical linked-record pickers.
  function listenDeliverables() {
    var p = projDocRef();
    if (!p) return;
    p.collection('signoffs').onSnapshot(function (snap) {
      ctx.deliverables = [];
      snap.forEach(function (d) { ctx.deliverables.push({ id: d.id, title: (d.data() || {}).title || d.id }); });
      var keep = deliverableSel ? deliverableSel.value : '';
      if (deliverableSel) {
        deliverableSel.innerHTML = '<option value="">' + (ctx.deliverables.length ? 'Linked deliverable (optional)' : 'No deliverables in this project yet') + '</option>' +
          ctx.deliverables.map(function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.title) + '</option>'; }).join('');
        deliverableSel.value = keep;
      }
    }, function (err) { console.warn(ns, 'deliverables listen error', err && err.code); });
  }

  function sortValue(r, key) { return String(r[key] || '').toLowerCase(); }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    var usingSample = !ctx.rows.length;
    var banner = document.getElementById('rtmSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var source = usingSample ? SAMPLE_REQUIREMENTS : ctx.rows;

    var fs = fStatus ? fStatus.value : '', fp = fPriority ? fPriority.value : '';
    var rows = source.filter(function (r) { return (!fs || r.status === fs) && (!fp || r.priority === fp); });

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

    var info = document.getElementById('rtmPageInfo');
    var prev = document.getElementById('rtmPagePrev');
    var next = document.getElementById('rtmPageNext');
    if (info) info.textContent = 'Page ' + ctx.page + ' of ' + totalPages + ' (' + rows.length + (rows.length === 1 ? ' requirement' : ' requirements') + ')';
    if (prev) prev.disabled = ctx.page <= 1;
    if (next) next.disabled = ctx.page >= totalPages;

    document.querySelectorAll('#rtmTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === ctx.sort.key) th.classList.add(ctx.sort.dir);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="metrics-empty">No requirements match the selected filters.</td></tr>';
      if (window.drInsight) window.drInsight.set(CARD_ID, '');
      return;
    }

    tbody.innerHTML = pageRows.map(function (r) {
      var tip = isSample(r.id) ? 'Sample data — add a real requirement to edit' : 'Owner only';
      var editBtn = '<button type="button" class="edit-btn rtm-edit" data-id="' + esc(r.id) + '"' + (canActOn(r.id) ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>✏️</button>';
      var delBtn = '<button type="button" class="delete-btn rtm-del" data-id="' + esc(r.id) + '"' + (canActOn(r.id) ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>🗑️</button>';
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td>' + esc(r.reqId) + '</td>' +
        '<td class="wrap-text">' + esc(r.description) + '</td>' +
        '<td>' + esc(r.source) + '</td>' +
        '<td>' + esc(r.priority) + '</td>' +
        '<td><span class="severity-badge ' + statusBadgeClass(r.status) + '">' + esc(r.status || '—') + '</span></td>' +
        '<td><span class="severity-badge ' + testBadgeClass(r.testStatus) + '">' + esc(r.testStatus || '—') + '</span></td>' +
        '<td>' + (r.linkedDeliverableTitle ? esc(r.linkedDeliverableTitle) : '—') + '</td>' +
        '<td>' + editBtn + delBtn + '</td></tr>';
    }).join('');

    if (window.drInsight) {
      var met = rows.filter(function (r) { return r.status === 'Met'; });
      var notMet = rows.filter(function (r) { return r.status === 'Not Met'; });
      var text = rows.length + ' requirement' + (rows.length === 1 ? '' : 's') + ' tracked, ' + met.length + ' met';
      if (notMet.length) text += ', ' + notMet.length + ' not met';
      text += '.';
      if (usingSample) text += ' (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  function readForm() {
    var d = ctx.deliverables.find(function (x) { return x.id === (deliverableSel && deliverableSel.value); });
    return {
      reqId: reqIdInput.value.trim(),
      description: descInput.value.trim(),
      source: sourceInput.value.trim(),
      priority: prioritySel.value || 'Medium',
      status: statusSel.value || 'Not Started',
      testStatus: testSel.value || 'Not Tested',
      linkedDeliverableId: d ? d.id : '',
      linkedDeliverableTitle: d ? d.title : '',
      notes: notesInput.value.trim()
    };
  }
  function clearForm() {
    [reqIdInput, descInput, sourceInput, notesInput].forEach(function (el) { if (el) el.value = ''; });
    [prioritySel, statusSel, testSel, deliverableSel].forEach(function (el) { if (el) el.value = ''; });
  }
  function resetEditMode() {
    ctx.editingId = null;
    addBtn.textContent = 'Add';
    cancelBtn.style.display = 'none';
    clearForm();
  }

  function save() {
    if (!canWrite() || !reqIdInput.value.trim() || !descInput.value.trim()) return;
    var ref = requirementsRef();
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
    reqIdInput.value = r.reqId || '';
    descInput.value = r.description || '';
    sourceInput.value = r.source || '';
    prioritySel.value = r.priority || '';
    statusSel.value = r.status || '';
    testSel.value = r.testStatus || '';
    if (deliverableSel) deliverableSel.value = r.linkedDeliverableId || '';
    notesInput.value = r.notes || '';
    addBtn.textContent = 'Update';
    cancelBtn.style.display = '';
  }

  function remove(id) {
    if (!canActOn(id)) return;
    var confirmed = window.drConfirm
      ? window.drConfirm('Delete this requirement? This cannot be undone.', { title: 'Delete Requirement' })
      : Promise.resolve(window.confirm('Delete this requirement?'));
    confirmed.then(function (ok) { if (ok) requirementsRef().doc(id).delete().catch(function (err) { console.error(ns, 'delete failed', err); }); });
  }

  function bindEvents() {
    tbody.addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t) return;
      var id = t.getAttribute('data-id');
      if (t.classList.contains('rtm-edit')) startEdit(id);
      else if (t.classList.contains('rtm-del')) remove(id);
    });

    function onFilter() { ctx.page = 1; paint(); }
    [fStatus, fPriority].forEach(function (s) { if (s) s.addEventListener('change', onFilter); });
    var reset = $('#rtmFilterReset');
    if (reset) reset.addEventListener('click', function () {
      [fStatus, fPriority].forEach(function (s) { if (s) s.value = ''; });
      onFilter();
    });

    var prev = document.getElementById('rtmPagePrev');
    var next = document.getElementById('rtmPageNext');
    if (prev) prev.addEventListener('click', function () { ctx.page--; paint(); });
    if (next) next.addEventListener('click', function () { ctx.page++; paint(); });

    addBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', resetEditMode);

    var thead = document.querySelector('#rtmTable thead');
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
    var ref = requirementsRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.rows = rows;
      paint();
    }, function (err) { console.warn(ns, 'listen error (expected if not a project member)', err && err.code); });
  }

  function applyAccess() {
    var els = document.querySelectorAll('.rtm-add-only');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.id === 'rtm-cancel-edit') { if (!canWrite()) el.style.display = 'none'; continue; }
      el.style.display = canWrite() ? '' : 'none';
    }
    paint();
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    tbody = $('#rtmTable tbody');
    reqIdInput = $('#rtm-reqid'); descInput = $('#rtm-description'); sourceInput = $('#rtm-source');
    prioritySel = $('#rtm-priority'); statusSel = $('#rtm-status'); testSel = $('#rtm-test-status');
    deliverableSel = $('#rtm-deliverable'); notesInput = $('#rtm-notes');
    addBtn = $('#rtm-add'); cancelBtn = $('#rtm-cancel-edit');
    fStatus = $('#rtmFilterStatus'); fPriority = $('#rtmFilterPriority');

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
    populateStaticSelects();
    bindEvents();
    listenDeliverables();
    listen();
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
