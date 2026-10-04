/* ============================================================================
   Jira Epic Progress — percent of each epic's child issues that are Done,
   by story points. Read-only; shares window.drJiraData with every other
   Jira card. Reuses the same progress-bar markup/CSS as Project Progress
   (projectProgress.css) rather than inventing a second bar style.
   ============================================================================ */

(function () {
  'use strict';

  var CARD_ID = 'jiraEpicProgressCard';

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

  var card, list;

  function epicRowHtml(epic, pct, donePoints, totalPoints, doneCount, totalCount) {
    return '<div class="jira-epic-row">' +
      '<div class="jira-epic-row-head">' +
        '<span class="jira-epic-key">' + esc(epic.key) + '</span>' +
        '<span class="jira-epic-title">' + esc(epic.summary) + '</span>' +
        '<span class="jira-epic-pct">' + pct + '%</span>' +
      '</div>' +
      '<div class="progress-bar-track">' +
        '<div class="progress-bar-fill progress-bar-fill-tasks" style="width:' + pct + '%"></div>' +
        '<span class="progress-bar-label">' + pct + '%</span>' +
      '</div>' +
      '<div class="jira-epic-row-foot">' + doneCount + ' of ' + totalCount + ' issues done (' + donePoints + ' of ' + totalPoints + ' pts)</div>' +
    '</div>';
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !list) return;

    var banner = document.getElementById('jiraEpicProgressSampleBanner');
    if (banner) banner.hidden = !ctx.usingSample;

    var epics = ctx.rows.filter(function (r) { return r.type === 'Epic'; });
    var children = ctx.rows.filter(function (r) { return r.type !== 'Epic' && r.epicLink; });

    if (!epics.length) {
      list.innerHTML = '<div class="metrics-empty">No epics found.</div>';
      if (window.drInsight) window.drInsight.set(CARD_ID, '');
      return;
    }

    list.innerHTML = epics.map(function (epic) {
      var kids = children.filter(function (c) { return c.epicLink === epic.key; });
      var totalPoints = kids.reduce(function (sum, c) { return sum + (c.storyPoints || 0); }, 0);
      var donePoints = kids.filter(function (c) { return c.status === 'Done'; }).reduce(function (sum, c) { return sum + (c.storyPoints || 0); }, 0);
      var doneCount = kids.filter(function (c) { return c.status === 'Done'; }).length;
      var pct = totalPoints ? Math.round((donePoints / totalPoints) * 100) : 0;
      return epicRowHtml(epic, pct, donePoints, totalPoints, doneCount, kids.length);
    }).join('');

    if (window.drInsight) {
      var overallDone = 0, overallTotal = 0;
      epics.forEach(function (epic) {
        var kids = children.filter(function (c) { return c.epicLink === epic.key; });
        overallTotal += kids.reduce(function (sum, c) { return sum + (c.storyPoints || 0); }, 0);
        overallDone += kids.filter(function (c) { return c.status === 'Done'; }).reduce(function (sum, c) { return sum + (c.storyPoints || 0); }, 0);
      });
      var pct = overallTotal ? Math.round((overallDone / overallTotal) * 100) : 0;
      var text = epics.length + ' epic' + (epics.length === 1 ? '' : 's') + ' tracked, ' + pct + '% of total points done across all of them.';
      if (ctx.usingSample) text += ' (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    list = document.getElementById('jiraEpicProgressList');
    var user = (window.auth && window.auth.currentUser) ||
      (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function applyAccess() { paint(); }

  function init() {
    detectContext();
    if (!card || !list || !window.drJiraData) return;
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
