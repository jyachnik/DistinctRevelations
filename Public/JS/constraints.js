// Public/JS/constraints.js
// Constraints Log (owner-only) — fixed conditions/boundaries the project
// must operate within (as opposed to Assumptions, which are believed-true-
// but-unverified, or Risks, which are uncertain events). Same
// import/store/sort/filter/paginate pattern as Assumptions Log and Risk
// Register (see riskAssumptions.js) — a small, infrequently-changing
// dataset stored as one array field on the business doc.

(function () {
  'use strict';

  var TAG = '[constraints]';
  function log() { console.log.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
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
  var constraintRows = [];

  function resolveBusinessKey() {
    var params = new URLSearchParams(window.location.search || '');
    return params.get('business') || (window.localStorage && window.localStorage.getItem('businessKey')) || window.BIZ_KEY || null;
  }

  // Multi-project cutover — constraintsLog now lives on the project doc,
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

  // Same bare-numeric-string-as-Excel-serial handling as
  // riskAssumptions.js's toJsDate() — a CSV date cell often comes through
  // as a plain digit string that new Date() would otherwise misread as a
  // literal year.
  function toJsDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
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

  var LEVEL_RANK = { h: 3, m: 2, l: 1 };
  function severityBadge(value) {
    var rank = LEVEL_RANK[(value || '').trim().toLowerCase()];
    var cls = rank === 3 ? 'high' : rank === 2 ? 'medium' : rank === 1 ? 'low' : 'unknown';
    return '<span class="severity-badge severity-' + cls + '">' + (value ? esc(value) : '—') + '</span>';
  }

  // ---------- Sort / Filter / Pagination state ----------
  var constraintsSort = { key: null, dir: 'asc' };
  var constraintsFilters = { category: [], severity: [], owner: [], status: [] };
  function matchesMulti(selected, value) {
    return !selected.length || selected.indexOf(value) !== -1;
  }
  var constraintsPage = 1;
  var CONSTRAINTS_PAGE_SIZE = 15;

  function populateConstraintsFilters() {
    var fields = [
      { key: 'category', id: 'constraintsFilterCategory', allLabel: 'All Categories' },
      { key: 'severity', id: 'constraintsFilterSeverity', allLabel: 'All Severity' },
      { key: 'owner', id: 'constraintsFilterOwner', allLabel: 'All Owners' },
      { key: 'status', id: 'constraintsFilterStatus', allLabel: 'All Status' }
    ];
    fields.forEach(function (f) {
      var sel = document.getElementById(f.id);
      if (!sel) return;
      var current = sel.value;
      var values = Array.from(
        constraintRows.reduce(function (set, c) {
          var v = (c[f.key] || '').toString().trim();
          if (v) set.add(v);
          return set;
        }, new Set())
      ).sort(function (a, b) { return a.localeCompare(b); });

      sel.innerHTML = '<option value="">' + f.allLabel + '</option>' +
        values.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
      if (values.indexOf(current) !== -1) sel.value = current;
    });
  }

  function getFilteredSortedConstraints() {
    var rows = constraintRows.filter(function (c) {
      return matchesMulti(constraintsFilters.category, c.category) &&
        matchesMulti(constraintsFilters.severity, c.severity) &&
        matchesMulti(constraintsFilters.owner, c.owner) &&
        matchesMulti(constraintsFilters.status, c.status);
    });

    if (constraintsSort.key) {
      var key = constraintsSort.key;
      var dir = constraintsSort.dir === 'desc' ? -1 : 1;
      rows = rows.slice().sort(function (a, b) {
        var av = a[key], bv = b[key];
        // dateLogged is a real Date object — comparing via toString()
        // would sort by weekday name (Fri/Mon/Sat/...), not
        // chronologically, since Date's string form starts with the
        // day-of-week abbreviation.
        if (av instanceof Date || bv instanceof Date) {
          var at = av instanceof Date && !isNaN(av.getTime()) ? av.getTime() : -Infinity;
          var bt = bv instanceof Date && !isNaN(bv.getTime()) ? bv.getTime() : -Infinity;
          return (at - bt) * dir;
        }
        av = (av || '').toString().toLowerCase();
        bv = (bv || '').toString().toLowerCase();
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return rows;
  }

  function wireConstraintsControls() {
    var thead = document.querySelector('#constraintsLogTable thead');
    if (thead && !thead.__sortWired) {
      thead.__sortWired = true;
      thead.addEventListener('click', function (e) {
        var th = e.target.closest('th[data-sort]');
        if (!th) return;
        var key = th.getAttribute('data-sort');
        if (constraintsSort.key === key) {
          constraintsSort.dir = constraintsSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          constraintsSort.key = key;
          constraintsSort.dir = 'asc';
        }
        constraintsPage = 1;
        renderConstraintsTable();
      });
    }

    ['Category', 'Severity', 'Owner', 'Status'].forEach(function (label) {
      var sel = document.getElementById('constraintsFilter' + label);
      if (sel && window.drCreateMultiSelectFilter) {
        window.drCreateMultiSelectFilter(sel, function (values) {
          constraintsFilters[label.toLowerCase()] = values;
          constraintsPage = 1;
          renderConstraintsTable();
        });
      }
    });

    var prevBtn = document.getElementById('constraintsPagePrev');
    var nextBtn = document.getElementById('constraintsPageNext');
    if (prevBtn && !prevBtn.__wired) {
      prevBtn.__wired = true;
      prevBtn.addEventListener('click', function () {
        if (constraintsPage > 1) { constraintsPage--; renderConstraintsTable(); }
      });
    }
    if (nextBtn && !nextBtn.__wired) {
      nextBtn.__wired = true;
      nextBtn.addEventListener('click', function () {
        constraintsPage++;
        renderConstraintsTable();
      });
    }

    var resetBtn = document.getElementById('constraintsFilterReset');
    if (resetBtn && !resetBtn.__wired) {
      resetBtn.__wired = true;
      resetBtn.addEventListener('click', function () {
        constraintsFilters = { category: [], severity: [], owner: [], status: [] };
        ['Category', 'Severity', 'Owner', 'Status'].forEach(function (label) {
          var sel = document.getElementById('constraintsFilter' + label);
          if (sel && sel.__drMultiSelect) sel.__drMultiSelect.clear();
        });
        constraintsPage = 1;
        renderConstraintsTable();
      });
    }

    // Up/down/left/right page-scroll — same directional-pad pattern as
    // qualityDefects.js/riskAssumptions.js's own scroll buttons.
    var upBtn = document.getElementById('constraintsPageUp');
    var downBtn = document.getElementById('constraintsPageDown');
    var leftBtn = document.getElementById('constraintsPageLeft');
    var rightBtn = document.getElementById('constraintsPageRight');
    if (upBtn && !upBtn.__wired) {
      upBtn.__wired = true;
      upBtn.addEventListener('click', function () {
        var scrollEl = document.querySelector('#constraintsLogCard .risk-assumptions-table-wrap');
        if (scrollEl) scrollEl.scrollBy({ top: -scrollEl.clientHeight * 0.6, behavior: 'smooth' });
      });
    }
    if (downBtn && !downBtn.__wired) {
      downBtn.__wired = true;
      downBtn.addEventListener('click', function () {
        var scrollEl = document.querySelector('#constraintsLogCard .risk-assumptions-table-wrap');
        if (scrollEl) scrollEl.scrollBy({ top: scrollEl.clientHeight * 0.6, behavior: 'smooth' });
      });
    }
    if (leftBtn && !leftBtn.__wired) {
      leftBtn.__wired = true;
      leftBtn.addEventListener('click', function () {
        var scrollEl = document.querySelector('#constraintsLogCard .risk-assumptions-table-wrap');
        if (scrollEl) scrollEl.scrollBy({ left: -scrollEl.clientWidth * 0.6, behavior: 'smooth' });
      });
    }
    if (rightBtn && !rightBtn.__wired) {
      rightBtn.__wired = true;
      rightBtn.addEventListener('click', function () {
        var scrollEl = document.querySelector('#constraintsLogCard .risk-assumptions-table-wrap');
        if (scrollEl) scrollEl.scrollBy({ left: scrollEl.clientWidth * 0.6, behavior: 'smooth' });
      });
    }
  }

  function renderConstraintsTable() {
    var card = document.getElementById('constraintsLogCard');
    var tbody = document.querySelector('#constraintsLogTable tbody');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('constraintsLogCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    wireConstraintsControls();

    if (!constraintRows.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="metrics-empty">No constraints imported yet.</td></tr>';
      var pageInfoEmpty = document.getElementById('constraintsPageInfo');
      if (pageInfoEmpty) pageInfoEmpty.textContent = '';
      if (window.drInsight) window.drInsight.set('constraintsLogCard', '');
      return;
    }

    populateConstraintsFilters();

    var filtered = getFilteredSortedConstraints();
    var totalPages = Math.max(1, Math.ceil(filtered.length / CONSTRAINTS_PAGE_SIZE));
    if (constraintsPage > totalPages) constraintsPage = totalPages;
    if (constraintsPage < 1) constraintsPage = 1;
    var startIdx = (constraintsPage - 1) * CONSTRAINTS_PAGE_SIZE;
    var pageRows = filtered.slice(startIdx, startIdx + CONSTRAINTS_PAGE_SIZE);

    document.querySelectorAll('#constraintsLogTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === constraintsSort.key) th.classList.add(constraintsSort.dir);
    });

    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="metrics-empty">No constraints match the selected filters.</td></tr>';
    } else {
      tbody.innerHTML = pageRows.map(function (c) {
        var titleAttr = esc([
          c.source ? 'Source: ' + c.source : '',
          c.impactedAreas ? 'Impacted Areas: ' + c.impactedAreas : '',
          c.mitigation ? 'Response/Mitigation: ' + c.mitigation : '',
          c.notes ? 'Notes: ' + c.notes : ''
        ].filter(Boolean).join(' — '));
        return '<tr title="' + titleAttr + '">' +
          '<td>' + esc(c.id) + '</td>' +
          '<td>' + esc(fmtDate(c.dateLogged)) + '</td>' +
          '<td>' + esc(c.category) + '</td>' +
          '<td class="wrap-text">' + esc(c.statement) + '</td>' +
          '<td>' + esc(c.source) + '</td>' +
          '<td>' + esc(c.impactedAreas) + '</td>' +
          '<td>' + severityBadge(c.severity) + '</td>' +
          '<td>' + esc(c.owner) + '</td>' +
          '<td>' + esc(c.status) + '</td>' +
          '<td class="wrap-text">' + esc(c.mitigation) + '</td>' +
          '<td class="wrap-text">' + esc(c.notes) + '</td>' +
          '</tr>';
      }).join('');
    }

    var pageInfo = document.getElementById('constraintsPageInfo');
    if (pageInfo) pageInfo.textContent = 'Page ' + constraintsPage + ' of ' + totalPages + ' (' + filtered.length + (filtered.length === 1 ? ' row' : ' rows') + ')';
    var prevBtnEl = document.getElementById('constraintsPagePrev');
    var nextBtnEl = document.getElementById('constraintsPageNext');
    if (prevBtnEl) prevBtnEl.disabled = constraintsPage <= 1;
    if (nextBtnEl) nextBtnEl.disabled = constraintsPage >= totalPages;

    if (window.drRefs) {
      constraintRows.forEach(function (c) {
        window.drRefs.register(c.id, {
          cardId: 'constraintsLogCard', cardLabel: 'Constraints Log',
          summary: c.statement,
          fields: [{ label: 'Severity', value: c.severity }, { label: 'Status', value: c.status }, { label: 'Owner', value: c.owner }]
        });
      });
    }

    if (window.drInsight) {
      var openConstraints = constraintRows.filter(function (c) { return (c.status || '').toLowerCase() !== 'closed' && (c.status || '').toLowerCase() !== 'resolved'; });
      var highSev = openConstraints.filter(function (c) { return (c.severity || '').toLowerCase() === 'high'; });
      var text = constraintRows.length + ' constraint' + (constraintRows.length === 1 ? '' : 's') + ' logged, ' +
        openConstraints.length + ' still open.';
      if (highSev.length) {
        text += ' ' + highSev.length + ' open at high severity' +
          (highSev[0].statement ? ', top one: ' + highSev[0].id + ' — "' + highSev[0].statement + '".' : '.');
      } else if (openConstraints.length) {
        text += ' None of the open items are high severity.';
      }
      window.drInsight.set('constraintsLogCard', text);
    }
  }

  function loadConstraintRows() {
    return projRef().get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      constraintRows = Array.isArray(data.constraintsLog) ? data.constraintsLog : [];
      renderConstraintsTable();
      if (window.drLastUpdated) window.drLastUpdated.render('constraintsLastUpdated', data.constraintsLastImportedAt);
    }).catch(function (err) { error('load constraints log failed', err); });
  }

  function wireConstraintsImport() {
    var input = document.getElementById('constraintsImportInput');
    var btn = document.getElementById('constraintsImportBtn');
    if (!input || !btn) return;

    if (!isOwner) { input.style.display = 'none'; btn.style.display = 'none'; return; }
    input.style.display = '';
    btn.style.display = '';
    if (btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener('click', function () {
      if (!input.files || !input.files[0]) { alert('Choose a Constraints Log export file first.'); return; }
      if (window.drProgress) window.drProgress.show('Importing constraints log…');

      readRows(input.files[0]).then(function (parsed) {
        var header = parsed.header;
        var idxId = colIndex(header, ['constraint id']);
        var idxDateLogged = colIndex(header, ['date logged']);
        var idxCategory = colIndex(header, ['category']);
        var idxStatement = colIndex(header, ['constraint statement']);
        var idxSource = colIndex(header, ['source']);
        var idxImpactedAreas = colIndex(header, ['impacted areas']);
        var idxSeverity = colIndex(header, ['severity (h/m/l)', 'severity(h/m/l)']);
        var idxOwner = colIndex(header, ['owner']);
        var idxStatus = colIndex(header, ['status']);
        var idxMitigation = colIndex(header, ['response / mitigation', 'response/mitigation']);
        var idxNotes = colIndex(header, ['notes']);

        if (idxId === -1 || idxStatement === -1) {
          alert('Constraints Log file must have Constraint ID and Constraint Statement columns.');
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
            source: idxSource >= 0 && row[idxSource] != null ? String(row[idxSource]).trim() : '',
            impactedAreas: idxImpactedAreas >= 0 && row[idxImpactedAreas] != null ? String(row[idxImpactedAreas]).trim() : '',
            severity: idxSeverity >= 0 && row[idxSeverity] != null ? String(row[idxSeverity]).trim() : '',
            owner: idxOwner >= 0 && row[idxOwner] != null ? String(row[idxOwner]).trim() : '',
            status: idxStatus >= 0 && row[idxStatus] != null ? String(row[idxStatus]).trim() : '',
            mitigation: idxMitigation >= 0 && row[idxMitigation] != null ? String(row[idxMitigation]).trim() : '',
            notes: idxNotes >= 0 && row[idxNotes] != null ? String(row[idxNotes]).trim() : ''
          });
        });

        if (!out.length) { alert('No valid constraint rows found — each row needs a Constraint ID.'); return; }

        var constraintsImportedAt = new Date();
        projRef().set({ constraintsLog: out, constraintsLastImportedAt: constraintsImportedAt }, { merge: true }).then(function () {
          alert('Constraints Log imported: ' + out.length + ' constraints.');
          input.value = '';
          constraintRows = out;
          renderConstraintsTable();
          if (window.drLastUpdated) window.drLastUpdated.render('constraintsLastUpdated', constraintsImportedAt);
        }).catch(function (err) {
          error('save constraints log failed', err);
          alert('Import failed: ' + (err && err.message ? err.message : err));
        });
      }).catch(function (err) {
        error('read constraints log failed', err);
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
    wireConstraintsImport();

    auth.onAuthStateChanged(function (user) {
      var email = (user && user.email) || '';
      isOwner = !!email && !!OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
      wireConstraintsImport();
      loadConstraintRows();
    });

    // renderConstraintsTable() checks window.drAccess.canViewReport() to
    // decide whether to populate at all — if the Firestore snapshot that
    // triggers it fires before dr-access-control.js finishes resolving
    // role/permissions (a real timing race either way), it renders a
    // permanently empty card with no second chance. Safe to re-run with
    // no arguments (cached module state), so re-run once access is known
    // to be resolved.
    if (window.drAccess) window.drAccess.whenReady().then(renderConstraintsTable);
  }

  start();
})();
