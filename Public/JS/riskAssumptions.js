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
  var projKey = null;
  var isOwner = false;
  var riskRows = [];
  var assumptionRows = [];
  var riskExposureSnapshots = [];
  var riskExposureChartInstance = null;

  function resolveBusinessKey() {
    var params = new URLSearchParams(window.location.search || '');
    return params.get('business') || (window.localStorage && window.localStorage.getItem('businessKey')) || window.BIZ_KEY || null;
  }

  // Multi-project cutover — riskRegister/assumptionsLog (and their sibling
  // riskExposureSnapshots/*LastImportedAt fields) now live on the project
  // doc, not the business doc.
  function projRef() {
    return db.collection('businesses').doc(bizKey)
      .collection('projects').doc(projKey || 'default');
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
    // A CSV export of a date-formatted cell often comes through as a bare
    // numeric STRING (the Excel serial date number as text, e.g. "46102"
    // for 2026-03-01) rather than a real JS number. Passed straight to
    // `new Date(...)` below, a short digit string like that gets silently
    // misread by JS as a literal YEAR instead of a serial day count —
    // `new Date("2082")` really does parse to 2082-01-01 — which is
    // exactly how a legitimate 2026 date ended up displaying as 2082.
    // Treating any bare digit string as an Excel serial first (same as a
    // real number already was) avoids that trap.
    var numericValue = typeof v === 'number' ? v : (/^[0-9]+(\.[0-9]+)?$/.test(String(v).trim()) ? parseFloat(v) : null);
    if (numericValue != null && window.XLSX && XLSX.SSF) {
      var parsed = XLSX.SSF.parse_date_code(numericValue);
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

  // ---------- Sort / Filter / Pagination state ----------
  var riskSort = { key: null, dir: 'asc' };
  // Multi-select — each value is an array of chosen strings; an empty
  // array means "no filter on this column" (see dr-multiselect.js).
  var riskFilters = { id: [], category: [], impactArea: [], probability: [], impact: [], score: [], responseStrategy: [], status: [], contributingToSpi: [], contributingToCpi: [] };
  var riskPage = 1;
  var RISK_PAGE_SIZE = 15;

  function populateRiskFilters() {
    var fields = [
      { key: 'id', id: 'riskFilterId', allLabel: 'All IDs' },
      { key: 'category', id: 'riskFilterCategory', allLabel: 'All Categories' },
      { key: 'impactArea', id: 'riskFilterImpactArea', allLabel: 'All Impact Areas' },
      { key: 'probability', id: 'riskFilterProbability', allLabel: 'All Probability' },
      { key: 'impact', id: 'riskFilterImpact', allLabel: 'All Impact' },
      { key: 'score', id: 'riskFilterScore', allLabel: 'All Scores' },
      { key: 'responseStrategy', id: 'riskFilterResponseStrategy', allLabel: 'All Response Strategies' },
      { key: 'status', id: 'riskFilterStatus', allLabel: 'All Status' }
    ];
    fields.forEach(function (f) {
      var sel = document.getElementById(f.id);
      if (!sel) return;
      var current = sel.value;
      var values = Array.from(
        riskRows.reduce(function (set, r) {
          var v = r[f.key];
          if (v != null && String(v).trim() !== '') set.add(String(v).trim());
          return set;
        }, new Set())
      ).sort(function (a, b) {
        var an = parseFloat(a), bn = parseFloat(b);
        if (!isNaN(an) && !isNaN(bn)) return an - bn;
        return a.localeCompare(b);
      });

      sel.innerHTML = '<option value="">' + f.allLabel + '</option>' +
        values.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
      if (values.indexOf(current) !== -1) sel.value = current;
    });
    // Contributing to SPI is a fixed Yes/No/All list (see HTML), not
    // derived from data — nothing to populate here, just preserved as-is.
  }

  // Empty array = no filter on that column; otherwise the row's value
  // must match ANY of the selected values (OR within a column).
  function matchesMulti(selected, value) {
    return !selected.length || selected.indexOf(value) !== -1;
  }

  function getFilteredSortedRisks() {
    var rows = riskRows.filter(function (r) {
      var spiValue = r.contributingToSpi ? 'yes' : 'no';
      var cpiValue = r.contributingToCpi ? 'yes' : 'no';
      return matchesMulti(riskFilters.id, r.id) &&
        matchesMulti(riskFilters.category, r.category) &&
        matchesMulti(riskFilters.impactArea, r.impactArea) &&
        matchesMulti(riskFilters.probability, String(r.probability)) &&
        matchesMulti(riskFilters.impact, String(r.impact)) &&
        matchesMulti(riskFilters.score, String(r.score)) &&
        matchesMulti(riskFilters.responseStrategy, r.responseStrategy) &&
        matchesMulti(riskFilters.status, r.status) &&
        matchesMulti(riskFilters.contributingToSpi, spiValue) &&
        matchesMulti(riskFilters.contributingToCpi, cpiValue);
    });

    if (riskSort.key) {
      var key = riskSort.key;
      var dir = riskSort.dir === 'desc' ? -1 : 1;
      rows = rows.slice().sort(function (a, b) {
        var av = a[key], bv = b[key];
        if (key === 'contributingToSpi') { av = av ? 1 : 0; bv = bv ? 1 : 0; }
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
    return rows;
  }

  function wireRiskControls() {
    var thead = document.querySelector('#riskRegisterTable thead');
    if (thead && !thead.__sortWired) {
      thead.__sortWired = true;
      thead.addEventListener('click', function (e) {
        var th = e.target.closest('th[data-sort]');
        if (!th) return;
        var key = th.getAttribute('data-sort');
        if (riskSort.key === key) {
          riskSort.dir = riskSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          riskSort.key = key;
          riskSort.dir = 'asc';
        }
        riskPage = 1;
        renderRiskTable();
      });
    }

    ['Id', 'Category', 'ImpactArea', 'Probability', 'Impact', 'Score', 'ResponseStrategy', 'Status', 'ContributingToSpi', 'ContributingToCpi'].forEach(function (idPart) {
      var sel = document.getElementById('riskFilter' + idPart);
      var stateKey = idPart.charAt(0).toLowerCase() + idPart.slice(1);
      if (sel && window.drCreateMultiSelectFilter) {
        window.drCreateMultiSelectFilter(sel, function (values) {
          riskFilters[stateKey] = values;
          riskPage = 1;
          renderRiskTable();
        });
      }
    });

    var prevBtn = document.getElementById('riskPagePrev');
    var nextBtn = document.getElementById('riskPageNext');
    if (prevBtn && !prevBtn.__wired) {
      prevBtn.__wired = true;
      prevBtn.addEventListener('click', function () {
        if (riskPage > 1) { riskPage--; renderRiskTable(); }
      });
    }
    if (nextBtn && !nextBtn.__wired) {
      nextBtn.__wired = true;
      nextBtn.addEventListener('click', function () {
        riskPage++;
        renderRiskTable();
      });
    }

    var resetBtn = document.getElementById('riskFilterReset');
    if (resetBtn && !resetBtn.__wired) {
      resetBtn.__wired = true;
      resetBtn.addEventListener('click', function () {
        riskFilters = { id: [], category: [], impactArea: [], probability: [], impact: [], score: [], responseStrategy: [], status: [], contributingToSpi: [], contributingToCpi: [] };
        ['Id', 'Category', 'ImpactArea', 'Probability', 'Impact', 'Score', 'ResponseStrategy', 'Status', 'ContributingToSpi', 'ContributingToCpi'].forEach(function (idPart) {
          var sel = document.getElementById('riskFilter' + idPart);
          if (sel && sel.__drMultiSelect) sel.__drMultiSelect.clear();
        });
        riskPage = 1;
        renderRiskTable();
      });
    }
  }

  function renderRiskTable() {
    var card = document.getElementById('riskRegisterCard');
    var tbody = document.querySelector('#riskRegisterTable tbody');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('riskRegisterCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;
    wireRiskSpiCheckboxes();
    wireRiskResponseInitiated();
    wireRiskControls();

    if (!riskRows.length) {
      tbody.innerHTML = '<tr><td colspan="14" class="metrics-empty">No risks imported yet.</td></tr>';
      var pageInfoEmpty = document.getElementById('riskPageInfo');
      if (pageInfoEmpty) pageInfoEmpty.textContent = '';
      if (window.drInsight) window.drInsight.set('riskRegisterCard', '');
      return;
    }

    populateRiskFilters();

    var filtered = getFilteredSortedRisks();
    var totalPages = Math.max(1, Math.ceil(filtered.length / RISK_PAGE_SIZE));
    if (riskPage > totalPages) riskPage = totalPages;
    if (riskPage < 1) riskPage = 1;
    var startIdx = (riskPage - 1) * RISK_PAGE_SIZE;
    var pageRows = filtered.slice(startIdx, startIdx + RISK_PAGE_SIZE);

    document.querySelectorAll('#riskRegisterTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === riskSort.key) th.classList.add(riskSort.dir);
    });

    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="14" class="metrics-empty">No risks match the selected filters.</td></tr>';
    } else {
      // Every captured column, in the same order as the table's <colgroup> —
      // cells ellipsis-truncate (see risk-assumptions-table-wrap CSS) with
      // the full value on the row's title tooltip, since even a
      // content-sized column can't fit a full paragraph inline.
      tbody.innerHTML = pageRows.map(function (r) {
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
          '<td style="text-align:center;">' +
            '<input type="date" class="risk-response-initiated-input" data-risk-id="' + esc(r.id) + '" value="' + esc(r.responseInitiated || '') + '"' + (isOwner ? '' : ' disabled') + ' />' +
          '</td>' +
          '<td class="wrap-text" style="text-align:center;">' +
            '<input type="checkbox" class="risk-spi-checkbox" data-risk-id="' + esc(r.id) + '"' + (r.contributingToSpi ? ' checked' : '') + (isOwner ? '' : ' disabled') + ' />' +
          '</td>' +
          '<td class="wrap-text" style="text-align:center;">' +
            '<input type="checkbox" class="risk-cpi-checkbox" data-risk-id="' + esc(r.id) + '"' + (r.contributingToCpi ? ' checked' : '') + (isOwner ? '' : ' disabled') + ' />' +
          '</td>' +
          '</tr>';
      }).join('');
    }

    var pageInfo = document.getElementById('riskPageInfo');
    if (pageInfo) pageInfo.textContent = 'Page ' + riskPage + ' of ' + totalPages + ' (' + filtered.length + (filtered.length === 1 ? ' row' : ' rows') + ')';
    var prevBtnEl = document.getElementById('riskPagePrev');
    var nextBtnEl = document.getElementById('riskPageNext');
    if (prevBtnEl) prevBtnEl.disabled = riskPage <= 1;
    if (nextBtnEl) nextBtnEl.disabled = riskPage >= totalPages;

    if (window.drRefs) {
      riskRows.forEach(function (r) {
        window.drRefs.register(r.id, {
          cardId: 'riskRegisterCard', cardLabel: 'Risk Register',
          summary: r.description,
          fields: [{ label: 'Score', value: r.score }, { label: 'Status', value: r.status }, { label: 'Owner', value: r.owner }]
        });
      });
    }

    if (window.drInsight) {
      var highRisks = riskRows.filter(function (r) { return riskSeverity(r.score) === 'high'; });
      var openHigh = highRisks.filter(function (r) { return (r.status || '').toLowerCase() !== 'closed'; });
      var topRisk = openHigh.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); })[0];
      var text = riskRows.length + ' risk' + (riskRows.length === 1 ? '' : 's') + ' tracked, ' +
        openHigh.length + ' open at high severity.';
      if (topRisk) {
        text += ' Top concern: ' + topRisk.id + ' — "' + (topRisk.description || topRisk.id) + '" (score ' + topRisk.score + ')' +
          (topRisk.responseStrategy ? ', mitigation strategy: ' + topRisk.responseStrategy + '.' : '.');
      } else if (openHigh.length === 0 && riskRows.length > 0) {
        text += ' No high-severity risks currently open.';
      }
      window.drInsight.set('riskRegisterCard', text);
    }
  }

  // Owner-only manual override, PERSISTED per risk — "I believe this risk
  // is contributing to the schedule being unfavorable" even when its
  // Impact Area field alone wouldn't flag it that way. Firestore has no
  // partial-array-element update, so this rewrites the whole riskRegister
  // array with just that one risk's flag toggled.
  // Handles BOTH "Contributing to SPI" and "Contributing to CPI" checkboxes
  // — same owner-only, rewrite-the-whole-array pattern for each, just a
  // different field name depending on which checkbox was toggled.
  function wireRiskSpiCheckboxes() {
    var tbody = document.querySelector('#riskRegisterTable tbody');
    if (!tbody || tbody.__spiWired) return;
    tbody.__spiWired = true;

    tbody.addEventListener('change', function (e) {
      var cb = e.target.closest('.risk-spi-checkbox, .risk-cpi-checkbox');
      if (!cb || !isOwner) return;
      var field = cb.classList.contains('risk-cpi-checkbox') ? 'contributingToCpi' : 'contributingToSpi';
      var riskId = cb.getAttribute('data-risk-id');
      var checked = cb.checked;

      var updated = riskRows.map(function (r) {
        if (r.id !== riskId) return r;
        var patch = {};
        patch[field] = checked;
        return Object.assign({}, r, patch);
      });
      riskRows = updated;

      projRef().set({ riskRegister: updated }, { merge: true }).then(function () {
        // Only actually needed when a "Contributing to SPI/CPI" filter or
        // a sort on that column is active — otherwise a no-op re-render —
        // but re-rendering unconditionally is simplest and keeps the
        // filtered/sorted view correct the moment the flag changes,
        // rather than only after the next full page load.
        renderRiskTable();
      }).catch(function (err) {
        error('save ' + field + ' flag failed', err);
        alert('Could not save — please try again: ' + (err && err.message ? err.message : err));
        cb.checked = !checked; // revert the checkbox on failure
      });
    });
  }

  // Owner-only, same rewrite-the-whole-array constraint as the SPI
  // checkbox above — marks when a response to this risk actually began.
  // The daily overdue-alert digest (see functions/index.js's
  // sendOverdueDigest) flags a high-severity, still-open risk with this
  // left blank as needing attention.
  function wireRiskResponseInitiated() {
    var tbody = document.querySelector('#riskRegisterTable tbody');
    if (!tbody || tbody.__responseInitiatedWired) return;
    tbody.__responseInitiatedWired = true;

    tbody.addEventListener('change', function (e) {
      var input = e.target.closest('.risk-response-initiated-input');
      if (!input || !isOwner) return;
      var riskId = input.getAttribute('data-risk-id');
      var value = input.value; // 'YYYY-MM-DD' or '' if cleared

      var updated = riskRows.map(function (r) {
        return r.id === riskId ? Object.assign({}, r, { responseInitiated: value || null }) : r;
      });
      riskRows = updated;

      projRef().set({ riskRegister: updated }, { merge: true }).then(function () {
        renderRiskTable();
      }).catch(function (err) {
        error('save responseInitiated date failed', err);
        alert('Could not save — please try again: ' + (err && err.message ? err.message : err));
      });
    });
  }

  function loadRiskRows() {
    return projRef().get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      riskRows = Array.isArray(data.riskRegister) ? data.riskRegister : [];
      riskExposureSnapshots = Array.isArray(data.riskExposureSnapshots) ? data.riskExposureSnapshots : [];
      renderRiskTable();
      renderRiskExposureTrend();
      if (window.drLastUpdated) window.drLastUpdated.render('riskRegisterLastUpdated', data.riskRegisterLastImportedAt);
    }).catch(function (err) { error('load risk register failed', err); });
  }

  // ---------- Risk Exposure Trend ----------
  // Same hide-the-canvas-not-delete-it pattern as every other chart in this
  // app — replacing the canvas via innerHTML would remove it from the DOM
  // permanently, so a later import could never redraw into it again.
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

  // 1-5 raw Probability/Impact ratings bucketed the same way the rest of
  // the app reads a 1-5 scale: 4-5 = High, 3 = Medium, 1-2 = Low.
  function ratingBucket(v) {
    if (typeof v !== 'number' || isNaN(v)) return null;
    if (v >= 4) return 'high';
    if (v === 3) return 'medium';
    return 'low';
  }

  // Compares the two most recent Risk Register imports risk-by-risk (only
  // risks present in BOTH snapshots — a risk that's new or gone between
  // imports has no "before" value to diff against) and counts how many
  // moved into each Probability/Impact bucket. A risk that changed is
  // attributed to its CURRENT (post-change) bucket — "3 risks now rate
  // High Impact that didn't before" is the actionable read, not just a
  // raw count of movement.
  function computeRiskBucketChanges(prevSnapshot, currSnapshot) {
    var prevById = {};
    (prevSnapshot.risks || []).forEach(function (r) { prevById[r.id] = r; });

    var counts = {
      impact: { high: 0, medium: 0, low: 0 },
      probability: { high: 0, medium: 0, low: 0 }
    };
    var changedCount = 0;

    (currSnapshot.risks || []).forEach(function (curr) {
      var prev = prevById[curr.id];
      if (!prev) return; // new risk since the last import — nothing to diff against

      var prevImpactBucket = ratingBucket(prev.impact);
      var currImpactBucket = ratingBucket(curr.impact);
      var impactChanged = prevImpactBucket && currImpactBucket && prevImpactBucket !== currImpactBucket;
      if (impactChanged) counts.impact[currImpactBucket]++;

      var prevProbBucket = ratingBucket(prev.probability);
      var currProbBucket = ratingBucket(curr.probability);
      var probChanged = prevProbBucket && currProbBucket && prevProbBucket !== currProbBucket;
      if (probChanged) counts.probability[currProbBucket]++;

      if (impactChanged || probChanged) changedCount++;
    });

    return { counts: counts, changedCount: changedCount };
  }

  // Compares the two most recent Risk Register imports — needs at least 2
  // to show anything (see the snapshot append in wireRiskImport below).
  function renderRiskExposureTrend() {
    var card = document.getElementById('riskExposureTrendCard');
    var canvas = document.getElementById('riskExposureTrendChart');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('riskExposureTrendCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !canvas || typeof window.Chart === 'undefined') return;

    // Snapshots taken before per-risk detail was added to this feature
    // have no .risks array at all — comparing against one would silently
    // produce an all-zero diff (nothing matches, so it reads as "no risks
    // changed") even when real changes were made. Rather than rigidly
    // requiring literally the last 2 array entries (which could be one
    // old aggregate-only snapshot and one new one, depending on exactly
    // when re-imports happened), this searches backward for the 2 most
    // recent snapshots that actually HAVE per-risk data — so once 2 real
    // ones exist, they're found and compared regardless of how many
    // older aggregate-only snapshots sit earlier in the history.
    var withRisks = riskExposureSnapshots.filter(function (s) { return Array.isArray(s.risks) && s.risks.length; });

    log('risk exposure trend render', {
      totalSnapshots: riskExposureSnapshots.length,
      snapshotsWithRisksData: withRisks.length,
      perSnapshotRiskCounts: riskExposureSnapshots.map(function (s) {
        return { date: s.date, hasRisksField: Array.isArray(s.risks), risksLength: Array.isArray(s.risks) ? s.risks.length : null, openCount: s.openCount };
      })
    });

    if (withRisks.length < 2) {
      setChartEmptyLocal(canvas, withRisks.length === 0
        ? 'Collecting data — every stored import predates per-risk tracking. Re-import the Risk Register twice more to get a real comparison.'
        : 'Collecting data — only 1 import has per-risk detail so far. Re-import the Risk Register once more to get a real comparison.');
      if (window.drInsight) window.drInsight.set('riskExposureTrendCard', '');
      return;
    }
    clearChartEmptyLocal(canvas);

    var prevSnapshot = withRisks[withRisks.length - 2];
    var currSnapshot = withRisks[withRisks.length - 1];

    var diff = computeRiskBucketChanges(prevSnapshot, currSnapshot);

    if (riskExposureChartInstance) { riskExposureChartInstance.destroy(); }
    riskExposureChartInstance = new window.Chart(canvas.getContext('2d'), {
      type: 'bar',
      plugins: window.ChartDataLabels ? [window.ChartDataLabels] : [],
      data: {
        labels: ['High', 'Medium', 'Low'],
        datasets: [
          { label: 'Impact', data: [diff.counts.impact.high, diff.counts.impact.medium, diff.counts.impact.low], backgroundColor: '#4a3aa7' },
          { label: 'Probability', data: [diff.counts.probability.high, diff.counts.probability.medium, diff.counts.probability.low], backgroundColor: '#eb6834' }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        // A little headroom above the tallest bar so its datalabel isn't
        // clipped by the chart's own top edge.
        layout: { padding: { top: 16 } },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { mode: 'index', intersect: false },
          datalabels: {
            anchor: 'end',
            align: 'end',
            font: { size: 11, weight: 'bold' },
            color: '#333',
            formatter: function (value) { return value > 0 ? value : ''; }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: { beginAtZero: true, max: 5, ticks: { precision: 0, stepSize: 1 }, title: { display: true, text: 'risks changed', font: { size: 11 } }, grid: { color: '#e0e0e0' } }
        }
      }
    });

    if (window.drInsight) {
      var text = 'Comparing the last 2 Risk Register imports (' + fmtDate(prevSnapshot.date) + ' → ' + fmtDate(currSnapshot.date) + '): ' +
        diff.changedCount + ' risk' + (diff.changedCount === 1 ? '' : 's') + ' changed Impact and/or Probability rating.';
      var impactUp = diff.counts.impact.high;
      var probUp = diff.counts.probability.high;
      if (impactUp > 0 || probUp > 0) {
        text += ' ' + (impactUp > 0 ? impactUp + ' now rate High Impact' : '') + (impactUp > 0 && probUp > 0 ? ', ' : '') +
          (probUp > 0 ? probUp + ' now rate High Probability' : '') + ' that didn\'t before.';
      } else if (diff.changedCount === 0) {
        text += ' No risks moved between High/Medium/Low buckets since the last import.';
      }
      window.drInsight.set('riskExposureTrendCard', text);
    }
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
      if (window.drProgress) window.drProgress.show('Importing risk register…');

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

        // Risk Register has no per-risk change tracking (it's a single
        // array field, fully overwritten on each import, unlike Milestones/
        // Activities' per-doc changeLog) — so a Risk Exposure Trend can't
        // read history from individual risks. Instead, append ONE
        // point-in-time snapshot per import (capped to the most recent 50),
        // same technique as the EAC-over-time snapshot history in gantt.js.
        // "Open" excludes Resolved/Closed — this is exposure that still
        // needs managing, not a running total of every risk ever logged.
        // Each snapshot keeps every open risk's OWN id/probability/impact
        // (not just an aggregate total) so the trend card can diff the two
        // most recent imports risk-by-risk — which risks moved between
        // High/Medium/Low buckets, not just whether the overall number
        // went up or down.
        var bizDocRef = projRef();
        var openRisksForSnapshot = out.filter(function (r) {
          var s = (r.status || '').toLowerCase();
          return s !== 'resolved' && s !== 'closed';
        });
        var totalScore = openRisksForSnapshot.reduce(function (sum, r) {
          return sum + (typeof r.score === 'number' ? r.score : 0);
        }, 0);
        var openHighCount = openRisksForSnapshot.filter(function (r) {
          return typeof r.score === 'number' && r.score >= 15;
        }).length;

        var updatedSnapshots;
        bizDocRef.get().then(function (snap) {
          var existing = (snap.exists && snap.data() && snap.data().riskExposureSnapshots) || [];
          var snapshot = {
            date: new Date(),
            totalScore: totalScore,
            openCount: openRisksForSnapshot.length,
            openHighCount: openHighCount,
            risks: openRisksForSnapshot.map(function (r) {
              return { id: r.id, probability: r.probability, impact: r.impact };
            })
          };
          log('risk exposure snapshot built', {
            totalRowsInFile: out.length,
            openRisksForSnapshot: openRisksForSnapshot.length,
            statusValuesSeen: out.map(function (r) { return r.status; }),
            existingSnapshotCount: existing.length,
            newSnapshotRisksLength: snapshot.risks.length
          });
          updatedSnapshots = existing.concat([snapshot]).slice(-50);
          var importedAt = new Date();
          return bizDocRef.set({ riskRegister: out, riskExposureSnapshots: updatedSnapshots, riskRegisterLastImportedAt: importedAt }, { merge: true }).then(function () {
            return importedAt;
          });
        }).then(function (importedAt) {
          alert('Risk Register imported: ' + out.length + ' risks.');
          input.value = '';
          riskRows = out;
          riskExposureSnapshots = updatedSnapshots;
          renderRiskTable();
          renderRiskExposureTrend();
          if (window.drLastUpdated) window.drLastUpdated.render('riskRegisterLastUpdated', importedAt);
        }).catch(function (err) {
          error('save risk register failed', err);
          alert('Import failed: ' + (err && err.message ? err.message : err));
        });
      }).catch(function (err) {
        error('read risk register failed', err);
        alert('Import failed: ' + (err && err.message ? err.message : err));
      }).finally(function () {
        if (window.drProgress) window.drProgress.hide();
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

  // ---------- Sort / Filter / Pagination state ----------
  var assumptionsSort = { key: null, dir: 'asc' };
  var assumptionsFilters = { category: [], impact: [], probability: [], owner: [], status: [] };
  var assumptionsPage = 1;
  var ASSUMPTIONS_PAGE_SIZE = 15;

  // Populates each filter <select> from the DATA's own distinct values
  // (not a fixed list), preserving whatever's currently selected if it's
  // still a valid option after new data loads.
  function populateAssumptionsFilters() {
    var fields = [
      { key: 'category', id: 'assumptionsFilterCategory', allLabel: 'All Categories' },
      { key: 'impact', id: 'assumptionsFilterImpact', allLabel: 'All Impact' },
      { key: 'probability', id: 'assumptionsFilterProbability', allLabel: 'All Probability' },
      { key: 'owner', id: 'assumptionsFilterOwner', allLabel: 'All Owners' },
      { key: 'status', id: 'assumptionsFilterStatus', allLabel: 'All Status' }
    ];
    fields.forEach(function (f) {
      var sel = document.getElementById(f.id);
      if (!sel) return;
      var current = sel.value;
      var values = Array.from(
        assumptionRows.reduce(function (set, a) {
          var v = (a[f.key] || '').toString().trim();
          if (v) set.add(v);
          return set;
        }, new Set())
      ).sort(function (a, b) { return a.localeCompare(b); });

      sel.innerHTML = '<option value="">' + f.allLabel + '</option>' +
        values.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
      if (values.indexOf(current) !== -1) sel.value = current;
    });
  }

  function getFilteredSortedAssumptions() {
    var rows = assumptionRows.filter(function (a) {
      return matchesMulti(assumptionsFilters.category, a.category) &&
        matchesMulti(assumptionsFilters.impact, a.impact) &&
        matchesMulti(assumptionsFilters.probability, a.probability) &&
        matchesMulti(assumptionsFilters.owner, a.owner) &&
        matchesMulti(assumptionsFilters.status, a.status);
    });

    if (assumptionsSort.key) {
      var key = assumptionsSort.key;
      var dir = assumptionsSort.dir === 'desc' ? -1 : 1;
      rows = rows.slice().sort(function (a, b) {
        var av = (a[key] || '').toString().toLowerCase();
        var bv = (b[key] || '').toString().toLowerCase();
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return rows;
  }

  function wireAssumptionsControls() {
    var thead = document.querySelector('#assumptionsLogTable thead');
    if (thead && !thead.__sortWired) {
      thead.__sortWired = true;
      thead.addEventListener('click', function (e) {
        var th = e.target.closest('th[data-sort]');
        if (!th) return;
        var key = th.getAttribute('data-sort');
        if (assumptionsSort.key === key) {
          assumptionsSort.dir = assumptionsSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          assumptionsSort.key = key;
          assumptionsSort.dir = 'asc';
        }
        assumptionsPage = 1;
        renderAssumptionsTable();
      });
    }

    ['Category', 'Impact', 'Probability', 'Owner', 'Status'].forEach(function (label) {
      var sel = document.getElementById('assumptionsFilter' + label);
      if (sel && window.drCreateMultiSelectFilter) {
        window.drCreateMultiSelectFilter(sel, function (values) {
          assumptionsFilters[label.toLowerCase()] = values;
          assumptionsPage = 1;
          renderAssumptionsTable();
        });
      }
    });

    var prevBtn = document.getElementById('assumptionsPagePrev');
    var nextBtn = document.getElementById('assumptionsPageNext');
    if (prevBtn && !prevBtn.__wired) {
      prevBtn.__wired = true;
      prevBtn.addEventListener('click', function () {
        if (assumptionsPage > 1) { assumptionsPage--; renderAssumptionsTable(); }
      });
    }
    if (nextBtn && !nextBtn.__wired) {
      nextBtn.__wired = true;
      nextBtn.addEventListener('click', function () {
        assumptionsPage++;
        renderAssumptionsTable();
      });
    }

    var resetBtn = document.getElementById('assumptionsFilterReset');
    if (resetBtn && !resetBtn.__wired) {
      resetBtn.__wired = true;
      resetBtn.addEventListener('click', function () {
        assumptionsFilters = { category: [], impact: [], probability: [], owner: [], status: [] };
        ['Category', 'Impact', 'Probability', 'Owner', 'Status'].forEach(function (label) {
          var sel = document.getElementById('assumptionsFilter' + label);
          if (sel && sel.__drMultiSelect) sel.__drMultiSelect.clear();
        });
        assumptionsPage = 1;
        renderAssumptionsTable();
      });
    }
  }

  function renderAssumptionsTable() {
    var card = document.getElementById('assumptionsLogCard');
    var tbody = document.querySelector('#assumptionsLogTable tbody');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('assumptionsLogCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    wireAssumptionsControls();

    if (!assumptionRows.length) {
      tbody.innerHTML = '<tr><td colspan="14" class="metrics-empty">No assumptions imported yet.</td></tr>';
      var pageInfoEmpty = document.getElementById('assumptionsPageInfo');
      if (pageInfoEmpty) pageInfoEmpty.textContent = '';
      if (window.drInsight) window.drInsight.set('assumptionsLogCard', '');
      return;
    }

    populateAssumptionsFilters();

    var filtered = getFilteredSortedAssumptions();
    var totalPages = Math.max(1, Math.ceil(filtered.length / ASSUMPTIONS_PAGE_SIZE));
    if (assumptionsPage > totalPages) assumptionsPage = totalPages;
    if (assumptionsPage < 1) assumptionsPage = 1;
    var startIdx = (assumptionsPage - 1) * ASSUMPTIONS_PAGE_SIZE;
    var pageRows = filtered.slice(startIdx, startIdx + ASSUMPTIONS_PAGE_SIZE);

    // Sort-direction indicator on the active column's header.
    document.querySelectorAll('#assumptionsLogTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === assumptionsSort.key) th.classList.add(assumptionsSort.dir);
    });

    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="14" class="metrics-empty">No assumptions match the selected filters.</td></tr>';
    } else {
      // Every captured column, in the same order as the table's <colgroup>.
      tbody.innerHTML = pageRows.map(function (a) {
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

    var pageInfo = document.getElementById('assumptionsPageInfo');
    if (pageInfo) pageInfo.textContent = 'Page ' + assumptionsPage + ' of ' + totalPages + ' (' + filtered.length + (filtered.length === 1 ? ' row' : ' rows') + ')';
    var prevBtnEl = document.getElementById('assumptionsPagePrev');
    var nextBtnEl = document.getElementById('assumptionsPageNext');
    if (prevBtnEl) prevBtnEl.disabled = assumptionsPage <= 1;
    if (nextBtnEl) nextBtnEl.disabled = assumptionsPage >= totalPages;

    if (window.drRefs) {
      assumptionRows.forEach(function (a) {
        window.drRefs.register(a.id, {
          cardId: 'assumptionsLogCard', cardLabel: 'Assumptions Log',
          summary: a.statement,
          fields: [{ label: 'Impact', value: a.impact }, { label: 'Status', value: a.status }, { label: 'Owner', value: a.owner }]
        });
      });
    }

    if (window.drInsight) {
      var unvalidated = assumptionRows.filter(function (a) { return (a.status || '').toLowerCase() !== 'validated' && (a.status || '').toLowerCase() !== 'confirmed'; });
      var highImpactOpen = unvalidated.filter(function (a) { return LEVEL_RANK[(a.impact || '').trim().toLowerCase()] === 3; });
      var text = assumptionRows.length + ' assumption' + (assumptionRows.length === 1 ? '' : 's') + ' logged, ' +
        unvalidated.length + ' still unvalidated.';
      if (highImpactOpen.length) {
        text += ' ' + highImpactOpen.length + ' of those carr' + (highImpactOpen.length === 1 ? 'ies' : 'y') + ' high impact if proven false' +
          (highImpactOpen[0].statement ? ', e.g. ' + highImpactOpen[0].id + ' — "' + highImpactOpen[0].statement + '".' : '.');
      } else {
        text += ' None of the open items are flagged high-impact.';
      }
      window.drInsight.set('assumptionsLogCard', text);
    }
  }

  function loadAssumptionRows() {
    return projRef().get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      assumptionRows = Array.isArray(data.assumptionsLog) ? data.assumptionsLog : [];
      renderAssumptionsTable();
      if (window.drLastUpdated) window.drLastUpdated.render('assumptionsLastUpdated', data.assumptionsLastImportedAt);
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
      if (window.drProgress) window.drProgress.show('Importing assumptions log…');

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

        var assumptionsImportedAt = new Date();
        projRef().set({ assumptionsLog: out, assumptionsLastImportedAt: assumptionsImportedAt }, { merge: true }).then(function () {
          alert('Assumptions Log imported: ' + out.length + ' assumptions.');
          input.value = '';
          assumptionRows = out;
          renderAssumptionsTable();
          if (window.drLastUpdated) window.drLastUpdated.render('assumptionsLastUpdated', assumptionsImportedAt);
        }).catch(function (err) {
          error('save assumptions log failed', err);
          alert('Import failed: ' + (err && err.message ? err.message : err));
        });
      }).catch(function (err) {
        error('read assumptions log failed', err);
        alert('Import failed: ' + (err && err.message ? err.message : err));
      }).finally(function () {
        if (window.drProgress) window.drProgress.hide();
      });
    });
  }

  // Pages a table's own scroll box up/down by most of a screenful per
  // click — same reasoning as the Gantt chart's directional pad and the
  // RACI table's up/down buttons: a long Assumptions/Risk list shouldn't
  // require manual scrollbar-dragging to page through.
  function scrollTableByPage(cardId, direction) {
    var scrollEl = document.querySelector('#' + cardId + ' .risk-assumptions-table-wrap');
    if (!scrollEl) return;
    scrollEl.scrollBy({ top: direction * scrollEl.clientHeight * 0.6, behavior: 'smooth' });
  }

  function wirePageScrollButtons() {
    [
      { up: 'assumptionsPageUp', down: 'assumptionsPageDown', cardId: 'assumptionsLogCard' },
      { up: 'riskPageUp', down: 'riskPageDown', cardId: 'riskRegisterCard' }
    ].forEach(function (cfg) {
      var upBtn = document.getElementById(cfg.up);
      var downBtn = document.getElementById(cfg.down);
      if (upBtn && !upBtn.__wired) { upBtn.__wired = true; upBtn.addEventListener('click', function () { scrollTableByPage(cfg.cardId, -1); }); }
      if (downBtn && !downBtn.__wired) { downBtn.__wired = true; downBtn.addEventListener('click', function () { scrollTableByPage(cfg.cardId, 1); }); }
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
    wireRiskImport();
    wireAssumptionsImport();
    wirePageScrollButtons();

    auth.onAuthStateChanged(function (user) {
      var email = (user && user.email) || '';
      isOwner = !!email && !!OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
      wireRiskImport();
      wireAssumptionsImport();
      loadRiskRows();
      loadAssumptionRows();
    });

    // Each of these checks window.drAccess.canViewReport() to decide
    // whether to populate at all — if the Firestore snapshot that
    // triggers one fires before dr-access-control.js finishes resolving
    // role/permissions (a real timing race either way), it renders a
    // permanently empty card with no second chance. All three are safe
    // to re-run with no arguments (cached module state), so re-run them
    // once access is known to be resolved.
    if (window.drAccess) window.drAccess.whenReady().then(function () {
      renderRiskTable();
      renderRiskExposureTrend();
      renderAssumptionsTable();
    });
  }

  start();
})();
