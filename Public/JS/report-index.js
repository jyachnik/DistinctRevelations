// Public/JS/report-index.js
// Report Index — a sidebar card, listing every report/chart card in the
// portal as a link to where it lives on the page, grouped under category
// headings (Executive, Schedule, Financial, Quality Control, Risk,
// Resources, Administration) with a hover tooltip explaining each report
// in a few words (each card's own subtitle, condensed). Pure DOM
// decoration, no Firebase needed, so it runs immediately rather than
// waiting on anything async.
//
// REPORTS is hand-maintained (not scraped from each card's own subtitle
// text live) so the wording stays short and deliberate — update it here
// if a card's id, title, or description changes. CATEGORIES groups those
// same ids under headings; the same id can appear under more than one
// category on purpose (e.g. the Health Scorecard rolls up both Executive
// and Risk signals) — repeats are intentional, not a bug.

(function () {
  'use strict';

  function warn() { console.warn.apply(console, ['[report-index]'].concat(Array.prototype.slice.call(arguments))); }

  var OWNER_EMAIL = 'john@distinctrevelations.com';
  var isOwner = false;

  // Runs early (before firebaseInit.js — see dashboard.html load order),
  // so auth isn't resolved yet at init() time. Re-renders once it is, to
  // reveal owner-only entries (currently just Manage Project Access).
  function watchOwner(list) {
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      var a = window.auth;
      if (a && typeof a.onAuthStateChanged === 'function') {
        clearInterval(iv);
        a.onAuthStateChanged(function (user) {
          var wasOwner = isOwner;
          isOwner = !!(user && user.email && user.email.toLowerCase().trim() === OWNER_EMAIL);
          if (isOwner !== wasOwner) render(list);
        });
      } else if (tries > 100) {
        clearInterval(iv);
        warn('window.auth never appeared; owner-only entries stay hidden.');
      }
    }, 100);
  }

  // icon matches the emoji already on that report's own card header in
  // dashboard.html (kept in sync by hand — same convention as label/desc
  // above) — rendered in its own fixed-width column (see entryHtml() and
  // .report-index-icon in metrics.css) so a row's label text always
  // starts at the same x position regardless of which glyph it has.
  var REPORTS = {
    projectCharterAction: { icon: '📜', label: 'Project Charter', desc: 'Opens the project\'s charter document — purpose, sponsor, business case, and scope, as uploaded.', action: 'projectCharter' },
    aiAnalysisCard: { icon: '🧭', label: 'Executive Overview', desc: 'The AI-generated executive read across every card and import in this project.' },
    projectStatusCard: { icon: '🚦', label: 'Project Status', desc: 'Traffic-light status, computed automatically from SPI/CPI.' },
    projectProgressCard: { icon: '🏁', label: 'Project Progress', desc: 'Overall completion percentage across all tasks.' },
    qnaSummaryCard: { icon: '💬', label: 'Q&A Summary', desc: 'Counts of open questions, tasks, issues, and risks.' },
    schedulePerformanceCard: { icon: '⏱️', label: 'Schedule Performance Index', desc: 'Actual vs. planned progress by task count.' },
    costPerformanceCard: { icon: '💲', label: 'Cost Performance Index', desc: 'CPI — cost efficiency relative to budget.' },
    ganttSection: { icon: '📊', label: 'Gantt Timeline', desc: 'The WBS hierarchy frozen on the left (collapsible), milestones and activities on a scrollable timeline to the right.' },
    executiveRoadmapCard: { icon: '🗺️', label: 'Executive Roadmap', desc: 'Major phases and milestones on one line, simplified from the same schedule data as the Gantt.' },
    benefitsRealizationCard: { icon: '🏆', label: 'Benefits Realization / KPI Tracker', desc: 'Business benefits/KPIs tracked against baseline and target over time, with a status auto-computed from the trend.' },
    projectClosureCard: { icon: '🏁', label: 'Project Closure Report', desc: 'Final scope/budget/schedule vs. baseline, outstanding items, and lessons learned, plus a closure checklist and saved snapshots.' },
    glossaryCard: { icon: '📖', label: 'Glossary / Acronyms', desc: 'Project-specific terms and acronyms, defined in one place.' },
    needsAttentionCard: { icon: '🔔', label: 'Needs Attention', desc: 'Overdue and high-urgency items across the whole project, pulled together in one place.' },
    riskHeatMapCard: { icon: '🌡️', label: 'Risk Heat Map', desc: 'Open risks plotted by Probability x Impact — the same Risk Register data as a 5x5 grid.' },
    orgChartCard: { icon: '🌳', label: 'Org Chart', desc: 'Reporting lines, built from Team Directory\'s roster.' },
    teamCharterCard: { icon: '🤝', label: 'Team Charter', desc: 'How this team agrees to work together — mission, values, working agreements, communication norms, decision-making, and conflict resolution.' },
    resourceCapacityCard: { icon: '📐', label: 'Resource Overallocation / Capacity', desc: 'Who\'s scheduled for more work than they have available capacity, period by period, looking forward only.' },
    stakeholderEngagementCard: { icon: '📊', label: 'Stakeholder Engagement Assessment Matrix', desc: 'Current vs. desired engagement level per stakeholder, the standard PMBOK matrix.' },
    riskReserveCard: { icon: '🧯', label: 'Risk Reserve / Contingency Burn-down', desc: 'Contingency reserve set aside vs. drawn down as risks are realized, over time.' },
    baselineChangeCard: { icon: '📏', label: 'Baseline Change / Rebaseline Log', desc: 'When and why the schedule/cost baseline itself was formally reset.' },
    earnedScheduleCard: { icon: '⏳', label: 'Earned Schedule', desc: 'Schedule performance in time, not dollars — the same PV/EV curve as EVM, expressed differently.' },
    requirementsTraceabilityCard: { icon: '🧷', label: 'Requirements Traceability Matrix', desc: 'Each requirement, its status, its test status, and the deliverable that satisfies it.' },
    costOfQualityCard: { icon: '💎', label: 'Cost of Quality', desc: 'What quality is actually costing the project — prevention/appraisal spend vs. internal/external failure spend.' },
    communicationsLogCard: { icon: '📨', label: 'Communications Log', desc: 'Whether each planned communication actually went out on schedule.' },
    burndownCard: { icon: '📉', label: 'Burndown', desc: 'Remaining work over time — ideal vs. actual.' },
    healthScorecardCard: { icon: '🎯', label: 'Project Health Scorecard', desc: 'One glance across schedule, cost, risk, and quality.' },
    burnupCard: { icon: '📈', label: 'Burnup', desc: 'Ideal and completed work over time.' },
    ragDistCard: { icon: '🚦', label: 'Status Snapshot', desc: 'Where open milestones and activities stand right now.' },
    velocityCard: { icon: '🏃', label: 'Velocity', desc: 'Work completed per period, and the running average.' },
    cfdCard: { icon: '🌊', label: 'Cumulative Flow', desc: 'Task count by status over time.' },
    cashFlowCard: { icon: '💵', label: 'Cash Flow', desc: 'Actual, baseline, remaining cost, plus cost per period.' },
    evmCard: { icon: '💰', label: 'Earned Value (EVM)', desc: 'Planned Value, Earned Value, and Actual Cost over time.' },
    defectTrendCard: { icon: '🐞', label: 'Defect Trend', desc: 'Opened vs. resolved defects, cumulative over time.' },
    riskExposureTrendCard: { icon: '📈', label: 'Risk Exposure Trend', desc: 'Risks that changed Impact or Probability rating between the last 2 imports.' },
    budgetVsActualCard: { icon: '📊', label: 'Budgeted vs. Actual Cost', desc: 'Baseline cost vs. actual cost over time.' },
    etcVsEacCard: { icon: '📐', label: 'ETC vs EAC', desc: 'PV/EV/AC against the original budget (BAC), with a forecast to Estimate at Completion.' },
    resourceHoursTrendCard: { icon: '📈', label: 'Resource Hours Trend', desc: 'Scheduled vs. actual work and utilization over time.' },
    milestoneTrendCard: { icon: '📅', label: 'Milestone Trend', desc: 'Which milestones have slipped, and by how much.' },
    criticalPathCard: { icon: '🎯', label: 'Critical Path', desc: 'Open tasks with no schedule slack — any slip pushes the finish date out.' },
    topSlippedCard: { icon: '📉', label: 'Top Slipped Tasks', desc: 'Tasks whose due date has moved later than originally planned.' },
    forecastFinishCard: { icon: '🏁', label: 'Forecast Finish Date', desc: 'At the current pace (SPI), when the project is forecast to actually finish.' },
    resourceHoursCard: { icon: '👥', label: 'Resource Hours', desc: 'Budgeted, actual, and remaining hours per resource, plus FTE.' },
    qualityDefectsCard: { icon: '🐞', label: 'Quality / Defects Log', desc: 'Defect tracking — the Quality project goal.' },
    issueLogCard: { icon: '🚧', label: 'Issue Log (Confirmed)', desc: 'Problems that have actually happened, distinct from Risk Register and Q&A.' },
    raciCard: { icon: '🧩', label: 'Assignments / RACI', desc: "Who's Responsible, Accountable, Consulted, or Informed per activity." },
    milestoneSection: { icon: '📌', label: 'Meetings/Events', desc: 'Meetings and events, each with a setup checklist.' },
    activityPanelCard: { icon: '📝', label: 'Activity Log', desc: 'Track project actions and team updates.' },
    assumptionsLogCard: { icon: '📋', label: 'Assumptions Log', desc: 'Every field from the import — sortable and filterable.' },
    riskRegisterCard: { icon: '⚠️', label: 'Risk Register (Confirmed)', desc: 'Every field from the import — sortable and filterable.' },
    constraintsLogCard: { icon: '🔒', label: 'Constraints Log', desc: 'Fixed conditions/boundaries the project must operate within.' },
    stakeholderRegisterCard: { icon: '🧑‍🤝‍🧑', label: 'Stakeholder Register', desc: 'Who has a stake in the project, their influence and interest, and how the team plans to engage them.' },
    teamDirectoryCard: { icon: '📇', label: 'Team Directory', desc: 'The project team\'s contact roster — select people and send them email directly.' },
    changeControlLogCard: { icon: '🔁', label: 'Change Control Log', desc: 'Formal change requests with impact and owner/sponsor approval status.' },
    decisionLogCard: { icon: '⚖️', label: 'Decision Log', desc: 'Decisions made on the project, with rationale, alternatives considered, and follow-up.' },
    communicationsPlanCard: { icon: '📣', label: 'Communications Plan', desc: 'Who gets told what, how often, and by what channel.' },
    documentRegisterCard: { icon: '🗂️', label: 'Project Documents', desc: 'Every document on the project — imported plans and registers (also what Ask the Project reads), File Manager uploads, and anything shared with you privately.', action: 'projectDocuments' },
    procurementCard: { icon: '🛒', label: 'Procurement / Vendor Log', desc: 'Purchases and contracts (value, invoiced, paid, key dates, flags) plus the vendor directory.' },
    deliverableSignoffCard: { icon: '✍️', label: 'Deliverable Sign-off', desc: 'Formal client acceptance of milestones and deliverables, with the decision, who and when.' },
    dependenciesCard: { icon: '🔗', label: 'Dependencies', desc: 'What each piece of work is waiting on — other tasks, outside parties, other teams — with need-by dates and status.' },
    lessonsLearnedCard: { icon: '📚', label: 'Lessons Learned Register', desc: 'What went well or badly, why, and what to do differently next time.' },
    qnaSection: { icon: '🧠', label: 'Q&A Tracker', desc: 'Ask questions, track tasks, risks, and issues.' },
    fileManagerSection: { icon: '📁', label: 'File Manager', desc: 'Upload, share, and track project files.' },
    // These last three aren't page sections to scroll to — each triggers
    // its own action instead (see the click handler below).
    aiExecutiveVersionAction: { icon: '🎯', label: 'AI wording — Executive version', desc: 'Roles that receive the short, C-level wording of AI results (Executive Overview, insights, Ask the Project, Status Report summary).', action: 'aiVersion' },
    aiDetailVersionAction: { icon: '🔬', label: 'AI wording — Detail version', desc: 'Roles that receive the detailed, technical wording of AI results. A role with neither box ticked keeps the detailed wording.', action: 'aiVersion' },
    askProjectAction: { icon: '🔎', label: 'Ask the Project', desc: 'Ask questions and get cited answers from the project documents and live data your role can see.', action: 'askProject' },
    statusReportAction: { icon: '📄', label: 'Status Report (PDF)', desc: 'Build a PDF status report from the live data — only the sections your role can view — and keep saved copies.', action: 'statusReport' },
    changeReportBtn: { icon: '🔄', label: 'Change Report', desc: 'Every schedule/progress edit, for reconciliation into the master plan.', action: 'modal' },
    settingsPermissionsAction: { icon: '🔒', label: 'Permissions', desc: 'Which roles can access each report — configuration only for now.', action: 'permissions' },
    dataImportsOverlay: { icon: '📥', label: 'Data Imports', desc: 'Import Schedule, Resources, Risk Register, Assumptions, Constraints, Defects, and RACI files.', action: 'dataImports' },
    insightModeOverlay: { icon: '🤖', label: 'Insight Mode', desc: 'Standard (free, rule-based) vs. AI-polished card insights and project analysis.', action: 'insightMode' },
    // Owner-only, unlike the other Settings entries — hidden entirely for
    // everyone else (see the ownerOnly filtering in entryHtml() below),
    // since creating projects/assigning roles is a platform-owner action.
    manageProjectAccessAction: { icon: '🗂️', label: 'Manage Project Access', desc: 'Create projects and assign member roles per project.', action: 'manageProjectAccess', ownerOnly: true },
    // Owner-only — replaces the old public self-service signup page.
    createAccountAction: { icon: '➕', label: 'Create Account', desc: 'Create a new user account for an existing company.', action: 'createAccount', ownerOnly: true },
    // Owner-only — where SMS alerts (new Q&A question, daily overdue
    // digest) get sent. See notification-settings.js.
    notificationSettingsAction: { icon: '📱', label: 'Notification Phone Number', desc: 'Where SMS alerts for new Q&A questions and overdue items get sent.', action: 'notificationSettings', ownerOnly: true },
    // Owner-only, same as the three entries above — an AI audit of every card
    // against your uploaded documents, saved as timestamped, checklist-able
    // records. See discrepancyReport.js.
    discrepancyReportAction: { icon: '🔍', label: 'Discrepancy Report', desc: 'Finds contradictions between the dashboard and your uploaded documents (and between cards), with links to each and a fix checklist.', action: 'discrepancyReport', ownerOnly: true },
    // Deliberately its own top-level category, not grouped under Settings
    // — a language switcher needs to stay easy to find even for someone
    // who can't read the rest of this menu once a different language is
    // selected. Label stays the literal English word "Language" always,
    // never translated, for the same reason.
    languageAction: { icon: '🌐', label: 'Language', desc: 'Choose the portal\'s display language.', action: 'language' }
  };

  // Grouping only — the same id can (and does) appear under more than one
  // category. Order here is the render order — within each category, ids
  // are ordered to follow how a PM would actually walk through that area
  // (the big picture first, then status/performance, then supporting
  // detail/logs, then reference material last), not just alphabetically
  // or by whenever the card happened to get built this session. Same
  // order drives both the sidebar list and titles-view.js's tile grid.
  var CATEGORIES = [
    // First 6 ids match the Dashboard's own fixed top row EXACTLY, same
    // order — Project Status/Progress/Q&A/SPI/Forecast Finish/CPI — so
    // the Tiled view's first row+ mirrors what's pinned at the top of
    // the Dashboard page itself, before the rest of Executive follows.
    { name: 'Executive', ids: ['projectStatusCard', 'projectProgressCard', 'qnaSummaryCard', 'schedulePerformanceCard', 'forecastFinishCard', 'costPerformanceCard', 'projectCharterAction', 'healthScorecardCard', 'ragDistCard', 'needsAttentionCard', 'aiAnalysisCard', 'benefitsRealizationCard', 'glossaryCard'] },
    { name: 'Schedule', ids: ['executiveRoadmapCard', 'ganttSection', 'schedulePerformanceCard', 'forecastFinishCard', 'burndownCard', 'burnupCard', 'velocityCard', 'cfdCard', 'criticalPathCard', 'dependenciesCard', 'milestoneTrendCard', 'topSlippedCard', 'milestoneSection'] },
    { name: 'Financial', ids: ['costPerformanceCard', 'evmCard', 'budgetVsActualCard', 'etcVsEacCard', 'cashFlowCard', 'earnedScheduleCard', 'procurementCard'] },
    { name: 'Quality Control', ids: ['requirementsTraceabilityCard', 'qualityDefectsCard', 'defectTrendCard', 'costOfQualityCard', 'deliverableSignoffCard'] },
    { name: 'Risk', ids: ['assumptionsLogCard', 'constraintsLogCard', 'riskRegisterCard', 'riskHeatMapCard', 'riskExposureTrendCard', 'riskReserveCard', 'issueLogCard', 'stakeholderRegisterCard', 'stakeholderEngagementCard', 'communicationsPlanCard', 'communicationsLogCard', 'healthScorecardCard'] },
    { name: 'Resources', ids: ['teamDirectoryCard', 'orgChartCard', 'teamCharterCard', 'raciCard', 'resourceHoursCard', 'resourceHoursTrendCard', 'resourceCapacityCard'] },
    { name: 'Administration', ids: ['documentRegisterCard', 'activityPanelCard', 'qnaSection', 'changeControlLogCard', 'baselineChangeCard', 'decisionLogCard', 'statusReportAction', 'changeReportBtn', 'lessonsLearnedCard', 'fileManagerSection', 'projectClosureCard'] },
    { name: 'Settings', ids: ['settingsPermissionsAction', 'dataImportsOverlay', 'insightModeOverlay', 'manageProjectAccessAction', 'createAccountAction', 'notificationSettingsAction', 'discrepancyReportAction'] },
    { name: 'Language', ids: ['languageAction'] }
  ];

  // Same self-removing-toast pattern as dashboard.html's back-button trap
  // — a plain fixed div, not dr-modal.js (that's a heavier content dialog,
  // the wrong tool for a one-line "why is this grayed out" message).
  function showAccessDeniedToast(label) {
    var existing = document.getElementById('drReportAccessToast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.id = 'drReportAccessToast';
    toast.textContent = "You don't have access to " + label.replace(/^[^\w]+\s*/, '') + ' in this project.';
    toast.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);' +
      'background:#000428;color:#fff;padding:10px 20px;border-radius:8px;' +
      'box-shadow:0 4px 12px rgba(0,0,0,.3);z-index:100000;font-size:0.9rem;' +
      'font-family:Arial,Helvetica,sans-serif;max-width:90vw;text-align:center;';
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 4000);
  }

  function scrollToId(id) {
    var el = document.getElementById(id);
    if (!el) return;
    // Same header-offset logic used elsewhere (quick-links.js, the
    // page-load hash-scroll in dashboard.html) — #dashboardHeader AND
    // .dashboard-summary-row are both fixed on top of the viewport, so a
    // plain scrollIntoView (or subtracting only the header's height, as
    // this used to) would land the target's own title right behind the
    // summary row, cut off — it needs both fixed elements' heights
    // subtracted, not just the header's.
    var header = document.getElementById('dashboardHeader');
    var headerHeight = header ? header.offsetHeight : 0;
    var summaryRow = document.querySelector('.dashboard-summary-row');
    var summaryRowHeight = summaryRow ? summaryRow.offsetHeight : 0;
    var top = el.getBoundingClientRect().top + window.scrollY - headerHeight - summaryRowHeight - 12;
    window.scrollTo({ top: top, behavior: 'smooth' });
  }

  // Same offset logic for other features that jump to a card (Ask the Project's "Show in dashboard").
  window.drScrollToId = scrollToId;

  // Exposed so permissions.js can build its report x role matrix from the
  // exact same list, instead of maintaining a second copy that could
  // drift out of sync. Only real, scrollable report cards — not the
  // action-triggering entries (Change Report/Permissions/Data Imports
  // aren't "reports" to grant role access to) — and de-duplicated, since
  // CATEGORIES repeats some ids across sections on purpose.
  window.drReportList = Object.keys(REPORTS)
    .filter(function (id) { return !REPORTS[id].action; })
    .map(function (id) { return Object.assign({ id: id }, REPORTS[id]); });

  // Unfiltered version (includes action-only entries) — permissions.js
  // needs this to also show rows for Change Report / Data Imports, which
  // have real ACTIONS mappings despite not being scrollable cards.
  window.drAllReportEntries = Object.keys(REPORTS)
    .map(function (id) { return Object.assign({ id: id }, REPORTS[id]); });

  // Category grouping/order, exposed read-only-by-convention so
  // titles-view.js can group its tile grid under the exact same headings
  // (Executive/Schedule/Financial/...) instead of a second hand-maintained
  // copy that could drift. A plain array reference, not cloned — callers
  // must not mutate it.
  window.drReportCategories = CATEGORIES;

  // The action-only entries actually governed by the Permissions matrix
  // (they have real rows in permissions.js's popup, including Permissions
  // and Insight Mode themselves — gated on whether a role can open them at
  // all) — Manage Project Access (owner-only regardless) and Language stay
  // ungated. Kept in sync by hand with permissions.js's own
  // GOVERNED_ACTION_ONLY_IDS/ACTIONS.
  var MATRIX_GOVERNED_ACTIONS = { changeReportBtn: true, dataImportsOverlay: true, settingsPermissionsAction: true, insightModeOverlay: true, statusReportAction: true };

  function entryHtml(id, catName, collapsed) {
    var r = REPORTS[id];
    if (!r) { warn('no REPORTS entry for id', id); return ''; }
    // Action-triggering entries (Change Report/Permissions/Data Imports)
    // don't scroll anywhere, so they don't need their "id" to exist as a
    // real element — only plain scroll-to entries do.
    if (!r.action && !document.getElementById(id)) return '';
    if (r.ownerOnly && !isOwner) return '';
    var actionAttr = r.action ? ' data-action="' + r.action + '"' : '';
    // The Language entry's own label is exempt from this page's
    // translation pipeline (see language.js) — the one link back to the
    // language picker needs to stay legible no matter which language is
    // currently selected.
    var noTranslateAttr = id === 'languageAction' ? ' data-no-translate' : '';
    // Grayed-out, not removed, for a role the Permissions matrix hasn't
    // granted this report to — stays visible so it doesn't look like the
    // report doesn't exist, but clicking it shows why instead of acting.
    var isGoverned = !r.action || MATRIX_GOVERNED_ACTIONS[id];
    var isDenied = !isOwner && isGoverned && window.drAccess && window.drAccess.ready && !window.drAccess.canViewReport(id);
    var disabledAttr = isDenied ? ' data-disabled="1"' : '';
    var disabledClass = isDenied ? ' report-index-disabled' : '';
    // Icon in its own fixed-width column (data-no-translate — an emoji
    // glyph needs no translation) so a row's label always starts at the
    // same x position regardless of which glyph it has.
    return '<li data-category="' + catName + '"' + (collapsed ? ' hidden' : '') + noTranslateAttr + disabledClass + '>' +
      '<a href="#' + id + '" data-target="' + id + '"' + actionAttr + disabledAttr + ' title="' + r.desc.replace(/"/g, '&quot;') + '">' +
      '<span class="report-index-icon" data-no-translate>' + (r.icon || '') + '</span>' +
      '<span class="report-index-entry-label">' + r.label + '</span>' +
      '</a></li>';
  }

  // Collapsed/expanded state per category, kept in memory for the life of
  // the page (not persisted) — every category starts COLLAPSED so the
  // sidebar opens compact, EXCEPT Executive (the first one, which
  // contains Project Status) — that one starts expanded so the first row
  // is visible without an extra click. Clicking a heading toggles just
  // that group.
  var collapsedCategories = {};
  CATEGORIES.forEach(function (cat) { collapsedCategories[cat.name] = cat.name !== 'Executive'; });

  function render(list) {
    list.innerHTML = CATEGORIES.map(function (cat) {
      var collapsed = !!collapsedCategories[cat.name];
      var items = cat.ids.map(function (id) { return entryHtml(id, cat.name, collapsed); }).filter(Boolean).join('');
      if (!items) return '';
      var heading = '<li class="report-index-category">' +
        '<button type="button" class="report-index-category-toggle" data-category="' + cat.name + '" aria-expanded="' + (!collapsed) + '">' +
          '<span class="report-index-category-caret">' + (collapsed ? '▸' : '▾') + '</span>' + cat.name +
        '</button></li>';
      return heading + items;
    }).join('');
  }

  // #dashboardHeader and .dashboard-summary-row (Project Status/Progress/
  // Q&A/SPI/CPI) are both position:fixed so they stay visible while
  // scrolling — their actual rendered heights are written here so the
  // summary row's own top offset, its flow-spacer, and the Report Index
  // card's top offset (which sits below both) can all size/position
  // themselves off real measurements instead of a guessed constant.
  //
  // The header's height was previously hardcoded as "130px" throughout
  // the CSS — a guess that didn't account for it varying with content
  // (business name length, whether "Last updated" is shown, the owner-
  // only Upload Logo button, etc.). When the real header was taller than
  // that guess, the summary row and Report Index card both positioned
  // themselves partly UNDER the header — invisible, since the header's
  // opaque background and higher z-index paint over them there.
  //
  // A ResizeObserver, not a one-time measurement — the summary row's own
  // content (status text, Q&A counts, CPI value, etc.) fills in
  // asynchronously from Firestore well after page load and can make it
  // taller than it was at first measurement.
  function syncFixedHeaderHeights() {
    var header = document.getElementById('dashboardHeader');
    var row = document.querySelector('.dashboard-summary-row');
    if (header) document.documentElement.style.setProperty('--dr-header-height', header.offsetHeight + 'px');
    if (row) document.documentElement.style.setProperty('--dr-summary-row-height', row.offsetHeight + 'px');
  }

  // Some screen-mirroring/casting software fires window 'resize' rapidly
  // and repeatedly while it's capturing frames (reported by a user whose
  // presentation setup uses one) rather than the normal one-shot-per-
  // actual-resize a person dragging a window edge produces. Debounced so
  // a burst of those collapses into a single re-measurement instead of
  // piling up real work (getElementById + offsetHeight reads + style
  // writes) once per fired event — cheap individually, not cheap at
  // whatever rate a capture loop might fire at.
  function debounce(fn, wait) {
    var t = null;
    return function () {
      if (t) clearTimeout(t);
      t = setTimeout(fn, wait);
    };
  }

  function watchFixedHeaderHeights() {
    var header = document.getElementById('dashboardHeader');
    var row = document.querySelector('.dashboard-summary-row');
    syncFixedHeaderHeights();
    var debouncedSync = debounce(syncFixedHeaderHeights, 150);
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(debouncedSync);
      if (header) ro.observe(header);
      if (row) ro.observe(row);
    }
    // Always wired, not just as a no-ResizeObserver fallback — this exact
    // measurement has already broken once before (see the comment above),
    // and a cheap re-check every second is a real safety net against
    // whatever the next timing edge case turns out to be (a late-loading
    // web font reflowing header text after ResizeObserver's own callback
    // already ran, a business-name Firestore read landing between two
    // observer callbacks, etc.) — this is the difference between the
    // header cutting off the summary row for a second and never fully
    // recovering versus self-correcting within a second either way.
    window.addEventListener('resize', debouncedSync);
    window.addEventListener('load', syncFixedHeaderHeights);
    setInterval(syncFixedHeaderHeights, 1000);
  }

  function init() {
    var list = document.getElementById('reportIndexList');
    if (!list) return;

    render(list);
    watchFixedHeaderHeights();
    watchOwner(list);
    // dr-access-control.js resolves role + the Permissions matrix
    // asynchronously — re-render once ready to reveal/gray entries
    // correctly instead of leaving the pre-auth render (nothing graying)
    // as the permanent state.
    window.addEventListener('dr-access:ready', function () { render(list); });

    list.addEventListener('click', function (e) {
      var toggleBtn = e.target.closest('.report-index-category-toggle');
      if (toggleBtn) {
        var catName = toggleBtn.getAttribute('data-category');
        collapsedCategories[catName] = !collapsedCategories[catName];
        render(list);
        return;
      }

      var a = e.target.closest('a[data-target]');
      if (!a) return;
      e.preventDefault();

      if (a.getAttribute('data-disabled')) {
        var deniedId = a.getAttribute('data-target');
        var deniedLabel = (REPORTS[deniedId] && REPORTS[deniedId].label) || 'This report';
        showAccessDeniedToast(deniedLabel);
        return;
      }

      var targetId = a.getAttribute('data-target');
      var action = a.getAttribute('data-action');

      if (action === 'modal') {
        var trigger = document.getElementById(targetId);
        if (trigger) trigger.click();
        return;
      }
      if (action === 'askProject') {
        if (window.drOpenAskProject) window.drOpenAskProject();
        else warn('ask-project.js not loaded yet');
        return;
      }
      if (action === 'statusReport') {
        if (window.drOpenStatusReport) window.drOpenStatusReport();
        else warn('status-report.js not loaded yet');
        return;
      }
      if (action === 'projectDocuments') {
        if (window.drOpenProjectDocuments) window.drOpenProjectDocuments();
        else warn('document-register.js not loaded yet');
        return;
      }
      if (action === 'projectCharter') {
        if (window.drOpenProjectCharter) window.drOpenProjectCharter();
        else warn('project-charter-link.js not loaded yet');
        return;
      }
      if (action === 'permissions') {
        if (window.drOpenPermissionsWindow) window.drOpenPermissionsWindow();
        else warn('permissions.js not loaded yet');
        return;
      }
      if (action === 'dataImports') {
        if (window.drOpenDataImportsModal) window.drOpenDataImportsModal();
        else warn('settings.js not loaded yet');
        return;
      }
      if (action === 'insightMode') {
        if (window.drOpenInsightModeModal) window.drOpenInsightModeModal();
        else warn('insight-mode-settings.js not loaded yet');
        return;
      }
      if (action === 'language') {
        if (window.drOpenLanguageWindow) window.drOpenLanguageWindow();
        else warn('language.js not loaded yet');
        return;
      }
      if (action === 'manageProjectAccess') {
        if (window.drOpenProjectAccessWindow) window.drOpenProjectAccessWindow();
        else warn('manage-project-access.js not loaded yet');
        return;
      }
      if (action === 'createAccount') {
        if (window.drOpenCreateAccountWindow) window.drOpenCreateAccountWindow();
        else warn('create-account.js not loaded yet');
        return;
      }
      if (action === 'notificationSettings') {
        if (window.drOpenNotificationSettings) window.drOpenNotificationSettings();
        else warn('notification-settings.js not loaded yet');
        return;
      }
      if (action === 'discrepancyReport') {
        if (window.drOpenDiscrepancyReport) window.drOpenDiscrepancyReport();
        else warn('discrepancyReport.js not loaded yet');
        return;
      }
      scrollToId(targetId);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
