/* ============================================================================
   Deliverable / Milestone Sign-off — formal client acceptance of a milestone
   or deliverable: acceptance criteria, a due date, and a recorded decision
   (Accepted / Accepted with conditions / Rejected) with who and when.
   Items are created/edited per the Permissions matrix (like decisionLog.js);
   the DECISION is role-based — the Client Partner (or the owner) records it,
   once per round. A rejected / conditionally accepted item can be resubmitted,
   which archives that round into history and starts the next.
   See firestore.rules's signoffs block for the enforcement.
   Firestore: businesses/{biz}/projects/{proj}/signoffs/{doc}
   Fields: title, kind (Milestone|Deliverable), linkedItemId ('milestone:<id>'
     | 'activity:<id>' | ''), linkedItemTitle, acceptanceCriteria, dueDate,
     evidenceUrl, decision (pending|accepted|conditional|rejected),
     decidedAt/decidedBy/decisionComment, round, history[] (archived rounds),
     resubmittedAt/By, createdAt/By/ByUid
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[signoff]';
  var CARD_ID = 'deliverableSignoffCard';
  var PAGE_SIZE = 15;

  var ctx = {
    biz: null, proj: null, userEmail: '', userUid: '', isOwner: false,
    rows: [], items: [], editingId: null,
    sort: { key: 'dueDate', dir: 'asc' }, page: 1
  };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var KINDS = ['Milestone', 'Deliverable'];
  var DECISION_LABEL = { pending: 'Pending', accepted: 'Accepted', conditional: 'Accepted with Conditions', rejected: 'Rejected' };
  var STATUS_LABELS = ['Pending', 'Accepted', 'Accepted with Conditions', 'Rejected'];

  function daysFromNow(n) { var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; }
  // Sample rows — shown only until a real item exists; never written to
  // Firestore. ids start with "sample-" so every action refuses them.
  var SAMPLE_ITEMS = [
    { id: 'sample-1', title: 'Design approval', kind: 'Milestone', linkedItemTitle: 'Design approval', dueDate: daysFromNow(-4), decision: 'pending', round: 1, history: [], acceptanceCriteria: 'Client signs off the final visual design and page templates.', evidenceUrl: '', decisionComment: '' },
    { id: 'sample-2', title: 'Requirements sign-off', kind: 'Milestone', linkedItemTitle: 'Requirements sign-off', dueDate: daysFromNow(-60), decision: 'accepted', decidedBy: 'partner@client.com', decidedAt: daysFromNow(-58), decisionComment: 'Approved as presented.', round: 1, history: [], acceptanceCriteria: 'Signed requirements document, no open questions.', evidenceUrl: '' },
    { id: 'sample-3', title: 'Content migration complete', kind: 'Deliverable', linkedItemTitle: '', dueDate: daysFromNow(10), decision: 'conditional', decidedBy: 'partner@client.com', decidedAt: daysFromNow(-1), decisionComment: 'Accepted once the 12 broken image links are fixed.', round: 1, history: [], acceptanceCriteria: 'All approved pages live with working links and images.', evidenceUrl: '' },
    { id: 'sample-4', title: 'User acceptance test report', kind: 'Deliverable', linkedItemTitle: '', dueDate: daysFromNow(21), decision: 'pending', round: 2, history: [{ round: 1, decision: 'rejected', comment: 'Test coverage missing for mobile.', decidedBy: 'partner@client.com', decidedAt: daysFromNow(-9) }], acceptanceCriteria: 'Report covers desktop and mobile, with all defects triaged.', evidenceUrl: '', decisionComment: '' }
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
  function signoffsRef() {
    var p = projDocRef();
    return p ? p.collection('signoffs') : null;
  }
  function serverTs() { return window.firebase.firestore.FieldValue.serverTimestamp(); }
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

  // Items: owner always; Client Partner / Project Manager per the
  // Permissions matrix (firestore.rules enforces the same grants).
  function can(action) {
    return ctx.isOwner || !!(window.drAccess && window.drAccess.canUseAction(CARD_ID, action));
  }
  function canWrite() { return can('Add') || can('Edit'); }
  // The decision itself is role-based, not matrix-based.
  function canDecide() {
    return ctx.isOwner || !!(window.drAccess && window.drAccess.role === 'clientPartner');
  }

  function decisionOf(r) { return r.decision || 'pending'; }
  function statusLabel(r) { return DECISION_LABEL[decisionOf(r)] || 'Pending'; }
  function isOverdue(r) {
    var d = toDate(r.dueDate);
    if (!d || decisionOf(r) !== 'pending') return false;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    return d.getTime() < today.getTime();
  }
  function statusBadgeClass(r) {
    var d = decisionOf(r);
    if (d === 'accepted') return 'severity-low';
    if (d === 'conditional') return 'severity-medium';
    if (d === 'rejected') return 'severity-high';
    return 'severity-unknown'; // pending
  }
  function safeLink(url) {
    var u = String(url || '').trim();
    if (!u) return '—';
    if (/^https?:\/\//i.test(u)) return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">Open</a>';
    return esc(u);
  }

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  var card, tbody, titleInput, kindSel, linkedSel, dateInput, urlInput, criteriaInput,
      addBtn, cancelBtn, bulkBtn, fStatus, fKind;

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
    fillSelect(kindSel, 'Kind', KINDS);
    fillSelect(fStatus, 'All Status', STATUS_LABELS);
    fillSelect(fKind, 'All Kinds', KINDS);
  }

  // Schedule-item dropdown: this project's milestones + activities. Re-read
  // whenever opened, so anything imported after page load shows up.
  function loadLinkables() {
    var p = projDocRef();
    if (!p || !linkedSel) return;
    Promise.all([p.collection('milestones').get(), p.collection('activities').get()]).then(function (res) {
      var items = [];
      res[0].forEach(function (d) { var x = d.data() || {}; items.push({ id: 'milestone:' + d.id, title: x.title || 'Untitled', kind: 'Milestone', due: x.dueDate || null }); });
      res[1].forEach(function (d) { var x = d.data() || {}; items.push({ id: 'activity:' + d.id, title: x.title || x.activity || 'Untitled', kind: 'Task', due: x.dueDate || null }); });
      items.sort(function (a, b) { return a.title.localeCompare(b.title); });
      ctx.items = items;
      var keep = linkedSel.value;
      linkedSel.innerHTML = '<option value="">' + (items.length ? 'Linked schedule item (optional)' : 'No tasks/milestones yet') + '</option>' +
        items.map(function (it) { return '<option value="' + esc(it.id) + '">' + esc(it.kind + ': ' + it.title) + '</option>'; }).join('');
      linkedSel.value = keep;
    }).catch(function (err) { console.warn(ns, 'could not load schedule items', err && err.code); });
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function sortValue(r, key) {
    if (key === 'dueDate' || key === 'decidedAt') { var d = toDate(r[key]); return d ? d.getTime() : Number.MAX_SAFE_INTEGER; }
    if (key === 'round') return Number(r.round) || 1;
    if (key === 'status') return statusLabel(r).toLowerCase();
    return String(r[key] || '').toLowerCase();
  }

  function actionsHtml(r) {
    var id = esc(r.id), sample = isSample(r.id), d = decisionOf(r), out = '';
    var tipSample = 'Sample data — add a real item first';
    // Decision buttons — Client Partner / owner, only while pending.
    if (d === 'pending' && canDecide()) {
      var dis = sample ? ' disabled aria-disabled="true" title="' + tipSample + '"' : '';
      out += '<button type="button" class="cc-decide so-decide" data-id="' + id + '" data-decision="accepted"' + dis + '>✓ Accept</button>' +
             '<button type="button" class="cc-decide so-decide" data-id="' + id + '" data-decision="conditional"' + dis + '>◐ Conditions</button>' +
             '<button type="button" class="cc-decide cc-reject so-decide" data-id="' + id + '" data-decision="rejected"' + dis + '>✗ Reject</button>';
    }
    // Resubmit — an editor, after a rejection / conditional acceptance.
    if ((d === 'rejected' || d === 'conditional') && can('Edit')) {
      out += '<button type="button" class="cc-decide so-resubmit" data-id="' + id + '"' +
        (sample ? ' disabled aria-disabled="true" title="' + tipSample + '"' : '') + '>↻ Resubmit</button>';
    }
    if ((r.history && r.history.length)) {
      out += '<button type="button" class="cc-decide so-history" data-id="' + id + '">History</button>';
    }
    var editOk = can('Edit') && !sample && d === 'pending';
    var editTip = sample ? tipSample : (d !== 'pending' ? 'Locked after a decision — resubmit to reopen' : 'You do not have permission for this action');
    var delOk = !sample && (ctx.isOwner || (can('Delete') && d === 'pending'));
    var delTip = sample ? tipSample : (d !== 'pending' ? 'Decided items can only be deleted by the owner' : 'You do not have permission for this action');
    out += '<span class="so-icons"><button type="button" class="edit-btn so-edit" data-id="' + id + '"' +
      (editOk ? '' : ' disabled aria-disabled="true" title="' + editTip + '"') + '>✏️</button>' +
      '<button type="button" class="delete-btn so-del" data-id="' + id + '"' +
      (delOk ? '' : ' disabled aria-disabled="true" title="' + delTip + '"') + '>🗑️</button></span>';
    return out;
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    var usingSample = !ctx.rows.length;
    var banner = document.getElementById('signoffSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var source = usingSample ? SAMPLE_ITEMS : ctx.rows;

    var fs = fStatus ? fStatus.value : '', fk = fKind ? fKind.value : '';
    var rows = source.filter(function (r) { return (!fs || statusLabel(r) === fs) && (!fk || r.kind === fk); });

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

    var info = document.getElementById('signoffPageInfo');
    var prev = document.getElementById('signoffPagePrev');
    var next = document.getElementById('signoffPageNext');
    if (info) info.textContent = 'Page ' + ctx.page + ' of ' + totalPages + ' (' + rows.length + (rows.length === 1 ? ' item' : ' items') + ')';
    if (prev) prev.disabled = ctx.page <= 1;
    if (next) next.disabled = ctx.page >= totalPages;

    document.querySelectorAll('#signoffTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === ctx.sort.key) th.classList.add(ctx.sort.dir);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="metrics-empty">No items match the selected filters.</td></tr>';
      if (window.drInsight) window.drInsight.set(CARD_ID, '');
      return;
    }

    tbody.innerHTML = pageRows.map(function (r) {
      var overdue = isOverdue(r);
      var dueCell = esc(fmtDate(r.dueDate)) +
        (overdue ? ' <span class="severity-badge severity-high" title="Sign-off is still pending and the due date has passed">Overdue</span>' : '');
      var decided = decisionOf(r) === 'pending' ? '—' :
        esc(r.decidedBy || '') + (r.decidedAt ? '<br>' + esc(fmtDate(r.decidedAt)) : '');
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td>' + esc(r.title) + '</td>' +
        '<td>' + esc(r.kind) + '</td>' +
        '<td>' + (r.linkedItemTitle ? esc(r.linkedItemTitle) : '—') + '</td>' +
        '<td>' + dueCell + '</td>' +
        '<td><span class="severity-badge ' + statusBadgeClass(r) + '">' + esc(statusLabel(r)) + '</span></td>' +
        '<td>' + esc(r.round || 1) + '</td>' +
        '<td>' + decided + '</td>' +
        '<td class="wrap-text">' + esc(r.decisionComment) + '</td>' +
        '<td class="wrap-text">' + esc(r.acceptanceCriteria) + '</td>' +
        '<td>' + safeLink(r.evidenceUrl) + '</td>' +
        '<td class="so-actions">' + actionsHtml(r) + '</td>' +
        '</tr>';
    }).join('');

    if (window.drInsight) {
      var n = function (label) { return rows.filter(function (r) { return statusLabel(r) === label; }).length; };
      var text = rows.length + ' item' + (rows.length === 1 ? '' : 's') + ': ' + n('Pending') + ' pending (' +
        rows.filter(isOverdue).length + ' overdue), ' + n('Accepted') + ' accepted, ' +
        n('Accepted with Conditions') + ' with conditions, ' + n('Rejected') + ' rejected.';
      if (usingSample) text += ' (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  // ---------------------------------------------------------------------
  // Item CRUD
  // ---------------------------------------------------------------------
  function fail(what, err) {
    console.error(ns, what + ' failed', err);
    alert('Could not ' + what + ': ' + (err && err.message ? err.message : err));
  }

  function readForm() {
    var it = ctx.items.find(function (x) { return x.id === (linkedSel && linkedSel.value); });
    return {
      title: titleInput.value.trim(),
      kind: kindSel.value || (it && it.kind === 'Milestone' ? 'Milestone' : 'Deliverable'),
      linkedItemId: it ? it.id : '',
      linkedItemTitle: it ? it.title : '',
      acceptanceCriteria: criteriaInput.value.trim(),
      dueDate: dateInput.value ? new Date(dateInput.value + 'T00:00:00') : null,
      evidenceUrl: urlInput.value.trim()
    };
  }
  function clearForm() {
    [titleInput, dateInput, urlInput, criteriaInput].forEach(function (el) { if (el) el.value = ''; });
    [kindSel, linkedSel].forEach(function (el) { if (el) el.value = ''; });
  }
  function resetEditMode() {
    ctx.editingId = null;
    addBtn.textContent = 'Add';
    cancelBtn.style.display = 'none';
    clearForm();
  }

  function save() {
    if (!can(ctx.editingId ? 'Edit' : 'Add') || !titleInput.value.trim()) return;
    var ref = signoffsRef();
    if (!ref) return;
    var payload = readForm();
    if (ctx.editingId) {
      ref.doc(ctx.editingId).update(payload).catch(function (err) { fail('save', err); });
      resetEditMode();
      return;
    }
    // New items always start pending, round 1 (the rules require it).
    payload.decision = 'pending';
    payload.round = 1;
    payload.history = [];
    payload.createdAt = serverTs();
    payload.createdBy = ctx.userEmail;
    payload.createdByUid = ctx.userUid;
    ref.add(payload).catch(function (err) { fail('save', err); });
    clearForm();
  }

  function startEdit(id) {
    var r = ctx.rows.find(function (x) { return x.id === id; });
    if (!r || isSample(id) || !can('Edit') || decisionOf(r) !== 'pending') return;
    ctx.editingId = id;
    titleInput.value = r.title || '';
    kindSel.value = r.kind || '';
    linkedSel.value = r.linkedItemId || '';
    dateInput.value = toDateInput(r.dueDate);
    urlInput.value = r.evidenceUrl || '';
    criteriaInput.value = r.acceptanceCriteria || '';
    addBtn.textContent = 'Update';
    cancelBtn.style.display = '';
  }

  function remove(id) {
    var r = ctx.rows.find(function (x) { return x.id === id; });
    if (!r || isSample(id)) return;
    if (!(ctx.isOwner || (can('Delete') && decisionOf(r) === 'pending'))) return;
    var confirmed = window.drConfirm
      ? window.drConfirm('Delete this sign-off item? This cannot be undone.', { title: 'Delete Sign-off Item' })
      : Promise.resolve(window.confirm('Delete this sign-off item?'));
    confirmed.then(function (ok) {
      if (!ok) return;
      signoffsRef().doc(id).delete().catch(function (err) { fail('delete', err); });
    });
  }

  // Picking a schedule item pre-fills the title, kind and due date when those
  // are still blank — the person can still change any of them.
  function onLinkedChange() {
    var it = ctx.items.find(function (x) { return x.id === linkedSel.value; });
    if (!it) return;
    if (!titleInput.value.trim()) titleInput.value = it.title;
    if (!kindSel.value) kindSel.value = it.kind === 'Milestone' ? 'Milestone' : 'Deliverable';
    if (!dateInput.value && it.due) dateInput.value = toDateInput(it.due);
  }

  // One pending item per schedule milestone not already covered.
  function addAllMilestones() {
    if (!can('Add')) return;
    var p = projDocRef(), ref = signoffsRef(), db = getDB();
    if (!p || !ref || !db) return;
    p.collection('milestones').get().then(function (snap) {
      var have = {};
      ctx.rows.forEach(function (r) { if (r.linkedItemId) have['milestone:' + r.linkedItemId.replace(/^milestone:/, '')] = true; });
      var todo = [];
      snap.forEach(function (d) {
        var x = d.data() || {};
        if (x.isSummary || have['milestone:' + d.id]) return;
        todo.push({ id: d.id, data: x });
      });
      if (!todo.length) {
        alert(snap.size === 0
          ? 'There are no milestones in the imported schedule yet — import the schedule first, or add an item by hand.'
          : 'Nothing to add: all ' + snap.size + ' schedule milestone' + (snap.size === 1 ? ' already has' : 's already have') + ' a sign-off item.');
        return;
      }
      var confirmed = window.drConfirm
        ? window.drConfirm('Create ' + todo.length + ' pending sign-off item' + (todo.length === 1 ? '' : 's') + ', one per schedule milestone? You can add acceptance criteria to each afterward.', { title: 'Add Schedule Milestones' })
        : Promise.resolve(window.confirm('Create ' + todo.length + ' sign-off items from the schedule milestones?'));
      return confirmed.then(function (ok) {
        if (!ok) return;
        var chunks = [];
        for (var i = 0; i < todo.length; i += 400) chunks.push(todo.slice(i, i + 400));
        return chunks.reduce(function (chain, chunk) {
          return chain.then(function () {
            var batch = db.batch();
            chunk.forEach(function (m) {
              batch.set(ref.doc('ms_' + m.id), {
                title: m.data.title || 'Untitled milestone', kind: 'Milestone',
                linkedItemId: 'milestone:' + m.id, linkedItemTitle: m.data.title || 'Untitled milestone',
                acceptanceCriteria: '', dueDate: m.data.dueDate || null, evidenceUrl: '',
                decision: 'pending', round: 1, history: [],
                createdAt: serverTs(), createdBy: ctx.userEmail, createdByUid: ctx.userUid
              });
            });
            return batch.commit();
          });
        }, Promise.resolve()).then(function () {
          alert('Added ' + todo.length + ' sign-off item' + (todo.length === 1 ? '' : 's') +
            ', one per schedule milestone. Open each to add its acceptance criteria.');
        });
      });
    }).catch(function (err) { fail('add the milestones', err); });
  }

  // ---------------------------------------------------------------------
  // Decision / resubmit / history
  // ---------------------------------------------------------------------
  function decide(id, decision) {
    var r = ctx.rows.find(function (x) { return x.id === id; });
    if (!r || isSample(id) || !canDecide() || decisionOf(r) !== 'pending') return;
    var needsComment = decision !== 'accepted';
    var label = { accepted: 'Accept', conditional: 'Accept with conditions', rejected: 'Reject' }[decision];
    var comment = window.prompt(label + ' "' + r.title + '"?' +
      (needsComment ? ' Please say what needs to change (required).' : ' Add an optional comment.') +
      ' The decision is final for this round.', '');
    if (comment === null) return;
    comment = comment.trim();
    if (needsComment && !comment) { alert('A comment is required for this decision.'); return; }
    signoffsRef().doc(id).update({
      decision: decision, decidedAt: serverTs(), decidedBy: ctx.userEmail, decisionComment: comment
    }).catch(function (err) { fail('record the decision', err); });
  }

  function resubmit(id) {
    var r = ctx.rows.find(function (x) { return x.id === id; });
    if (!r || isSample(id) || !can('Edit')) return;
    var d = decisionOf(r);
    if (d !== 'rejected' && d !== 'conditional') return;
    var confirmed = window.drConfirm
      ? window.drConfirm('Resubmit "' + r.title + '" for sign-off? This round\'s decision is kept in the history and a new round starts.', { title: 'Resubmit for Sign-off' })
      : Promise.resolve(window.confirm('Resubmit for sign-off?'));
    confirmed.then(function (ok) {
      if (!ok) return;
      var entry = {
        round: r.round || 1, decision: d, comment: r.decisionComment || '',
        decidedBy: r.decidedBy || '', decidedAt: r.decidedAt || null
      };
      signoffsRef().doc(id).update({
        decision: 'pending', decidedAt: null, decidedBy: null, decisionComment: '',
        round: (r.round || 1) + 1, history: (r.history || []).concat([entry]),
        resubmittedAt: serverTs(), resubmittedBy: ctx.userEmail
      }).catch(function (err) { fail('resubmit', err); });
    });
  }

  function showHistory(id) {
    var r = (ctx.rows.concat(SAMPLE_ITEMS)).find(function (x) { return x.id === id; });
    if (!r || !window.drModal) return;
    var rows = (r.history || []).map(function (h) {
      return '<tr><td>' + esc(h.round) + '</td><td>' + esc(DECISION_LABEL[h.decision] || h.decision) + '</td><td>' +
        esc(h.decidedBy || '') + '</td><td>' + esc(fmtDate(h.decidedAt)) + '</td><td>' + esc(h.comment || '') + '</td></tr>';
    }).join('');
    window.drModal.open({
      title: 'Sign-off history — ' + (r.title || ''),
      bodyHtml: '<p>Earlier rounds for this item. The current round (' + esc(r.round || 1) + ') is ' + esc(statusLabel(r).toLowerCase()) + '.</p>' +
        '<table style="width:100%;border-collapse:collapse;font-size:0.85rem" border="1" cellpadding="6">' +
        '<thead><tr><th>Round</th><th>Decision</th><th>By</th><th>Date</th><th>Comment</th></tr></thead><tbody>' + rows + '</tbody></table>'
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
      if (t.classList.contains('so-edit')) startEdit(id);
      else if (t.classList.contains('so-del')) remove(id);
      else if (t.classList.contains('so-decide')) decide(id, t.getAttribute('data-decision'));
      else if (t.classList.contains('so-resubmit')) resubmit(id);
      else if (t.classList.contains('so-history')) showHistory(id);
    });

    function onFilter() { ctx.page = 1; paint(); }
    [fStatus, fKind].forEach(function (s) { if (s) s.addEventListener('change', onFilter); });
    var reset = $('#signoffFilterReset');
    if (reset) reset.addEventListener('click', function () {
      [fStatus, fKind].forEach(function (s) { if (s) s.value = ''; });
      onFilter();
    });

    var prev = document.getElementById('signoffPagePrev');
    var next = document.getElementById('signoffPageNext');
    if (prev) prev.addEventListener('click', function () { ctx.page--; paint(); });
    if (next) next.addEventListener('click', function () { ctx.page++; paint(); });

    linkedSel.addEventListener('mousedown', loadLinkables);
    linkedSel.addEventListener('change', onLinkedChange);
    addBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', resetEditMode);
    if (bulkBtn) bulkBtn.addEventListener('click', addAllMilestones);

    var thead = document.querySelector('#signoffTable thead');
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
    var ref = signoffsRef();
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
    var els = document.querySelectorAll('.so-add-only');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.id === 'so-cancel-edit') { if (!canWrite()) el.style.display = 'none'; continue; }
      if (el.id === 'so-bulk') { el.style.display = can('Add') ? '' : 'none'; continue; }
      el.style.display = canWrite() ? '' : 'none';
    }
    paint();
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    tbody = $('#signoffTable tbody');
    titleInput = $('#so-title'); kindSel = $('#so-kind'); linkedSel = $('#so-linked');
    dateInput = $('#so-date'); urlInput = $('#so-url'); criteriaInput = $('#so-criteria');
    addBtn = $('#so-add'); cancelBtn = $('#so-cancel-edit'); bulkBtn = $('#so-bulk');
    fStatus = $('#signoffFilterStatus'); fKind = $('#signoffFilterKind');

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
