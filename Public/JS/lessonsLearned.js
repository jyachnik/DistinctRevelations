/* ============================================================================
   Lessons Learned Register — what went well / badly / could be improved on
   the project, why, and what to do differently, with a simple follow-up
   status. Real-time add/edit/delete, modeled on decisionLog.js (live
   subcollection, filters, sort, pagination, sample rows, owner-only-card
   visibility). Any project member can log a lesson; afterward only the
   owner or the person who logged it can edit/delete it — see
   firestore.rules's lessonsLearned block.
   Firestore: businesses/{biz}/projects/{proj}/lessonsLearned/{doc}
   Fields: title, lessonType, phase, category, impact, status, actionOwner,
     whatHappened, rootCause, recommendation, linkedRiskId/Title,
     linkedDecisionId/Title, linkedChangeRequestId/Title,
     createdAt/createdBy/createdByUid, updatedAt/updatedBy
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[lessonsLearned]';
  var CARD_ID = 'lessonsLearnedCard';
  var PAGE_SIZE = 15;

  var ctx = {
    biz: null, proj: null, userEmail: '', userUid: '', isOwner: false,
    rows: [], risks: [], decisions: [], changeRequests: [], editingId: null,
    sort: { key: 'createdAt', dir: 'desc' }, page: 1
  };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var TYPES = ['Went Well', 'Went Badly', 'Improvement Idea'];
  var PHASES = ['Initiating', 'Planning', 'Executing', 'Monitoring & Controlling', 'Closing'];
  var CATEGORIES = ['Scope', 'Schedule', 'Cost', 'People', 'Vendor', 'Technical', 'Communication', 'Other'];
  var IMPACTS = ['High', 'Medium', 'Low'];
  var STATUSES = ['Open', 'Actioned', 'Closed'];

  // Sample rows — shown only until a real lesson exists; never written to
  // Firestore. ids start with "sample-" so every action refuses them.
  var SAMPLE_LESSONS = [
    { id: 'sample-1', title: 'Weekly demos caught issues early', lessonType: 'Went Well', phase: 'Executing', category: 'Communication', impact: 'High', status: 'Actioned', actionOwner: 'Project manager', createdBy: 'pm@example.com', createdByUid: 'sample', createdAt: new Date(2026, 5, 3), whatHappened: 'Short weekly demos to the client surfaced misunderstandings within days.', rootCause: 'Regular, low-ceremony feedback loop.', recommendation: 'Schedule recurring demos from the start of every project.', linkedRiskTitle: '', linkedDecisionTitle: '', linkedChangeRequestTitle: '' },
    { id: 'sample-2', title: 'Vendor delivery slipped two weeks', lessonType: 'Went Badly', phase: 'Executing', category: 'Vendor', impact: 'High', status: 'Open', actionOwner: 'Owner', createdBy: 'owner@example.com', createdByUid: 'sample', createdAt: new Date(2026, 7, 14), whatHappened: 'The hosting vendor delivered the environment 14 days late, blocking testing.', rootCause: 'No firm delivery date or penalty in the agreement.', recommendation: 'Put delivery dates and remedies in every vendor contract; track them as milestones.', linkedRiskTitle: 'Vendor may miss delivery date', linkedDecisionTitle: '', linkedChangeRequestTitle: '' },
    { id: 'sample-3', title: 'Capture acceptance criteria before build', lessonType: 'Improvement Idea', phase: 'Planning', category: 'Scope', impact: 'Medium', status: 'Open', actionOwner: '', createdBy: 'pm@example.com', createdByUid: 'sample', createdAt: new Date(2026, 8, 1), whatHappened: 'Two deliverables were reworked because "done" was never defined.', rootCause: 'Acceptance criteria were agreed verbally, not written down.', recommendation: 'Record acceptance criteria for each deliverable at planning.', linkedRiskTitle: '', linkedDecisionTitle: 'Freeze the page-template list at design approval', linkedChangeRequestTitle: '' }
  ];

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function getDB() {
    return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore());
  }
  function projDocRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }
  function lessonsRef() {
    var p = projDocRef();
    return p ? p.collection('lessonsLearned') : null;
  }
  function serverTs() {
    return window.firebase.firestore.FieldValue.serverTimestamp();
  }
  function toDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    var d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(v) {
    var d = toDate(v);
    if (!d) return '—';
    return window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString();
  }
  function isSample(id) { return String(id || '').indexOf('sample-') === 0; }

  // Any member can log (a Permissions "Add" grant can only narrow that);
  // the owner or the lesson's own author can edit/delete it.
  function canAdd() {
    return ctx.isOwner || !!(window.drAccess && window.drAccess.canUseAction(CARD_ID, 'Add'));
  }
  function canActOn(r) {
    if (isSample(r.id)) return false;
    return ctx.isOwner || (!!ctx.userUid && r.createdByUid === ctx.userUid);
  }

  function typeBadgeClass(t) {
    if (t === 'Went Well') return 'severity-low';
    if (t === 'Went Badly') return 'severity-high';
    return 'severity-medium'; // Improvement Idea
  }
  function impactBadgeClass(i) {
    if (i === 'High') return 'severity-high';
    if (i === 'Medium') return 'severity-medium';
    if (i === 'Low') return 'severity-low';
    return 'severity-unknown';
  }
  function statusBadgeClass(s) {
    if (s === 'Closed') return 'severity-low';
    if (s === 'Actioned') return 'severity-medium';
    return 'severity-unknown'; // Open
  }

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  var card, tbody, titleInput, typeSel, phaseSel, catSel, impactSel, statusSel, ownerInput,
      riskSel, decSel, crSel, whatInput, rootInput, recInput, addBtn, cancelBtn,
      fType, fPhase, fCategory, fStatus;

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
    fillSelect(typeSel, 'Type', TYPES);
    fillSelect(phaseSel, 'Phase', PHASES);
    fillSelect(catSel, 'Category', CATEGORIES);
    fillSelect(impactSel, 'Impact', IMPACTS);
    fillSelect(statusSel, 'Status', STATUSES);
    fillSelect(fType, 'All Types', TYPES);
    fillSelect(fPhase, 'All Phases', PHASES);
    fillSelect(fCategory, 'All Categories', CATEGORIES);
    fillSelect(fStatus, 'All Status', STATUSES);
  }

  // Linked-record dropdowns: this project's Risk Register entries (an array
  // field on the project doc), Decision Log entries and Change Control
  // requests. Re-read whenever a dropdown is opened, so a record added after
  // the page loaded still shows up; the current selection is preserved.
  function setOptions(sel, placeholder, emptyText, items) {
    if (!sel) return;
    var keep = sel.value;
    sel.innerHTML = '<option value="">' + (items.length ? placeholder : emptyText) + '</option>' +
      items.map(function (i) {
        return '<option value="' + esc(i.id) + '">' + esc(i.label) + '</option>';
      }).join('');
    sel.value = keep;
  }
  function loadLinkables() {
    var p = projDocRef();
    if (!p) return;
    p.get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      ctx.risks = (Array.isArray(data.riskRegister) ? data.riskRegister : [])
        .filter(function (r) { return r && r.id; })
        .map(function (r) { return { id: String(r.id), title: r.description || r.id }; });
      setOptions(riskSel, 'Linked risk (optional)', 'No risks in this project yet',
        ctx.risks.map(function (r) { return { id: r.id, label: r.id + ' — ' + r.title }; }));
    }).catch(function (err) { console.warn(ns, 'could not load risks', err && err.code); });
    p.collection('decisions').get().then(function (snap) {
      ctx.decisions = [];
      snap.forEach(function (d) { ctx.decisions.push({ id: d.id, title: (d.data() || {}).title || d.id }); });
      setOptions(decSel, 'Linked decision (optional)', 'No decisions in this project yet',
        ctx.decisions.map(function (x) { return { id: x.id, label: x.title }; }));
    }).catch(function (err) { console.warn(ns, 'could not load decisions', err && err.code); });
    p.collection('changeRequests').get().then(function (snap) {
      ctx.changeRequests = [];
      snap.forEach(function (d) { ctx.changeRequests.push({ id: d.id, title: (d.data() || {}).title || d.id }); });
      setOptions(crSel, 'Linked change request (optional)', 'No change requests in this project yet',
        ctx.changeRequests.map(function (c) { return { id: c.id, label: c.title }; }));
    }).catch(function (err) { console.warn(ns, 'could not load change requests', err && err.code); });
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function sortValue(r, key) {
    if (key === 'createdAt') { var d = toDate(r.createdAt); return d ? d.getTime() : 0; }
    return String(r[key] || '').toLowerCase();
  }

  function linkedHtml(r) {
    var parts = [];
    if (r.linkedRiskTitle) parts.push('Risk: ' + esc(r.linkedRiskTitle));
    if (r.linkedDecisionTitle) parts.push('Decision: ' + esc(r.linkedDecisionTitle));
    if (r.linkedChangeRequestTitle) parts.push('Change: ' + esc(r.linkedChangeRequestTitle));
    return parts.length ? parts.join('<br>') : '—';
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    var usingSample = !ctx.rows.length;
    var banner = document.getElementById('lessonsLearnedSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var source = usingSample ? SAMPLE_LESSONS : ctx.rows;

    var ft = fType ? fType.value : '', fp = fPhase ? fPhase.value : '';
    var fc = fCategory ? fCategory.value : '', fs = fStatus ? fStatus.value : '';
    var rows = source.filter(function (r) {
      return (!ft || r.lessonType === ft) && (!fp || r.phase === fp) &&
             (!fc || r.category === fc) && (!fs || r.status === fs);
    });

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

    var info = document.getElementById('lessonsLearnedPageInfo');
    var prev = document.getElementById('lessonsLearnedPagePrev');
    var next = document.getElementById('lessonsLearnedPageNext');
    if (info) info.textContent = 'Page ' + ctx.page + ' of ' + totalPages + ' (' + rows.length + (rows.length === 1 ? ' lesson' : ' lessons') + ')';
    if (prev) prev.disabled = ctx.page <= 1;
    if (next) next.disabled = ctx.page >= totalPages;

    document.querySelectorAll('#lessonsLearnedTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === ctx.sort.key) th.classList.add(ctx.sort.dir);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="14" class="metrics-empty">No lessons match the selected filters.</td></tr>';
      if (window.drInsight) window.drInsight.set(CARD_ID, '');
      return;
    }

    tbody.innerHTML = pageRows.map(function (r) {
      var can = canActOn(r);
      var tip = isSample(r.id) ? 'Sample data — log a real lesson to edit' : 'Only the owner or the person who logged this can change it';
      var editBtn = '<button type="button" class="edit-btn ll-edit" data-id="' + esc(r.id) + '"' +
        (can ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>✏️</button>';
      var delBtn = '<button type="button" class="delete-btn ll-del" data-id="' + esc(r.id) + '"' +
        (can ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>🗑️</button>';
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td>' + esc(r.title) + '</td>' +
        '<td><span class="severity-badge ' + typeBadgeClass(r.lessonType) + '">' + esc(r.lessonType || '—') + '</span></td>' +
        '<td>' + esc(r.phase) + '</td>' +
        '<td>' + esc(r.category) + '</td>' +
        '<td><span class="severity-badge ' + impactBadgeClass(r.impact) + '">' + esc(r.impact || '—') + '</span></td>' +
        '<td><span class="severity-badge ' + statusBadgeClass(r.status) + '">' + esc(r.status || 'Open') + '</span></td>' +
        '<td>' + esc(r.actionOwner) + '</td>' +
        '<td>' + esc(r.createdBy) + '</td>' +
        '<td>' + esc(fmtDate(r.createdAt)) + '</td>' +
        '<td>' + linkedHtml(r) + '</td>' +
        '<td class="wrap-text">' + esc(r.whatHappened) + '</td>' +
        '<td class="wrap-text">' + esc(r.rootCause) + '</td>' +
        '<td class="wrap-text">' + esc(r.recommendation) + '</td>' +
        '<td>' + editBtn + delBtn + '</td>' +
        '</tr>';
    }).join('');

    if (window.drInsight) {
      var open = rows.filter(function (r) { return (r.status || 'Open') === 'Open'; }).length;
      var badly = rows.filter(function (r) { return r.lessonType === 'Went Badly'; }).length;
      var well = rows.filter(function (r) { return r.lessonType === 'Went Well'; }).length;
      var text = rows.length + ' lesson' + (rows.length === 1 ? '' : 's') + ' logged: ' + well + ' went well, ' + badly +
        ' went badly; ' + open + ' still open.';
      if (usingSample) text += ' (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  // ---------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------
  function pick(list, sel) {
    return list.find(function (x) { return x.id === (sel && sel.value); });
  }
  function readForm() {
    var risk = pick(ctx.risks, riskSel), dec = pick(ctx.decisions, decSel), cr = pick(ctx.changeRequests, crSel);
    return {
      title: titleInput.value.trim(),
      lessonType: typeSel.value || 'Improvement Idea',
      phase: phaseSel.value || '',
      category: catSel.value || 'Other',
      impact: impactSel.value || 'Medium',
      status: statusSel.value || 'Open',
      actionOwner: ownerInput.value.trim(),
      whatHappened: whatInput.value.trim(),
      rootCause: rootInput.value.trim(),
      recommendation: recInput.value.trim(),
      linkedRiskId: risk ? risk.id : '',
      linkedRiskTitle: risk ? risk.title : '',
      linkedDecisionId: dec ? dec.id : '',
      linkedDecisionTitle: dec ? dec.title : '',
      linkedChangeRequestId: cr ? cr.id : '',
      linkedChangeRequestTitle: cr ? cr.title : ''
    };
  }
  function clearForm() {
    [titleInput, ownerInput, whatInput, rootInput, recInput].forEach(function (el) { if (el) el.value = ''; });
    [typeSel, phaseSel, catSel, impactSel, statusSel, riskSel, decSel, crSel].forEach(function (el) { if (el) el.value = ''; });
  }
  function resetEditMode() {
    ctx.editingId = null;
    addBtn.textContent = 'Add';
    cancelBtn.style.display = 'none';
    clearForm();
    applyAccess();
  }
  function fail(what, err) {
    console.error(ns, what + ' failed', err);
    alert('Could not save — please try again: ' + (err && err.message ? err.message : err));
  }

  function save() {
    if (!titleInput.value.trim()) return;
    var ref = lessonsRef();
    if (!ref) return;
    var payload = readForm();

    if (ctx.editingId) {
      var existing = ctx.rows.find(function (x) { return x.id === ctx.editingId; });
      if (!existing || !canActOn(existing)) return;
      payload.updatedAt = serverTs();
      payload.updatedBy = ctx.userEmail;
      ref.doc(ctx.editingId).update(payload).catch(function (err) { fail('update', err); });
      resetEditMode();
      return;
    }
    if (!canAdd()) return;
    payload.createdAt = serverTs();
    payload.createdBy = ctx.userEmail;
    payload.createdByUid = ctx.userUid;
    ref.add(payload).catch(function (err) { fail('add', err); });
    clearForm();
  }

  function startEdit(id) {
    var r = ctx.rows.find(function (x) { return x.id === id; });
    if (!r || !canActOn(r)) return;
    ctx.editingId = id;
    titleInput.value = r.title || '';
    typeSel.value = r.lessonType || '';
    phaseSel.value = r.phase || '';
    catSel.value = r.category || '';
    impactSel.value = r.impact || '';
    statusSel.value = r.status || '';
    ownerInput.value = r.actionOwner || '';
    whatInput.value = r.whatHappened || '';
    rootInput.value = r.rootCause || '';
    recInput.value = r.recommendation || '';
    riskSel.value = r.linkedRiskId || '';
    decSel.value = r.linkedDecisionId || '';
    crSel.value = r.linkedChangeRequestId || '';
    addBtn.textContent = 'Update';
    cancelBtn.style.display = '';
    // Edit/Update stays available to the owner or author even if their
    // Add grant was narrowed away, so make sure the form is showing.
    applyAccess();
  }

  function remove(id) {
    var r = ctx.rows.find(function (x) { return x.id === id; });
    if (!r || !canActOn(r)) return;
    var confirmed = window.drConfirm
      ? window.drConfirm('Delete this lesson? This cannot be undone.', { title: 'Delete Lesson' })
      : Promise.resolve(window.confirm('Delete this lesson?'));
    confirmed.then(function (ok) {
      if (!ok) return;
      lessonsRef().doc(id).delete().catch(function (err) { console.error(ns, 'delete failed', err); });
    });
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function bindEvents() {
    tbody.addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t) return;
      var id = t.getAttribute('data-id');
      if (t.classList.contains('ll-edit')) startEdit(id);
      else if (t.classList.contains('ll-del')) remove(id);
    });

    function onFilter() { ctx.page = 1; paint(); }
    [fType, fPhase, fCategory, fStatus].forEach(function (s) { if (s) s.addEventListener('change', onFilter); });
    var reset = $('#lessonsLearnedFilterReset');
    if (reset) reset.addEventListener('click', function () {
      [fType, fPhase, fCategory, fStatus].forEach(function (s) { if (s) s.value = ''; });
      onFilter();
    });

    var prev = document.getElementById('lessonsLearnedPagePrev');
    var next = document.getElementById('lessonsLearnedPageNext');
    if (prev) prev.addEventListener('click', function () { ctx.page--; paint(); });
    if (next) next.addEventListener('click', function () { ctx.page++; paint(); });

    [riskSel, decSel, crSel].forEach(function (sel) {
      if (sel) sel.addEventListener('mousedown', loadLinkables);
    });

    addBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', resetEditMode);

    var thead = document.querySelector('#lessonsLearnedTable thead');
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
    var ref = lessonsRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.rows = rows;
      paint();
    }, function (err) {
      console.warn(ns, 'listen error (expected if not a project member)', err && err.code);
    });
  }

  // The form shows when the user can add, or is in the middle of editing
  // their own lesson.
  function applyAccess() {
    var show = canAdd() || !!ctx.editingId;
    var els = document.querySelectorAll('.ll-add-only');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.id === 'll-cancel-edit') { if (!ctx.editingId) el.style.display = 'none'; continue; }
      el.style.display = show ? '' : 'none';
    }
    paint();
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    tbody = $('#lessonsLearnedTable tbody');
    titleInput = $('#ll-title'); typeSel = $('#ll-type'); phaseSel = $('#ll-phase'); catSel = $('#ll-category');
    impactSel = $('#ll-impact'); statusSel = $('#ll-status'); ownerInput = $('#ll-owner');
    riskSel = $('#ll-risk'); decSel = $('#ll-decision'); crSel = $('#ll-cr');
    whatInput = $('#ll-what'); rootInput = $('#ll-root'); recInput = $('#ll-recommendation');
    addBtn = $('#ll-add'); cancelBtn = $('#ll-cancel-edit');
    fType = $('#lessonsLearnedFilterType'); fPhase = $('#lessonsLearnedFilterPhase');
    fCategory = $('#lessonsLearnedFilterCategory'); fStatus = $('#lessonsLearnedFilterStatus');

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    var user = (window.auth && window.auth.currentUser) ||
      (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.userUid = (user && user.uid) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function init() {
    detectContext();
    if (!ctx.biz || !card || !tbody || !addBtn) return;
    populateStaticSelects();
    bindEvents();
    loadLinkables();
    listen();
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
