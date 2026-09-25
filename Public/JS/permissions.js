// Public/JS/permissions.js
// Settings > Permissions — a genuinely separate browser window (per
// explicit request) listing every report/chart (same list report-index.js
// builds its sidebar from) with a checkbox per role: Owner, Client
// Partner, Project Manager, Admin, Member. The matrix saved here is read
// by Public/JS/dr-access-control.js to actually hide/show cards and
// actions per role — this is no longer configuration-only.
//
// Per-PROJECT, not company-wide (businesses/{biz}/projects/{proj}), to
// match the per-project roles built alongside the multi-project feature —
// a user's role only exists as a projects/{proj}/members/{uid} doc, so the
// matrix that role is checked against has to live at the same scope.
//
// Same window.opener-callback pattern as the milestone checklist and the
// Risk Register's "Contributing to SPI" checkbox: the popup has no
// Firebase access of its own, so every checkbox change calls back into
// this (already-connected) page to do the actual read/write.

(function () {
  'use strict';

  var TAG = '[permissions]';
  function log() { console.log.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function warn() { console.warn.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function error() { console.error.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }

  var db = null;
  var bizKey = null;
  var projKey = null;

  var ROLES = [
    { key: 'owner', label: 'Owner' },
    { key: 'clientPartner', label: 'Client Partner' },
    { key: 'projectManager', label: 'Project Manager' },
    { key: 'admin', label: 'Admin' },
    { key: 'member', label: 'Member' }
  ];

  // Hand-maintained: reportId -> the concrete actions that card actually
  // supports, so a role's permission can be scoped down to specific
  // functionality (Add/Edit/Delete/Upload/etc.) instead of only "can see
  // this report at all". Cards with no interactive functionality (pure
  // charts — Burndown, EVM, Status Snapshot, etc.) are simply absent
  // here and show no action sub-rows.
  var ACTIONS = {
    milestoneSection: ['Add', 'Edit', 'Delete', 'Checklist'],
    qnaSection: ['Add', 'Respond', 'Mark Done', 'Delete'],
    fileManagerSection: ['Upload', 'Download', 'Delete'],
    riskRegisterCard: ['Import', 'Contributing to SPI'],
    assumptionsLogCard: ['Import'],
    constraintsLogCard: ['Import'],
    raciCard: ['Import'],
    qualityDefectsCard: ['Import'],
    resourceHoursCard: ['Import'],
    changeReportBtn: ['Download CSV'],
    dataImportsOverlay: ['Find Duplicates'],
    stakeholderRegisterCard: ['Add', 'Edit', 'Delete'],
    teamDirectoryCard: ['Add', 'Edit', 'Delete'],
    communicationsPlanCard: ['Add', 'Edit', 'Delete'],
    benefitsRealizationCard: ['Add', 'Edit', 'Delete', 'Log Reading'],
    projectClosureCard: ['Check Item', 'Add Item', 'Save Report'],
    glossaryCard: ['Add', 'Edit', 'Delete'],
    baselineChangeCard: ['Add', 'Edit', 'Delete'],
    riskReserveCard: ['Set Total', 'Log Draw', 'Delete Draw'],
    requirementsTraceabilityCard: ['Add', 'Edit', 'Delete'],
    communicationsLogCard: ['Log Entry', 'Delete Entry'],
    costOfQualityCard: ['Log Entry', 'Delete Entry'],
    // Any project member can submit at the rules layer; this grant can
    // only narrow that (same as Q&A's actions). Owner/sponsor decisions
    // are role-based in the rules, not grantable here.
    changeControlLogCard: ['Submit'],
    decisionLogCard: ['Add', 'Edit', 'Delete'],
    // Any project member can log at the rules layer; this grant can only
    // narrow that. Edit/delete of an existing lesson is owner-or-author in
    // the rules, not grantable here.
    lessonsLearnedCard: ['Add'],
    dependenciesCard: ['Add', 'Edit', 'Delete'],
    // Items only; the accept/reject DECISION is role-based (Client Partner or
    // owner) in the rules, not grantable here.
    deliverableSignoffCard: ['Add', 'Edit', 'Delete'],
    // Governs BOTH the purchases and the vendors list on this card.
    procurementCard: ['Add', 'Edit', 'Delete']
  };

  // Actions whose underlying Firestore write is hardcoded owner-only at
  // the security-rules layer regardless of this matrix (Import/Find
  // Duplicates write flat fields on the project doc; Contributing to SPI
  // goes through the same owner-only doc-update path) — the Change
  // Request workflow that would let a non-owner role actually perform
  // these (a separate, not-yet-built phase) doesn't exist yet. Checking
  // one of these for a non-owner role here would render a button that
  // just fails with a permission error when clicked, so their checkboxes
  // are disabled for every non-owner role instead (see BACKEND_LOCKED
  // usage in openPermissionsWindow below). Keyed by actionSlug().
  //
  // Meetings/Events' Add/Edit/Delete/Checklist are deliberately NOT
  // listed here — the owner asked for those to be freely selectable per
  // role in this screen even though the underlying milestone.js code and
  // Firestore rules haven't been wired to actually enforce them yet
  // (still hardcoded owner-only there, unchanged, on purpose — the owner
  // explicitly didn't want milestones/rules touched). Checking a box here
  // for these four actions saves normally but has no real effect on the
  // dashboard until that enforcement is built later.
  var BACKEND_LOCKED = {
    riskRegisterCard: ['import', 'contributingToSpi'],
    assumptionsLogCard: ['import'],
    constraintsLogCard: ['import'],
    raciCard: ['import'],
    qualityDefectsCard: ['import'],
    resourceHoursCard: ['import'],
    dataImportsOverlay: ['findDuplicates'],
    // Add/Edit/Delete are real owner-only writes at the rules layer for
    // this card (see firestore.rules's stakeholders block) — unlike the
    // Meetings/Events note above, this one's enforcement genuinely
    // exists from day one, so these checkboxes are correctly disabled
    // for every non-owner role rather than being a placeholder.
    stakeholderRegisterCard: ['add', 'edit', 'delete'],
    // Same reasoning — real owner-only writes (firestore.rules's teamDirectory
    // block); "send email" isn't a grantable action at all (owner-only,
    // ungated, see team-email-handler.js), so it has no row here.
    teamDirectoryCard: ['add', 'edit', 'delete'],
    // Same reasoning — real owner-only writes (firestore.rules's communicationsPlan block).
    communicationsPlanCard: ['add', 'edit', 'delete'],
    // Same reasoning — real owner-only writes (firestore.rules's benefitsRealization block);
    // logging a reading is also just an update on this doc, so it's owner-only too.
    benefitsRealizationCard: ['add', 'edit', 'delete', 'logReading'],
    // Same reasoning — real owner-only writes (firestore.rules's projectClosure/
    // closureReports blocks).
    projectClosureCard: ['checkItem', 'addItem', 'saveReport'],
    // Same reasoning — real owner-only writes (firestore.rules's glossary block).
    glossaryCard: ['add', 'edit', 'delete'],
    // Same reasoning — real owner-only writes (firestore.rules's baselineChanges block).
    baselineChangeCard: ['add', 'edit', 'delete'],
    // Same reasoning — real owner-only writes (firestore.rules's riskReserve/reserveDraws blocks).
    riskReserveCard: ['setTotal', 'logDraw', 'deleteDraw'],
    // Same reasoning — real owner-only writes (firestore.rules's requirements block).
    requirementsTraceabilityCard: ['add', 'edit', 'delete'],
    // Same reasoning — real owner-only writes (firestore.rules's communicationsLog block).
    communicationsLogCard: ['logEntry', 'deleteEntry'],
    // Same reasoning — real owner-only writes (firestore.rules's costOfQuality block).
    costOfQualityCard: ['logEntry', 'deleteEntry'],
    // Locked for Admin/Member only — Client Partner and Project Manager are
    // exempted via ACTION_WRITE_ROLES below (firestore.rules decisions block).
    decisionLogCard: ['add', 'edit', 'delete'],
    dependenciesCard: ['add', 'edit', 'delete'],
    deliverableSignoffCard: ['add', 'edit', 'delete'],
    procurementCard: ['add', 'edit', 'delete']
  };
  // Roles that can still be granted an otherwise backend-locked action
  // because the rules genuinely enforce that grant for them.
  var ACTION_WRITE_ROLES = {
    decisionLogCard: ['clientPartner', 'projectManager'],
    dependenciesCard: ['clientPartner', 'projectManager'],
    deliverableSignoffCard: ['clientPartner', 'projectManager'],
    procurementCard: ['clientPartner', 'projectManager']
  };
  // Reports that bypass this matrix entirely for VIEW access (dr-access-
  // control.js's own ALWAYS_VISIBLE_REPORTS) — currently none; Meetings/
  // Events' top-level visibility was made grantable, then reverted to
  // always-open, then reverted again to a normal selectable checkbox per
  // the owner's latest request, matching every other card.
  var ALWAYS_VISIBLE_IDS = {};

  function isActionBackendLocked(reportId, slug) {
    var locked = BACKEND_LOCKED[reportId];
    return !!locked && locked.indexOf(slug) !== -1;
  }

  // "Mark Done" -> "markDone", "Download CSV" -> "downloadCsv" — a safe,
  // stable Firestore field-path segment for each action name.
  function actionSlug(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+(.)/g, function (_, c) { return c.toUpperCase(); });
  }

  function resolveBusinessKey() {
    var params = new URLSearchParams(window.location.search || '');
    return params.get('business') || (window.localStorage && window.localStorage.getItem('businessKey')) || window.BIZ_KEY || null;
  }

  function resolveProjectKey() {
    return window.PROJECT_KEY || (window.localStorage && window.localStorage.getItem('projectKey')) || 'default';
  }

  function projectRef() {
    return db.collection('businesses').doc(bizKey).collection('projects').doc(projKey);
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // Converts a single dotted field-path key into the equivalent nested
  // object, e.g. dottedToNested('a.b.c', true) -> {a:{b:{c:true}}}.
  function dottedToNested(dottedKey, value) {
    var parts = dottedKey.split('.');
    var root = {};
    var cursor = root;
    for (var i = 0; i < parts.length - 1; i++) {
      cursor[parts[i]] = {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
    return root;
  }

  // update() correctly interprets a dotted-string field-path key
  // ('reportPermissions.projectStatusCard.member') as a nested path —
  // set(field, {merge:true}) does NOT; it writes one literal top-level
  // field whose NAME contains dots, silently discarding the intended
  // nested structure (verified against the emulator — this was a real,
  // long-standing bug: every checkbox in this screen appeared to save
  // successfully but never actually persisted as read-back-able data).
  // update() requires the doc to already exist, which is normally true
  // (a project is created with {name, createdAt} before anyone opens
  // Permissions for it) — the set()-with-a-real-nested-object fallback
  // below covers the rare case where it somehow doesn't yet, since a
  // proper nested object DOES merge correctly with set(...,{merge:true}).
  function writeField(field) {
    return projectRef().update(field).catch(function (err) {
      if (err && (err.code === 'not-found' || err.code === 'NOT_FOUND')) {
        var dottedKey = Object.keys(field)[0];
        return projectRef().set(dottedToNested(dottedKey, field[dottedKey]), { merge: true });
      }
      throw err;
    });
  }

  // Tracked so header.js's Log Out can wait for any still-in-flight
  // Permissions save before navigating away — the popup's own beforeunload
  // guard only protects against closing THAT window mid-save; it can't see
  // a logout click happening in this (opener) tab, which would otherwise
  // abort the write via navigation before Firestore ever gets it, even
  // though the popup already told the user "Saved ✓".
  var pendingSaves = [];
  window.drPermissions_waitForPendingSaves = function () {
    return Promise.all(pendingSaves).catch(function () {});
  };
  function trackPending(promise) {
    pendingSaves.push(promise);
    var settle = function () { pendingSaves = pendingSaves.filter(function (p) { return p !== promise; }); };
    promise.then(settle, settle);
    return promise;
  }

  // Called from the popup window (via window.opener) whenever a checkbox
  // is toggled. Always resolves to {ok, message} — never rejects — so
  // the popup can show the user whether it actually saved.
  window.drPermissions = {
    save: function (reportId, roleKey, checked) {
      if (!db || !bizKey || !projKey) return Promise.resolve({ ok: false, message: 'Not ready yet — please try again.' });
      var field = {};
      field['reportPermissions.' + reportId + '.' + roleKey] = checked;
      return trackPending(writeField(field)).then(function () {
        return { ok: true, message: 'Saved' };
      }).catch(function (err) {
        error('save failed', err);
        var msg = (err && err.code === 'permission-denied')
          ? "You don't have permission to update this."
          : 'Save failed: ' + (err && err.message ? err.message : 'unknown error');
        return { ok: false, message: msg };
      });
    },
    // Same as save() above, but scoped to one specific action within a
    // report (e.g. "can this role Delete in Meetings/Events") rather than
    // the report as a whole.
    saveAction: function (reportId, actionKey, roleKey, checked) {
      if (!db || !bizKey || !projKey) return Promise.resolve({ ok: false, message: 'Not ready yet — please try again.' });
      var field = {};
      field['reportPermissions.' + reportId + '.actions.' + actionKey + '.' + roleKey] = checked;
      return trackPending(writeField(field)).then(function () {
        return { ok: true, message: 'Saved' };
      }).catch(function (err) {
        error('save action failed', err);
        var msg = (err && err.code === 'permission-denied')
          ? "You don't have permission to update this."
          : 'Save failed: ' + (err && err.message ? err.message : 'unknown error');
        return { ok: false, message: msg };
      });
    }
  };

  function loadPermissions() {
    return projectRef().get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      return data.reportPermissions || {};
    }).catch(function (err) {
      error('load failed', err);
      return {};
    });
  }

  function openPermissionsWindow() {
    // window.drAllReportEntries (report-index.js) is the unfiltered list —
    // includes action-only entries like Change Report / Data Imports that
    // window.drReportList deliberately excludes (they're not scrollable
    // cards). Only keep real cards, plus action-only entries that either
    // have a real ACTIONS mapping (Change Report, Data Imports) or are in
    // GOVERNED_ACTION_ONLY_IDS (Permissions, Insight Mode — gated on
    // whether a role can open them at all, with no action sub-rows) —
    // the rest (Manage Project Access, Language) aren't reports to grant
    // role access to. Kept in sync by hand with report-index.js's own
    // MATRIX_GOVERNED_ACTIONS, same as ACTIONS below.
    // askProjectAction / statusReportAction / the two AI-wording rows are gated per role here too.
    var GOVERNED_ACTION_ONLY_IDS = { settingsPermissionsAction: true, insightModeOverlay: true, askProjectAction: true, statusReportAction: true, aiExecutiveVersionAction: true, aiDetailVersionAction: true };
    var reports = (window.drAllReportEntries || window.drReportList || []).filter(function (r) {
      return !r.action || ACTIONS[r.id] || GOVERNED_ACTION_ONLY_IDS[r.id];
    });
    if (!reports.length) {
      alert('Report list not loaded yet — please try again in a moment.');
      return;
    }

    loadPermissions().then(function (perms) {
      var headerCells = ROLES.map(function (r) { return '<th>' + esc(r.label) + '</th>'; }).join('');
      var rows = reports.map(function (rep) {
        var repPerm = perms[rep.id] || {};
        // Kept in sync by hand with dr-access-control.js's own
        // ALWAYS_VISIBLE_REPORTS — that card bypasses this matrix
        // entirely, so its top-level checkboxes would just be misleading
        // (checking/unchecking one has no effect) if left interactive.
        var alwaysVisible = ALWAYS_VISIBLE_IDS[rep.id];
        var cells = ROLES.map(function (role) {
          var checked = repPerm[role.key] === true ? ' checked' : '';
          var disabled = alwaysVisible ? ' disabled title="Always visible to every role — not gated by this matrix."' : '';
          return '<td style="text-align:center;"><input type="checkbox" data-report="' + esc(rep.id) + '" data-role="' + role.key + '"' + checked + disabled + ' /></td>';
        }).join('');
        var alwaysVisibleMark = alwaysVisible ? ' <span style="color:#2f9e44;font-weight:400;">(always visible)</span>' : '';
        var mainRow = '<tr><td>' + esc(rep.label) + alwaysVisibleMark + '</td>' + cells + '</tr>';

        // Action sub-rows — only for cards that actually have
        // add/edit/delete/upload-style functionality (see ACTIONS above).
        var actionRows = (ACTIONS[rep.id] || []).map(function (actionLabel) {
          var slug = actionSlug(actionLabel);
          var actionPerm = (repPerm.actions && repPerm.actions[slug]) || {};
          var locked = isActionBackendLocked(rep.id, slug);
          var actionCells = ROLES.map(function (role) {
            var checked = actionPerm[role.key] === true ? ' checked' : '';
            // Backend-locked actions (Import, schedule edits, etc.) can
            // never actually work for a non-owner yet — see BACKEND_LOCKED
            // above — so their checkbox is disabled for every role but
            // Owner, instead of silently accepting a grant that would just
            // produce a failing button.
            var exempt = (ACTION_WRITE_ROLES[rep.id] || []).indexOf(role.key) !== -1;
            var disabled = (locked && role.key !== 'owner' && !exempt) ?' disabled title="Not available yet — this action still requires owner access until the change-request workflow is built."' : '';
            return '<td style="text-align:center;"><input type="checkbox" data-report="' + esc(rep.id) + '" data-action="' + esc(slug) + '" data-role="' + role.key + '"' + checked + disabled + ' /></td>';
          }).join('');
          var lockMark = locked ? ' 🔒' : '';
          return '<tr class="action-row"><td class="action-label">↳ ' + esc(actionLabel) + lockMark + '</td>' + actionCells + '</tr>';
        }).join('');

        return mainRow + actionRows;
      }).join('');

      var html = '<!doctype html><html><head><meta charset="utf-8"><title>Report Permissions</title><style>' +
        'body{font-family:Arial,Helvetica,sans-serif;margin:20px;color:#222;}' +
        'h1{font-size:1.25rem;margin:0 0 2px;}' +
        'p.sub{color:#666;font-size:0.85rem;margin:0 0 16px;}' +
        'table{border-collapse:collapse;width:100%;font-size:0.85rem;}' +
        'th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:middle;}' +
        'th{background:#f3f3f3;position:sticky;top:0;}' +
        '.action-row td{background:#fafbfc;}' +
        '.action-label{padding-left:24px !important;color:#555;font-size:0.82rem;}' +
        '.logo-row{display:flex;align-items:center;gap:10px;margin:0 0 16px;padding-bottom:12px;border-bottom:1px solid #ddd;}' +
        '.logo-row button{padding:6px 14px;border-radius:6px;border:1px solid #004e92;background:#fff;color:#004e92;cursor:pointer;font-size:0.85rem;}' +
        '.logo-row button:hover{background:#f0f6ff;}' +
        '#logoStatus{font-size:0.8rem;color:#666;}' +
        // Sticky footer bar so Save Changes stays reachable without
        // scrolling back down through a long table.
        '#saveBar{position:sticky;bottom:0;background:#fff;border-top:1px solid #ddd;padding:12px 0;margin-top:16px;display:flex;align-items:center;gap:12px;}' +
        '#saveBtn{padding:8px 20px;border-radius:6px;border:none;background:#0b5cff;color:#fff;font-size:0.9rem;font-weight:600;cursor:pointer;}' +
        '#saveBtn:disabled{background:#9db8e8;cursor:not-allowed;}' +
        '#saveStatus{font-size:0.85rem;min-height:1.2em;}' +
        '#saveStatus.ok{color:#2f9e44;}' +
        '#saveStatus.err{color:#dd3333;font-weight:600;}' +
        '#pendingNote{font-size:0.8rem;color:#b8860b;}' +
        '</style></head><body>' +
        '<h1>Report Permissions</h1>' +
        '<p class="sub">Which roles can access each report/chart — and, where a card has real functionality (rows marked with ↳ below it), which roles can use each specific action. A role sees a report/action only once its box here is checked and saved — this is enforced live on the dashboard. Rows marked 🔒 can\'t be granted to non-owner roles yet (still owner-only until the change-request workflow is built), regardless of any checkbox. Checking boxes below does NOT save automatically — click Save Changes when you\'re done.</p>' +
        '<div class="logo-row"><strong>Company Logo:</strong><button type="button" id="popupUploadLogoBtn">Upload Logo</button><span id="logoStatus"></span></div>' +
        '<table><thead><tr><th>Report</th>' + headerCells + '</tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div id="saveBar">' +
        '<button type="button" id="saveBtn" disabled>Save Changes</button>' +
        '<span id="pendingNote"></span>' +
        '<span id="saveStatus"></span>' +
        '</div>' +
        '<script>' +
        'var statusEl=document.getElementById("saveStatus");' +
        'var pendingEl=document.getElementById("pendingNote");' +
        'var saveBtn=document.getElementById("saveBtn");' +
        'var checkboxes=Array.prototype.slice.call(document.querySelectorAll("input[type=checkbox][data-report]"));' +
        // Snapshot each checkbox's starting state so Save Changes only
        // writes ones actually touched this session, and the pending
        // count/enabled state reflects real unsaved edits, not every row.
        'checkboxes.forEach(function(cb){cb.dataset.original=cb.checked?"1":"0";});' +
        'function pendingCheckboxes(){' +
        'return checkboxes.filter(function(cb){return (cb.checked?"1":"0")!==cb.dataset.original;});' +
        '}' +
        'function refreshSaveBtn(){' +
        'var n=pendingCheckboxes().length;' +
        'saveBtn.disabled=n===0;' +
        'pendingEl.textContent=n?(n+" unsaved change"+(n===1?"":"s")):"";' +
        '}' +
        'checkboxes.forEach(function(cb){cb.addEventListener("change",refreshSaveBtn);});' +
        'refreshSaveBtn();' +
        'var saving=false;' +
        // Guards against the most likely cause of "checked boxes, clicked
        // Save, but nothing actually saved": closing this popup while the
        // Firestore writes are still in flight kills them mid-request. The
        // native confirm-before-leaving dialog is the right tool here
        // (unlike the dashboard's own back-button trap elsewhere in this
        // app) — this is a short-lived config popup where losing an
        // in-progress save really would lose data, not a page someone
        // should be blocked from ever leaving.
        'window.addEventListener("beforeunload",function(e){' +
        'if(!saving)return;' +
        'e.preventDefault();e.returnValue="";' +
        '});' +
        'saveBtn.addEventListener("click",function(){' +
        'if(!(window.opener&&window.opener.drPermissions)){statusEl.className="err";statusEl.textContent="Could not reach the dashboard tab to save — keep this window open alongside it.";return;}' +
        'var pending=pendingCheckboxes();' +
        'if(!pending.length)return;' +
        'saving=true;' +
        'saveBtn.disabled=true;statusEl.className="";statusEl.textContent="Saving "+pending.length+" change"+(pending.length===1?"":"s")+"… (keep this window open)";' +
        'Promise.all(pending.map(function(cb){' +
        'var actionKey=cb.getAttribute("data-action");' +
        'var p=actionKey' +
        '?window.opener.drPermissions.saveAction(cb.getAttribute("data-report"),actionKey,cb.getAttribute("data-role"),cb.checked)' +
        ':window.opener.drPermissions.save(cb.getAttribute("data-report"),cb.getAttribute("data-role"),cb.checked);' +
        'return p.then(function(result){return {cb:cb,result:result};}).catch(function(err){return {cb:cb,result:{ok:false,message:(err&&err.message)?err.message:"Unknown error"}};});' +
        '})).then(function(outcomes){' +
        'saving=false;' +
        'var failed=outcomes.filter(function(o){return !o.result.ok;});' +
        'outcomes.forEach(function(o){if(o.result.ok)o.cb.dataset.original=o.cb.checked?"1":"0";});' +
        'if(failed.length){' +
        'statusEl.className="err";' +
        'statusEl.textContent=failed.length+" of "+outcomes.length+" change(s) failed to save: "+failed[0].result.message;' +
        '}else{' +
        'statusEl.className="ok";' +
        'statusEl.textContent="Saved "+outcomes.length+" change"+(outcomes.length===1?"":"s")+" ✓ — safe to close now.";' +
        '}' +
        'refreshSaveBtn();' +
        '}).catch(function(err){' +
        'saving=false;' +
        'saveBtn.disabled=false;' +
        'statusEl.className="err";' +
        'statusEl.textContent="Save failed unexpectedly: "+((err&&err.message)?err.message:"unknown error")+" — please try again.";' +
        '});' +
        '});' +
        // Same underlying upload as the header/Data Imports — this button
        // has no upload logic of its own, it just clicks the hidden
        // #logoFileInput on the OPENER (dashboard) tab, so there's still
        // exactly one upload code path (header.js's wireUpload).
        'var logoStatusEl=document.getElementById("logoStatus");' +
        'document.getElementById("popupUploadLogoBtn").addEventListener("click",function(){' +
        'if(!(window.opener&&window.opener.document)){logoStatusEl.textContent="Could not reach the dashboard tab — keep this window open alongside it.";return;}' +
        'var input=window.opener.document.getElementById("logoFileInput");' +
        'if(!input){logoStatusEl.textContent="Could not find the upload control on the dashboard tab.";return;}' +
        'logoStatusEl.textContent="Choose a file in the picker that opened on the dashboard tab…";' +
        'input.click();' +
        '});' +
        '</script>' +
        '</body></html>';

      var win = window.open('', '_blank', 'width=900,height=700');
      if (!win) { alert('Please allow pop-ups to view Permissions in a new window.'); return; }
      win.document.open();
      win.document.write(html);
      win.document.close();
    });
  }

  window.drOpenPermissionsWindow = openPermissionsWindow;

  function start() {
    db = window.db || null;
    if (!db) { setTimeout(start, 200); return; }
    bizKey = resolveBusinessKey();
    if (!bizKey) { setTimeout(start, 300); return; }
    projKey = resolveProjectKey();
    log('initialized', { bizKey: bizKey, projKey: projKey });
  }

  start();
})();
