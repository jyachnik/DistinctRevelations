// Public/JS/change-report.js
// Owner-only: flattens the changeLog already captured on every milestone
// and activity (from Gantt drags and from the regular edit forms) into one
// reviewable, exportable list — for reconciling into the master MS Project
// plan without hunting through the app for what changed.

(function () {
  'use strict';

  var TAG = '[change-report]';
  var OWNER_EMAIL =
    (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) ||
    window.ownerEmail ||
    '';

  var db = null;
  var auth = null;
  var bizKey = null;
  var isOwner = false;
  var lastRows = [];

  function warn() { console.warn.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function error() { console.error.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }

  function fmtDateTime(v) {
    return window.drDateFmt ? window.drDateFmt.dateTime(v) : (v ? String(v) : '');
  }

  function resolveBizKey() {
    var params = new URLSearchParams(window.location.search || '');
    return params.get('business') || window.localStorage.getItem('businessKey') || window.BIZ_KEY || null;
  }

  // Categorizes each change by what aspect of the item it touched — derived
  // from the field name itself rather than a new schema field, so this
  // works retroactively on changeLog entries already in Firestore.
  var FIELD_CATEGORIES = {
    'Title': 'Identity',
    'Due date': 'Schedule',
    'Start date': 'Schedule',
    'Progress': 'Progress',
    'Status': 'Progress',
    'Cost': 'Cost',
    'Baseline Cost': 'Cost',
    'Actual Cost': 'Cost',
    'Milestone created': 'Lifecycle',
    'Activity created': 'Lifecycle',
    'Reclassified as milestone': 'Lifecycle',
    'Reclassified as activity': 'Lifecycle'
  };
  function categoryFor(field) {
    return FIELD_CATEGORIES[field] || 'Other';
  }

  function flatten(itemLabel, itemType, changeLog) {
    var rows = [];
    (changeLog || []).forEach(function (entry) {
      (entry.changes || []).forEach(function (c) {
        rows.push({
          item: itemLabel,
          type: itemType,
          category: categoryFor(c.field),
          field: c.field,
          from: c.from,
          to: c.to,
          changedBy: entry.changedBy || 'Someone',
          changedAt: entry.changedAt || null
        });
      });
    });
    return rows;
  }

  function loadRows() {
    var milestones = db.collection('businesses').doc(bizKey).collection('milestones').get();
    var activities = db.collection('businesses').doc(bizKey).collection('activities').get();

    return Promise.all([milestones, activities]).then(function (results) {
      var rows = [];
      results[0].forEach(function (doc) {
        var d = doc.data() || {};
        rows = rows.concat(flatten(d.title || 'Untitled milestone', 'Milestone', d.changeLog));
      });
      results[1].forEach(function (doc) {
        var d = doc.data() || {};
        rows = rows.concat(flatten(d.title || 'Untitled activity', 'Activity', d.changeLog));
      });
      rows.sort(function (a, b) {
        var at = (window.drRag ? window.drRag.toJsDate(a.changedAt) : a.changedAt) || 0;
        var bt = (window.drRag ? window.drRag.toJsDate(b.changedAt) : b.changedAt) || 0;
        return (bt.getTime ? bt.getTime() : 0) - (at.getTime ? at.getTime() : 0);
      });
      return rows;
    });
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function render(rows) {
    var tbody = document.querySelector('#changeReportTable tbody');
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No changes recorded yet.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function (r) {
      return '<tr>' +
        '<td>' + esc(r.item) + '</td>' +
        '<td>' + esc(r.type) + '</td>' +
        '<td><span class="change-category-badge change-category-' + esc(r.category.toLowerCase()) + '">' + esc(r.category) + '</span></td>' +
        '<td>' + esc(r.field) + '</td>' +
        '<td>' + esc(r.from) + '</td>' +
        '<td>' + esc(r.to) + '</td>' +
        '<td>' + esc(r.changedBy) + '</td>' +
        '<td>' + esc(fmtDateTime(r.changedAt)) + '</td>' +
        '</tr>';
    }).join('');
  }

  function applyCategoryFilter(rows) {
    var select = document.getElementById('changeReportCategoryFilter');
    var chosen = select ? select.value : '';
    return chosen ? rows.filter(function (r) { return r.category === chosen; }) : rows;
  }

  function populateCategoryFilter(rows) {
    var select = document.getElementById('changeReportCategoryFilter');
    if (!select) return;
    var current = select.value;
    var categories = [];
    rows.forEach(function (r) { if (categories.indexOf(r.category) === -1) categories.push(r.category); });
    categories.sort();
    select.innerHTML = '<option value="">All categories</option>' +
      categories.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    if (categories.indexOf(current) !== -1) select.value = current;
  }

  function downloadCsv(rows) {
    if (typeof XLSX === 'undefined') {
      alert('Export library not loaded yet — try again in a moment.');
      return;
    }
    var data = rows.map(function (r) {
      return {
        Item: r.item,
        Type: r.type,
        Category: r.category,
        Field: r.field,
        From: r.from,
        To: r.to,
        'Changed By': r.changedBy,
        When: fmtDateTime(r.changedAt)
      };
    });
    var ws = XLSX.utils.json_to_sheet(data);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Change Report');
    XLSX.writeFile(wb, 'change-report.csv');
  }

  function openModal() {
    var overlay = document.getElementById('changeReportOverlay');
    if (!overlay) return;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');

    loadRows().then(function (rows) {
      lastRows = rows;
      populateCategoryFilter(rows);
      render(applyCategoryFilter(rows));
    }).catch(function (err) {
      error('loadRows failed', err);
      var tbody = document.querySelector('#changeReportTable tbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="empty">Could not load changes: ' + esc(err.message || err) + '</td></tr>';
    });
  }

  function closeModal() {
    var overlay = document.getElementById('changeReportOverlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function wire() {
    var openBtn = document.getElementById('changeReportBtn');
    var closeBtn = document.getElementById('changeReportClose');
    var dlBtn = document.getElementById('changeReportDownload');
    var overlay = document.getElementById('changeReportOverlay');
    var categoryFilter = document.getElementById('changeReportCategoryFilter');

    if (!openBtn) return;

    if (!isOwner) {
      openBtn.style.display = 'none';
      return;
    }

    openBtn.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (overlay) overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeModal(); });
    if (dlBtn) dlBtn.addEventListener('click', function () { downloadCsv(applyCategoryFilter(lastRows)); });
    if (categoryFilter) categoryFilter.addEventListener('change', function () { render(applyCategoryFilter(lastRows)); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  }

  function start() {
    db = window.db || null;
    auth = window.auth || null;
    if (!db || !auth) { setTimeout(start, 200); return; }

    bizKey = resolveBizKey();
    if (!bizKey) { setTimeout(start, 300); return; }

    var user = auth.currentUser;
    var email = (user && user.email) || '';
    isOwner = !!email && !!OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL.toLowerCase();

    wire();
  }

  function waitForFirebaseAndStart() {
    if (window.db && window.auth) { start(); return; }
    window.addEventListener('firebase-ready', function handle() {
      window.removeEventListener('firebase-ready', handle);
      start();
    }, { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForFirebaseAndStart);
  } else {
    waitForFirebaseAndStart();
  }
})();
