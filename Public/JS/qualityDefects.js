// Public/JS/qualityDefects.js
// Quality / Defects Log (owner-only) — the one project goal (Quality) this
// dashboard had no data for at all. Unlike Risk Register/Assumptions Log,
// there's no existing export to match column-for-column, so this module
// DEFINES the expected file shape and ships with sample/placeholder rows
// (clearly labeled) so you can see it before building a real export to
// match. Swap the real file in via the same "Import" control once ready —
// nothing here needs to change, just the column names below.
//
// Expected columns (case-insensitive, same matching style as every other
// import in this app):
//   ID, Date Logged, Category, Description, Severity, Found In,
//   Status, Assigned To, Date Resolved, Resolution / Root Cause,
//   Reopened Count, Notes

(function () {
  'use strict';

  var TAG = '[qualityDefects]';
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
  var defectRows = null; // null = not loaded yet; [] = loaded, genuinely empty
  var defectChartInstance = null;
  // Tracks the same global time frame control burndown.js's charts use
  // (broadcast via the 'dr-timeframe-changed' event since this is a
  // separate script with no shared module) — same default as burndown.js
  // so both start in agreement before the first change event ever fires.
  var currentTimeframeUnit = '3month';

  // ---------- Sample/placeholder data ----------
  // Shown only until a real file is imported — never written to Firestore,
  // so it can't be mistaken for real data or pollute the database. Dates
  // are plain strings here (matching how a fresh import would look before
  // parsing) purely for this hardcoded demo; real imports go through
  // toJsDate() like every other date field in the app.
  var SAMPLE_DEFECTS = [
    { id: 'D-001', dateLogged: '2026-04-10', category: 'Functional', description: 'Task creation fails when title exceeds 200 characters', severity: 'High', foundIn: 'Sprint 1', status: 'Resolved', assignedTo: 'Tech Lead-1', dateResolved: '2026-04-12', resolution: 'Added input validation and truncation warning', reopenedCount: 0, notes: 'Found during Sprint 1 QA pass' },
    { id: 'D-002', dateLogged: '2026-04-15', category: 'UX', description: 'Progress bar does not update in real time on mobile view', severity: 'Medium', foundIn: 'Sprint 1', status: 'Open', assignedTo: 'Development Team', dateResolved: '', resolution: '', reopenedCount: 0, notes: 'Needs responsive design review' },
    { id: 'D-003', dateLogged: '2026-05-02', category: 'Performance', description: 'Search results take over 5 seconds to return for 500+ tasks', severity: 'High', foundIn: 'Sprint 2', status: 'In Progress', assignedTo: 'Tech Lead-2', dateResolved: '', resolution: 'Investigating indexing strategy', reopenedCount: 1, notes: 'Reopened after initial fix regressed' },
    { id: 'D-004', dateLogged: '2026-05-20', category: 'Security', description: 'Session token not invalidated on logout', severity: 'Critical', foundIn: 'Sprint 3', status: 'Resolved', assignedTo: 'Security Lead', dateResolved: '2026-05-22', resolution: 'Implemented server-side token revocation', reopenedCount: 0, notes: 'Verified via penetration test' },
    { id: 'D-005', dateLogged: '2026-06-01', category: 'Functional', description: 'Duplicate milestone created when import run twice quickly', severity: 'Medium', foundIn: 'Sprint 3', status: 'Closed', assignedTo: 'Tech Lead-1', dateResolved: '2026-06-03', resolution: 'Added WBS-based duplicate check', reopenedCount: 0, notes: '' },
    { id: 'D-006', dateLogged: '2026-06-10', category: 'UX', description: 'Q&A filter dropdowns reset after adding a new item', severity: 'Low', foundIn: 'Sprint 4', status: 'Open', assignedTo: 'Product Owner', dateResolved: '', resolution: '', reopenedCount: 0, notes: '' }
  ];

  function resolveBusinessKey() {
    var params = new URLSearchParams(window.location.search || '');
    return params.get('business') || (window.localStorage && window.localStorage.getItem('businessKey')) || window.BIZ_KEY || null;
  }

  // Multi-project cutover — qualityDefects now lives on the project doc,
  // not the business doc.
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
  function dateOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function fmtDate(v) {
    var d = toJsDate(v);
    if (!d) return '';
    return window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString();
  }

  var SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
  function severityClass(sev) {
    var rank = SEVERITY_RANK[(sev || '').trim().toLowerCase()];
    return rank >= 4 ? 'high' : rank === 3 ? 'high' : rank === 2 ? 'medium' : rank === 1 ? 'low' : 'unknown';
  }

  // ---------- Sort / Filter / Pagination state ----------
  var defectsSort = { key: null, dir: 'asc' };
  var defectsFilters = { category: [], severity: [], foundIn: [], status: [], assignedTo: [] };
  function matchesMulti(selected, value) {
    return !selected.length || selected.indexOf(value) !== -1;
  }
  var defectsPage = 1;
  var DEFECTS_PAGE_SIZE = 15;

  function populateDefectsFilters(rows) {
    var fields = [
      { key: 'category', id: 'defectsFilterCategory', allLabel: 'All Categories' },
      { key: 'severity', id: 'defectsFilterSeverity', allLabel: 'All Severity' },
      { key: 'foundIn', id: 'defectsFilterFoundIn', allLabel: 'All Found In' },
      { key: 'status', id: 'defectsFilterStatus', allLabel: 'All Status' },
      { key: 'assignedTo', id: 'defectsFilterAssignedTo', allLabel: 'All Assigned To' }
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

  function getFilteredSortedDefects(rows) {
    var out = rows.filter(function (r) {
      return matchesMulti(defectsFilters.category, r.category) &&
        matchesMulti(defectsFilters.severity, r.severity) &&
        matchesMulti(defectsFilters.foundIn, r.foundIn) &&
        matchesMulti(defectsFilters.status, r.status) &&
        matchesMulti(defectsFilters.assignedTo, r.assignedTo);
    });

    if (defectsSort.key) {
      var key = defectsSort.key;
      var dir = defectsSort.dir === 'desc' ? -1 : 1;
      out = out.slice().sort(function (a, b) {
        var av = a[key], bv = b[key];
        // dateLogged/dateResolved may be real Date objects (or Firestore
        // Timestamps) — comparing those via toString() would sort by
        // weekday name, not chronologically.
        var avDate = toJsDate(av), bvDate = toJsDate(bv);
        if ((key === 'dateLogged' || key === 'dateResolved')) {
          var at = avDate ? avDate.getTime() : -Infinity;
          var bt = bvDate ? bvDate.getTime() : -Infinity;
          return (at - bt) * dir;
        }
        var an = parseFloat(av), bn = parseFloat(bv);
        var bothNumeric = av !== '' && bv !== '' && av != null && bv != null && !isNaN(an) && !isNaN(bn);
        if (bothNumeric) return (an - bn) * dir;
        av = (av || '').toString().toLowerCase();
        bv = (bv || '').toString().toLowerCase();
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return out;
  }

  function wireDefectsControls() {
    var thead = document.querySelector('#qualityDefectsTable thead');
    if (thead && !thead.__sortWired) {
      thead.__sortWired = true;
      thead.addEventListener('click', function (e) {
        var th = e.target.closest('th[data-sort]');
        if (!th) return;
        var key = th.getAttribute('data-sort');
        if (defectsSort.key === key) {
          defectsSort.dir = defectsSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          defectsSort.key = key;
          defectsSort.dir = 'asc';
        }
        defectsPage = 1;
        renderDefectsTable();
      });
    }

    ['Category', 'Severity', 'FoundIn', 'Status', 'AssignedTo'].forEach(function (label) {
      var sel = document.getElementById('defectsFilter' + label);
      var stateKey = label.charAt(0).toLowerCase() + label.slice(1);
      if (sel && window.drCreateMultiSelectFilter) {
        window.drCreateMultiSelectFilter(sel, function (values) {
          defectsFilters[stateKey] = values;
          defectsPage = 1;
          renderDefectsTable();
        });
      }
    });

    var resetBtn = document.getElementById('defectsFilterReset');
    if (resetBtn && !resetBtn.__wired) {
      resetBtn.__wired = true;
      resetBtn.addEventListener('click', function () {
        defectsFilters = { category: [], severity: [], foundIn: [], status: [], assignedTo: [] };
        ['Category', 'Severity', 'FoundIn', 'Status', 'AssignedTo'].forEach(function (label) {
          var sel = document.getElementById('defectsFilter' + label);
          if (sel && sel.__drMultiSelect) sel.__drMultiSelect.clear();
        });
        defectsPage = 1;
        renderDefectsTable();
      });
    }

    var pagePrevBtn = document.getElementById('defectsPagePrev');
    var pageNextBtn = document.getElementById('defectsPageNext');
    if (pagePrevBtn && !pagePrevBtn.__wired) {
      pagePrevBtn.__wired = true;
      pagePrevBtn.addEventListener('click', function () {
        defectsPage--;
        renderDefectsTable();
      });
    }
    if (pageNextBtn && !pageNextBtn.__wired) {
      pageNextBtn.__wired = true;
      pageNextBtn.addEventListener('click', function () {
        defectsPage++;
        renderDefectsTable();
      });
    }

    // Pages the table's own scroll box up/down — same reasoning as the
    // Gantt chart's directional pad and every other table's up/down pair.
    var upBtn = document.getElementById('defectsPageUp');
    var downBtn = document.getElementById('defectsPageDown');
    if (upBtn && !upBtn.__wired) {
      upBtn.__wired = true;
      upBtn.addEventListener('click', function () {
        var scrollEl = document.querySelector('#qualityDefectsCard .risk-assumptions-table-wrap');
        if (scrollEl) scrollEl.scrollBy({ top: -scrollEl.clientHeight * 0.6, behavior: 'smooth' });
      });
    }
    if (downBtn && !downBtn.__wired) {
      downBtn.__wired = true;
      downBtn.addEventListener('click', function () {
        var scrollEl = document.querySelector('#qualityDefectsCard .risk-assumptions-table-wrap');
        if (scrollEl) scrollEl.scrollBy({ top: scrollEl.clientHeight * 0.6, behavior: 'smooth' });
      });
    }
  }

  // ---------- Table ----------
  function renderDefectsTable() {
    var card = document.getElementById('qualityDefectsCard');
    var tbody = document.querySelector('#qualityDefectsTable tbody');
    var banner = document.getElementById('qualityDefectsSampleBanner');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('qualityDefectsCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    wireDefectsControls();

    var usingSample = !defectRows || !defectRows.length;
    var allRows = usingSample ? SAMPLE_DEFECTS : defectRows;
    if (banner) banner.hidden = !usingSample;

    populateDefectsFilters(allRows);
    var rows = getFilteredSortedDefects(allRows);

    document.querySelectorAll('#qualityDefectsTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === defectsSort.key) th.classList.add(defectsSort.dir);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="metrics-empty">No defects match the selected filters.</td></tr>';
      if (window.drInsight) window.drInsight.set('qualityDefectsCard', '');
      var pageInfoElEmpty = document.getElementById('defectsPageInfo');
      if (pageInfoElEmpty) pageInfoElEmpty.textContent = '';
      var prevBtnElEmpty = document.getElementById('defectsPagePrev');
      var nextBtnElEmpty = document.getElementById('defectsPageNext');
      if (prevBtnElEmpty) prevBtnElEmpty.disabled = true;
      if (nextBtnElEmpty) nextBtnElEmpty.disabled = true;
      return;
    }

    var totalPages = Math.max(1, Math.ceil(rows.length / DEFECTS_PAGE_SIZE));
    if (defectsPage > totalPages) defectsPage = totalPages;
    if (defectsPage < 1) defectsPage = 1;
    var startIdx = (defectsPage - 1) * DEFECTS_PAGE_SIZE;
    var pageRows = rows.slice(startIdx, startIdx + DEFECTS_PAGE_SIZE);

    var pageInfoEl = document.getElementById('defectsPageInfo');
    if (pageInfoEl) pageInfoEl.textContent = 'Page ' + defectsPage + ' of ' + totalPages + ' (' + rows.length + (rows.length === 1 ? ' row' : ' rows') + ')';
    var prevBtnEl = document.getElementById('defectsPagePrev');
    var nextBtnEl = document.getElementById('defectsPageNext');
    if (prevBtnEl) prevBtnEl.disabled = defectsPage <= 1;
    if (nextBtnEl) nextBtnEl.disabled = defectsPage >= totalPages;

    tbody.innerHTML = pageRows.map(function (r) {
      var sevClass = severityClass(r.severity);
      var titleAttr = esc([
        r.resolution ? 'Resolution: ' + r.resolution : '',
        r.notes ? 'Notes: ' + r.notes : ''
      ].filter(Boolean).join(' — '));
      return '<tr title="' + titleAttr + '">' +
        '<td>' + esc(r.id) + '</td>' +
        '<td>' + esc(fmtDate(r.dateLogged)) + '</td>' +
        '<td>' + esc(r.category) + '</td>' +
        '<td class="wrap-text">' + esc(r.description) + '</td>' +
        '<td><span class="severity-badge severity-' + sevClass + '">' + esc(r.severity) + '</span></td>' +
        '<td>' + esc(r.foundIn) + '</td>' +
        '<td>' + esc(r.status) + '</td>' +
        '<td>' + esc(r.assignedTo) + '</td>' +
        '<td>' + (r.dateResolved ? esc(fmtDate(r.dateResolved)) : '—') + '</td>' +
        '<td class="wrap-text">' + esc(r.resolution) + '</td>' +
        '<td>' + (r.reopenedCount || 0) + '</td>' +
        '<td class="wrap-text">' + esc(r.notes) + '</td>' +
        '</tr>';
    }).join('');

    if (window.drRefs) {
      allRows.forEach(function (r) {
        window.drRefs.register(r.id, {
          cardId: 'qualityDefectsCard', cardLabel: 'Quality/Defects',
          summary: r.description,
          fields: [{ label: 'Severity', value: r.severity }, { label: 'Status', value: r.status }, { label: 'Assigned To', value: r.assignedTo }]
        });
      });
    }

    if (window.drInsight) {
      var openRows = allRows.filter(function (r) { return (r.status || '').toLowerCase() !== 'closed' && (r.status || '').toLowerCase() !== 'resolved'; });
      var critical = openRows.filter(function (r) { return severityClass(r.severity) === 'high'; });
      var reopened = allRows.filter(function (r) { return (r.reopenedCount || 0) > 0; });
      var text = allRows.length + ' defect' + (allRows.length === 1 ? '' : 's') + ' logged, ' + openRows.length + ' still open.';
      if (critical.length) {
        text += ' ' + critical.length + ' open at high severity' + (critical[0].description ? ', top one: ' + critical[0].id + ' — "' + critical[0].description + '".' : '.');
      }
      if (reopened.length) {
        text += ' ' + reopened.length + ' defect' + (reopened.length === 1 ? ' has' : 's have') + ' been reopened at least once.';
      }
      if (usingSample) text += ' (sample data)';
      window.drInsight.set('qualityDefectsCard', text);
    }
  }

  function loadDefectRows() {
    return projRef().get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      defectRows = Array.isArray(data.qualityDefects) ? data.qualityDefects : [];
      renderDefectsTable();
      renderDefectTrend();
      if (window.drLastUpdated) window.drLastUpdated.render('qualityDefectsLastUpdated', data.qualityDefectsLastImportedAt);
    }).catch(function (err) { error('load defects failed', err); });
  }

  // ---------- Defect Trend chart ----------
  // Cumulative Opened vs Cumulative Resolved, from dateLogged/dateResolved
  // — same "cumulative flow" shape as the CFD chart, but for quality
  // instead of schedule. Bucket width now follows the same global time
  // frame control every other trend chart on the dashboard uses (Week =
  // weekly points, Month = monthly, and so on; Total Project collapses to
  // start/end only) — same convention as burndown.js's buildPeriodTimeline,
  // reimplemented locally since this is a separate script with no shared
  // module to import it from. Uses sample data too (clearly labeled) until
  // a real import exists, so the shape of the insight is visible
  // immediately rather than only after data arrives.
  function bucketStep(d, unit) {
    if (unit === 'week') return new Date(d.getTime() + 7 * 86400000);
    var monthsPerBucket = unit === 'month' ? 1 : unit === '6month' ? 6 : unit === 'year' ? 12 : 3;
    return new Date(d.getFullYear(), d.getMonth() + monthsPerBucket, d.getDate());
  }

  function computeDefectTrend(rows, unit) {
    var withDates = rows.map(function (r) {
      return { logged: toJsDate(r.dateLogged), resolved: toJsDate(r.dateResolved) };
    }).filter(function (r) { return r.logged; });
    if (!withDates.length) return null;

    var minDate = withDates.reduce(function (m, r) { return r.logged < m ? r.logged : m; }, withDates[0].logged);
    var maxCandidate = withDates.reduce(function (m, r) {
      var latest = r.resolved && r.resolved > r.logged ? r.resolved : r.logged;
      return latest > m ? latest : m;
    }, withDates[0].logged);
    var today = dateOnly(new Date());
    var maxDate = maxCandidate > today ? maxCandidate : today;
    minDate = dateOnly(minDate);

    function countsAt(d) {
      return {
        opened: withDates.filter(function (r) { return r.logged <= d; }).length,
        resolved: withDates.filter(function (r) { return r.resolved && r.resolved <= d; }).length
      };
    }

    var labels = [], opened = [], resolved = [];
    function pushPoint(d) {
      var c = countsAt(d);
      labels.push(window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString());
      opened.push(c.opened);
      resolved.push(c.resolved);
    }

    // "Total Project" collapses to just the two endpoints, same as every
    // other chart's buildPeriodTimeline treats it — a full point-per-week
    // walk across a multi-year project would be unreadable and isn't what
    // "Total" means anywhere else on this dashboard.
    if (unit === 'total') {
      pushPoint(minDate);
      if (maxDate.getTime() !== minDate.getTime()) pushPoint(maxDate);
      return { labels: labels, opened: opened, resolved: resolved };
    }

    var d = minDate;
    pushPoint(d);
    while (d < maxDate) {
      d = bucketStep(d, unit);
      if (d > maxDate) d = maxDate;
      pushPoint(d);
    }

    return { labels: labels, opened: opened, resolved: resolved };
  }

  // Same hide-the-canvas-not-delete-it pattern as burndown.js's
  // setChartEmpty/clearChartEmpty — replacing the canvas via innerHTML
  // would remove it from the DOM permanently, so a later real import could
  // never redraw into it again.
  function setChartEmptyLocal(canvas, message) {
    var wrap = canvas.closest('.metrics-chart-wrap');
    if (!wrap) return;
    canvas.hidden = true;
    wrap.classList.add('is-empty');
    var msg = wrap.querySelector('.metrics-empty');
    if (!msg) { msg = document.createElement('p'); msg.className = 'metrics-empty'; wrap.appendChild(msg); }
    msg.textContent = message;
  }
  function clearChartEmptyLocal(canvas) {
    var wrap = canvas.closest('.metrics-chart-wrap');
    if (wrap) {
      wrap.classList.remove('is-empty');
      var msg = wrap.querySelector('.metrics-empty');
      if (msg) msg.remove();
    }
    canvas.hidden = false;
  }

  function renderDefectTrend() {
    var card = document.getElementById('defectTrendCard');
    var canvas = document.getElementById('defectTrendChart');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('defectTrendCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (window.drBurndownInternals) window.drBurndownInternals.applyTimeframeBadge('defectTrendCard', currentTimeframeUnit);
    if (!canView || !canvas || typeof window.Chart === 'undefined') return;

    var usingSample = !defectRows || !defectRows.length;
    var rows = usingSample ? SAMPLE_DEFECTS : defectRows;
    var trend = computeDefectTrend(rows, currentTimeframeUnit);
    if (!trend) {
      setChartEmptyLocal(canvas, 'No defects logged yet.');
      if (window.drInsight) window.drInsight.set('defectTrendCard', '');
      return;
    }
    clearChartEmptyLocal(canvas);

    if (defectChartInstance) { defectChartInstance.destroy(); }
    defectChartInstance = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: trend.labels,
        datasets: [
          { label: 'Opened (cumulative)', data: trend.opened, borderColor: '#dd3333', backgroundColor: '#dd3333', pointRadius: 1, pointHoverRadius: 3, borderWidth: 2, tension: 0.1 },
          { label: 'Resolved (cumulative)', data: trend.resolved, borderColor: '#2f9e44', backgroundColor: '#2f9e44', pointRadius: 1, pointHoverRadius: 3, borderWidth: 2, tension: 0.1 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { mode: 'index', intersect: false }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 90, minRotation: 90, autoSkip: true } },
          y: { beginAtZero: true, title: { display: true, text: 'defects', font: { size: 11 } }, grid: { color: '#e0e0e0' } }
        }
      }
    });

    if (window.drInsight) {
      var opened = trend.opened[trend.opened.length - 1];
      var resolved = trend.resolved[trend.resolved.length - 1];
      var openCount = opened - resolved;
      var tfLabel = { week: 'this week', month: 'this month', '3month': 'this quarter', '6month': 'the last 6 months', year: 'this year', total: 'the full project' }[currentTimeframeUnit] || 'the selected period';
      window.drInsight.set('defectTrendCard', opened + ' defects logged and ' + resolved + ' resolved ' + tfLabel + ' — ' + openCount + ' still open' + (usingSample ? ' (sample data).' : '.'));

      if (window.drInsight.setHistory) {
        var histTrend = computeDefectTrend(rows, 'month');
        if (histTrend) {
          var newPerMonth = histTrend.opened.map(function (v, i) { return i === 0 ? v : v - histTrend.opened[i - 1]; });
          window.drInsight.setHistory('defectTrendCard',
            'Across the full history (by month), new defects opened ranged from ' + Math.min.apply(null, newPerMonth) + ' to ' + Math.max.apply(null, newPerMonth) + ' per month.');
        }
      }
    }
  }

  // ---------- Import ----------
  function colIndex(header, names) {
    for (var i = 0; i < header.length; i++) {
      if (names.indexOf(header[i]) !== -1) return i;
    }
    return -1;
  }

  function wireImport() {
    var input = document.getElementById('defectsImportInput');
    var btn = document.getElementById('defectsImportBtn');
    if (!input || !btn) return;

    if (!isOwner) { input.style.display = 'none'; btn.style.display = 'none'; return; }
    input.style.display = '';
    btn.style.display = '';
    if (btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener('click', function () {
      if (!input.files || !input.files[0]) { alert('Choose a Defects/Quality Log export file first.'); return; }
      if (window.drProgress) window.drProgress.show('Importing quality/defects log…');

      input.files[0].arrayBuffer().then(function (data) {
        var wb = XLSX.read(data, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (!rows.length) { alert('File has no rows.'); return; }

        var header = rows[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
        var idxId = colIndex(header, ['id']);
        var idxDateLogged = colIndex(header, ['date logged']);
        var idxCategory = colIndex(header, ['category']);
        var idxDescription = colIndex(header, ['description']);
        var idxSeverity = colIndex(header, ['severity']);
        var idxFoundIn = colIndex(header, ['found in']);
        var idxStatus = colIndex(header, ['status']);
        var idxAssignedTo = colIndex(header, ['assigned to']);
        var idxDateResolved = colIndex(header, ['date resolved']);
        var idxResolution = colIndex(header, ['resolution / root cause', 'resolution/root cause', 'resolution']);
        var idxReopenedCount = colIndex(header, ['reopened count']);
        var idxNotes = colIndex(header, ['notes']);

        if (idxId === -1 || idxDescription === -1) {
          alert('Defects/Quality Log file must have ID and Description columns.');
          return;
        }

        log('column mapping', { id: header[idxId], description: header[idxDescription] });

        var out = [];
        rows.slice(1).forEach(function (row) {
          var id = row[idxId] != null ? String(row[idxId]).trim() : '';
          if (!id) return;
          out.push({
            id: id,
            dateLogged: idxDateLogged >= 0 ? toJsDate(row[idxDateLogged]) : null,
            category: idxCategory >= 0 && row[idxCategory] != null ? String(row[idxCategory]).trim() : '',
            description: idxDescription >= 0 && row[idxDescription] != null ? String(row[idxDescription]).trim() : '',
            severity: idxSeverity >= 0 && row[idxSeverity] != null ? String(row[idxSeverity]).trim() : '',
            foundIn: idxFoundIn >= 0 && row[idxFoundIn] != null ? String(row[idxFoundIn]).trim() : '',
            status: idxStatus >= 0 && row[idxStatus] != null ? String(row[idxStatus]).trim() : '',
            assignedTo: idxAssignedTo >= 0 && row[idxAssignedTo] != null ? String(row[idxAssignedTo]).trim() : '',
            dateResolved: idxDateResolved >= 0 ? toJsDate(row[idxDateResolved]) : null,
            resolution: idxResolution >= 0 && row[idxResolution] != null ? String(row[idxResolution]).trim() : '',
            reopenedCount: idxReopenedCount >= 0 ? (parseInt(row[idxReopenedCount], 10) || 0) : 0,
            notes: idxNotes >= 0 && row[idxNotes] != null ? String(row[idxNotes]).trim() : ''
          });
        });

        if (!out.length) { alert('No valid rows found — each row needs an ID.'); return; }

        var defectsImportedAt = new Date();
        projRef().set({ qualityDefects: out, qualityDefectsLastImportedAt: defectsImportedAt }, { merge: true }).then(function () {
          alert('Defects/Quality Log imported: ' + out.length + ' defects.');
          input.value = '';
          defectRows = out;
          renderDefectsTable();
          renderDefectTrend();
          if (window.drLastUpdated) window.drLastUpdated.render('qualityDefectsLastUpdated', defectsImportedAt);
        }).catch(function (err) {
          error('save defects failed', err);
          alert('Import failed: ' + (err && err.message ? err.message : err));
        });
      }).catch(function (err) {
        error('read defects failed', err);
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

    // Same global time frame control burndown.js's charts follow —
    // broadcast via a custom event since this is a separate script with
    // no shared module (gantt.js listens to the same event for its own
    // view-mode sync).
    window.addEventListener('dr-timeframe-changed', function (e) {
      currentTimeframeUnit = (e.detail && e.detail.unit) || currentTimeframeUnit;
      renderDefectTrend();
    });

    auth.onAuthStateChanged(function (user) {
      var email = (user && user.email) || '';
      isOwner = !!email && !!OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
      wireImport();
      loadDefectRows();
    });

    // renderDefectsTable()/renderDefectTrend() each check
    // window.drAccess.canViewReport() to decide whether to populate at
    // all — if the Firestore snapshot that triggers them fires before
    // dr-access-control.js finishes resolving role/permissions (a real
    // timing race, not guaranteed either way), they'd render an
    // permanently empty card with no second chance to try again. Both
    // functions are safe to re-run with no arguments (they read cached
    // module state), so just re-run them once access is known to be
    // resolved either way.
    if (window.drAccess) window.drAccess.whenReady().then(function () {
      renderDefectsTable();
      renderDefectTrend();
    });
  }

  start();
})();
