/* ============================================================================
   Team Directory — real-time add/edit/delete, modeled directly on
   stakeholders.js's structure (live subcollection, owner-only-card
   visibility gating, owner-only write gating enforced at the Firestore
   rules layer — see firestore.rules's teamDirectory block), plus two
   additions:

     - VERSIONED edits: saveEdit() snapshots the row's pre-edit field
       values into versions[] before writing the new ones (same technique
       as signoff.js's history[] resubmit pattern, simplified since this
       card is owner-only end to end) — a "History" button per row shows
       every past version.
     - SEND EMAIL: select one or more rows, compose a subject/message, and
       send via the sendTeamEmail Cloud Function (functions/team-email-
       handler.js, SendGrid). Each recipient's success/failure comes back
       from the function and is shown after sending; a matching record is
       written server-side to teamEmailLog.

   Firestore: businesses/{biz}/projects/{proj}/teamDirectory/{doc}
   Fields: { name, role, email, phone, department, notes, lastEmailedAt,
             lastEmailStatus, version, versions: [...], createdAt,
             createdBy, createdByUid, updatedAt, updatedBy }
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[team-directory]';
  var TEAM_PAGE_SIZE = 15;

  var FIELD_KEYS = ['name', 'role', 'email', 'phone', 'department', 'notes', 'reportsToName'];
  var FIELD_LABELS = [
    { key: 'name', label: 'Name' }, { key: 'role', label: 'Role' }, { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' }, { key: 'department', label: 'Department' }, { key: 'reportsToName', label: 'Reports To' }, { key: 'notes', label: 'Notes' }
  ];

  var ctx = { biz: null, proj: null, userEmail: '', userUid: '', isOwner: false, rows: [], editingId: null, sort: { key: null, dir: 'asc' }, page: 1, selected: {} };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var SAMPLE_TEAM = [
    { id: 'sample-1', name: 'Jordan Blake', role: 'Project Manager', email: 'jordan.blake@example.com', phone: '', department: 'PMO', notes: 'Primary point of contact for schedule questions.' },
    { id: 'sample-2', name: 'Sam Lee', role: 'Lead Developer', email: 'sam.lee@example.com', phone: '', department: 'Engineering', notes: '' },
    { id: 'sample-3', name: 'Riley Chen', role: 'QA Lead', email: 'riley.chen@example.com', phone: '', department: 'Quality', notes: '' }
  ];

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function toDate(v) { if (!v) return null; if (v.toDate) return v.toDate(); var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtDate(v) { var d = toDate(v); return d ? (window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString()) : '—'; }

  var card, tbody;
  var nameInput, roleSel, roleTextInput, emailInput, phoneInput, deptSel, deptTextInput, reportsToSel, notesInput;
  var addBtn, cancelEditBtn, sendEmailBtn;

  function canWrite() { return ctx.isOwner; }
  function canActOnRow(id) { return canWrite() && String(id || '').indexOf('sample-') !== 0; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function teamRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default').collection('teamDirectory');
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('teamDirectoryCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    var usingSample = !ctx.rows || !ctx.rows.length;
    var banner = document.getElementById('teamDirectorySampleBanner');
    if (banner) banner.hidden = !usingSample;
    var rows = usingSample ? SAMPLE_TEAM : ctx.rows;

    if (ctx.sort && ctx.sort.key) {
      var key = ctx.sort.key, dir = ctx.sort.dir === 'desc' ? -1 : 1;
      rows = rows.slice().sort(function (a, b) {
        var av = (a[key] || '').toString().toLowerCase(), bv = (b[key] || '').toString().toLowerCase();
        return av < bv ? -1 * dir : av > bv ? dir : 0;
      });
    }

    var totalPages = Math.max(1, Math.ceil(rows.length / TEAM_PAGE_SIZE));
    if (ctx.page > totalPages) ctx.page = totalPages;
    if (ctx.page < 1) ctx.page = 1;
    var pageRows = rows.slice((ctx.page - 1) * TEAM_PAGE_SIZE, ctx.page * TEAM_PAGE_SIZE);

    var info = document.getElementById('teamDirectoryPageInfo');
    var prev = document.getElementById('teamDirectoryPagePrev');
    var next = document.getElementById('teamDirectoryPageNext');
    if (info) info.textContent = 'Page ' + ctx.page + ' of ' + totalPages + ' (' + rows.length + (rows.length === 1 ? ' person' : ' people') + ')';
    if (prev) prev.disabled = ctx.page <= 1;
    if (next) next.disabled = ctx.page >= totalPages;

    document.querySelectorAll('#teamDirectoryTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === ctx.sort.key) th.classList.add(ctx.sort.dir);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="metrics-empty">No team members yet.</td></tr>';
      updateSendButton();
      return;
    }

    tbody.innerHTML = pageRows.map(function (r) {
      var canAct = canActOnRow(r.id);
      var disabledTitle = usingSample ? 'Sample data — add a real entry to edit' : 'Owner only';
      var checkbox = usingSample ? '' : '<input type="checkbox" class="td-select" data-id="' + esc(r.id) + '"' + (ctx.selected[r.id] ? ' checked' : '') + ' />';
      var histBtn = (r.versions && r.versions.length) ? '<button type="button" class="td-history" data-id="' + esc(r.id) + '" title="View history">🕘</button>' : '';
      var editBtn = '<button type="button" class="edit-btn td-edit" data-id="' + esc(r.id) + '"' + (canAct ? '' : ' disabled aria-disabled="true" title="' + disabledTitle + '"') + '>✏️</button>';
      var delBtn = '<button type="button" class="delete-btn td-del" data-id="' + esc(r.id) + '"' + (canAct ? '' : ' disabled aria-disabled="true" title="' + disabledTitle + '"') + '>🗑️</button>';
      var lastEmailed = r.lastEmailedAt ? (esc(fmtDate(r.lastEmailedAt)) + (r.lastEmailStatus ? ' (' + esc(r.lastEmailStatus) + ')' : '')) : '—';
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td>' + checkbox + '</td>' +
        '<td>' + esc(r.name) + '</td>' +
        '<td>' + esc(r.role) + '</td>' +
        '<td>' + esc(r.email) + '</td>' +
        '<td>' + esc(r.phone) + '</td>' +
        '<td>' + esc(r.department) + '</td>' +
        '<td>' + esc(r.reportsToName) + '</td>' +
        '<td>' + lastEmailed + '</td>' +
        '<td>' + histBtn + editBtn + delBtn + '</td></tr>';
    }).join('');

    if (window.drInsight) {
      var text = rows.length + ' team member' + (rows.length === 1 ? '' : 's') + ' on the roster.';
      if (usingSample) text += ' (sample data)';
      window.drInsight.set('teamDirectoryCard', text);
    }
    updateSendButton();
  }

  // ---------------------------------------------------------------------------
  // CRUD + versioning
  // ---------------------------------------------------------------------------
  // Role/Department are "pick from what's already used on this roster, or type a new one" —
  // same pattern as Procurement's vendor picker (a <select> of distinct existing values plus a
  // parallel text input; the typed value wins when the dropdown is left on its placeholder).
  function readForm() {
    var roleSelVal = roleSel ? roleSel.value : '', roleTextVal = roleTextInput ? roleTextInput.value.trim() : '';
    var deptSelVal = deptSel ? deptSel.value : '', deptTextVal = deptTextInput ? deptTextInput.value.trim() : '';
    var reportsToId = reportsToSel ? reportsToSel.value : '';
    var reportsToRow = reportsToId ? ctx.rows.find(function (r) { return r.id === reportsToId; }) : null;
    return {
      name: nameInput ? nameInput.value.trim() : '', role: roleSelVal || roleTextVal,
      email: emailInput ? emailInput.value.trim() : '', phone: phoneInput ? phoneInput.value.trim() : '',
      department: deptSelVal || deptTextVal,
      reportsTo: reportsToId, reportsToName: reportsToRow ? reportsToRow.name : '',
      notes: notesInput ? notesInput.value.trim() : ''
    };
  }
  function clearForm() {
    [nameInput, roleTextInput, emailInput, phoneInput, deptTextInput, notesInput].forEach(function (el) { if (el) el.value = ''; });
    [roleSel, deptSel, reportsToSel].forEach(function (el) { if (el) el.value = ''; });
  }
  function selectHasValue(sel, val) {
    if (!sel) return false;
    return Array.prototype.some.call(sel.options, function (o) { return o.value === val; });
  }
  // Rebuilt from the roster's own real rows (never sample data) each time it changes — no separate
  // "roles directory" to maintain; whatever gets typed once becomes pickable for the next person.
  function fillDerivedSelect(sel, placeholder, values) {
    if (!sel) return;
    var keep = sel.value;
    sel.innerHTML = '<option value="">' + placeholder + '</option>' + values.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
    sel.value = values.indexOf(keep) !== -1 ? keep : '';
  }
  function populateRoleDeptSelects() {
    var roles = {}, depts = {};
    (ctx.rows || []).forEach(function (r) { if (r.role) roles[r.role] = 1; if (r.department) depts[r.department] = 1; });
    fillDerivedSelect(roleSel, 'Role/Title: pick existing…', Object.keys(roles).sort());
    fillDerivedSelect(deptSel, 'Department: pick existing…', Object.keys(depts).sort());
  }
  // Excludes whichever row is currently being edited, so a member can never
  // be set to report to themself — the org chart (orgChart.js) reads this
  // same reportsTo/reportsToName field to build its tree, and a self-loop
  // there would recurse forever without the cycle guard it also has.
  function populateReportsToSelect() {
    if (!reportsToSel) return;
    var keep = reportsToSel.value;
    var candidates = (ctx.rows || []).filter(function (r) { return r.id !== ctx.editingId; })
      .slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    reportsToSel.innerHTML = '<option value="">Reports To: none</option>' +
      candidates.map(function (r) { return '<option value="' + esc(r.id) + '">' + esc(r.name) + (r.role ? (' — ' + esc(r.role)) : '') + '</option>'; }).join('');
    reportsToSel.value = candidates.some(function (r) { return r.id === keep; }) ? keep : '';
  }

  function addMember() {
    if (!nameInput || !canWrite()) return;
    var data = readForm();
    if (!data.name) return;
    var ref = teamRef();
    if (!ref) return;
    var ts = (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue && window.firebase.firestore.FieldValue.serverTimestamp()) || new Date();
    data.version = 1; data.versions = [];
    data.createdAt = ts; data.createdBy = ctx.userEmail || ''; data.createdByUid = ctx.userUid || '';
    ref.add(data).catch(function (err) { console.error(ns, 'addMember error', err); alert('Could not save — please try again: ' + (err && err.message ? err.message : err)); });
    clearForm();
  }

  function startEdit(id) {
    var row = ctx.rows.find(function (r) { return r.id === id; });
    if (!row || !nameInput || !canActOnRow(id)) return;
    ctx.editingId = id;
    if (nameInput) nameInput.value = row.name || '';
    var roleKnown = selectHasValue(roleSel, row.role || '');
    if (roleSel) roleSel.value = roleKnown ? (row.role || '') : '';
    if (roleTextInput) roleTextInput.value = roleKnown ? '' : (row.role || '');
    if (emailInput) emailInput.value = row.email || '';
    if (phoneInput) phoneInput.value = row.phone || '';
    var deptKnown = selectHasValue(deptSel, row.department || '');
    if (deptSel) deptSel.value = deptKnown ? (row.department || '') : '';
    if (deptTextInput) deptTextInput.value = deptKnown ? '' : (row.department || '');
    populateReportsToSelect(); // rebuilt now that ctx.editingId is set, so this row can't report to itself
    if (reportsToSel) reportsToSel.value = row.reportsTo || '';
    if (notesInput) notesInput.value = row.notes || '';
    if (addBtn) addBtn.textContent = 'Update';
    if (cancelEditBtn) cancelEditBtn.style.display = '';
  }

  function cancelEdit() {
    ctx.editingId = null;
    if (addBtn) addBtn.textContent = 'Add';
    if (cancelEditBtn) cancelEditBtn.style.display = 'none';
    clearForm();
    populateReportsToSelect();
  }

  function saveEdit() {
    if (!ctx.editingId || !canWrite()) return;
    var ref = teamRef();
    if (!ref || !nameInput) return;
    var row = ctx.rows.find(function (r) { return r.id === ctx.editingId; }) || {};
    var payload = readForm();
    if (!payload.name) return;

    var prevVersion = row.version || 0;
    var versionEntry = prevVersion ? { version: prevVersion, savedAt: row.updatedAt || row.createdAt || null, savedBy: row.updatedBy || row.createdBy || '' } : null;
    if (versionEntry) FIELD_KEYS.forEach(function (k) { versionEntry[k] = row[k] || ''; });
    payload.version = prevVersion + 1;
    payload.versions = versionEntry ? (row.versions || []).concat([versionEntry]) : (row.versions || []);
    payload.updatedAt = new Date();
    payload.updatedBy = ctx.userEmail || '';

    ref.doc(ctx.editingId).update(payload).catch(function (err) { console.error(ns, 'saveEdit error', err); alert('Could not save — please try again: ' + (err && err.message ? err.message : err)); });

    ctx.editingId = null;
    if (addBtn) addBtn.textContent = 'Add';
    if (cancelEditBtn) cancelEditBtn.style.display = 'none';
    clearForm();
    populateReportsToSelect();
  }

  function deleteMember(id) {
    if (!canActOnRow(id)) return;
    var ref = teamRef();
    if (!ref) return;
    var confirmed = window.drConfirm ? window.drConfirm('Delete this team member? This cannot be undone.', { title: 'Delete Team Member' }) : Promise.resolve(window.confirm('Delete this team member?'));
    confirmed.then(function (ok) {
      if (!ok) return;
      ref.doc(id).delete().catch(function (err) { console.error(ns, 'deleteMember error', err); });
      delete ctx.selected[id];
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
    window.drModal.open({ title: 'Team member history — ' + (row.name || ''), bodyHtml: html || '<p>No earlier versions yet.</p>' });
  }

  // ---------------------------------------------------------------------------
  // Send email
  // ---------------------------------------------------------------------------
  function selectedCount() { return Object.keys(ctx.selected).length; }
  function updateSendButton() { if (sendEmailBtn) sendEmailBtn.disabled = selectedCount() === 0; }
  function toggleSelect(id, checked) { if (checked) ctx.selected[id] = true; else delete ctx.selected[id]; updateSendButton(); }

  function errorText(err) {
    var code = String((err && err.code) || '').replace(/^functions\//, '');
    if (code === 'permission-denied') return 'Only the Owner can send email from the Team Directory.';
    return (err && err.message) || 'Something went wrong.';
  }

  function openCompose() {
    if (!selectedCount()) return;
    var names = Object.keys(ctx.selected).map(function (id) {
      var row = ctx.rows.find(function (r) { return r.id === id; });
      return row ? (row.name + ' <' + row.email + '>') : id;
    });
    var toEl = $('#td-compose-to'); if (toEl) toEl.textContent = names.join(', ');
    var subjEl = $('#td-compose-subject'); if (subjEl) subjEl.value = '';
    var bodyEl = $('#td-compose-body'); if (bodyEl) bodyEl.value = '';
    var statusEl = $('#td-compose-status'); if (statusEl) statusEl.textContent = '';
    var overlay = document.getElementById('teamEmailComposeOverlay');
    if (overlay) { overlay.classList.add('is-open'); overlay.setAttribute('aria-hidden', 'false'); }
  }
  function closeCompose() {
    var overlay = document.getElementById('teamEmailComposeOverlay');
    if (overlay) { overlay.classList.remove('is-open'); overlay.setAttribute('aria-hidden', 'true'); }
  }
  function sendCompose() {
    var subjEl = $('#td-compose-subject'), bodyEl = $('#td-compose-body'), statusEl = $('#td-compose-status'), btn = $('#td-compose-send');
    var subject = subjEl ? subjEl.value.trim() : '', body = bodyEl ? bodyEl.value.trim() : '';
    if (!subject || !body) { alert('A subject and message are required.'); return; }
    var recipients = Object.keys(ctx.selected).map(function (id) {
      var row = ctx.rows.find(function (r) { return r.id === id; });
      return row ? { id: id, name: row.name, email: row.email } : null;
    }).filter(Boolean);
    if (!recipients.length) return;

    var call = window.functions && window.functions.httpsCallable ? window.functions.httpsCallable('sendTeamEmail', { timeout: 60000 }) : null;
    if (!call) { alert('Email sending is not available right now — try again in a moment.'); return; }

    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Sending…';
    call({ bizKey: ctx.biz, projKey: ctx.proj, recipients: recipients, subject: subject, body: body })
      .then(function (res) {
        var d = (res && res.data) || {};
        if (statusEl) statusEl.textContent = 'Sent to ' + (d.sent || 0) + ' of ' + recipients.length + (d.failed ? '; ' + d.failed + ' failed' : '') + '.';
        ctx.selected = {};
        updateSendButton();
      })
      .catch(function (err) {
        if (statusEl) statusEl.textContent = '';
        alert('Could not send: ' + errorText(err));
      })
      .finally(function () { if (btn) btn.disabled = false; });
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------
  function bindTableEvents() {
    if (!tbody) return;
    tbody.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t) return;
      if (t.classList.contains('td-edit')) startEdit(t.getAttribute('data-id'));
      else if (t.classList.contains('td-del')) deleteMember(t.getAttribute('data-id'));
      else if (t.classList.contains('td-history')) showHistory(t.getAttribute('data-id'));
    });
    tbody.addEventListener('change', function (ev) {
      var t = ev.target;
      if (t && t.classList.contains('td-select')) toggleSelect(t.getAttribute('data-id'), t.checked);
    });
  }
  function bindPagination() {
    var prevBtn = document.getElementById('teamDirectoryPagePrev'), nextBtn = document.getElementById('teamDirectoryPageNext');
    if (prevBtn) prevBtn.addEventListener('click', function () { ctx.page--; paint(); });
    if (nextBtn) nextBtn.addEventListener('click', function () { ctx.page++; paint(); });
  }
  function bindAdd() {
    if (!addBtn) return;
    addBtn.addEventListener('click', function () { if (ctx.editingId) saveEdit(); else addMember(); });
    if (cancelEditBtn) cancelEditBtn.addEventListener('click', cancelEdit);
  }
  function bindSortHeader() {
    var thead = document.querySelector('#teamDirectoryTable thead');
    if (!thead) return;
    thead.addEventListener('click', function (ev) {
      var th = ev.target.closest('th[data-sort]');
      if (!th) return;
      var key = th.getAttribute('data-sort');
      if (ctx.sort.key === key) ctx.sort.dir = ctx.sort.dir === 'asc' ? 'desc' : 'asc'; else { ctx.sort.key = key; ctx.sort.dir = 'asc'; }
      paint();
    });
  }
  function bindCompose() {
    if (sendEmailBtn) sendEmailBtn.addEventListener('click', openCompose);
    var closeBtn = document.getElementById('teamEmailComposeClose');
    if (closeBtn) closeBtn.addEventListener('click', closeCompose);
    var overlay = document.getElementById('teamEmailComposeOverlay');
    if (overlay) overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeCompose(); });
    var sendBtn = $('#td-compose-send');
    if (sendBtn) sendBtn.addEventListener('click', sendCompose);
  }

  function listenTeam() {
    var ref = teamRef();
    if (!ref) return;
    ref.orderBy('name').onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.rows = rows;
      // Drop selections for rows that no longer exist (deleted elsewhere).
      Object.keys(ctx.selected).forEach(function (id) { if (!rows.some(function (r) { return r.id === id; })) delete ctx.selected[id]; });
      populateRoleDeptSelects();
      populateReportsToSelect();
      paint();
    }, function (err) {
      console.warn(ns, 'listen error (expected if not granted view access)', err && err.code);
    });
  }

  function detectContextFromDOM() {
    card = document.getElementById('teamDirectoryCard');
    tbody = $('#teamDirectoryTable tbody');
    nameInput = $('#td-name'); roleSel = $('#td-role'); roleTextInput = $('#td-role-text'); emailInput = $('#td-email');
    phoneInput = $('#td-phone'); deptSel = $('#td-department'); deptTextInput = $('#td-department-text');
    reportsToSel = $('#td-reports-to'); notesInput = $('#td-notes');
    addBtn = $('#td-add'); cancelEditBtn = $('#td-cancel-edit'); sendEmailBtn = $('#td-send-email-btn');

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';

    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.userUid = (user && user.uid) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function applyWriteAccess() {
    var addOnlyEls = document.querySelectorAll('.td-add-only');
    for (var i = 0; i < addOnlyEls.length; i++) {
      var el = addOnlyEls[i];
      if (el.id === 'td-cancel-edit') { if (!canWrite()) el.style.display = 'none'; continue; }
      el.style.display = canWrite() ? '' : 'none';
    }
    if (sendEmailBtn) sendEmailBtn.style.display = ctx.isOwner ? '' : 'none';
    paint();
  }

  function init() {
    detectContextFromDOM();
    if (!ctx.biz || !card) return;
    bindTableEvents();
    bindPagination();
    bindAdd();
    bindSortHeader();
    bindCompose();
    listenTeam();
    if (window.drAccess) window.drAccess.whenReady().then(applyWriteAccess);
    else applyWriteAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
