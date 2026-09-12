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

  // ---------- Table ----------
  function renderDefectsTable() {
    var card = document.getElementById('qualityDefectsCard');
    var tbody = document.querySelector('#qualityDefectsTable tbody');
    var banner = document.getElementById('qualityDefectsSampleBanner');
    if (!card) return;
    card.classList.toggle('owner', isOwner);
    if (!isOwner || !tbody) return;

    var usingSample = !defectRows || !defectRows.length;
    var rows = usingSample ? SAMPLE_DEFECTS : defectRows;
    if (banner) banner.hidden = !usingSample;

    tbody.innerHTML = rows.map(function (r) {
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
  }

  function loadDefectRows() {
    return db.collection('businesses').doc(bizKey).get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      defectRows = Array.isArray(data.qualityDefects) ? data.qualityDefects : [];
      renderDefectsTable();
      renderDefectTrend();
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
    card.classList.toggle('owner', isOwner);
    if (!isOwner || !canvas || typeof window.Chart === 'undefined') return;

    var usingSample = !defectRows || !defectRows.length;
    var rows = usingSample ? SAMPLE_DEFECTS : defectRows;
    var trend = computeDefectTrend(rows, currentTimeframeUnit);
    if (!trend) {
      setChartEmptyLocal(canvas, 'No defects logged yet.');
      return;
    }
    clearChartEmptyLocal(canvas);

    if (defectChartInstance) { defectChartInstance.destroy(); }
    defectChartInstance = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: trend.labels,
        datasets: [
          { label: 'Opened (cumulative)', data: trend.opened, borderColor: '#dd3333', backgroundColor: '#dd3333', pointRadius: 2, borderWidth: 2, tension: 0.1 },
          { label: 'Resolved (cumulative)', data: trend.resolved, borderColor: '#2f9e44', backgroundColor: '#2f9e44', pointRadius: 2, borderWidth: 2, tension: 0.1 }
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

        db.collection('businesses').doc(bizKey).set({ qualityDefects: out }, { merge: true }).then(function () {
          alert('Defects/Quality Log imported: ' + out.length + ' defects.');
          input.value = '';
          defectRows = out;
          renderDefectsTable();
          renderDefectTrend();
        }).catch(function (err) {
          error('save defects failed', err);
          alert('Import failed: ' + (err && err.message ? err.message : err));
        });
      }).catch(function (err) {
        error('read defects failed', err);
        alert('Import failed: ' + (err && err.message ? err.message : err));
      });
    });
  }

  function start() {
    db = window.db || null;
    auth = window.auth || null;
    if (!db || !auth || typeof window.XLSX === 'undefined') { setTimeout(start, 200); return; }
    bizKey = resolveBusinessKey();
    if (!bizKey) { setTimeout(start, 300); return; }

    log('initialized', { bizKey: bizKey });
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
  }

  start();
})();
