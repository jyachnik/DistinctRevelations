/* ============================================================================
   Jira Velocity — completed story points per closed sprint, plus the
   running average, same bar+dashed-average-line convention as the
   project-level Velocity chart (burndown.js's renderVelocity). Read-only;
   shares window.drJiraData with every other Jira card.

   Real version (not built yet): Jira's Sprint Report / Agile API gives
   "completed points" per closed sprint directly. The current sample
   issue set only has 3 sprints (mostly not yet Done), too thin for a
   meaningful trend line, so this shows its own illustrative closed-
   sprint history instead — same reasoning as Sprint Burndown's sample
   data, flagged the same way.
   ============================================================================ */

(function () {
  'use strict';

  var CARD_ID = 'jiraVelocityCard';

  var SAMPLE_SPRINTS = ['Sprint 10', 'Sprint 11', 'Sprint 12', 'Sprint 13'];
  var SAMPLE_COMPLETED = [19, 23, 20, 26];

  var ctx = { userEmail: '', isOwner: false };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var card, canvas, chartInstance;

  function commonLineOptions(yLabel) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { beginAtZero: true, title: { display: true, text: yLabel, font: { size: 11 } }, grid: { color: '#e0e0e0' } }
      }
    };
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !canvas || typeof window.Chart === 'undefined') return;

    var avg = SAMPLE_COMPLETED.reduce(function (a, b) { return a + b; }, 0) / SAMPLE_COMPLETED.length;
    var avgLine = SAMPLE_COMPLETED.map(function () { return avg; });

    if (chartInstance) chartInstance.destroy();
    chartInstance = new window.Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: SAMPLE_SPRINTS,
        datasets: [
          { type: 'bar', label: 'Points completed', data: SAMPLE_COMPLETED, backgroundColor: '#7d5fc4', order: 2 },
          { type: 'line', label: 'Average velocity (' + avg.toFixed(1) + ')', data: avgLine, borderColor: '#dd3333', borderDash: [6, 4], pointRadius: 0, borderWidth: 3, tension: 0, order: 1 }
        ]
      },
      options: commonLineOptions('points completed')
    });

    var sampleNote = document.getElementById('jiraVelocitySampleBanner');
    if (sampleNote) sampleNote.hidden = false; // always illustrative until the real Sprint Report feed exists

    if (window.drInsight) {
      var last = SAMPLE_COMPLETED[SAMPLE_COMPLETED.length - 1];
      var text = 'Average velocity ' + avg.toFixed(1) + ' pts/sprint over the last ' + SAMPLE_COMPLETED.length +
        ' sprints; most recent (' + SAMPLE_SPRINTS[SAMPLE_SPRINTS.length - 1] + ') completed ' + last + ' pts. (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    canvas = document.getElementById('jiraVelocityChart');
    var user = (window.auth && window.auth.currentUser) ||
      (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function applyAccess() { paint(); }

  function init() {
    detectContext();
    if (!card || !canvas) return;
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
