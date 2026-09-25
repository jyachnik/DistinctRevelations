// Public/JS/burndown.js
// Phase 1 dashboard metrics: Burndown, Burnup, Cumulative Flow Diagram, and
// a RAG Status Snapshot — computed from the same milestones/activities data
// gantt.js uses, rendered with Chart.js.
//
// IMPORTANT CAVEAT: the app has never persisted progress-over-time
// snapshots, only a live current value plus a changeLog capped at the last
// 5 edits per task. The "actual" lines below are a best-effort
// reconstruction — real points from changeLog "Progress" entries where
// they exist, a straight-line approximation from (creation, 0%) to
// (today, current progress) where they don't. This was an explicit,
// deliberate tradeoff, not an oversight — see the memory note on this
// project's dashboard-metrics initiative for the reasoning.

(function () {
  'use strict';

  var TAG = '[burndown]';
  function log() { console.log.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function warn() { console.warn.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function error() { console.error.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }

  var OWNER_EMAIL =
    (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) ||
    window.ownerEmail ||
    '';

  var db = null;
  var auth = null;
  var bizKey = null;
  var projKey = null;
  var isOwner = false;

  var milestoneDocs = [];
  var activityDocs = [];

  var burndownMetric = 'tasks'; // 'tasks' | 'duration'
  var burnupMetric = 'tasks';

  var chartInstances = {}; // canvas id -> Chart.js instance, so re-render can destroy+rebuild cleanly

  // ---------- Date helpers ----------
  function toJsDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function dateOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { var r = new Date(d.getTime()); r.setDate(r.getDate() + n); return r; }
  function fmtShort(d) {
    return window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString();
  }

  // ---------- Normalize milestones/activities into one task shape ----------
  function normalizeTask(item, collection) {
    var d = item.data;
    var due = toJsDate(d.dueDate);
    if (!due) return null;
    due = dateOnly(due);

    var start = toJsDate(d.startDate) || toJsDate(d.createdAt);
    start = start ? dateOnly(start) : addDays(due, -3);
    if (start > due) start = due; // don't let already-flagged bad data invert this window too

    var durationDays = Math.max(1, Math.round((due - start) / 86400000));

    var progress = typeof d.progress === 'number' ? d.progress : null;
    var statusLower = (d.status || '').toLowerCase();
    if (progress == null) {
      progress = statusLower === 'completed' ? 100 : statusLower === 'in progress' ? 50 : 0;
    }
    progress = Math.max(0, Math.min(100, progress));

    var bucket = progress >= 100 ? 'completed' : progress > 0 ? 'inProgress' : 'notStarted';

    // Real baseline/actual cost + baseline schedule, when the import
    // included them (see gantt.js) — computeEVM prefers these over
    // approximating PV from the current schedule and AC from EV/CPI.
    var baselineStart = toJsDate(d.baselineStart);
    var baselineFinish = toJsDate(d.baselineFinish);

    return {
      id: collection + '_' + item.id,
      title: d.title || '',
      wbs: d.wbs || null,
      // Critical path flag + Total Slack (days) — from the schedule
      // import's own Critical Yes/No and Total Slack columns (see
      // gantt.js). totalSlack is null on older imports/exports that don't
      // include a Total Slack column — the Critical Path card falls back
      // to the Yes/No flag alone in that case.
      critical: d.critical === true,
      totalSlack: typeof d.totalSlack === 'number' ? d.totalSlack : null,
      // The "milestones" Firestore collection is exactly the 0-duration
      // rows from the import (gantt.js classifies any zero-duration row —
      // or one explicitly flagged Milestone=Yes — into it), so this flag
      // is a reliable stand-in for "0-day duration item" without having to
      // re-derive it from start/due (which get a synthetic 3-day window
      // below when no startDate is set, so start!==due isn't a safe test).
      isMilestone: collection === 'milestones',
      // A WBS summary row (e.g. "1.0 Project Management") — see gantt.js's
      // import, which detects this from Outline_Level. Always excluded in
      // buildTasks() below; a summary row's own Cost/Progress/Duration is
      // already a rollup of its children, so counting it alongside them
      // multiplies the same underlying work (and budget) several times
      // over instead of adding anything new.
      isSummary: d.isSummary === true,
      start: start,
      due: due,
      durationDays: durationDays,
      progress: progress,
      bucket: bucket,
      cost: typeof d.cost === 'number' ? d.cost : null, // owner-only EVM chart use
      baselineCost: typeof d.baselineCost === 'number' ? d.baselineCost : null,
      actualCost: typeof d.actualCost === 'number' ? d.actualCost : null,
      baselineStart: baselineStart ? dateOnly(baselineStart) : null,
      baselineFinish: baselineFinish ? dateOnly(baselineFinish) : null,
      createdAt: toJsDate(d.createdAt) || start,
      changeLog: d.changeLog || []
    };
  }

  // Milestones (0-day duration items) are excluded from the metrics charts
  // by default — they're point-in-time gates, not work with a real
  // progress curve, and including them alongside ~200 real tasks skews
  // every task-count chart. Toggled by the "Include milestones" checkbox
  // above the charts row; off by default.
  var includeMilestones = false;

  function buildTasks() {
    var tasks = [];
    milestoneDocs.forEach(function (item) {
      var t = normalizeTask(item, 'milestones');
      if (t) tasks.push(t);
    });
    activityDocs.forEach(function (item) {
      var t = normalizeTask(item, 'activities');
      if (t) tasks.push(t);
    });
    if (!includeMilestones) tasks = tasks.filter(function (t) { return !t.isMilestone; });
    // Always excluded, not a toggle — a summary row isn't independent
    // work; it's a rollup label for the tasks already counted below it.
    tasks = tasks.filter(function (t) { return !t.isSummary; });
    return tasks;
  }

  // ---------- Per-task progress-over-time reconstruction ----------
  function progressPointsForTask(task, today) {
    var points = [];
    (task.changeLog || []).forEach(function (entry) {
      var when = toJsDate(entry.changedAt);
      if (!when) return;
      (entry.changes || []).forEach(function (c) {
        if (c.field === 'Progress') {
          var pct = parseFloat(String(c.to).replace('%', ''));
          if (!isNaN(pct)) points.push({ date: dateOnly(when), progress: pct });
        }
      });
    });
    points.sort(function (a, b) { return a.date - b.date; });

    // Anchor the zero-point to the task's own schedule START date, not its
    // Firestore createdAt — for bulk-imported data (this app's main data
    // source), every task shares the same createdAt (the moment the CSV
    // was imported), which has nothing to do with when its real work
    // began. Anchoring to createdAt made every task read as 0% right up
    // until the import instant and then jump, which is what broke the
    // actual line. The schedule start is the meaningful zero-point.
    var zeroDate = task.start;

    if (!points.length) {
      // No recorded history — straight line from schedule start (0%) to
      // either the task's own due date (if it's already done) or today
      // (if it's still open). This is the common case for most tasks,
      // especially freshly-imported ones with no edit history yet.
      //
      // Using "today" as the end anchor for an ALREADY-COMPLETE task was a
      // real bug: it made every finished task creep up to 100% only by
      // today's date, no matter how long ago it actually finished — so the
      // Cumulative Flow Diagram's "Completed" band stayed at zero for the
      // entire chart (nothing ever reached >=100% before the very last
      // point), and Burndown/Burnup's "actual" lines understated progress
      // for the same reason. Anchoring a complete task's 100% point to its
      // own due date fixes both — progressAt() already holds the last
      // point's value for any later date, including today.
      var endDate = task.progress >= 100 ? task.due : today;
      if (endDate < zeroDate) endDate = zeroDate;
      points.push({ date: zeroDate, progress: 0 });
      points.push({ date: endDate, progress: task.progress });
    } else {
      if (points[0].date > zeroDate) points.unshift({ date: zeroDate, progress: 0 });
      var last = points[points.length - 1];
      if (last.date < today || last.progress !== task.progress) {
        points.push({ date: today, progress: task.progress });
      }
    }
    return points;
  }

  function progressAt(points, date) {
    if (!points.length) return 0;
    if (date <= points[0].date) return points[0].progress;
    for (var i = 1; i < points.length; i++) {
      if (date <= points[i].date) {
        var a = points[i - 1], b = points[i];
        var span = b.date - a.date;
        var frac = span > 0 ? (date - a.date) / span : 1;
        return a.progress + (b.progress - a.progress) * frac;
      }
    }
    return points[points.length - 1].progress;
  }

  // ---------- Timeline: weekly buckets, earliest start through max(latest due, today) ----------
  function buildTimeline(tasks, today) {
    if (!tasks.length) return [];
    var minStart = tasks.reduce(function (m, t) { return t.start < m ? t.start : m; }, tasks[0].start);
    var maxDue = tasks.reduce(function (m, t) { return t.due > m ? t.due : m; }, tasks[0].due);
    var end = maxDue > today ? maxDue : today;

    var dates = [];
    var d = dateOnly(minStart);
    while (d <= end) {
      dates.push(new Date(d.getTime()));
      d = addDays(d, 7);
    }
    if (!dates.length || dates[dates.length - 1].getTime() !== end.getTime()) dates.push(new Date(end.getTime()));
    return dates;
  }

  function weight(task, metric) {
    return metric === 'duration' ? task.durationDays : 1;
  }

  // ---------- Burndown / Burnup ----------
  function computeBurnBurnup(tasks, timeline, today, metric) {
    var total = tasks.reduce(function (sum, t) { return sum + weight(t, metric); }, 0);
    var perTaskPoints = tasks.map(function (t) { return { task: t, points: progressPointsForTask(t, today) }; });

    var plannedRemaining = [], actualRemaining = [], plannedComplete = [], actualComplete = [], totalLine = [];

    timeline.forEach(function (date) {
      var plannedDone = 0;
      tasks.forEach(function (t) {
        var w = weight(t, metric);
        var pct;
        if (date <= t.start) pct = 0;
        else if (date >= t.due) pct = 100;
        else pct = ((date - t.start) / (t.due - t.start)) * 100;
        plannedDone += w * (pct / 100);
      });

      var isPast = date <= today;
      var actualDone = null;
      if (isPast) {
        actualDone = 0;
        perTaskPoints.forEach(function (pt) {
          actualDone += weight(pt.task, metric) * (progressAt(pt.points, date) / 100);
        });
      }

      plannedComplete.push(plannedDone);
      plannedRemaining.push(total - plannedDone);
      actualComplete.push(actualDone);
      actualRemaining.push(actualDone == null ? null : total - actualDone);
      totalLine.push(total);
    });

    // Incremental work completed per period (the delta between consecutive
    // actualComplete points) — the "Daily Completed" bars in a classic
    // burndown, showing throughput per period rather than just the
    // cumulative trend.
    var periodCompleted = actualComplete.map(function (val, i) {
      if (val == null) return null;
      var prev = i > 0 ? actualComplete[i - 1] : 0;
      if (prev == null) prev = 0;
      return Math.max(0, val - prev);
    });

    return {
      total: total,
      plannedRemaining: plannedRemaining, actualRemaining: actualRemaining,
      plannedComplete: plannedComplete, actualComplete: actualComplete,
      totalLine: totalLine, periodCompleted: periodCompleted
    };
  }

  // ---------- Cumulative Flow Diagram ----------
  function computeCFD(tasks, timeline, today) {
    var perTaskPoints = tasks.map(function (t) { return { task: t, points: progressPointsForTask(t, today) }; });
    var notStarted = [], inProgress = [], completed = [];

    timeline.forEach(function (date) {
      if (date > today) { notStarted.push(null); inProgress.push(null); completed.push(null); return; }
      var n = 0, p = 0, c = 0;
      perTaskPoints.forEach(function (pt) {
        // A task whose own scheduled start hasn't arrived yet isn't part
        // of the visible backlog at this point in time — it hasn't
        // entered the flow. Without this, "Not Started" counted the
        // entire project's remaining task list from day one regardless of
        // when each task was actually scheduled to begin, so it read as
        // a near-flat band at ~the total task count instead of a queue
        // that grows as work actually enters it (see the reference CFD:
        // the total stack height grows over time, it isn't fixed).
        if (pt.task.start > date) return;
        var pct = progressAt(pt.points, date);
        if (pct >= 100) c++;
        else if (pct > 0) p++;
        else n++;
      });
      notStarted.push(n); inProgress.push(p); completed.push(c);
    });

    return { notStarted: notStarted, inProgress: inProgress, completed: completed };
  }

  // ---------- EVM: Planned Value / Earned Value / Actual Cost (owner-only) ----------
  // PV = "the authorized budget assigned to scheduled work" — spread each
  // task's BASELINE cost linearly across its BASELINE start->finish window
  // when the import provided baseline data (real MS Project baseline
  // fields); falls back to the current cost/schedule for tasks or imports
  // without a baseline, same as before.
  // EV reuses the same changeLog-approximated progress reconstruction as
  // Burndown/Burnup, weighted by the same cost basis as PV (baseline cost
  // where available) so EV and PV are measured against the same budget.
  // AC uses each task's real Actual Cost (from the import) when present,
  // spread over time in proportion to that task's own reconstructed
  // progress; only falls back to EV/project-CPI for tasks with no Actual
  // Cost figure at all.
  function computeEVM(tasks, timeline, today, projectCPI) {
    function budgetBasis(t) { return typeof t.baselineCost === 'number' ? t.baselineCost : t.cost; }
    var costedTasks = tasks.filter(function (t) { return typeof budgetBasis(t) === 'number'; });
    var perTaskPoints = costedTasks.map(function (t) { return { task: t, points: progressPointsForTask(t, today) }; });
    var cpi = typeof projectCPI === 'number' && projectCPI > 0 ? projectCPI : 1;
    // "every", not "some" — the AC line should only drop the "(approximate)"
    // qualifier when every costed task has a real Actual Cost figure, not
    // just one or two of them.
    var hasRealActualCost = costedTasks.length > 0 && costedTasks.every(function (t) { return typeof t.actualCost === 'number'; });

    var pv = [], ev = [], ac = [];
    timeline.forEach(function (date) {
      var pvVal = 0;
      costedTasks.forEach(function (t) {
        var pvStart = t.baselineStart || t.start;
        var pvDue = t.baselineFinish || t.due;
        var pct;
        if (date <= pvStart) pct = 0;
        else if (date >= pvDue) pct = 100;
        else pct = ((date - pvStart) / (pvDue - pvStart)) * 100;
        pvVal += budgetBasis(t) * (pct / 100);
      });
      pv.push(pvVal);

      if (date > today) { ev.push(null); ac.push(null); return; }
      var evVal = 0, acVal = 0;
      perTaskPoints.forEach(function (pt) {
        var fraction = progressAt(pt.points, date) / 100;
        var taskEv = budgetBasis(pt.task) * fraction;
        evVal += taskEv;
        acVal += typeof pt.task.actualCost === 'number' ? pt.task.actualCost * fraction : taskEv / cpi;
      });
      ev.push(evVal);
      ac.push(acVal);
    });

    return { pv: pv, ev: ev, ac: ac, hasCostData: costedTasks.length > 0, hasRealActualCost: hasRealActualCost };
  }

  // ---------- Cash Flow report (owner-only) ----------
  // Matches MS Project's own built-in "Cash Flow" report layout you
  // referenced: a Cost-per-period bar + Cumulative Cost line. Period
  // granularity is selectable (Week/Month/3 Month/6 Month/Year) via the
  // buttons on the card, same pattern as the Gantt's own view-mode
  // buttons. The bar/line pair uses the same per-task linear-spread
  // technique as EVM's PV, just at whatever period width is selected.
  // The 4 top stat tiles (Actual/Baseline/Remaining/Variance) come straight
  // from the import's own project-level rollup, not recomputed:
  //   Remaining Cost = current Cost - Actual Cost
  //   Cost Variance  = current Cost - Baseline Cost  (MS Project's own
  //                    schedule-level "Cost Variance" field — NOT the
  //                    Cost Performance card's EVM-based "CV" = EV - AC,
  //                    a different, unrelated calculation despite the
  //                    similar name)
  // A TRUE cash flow report (real invoice/payment timing) is a separate
  // future phase — MS Project schedules have no billing/payment-date data
  // to draw that from.
  // Shared by EVERY chart on the dashboard — one global control (the
  // sticky sidebar to the left of the charts row) drives all of them at
  // once, via the single `timeline` renderAll() builds and passes down.
  // Was '3month' — with only a couple of quarterly data points, the
  // Cumulative Flow area chart (and every other trend chart sharing this
  // one control) rendered as a blocky trapezoid that read as a bar chart
  // rather than a smooth area. Weekly gives every trend chart enough
  // points to actually look like a trend on first load; the buttons still
  // switch to any other period.
  var globalTimeframeUnit = 'week'; // 'week' | 'month' | '3month' | '6month' | 'year' | 'total'

  // Roughly how many days each option actually needs to show a real
  // window (not the whole project at once) — used to gray out any option
  // longer than the project's own task date range, since e.g. "Year" on a
  // 3-week project can't show anything a shorter window doesn't already.
  // 'total' is exempt — it always means "everything," so it's never too
  // long by definition.
  var TIMEFRAME_SPAN_DAYS = { week: 7, month: 30, '3month': 90, '6month': 180, year: 365, total: Infinity };

  // Same wording as the sidebar dropdown's own <option> text — a card's
  // "Time Frame: X" badge should always read exactly like the control
  // that set it.
  var TIMEFRAME_OPTION_LABEL = { week: 'Week', month: 'Month', '3month': 'Quarter', '6month': '6 Month', year: 'Year', total: 'Total Project' };

  // A small "Time Frame: X" badge in a card's own top-left corner, so it's
  // clear at a glance which period a given card's numbers reflect without
  // having to check the sidebar. One shared helper (not duplicated per
  // file) — every timeframe-aware chart calls this with its own card id
  // and currently-known unit, whether that's this file's own
  // globalTimeframeUnit or another file's separately-tracked copy of the
  // same value (riskReserve.js, resourceHours.js, qualityDefects.js).
  function applyTimeframeBadge(cardId, unit) {
    var card = document.getElementById(cardId);
    if (!card) return;
    var badge = card.querySelector(':scope > .tf-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'tf-badge';
      card.insertBefore(badge, card.firstChild);
    }
    badge.textContent = 'Time Frame: ' + (TIMEFRAME_OPTION_LABEL[unit] || unit);
  }

  // Grays out (disables) any Time Frame option whose window exceeds the
  // real span between the earliest task start and the latest task due
  // date. If the currently-selected unit becomes unavailable (e.g. after
  // deleting tasks that shortened the range), falls back to 'total'
  // rather than leaving a disabled option selected.
  function refreshTimeframeAvailability(tasks) {
    var sel = document.getElementById('chartsGlobalTimeframeSelect');
    if (!sel) return;
    var minD = null, maxD = null;
    tasks.forEach(function (t) {
      if (t.start && (!minD || t.start < minD)) minD = t.start;
      if (t.due && (!maxD || t.due > maxD)) maxD = t.due;
    });
    var spanDays = (minD && maxD) ? Math.max(1, Math.round((maxD - minD) / 86400000)) : Infinity;
    var activeNowDisabled = false;
    Array.prototype.forEach.call(sel.options, function (opt) {
      var unit = opt.value;
      var need = TIMEFRAME_SPAN_DAYS[unit] || 0;
      var tooLong = spanDays !== Infinity && unit !== 'total' && need > spanDays;
      opt.disabled = tooLong;
      opt.title = tooLong
        ? "The project's task dates span about " + spanDays + ' day' + (spanDays === 1 ? '' : 's') + " — shorter than this option, so it wouldn't show a real change."
        : '';
      if (tooLong && unit === globalTimeframeUnit) activeNowDisabled = true;
    });
    if (activeNowDisabled) {
      globalTimeframeUnit = 'total';
      sel.value = 'total';
    }
  }

  // todayForCap: when given, extends the timeline through "today" even if
  // the project's own latest due date has already passed — same guarantee
  // buildTimeline() gives Burndown/Burnup/CFD. Cash Flow's own projection
  // (which deliberately runs past today, to project completion) omits it.
  function buildPeriodTimeline(tasks, unit, todayForCap) {
    if (!tasks.length) return [];
    var minStart = tasks.reduce(function (m, t) { return t.start < m ? t.start : m; }, tasks[0].start);
    var maxDue = tasks.reduce(function (m, t) { return t.due > m ? t.due : m; }, tasks[0].due);
    if (todayForCap && todayForCap > maxDue) maxDue = todayForCap;

    function weekBuckets() {
      var dates = [];
      var wd = dateOnly(minStart);
      while (wd <= maxDue) { dates.push(new Date(wd.getTime())); wd = addDays(wd, 7); }
      if (!dates.length || dates[dates.length - 1].getTime() !== maxDue.getTime()) dates.push(new Date(maxDue.getTime()));
      return dates;
    }
    function monthBuckets(monthsPerBucket) {
      var pStart = new Date(minStart.getFullYear(), Math.floor(minStart.getMonth() / monthsPerBucket) * monthsPerBucket, 1);
      var dates = [];
      var d = new Date(pStart.getTime());
      while (d <= maxDue) {
        d = new Date(d.getFullYear(), d.getMonth() + monthsPerBucket, 1);
        dates.push(new Date(d.getTime() - 86400000)); // last day of the period just ended
      }
      if (!dates.length || dates[dates.length - 1] < maxDue) dates.push(new Date(maxDue.getTime()));
      return dates;
    }

    if (unit === 'week') return weekBuckets();

    if (unit === 'total') {
      // Deliberately NOT calendar-aligned like every other unit (which all
      // bucket by real month/quarter/6-month/year boundaries) — "Total
      // Project" instead slices the whole start-to-end span into a fixed
      // number of even pieces. That guarantees it always reads as its own
      // distinct, coarser view of the whole arc, rather than coincidentally
      // landing on the exact same bucket count as Month (or Quarter, etc.)
      // purely because of how long this particular project happens to be —
      // which is what silently made it look identical to Month before.
      var TOTAL_BUCKETS = 10;
      var totalStart = dateOnly(minStart);
      var totalSpanMs = maxDue.getTime() - totalStart.getTime();
      if (totalSpanMs <= 0) return [new Date(maxDue.getTime())];
      var totalDates = [];
      for (var i = 1; i <= TOTAL_BUCKETS; i++) {
        totalDates.push(new Date(totalStart.getTime() + Math.round(totalSpanMs * i / TOTAL_BUCKETS)));
      }
      return totalDates;
    }

    var monthsPerBucket = unit === 'month' ? 1 : unit === '6month' ? 6 : unit === 'year' ? 12 : 3;
    var result = monthBuckets(monthsPerBucket);

    // Only bail out to weekly for a genuinely degenerate case (fewer than
    // 2 points can't even draw a line). Coarser units are SUPPOSED to look
    // sparser than Month — that's the whole point of picking them — so
    // this deliberately does NOT step Quarter/6 Month/Year back down to
    // finer buckets just because they produce fewer points than Month
    // would. The previous version did exactly that (cascading all the way
    // down to monthly whenever a coarser bucket gave < 8 points), which is
    // why Quarter/6 Month/Year/Total all silently rendered the identical
    // monthly-bucketed curve as Month for any project under ~2 years —
    // the underlying data never actually changed when those options were
    // picked, only some charts' axis LABELS did (see periodLabel()),
    // which is why it looked like a difference on some charts and not
    // others.
    if (result.length < 2) result = weekBuckets();
    return result;
  }

  // Human phrasing for the global Time Frame control, shared by every
  // insight below so they all describe "this quarter"/"this month"/etc.
  // consistently instead of echoing the raw unit key.
  function timeframeLabel(unit) {
    return {
      week: 'this week', month: 'this month', '3month': 'this quarter',
      '6month': 'the last 6 months', year: 'this year', total: 'the full project'
    }[unit] || 'the selected period';
  }
  // Last non-null value in an array — used to read "as of today" out of
  // a timeline series where future points are intentionally null.
  function lastKnown(arr) {
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i] != null) return arr[i];
    }
    return null;
  }

  // ---------- Full-history trend facts (for AI Project Analysis) --------
  // The on-screen insight box only ever describes whatever period the
  // Time Frame control is currently set to — that's what these charts are
  // FOR. But the AI Project Analysis (see ai-analysis.js) needs to be able
  // to describe fluctuation ACROSS periods (e.g. "a slowdown in Q2 before
  // recovering"), which a single period's snapshot can't show. So each
  // timeframe chart also computes one extra, period-INDEPENDENT series —
  // always the full project history at monthly granularity, regardless of
  // whatever the Time Frame control is set to — and hands it to
  // window.drInsight.setHistory(). This never touches what's rendered on
  // screen; it's purely extra context fed into the next "Run Analysis".
  function buildHistoryTimeline(tasks, today) {
    return buildPeriodTimeline(tasks, 'month', today);
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  function summarizeTrend(values, noun) {
    var vals = values.filter(function (v) { return v != null; });
    if (vals.length < 2) return '';
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var avg = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    var first = vals[0], last = vals[vals.length - 1];
    var direction = last > first * 1.05 ? 'trending upward' : last < first * 0.95 ? 'trending downward' : 'holding roughly steady';
    return 'Across the full project history (by month), ' + noun + ' ranged from ' + round1(min) + ' to ' + round1(max) + ' (avg ' + round1(avg) + '), ' + direction + ' overall.';
  }

  function periodLabel(date, unit) {
    if (unit === 'week' || unit === 'month' || unit === 'total') return fmtShort(date);
    if (unit === 'year') return String(date.getFullYear());
    var monthsPerBucket = unit === '6month' ? 6 : 3;
    var tag = unit === '6month' ? 'H' : 'Q';
    return tag + (Math.floor(date.getMonth() / monthsPerBucket) + 1) + ' ' + date.getFullYear();
  }

  // Cost and Baseline are spread as TWO SEPARATE curves here (unlike EVM's
  // PV, which blends them via a baseline-preferring "budgetBasis") so Cost
  // Variance (Cost - Baseline) can be computed AT EACH PERIOD POINT — this
  // is what makes the Variance number change with the selected time frame,
  // instead of only ever showing the one static whole-project total.
  // projectEAC, when given, anchors a forecast line: real Actual Cost
  // spread by each task's own reconstructed progress (same technique as
  // EVM's AC, so it only covers real progress up to "today"), then a
  // straight line from the last known actual point to (project end, EAC)
  // — using MS Project's own Estimate At Completion, not a new guess, to
  // answer "where will unfinished tasks put the total by project end."
  function computeCashFlowReport(tasks, unit, today, projectEAC) {
    var costedTasks = tasks.filter(function (t) { return typeof t.cost === 'number' || typeof t.baselineCost === 'number'; });
    var periods = buildPeriodTimeline(tasks, unit);
    var actualTasks = tasks.filter(function (t) { return typeof t.actualCost === 'number'; });
    var perTaskPoints = actualTasks.map(function (t) { return { task: t, points: progressPointsForTask(t, today) }; });

    var cumulative = [], perPeriod = [], costVariance = [], actual = [];
    var prevCost = 0;
    periods.forEach(function (date) {
      var costTotal = 0, baselineTotal = 0;
      costedTasks.forEach(function (t) {
        if (typeof t.cost === 'number') {
          var cStart = t.start, cDue = t.due, cPct;
          if (date <= cStart) cPct = 0;
          else if (date >= cDue) cPct = 100;
          else cPct = ((date - cStart) / (cDue - cStart)) * 100;
          costTotal += t.cost * (cPct / 100);
        }
        var baselineBasis = typeof t.baselineCost === 'number' ? t.baselineCost : t.cost;
        if (typeof baselineBasis === 'number') {
          var bStart = t.baselineStart || t.start, bDue = t.baselineFinish || t.due, bPct;
          if (date <= bStart) bPct = 0;
          else if (date >= bDue) bPct = 100;
          else bPct = ((date - bStart) / (bDue - bStart)) * 100;
          baselineTotal += baselineBasis * (bPct / 100);
        }
      });
      cumulative.push(costTotal);
      perPeriod.push(costTotal - prevCost);
      prevCost = costTotal;
      costVariance.push(costTotal - baselineTotal);

      if (today && date <= today) {
        var actualTotal = 0;
        perTaskPoints.forEach(function (pt) {
          actualTotal += pt.task.actualCost * (progressAt(pt.points, date) / 100);
        });
        actual.push(actualTotal);
      } else {
        actual.push(null);
      }
    });

    // Forecast: connects from the last known actual point straight to
    // (project end, EAC). Only meaningful once there's at least one real
    // actual point and a known EAC to aim at.
    var forecast = periods.map(function () { return null; });
    var lastKnownIdx = -1;
    for (var i = actual.length - 1; i >= 0; i--) {
      if (actual[i] != null) { lastKnownIdx = i; break; }
    }
    if (lastKnownIdx >= 0 && lastKnownIdx < periods.length - 1 && typeof projectEAC === 'number') {
      var startVal = actual[lastKnownIdx];
      var startDate = periods[lastKnownIdx];
      var endDate = periods[periods.length - 1];
      var span = endDate - startDate;
      forecast[lastKnownIdx] = startVal;
      for (var j = lastKnownIdx + 1; j < periods.length; j++) {
        var frac = span > 0 ? (periods[j] - startDate) / span : 1;
        forecast[j] = startVal + (projectEAC - startVal) * frac;
      }
    }

    return {
      labels: periods.map(function (d) { return periodLabel(d, unit); }),
      perPeriod: perPeriod,
      cumulative: cumulative,
      costVariance: costVariance,
      actual: actual,
      forecast: forecast,
      hasCostData: costedTasks.length > 0
    };
  }

  // ---------- Budgeted (baseline) vs Actual cost, over time (owner-only) ----------
  // A time-phased 2-line view, distinct from EVM's 3-line PV/EV/AC chart —
  // just Budgeted (= EVM's PV) vs Actual (= EVM's AC), at a selectable
  // period width. "Total Project" collapses to the two endpoints of the
  // full project timeline (same one Burndown/Burnup/CFD use), so it reads
  // as a single rising line from $0 to the final totals rather than a
  // meaningless one-point chart.
  function computeBudgetVsActualSeries(tasks, unit, today, projectCPI) {
    var periods = buildPeriodTimeline(tasks, unit, today);
    var evmData = computeEVM(tasks, periods, today, projectCPI);
    var labels = periods.map(function (d) { return periodLabel(d, unit); });
    return { labels: labels, budgeted: evmData.pv, actual: evmData.ac, hasData: evmData.hasCostData };
  }

  // ---------- RAG distribution snapshot (open items only) ----------
  // Covers every currently-open task project-wide, regardless of the
  // global time frame control — a "snapshot" is what's true right now,
  // not a forward-looking forecast of what's due soon. Windowing this to
  // e.g. the default "Week" period meant it usually had almost nothing to
  // count, so it sat on the same static "nothing due" empty state across
  // render after render — indistinguishable from being frozen, even
  // though it was in fact re-evaluating on every change (same bug class
  // as the Milestone Trend fix above).
  function computeRagDistribution(tasks) {
    var counts = { red: 0, amber: 0, green: 0 };
    tasks.forEach(function (t) {
      if (t.bucket === 'completed') return; // snapshot is about OPEN risk, not closed work
      var jeopardy = window.drRag ? window.drRag.compute(t.start, t.due, false) : { code: 'green' };
      if (jeopardy.code === 'red') counts.red++;
      else if (jeopardy.code === 'amber') counts.amber++;
      else counts.green++;
    });
    return counts;
  }

  // ---------- Chart.js rendering ----------
  function destroyChart(id) {
    if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
  }

  // IMPORTANT: the empty-state helpers below toggle the canvas's hidden
  // attribute and add/remove a sibling <p>, rather than overwriting
  // wrap.innerHTML — replacing the canvas element via innerHTML would
  // permanently remove it from the DOM, so any later render call's
  // getElementById(canvasId) would return null forever and the chart
  // could never come back even after real data arrived. This was a real
  // bug: any transient empty state (e.g. a snapshot listener firing once
  // with zero docs before an import completes) silently and permanently
  // blanked every chart for the rest of the page's life.
  function setChartEmpty(canvas, message) {
    if (!canvas) return;
    var wrap = canvas.closest('.metrics-chart-wrap');
    if (!wrap) return;
    canvas.hidden = true;
    wrap.classList.add('is-empty');
    var msg = wrap.querySelector('.metrics-empty');
    if (!msg) {
      msg = document.createElement('p');
      msg.className = 'metrics-empty';
      wrap.appendChild(msg);
    }
    msg.textContent = message;
  }
  function clearChartEmpty(canvas) {
    if (!canvas) return;
    var wrap = canvas.closest('.metrics-chart-wrap');
    if (wrap) {
      wrap.classList.remove('is-empty');
      var msg = wrap.querySelector('.metrics-empty');
      if (msg) msg.remove();
    }
    canvas.hidden = false;
  }

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
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 90, minRotation: 90, autoSkip: true } },
        y: { beginAtZero: true, title: { display: true, text: yLabel, font: { size: 11 } }, grid: { color: '#e0e0e0' } }
      }
    };
  }

  function renderBurndown(tasks, timeline, today) {
    var canvas = document.getElementById('burndownChart');
    if (!canvas || typeof window.Chart === 'undefined') return;
    clearChartEmpty(canvas);
    var data = computeBurnBurnup(tasks, timeline, today, burndownMetric);
    var labels = timeline.map(function (d) { return periodLabel(d, globalTimeframeUnit); });
    var unit = burndownMetric === 'duration' ? 'days remaining' : 'tasks remaining';

    destroyChart('burndownChart');
    // Clean two-line burndown (ideal vs. actual remaining) — matching the
    // PMI reference exactly. Velocity (per-period completed work) is its
    // own separate chart now, not an overlay here.
    chartInstances.burndownChart = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Ideal',
            data: data.plannedRemaining,
            borderColor: '#4a3aa7',
            backgroundColor: '#4a3aa7',
            pointRadius: 1,
            pointHoverRadius: 3,
            borderWidth: 2,
            tension: 0
          },
          {
            label: 'Actual (approximate)',
            data: data.actualRemaining,
            borderColor: '#dd3333',
            backgroundColor: '#dd3333',
            pointRadius: 1,
            pointHoverRadius: 3,
            borderWidth: 2,
            tension: 0.1
          }
        ]
      },
      options: commonLineOptions(unit)
    });

    if (window.drInsight) {
      var lastIdx = -1;
      for (var i = data.actualRemaining.length - 1; i >= 0; i--) { if (data.actualRemaining[i] != null) { lastIdx = i; break; } }
      if (lastIdx >= 0) {
        var actualR = data.actualRemaining[lastIdx], idealR = data.plannedRemaining[lastIdx];
        var diff = Math.round(idealR - actualR); // positive = ahead (fewer remaining than ideal)
        var noun = burndownMetric === 'duration' ? 'days' : 'tasks';
        var msg = Math.round(actualR) + ' ' + noun + ' remaining vs. an ideal of ' + Math.round(idealR) + ' ' + timeframeLabel(globalTimeframeUnit) + ' — ' +
          (Math.abs(diff) < 1 ? 'tracking almost exactly to plan.' : (diff > 0 ? Math.abs(diff) + ' ' + noun + ' ahead of plan.' : Math.abs(diff) + ' ' + noun + ' behind plan.'));
        window.drInsight.set('burndownCard', msg);
      } else {
        window.drInsight.set('burndownCard', '');
      }
      if (window.drInsight.setHistory) {
        var histData = computeBurnBurnup(tasks, buildHistoryTimeline(tasks, today), today, burndownMetric);
        window.drInsight.setHistory('burndownCard', summarizeTrend(histData.actualRemaining, noun + ' remaining'));
      }
    }
  }

  function renderBurnup(tasks, timeline, today) {
    var canvas = document.getElementById('burnupChart');
    if (!canvas || typeof window.Chart === 'undefined') return;
    clearChartEmpty(canvas);
    var data = computeBurnBurnup(tasks, timeline, today, burnupMetric);
    var labels = timeline.map(function (d) { return periodLabel(d, globalTimeframeUnit); });
    var unit = burnupMetric === 'duration' ? 'days complete' : 'tasks complete';

    destroyChart('burnupChart');
    chartInstances.burnupChart = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Ideal',
            data: data.plannedComplete,
            borderColor: '#898781',
            backgroundColor: '#898781',
            borderDash: [6, 4],
            pointRadius: 1,
            pointHoverRadius: 3,
            borderWidth: 2,
            tension: 0
          },
          {
            label: 'Completed (approximate)',
            data: data.actualComplete,
            borderColor: '#dd3333',
            backgroundColor: '#dd3333',
            pointRadius: 1,
            pointHoverRadius: 3,
            borderWidth: 2,
            tension: 0.1
          }
        ]
      },
      options: commonLineOptions(unit)
    });

    if (window.drInsight) {
      var lastIdxUp = -1;
      for (var iu = data.actualComplete.length - 1; iu >= 0; iu--) { if (data.actualComplete[iu] != null) { lastIdxUp = iu; break; } }
      if (lastIdxUp >= 0) {
        var doneVal = data.actualComplete[lastIdxUp], idealVal = data.plannedComplete[lastIdxUp];
        var pctDone = data.total ? Math.round((doneVal / data.total) * 100) : 0;
        var nounUp = burnupMetric === 'duration' ? 'days' : 'tasks';
        var msgUp = Math.round(doneVal) + ' of ' + Math.round(data.total) + ' ' + nounUp + ' complete (' + pctDone + '%) ' + timeframeLabel(globalTimeframeUnit) + ', ' +
          (doneVal >= idealVal ? 'ahead of' : 'behind') + ' the ideal pace of ' + Math.round(idealVal) + '.';
        window.drInsight.set('burnupCard', msgUp);
      } else {
        window.drInsight.set('burnupCard', '');
      }
      if (window.drInsight.setHistory) {
        var histDataUp = computeBurnBurnup(tasks, buildHistoryTimeline(tasks, today), today, burnupMetric);
        window.drInsight.setHistory('burnupCard', summarizeTrend(histDataUp.actualComplete, nounUp + ' completed'));
      }
    }
  }

  function renderVelocity(tasks, timeline, today) {
    var canvas = document.getElementById('velocityChart');
    if (!canvas || typeof window.Chart === 'undefined') return;
    clearChartEmpty(canvas);
    var data = computeBurnBurnup(tasks, timeline, today, burndownMetric);
    var labels = timeline.map(function (d) { return periodLabel(d, globalTimeframeUnit); });
    var unit = burndownMetric === 'duration' ? 'days completed' : 'tasks completed';

    var pastValues = data.periodCompleted.filter(function (v) { return v != null; });
    var avg = pastValues.length ? pastValues.reduce(function (a, b) { return a + b; }, 0) / pastValues.length : 0;
    // Spans every period on the chart, not just the ones with an actual
    // bar — a flat reference line reads as "here's the target to compare
    // against" across the whole timeline, including future periods,
    // rather than mysteriously stopping partway through the chart.
    var avgLine = data.periodCompleted.map(function () { return avg; });

    destroyChart('velocityChart');
    // Bars are the per-period throughput; the dashed line is the running
    // average ("velocity") — matching the PMI reference's bar+average-line
    // pattern. A flat reference line, like Burnup's "Ideal"/"Total", so it
    // gets no point markers of its own.
    chartInstances.velocityChart = new window.Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            type: 'bar',
            label: 'Completed per period',
            data: data.periodCompleted,
            backgroundColor: '#7d5fc4',
            // Higher order = drawn further back — Chart.js draws lower
            // "order" values last (on top), so this needs to be higher
            // than the average-velocity line's order below for the line
            // to actually sit in front of the bars instead of behind them.
            order: 2
          },
          {
            type: 'line',
            label: 'Average velocity (' + avg.toFixed(1) + ')',
            data: avgLine,
            borderColor: '#dd3333',
            borderDash: [6, 4],
            pointRadius: 0,
            borderWidth: 3,
            tension: 0,
            order: 1
          }
        ]
      },
      options: commonLineOptions(unit)
    });

    if (window.drInsight) {
      var latestPeriod = lastKnown(data.periodCompleted);
      if (latestPeriod != null && pastValues.length) {
        var nounV = burndownMetric === 'duration' ? 'days' : 'tasks';
        var cmp = latestPeriod > avg ? 'above' : (latestPeriod < avg ? 'below' : 'right at');
        window.drInsight.set('velocityCard', 'Average velocity is ' + avg.toFixed(1) + ' ' + nounV + '/period ' + timeframeLabel(globalTimeframeUnit) + '; the most recent period completed ' + Math.round(latestPeriod) + ', ' + cmp + ' average.');
      } else {
        window.drInsight.set('velocityCard', '');
      }
      if (window.drInsight.setHistory) {
        var histDataV = computeBurnBurnup(tasks, buildHistoryTimeline(tasks, today), today, burndownMetric);
        window.drInsight.setHistory('velocityCard', summarizeTrend(histDataV.periodCompleted, nounV + ' completed per month'));
      }
    }
  }

  function renderCFD(tasks, timeline, today) {
    var canvas = document.getElementById('cfdChart');
    if (!canvas || typeof window.Chart === 'undefined') return;
    var data = computeCFD(tasks, timeline, today);

    // CFD only ever has real data up to today — computeCFD pushes null for
    // every date after it. Plotting those null points anyway left a
    // visibly empty gap at the end of the stacked area, reading as "no
    // data" for the chart as a whole. Trim the chart to what's actually
    // happened instead of plotting nothing for what hasn't.
    var cutoff = timeline.length;
    for (var i = 0; i < timeline.length; i++) {
      if (timeline[i] > today) { cutoff = i; break; }
    }

    if (cutoff === 0) {
      setChartEmpty(canvas, 'Nothing in the selected time frame has happened yet.');
      if (window.drInsight) window.drInsight.set('cfdCard', '');
      return;
    }
    clearChartEmpty(canvas);

    var labels = timeline.slice(0, cutoff).map(function (d) { return periodLabel(d, globalTimeframeUnit); });
    var completedData = data.completed.slice(0, cutoff);
    var inProgressData = data.inProgress.slice(0, cutoff);
    var notStartedData = data.notStarted.slice(0, cutoff);

    destroyChart('cfdChart');
    chartInstances.cfdChart = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Completed',
            data: completedData,
            borderColor: '#2f9e44',
            backgroundColor: '#2f9e44',
            fill: true,
            pointRadius: 0,
            borderWidth: 1,
            tension: 0
          },
          {
            label: 'In Progress',
            data: inProgressData,
            borderColor: '#007bff',
            backgroundColor: '#007bff',
            fill: true,
            pointRadius: 0,
            borderWidth: 1,
            tension: 0
          },
          {
            label: 'Not Started',
            data: notStartedData,
            borderColor: '#4a3aa7',
            backgroundColor: '#4a3aa7',
            fill: true,
            pointRadius: 0,
            borderWidth: 1,
            tension: 0
          }
        ]
      },
      options: Object.assign(commonLineOptions('tasks'), {
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 90, minRotation: 90, autoSkip: true } },
          y: { beginAtZero: true, stacked: true, title: { display: true, text: 'tasks', font: { size: 11 } }, grid: { color: '#e0e0e0' } }
        }
      })
    });

    if (window.drInsight) {
      var cDone = lastKnown(data.completed), cProg = lastKnown(data.inProgress), cNot = lastKnown(data.notStarted);
      if (cDone != null) {
        window.drInsight.set('cfdCard', cDone + ' completed, ' + cProg + ' in progress, and ' + cNot + ' not started as of ' + timeframeLabel(globalTimeframeUnit) + '.');
      } else {
        window.drInsight.set('cfdCard', '');
      }
      if (window.drInsight.setHistory) {
        var histCfd = computeCFD(tasks, buildHistoryTimeline(tasks, today), today);
        window.drInsight.setHistory('cfdCard', summarizeTrend(histCfd.completed, 'completed tasks'));
      }
    }
  }

  function renderRagDistribution(tasks) {
    var canvas = document.getElementById('ragDistChart');
    if (!canvas || typeof window.Chart === 'undefined') return;
    var counts = computeRagDistribution(tasks);
    var openTotal = counts.red + counts.amber + counts.green;

    destroyChart('ragDistChart');

    if (!openTotal) {
      setChartEmpty(canvas, 'No open milestones or activities right now.');
      if (window.drInsight) window.drInsight.set('ragDistCard', '');
      return;
    }
    clearChartEmpty(canvas);

    // Datalabels plugin registered per-chart (not globally via
    // Chart.register) so it only affects this doughnut, not every other
    // chart on the page.
    chartInstances.ragDistChart = new window.Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      plugins: window.ChartDataLabels ? [window.ChartDataLabels] : [],
      data: {
        labels: ['On track (' + counts.green + ')', 'At risk (' + counts.amber + ')', 'Overdue/critical (' + counts.red + ')'],
        datasets: [{
          data: [counts.green, counts.amber, counts.red],
          backgroundColor: ['#2f9e44', '#e0a800', '#dd3333'],
          borderColor: '#ffffff',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        cutout: '50%',
        // Slightly smaller than "fill the whole box" (which is what an
        // unset radius does) — leaves clear breathing room between the
        // ring's own outside-the-arc % labels and the legend below,
        // instead of the ring itself pushing right up against both.
        radius: '80%',
        // Bottom padding here is the actual gap between the ring's
        // outside-the-arc % labels and the legend below — raised further
        // (was 16) since the largest slice's label (bottom of the ring,
        // where Chart.js's clockwise-from-12-o'clock layout puts the last/
        // biggest segment) was still landing right on top of the legend.
        layout: { padding: { top: 10, left: 12, right: 12, bottom: 26 } },
        plugins: {
          legend: { position: 'bottom', align: 'center', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } },
          tooltip: { enabled: true },
          datalabels: {
            // Outside the ring (anchor/align: 'end') rather than inside the
            // arc — a thin slice like "At risk" has no room to fit a
            // legible label inside it, so it was getting silently dropped.
            anchor: 'end',
            align: 'end',
            offset: 16,
            color: function (ctx) { return ctx.dataset.backgroundColor[ctx.dataIndex]; },
            font: { size: 11, weight: 'bold' },
            formatter: function (value) {
              var pct = openTotal ? Math.round((value / openTotal) * 100) : 0;
              return pct > 0 ? pct + '%' : '';
            }
          }
        }
      }
    });

    if (window.drInsight) {
      var riskiest = counts.red > 0 ? 'overdue/critical' : (counts.amber > 0 ? 'at risk' : 'on track');
      window.drInsight.set('ragDistCard', counts.green + ' on track, ' + counts.amber + ' at risk, ' + counts.red + ' overdue/critical out of ' + openTotal + ' open items across the project' + (counts.red > 0 || counts.amber > 0 ? ' — most attention needed on the ' + riskiest + ' ones.' : '.'));
    }
  }

  // ---------- Milestone Trend (schedule-only, visible to everyone) ----------
  // The classic PM "milestone trend chart" — is each milestone's due date
  // holding steady or sliding later over time? Built entirely from the
  // changeLog "Due date" entries already captured on every milestone (from
  // drags and edits), no new import needed. A line/date-scale chart would
  // need a date-axis adapter library this app doesn't load, so this is a
  // table instead: same insight (which milestones have slipped, by how
  // much), without a new dependency.
  // Unlike the timeframe-windowed charts, this always covers every dated
  // milestone in the project regardless of the global period control —
  // it's a slippage audit of the whole milestone set, not a "what's due
  // soon" snapshot, so windowing it would hide exactly the milestones
  // (often the far-out ones) most worth watching for drift.
  function computeMilestoneTrend() {
    var rows = [];
    milestoneDocs.forEach(function (item) {
      var d = item.data;
      var currentDue = toJsDate(d.dueDate);
      if (!currentDue) return;
      currentDue = dateOnly(currentDue);

      var dueDateChanges = (d.changeLog || []).reduce(function (acc, entry) {
        (entry.changes || []).forEach(function (c) {
          if (c.field === 'Due date') acc.push({ from: c.from, to: c.to, changedAt: entry.changedAt });
        });
        return acc;
      }, []);

      // The earliest recorded "from" value is the closest thing to an
      // original due date; with no recorded change, current IS original
      // (nothing to compare against — not the same as "zero slip", so
      // this is flagged separately in the table rather than shown as 0d).
      var originalDue = null;
      if (dueDateChanges.length) {
        var firstFrom = toJsDate(dueDateChanges[0].from);
        if (firstFrom) originalDue = dateOnly(firstFrom);
      }

      var slipDays = originalDue ? Math.round((currentDue - originalDue) / 86400000) : null;
      var lastChangedAt = dueDateChanges.length ? dueDateChanges[dueDateChanges.length - 1].changedAt : null;

      rows.push({
        title: d.title || 'Untitled milestone',
        originalDue: originalDue,
        currentDue: currentDue,
        slipDays: slipDays,
        changeCount: dueDateChanges.length,
        lastChangedAt: lastChangedAt
      });
    });

    // Most-slipped first, so the milestones needing attention surface
    // immediately instead of being buried alphabetically.
    rows.sort(function (a, b) { return (b.slipDays || 0) - (a.slipDays || 0); });
    return rows;
  }

  // Shared click-to-sort for the small schedule-only tables below
  // (Milestone Trend, Critical Path, Top Slipped Tasks) — each has its own
  // default sort baked into its compute*() function (most-urgent-first),
  // but clicking a header re-sorts by that column instead. One generic
  // implementation rather than three near-identical copies.
  function wireTableSort(theadSelector, sortState, renderFn) {
    var thead = document.querySelector(theadSelector);
    if (!thead || thead.__sortWired) return;
    thead.__sortWired = true;
    thead.addEventListener('click', function (e) {
      var th = e.target.closest('th[data-sort]');
      if (!th) return;
      var key = th.getAttribute('data-sort');
      if (sortState.key === key) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.key = key;
        sortState.dir = 'asc';
      }
      renderFn();
    });
  }
  function applyTableSort(rows, sortState) {
    if (!sortState || !sortState.key) return rows;
    var dir = sortState.dir === 'desc' ? -1 : 1;
    return rows.slice().sort(function (a, b) {
      var av = a[sortState.key];
      var bv = b[sortState.key];
      if (av instanceof Date) av = av.getTime();
      if (bv instanceof Date) bv = bv.getTime();
      if (typeof av === 'boolean') av = av ? 1 : 0;
      if (typeof bv === 'boolean') bv = bv ? 1 : 0;
      if (av == null) av = '';
      if (bv == null) bv = '';
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }
  function updateSortIndicators(theadSelector, sortState) {
    document.querySelectorAll(theadSelector + ' th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (sortState.key && th.getAttribute('data-sort') === sortState.key) th.classList.add(sortState.dir);
    });
  }

  var milestoneTrendSort = { key: null, dir: 'asc' };

  function renderMilestoneTrend() {
    var tbody = document.querySelector('#milestoneTrendTable tbody');
    if (!tbody) return;
    wireTableSort('#milestoneTrendTable thead', milestoneTrendSort, renderMilestoneTrend);

    var defaultRows = computeMilestoneTrend();
    var rows = applyTableSort(defaultRows, milestoneTrendSort);
    updateSortIndicators('#milestoneTrendTable thead', milestoneTrendSort);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="metrics-empty">No dated milestones yet.</td></tr>';
      if (window.drInsight) window.drInsight.set('milestoneTrendCard', '');
      return;
    }

    tbody.innerHTML = rows.map(function (r) {
      var slipLabel, slipClass;
      if (r.slipDays == null) { slipLabel = 'No history yet'; slipClass = 'unknown'; }
      else if (r.slipDays > 0) { slipLabel = '+' + r.slipDays + 'd later'; slipClass = r.slipDays > 5 ? 'high' : 'medium'; }
      else if (r.slipDays < 0) { slipLabel = r.slipDays + 'd earlier'; slipClass = 'low'; }
      else { slipLabel = 'On track'; slipClass = 'low'; }

      return '<tr>' +
        '<td>' + esc(r.title) + '</td>' +
        '<td>' + (r.originalDue ? esc(fmtShort(r.originalDue)) : '—') + '</td>' +
        '<td>' + esc(fmtShort(r.currentDue)) + '</td>' +
        '<td><span class="severity-badge severity-' + slipClass + '">' + esc(slipLabel) + '</span></td>' +
        '<td>' + (r.lastChangedAt ? esc(fmtShort(toJsDate(r.lastChangedAt))) : '—') + '</td>' +
        '</tr>';
    }).join('');

    if (window.drInsight) {
      var slipped = rows.filter(function (r) { return r.slipDays > 0; }).length;
      var worst = defaultRows[0]; // default compute order — most-slipped first, independent of the table's current display sort
      var msg = rows.length + ' milestone' + (rows.length === 1 ? '' : 's') + ' tracked across the project, ' + slipped + ' slipped later than originally planned';
      msg += (worst && worst.slipDays > 0) ? ' — most notably "' + worst.title + '" (' + worst.slipDays + ' days later).' : '.';
      window.drInsight.set('milestoneTrendCard', msg);
    }
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ---------- Critical Path (schedule-only, visible to everyone) ----------
  // Every OPEN task/milestone flagged Critical=Yes by the schedule import —
  // any slip on one of these pushes the project's own finish date, unlike
  // a slip on a task with float to spare. Completed critical tasks are
  // excluded: once done, they can no longer threaten the finish date, so
  // keeping them here would just be noise on what's meant to read as
  // "what to watch right now." Sorted by finish date — soonest first, same
  // "most urgent on top" convention as the RAG-style tables elsewhere.
  var criticalPathPage = 1;
  var CRITICAL_PATH_PAGE_SIZE = 15;
  var criticalPathSort = { key: null, dir: 'asc' };

  function computeCriticalPath(tasks) {
    return tasks
      .filter(function (t) { return t.critical && t.bucket !== 'completed'; })
      .sort(function (a, b) { return a.due - b.due; });
  }

  function renderCriticalPath(tasks) {
    var tbody = document.querySelector('#criticalPathTable tbody');
    if (!tbody) return;
    wireTableSort('#criticalPathTable thead', criticalPathSort, function () { renderCriticalPath(buildTasks()); });

    var defaultRows = computeCriticalPath(tasks);
    var rows = applyTableSort(defaultRows, criticalPathSort);
    updateSortIndicators('#criticalPathTable thead', criticalPathSort);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="metrics-empty">No open critical-path items right now.</td></tr>';
      if (window.drInsight) window.drInsight.set('criticalPathCard', '');
      renderTablePagination('criticalPath', 0, 1);
      return;
    }

    var totalPages = Math.max(1, Math.ceil(rows.length / CRITICAL_PATH_PAGE_SIZE));
    if (criticalPathPage > totalPages) criticalPathPage = totalPages;
    if (criticalPathPage < 1) criticalPathPage = 1;
    var startIdx = (criticalPathPage - 1) * CRITICAL_PATH_PAGE_SIZE;
    var pageRows = rows.slice(startIdx, startIdx + CRITICAL_PATH_PAGE_SIZE);

    tbody.innerHTML = pageRows.map(function (t) {
      var slackLabel = typeof t.totalSlack === 'number' ? Math.round(t.totalSlack) + 'd' : '—';
      var slackClass = typeof t.totalSlack === 'number' ? (t.totalSlack <= 0 ? 'high' : t.totalSlack <= 2 ? 'medium' : 'low') : 'unknown';
      return '<tr>' +
        '<td class="wrap-text">' + esc(t.title) + '</td>' +
        '<td>' + (t.isMilestone ? 'Milestone' : 'Activity') + '</td>' +
        '<td><span class="severity-badge severity-' + slackClass + '">' + esc(slackLabel) + '</span></td>' +
        '<td>' + esc(fmtShort(t.start)) + '</td>' +
        '<td>' + esc(fmtShort(t.due)) + '</td>' +
        '<td>' + Math.round(t.progress) + '%</td>' +
        '</tr>';
    }).join('');

    renderTablePagination('criticalPath', rows.length, totalPages);

    if (window.drInsight) {
      var soonest = defaultRows[0]; // default compute order — soonest-due first, independent of the table's current display sort
      var zeroSlack = rows.filter(function (t) { return t.totalSlack === 0; }).length;
      var msg = rows.length + ' open critical-path item' + (rows.length === 1 ? '' : 's') + ' — any slip on ' + (rows.length === 1 ? 'it pushes' : 'these pushes') + ' the project finish date out.';
      msg += ' Nearest: "' + soonest.title + '" due ' + fmtShort(soonest.due) + '.';
      if (zeroSlack > 0) msg += ' ' + zeroSlack + ' with zero slack remaining.';
      window.drInsight.set('criticalPathCard', msg);
    }
  }

  // ---------- Top Slipped Tasks (schedule-only, visible to everyone) ----
  // Same slippage-tracking technique as Milestone Trend (reads the
  // changeLog "Due date" history already captured on every import/edit),
  // but scoped to the general WBS schedule instead — every activity, plus
  // real project milestones/decision gates (type Milestone or unset).
  // Meeting/Event entries are deliberately excluded since Milestone Trend
  // already covers those; the two cards are meant to be complementary, not
  // duplicates of each other. Only tasks that have actually slipped later
  // are included — this is a "who's dragging" list, not a full log.
  var topSlippedPage = 1;
  var TOP_SLIPPED_PAGE_SIZE = 15;
  var topSlippedSort = { key: null, dir: 'asc' };

  function buildTasksForSlippage() {
    var all = [];
    milestoneDocs.forEach(function (item) {
      var data = item.data || {};
      var itemType = data.type || '';
      if (itemType === 'Meeting' || itemType === 'Event') return; // covered by Milestone Trend
      var t = normalizeTask(item, 'milestones');
      if (t) all.push(t);
    });
    activityDocs.forEach(function (item) {
      var t = normalizeTask(item, 'activities');
      if (t) all.push(t);
    });
    return all.filter(function (t) { return !t.isSummary; });
  }

  function computeTopSlippedTasks() {
    var rows = [];
    buildTasksForSlippage().forEach(function (t) {
      var dueDateChanges = (t.changeLog || []).reduce(function (acc, entry) {
        (entry.changes || []).forEach(function (c) {
          if (c.field === 'Due date') acc.push({ from: c.from, to: c.to, changedAt: entry.changedAt });
        });
        return acc;
      }, []);
      if (!dueDateChanges.length) return;

      var firstFrom = toJsDate(dueDateChanges[0].from);
      if (!firstFrom) return;
      var originalDue = dateOnly(firstFrom);
      var slipDays = Math.round((t.due - originalDue) / 86400000);
      if (slipDays <= 0) return; // only interested in tasks that slipped LATER

      rows.push({
        title: t.title, isMilestone: t.isMilestone, bucket: t.bucket,
        originalDue: originalDue, currentDue: t.due, slipDays: slipDays,
        lastChangedAt: dueDateChanges[dueDateChanges.length - 1].changedAt
      });
    });
    rows.sort(function (a, b) { return b.slipDays - a.slipDays; });
    return rows;
  }

  function renderTopSlippedTasks() {
    var tbody = document.querySelector('#topSlippedTable tbody');
    if (!tbody) return;
    wireTableSort('#topSlippedTable thead', topSlippedSort, renderTopSlippedTasks);

    var defaultRows = computeTopSlippedTasks();
    var rows = applyTableSort(defaultRows, topSlippedSort);
    updateSortIndicators('#topSlippedTable thead', topSlippedSort);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="metrics-empty">No tasks have slipped later than originally planned.</td></tr>';
      if (window.drInsight) window.drInsight.set('topSlippedCard', '');
      renderTablePagination('topSlipped', 0, 1);
      return;
    }

    var totalPages = Math.max(1, Math.ceil(rows.length / TOP_SLIPPED_PAGE_SIZE));
    if (topSlippedPage > totalPages) topSlippedPage = totalPages;
    if (topSlippedPage < 1) topSlippedPage = 1;
    var startIdx = (topSlippedPage - 1) * TOP_SLIPPED_PAGE_SIZE;
    var pageRows = rows.slice(startIdx, startIdx + TOP_SLIPPED_PAGE_SIZE);

    tbody.innerHTML = pageRows.map(function (r) {
      var slipClass = r.slipDays > 10 ? 'high' : r.slipDays > 3 ? 'medium' : 'low';
      var statusLabel = r.bucket === 'completed' ? 'Completed' : r.bucket === 'inProgress' ? 'In Progress' : 'Not Started';
      return '<tr>' +
        '<td class="wrap-text">' + esc(r.title) + '</td>' +
        '<td>' + (r.isMilestone ? 'Milestone' : 'Activity') + '</td>' +
        '<td>' + esc(fmtShort(r.originalDue)) + '</td>' +
        '<td>' + esc(fmtShort(r.currentDue)) + '</td>' +
        '<td><span class="severity-badge severity-' + slipClass + '">+' + r.slipDays + 'd</span></td>' +
        '<td>' + esc(statusLabel) + '</td>' +
        '</tr>';
    }).join('');

    renderTablePagination('topSlipped', rows.length, totalPages);

    if (window.drInsight) {
      var worst = defaultRows[0]; // default compute order — most-slipped first, independent of the table's current display sort
      var msg = rows.length + ' task' + (rows.length === 1 ? '' : 's') + ' slipped later than originally planned' +
        ' — most notably "' + worst.title + '" (' + worst.slipDays + ' days later).';
      window.drInsight.set('topSlippedCard', msg);
    }
  }

  // Shared Prev/Next/page-info renderer for the simple table cards above —
  // same page-count text and disabled-state logic every other paginated
  // card in this app uses, just factored out since these two share it
  // identically instead of copy-pasting it twice more.
  function renderTablePagination(prefix, totalRows, totalPages) {
    var page = prefix === 'criticalPath' ? criticalPathPage : topSlippedPage;
    var pageInfoEl = document.getElementById(prefix + 'PageInfo');
    if (pageInfoEl) {
      pageInfoEl.textContent = totalRows
        ? 'Page ' + page + ' of ' + totalPages + ' (' + totalRows + (totalRows === 1 ? ' row' : ' rows') + ')'
        : '';
    }
    var prevBtn = document.getElementById(prefix + 'PagePrev');
    var nextBtn = document.getElementById(prefix + 'PageNext');
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= totalPages;
  }

  function wireTablePaginationButtons() {
    var prevBtn = document.getElementById('criticalPathPagePrev');
    var nextBtn = document.getElementById('criticalPathPageNext');
    if (prevBtn && !prevBtn.__wired) { prevBtn.__wired = true; prevBtn.addEventListener('click', function () { criticalPathPage--; renderCriticalPath(buildTasks()); }); }
    if (nextBtn && !nextBtn.__wired) { nextBtn.__wired = true; nextBtn.addEventListener('click', function () { criticalPathPage++; renderCriticalPath(buildTasks()); }); }

    var slipPrevBtn = document.getElementById('topSlippedPagePrev');
    var slipNextBtn = document.getElementById('topSlippedPageNext');
    if (slipPrevBtn && !slipPrevBtn.__wired) { slipPrevBtn.__wired = true; slipPrevBtn.addEventListener('click', function () { topSlippedPage--; renderTopSlippedTasks(); }); }
    if (slipNextBtn && !slipNextBtn.__wired) { slipNextBtn.__wired = true; slipNextBtn.addEventListener('click', function () { topSlippedPage++; renderTopSlippedTasks(); }); }
  }

  // ---------- Schedule Performance (top-row stat tile) ----------
  // A schedule-only SPI-equivalent: actual complete / ideal complete, by
  // task count — deliberately not dollar-based, so it needs no Actual
  // Cost data and is safe to show to every user, unlike true EVM CPI/CV
  // which will be owner-only once cost data exists.
  function computeSchedulePerformance(tasks, today) {
    var plannedDone = 0, actualDone = 0;
    var perTaskPoints = tasks.map(function (t) { return { task: t, points: progressPointsForTask(t, today) }; });

    tasks.forEach(function (t) {
      var pct;
      if (today <= t.start) pct = 0;
      else if (today >= t.due) pct = 100;
      else pct = ((today - t.start) / (t.due - t.start)) * 100;
      plannedDone += pct / 100;
    });
    perTaskPoints.forEach(function (pt) {
      actualDone += progressAt(pt.points, today) / 100;
    });

    return { spi: plannedDone > 0 ? actualDone / plannedDone : 1, plannedDone: plannedDone, actualDone: actualDone };
  }

  function renderSchedulePerformance(tasks, today) {
    var valueEl = document.getElementById('schedulePerformanceValue');
    var labelEl = document.getElementById('schedulePerformanceLabel');
    if (!valueEl || !labelEl) return;

    if (!tasks.length) {
      valueEl.textContent = '—';
      labelEl.textContent = 'No dated items yet';
      if (window.drInsight) window.drInsight.set('schedulePerformanceCard', '');
      return;
    }

    var perf = computeSchedulePerformance(tasks, today);
    valueEl.textContent = perf.spi.toFixed(2);
    valueEl.classList.remove('is-behind', 'is-caution', 'is-ahead');

    var label, cls;
    if (perf.spi >= 1.00) { label = 'On or ahead of schedule'; cls = 'is-ahead'; }
    else if (perf.spi >= 0.90) { label = 'Behind schedule'; cls = 'is-caution'; }
    else { label = 'Significantly behind schedule'; cls = 'is-behind'; }
    valueEl.classList.add(cls);
    // No longer duplicated as static text here — the insight box below
    // already says this (and more: the actual task-equivalent numbers),
    // so this line was just repeating the same "significantly behind
    // schedule" sentiment twice in the same small card.
    labelEl.textContent = '';

    if (window.drInsight) {
      window.drInsight.set('schedulePerformanceCard', 'SPI is ' + perf.spi.toFixed(2) + ' — ' + label.toLowerCase() + ', with ' + perf.actualDone.toFixed(1) + ' of ' + perf.plannedDone.toFixed(1) + ' planned task-equivalents actually complete.');
    }
  }

  // ---------- Forecast Finish Date (schedule-only stat tile) ----------
  // Mirrors how EAC works for cost: Forecast Finish = Plan Start +
  // (Planned Duration ÷ SPI) — same "at this pace, carry the current trend
  // through to completion" logic, just for schedule instead of cost. Uses
  // the project's own BASELINE Start/Finish (captured from the schedule
  // import's top-level summary row — see gantt.js) as the planned window,
  // not the current/possibly-already-drifted Start/Finish, for the same
  // reason BAC needs baselineCost rather than the current Cost — falling
  // back to the current window only when the import had no Baseline
  // Start/Finish columns to capture.
  function renderForecastFinish(tasks, today) {
    var valueEl = document.getElementById('forecastFinishValue');
    var labelEl = document.getElementById('forecastFinishLabel');
    if (!valueEl || !labelEl) return;

    if (!tasks.length) {
      valueEl.textContent = '—';
      labelEl.textContent = 'No dated items yet';
      if (window.drInsight) window.drInsight.set('forecastFinishCard', '');
      return;
    }

    loadBusinessDoc().then(function (data) {
      var planStart = toJsDate(data.projectBaselineStartDate) || toJsDate(data.projectStartDate);
      var planEnd = toJsDate(data.projectBaselineEndDate) || toJsDate(data.projectEndDate);
      valueEl.classList.remove('is-behind', 'is-caution', 'is-ahead');

      if (!planStart || !planEnd || planEnd <= planStart) {
        valueEl.textContent = '—';
        labelEl.textContent = 'No project window yet';
        if (window.drInsight) window.drInsight.set('forecastFinishCard', '');
        return;
      }

      var perf = computeSchedulePerformance(tasks, today);
      var spi = perf.spi > 0 ? perf.spi : null;
      if (!spi) {
        valueEl.textContent = '—';
        labelEl.textContent = 'Collecting data';
        if (window.drInsight) window.drInsight.set('forecastFinishCard', '');
        return;
      }

      var plannedDurationDays = Math.round((planEnd - planStart) / 86400000);
      var forecastFinish = new Date(planStart.getTime() + (plannedDurationDays / spi) * 86400000);
      var deltaDays = Math.round((forecastFinish - planEnd) / 86400000);

      valueEl.textContent = fmtShort(forecastFinish);
      // On/ahead of plan = green, 1-9 days late = yellow, 10+ days late = red.
      var cls = deltaDays <= 0 ? 'is-ahead' : deltaDays < 10 ? 'is-caution' : 'is-behind';
      valueEl.classList.add(cls);
      labelEl.textContent = deltaDays <= 0
        ? (Math.abs(deltaDays) < 1 ? 'On plan' : Math.abs(deltaDays) + 'd early')
        : deltaDays + 'd late';

      if (window.drInsight) {
        var msg = 'At the current pace (SPI ' + spi.toFixed(2) + '), the project is forecast to finish ' + fmtShort(forecastFinish) +
          (deltaDays <= 0
            ? (Math.abs(deltaDays) < 1 ? ', right on the original plan.' : ', ' + Math.abs(deltaDays) + ' days ahead of the original plan (' + fmtShort(planEnd) + ').')
            : ', ' + deltaDays + ' days later than the original plan (' + fmtShort(planEnd) + ').');
        window.drInsight.set('forecastFinishCard', msg);
      }
    }).catch(function (err) {
      warn('could not load forecast finish data', err);
    });
  }

  // ---------- Cost Performance (owner-only, from the import's own
  // top-level Cost/EAC/CPI/CV rollup — see the extended import in
  // gantt.js's wireImport()) ----------
  function fmtMoney(v) {
    if (v == null || isNaN(v)) return '—';
    var sign = v < 0 ? '-' : '';
    return sign + '$' + Math.round(Math.abs(v)).toLocaleString();
  }

  // Abbreviated ($625K / -$185K) for tight spaces like the 5-block Cost
  // Performance row, where a full "$625,028" was overflowing its block and
  // getting CSS-ellipsis-truncated down to an unreadable "$62…". The full
  // precise value is still available via the element's title tooltip.
  function fmtMoneyCompact(v) {
    if (v == null || isNaN(v)) return '—';
    var sign = v < 0 ? '-' : '';
    var abs = Math.abs(v);
    if (abs >= 1000000) return sign + '$' + (abs / 1000000).toFixed(abs >= 10000000 ? 0 : 1) + 'M';
    if (abs >= 1000) return sign + '$' + (abs / 1000).toFixed(abs >= 10000 ? 0 : 1) + 'K';
    return sign + '$' + Math.round(abs).toLocaleString();
  }

  // Shared by Cost Performance, EVM, Budgeted vs. Actual, and Cash Flow —
  // caches the in-flight PROMISE itself, not just its resolved value.
  // renderAll() calls all four synchronously, so on first load each one
  // used to fire its OWN independent Firestore fetch (the cache var was
  // still null for all of them — a resolved Promise's value only lands
  // on the NEXT microtask, after the current synchronous call stack, i.e.
  // after every one of these calls had already read the null cache).
  // That let their charts get created at four different, staggered
  // moments instead of together in one batch — racing the CSS Grid row-
  // height calculation those charts' flex-fill sizing depends on, which
  // is why Cash Flow's chart/legend could end up a different size than
  // EVM's and Budgeted vs. Actual's despite all three needing to match.
  // Everything this file reads for cost/status/progress (projectCPI, EAC, costSnapshots,
  // projectStatus, auto progress…) lives on THIS project's document — the company document
  // is shared by every project in the company, so a value there would leak across projects.
  // (The name loadBusinessDoc is historical; it serves the project document.)
  function projectDocRefB() {
    return db.collection('businesses').doc(bizKey).collection('projects').doc(projKey || 'default');
  }
  var businessDocPromise = null;
  function loadBusinessDoc() {
    if (!businessDocPromise) {
      businessDocPromise = projectDocRefB().get().then(function (snap) {
        return (snap.exists && snap.data()) || {};
      });
    }
    return businessDocPromise;
  }

  // riskRegister and qualityDefects (Health Scorecard) and the Gantt-import rollups
  // (projectCPI, EAC, costSnapshots…) all live on the project doc — see loadBusinessDoc above.
  var projectDocPromise = null;
  function loadProjectDoc() {
    if (!projectDocPromise) {
      projectDocPromise = db.collection('businesses').doc(bizKey)
        .collection('projects').doc(projKey || 'default')
        .get().then(function (snap) {
          return (snap.exists && snap.data()) || {};
        });
    }
    return projectDocPromise;
  }

  function renderCostPerformance(tasks, timeline, today) {
    var card = document.getElementById('costPerformanceCard');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('costPerformanceCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView) return;

    loadBusinessDoc().then(function (data) {
      var cpi = typeof data.projectCPI === 'number' ? data.projectCPI : null;
      var cpiEl = document.getElementById('costPerfCPI');
      if (!cpiEl) return;
      cpiEl.textContent = cpi == null ? '—' : cpi.toFixed(2);

      // Same red/amber/green thresholds and class names as
      // renderSchedulePerformance's SPI coloring — this element never got
      // a color class at all before, so it always rendered in the default
      // ink color no matter how good or bad CPI actually was.
      cpiEl.classList.remove('is-behind', 'is-caution', 'is-ahead');
      if (cpi != null) {
        var cpiCls = cpi >= 1.00 ? 'is-ahead' : cpi >= 0.90 ? 'is-caution' : 'is-behind';
        cpiEl.classList.add(cpiCls);
      }

      if (window.drInsight) {
        if (cpi == null) {
          window.drInsight.set('costPerformanceCard', '');
        } else {
          var breakdown = computeCostBreakdown(tasks, timeline, today, data);
          var costMsg = 'CPI is ' + cpi.toFixed(2) + ' — ' + (cpi >= 1 ? 'costs are on or under budget' : 'costs are running over budget') +
            (breakdown.cv != null ? ' (CV ' + fmtMoneyCompact(breakdown.cv) + ')' : '') + '.';
          window.drInsight.set('costPerformanceCard', costMsg);
        }
      }
    }).catch(function (err) {
      warn('could not load cost performance data', err);
    });
  }

  // SV/CV/EAC/ETC — same figures the old standalone Cost Performance card
  // used to show, now rendered as part of the Health Scorecard instead
  // (see renderHealthScorecard). Kept as its own function since the
  // EV/AC/CV/ETC derivation is a few steps and doesn't belong inlined
  // into the scorecard's own render flow.
  // Standard EVM formulas (BAC = Budget at Completion, the ORIGINAL
  // baselined budget — not the current/latest cost, which can drift from
  // baseline as the schedule changes):
  //   EV = % complete x BAC          SV = EV - PV        CV = EV - AC
  //   CPI = EV / AC                  ETC = EAC - AC       VAC = BAC - EAC
  // This used to multiply % complete by the CURRENT cost (data.projectCost)
  // instead of BAC — a real formula error, and inconsistent with the EVM
  // chart above, which already correctly spreads BASELINE cost over time.
  // Now reuses that exact same per-task reconstruction (computeEVM) so the
  // summary numbers here always match what the EVM chart shows at today —
  // no more two different EV figures depending which card you're looking at.
  function computeCostBreakdown(tasks, timeline, today, data) {
    var cpi = typeof data.projectCPI === 'number' ? data.projectCPI : null;
    var evmData = computeEVM(tasks, timeline, today, cpi);
    if (!evmData.hasCostData) {
      return { bac: null, ev: null, pv: null, ac: null, sv: null, cv: null, eac: null, etc: null, vac: null };
    }

    var evNow = lastKnown(evmData.ev);
    var pvNow = lastKnown(evmData.pv);
    var acNow = lastKnown(evmData.ac);

    // BAC prefers MS Project's own top-level rollup (data.projectBaselineCost,
    // from the Outline-Level-0 summary row) over re-deriving it by summing
    // every leaf task's own baselineCost — a real schedule can have tasks
    // added AFTER the baseline was originally set, which show Baseline_Cost
    // as an explicit 0 (not missing — genuinely zero) despite having a real
    // current Cost. Summing those understates BAC by exactly that amount;
    // MS Project's own rollup doesn't have that gap, so it's the more
    // trustworthy figure when the import provides it. The leaf-sum is only
    // a fallback for imports with no Outline Level column at all.
    var bac = typeof data.projectBaselineCost === 'number' ? data.projectBaselineCost : tasks.reduce(function (sum, t) {
      var basis = typeof t.baselineCost === 'number' ? t.baselineCost : t.cost;
      return typeof basis === 'number' ? sum + basis : sum;
    }, 0);

    var eac = typeof data.projectEAC === 'number' ? data.projectEAC : (cpi != null && cpi > 0 ? bac / cpi : null);
    var sv = evNow != null && pvNow != null ? evNow - pvNow : null;
    var cv = evNow != null && acNow != null ? evNow - acNow : null;
    var etc = eac != null && acNow != null ? eac - acNow : null;
    var vac = eac != null ? bac - eac : null;

    return { bac: bac, ev: evNow, pv: pvNow, ac: acNow, sv: sv, cv: cv, eac: eac, etc: etc, vac: vac };
  }

  // ---------- ETC vs EAC (owner-only) ----------
  // The classic PMI reference chart: PV/EV/AC S-curves against a flat BAC
  // budget line, plus a dashed forecast segment from today's actual
  // position out to (project end, EAC) — visually completing the curve as
  // a projection rather than a fact. Reuses the exact same computeEVM/
  // computeCostBreakdown numbers as the EVM chart and Health Scorecard
  // above, so all three always agree with each other.
  function renderEtcVsEacChart(tasks, timeline, today) {
    var card = document.getElementById('etcVsEacCard');
    var canvas = document.getElementById('etcVsEacChart');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('etcVsEacCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !canvas || typeof window.Chart === 'undefined') return;

    loadBusinessDoc().then(function (data) {
      var cpi = typeof data.projectCPI === 'number' ? data.projectCPI : null;
      var evmData = computeEVM(tasks, timeline, today, cpi);
      if (!evmData.hasCostData) {
        setChartEmpty(canvas, 'No cost data imported yet.');
        if (window.drInsight) window.drInsight.set('etcVsEacCard', '');
        return;
      }
      clearChartEmpty(canvas);

      var breakdown = computeCostBreakdown(tasks, timeline, today, data);
      var labels = timeline.map(function (d) { return periodLabel(d, globalTimeframeUnit); });
      var bacLine = timeline.map(function () { return breakdown.bac; });

      // Forecast segment — real values ONLY at the last actual (today)
      // point and the final period (project end); spanGaps draws one
      // straight dashed line connecting just those two, extending the
      // curve as a projection rather than plotting a fabricated path.
      var todayIdx = -1;
      for (var i = evmData.ac.length - 1; i >= 0; i--) {
        if (evmData.ac[i] != null) { todayIdx = i; break; }
      }
      var eacForecast = timeline.map(function () { return null; });
      if (todayIdx >= 0 && breakdown.eac != null) {
        eacForecast[todayIdx] = evmData.ac[todayIdx];
        eacForecast[eacForecast.length - 1] = breakdown.eac;
      }

      destroyChart('etcVsEacChart');
      chartInstances.etcVsEacChart = new window.Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            { label: 'PV (Planned Value)', data: evmData.pv, borderColor: '#4a3aa7', backgroundColor: '#4a3aa7', pointRadius: 0, borderWidth: 2, tension: 0.15 },
            { label: 'EV (Earned Value)', data: evmData.ev, borderColor: '#007bff', backgroundColor: '#007bff', pointRadius: 0, borderWidth: 2, tension: 0.15 },
            { label: 'AC (Actual Cost)', data: evmData.ac, borderColor: '#dd3333', backgroundColor: '#dd3333', pointRadius: 0, borderWidth: 2, tension: 0.15 },
            { label: 'BAC (Budget at Completion)', data: bacLine, borderColor: '#898781', backgroundColor: '#898781', pointRadius: 0, borderWidth: 1, borderDash: [4, 3], tension: 0 },
            { label: 'EAC forecast', data: eacForecast, borderColor: '#eb6834', backgroundColor: '#eb6834', pointRadius: 2, pointHoverRadius: 4, borderWidth: 2, borderDash: [6, 4], spanGaps: true, tension: 0 }
          ]
        },
        options: commonLineOptions('$')
      });

      if (window.drInsight) {
        // Leads with the BAC-vs-EAC/VAC comparison — the actual point of
        // this chart — as ONE complete headline sentence, rather than
        // burying it as a second sentence behind "...more detail" (the
        // insight box only shows the first sentence inline; see
        // ai-insights.js's splitFirstSentence). A bare "BAC is $636K" on
        // its own says nothing about whether the project's on track to
        // hit that budget, which is what someone glancing at this card
        // actually wants to know.
        var text;
        if (breakdown.eac != null && breakdown.vac != null) {
          text = 'Forecast to finish at EAC ' + fmtMoneyCompact(breakdown.eac) + ' against a BAC of ' + fmtMoneyCompact(breakdown.bac) +
            ' — ' + fmtMoneyCompact(Math.abs(breakdown.vac)) + (breakdown.vac < 0 ? ' over budget' : ' under budget') + ' (VAC).';
        } else {
          text = 'BAC (original budget) is ' + fmtMoneyCompact(breakdown.bac) + '.';
        }
        if (breakdown.etc != null) {
          text += ' ' + fmtMoneyCompact(breakdown.etc) + ' more is needed to finish the work (ETC).';
        }
        window.drInsight.set('etcVsEacCard', text);
      }
    }).catch(function (err) {
      warn('could not load ETC vs EAC data', err);
    });
  }

  // ---------- Project Health Scorecard (owner-only) ----------
  // One glanceable read combining a signal from each of the three goals
  // (schedule, cost, quality) plus risk exposure, rather than making
  // someone scan six separate cards to answer "how are we really doing."
  // Owner-only as a whole since CPI is cost data — Quality reads "No data
  // yet" rather than borrowing the Quality/Defects Log's sample rows,
  // since a decision-support scorecard using fake data could mislead.
  // Impact ($) and Time Lost are optional RISK REGISTER import columns
  // (see riskAssumptions.js) — most Risk Registers don't have them, only
  // the 1-5 qualitative Impact rating every register already has. When a
  // risk has no imported dollar/day figure, ESTIMATE one from that 1-5
  // score, scaled against THIS project's own total budget and schedule
  // length (so a "5" on a $2M project reads differently than a "5" on a
  // $50K one) — a max-severity (5/5) risk is treated as able to consume
  // up to 10% of total budget/duration, scaled linearly down for lower
  // scores. Falls back to a generic baseline only when cost/schedule
  // totals aren't available yet. Clearly marked as an estimate in the UI
  // (not presented as if it were real imported data).
  function estimateDollarImpact(impactScore, totalBudget) {
    if (typeof impactScore !== 'number') return null;
    var basis = typeof totalBudget === 'number' && totalBudget > 0 ? totalBudget : 250000;
    return Math.round((impactScore / 5) * basis * 0.10);
  }
  function estimateTimeLostDays(impactScore, totalDurationDays) {
    if (typeof impactScore !== 'number') return null;
    var basis = typeof totalDurationDays === 'number' && totalDurationDays > 0 ? totalDurationDays : 180;
    return Math.round((impactScore / 5) * basis * 0.10);
  }

  function computeHealthScorecard(tasks, today, data) {
    var spi = tasks.length ? computeSchedulePerformance(tasks, today).spi : null;
    var cpi = typeof data.projectCPI === 'number' ? data.projectCPI : null;

    var totalBudget = typeof data.projectCost === 'number' ? data.projectCost : null;
    var minStart = tasks.length ? tasks.reduce(function (m, t) { return t.start < m ? t.start : m; }, tasks[0].start) : null;
    var maxDue = tasks.length ? tasks.reduce(function (m, t) { return t.due > m ? t.due : m; }, tasks[0].due) : null;
    var totalDurationDays = (minStart && maxDue) ? Math.round((maxDue - minStart) / 86400000) : null;

    var risks = Array.isArray(data.riskRegister) ? data.riskRegister : [];
    var openHighRiskList = risks.filter(function (r) {
      var score = typeof r.score === 'number' ? r.score : null;
      var statusLower = (r.status || '').toLowerCase();
      var isClosed = statusLower === 'closed' || statusLower === 'resolved' || statusLower === 'mitigated';
      if (isClosed) return false;

      // Three ways a risk lands in this list, not just a high score:
      // (1) score >= 15, the original "generally severe" threshold;
      // (2) its own Impact Area field says "Schedule" — a direct signal
      // it's a schedule risk regardless of score; (3) the owner manually
      // checked "Contributing to SPI?" on the Risk Register table (see
      // riskAssumptions.js's contributingToSpi checkbox) — their own
      // judgment call for a risk that doesn't fit the other two but they
      // believe is affecting schedule performance anyway.
      var isHighScore = score != null && score >= 15;
      var isScheduleImpact = /schedule/i.test(r.impactArea || '');
      var isManuallyFlagged = r.contributingToSpi === true;
      return isHighScore || isScheduleImpact || isManuallyFlagged;
    }).map(function (r) {
      // Keeps every original Risk Register field (category, status,
      // response strategy, etc.) alongside the computed ones — the
      // compact inline table only reads description/impactDollars/
      // timeLostDays/owner, but the "View full list" popup window
      // (see renderHealthScorecard) needs the rest.
      var hasRealDollars = typeof r.impactDollars === 'number';
      var hasRealDays = typeof r.timeLostDays === 'number';
      var out = {};
      for (var key in r) { if (Object.prototype.hasOwnProperty.call(r, key)) out[key] = r[key]; }
      out.impactDollars = hasRealDollars ? r.impactDollars : estimateDollarImpact(r.impact, totalBudget);
      out.timeLostDays = hasRealDays ? r.timeLostDays : estimateTimeLostDays(r.impact, totalDurationDays);
      out.impactIsEstimated = !hasRealDollars;
      out.timeLostIsEstimated = !hasRealDays;
      return out;
    });
    var openHighRisks = openHighRiskList.length;

    var defects = Array.isArray(data.qualityDefects) ? data.qualityDefects : [];
    var hasQualityData = defects.length > 0;
    var openCriticalDefects = defects.filter(function (d) {
      var sevLower = (d.severity || '').toLowerCase();
      var statusLower = (d.status || '').toLowerCase();
      var isSevere = sevLower === 'critical' || sevLower === 'high';
      var isOpen = statusLower !== 'resolved' && statusLower !== 'closed';
      return isSevere && isOpen;
    }).length;

    return { spi: spi, cpi: cpi, openHighRisks: openHighRisks, openHighRiskList: openHighRiskList, hasQualityData: hasQualityData, openCriticalDefects: openCriticalDefects };
  }

  // Same green ≥1.00 / amber 0.90-0.99 / red <0.90 thresholds as the SPI/
  // CPI stat tiles (renderSchedulePerformance/renderCostPerformance) — this
  // drives Project Status's traffic light and Health Scorecard's SPI/CPI
  // blocks, so all three now agree on what counts as "on plan" instead of
  // this one using a looser 0.75/0.90 band that let a CPI like 0.93 (7%
  // over budget) still read as green/"on track".
  function indexRag(v) {
    if (v == null) return null;
    if (v < 0.90) return 'high';
    if (v < 1.00) return 'medium';
    return 'low';
  }
  function countRag(n) {
    if (n >= 3) return 'high';
    if (n >= 1) return 'medium';
    return 'low';
  }

  // ---------- Automatic Project Status (SPI and/or CPI) ----------
  // Project Status (the traffic light) used to be set by hand — now it's
  // computed from SPI and/or CPI and written once per session, the first
  // time this resolves after the page loads. Since reaching the dashboard
  // already means a successful login AND a selected business, "on login /
  // selecting the client portal / entering the site" collapses to one
  // moment: this page's own load. Only the Owner's session actually
  // writes it (firestore.rules only grants the Owner update permission on
  // the business doc) — everyone else just reads the synced result via
  // projectStatus.js's existing live listener, same as before.
  // Tracks the last status THIS session actually wrote, not whether it
  // has EVER written one — a plain "written yet?" flag locked the light
  // to whatever SPI/CPI looked like the first time it happened to
  // succeed (e.g. before all tasks had loaded, or before a later
  // import/correction changed the real numbers) and never re-checked
  // for the rest of the browser session, even as the real SPI/CPI kept
  // changing underneath it.
  var lastWrittenAutoStatus = null;
  var lastWrittenAutoProgress = null;

  function computeAutoProjectStatus(spi, cpi) {
    var spiSev = indexRag(spi);
    var cpiSev = indexRag(cpi);
    var sevRank = { high: 3, medium: 2, low: 1 };
    var worst = null;
    [spiSev, cpiSev].forEach(function (s) {
      if (!s) return;
      if (!worst || sevRank[s] > sevRank[worst]) worst = s;
    });
    if (!worst) return null; // no SPI or CPI data yet — nothing to compute
    return worst === 'high' ? 'critical' : worst === 'medium' ? 'caution' : 'onTrack';
  }

  function writeAutoProjectStatus(tasks, today) {
    if (!isOwner) return;

    var perf = tasks.length ? computeSchedulePerformance(tasks, today) : null;
    var spi = perf ? perf.spi : null;

    loadBusinessDoc().then(function (data) {
      var cpi = typeof data.projectCPI === 'number' ? data.projectCPI : null;
      var status = computeAutoProjectStatus(spi, cpi);
      if (!status) return; // not enough data yet — try again on the next render

      // Dedup key includes spi/cpi (rounded), not just status — otherwise
      // a status that stays e.g. "critical" while SPI/CPI keep moving
      // would skip the write forever and projectStatus.js would keep
      // showing stale numbers in its "Driven by ..." reasoning.
      var key = status + '|' + (spi != null ? spi.toFixed(2) : '') + '|' + (cpi != null ? cpi.toFixed(2) : '');
      if (key === lastWrittenAutoStatus) return; // unchanged — skip the redundant write

      lastWrittenAutoStatus = key;
      projectDocRefB().set({
        projectStatus: status,
        projectStatusComputedAt: new Date(),
        projectStatusSource: 'auto',
        // Persisted specifically so projectStatus.js's insight box can
        // explain WHY the status is what it is (SPI/CPI), not just name
        // the status itself — these were computed here but never actually
        // reaching Firestore before, so that reasoning silently never fired.
        spi: spi,
        cpi: cpi
      }, { merge: true }).catch(function (err) {
        warn('could not write auto project status', err);
        lastWrittenAutoStatus = null; // write failed — allow retrying on the next render
      });
    }).catch(function (err) {
      warn('could not load data for auto project status', err);
    });
  }

  // ---------- Project Progress (two automatic bars) ----------
  // Time Elapsed and Tasks Completed used to be one manually-clicked bar
  // (the Owner eyeballing a percentage). Both are actually objective facts
  // already derivable from the same schedule data driving every other
  // chart here, so they're now computed automatically, same pattern as
  // writeAutoProjectStatus above — written once per render, only when
  // changed, and read reactively by projectProgress.js's own listener.
  function writeAutoProjectProgress(tasks, today) {
    if (!isOwner) return;
    if (!tasks.length) return;

    var minStart = tasks.reduce(function (m, t) { return t.start < m ? t.start : m; }, tasks[0].start);
    var maxDue = tasks.reduce(function (m, t) { return t.due > m ? t.due : m; }, tasks[0].due);
    var span = maxDue - minStart;
    var timeElapsedPercent = span > 0 ? ((today - minStart) / span) * 100 : (today >= maxDue ? 100 : 0);
    timeElapsedPercent = Math.max(0, Math.min(100, Math.round(timeElapsedPercent)));

    var completedCount = tasks.filter(function (t) { return t.bucket === 'completed'; }).length;
    var taskProgressPercent = Math.round((completedCount / tasks.length) * 100);

    // A straight completed/total count treats a task at 99% the same as
    // one at 0% — fine as a literal "how many are actually done" figure,
    // but it can't be cross-checked against the imported schedule's own
    // Percent_Complete (a work-weighted figure that credits partial
    // progress), which reads as "the numbers don't match" even when
    // nothing is wrong. This second figure uses the same methodology
    // (average each task's own % complete, not just done-or-not) so it's
    // the actual apples-to-apples check-and-balance against that import.
    var weightedProgressPercent = Math.round(
      tasks.reduce(function (sum, t) { return sum + (t.progress || 0); }, 0) / tasks.length
    );

    var key = timeElapsedPercent + '|' + taskProgressPercent + '|' + weightedProgressPercent;
    if (key === lastWrittenAutoProgress) return; // unchanged — skip the redundant write
    lastWrittenAutoProgress = key;

    projectDocRefB().set({
      autoTimeElapsedProgress: timeElapsedPercent,
      autoTaskProgress: taskProgressPercent,
      autoTaskProgressWeighted: weightedProgressPercent,
      autoProgressComputedAt: new Date()
    }, { merge: true }).catch(function (err) {
      warn('could not write auto project progress', err);
      lastWrittenAutoProgress = null; // write failed — allow retrying on the next render
    });
  }

  function renderHealthScorecard(tasks, timeline, today) {
    var card = document.getElementById('healthScorecardCard');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('healthScorecardCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView) return;

    Promise.all([loadBusinessDoc(), loadProjectDoc()]).then(function (results) {
      var bizData = results[0], projData = results[1];
      // riskRegister/qualityDefects come from the project doc; everything
      // else computeHealthScorecard reads (projectCPI, projectCost) stays
      // on the business doc — see loadProjectDoc's own comment.
      var data = Object.assign({}, bizData, {
        riskRegister: projData.riskRegister,
        qualityDefects: projData.qualityDefects
      });
      var h = computeHealthScorecard(tasks, today, data);

      var spiEl = document.getElementById('healthSpi');
      var cpiEl = document.getElementById('healthCpi');
      var riskEl = document.getElementById('healthRisk');
      var qualityEl = document.getElementById('healthQuality');
      var overallEl = document.getElementById('healthOverall');
      if (!spiEl || !cpiEl || !riskEl || !qualityEl || !overallEl) return;

      var spiSev = indexRag(h.spi);
      var cpiSev = indexRag(h.cpi);
      var riskSev = countRag(h.openHighRisks);
      var qualitySev = h.hasQualityData ? countRag(h.openCriticalDefects) : null;

      // health-sev-* (not severity-*) — severity-high/medium/low elsewhere
      // in this file are pill badges with a colored background; these are
      // plain colored text/numbers, a different treatment for a different
      // context, so they get their own class names instead of colliding.
      spiEl.textContent = h.spi != null ? h.spi.toFixed(2) : '—';
      spiEl.className = 'health-value health-sev-' + (spiSev || 'unknown');
      cpiEl.textContent = h.cpi != null ? h.cpi.toFixed(2) : '—';
      cpiEl.className = 'health-value health-sev-' + (cpiSev || 'unknown');
      riskEl.textContent = h.openHighRisks;
      riskEl.className = 'health-value health-sev-' + riskSev;
      qualityEl.textContent = h.hasQualityData ? h.openCriticalDefects : 'No data';
      qualityEl.className = 'health-value health-sev-' + (qualitySev || 'unknown');

      // Overall = the worst of whichever signals actually have data —
      // "unknown" (no quality data yet) never drags the overall down.
      var sevRank = { high: 3, medium: 2, low: 1 };
      var worst = [spiSev, cpiSev, riskSev, qualitySev].filter(Boolean).reduce(function (worst, s) {
        return (sevRank[s] > sevRank[worst]) ? s : worst;
      }, 'low');
      var overallLabel = worst === 'high' ? 'At risk' : worst === 'medium' ? 'Needs attention' : 'On track';
      overallEl.textContent = overallLabel;
      overallEl.className = 'health-overall-value health-sev-' + worst;

      // SV/CV/EAC/ETC/VAC — moved here from the old standalone Cost
      // Performance card.
      var costBreakdown = computeCostBreakdown(tasks, timeline, today, data);
      var svEl = document.getElementById('costPerfSV');
      var cvEl = document.getElementById('costPerfCV');
      var eacEl = document.getElementById('costPerfEAC');
      var etcEl = document.getElementById('costPerfETC');
      var vacEl = document.getElementById('costPerfVAC');
      if (svEl) { svEl.textContent = costBreakdown.sv == null ? '—' : fmtMoneyCompact(costBreakdown.sv); svEl.title = costBreakdown.sv == null ? '' : fmtMoney(costBreakdown.sv); }
      if (cvEl) { cvEl.textContent = costBreakdown.cv == null ? '—' : fmtMoneyCompact(costBreakdown.cv); cvEl.title = costBreakdown.cv == null ? '' : fmtMoney(costBreakdown.cv); }
      if (eacEl) { eacEl.textContent = costBreakdown.eac == null ? '—' : fmtMoneyCompact(costBreakdown.eac); eacEl.title = costBreakdown.eac == null ? '' : fmtMoney(costBreakdown.eac); }
      if (etcEl) { etcEl.textContent = costBreakdown.etc == null ? '—' : fmtMoneyCompact(costBreakdown.etc); etcEl.title = costBreakdown.etc == null ? '' : fmtMoney(costBreakdown.etc); }
      if (vacEl) { vacEl.textContent = costBreakdown.vac == null ? '—' : fmtMoneyCompact(costBreakdown.vac); vacEl.title = costBreakdown.vac == null ? '' : fmtMoney(costBreakdown.vac); }

      // Open high-risk list — the compact inline table was removed in
      // favor of the "View full list" popup window (openHealthRiskWindow
      // below); just a count stays inline as a glance-able signal.
      var riskCountEl = document.getElementById('healthRiskCountInline');
      var riskList = h.openHighRiskList || [];
      if (riskCountEl) riskCountEl.textContent = riskList.length ? '(' + riskList.length + ')' : '';
      lastHealthRiskList = riskList;
      wireHealthRiskOpenWindowLink();

      var topRisksEl = document.getElementById('healthTopRisksList');
      if (topRisksEl) {
        var topRisks = riskList.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); }).slice(0, 3);
        topRisksEl.innerHTML = topRisks.map(function (r) {
          var desc = (r.description || r.id || 'Untitled risk');
          return '<li title="' + esc(desc) + '"><strong>' + esc(r.id || '') + '</strong> ' + esc(desc) +
            (typeof r.score === 'number' ? ' <span class="health-top-risk-score">(score ' + r.score + ')</span>' : '') + '</li>';
        }).join('');
      }

      if (window.drInsight) {
        var driverLabel = { spi: 'schedule (SPI)', cpi: 'cost (CPI)', risk: 'open high risks', quality: 'open critical defects' };
        var driverKey = spiSev === worst ? 'spi' : (cpiSev === worst ? 'cpi' : (riskSev === worst ? 'risk' : (qualitySev === worst ? 'quality' : null)));
        var hsMsg = 'Overall status is ' + overallLabel.toLowerCase() + '.';
        if (worst !== 'low' && driverKey) hsMsg += ' Main driver: ' + driverLabel[driverKey] + '.';
        if (riskList.length) hsMsg += ' ' + riskList.length + ' open high-risk item' + (riskList.length === 1 ? '' : 's') + ' to watch.';
        window.drInsight.set('healthScorecardCard', hsMsg);
      }
    }).catch(function (err) {
      warn('could not load health scorecard data', err);
    });
  }

  // ---------- Open High Risks: "View full list" popup window ----------
  // Opens in a genuinely separate browser window/tab (not an in-page
  // modal) specifically so it doesn't disturb the dashboard's own layout
  // — per explicit request: "so it does not affect the real estate
  // around it." Built from data already loaded in this page (no second
  // Firestore round-trip or auth context needed in the new window).
  var lastHealthRiskList = [];

  function openHealthRiskWindow() {
    var qnaUrl = 'dashboard.html?business=' + encodeURIComponent(bizKey || '') + '#qnaSection';
    var rows = lastHealthRiskList.map(function (r) {
      var dollarText = typeof r.impactDollars === 'number' ? (r.impactIsEstimated ? '~' : '') + fmtMoney(r.impactDollars) : '—';
      var daysText = typeof r.timeLostDays === 'number' ? (r.timeLostIsEstimated ? '~' : '') + r.timeLostDays + ' day' + (r.timeLostDays === 1 ? '' : 's') : '—';
      // Which of the three inclusion reasons applied — a risk can match
      // more than one, so this lists every reason it's here, not just one.
      var reasons = [];
      if (typeof r.score === 'number' && r.score >= 15) reasons.push('High score');
      if (/schedule/i.test(r.impactArea || '')) reasons.push('Schedule impact area');
      if (r.contributingToSpi === true) reasons.push('Flagged by owner');
      return '<tr>' +
        '<td>' + esc(r.id || '—') + '</td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(r.description || '—') + '</td>' +
        '<td>' + esc(r.impactArea || '—') + '</td>' +
        '<td>' + esc(typeof r.score === 'number' ? r.score : '—') + '</td>' +
        '<td>' + esc(reasons.join(', ') || '—') + '</td>' +
        '<td>' + dollarText + '</td>' +
        '<td>' + daysText + '</td>' +
        '<td>' + esc(r.owner || '—') + '</td>' +
        '<td>' + esc(r.status || '—') + '</td>' +
        '<td class="wrap"><a href="' + qnaUrl + '" target="_blank" rel="noopener">Ask/track in Q&amp;A →</a></td>' +
        '</tr>';
    }).join('');

    var html = '<!doctype html><html><head><meta charset="utf-8"><title>Open High Risks</title><style>' +
      'body{font-family:Arial,Helvetica,sans-serif;margin:20px;color:#222;}' +
      'h1{font-size:1.3rem;margin:0 0 4px;}' +
      'p.sub{color:#666;font-size:0.85rem;margin:0 0 16px;}' +
      'table{border-collapse:collapse;width:100%;font-size:0.85rem;}' +
      'th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top;}' +
      'th{background:#f3f3f3;}' +
      'td.wrap{white-space:nowrap;}' +
      'a{color:#2a78d6;text-decoration:none;}' +
      'a:hover{text-decoration:underline;}' +
      '</style></head><body>' +
      '<h1>Open High Risks</h1>' +
      '<p class="sub">Included if score &ge; 15, its Impact Area mentions Schedule, and/or it was manually flagged as contributing to SPI on the Risk Register — see the "Why Included" column. Not closed/resolved/mitigated. "~" = estimated from the risk\'s Impact rating, not an imported figure. Use "Ask/track in Q&amp;A" to raise or follow up on a question for any risk.</p>' +
      '<table><thead><tr><th>ID</th><th>Category</th><th>Description</th><th>Impact Area</th><th>Score</th><th>Why Included</th><th>Impact ($)</th><th>Time Lost</th><th>Owner</th><th>Status</th><th>Q&amp;A</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="11">No open high risks.</td></tr>') + '</tbody></table>' +
      '</body></html>';

    var win = window.open('', '_blank', 'width=1100,height=700');
    if (!win) { alert('Please allow pop-ups to view the full risk list in a new window.'); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  function wireHealthRiskOpenWindowLink() {
    var link = document.getElementById('healthRiskOpenWindowLink');
    if (!link || link.__wired) return;
    link.__wired = true;
    link.addEventListener('click', function (e) {
      e.preventDefault();
      openHealthRiskWindow();
    });
  }

  function renderEVM(tasks, timeline, today) {
    var card = document.getElementById('evmCard');
    var canvas = document.getElementById('evmChart');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('evmCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !canvas || typeof window.Chart === 'undefined') return;

    loadBusinessDoc().then(function (data) {
      var cpi = typeof data.projectCPI === 'number' ? data.projectCPI : null;
      var evmData = computeEVM(tasks, timeline, today, cpi);

      if (!evmData.hasCostData) {
        setChartEmpty(canvas, 'No per-task cost data yet — re-import with the Cost column present to populate this chart.');
        if (window.drInsight) window.drInsight.set('evmCard', '');
        return;
      }
      clearChartEmpty(canvas);

      var labels = timeline.map(function (d) { return periodLabel(d, globalTimeframeUnit); });
      destroyChart('evmChart');
      chartInstances.evmChart = new window.Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Planned Value (PV)',
              data: evmData.pv,
              borderColor: '#eb6834',
              backgroundColor: '#eb6834',
              pointRadius: 1,
              pointHoverRadius: 3,
              borderWidth: 2,
              tension: 0
            },
            {
              label: 'Earned Value (EV)',
              data: evmData.ev,
              borderColor: '#2a78d6',
              backgroundColor: '#2a78d6',
              pointRadius: 1,
              pointHoverRadius: 3,
              borderWidth: 2,
              tension: 0.1
            },
            {
              label: evmData.hasRealActualCost ? 'Actual Cost (AC)' : 'Actual Cost (AC, approximate)',
              data: evmData.ac,
              borderColor: '#4a3aa7',
              backgroundColor: '#4a3aa7',
              pointRadius: 1,
              pointHoverRadius: 3,
              borderWidth: 2,
              tension: 0.1
            }
          ]
        },
        options: commonLineOptions('$')
      });

      if (window.drInsight) {
        var pvNow = lastKnown(evmData.pv), evNow = lastKnown(evmData.ev), acNow = lastKnown(evmData.ac);
        if (pvNow != null && evNow != null && acNow != null) {
          var sv = evNow - pvNow, cv = evNow - acNow;
          window.drInsight.set('evmCard', 'As of ' + timeframeLabel(globalTimeframeUnit) + ', Earned Value is ' + fmtMoneyCompactAccounting(evNow) + ' vs. Planned ' + fmtMoneyCompactAccounting(pvNow) +
            ' (SV ' + fmtMoneyCompactAccounting(sv) + ', ' + (sv >= 0 ? 'ahead of schedule' : 'behind schedule') + ') and Actual Cost ' + fmtMoneyCompactAccounting(acNow) +
            ' (CV ' + fmtMoneyCompactAccounting(cv) + ', ' + (cv >= 0 ? 'under budget' : 'over budget') + ').');
        } else {
          window.drInsight.set('evmCard', '');
        }
        if (window.drInsight.setHistory) {
          var histEvm = computeEVM(tasks, buildHistoryTimeline(tasks, today), today, cpi);
          var svHist = histEvm.ev.map(function (v, i) { return (v != null && histEvm.pv[i] != null) ? v - histEvm.pv[i] : null; });
          var cvHist = histEvm.ev.map(function (v, i) { return (v != null && histEvm.ac[i] != null) ? v - histEvm.ac[i] : null; });
          var svText = summarizeTrend(svHist, 'schedule variance ($)');
          var cvText = summarizeTrend(cvHist, 'cost variance ($)');
          window.drInsight.setHistory('evmCard', [svText, cvText].filter(Boolean).join(' '));
        }
      }
    }).catch(function (err) {
      warn('could not load EVM data', err);
    });
  }

  function renderBudgetVsActual(tasks, today) {
    var card = document.getElementById('budgetVsActualCard');
    var canvas = document.getElementById('budgetVsActualChart');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('budgetVsActualCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !canvas || typeof window.Chart === 'undefined') return;

    loadBusinessDoc().then(function (data) {
      var cpi = typeof data.projectCPI === 'number' ? data.projectCPI : null;
      var series = computeBudgetVsActualSeries(tasks, globalTimeframeUnit, today, cpi);

      if (!series.hasData) {
        setChartEmpty(canvas, 'No budgeted or actual cost data yet — re-import with the Cost/Actual Cost columns present to populate this chart.');
        if (window.drInsight) window.drInsight.set('budgetVsActualCard', '');
        return;
      }
      clearChartEmpty(canvas);

      destroyChart('budgetVsActualChart');
      chartInstances.budgetVsActualChart = new window.Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: series.labels,
          datasets: [
            { label: 'Budgeted Cost', data: series.budgeted, borderColor: '#eb6834', backgroundColor: '#eb6834', pointRadius: 1, pointHoverRadius: 3, borderWidth: 2, tension: 0 },
            { label: 'Actual Cost', data: series.actual, borderColor: '#4a3aa7', backgroundColor: '#4a3aa7', pointRadius: 1, pointHoverRadius: 3, borderWidth: 2, tension: 0.1 }
          ]
        },
        options: commonLineOptions('$')
      });

      if (window.drInsight) {
        var budgetedNow = lastKnown(series.budgeted), actualNow = lastKnown(series.actual);
        if (budgetedNow != null && actualNow != null) {
          var costDiff = actualNow - budgetedNow;
          window.drInsight.set('budgetVsActualCard', 'Actual cost is ' + fmtMoneyCompactAccounting(actualNow) + ' against a budgeted ' + fmtMoneyCompactAccounting(budgetedNow) + ' ' + timeframeLabel(globalTimeframeUnit) +
            ' — ' + (Math.abs(costDiff) < 1 ? 'right on budget.' : (costDiff > 0 ? fmtMoneyCompactAccounting(costDiff) + ' over budget.' : fmtMoneyCompactAccounting(Math.abs(costDiff)) + ' under budget.')));
        } else {
          window.drInsight.set('budgetVsActualCard', '');
        }
        if (window.drInsight.setHistory) {
          var histSeries = computeBudgetVsActualSeries(tasks, 'month', today, cpi);
          var diffHist = histSeries.actual.map(function (v, i) { return (v != null && histSeries.budgeted[i] != null) ? v - histSeries.budgeted[i] : null; });
          window.drInsight.setHistory('budgetVsActualCard', summarizeTrend(diffHist, 'actual-vs-budget variance ($)'));
        }
      }
    }).catch(function (err) {
      warn('could not load budget vs actual data', err);
    });
  }

  // Accounting-style formatting for the Cash Flow stat tiles — negative
  // shown in parens, matching the MS Project report you referenced
  // ("($8,216.00)"), not a leading minus sign.
  function fmtMoneyAccounting(v) {
    if (v == null || isNaN(v)) return '—';
    var str = '$' + Math.abs(Math.round(v)).toLocaleString();
    return v < 0 ? '(' + str + ')' : str;
  }

  // Same accounting convention (parentheses for negative) as
  // fmtMoneyAccounting, but abbreviated to K/M like fmtMoneyCompact — used
  // for the Cash Flow stat row so e.g. $625,000 reads as $625K instead of
  // the full number.
  function fmtMoneyCompactAccounting(v) {
    if (v == null || isNaN(v)) return '—';
    var abs = Math.abs(v);
    var str;
    if (abs >= 1000000) str = '$' + (abs / 1000000).toFixed(abs >= 10000000 ? 0 : 1) + 'M';
    else if (abs >= 1000) str = '$' + (abs / 1000).toFixed(abs >= 10000 ? 0 : 1) + 'K';
    else str = '$' + Math.round(abs).toLocaleString();
    return v < 0 ? '(' + str + ')' : str;
  }

  function renderCashFlow(tasks, today) {
    var card = document.getElementById('cashFlowCard');
    var canvas = document.getElementById('cashFlowChart');
    if (!card) return;
    var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('cashFlowCard'));
    card.classList.toggle('owner', isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !canvas || typeof window.Chart === 'undefined') return;

    loadBusinessDoc().then(function (data) {
      var cost = typeof data.projectCost === 'number' ? data.projectCost : null;
      var baseline = typeof data.projectBaselineCost === 'number' ? data.projectBaselineCost : null;
      var actual = typeof data.projectActualCost === 'number' ? data.projectActualCost : null;
      var eac = typeof data.projectEAC === 'number' ? data.projectEAC : null;

      var actualEl = document.getElementById('cashFlowActual');
      var baselineEl = document.getElementById('cashFlowBaseline');
      var remainingEl = document.getElementById('cashFlowRemaining');
      var varianceEl = document.getElementById('cashFlowVariance');
      // Abbreviated to K/M (fmtMoneyCompactAccounting) so the stat row
      // reads at a glance instead of full numbers crowding the card; the
      // exact figure is still available via the title tooltip on hover.
      var remaining = (cost != null && actual != null) ? cost - actual : null;
      if (actualEl) { actualEl.textContent = fmtMoneyCompactAccounting(actual); actualEl.title = fmtMoneyAccounting(actual); }
      if (baselineEl) { baselineEl.textContent = fmtMoneyCompactAccounting(baseline); baselineEl.title = fmtMoneyAccounting(baseline); }
      if (remainingEl) { remainingEl.textContent = fmtMoneyCompactAccounting(remaining); remainingEl.title = fmtMoneyAccounting(remaining); }

      var report = computeCashFlowReport(tasks, globalTimeframeUnit, today, eac);
      // Cost Variance is now driven by the SAME per-period calculation as
      // the chart (Cost - Baseline, spread across each one's own schedule)
      // rather than a separate static field, so it updates when you change
      // the time frame buttons instead of always showing one frozen number.
      if (varianceEl) {
        var variance = report.costVariance.length ? report.costVariance[report.costVariance.length - 1] : null;
        varianceEl.textContent = fmtMoneyCompactAccounting(variance);
        varianceEl.title = fmtMoneyAccounting(variance);
      }

      if (!report.hasCostData) {
        setChartEmpty(canvas, 'No per-task cost data yet — re-import with the Cost column present to populate this chart.');
        if (window.drInsight) window.drInsight.set('cashFlowCard', '');
        return;
      }
      clearChartEmpty(canvas);

      destroyChart('cashFlowChart');
      // Dual y-axis is normally avoided, but this deliberately mirrors
      // MS Project's own Cash Flow report layout, which you referenced
      // directly as the target. Cost Variance is intentionally NOT a
      // series here — it's a single running total, shown in the stat row
      // above (next to Remaining Cost), not something that needs its own
      // trend line on this chart. Actual Cost and Forecast (dashed, same
      // color — same series, projected portion) answer "where will
      // unfinished tasks put the total by project end": Actual is real
      // spread-by-progress spend up to today, Forecast continues that line
      // to (project end, EAC).
      var datasets = [
        { type: 'line', label: 'Cost', data: report.perPeriod, borderColor: '#2a78d6', backgroundColor: '#2a78d6', yAxisID: 'y', pointRadius: 1, pointHoverRadius: 3, borderWidth: 2, tension: 0.15 },
        { type: 'line', label: 'Cumulative Cost', data: report.cumulative, borderColor: '#eb6834', backgroundColor: '#eb6834', yAxisID: 'y1', pointRadius: 1, pointHoverRadius: 3, borderWidth: 2, tension: 0.15 },
        { type: 'line', label: 'Actual Cost', data: report.actual, borderColor: '#4a3aa7', backgroundColor: '#4a3aa7', yAxisID: 'y1', pointRadius: 1, pointHoverRadius: 3, borderWidth: 2, tension: 0.15 }
      ];
      if (report.forecast.some(function (v) { return v != null; })) {
        datasets.push({ type: 'line', label: 'Forecast to EAC', data: report.forecast, borderColor: '#4a3aa7', backgroundColor: '#4a3aa7', borderDash: [6, 4], yAxisID: 'y1', pointRadius: 1, pointHoverRadius: 3, borderWidth: 2, tension: 0.15 });
      }
      chartInstances.cashFlowChart = new window.Chart(canvas.getContext('2d'), {
        data: {
          labels: report.labels,
          datasets: datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
            tooltip: {
              callbacks: {
                label: function (ctx) { return ctx.dataset.label + ': ' + fmtMoney(ctx.parsed.y); }
              }
            }
          },
          scales: {
            x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 90, minRotation: globalTimeframeUnit === 'week' ? 90 : 0, autoSkip: true } },
            y: { position: 'left', beginAtZero: true, title: { display: true, text: '$ per period', font: { size: 11 } }, grid: { color: '#e0e0e0' } },
            y1: { position: 'right', beginAtZero: true, title: { display: true, text: 'Cumulative $', font: { size: 11 } }, grid: { drawOnChartArea: false } }
          }
        }
      });

      if (window.drInsight) {
        var periodCost = lastKnown(report.perPeriod);
        var varianceNow = report.costVariance.length ? report.costVariance[report.costVariance.length - 1] : null;
        if (periodCost != null) {
          window.drInsight.set('cashFlowCard', 'Spend ' + timeframeLabel(globalTimeframeUnit) + ' is running at ' + fmtMoneyCompactAccounting(periodCost) + '/period' +
            (varianceNow != null ? ', ' + (varianceNow >= 0 ? fmtMoneyCompactAccounting(varianceNow) + ' over baseline.' : fmtMoneyCompactAccounting(Math.abs(varianceNow)) + ' under baseline.') : '.'));
        } else {
          window.drInsight.set('cashFlowCard', '');
        }
        if (window.drInsight.setHistory) {
          var histReport = computeCashFlowReport(tasks, 'month', today, eac);
          window.drInsight.setHistory('cashFlowCard', summarizeTrend(histReport.perPeriod, 'spend per period ($)'));
        }
      }
    }).catch(function (err) {
      warn('could not load cash flow data', err);
    });
  }

  // ---------- Toggle wiring (Tasks / Duration) ----------
  function wireToggle(groupSelector, onChange) {
    var group = document.querySelector(groupSelector);
    if (!group || group.__wired) return;
    group.__wired = true;
    group.addEventListener('click', function (e) {
      var btn = e.target.closest('.metrics-toggle-btn');
      if (!btn) return;
      var buttons = group.querySelectorAll('.metrics-toggle-btn');
      buttons.forEach(function (b) { b.classList.toggle('is-active', b === btn); });
      onChange(btn.getAttribute('data-metric'));
    });
  }

  // Visible diagnostic so a real-vs-expected task count mismatch (e.g.
  // leftover duplicate documents from an earlier test import) is obvious
  // without opening devtools — shows the RAW collection sizes (before the
  // milestone filter), since that's what needs checking against Firestore.
  function renderTaskCountDiagnostic() {
    var el = document.getElementById('taskCountDiagnostic');
    if (!el) return;
    var milestoneCount = milestoneDocs.length;
    var activityCount = activityDocs.length;
    el.textContent = '(' + milestoneCount + ' milestones + ' + activityCount + ' activities = ' + (milestoneCount + activityCount) + ' total documents in Firestore)';
  }

  // ---------- Render everything ----------
  function renderAll() {
    var tasks = buildTasks();
    var today = dateOnly(new Date());
    refreshTimeframeAvailability(tasks);
    // The global sidebar's period choice now drives every chart's timeline
    // (not just Cash Flow/Budgeted vs. Actual) — buildPeriodTimeline
    // replaces the old always-weekly buildTimeline() here.
    var timeline = buildPeriodTimeline(tasks, globalTimeframeUnit, today);
    ['etcVsEacCard', 'burndownCard', 'burnupCard', 'velocityCard', 'cfdCard', 'evmCard', 'budgetVsActualCard', 'cashFlowCard'].forEach(function (id) {
      applyTimeframeBadge(id, globalTimeframeUnit);
    });

    log('rendering: taskCount=' + tasks.length + ' timelinePoints=' + timeline.length +
      ' rawMilestoneCount=' + milestoneDocs.length + ' rawActivityCount=' + activityDocs.length);
    renderTaskCountDiagnostic();

    renderSchedulePerformance(tasks, today);
    renderForecastFinish(tasks, today);
    // Reads the business doc directly (not tasks/timeline), so it belongs
    // above the tasks.length early-return, not gated on there being any
    // dated milestones/activities yet. This call was missing from
    // renderAll() entirely — that's why the Cost Performance Index card
    // never appeared even for the real Owner.
    renderCostPerformance(tasks, timeline, today);
    renderEtcVsEacChart(tasks, timeline, today);
    renderMilestoneTrend();
    renderCriticalPath(tasks);
    renderTopSlippedTasks();
    renderHealthScorecard(tasks, timeline, today);
    writeAutoProjectStatus(tasks, today);
    writeAutoProjectProgress(tasks, today);

    if (!tasks.length) {
      ['burndownChart', 'burnupChart', 'velocityChart', 'cfdChart', 'ragDistChart', 'evmChart', 'budgetVsActualChart', 'cashFlowChart', 'etcVsEacChart'].forEach(function (id) {
        setChartEmpty(document.getElementById(id), 'No dated milestones or activities yet.');
      });
      return;
    }

    renderBurndown(tasks, timeline, today);
    renderBurnup(tasks, timeline, today);
    renderVelocity(tasks, timeline, today);
    renderCFD(tasks, timeline, today);
    renderRagDistribution(tasks);
    renderEVM(tasks, timeline, today);
    renderBudgetVsActual(tasks, today);
    renderCashFlow(tasks, today);

    // Safety net: several of the charts above are created asynchronously
    // (after their own loadBusinessDoc()/Firestore read resolves), each
    // measuring its container's height at whatever moment it happens to
    // construct — which can be before a slower-loading row-mate has
    // finished growing that row via CSS Grid's stretch. Chart.js's own
    // ResizeObserver should catch a later container resize automatically,
    // but forcing one explicit resize pass once everything in this
    // render has had a moment to settle removes any dependency on that
    // timing working out on its own.
    setTimeout(resizeAllCharts, 250);
  }

  function resizeAllCharts() {
    Object.keys(chartInstances).forEach(function (id) {
      var c = chartInstances[id];
      if (c && typeof c.resize === 'function') {
        try { c.resize(); } catch (e) { /* chart may have been destroyed mid-timeout */ }
      }
    });
  }

  // ---------- Firestore subscriptions ----------
  function subscribe() {
    var projDocRef = db.collection('businesses').doc(bizKey)
      .collection('projects').doc(projKey || 'default');

    projDocRef.collection('milestones').onSnapshot(function (snap) {
      milestoneDocs = snap.docs.map(function (d) { return { id: d.id, data: d.data() || {} }; });
      renderAll();
    }, function (err) { error('milestones snapshot failed', err); });

    projDocRef.collection('activities').onSnapshot(function (snap) {
      activityDocs = snap.docs.map(function (d) { return { id: d.id, data: d.data() || {} }; });
      renderAll();
    }, function (err) { error('activities snapshot failed', err); });

    // loadBusinessDoc() below reads this same document (projectCPI, EAC,
    // costSnapshots, etc.) for Cost Performance/EAC Trend/EVM/Cash Flow/
    // Health Scorecard — but until now it only ever fetched it ONCE and
    // cached that single result for the rest of the page's life, unlike
    // milestones/activities above which are live. A fresh Schedule import
    // (gantt.js) writes new values straight into this same document, but
    // none of those cards would ever pick it up without a full page
    // reload — "I just re-imported and nothing changed" was this, not a
    // bug in the import itself. Live now, same as everything else.
    projDocRef.onSnapshot(function (snap) {
      var d = (snap.exists && snap.data()) || {};
      businessDocPromise = Promise.resolve(d);
      projectDocPromise = Promise.resolve(d);
      renderAll();
    }, function (err) { error('project doc snapshot failed', err); });
  }

  // ---------- Boot ----------
  function resolveBusinessKey() {
    var params = new URLSearchParams(window.location.search || '');
    return params.get('business') || (window.localStorage && window.localStorage.getItem('businessKey')) || window.BIZ_KEY || null;
  }

  function start() {
    db = window.db || null;
    auth = window.auth || null;

    if (!db || !auth || typeof window.Chart === 'undefined') {
      setTimeout(start, 200);
      return;
    }

    bizKey = resolveBusinessKey();
    if (!bizKey) { setTimeout(start, 300); return; }

    // Multi-project cutover — every business always has at least the
    // auto-created 'default' project (dashboard-business-loader.js
    // guarantees window.PROJECT_KEY is set by the time this runs).
    projKey = window.PROJECT_KEY || 'default';

    log('initialized', { bizKey: bizKey, projKey: projKey });

    wireToggle('.metrics-toggle[data-chart="burndown"]', function (metric) {
      burndownMetric = metric;
      renderAll();
    });
    wireToggle('.metrics-toggle[data-chart="burnup"]', function (metric) {
      burnupMetric = metric;
      renderAll();
    });
    wireTablePaginationButtons();

    var includeMilestonesCheckbox = document.getElementById('includeMilestonesToggle');
    if (includeMilestonesCheckbox && !includeMilestonesCheckbox.__wired) {
      includeMilestonesCheckbox.__wired = true;
      includeMilestonesCheckbox.addEventListener('change', function () {
        includeMilestones = includeMilestonesCheckbox.checked;
        renderAll();
      });
    }

    // One shared control drives EVERY chart at once — it changes
    // globalTimeframeUnit, which renderAll() uses to rebuild the one
    // shared timeline every chart is rendered against. Lives as a
    // dropdown in the sidebar (dashboard.html), not the charts area.
    var globalTimeframeSelect = document.getElementById('chartsGlobalTimeframeSelect');
    if (globalTimeframeSelect && !globalTimeframeSelect.__wired) {
      globalTimeframeSelect.__wired = true;
      globalTimeframeSelect.addEventListener('change', function () {
        globalTimeframeUnit = globalTimeframeSelect.value;
        renderAll();
        // Lets gantt.js (a separate script, no shared JS module) track the
        // same time frame on its own view-mode buttons.
        window.dispatchEvent(new CustomEvent('dr-timeframe-changed', { detail: { unit: globalTimeframeUnit } }));
      });
    }

    // auth.currentUser may not have resolved yet on a fresh page load
    // (the same race documented and fixed in gantt.js) — react to the
    // real value once it's known rather than reading it once synchronously.
    auth.onAuthStateChanged(function (user) {
      var email = (user && user.email) || '';
      var wasOwner = isOwner;
      isOwner = !!email && !!OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
      if (isOwner !== wasOwner) renderAll();
    });

    // renderCostPerformance/renderEtcVsEacChart/renderHealthScorecard/
    // renderEVM/renderBudgetVsActual/renderCashFlow each check
    // window.drAccess.canViewReport() to decide whether to populate at
    // all — if the Firestore snapshot that triggers renderAll() fires
    // before dr-access-control.js finishes resolving role/permissions (a
    // real timing race either way), those cards render permanently empty
    // with no second chance. renderAll() is safe to re-run with no
    // arguments (it recomputes everything from cached module state), so
    // re-run it once access is known to be resolved.
    if (window.drAccess) window.drAccess.whenReady().then(renderAll);

    subscribe();
  }

  function waitForFirebaseAndStart() {
    if (window.db && window.auth) { start(); return; }
    window.addEventListener('firebase-ready', function handle() {
      window.removeEventListener('firebase-ready', handle);
      start();
    }, { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForFirebaseAndStart);
  } else {
    waitForFirebaseAndStart();
  }

  // Pure reconstruction pieces, exposed so the Status Report's burndown exhibit (status-report.js)
  // can reuse the exact same math the live dashboard chart uses instead of a second implementation
  // that could quietly drift from it — same normalizeTask()/progress-reconstruction the chart above
  // renders from, just callable with an explicit {id, data} item list instead of this module's own
  // Firestore-subscription state.
  function buildTasksFrom(milestoneItems, activityItems, includeMs) {
    var tasks = [];
    (milestoneItems || []).forEach(function (item) { var t = normalizeTask(item, 'milestones'); if (t) tasks.push(t); });
    (activityItems || []).forEach(function (item) { var t = normalizeTask(item, 'activities'); if (t) tasks.push(t); });
    if (!includeMs) tasks = tasks.filter(function (t) { return !t.isMilestone; });
    tasks = tasks.filter(function (t) { return !t.isSummary; });
    return tasks;
  }
  window.drBurndownInternals = {
    normalizeTask: normalizeTask, buildTasksFrom: buildTasksFrom, progressPointsForTask: progressPointsForTask,
    progressAt: progressAt, buildTimeline: buildTimeline, weight: weight, computeBurnBurnup: computeBurnBurnup,
    // Exposed for Earned Schedule (earnedSchedule.js) — the exact same PV/EV
    // curve the EVM card itself builds, so ES can never disagree with it.
    computeEVM: computeEVM, buildPeriodTimeline: buildPeriodTimeline,
    // periodLabel: the same Q1/H1-style axis-label formatting every
    // burndown.js chart uses, exposed so other files' timeframe-aware
    // charts (riskReserve.js, resourceHours.js, qualityDefects.js) can
    // match it exactly instead of drifting to their own plain-date format.
    periodLabel: periodLabel,
    getGlobalTimeframeUnit: function () { return globalTimeframeUnit; },
    timeframeLabel: timeframeLabel,
    applyTimeframeBadge: applyTimeframeBadge
  };
})();
