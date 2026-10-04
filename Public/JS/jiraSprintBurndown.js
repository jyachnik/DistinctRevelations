/* ============================================================================
   Jira Sprint Burndown — remaining story points over the current sprint,
   Ideal vs. Actual, same Chart.js convention as the project-level
   Burndown card (burndown.js) so it reads as the same visual language,
   not a one-off. Read-only; shares window.drJiraData with every other
   Jira card.

   Real version (not built yet): the active sprint and its daily
   remaining-points series would come from Jira's own Sprint Report data
   (or be computed from a daily snapshot the sync function writes) — Jira
   doesn't expose historical burndown directly via the issue list alone.
   Until then this shows one authored sample sprint (Sprint 14, this
   app's sample issues' current sprint) with an illustrative Actual line.
   ============================================================================ */

(function () {
  'use strict';

  var CARD_ID = 'jiraSprintBurndownCard';
  var ACTIVE_SPRINT = 'Sprint 14';

  // Illustrative only — see file header. A slightly-behind-ideal Actual
  // line is the most common real-world shape, so that's what this shows.
  var SAMPLE_DAY_LABELS = ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7', 'Day 8', 'Day 9', 'Day 10'];
  var SAMPLE_ACTUAL = [28, 28, 26, 24, 24, 20, 18, 18, 13, 8];

  var ctx = { userEmail: '', isOwner: false, rows: [] };

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

  function sprintTotalPoints(rows) {
    return rows
      .filter(function (r) { return r.sprint === ACTIVE_SPRINT; })
      .reduce(function (sum, r) { return sum + (r.storyPoints || 0); }, 0);
  }

  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !canvas || typeof window.Chart === 'undefined') return;

    var total = sprintTotalPoints(ctx.rows) || SAMPLE_ACTUAL[0];
    var n = SAMPLE_DAY_LABELS.length;
    var ideal = SAMPLE_DAY_LABELS.map(function (_, i) { return Math.round((total * (n - 1 - i) / (n - 1)) * 10) / 10; });

    if (chartInstance) chartInstance.destroy();
    chartInstance = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: SAMPLE_DAY_LABELS,
        datasets: [
          { label: 'Ideal', data: ideal, borderColor: '#4a3aa7', backgroundColor: '#4a3aa7', pointRadius: 1, pointHoverRadius: 3, borderWidth: 2, tension: 0 },
          { label: 'Actual', data: SAMPLE_ACTUAL, borderColor: '#dd3333', backgroundColor: '#dd3333', pointRadius: 1, pointHoverRadius: 3, borderWidth: 2, tension: 0.1 }
        ]
      },
      options: commonLineOptions('points remaining')
    });

    var sampleNote = document.getElementById('jiraSprintBurndownSampleBanner');
    if (sampleNote) sampleNote.hidden = false; // always illustrative until the real Sprint Report feed exists

    if (window.drInsight) {
      var last = SAMPLE_ACTUAL[SAMPLE_ACTUAL.length - 1], lastIdeal = ideal[ideal.length - 1];
      var diff = Math.round(lastIdeal - last);
      var text = ACTIVE_SPRINT + ': ' + last + ' pts remaining vs. an ideal of ' + lastIdeal + ' — ' +
        (Math.abs(diff) < 1 ? 'tracking almost exactly to plan.' : (diff > 0 ? diff + ' pts ahead of plan.' : Math.abs(diff) + ' pts behind plan.')) +
        ' (sample data)';
      window.drInsight.set(CARD_ID, text);
    }
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    canvas = document.getElementById('jiraSprintBurndownChart');
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
      paint();
    });
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
