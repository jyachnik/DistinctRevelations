// Public/JS/chart-info.js
// "About this chart" — a small ℹ️ button injected into every card's own
// header, opening a popup (window.drModal) with authored, static content:
// what the chart/table is actually showing, how to read it, and what its
// measures mean. Separate from the AI/rule-based insight box (which
// describes THIS project's current numbers) — this is reference material
// that never changes project to project.
//
// Loaded through the normal auth-gated cascade (not the early static
// <script> group) since it only needs the DOM, not Firestore/auth.

(function () {
  'use strict';

  // Keys match card ids used everywhere else in this app (report-index.js,
  // ai-insights.js, burndown.js, etc.). body is plain HTML — short
  // paragraphs and a <dl> of term/definition pairs where a card has real
  // jargon worth spelling out.
  var CHART_INFO = {
    projectCharterAction: {
      body: '<p>Opens whichever uploaded document has "charter" in its title (Settings ▸ Data Imports ▸ Project Documents), in the same document reader Ask the Project\'s citations use — not a card of its own, so it always reflects whatever charter document is currently on file, re-import a new version any time to update it.</p>'
    },
    projectStatusCard: {
      body: '<p>A single traffic-light read of the whole project, computed automatically from Schedule Performance (SPI) and Cost Performance (CPI) — not set manually. Takes the WORSE of the two.</p>' +
        '<dl><dt>Critical</dt><dd>SPI and/or CPI is below 0.90 — behind schedule or over budget by a meaningful margin.</dd>' +
        '<dt>Caution</dt><dd>SPI and/or CPI is 0.90 – 0.99 — worth watching, not yet an emergency.</dd>' +
        '<dt>On Plan</dt><dd>Both SPI and CPI are 1.00 or above.</dd></dl>' +
        '<p>Same thresholds as the Schedule/Cost Performance Index tiles and Health Scorecard, so all three always agree.</p>'
    },
    projectProgressCard: {
      body: '<p><strong>Time Elapsed</strong> is a calendar fact: how far today sits between the earliest task\'s start and the latest task\'s due date, regardless of how much work is actually done.</p>' +
        '<p><strong>Tasks Completed</strong> counts tasks that have reached 100% — a task at 90% counts the same as one at 0% here, which is why it can look "behind" Time Elapsed even on a healthy project. The insight text below it also shows a work-weighted figure (credits partial progress) and the imported schedule\'s own Percent Complete, so you can cross-check all three.</p>'
    },
    qnaSummaryCard: {
      body: '<p>A count of every open item in the Q&amp;A Tracker, split by type. Not a health signal on its own — a very low count on an otherwise behind-schedule project can itself be a red flag (nobody\'s surfacing issues), which the AI insight is specifically prompted to call out.</p>'
    },
    schedulePerformanceCard: {
      body: '<p><strong>SPI (Schedule Performance Index)</strong> = actual task-equivalents completed ÷ planned task-equivalents by today\'s date. 1.00 means exactly on pace.</p>' +
        '<dl><dt>SPI ≥ 1.00 (green)</dt><dd>On or ahead of schedule.</dd>' +
        '<dt>0.90 – 0.99 (amber)</dt><dd>Behind schedule.</dd><dt>&lt; 0.90 (red)</dt><dd>Significantly behind.</dd></dl>' +
        '<p>This version is task-count based (ignores cost) so it\'s safe to show to every role, not just the Owner.</p>'
    },
    forecastFinishCard: {
      body: '<p>Mirrors how EAC works for cost: <strong>Forecast Finish = Baseline Start + (Baseline Duration ÷ SPI)</strong> — if the project keeps completing work at its current pace (SPI) relative to plan, this is roughly when it actually finishes.</p>' +
        '<p>Compared against the project\'s own originally-baselined finish date (not the current, possibly-already-adjusted one) — green means forecast on or ahead of that original date, amber up to 2 weeks late, red more than 2 weeks late. Needs a Baseline Start/Finish (or at least a current Start/Finish) on the schedule import to compute anything.</p>'
    },
    costPerformanceCard: {
      body: '<p><strong>CPI (Cost Performance Index)</strong> = Earned Value ÷ Actual Cost. 1.00 means the work delivered so far cost exactly what was budgeted for it.</p>' +
        '<dl><dt>CPI ≥ 1.00 (green)</dt><dd>On or under budget.</dd>' +
        '<dt>0.90 – 0.99 (amber)</dt><dd>Slightly over budget.</dd><dt>&lt; 0.90 (red)</dt><dd>Significantly over budget.</dd></dl>' +
        '<p>Requires the import to include a CPI or Actual Cost column — without one, this stays blank rather than guessing.</p>'
    },
    ganttSection: {
      body: '<p>Every milestone (📌) and activity (📝) on one timeline. Bar color follows the same red/amber/green jeopardy scale used across the app (overdue-or-critical / at-risk / on-track). A 🔄 prefix on a task name means it has an edit history — check its Change Report entry for what changed.</p>' +
        '<dl><dt>Black dashed outline</dt><dd>Flagged Critical = Yes on import — on the critical path.</dd>' +
        '<dt>Yellow dashed vertical line</dt><dd>Today\'s date.</dd></dl>' +
        '<p>Click any bar to see its full detail (dates, % complete, change history) and edit it (Owner only).</p>'
    },
    burndownCard: {
      body: '<p>Remaining work over time — Ideal (a straight line from total scope to zero) vs. Actual (what\'s really left). Actual finishing ABOVE Ideal by the end of a period means more is left undone than planned; below means ahead of pace.</p>' +
        '<p>The Tasks/Duration toggle changes what "work" means: <strong>Tasks</strong> counts each task as one unit regardless of size; <strong>Duration</strong> weights by how many days each task takes, so a handful of long tasks move the line more than many short ones.</p>'
    },
    burnupCard: {
      body: '<p>The mirror image of Burndown — cumulative work COMPLETED over time, against an Ideal pace line and the Total Scope ceiling. Actual below Ideal means behind pace; a rising Total Scope line mid-project means work was added (scope growth).</p>' +
        '<p>Same Tasks/Duration toggle and meaning as Burndown.</p>'
    },
    velocityCard: {
      body: '<p>How much work finished in each period (bars) against the running average across all periods (dashed line). A bar well below the average line for a recent period is usually the first sign something slowed the team down that period specifically — worth cross-referencing against what else happened in that same window (new defects, resource changes, a blocking gate).</p>'
    },
    ragDistCard: {
      body: '<p>Where every open (not-yet-complete) milestone/activity currently stands, by the same red/amber/green jeopardy rule used on the Gantt bars: <strong>green</strong> = on track relative to its due date, <strong>amber</strong> = at risk, <strong>red</strong> = overdue or critically close. A snapshot of right now, not a trend — see Velocity or Burndown for how it\'s moving over time.</p>'
    },
    cfdCard: {
      body: '<p>A Cumulative Flow Diagram — task count in each status (Not Started / In Progress / Completed) stacked over time. A widening "In Progress" band means work is starting faster than it\'s finishing (a bottleneck); a shrinking "Not Started" band with a flat "Completed" band means intake has slowed.</p>'
    },
    cashFlowCard: {
      body: '<p>Cost per period (bars/line) and cumulative cost (second line) against a Forecast-to-EAC (dashed) — MS Project\'s own Cash Flow report layout. The top stat row (Actual/Baseline/Remaining/Variance) is a snapshot as of the latest import; the chart shows how it got there and where it\'s forecast to end up.</p>'
    },
    evmCard: {
      body: '<p>The three classic Earned Value lines over time: <strong>PV</strong> (Planned Value — what should have been spent by now), <strong>EV</strong> (Earned Value — the budgeted cost of work actually done), <strong>AC</strong> (Actual Cost — what was really spent). EV below PV = behind schedule (SV = EV−PV is negative); AC above EV = over budget (CV = EV−AC is negative).</p>'
    },
    budgetVsActualCard: {
      body: '<p>Two lines, simpler than the full EVM chart above: the Baseline (originally budgeted) cost vs. Actual cost, both over time. Actual running above Baseline means overspending relative to the original plan; below means underspending (which isn\'t automatically good — check whether work is also behind).</p>'
    },
    etcVsEacCard: {
      body: '<p>The classic Earned Value forecast chart: PV/EV/AC over time (same lines as the EVM chart), plus a flat BAC budget reference line and a dashed forecast segment projecting from today out to the Estimate at Completion.</p>' +
        '<dl><dt>BAC — Budget at Completion</dt><dd>The original, baselined total project budget.</dd>' +
        '<dt>EAC — Estimate at Completion</dt><dd>The current forecast of total project cost, given how it\'s actually going so far.</dd>' +
        '<dt>ETC — Estimate to Complete</dt><dd>How much more needs to be spent to finish. ETC = EAC − AC.</dd>' +
        '<dt>VAC — Variance at Completion</dt><dd>How far the forecast total is from the original budget. VAC = BAC − EAC — positive means finishing under budget, negative means over.</dd></dl>' +
        '<p>If EAC is meaningfully above BAC (VAC is negative), the project is forecast to overrun its original budget even if today\'s CPI looks fine — this chart is where that shows up before it happens.</p>'
    },
    healthScorecardCard: {
      body: '<p>One glance across all four project goals: <strong>SPI</strong> (schedule), <strong>CPI</strong> (cost), <strong>Open High Risks</strong> (risk), <strong>Open Critical/High Defects</strong> (quality) — each colored red/amber/green on its own threshold. Overall status takes the WORST of the four that actually have data (a goal with no data yet never drags it down). SV/CV/EAC/ETC below are the same cost figures as the Cash Flow/EVM charts, just gathered in one place.</p>'
    },
    milestoneTrendCard: {
      body: '<p>Which milestones have slipped from their originally baselined date, and by how many days — sorted worst-first. A milestone with no baseline date on import can\'t show a slip figure.</p>'
    },
    criticalPathCard: {
      body: '<p>Every OPEN task or milestone the schedule import flagged <strong>Critical = Yes</strong> — the chain of work that directly determines the project\'s finish date. Slip any one of these and the whole project slips with it, unlike a task with slack (float) to absorb a delay.</p>' +
        '<p><strong>Slack</strong> is how many days a task can slip before it delays the finish date — needs a "Total Slack" column in the schedule export; without one, this just shows the Critical Yes/No flag with no slack figure. Completed critical tasks drop off this list since they can no longer threaten the finish date.</p>'
    },
    topSlippedCard: {
      body: '<p>Every activity or real project milestone (not Meetings/Events — see Milestone Trend for those) whose due date has moved LATER than its originally recorded due date, sorted worst-first. Built from the same change-history already captured on every edit/re-import; a task with no recorded due-date change, or one that only ever moved earlier, won\'t appear here.</p>'
    },
    resourceHoursTrendCard: {
      body: '<p>Scheduled work (hrs/week) vs. actual work vs. utilization % (hrs actually logged ÷ hrs available), aggregated across every resource, over time. Utilization well under 100% for a period usually means work is blocked/unplanned rather than resources being idle by design — worth checking what else was happening that period.</p>'
    },
    resourceHoursCard: {
      body: '<p>Per-resource breakdown: budgeted hours, actual hours logged, remaining hours, % complete, and average FTE (full-time-equivalent load) across the selected time frame.</p>'
    },
    defectTrendCard: {
      body: '<p>Defects opened vs. resolved, cumulative over time, for the selected time frame — the quality equivalent of the Cumulative Flow Diagram. A growing gap between the two lines means defects are piling up faster than they\'re being fixed.</p>'
    },
    riskExposureTrendCard: {
      body: '<p>Compares the two MOST RECENT Risk Register imports, risk-by-risk: for every open risk present in both, did its Probability or Impact rating (1-5) cross into a different High (4-5) / Medium (3) / Low (1-2) bucket? Each bar is the count of risks that moved INTO that bucket — e.g. a tall "Impact: High" bar means several risks got worse on Impact since the last import.</p>' +
        '<p>Only risks present in BOTH imports are compared (a brand-new or removed risk has no "before" value to diff against). Needs at least 2 Risk Register imports to show anything, since it can\'t read continuous history from individual risk edits — the Risk Register has no per-risk change tracking, unlike Milestones/Activities.</p>'
    },
    qualityDefectsCard: {
      body: '<p>Every logged defect — category, severity, where it was found, status, assignee, and reopen count. Sortable/filterable on every column. "Reopened" &gt; 0 means a defect marked resolved came back — worth a closer look at whether the original fix actually addressed the root cause.</p>'
    },
    issueLogCard: {
      body: '<p>Problems that have actually HAPPENED — distinct from <strong>Risk Register</strong> (hypothetical, not-yet-materialized problems) and Q&amp;A\'s lightweight "Issue" type (message/assignee/status only, no severity or root-cause fields). Every field is sortable/filterable; "Related Risk" links an issue back to the risk that predicted it, when one exists — a risk that keeps generating real issues is worth re-examining its response strategy.</p>'
    },
    raciCard: {
      body: '<p>Who\'s Responsible, Accountable, Consulted, or Informed for each activity.</p>' +
        '<dl><dt>R — Responsible</dt><dd>Does the work.</dd><dt>A — Accountable</dt><dd>Owns the outcome; ideally exactly one person per activity.</dd>' +
        '<dt>C — Consulted</dt><dd>Gives input before/during the work.</dd><dt>I — Informed</dt><dd>Kept up to date after the fact.</dd></dl>' +
        '<p>An activity with no one marked Accountable is a real gap — nobody is actually on the hook for it.</p>'
    },
    riskRegisterCard: {
      body: '<p>Every logged risk — category, probability, impact, score (probability × impact), response strategy, and status. Score ≥ 15, an Impact Area of "Schedule", or a manually-checked "Contributing to SPI?" box are what flag a risk as one of the "open high risks" counted on the Health Scorecard.</p>'
    },
    assumptionsLogCard: {
      body: '<p>Everything the plan assumes to be true but hasn\'t been verified. An assumption marked high-impact and still unvalidated late in the project is a real exposure — if it turns out false, expect schedule/cost/scope consequences that aren\'t currently planned for.</p>'
    },
    constraintsLogCard: {
      body: '<p>Fixed conditions/boundaries the project must operate within (a hard deadline, a fixed budget ceiling, a mandated technology) — not risks (which are uncertain) but firm limits the plan has to work inside.</p>'
    },
    qnaSection: {
      body: '<p>The full Q&amp;A/Task/Issue/Risk tracker — anyone can log an item, assign it, and mark it done. An item overdue (past its due date, still open) shows in red.</p>'
    },
    activityPanelCard: {
      body: '<p>A running log of project actions and team updates, separate from the formal Activities on the Gantt chart — this is more like a project journal/status feed.</p>'
    },
    milestoneSection: {
      body: '<p>Meetings and events, each with its own setup checklist (📋) tracking how ready it is. "Occurred" means the date has already passed; otherwise status reflects how much of that meeting\'s checklist is checked off.</p>'
    },
    fileManagerSection: {
      body: '<p>Shared project files — upload, download, and see who added what and when.</p>'
    },
    aiAnalysisCard: {
      body: '<p>An AI-generated executive read across every card and import in this project — a synthesized narrative, not a new calculation of its own. Regenerate it any time once new data has come in; older versions stay in its history.</p>'
    },
    baselineChangeCard: {
      body: '<p>When and why the schedule/cost baseline itself was formally reset — different from an ordinary schedule edit, which only updates the current plan. A rebaseline resets the reference point everything else (SPI, CPI, Milestone Trend\'s slip figures) is measured against, so every entry here should trace back to a real, approved reason.</p>'
    },
    benefitsRealizationCard: {
      body: '<p>Each KPI has a baseline value/date and a target value/date; the owner logs dated actual readings over time (➕) to build a real trend, not just a current snapshot.</p>' +
        '<dl><dt>Achieved</dt><dd>Latest reading has reached target.</dd>' +
        '<dt>On track</dt><dd>Progress toward target is keeping pace with how much of the baseline-to-target time window has elapsed.</dd>' +
        '<dt>Behind pace / At risk</dt><dd>Progress is lagging (or well behind) that same elapsed-time pace.</dd></dl>' +
        '<p>Status compares progress against elapsed TIME, not just whether the latest number looks good in isolation — a KPI can be "on track" even with a low reading, early on.</p>'
    },
    changeControlLogCard: {
      body: '<p>Status is derived, never stored directly: <strong>Approved</strong> only once every required decision (the owner, and the sponsor if the request was flagged as needing it) says yes; <strong>Rejected</strong> if either says no; otherwise <strong>Pending</strong>. A request still pending after 7+ days shows up on Needs Attention.</p>'
    },
    communicationsLogCard: {
      body: '<p>Whether each planned communication (from the Communications Plan above) actually went out on schedule — kept as its own log, separate from the plan itself, so a plan item with no matching log entry by its due date is visibly missed rather than silently assumed done.</p>'
    },
    communicationsPlanCard: {
      body: '<p>Who gets told what, how often, and by what channel — the plan itself, not whether it was actually followed. See Communications Log below for the real record of what went out and when.</p>'
    },
    costOfQualityCard: {
      body: '<p><strong>Prevention + Appraisal</strong> spend is money spent to keep defects from happening (or catch them early); <strong>Internal + External Failure</strong> spend is money spent because a defect happened anyway. A healthy trend spends relatively more on Prevention/Appraisal over time and less on Failure — the reverse usually means defects are being caught late, or not at all until a customer finds them.</p>'
    },
    decisionLogCard: {
      body: '<p><strong>Status</strong>: Proposed (not yet decided) → Decided (the call was made) → Superseded (replaced by a later decision) or Reversed. A decision still Proposed after 7+ days shows up on Needs Attention. Optional links tie a decision back to the Risk Register entry or Change Request that prompted it.</p>'
    },
    deliverableSignoffCard: {
      body: '<p>Decision options — Accept, Accept with conditions, or Reject — recorded once per round by the Client Partner (or the owner). A rejected item can be resubmitted after fixes, which archives that round into history and starts a new one; the item\'s own content can only be edited while a round is still pending.</p>'
    },
    dependenciesCard: {
      body: '<p>What each piece of work is waiting on — another task/milestone, an outside party, or another team/project. A dependency past its need-by date and still not Resolved shows up on Needs Attention.</p>'
    },
    earnedScheduleCard: {
      body: '<p><strong>SPI(t)</strong> = Earned Schedule ÷ Actual Time — a time-based version of Schedule Performance Index that, unlike the dollar-based SV/SPI on the EVM chart, stays meaningful all the way to actual finish even after planned work\'s own due dates have passed.</p>' +
        '<p><strong>Forecast Finish (time-based)</strong> = project start + (planned duration ÷ SPI(t)).</p>'
    },
    executiveRoadmapCard: {
      body: '<p>The same milestones/activities data as the Gantt Timeline, simplified to just top-level phases (date-range bars, stacked waterfall-style when they\'d otherwise overlap) and milestones (dots) — a five-second read, not the Gantt\'s full operational detail.</p>'
    },
    glossaryCard: {
      body: '<p>Project-specific terms, acronyms, data-dictionary field definitions, and calculation formulas (EVM, ROI, and the rest), all in one alphabetical, searchable list. Use the A-Z index at the bottom of the list to jump straight to a letter.</p>'
    },
    lessonsLearnedCard: {
      body: '<p>What went well, what went badly, why, and what to do differently next time — captured as the project goes rather than only at closure, so nothing gets lost waiting for a retrospective.</p>'
    },
    needsAttentionCard: {
      body: '<p>Aggregates overdue/high-urgency items across the whole project — risks, issues, dependencies, sign-offs, change requests, decisions, Q&amp;A, meeting action items — into one feed. Read-only, reusing each source card\'s own data, so it can never show something that disagrees with what that card itself shows.</p>' +
        '<p>Check an item\'s box to mark it reviewed — date/time and who reviewed it are recorded for reference, kept separately from the source record so marking something reviewed never alters the underlying data.</p>'
    },
    orgChartCard: {
      body: '<p>Reporting lines, built automatically from Team Directory\'s "Reports To" field above — not something maintained separately here.</p>'
    },
    procurementCard: {
      body: '<p>What the project is buying, from whom, and how the money and dates are tracking, plus the vendor directory those purchase orders reference.</p>'
    },
    projectClosureCard: {
      body: '<p>Final scope/budget/schedule vs. baseline, outstanding items, and lessons learned — computed live from the dashboard\'s own current numbers rather than re-entered by hand — plus a closure checklist. Checking a standard checklist item while it still has an open concern (⚠) asks you to confirm first. Save a snapshot once closure is actually complete; past snapshots stay listed under Saved Runs.</p>'
    },
    requirementsTraceabilityCard: {
      body: '<p>Each requirement, its own status, its test status, and the deliverable that satisfies it — the audit trail proving every requirement was actually built AND verified, not just logged and forgotten.</p>'
    },
    resourceCapacityCard: {
      body: '<p>"Overallocated" is simply a resource\'s scheduled work exceeding their available capacity for that week — the same workAvailability/work figures Resource Hours already imports, viewed week-by-week going forward instead of as a whole-project total.</p>' +
        '<dl><dt>Under 90% (green)</dt><dd>Room to spare that week.</dd>' +
        '<dt>90–110% (amber)</dt><dd>Fully committed.</dd>' +
        '<dt>Over 110% (red)</dt><dd>Scheduled for more than they have available — likely to slip or need help.</dd></dl>' +
        '<p>Split into two collapsible groups by whether the resource\'s name contains "Vendor" — Project Team - Internal and Project Team - External Vendors. Click any cell for the raw hours behind the percentage.</p>'
    },
    riskHeatMapCard: {
      body: '<p>Every OPEN risk plotted by Probability × Impact (1–5 each) — the same score and severity thresholds as the Risk Register (≥15 high/red, 8–14 medium/amber, &lt;8 low/green). Click a cell to see exactly which risks fall in it.</p>'
    },
    riskReserveCard: {
      body: '<p>Contingency reserve set aside vs. drawn down as risks are actually realized — a running burn-down of real draws against the reserve, not a static budget line that never moves.</p>'
    },
    stakeholderEngagementCard: {
      body: '<p><strong>Current (C)</strong> vs. <strong>Desired (D)</strong> engagement level per stakeholder (Unaware / Resistant / Neutral / Supportive / Leading), sorted by the biggest gap between the two — the stakeholders furthest from where the project needs them to be, and therefore most worth active engagement effort right now.</p>'
    },
    stakeholderRegisterCard: {
      body: '<p>Everyone with a stake in this project, including people who never log into the portal. Influence and Interest (each Low/Medium/High) drive the Quadrant column — Manage Closely, Keep Satisfied, Keep Informed, or Monitor — the standard stakeholder-management model for deciding how much engagement effort each person actually needs.</p>'
    },
    teamDirectoryCard: {
      body: '<p>The project team\'s contact roster, versioned — every edit archives the row\'s previous values (🕘 to view a row\'s history). Select one or more rows and use Send Email to reach people directly through the portal, with each send recorded in a log.</p>'
    },
    teamCharterCard: {
      body: '<p>The team\'s own working agreement — distinct from Project Charter (a real uploaded document defining the PROJECT\'s purpose/sponsor/scope) and Team Directory (the contact roster). A single living reference, not versioned, editable by the owner at any time.</p>'
    },
    documentRegisterCard: {
      body: '<p>Every document on the project in one place — imported plans/registers (also what Ask the Project reads), File Manager uploads, and anything shared with you privately. Opens as its own popup (Reports ▸ Administration ▸ Project Documents), not a page-flow card.</p>'
    },
    statusReportAction: {
      body: '<p>Builds a PDF status report from the live dashboard data — only the sections your role can view — and keeps saved copies. Opens its own popup; not a page-flow card.</p>'
    },
    changeReportBtn: {
      body: '<p>Every schedule/progress edit ever made, for reconciling into the master plan — a full audit trail, not a summary. Opens its own popup; not a page-flow card.</p>'
    },
    settingsPermissionsAction: {
      body: '<p>Which roles can view or edit each report/card in this project — the matrix that governs every role\'s access throughout the whole portal. Owner-only.</p>'
    },
    dataImportsOverlay: {
      body: '<p>Import Schedule, Resources, Risk Register, Assumptions, Constraints, Defects, and RACI files — this is how the live data behind almost every card in this portal gets updated. Owner-only.</p>'
    },
    insightModeOverlay: {
      body: '<p>Standard (free, rule-based) vs. AI-polished wording for card insights and project analysis. Owner-only.</p>'
    },
    manageProjectAccessAction: {
      body: '<p>Create projects and assign member roles per project — a platform-owner action, not something available at the individual-project level. Owner-only.</p>'
    },
    createAccountAction: {
      body: '<p>Create a new user account for an existing company. Owner-only.</p>'
    },
    notificationSettingsAction: {
      body: '<p>The phone number SMS alerts (new Q&amp;A questions, daily overdue digest) get sent to. Owner-only.</p>'
    },
    discrepancyReportAction: {
      body: '<p>An AI audit comparing every card against your uploaded documents (and cards against each other), looking for real contradictions — not gaps, just disagreements — saved as timestamped, checklist-able records. Owner-only.</p>'
    }
  };

  // Exposed so titles-view.js can put the same info icon/hover-panel on
  // each tile in the "Titles & Subtitles" grid, reusing this exact
  // authored content rather than a second copy.
  window.drChartInfo = CHART_INFO;

  // The button sits on the card's own outer top-right corner (half outside
  // the border) rather than inline in the header text, and hovering it
  // reveals a small panel with the same body content right there — no
  // click needed to preview it. Clicking still opens the full window.drModal
  // popup too (a hover has no equivalent on touch, so this keeps the info
  // reachable on mobile and gives a "pin it open" option on desktop).
  function injectButton(cardId) {
    var card = document.getElementById(cardId);
    if (!card || card.querySelector(':scope > .chart-info-wrap')) return;

    // Absolute positioning is relative to the nearest positioned ancestor
    // — force it here rather than relying on any card's own (possibly
    // absent) position:relative.
    if (!card.style.position) card.style.position = 'relative';

    var wrap = document.createElement('span');
    wrap.className = 'chart-info-wrap';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chart-info-btn';
    btn.title = 'About this chart';
    btn.setAttribute('aria-label', 'About this chart');
    btn.textContent = 'ℹ️';
    btn.setAttribute('data-card-id', cardId);

    var panel = document.createElement('div');
    panel.className = 'chart-info-panel';
    panel.innerHTML = CHART_INFO[cardId].body;

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    card.appendChild(wrap);
  }

  function init() {
    Object.keys(CHART_INFO).forEach(injectButton);

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.chart-info-btn');
      if (!btn) return;
      var cardId = btn.getAttribute('data-card-id');
      var info = CHART_INFO[cardId];
      if (!info || !window.drModal) return;
      var card = document.getElementById(cardId);
      var h2 = card ? card.querySelector('h2') : null;
      var title = 'About: ' + (h2 ? h2.textContent.replace(/\s+/g, ' ').trim() : cardId);
      window.drModal.open({ title: title, bodyHtml: info.body });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
