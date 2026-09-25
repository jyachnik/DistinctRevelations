// Public/JS/issueLog.js
// Issue Log (owner-only) — problems that have actually HAPPENED, distinct
// from Risk Register (hypothetical, not-yet-materialized problems) and
// Q&A's lightweight "Issue" type (message/assignee/status only, no
// severity or root-cause fields). No existing export to match yet, so
// this module DEFINES the expected file shape and ships with sample/
// placeholder rows (clearly labeled) — same pattern as qualityDefects.js.
//
// Expected columns (case-insensitive, same matching style as every other
// import in this app):
//   ID, Date Raised, Category, Description, Severity, Root Cause,
//   Raised By, Owner, Status, Target Resolution Date, Date Resolved,
//   Related Risk ID, Resolution, Notes

(function () {
  'use strict';

  var TAG = '[issueLog]';
  function log() { console.log.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function warn() { console.warn.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function error() { console.error.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }

  var OWNER_EMAIL =
    (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) ||
    window.ownerEmail ||
    '';

  var db = null;
  var auth = null;
  var bizKey = null;
  var projKey = null;
  var isOwner = false;
  var issueRows = null; // null = not loaded yet; [] = loaded, genuinely empty

  // ---------- Sample/placeholder data ----------
  // Shown only until a real file is imported — never written to Firestore,
  // so it can't be mistaken for real data. Dates are plain strings here
  // (matching how a fresh import would look before parsing) purely for
  // this hardcoded demo; real imports go through toJsDate() like every
  // other date field in the app.
  var SAMPLE_ISSUES = [
    { id: 'ISS-001', dateRaised: '2026-04-08', category: 'Resource', description: 'Lead developer unavailable for 2 weeks due to a family emergency', severity: 'High', rootCause: 'No backup assigned to critical-path tasks', raisedBy: 'PM', owner: 'Tech Lead-1', status: 'Resolved', targetResolutionDate: '2026-04-15', dateResolved: '2026-04-14', relatedRiskId: 'R-003', resolution: 'Reassigned tasks to a secondary developer, adjusted schedule', notes: 'Caused a 3-day slip on Sprint 2 deliverables' },
    { id: 'ISS-002', dateRaised: '2026-04-22', category: 'Vendor', description: 'Third-party API vendor missed the agreed integration deadline', severity: 'Critical', rootCause: 'Vendor underestimated scope during contract negotiation', raisedBy: 'Product Owner', owner: 'Vendor Manager', status: 'In Progress', targetResolutionDate: '2026-05-01', dateResolved: '', relatedRiskId: 'R-001', resolution: 'Escalated to the vendor account manager, daily check-ins started', notes: '' },
    { id: 'ISS-003', dateRaised: '2026-05-05', category: 'Technical', description: 'Production database migration script corrupted test data', severity: 'Medium', rootCause: 'Script did not account for a legacy schema variant', raisedBy: 'Tech Lead-2', owner: 'Tech Lead-2', status: 'Resolved', targetResolutionDate: '2026-05-08', dateResolved: '2026-05-07', relatedRiskId: '', resolution: 'Restored from backup, added a schema validation step', notes: 'No production impact' },
    { id: 'ISS-004', dateRaised: '2026-05-18', category: 'Communication', description: 'Client stakeholder unaware of a scope change approved 2 sprints ago', severity: 'Medium', rootCause: 'Change log was not shared outside the internal team', raisedBy: 'PM', owner: 'PM', status: 'Open', targetResolutionDate: '2026-05-25', dateResolved: '', relatedRiskId: '', resolution: '', notes: 'Scheduling a stakeholder sync this week' },
    { id: 'ISS-005', dateRaised: '2026-06-02', category: 'Scope', description: 'Feature request submitted mid-sprint without going through change control', severity: 'Low', rootCause: 'No formal intake process for ad-hoc requests', raisedBy: 'Product Owner', owner: 'Product Owner', status: 'Closed', targetResolutionDate: '2026-06-05', dateResolved: '2026-06-04', relatedRiskId: '', resolution: 'Routed to backlog for next sprint planning', notes: '' }
  ];

  function resolveBusinessKey() {
    var params = new URLSearchParams(window.location.search || '');
    return params.get('business') || (window.localStorage && window.localStorage.getItem('businessKey')) || window.BIZ_KEY || null;
  }

  // Multi-project cutover — issueLog now lives on the project doc, not
  // the business doc.
  function projRef() {
    return db.collection('businesses').doc(bizKey)
      .collection('projects').doc(projKey || 'default');
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function toJsDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number' && window.XLSX && XLSX.SSF) {
      var parsed = XLSX.SSF.parse_date_code(v);
      if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d);
    }
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(v) {
    var d = toJsDate(v);
    if (!d) return '';
    return window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString();
  }

  // Same H/M/L(+Critical) badge convention as Quality/Defects Log — an
  // issue that's blocking work reads the same way a Critical/High defect
  // does, deliberately, since both are "this needs attention now."
  var SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
  function severityClass(sev) {
    var rank = SEVERITY_RANK[(sev || '').trim().toLowerCase()];
    return rank >= 4 ? 'high' : rank === 3 ? 'high' : rank === 2 ? 'medium' : rank === 1 ? 'low' : 'unknown';
  }

  // ---------- Sort / Filter / Pagination state ----------
  var issueSort = { key: null, dir: 'asc' };
  var issueFilters = { category: [], severity: [], status: [], owner: [] };
  function matchesMulti(selected, value) {
    return !selected.length || selected.indexOf(value) !== -1;
  }
  var issuePage = 1;
  var ISSUE_PAGE_SIZE = 15;

  function populateIssueFilters(rows) {
    var fields = [
      { key: 'category', id: 'issueLogFilterCategory', allLabel: 'All Categories' },
      { key: 'severity', id: 'issueLogFilterSeverity', allLabel: 'All Severity' },
      { key: 'status', id: 'issueLogFilterStatus', allLabel: 'All Status' },
      { key: 'owner', id: 'issueLogFilterOwner', allLabel: 'All Owners' }
    ];
    fields.forEach(function (f) {
      var sel = document.getElementById(f.id);
      if (!sel) return;
      var current = sel.value;
      var values = Array.from(
        rows.reduce(function (set, r) {
          var v = (r[f.key] || '').toString().trim();
          if (v) set.add(v);
          return set;
        }, new Set())
      ).sort(function (a, b) { return a.localeCompare(b); });

      sel.innerHTML = '<option value="">' + f.allLabel + '</option>' +
        values.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
      if (values.indexOf(current) !== -1) sel.value = current;
    });
  }

  function getFilteredSortedIssues(rows) {
    var out = rows.filter(function (r) {
      return matchesMulti(issueFilters.category, r.category) &&
        matchesMulti(issueFilters.severity, r.severity) &&
        matchesMulti(issueFilters.status, r.status) &&
        matchesMulti(issueFilters.owner, r.owner);
    });

    if (issueSort.key) {
      var key = issueSort.key;
      var dir = issueSort.dir === 'desc' ? -1 : 1;
      out = out.slice().sort(function (a, b) {
        var av = a[key], bv = b[key];
        var isDateField = key === 'dateRaised' || key === 'dateResolved' || key === 'targetResolutionDate';
        if (isDateField) {
          var avDate = toJsDate(av), bvDate = toJsDate(bv);
          var at = avDate ? avDate.getTime() : -Infinity;
          var bt = bvDate ? bvDate.getTime() : -Infinity;
          return (at - bt) * dir;
        }
        av = (av || '').toString().toLowerCase();
        bv = (bv || '').toString().toLowerCase();
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return out;
  }

  function wireIssueControls() {
    var thead = document.querySelector('#issueLogTable thead');
    if (thead && !thead.__sortWired) {
      thead.__sortWired = true;
      thead.addEventListener('click', function (e) {
        var th = e.target.closest('th[data-sort]');
        if (!th) return;
        var key = th.getAttribute('data-sort');
        if (issueSort.key === key) {
          issueSort.dir = issueSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          issueSort.key = key;
          issueSort.dir = 'asc';
        }
        issuePage = 1;
        renderIssueTable();
      });
    }

    ['Category', 'Severity', 'Status', 'Owner'].forEach(function (label) {
      var sel = document.getElementById('issueLogFilter' + label);
      var stateKey = label.charAt(0).toLowerCase() + label.slice(1);
      if (sel && window.drCreateMultiSelectFilter) {
        window.drCreateMultiSelectFilter(sel, function (values) {
          issueFilters[stateKey] = values;
          issuePage = 1;
          renderIssueTable();
        });
      }
    });

    var resetBtn = document.getElementById('issueLogFilterReset');
    if (resetBtn && !resetBtn.__wired) {
      resetBtn.__wired = true;
      resetBtn.addEventListener('click', function () {
        issueFilters = { category: [], severity: [], status: [], owner: [] };
        ['Category', 'Severity', 'Status', 'Owner'].forEach(function (label) {
          var sel = document.getElementById('issueLogFilter' + label);
          if (sel && sel.__drMultiSelect) sel.__drMultiSelect.clear();
        });
        issuePage = 1;
        renderIssueTable();
      });
    }

    var pagePrevBtn = document.getElementById('issueLogPagePrev');
    var pageNextBtn = document.getElementById('issueLogPageNext');
    if (pagePrevBtn && !pagePrevBtn.__wired) {
      pagePrevBtn.__wired = true;
      pagePrevBtn.addEventListener('click', function () {
        issuePage--;
        renderIssueTable();
      });
    }
    if (pageNextBtn && !pageNextBtn.__wired) {
      pageNextBtn.__wired = true;
      pageNextBtn.addEventListener('click', function () {
        issuePage++;
        renderIssueTable();
      });
    }
  }

  // ---------- Table ----------
  function renderIssueTable() {
    var card = document.getElementById('issueLogCard');
    var tbody = document.querySelector('#issueLogTable tbody');
    var banner = document.getElementById('issueLogSampleBanner');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('issueLogCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    wireIssueControls();

    var usingSample = !issueRows || !issueRows.length;
    var allRows = usingSample ? SAMPLE_ISSUES : issueRows;
    if (banner) banner.hidden = !usingSample;

    populateIssueFilters(allRows);
    var rows = getFilteredSortedIssues(allRows);

    document.querySelectorAll('#issueLogTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === issueSort.key) th.classList.add(issueSort.dir);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="14" class="metrics-empty">No issues match the selected filters.</td></tr>';
      if (window.drInsight) window.drInsight.set('issueLogCard', '');
      var pageInfoElEmpty = document.getElementById('issueLogPageInfo');
      if (pageInfoElEmpty) pageInfoElEmpty.textContent = '';
      var prevBtnElEmpty = document.getElementById('issueLogPagePrev');
      var nextBtnElEmpty = document.getElementById('issueLogPageNext');
      if (prevBtnElEmpty) prevBtnElEmpty.disabled = true;
      if (nextBtnElEmpty) nextBtnElEmpty.disabled = true;
      return;
    }

    var totalPages = Math.max(1, Math.ceil(rows.length / ISSUE_PAGE_SIZE));
    if (issuePage > totalPages) issuePage = totalPages;
    if (issuePage < 1) issuePage = 1;
    var startIdx = (issuePage - 1) * ISSUE_PAGE_SIZE;
    var pageRows = rows.slice(startIdx, startIdx + ISSUE_PAGE_SIZE);

    var pageInfoEl = document.getElementById('issueLogPageInfo');
    if (pageInfoEl) pageInfoEl.textContent = 'Page ' + issuePage + ' of ' + totalPages + ' (' + rows.length + (rows.length === 1 ? ' row' : ' rows') + ')';
    var prevBtnEl = document.getElementById('issueLogPagePrev');
    var nextBtnEl = document.getElementById('issueLogPageNext');
    if (prevBtnEl) prevBtnEl.disabled = issuePage <= 1;
    if (nextBtnEl) nextBtnEl.disabled = issuePage >= totalPages;

    tbody.innerHTML = pageRows.map(function (r) {
      var sevClass = severityClass(r.severity);
      var titleAttr = esc([
        r.rootCause ? 'Root Cause: ' + r.rootCause : '',
        r.resolution ? 'Resolution: ' + r.resolution : '',
        r.notes ? 'Notes: ' + r.notes : ''
      ].filter(Boolean).join(' — '));
      return '<tr title="' + titleAttr + '">' +
        '<td>' + esc(r.id) + '</td>' +
        '<td>' + esc(fmtDate(r.dateRaised)) + '</td>' +
        '<td>' + esc(r.category) + '</td>' +
        '<td class="wrap-text">' + esc(r.description) + '</td>' +
        '<td><span class="severity-badge severity-' + sevClass + '">' + esc(r.severity) + '</span></td>' +
        '<td class="wrap-text">' + esc(r.rootCause) + '</td>' +
        '<td>' + esc(r.raisedBy) + '</td>' +
        '<td>' + esc(r.owner) + '</td>' +
        '<td>' + esc(r.status) + '</td>' +
        '<td>' + (r.targetResolutionDate ? esc(fmtDate(r.targetResolutionDate)) : '—') + '</td>' +
        '<td>' + (r.dateResolved ? esc(fmtDate(r.dateResolved)) : '—') + '</td>' +
        '<td>' + (r.relatedRiskId ? esc(r.relatedRiskId) : '—') + '</td>' +
        '<td class="wrap-text">' + esc(r.resolution) + '</td>' +
        '<td class="wrap-text">' + esc(r.notes) + '</td>' +
        '</tr>';
    }).join('');

    if (window.drRefs) {
      allRows.forEach(function (r) {
        window.drRefs.register(r.id, {
          cardId: 'issueLogCard', cardLabel: 'Issue Log',
          summary: r.description,
          fields: [{ label: 'Severity', value: r.severity }, { label: 'Status', value: r.status }, { label: 'Owner', value: r.owner }]
        });
      });
    }

    if (window.drInsight) {
      var openRows = allRows.filter(function (r) { return (r.status || '').toLowerCase() !== 'closed' && (r.status || '').toLowerCase() !== 'resolved'; });
      var criticalOpen = openRows.filter(function (r) { return severityClass(r.severity) === 'high'; });
      var text = allRows.length + ' issue' + (allRows.length === 1 ? '' : 's') + ' logged, ' + openRows.length + ' still open.';
      if (criticalOpen.length) {
        text += ' ' + criticalOpen.length + ' open at critical/high severity' + (criticalOpen[0].description ? ', top one: ' + criticalOpen[0].id + ' — "' + criticalOpen[0].description + '".' : '.');
      }
      if (usingSample) text += ' (sample data)';
      window.drInsight.set('issueLogCard', text);
    }
  }

  function loadIssueRows() {
    return projRef().get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      issueRows = Array.isArray(data.issueLog) ? data.issueLog : [];
      renderIssueTable();
      if (window.drLastUpdated) window.drLastUpdated.render('issueLogLastUpdated', data.issueLogLastImportedAt);
    }).catch(function (err) { error('load issue log failed', err); });
  }

  // ---------- Import ----------
  function colIndex(header, names) {
    for (var i = 0; i < header.length; i++) {
      if (names.indexOf(header[i]) !== -1) return i;
    }
    return -1;
  }

  function wireImport() {
    var input = document.getElementById('issueLogImportInput');
    var btn = document.getElementById('issueLogImportBtn');
    if (!input || !btn) return;

    if (!isOwner) { input.style.display = 'none'; btn.style.display = 'none'; return; }
    input.style.display = '';
    btn.style.display = '';
    if (btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener('click', function () {
      if (!input.files || !input.files[0]) { alert('Choose an Issue Log export file first.'); return; }
      if (window.drProgress) window.drProgress.show('Importing issue log…');

      input.files[0].arrayBuffer().then(function (data) {
        var wb = XLSX.read(data, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (!rows.length) { alert('File has no rows.'); return; }

        var header = rows[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
        var idxId = colIndex(header, ['id']);
        var idxDateRaised = colIndex(header, ['date raised']);
        var idxCategory = colIndex(header, ['category']);
        var idxDescription = colIndex(header, ['description']);
        var idxSeverity = colIndex(header, ['severity']);
        var idxRootCause = colIndex(header, ['root cause']);
        var idxRaisedBy = colIndex(header, ['raised by']);
        var idxOwner = colIndex(header, ['owner']);
        var idxStatus = colIndex(header, ['status']);
        var idxTargetResolutionDate = colIndex(header, ['target resolution date', 'target resolution']);
        var idxDateResolved = colIndex(header, ['date resolved']);
        var idxRelatedRiskId = colIndex(header, ['related risk id', 'related risk']);
        var idxResolution = colIndex(header, ['resolution']);
        var idxNotes = colIndex(header, ['notes']);

        if (idxId === -1 || idxDescription === -1) {
          alert('Issue Log file must have ID and Description columns.');
          return;
        }

        log('column mapping', { id: header[idxId], description: header[idxDescription] });

        var out = [];
        rows.slice(1).forEach(function (row) {
          var id = row[idxId] != null ? String(row[idxId]).trim() : '';
          if (!id) return;
          out.push({
            id: id,
            dateRaised: idxDateRaised >= 0 ? toJsDate(row[idxDateRaised]) : null,
            category: idxCategory >= 0 && row[idxCategory] != null ? String(row[idxCategory]).trim() : '',
            description: idxDescription >= 0 && row[idxDescription] != null ? String(row[idxDescription]).trim() : '',
            severity: idxSeverity >= 0 && row[idxSeverity] != null ? String(row[idxSeverity]).trim() : '',
            rootCause: idxRootCause >= 0 && row[idxRootCause] != null ? String(row[idxRootCause]).trim() : '',
            raisedBy: idxRaisedBy >= 0 && row[idxRaisedBy] != null ? String(row[idxRaisedBy]).trim() : '',
            owner: idxOwner >= 0 && row[idxOwner] != null ? String(row[idxOwner]).trim() : '',
            status: idxStatus >= 0 && row[idxStatus] != null ? String(row[idxStatus]).trim() : '',
            targetResolutionDate: idxTargetResolutionDate >= 0 ? toJsDate(row[idxTargetResolutionDate]) : null,
            dateResolved: idxDateResolved >= 0 ? toJsDate(row[idxDateResolved]) : null,
            relatedRiskId: idxRelatedRiskId >= 0 && row[idxRelatedRiskId] != null ? String(row[idxRelatedRiskId]).trim() : '',
            resolution: idxResolution >= 0 && row[idxResolution] != null ? String(row[idxResolution]).trim() : '',
            notes: idxNotes >= 0 && row[idxNotes] != null ? String(row[idxNotes]).trim() : ''
          });
        });

        if (!out.length) { alert('No valid rows found — each row needs an ID.'); return; }

        var issueLogImportedAt = new Date();
        projRef().set({ issueLog: out, issueLogLastImportedAt: issueLogImportedAt }, { merge: true }).then(function () {
          alert('Issue Log imported: ' + out.length + ' issues.');
          input.value = '';
          issueRows = out;
          renderIssueTable();
          if (window.drLastUpdated) window.drLastUpdated.render('issueLogLastUpdated', issueLogImportedAt);
        }).catch(function (err) {
          error('save issue log failed', err);
          alert('Import failed: ' + (err && err.message ? err.message : err));
        });
      }).catch(function (err) {
        error('read issue log failed', err);
        alert('Import failed: ' + (err && err.message ? err.message : err));
      }).finally(function () {
        if (window.drProgress) window.drProgress.hide();
      });
    });
  }

  function start() {
    db = window.db || null;
    auth = window.auth || null;
    if (!db || !auth || typeof window.XLSX === 'undefined') { setTimeout(start, 200); return; }
    bizKey = resolveBusinessKey();
    if (!bizKey) { setTimeout(start, 300); return; }

    // Multi-project cutover — every business always has at least the
    // auto-created 'default' project (dashboard-business-loader.js
    // guarantees window.PROJECT_KEY is set by the time this runs).
    projKey = window.PROJECT_KEY || 'default';

    log('initialized', { bizKey: bizKey, projKey: projKey });
    wireImport();

    auth.onAuthStateChanged(function (user) {
      var email = (user && user.email) || '';
      isOwner = !!email && !!OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
      wireImport();
      loadIssueRows();
    });

    // renderIssueTable() checks window.drAccess.canViewReport() to decide
    // whether to populate at all — if the Firestore snapshot that
    // triggers it fires before dr-access-control.js finishes resolving
    // role/permissions (a real timing race either way), it renders a
    // permanently empty card with no second chance. Safe to re-run with
    // no arguments (cached module state), so re-run once access is known
    // to be resolved.
    if (window.drAccess) window.drAccess.whenReady().then(renderIssueTable);
  }

  start();
})();
