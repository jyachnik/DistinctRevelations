// Public/JS/raci.js
// Assignments / RACI (Responsibility Matrix) — owner-only. One row per
// activity, one column per resource, cell = that resource's RACI code
// for that activity (R = Responsible, A = Accountable, C = Consulted,
// I = Informed, or a combination like "R/A"). Column count/names come
// straight from the import (whatever resources the file lists), not a
// fixed schema like the other imports — so this table's own <thead> is
// built dynamically at render time instead of a static one in
// dashboard.html.

(function () {
  'use strict';

  var TAG = '[raci]';
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
  var raciResources = [];
  var raciRows = [];
  var raciPage = 1;
  var RACI_PAGE_SIZE = 15;

  function resolveBusinessKey() {
    var params = new URLSearchParams(window.location.search || '');
    return params.get('business') || (window.localStorage && window.localStorage.getItem('businessKey')) || window.BIZ_KEY || null;
  }

  // Multi-project cutover — raciMatrix now lives on the project doc, not
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

  // Same red/blue/green/grey convention used for severity badges
  // elsewhere, repurposed for RACI codes so each letter reads at a
  // glance: Accountable (the one on the hook) stands out like a
  // high-severity badge, Responsible like medium, Consulted/Informed
  // like low/neutral.
  var RACI_CLASS = { R: 'raci-r', A: 'raci-a', C: 'raci-c', I: 'raci-i' };
  function raciBadge(code) {
    if (!code) return '';
    var parts = code.split('/').map(function (p) { return p.trim().toUpperCase(); }).filter(Boolean);
    return parts.map(function (p) {
      var cls = RACI_CLASS[p] || 'raci-other';
      return '<span class="raci-badge ' + cls + '" title="' + esc(raciFullName(p)) + '">' + esc(p) + '</span>';
    }).join(' ');
  }
  function raciFullName(code) {
    return { R: 'Responsible', A: 'Accountable', C: 'Consulted', I: 'Informed' }[code] || code;
  }

  // Click-to-sort — same generic pattern used elsewhere in this app,
  // duplicated per this repo's self-contained-module convention.
  // "activity" sorts alphabetically by activity name; a resource column
  // sorts by that resource's R/A/C/I code (blank last).
  var raciSort = { key: null, dir: 'asc' };
  var RACI_CODE_RANK = { R: 1, A: 2, C: 3, I: 4 };
  function raciSortValue(row, key) {
    if (key === 'activity') return (row.activity || '').toLowerCase();
    var code = (row.assignments[key] || '').trim().toUpperCase();
    return RACI_CODE_RANK[code] || 99;
  }
  function wireRaciSort(thead) {
    if (!thead || thead.__sortWired) return;
    thead.__sortWired = true;
    thead.addEventListener('click', function (e) {
      var th = e.target.closest('th[data-sort]');
      if (!th) return;
      var key = th.getAttribute('data-sort');
      if (raciSort.key === key) {
        raciSort.dir = raciSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        raciSort.key = key;
        raciSort.dir = 'asc';
      }
      renderRaciTable();
    });
  }

  function renderRaciTable() {
    var card = document.getElementById('raciCard');
    var thead = document.querySelector('#raciTable thead');
    var tbody = document.querySelector('#raciTable tbody');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('raciCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !thead || !tbody) return;
    wireRaciSort(thead);

    if (!raciRows.length) {
      thead.innerHTML = '';
      tbody.innerHTML = '<tr><td class="metrics-empty">No RACI matrix imported yet.</td></tr>';
      if (window.drInsight) window.drInsight.set('raciCard', '');
      renderRaciPagination(0, 1);
      return;
    }

    var sortedRows = raciRows;
    if (raciSort.key) {
      var dir = raciSort.dir === 'desc' ? -1 : 1;
      sortedRows = raciRows.slice().sort(function (a, b) {
        var av = raciSortValue(a, raciSort.key);
        var bv = raciSortValue(b, raciSort.key);
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }

    var totalPages = Math.max(1, Math.ceil(sortedRows.length / RACI_PAGE_SIZE));
    if (raciPage > totalPages) raciPage = totalPages;
    if (raciPage < 1) raciPage = 1;
    var startIdx = (raciPage - 1) * RACI_PAGE_SIZE;
    var pageRows = sortedRows.slice(startIdx, startIdx + RACI_PAGE_SIZE);

    // Activity stays a normal horizontal header/column (it's the one long
    // free-text field); every resource column is a person's name that can
    // run long, so its header is rotated vertical — keeps the column
    // itself narrow (just an R/A/C/I badge wide) instead of every column
    // being as wide as its longest name.
    // The rotation transform lives on an INNER span, not the <th> itself —
    // combining position:sticky and transform on the same element caused a
    // hairline rendering gap at the sticky boundary during scroll (a
    // sliver of the scrolled-past row peeking in above the header). The
    // <th> stays a plain sticky box; only the visual label is rotated.
    thead.innerHTML = '<tr><th class="raci-activity-col" data-sort="activity">Activity</th>' + raciResources.map(function (r) {
      return '<th class="raci-resource-col" data-sort="' + esc(r) + '"><span class="raci-resource-col-label">' + esc(r) + '</span></th>';
    }).join('') + '</tr>';
    thead.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (raciSort.key && th.getAttribute('data-sort') === raciSort.key) th.classList.add(raciSort.dir);
    });

    tbody.innerHTML = pageRows.map(function (row) {
      var cells = raciResources.map(function (res) {
        return '<td style="text-align:center;">' + raciBadge(row.assignments[res]) + '</td>';
      }).join('');
      return '<tr><td class="wrap-text raci-activity-col">' + esc(row.activity) + '</td>' + cells + '</tr>';
    }).join('');

    renderRaciPagination(sortedRows.length, totalPages);

    // RACI rows have no natural ID (keyed only by activity name) — a
    // synthetic, position-based code, regenerated fresh every render, so
    // it's only meaningful as "whichever activity this sentence is
    // naming right now," not a durable reference like D-003/A-055.
    if (window.drRefs) {
      raciRows.forEach(function (row, idx) {
        row.__refCode = 'ACT-' + String(idx + 1).padStart(2, '0');
        var fields = raciResources.filter(function (res) { return row.assignments[res]; }).map(function (res) {
          return { label: res, value: raciFullName(row.assignments[res]) };
        });
        window.drRefs.register(row.__refCode, {
          cardId: 'raciCard', cardLabel: 'Assignments / RACI',
          summary: row.activity,
          fields: fields
        });
      });
    }

    if (window.drInsight) {
      var noAccountable = raciRows.filter(function (row) {
        return !raciResources.some(function (res) {
          var code = (row.assignments[res] || '').toUpperCase();
          return code.indexOf('A') !== -1;
        });
      });
      var accountableCounts = {};
      raciResources.forEach(function (res) { accountableCounts[res] = 0; });
      raciRows.forEach(function (row) {
        raciResources.forEach(function (res) {
          if ((row.assignments[res] || '').toUpperCase().indexOf('A') !== -1) accountableCounts[res]++;
        });
      });
      var busiest = raciResources.slice().sort(function (a, b) { return accountableCounts[b] - accountableCounts[a]; })[0];
      var text = raciRows.length + ' activit' + (raciRows.length === 1 ? 'y' : 'ies') + ' mapped across ' + raciResources.length + ' resource' + (raciResources.length === 1 ? '' : 's') + '.';
      if (busiest && accountableCounts[busiest] > 0) {
        var example = raciRows.find(function (row) {
          return (row.assignments[busiest] || '').toUpperCase().indexOf('A') !== -1;
        });
        text += ' ' + busiest + ' is Accountable for the most (' + accountableCounts[busiest] + ')' +
          (example ? ', e.g. ' + example.__refCode + ' — "' + example.activity + '".' : '.');
      }
      if (noAccountable.length) {
        text += ' ' + noAccountable.length + ' activit' + (noAccountable.length === 1 ? 'y has' : 'ies have') + ' no one marked Accountable.';
      }
      window.drInsight.set('raciCard', text);
    }
  }

  function loadRaci() {
    return projRef().get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      var matrix = data.raciMatrix || {};
      raciResources = Array.isArray(matrix.resources) ? matrix.resources : [];
      raciRows = Array.isArray(matrix.rows) ? matrix.rows : [];
      renderRaciTable();
      if (window.drLastUpdated) window.drLastUpdated.render('raciLastUpdated', data.raciLastImportedAt);
    }).catch(function (err) { error('load failed', err); });
  }

  function wireImport() {
    var input = document.getElementById('raciImportInput');
    var btn = document.getElementById('raciImportBtn');
    if (!input || !btn) return;

    if (!isOwner) { input.style.display = 'none'; btn.style.display = 'none'; return; }
    input.style.display = '';
    btn.style.display = '';
    if (btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener('click', function () {
      if (!input.files || !input.files[0]) { alert('Choose a Responsibility Matrix (RACI) export file first.'); return; }
      if (window.drProgress) window.drProgress.show('Importing RACI matrix…');

      input.files[0].arrayBuffer().then(function (data) {
        var wb = XLSX.read(data, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (!rows.length) { alert('File has no rows.'); return; }

        // First column is the Activity name (case-insensitive header
        // match, same convention as every other import); every other
        // column is a resource name taken verbatim from the header —
        // there's no fixed set of resources to match against, unlike
        // every other import in this app.
        var header = rows[0] || [];
        var idxActivity = -1;
        for (var i = 0; i < header.length; i++) {
          if (String(header[i] || '').trim().toLowerCase() === 'activity') { idxActivity = i; break; }
        }
        if (idxActivity === -1) idxActivity = 0; // fall back to "first column is Activity"

        var resources = [];
        for (var c = 0; c < header.length; c++) {
          if (c === idxActivity) continue;
          var name = header[c] != null ? String(header[c]).trim() : '';
          if (name) resources.push(name);
        }
        if (!resources.length) {
          alert('Could not find any resource columns — the file needs an Activity column plus one column per resource.');
          return;
        }

        var outRows = [];
        rows.slice(1).forEach(function (row) {
          var activity = row[idxActivity] != null ? String(row[idxActivity]).trim() : '';
          if (!activity) return;
          var assignments = {};
          header.forEach(function (colName, c) {
            if (c === idxActivity) return;
            var name = colName != null ? String(colName).trim() : '';
            if (!name) return;
            var val = row[c] != null ? String(row[c]).trim() : '';
            if (val) assignments[name] = val;
          });
          outRows.push({ activity: activity, assignments: assignments });
        });

        if (!outRows.length) { alert('No valid rows found — each row needs an Activity.'); return; }

        log('parsed', { resources: resources.length, rows: outRows.length });

        var raciImportedAt = new Date();
        projRef().set({
          raciMatrix: { resources: resources, rows: outRows },
          raciLastImportedAt: raciImportedAt
        }, { merge: true }).then(function () {
          alert('RACI matrix imported: ' + outRows.length + ' activities x ' + resources.length + ' resources.');
          input.value = '';
          raciResources = resources;
          raciRows = outRows;
          renderRaciTable();
          if (window.drLastUpdated) window.drLastUpdated.render('raciLastUpdated', raciImportedAt);
        }).catch(function (err) {
          error('save failed', err);
          alert('Import failed: ' + (err && err.message ? err.message : err));
        });
      }).catch(function (err) {
        error('read failed', err);
        alert('Import failed: ' + (err && err.message ? err.message : err));
      }).finally(function () {
        if (window.drProgress) window.drProgress.hide();
      });
    });
  }

  // Pages the table's own scroll box up/down by most of a screenful per
  // click — same reasoning as the Gantt chart's directional pad: a long
  // activity list (or, horizontally, a wide resource list) shouldn't
  // require manual scrollbar-dragging or a mouse wheel to page through.
  function scrollRaciByPage(direction) {
    var scrollEl = document.querySelector('#raciCard .raci-table-wrap');
    if (!scrollEl) return;
    scrollEl.scrollBy({ top: direction * scrollEl.clientHeight * 0.6, behavior: 'smooth' });
  }

  function wirePageScroll() {
    var upBtn = document.getElementById('raciPageUp');
    var downBtn = document.getElementById('raciPageDown');
    if (upBtn && !upBtn.__wired) { upBtn.__wired = true; upBtn.addEventListener('click', function () { scrollRaciByPage(-1); }); }
    if (downBtn && !downBtn.__wired) { downBtn.__wired = true; downBtn.addEventListener('click', function () { scrollRaciByPage(1); }); }
  }

  function renderRaciPagination(totalRows, totalPages) {
    var pageInfoEl = document.getElementById('raciPageInfo');
    if (pageInfoEl) {
      pageInfoEl.textContent = totalRows
        ? 'Page ' + raciPage + ' of ' + totalPages + ' (' + totalRows + (totalRows === 1 ? ' row' : ' rows') + ')'
        : '';
    }
    var prevBtn = document.getElementById('raciPagePrev');
    var nextBtn = document.getElementById('raciPageNext');
    if (prevBtn) prevBtn.disabled = raciPage <= 1;
    if (nextBtn) nextBtn.disabled = raciPage >= totalPages;
  }

  function wirePagination() {
    var prevBtn = document.getElementById('raciPagePrev');
    var nextBtn = document.getElementById('raciPageNext');
    if (prevBtn && !prevBtn.__wired) {
      prevBtn.__wired = true;
      prevBtn.addEventListener('click', function () { raciPage--; renderRaciTable(); });
    }
    if (nextBtn && !nextBtn.__wired) {
      nextBtn.__wired = true;
      nextBtn.addEventListener('click', function () { raciPage++; renderRaciTable(); });
    }
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
    wirePageScroll();
    wirePagination();

    auth.onAuthStateChanged(function (user) {
      var email = (user && user.email) || '';
      isOwner = !!email && !!OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
      wireImport();
      loadRaci();
    });

    // renderRaciTable() checks window.drAccess.canViewReport() to decide
    // whether to populate at all — if the Firestore snapshot that
    // triggers it fires before dr-access-control.js finishes resolving
    // role/permissions (a real timing race either way), it renders a
    // permanently empty card with no second chance. Safe to re-run with
    // no arguments (cached module state), so re-run once access is known
    // to be resolved.
    if (window.drAccess) window.drAccess.whenReady().then(renderRaciTable);
  }

  start();
})();
