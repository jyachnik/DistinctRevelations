/* ============================================================================
   Three Agile PMI artifacts built on the simple-doc-cards.js factory —
   each a single owner-edited document, sample content until replaced:
     Product Vision Statement, Definition of Ready, Definition of Done
   ============================================================================ */

(function () {
  'use strict';
  if (!window.drBuildSimpleDocCard) { console.error('[agile-doc-cards] simple-doc-cards.js must load first'); return; }

  window.drBuildSimpleDocCard({
    cardId: 'productVisionCard', collectionName: 'productVision', bodyPrefix: 'pv', noun: 'product vision statement',
    fields: ['problemStatement', 'vision', 'targetUsers', 'successMeasures'],
    labels: {
      problemStatement: 'Problem / Opportunity',
      vision: 'Vision Statement',
      targetUsers: 'Target Users / Beneficiaries',
      successMeasures: 'Success Measures'
    },
    sample: {
      problemStatement: 'Field crews currently track outage status on paper and in text messages, so dispatch has no reliable, up-to-date view of which repairs are in progress.',
      vision: 'A single real-time dashboard where every crew update is visible to dispatch within minutes, cutting average outage resolution reporting time in half.',
      targetUsers: 'Dispatch coordinators, field crew leads, and the operations manager.',
      successMeasures: 'Average time from "repair started" to "dispatch notified" under 5 minutes; 90% of crews using the app daily within one month of rollout.'
    }
  });

  window.drBuildSimpleDocCard({
    cardId: 'definitionOfReadyCard', collectionName: 'definitionOfReady', bodyPrefix: 'dor', noun: 'Definition of Ready',
    fields: ['criteria'],
    labels: { criteria: 'A backlog item is Ready to pull into a sprint when…' },
    sample: {
      criteria: '• The user story has a clear, testable acceptance criteria.\n• It is estimated by the team (story points assigned).\n• Any design/UX mockups it depends on are approved.\n• It has no open blocking dependency on another unfinished item.\n• It is small enough to complete within one sprint.'
    }
  });

  window.drBuildSimpleDocCard({
    cardId: 'definitionOfDoneCard', collectionName: 'definitionOfDone', bodyPrefix: 'dod', noun: 'Definition of Done',
    fields: ['criteria'],
    labels: { criteria: 'An increment is Done when…' },
    sample: {
      criteria: '• Code is written, reviewed, and merged.\n• Automated tests pass and cover the new behavior.\n• It has been demoed to the Product Owner and accepted.\n• Documentation (if applicable) is updated.\n• It is deployed to the staging environment with no known defects.'
    }
  });
})();
