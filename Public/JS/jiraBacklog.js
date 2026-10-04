/* ============================================================================
   Jira Backlog Tracker — a read-only mirror of a connected Jira project's
   issues. Unlike every other card in this app, this one has NO add/edit/
   delete UI at all: the data comes FROM Jira, not typed in here. Until a
   real Jira connection exists, it shows clearly-labeled sample issues with
   the exact shape real synced data will have, so swapping in the live
   source later is a data-layer change only — the rendering/filtering/
   sorting code below doesn't change.

   Real version (not built yet): a scheduled Cloud Function polls the Jira
   REST API (same pattern as the existing daily overdue-task digest) and
   writes normalized issues into
   businesses/{biz}/projects/{proj}/jiraIssues/{issueKey}. This file
   already listens on that collection — the moment it has documents, the
   sample banner disappears and real issues take over automatically.
   Fields (matching Jira's own naming where there's a direct equivalent):
   key, summary, type, status, statusCategory, assignee, priority,
   storyPoints, sprint, dueDate.
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[jiraBacklog]';
  var CARD_ID = 'jiraBacklogCard';
  var PAGE_SIZE = 15;

  var ctx = {
    biz: null, proj: null, userEmail: '', isOwner: false,
    rows: [], sort: { key: 'key', dir: 'asc' }, page: 1
  };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var TYPES = ['Epic', 'Story', 'Task', 'Bug'];
  var STATUSES = ['To Do', 'In Progress', 'In Review', 'Done'];

  // Sample issues — shown only until a real Jira sync populates
  // jiraIssues. ids start with "sample-"; this card never writes to
  // Firestore at all (read-only), so there's no action to refuse them
  // from, but the prefix keeps the convention consistent with every
  // other sample-data card in this app.
  var SAMPLE_ISSUES = [
    { id: 'sample-1', key: 'PWR-101', summary: 'Define MVP scope for Phase I rollout', type: 'Epic', status: 'In Progress', priority: 'High', assignee: 'J. Alvarez', storyPoints: null, sprint: '—', dueDate: new Date(2026, 10, 14) },
    { id: 'sample-2', key: 'PWR-102', summary: 'Integrate GPS feed with asset tracking service', type: 'Story', status: 'In Progress', priority: 'High', assignee: 'M. Chen', storyPoints: 8, sprint: 'Sprint 14', dueDate: new Date(2026, 9, 24) },
    { id: 'sample-3', key: 'PWR-103', summary: 'Set up email notification service', type: 'Story', status: 'Done', priority: 'Medium', assignee: 'S. Patel', storyPoints: 5, sprint: 'Sprint 13', dueDate: new Date(2026, 9, 10) },
    { id: 'sample-4', key: 'PWR-104', summary: 'Fix null pointer on empty asset list', type: 'Bug', status: 'To Do', priority: 'Highest', assignee: 'M. Chen', storyPoints: 2, sprint: 'Sprint 14', dueDate: new Date(2026, 9, 22) },
    { id: 'sample-5', key: 'PWR-105', summary: 'Design security dashboard wireframes', type: 'Task', status: 'Done', priority: 'Medium', assignee: 'R. Nolan', storyPoints: 3, sprint: 'Sprint 13', dueDate: new Date(2026, 9, 8) },
    { id: 'sample-6', key: 'PWR-106', summary: 'Underestimated integration time with third-party GPS vendor', type: 'Bug', status: 'In Review', priority: 'Highest', assignee: 'J. Alvarez', storyPoints: 5, sprint: 'Sprint 14', dueDate: new Date(2026, 9, 25) },
    { id: 'sample-7', key: 'PWR-107', summary: 'Build resource-capacity API endpoint', type: 'Story', status: 'In Progress', priority: 'Medium', assignee: 'S. Patel', storyPoints: 5, sprint: 'Sprint 14', dueDate: new Date(2026, 9, 27) },
    { id: 'sample-8', key: 'PWR-108', summary: 'Write UAT test cases for asset tracking', type: 'Task', status: 'To Do', priority: 'Medium', assignee: 'R. Nolan', storyPoints: 3, sprint: 'Sprint 15', dueDate: new Date(2026, 10, 3) },
    { id: 'sample-9', key: 'PWR-109', summary: 'Specialized AI/security resource availability', type: 'Epic', status: 'To Do', priority: 'High', assignee: 'J. Alvarez', storyPoints: null, sprint: '—', dueDate: new Date(2026, 11, 1) },
    { id: 'sample-10', key: 'PWR-110', summary: 'Reduce dashboard initial load time', type: 'Task', status: 'To Do', priority: 'Low', assignee: 'M. Chen', storyPoints: 2, sprint: 'Sprint 15', dueDate: new Date(2026, 10, 5) },
    { id: 'sample-11', key: 'PWR-111', summary: 'Login session expires too early on mobile', type: 'Bug', status: 'Done', priority: 'Medium', assignee: 'S. Patel', storyPoints: 1, sprint: 'Sprint 13', dueDate: new Date(2026, 9, 9) },
    { id: 'sample-12', key: 'PWR-112', summary: 'Vendor integration deadline for Phase I MVP', type: 'Story', status: 'In Review', priority: 'High', assignee: 'R. Nolan', storyPoints: 8, sprint: 'Sprint 14', dueDate: new Date(2026, 9, 26) }
  ];

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function getDB() {
    return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore());
  }
  function projDocRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }
  function issuesRef() {
    var p = projDocRef();
    return p ? p.collection('jiraIssues') : null;
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

    var usingSample = !ctx.rows.length;
    var banner = document.getElementById('jiraBacklogSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var source = usingSample ? SAMPLE_ISSUES : ctx.rows;

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

  function listen() {
    var ref = issuesRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.rows = rows;
      paint();
    }, function (err) {
      console.warn(ns, 'listen error (expected if not a project member, or no Jira sync yet)', err && err.code);
    });
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    tbody = $('#jiraBacklogTable tbody');
    fStatus = $('#jiraBacklogFilterStatus'); fType = $('#jiraBacklogFilterType'); fAssignee = $('#jiraBacklogFilterAssignee');

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    var user = (window.auth && window.auth.currentUser) ||
      (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function applyAccess() { paint(); }

  function init() {
    detectContext();
    if (!ctx.biz || !card || !tbody) return;
    fillSelect(fStatus, 'All Status', STATUSES);
    fillSelect(fType, 'All Types', TYPES);
    bindEvents();
    listen();
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
