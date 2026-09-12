// Public/JS/resourceHours.js
// Resource Hours (owner-only): Budgeted vs Actual vs Remaining work hours
// per resource, plus average FTE, and a time-phased trend chart that
// follows the dashboard's global time frame control.
//
// Imported from MS Project's Visual Reports -> Resource Usage -> "Resource
// Work Summary Report", with the pivot's "Weekly Calendar" field moved
// from Filters into Rows (so it's broken out by period, not collapsed to
// "All"). That report's own default layout only drills Q1 down to
// individual weeks and leaves Q2/Q3/Q4 as quarter-level totals — this
// parser handles both granularities in the same file, plus the trailing
// grand-total block MS Project appends as the last 4 columns.
//
// FTE = Work hours for a period / that period's own standard hours (40
// per week; 40*13 for a quarter-total block) — a normalized utilization
// ratio, not a separate field pulled from Project (Visual Reports custom
// fields proved unreliable; this derives the same insight from Work,
// which Project does export correctly).

(function () {
  'use strict';

  var TAG = '[resourceHours]';
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
  var resourceRows = [];       // summary: one row per resource (budgeted/actual/remaining/FTE totals)
  var resourceWeeklyRows = []; // time-phased: one row per resource per period (week or quarter)
  var trendChartInstance = null;

  // Same global time frame control burndown.js's charts use, tracked
  // locally since this is a separate script with no shared module (same
  // pattern as qualityDefects.js).
  var currentTimeframeUnit = '3month';

  var STANDARD_WEEKLY_HOURS = 40;

  // ASSUMPTION, stated so it's easy to correct: "Week 1" in the MS
  // Project export is the calendar week starting Monday Jan 5, 2026 —
  // matching this project's own earliest scheduled date and the Gantt's
  // own Monday-aligned week grid. If your export's Week 1 starts on a
  // different date, this needs to change.
  var WEEK1_START = new Date(2026, 0, 5);

  function resolveBusinessKey() {
    var params = new URLSearchParams(window.location.search || '');
    return params.get('business') || (window.localStorage && window.localStorage.getItem('businessKey')) || window.BIZ_KEY || null;
  }

  function fmtHours(v) {
    if (typeof v !== 'number' || isNaN(v)) return '—';
    return v.toFixed(1) + 'h';
  }
  function fmtPct(v) {
    if (typeof v !== 'number' || isNaN(v)) return '—';
    return Math.round(v * 100) + '%';
  }
  function fmtFte(v) {
    if (typeof v !== 'number' || isNaN(v)) return '—';
    return v.toFixed(2);
  }
  function fmtISO(d) {
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }
  function fmtShort(d) {
    return window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString();
  }

  // The end of the forward-looking window the global time frame control
  // represents, measured from today — same convention as burndown.js's
  // windowEndDate(). null ("Total Project") means no filtering.
  function windowEndDate(unit, today) {
    if (unit === 'week') return new Date(today.getTime() + 7 * 86400000);
    if (unit === 'month') return new Date(today.getFullYear(), today.getMonth() + 1, today.getDate());
    if (unit === '3month') return new Date(today.getFullYear(), today.getMonth() + 3, today.getDate());
    if (unit === '6month') return new Date(today.getFullYear(), today.getMonth() + 6, today.getDate());
    if (unit === 'year') return new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());
    return null;
  }

  // ---------- Table (summary: one row per resource) ----------
  function renderTable() {
    var card = document.getElementById('resourceHoursCard');
    var tbody = document.querySelector('#resourceHoursTable tbody');
    if (!card) return;
    card.classList.toggle('owner', isOwner);
    if (!isOwner || !tbody) return;

    if (!resourceRows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="metrics-empty">No resource hours imported yet.</td></tr>';
      return;
    }

    tbody.innerHTML = resourceRows.map(function (r) {
      return '<tr>' +
        '<td>' + (r.name || 'Unnamed') + '</td>' +
        '<td>' + fmtHours(r.budgetedHours) + '</td>' +
        '<td>' + fmtHours(r.actualHours) + '</td>' +
        '<td>' + fmtHours(r.remainingHours) + '</td>' +
        '<td>' + fmtPct(r.percentComplete) + '</td>' +
        '<td>' + fmtFte(r.avgFte) + '</td>' +
        '</tr>';
    }).join('');
  }

  // ---------- Trend chart (aggregate across all resources, per period) ----------
  // Total Work vs Total Actual Work (hours) plus overall FTE utilization
  // (Work / Work Availability) over time — filtered to periods within the
  // selected global time frame window, same "forward window from today"
  // convention as Status Snapshot / Milestone Trend, since this is
  // discrete pre-existing period data (weeks/quarters from the import),
  // not something that can be re-bucketed arbitrarily.
  function computeTrend(windowEnd) {
    var byPeriod = {};
    resourceWeeklyRows.forEach(function (r) {
      if (!r.periodStart) return;
      var periodDate = new Date(r.periodStart + 'T00:00:00');
      if (windowEnd && periodDate > windowEnd) return;
      var key = r.periodStart;
      if (!byPeriod[key]) byPeriod[key] = { date: periodDate, label: r.periodLabel, work: 0, actualWork: 0, workAvailability: 0 };
      byPeriod[key].work += r.work;
      byPeriod[key].actualWork += r.actualWork;
      byPeriod[key].workAvailability += r.workAvailability;
    });

    var periods = Object.keys(byPeriod).map(function (k) { return byPeriod[k]; });
    periods.sort(function (a, b) { return a.date - b.date; });
    if (!periods.length) return null;

    return {
      labels: periods.map(function (p) { return p.label; }),
      work: periods.map(function (p) { return p.work; }),
      actualWork: periods.map(function (p) { return p.actualWork; }),
      utilizationPct: periods.map(function (p) { return p.workAvailability > 0 ? Math.round((p.work / p.workAvailability) * 100) : null; })
    };
  }

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

  function renderTrendChart() {
    var card = document.getElementById('resourceHoursCard');
    var canvas = document.getElementById('resourceHoursTrendChart');
    if (!card || !canvas || typeof window.Chart === 'undefined') return;
    if (!isOwner) return;

    var today = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    var windowEnd = windowEndDate(currentTimeframeUnit, today);
    var trend = computeTrend(windowEnd);
    if (!trend) {
      setChartEmptyLocal(canvas, resourceWeeklyRows.length ? 'Nothing in the selected time frame.' : 'No time-phased resource hours imported yet.');
      return;
    }
    clearChartEmptyLocal(canvas);

    if (trendChartInstance) { trendChartInstance.destroy(); }
    trendChartInstance = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: trend.labels,
        datasets: [
          { label: 'Scheduled Work (hrs)', data: trend.work, borderColor: '#2a78d6', backgroundColor: '#2a78d6', pointRadius: 2, borderWidth: 2, tension: 0.1, yAxisID: 'hours' },
          { label: 'Actual Work (hrs)', data: trend.actualWork, borderColor: '#2f9e44', backgroundColor: '#2f9e44', pointRadius: 2, borderWidth: 2, tension: 0.1, yAxisID: 'hours' },
          { label: 'Utilization (% of capacity)', data: trend.utilizationPct, borderColor: '#eb6834', backgroundColor: '#eb6834', pointRadius: 2, borderWidth: 2, borderDash: [4, 3], tension: 0.1, yAxisID: 'pct' }
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
          hours: { position: 'left', beginAtZero: true, title: { display: true, text: 'hours', font: { size: 11 } }, grid: { color: '#e0e0e0' } },
          pct: { position: 'right', beginAtZero: true, max: 150, title: { display: true, text: 'utilization %', font: { size: 11 } }, grid: { display: false } }
        }
      }
    });
  }

  function loadResourceRows() {
    return db.collection('businesses').doc(bizKey).get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      resourceRows = Array.isArray(data.resourceHours) ? data.resourceHours : [];
      resourceWeeklyRows = Array.isArray(data.resourceHoursWeekly) ? data.resourceHoursWeekly : [];
      renderTable();
      renderTrendChart();
    }).catch(function (err) { error('load failed', err); });
  }

  // ---------- Import: wide pivot CSV from MS Project's Visual Report ----------
  // Every "Work Availability" cell in the sub-header row marks the start
  // of a new 4-column block (Work Availability, Work, Remaining
  // Availability, Actual Work) — found by scanning rather than hardcoded
  // column indices, so it's not brittle to exact spacing/trailing blanks
  // in the export.
  function parseResourcePivot(rows) {
    var yearRow = rows[3] || [];
    var quarterRow = rows[4] || [];
    var weekRow = rows[5] || [];
    var subHeaderRow = rows[6] || [];

    var sheetYear = parseInt(yearRow[2], 10) || new Date().getFullYear();

    var blockCols = [];
    for (var j = 0; j < subHeaderRow.length; j++) {
      if (String(subHeaderRow[j] || '').trim().toLowerCase() === 'work availability') blockCols.push(j);
    }
    // The trailing Grand Total block has BLANK sub-header cells of its
    // own — its labels ("Total Work Availability", "Total Work", ...)
    // live in the year row instead, so the scan above misses it; found
    // separately here and appended as its own block.
    var totalCol = -1;
    for (var k = 0; k < yearRow.length; k++) {
      if (String(yearRow[k] || '').trim().toLowerCase() === 'total work availability') { totalCol = k; break; }
    }
    if (totalCol >= 0 && blockCols.indexOf(totalCol) === -1) blockCols.push(totalCol);
    if (!blockCols.length) return null;

    var periods = blockCols.map(function (col) {
      var weekLabel = String(weekRow[col] || '').trim();
      var quarterLabel = String(quarterRow[col] || '').trim();

      if (/^Week\s*\d+/i.test(weekLabel)) {
        var weekNum = parseInt(weekLabel.replace(/[^0-9]/g, ''), 10);
        var start = new Date(WEEK1_START.getTime() + (weekNum - 1) * 7 * 86400000);
        return { col: col, unit: 'week', label: weekLabel + ' (' + fmtShort(start) + ')', start: start, standardHours: STANDARD_WEEKLY_HOURS };
      }
      // Q1's own header column is already covered week-by-week above, so
      // only later quarters (Q2/Q3/Q4, left as quarter-level totals in
      // the default report layout) are treated as their own periods.
      if (/^Q\d/i.test(quarterLabel) && quarterLabel !== 'Q1') {
        var qNum = parseInt(quarterLabel.replace(/[^0-9]/g, ''), 10);
        var qStart = new Date(sheetYear, (qNum - 1) * 3, 1);
        return { col: col, unit: 'quarter', label: quarterLabel + ' ' + sheetYear, start: qStart, standardHours: STANDARD_WEEKLY_HOURS * 13 };
      }
      if (col === totalCol) return { col: col, unit: 'total', label: 'Total', start: null, standardHours: null };
      return null;
    }).filter(Boolean);

    var weeklyRows = [];
    var summaryByName = {};
    var fteAccumByName = {}; // { totalWork, totalStandardHours }

    for (var r = 7; r < rows.length; r++) {
      var row = rows[r] || [];
      var typeCell = String(row[0] || '').trim();
      var name = row[1] != null ? String(row[1]).trim() : '';
      if (!name || name === 'Unassigned') continue;
      if (/^work total$/i.test(typeCell) || /^grand total$/i.test(typeCell)) continue;

      periods.forEach(function (p) {
        var workAvailability = parseFloat(row[p.col]) || 0;
        var work = parseFloat(row[p.col + 1]) || 0;
        var remainingAvailability = parseFloat(row[p.col + 2]) || 0;
        var actualWork = parseFloat(row[p.col + 3]) || 0;

        if (p.unit === 'total') {
          var fteAccum = fteAccumByName[name] || { totalWork: 0, totalStandardHours: 0 };
          summaryByName[name] = {
            name: name,
            budgetedHours: work,
            actualHours: actualWork,
            remainingHours: remainingAvailability,
            percentComplete: work > 0 ? actualWork / work : null,
            avgFte: fteAccum.totalStandardHours > 0 ? fteAccum.totalWork / fteAccum.totalStandardHours : null
          };
          return;
        }

        if (!fteAccumByName[name]) fteAccumByName[name] = { totalWork: 0, totalStandardHours: 0 };
        fteAccumByName[name].totalWork += work;
        fteAccumByName[name].totalStandardHours += p.standardHours;

        weeklyRows.push({
          resource: name,
          unit: p.unit,
          periodStart: fmtISO(p.start),
          periodLabel: p.label,
          workAvailability: workAvailability,
          work: work,
          remainingAvailability: remainingAvailability,
          actualWork: actualWork
        });
      });
    }

    return {
      weeklyRows: weeklyRows,
      summaryRows: Object.keys(summaryByName).map(function (k) { return summaryByName[k]; })
    };
  }

  function wireImport() {
    var input = document.getElementById('resourceImportInput');
    var btn = document.getElementById('resourceImportBtn');
    if (!input || !btn) return;

    // These controls now live in the shared "Data Imports" panel, not
    // inside the owner-gated Resource Hours card, so they have to hide
    // themselves for non-owners directly (same pattern as gantt.js's
    // import/dedup buttons).
    if (!isOwner) { input.style.display = 'none'; btn.style.display = 'none'; return; }
    input.style.display = '';
    btn.style.display = '';
    if (btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener('click', function () {
      if (!input.files || !input.files[0]) { alert('Choose the Resource Work Summary export file first.'); return; }
      var file = input.files[0];

      file.arrayBuffer().then(function (data) {
        var wb = XLSX.read(data, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (!rows.length) { alert('File has no rows.'); return; }

        var parsed = parseResourcePivot(rows);
        if (!parsed || !parsed.weeklyRows.length) {
          alert('Could not find the expected "Work Availability / Work / Remaining Availability / Actual Work" column blocks. Make sure this is the Resource Work Summary Visual Report with Weekly Calendar broken out to Rows (not left in Filters).');
          return;
        }

        log('parsed', { resources: parsed.summaryRows.length, periodRows: parsed.weeklyRows.length });

        db.collection('businesses').doc(bizKey).set({
          resourceHours: parsed.summaryRows,
          resourceHoursWeekly: parsed.weeklyRows
        }, { merge: true }).then(function () {
          alert('Resource hours imported: ' + parsed.summaryRows.length + ' resources, ' + parsed.weeklyRows.length + ' period rows.');
          input.value = '';
          resourceRows = parsed.summaryRows;
          resourceWeeklyRows = parsed.weeklyRows;
          renderTable();
          renderTrendChart();
        }).catch(function (err) {
          error('save failed', err);
          alert('Import failed: ' + (err && err.message ? err.message : err));
        });
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
    // no shared module.
    window.addEventListener('dr-timeframe-changed', function (e) {
      currentTimeframeUnit = (e.detail && e.detail.unit) || currentTimeframeUnit;
      renderTrendChart();
    });

    auth.onAuthStateChanged(function (user) {
      var email = (user && user.email) || '';
      isOwner = !!email && !!OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
      wireImport();
      loadResourceRows();
    });
  }

  start();
})();
