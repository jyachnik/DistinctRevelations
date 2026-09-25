/* ============================================================================
   Decision Log — the decisions made on the project: what, by whom, when,
   why, what else was weighed, and what follows. Real-time add/edit/delete,
   modeled on stakeholders.js (live subcollection, filters, sort,
   pagination, sample rows, owner-only-card visibility, writes per the Permissions matrix —
   see firestore.rules's decisions block).
   Firestore: businesses/{biz}/projects/{proj}/decisions/{doc}
   Fields: title, category, status, decisionMakers, dateDecided, rationale,
     alternatives, impact, linkedRiskId/linkedRiskTitle,
     linkedChangeRequestId/linkedChangeRequestTitle, createdAt/By/ByUid,
     updatedAt/By
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[decisionLog]';
  var CARD_ID = 'decisionLogCard';
  var PAGE_SIZE = 15;

  var ctx = {
    biz: null, proj: null, userEmail: '', userUid: '', isOwner: false,
    rows: [], risks: [], changeRequests: [], editingId: null,
    sort: { key: 'dateDecided', dir: 'desc' }, page: 1
  };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var CATEGORIES = ['Scope', 'Schedule', 'Cost', 'Technical', 'Other'];
  var STATUSES = ['Proposed', 'Decided', 'Superseded', 'Reversed'];

  // Sample rows — shown only until a real decision exists; never written
  // to Firestore. ids start with "sample-" so every action refuses them.
  var SAMPLE_DECISIONS = [
    { id: 'sample-1', title: 'Use the existing corporate CMS instead of a new platform', category: 'Technical', status: 'Decided', decisionMakers: 'Steering committee', dateDecided: new Date(2026, 1, 12), rationale: 'Avoids a 3-month platform migration and keeps licensing within budget.', alternatives: 'New headless CMS; hosted SaaS CMS.', impact: 'Front-end team must work within CMS templating limits.', linkedRiskTitle: '', linkedChangeRequestTitle: '' },
    { id: 'sample-2', title: 'Freeze the page-template list at design approval', category: 'Scope', status: 'Decided', decisionMakers: 'Executive sponsor, Project manager', dateDecided: new Date(2026, 4, 15), rationale: 'Late template requests were the top scope risk.', alternatives: 'Allow templates until UAT.', impact: 'Any new template now needs a change request.', linkedRiskTitle: 'Stakeholders may request new page templates late', linkedChangeRequestTitle: '' },
    { id: 'sample-3', title: 'Move go-live one week earlier', category: 'Schedule', status: 'Proposed', decisionMakers: 'Executive sponsor', dateDecided: null, rationale: 'Launch before the trade show.', alternatives: 'Keep the original date.', impact: 'Compresses UAT; needs extra testers.', linkedRiskTitle: '', linkedChangeRequestTitle: 'Move go-live one week earlier' }
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
  function decisionsRef() {
    var p = projDocRef();
    return p ? p.collection('decisions') : null;
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
  function toDateInput(v) {
    var d = toDate(v);
    if (!d) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function isSample(id) { return String(id || '').indexOf('sample-') === 0; }
  // Owner always; a Client Partner / Project Manager per the Permissions
  // matrix (firestore.rules enforces the same grants).
  function can(action) {
    return ctx.isOwner || !!(window.drAccess && window.drAccess.canUseAction(CARD_ID, action));
  }
  function canWrite() { return can('Add') || can('Edit'); }
  function canActOn(id, action) { return can(action) && !isSample(id); }

  function statusBadgeClass(s) {
    if (s === 'Decided') return 'severity-low';
    if (s === 'Proposed') return 'severity-medium';
    if (s === 'Reversed') return 'severity-high';
    return 'severity-unknown'; // Superseded
  }

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  var card, tbody, titleInput, catSel, statusSel, makersInput, dateInput, riskSel, crSel,
      rationaleInput, altInput, impactInput, addBtn, cancelBtn, fStatus, fCategory;

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
    fillSelect(catSel, 'Category', CATEGORIES);
    fillSelect(statusSel, 'Status', STATUSES);
    fillSelect(fStatus, 'All Status', STATUSES);
    fillSelect(fCategory, 'All Categories', CATEGORIES);
  }

  // Linked-record dropdowns: this project's Risk Register entries (an
  // array field on the project doc) and Change Control requests. LIVE, not
  // a one-time fetch-on-click: a <select>'s native dropdown opens
  // essentially synchronously on mousedown, before an async Firestore
  // .get() from that same event has any chance to resolve — so a
  // lazily-loaded list always shows one click stale (add a risk, open
  // this dropdown, and it's missing until a SECOND open — the same bug
  // found and fixed in Communications Plan's audience picker). A standing
  // onSnapshot listener keeps these options current the instant Risk
  // Register or Change Control changes, the same real-time convention
  // every other list in this app already uses.
  function setOptions(sel, placeholder, emptyText, items) {
    if (!sel) return;
    var keep = sel.value;
    sel.innerHTML = '<option value="">' + (items.length ? placeholder : emptyText) + '</option>' +
      items.map(function (i) {
        return '<option value="' + esc(i.id) + '">' + esc(i.label) + '</option>';
      }).join('');
    sel.value = keep;
  }
  function listenLinkables() {
    var p = projDocRef();
    if (!p) return;
    p.onSnapshot(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      ctx.risks = (Array.isArray(data.riskRegister) ? data.riskRegister : [])
        .filter(function (r) { return r && r.id; })
        .map(function (r) { return { id: String(r.id), title: r.description || r.id }; });
      setOptions(riskSel, 'Linked risk (optional)', 'No risks in this project yet',
        ctx.risks.map(function (r) { return { id: r.id, label: r.id + ' — ' + r.title }; }));
    }, function (err) { console.warn(ns, 'project doc listen error (risk link)', err && err.code); });
    p.collection('changeRequests').onSnapshot(function (snap) {
      ctx.changeRequests = [];
      snap.forEach(function (d) { ctx.changeRequests.push({ id: d.id, title: (d.data() || {}).title || d.id }); });
      setOptions(crSel, 'Linked change request (optional)', 'No change requests in this project yet',
        ctx.changeRequests.map(function (c) { return { id: c.id, label: c.title }; }));
    }, function (err) { console.warn(ns, 'change requests listen error', err && err.code); });
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function sortValue(r, key) {
    if (key === 'dateDecided') { var d = toDate(r.dateDecided); return d ? d.getTime() : 0; }
    return String(r[key] || '').toLowerCase();
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    var usingSample = !ctx.rows.length;
    var banner = document.getElementById('decisionLogSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var source = usingSample ? SAMPLE_DECISIONS : ctx.rows;

    var fs = fStatus ? fStatus.value : '', fc = fCategory ? fCategory.value : '';
    var rows = source.filter(function (r) { return (!fs || r.status === fs) && (!fc || r.category === fc); });

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

    var info = document.getElementById('decisionLogPageInfo');
    var prev = document.getElementById('decisionLogPagePrev');
    var next = document.getElementById('decisionLogPageNext');
    if (info) info.textContent = 'Page ' + ctx.page + ' of ' + totalPages + ' (' + rows.length + (rows.length === 1 ? ' decision' : ' decisions') + ')';
    if (prev) prev.disabled = ctx.page <= 1;
    if (next) next.disabled = ctx.page >= totalPages;

    document.querySelectorAll('#decisionLogTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === ctx.sort.key) th.classList.add(ctx.sort.dir);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="metrics-empty">No decisions match the selected filters.</td></tr>';
      if (window.drInsight) window.drInsight.set(CARD_ID, '');
      return;
    }

    tbody.innerHTML = pageRows.map(function (r) {
      var tip = isSample(r.id) ? 'Sample data — add a real decision to edit' : 'You do not have permission for this action';
      var editBtn = '<button type="button" class="edit-btn dl-edit" data-id="' + esc(r.id) + '"' +
        (canActOn(r.id, 'Edit') ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>✏️</button>';
      var delBtn = '<button type="button" class="delete-btn dl-del" data-id="' + esc(r.id) + '"' +
        (canActOn(r.id, 'Delete') ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>🗑️</button>';
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td>' + esc(r.title) + '</td>' +
        '<td>' + esc(r.category) + '</td>' +
        '<td><span class="severity-badge ' + statusBadgeClass(r.status) + '">' + esc(r.status || '—') + '</span></td>' +
        '<td>' + esc(r.decisionMakers) + '</td>' +
        '<td>' + esc(fmtDate(r.dateDecided)) + '</td>' +
        '<td>' + (r.linkedRiskTitle ? esc(r.linkedRiskTitle) : '—') + '</td>' +
        '<td>' + (r.linkedChangeRequestTitle ? esc(r.linkedChangeRequestTitle) : '—') + '</td>' +
        '<td class="wrap-text">' + esc(r.rationale) + '</td>' +
        '<td class="wrap-text">' + esc(r.alternatives) + '</td>' +
        '<td class="wrap-text">' + esc(r.impact) + '</td>' +
        '<td>' + editBtn + delBtn + '</td>' +
        '</tr>';
    }).join('');

    if (window.drInsight) {
      var decided = rows.filter(function (r) { return r.status === 'Decided'; });
      var proposed = rows.filter(function (r) { return r.status === 'Proposed'; });
      var latest = decided.slice().sort(function (a, b) { return sortValue(b, 'dateDecided') - sortValue(a, 'dateDecided'); })[0];
      var text = rows.length + ' decision' + (rows.length === 1 ? '' : 's') + ' logged, ' + decided.length + ' decided, ' + proposed.length + ' still proposed.';
      if (latest && latest.title) text += ' Most recent: "' + latest.title + '".';
      if (usingSample) text += ' (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  // ---------------------------------------------------------------------
  // CRUD (owner only)
  // ---------------------------------------------------------------------
  function readForm() {
    var risk = ctx.risks.find(function (r) { return r.id === (riskSel && riskSel.value); });
    var cr = ctx.changeRequests.find(function (c) { return c.id === (crSel && crSel.value); });
    return {
      title: titleInput.value.trim(),
      category: catSel.value || 'Other',
      status: statusSel.value || 'Proposed',
      decisionMakers: makersInput.value.trim(),
      dateDecided: dateInput.value ? new Date(dateInput.value + 'T00:00:00') : null,
      rationale: rationaleInput.value.trim(),
      alternatives: altInput.value.trim(),
      impact: impactInput.value.trim(),
      linkedRiskId: risk ? risk.id : '',
      linkedRiskTitle: risk ? risk.title : '',
      linkedChangeRequestId: cr ? cr.id : '',
      linkedChangeRequestTitle: cr ? cr.title : ''
    };
  }
  function clearForm() {
    [titleInput, makersInput, dateInput, rationaleInput, altInput, impactInput].forEach(function (el) { if (el) el.value = ''; });
    [catSel, statusSel, riskSel, crSel].forEach(function (el) { if (el) el.value = ''; });
  }
  function resetEditMode() {
    ctx.editingId = null;
    addBtn.textContent = 'Add';
    cancelBtn.style.display = 'none';
    clearForm();
  }

  function save() {
    if (!can(ctx.editingId ? 'Edit' : 'Add') || !titleInput.value.trim()) return;
    var ref = decisionsRef();
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
    if (!r || !canActOn(id, 'Edit')) return;
    ctx.editingId = id;
    titleInput.value = r.title || '';
    catSel.value = r.category || '';
    statusSel.value = r.status || '';
    makersInput.value = r.decisionMakers || '';
    dateInput.value = toDateInput(r.dateDecided);
    rationaleInput.value = r.rationale || '';
    altInput.value = r.alternatives || '';
    impactInput.value = r.impact || '';
    riskSel.value = r.linkedRiskId || '';
    crSel.value = r.linkedChangeRequestId || '';
    addBtn.textContent = 'Update';
    cancelBtn.style.display = '';
  }

  function remove(id) {
    if (!canActOn(id, 'Delete')) return;
    var confirmed = window.drConfirm
      ? window.drConfirm('Delete this decision? This cannot be undone.', { title: 'Delete Decision' })
      : Promise.resolve(window.confirm('Delete this decision?'));
    confirmed.then(function (ok) {
      if (!ok) return;
      decisionsRef().doc(id).delete().catch(function (err) { console.error(ns, 'delete failed', err); });
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
      if (t.classList.contains('dl-edit')) startEdit(id);
      else if (t.classList.contains('dl-del')) remove(id);
    });

    function onFilter() { ctx.page = 1; paint(); }
    [fStatus, fCategory].forEach(function (s) { if (s) s.addEventListener('change', onFilter); });
    var reset = $('#decisionLogFilterReset');
    if (reset) reset.addEventListener('click', function () {
      [fStatus, fCategory].forEach(function (s) { if (s) s.value = ''; });
      onFilter();
    });

    var prev = document.getElementById('decisionLogPagePrev');
    var next = document.getElementById('decisionLogPageNext');
    if (prev) prev.addEventListener('click', function () { ctx.page--; paint(); });
    if (next) next.addEventListener('click', function () { ctx.page++; paint(); });


    addBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', resetEditMode);

    var thead = document.querySelector('#decisionLogTable thead');
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
    var ref = decisionsRef();
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

  function applyAccess() {
    var els = document.querySelectorAll('.dl-add-only');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.id === 'dl-cancel-edit') { if (!canWrite()) el.style.display = 'none'; continue; }
      el.style.display = canWrite() ? '' : 'none';
    }
    paint();
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    tbody = $('#decisionLogTable tbody');
    titleInput = $('#dl-title'); catSel = $('#dl-category'); statusSel = $('#dl-status');
    makersInput = $('#dl-makers'); dateInput = $('#dl-date'); riskSel = $('#dl-risk'); crSel = $('#dl-cr');
    rationaleInput = $('#dl-rationale'); altInput = $('#dl-alternatives'); impactInput = $('#dl-impact');
    addBtn = $('#dl-add'); cancelBtn = $('#dl-cancel-edit');
    fStatus = $('#decisionLogFilterStatus'); fCategory = $('#decisionLogFilterCategory');

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
    listenLinkables();
    listen();
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
