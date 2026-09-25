/* ============================================================================
   Glossary / Acronyms / Data Dictionary — a searchable term/definition list
   so a new stakeholder reading everything else on this dashboard isn't lost
   in project-specific jargon, tracked-field names, or calculation formulas.
   Owner-editable, real-time, no versioning (a reference list, not a draft
   document) — modeled on stakeholders.js's minimal CRUD shape.

   Rows are always shown in alphabetical order by term, grouped under a
   letter header row (A, B, C, ...) with a clickable A-Z index at the
   bottom (#glossaryAlphaNav) that jumps to each letter's group — same
   sticky-header offset math as window.drScrollToId (report-index.js),
   duplicated locally rather than imported since this needs to target a
   letter-group row inside the card, not a whole card by id.

   Firestore: businesses/{biz}/projects/{proj}/glossary/{id}
   Fields: { term, definition, type ('Term'|'Acronym'|'Data Field'|'Calculation'),
             createdAt, createdBy, createdByUid, updatedAt, updatedBy }
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[glossary]';
  var ctx = { biz: null, proj: null, userEmail: '', userUid: '', isOwner: false, rows: [], editingId: null, search: '' };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var SAMPLE_GLOSSARY = [
    { id: 'sample-1', term: 'SPI', definition: 'Schedule Performance Index — actual progress divided by planned progress; 1.0 means on schedule.', type: 'Acronym' },
    { id: 'sample-2', term: 'CPI', definition: 'Cost Performance Index — earned value divided by actual cost; 1.0 means on budget.', type: 'Acronym' },
    { id: 'sample-3', term: 'RAG Status', definition: 'Red/Amber/Green — a quick visual read of whether something is on track, at risk, or overdue.', type: 'Term' },
    { id: 'sample-4', term: '% Complete', definition: 'The tracked completion percentage on a task, used to compute Earned Value (EV = % Complete × Baseline Cost).', type: 'Data Field' },
    { id: 'sample-5', term: 'EAC', definition: 'Estimate at Completion = BAC ÷ CPI — the forecast total project cost given current cost performance.', type: 'Calculation' }
  ];

  // Letters (and one catch-all bucket) the A-Z index can jump to.
  var ALPHA_BUCKETS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat(['#']);
  function letterBucket(term) {
    var ch = (term || '').trim().charAt(0).toUpperCase();
    return /[A-Z]/.test(ch) ? ch : '#';
  }
  function letterAnchorId(bucket) { return 'gl-letter-' + (bucket === '#' ? 'hash' : bucket); }

  // Same sticky-header + summary-row offset math as window.drScrollToId
  // (report-index.js) — duplicated here because that helper only targets a
  // whole card by id, not a row inside one.
  function scrollToLetterRow(el) {
    if (!el) return;
    var header = document.getElementById('dashboardHeader');
    var headerHeight = header ? header.offsetHeight : 0;
    var summaryRow = document.querySelector('.dashboard-summary-row');
    var summaryRowHeight = summaryRow ? summaryRow.offsetHeight : 0;
    var top = el.getBoundingClientRect().top + window.scrollY - headerHeight - summaryRowHeight - 12;
    window.scrollTo({ top: top, behavior: 'smooth' });
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  var card, tbody, searchInput, alphaNav;
  var termInput, definitionInput, typeSel, addBtn, cancelEditBtn;

  function canWrite() { return ctx.isOwner; }
  function canActOnRow(id) { return canWrite() && String(id || '').indexOf('sample-') !== 0; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function glossaryRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default').collection('glossary');
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('glossaryCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    var usingSample = !ctx.rows || !ctx.rows.length;
    var banner = document.getElementById('glossarySampleBanner');
    if (banner) banner.hidden = !usingSample;
    var rows = usingSample ? SAMPLE_GLOSSARY : ctx.rows;

    var q = (ctx.search || '').toLowerCase().trim();
    var filtered = q ? rows.filter(function (r) { return (r.term || '').toLowerCase().indexOf(q) !== -1 || (r.definition || '').toLowerCase().indexOf(q) !== -1; }) : rows;
    filtered = filtered.slice().sort(function (a, b) { return (a.term || '').toLowerCase().localeCompare((b.term || '').toLowerCase()); });

    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="metrics-empty">' + (q ? 'No terms match your search.' : 'No glossary terms yet.') + '</td></tr>';
      if (alphaNav) alphaNav.innerHTML = '';
      return;
    }

    // Group alphabetically, inserting a letter-header row (an anchor
    // target for the A-Z index below) before each new bucket's entries.
    var presentBuckets = {};
    var bodyHtml = '';
    var lastBucket = null;
    filtered.forEach(function (r) {
      var bucket = letterBucket(r.term);
      if (bucket !== lastBucket) {
        bodyHtml += '<tr class="gl-letter-row" id="' + letterAnchorId(bucket) + '"><td colspan="4">' + (bucket === '#' ? '#' : bucket) + '</td></tr>';
        lastBucket = bucket;
        presentBuckets[bucket] = true;
      }
      var canAct = canActOnRow(r.id);
      var disabledTitle = usingSample ? 'Sample data — add a real term to edit' : 'Owner only';
      var editBtn = '<button type="button" class="edit-btn gl-edit" data-id="' + esc(r.id) + '"' + (canAct ? '' : ' disabled aria-disabled="true" title="' + disabledTitle + '"') + '>✏️</button>';
      var delBtn = '<button type="button" class="delete-btn gl-del" data-id="' + esc(r.id) + '"' + (canAct ? '' : ' disabled aria-disabled="true" title="' + disabledTitle + '"') + '>🗑️</button>';
      bodyHtml += '<tr data-id="' + esc(r.id) + '">' +
        '<td>' + esc(r.term) + '</td>' +
        '<td>' + esc(r.type || 'Term') + '</td>' +
        '<td>' + esc(r.definition) + '</td>' +
        '<td>' + editBtn + delBtn + '</td></tr>';
    });
    tbody.innerHTML = bodyHtml;

    if (alphaNav) {
      var letterBtns = ALPHA_BUCKETS.map(function (b) {
        var has = !!presentBuckets[b];
        var label = b === '#' ? '#' : b;
        return has
          ? '<button type="button" class="gl-alpha-link" data-letter="' + b + '">' + label + '</button>'
          : '<button type="button" class="gl-alpha-link gl-alpha-disabled" disabled aria-disabled="true">' + label + '</button>';
      }).join('');
      alphaNav.innerHTML = letterBtns + '<button type="button" class="gl-alpha-link gl-alpha-top" data-letter="top" title="Back to top of Glossary">⬆ Top</button>';
    }

    if (window.drInsight) {
      var text = rows.length + ' glossary term' + (rows.length === 1 ? '' : 's') + ' defined.';
      if (usingSample) text += ' (sample data)';
      window.drInsight.set('glossaryCard', text);
    }
  }

  function readForm() {
    return {
      term: termInput ? termInput.value.trim() : '',
      definition: definitionInput ? definitionInput.value.trim() : '',
      type: typeSel ? typeSel.value : 'Term'
    };
  }
  function clearForm() {
    if (termInput) termInput.value = '';
    if (definitionInput) definitionInput.value = '';
    if (typeSel) typeSel.value = 'Term';
  }

  function addTerm() {
    if (!termInput || !canWrite()) return;
    var data = readForm();
    if (!data.term || !data.definition) return;
    var ref = glossaryRef();
    if (!ref) return;
    var ts = (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue && window.firebase.firestore.FieldValue.serverTimestamp()) || new Date();
    data.createdAt = ts; data.createdBy = ctx.userEmail || ''; data.createdByUid = ctx.userUid || '';
    ref.add(data).catch(function (err) { console.error(ns, 'addTerm error', err); alert('Could not save — please try again: ' + (err && err.message ? err.message : err)); });
    clearForm();
  }

  function startEdit(id) {
    var row = ctx.rows.find(function (r) { return r.id === id; });
    if (!row || !termInput || !canActOnRow(id)) return;
    ctx.editingId = id;
    if (termInput) termInput.value = row.term || '';
    if (definitionInput) definitionInput.value = row.definition || '';
    if (typeSel) typeSel.value = row.type || 'Term';
    if (addBtn) addBtn.textContent = 'Update';
    if (cancelEditBtn) cancelEditBtn.style.display = '';
  }
  function cancelEdit() {
    ctx.editingId = null;
    if (addBtn) addBtn.textContent = 'Add';
    if (cancelEditBtn) cancelEditBtn.style.display = 'none';
    clearForm();
  }
  function saveEdit() {
    if (!ctx.editingId || !canWrite()) return;
    var ref = glossaryRef();
    if (!ref || !termInput) return;
    var payload = readForm();
    if (!payload.term || !payload.definition) return;
    payload.updatedAt = new Date();
    payload.updatedBy = ctx.userEmail || '';
    ref.doc(ctx.editingId).update(payload).catch(function (err) { console.error(ns, 'saveEdit error', err); alert('Could not save — please try again: ' + (err && err.message ? err.message : err)); });
    ctx.editingId = null;
    if (addBtn) addBtn.textContent = 'Add';
    if (cancelEditBtn) cancelEditBtn.style.display = 'none';
    clearForm();
  }
  function deleteTerm(id) {
    if (!canActOnRow(id)) return;
    var ref = glossaryRef();
    if (!ref) return;
    var confirmed = window.drConfirm ? window.drConfirm('Delete this glossary term? This cannot be undone.', { title: 'Delete Glossary Term' }) : Promise.resolve(window.confirm('Delete this glossary term?'));
    confirmed.then(function (ok) { if (ok) ref.doc(id).delete().catch(function (err) { console.error(ns, 'deleteTerm error', err); }); });
  }

  function bindTableEvents() {
    if (!tbody) return;
    tbody.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t) return;
      if (t.classList.contains('gl-edit')) startEdit(t.getAttribute('data-id'));
      else if (t.classList.contains('gl-del')) deleteTerm(t.getAttribute('data-id'));
    });
  }
  function bindAdd() {
    if (!addBtn) return;
    addBtn.addEventListener('click', function () { if (ctx.editingId) saveEdit(); else addTerm(); });
    if (cancelEditBtn) cancelEditBtn.addEventListener('click', cancelEdit);
  }
  function bindSearch() {
    if (!searchInput) return;
    searchInput.addEventListener('input', function () { ctx.search = searchInput.value; paint(); });
  }
  function bindAlphaNav() {
    if (!alphaNav) return;
    // Plain <button>s (not <a href="#...">) — this page sets a global
    // `html { scroll-behavior: smooth }` (global.css), and a real anchor's
    // native jump can race the click handler's own scroll, landing on the
    // wrong final position (or scrolling the whole page to the very top,
    // taking the card out of view). A button has no default navigation
    // action at all, so there's nothing to race.
    alphaNav.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.gl-alpha-link') : null;
      if (!btn || btn.disabled) return;
      var letter = btn.getAttribute('data-letter');
      if (letter === 'top') { if (card) scrollToLetterRow(card); return; }
      scrollToLetterRow(document.getElementById(letterAnchorId(letter)));
    });
  }

  function listenGlossary() {
    var ref = glossaryRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.rows = rows;
      paint();
    }, function (err) { console.warn(ns, 'listen error (expected if not granted view access)', err && err.code); });
  }

  function detectContextFromDOM() {
    card = document.getElementById('glossaryCard');
    tbody = $('#glossaryTable tbody');
    searchInput = $('#glossarySearch');
    alphaNav = document.getElementById('glossaryAlphaNav');
    termInput = $('#gl-term'); definitionInput = $('#gl-definition'); typeSel = $('#gl-type');
    addBtn = $('#gl-add'); cancelEditBtn = $('#gl-cancel-edit');

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';

    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.userUid = (user && user.uid) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function applyWriteAccess() {
    var addOnlyEls = document.querySelectorAll('.gl-add-only');
    for (var i = 0; i < addOnlyEls.length; i++) {
      var el = addOnlyEls[i];
      if (el.id === 'gl-cancel-edit') { if (!canWrite()) el.style.display = 'none'; continue; }
      el.style.display = canWrite() ? '' : 'none';
    }
    paint();
  }

  function init() {
    detectContextFromDOM();
    if (!ctx.biz || !card) return;
    bindTableEvents();
    bindAdd();
    bindSearch();
    bindAlphaNav();
    listenGlossary();
    if (window.drAccess) window.drAccess.whenReady().then(applyWriteAccess);
    else applyWriteAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
