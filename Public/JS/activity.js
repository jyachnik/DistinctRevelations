// Public/JS/activity.js – Activity Log for businesses/{biz}/activities
// Read-only report now — no add/edit/delete UI and no separate import of
// its own. Fed entirely by the Schedule (Milestones & Activities) import
// (see gantt.js), which already writes non-milestone rows into this SAME
// "activities" subcollection — there's nothing this card needs that the
// Schedule import doesn't already provide, so the standalone CRUD/import
// path that used to live here was removed rather than left duplicating
// it. Filters (Stage/Responsible/Due Date/Status) replace what the old
// Actions column and add form used to be for.

(function () {
  'use strict';

  var TAG = '[activity]';
  // Read owner email from a global or environment config
  var OWNER_EMAIL =
    (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) ||
    (window.ownerEmail) ||
    '';

  // ---------- helpers ----------

  function getDB() {
    return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore());
  }

  function getAuth() {
    return window.auth || (window.firebase && window.firebase.auth && window.firebase.auth());
  }

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function fmtDate(ts) {
    if (!ts) return '';
    if (window.drDateFmt) return window.drDateFmt.date(ts);
    try {
      var d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toLocaleDateString();
    } catch (e) {
      console.warn(TAG, 'fmtDate failed', e);
      return '';
    }
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // "Ahead" / "On Schedule" / "Behind" — actual % complete vs. where the
  // item should be given how much of its own start->due window has
  // elapsed. Deliberately plain-language, not a raw SPI/EVM figure.
  function computePace(row, completed) {
    if (completed || !window.drRag) return null;

    var due = window.drRag.toJsDate(row.dueDate);
    var start = window.drRag.toJsDate(row.startDate) || window.drRag.toJsDate(row.createdAt);
    if (!due || !start) return null;

    due = window.drRag.dateOnly(due);
    start = window.drRag.dateOnly(start);
    var today = window.drRag.dateOnly(new Date());
    if (due <= start || today <= start) return null;

    var expectedPct = Math.max(0, Math.min(100, ((today - start) / (due - start)) * 100));
    var actualPct = typeof row.progress === 'number' ? row.progress :
      ((row.status || '').toLowerCase() === 'in progress' ? 50 : 0);

    var diff = actualPct - expectedPct;
    if (diff >= 10) return { code: 'ahead', label: 'Ahead of schedule' };
    if (diff <= -10) return { code: 'behind', label: 'Behind schedule' };
    return { code: 'on-track', label: 'On schedule' };
  }

  function resolveBizKey(required) {
    return new Promise(function (resolve) {
      var tries = 0;

      function fromRuntime() {
        return window.BIZ_KEY || window.businessKey || null;
      }

      function fromStorage() {
        try {
          return (
            sessionStorage.getItem('bizKey') ||
            localStorage.getItem('bizKey') ||
            null
          );
        } catch (_) {
          return null;
        }
      }

      function fromURL() {
        try {
          var qs = new URLSearchParams(location.search);
          var k = qs.get('business');
          return k || null;
        } catch (_) {
          return null;
        }
      }

      function attempt() {
        tries++;

        var k = fromRuntime() || fromStorage() || fromURL();
        if (k) {
          window.BIZ_KEY = k;
          window.businessKey = k;
          try {
            sessionStorage.setItem('bizKey', k);
          } catch (_) {}
          return done(k);
        }

        if (typeof window.requireAuth === 'function') {
          window
            .requireAuth(false)
            .then(function (info) {
              if (info && info.businessKey) {
                window.BIZ_KEY = info.businessKey;
                try {
                  sessionStorage.setItem('bizKey', info.businessKey);
                } catch (_) {}
                return done(info.businessKey);
              }
              retry();
            })
            .catch(function () {
              retry();
            });
          return;
        }

        retry();
      }

      function retry() {
        if (!required) return done(null);
        if (tries > 40) {
          console.error(TAG, 'Business key is missing after retries.');
          return done(null);
        }
        setTimeout(attempt, 150);
      }

      function done(k) {
        resolve(k || null);
      }

      attempt();
    });
  }

  // ---------- state + DOM ----------

  var ctx = {
    biz: null,
    proj: null,
    isOwner: false,
    userEmail: '',
    rows: [], // { id, title, description, status, dueDate, responsible, ... }
    sort: { key: 'date', dir: 'desc' },
    filters: { stage: '', responsible: '', dueDate: '', rag: '' },
    page: 1
  };
  var ACTIVITY_PAGE_SIZE = 15;

  var dom = {
    table: null,
    tableBody: null,
    filterStage: null,
    filterResponsible: null,
    filterDueDate: null,
    filterRag: null,
    filterReset: null
  };

  function bindDOM() {
    dom.table = byId('activityTable');
    dom.tableBody =
      (dom.table && dom.table.querySelector('tbody')) ||
      $('#activityTable tbody') ||
      byId('activityTableBody') ||
      $('#activityTable');

    dom.filterStage = byId('activityFilterStage');
    dom.filterResponsible = byId('activityFilterResponsible');
    dom.filterDueDate = byId('activityFilterDueDate');
    dom.filterRag = byId('activityFilterRag');
    dom.filterReset = byId('activityFilterReset');
  }

  // ---------- filters ----------
  // Populated from the actual imported rows' own distinct values, same
  // convention as Quality/Defects Log/Constraints/etc. — not a fixed
  // list, so it only ever offers values that actually exist right now.
  function ragLabelFor(r) {
    var completed = (r.status || '').toLowerCase() === 'completed';
    var jeopardy = window.drRag ? window.drRag.compute(r.createdAt, r.dueDate, completed) : { label: '' };
    return jeopardy.label || '';
  }

  // Most-urgent-first rank for sorting the Status column — the RAG code
  // itself (red/amber/green/done/none) has no natural alphabetical order,
  // so sorting by ragLabelFor's text would group "At risk"/"Overdue"
  // apart from each other despite both being red. This ranks by actual
  // urgency instead.
  var RAG_SORT_RANK = { red: 0, amber: 1, green: 2, done: 3, none: 4 };
  function ragRankFor(r) {
    var completed = (r.status || '').toLowerCase() === 'completed';
    var jeopardy = window.drRag ? window.drRag.compute(r.createdAt, r.dueDate, completed) : { code: 'none' };
    var rank = RAG_SORT_RANK[jeopardy.code];
    return rank == null ? 5 : rank;
  }

  function populateActivityFilters(rows) {
    var fields = [
      { key: 'stage', el: dom.filterStage, get: function (r) { return r.status || ''; } },
      { key: 'responsible', el: dom.filterResponsible, get: function (r) { return r.responsible || ''; } },
      { key: 'dueDate', el: dom.filterDueDate, get: function (r) { return r.dueDate ? fmtDate(r.dueDate) : (r.dueDateText || ''); } },
      { key: 'rag', el: dom.filterRag, get: ragLabelFor }
    ];
    fields.forEach(function (f) {
      if (!f.el) return;
      var current = f.el.value;
      var values = Array.from(
        rows.reduce(function (set, r) {
          var v = (f.get(r) || '').toString().trim();
          if (v) set.add(v);
          return set;
        }, new Set())
      ).sort(function (a, b) { return a.localeCompare(b); });

      var allLabel = f.el.options[0] ? f.el.options[0].textContent : 'All';
      f.el.innerHTML = '<option value="">' + esc(allLabel) + '</option>' +
        values.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
      if (values.indexOf(current) !== -1) f.el.value = current;
    });
  }

  function getFilteredRows(rows) {
    return rows.filter(function (r) {
      return (!ctx.filters.stage || (r.status || '') === ctx.filters.stage) &&
        (!ctx.filters.responsible || (r.responsible || '') === ctx.filters.responsible) &&
        (!ctx.filters.dueDate || (r.dueDate ? fmtDate(r.dueDate) : (r.dueDateText || '')) === ctx.filters.dueDate) &&
        (!ctx.filters.rag || ragLabelFor(r) === ctx.filters.rag);
    });
  }

  function wireActivityFilters() {
    [
      { el: dom.filterStage, key: 'stage' },
      { el: dom.filterResponsible, key: 'responsible' },
      { el: dom.filterDueDate, key: 'dueDate' },
      { el: dom.filterRag, key: 'rag' }
    ].forEach(function (f) {
      if (f.el && !f.el.__wired) {
        f.el.__wired = true;
        f.el.addEventListener('change', function () {
          ctx.filters[f.key] = f.el.value;
          ctx.page = 1;
          render();
        });
      }
    });

    if (dom.filterReset && !dom.filterReset.__wired) {
      dom.filterReset.__wired = true;
      dom.filterReset.addEventListener('click', function () {
        ctx.filters = { stage: '', responsible: '', dueDate: '', rag: '' };
        [dom.filterStage, dom.filterResponsible, dom.filterDueDate, dom.filterRag].forEach(function (el) {
          if (el) el.value = '';
        });
        ctx.page = 1;
        render();
      });
    }
  }

  // ---------- sorting ----------
  function sortedRows(rows) {
    rows = rows.slice();
    var key = ctx.sort && ctx.sort.key;
    var dir = ctx.sort && ctx.sort.dir === 'desc' ? -1 : 1;
    if (!key) return rows;

    rows.sort(function (a, b) {
      var av, bv;

      if (key === 'date') {
        av = a.dueDate || a.dueDateText || '';
        bv = b.dueDate || b.dueDateText || '';

        av = av && av.toDate ? av.toDate() : (av instanceof Date ? av : new Date(av));
        bv = bv && bv.toDate ? bv.toDate() : (bv instanceof Date ? bv : new Date(bv));

        av = isNaN(av.getTime()) ? 0 : av.getTime();
        bv = isNaN(bv.getTime()) ? 0 : bv.getTime();
      } else if (key === 'title') {
        av = (a.title || '').toLowerCase();
        bv = (b.title || '').toLowerCase();
      } else if (key === 'status') {
        av = (a.status || '').toLowerCase();
        bv = (b.status || '').toLowerCase();
      } else if (key === 'responsible') {
        av = (a.responsible || '').toLowerCase();
        bv = (b.responsible || '').toLowerCase();
      } else if (key === 'rag') {
        av = ragRankFor(a);
        bv = ragRankFor(b);
      } else {
        return 0;
      }

      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    return rows;
  }

  // ---------- rendering ----------

  function render() {
    if (!dom.tableBody) return;

    populateActivityFilters(ctx.rows);
    var rows = sortedRows(getFilteredRows(ctx.rows));

    if (!rows || !rows.length) {
      dom.tableBody.innerHTML =
        '<tr><td colspan="5" class="empty">' + (ctx.rows.length ? 'No activities match the selected filters.' : 'No activity logged yet — import the Schedule to populate this.') + '</td></tr>';
      if (window.drInsight) window.drInsight.set('activityPanelCard', '');
      renderActivityPagination(0, 1);
      return;
    }

    // update header sort arrow classes
    if (dom.table) {
      $all('thead th[data-sort]', dom.table).forEach(function (th) {
        var key = th.getAttribute('data-sort');
        th.classList.remove('sorted-asc', 'sorted-desc');
        if (ctx.sort && ctx.sort.key === key) {
          th.classList.add(ctx.sort.dir === 'desc' ? 'sorted-desc' : 'sorted-asc');
        }
      });
    }

    var totalPages = Math.max(1, Math.ceil(rows.length / ACTIVITY_PAGE_SIZE));
    if (ctx.page > totalPages) ctx.page = totalPages;
    if (ctx.page < 1) ctx.page = 1;
    var startIdx = (ctx.page - 1) * ACTIVITY_PAGE_SIZE;
    var pageRows = rows.slice(startIdx, startIdx + ACTIVITY_PAGE_SIZE);

    dom.tableBody.innerHTML = pageRows
      .map(function (r) {
        var title = r.title || '';
        var status = r.status || '';
        var due = r.dueDate ? fmtDate(r.dueDate) : (r.dueDateText || '');

        var completed = (r.status || '').toLowerCase() === 'completed';
        var jeopardy = window.drRag
          ? window.drRag.compute(r.createdAt, r.dueDate, completed)
          : { code: 'none', label: '' };
        var pace = computePace(r, completed);
        var ragCell =
          '<span class="dr-rag dr-rag-' + jeopardy.code + '" title="' + jeopardy.label + '"></span>' +
          '<span class="dr-rag-label">' + jeopardy.label + '</span>' +
          (pace ? '<div class="dr-pace dr-pace-' + pace.code + '">' + pace.label + '</div>' : '');

        var responsible = r.responsible || '';

        return (
          '<tr data-id="' +
          r.id +
          '">' +
          '<td>' +
          esc(title) +
          (r.description ? '<div class="activity-desc">' + esc(r.description) + '</div>' : '') +
          '</td>' +
          '<td>' +
          esc(status) +
          '</td>' +
          '<td title="' + esc(responsible) + '">' +
          esc(responsible) +
          '</td>' +
          '<td>' +
          esc(due) +
          '</td>' +
          '<td class="dr-rag-cell">' +
          ragCell +
          '</td>' +
          '</tr>'
        );
      })
      .join('');

    if (window.drInsight) {
      var completedCount = rows.filter(function (r) { return (r.status || '').toLowerCase() === 'completed'; }).length;
      var atRisk = rows.filter(function (r) {
        var completed = (r.status || '').toLowerCase() === 'completed';
        if (completed) return false;
        var j = window.drRag ? window.drRag.compute(r.createdAt, r.dueDate, completed) : { code: 'none' };
        return j.code === 'red' || j.code === 'amber';
      });
      var text = rows.length + ' activit' + (rows.length === 1 ? 'y' : 'ies') + ' logged, ' + completedCount + ' completed.';
      if (atRisk.length) {
        text += ' ' + atRisk.length + ' open item' + (atRisk.length === 1 ? ' is' : 's are') + ' at risk on schedule' +
          (atRisk[0].title ? ', e.g. "' + atRisk[0].title + '".' : '.');
      } else if (rows.length > completedCount) {
        text += ' Remaining open items are on track.';
      }
      window.drInsight.set('activityPanelCard', text);
    }

    renderActivityPagination(rows.length, totalPages);
  }

  function renderActivityPagination(totalRows, totalPages) {
    var pageInfoEl = byId('activityPageInfo');
    if (pageInfoEl) {
      pageInfoEl.textContent = totalRows
        ? 'Page ' + ctx.page + ' of ' + totalPages + ' (' + totalRows + (totalRows === 1 ? ' row' : ' rows') + ')'
        : '';
    }
    var prevBtn = byId('activityPagePrev');
    var nextBtn = byId('activityPageNext');
    if (prevBtn) prevBtn.disabled = ctx.page <= 1;
    if (nextBtn) nextBtn.disabled = ctx.page >= totalPages;
  }

  function bindActivityPagination() {
    var prevBtn = byId('activityPagePrev');
    var nextBtn = byId('activityPageNext');
    if (prevBtn && !prevBtn.__wired) {
      prevBtn.__wired = true;
      prevBtn.addEventListener('click', function () {
        ctx.page--;
        render();
      });
    }
    if (nextBtn && !nextBtn.__wired) {
      nextBtn.__wired = true;
      nextBtn.addEventListener('click', function () {
        ctx.page++;
        render();
      });
    }
  }

  function bindSortHeaders() {
    if (!dom.table) return;
    $all('thead th[data-sort]', dom.table).forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (!key) return;

        if (ctx.sort && ctx.sort.key === key) {
          ctx.sort.dir = ctx.sort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          ctx.sort = { key: key, dir: 'asc' };
        }
        ctx.page = 1;
        render();
      });
    });
  }

  // ---------- Firestore subscription ----------
  // Read-only: subscribes to businesses/{biz}/activities (written by the
  // Schedule import in gantt.js) and renders whatever's there. No form,
  // no per-row edit/delete, no separate import — see the file header.

  function subscribe(biz, user) {
    var db = getDB();
    if (!db) {
      console.error(TAG, 'Firestore not available');
      return;
    }

    var email = (user && user.email ? user.email : '').toLowerCase();
    ctx.biz = biz;
    // Multi-project cutover — every business always has at least the
    // auto-created 'default' project (dashboard-business-loader.js
    // guarantees window.PROJECT_KEY is set by the time this runs).
    ctx.proj = window.PROJECT_KEY || 'default';
    ctx.userEmail = email;
    ctx.isOwner = email === OWNER_EMAIL;

    var panel = document.querySelector('.card.activity-panel');
    if (panel) panel.classList.toggle('owner', ctx.isOwner);

    console.log(TAG, 'panel owner flag', {
      email: ctx.userEmail,
      isOwner: ctx.isOwner,
      hasPanel: !!panel
    });

    var col = db
      .collection('businesses')
      .doc(biz)
      .collection('projects')
      .doc(ctx.proj || 'default')
      .collection('activities');

    col.orderBy('createdAt', 'desc').onSnapshot(
      function (snap) {
        var rows = [];
        snap.forEach(function (doc) {
          var data = doc.data() || {};

          function normalizeStatus(s) {
            s = (s || '').toLowerCase().trim();
            if (!s) return '';
            if (s === 'not started') return 'Not Started';
            if (s === 'in progress') return 'In Progress';
            if (s === 'completed' || s === 'complete') return 'Completed';
            return s.charAt(0).toUpperCase() + s.slice(1);
          }

          rows.push({
            id: doc.id,
            title: data.title || data.activity || '',
            description: data.description || data.desc || '',
            status: normalizeStatus(data.status || ''),
            responsible: data.responsible || '',
            dueDate: data.dueDate || data.due || null,
            dueDateText: data.dueDateText || '',
            startDate: data.startDate || null,
            progress: data.progress,
            changeLog: data.changeLog || [],
            createdAt: data.createdAt || null,
            createdBy: data.createdBy || ''
          });
        });
        ctx.rows = rows;
        render();
      },
      function (err) {
        console.error(TAG, 'Activity snapshot failed', err);
      }
    );
  }

  // ---------- boot ----------

  function start() {
    var auth = getAuth();
    if (!auth) {
      console.error(TAG, 'Auth not available');
      return;
    }

    bindDOM();
    bindSortHeaders();
    bindActivityPagination();
    wireActivityFilters();

    auth.onAuthStateChanged(function (user) {
      if (!user) {
        ctx.rows = [];
        render();
        return;
      }

      resolveBizKey(true).then(function (biz) {
        if (!biz) return;
        subscribe(biz, user);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
