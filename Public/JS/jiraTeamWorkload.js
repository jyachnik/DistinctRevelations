/* ============================================================================
   Jira Team Workload — open (not-Done) story points per assignee, as a
   horizontal bar chart. Same Chart.js convention as the other Jira
   charts. Read-only; shares window.drJiraData with every other Jira
   card.
   ============================================================================ */

(function () {
  'use strict';

  var CARD_ID = 'jiraTeamWorkloadCard';

  var ctx = { userEmail: '', isOwner: false, rows: [], usingSample: true };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var card, canvas, chartInstance;

  function commonBarOptions(xLabel) {
    return {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, title: { display: true, text: xLabel, font: { size: 11 } }, grid: { color: '#e0e0e0' } },
        y: { grid: { display: false }, ticks: { font: { size: 11 } } }
      }
    };
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !canvas || typeof window.Chart === 'undefined') return;

    var banner = document.getElementById('jiraTeamWorkloadSampleBanner');
    if (banner) banner.hidden = !ctx.usingSample;

    var open = ctx.rows.filter(function (r) { return r.type !== 'Epic' && r.status !== 'Done'; });
    var byAssignee = {};
    open.forEach(function (r) {
      var name = r.assignee || 'Unassigned';
      byAssignee[name] = (byAssignee[name] || 0) + (r.storyPoints || 0);
    });
    var names = Object.keys(byAssignee).sort(function (a, b) { return byAssignee[b] - byAssignee[a]; });
    var points = names.map(function (n) { return byAssignee[n]; });

    if (chartInstance) chartInstance.destroy();
    chartInstance = new window.Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: names,
        datasets: [{ label: 'Open points', data: points, backgroundColor: '#2f9e44' }]
      },
      options: commonBarOptions('open story points')
    });

    if (window.drInsight) {
      var text = names.length ? (names[0] + ' has the most open work (' + points[0] + ' pts across ' + names.length + ' people).') : 'No open issues.';
      if (ctx.usingSample) text += ' (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    canvas = document.getElementById('jiraTeamWorkloadChart');
    var user = (window.auth && window.auth.currentUser) ||
      (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function applyAccess() { paint(); }

  function init() {
    detectContext();
    if (!card || !canvas || !window.drJiraData) return;
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
