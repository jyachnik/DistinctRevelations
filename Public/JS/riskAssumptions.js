// Public/JS/riskAssumptions.js
// Risk Register + Assumptions Log (owner-only) — two independent imports,
// each stored as its own array field on the business doc (same simple
// pattern as resourceHours.js — a small, infrequently-changing dataset,
// not a live-editable collection).

(function () {
  'use strict';

  var TAG = '[riskAssumptions]';
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
  var riskRows = [];
  var assumptionRows = [];

  function resolveBusinessKey() {
    var params = new URLSearchParams(window.location.search || '');
    return params.get('business') || (window.localStorage && window.localStorage.getItem('businessKey')) || window.BIZ_KEY || null;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // Excel serial number, Firestore Timestamp, JS Date, or a plain string
  // like "2026-03-01" — normalized to a real Date so it can be stored and
  // displayed consistently with every other date in the app, rather than
  // the raw import string.
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

  function colIndex(header, names) {
    for (var i = 0; i < header.length; i++) {
      if (names.indexOf(header[i]) !== -1) return i;
    }
    return -1;
  }

  function readRows(file) {
    return file.arrayBuffer().then(function (data) {
      var wb = XLSX.read(data, { type: 'array' });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
      if (!rows.length) throw new Error('File has no rows.');
      var header = rows[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
      return { header: header, rows: rows.slice(1) };
    });
  }

  // ---------- Risk Register ----------
  // Risk Score badge follows the standard 5x5 risk-matrix convention:
  // >=15 high (red), 8-14 medium (amber), <=7 low (green) — matches the
  // score range Probability(1-5) x Impact(1-5) actually produces.
  function riskSeverity(score) {
    if (typeof score !== 'number' || isNaN(score)) return 'unknown';
    if (score >= 15) return 'high';
    if (score >= 8) return 'medium';
    return 'low';
  }

  function renderRiskTable() {
    var card = document.getElementById('riskRegisterCard');
    var tbody = document.querySelector('#riskRegisterTable tbody');
    if (!card) return;
    card.classList.toggle('owner', isOwner);
    if (!isOwner || !tbody) return;

    if (!riskRows.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="metrics-empty">No risks imported yet.</td></tr>';
      return;
    }
    // Every captured column, in the same order as the table's <colgroup> —
    // cells ellipsis-truncate (see risk-assumptions-table-wrap CSS) with
    // the full value on the row's title tooltip, since even a
    // content-sized column can't fit a full paragraph inline.
    tbody.innerHTML = riskRows.map(function (r) {
      var sev = riskSeverity(r.score);
      var titleAttr = esc([
        r.description ? 'Description: ' + r.description : '',
        r.responseStrategy ? 'Response Strategy: ' + r.responseStrategy : '',
        r.responseActions ? 'Response Actions: ' + r.responseActions : ''
      ].filter(Boolean).join(' — '));
      return '<tr title="' + titleAttr + '">' +
        '<td>' + esc(r.id) + '</td>' +
        '<td>' + esc(r.category) + '</td>' +
        '<td class="wrap-text">' + esc(r.description) + '</td>' +
        '<td class="wrap-text">' + esc(r.impactArea) + '</td>' +
        '<td>' + (r.probability != null ? esc(r.probability) : '—') + '</td>' +
        '<td>' + (r.impact != null ? esc(r.impact) : '—') + '</td>' +
        '<td><span class="severity-badge severity-' + sev + '">' + (typeof r.score === 'number' ? r.score : '—') + '</span></td>' +
        '<td>' + esc(r.owner) + '</td>' +
        '<td>' + esc(r.responseStrategy) + '</td>' +
        '<td class="wrap-text">' + esc(r.responseActions) + '</td>' +
        '<td>' + esc(r.status) + '</td>' +
        '</tr>';
    }).join('');
  }

  function loadRiskRows() {
    return db.collection('businesses').doc(bizKey).get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      riskRows = Array.isArray(data.riskRegister) ? data.riskRegister : [];
      renderRiskTable();
    }).catch(function (err) { error('load risk register failed', err); });
  }

  function wireRiskImport() {
    var input = document.getElementById('riskImportInput');
    var btn = document.getElementById('riskImportBtn');
    if (!input || !btn) return;

    if (!isOwner) { input.style.display = 'none'; btn.style.display = 'none'; return; }
    input.style.display = '';
    btn.style.display = '';
    if (btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener('click', function () {
      if (!input.files || !input.files[0]) { alert('Choose a Risk Register export file first.'); return; }

      readRows(input.files[0]).then(function (parsed) {
        var header = parsed.header;
        var idxId = colIndex(header, ['risk id']);
        var idxCategory = colIndex(header, ['risk category']);
        var idxDescription = colIndex(header, ['risk description']);
        var idxImpactArea = colIndex(header, ['impact area']);
        var idxProbability = colIndex(header, ['probability (1-5)', 'probability(1-5)']);
        var idxImpact = colIndex(header, ['impact (1-5)', 'impact(1-5)']);
        var idxScore = colIndex(header, ['risk score']);
        var idxOwner = colIndex(header, ['risk owner']);
        var idxResponseStrategy = colIndex(header, ['response strategy']);
        var idxResponseActions = colIndex(header, ['response actions']);
        var idxStatus = colIndex(header, ['status']);
        // Optional — not in the original CSV schema, so a re-import
        // without these columns still works fine (both fall back to
        // null). Added specifically to feed the Health Scorecard's open
        // high-risk list with a dollar impact and schedule impact per
        // risk, not just the 1-5 impact score.
        var idxImpactDollars = colIndex(header, ['impact ($)', 'impact ($', 'dollar impact', '$ impact']);
        var idxTimeLostDays = colIndex(header, ['schedule impact (days)', 'time lost (days)', 'time lost']);

        if (idxId === -1 || idxDescription === -1) {
          alert('Risk Register file must have Risk ID and Risk Description columns.');
          return;
        }

        log('column mapping', { id: header[idxId], description: header[idxDescription], score: idxScore >= 0 ? header[idxScore] : '(not found)' });

        var out = [];
        parsed.rows.forEach(function (row) {
          var id = row[idxId] != null ? String(row[idxId]).trim() : '';
          if (!id) return;
          var scoreVal = idxScore >= 0 ? parseFloat(row[idxScore]) : NaN;
          out.push({
            id: id,
            category: idxCategory >= 0 && row[idxCategory] != null ? String(row[idxCategory]).trim() : '',
            description: idxDescription >= 0 && row[idxDescription] != null ? String(row[idxDescription]).trim() : '',
            impactArea: idxImpactArea >= 0 && row[idxImpactArea] != null ? String(row[idxImpactArea]).trim() : '',
            probability: idxProbability >= 0 ? parseFloat(row[idxProbability]) : null,
            impact: idxImpact >= 0 ? parseFloat(row[idxImpact]) : null,
            score: isNaN(scoreVal) ? null : scoreVal,
            owner: idxOwner >= 0 && row[idxOwner] != null ? String(row[idxOwner]).trim() : '',
            responseStrategy: idxResponseStrategy >= 0 && row[idxResponseStrategy] != null ? String(row[idxResponseStrategy]).trim() : '',
            responseActions: idxResponseActions >= 0 && row[idxResponseActions] != null ? String(row[idxResponseActions]).trim() : '',
            status: idxStatus >= 0 && row[idxStatus] != null ? String(row[idxStatus]).trim() : '',
            impactDollars: (function () {
              if (idxImpactDollars < 0 || row[idxImpactDollars] == null) return null;
              var n = parseFloat(String(row[idxImpactDollars]).replace(/[^0-9.-]/g, ''));
              return isNaN(n) ? null : n;
            })(),
            timeLostDays: (function () {
              if (idxTimeLostDays < 0 || row[idxTimeLostDays] == null) return null;
              var n = parseFloat(row[idxTimeLostDays]);
              return isNaN(n) ? null : n;
            })()
          });
        });

        if (!out.length) { alert('No valid risk rows found — each row needs a Risk ID.'); return; }

        db.collection('businesses').doc(bizKey).set({ riskRegister: out }, { merge: true }).then(function () {
          alert('Risk Register imported: ' + out.length + ' risks.');
          input.value = '';
          riskRows = out;
          renderRiskTable();
        }).catch(function (err) {
          error('save risk register failed', err);
          alert('Import failed: ' + (err && err.message ? err.message : err));
        });
      }).catch(function (err) {
        error('read risk register failed', err);
        alert('Import failed: ' + (err && err.message ? err.message : err));
      });
    });
  }

  // ---------- Assumptions Log ----------
  // Blank Impact/Probability cells (common in this file's later rows,
  // e.g. A-055+) render as "unknown" via levelBadge() below, rather than
  // a false low.
  var LEVEL_RANK = { h: 3, m: 2, l: 1 };

  // A single H/M/L value gets its own small badge — kept separate from
  // assumptionSeverity() (which combines both into one worst-case read)
  // so the raw Impact and Probability columns can each show their own
  // real value, per "all columns if possible" rather than one merged one.
  function levelBadge(value) {
    var rank = LEVEL_RANK[(value || '').trim().toLowerCase()];
    var cls = rank === 3 ? 'high' : rank === 2 ? 'medium' : rank === 1 ? 'low' : 'unknown';
    return '<span class="severity-badge severity-' + cls + '">' + (value ? esc(value) : '—') + '</span>';
  }

  function renderAssumptionsTable() {
    var card = document.getElementById('assumptionsLogCard');
    var tbody = document.querySelector('#assumptionsLogTable tbody');
    if (!card) return;
    card.classList.toggle('owner', isOwner);
    if (!isOwner || !tbody) return;

    if (!assumptionRows.length) {
      tbody.innerHTML = '<tr><td colspan="14" class="metrics-empty">No assumptions imported yet.</td></tr>';
      return;
    }
    // Every captured column, in the same order as the table's <colgroup>.
    tbody.innerHTML = assumptionRows.map(function (a) {
      var titleAttr = esc([
        a.rationale ? 'Rationale: ' + a.rationale : '',
        a.potentialImpact ? 'If false: ' + a.potentialImpact : '',
        a.validationMethod ? 'Validation: ' + a.validationMethod : '',
        a.actualOutcome ? 'Outcome: ' + a.actualOutcome : '',
        a.notes ? 'Notes: ' + a.notes : ''
      ].filter(Boolean).join(' — '));
      return '<tr title="' + titleAttr + '">' +
        '<td>' + esc(a.id) + '</td>' +
        '<td>' + esc(fmtDate(a.dateLogged)) + '</td>' +
        '<td>' + esc(a.category) + '</td>' +
        '<td class="wrap-text">' + esc(a.statement) + '</td>' +
        '<td class="wrap-text">' + esc(a.rationale) + '</td>' +
        '<td class="wrap-text">' + esc(a.potentialImpact) + '</td>' +
        '<td>' + levelBadge(a.impact) + '</td>' +
        '<td>' + levelBadge(a.probability) + '</td>' +
        '<td>' + esc(a.owner) + '</td>' +
        '<td>' + esc(a.status) + '</td>' +
        '<td class="wrap-text">' + esc(a.validationMethod) + '</td>' +
        '<td>' + esc(fmtDate(a.targetValidationDate)) + '</td>' +
        '<td class="wrap-text">' + esc(a.actualOutcome) + '</td>' +
        '<td class="wrap-text">' + esc(a.notes) + '</td>' +
        '</tr>';
    }).join('');
  }

  function loadAssumptionRows() {
    return db.collection('businesses').doc(bizKey).get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      assumptionRows = Array.isArray(data.assumptionsLog) ? data.assumptionsLog : [];
      renderAssumptionsTable();
    }).catch(function (err) { error('load assumptions log failed', err); });
  }

  function wireAssumptionsImport() {
    var input = document.getElementById('assumptionsImportInput');
    var btn = document.getElementById('assumptionsImportBtn');
    if (!input || !btn) return;

    if (!isOwner) { input.style.display = 'none'; btn.style.display = 'none'; return; }
    input.style.display = '';
    btn.style.display = '';
    if (btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener('click', function () {
      if (!input.files || !input.files[0]) { alert('Choose an Assumptions Log export file first.'); return; }

      readRows(input.files[0]).then(function (parsed) {
        var header = parsed.header;
        var idxId = colIndex(header, ['id']);
        var idxDateLogged = colIndex(header, ['date logged']);
        var idxCategory = colIndex(header, ['category']);
        var idxStatement = colIndex(header, ['assumption statement']);
        var idxRationale = colIndex(header, ['rationale / source', 'rationale/source']);
        var idxPotentialImpact = colIndex(header, ['potential impact if false']);
        var idxImpact = colIndex(header, ['impact (h/m/l)', 'impact(h/m/l)']);
        var idxProbability = colIndex(header, ['probability (h/m/l)', 'probability(h/m/l)']);
        var idxOwner = colIndex(header, ['owner']);
        var idxStatus = colIndex(header, ['status']);
        var idxValidationMethod = colIndex(header, ['validation method']);
        var idxTargetDate = colIndex(header, ['target validation date']);
        var idxActualOutcome = colIndex(header, ['actual outcome / decision', 'actual outcome/decision']);
        var idxNotes = colIndex(header, ['notes / next steps', 'notes/next steps']);

        if (idxId === -1 || idxStatement === -1) {
          alert('Assumptions Log file must have ID and Assumption Statement columns.');
          return;
        }

        log('column mapping', { id: header[idxId], statement: header[idxStatement] });

        var out = [];
        parsed.rows.forEach(function (row) {
          var id = row[idxId] != null ? String(row[idxId]).trim() : '';
          if (!id) return;
          out.push({
            id: id,
            dateLogged: idxDateLogged >= 0 ? toJsDate(row[idxDateLogged]) : null,
            category: idxCategory >= 0 && row[idxCategory] != null ? String(row[idxCategory]).trim() : '',
            statement: idxStatement >= 0 && row[idxStatement] != null ? String(row[idxStatement]).trim() : '',
            rationale: idxRationale >= 0 && row[idxRationale] != null ? String(row[idxRationale]).trim() : '',
            potentialImpact: idxPotentialImpact >= 0 && row[idxPotentialImpact] != null ? String(row[idxPotentialImpact]).trim() : '',
            impact: idxImpact >= 0 && row[idxImpact] != null ? String(row[idxImpact]).trim() : '',
            probability: idxProbability >= 0 && row[idxProbability] != null ? String(row[idxProbability]).trim() : '',
            owner: idxOwner >= 0 && row[idxOwner] != null ? String(row[idxOwner]).trim() : '',
            status: idxStatus >= 0 && row[idxStatus] != null ? String(row[idxStatus]).trim() : '',
            validationMethod: idxValidationMethod >= 0 && row[idxValidationMethod] != null ? String(row[idxValidationMethod]).trim() : '',
            targetValidationDate: idxTargetDate >= 0 ? toJsDate(row[idxTargetDate]) : null,
            actualOutcome: idxActualOutcome >= 0 && row[idxActualOutcome] != null ? String(row[idxActualOutcome]).trim() : '',
            notes: idxNotes >= 0 && row[idxNotes] != null ? String(row[idxNotes]).trim() : ''
          });
        });

        if (!out.length) { alert('No valid assumption rows found — each row needs an ID.'); return; }

        db.collection('businesses').doc(bizKey).set({ assumptionsLog: out }, { merge: true }).then(function () {
          alert('Assumptions Log imported: ' + out.length + ' assumptions.');
          input.value = '';
          assumptionRows = out;
          renderAssumptionsTable();
        }).catch(function (err) {
          error('save assumptions log failed', err);
          alert('Import failed: ' + (err && err.message ? err.message : err));
        });
      }).catch(function (err) {
        error('read assumptions log failed', err);
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
    wireRiskImport();
    wireAssumptionsImport();

    auth.onAuthStateChanged(function (user) {
      var email = (user && user.email) || '';
      isOwner = !!email && !!OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
      wireRiskImport();
      wireAssumptionsImport();
      loadRiskRows();
      loadAssumptionRows();
    });
  }

  start();
})();
