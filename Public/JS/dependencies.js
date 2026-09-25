/* ============================================================================
   Dependencies tracker — what this project's work depends on: one schedule
   item waiting on another, or on something external (vendor, client, third
   party) or internal / cross-project. Each side (predecessor / successor)
   is either picked from this project's Activity Log + Meetings & Events or
   typed in. Real-time add/edit/delete, modeled on decisionLog.js (live
   subcollection, filters, sort, pagination, sample rows, owner-only-card
   visibility, writes per the Permissions matrix — see firestore.rules's
   dependencies block). Overdue / At Risk / Blocked items are highlighted;
   nothing is texted.
   Firestore: businesses/{biz}/projects/{proj}/dependencies/{doc}
   Rows can be seeded by the schedule import (gantt.js: the Predecessors
   column becomes source:'schedule' rows with deterministic ids
   sched_<predWbs>__<succWbs>); a re-import refreshes only the schedule-owned
   fields (tasks, relationship, lag, and need-by unless needByEdited), never
   what people filled in.
   Fields: title ("Predecessor → Successor", derived), predecessorId/Title,
     successorId/Title, dependencyType, relationship, lag, source,
     status, owner, needByDate, needByEdited, impact,
     linkedRiskId/linkedRiskTitle, createdAt/By/ByUid, updatedAt/By
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[dependencies]';
  var CARD_ID = 'dependenciesCard';
  var PAGE_SIZE = 15;

  var ctx = {
    biz: null, proj: null, userEmail: '', userUid: '', isOwner: false,
    rows: [], risks: [], items: [], editingId: null,
    sort: { key: 'needByDate', dir: 'asc' }, page: 1
  };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var TYPES = ['Task / Milestone', 'External', 'Internal / Cross-project'];
  var RELATIONSHIPS = ['Finish-to-Start', 'Start-to-Start', 'Finish-to-Finish', 'Start-to-Finish'];
  var STATUSES = ['Open', 'At Risk', 'Blocked', 'Resolved'];

  // Sample rows — shown only until a real dependency exists; never written
  // to Firestore. ids start with "sample-" so every action refuses them.
  function daysFromNow(n) { var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; }
  var SAMPLE_DEPENDENCIES = [
    { id: 'sample-1', predecessorTitle: 'Design approval', successorTitle: 'Build kickoff', dependencyType: 'Task / Milestone', relationship: 'Finish-to-Start', status: 'Open', owner: 'Project manager', needByDate: daysFromNow(14), impact: 'Build start slips day-for-day.', linkedRiskTitle: '' },
    { id: 'sample-2', predecessorTitle: 'Vendor hosting environment ready', successorTitle: 'User acceptance testing', dependencyType: 'External', relationship: 'Finish-to-Start', status: 'At Risk', owner: 'Owner', needByDate: daysFromNow(-3), impact: 'UAT cannot start; about a two-week delay.', linkedRiskTitle: 'Vendor may miss delivery date' },
    { id: 'sample-3', predecessorTitle: 'Shared identity service upgrade (IT team)', successorTitle: 'Single sign-on go-live', dependencyType: 'Internal / Cross-project', relationship: 'Finish-to-Finish', status: 'Blocked', owner: 'Client partner', needByDate: daysFromNow(30), impact: 'SSO cannot go live without it.', linkedRiskTitle: '' }
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
  function depsRef() {
    var p = projDocRef();
    return p ? p.collection('dependencies') : null;
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

  // Overdue = a need-by date before today on something not yet Resolved.
  function isOverdue(r) {
    var d = toDate(r.needByDate);
    if (!d || r.status === 'Resolved') return false;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    return d.getTime() < today.getTime();
  }

  function statusBadgeClass(s) {
    if (s === 'Resolved') return 'severity-low';
    if (s === 'At Risk') return 'severity-medium';
    if (s === 'Blocked') return 'severity-high';
    return 'severity-unknown'; // Open
  }

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  var card, tbody, predSel, predText, relSel, succSel, succText, typeSel, statusSel, ownerInput,
      dateInput, riskSel, impactInput, addBtn, cancelBtn, fStatus, fType;

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
    fillSelect(relSel, 'Relationship', RELATIONSHIPS);
    fillSelect(typeSel, 'Type', TYPES);
    fillSelect(statusSel, 'Status', STATUSES);
    fillSelect(fStatus, 'All Status', STATUSES);
    fillSelect(fType, 'All Types', TYPES);
  }

  // Dropdown option lists. Re-read whenever one is opened, so an item added
  // after the page loaded still shows up; the current selection is kept.
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
    // Schedule items: milestones (Meetings & Events) + activities.
    Promise.all([p.collection('milestones').get(), p.collection('activities').get()]).then(function (res) {
      var items = [];
      res[0].forEach(function (d) { items.push({ id: 'milestone:' + d.id, title: (d.data() || {}).title || 'Untitled', kind: 'Milestone' }); });
      res[1].forEach(function (d) { items.push({ id: 'activity:' + d.id, title: (d.data() || {}).title || (d.data() || {}).activity || 'Untitled', kind: 'Task' }); });
      items.sort(function (a, b) { return a.title.localeCompare(b.title); });
      ctx.items = items;
      var opts = items.map(function (it) { return { id: it.id, label: it.kind + ': ' + it.title }; });
      setOptions(predSel, 'Predecessor: pick a task/milestone…', 'No tasks/milestones yet — type it below', opts);
      setOptions(succSel, 'Successor: pick a task/milestone…', 'No tasks/milestones yet — type it below', opts);
    }).catch(function (err) { console.warn(ns, 'could not load schedule items', err && err.code); });
    p.get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      ctx.risks = (Array.isArray(data.riskRegister) ? data.riskRegister : [])
        .filter(function (r) { return r && r.id; })
        .map(function (r) { return { id: String(r.id), title: r.description || r.id }; });
      setOptions(riskSel, 'Linked risk (optional)', 'No risks in this project yet',
        ctx.risks.map(function (r) { return { id: r.id, label: r.id + ' — ' + r.title }; }));
    }).catch(function (err) { console.warn(ns, 'could not load risks', err && err.code); });
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function sortValue(r, key) {
    if (key === 'needByDate') { var d = toDate(r.needByDate); return d ? d.getTime() : Number.MAX_SAFE_INTEGER; }
    return String(r[key] || '').toLowerCase();
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    var usingSample = !ctx.rows.length;
    var banner = document.getElementById('dependenciesSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var source = usingSample ? SAMPLE_DEPENDENCIES : ctx.rows;

    var fs = fStatus ? fStatus.value : '', ft = fType ? fType.value : '';
    var rows = source.filter(function (r) { return (!fs || r.status === fs) && (!ft || r.dependencyType === ft); });

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

    var info = document.getElementById('dependenciesPageInfo');
    var prev = document.getElementById('dependenciesPagePrev');
    var next = document.getElementById('dependenciesPageNext');
    if (info) info.textContent = 'Page ' + ctx.page + ' of ' + totalPages + ' (' + rows.length + (rows.length === 1 ? ' dependency' : ' dependencies') + ')';
    if (prev) prev.disabled = ctx.page <= 1;
    if (next) next.disabled = ctx.page >= totalPages;

    document.querySelectorAll('#dependenciesTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === ctx.sort.key) th.classList.add(ctx.sort.dir);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="metrics-empty">No dependencies match the selected filters.</td></tr>';
      if (window.drInsight) window.drInsight.set(CARD_ID, '');
      return;
    }

    tbody.innerHTML = pageRows.map(function (r) {
      var tip = isSample(r.id) ? 'Sample data — add a real dependency to edit' : 'You do not have permission for this action';
      var editBtn = '<button type="button" class="edit-btn dp-edit" data-id="' + esc(r.id) + '"' +
        (canActOn(r.id, 'Edit') ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>✏️</button>';
      var delBtn = '<button type="button" class="delete-btn dp-del" data-id="' + esc(r.id) + '"' +
        (canActOn(r.id, 'Delete') ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>🗑️</button>';
      var overdue = isOverdue(r);
      var dateCell = esc(fmtDate(r.needByDate)) +
        (overdue ? ' <span class="severity-badge severity-high" title="Need-by date has passed and this is not resolved">Overdue</span>' : '');
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td>' + esc(r.predecessorTitle) + '</td>' +
        '<td>' + esc(r.relationship) + (r.lag ? ' ' + esc(r.lag) : '') + '</td>' +
        '<td>' + esc(r.successorTitle) + '</td>' +
        '<td>' + esc(r.dependencyType) +
          (r.source === 'schedule' ? ' <span class="dp-src" title="Created from the schedule import; the schedule keeps the tasks, link type and lag up to date">schedule</span>' : '') + '</td>' +
        '<td><span class="severity-badge ' + statusBadgeClass(r.status) + '">' + esc(r.status || 'Open') + '</span></td>' +
        '<td>' + esc(r.owner) + '</td>' +
        '<td>' + dateCell + '</td>' +
        '<td class="wrap-text">' + esc(r.impact) + '</td>' +
        '<td>' + (r.linkedRiskTitle ? esc(r.linkedRiskTitle) : '—') + '</td>' +
        '<td>' + editBtn + delBtn + '</td>' +
        '</tr>';
    }).join('');

    if (window.drInsight) {
      function n(pred) { return rows.filter(pred).length; }
      var text = rows.length + ' dependenc' + (rows.length === 1 ? 'y' : 'ies') + ': ' +
        n(function (r) { return (r.status || 'Open') === 'Open'; }) + ' open, ' +
        n(function (r) { return r.status === 'At Risk'; }) + ' at risk, ' +
        n(function (r) { return r.status === 'Blocked'; }) + ' blocked, ' +
        n(function (r) { return r.status === 'Resolved'; }) + ' resolved; ' +
        n(isOverdue) + ' overdue.';
      if (usingSample) text += ' (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  // ---------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------
  // One side of the dependency: a picked schedule item wins; otherwise the
  // typed text. Returns { id, title } (id '' when typed).
  function readSide(sel, textInput) {
    var it = ctx.items.find(function (x) { return x.id === (sel && sel.value); });
    if (it) return { id: it.id, title: it.title };
    return { id: '', title: (textInput.value || '').trim() };
  }
  function readForm() {
    var pred = readSide(predSel, predText), succ = readSide(succSel, succText);
    var risk = ctx.risks.find(function (r) { return r.id === (riskSel && riskSel.value); });
    return {
      title: pred.title + ' → ' + succ.title,
      predecessorId: pred.id, predecessorTitle: pred.title,
      successorId: succ.id, successorTitle: succ.title,
      dependencyType: typeSel.value || 'Task / Milestone',
      relationship: relSel.value || 'Finish-to-Start',
      status: statusSel.value || 'Open',
      owner: ownerInput.value.trim(),
      needByDate: dateInput.value ? new Date(dateInput.value + 'T00:00:00') : null,
      impact: impactInput.value.trim(),
      linkedRiskId: risk ? risk.id : '',
      linkedRiskTitle: risk ? risk.title : ''
    };
  }
  function clearForm() {
    [predText, succText, ownerInput, dateInput, impactInput].forEach(function (el) { if (el) el.value = ''; });
    [predSel, succSel, relSel, typeSel, statusSel, riskSel].forEach(function (el) { if (el) el.value = ''; });
  }
  function resetEditMode() {
    ctx.editingId = null;
    addBtn.textContent = 'Add';
    cancelBtn.style.display = 'none';
    clearForm();
  }

  function save() {
    if (!can(ctx.editingId ? 'Edit' : 'Add')) return;
    var payload = readForm();
    if (!readSide(predSel, predText).title || !readSide(succSel, succText).title) {
      alert('Please give both a predecessor and a successor — pick a task/milestone or type one in.');
      return;
    }
    var ref = depsRef();
    if (!ref) return;

    if (ctx.editingId) {
      // A need-by date set by hand stops following the schedule import.
      var before = ctx.rows.find(function (x) { return x.id === ctx.editingId; });
      if (before && toDateInput(before.needByDate) !== dateInput.value) payload.needByEdited = true;
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

  function fillSide(sel, textInput, id, title) {
    // A stored id that still exists in the dropdown reselects it; otherwise
    // (typed side, or the item was since removed) fall back to the text box.
    var known = id && ctx.items.some(function (x) { return x.id === id; });
    sel.value = known ? id : '';
    textInput.value = known ? '' : (title || '');
  }

  function startEdit(id) {
    var r = ctx.rows.find(function (x) { return x.id === id; });
    if (!r || !canActOn(id, 'Edit')) return;
    ctx.editingId = id;
    fillSide(predSel, predText, r.predecessorId, r.predecessorTitle);
    fillSide(succSel, succText, r.successorId, r.successorTitle);
    relSel.value = r.relationship || '';
    typeSel.value = r.dependencyType || '';
    statusSel.value = r.status || '';
    ownerInput.value = r.owner || '';
    dateInput.value = toDateInput(r.needByDate);
    impactInput.value = r.impact || '';
    riskSel.value = r.linkedRiskId || '';
    addBtn.textContent = 'Update';
    cancelBtn.style.display = '';
  }

  function remove(id) {
    if (!canActOn(id, 'Delete')) return;
    var confirmed = window.drConfirm
      ? window.drConfirm('Delete this dependency? This cannot be undone.', { title: 'Delete Dependency' })
      : Promise.resolve(window.confirm('Delete this dependency?'));
    confirmed.then(function (ok) {
      if (!ok) return;
      depsRef().doc(id).delete().catch(function (err) { console.error(ns, 'delete failed', err); });
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
      if (t.classList.contains('dp-edit')) startEdit(id);
      else if (t.classList.contains('dp-del')) remove(id);
    });

    function onFilter() { ctx.page = 1; paint(); }
    [fStatus, fType].forEach(function (s) { if (s) s.addEventListener('change', onFilter); });
    var reset = $('#dependenciesFilterReset');
    if (reset) reset.addEventListener('click', function () {
      [fStatus, fType].forEach(function (s) { if (s) s.value = ''; });
      onFilter();
    });

    var prev = document.getElementById('dependenciesPagePrev');
    var next = document.getElementById('dependenciesPageNext');
    if (prev) prev.addEventListener('click', function () { ctx.page--; paint(); });
    if (next) next.addEventListener('click', function () { ctx.page++; paint(); });

    [predSel, succSel, riskSel].forEach(function (sel) {
      if (sel) sel.addEventListener('mousedown', loadLinkables);
    });

    addBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', resetEditMode);

    var thead = document.querySelector('#dependenciesTable thead');
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
    var ref = depsRef();
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
    var els = document.querySelectorAll('.dp-add-only');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.id === 'dp-cancel-edit') { if (!canWrite()) el.style.display = 'none'; continue; }
      el.style.display = canWrite() ? '' : 'none';
    }
    paint();
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    tbody = $('#dependenciesTable tbody');
    predSel = $('#dp-pred'); predText = $('#dp-pred-text'); relSel = $('#dp-relationship');
    succSel = $('#dp-succ'); succText = $('#dp-succ-text'); typeSel = $('#dp-type');
    statusSel = $('#dp-status'); ownerInput = $('#dp-owner'); dateInput = $('#dp-date');
    riskSel = $('#dp-risk'); impactInput = $('#dp-impact');
    addBtn = $('#dp-add'); cancelBtn = $('#dp-cancel-edit');
    fStatus = $('#dependenciesFilterStatus'); fType = $('#dependenciesFilterType');

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
