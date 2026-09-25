/* ============================================================================
   Communications Plan — who gets told what, how often, and by what channel.
   Distinct from Stakeholder Register's influence/interest tracking: this is
   the actual planned cadence of communication, not who has a stake. Real-time
   add/edit/delete, modeled on decisionLog.js's structure (live subcollection,
   filters, sort, pagination, sample rows, linked-record dropdown) — but
   owner-only writes like Stakeholder Register/Team Directory (see
   firestore.rules's communicationsPlan block), and VERSIONED edits like Team
   Directory (every save snapshots the row's pre-edit values into versions[]).

   Firestore: businesses/{biz}/projects/{proj}/communicationsPlan/{doc}
   Fields: { audience, linkedStakeholderId, topic, purpose, frequency,
             channel, owner, notes, version, versions: [...], createdAt,
             createdBy, createdByUid, updatedAt, updatedBy }
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[communicationsPlan]';
  var CARD_ID = 'communicationsPlanCard';
  var PAGE_SIZE = 15;

  var FIELD_KEYS = ['audience', 'topic', 'purpose', 'frequency', 'channel', 'owner', 'notes'];
  var FIELD_LABELS = [
    { key: 'audience', label: 'Audience' }, { key: 'topic', label: 'Topic' }, { key: 'purpose', label: 'Purpose' },
    { key: 'frequency', label: 'Frequency' }, { key: 'channel', label: 'Channel' }, { key: 'owner', label: 'Owner' }, { key: 'notes', label: 'Notes' }
  ];

  var FREQUENCIES = ['Daily', 'Weekly', 'Biweekly', 'Monthly', 'Quarterly', 'Milestone-based', 'Ad hoc'];
  var CHANNELS = ['Email', 'Meeting', 'Status Report', 'Dashboard', 'Phone/Call', 'Other'];

  var ctx = { biz: null, proj: null, userEmail: '', userUid: '', isOwner: false, rows: [], stakeholders: [], editingId: null, sort: { key: 'audience', dir: 'asc' }, page: 1 };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var SAMPLE_PLAN = [
    { id: 'sample-1', audience: 'Executive Sponsor', topic: 'Overall project health', purpose: 'Keep sponsorship informed and unblock escalations early.', frequency: 'Monthly', channel: 'Status Report', owner: 'Project Manager', notes: '' },
    { id: 'sample-2', audience: 'Project Team', topic: 'Sprint progress and blockers', purpose: 'Coordinate day-to-day work.', frequency: 'Weekly', channel: 'Meeting', owner: 'Project Manager', notes: '' },
    { id: 'sample-3', audience: 'End Users', topic: 'Upcoming changes affecting their workflow', purpose: 'Reduce disruption and resistance at go-live.', frequency: 'Milestone-based', channel: 'Email', owner: 'Change Lead', notes: '' }
  ];

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projDocRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }
  function planRef() { var p = projDocRef(); return p ? p.collection('communicationsPlan') : null; }
  function toDate(v) { if (!v) return null; if (v.toDate) return v.toDate(); var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtDate(v) { var d = toDate(v); return d ? (window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString()) : '—'; }
  function isSample(id) { return String(id || '').indexOf('sample-') === 0; }
  function canWrite() { return ctx.isOwner; }
  function canActOn(id) { return canWrite() && !isSample(id); }

  var card, tbody, audienceSel, audienceTextInput, topicInput, purposeInput, freqSel, channelSel, ownerInput, notesInput, addBtn, cancelBtn, fFreq, fChannel;

  function fillSelect(sel, placeholder, values) {
    if (!sel || sel.options.length) return;
    var o0 = document.createElement('option'); o0.value = ''; o0.textContent = placeholder; sel.appendChild(o0);
    values.forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); });
  }
  function populateStaticSelects() {
    fillSelect(freqSel, 'Frequency', FREQUENCIES);
    fillSelect(channelSel, 'Channel', CHANNELS);
    fillSelect(fFreq, 'All Frequencies', FREQUENCIES);
    fillSelect(fChannel, 'All Channels', CHANNELS);
  }

  // Linked-record dropdown: this project's Stakeholder Register — re-read whenever it's opened
  // LIVE, not a one-time fetch-on-click: a <select>'s native dropdown opens essentially
  // synchronously on mousedown, before an async Firestore .get() from that same event has any
  // chance to resolve — so a lazily-loaded list always shows one click stale (add a stakeholder,
  // open this dropdown, and the new one is missing until a SECOND open). A standing onSnapshot
  // listener keeps ctx.stakeholders — and the <option> list — current the instant Stakeholder
  // Register changes, the same real-time convention every other card in this app already uses.
  function setOptions(sel, placeholder, emptyText, items) {
    if (!sel) return;
    var keep = sel.value;
    sel.innerHTML = '<option value="">' + (items.length ? placeholder : emptyText) + '</option>' +
      items.map(function (i) { return '<option value="' + esc(i.id) + '">' + esc(i.label) + '</option>'; }).join('');
    sel.value = keep;
  }
  function listenStakeholders() {
    var p = projDocRef();
    if (!p) return;
    p.collection('stakeholders').onSnapshot(function (snap) {
      ctx.stakeholders = [];
      snap.forEach(function (d) { ctx.stakeholders.push({ id: d.id, title: (d.data() || {}).name || d.id }); });
      setOptions(audienceSel, 'Audience: pick a stakeholder…', 'No stakeholders in this project yet',
        ctx.stakeholders.map(function (s) { return { id: s.id, label: s.title }; }));
    }, function (err) { console.warn(ns, 'stakeholders listen error (expected if not a project member)', err && err.code); });
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function sortValue(r, key) { return String(r[key] || '').toLowerCase(); }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    var usingSample = !ctx.rows.length;
    var banner = document.getElementById('communicationsPlanSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var source = usingSample ? SAMPLE_PLAN : ctx.rows;

    var ff = fFreq ? fFreq.value : '', fc = fChannel ? fChannel.value : '';
    var rows = source.filter(function (r) { return (!ff || r.frequency === ff) && (!fc || r.channel === fc); });

    var key = ctx.sort.key, dir = ctx.sort.dir === 'desc' ? -1 : 1;
    rows = rows.slice().sort(function (a, b) {
      var av = sortValue(a, key), bv = sortValue(b, key);
      return av < bv ? -1 * dir : av > bv ? dir : 0;
    });

    var totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (ctx.page > totalPages) ctx.page = totalPages;
    if (ctx.page < 1) ctx.page = 1;
    var pageRows = rows.slice((ctx.page - 1) * PAGE_SIZE, ctx.page * PAGE_SIZE);

    var info = document.getElementById('communicationsPlanPageInfo');
    var prev = document.getElementById('communicationsPlanPagePrev');
    var next = document.getElementById('communicationsPlanPageNext');
    if (info) info.textContent = 'Page ' + ctx.page + ' of ' + totalPages + ' (' + rows.length + (rows.length === 1 ? ' item' : ' items') + ')';
    if (prev) prev.disabled = ctx.page <= 1;
    if (next) next.disabled = ctx.page >= totalPages;

    document.querySelectorAll('#communicationsPlanTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === ctx.sort.key) th.classList.add(ctx.sort.dir);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="metrics-empty">No communications match the selected filters.</td></tr>';
      if (window.drInsight) window.drInsight.set(CARD_ID, '');
      return;
    }

    tbody.innerHTML = pageRows.map(function (r) {
      var canAct = canActOn(r.id);
      var tip = isSample(r.id) ? 'Sample data — add a real entry to edit' : 'Owner only';
      var histBtn = (r.versions && r.versions.length) ? '<button type="button" class="cp-history" data-id="' + esc(r.id) + '" title="View history">🕘</button>' : '';
      var editBtn = '<button type="button" class="edit-btn cp-edit" data-id="' + esc(r.id) + '"' + (canAct ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>✏️</button>';
      var delBtn = '<button type="button" class="delete-btn cp-del" data-id="' + esc(r.id) + '"' + (canAct ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>🗑️</button>';
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td>' + esc(r.audience) + '</td>' +
        '<td>' + esc(r.topic) + '</td>' +
        '<td class="wrap-text">' + esc(r.purpose) + '</td>' +
        '<td>' + esc(r.frequency) + '</td>' +
        '<td>' + esc(r.channel) + '</td>' +
        '<td>' + esc(r.owner) + '</td>' +
        '<td class="wrap-text">' + esc(r.notes) + '</td>' +
        '<td>' + histBtn + editBtn + delBtn + '</td></tr>';
    }).join('');

    if (window.drInsight) {
      var text = rows.length + ' planned communication' + (rows.length === 1 ? '' : 's') + '.';
      if (usingSample) text += ' (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  // ---------------------------------------------------------------------
  // CRUD + versioning (owner only)
  // ---------------------------------------------------------------------
  function readForm() {
    var stakeholder = ctx.stakeholders.find(function (s) { return s.id === (audienceSel && audienceSel.value); });
    return {
      audience: stakeholder ? stakeholder.title : (audienceTextInput ? audienceTextInput.value.trim() : ''),
      linkedStakeholderId: stakeholder ? stakeholder.id : '',
      topic: topicInput ? topicInput.value.trim() : '',
      purpose: purposeInput ? purposeInput.value.trim() : '',
      frequency: (freqSel && freqSel.value) || '',
      channel: (channelSel && channelSel.value) || '',
      owner: ownerInput ? ownerInput.value.trim() : '',
      notes: notesInput ? notesInput.value.trim() : ''
    };
  }
  function clearForm() {
    [audienceTextInput, topicInput, purposeInput, ownerInput, notesInput].forEach(function (el) { if (el) el.value = ''; });
    [audienceSel, freqSel, channelSel].forEach(function (el) { if (el) el.value = ''; });
  }
  function resetEditMode() {
    ctx.editingId = null;
    if (addBtn) addBtn.textContent = 'Add';
    if (cancelBtn) cancelBtn.style.display = 'none';
    clearForm();
  }

  function addItem() {
    if (!canWrite()) return;
    var data = readForm();
    if (!data.audience) { alert('Choose or type an audience.'); return; }
    var ref = planRef();
    if (!ref) return;
    var ts = (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue && window.firebase.firestore.FieldValue.serverTimestamp()) || new Date();
    data.version = 1; data.versions = [];
    data.createdAt = ts; data.createdBy = ctx.userEmail || ''; data.createdByUid = ctx.userUid || '';
    ref.add(data).catch(function (err) { console.error(ns, 'add failed', err); alert('Could not save — please try again: ' + (err && err.message ? err.message : err)); });
    clearForm();
  }

  function startEdit(id) {
    var row = ctx.rows.find(function (r) { return r.id === id; });
    if (!row || !canActOn(id)) return;
    ctx.editingId = id;
    if (audienceSel) audienceSel.value = row.linkedStakeholderId || '';
    if (audienceTextInput) audienceTextInput.value = row.linkedStakeholderId ? '' : (row.audience || '');
    if (topicInput) topicInput.value = row.topic || '';
    if (purposeInput) purposeInput.value = row.purpose || '';
    if (freqSel) freqSel.value = row.frequency || '';
    if (channelSel) channelSel.value = row.channel || '';
    if (ownerInput) ownerInput.value = row.owner || '';
    if (notesInput) notesInput.value = row.notes || '';
    if (addBtn) addBtn.textContent = 'Update';
    if (cancelBtn) cancelBtn.style.display = '';
  }

  function saveEdit() {
    if (!ctx.editingId || !canWrite()) return;
    var ref = planRef();
    if (!ref) return;
    var row = ctx.rows.find(function (r) { return r.id === ctx.editingId; }) || {};
    var payload = readForm();
    if (!payload.audience) { alert('Choose or type an audience.'); return; }

    var prevVersion = row.version || 0;
    var versionEntry = prevVersion ? { version: prevVersion, savedAt: row.updatedAt || row.createdAt || null, savedBy: row.updatedBy || row.createdBy || '' } : null;
    if (versionEntry) FIELD_KEYS.forEach(function (k) { versionEntry[k] = row[k] || ''; });
    payload.version = prevVersion + 1;
    payload.versions = versionEntry ? (row.versions || []).concat([versionEntry]) : (row.versions || []);
    payload.updatedAt = new Date();
    payload.updatedBy = ctx.userEmail || '';

    ref.doc(ctx.editingId).update(payload).catch(function (err) { console.error(ns, 'update failed', err); alert('Could not save — please try again: ' + (err && err.message ? err.message : err)); });
    resetEditMode();
  }

  function remove(id) {
    if (!canActOn(id)) return;
    var confirmed = window.drConfirm ? window.drConfirm('Delete this communication plan item? This cannot be undone.', { title: 'Delete Item' }) : Promise.resolve(window.confirm('Delete this item?'));
    confirmed.then(function (ok) {
      if (!ok) return;
      planRef().doc(id).delete().catch(function (err) { console.error(ns, 'delete failed', err); });
    });
  }

  function showHistory(id) {
    var row = ctx.rows.find(function (r) { return r.id === id; });
    if (!row || !window.drModal) return;
    var current = Object.assign({ version: row.version || 1, savedAt: row.updatedAt || row.createdAt, savedBy: row.updatedBy || row.createdBy }, row);
    var all = (row.versions || []).concat([current]).sort(function (a, b) { return (b.version || 0) - (a.version || 0); });
    var html = all.map(function (v) {
      var fields = FIELD_LABELS.map(function (f) { return v[f.key] ? ('<p><strong>' + esc(f.label) + ':</strong> ' + esc(v[f.key]) + '</p>') : ''; }).join('');
      return '<div style="margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #ddd">' +
        '<p style="font-weight:bold">Version ' + esc(v.version || 1) + ' — ' + esc(fmtDate(v.savedAt)) + (v.savedBy ? ' by ' + esc(v.savedBy) : '') + '</p>' +
        (fields || '<p><em>No fields filled in.</em></p>') + '</div>';
    }).join('');
    window.drModal.open({ title: 'Communications Plan history — ' + (row.audience || ''), bodyHtml: html || '<p>No earlier versions yet.</p>' });
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function bindEvents() {
    tbody.addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t) return;
      var id = t.getAttribute('data-id');
      if (t.classList.contains('cp-edit')) startEdit(id);
      else if (t.classList.contains('cp-del')) remove(id);
      else if (t.classList.contains('cp-history')) showHistory(id);
    });

    function onFilter() { ctx.page = 1; paint(); }
    [fFreq, fChannel].forEach(function (s) { if (s) s.addEventListener('change', onFilter); });
    var reset = $('#communicationsPlanFilterReset');
    if (reset) reset.addEventListener('click', function () { [fFreq, fChannel].forEach(function (s) { if (s) s.value = ''; }); onFilter(); });

    var prev = document.getElementById('communicationsPlanPagePrev');
    var next = document.getElementById('communicationsPlanPageNext');
    if (prev) prev.addEventListener('click', function () { ctx.page--; paint(); });
    if (next) next.addEventListener('click', function () { ctx.page++; paint(); });


    if (addBtn) addBtn.addEventListener('click', function () { if (ctx.editingId) saveEdit(); else addItem(); });
    if (cancelBtn) cancelBtn.addEventListener('click', resetEditMode);

    var thead = document.querySelector('#communicationsPlanTable thead');
    if (thead) thead.addEventListener('click', function (ev) {
      var th = ev.target.closest('th[data-sort]');
      if (!th) return;
      var key = th.getAttribute('data-sort');
      if (ctx.sort.key === key) ctx.sort.dir = ctx.sort.dir === 'asc' ? 'desc' : 'asc'; else { ctx.sort.key = key; ctx.sort.dir = 'asc'; }
      paint();
    });
  }

  function listen() {
    var ref = planRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.rows = rows;
      paint();
    }, function (err) { console.warn(ns, 'listen error (expected if not a project member)', err && err.code); });
  }

  function applyAccess() {
    var els = document.querySelectorAll('.cp-add-only');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.id === 'cp-cancel-edit') { if (!canWrite()) el.style.display = 'none'; continue; }
      el.style.display = canWrite() ? '' : 'none';
    }
    paint();
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    tbody = $('#communicationsPlanTable tbody');
    audienceSel = $('#cp-audience'); audienceTextInput = $('#cp-audience-text');
    topicInput = $('#cp-topic'); purposeInput = $('#cp-purpose'); freqSel = $('#cp-frequency'); channelSel = $('#cp-channel');
    ownerInput = $('#cp-owner'); notesInput = $('#cp-notes'); addBtn = $('#cp-add'); cancelBtn = $('#cp-cancel-edit');
    fFreq = $('#communicationsPlanFilterFrequency'); fChannel = $('#communicationsPlanFilterChannel');

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
    listenStakeholders();
    listen();
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
