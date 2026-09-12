// Public/JS/gantt.js
// Engagement Timeline: merges businesses/{biz}/milestones and
// businesses/{biz}/activities into one Frappe Gantt view.
// Owner can drag a bar to reschedule it or drag its fill to update
// progress — both write straight back to Firestore. Members get a
// read-only render (chart is instantiated with readonly: true).

(function () {
  'use strict';

  var TAG = '[gantt]';
  var OWNER_EMAIL =
    (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) ||
    window.ownerEmail ||
    '';

  var db = null;
  var auth = null;
  var bizKey = null;
  var userEmail = null;
  var userUid = null;
  var isOwner = false;

  var milestoneDocs = [];
  var activityDocs = [];
  var container = null;

  // Tracks whichever view mode the user last picked from the dropdown, so
  // a fresh render (e.g. from a Firestore update) reopens on the same
  // zoom level instead of always resetting to Month.
  var currentViewMode = 'Month';
  // Tracks which view mode the LAST render actually drew, so a genuine
  // mode switch (different column_width) can be told apart from a
  // same-mode re-render (a data update, a bounds correction) — see the
  // scroll-restore logic in render() below.
  var lastRenderedViewMode = null;

  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // Upper-row label for Day view: the month name, shown ONCE per month
  // (blank on every other day in that month) — the missing "only on a
  // real change" guard was the bug that had every single day's column
  // repeating its own "January" label, so on a view narrow enough to
  // show many days at once they visually ran together into one smear of
  // overlapping text instead of one label per month.
  function monthUpperText(curDate, prevDate) {
    var monthChanged = !prevDate || curDate.getMonth() !== prevDate.getMonth() || curDate.getFullYear() !== prevDate.getFullYear();
    if (!monthChanged) return '';
    var month = MONTH_NAMES[curDate.getMonth()];
    var yearChanged = !prevDate || curDate.getFullYear() !== prevDate.getFullYear();
    return yearChanged ? month + ' ' + curDate.getFullYear() : month;
  }

  function log() { console.log.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function warn() { console.warn.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function error() { console.error.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }

  // ---------- Business / user context ----------
  function resolveBusinessContext() {
    var params = new URLSearchParams(window.location.search || '');
    var fromUrl = params.get('business');
    var fromLocal = (window.localStorage && window.localStorage.getItem('businessKey')) || null;
    bizKey = fromUrl || fromLocal || window.BIZ_KEY || bizKey;
    if (!bizKey) { warn('no business key; cannot load gantt'); return false; }

    var user = auth.currentUser;
    var email = (user && user.email) || userEmail || '';
    userEmail = email;
    userUid = (user && user.uid) || userUid;
    isOwner = !!email && !!OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
    return true;
  }

  // ---------- Date helpers ----------
  function toJsDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    // An already-invalid Date object (e.g. new Date('garbage')) is still
    // truthy and still `instanceof Date` — returning it here without a
    // validity check would silently hand a NaN date downstream to every
    // consumer of this helper, which is exactly how one bad document can
    // corrupt the Gantt's computed date range without ever throwing.
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtISO(d) {
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  function dateOnly(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addDays(d, n) {
    var r = new Date(d.getTime());
    r.setDate(r.getDate() + n);
    return r;
  }

  // Rounds down to the start of whatever unit the active view mode uses
  // (year/month/day) — used to force-correct Frappe's own computed
  // gantt_start/gantt_end after construction, since its internal padding
  // and rounding logic has proven unreliable across every mode despite
  // repeated attempts to configure it correctly through its own options.
  function startOfUnit(d, unit) {
    if (unit === 'year') return new Date(d.getFullYear(), 0, 1);
    if (unit === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
    return dateOnly(d);
  }

  // Rounds up to the START of the NEXT unit boundary — used for the end
  // bound so the last real task's bar always has room to fully render
  // instead of being clipped at the exact edge of the grid.
  function endOfUnitExclusive(d, unit) {
    if (unit === 'year') return new Date(d.getFullYear() + 1, 0, 1);
    if (unit === 'month') return new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return addDays(dateOnly(d), 1);
  }

  // Reimplementation of Frappe's own internal date_utils.diff(n, t, unit)
  // (read directly from frappe-gantt@1.2.2's bundled source) — needed
  // because that helper isn't exposed on window.Gantt, but computing a
  // pixel position for the "today" line requires the EXACT same
  // month/year fractional-diff formula Frappe itself uses for bar and
  // scroll positioning, or the line would drift out of sync with the
  // grid by a few pixels per column.
  function ganttDateDiff(n, t, unit) {
    unit = unit || 'day';
    var msDiff = n.getTime() - t.getTime() + (t.getTimezoneOffset() - n.getTimezoneOffset()) * 60000;
    var days = msDiff / 1000 / 60 / 60 / 24;
    var months = (n.getFullYear() - t.getFullYear()) * 12 + (n.getMonth() - t.getMonth()) + n.getDate() / 31;
    if (n.getDate() < t.getDate()) months--;
    var years = months / 12;
    var key = unit.charAt(unit.length - 1) === 's' ? unit : unit + 's';
    var map = { days: days, months: months, years: years };
    return Math.round(map[key] !== undefined ? map[key] : days);
  }

  // Draws a thin vertical "today" marker directly into the Gantt's own
  // SVG grid, at the same x-coordinate Frappe would compute for a bar
  // starting today — so it stays correctly positioned across every view
  // mode (Day through Year) and pans naturally with horizontal scroll,
  // since it lives inside the same scrollable SVG as the bars themselves
  // rather than as a separately-positioned overlay element.
  function drawTodayLine(ganttInstance, container) {
    var svg = container.querySelector('svg.gantt');
    if (!svg || !ganttInstance.config || !ganttInstance.gantt_start || !ganttInstance.gantt_end) return;

    var today = new Date();
    if (today < ganttInstance.gantt_start || today > ganttInstance.gantt_end) return; // outside the rendered range — nothing to draw

    var x = ganttDateDiff(today, ganttInstance.gantt_start, ganttInstance.config.unit) /
      ganttInstance.config.step * ganttInstance.config.column_width;

    var svgHeight = parseFloat(svg.getAttribute('height')) || svg.getBBox().height;
    if (!svgHeight) return;

    var ns = 'http://www.w3.org/2000/svg';
    var line = document.createElementNS(ns, 'line');
    line.setAttribute('class', 'gantt-today-line');
    line.setAttribute('x1', x);
    line.setAttribute('x2', x);
    line.setAttribute('y1', 0);
    line.setAttribute('y2', svgHeight);
    svg.appendChild(line);

    // A small yellow/black tab sitting right above the line, at the true
    // top of the grid (y=0) regardless of scroll — makes "today" read as
    // a flag pinned to the date, not just a thin line easy to miss among
    // the grid lines and bars.
    var tabWidth = 42, tabHeight = 15;
    var g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'gantt-today-tab');

    var rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', x - tabWidth / 2);
    rect.setAttribute('y', 0);
    rect.setAttribute('width', tabWidth);
    rect.setAttribute('height', tabHeight);
    rect.setAttribute('rx', 3);
    rect.setAttribute('class', 'gantt-today-tab-bg');
    g.appendChild(rect);

    var label = document.createElementNS(ns, 'text');
    label.setAttribute('class', 'gantt-today-tab-label');
    label.setAttribute('x', x);
    label.setAttribute('y', tabHeight / 2);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'central');
    label.textContent = 'Today';
    g.appendChild(label);

    svg.appendChild(g);
  }

  // Hard floor: nothing before 2026 is ever shown. The chart's visible
  // range is driven purely by each task's own end date against this floor
  // — no separate "project window" filter on top of that. (There used to
  // be one, driven by projectStartDate/projectEndDate stored on the
  // business document — but that field is a side-channel that doesn't get
  // cleared along with the milestones/activities collections, so a stale
  // value from early testing could silently filter out real current data
  // while letting old leftover test entries through. Removed entirely
  // rather than fixed, since the floor below already does the actual job:
  // only show years that genuinely have a milestone or activity in them.)
  var GANTT_FLOOR_DATE = new Date(2026, 0, 1);

  function withinYearFloor(start, end) {
    return end >= GANTT_FLOOR_DATE;
  }

  // Bar color follows the same red/amber("yellow")/green convention used
  // everywhere else in the app (Q&A, Activity, Milestones RAG lights) —
  // computed from the same shared dr-rag.js formula, not a fixed per-type
  // color like before.
  function ganttBarColor(startForRag, dueForRag, isDone) {
    if (!window.drRag) return '#004e92';
    var jeopardy = window.drRag.compute(startForRag, dueForRag, isDone);
    if (jeopardy.code === 'red') return '#d33';
    if (jeopardy.code === 'amber') return '#e0a800';
    if (jeopardy.code === 'green') return '#2f9e44';
    return '#8a8a8a'; // done / no due date
  }

  // ---------- Build Frappe Gantt tasks from Firestore docs ----------
  function buildTasks() {
    var tasks = [];
    var today = dateOnly(new Date());

    milestoneDocs.forEach(function (item) {
      var d = item.data;
      var due = toJsDate(d.dueDate);
      if (!due) return; // nothing to place on the timeline without a date

      due = dateOnly(due);
      var start = toJsDate(d.startDate);
      // start strictly AFTER due, with an explicit startDate set, is
      // genuinely broken data — not the "no startDate yet" fallback case
      // below, and not a 0-duration milestone either (those legitimately
      // have start === due, which is valid, not inverted). Flag only the
      // true inversion visibly rather than silently faking a 1-day bar,
      // so a bad edit made before validation existed doesn't quietly look
      // fine forever.
      var hasInvertedDates = !!start && dateOnly(start).getTime() > due.getTime();
      start = start ? dateOnly(start) : addDays(due, -3);
      // Clamp the RENDERED start to the floor too, not just filter on the
      // end date — otherwise one task with a wildly early/corrupted start
      // (still due 2026+, so it isn't filtered out) drags Frappe's own
      // auto-computed calendar range back with it, pulling pre-2026 years
      // into the header even though every task in the list looks fine.
      if (start < GANTT_FLOOR_DATE) start = GANTT_FLOOR_DATE;
      var end = start.getTime() >= due.getTime() ? addDays(start, 1) : due;
      if (!withinYearFloor(start, end)) return;

      var occurred = due < today; // a past-dated milestone has "occurred", not "overdue"
      var progress = typeof d.progress === 'number' ? d.progress : (occurred ? 100 : 0);
      var mChangeLog = d.changeLog || [];
      var venue = d.status || d.location || '';
      if (venue === 'Other' && d.locationOther) venue += ': ' + d.locationOther;

      tasks.push({
        id: 'milestone_' + item.id,
        name: (hasInvertedDates ? '⚠️ INVALID DATES: ' : '') + (mChangeLog.length ? '🔄 ' : '') + '📌 ' + (d.title || 'Untitled milestone'),
        start: fmtISO(start),
        end: fmtISO(end),
        progress: Math.max(0, Math.min(100, progress)),
        color: ganttBarColor(d.startDate || d.createdAt, d.dueDate, occurred),
        custom_class: d.critical ? 'gantt-critical-task' : '',
        _collection: 'milestones',
        _docId: item.id,
        _changeLog: mChangeLog,
        _detailLabel: 'Venue',
        _detail: venue
      });
    });

    activityDocs.forEach(function (item) {
      var d = item.data;
      var due = toJsDate(d.dueDate);
      if (!due) return;

      due = dateOnly(due);
      var start = toJsDate(d.startDate);
      // Strictly AFTER due only — start === due is a legitimate 0-day
      // activity, not inverted data.
      var hasInvertedDates = !!start && dateOnly(start).getTime() > due.getTime();
      start = start ? dateOnly(start) : addDays(due, -3);
      if (start < GANTT_FLOOR_DATE) start = GANTT_FLOOR_DATE;
      var end = start.getTime() >= due.getTime() ? addDays(start, 1) : due;
      if (!withinYearFloor(start, end)) return;

      var isCompleted = (d.status || '').toLowerCase() === 'completed';
      var progress = d.progress;
      if (typeof progress !== 'number') {
        var s = (d.status || '').toLowerCase();
        progress = isCompleted ? 100 : s === 'in progress' ? 50 : 0;
      }
      var aChangeLog = d.changeLog || [];

      tasks.push({
        id: 'activity_' + item.id,
        name: (hasInvertedDates ? '⚠️ INVALID DATES: ' : '') + (aChangeLog.length ? '🔄 ' : '') + '📝 ' + (d.title || d.activity || 'Untitled activity'),
        start: fmtISO(start),
        end: fmtISO(end),
        progress: Math.max(0, Math.min(100, progress)),
        color: ganttBarColor(d.startDate || d.createdAt, d.dueDate, isCompleted),
        custom_class: d.critical ? 'gantt-critical-task' : '',
        _collection: 'activities',
        _docId: item.id,
        _changeLog: aChangeLog,
        _detailLabel: 'Description',
        _detail: d.description || ''
      });
    });

    return tasks;
  }

  // ---------- Persist owner edits (with a visible change history) ----------
  function taskRef(task) {
    return db.collection('businesses').doc(bizKey).collection(task._collection).doc(task._docId);
  }

  function sourceDocData(task) {
    var list = task._collection === 'milestones' ? milestoneDocs : activityDocs;
    var found = list.find(function (d) { return d.id === task._docId; });
    return found ? found.data : {};
  }

  function fmtForLog(v) {
    return window.drDateFmt ? window.drDateFmt.date(v) : (toJsDate(v) ? toJsDate(v).toDateString() : '—');
  }

  // Appends one entry to the item's changeLog (kept to the most recent 5)
  // so the Gantt popup can show real before -> after values instead of a
  // vague "this was modified."
  function appendChangeLog(existingLog, changes) {
    var log = (existingLog || []).slice(-4);
    log.push({
      changes: changes,
      changedAt: new Date(),
      changedBy: userEmail || 'Someone'
    });
    return log;
  }

  function persistDateChange(task, newStart, newEnd) {
    if (!isOwner || !task || !task._collection || !task._docId) return;

    var s = newStart instanceof Date ? newStart : new Date(newStart);
    var e = newEnd instanceof Date ? newEnd : new Date(newEnd);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return;

    var s2 = dateOnly(s);
    var e2 = dateOnly(e);

    // Start can never land after due (e.g. dragging a resize handle past
    // the bar's other edge). Reject the write and snap the bar back to its
    // last known-good position rather than saving an inverted range.
    if (s2 > e2) {
      warn('rejected date change: start would be after due', { start: s2, due: e2 });
      try { alert('The start date cannot be after the due date.'); } catch (_e) {}
      render();
      return;
    }

    var before = sourceDocData(task);
    var changes = [];
    if (fmtForLog(before.startDate) !== fmtForLog(s2)) {
      changes.push({ field: 'Start date', from: fmtForLog(before.startDate) || 'not set', to: fmtForLog(s2) });
    }
    if (fmtForLog(before.dueDate) !== fmtForLog(e2)) {
      changes.push({ field: 'Due date', from: fmtForLog(before.dueDate) || 'not set', to: fmtForLog(e2) });
    }

    var update = {
      startDate: s2,
      dueDate: e2,
      updatedAt: new Date(),
      updatedBy: userEmail || null
    };
    if (changes.length) update.changeLog = appendChangeLog(before.changeLog, changes);

    taskRef(task).update(update).catch(function (err) {
      error('date change failed', err);
      try { alert('Could not save the new schedule: ' + (err && err.message ? err.message : err)); } catch (_e) {}
    });
  }

  function persistProgressChange(task, progress) {
    if (!isOwner || !task || !task._collection || !task._docId) return;

    var p = Math.max(0, Math.min(100, Math.round(progress)));
    var before = sourceDocData(task);
    var oldProgress = typeof before.progress === 'number' ? before.progress : 0;

    var update = {
      progress: p,
      updatedAt: new Date(),
      updatedBy: userEmail || null
    };
    if (oldProgress !== p) {
      update.changeLog = appendChangeLog(before.changeLog, [
        { field: 'Progress', from: oldProgress + '%', to: p + '%' }
      ]);
    }

    taskRef(task).update(update).catch(function (err) {
      error('progress change failed', err);
    });
  }

  // Custom popup: title + dates/progress, and — when present — the actual
  // before/after values for every change made to this item, not just a
  // vague "this was modified" flag.
  function renderChangePopup(ctx) {
    var task = ctx.task;
    ctx.set_title(task.name);

    var basics =
      '<div class="gantt-popup-basics">' +
      (window.drDateFmt ? window.drDateFmt.date(task._start) : task.start) +
      ' – ' +
      (window.drDateFmt ? window.drDateFmt.date(task._end) : task.end) +
      ' · ' + task.progress + '% complete' +
      '</div>';

    if (task._detail) {
      basics += '<div class="gantt-popup-detail"><strong>' + task._detailLabel + ':</strong> ' + task._detail + '</div>';
    }

    var log = task._changeLog || [];
    if (!log.length) {
      ctx.set_details(basics + '<div class="gantt-popup-nochange">No changes recorded yet.</div>');
      return;
    }

    var html = basics + '<div class="gantt-changelog">';
    log.slice().reverse().forEach(function (entry) {
      var when = window.drDateFmt ? window.drDateFmt.dateTime(entry.changedAt) : '';
      html += '<div class="gantt-changelog-entry">' +
        '<div class="gantt-changelog-meta"><strong>' + (entry.changedBy || 'Someone') + '</strong> · ' + when + '</div>' +
        '<ul class="gantt-changelog-list">';
      (entry.changes || []).forEach(function (c) {
        html += '<li><span class="gantt-changelog-field">' + c.field + ':</span> ' +
          '<span class="gantt-changelog-from">' + c.from + '</span> → ' +
          '<span class="gantt-changelog-to">' + c.to + '</span></li>';
      });
      html += '</ul></div>';
    });
    html += '</div>';

    ctx.set_details(html);
  }

  // ---------- Render ----------
  function render() {
    if (!container) return;

    var tasks = buildTasks();

    // Preserve horizontal scroll position across a rebuild — without this,
    // every re-render (including the one triggered by the owner's own drag
    // write echoing back through onSnapshot) snaps the chart back to its
    // default scroll position, which reads as the chart "jumping" mid-use.
    var prevScrollEl = container.querySelector('.gantt-container');
    var prevScrollLeft = prevScrollEl ? prevScrollEl.scrollLeft : null;

    container.innerHTML = '';

    if (!tasks.length) {
      container.innerHTML = '<p class="gantt-empty">No dated milestones or activities yet — add a due date to a milestone or activity to see it here.</p>';
      return;
    }

    if (typeof window.Gantt !== 'function') {
      warn('Gantt library not loaded yet; retrying shortly');
      setTimeout(render, 300);
      return;
    }

    // Track the earliest task (never earlier than the 2026 floor, since
    // every task's start is already clamped to it above) so the initial
    // view can be scrolled there directly — task.start is already a
    // "YYYY-MM-DD" string, so a plain comparison sorts correctly.
    var earliestTask = tasks.reduce(function (min, t) {
      return (!min || t.start < min.start) ? t : min;
    }, null);
    var latestTask = tasks.reduce(function (max, t) {
      return (!max || t.end > max.end) ? t : max;
    }, null);

    // Plain string, not an object — copy-pasting console text renders an
    // un-expanded logged object as just the word "Object", losing the
    // actual values, which is why earlier diagnostic rounds kept coming
    // back without the data actually needed. Includes the task NAME on
    // both ends, not just the date, so whichever one is unexpectedly far
    // out can be found and fixed directly instead of guessing which
    // record it is.
    log('rendering: currentViewMode=' + currentViewMode + ' taskCount=' + tasks.length +
      ' earliest=[' + (earliestTask && earliestTask.start) + '] ' + (earliestTask && earliestTask.name) +
      ' latest=[' + (latestTask && latestTask.end) + '] ' + (latestTask && latestTask.name));

    // Also surfaced directly on the page (not just devtools) — the exact
    // bounds actually in use, so a wrong range is visible at a glance
    // without opening the console at all.
    var boundsNoteEl = document.getElementById('ganttBoundsNote');
    if (boundsNoteEl) {
      boundsNoteEl.textContent = earliestTask && latestTask
        ? 'Showing ' + earliestTask.start + ' → ' + latestTask.end +
          ' (earliest: "' + earliestTask.name + '", latest: "' + latestTask.name + '")'
        : '';
    }

    // Every Frappe built-in view mode pads the grid beyond the actual task
    // dates (Month: 2 months, Year: 2 years, Week: 1 month) — that padding
    // is what kept pulling prior years into view even with every task's
    // rendered start already clamped to the 2026 floor, since it's applied
    // on top of that clamp, not instead of it. There is no option to just
    // turn padding off; the only way to change it is to replace the whole
    // view_modes list. Month, Year, and Week — the three modes whose
    // padding is large enough to visibly pull in prior years or months —
    // are redefined below with their padding reduced to near-zero, using
    // the exact built-in properties from
    // frappe-gantt@1.2.2/dist/frappe-gantt.umd.js wherever known; the
    // remaining modes (Hour/Quarter Day/Half Day/Day) are left as the
    // untouched built-in definitions by name since their padding (7-14
    // days) is too small to ever surface a prior year.
    // "3 Months", "6 Months", and "Year" are meant to fill the section
    // edge-to-edge with exactly that many months visible at once — no
    // scrolling needed to see the whole window — rather than a fixed
    // pixel width that leaves empty space on a wide screen or forces
    // scrolling on a narrow one. Measured against the actual card width
    // at render time, with a floor so columns never get too cramped to
    // read on a narrow viewport.
    var availableWidth = container.clientWidth || (container.parentElement && container.parentElement.clientWidth) || 900;
    function fillWidthColumn(monthCount, minWidth) {
      return Math.max(minWidth, Math.floor(availableWidth / monthCount));
    }

    var viewModes = [
      {
        name: 'Month',
        padding: '0d',
        step: '1m',
        column_width: 120,
        date_format: 'YYYY-MM',
        lower_text: 'MMMM',
        upper_text: function (curDate, prevDate) {
          return (!prevDate || curDate.getFullYear() !== prevDate.getFullYear())
            ? String(curDate.getFullYear())
            : '';
        },
        thick_line: function (d) { return d.getMonth() % 3 === 0; },
        snap_at: '7d'
      },
      {
        // "3 Months" is a rolling window — the next 3 months FROM TODAY
        // (see the isRollingWindowMode scroll-anchor logic below) — shown
        // MONTH BY MONTH, same granularity as Month view itself, not one
        // column grouping 3 months together. Per explicit feedback: "it
        // is the next 3 months ... month by month, not a grouping" and
        // the 3 columns should fill the section's width edge-to-edge.
        name: '3 Months',
        padding: '0d',
        step: '1m',
        column_width: fillWidthColumn(3, 140),
        date_format: 'YYYY-MM',
        lower_text: 'MMMM',
        upper_text: function (curDate, prevDate) {
          return (!prevDate || curDate.getFullYear() !== prevDate.getFullYear())
            ? String(curDate.getFullYear())
            : '';
        },
        thick_line: function (d) { return d.getMonth() % 3 === 0; },
        snap_at: '7d'
      },
      {
        // Same idea as "3 Months" — a rolling today-forward window, month
        // by month, filling the section width so all 6 months are visible
        // without scrolling.
        name: '6 Months',
        padding: '0d',
        step: '1m',
        column_width: fillWidthColumn(6, 70),
        date_format: 'YYYY-MM',
        lower_text: function (curDate) { return MONTH_NAMES[curDate.getMonth()].slice(0, 3); },
        upper_text: function (curDate, prevDate) {
          return (!prevDate || curDate.getFullYear() !== prevDate.getFullYear())
            ? String(curDate.getFullYear())
            : '';
        },
        thick_line: function (d) { return d.getMonth() % 6 === 0; },
        snap_at: '7d'
      },
      {
        name: 'Week',
        padding: '0d',
        step: '7d',
        date_format: 'YYYY-MM-DD',
        column_width: 140,
        // Frappe only gives us two header rows, so with the year pinned
        // to the upper row (below), the month has to live down here
        // alongside the day number instead of its own row — "Jan 5",
        // "Jan 12", etc. — rather than a bare day number with no month
        // context at all.
        lower_text: function (curDate) { return MONTH_NAMES[curDate.getMonth()].slice(0, 3) + ' ' + curDate.getDate(); },
        // Year on the upper row, changing only on a year boundary — same
        // convention as every other mode's upper row. Per explicit
        // feedback: "the year has to be above the month."
        upper_text: function (curDate, prevDate) {
          return (!prevDate || curDate.getFullYear() !== prevDate.getFullYear())
            ? String(curDate.getFullYear())
            : '';
        },
        thick_line: function (d) { return d.getDate() >= 1 && d.getDate() <= 7; },
        upper_text_frequency: 4
      },
      {
        // "Year" shows the full project span broken down MONTH BY MONTH
        // (not one column per calendar year) — same column shape as
        // Month view, sized to fill the section width so a full 12-month
        // span fits on screen at once without scrolling. Per explicit
        // feedback: "The year needs to show year month by month for the
        // total year" and should "expand across the section."
        name: 'Year',
        padding: '0d',
        step: '1m',
        column_width: fillWidthColumn(12, 45),
        date_format: 'YYYY-MM',
        lower_text: function (curDate) { return MONTH_NAMES[curDate.getMonth()].slice(0, 3); },
        upper_text: function (curDate, prevDate) {
          return (!prevDate || curDate.getFullYear() !== prevDate.getFullYear())
            ? String(curDate.getFullYear())
            : '';
        },
        thick_line: function (d) { return d.getMonth() % 3 === 0; },
        snap_at: '7d'
      },
      {
        // Otherwise identical to the built-in Day mode (same 7d padding,
        // judged small enough to leave alone) — upper_text now shows the
        // month name above the day numbers (year appended only when it
        // changes), per explicit feedback.
        name: 'Day',
        padding: '7d',
        date_format: 'YYYY-MM-DD',
        step: '1d',
        lower_text: function (curDate) { return String(curDate.getDate()); },
        upper_text: monthUpperText,
        thick_line: function (d) { return d.getDay() === 1; }
      },
      'Hour', 'Quarter Day', 'Half Day'
    ];

    // Frappe's setup_options() unconditionally overwrites view_mode to be
    // view_modes[0] — the FIRST entry in this array — ignoring whatever
    // view_mode option is explicitly passed alongside it (verified
    // directly against the library source). That's why every render was
    // silently reverting to Month no matter what currentViewMode said:
    // Month was always listed first. Sorting the array so the currently
    // selected mode is always at index 0 is the only way to actually
    // control which mode ends up active.
    viewModes.sort(function (a, b) {
      var aName = typeof a === 'string' ? a : a.name;
      var bName = typeof b === 'string' ? b : b.name;
      if (aName === currentViewMode) return -1;
      if (bName === currentViewMode) return 1;
      return 0;
    });

    try {
      var ganttInstance = new window.Gantt(container, tasks, {
        // Frappe's defaults (bar_height:30, row padding:18 -> 48px/row)
        // leave a lot of empty vertical space around each bar's text —
        // shrinking both makes each entry's row about as tall as the
        // label actually needs, fitting more rows on screen at once.
        // 14/6 (20px/row) is close to the line-height of the bar's own
        // label text — much smaller starts clipping it.
        bar_height: 14,
        padding: 6,
        view_mode: currentViewMode,
        view_modes: viewModes,
        // Frappe's built-in dropdown (view_mode_select: true) deliberately
        // reuses whatever date range was computed at construction time
        // when you switch modes — it does NOT recompute bounds for the
        // newly selected mode (verified directly against the library
        // source), which is exactly why "Year" kept showing years outside
        // 2026 even with the padding fix in place: neither that fix nor
        // the floor clamp ever got a chance to run for that mode. Adding
        // a second listener alongside Frappe's own to force a rebuild
        // afterward caused the two to race — Frappe's handler still ran
        // and partially rendered first. So Frappe's own dropdown is
        // disabled entirely here; the #ganttViewMode <select> in
        // dashboard.html drives view-mode switching instead, always
        // through this module's own render(), which recomputes bounds
        // from scratch every time with no competing handler.
        view_mode_select: false,
        today_button: true,
        readonly: !isOwner,
        popup_on: 'click',
        popup: renderChangePopup,
        // Belt-and-suspenders: with padding removed above, the earliest
        // task should already sit at (or very near) scrollLeft 0 with no
        // scrolling needed — scroll_to and the internal-container scroll
        // set below (in the "first render" branch) are kept as a safety
        // net in case any padding remains from a future library update.
        scroll_to: (earliestTask && earliestTask.start) || fmtISO(GANTT_FLOOR_DATE),
        on_date_change: function (task, start, end) {
          persistDateChange(task, start, end);
        },
        on_progress_change: function (task, progress) {
          persistProgressChange(task, progress);
        }
      });

      // Force-correct the grid's actual date range directly, rather than
      // trusting Frappe's own internal computation of it — that computation
      // has produced wrong results (as far off as 1996) across every mode
      // despite the padding, reordering, and crash fixes already applied,
      // so it can no longer be trusted regardless of the exact remaining
      // cause. This overwrites gantt_start/gantt_end with values computed
      // directly from the real task list — the earliest task's start
      // (never before the 2026 floor) through one unit past the latest
      // task's end — then asks Frappe to rebuild the grid using them.
      if (earliestTask && latestTask && ganttInstance.config) {
        var unit = ganttInstance.config.unit || 'month';
        var correctedStart = startOfUnit(toJsDate(earliestTask.start), unit);
        if (correctedStart < GANTT_FLOOR_DATE) correctedStart = GANTT_FLOOR_DATE;
        var correctedEnd = endOfUnitExclusive(toJsDate(latestTask.end), unit);

        // Applied UNCONDITIONALLY now, not just when gantt_start/gantt_end
        // already look wrong — comparing Frappe's own computed bounds
        // against the target and skipping the correction when they
        // "already matched" was the one path that could leave a genuinely
        // wrong render on screen with no correction attempted at all, if
        // that comparison were ever satisfied by something other than a
        // truly correct render (e.g. a stale reference). Re-running
        // setup_date_values()+render() when bounds already match is a
        // harmless extra redraw; skipping it when they don't is the actual
        // bug this exists to prevent.
        warn('forcing frappe bounds: was ' +
          (ganttInstance.gantt_start && ganttInstance.gantt_start.toString()) + ' to ' +
          (ganttInstance.gantt_end && ganttInstance.gantt_end.toString()) + ', now ' +
          correctedStart.toString() + ' to ' + correctedEnd.toString());
        try {
          ganttInstance.gantt_start = correctedStart;
          ganttInstance.gantt_end = correctedEnd;
          ganttInstance.setup_date_values();
          ganttInstance.render();
        } catch (correctionErr) {
          // Surfaced on-page (not just console) — if this correction ever
          // throws partway through, the chart is left showing whatever
          // Frappe's own (possibly wrong) initial render produced, with no
          // visible sign anything failed. Recorded here so the next
          // report of "wrong years" carries the actual cause instead of
          // another guess.
          if (boundsNoteEl) {
            boundsNoteEl.textContent += ' [bounds correction FAILED: ' + (correctionErr && correctionErr.message) + ']';
          }
          error('bounds correction threw', correctionErr);
        }
        // Visible confirmation of what the grid actually ended up showing
        // after the correction attempt, whether it succeeded or not — lets
        // a mismatch against the "Showing ..." target above be spotted
        // directly on the page without devtools.
        if (boundsNoteEl) {
          boundsNoteEl.textContent += ' | grid: ' +
            (ganttInstance.gantt_start && ganttInstance.gantt_start.toDateString()) + ' → ' +
            (ganttInstance.gantt_end && ganttInstance.gantt_end.toDateString());
          // Decisive check: compares Frappe's internal this.dates array
          // (what the correction actually computed) against what actually
          // got painted into the header DOM. If these two disagree, the
          // bug is in Frappe's OWN render pipeline re-using/duplicating
          // stale header markup rather than in anything this file
          // computes — if they agree, the problem is upstream of here.
          if (Array.isArray(ganttInstance.dates) && ganttInstance.dates.length) {
            var firstDrawn = container.querySelector('.upper-text');
            var upperTexts = container.querySelectorAll('.upper-text');
            var lastDrawn = upperTexts.length ? upperTexts[upperTexts.length - 1] : null;
            boundsNoteEl.textContent += ' | dates[]: ' +
              ganttInstance.dates[0].toDateString() + ' … ' +
              ganttInstance.dates[ganttInstance.dates.length - 1].toDateString() +
              ' (' + ganttInstance.dates.length + ' cols) | painted header: "' +
              (firstDrawn ? firstDrawn.textContent : '?') + '" … "' +
              (lastDrawn ? lastDrawn.textContent : '?') + '"';
          }
        }
        // No scrollIntoView here — it was jumping the WHOLE PAGE down to
        // the Gantt section on every re-render that needed a bounds
        // correction, which now includes any change elsewhere on the
        // dashboard that switches the global time frame (that alone
        // re-renders the Gantt at a new view mode). The prevScrollLeft
        // restore right below already puts the Gantt's own internal
        // horizontal scroll back where it was, with no page-level jump.
      }

      // A raw scrollLeft pixel value only means the same thing across a
      // re-render if the column width didn't change — Month is 120px/col,
      // 3 Months is 260px/col, 6 Months is 320px/col. Only restore
      // prevScrollLeft for a same-mode re-render (a data update, a bounds
      // correction); a genuine mode switch needs to re-anchor instead.
      //
      // Where it re-anchors TO depends on the mode: "3 Months" and
      // "6 Months" are explicitly meant to show the next 3/6 months FROM
      // TODAY (a rolling forward-looking window), not the project's
      // earliest task — every other mode anchors to the earliest task as
      // the natural "start of the project" view.
      var viewModeChanged = lastRenderedViewMode !== null && lastRenderedViewMode !== currentViewMode;
      var isRollingWindowMode = currentViewMode === '3 Months' || currentViewMode === '6 Months';

      if (prevScrollLeft !== null && !viewModeChanged) {
        var newScrollEl = container.querySelector('.gantt-container');
        if (newScrollEl) newScrollEl.scrollLeft = prevScrollLeft;
      } else if (isRollingWindowMode && typeof ganttInstance.set_scroll_position === 'function') {
        // Frappe's own date-to-scroll-position method — correctly accounts
        // for the current mode's column_width/step, unlike a manual pixel
        // offset computed for a different mode.
        ganttInstance.set_scroll_position(new Date());
      } else if (earliestTask) {
        // First render, or a mode switch to a non-rolling-window mode —
        // scroll the Gantt's OWN internal container directly to the
        // earliest task's bar, via its offset rather than scrollIntoView.
        // scrollIntoView can scroll ANY scrollable ancestor, including the
        // whole page, if the bar isn't already fully in the viewport —
        // which is exactly what pulled a fresh sign-in down to the Gantt
        // section instead of leaving the page at the top. Setting
        // scrollLeft directly on the known internal container can only
        // ever move that container.
        var earliestBar = container.querySelector('.bar-wrapper[data-id="' + earliestTask.id + '"]');
        var innerScrollEl = container.querySelector('.gantt-container');
        if (earliestBar && innerScrollEl) {
          innerScrollEl.scrollLeft = earliestBar.offsetLeft;
        }
      }
      lastRenderedViewMode = currentViewMode;

      drawTodayLine(ganttInstance, container);

      // #ganttViewModeGroup lives outside this container (in
      // dashboard.html), so unlike everything above it survives the
      // container.innerHTML wipe at the top of this function — keep the
      // active button's styling in sync, and wire the click listener
      // exactly once (it's the same persistent element on every render,
      // so wiring it again each time would stack up duplicate listeners).
      var viewGroup = document.getElementById('ganttViewModeGroup');
      log('viewGroup element found?', !!viewGroup, 'already wired?', !!(viewGroup && viewGroup.__ganttWired));
      if (viewGroup) {
        var modeBtns = viewGroup.querySelectorAll('.gantt-view-mode-btn');
        modeBtns.forEach(function (btn) {
          btn.classList.toggle('is-active', btn.getAttribute('data-mode') === currentViewMode);
        });
        if (!viewGroup.__ganttWired) {
          viewGroup.__ganttWired = true;
          viewGroup.addEventListener('click', function (e) {
            var btn = e.target.closest('.gantt-view-mode-btn');
            if (!btn) return;
            log('view mode button clicked:', btn.getAttribute('data-mode'));
            currentViewMode = btn.getAttribute('data-mode');
            render();
          });
        }
      } else {
        warn('#ganttViewModeGroup not found in the DOM — check dashboard.html has that markup');
      }
    } catch (e) {
      error('render failed', e);
    }
  }

  // ---------- Import (owner only) — reuses SheetJS already loaded for Activity import ----------
  function wireImport() {
    var btn = document.getElementById('ganttImportBtn');
    var input = document.getElementById('ganttImportInput');
    // The whole "Data Imports" panel is owner-only — toggled here since
    // this runs (and re-runs on owner-status change) reliably regardless
    // of which other scripts have loaded yet.
    var importsPanel = document.getElementById('dataImportsPanel');
    if (importsPanel) importsPanel.classList.toggle('owner', isOwner);
    if (!btn || !input) return;

    if (!isOwner) {
      btn.style.display = 'none';
      input.style.display = 'none';
      return;
    }
    btn.style.display = '';
    input.style.display = '';
    if (btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener('click', function () {
      if (!input.files || !input.files[0]) {
        alert('Choose an Excel (.xlsx) or CSV file first.');
        return;
      }
      if (typeof XLSX === 'undefined') {
        alert('Import library not loaded yet — try again in a moment.');
        return;
      }

      var file = input.files[0];

      file.arrayBuffer().then(function (data) {
        var wb = XLSX.read(data, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (!rows.length) { alert('Excel file has no rows.'); return; }

        var header = rows[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
        function colIndex(names) {
          for (var i = 0; i < header.length; i++) {
            if (names.indexOf(header[i]) !== -1) return i;
          }
          return -1;
        }

        var idxType = colIndex(['type']);
        // Some MS Project exports (e.g. the "Milestone" flag column) mark
        // milestones with a Yes/No column instead of a Type column.
        var idxMilestoneFlag = colIndex(['milestone', 'is milestone', 'is_milestone']);
        var idxTitle = colIndex(['title', 'name', 'task_name', 'task name']);
        var idxStart = colIndex(['start', 'startdate', 'start date', 'start_date']);
        var idxDue = colIndex(['due', 'duedate', 'due date', 'end', 'enddate', 'end date', 'finish', 'finish_date', 'finish date']);
        var idxProgress = colIndex(['progress', '% complete', 'percent complete', 'percent_complete']);
        var idxOutline = colIndex(['outline_level', 'outline level', 'outlinelevel', 'wbs level']);
        var idxResource = colIndex(['resource_names', 'resource names', 'resources', 'responsible']);
        var idxWbs = colIndex(['wbs']);
        var idxDuration = colIndex(['duration']);
        // Cost-performance fields — captured from the top-level (Outline
        // Level 0) summary row only, for the owner-only Cost Performance
        // stat tile. MS Project computes EAC/CPI/CV itself; we don't
        // recompute those, only derive AC = EV / CPI and ETC = EAC - AC
        // from them (see renderCostPerformance in burndown.js).
        var idxCost = colIndex(['cost']);
        var idxEac = colIndex(['eac']);
        var idxCpi = colIndex(['cpi']);
        var idxCv = colIndex(['cv']);
        var idxSv = colIndex(['sv']);
        // Real baseline/actual cost + baseline schedule — when present
        // (this project's latest export has them), the EVM chart in
        // burndown.js uses these directly instead of approximating PV from
        // the current schedule and AC from EV/CPI.
        var idxBaselineCost = colIndex(['baseline_cost', 'baseline cost']);
        var idxActualCost = colIndex(['actual_cost', 'actual cost']);
        var idxBaselineStart = colIndex(['baseline_start', 'baseline start']);
        var idxBaselineFinish = colIndex(['baseline_finish', 'baseline finish']);
        // Critical path flag — MS Project's own Yes/No column, already
        // present in the schedule export but not used until now. Drives a
        // colored outline on the Gantt bar (see ganttBarColor's sibling,
        // the custom_class on each task below) rather than a separate
        // report, so critical-path status is visible right on the chart.
        var idxCritical = colIndex(['critical']);

        if (idxTitle === -1 || idxDue === -1) {
          alert('Excel sheet must have at least Title and Due Date columns.');
          return;
        }

        log('column mapping', {
          title: header[idxTitle], due: header[idxDue],
          cost: idxCost >= 0 ? header[idxCost] : '(not found)',
          baselineCost: idxBaselineCost >= 0 ? header[idxBaselineCost] : '(not found)',
          actualCost: idxActualCost >= 0 ? header[idxActualCost] : '(not found)'
        });

        function parseCell(v) {
          if (v == null || v === '') return null;
          if (typeof v === 'number') {
            var jsDate = XLSX.SSF.parse_date_code(v);
            if (jsDate) return new Date(jsDate.y, jsDate.m - 1, jsDate.d);
          }
          var d = new Date(v);
          return isNaN(d.getTime()) ? null : d;
        }

        function dfmt(v) {
          return window.drDateFmt ? (window.drDateFmt.date(v) || 'not set') : (v ? String(v) : 'not set');
        }
        function fmtMoneyForLog(v) {
          return typeof v === 'number' ? '$' + Math.round(v).toLocaleString() : 'not set';
        }
        // Rounds to the nearest dollar before comparing so float noise from
        // the spreadsheet library re-parsing the same value on every
        // import doesn't log a change that isn't really there.
        function costFieldChanged(a, b) {
          var an = typeof a === 'number' ? Math.round(a) : null;
          var bn = typeof b === 'number' ? Math.round(b) : null;
          return an !== bn;
        }

        // Re-importing an updated file should UPDATE rows that already
        // exist (matched by WBS, the stable id MS Project assigns each
        // row) rather than creating duplicates every time — so fetch
        // what's already there first and match against it below.
        var milestonesQuery = db.collection('businesses').doc(bizKey).collection('milestones').get();
        var activitiesQuery = db.collection('businesses').doc(bizKey).collection('activities').get();

        Promise.all([milestonesQuery, activitiesQuery]).then(function (snaps) {
          var existingByWbs = { milestones: {}, activities: {} };
          ['milestones', 'activities'].forEach(function (col, i) {
            snaps[i].forEach(function (doc) {
              var d = doc.data() || {};
              if (d.wbs) existingByWbs[col][String(d.wbs).trim()] = { id: doc.id, data: d };
            });
          });

          // Track the row with the lowest outline level (0 = the whole
          // project, e.g. "PowerMgmt Project Plan v1.0") so its
          // Start/Finish can become the project's official bounds — that's
          // what keeps stray or bad-date rows from stretching the Gantt
          // into years that have nothing to do with the actual project.
          var boundsRow = null; // { level, start, due }

          var ops = [];
          var createdCount = 0, updatedCount = 0, movedCount = 0, costFoundCount = 0;

          for (var r = 1; r < rows.length; r++) {
            var row = rows[r] || [];
            var title = row[idxTitle] != null ? String(row[idxTitle]).trim() : '';
            if (!title) continue;

            var milestoneFlag = (idxMilestoneFlag >= 0 && row[idxMilestoneFlag] != null)
              ? String(row[idxMilestoneFlag]).trim().toLowerCase()
              : '';
            var type = (idxType >= 0 && row[idxType]) ? String(row[idxType]).trim().toLowerCase() : '';
            // MS Project's Duration column reads like "0 days", "0.75
            // days", "10 days" — parseFloat grabs the leading number and
            // ignores the unit. A milestone is defined as a zero-duration
            // event, which this file's own Milestone Yes/No flag already
            // agrees with on every row — checking both makes detection
            // work even if one of those two columns is missing or doesn't
            // parse as expected.
            var durationVal = idxDuration >= 0 && row[idxDuration] != null ? parseFloat(String(row[idxDuration])) : NaN;
            var isZeroDuration = !isNaN(durationVal) && durationVal === 0;
            var isMilestone = milestoneFlag === 'yes' || milestoneFlag === 'true' || type.indexOf('milestone') === 0 || isZeroDuration;
            var collection = isMilestone ? 'milestones' : 'activities';
            var otherCollection = collection === 'milestones' ? 'activities' : 'milestones';

            var dueDate = idxDue >= 0 ? parseCell(row[idxDue]) : null;
            if (!dueDate) continue;

            var startDate = idxStart >= 0 ? parseCell(row[idxStart]) : null;
            // MS Project's own CSV export writes Percent_Complete as a 0-1
            // fraction (0.33 = 33%), not 0-100 — but some other sources
            // (e.g. a manually built sheet) might already use 0-100. Treat
            // anything <= 1 as a fraction and scale it up.
            var rawProgress = (idxProgress >= 0 && row[idxProgress] != null) ? Number(row[idxProgress]) : 0;
            if (isNaN(rawProgress)) rawProgress = 0;
            var progress = rawProgress > 0 && rawProgress <= 1 ? rawProgress * 100 : rawProgress;
            progress = Math.max(0, Math.min(100, progress));

            if (idxOutline >= 0 && row[idxOutline] != null && row[idxOutline] !== '') {
              var level = Number(row[idxOutline]);
              if (!isNaN(level) && startDate && (!boundsRow || level < boundsRow.level)) {
                var rowCost = idxCost >= 0 ? parseFloat(row[idxCost]) : NaN;
                var rowEac = idxEac >= 0 ? parseFloat(row[idxEac]) : NaN;
                var rowCpi = idxCpi >= 0 ? parseFloat(row[idxCpi]) : NaN;
                var rowCv = idxCv >= 0 ? parseFloat(row[idxCv]) : NaN;
                var rowActualCost = idxActualCost >= 0 ? parseFloat(row[idxActualCost]) : NaN;
                var rowBaselineCost = idxBaselineCost >= 0 ? parseFloat(row[idxBaselineCost]) : NaN;
                var rowSv = idxSv >= 0 ? parseFloat(row[idxSv]) : NaN;
                boundsRow = {
                  level: level, start: startDate, due: dueDate,
                  progressPct: progress, // 0-100
                  cost: isNaN(rowCost) ? null : rowCost,
                  eac: isNaN(rowEac) ? null : rowEac,
                  cpi: isNaN(rowCpi) ? null : rowCpi,
                  cv: isNaN(rowCv) ? null : rowCv,
                  sv: isNaN(rowSv) ? null : rowSv,
                  actualCost: isNaN(rowActualCost) ? null : rowActualCost,
                  baselineCost: isNaN(rowBaselineCost) ? null : rowBaselineCost
                };
              }
            }

            var wbs = (idxWbs >= 0 && row[idxWbs] != null) ? String(row[idxWbs]).trim() : '';
            // Per-task dollar figures — needed for the EVM chart (PV/EV/AC),
            // not just the project-wide rollup captured on the business
            // doc below. Owner-only downstream, same as the rest of EVM.
            // baselineCost/baselineStart/baselineFinish and actualCost are
            // real MS Project fields when the export includes them — when
            // present, burndown.js uses them directly instead of
            // approximating PV from the current schedule and AC from
            // EV/CPI.
            var rowCostVal = idxCost >= 0 ? parseFloat(row[idxCost]) : NaN;
            var rowBaselineCostVal = idxBaselineCost >= 0 ? parseFloat(row[idxBaselineCost]) : NaN;
            var rowActualCostVal = idxActualCost >= 0 ? parseFloat(row[idxActualCost]) : NaN;
            var rowBaselineStart = idxBaselineStart >= 0 ? parseCell(row[idxBaselineStart]) : null;
            var rowBaselineFinish = idxBaselineFinish >= 0 ? parseCell(row[idxBaselineFinish]) : null;

            if (!isNaN(rowCostVal)) costFoundCount++;

            var payload = {
              title: title,
              dueDate: dueDate,
              startDate: startDate,
              progress: progress,
              wbs: wbs || null,
              cost: isNaN(rowCostVal) ? null : rowCostVal,
              baselineCost: isNaN(rowBaselineCostVal) ? null : rowBaselineCostVal,
              actualCost: isNaN(rowActualCostVal) ? null : rowActualCostVal,
              baselineStart: rowBaselineStart || null,
              baselineFinish: rowBaselineFinish || null,
              critical: idxCritical >= 0 && String(row[idxCritical] || '').trim().toLowerCase() === 'yes'
            };

            if (collection === 'activities') {
              payload.status = progress >= 100 ? 'Completed' : (progress > 0 ? 'In Progress' : 'Not Started');
              if (idxResource >= 0 && row[idxResource] != null) {
                payload.responsible = String(row[idxResource]).trim();
              }
            } else {
              payload.status = 'On-site';
            }

            var existingMatch = wbs ? existingByWbs[collection][wbs] : null;
            var existingInOther = wbs ? existingByWbs[otherCollection][wbs] : null;
            var docRef = db.collection('businesses').doc(bizKey);

            if (existingMatch) {
              // Same WBS, same type as before — update in place and log
              // exactly what changed, same shape as a manual edit.
              var before = existingMatch.data;
              var edits = [];
              if ((before.title || '') !== title) edits.push({ field: 'Title', from: before.title || 'not set', to: title });
              if (dfmt(before.dueDate) !== dfmt(dueDate)) edits.push({ field: 'Due date', from: dfmt(before.dueDate), to: dfmt(dueDate) });
              if (dfmt(before.startDate) !== dfmt(startDate)) edits.push({ field: 'Start date', from: dfmt(before.startDate), to: dfmt(startDate) });
              if ((before.progress || 0) !== progress) edits.push({ field: 'Progress', from: (before.progress || 0) + '%', to: Math.round(progress) + '%' });
              if ((before.status || '') !== payload.status) edits.push({ field: 'Status', from: before.status || 'not set', to: payload.status });
              // Cost-metric changes — a re-import with an updated Cost/
              // Baseline Cost/Actual Cost figure previously went through
              // silently; the Change Report had no record of it at all.
              if (costFieldChanged(before.cost, payload.cost)) edits.push({ field: 'Cost', from: fmtMoneyForLog(before.cost), to: fmtMoneyForLog(payload.cost) });
              if (costFieldChanged(before.baselineCost, payload.baselineCost)) edits.push({ field: 'Baseline Cost', from: fmtMoneyForLog(before.baselineCost), to: fmtMoneyForLog(payload.baselineCost) });
              if (costFieldChanged(before.actualCost, payload.actualCost)) edits.push({ field: 'Actual Cost', from: fmtMoneyForLog(before.actualCost), to: fmtMoneyForLog(payload.actualCost) });

              payload.updatedAt = new Date();
              payload.updatedBy = userEmail || null;
              if (edits.length) {
                payload.changeLog = (before.changeLog || []).slice(-4);
                payload.changeLog.push({ changes: edits, changedAt: new Date(), changedBy: userEmail || 'Someone' });
              }

              ops.push(docRef.collection(collection).doc(existingMatch.id).update(payload));
              updatedCount++;
            } else if (existingInOther) {
              // Same WBS but its type flipped (e.g. Activity -> Milestone)
              // since the last import. Firestore can't move a document
              // between subcollections, so delete the old one and create
              // fresh in the right place.
              payload.createdAt = new Date();
              payload.createdBy = userEmail || null;
              payload.changeLog = [{
                changes: [{ field: collection === 'milestones' ? 'Reclassified as milestone' : 'Reclassified as activity', from: '—', to: title }],
                changedAt: new Date(),
                changedBy: userEmail || 'Someone'
              }];
              ops.push(docRef.collection(otherCollection).doc(existingInOther.id).delete());
              ops.push(docRef.collection(collection).add(payload));
              movedCount++;
            } else {
              payload.createdAt = new Date();
              payload.createdBy = userEmail || null;
              payload.changeLog = [{
                changes: [{ field: collection === 'milestones' ? 'Milestone created' : 'Activity created', from: '—', to: title }],
                changedAt: new Date(),
                changedBy: userEmail || 'Someone'
              }];
              ops.push(docRef.collection(collection).add(payload));
              createdCount++;
            }
          }

          if (!ops.length) {
            alert('No valid rows found — each row needs at least a Title and a Due Date.');
            return;
          }

          var bizDocRef = db.collection('businesses').doc(bizKey);

          return Promise.all(ops).then(function () {
            if (!boundsRow) return;
            // Kept as informational record on the business doc (from
            // the import file's own top-level summary row) — dates are
            // no longer used to filter what the Gantt shows (see the
            // note above withinYearFloor); cost/EAC/CPI/CV feed the
            // owner-only Cost Performance stat tile in burndown.js.
            var s = dateOnly(boundsRow.start);
            var e = dateOnly(boundsRow.due);

            // Also append a point-in-time snapshot (capped to the most
            // recent 50) so an EAC-over-time trend can be charted —
            // every field above this point only ever holds the LATEST
            // import's values, with no history of how EAC/CPI/Cost have
            // moved release over release.
            return bizDocRef.get().then(function (snap) {
              var existing = (snap.exists && snap.data() && snap.data().costSnapshots) || [];
              var snapshot = {
                date: new Date(),
                cost: boundsRow.cost,
                eac: boundsRow.eac,
                cpi: boundsRow.cpi,
                actualCost: boundsRow.actualCost,
                percentComplete: boundsRow.progressPct
              };
              var costSnapshots = existing.concat([snapshot]).slice(-50);

              return bizDocRef.set({
                projectStartDate: s,
                projectEndDate: e,
                projectPercentComplete: boundsRow.progressPct,
                projectCost: boundsRow.cost,
                projectEAC: boundsRow.eac,
                projectCPI: boundsRow.cpi,
                projectCV: boundsRow.cv,
                projectSV: boundsRow.sv,
                projectActualCost: boundsRow.actualCost,
                projectBaselineCost: boundsRow.baselineCost,
                costSnapshots: costSnapshots
              }, { merge: true });
            });
          }).then(function () {
            alert(
              'Import complete: ' + createdCount + ' created, ' + updatedCount + ' updated' +
              (movedCount ? ', ' + movedCount + ' reclassified' : '') + '.' +
              (boundsRow ? ' Project window set to ' + dfmt(boundsRow.start) + ' – ' + dfmt(boundsRow.due) + '.' : '') +
              ' Cost column read on ' + costFoundCount + ' of ' + (createdCount + updatedCount) + ' rows' +
              (idxCost >= 0 ? ' (found column "' + header[idxCost] + '").' : ' (no Cost column matched in the header — EVM chart will stay empty).') +
              (idxWbs === -1 ? ' Note: no WBS column was found, so every row was created as new rather than matched against existing entries.' : '')
            );
            input.value = '';
            render();
          });
        }).catch(function (err) {
          error('import failed', err);
          alert('Import failed: ' + (err && err.message ? err.message : err));
        });
      });
    });
  }

  // ---------- Duplicate-task detection/cleanup (owner-only) ----------
  // Scans both collections, groups documents that are almost certainly the
  // SAME real task — matched by WBS when present, or by title+due date as
  // a fallback for older records created before WBS-matching existed —
  // and reports what it found. Nothing is deleted until you see the exact
  // count and explicitly confirm; within each duplicate group, the most
  // recently updated (or created) copy is kept and the rest are removed.
  function wireDedup() {
    var btn = document.getElementById('dedupBtn');
    if (!btn) return;

    if (!isOwner) { btn.style.display = 'none'; return; }
    btn.style.display = '';
    if (btn.__wired) return;
    btn.__wired = true;

    btn.addEventListener('click', function () {
      btn.disabled = true;
      var milestonesQuery = db.collection('businesses').doc(bizKey).collection('milestones').get();
      var activitiesQuery = db.collection('businesses').doc(bizKey).collection('activities').get();

      Promise.all([milestonesQuery, activitiesQuery]).then(function (snaps) {
        var totalDocs = snaps[0].size + snaps[1].size;
        var groups = {};

        ['milestones', 'activities'].forEach(function (col, i) {
          snaps[i].forEach(function (doc) {
            var d = doc.data() || {};
            var key = col + '::' + (d.wbs
              ? 'wbs:' + String(d.wbs).trim()
              : 'td:' + (d.title || '').trim().toLowerCase() + '|' + fmtISO(dateOnly(toJsDate(d.dueDate) || new Date(0))));
            (groups[key] || (groups[key] = [])).push({ ref: doc.ref, data: d, id: doc.id, collection: col });
          });
        });

        var toDelete = [];
        var dupGroupCount = 0;
        Object.keys(groups).forEach(function (key) {
          var arr = groups[key];
          if (arr.length <= 1) return;
          dupGroupCount++;
          arr.sort(function (a, b) {
            var at = toJsDate(a.data.updatedAt) || toJsDate(a.data.createdAt) || new Date(0);
            var bt = toJsDate(b.data.updatedAt) || toJsDate(b.data.createdAt) || new Date(0);
            return bt - at; // newest first — kept copy is arr[0]
          });
          for (var i = 1; i < arr.length; i++) toDelete.push(arr[i]);
        });

        btn.disabled = false;

        if (!toDelete.length) {
          alert('No duplicates found.\n\nTotal documents: ' + totalDocs +
            ' (' + snaps[0].size + ' milestones, ' + snaps[1].size + ' activities).');
          return;
        }

        var confirmMsg = 'Found ' + dupGroupCount + ' duplicate group(s) — ' + toDelete.length +
          ' extra document(s) out of ' + totalDocs + ' total (' + snaps[0].size + ' milestones, ' + snaps[1].size + ' activities).\n\n' +
          'Deleting will permanently remove the ' + toDelete.length + ' older/duplicate copies, keeping the most ' +
          'recently updated one in each group. This cannot be undone.\n\nDelete them now?';
        if (!confirm(confirmMsg)) return;

        var ops = toDelete.map(function (item) { return item.ref.delete(); });
        Promise.all(ops).then(function () {
          alert('Removed ' + toDelete.length + ' duplicate document(s).');
        }).catch(function (err) {
          error('dedup delete failed', err);
          alert('Delete failed: ' + (err && err.message ? err.message : err));
        });
      }).catch(function (err) {
        btn.disabled = false;
        error('dedup scan failed', err);
        alert('Scan failed: ' + (err && err.message ? err.message : err));
      });
    });
  }

  // ---------- Firestore subscriptions ----------
  // includeMetadataChanges + the hasPendingWrites check below means our own
  // writes (e.g. a drag-to-reschedule) don't trigger a chart rebuild the
  // instant they're optimistically echoed back locally — that immediate
  // rebuild was tearing down the whole Gantt DOM mid-drag/right after drop,
  // which is what made dragging feel broken and the chart "jump." We still
  // re-render once the write is server-confirmed (hasPendingWrites: false),
  // and immediately for anything that originates elsewhere (another user,
  // an import, a mirror function).
  function subscribe() {
    db.collection('businesses').doc(bizKey).collection('milestones')
      .onSnapshot({ includeMetadataChanges: true }, function (snap) {
        if (snap.metadata.hasPendingWrites) return;
        milestoneDocs = snap.docs.map(function (d) { return { id: d.id, data: d.data() || {} }; });
        render();
      }, function (err) { error('milestones snapshot failed', err); });

    db.collection('businesses').doc(bizKey).collection('activities')
      .onSnapshot({ includeMetadataChanges: true }, function (snap) {
        if (snap.metadata.hasPendingWrites) return;
        activityDocs = snap.docs.map(function (d) { return { id: d.id, data: d.data() || {} }; });
        render();
      }, function (err) { error('activities snapshot failed', err); });
  }

  // ---------- Global time frame (from the sticky sidebar in burndown.js) ----------
  // burndown.js dispatches 'dr-timeframe-changed' whenever the sidebar
  // selection changes, so the Gantt's own zoom level tracks the same
  // choice as every metrics chart, without the two scripts sharing a JS
  // module — just this one DOM event as the contract between them.
  var TIMEFRAME_TO_GANTT_MODE = {
    week: 'Week',
    month: 'Month',
    '3month': '3 Months',
    '6month': '6 Months',
    year: 'Year',
    // Gantt has no "whole project as one view" mode of its own — Year is
    // the widest zoom it offers, so that's the closest equivalent.
    total: 'Year'
  };
  function wireGlobalTimeframe() {
    if (window.__drGanttTimeframeWired) return;
    window.__drGanttTimeframeWired = true;
    window.addEventListener('dr-timeframe-changed', function (e) {
      var unit = e && e.detail && e.detail.unit;
      var mode = TIMEFRAME_TO_GANTT_MODE[unit];
      if (!mode) return;
      var viewGroup = document.getElementById('ganttViewModeGroup');
      var btn = viewGroup && viewGroup.querySelector('.gantt-view-mode-btn[data-mode="' + mode + '"]');
      if (btn) btn.click();
    });
  }

  // ---------- Boot ----------
  function start() {
    db = window.db || null;
    auth = window.auth || null;
    container = document.getElementById('ganttChart');

    if (!db || !auth || !container) {
      setTimeout(start, 200);
      return;
    }
    if (!resolveBusinessContext()) {
      setTimeout(start, 300);
      return;
    }

    log('initialized', { bizKey: bizKey, email: userEmail, isOwner: isOwner });
    wireImport();
    wireDedup();
    wireGlobalTimeframe();

    // auth.currentUser above may not have resolved yet on a fresh page
    // load (Firebase Auth restores the session asynchronously) — if that
    // race left isOwner wrongly false, this catches the real value once it
    // resolves and re-renders as read-write instead of staying stuck
    // read-only for the rest of the session.
    auth.onAuthStateChanged(function (user) {
      var email = (user && user.email) || '';
      var wasOwner = isOwner;
      if (email) userEmail = email;
      if (user && user.uid) userUid = user.uid;
      isOwner = !!email && !!OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
      if (isOwner !== wasOwner) {
        log('owner status resolved/changed', { isOwner: isOwner });
        wireImport();
        wireDedup();
        render();
      }
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
