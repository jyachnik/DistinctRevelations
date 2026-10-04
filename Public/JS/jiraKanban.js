/* ============================================================================
   Jira Kanban Board — the same issues as the Backlog Tracker, grouped
   into columns by status instead of a sortable table. Read-only, same as
   every Jira-sourced card (data comes FROM Jira, never written here).
   Shares window.drJiraData (see jiraData.js) with the Backlog Tracker and
   every other Jira card — one listener, one sample set, no drift.
   ============================================================================ */

(function () {
  'use strict';

  var CARD_ID = 'jiraKanbanCard';
  var COLUMNS = ['To Do', 'In Progress', 'In Review', 'Done'];
  var TYPE_ICON = { Epic: '🟣', Story: '🟢', Task: '🔵', Bug: '🔴' };
  var PRIORITY_CLASS = { Highest: 'severity-high', High: 'severity-high', Medium: 'severity-medium', Low: 'severity-unknown' };

  var ctx = { userEmail: '', isOwner: false, rows: [], usingSample: true };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  var card, board;

  function issueCardHtml(r) {
    var pClass = PRIORITY_CLASS[r.priority] || 'severity-unknown';
    return '<div class="jira-kanban-card" data-id="' + esc(r.id) + '">' +
      '<div class="jira-kanban-card-top">' +
        '<span class="jira-kanban-key">' + esc(r.key) + '</span>' +
        '<span class="jira-kanban-type" title="' + esc(r.type) + '">' + (TYPE_ICON[r.type] || '⚪') + '</span>' +
      '</div>' +
      '<div class="jira-kanban-summary">' + esc(r.summary) + '</div>' +
      '<div class="jira-kanban-card-bottom">' +
        '<span class="severity-badge ' + pClass + '">' + esc(r.priority || '—') + '</span>' +
        (r.storyPoints != null ? '<span class="jira-kanban-points">' + esc(r.storyPoints) + ' pts</span>' : '') +
        '<span class="jira-kanban-assignee">' + esc(r.assignee || 'Unassigned') + '</span>' +
      '</div>' +
    '</div>';
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !board) return;

    var banner = document.getElementById('jiraKanbanSampleBanner');
    if (banner) banner.hidden = !ctx.usingSample;

    board.innerHTML = COLUMNS.map(function (col) {
      var issues = ctx.rows.filter(function (r) { return r.status === col; });
      return '<div class="jira-kanban-column">' +
        '<div class="jira-kanban-column-header">' + esc(col) + ' <span class="jira-kanban-count">' + issues.length + '</span></div>' +
        '<div class="jira-kanban-column-body">' +
          (issues.length ? issues.map(issueCardHtml).join('') : '<div class="jira-kanban-empty">No issues</div>') +
        '</div>' +
      '</div>';
    }).join('');

    if (window.drInsight) {
      var byCol = COLUMNS.map(function (col) {
        return ctx.rows.filter(function (r) { return r.status === col; }).length;
      });
      var text = ctx.rows.length + ' issue' + (ctx.rows.length === 1 ? '' : 's') + ' — ' +
        COLUMNS.map(function (col, i) { return byCol[i] + ' ' + col; }).join(', ') + '.';
      if (ctx.usingSample) text += ' (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    board = document.getElementById('jiraKanbanBoard');
    var user = (window.auth && window.auth.currentUser) ||
      (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function applyAccess() { paint(); }

  function init() {
    detectContext();
    if (!card || !board || !window.drJiraData) return;
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
