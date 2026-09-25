/* ============================================================================
   Project Closure Report — a final rollup (scope/budget/schedule/outstanding
   items/lessons learned) plus a closure checklist, with a "Save" that
   snapshots both into a timestamped, reopenable record.

   The rollup does NOT recompute anything — it reads the exact one-line
   insight text each source card (Project Progress, SPI, CPI, Forecast
   Finish, Risk Register, Issue Log, Change Control, Dependencies, Q&A
   Summary, Lessons Learned) already computed and published via
   window.drInsight.set(cardId, text) — the same window.drInsight.getFacts()
   lookup status-report.js's PDF builder uses. Reusing it here means this
   report can never show a number that disagrees with what's already on the
   dashboard, and needs no separate computation to keep in sync.

   Checklist: a standard PM closure list (see DEFAULT_CHECKLIST) plus
   owner-added custom items, stored as one array field — live, not
   versioned (checking a box is a state change, not a document draft).

   Firestore:
     businesses/{biz}/projects/{proj}/projectClosure/main
       { checklist: [{id, label, checked, checkedAt, checkedBy, custom}],
         updatedAt, updatedBy }
     businesses/{biz}/projects/{proj}/closureReports/{id}   (append-only saves)
       { savedAt, savedBy, checklist: [...snapshot...],
         rollup: { groups: [{ title, items: [{ cardLabel, text }] }] } }
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[project-closure]';
  var ROLLUP_REFRESH_TRIES = 8, ROLLUP_REFRESH_MS = 4000; // covers other cards' async Firestore listeners populating their insight text after load

  var ctx = { biz: null, proj: null, userEmail: '', userUid: '', isOwner: false, checklist: null, docExists: false };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var DEFAULT_CHECKLIST = [
    { id: 'deliverables', label: 'All deliverables completed and formally accepted' },
    { id: 'financials', label: 'Final invoice issued and outstanding payments collected' },
    { id: 'contracts', label: 'Contracts and procurement activities closed out' },
    { id: 'resources', label: 'Project resources released or reassigned' },
    { id: 'lessons', label: 'Lessons learned documented and reviewed' },
    { id: 'documentation', label: 'Project documentation archived' },
    { id: 'signoff', label: 'Client / sponsor sign-off obtained' },
    { id: 'outstanding', label: 'Outstanding risks, issues, and change requests resolved or transferred' },
    { id: 'retro', label: 'Post-project review / retrospective held' },
    { id: 'distribution', label: 'Closure report distributed to stakeholders' }
  ].map(function (i) { return Object.assign({ checked: false, checkedAt: null, checkedBy: '', custom: false }, i); });

  var ROLLUP_GROUPS = [
    { title: 'Scope', cards: ['projectProgressCard'] },
    { title: 'Schedule', cards: ['schedulePerformanceCard', 'forecastFinishCard'] },
    { title: 'Budget', cards: ['costPerformanceCard'] },
    { title: 'Outstanding Items', cards: ['riskRegisterCard', 'issueLogCard', 'changeControlLogCard', 'dependenciesCard', 'qnaSummaryCard'] },
    { title: 'Lessons Learned', cards: ['lessonsLearnedCard'] }
  ];

  // Which live card(s) are relevant to weigh before checking off each standard
  // item — the exact same window.drInsight text used in the rollup above, just
  // scoped to what that specific closure item is actually asking about. A
  // custom (owner-added) item has no mapping, so it gets no concern note —
  // there's nothing live to check it against.
  var ITEM_CONCERN_CARDS = {
    deliverables: ['deliverableSignoffCard'],
    financials: ['costPerformanceCard', 'procurementCard'],
    contracts: ['procurementCard'],
    resources: ['resourceHoursCard'],
    lessons: ['lessonsLearnedCard'],
    signoff: ['deliverableSignoffCard'],
    outstanding: ['riskRegisterCard', 'issueLogCard', 'changeControlLogCard', 'dependenciesCard', 'qnaSummaryCard'],
    retro: ['lessonsLearnedCard']
  };
  function itemConcernText(item) {
    var cardIds = ITEM_CONCERN_CARDS[item.id] || [];
    return cardIds.map(function (id) { var t = cardFact(id); return t ? (cardLabel(id) + ': ' + t) : null; }).filter(Boolean).join(' | ');
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function toDate(v) { if (!v) return null; if (v.toDate) return v.toDate(); var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtDateTime(v) { var d = toDate(v); return d ? (window.drDateFmt ? window.drDateFmt.dateTime(d) : d.toLocaleString()) : '—'; }

  function cardLabel(cardId) {
    var entry = window.drAllReportEntries && window.drAllReportEntries.find(function (r) { return r.id === cardId; });
    return entry ? entry.label : cardId;
  }
  function cardFact(cardId) {
    var facts = window.drInsight && window.drInsight.getFacts ? window.drInsight.getFacts() : {};
    var f = facts[cardId];
    return f ? (typeof f === 'string' ? f : f.current) : '';
  }
  function buildRollup() {
    return {
      groups: ROLLUP_GROUPS.map(function (g) {
        var items = g.cards.map(function (id) { return { cardLabel: cardLabel(id), text: cardFact(id) }; }).filter(function (it) { return it.text; });
        return { title: g.title, items: items };
      })
    };
  }
  function rollupHtml(rollup) {
    return rollup.groups.map(function (g) {
      var body = g.items.length
        ? '<ul class="pcr-group-list">' + g.items.map(function (it) { return '<li><strong>' + esc(it.cardLabel) + ':</strong> ' + esc(it.text) + '</li>'; }).join('') + '</ul>'
        : '<p class="pcr-group-empty">No data available yet.</p>';
      return '<div class="pcr-group"><h4>' + esc(g.title) + '</h4>' + body + '</div>';
    }).join('');
  }

  var card, checklistEl, rollupEl, itemInput;
  var saveBtn, viewSavedBtn, saveStatusEl, addItemBtn;
  var rollupTries = 0, rollupTimer = null;

  function canWrite() { return ctx.isOwner; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }
  function closureDocRef() { var p = projRef(); return p ? p.collection('projectClosure').doc('main') : null; }
  function closureReportsRef() { var p = projRef(); return p ? p.collection('closureReports') : null; }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function paintRollup() {
    if (rollupEl) rollupEl.innerHTML = rollupHtml(buildRollup());
  }

  function paintChecklist() {
    if (!checklistEl) return;
    var list = ctx.checklist || DEFAULT_CHECKLIST;
    checklistEl.innerHTML = list.map(function (item) {
      var stamp = item.checked ? ('<span class="pcr-item-stamp">' + esc(fmtDateTime(item.checkedAt)) + (item.checkedBy ? ' — ' + esc(item.checkedBy) : '') + '</span>') : '';
      var delBtn = item.custom ? '<button type="button" class="pcr-item-del" data-id="' + esc(item.id) + '" title="Remove item">🗑️</button>' : '';
      var concern = itemConcernText(item);
      var concernHtml = concern ? '<div class="pcr-item-concern">⚠ ' + esc(concern) + '</div>' : '';
      return '<li class="pcr-item' + (item.checked ? ' pcr-item-checked' : '') + '">' +
        '<div class="pcr-item-row"><label><input type="checkbox" class="pcr-item-check" data-id="' + esc(item.id) + '"' + (item.checked ? ' checked' : '') + (canWrite() ? '' : ' disabled') + ' /> ' + esc(item.label) + '</label>' +
        stamp + delBtn + '</div>' + concernHtml + '</li>';
    }).join('');
    var done = list.filter(function (i) { return i.checked; }).length;
    if (window.drInsight) window.drInsight.set('projectClosureCard', done + ' of ' + list.length + ' closure checklist items complete.');
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('projectClosureCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView) return;
    paintRollup();
    paintChecklist();
  }

  // Other cards' insight text populates asynchronously (their own Firestore
  // listeners resolve after this card has already rendered) — re-paint the
  // rollup a handful of times on load rather than once, so it doesn't get
  // stuck showing "No data available" for sections that fill in a second
  // or two later. Bounded, not a permanent interval.
  function scheduleRollupRefresh() {
    if (rollupTimer) return;
    rollupTimer = setInterval(function () {
      rollupTries++;
      paintRollup();
      if (rollupTries >= ROLLUP_REFRESH_TRIES) { clearInterval(rollupTimer); rollupTimer = null; }
    }, ROLLUP_REFRESH_MS);
  }

  // ---------------------------------------------------------------------------
  // Checklist writes (owner-only) — whole-array overwrite; the list is small
  // (~10-15 items), so a per-item Firestore write isn't worth the complexity.
  // ---------------------------------------------------------------------------
  function writeChecklist(newList) {
    var ref = closureDocRef();
    if (!ref) return;
    ctx.checklist = newList; // optimistic — the listener will confirm/replace it
    paintChecklist();
    ref.set({ checklist: newList, updatedAt: new Date(), updatedBy: ctx.userEmail || '' }, { merge: true })
      .catch(function (err) { console.error(ns, 'writeChecklist error', err); alert('Could not save — please try again: ' + (err && err.message ? err.message : err)); });
  }

  function toggleItem(id, checked) {
    if (!canWrite()) return;
    var list = (ctx.checklist || DEFAULT_CHECKLIST).map(function (item) {
      if (item.id !== id) return item;
      return Object.assign({}, item, { checked: checked, checkedAt: checked ? new Date() : null, checkedBy: checked ? (ctx.userEmail || '') : '' });
    });
    writeChecklist(list);
  }

  function addCustomItem() {
    if (!canWrite() || !itemInput) return;
    var text = itemInput.value.trim();
    if (!text) return;
    var list = (ctx.checklist || DEFAULT_CHECKLIST).concat([{ id: 'custom-' + Date.now(), label: text, checked: false, checkedAt: null, checkedBy: '', custom: true }]);
    writeChecklist(list);
    itemInput.value = '';
  }

  function removeCustomItem(id) {
    if (!canWrite()) return;
    var list = (ctx.checklist || DEFAULT_CHECKLIST).filter(function (item) { return item.id !== id; });
    writeChecklist(list);
  }

  // ---------------------------------------------------------------------------
  // Save — a timestamped, reopenable snapshot of the checklist + rollup as
  // they stand right now (append-only; never edited after the fact).
  // ---------------------------------------------------------------------------
  function saveReport() {
    if (!canWrite()) return;
    var ref = closureReportsRef();
    if (!ref) return;
    if (saveStatusEl) saveStatusEl.textContent = 'Saving…';
    if (saveBtn) saveBtn.disabled = true;
    ref.add({ savedAt: new Date(), savedBy: ctx.userEmail || '', checklist: ctx.checklist || DEFAULT_CHECKLIST, rollup: buildRollup() })
      .then(function () { if (saveStatusEl) saveStatusEl.textContent = 'Saved ' + fmtDateTime(new Date()) + '.'; })
      .catch(function (err) { console.error(ns, 'saveReport error', err); if (saveStatusEl) saveStatusEl.textContent = ''; alert('Could not save: ' + (err && err.message ? err.message : err)); })
      .finally(function () { if (saveBtn) saveBtn.disabled = false; });
  }

  function renderSnapshotDetail(snap) {
    var list = snap.checklist || [];
    var done = list.filter(function (i) { return i.checked; }).length;
    var checklistHtml = '<ul class="pcr-group-list">' + list.map(function (item) {
      return '<li>' + (item.checked ? '☑' : '☐') + ' ' + esc(item.label) + (item.checked ? (' <span class="pcr-item-stamp">(' + esc(fmtDateTime(item.checkedAt)) + (item.checkedBy ? ' — ' + esc(item.checkedBy) : '') + ')</span>') : '') + '</li>';
    }).join('') + '</ul>';
    var rollup = snap.rollup || { groups: [] };
    return '<p><strong>Saved:</strong> ' + esc(fmtDateTime(snap.savedAt)) + (snap.savedBy ? ' by ' + esc(snap.savedBy) : '') + '</p>' +
      '<p><strong>Checklist:</strong> ' + done + ' of ' + list.length + ' complete</p>' + checklistHtml +
      rollupHtml(rollup);
  }

  function openSavedReport(id, rows) {
    var snap = rows.find(function (r) { return r.id === id; });
    if (!snap || !window.drModal) return;
    window.drModal.open({ title: 'Closure Report — ' + fmtDateTime(snap.savedAt), bodyHtml: renderSnapshotDetail(snap), boxClass: 'dr-modal-box-wide' });
  }

  function viewSavedReports() {
    var ref = closureReportsRef();
    if (!ref || !window.drModal) return;
    ref.orderBy('savedAt', 'desc').get().then(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      var html = rows.length
        ? '<ul class="pcr-saved-list">' + rows.map(function (r) {
            return '<li><button type="button" class="pcr-saved-open" data-id="' + esc(r.id) + '">' + esc(fmtDateTime(r.savedAt)) + (r.savedBy ? ' — ' + esc(r.savedBy) : '') + '</button></li>';
          }).join('') + '</ul>'
        : '<p>No saved closure reports yet.</p>';
      window.drModal.open({ title: 'Saved Closure Reports', bodyHtml: html });
      var listEl = document.querySelector('.pcr-saved-list');
      if (listEl) listEl.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.pcr-saved-open');
        if (btn) openSavedReport(btn.getAttribute('data-id'), rows);
      });
    }).catch(function (err) { console.error(ns, 'viewSavedReports error', err); alert('Could not load saved reports: ' + (err && err.message ? err.message : err)); });
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------
  // Checking a box that still has an open concern isn't blocked — it's the
  // owner's call whether it's really ready — but it does ask for a deliberate
  // confirmation quoting exactly what's still outstanding, rather than letting
  // a click silently close out an item something else still needs attention on.
  // Unchecking is always free (no concern to weigh against reopening it).
  function bindChecklistEvents() {
    if (!checklistEl) return;
    checklistEl.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || !t.classList.contains('pcr-item-check')) return;
      var id = t.getAttribute('data-id'), checked = t.checked;
      if (!checked) { toggleItem(id, false); return; }
      var item = (ctx.checklist || DEFAULT_CHECKLIST).find(function (i) { return i.id === id; });
      var concern = item ? itemConcernText(item) : '';
      if (!concern) { toggleItem(id, true); return; }
      var msg = 'Before checking off "' + item.label + '" — ' + concern + ' Check it off anyway?';
      var confirmed = window.drConfirm
        ? window.drConfirm(msg, { title: 'Concern before closing this item', confirmText: 'Check It Off', cancelText: 'Go Back', danger: false })
        : Promise.resolve(window.confirm(msg));
      confirmed.then(function (ok) { if (ok) toggleItem(id, true); else t.checked = false; });
    });
    checklistEl.addEventListener('click', function (ev) {
      var t = ev.target.closest('.pcr-item-del');
      if (t) removeCustomItem(t.getAttribute('data-id'));
    });
  }

  function listenClosure() {
    var ref = closureDocRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      ctx.docExists = snap.exists;
      var data = (snap.exists && snap.data()) || {};
      ctx.checklist = (Array.isArray(data.checklist) && data.checklist.length) ? data.checklist : DEFAULT_CHECKLIST;
      paintChecklist();
    }, function (err) { console.warn(ns, 'listen error (expected if not granted view access)', err && err.code); });
  }

  function detectContextFromDOM() {
    card = document.getElementById('projectClosureCard');
    checklistEl = $('#pcrChecklist'); rollupEl = $('#pcrRollup'); itemInput = $('#pcr-item-text');
    saveBtn = $('#pcr-save'); viewSavedBtn = $('#pcr-view-saved'); saveStatusEl = $('#pcr-save-status'); addItemBtn = $('#pcr-item-add');

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';

    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.userUid = (user && user.uid) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function applyWriteAccess() {
    var addOnlyEls = document.querySelectorAll('.pcr-add-only');
    for (var i = 0; i < addOnlyEls.length; i++) addOnlyEls[i].style.display = canWrite() ? '' : 'none';
    paint();
  }

  function init() {
    detectContextFromDOM();
    if (!ctx.biz || !card) return;
    bindChecklistEvents();
    if (addItemBtn) addItemBtn.addEventListener('click', addCustomItem);
    if (saveBtn) saveBtn.addEventListener('click', saveReport);
    if (viewSavedBtn) viewSavedBtn.addEventListener('click', viewSavedReports);
    listenClosure();
    scheduleRollupRefresh();
    if (window.drAccess) window.drAccess.whenReady().then(applyWriteAccess);
    else applyWriteAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
