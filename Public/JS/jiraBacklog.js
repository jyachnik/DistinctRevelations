/* ============================================================================
   Jira Backlog Tracker — a read-only mirror of a connected Jira project's
   issues. Unlike every other card in this app, this one has NO add/edit/
   delete UI at all: the data comes FROM Jira, not typed in here.

   Data comes from window.drJiraData (see jiraData.js — the one shared
   listener + sample set every Jira-sourced card subscribes to, so this
   file never talks to Firestore or holds its own copy of the sample
   data). Fields (matching Jira's own naming where there's a direct
   equivalent): key, summary, type, status, assignee, priority,
   storyPoints, sprint, dueDate.
   ============================================================================ */

(function () {
  'use strict';

  var CARD_ID = 'jiraBacklogCard';
  var PAGE_SIZE = 15;

  var ctx = {
    userEmail: '', isOwner: false,
    rows: [], usingSample: true, sort: { key: 'key', dir: 'asc' }, page: 1
  };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var TYPES = ['Epic', 'Story', 'Task', 'Bug'];
  var STATUSES = ['To Do', 'In Progress', 'In Review', 'Done'];

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function toDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    var d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(v) {
    var d = toDate(v);
    if (!d) return '—';
    return window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString();
  }

  function statusBadgeClass(s) {
    if (s === 'Done') return 'severity-low';
    if (s === 'To Do') return 'severity-unknown';
    return 'severity-medium'; // In Progress, In Review
  }

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  var card, tbody, fStatus, fType, fAssignee;

  function fillSelect(sel, placeholder, values) {
    if (!sel || sel.options.length) return;
    var o0 = document.createElement('option');
    o0.value = ''; o0.textContent = placeholder;
    sel.appendChild(o0);
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    });
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function sortValue(r, key) {
    if (key === 'storyPoints') return r.storyPoints == null ? -1 : r.storyPoints;
    return String(r[key] || '').toLowerCase();
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    var usingSample = ctx.usingSample;
    var banner = document.getElementById('jiraBacklogSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var source = ctx.rows;

    // Assignee filter options depend on what's actually in the data, so
    // (re)built here rather than from a fixed list like Status/Type.
    if (fAssignee && !fAssignee.dataset.builtFor) fAssignee.dataset.builtFor = '';
    var assignees = Array.from(new Set(source.map(function (r) { return r.assignee; }).filter(Boolean))).sort();
    var assigneeKey = assignees.join('|');
    if (fAssignee && fAssignee.dataset.builtFor !== assigneeKey) {
      var keep = fAssignee.value;
      fillSelectReset(fAssignee, 'All Assignees', assignees);
      fAssignee.value = keep;
      fAssignee.dataset.builtFor = assigneeKey;
    }

    var fs = fStatus ? fStatus.value : '', ft = fType ? fType.value : '', fa = fAssignee ? fAssignee.value : '';
    var rows = source.filter(function (r) {
      return (!fs || r.status === fs) && (!ft || r.type === ft) && (!fa || r.assignee === fa);
    });

    var key = ctx.sort.key, dir = ctx.sort.dir === 'desc' ? -1 : 1;
    rows = rows.slice().sort(function (a, b) {
      var av = sortValue(a, key), bv = sortValue(b, key);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    var totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (ctx.page > totalPages) ctx.page = totalPages;
    if (ctx.page < 1) ctx.page = 1;
    var pageRows = rows.slice((ctx.page - 1) * PAGE_SIZE, ctx.page * PAGE_SIZE);

    var info = document.getElementById('jiraBacklogPageInfo');
    var prev = document.getElementById('jiraBacklogPagePrev');
    var next = document.getElementById('jiraBacklogPageNext');
    if (info) info.textContent = 'Page ' + ctx.page + ' of ' + totalPages + ' (' + rows.length + (rows.length === 1 ? ' issue' : ' issues') + ')';
    if (prev) prev.disabled = ctx.page <= 1;
    if (next) next.disabled = ctx.page >= totalPages;

    document.querySelectorAll('#jiraBacklogTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === ctx.sort.key) th.classList.add(ctx.sort.dir);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="metrics-empty">No issues match the selected filters.</td></tr>';
      if (window.drInsight) window.drInsight.set(CARD_ID, '');
      return;
    }

    tbody.innerHTML = pageRows.map(function (r) {
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td>' + esc(r.key) + '</td>' +
        '<td class="wrap-text">' + esc(r.summary) + '</td>' +
        '<td>' + esc(r.type) + '</td>' +
        '<td><span class="severity-badge ' + statusBadgeClass(r.status) + '">' + esc(r.status || '—') + '</span></td>' +
        '<td>' + esc(r.priority || '—') + '</td>' +
        '<td>' + esc(r.assignee || 'Unassigned') + '</td>' +
        '<td>' + (r.storyPoints == null ? '—' : esc(r.storyPoints)) + '</td>' +
        '<td>' + esc(r.sprint || '—') + '</td>' +
        '</tr>';
    }).join('');

    if (window.drInsight) {
      var done = rows.filter(function (r) { return r.status === 'Done'; });
      var inProgress = rows.filter(function (r) { return r.status === 'In Progress' || r.status === 'In Review'; });
      var points = rows.reduce(function (sum, r) { return sum + (r.storyPoints || 0); }, 0);
      var text = rows.length + ' issue' + (rows.length === 1 ? '' : 's') + ' (' + points + ' pts total), ' +
        done.length + ' done, ' + inProgress.length + ' in progress.';
      if (usingSample) text += ' (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  function fillSelectReset(sel, placeholder, values) {
    sel.innerHTML = '';
    fillSelect(sel, placeholder, values);
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function bindEvents() {
    function onFilter() { ctx.page = 1; paint(); }
    [fStatus, fType, fAssignee].forEach(function (s) { if (s) s.addEventListener('change', onFilter); });
    var reset = $('#jiraBacklogFilterReset');
    if (reset) reset.addEventListener('click', function () {
      [fStatus, fType, fAssignee].forEach(function (s) { if (s) s.value = ''; });
      onFilter();
    });

    var prev = document.getElementById('jiraBacklogPagePrev');
    var next = document.getElementById('jiraBacklogPageNext');
    if (prev) prev.addEventListener('click', function () { ctx.page--; paint(); });
    if (next) next.addEventListener('click', function () { ctx.page++; paint(); });

    var thead = document.querySelector('#jiraBacklogTable thead');
    if (thead) thead.addEventListener('click', function (ev) {
      var th = ev.target.closest('th[data-sort]');
      if (!th) return;
      var key = th.getAttribute('data-sort');
      if (ctx.sort.key === key) ctx.sort.dir = ctx.sort.dir === 'asc' ? 'desc' : 'asc';
      else { ctx.sort.key = key; ctx.sort.dir = 'asc'; }
      paint();
    });
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    tbody = $('#jiraBacklogTable tbody');
    fStatus = $('#jiraBacklogFilterStatus'); fType = $('#jiraBacklogFilterType'); fAssignee = $('#jiraBacklogFilterAssignee');

    var user = (window.auth && window.auth.currentUser) ||
      (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function applyAccess() { paint(); }

  function init() {
    detectContext();
    if (!card || !tbody || !window.drJiraData) return;
    fillSelect(fStatus, 'All Status', STATUSES);
    fillSelect(fType, 'All Types', TYPES);
    bindEvents();
    window.drJiraData.subscribe(function (state) {
      ctx.rows = state.issues;
      ctx.usingSample = state.usingSample;
      paint();
    });
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
