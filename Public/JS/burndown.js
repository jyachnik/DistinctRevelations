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
      // The "milestones" Firestore collection is exactly the 0-duration
      // rows from the import (gantt.js classifies any zero-duration row —
      // or one explicitly flagged Milestone=Yes — into it), so this flag
      // is a reliable stand-in for "0-day duration item" without having to
      // re-derive it from start/due (which get a synthetic 3-day window
      // below when no startDate is set, so start!==due isn't a safe test).
      isMilestone: collection === 'milestones',
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
  var globalTimeframeUnit = '3month'; // 'week' | 'month' | '3month' | '6month' | 'year' | 'total'

  // todayForCap: when given, extends the timeline through "today" even if
  // the project's own latest due date has already passed — same guarantee
  // buildTimeline() gives Burndown/Burnup/CFD. Cash Flow's own projection
  // (which deliberately runs past today, to project completion) omits it.
  function buildPeriodTimeline(tasks, unit, todayForCap) {
    if (!tasks.length) return [];
    var minStart = tasks.reduce(function (m, t) { return t.start < m ? t.start : m; }, tasks[0].start);
    var maxDue = tasks.reduce(function (m, t) { return t.due > m ? t.due : m; }, tasks[0].due);
    if (todayForCap && todayForCap > maxDue) maxDue = todayForCap;

    if (unit === 'total') return [dateOnly(minStart), dateOnly(maxDue)];

    if (unit === 'week') {
      var dates = [];
      var wd = dateOnly(minStart);
      while (wd <= maxDue) { dates.push(new Date(wd.getTime())); wd = addDays(wd, 7); }
      if (!dates.length || dates[dates.length - 1].getTime() !== maxDue.getTime()) dates.push(new Date(maxDue.getTime()));
      return dates;
    }

    var monthsPerBucket = unit === 'month' ? 1 : unit === '6month' ? 6 : unit === 'year' ? 12 : 3;
    var pStart = new Date(minStart.getFullYear(), Math.floor(minStart.getMonth() / monthsPerBucket) * monthsPerBucket, 1);
    var dates2 = [];
    var d = new Date(pStart.getTime());
    while (d <= maxDue) {
      d = new Date(d.getFullYear(), d.getMonth() + monthsPerBucket, 1);
      dates2.push(new Date(d.getTime() - 86400000)); // last day of the period just ended
    }
    if (!dates2.length || dates2[dates2.length - 1] < maxDue) dates2.push(new Date(maxDue.getTime()));
    return dates2;
  }

  // The end of the forward-looking window the global time frame control
  // represents, measured from today — "Week" = the next 7 days, "Month" =
  // the next calendar month, and so on, matching the same rolling-window
  // convention the Gantt's own 3 Months/6 Months modes use. "Total
  // Project" returns null (no end — nothing is filtered out), same as
  // every other chart already treats it.
  function windowEndDate(unit, today) {
    if (unit === 'week') return addDays(today, 7);
    if (unit === 'month') return new Date(today.getFullYear(), today.getMonth() + 1, today.getDate());
    if (unit === '3month') return new Date(today.getFullYear(), today.getMonth() + 3, today.getDate());
    if (unit === '6month') return new Date(today.getFullYear(), today.getMonth() + 6, today.getDate());
    if (unit === 'year') return new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());
    return null; // 'total' — no filtering
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
  // windowEnd (from windowEndDate()) limits this to items due BY the end
  // of the selected time frame — an already-overdue item's due date is
  // always in the past, so it's always <= windowEnd and stays counted
  // regardless of which window is selected; windowEnd == null ("Total
  // Project") applies no filter at all, same as before this existed.
  function computeRagDistribution(tasks, windowEnd) {
    var counts = { red: 0, amber: 0, green: 0 };
    tasks.forEach(function (t) {
      if (t.bucket === 'completed') return; // snapshot is about OPEN risk, not closed work
      if (windowEnd && t.due > windowEnd) return;
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
    var labels = timeline.map(fmtShort);
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
            pointRadius: 3,
            pointHoverRadius: 5,
            borderWidth: 2,
            tension: 0
          },
          {
            label: 'Actual (approximate)',
            data: data.actualRemaining,
            borderColor: '#dd3333',
            backgroundColor: '#dd3333',
            pointRadius: 3,
            pointHoverRadius: 5,
            borderWidth: 2,
            tension: 0.1
          }
        ]
      },
      options: commonLineOptions(unit)
    });
  }

  function renderBurnup(tasks, timeline, today) {
    var canvas = document.getElementById('burnupChart');
    if (!canvas || typeof window.Chart === 'undefined') return;
    clearChartEmpty(canvas);
    var data = computeBurnBurnup(tasks, timeline, today, burnupMetric);
    var labels = timeline.map(fmtShort);
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
            pointRadius: 3,
            pointHoverRadius: 5,
            borderWidth: 2,
            tension: 0
          },
          {
            label: 'Completed (approximate)',
            data: data.actualComplete,
            borderColor: '#dd3333',
            backgroundColor: '#dd3333',
            pointRadius: 3,
            pointHoverRadius: 5,
            borderWidth: 2,
            tension: 0.1
          }
        ]
      },
      options: commonLineOptions(unit)
    });
  }

  function renderVelocity(tasks, timeline, today) {
    var canvas = document.getElementById('velocityChart');
    if (!canvas || typeof window.Chart === 'undefined') return;
    clearChartEmpty(canvas);
    var data = computeBurnBurnup(tasks, timeline, today, burndownMetric);
    var labels = timeline.map(fmtShort);
    var unit = burndownMetric === 'duration' ? 'days completed' : 'tasks completed';

    var pastValues = data.periodCompleted.filter(function (v) { return v != null; });
    var avg = pastValues.length ? pastValues.reduce(function (a, b) { return a + b; }, 0) / pastValues.length : 0;
    var avgLine = data.periodCompleted.map(function (v) { return v == null ? null : avg; });

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
            backgroundColor: '#7d5fc4'
          },
          {
            type: 'line',
            label: 'Average velocity (' + avg.toFixed(1) + ')',
            data: avgLine,
            borderColor: '#dd3333',
            borderDash: [6, 4],
            pointRadius: 0,
            borderWidth: 2,
            tension: 0
          }
        ]
      },
      options: commonLineOptions(unit)
    });
  }

  function renderCFD(tasks, timeline, today) {
    var canvas = document.getElementById('cfdChart');
    if (!canvas || typeof window.Chart === 'undefined') return;
    clearChartEmpty(canvas);
    var data = computeCFD(tasks, timeline, today);
    var labels = timeline.map(fmtShort);

    destroyChart('cfdChart');
    chartInstances.cfdChart = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Completed',
            data: data.completed,
            borderColor: '#2f9e44',
            backgroundColor: '#2f9e44',
            fill: true,
            pointRadius: 0,
            borderWidth: 1,
            tension: 0
          },
          {
            label: 'In Progress',
            data: data.inProgress,
            borderColor: '#007bff',
            backgroundColor: '#007bff',
            fill: true,
            pointRadius: 0,
            borderWidth: 1,
            tension: 0
          },
          {
            label: 'Not Started',
            data: data.notStarted,
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
  }

  function renderRagDistribution(tasks, windowEnd) {
    var canvas = document.getElementById('ragDistChart');
    if (!canvas || typeof window.Chart === 'undefined') return;
    var counts = computeRagDistribution(tasks, windowEnd);
    var openTotal = counts.red + counts.amber + counts.green;

    destroyChart('ragDistChart');

    if (!openTotal) {
      setChartEmpty(canvas, windowEnd ? 'Nothing open and due in the selected time frame.' : 'No open milestones or activities right now.');
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
        layout: { padding: { top: 16, left: 16, right: 16, bottom: 4 } }, // room for the now-outside-the-ring % labels
        plugins: {
          // Extra top padding on the legend's own labels pushes it further
          // down, away from the ring/outside-labels above it.
          legend: { position: 'bottom', align: 'center', labels: { boxWidth: 12, padding: 20, font: { size: 11 } } },
          tooltip: { enabled: true },
          datalabels: {
            // Outside the ring (anchor/align: 'end') rather than inside the
            // arc — a thin slice like "At risk" has no room to fit a
            // legible label inside it, so it was getting silently dropped.
            anchor: 'end',
            align: 'end',
            offset: 8,
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
  }

  // ---------- Milestone Trend (schedule-only, visible to everyone) ----------
  // The classic PM "milestone trend chart" — is each milestone's due date
  // holding steady or sliding later over time? Built entirely from the
  // changeLog "Due date" entries already captured on every milestone (from
  // drags and edits), no new import needed. A line/date-scale chart would
  // need a date-axis adapter library this app doesn't load, so this is a
  // table instead: same insight (which milestones have slipped, by how
  // much), without a new dependency.
  // windowEnd limits this to milestones CURRENTLY due by the end of the
  // selected time frame — same rolling-window convention as everything
  // else driven by the global control; null ("Total Project") shows every
  // dated milestone, same as before this existed.
  function computeMilestoneTrend(windowEnd) {
    var rows = [];
    milestoneDocs.forEach(function (item) {
      var d = item.data;
      var currentDue = toJsDate(d.dueDate);
      if (!currentDue) return;
      currentDue = dateOnly(currentDue);
      if (windowEnd && currentDue > windowEnd) return;

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

  function renderMilestoneTrend(windowEnd) {
    var tbody = document.querySelector('#milestoneTrendTable tbody');
    if (!tbody) return;

    var rows = computeMilestoneTrend(windowEnd);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="metrics-empty">' +
        (windowEnd ? 'No milestones due in the selected time frame.' : 'No dated milestones yet.') +
        '</td></tr>';
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
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
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
      return;
    }

    var perf = computeSchedulePerformance(tasks, today);
    valueEl.textContent = perf.spi.toFixed(2);
    valueEl.classList.remove('is-behind', 'is-caution', 'is-ahead');

    var label, cls;
    if (perf.spi >= 1.05) { label = 'Ahead of schedule'; cls = 'is-ahead'; }
    else if (perf.spi >= 0.9) { label = 'On schedule'; cls = 'is-ahead'; }
    else if (perf.spi >= 0.75) { label = 'Behind schedule'; cls = 'is-caution'; }
    else { label = 'Significantly behind schedule'; cls = 'is-behind'; }
    valueEl.classList.add(cls);
    labelEl.textContent = label + ' (task-count based)';
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

  // Shared by Cost Performance and the EVM chart, so re-importing while
  // the dashboard is open (or just switching views) doesn't re-fetch the
  // business doc twice for the same data.
  var businessDocCache = null;
  function loadBusinessDoc() {
    if (businessDocCache) return Promise.resolve(businessDocCache);
    return db.collection('businesses').doc(bizKey).get().then(function (snap) {
      businessDocCache = (snap.exists && snap.data()) || {};
      return businessDocCache;
    });
  }

  function renderCostPerformance() {
    var card = document.getElementById('costPerformanceCard');
    if (!card) return;
    card.classList.toggle('owner', isOwner);
    if (!isOwner) return;

    loadBusinessDoc().then(function (data) {
      var cpi = typeof data.projectCPI === 'number' ? data.projectCPI : null;
      var cpiEl = document.getElementById('costPerfCPI');
      if (!cpiEl) return;
      cpiEl.textContent = cpi == null ? '—' : cpi.toFixed(2);
    }).catch(function (err) {
      warn('could not load cost performance data', err);
    });
  }

  // SV/CV/EAC/ETC — same figures the old standalone Cost Performance card
  // used to show, now rendered as part of the Health Scorecard instead
  // (see renderHealthScorecard). Kept as its own function since the
  // EV/AC/CV/ETC derivation is a few steps and doesn't belong inlined
  // into the scorecard's own render flow.
  function computeCostBreakdown(data) {
    var cost = typeof data.projectCost === 'number' ? data.projectCost : null;
    var eac = typeof data.projectEAC === 'number' ? data.projectEAC : null;
    var cpi = typeof data.projectCPI === 'number' ? data.projectCPI : null;
    var pct = typeof data.projectPercentComplete === 'number' ? data.projectPercentComplete : null;
    var realActualCost = typeof data.projectActualCost === 'number' ? data.projectActualCost : null;
    var sv = typeof data.projectSV === 'number' ? data.projectSV : null;

    if (cost == null || eac == null || cpi == null || pct == null) {
      return { sv: sv, cv: null, eac: eac, etc: null };
    }

    // EV = % complete x total budgeted cost. AC prefers the import's own
    // real Actual Cost rollup when present; otherwise falls back to
    // rearranging MS Project's own CPI = EV/AC. ETC = EAC - AC.
    var ev = (pct / 100) * cost;
    var ac = realActualCost != null ? realActualCost : (cpi > 0 ? ev / cpi : null);
    var cv = ac == null ? null : ev - ac;
    var etc = ac == null ? null : eac - ac;
    return { sv: sv, cv: cv, eac: eac, etc: etc };
  }

  // ---------- EAC Trend (owner-only) ----------
  // Every other cost figure on this dashboard is a snapshot of the LATEST
  // import only — this is the one place that shows whether the estimate
  // at completion is trending up, down, or holding steady release over
  // release. Snapshots are appended (capped to the last 50) by gantt.js
  // on every import; there's nothing to show until at least 2 imports
  // have happened.
  function renderEACTrend() {
    var card = document.getElementById('eacTrendCard');
    var canvas = document.getElementById('eacTrendChart');
    if (!card) return;
    card.classList.toggle('owner', isOwner);
    if (!isOwner || !canvas || typeof window.Chart === 'undefined') return;

    loadBusinessDoc().then(function (data) {
      var snapshots = Array.isArray(data.costSnapshots) ? data.costSnapshots : [];
      if (snapshots.length < 2) {
        setChartEmpty(canvas, 'Collecting data — EAC trend needs at least 2 imports to show a line (currently ' + snapshots.length + ').');
        return;
      }
      clearChartEmpty(canvas);

      var labels = snapshots.map(function (s) { return fmtShort(toJsDate(s.date) || new Date()); });
      var eacData = snapshots.map(function (s) { return typeof s.eac === 'number' ? s.eac : null; });
      var costData = snapshots.map(function (s) { return typeof s.cost === 'number' ? s.cost : null; });

      destroyChart('eacTrendChart');
      chartInstances.eacTrendChart = new window.Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            { label: 'EAC (Estimate at Completion)', data: eacData, borderColor: '#eb6834', backgroundColor: '#eb6834', pointRadius: 3, pointHoverRadius: 5, borderWidth: 2, tension: 0.1 },
            { label: 'Current Cost', data: costData, borderColor: '#2a78d6', backgroundColor: '#2a78d6', pointRadius: 3, pointHoverRadius: 5, borderWidth: 2, tension: 0.1 }
          ]
        },
        options: commonLineOptions('$')
      });
    }).catch(function (err) {
      warn('could not load EAC trend data', err);
    });
  }

  // ---------- Project Health Scorecard (owner-only) ----------
  // One glanceable read combining a signal from each of the three goals
  // (schedule, cost, quality) plus risk exposure, rather than making
  // someone scan six separate cards to answer "how are we really doing."
  // Owner-only as a whole since CPI is cost data — Quality reads "No data
  // yet" rather than borrowing the Quality/Defects Log's sample rows,
  // since a decision-support scorecard using fake data could mislead.
  function computeHealthScorecard(tasks, today, data) {
    var spi = tasks.length ? computeSchedulePerformance(tasks, today).spi : null;
    var cpi = typeof data.projectCPI === 'number' ? data.projectCPI : null;

    var risks = Array.isArray(data.riskRegister) ? data.riskRegister : [];
    var openHighRiskList = risks.filter(function (r) {
      var score = typeof r.score === 'number' ? r.score : null;
      var statusLower = (r.status || '').toLowerCase();
      var isClosed = statusLower === 'closed' || statusLower === 'resolved' || statusLower === 'mitigated';
      return score != null && score >= 15 && !isClosed;
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

  function indexRag(v) {
    if (v == null) return null;
    if (v < 0.75) return 'high';
    if (v < 0.9) return 'medium';
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
  var autoStatusWrittenThisSession = false;

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
    if (autoStatusWrittenThisSession || !isOwner) return;

    var perf = tasks.length ? computeSchedulePerformance(tasks, today) : null;
    var spi = perf ? perf.spi : null;

    loadBusinessDoc().then(function (data) {
      var cpi = typeof data.projectCPI === 'number' ? data.projectCPI : null;
      var status = computeAutoProjectStatus(spi, cpi);
      if (!status) return; // not enough data yet — try again on the next render

      autoStatusWrittenThisSession = true;
      db.collection('businesses').doc(bizKey).set({
        projectStatus: status,
        projectStatusComputedAt: new Date(),
        projectStatusSource: 'auto'
      }, { merge: true }).catch(function (err) {
        warn('could not write auto project status', err);
      });
    }).catch(function (err) {
      warn('could not load data for auto project status', err);
    });
  }

  function renderHealthScorecard(tasks, today) {
    var card = document.getElementById('healthScorecardCard');
    if (!card) return;
    card.classList.toggle('owner', isOwner);
    if (!isOwner) return;

    loadBusinessDoc().then(function (data) {
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

      // SV/CV/EAC/ETC — moved here from the old standalone Cost
      // Performance card.
      var costBreakdown = computeCostBreakdown(data);
      var svEl = document.getElementById('costPerfSV');
      var cvEl = document.getElementById('costPerfCV');
      var eacEl = document.getElementById('costPerfEAC');
      var etcEl = document.getElementById('costPerfETC');
      if (svEl) { svEl.textContent = costBreakdown.sv == null ? '—' : fmtMoneyCompact(costBreakdown.sv); svEl.title = costBreakdown.sv == null ? '' : fmtMoney(costBreakdown.sv); }
      if (cvEl) { cvEl.textContent = costBreakdown.cv == null ? '—' : fmtMoneyCompact(costBreakdown.cv); cvEl.title = costBreakdown.cv == null ? '' : fmtMoney(costBreakdown.cv); }
      if (eacEl) { eacEl.textContent = costBreakdown.eac == null ? '—' : fmtMoneyCompact(costBreakdown.eac); eacEl.title = costBreakdown.eac == null ? '' : fmtMoney(costBreakdown.eac); }
      if (etcEl) { etcEl.textContent = costBreakdown.etc == null ? '—' : fmtMoneyCompact(costBreakdown.etc); etcEl.title = costBreakdown.etc == null ? '' : fmtMoney(costBreakdown.etc); }

      // Open high-risk list — description, $ impact, time lost, owner.
      var riskBody = document.getElementById('healthRiskTableBody');
      var riskTable = document.getElementById('healthRiskTable');
      var riskEmpty = document.getElementById('healthRiskEmpty');
      if (riskBody && riskTable && riskEmpty) {
        var riskList = h.openHighRiskList || [];
        if (!riskList.length) {
          riskTable.hidden = true;
          riskEmpty.hidden = false;
          riskBody.innerHTML = '';
        } else {
          riskTable.hidden = false;
          riskEmpty.hidden = true;
          riskBody.innerHTML = riskList.map(function (r) {
            return '<tr>' +
              '<td>' + esc(r.description || '—') + '</td>' +
              '<td>' + (typeof r.impactDollars === 'number' ? esc(fmtMoney(r.impactDollars)) : '—') + '</td>' +
              '<td>' + (typeof r.timeLostDays === 'number' ? esc(r.timeLostDays + ' day' + (r.timeLostDays === 1 ? '' : 's')) : '—') + '</td>' +
              '<td>' + esc(r.owner || '—') + '</td>' +
              '</tr>';
          }).join('');
        }
      }
    }).catch(function (err) {
      warn('could not load health scorecard data', err);
    });
  }

  function renderEVM(tasks, timeline, today) {
    var card = document.getElementById('evmCard');
    var canvas = document.getElementById('evmChart');
    if (!card) return;
    card.classList.toggle('owner', isOwner);
    if (!isOwner || !canvas || typeof window.Chart === 'undefined') return;

    loadBusinessDoc().then(function (data) {
      var cpi = typeof data.projectCPI === 'number' ? data.projectCPI : null;
      var evmData = computeEVM(tasks, timeline, today, cpi);

      if (!evmData.hasCostData) {
        setChartEmpty(canvas, 'No per-task cost data yet — re-import with the Cost column present to populate this chart.');
        return;
      }
      clearChartEmpty(canvas);

      var labels = timeline.map(fmtShort);
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
              pointRadius: 3,
              pointHoverRadius: 5,
              borderWidth: 2,
              tension: 0
            },
            {
              label: 'Earned Value (EV)',
              data: evmData.ev,
              borderColor: '#2a78d6',
              backgroundColor: '#2a78d6',
              pointRadius: 3,
              pointHoverRadius: 5,
              borderWidth: 2,
              tension: 0.1
            },
            {
              label: evmData.hasRealActualCost ? 'Actual Cost (AC)' : 'Actual Cost (AC, approximate)',
              data: evmData.ac,
              borderColor: '#4a3aa7',
              backgroundColor: '#4a3aa7',
              pointRadius: 3,
              pointHoverRadius: 5,
              borderWidth: 2,
              tension: 0.1
            }
          ]
        },
        options: commonLineOptions('$')
      });
    }).catch(function (err) {
      warn('could not load EVM data', err);
    });
  }

  function renderBudgetVsActual(tasks, today) {
    var card = document.getElementById('budgetVsActualCard');
    var canvas = document.getElementById('budgetVsActualChart');
    if (!card) return;
    card.classList.toggle('owner', isOwner);
    if (!isOwner || !canvas || typeof window.Chart === 'undefined') return;

    loadBusinessDoc().then(function (data) {
      var cpi = typeof data.projectCPI === 'number' ? data.projectCPI : null;
      var series = computeBudgetVsActualSeries(tasks, globalTimeframeUnit, today, cpi);

      if (!series.hasData) {
        setChartEmpty(canvas, 'No budgeted or actual cost data yet — re-import with the Cost/Actual Cost columns present to populate this chart.');
        return;
      }
      clearChartEmpty(canvas);

      destroyChart('budgetVsActualChart');
      chartInstances.budgetVsActualChart = new window.Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: series.labels,
          datasets: [
            { label: 'Budgeted Cost', data: series.budgeted, borderColor: '#eb6834', backgroundColor: '#eb6834', pointRadius: 3, pointHoverRadius: 5, borderWidth: 2, tension: 0 },
            { label: 'Actual Cost', data: series.actual, borderColor: '#4a3aa7', backgroundColor: '#4a3aa7', pointRadius: 3, pointHoverRadius: 5, borderWidth: 2, tension: 0.1 }
          ]
        },
        options: commonLineOptions('$')
      });
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

  function renderCashFlow(tasks, today) {
    var card = document.getElementById('cashFlowCard');
    var canvas = document.getElementById('cashFlowChart');
    if (!card) return;
    card.classList.toggle('owner', isOwner);
    if (!isOwner || !canvas || typeof window.Chart === 'undefined') return;

    loadBusinessDoc().then(function (data) {
      var cost = typeof data.projectCost === 'number' ? data.projectCost : null;
      var baseline = typeof data.projectBaselineCost === 'number' ? data.projectBaselineCost : null;
      var actual = typeof data.projectActualCost === 'number' ? data.projectActualCost : null;
      var eac = typeof data.projectEAC === 'number' ? data.projectEAC : null;

      var actualEl = document.getElementById('cashFlowActual');
      var baselineEl = document.getElementById('cashFlowBaseline');
      var remainingEl = document.getElementById('cashFlowRemaining');
      var varianceEl = document.getElementById('cashFlowVariance');
      if (actualEl) actualEl.textContent = fmtMoneyAccounting(actual);
      if (baselineEl) baselineEl.textContent = fmtMoneyAccounting(baseline);
      if (remainingEl) remainingEl.textContent = (cost != null && actual != null) ? fmtMoneyAccounting(cost - actual) : '—';

      var report = computeCashFlowReport(tasks, globalTimeframeUnit, today, eac);
      // Cost Variance is now driven by the SAME per-period calculation as
      // the chart (Cost - Baseline, spread across each one's own schedule)
      // rather than a separate static field, so it updates when you change
      // the time frame buttons instead of always showing one frozen number.
      if (varianceEl) {
        varianceEl.textContent = report.costVariance.length
          ? fmtMoneyAccounting(report.costVariance[report.costVariance.length - 1])
          : '—';
      }

      if (!report.hasCostData) {
        setChartEmpty(canvas, 'No per-task cost data yet — re-import with the Cost column present to populate this chart.');
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
        { type: 'line', label: 'Cost', data: report.perPeriod, borderColor: '#2a78d6', backgroundColor: '#2a78d6', yAxisID: 'y', pointRadius: 3, pointHoverRadius: 5, borderWidth: 2, tension: 0.15 },
        { type: 'line', label: 'Cumulative Cost', data: report.cumulative, borderColor: '#eb6834', backgroundColor: '#eb6834', yAxisID: 'y1', pointRadius: 3, pointHoverRadius: 5, borderWidth: 2, tension: 0.15 },
        { type: 'line', label: 'Actual Cost', data: report.actual, borderColor: '#4a3aa7', backgroundColor: '#4a3aa7', yAxisID: 'y1', pointRadius: 3, pointHoverRadius: 5, borderWidth: 2, tension: 0.15 }
      ];
      if (report.forecast.some(function (v) { return v != null; })) {
        datasets.push({ type: 'line', label: 'Forecast to EAC', data: report.forecast, borderColor: '#4a3aa7', backgroundColor: '#4a3aa7', borderDash: [6, 4], yAxisID: 'y1', pointRadius: 2, pointHoverRadius: 4, borderWidth: 2, tension: 0.15 });
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
    // The global sidebar's period choice now drives every chart's timeline
    // (not just Cash Flow/Budgeted vs. Actual) — buildPeriodTimeline
    // replaces the old always-weekly buildTimeline() here.
    var timeline = buildPeriodTimeline(tasks, globalTimeframeUnit, today);
    // Status Snapshot and Milestone Trend are "as of today" reads, not
    // trend-over-time charts, so they don't need timeline's per-period
    // buckets — they need a single cutoff date (the end of the selected
    // rolling window) to filter WHICH items they include. See
    // windowEndDate() above.
    var windowEnd = windowEndDate(globalTimeframeUnit, today);

    log('rendering: taskCount=' + tasks.length + ' timelinePoints=' + timeline.length +
      ' rawMilestoneCount=' + milestoneDocs.length + ' rawActivityCount=' + activityDocs.length);
    renderTaskCountDiagnostic();

    renderSchedulePerformance(tasks, today);
    // Reads the business doc directly (not tasks/timeline), so it belongs
    // above the tasks.length early-return, not gated on there being any
    // dated milestones/activities yet. This call was missing from
    // renderAll() entirely — that's why the Cost Performance Index card
    // never appeared even for the real Owner.
    renderCostPerformance();
    renderEACTrend();
    renderMilestoneTrend(windowEnd);
    renderHealthScorecard(tasks, today);
    writeAutoProjectStatus(tasks, today);

    if (!tasks.length) {
      ['burndownChart', 'burnupChart', 'velocityChart', 'cfdChart', 'ragDistChart', 'evmChart', 'budgetVsActualChart', 'cashFlowChart'].forEach(function (id) {
        setChartEmpty(document.getElementById(id), 'No dated milestones or activities yet.');
      });
      return;
    }

    renderBurndown(tasks, timeline, today);
    renderBurnup(tasks, timeline, today);
    renderVelocity(tasks, timeline, today);
    renderCFD(tasks, timeline, today);
    renderRagDistribution(tasks, windowEnd);
    renderEVM(tasks, timeline, today);
    renderBudgetVsActual(tasks, today);
    renderCashFlow(tasks, today);
  }

  // ---------- Firestore subscriptions ----------
  function subscribe() {
    db.collection('businesses').doc(bizKey).collection('milestones').onSnapshot(function (snap) {
      milestoneDocs = snap.docs.map(function (d) { return { id: d.id, data: d.data() || {} }; });
      renderAll();
    }, function (err) { error('milestones snapshot failed', err); });

    db.collection('businesses').doc(bizKey).collection('activities').onSnapshot(function (snap) {
      activityDocs = snap.docs.map(function (d) { return { id: d.id, data: d.data() || {} }; });
      renderAll();
    }, function (err) { error('activities snapshot failed', err); });
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

    log('initialized', { bizKey: bizKey });

    wireToggle('.metrics-toggle[data-chart="burndown"]', function (metric) {
      burndownMetric = metric;
      renderAll();
    });
    wireToggle('.metrics-toggle[data-chart="burnup"]', function (metric) {
      burnupMetric = metric;
      renderAll();
    });

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
    // shared timeline every chart is rendered against.
    var globalTimeframeGroup = document.getElementById('chartsGlobalTimeframe');
    if (globalTimeframeGroup && !globalTimeframeGroup.__wired) {
      globalTimeframeGroup.__wired = true;
      globalTimeframeGroup.addEventListener('click', function (e) {
        var btn = e.target.closest('.charts-global-timeframe-btn');
        if (!btn) return;
        globalTimeframeGroup.querySelectorAll('.charts-global-timeframe-btn').forEach(function (b) { b.classList.toggle('is-active', b === btn); });
        globalTimeframeUnit = btn.getAttribute('data-unit');
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
})();
