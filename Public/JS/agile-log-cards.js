/* ============================================================================
   Five Agile PMI artifacts built on the simple-log-cards.js factory — each
   a real-time, owner-maintained list of dated entries, sample rows until a
   real one exists:
     Release Plan, Daily Stand-up Notes, Sprint Review/Demo Notes,
     Sprint Retrospective Notes, Release Notes
   ============================================================================ */

(function () {
  'use strict';
  if (!window.drBuildSimpleLogCard) { console.error('[agile-log-cards] simple-log-cards.js must load first'); return; }

  function daysFromNow(n) { var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; }

  window.drBuildSimpleLogCard({
    cardId: 'releasePlanCard', collectionName: 'releasePlan', bodyPrefix: 'rp', dateField: 'targetDate',
    fields: [
      { key: 'releaseName', label: 'Release', type: 'text' },
      { key: 'targetDate', label: 'Target Date', type: 'date' },
      { key: 'status', label: 'Status', type: 'select' },
      { key: 'scopeSummary', label: 'Scope / Items Included', type: 'textarea' }
    ],
    sample: [
      { id: 'sample-1', releaseName: 'Release 1.0 — Field Intake', targetDate: daysFromNow(-20), status: 'Released', scopeSummary: 'Outage intake form, crew assignment, basic dispatch view.' },
      { id: 'sample-2', releaseName: 'Release 1.1 — Mobile Updates', targetDate: daysFromNow(14), status: 'In Progress', scopeSummary: 'Mobile status updates from the field, photo attachments.' },
      { id: 'sample-3', releaseName: 'Release 1.2 — Reporting', targetDate: daysFromNow(60), status: 'Planned', scopeSummary: 'Resolution-time reporting, crew workload dashboard.' }
    ]
  });

  window.drBuildSimpleLogCard({
    cardId: 'dailyStandupCard', collectionName: 'dailyStandups', bodyPrefix: 'ds', dateField: 'date',
    fields: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'attendees', label: 'Attendees', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
      { key: 'blockers', label: 'Blockers', type: 'textarea' }
    ],
    sample: [
      { id: 'sample-1', date: daysFromNow(-1), attendees: 'Full team', notes: 'Mobile status-update screen on track for demo Friday.', blockers: 'Waiting on design approval for the photo-attachment flow.' },
      { id: 'sample-2', date: daysFromNow(-2), attendees: 'Full team minus QA', notes: 'Dispatch view filtering finished and merged.', blockers: 'None.' }
    ]
  });

  window.drBuildSimpleLogCard({
    cardId: 'sprintReviewCard', collectionName: 'sprintReviews', bodyPrefix: 'sr', dateField: 'date',
    fields: [
      { key: 'sprintLabel', label: 'Sprint', type: 'text' },
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'completedWork', label: 'What Was Completed / Demoed', type: 'textarea' },
      { key: 'stakeholderFeedback', label: 'Stakeholder Feedback', type: 'textarea' }
    ],
    sample: [
      { id: 'sample-1', sprintLabel: 'Sprint 4', date: daysFromNow(-6), completedWork: 'Demoed the mobile status-update screen and photo attachments.', stakeholderFeedback: 'Operations manager asked for a way to flag urgent outages — added to the backlog.' }
    ]
  });

  window.drBuildSimpleLogCard({
    cardId: 'sprintRetroCard', collectionName: 'sprintRetros', bodyPrefix: 'rt', dateField: 'date',
    fields: [
      { key: 'sprintLabel', label: 'Sprint', type: 'text' },
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'whatWentWell', label: 'What Went Well', type: 'textarea' },
      { key: 'whatDidntGoWell', label: "What Didn't Go Well", type: 'textarea' },
      { key: 'actionItems', label: 'Action Items for Next Sprint', type: 'textarea' }
    ],
    sample: [
      { id: 'sample-1', sprintLabel: 'Sprint 4', date: daysFromNow(-6), whatWentWell: 'Mobile screen shipped a day early; good pairing on the photo-upload bug.', whatDidntGoWell: 'Design approval for one screen came in mid-sprint, causing rework.', actionItems: 'Get design sign-off before a story is marked Ready, per the Definition of Ready.' }
    ]
  });

  window.drBuildSimpleLogCard({
    cardId: 'releaseNotesCard', collectionName: 'releaseNotesLog', bodyPrefix: 'rn', dateField: 'date',
    fields: [
      { key: 'releaseLabel', label: 'Release / Version', type: 'text' },
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'summary', label: 'What Shipped', type: 'textarea' }
    ],
    sample: [
      { id: 'sample-1', releaseLabel: 'v1.0', date: daysFromNow(-20), summary: 'Outage intake form, crew assignment, basic dispatch view — initial rollout to the night-shift team.' }
    ]
  });
})();
