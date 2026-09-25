/* ============================================================================
   Change Control Log — a formal register of change requests and their
   approvals. Log-only: an approved request is NOT applied to the schedule
   automatically; the owner implements it by hand. (Distinct from the
   Change Report, which is just an automatic audit trail of field edits.)

   Modeled on stakeholders.js (live subcollection, filters, sort,
   pagination, sample-data banner, owner-only-card visibility gating).
   Firestore: businesses/{biz}/projects/{proj}/changeRequests/{doc}
   Fields: title, description, reason, changeType, priority,
     scheduleImpactDays, costImpact, linkedItemType, linkedItemId,
     linkedItemTitle, needsSponsorApproval, proposedBy, proposedByUid,
     createdAt, ownerDecision (+ ownerDecidedAt/By/Comment),
     sponsorDecision (+ sponsorDecidedAt/By/Comment)
   Status is DERIVED from the two decisions (see deriveStatus) — never
   stored, so it can't go stale. Rules: see firestore.rules changeRequests.
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[changeControl]';
  var CARD_ID = 'changeControlLogCard';
  var PAGE_SIZE = 15;

  var ctx = {
    biz: null, proj: null, userEmail: '', userUid: '', isOwner: false,
    rows: [], linkedItems: [], editingId: null,
    sort: { key: 'createdAt', dir: 'desc' }, page: 1
  };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var CHANGE_TYPES = ['Scope', 'Schedule', 'Cost', 'Quality', 'Other'];
  var PRIORITIES = ['High', 'Medium', 'Low'];
  var PRIORITY_RANK = { high: 3, medium: 2, low: 1 };
  var STATUSES = ['Pending Owner', 'Pending Sponsor', 'Approved', 'Rejected'];

  // Sample/placeholder rows — shown only until a real request exists.
  // Never written to Firestore; ids start with "sample-" so every action
  // refuses them (see isSample()).
  var SAMPLE_REQUESTS = [
    { id: 'sample-1', title: 'Add two extra page templates', description: 'Marketing wants a landing-page and a pricing template added to scope.', reason: 'Late request from the campaign team', changeType: 'Scope', priority: 'Medium', scheduleImpactDays: 6, costImpact: 18000, linkedItemType: 'activity', linkedItemTitle: 'Front-end development', needsSponsorApproval: true, proposedBy: 'pm@example.com', createdAt: null, ownerDecision: 'approved', sponsorDecision: 'pending' },
    { id: 'sample-2', title: 'Move go-live one week earlier', description: 'Client wants to launch before the trade show.', reason: 'Business deadline', changeType: 'Schedule', priority: 'High', scheduleImpactDays: -7, costImpact: 12000, linkedItemType: 'milestone', linkedItemTitle: 'Go-live', needsSponsorApproval: false, proposedBy: 'sponsor@example.com', createdAt: null, ownerDecision: 'pending', sponsorDecision: 'n/a' },
    { id: 'sample-3', title: 'Replace vendor CMS module', description: 'Current module fails accessibility requirements.', reason: 'Quality gap found in review', changeType: 'Quality', priority: 'Low', scheduleImpactDays: 3, costImpact: 4500, linkedItemType: '', linkedItemTitle: '', needsSponsorApproval: false, proposedBy: 'dev@example.com', createdAt: null, ownerDecision: 'approved', sponsorDecision: 'n/a' }
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
  function requestsRef() {
    var p = projDocRef();
    return p ? p.collection('changeRequests') : null;
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
  function fmtDays(n) {
    n = Number(n) || 0;
    return (n > 0 ? '+' : '') + n + 'd';
  }
  function fmtMoney(n) {
    n = Number(n) || 0;
    return (n < 0 ? '-$' : (n > 0 ? '+$' : '$')) + Math.abs(n).toLocaleString();
  }
  function isSample(id) { return String(id || '').indexOf('sample-') === 0; }

  // Derived status — the single source of truth for what a request's
  // overall state is (the rules deliberately store no `status` field).
  function deriveStatus(r) {
    var o = r.ownerDecision || 'pending';
    var s = r.sponsorDecision || 'n/a';
    if (o === 'rejected' || s === 'rejected') return 'Rejected';
    if (o === 'approved' && (s === 'n/a' || s === 'approved')) return 'Approved';
    if (o === 'approved' && s === 'pending') return 'Pending Sponsor';
    return 'Pending Owner';
  }
  function statusBadgeClass(status) {
    if (status === 'Approved') return 'severity-low';
    if (status === 'Rejected') return 'severity-high';
    return 'severity-medium';
  }
  function priorityBadgeClass(p) {
    var l = String(p || '').toLowerCase();
    if (l === 'high') return 'severity-high';
    if (l === 'medium') return 'severity-medium';
    if (l === 'low') return 'severity-low';
    return 'severity-unknown';
  }
  function decisionBadgeClass(d) {
    if (d === 'approved') return 'severity-low';
    if (d === 'rejected') return 'severity-high';
    return 'severity-unknown';
  }

  // ---------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------
  function role() { return (window.drAccess && window.drAccess.role) || null; }
  function isSponsor() { return role() === 'clientPartner'; }
  // Anyone who can see the card can submit (rules allow any project
  // member/owner); the Permissions matrix's "Submit" grant can narrow it.
  function canSubmit() {
    return ctx.isOwner || !!(window.drAccess && window.drAccess.canUseAction(CARD_ID, 'Submit'));
  }
  function isOwn(r) { return !!ctx.userUid && r.proposedByUid === ctx.userUid; }
  function undecided(r) {
    return (r.ownerDecision || 'pending') === 'pending' && (r.sponsorDecision === 'pending' || r.sponsorDecision === 'n/a');
  }
  function canEditOrWithdraw(r) { return !isSample(r.id) && isOwn(r) && undecided(r); }
  function canDelete(r) { return !isSample(r.id) && (ctx.isOwner || canEditOrWithdraw(r)); }

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  var card, tbody, titleInput, typeSel, prioritySel, daysInput, costInput, linkedSel,
      descInput, reasonInput, sponsorChk, addBtn, cancelBtn,
      fStatus, fType, fPriority;

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
    fillSelect(typeSel, 'Change Type', CHANGE_TYPES);
    fillSelect(prioritySel, 'Priority', PRIORITIES);
    fillSelect(fStatus, 'All Status', STATUSES);
    fillSelect(fType, 'All Types', CHANGE_TYPES);
    fillSelect(fPriority, 'All Priorities', PRIORITIES);
  }

  // Linked-item dropdown: this project's milestones + activities.
  function loadLinkedItems() {
    var p = projDocRef();
    if (!p || !linkedSel) return;
    Promise.all([p.collection('milestones').get(), p.collection('activities').get()]).then(function (res) {
      var items = [];
      res[0].forEach(function (d) { items.push({ type: 'milestone', id: d.id, title: (d.data() || {}).title || 'Untitled' }); });
      res[1].forEach(function (d) { items.push({ type: 'activity', id: d.id, title: (d.data() || {}).title || (d.data() || {}).activity || 'Untitled' }); });
      items.sort(function (a, b) { return a.title.localeCompare(b.title); });
      ctx.linkedItems = items;
      linkedSel.innerHTML = '<option value="">Linked task/milestone (optional)</option>' + items.map(function (it) {
        return '<option value="' + esc(it.type + ':' + it.id) + '">' + esc((it.type === 'milestone' ? 'Milestone: ' : 'Task: ') + it.title) + '</option>';
      }).join('');
    }).catch(function (err) { console.warn(ns, 'could not load linked items', err && err.code); });
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function sortValue(r, key) {
    if (key === 'status') return deriveStatus(r);
    if (key === 'priority') return PRIORITY_RANK[String(r.priority || '').toLowerCase()] || 0;
    if (key === 'scheduleImpactDays' || key === 'costImpact') return Number(r[key]) || 0;
    if (key === 'createdAt') { var d = toDate(r.createdAt); return d ? d.getTime() : 0; }
    return String(r[key] || '').toLowerCase();
  }

  function decisionCell(r, who) {
    var decision = who === 'owner' ? (r.ownerDecision || 'pending') : (r.sponsorDecision || 'n/a');
    if (who === 'sponsor' && decision === 'n/a') return '—';
    if (decision !== 'pending') {
      var by = who === 'owner' ? r.ownerDecidedBy : r.sponsorDecidedBy;
      var comment = who === 'owner' ? r.ownerComment : r.sponsorComment;
      var tip = (by ? 'By ' + by : '') + (comment ? ' — ' + comment : '');
      return '<span class="severity-badge ' + decisionBadgeClass(decision) + '" title="' + esc(tip) + '">' +
        esc(decision.charAt(0).toUpperCase() + decision.slice(1)) + '</span>';
    }
    // Pending: show Approve/Reject only to whoever may actually decide.
    var mayDecide = !isSample(r.id) && (who === 'owner' ? ctx.isOwner : (isSponsor() && r.needsSponsorApproval === true));
    if (!mayDecide) return '<span class="severity-badge severity-unknown">Pending</span>';
    return '<button type="button" class="cc-decide" data-id="' + esc(r.id) + '" data-who="' + who + '" data-decision="approved">Approve</button>' +
           '<button type="button" class="cc-decide cc-reject" data-id="' + esc(r.id) + '" data-who="' + who + '" data-decision="rejected">Reject</button>';
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    var usingSample = !ctx.rows.length;
    var banner = document.getElementById('changeControlSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var source = usingSample ? SAMPLE_REQUESTS : ctx.rows;

    var fs = fStatus ? fStatus.value : '', ft = fType ? fType.value : '', fp = fPriority ? fPriority.value : '';
    var rows = source.filter(function (r) {
      return (!fs || deriveStatus(r) === fs) && (!ft || r.changeType === ft) && (!fp || r.priority === fp);
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

    var info = document.getElementById('changeControlPageInfo');
    var prev = document.getElementById('changeControlPagePrev');
    var next = document.getElementById('changeControlPageNext');
    if (info) info.textContent = 'Page ' + ctx.page + ' of ' + totalPages + ' (' + rows.length + (rows.length === 1 ? ' request' : ' requests') + ')';
    if (prev) prev.disabled = ctx.page <= 1;
    if (next) next.disabled = ctx.page >= totalPages;

    document.querySelectorAll('#changeControlTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === ctx.sort.key) th.classList.add(ctx.sort.dir);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="13" class="metrics-empty">No change requests match the selected filters.</td></tr>';
      if (window.drInsight) window.drInsight.set(CARD_ID, '');
      return;
    }

    tbody.innerHTML = pageRows.map(function (r) {
      var status = deriveStatus(r);
      var canE = canEditOrWithdraw(r), canD = canDelete(r);
      var sampleTip = 'Sample data — submit a real request to use this';
      var editBtn = '<button type="button" class="edit-btn cc-edit" data-id="' + esc(r.id) + '"' +
        (canE ? '' : ' disabled aria-disabled="true" title="' + (isSample(r.id) ? sampleTip : 'Only the submitter can edit, and only before a decision') + '"') + '>✏️</button>';
      var delBtn = '<button type="button" class="delete-btn cc-del" data-id="' + esc(r.id) + '"' +
        (canD ? '' : ' disabled aria-disabled="true" title="' + (isSample(r.id) ? sampleTip : 'Only the owner, or the submitter before a decision') + '"') + '>🗑️</button>';
      var details = esc(r.description) + (r.reason ? '<div class="cc-reason">Reason: ' + esc(r.reason) + '</div>' : '');
      var linked = r.linkedItemTitle ? esc((r.linkedItemType === 'milestone' ? 'Milestone: ' : 'Task: ') + r.linkedItemTitle) : '—';
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td>' + esc(r.title) + '</td>' +
        '<td>' + esc(r.changeType) + '</td>' +
        '<td><span class="severity-badge ' + priorityBadgeClass(r.priority) + '">' + esc(r.priority || '—') + '</span></td>' +
        '<td>' + esc(fmtDays(r.scheduleImpactDays)) + '</td>' +
        '<td>' + esc(fmtMoney(r.costImpact)) + '</td>' +
        '<td>' + linked + '</td>' +
        '<td>' + esc(r.proposedBy) + '</td>' +
        '<td>' + esc(fmtDate(r.createdAt)) + '</td>' +
        '<td>' + decisionCell(r, 'owner') + '</td>' +
        '<td>' + decisionCell(r, 'sponsor') + '</td>' +
        '<td><span class="severity-badge ' + statusBadgeClass(status) + '">' + esc(status) + '</span></td>' +
        '<td class="wrap-text">' + details + '</td>' +
        '<td>' + editBtn + delBtn + '</td>' +
        '</tr>';
    }).join('');

    if (window.drInsight) {
      var pending = rows.filter(function (r) { var s = deriveStatus(r); return s === 'Pending Owner' || s === 'Pending Sponsor'; });
      var approved = rows.filter(function (r) { return deriveStatus(r) === 'Approved'; });
      var days = approved.reduce(function (t, r) { return t + (Number(r.scheduleImpactDays) || 0); }, 0);
      var cost = approved.reduce(function (t, r) { return t + (Number(r.costImpact) || 0); }, 0);
      var text = rows.length + ' change request' + (rows.length === 1 ? '' : 's') + ', ' + pending.length + ' awaiting a decision.';
      if (approved.length) text += ' Approved changes so far add ' + fmtDays(days) + ' and ' + fmtMoney(cost) + '.';
      if (usingSample) text += ' (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  // ---------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------
  function readForm() {
    var linked = linkedSel && linkedSel.value ? linkedSel.value.split(':') : ['', ''];
    var item = ctx.linkedItems.find(function (i) { return i.type === linked[0] && i.id === linked[1]; });
    return {
      title: titleInput.value.trim(),
      description: descInput.value.trim(),
      reason: reasonInput.value.trim(),
      changeType: typeSel.value || 'Other',
      priority: prioritySel.value || 'Medium',
      scheduleImpactDays: parseFloat(daysInput.value) || 0,
      costImpact: parseFloat(costInput.value) || 0,
      linkedItemType: item ? item.type : '',
      linkedItemId: item ? item.id : '',
      linkedItemTitle: item ? item.title : ''
    };
  }
  function clearForm() {
    [titleInput, descInput, reasonInput, daysInput, costInput].forEach(function (el) { if (el) el.value = ''; });
    [typeSel, prioritySel, linkedSel].forEach(function (el) { if (el) el.value = ''; });
    if (sponsorChk) { sponsorChk.checked = false; sponsorChk.disabled = false; }
  }
  function resetEditMode() {
    ctx.editingId = null;
    if (addBtn) addBtn.textContent = 'Submit';
    if (cancelBtn) cancelBtn.style.display = 'none';
    clearForm();
  }

  function submitRequest() {
    if (!canSubmit()) return;
    var ref = requestsRef();
    if (!ref || !titleInput.value.trim()) return;

    if (ctx.editingId) {
      ref.doc(ctx.editingId).update(readForm()).catch(function (err) {
        console.error(ns, 'edit failed', err);
        alert('Could not save — it may already have been decided. ' + (err && err.message ? err.message : ''));
      });
      resetEditMode();
      return;
    }

    var payload = readForm();
    payload.needsSponsorApproval = !!(sponsorChk && sponsorChk.checked);
    payload.proposedBy = ctx.userEmail;
    payload.proposedByUid = ctx.userUid;
    payload.createdAt = serverTs();
    payload.ownerDecision = 'pending';
    payload.sponsorDecision = payload.needsSponsorApproval ? 'pending' : 'n/a';
    ref.add(payload).catch(function (err) {
      console.error(ns, 'submit failed', err);
      alert('Could not submit — please try again: ' + (err && err.message ? err.message : err));
    });
    clearForm();
  }

  function startEdit(id) {
    var r = ctx.rows.find(function (x) { return x.id === id; });
    if (!r || !canEditOrWithdraw(r)) return;
    ctx.editingId = id;
    titleInput.value = r.title || '';
    descInput.value = r.description || '';
    reasonInput.value = r.reason || '';
    typeSel.value = r.changeType || '';
    prioritySel.value = r.priority || '';
    daysInput.value = r.scheduleImpactDays != null ? r.scheduleImpactDays : '';
    costInput.value = r.costImpact != null ? r.costImpact : '';
    linkedSel.value = r.linkedItemId ? r.linkedItemType + ':' + r.linkedItemId : '';
    if (sponsorChk) { sponsorChk.checked = !!r.needsSponsorApproval; sponsorChk.disabled = true; }
    addBtn.textContent = 'Update';
    cancelBtn.style.display = '';
  }

  function deleteRequest(id) {
    var r = ctx.rows.find(function (x) { return x.id === id; });
    if (!r || !canDelete(r)) return;
    var msg = ctx.isOwner && !isOwn(r) ? 'Delete this change request? This cannot be undone.' : 'Withdraw this change request?';
    var confirmed = window.drConfirm
      ? window.drConfirm(msg, { title: 'Change Request' })
      : Promise.resolve(window.confirm(msg));
    confirmed.then(function (ok) {
      if (!ok) return;
      requestsRef().doc(id).delete().catch(function (err) { console.error(ns, 'delete failed', err); });
    });
  }

  function decide(id, who, decision) {
    var r = ctx.rows.find(function (x) { return x.id === id; });
    if (!r) return;
    var label = decision === 'approved' ? 'Approve' : 'Reject';
    var comment = window.prompt(label + ' this change request? Add an optional comment (final — it can\'t be changed afterward):', '');
    if (comment === null) return;
    var patch = {};
    var by = ctx.userEmail;
    if (who === 'owner') {
      patch = { ownerDecision: decision, ownerDecidedAt: serverTs(), ownerDecidedBy: by, ownerComment: comment.trim() };
    } else {
      patch = { sponsorDecision: decision, sponsorDecidedAt: serverTs(), sponsorDecidedBy: by, sponsorComment: comment.trim() };
    }
    requestsRef().doc(id).update(patch).catch(function (err) {
      console.error(ns, 'decision failed', err);
      alert('Could not record the decision: ' + (err && err.message ? err.message : err));
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
      if (t.classList.contains('cc-edit')) startEdit(id);
      else if (t.classList.contains('cc-del')) deleteRequest(id);
      else if (t.classList.contains('cc-decide')) decide(id, t.getAttribute('data-who'), t.getAttribute('data-decision'));
    });

    function onFilter() { ctx.page = 1; paint(); }
    [fStatus, fType, fPriority].forEach(function (s) { if (s) s.addEventListener('change', onFilter); });
    var reset = $('#changeControlFilterReset');
    if (reset) reset.addEventListener('click', function () {
      [fStatus, fType, fPriority].forEach(function (s) { if (s) s.value = ''; });
      onFilter();
    });

    var prev = document.getElementById('changeControlPagePrev');
    var next = document.getElementById('changeControlPageNext');
    if (prev) prev.addEventListener('click', function () { ctx.page--; paint(); });
    if (next) next.addEventListener('click', function () { ctx.page++; paint(); });

    addBtn.addEventListener('click', submitRequest);
    cancelBtn.addEventListener('click', resetEditMode);

    var thead = document.querySelector('#changeControlTable thead');
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
    var ref = requestsRef();
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
    var els = document.querySelectorAll('.cc-add-only');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.id === 'cc-cancel-edit') { if (!canSubmit()) el.style.display = 'none'; continue; }
      el.style.display = canSubmit() ? '' : 'none';
    }
    paint();
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    tbody = $('#changeControlTable tbody');
    titleInput = $('#cc-title'); typeSel = $('#cc-type'); prioritySel = $('#cc-priority');
    daysInput = $('#cc-days'); costInput = $('#cc-cost'); linkedSel = $('#cc-linked');
    descInput = $('#cc-description'); reasonInput = $('#cc-reason'); sponsorChk = $('#cc-sponsor');
    addBtn = $('#cc-add'); cancelBtn = $('#cc-cancel-edit');
    fStatus = $('#changeControlFilterStatus'); fType = $('#changeControlFilterType'); fPriority = $('#changeControlFilterPriority');

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
    loadLinkedItems();
    listen();
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
