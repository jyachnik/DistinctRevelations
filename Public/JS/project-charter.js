/* ============================================================================
   Project Charter — what this project IS: purpose, sponsor, business
   case, success criteria, scope in/out, and key assumptions. Distinct
   from Team Charter (how the team agrees to work together — see
   teamCharter.js) and Team Directory (the contact roster).

   Owner-editable, single document, versioned: every Save snapshots the
   current narrative fields into versions[] before writing the new ones,
   so "View History" always shows exactly what the charter said at any
   past point. Milestones/Budget/Assumptions sections below the form are
   LIVE READ-ONLY ROLLUPS, not stored here — they're computed fresh from
   the same milestones collection / project-doc cost fields / Constraints
   Log every other card already reads, so they can never drift stale the
   way retyped copies would.

   Also keeps the previous "open the uploaded charter document" shortcut
   (findAndOpenDocument, below) as one button inside this card instead of
   a separate top-level menu entry — there's now one "Project Charter" in
   Reports, not two different things both called that.

   Firestore: businesses/{biz}/projects/{proj}/charter/main
   Fields: { purpose, sponsor, businessCase, successCriteria, scopeIn,
             scopeOut, keyAssumptions, version, versions: [...],
             createdAt, createdBy, updatedAt, updatedBy }
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[project-charter]';
  var CARD_ID = 'projectCharterCard';
  var FIELDS = ['purpose', 'sponsor', 'businessCase', 'successCriteria', 'scopeIn', 'scopeOut', 'keyAssumptions'];

  var LABELS = {
    purpose: 'Purpose / Objective',
    sponsor: 'Sponsor',
    businessCase: 'Business Case',
    successCriteria: 'Success Criteria',
    scopeIn: 'Scope — In',
    scopeOut: 'Scope — Out',
    keyAssumptions: 'Key Assumptions'
  };

  var ctx = { biz: null, proj: null, userEmail: '', isOwner: false, data: null };
  var card, inputs = {}, viewEl, historyBtn, viewDocBtn, statusEl;

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }
  function fmtDate(v) {
    var d = v && v.toDate ? v.toDate() : (v instanceof Date ? v : (v ? new Date(v) : null));
    if (!d || isNaN(d.getTime())) return '—';
    return window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString();
  }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }
  function charterRef() {
    var p = projRef();
    return p ? p.collection('charter').doc('main') : null;
  }
  function canWrite() { return ctx.isOwner; }

  // ---------------------------------------------------------------------
  // Form / read-only rendering
  // ---------------------------------------------------------------------
  function paintForm() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView) return;

    var data = ctx.data || {};
    FIELDS.forEach(function (f) {
      if (inputs[f] && document.activeElement !== inputs[f]) inputs[f].value = data[f] || '';
    });

    if (viewEl) {
      viewEl.innerHTML = FIELDS.map(function (f) {
        return '<div class="tc-field-view"><h4>' + esc(LABELS[f]) + '</h4><p>' + (data[f] ? nl2br(data[f]) : '<span class="tc-empty">Not set.</span>') + '</p></div>';
      }).join('');
    }

    if (historyBtn) historyBtn.style.display = (ctx.data && ctx.data.versions && ctx.data.versions.length) ? '' : 'none';

    if (window.drInsight) {
      var text = ctx.data
        ? 'Last updated' + (ctx.data.updatedBy ? ' by ' + ctx.data.updatedBy : '') + (ctx.data.updatedAt ? ' on ' + fmtDate(ctx.data.updatedAt) : '') + '.'
        : (ctx.isOwner ? 'Not filled in yet — add the project\'s purpose, sponsor, and scope below.' : 'The owner hasn\'t filled this in yet.');
      window.drInsight.set(CARD_ID, text);
    }
  }

  function save() {
    if (!canWrite()) return;
    var ref = charterRef();
    if (!ref) return;
    var payload = {};
    FIELDS.forEach(function (f) { payload[f] = inputs[f] ? inputs[f].value.trim() : ''; });

    var prior = ctx.data;
    var nextVersion = prior ? (prior.version || 1) + 1 : 1;
    if (statusEl) statusEl.textContent = 'Saving…';

    var write = { updatedAt: new Date(), updatedBy: ctx.userEmail || '', version: nextVersion };
    Object.assign(write, payload);

    if (prior) {
      var snapshot = { version: prior.version || 1, savedAt: prior.updatedAt || null, savedBy: prior.updatedBy || '' };
      FIELDS.forEach(function (f) { snapshot[f] = prior[f] || ''; });
      ref.update(Object.assign(write, { versions: window.firebase.firestore.FieldValue.arrayUnion(snapshot) }))
        .then(function () { if (statusEl) statusEl.textContent = 'Saved.'; })
        .catch(function (err) {
          console.error(ns, 'update failed', err);
          if (statusEl) statusEl.textContent = 'Could not save — please try again.';
        });
    } else {
      write.createdAt = new Date();
      write.createdBy = ctx.userEmail || '';
      write.versions = [];
      ref.set(write)
        .then(function () { if (statusEl) statusEl.textContent = 'Saved.'; })
        .catch(function (err) {
          console.error(ns, 'create failed', err);
          if (statusEl) statusEl.textContent = 'Could not save — please try again.';
        });
    }
  }

  function showHistory() {
    if (!ctx.data || !window.drModal) return;
    var versions = (ctx.data.versions || []).slice().reverse();
    var cardsHtml = versions.map(function (v) {
      return '<div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin-bottom:12px;">' +
        '<div style="font-size:0.78rem;color:#666;margin-bottom:8px;">Version ' + esc(v.version) + ' — saved' + (v.savedBy ? ' by ' + esc(v.savedBy) : '') + (v.savedAt ? ' on ' + esc(fmtDate(v.savedAt)) : '') + '</div>' +
        FIELDS.map(function (f) {
          return '<div style="margin-bottom:8px;"><strong style="font-size:0.82rem;">' + esc(LABELS[f]) + ':</strong><br>' + (v[f] ? nl2br(v[f]) : '<span class="tc-empty">Not set.</span>') + '</div>';
        }).join('') +
      '</div>';
    }).join('');
    window.drModal.open({
      title: 'Project Charter — version history',
      bodyHtml: versions.length ? cardsHtml : '<p>No earlier versions yet.</p>'
    });
  }

  // ---------------------------------------------------------------------
  // Live rollups — Milestones, Budget, Assumptions & Constraints
  // ---------------------------------------------------------------------
  function paintMilestonesRollup() {
    var el = document.getElementById('pcMilestonesRollup');
    if (!el) return;
    var p = projRef();
    if (!p) return;
    p.collection('milestones').get().then(function (snap) {
      var today = new Date(); today.setHours(0, 0, 0, 0);
      var rows = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data() || {}); })
        .filter(function (m) { return !m.completed && !m.isSummary; })
        .sort(function (a, b) {
          var ad = a.dueDate && a.dueDate.toDate ? a.dueDate.toDate() : (a.dueDate ? new Date(a.dueDate) : null);
          var bd = b.dueDate && b.dueDate.toDate ? b.dueDate.toDate() : (b.dueDate ? new Date(b.dueDate) : null);
          return (ad ? ad.getTime() : Infinity) - (bd ? bd.getTime() : Infinity);
        })
        .slice(0, 5);
      if (!rows.length) { el.innerHTML = '<p class="tc-empty">No upcoming milestones.</p>'; return; }
      el.innerHTML = '<ul style="margin:0;padding-left:1.1em;font-size:0.84rem;line-height:1.7;">' +
        rows.map(function (m) { return '<li>' + esc(m.title || 'Untitled milestone') + ' — ' + esc(fmtDate(m.dueDate)) + '</li>'; }).join('') +
        '</ul>';
    }).catch(function (err) { console.warn(ns, 'milestones rollup failed', err && err.code); });
  }

  function money(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Math.round(n).toLocaleString();
  }
  function paintBudgetRollup(projectDoc) {
    var el = document.getElementById('pcBudgetRollup');
    if (!el) return;
    var bac = projectDoc.projectBaselineCost, actual = projectDoc.projectActualCost, eac = projectDoc.projectEAC;
    if (bac == null && actual == null && eac == null) { el.innerHTML = '<p class="tc-empty">No budget data imported yet.</p>'; return; }
    el.innerHTML = '<ul style="margin:0;padding-left:1.1em;font-size:0.84rem;line-height:1.7;">' +
      '<li>Baseline: ' + money(bac) + '</li>' +
      '<li>Actual to date: ' + money(actual) + '</li>' +
      '<li>Estimate at Completion (EAC): ' + money(eac) + '</li>' +
    '</ul>';
  }

  function paintConstraintsRollup(projectDoc) {
    var el = document.getElementById('pcConstraintsRollup');
    if (!el) return;
    var rows = Array.isArray(projectDoc.constraintsLog) ? projectDoc.constraintsLog : [];
    if (!rows.length) { el.innerHTML = '<p class="tc-empty">No constraints logged yet.</p>'; return; }
    var bySeverity = {};
    rows.forEach(function (r) { var s = r.severity || 'Unspecified'; bySeverity[s] = (bySeverity[s] || 0) + 1; });
    var counts = Object.keys(bySeverity).map(function (s) { return s + ': ' + bySeverity[s]; }).join(', ');
    var high = rows.filter(function (r) { return /high/i.test(r.severity || ''); }).slice(0, 3);
    el.innerHTML = '<p style="margin:0 0 6px;font-size:0.82rem;color:#666;">' + esc(counts) + '</p>' +
      (high.length ? '<ul style="margin:0;padding-left:1.1em;font-size:0.84rem;line-height:1.6;">' +
        high.map(function (r) { return '<li>' + esc(r.statement || 'Untitled constraint') + '</li>'; }).join('') + '</ul>' : '');
  }

  // ---------------------------------------------------------------------
  // "View uploaded charter document" — same lookup this card replaces as
  // a standalone menu entry, now just one button inside it.
  // ---------------------------------------------------------------------
  function findAndOpenDocument() {
    var isOwner = window.drAccess && window.drAccess.role === 'owner';
    var role = window.drAccess && window.drAccess.role;
    var p = projRef();
    if (!p) return;
    var q = isOwner ? p.collection('documents') : p.collection('documents').where('allowedRoles', 'array-contains', role);
    q.get().then(function (snap) {
      var rows = snap.docs.map(function (d) { var x = d.data() || {}; x.id = d.id; return x; });
      var match = rows.filter(function (r) { return /charter/i.test(r.title || r.fileName || ''); })
        .sort(function (a, b) {
          var ad = a.importedAt && a.importedAt.toMillis ? a.importedAt.toMillis() : 0;
          var bd = b.importedAt && b.importedAt.toMillis ? b.importedAt.toMillis() : 0;
          return bd - ad;
        })[0];
      if (!match) { alert('No Project Charter document has been imported yet. Import one from Settings ▸ Data Imports ▸ Project Documents to use this button, or just fill in the form above.'); return; }
      if (!window.drDocViewer) { alert('The document reader has not loaded yet — try again in a moment.'); return; }
      window.drDocViewer.open({
        docId: match.id, docLabel: match.title || match.fileName, ext: match.ext,
        storagePath: match.storagePath || ('documents/' + ctx.biz + '/' + ctx.proj + '/' + match.id),
        standalone: true
      });
    }).catch(function (err) { console.error(ns, 'document lookup failed', err); alert('Could not open the document: ' + (err && err.message ? err.message : err)); });
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function listen() {
    var ref = charterRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      ctx.data = snap.exists ? Object.assign({ id: snap.id }, snap.data()) : null;
      paintForm();
    }, function (err) { console.warn(ns, 'charter listen error', err && err.code); });

    var p = projRef();
    if (p) {
      p.onSnapshot(function (snap) {
        var data = (snap.exists && snap.data()) || {};
        paintBudgetRollup(data);
        paintConstraintsRollup(data);
      }, function (err) { console.warn(ns, 'project doc listen error', err && err.code); });
    }
    paintMilestonesRollup();
  }

  function bindEvents() {
    var saveBtn = document.getElementById('pc-save');
    if (saveBtn) saveBtn.addEventListener('click', save);
    if (historyBtn) historyBtn.addEventListener('click', showHistory);
    if (viewDocBtn) viewDocBtn.addEventListener('click', findAndOpenDocument);
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    FIELDS.forEach(function (f) { inputs[f] = document.getElementById('pc-' + f); });
    viewEl = document.getElementById('pcReadOnlyView');
    historyBtn = document.getElementById('pc-history-btn');
    viewDocBtn = document.getElementById('pc-view-doc-btn');
    statusEl = document.getElementById('pc-status');

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    var user = (window.auth && window.auth.currentUser) ||
      (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function applyAccess() {
    var formEls = document.querySelectorAll('.pc-add-only');
    for (var i = 0; i < formEls.length; i++) formEls[i].style.display = canWrite() ? '' : 'none';
    var form = document.getElementById('pc-form');
    if (form) form.style.display = canWrite() ? '' : 'none';
    if (viewEl) viewEl.style.display = canWrite() ? 'none' : '';
    paintForm();
  }

  function init() {
    detectContext();
    if (!ctx.biz || !card) return;
    bindEvents();
    listen();
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
