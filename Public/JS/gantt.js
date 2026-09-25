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
  var projKey = null;
  var userEmail = null;
  var userUid = null;
  var isOwner = false;

  var milestoneDocs = [];
  var activityDocs = [];
  var container = null;
  var wbsColumnEl = null;

  // WBS + Timeline combined view — a wbs-tree key -> true/false override,
  // set only once a row is actually clicked; every branch starts collapsed
  // by default (see isWbsRowCollapsed) until the user opens it.
  var collapseOverride = {};
  // The last WBS-ordered row list buildTasks() produced (task + depth +
  // hasChildren + collapsed + key per row) — buildTasks() itself only
  // returns the flat frappe task array (so the existing `var tasks =
  // buildTasks()` call site in render() needs no change); the WBS column
  // renderer reads this side channel to know how to draw the frozen
  // left-hand labels for exactly the rows frappe just drew.
  var lastWbsRows = [];

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

    // Multi-project cutover — every business always has at least the
    // auto-created 'default' project (dashboard-business-loader.js
    // guarantees window.PROJECT_KEY is set by the time this runs).
    projKey = window.PROJECT_KEY || projKey || 'default';

    var user = auth.currentUser;
    var email = (user && user.email) || userEmail || '';
    userEmail = email;
    userUid = (user && user.uid) || userUid;
    isOwner = !!email && !!OWNER_EMAIL && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
    return true;
  }

  // Multi-project cutover — every milestones/activities read or write in
  // this file goes through here rather than businesses/{bizKey} directly.
  function projRef() {
    return db.collection('businesses').doc(bizKey)
      .collection('projects').doc(projKey || 'default');
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

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  // ---------- WBS tree helpers (same logic the old standalone WBS Tree
  // card used — a node's parent is its own wbs string with the last
  // dot-segment removed; a node whose parent segment isn't itself present
  // becomes a root, adapting to whatever numbering convention the import
  // used) ----------
  function parentWbs(wbs) {
    var parts = String(wbs).split('.');
    if (parts.length <= 1) return null;
    return parts.slice(0, -1).join('.');
  }
  function wbsCompare(a, b) {
    var pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var va = pa[i] || 0, vb = pb[i] || 0;
      if (va !== vb) return va - vb;
    }
    return 0;
  }
  // Default (never-clicked) collapsed state: every branch starts
  // collapsed. Once a row has actually been clicked, its real state lives
  // in collapseOverride instead.
  function isWbsRowCollapsed(key, depth) {
    return Object.prototype.hasOwnProperty.call(collapseOverride, key) ? collapseOverride[key] : true;
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

  // Draws a thin dashed vertical "today" line directly into the Gantt's
  // own SVG grid, at the same x-coordinate Frappe would compute for a bar
  // starting today — so it stays correctly positioned across every view
  // mode (Day through Year) and pans naturally with horizontal scroll,
  // since it lives inside the same scrollable SVG as the bars themselves
  // rather than as a separately-positioned overlay element. Just the
  // dashed line itself (no flag/box) — explained in the legend note
  // instead, the same way the critical-path dashed outline is.
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
  }

  // ---------- Frozen WBS column ----------
  // Measures the ACTUAL rendered position of each bar (by data-id, not
  // DOM order — safer against any future frappe render-order change) and
  // sizes the WBS column's header spacer + per-row height to match
  // exactly, rather than hardcoding bar_height/padding math that would
  // silently drift if those constants ever change — same "measure the
  // real value, don't guess" approach this file already uses elsewhere
  // (availableWidth/fillWidthColumn, the bounds-correction block above).
  function measureRowLayout(tasksInOrder) {
    if (!container) return null;
    var containerRect = container.getBoundingClientRect();
    var tops = [];
    for (var i = 0; i < tasksInOrder.length && tops.length < 2; i++) {
      var el = container.querySelector('.bar-wrapper[data-id="' + tasksInOrder[i].id + '"]');
      if (el) tops.push(el.getBoundingClientRect().top - containerRect.top);
    }
    if (!tops.length) return null;
    return { headerHeight: tops[0], rowHeight: tops.length > 1 ? (tops[1] - tops[0]) : 24 };
  }

  function wbsToggleClick(e) {
    var btn = e.target.closest('.gantt-wbs-toggle');
    if (!btn) return;
    var key = btn.getAttribute('data-key');
    var depth = parseInt(btn.getAttribute('data-depth'), 10) || 0;
    collapseOverride[key] = !isWbsRowCollapsed(key, depth);
    render();
  }

  function renderWbsColumn(tasksInOrder) {
    if (!wbsColumnEl) return;
    var layout = measureRowLayout(tasksInOrder);
    if (!layout) { wbsColumnEl.innerHTML = ''; return; }

    // A real header, not a blank spacer — position:sticky within
    // wbsColumnEl's own real (native) vertical scroll, so it's guaranteed
    // by the browser to stay put while the rows scroll beneath it, the
    // same way Frappe's own date header on the right stays fixed during
    // vertical scroll (see wireWbsScrollSync — wbsColumnEl's scrollTop is
    // mirrored to/from .gantt-container's, its own scrollbar hidden via
    // CSS so only one scrollbar is ever visible).
    var headerHtml = '<div class="gantt-wbs-header" style="height:' + layout.headerHeight + 'px">' +
      '<div class="gantt-wbs-header-title">Tasks/Milestones</div>' +
      '<div class="gantt-wbs-header-subtitle">Click ▸/▾ to expand or collapse a WBS phase.</div>' +
      '<div class="gantt-wbs-header-legend">📝 Activity &nbsp; <em class="gantt-wbs-row-milestone">📌 Milestone</em></div>' +
      '</div>';

    var rowsHtml = lastWbsRows.map(function (r) {
      var t = r.task;
      var toggle = r.hasChildren
        ? '<button type="button" class="gantt-wbs-toggle" data-key="' + esc(r.key) + '" data-depth="' + r.depth + '" title="' + (r.collapsed ? 'Expand' : 'Collapse') + '">' + (r.collapsed ? '▸' : '▾') + '</button>'
        : '<span class="gantt-wbs-toggle-spacer"></span>';
      var indent = 8 + r.depth * 16;
      var rowClass = (t._isSummary ? ' gantt-wbs-row-summary' : '') + (t._isMilestone ? ' gantt-wbs-row-milestone' : '');
      return '<div class="gantt-wbs-row' + rowClass + '" style="height:' + layout.rowHeight + 'px" title="' + esc(t._title) + '">' +
        '<span class="gantt-wbs-indent" style="width:' + indent + 'px"></span>' +
        toggle +
        '<span class="gantt-wbs-dot" style="background:' + esc(t.color) + '"></span>' +
        (t._wbs ? '<span class="gantt-wbs-code">' + esc(t._wbs) + '</span>' : '') +
        '<span class="gantt-wbs-title">' + esc(t._title) + '</span>' +
        '</div>';
    }).join('');
    wbsColumnEl.innerHTML = headerHtml + rowsHtml;

    if (!wbsColumnEl.__wired) {
      wbsColumnEl.__wired = true;
      wbsColumnEl.addEventListener('click', wbsToggleClick);
    }
  }

  // Frappe's own .gantt-container owns the real (both-axis) scrollbar, so
  // its sticky date header keeps working natively — the WBS column just
  // mirrors that box's vertical scroll position onto its own rows via a
  // transform, the standard technique for a frozen column that lives in a
  // separate DOM box from the pane that actually scrolls. Re-wired every
  // render since Frappe rebuilds .gantt-container fresh each time
  // (container.innerHTML is wiped at the top of render()), so there is no
  // stale listener to guard against with a "wired once" flag here.
  function wireWbsScrollSync() {
    if (!container || !wbsColumnEl) return;
    var scrollEl = container.querySelector('.gantt-container');
    if (!scrollEl) return;
    // Real scrollTop mirroring (not a CSS transform) — wbsColumnEl is now a
    // genuine (native, if visually hidden) scroll container itself, so its
    // own position:sticky header is guaranteed by the browser to stay put,
    // rather than relying on a hand-computed offset. A guard flag stops
    // the two listeners from bouncing off each other.
    var syncing = false;
    function fromChart() { if (syncing) return; syncing = true; wbsColumnEl.scrollTop = scrollEl.scrollTop; syncing = false; }
    function fromWbs() { if (syncing) return; syncing = true; scrollEl.scrollTop = wbsColumnEl.scrollTop; syncing = false; }
    scrollEl.addEventListener('scroll', fromChart);
    wbsColumnEl.addEventListener('scroll', fromWbs);
    fromChart();
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

  // ---------- Build one Frappe task object per Firestore doc (unchanged
  // per-item logic, just extracted so it can be called from a WBS-tree
  // walk instead of a flat push loop) ----------
  function makeMilestoneTask(item) {
    var d = item.data;
    var due = toJsDate(d.dueDate);
    if (!due) return null; // nothing to place on the timeline without a date

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
    if (!withinYearFloor(start, end)) return null;

    var today = dateOnly(new Date());
    var occurred = due < today; // a past-dated milestone has "occurred", not "overdue"
    var progress = typeof d.progress === 'number' ? d.progress : (occurred ? 100 : 0);
    progress = Math.max(0, Math.min(100, progress));
    var mChangeLog = d.changeLog || [];
    var venue = d.status || d.location || '';
    if (venue === 'Other' && d.locationOther) venue += ': ' + d.locationOther;
    var title = d.title || 'Untitled milestone';

    return {
      id: 'milestone_' + item.id,
      name: (hasInvertedDates ? '⚠️ INVALID DATES: ' : '') + (mChangeLog.length ? '🔄 ' : '') + '📌 ' + title,
      start: fmtISO(start),
      end: fmtISO(end),
      progress: progress,
      color: ganttBarColor(d.startDate || d.createdAt, d.dueDate, occurred),
      custom_class: d.critical ? 'gantt-critical-task' : '',
      _collection: 'milestones',
      _docId: item.id,
      _changeLog: mChangeLog,
      _detailLabel: 'Venue',
      _detail: venue,
      _wbs: d.wbs ? String(d.wbs).trim() : '',
      _title: title,
      _isMilestone: true,
      _isSummary: false
    };
  }

  function makeActivityTask(item) {
    var d = item.data;
    var due = toJsDate(d.dueDate);
    if (!due) return null;

    due = dateOnly(due);
    var start = toJsDate(d.startDate);
    // Strictly AFTER due only — start === due is a legitimate 0-day
    // activity, not inverted data.
    var hasInvertedDates = !!start && dateOnly(start).getTime() > due.getTime();
    start = start ? dateOnly(start) : addDays(due, -3);
    if (start < GANTT_FLOOR_DATE) start = GANTT_FLOOR_DATE;
    var end = start.getTime() >= due.getTime() ? addDays(start, 1) : due;
    if (!withinYearFloor(start, end)) return null;

    var isCompleted = (d.status || '').toLowerCase() === 'completed';
    var progress = d.progress;
    if (typeof progress !== 'number') {
      var s = (d.status || '').toLowerCase();
      progress = isCompleted ? 100 : s === 'in progress' ? 50 : 0;
    }
    progress = Math.max(0, Math.min(100, progress));
    var aChangeLog = d.changeLog || [];
    var title = d.title || d.activity || 'Untitled activity';

    return {
      id: 'activity_' + item.id,
      name: (hasInvertedDates ? '⚠️ INVALID DATES: ' : '') + (aChangeLog.length ? '🔄 ' : '') + '📝 ' + title,
      start: fmtISO(start),
      end: fmtISO(end),
      progress: progress,
      color: ganttBarColor(d.startDate || d.createdAt, d.dueDate, isCompleted),
      custom_class: d.critical ? 'gantt-critical-task' : '',
      _collection: 'activities',
      _docId: item.id,
      _changeLog: aChangeLog,
      _detailLabel: 'Description',
      _detail: d.description || '',
      _wbs: d.wbs ? String(d.wbs).trim() : '',
      _title: title,
      _isMilestone: false,
      _isSummary: !!d.isSummary
    };
  }

  // ---------- WBS-ordered task list ----------
  // Groups every milestone/activity task into a WBS tree (same technique
  // the old standalone WBS Tree card used), walks it depth-first skipping
  // any collapsed branch, and returns the resulting flat array IN THAT
  // ORDER — frappe-gantt draws bars top-to-bottom in array order, so
  // controlling this array's order is what makes the timeline's row order
  // match the WBS hierarchy. A task with no usable wbs value becomes its
  // own root row (keyed by its own id) rather than being dropped — every
  // dated milestone/activity that showed up in the old flat Gantt must
  // still show up here.
  function buildTasks() {
    // Real imports can genuinely reuse the same WBS code for two different
    // rows (confirmed against this project's own data — an activity and a
    // milestone both stamped "1.1"). When that happens, whichever one
    // claims the key first wins the children that actually belong to the
    // real phase, and the other becomes its own (wrongly childless-or-
    // orphaned) row — so summary/phase activities are given first claim,
    // ahead of plain activities, ahead of milestones (a milestone is a
    // single point in time; it is essentially never the intended parent of
    // other tasks, so a collision there should never win the key).
    var summaryTasks = [], otherActivityTasks = [], milestoneTasks = [];
    activityDocs.forEach(function (item) {
      var t = makeActivityTask(item);
      if (!t) return;
      (t._isSummary ? summaryTasks : otherActivityTasks).push(t);
    });
    milestoneDocs.forEach(function (item) { var t = makeMilestoneTask(item); if (t) milestoneTasks.push(t); });
    var rawTasks = summaryTasks.concat(otherActivityTasks, milestoneTasks);

    var byKey = {};
    rawTasks.forEach(function (t) {
      var key = t._wbs || ('__no_wbs__' + t.id);
      while (byKey[key]) key = key + '_dup'; // collision guard (see above) — never drop a task
      byKey[key] = { task: t, children: [], key: key };
    });
    var roots = [];
    Object.keys(byKey).forEach(function (key) {
      var node = byKey[key];
      var parentKey = node.task._wbs ? parentWbs(node.task._wbs) : null;
      if (parentKey && byKey[parentKey]) byKey[parentKey].children.push(node);
      else roots.push(node);
    });
    function sortKeyOf(node) { return node.task._wbs || node.key; }
    function sortRec(node) {
      node.children.sort(function (a, b) { return wbsCompare(sortKeyOf(a), sortKeyOf(b)); });
      node.children.forEach(sortRec);
    }
    roots.sort(function (a, b) { return wbsCompare(sortKeyOf(a), sortKeyOf(b)); });
    roots.forEach(sortRec);

    var rows = [];
    function walk(node, depth) {
      var hasChildren = node.children.length > 0;
      var collapsed = hasChildren && isWbsRowCollapsed(node.key, depth);
      rows.push({ task: node.task, depth: depth, hasChildren: hasChildren, collapsed: collapsed, key: node.key });
      if (hasChildren && !collapsed) node.children.forEach(function (c) { walk(c, depth + 1); });
    }
    roots.forEach(function (r) { walk(r, 0); });

    lastWbsRows = rows;
    return rows.map(function (r) { return r.task; });
  }

  // ---------- Persist owner edits (with a visible change history) ----------
  function taskRef(task) {
    return projRef().collection(task._collection).doc(task._docId);
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
      ' · <span style="color:' + esc(task.color) + ';font-weight:700">' + task.progress + '% complete</span>' +
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
      if (wbsColumnEl) wbsColumnEl.innerHTML = '';
      if (window.drInsight) window.drInsight.set('ganttSection', '');
      return;
    }

    if (window.drInsight) {
      var todayIso = fmtISO(dateOnly(new Date()));
      var overdueTasks = tasks.filter(function (t) { return t.end < todayIso && t.progress < 100; });
      var criticalTasks = tasks.filter(function (t) { return t.custom_class === 'gantt-critical-task'; });
      var upcoming = tasks.filter(function (t) { return t.end >= todayIso; }).sort(function (a, b) { return a.end < b.end ? -1 : 1; })[0];
      // The single worst offender — most overdue, least progress — named
      // specifically so the reader has one concrete bar to go click on
      // instead of a bare count. changedTasks (🔄-marked) get first look
      // since "what changed" is usually the more useful click.
      var changedTasks = overdueTasks.filter(function (t) { return t.name.indexOf('🔄') !== -1; });
      var worst = (changedTasks.length ? changedTasks : overdueTasks).slice().sort(function (a, b) {
        return a.end < b.end ? -1 : (a.end > b.end ? 1 : a.progress - b.progress);
      })[0];

      var text = tasks.length + ' item' + (tasks.length === 1 ? '' : 's') + ' on the timeline';
      if (overdueTasks.length) {
        text += ', ' + overdueTasks.length + ' past due.';
      } else {
        text += ', none past due.';
      }
      if (criticalTasks.length) {
        text += ' ' + criticalTasks.length + ' flagged critical path.';
      }
      if (worst) {
        text += ' Click into "' + worst.name.replace(/^[^\w]*/, '') + '" (due ' + worst.end + ', ' + Math.round(worst.progress) + '% complete) to see what changed and why it slipped.';
      } else if (upcoming) {
        text += ' Next up: ' + upcoming.name.replace(/^[^\w]*/, '') + ' (due ' + upcoming.end + ').';
      }
      window.drInsight.set('ganttSection', text);
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
    // Reset here too (not just where it's populated below) so a render
    // that skips the correction step entirely doesn't leave a stale
    // second line from a previous render still showing.
    var boundsNoteGridElReset = document.getElementById('ganttBoundsNoteGrid');
    if (boundsNoteGridElReset) boundsNoteGridElReset.textContent = '';

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

        // Widen the corrected range to always include today, even if every
        // imported task's dates fall entirely before or after it (e.g. the
        // schedule's last milestone already occurred, or nothing has
        // started yet). Without this, drawTodayLine()'s own
        // today < gantt_start || today > gantt_end guard silently drops
        // the yellow "Today" marker any time the real task data doesn't
        // happen to straddle today's date — exactly the case for a
        // project whose latest imported milestone is already in the past.
        var todayFloor = startOfUnit(new Date(), unit);
        var todayCeil = endOfUnitExclusive(new Date(), unit);
        if (correctedStart > todayFloor) correctedStart = todayFloor;
        if (correctedEnd < todayCeil) correctedEnd = todayCeil;

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
        // directly on the page without devtools. Its own second footer
        // line (centered, underneath the first), not appended onto the
        // "Showing ..." line.
        var boundsNoteGridEl = document.getElementById('ganttBoundsNoteGrid');
        if (boundsNoteGridEl) {
          boundsNoteGridEl.textContent = 'grid: ' +
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
            boundsNoteGridEl.textContent += ' | dates[]: ' +
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
      renderWbsColumn(tasks);
      wireWbsScrollSync();

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

      // Up/down/left/right page-scroll buttons — same "outside this
      // container, survives the innerHTML wipe, wire once" reasoning as
      // the view-mode buttons above. The scroll target itself
      // (.gantt-container) IS recreated on every render, so that's
      // looked up fresh inside each click handler rather than cached.
      var pageUpBtn = document.getElementById('ganttPageUp');
      var pageDownBtn = document.getElementById('ganttPageDown');
      var pageLeftBtn = document.getElementById('ganttPageLeft');
      var pageRightBtn = document.getElementById('ganttPageRight');
      function scrollGanttByPage(axis, direction) {
        var scrollEl = container.querySelector('.gantt-container');
        if (!scrollEl) return;
        // A smaller step per click (was 90% of the viewport, nearly a
        // full page — too large a jump per click) so each press moves a
        // controlled, readable amount instead.
        var size = (axis === 'x' ? scrollEl.clientWidth : scrollEl.clientHeight) * 0.25;
        var opts = { behavior: 'smooth' };
        opts[axis === 'x' ? 'left' : 'top'] = direction * size;
        scrollEl.scrollBy(opts);
      }
      if (pageUpBtn && !pageUpBtn.__ganttWired) {
        pageUpBtn.__ganttWired = true;
        pageUpBtn.addEventListener('click', function () { scrollGanttByPage('y', -1); });
      }
      if (pageDownBtn && !pageDownBtn.__ganttWired) {
        pageDownBtn.__ganttWired = true;
        pageDownBtn.addEventListener('click', function () { scrollGanttByPage('y', 1); });
      }
      if (pageLeftBtn && !pageLeftBtn.__ganttWired) {
        pageLeftBtn.__ganttWired = true;
        pageLeftBtn.addEventListener('click', function () { scrollGanttByPage('x', -1); });
      }
      if (pageRightBtn && !pageRightBtn.__ganttWired) {
        pageRightBtn.__ganttWired = true;
        pageRightBtn.addEventListener('click', function () { scrollGanttByPage('x', 1); });
      }
    } catch (e) {
      error('render failed', e);
    }
  }

  // ---------- Predecessors cell parser (for the Dependencies card) ----------
  // MS Project writes a row's predecessors as task IDs with an optional link
  // type and lag: "5", "5FS", "5SS+2 days", "8FF-1d", separated by "," or ";".
  // Returns [{ id, relationship, lag }] — relationship defaults to
  // Finish-to-Start (MS Project's own default); lag is the raw "+2 days" text
  // ('' when none). Tokens that don't parse are ignored.
  var LINK_TYPES = { FS: 'Finish-to-Start', SS: 'Start-to-Start', FF: 'Finish-to-Finish', SF: 'Start-to-Finish' };
  function parsePredecessors(cell) {
    var out = [];
    String(cell == null ? '' : cell).split(/[;,]/).forEach(function (token) {
      var m = /^\s*(\d+)\s*(FS|SS|FF|SF)?\s*([+-]\s*[\d.]+\s*[a-z%]*)?\s*$/i.exec(token);
      if (!m) return;
      out.push({
        id: m[1],
        relationship: LINK_TYPES[(m[2] || 'FS').toUpperCase()],
        lag: (m[3] || '').replace(/\s+/g, ' ').replace(/^([+-])\s/, '$1').trim()
      });
    });
    return out;
  }

  // Turns the file's predecessor links into Firestore writes for the
  // Dependencies card. Pure (no Firestore access) so it can be tested alone.
  //   candidates: [{ taskId, preds }]   scheduleTasks: { fileId: { wbs, title, startDate, dueDate, isSummary, responsible } }
  //   byWbs: { wbs: 'activity:<docId>' | 'milestone:<docId>' }   existing: { depDocId: data }
  // A new link gets defaults (status Open, owner = the predecessor's
  // resource, need-by = the successor's start); an existing one only has the
  // schedule-owned fields refreshed, so nothing a person typed is lost.
  function planScheduleDependencies(candidates, scheduleTasks, byWbs, existing, who) {
    var writes = [], seen = {}, created = 0, updated = 0, skipped = 0;
    candidates.forEach(function (c) {
      var succ = scheduleTasks[c.taskId];
      parsePredecessors(c.preds).forEach(function (p) {
        var pred = scheduleTasks[p.id];
        if (!succ || !pred || !succ.wbs || !pred.wbs || succ.isSummary || pred.isSummary ||
            !byWbs[succ.wbs] || !byWbs[pred.wbs]) { skipped++; return; }
        var depId = ('sched_' + pred.wbs + '__' + succ.wbs).replace(/\//g, '_');
        if (seen[depId]) return;
        seen[depId] = true;
        var fields = {
          title: pred.title + ' → ' + succ.title,
          predecessorId: byWbs[pred.wbs], predecessorTitle: pred.title,
          successorId: byWbs[succ.wbs], successorTitle: succ.title,
          relationship: p.relationship, lag: p.lag,
          source: 'schedule', scheduleSyncedAt: new Date()
        };
        var needBy = succ.startDate || succ.dueDate || null;
        if (existing[depId]) {
          if (!existing[depId].needByEdited) fields.needByDate = needBy;
          writes.push({ id: depId, data: fields, isNew: false });
          updated++;
        } else {
          fields.dependencyType = 'Task / Milestone';
          fields.status = 'Open';
          fields.owner = pred.responsible || '';
          fields.needByDate = needBy;
          fields.impact = '';
          fields.linkedRiskId = '';
          fields.linkedRiskTitle = '';
          fields.createdAt = new Date();
          fields.createdBy = (who && who.email) || null;
          fields.createdByUid = (who && who.uid) || null;
          writes.push({ id: depId, data: fields, isNew: true });
          created++;
        }
      });
    });
    return { writes: writes, created: created, updated: updated, skipped: skipped };
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
      if (window.drProgress) window.drProgress.show('Importing schedule…');

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
        var idxOutline = colIndex(['outline_level', 'outline level', 'outlinelevel', 'wbs level', 'outline', 'level']);
        var idxResource = colIndex(['resource_names', 'resource names', 'resources', 'responsible']);
        var idxWbs = colIndex(['wbs']);
        var idxDuration = colIndex(['duration']);
        // Cost-performance fields — captured from the top-level (Outline
        // Level 0) summary row only, for the owner-only Cost Performance
        // stat tile. MS Project computes EAC/CPI/CV itself; we don't
        // recompute those, only derive AC = EV / CPI and ETC = EAC - AC
        // from them (see renderCostPerformance in burndown.js).
        var idxCost = colIndex(['cost', 'total cost', 'cost ($)']);
        var idxEac = colIndex(['eac', 'estimate at completion', 'eac (estimate at completion)']);
        var idxCpi = colIndex(['cpi', 'cost performance index', 'cpi (cost performance index)']);
        var idxCv = colIndex(['cv', 'cost variance', 'cv (cost variance)']);
        var idxSv = colIndex(['sv', 'schedule variance', 'sv (schedule variance)']);
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
        // Total Slack (float) — how many days a task can slip before it
        // delays the project finish. Feeds the Critical Path card's "how
        // critical" column; a task can be Critical=Yes with 0 slack, or
        // this can be missing entirely (older exports) and the card just
        // shows the Yes/No flag alone.
        var idxSlack = colIndex(['total slack', 'total_slack', 'slack (days)', 'slack']);
        // Task links — MS Project's "Predecessors" column lists the task IDs
        // (the "ID" column, NOT Unique ID) each row waits on, e.g.
        // "5FS+2 days,8". Used to seed the Dependencies card (see
        // syncScheduleDependencies below).
        var idxTaskId = colIndex(['id', 'task id', 'task_id']);
        var idxPred = colIndex(['predecessors', 'predecessor']);

        if (idxTitle === -1 || idxDue === -1) {
          alert('Excel sheet must have at least Title and Due Date columns.');
          return;
        }

        log('column mapping', {
          title: header[idxTitle], due: header[idxDue],
          cost: idxCost >= 0 ? header[idxCost] : '(not found)',
          baselineCost: idxBaselineCost >= 0 ? header[idxBaselineCost] : '(not found)',
          actualCost: idxActualCost >= 0 ? header[idxActualCost] : '(not found)',
          outlineLevel: idxOutline >= 0 ? header[idxOutline] : '(not found)',
          eac: idxEac >= 0 ? header[idxEac] : '(not found)',
          cpi: idxCpi >= 0 ? header[idxCpi] : '(not found)',
          cv: idxCv >= 0 ? header[idxCv] : '(not found)',
          sv: idxSv >= 0 ? header[idxSv] : '(not found)',
          totalSlack: idxSlack >= 0 ? header[idxSlack] : '(not found)'
        });
        // The single gate for Cost Performance Index and the Cash Flow
        // stat row — both read from the Outline-Level-0 "whole project"
        // summary row's own Cost/EAC/CPI columns (see boundsRow below),
        // not from any per-task row. Without this column matched, neither
        // can ever update no matter what the individual Cost/EAC/CPI
        // columns say, which reads very confusingly as "the data's right
        // there in the file but nothing changes" — so call it out loudly
        // here rather than leaving it to be inferred from two separately-
        // empty cards.
        if (idxOutline === -1) {
          warn('No Outline Level column matched — Cost Performance Index and the Cash Flow stat row will NOT update from this import. Rename the column to "Outline Level" (or similar) and re-import.');
        } else if (idxEac === -1 || idxCpi === -1) {
          warn('Outline Level column found, but ' + (idxEac === -1 ? 'EAC' : '') + (idxEac === -1 && idxCpi === -1 ? ' and ' : '') + (idxCpi === -1 ? 'CPI' : '') +
            ' not matched — Cost Performance Index will show incomplete data even if the summary row itself was found.');
        }
        if (idxSlack === -1) {
          warn('No Total Slack column matched — the Critical Path card will show the Critical Yes/No flag only, with no slack (days) figure. Add a "Total Slack" column and re-import to include it.');
        }

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
        var milestonesQuery = projRef().collection('milestones').get();
        var activitiesQuery = projRef().collection('activities').get();

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
          // For the Dependencies card: every imported task by its file ID,
          // and each row's raw Predecessors cell.
          var scheduleTasks = {};
          var depCandidates = [];
          var depMessage = '';

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
            var startDate = idxStart >= 0 ? parseCell(row[idxStart]) : null;
            // A milestone is a zero-duration event — Start and Finish are
            // meant to be the same day. If the source file's Start was
            // edited but Finish wasn't (or vice versa, e.g. a hand edit
            // that only touched one column), Start is the field that
            // actually carries the intended milestone date, so it wins.
            if (isMilestone && startDate) dueDate = startDate;
            if (!dueDate) continue;

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
                // The whole project's OWN baseline Start/Finish — distinct
                // from startDate/dueDate above (the CURRENT schedule, which
                // drifts as the plan changes). Forecast Finish Date needs
                // the original planned window, same reasoning as BAC
                // needing baselineCost rather than the current Cost.
                var rowBaselineStartTop = idxBaselineStart >= 0 ? parseCell(row[idxBaselineStart]) : null;
                var rowBaselineFinishTop = idxBaselineFinish >= 0 ? parseCell(row[idxBaselineFinish]) : null;
                boundsRow = {
                  level: level, start: startDate, due: dueDate,
                  baselineStart: rowBaselineStartTop, baselineFinish: rowBaselineFinishTop,
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

            // A "summary" WBS row (e.g. "1.0 Project Management") already
            // rolls up every one of its own children's Cost/Duration/
            // Progress — that's how MS Project computes it. Importing it
            // as a peer alongside those same children, with nothing to
            // tell them apart, meant every cost/task-count aggregate
            // across the dashboard (BAC, EVM, Burndown/Burnup/Velocity
            // task counts, Health Scorecard, etc.) summed the same
            // underlying work multiple times over — once at each WBS
            // level above a leaf task, plus once for the leaf itself.
            // Detected here: a row is a summary if the very next row in
            // the file sits at a DEEPER Outline_Level — the standard
            // depth-first ordering every MS Project export uses — and
            // carried through so burndown.js can exclude these rows from
            // every aggregate instead of over-counting.
            var isSummaryRow = false;
            if (idxOutline >= 0) {
              var thisOutlineLevel = row[idxOutline] != null && row[idxOutline] !== '' ? Number(row[idxOutline]) : null;
              var nextRawRow = rows[r + 1];
              var nextOutlineLevel = (nextRawRow && nextRawRow[idxOutline] != null && nextRawRow[idxOutline] !== '') ? Number(nextRawRow[idxOutline]) : null;
              if (thisOutlineLevel != null && nextOutlineLevel != null && nextOutlineLevel > thisOutlineLevel) isSummaryRow = true;
            } else if (idxWbs >= 0) {
              // No Outline Level column (e.g. a plain WBS export): a row is a
              // summary if the next row's WBS is nested under it ("1" then
              // "1.1"), or it is the project root ("0"). Keeps summary rows
              // out of the task/cost aggregates just like the Outline case.
              var thisWbsKey = row[idxWbs] != null ? String(row[idxWbs]).trim() : '';
              var nextRawWbs = rows[r + 1];
              var nextWbsKey = (nextRawWbs && nextRawWbs[idxWbs] != null) ? String(nextRawWbs[idxWbs]).trim() : '';
              if (thisWbsKey && nextWbsKey && (nextWbsKey.indexOf(thisWbsKey + '.') === 0 || (thisWbsKey === '0' && nextWbsKey !== '0'))) isSummaryRow = true;
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
            var rowSlackVal = idxSlack >= 0 ? parseFloat(row[idxSlack]) : NaN;

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
              critical: idxCritical >= 0 && String(row[idxCritical] || '').trim().toLowerCase() === 'yes',
              totalSlack: isNaN(rowSlackVal) ? null : rowSlackVal,
              isSummary: isSummaryRow
            };

            if (collection === 'activities') {
              payload.status = progress >= 100 ? 'Completed' : (progress > 0 ? 'In Progress' : 'Not Started');
              if (idxResource >= 0 && row[idxResource] != null) {
                payload.responsible = String(row[idxResource]).trim();
              }
            } else {
              payload.status = 'On-site';
            }

            var taskFileId = (idxTaskId >= 0 && row[idxTaskId] != null) ? String(row[idxTaskId]).trim() : '';
            if (taskFileId) {
              scheduleTasks[taskFileId] = {
                wbs: wbs, title: title, startDate: startDate, dueDate: dueDate,
                isSummary: isSummaryRow, responsible: payload.responsible || ''
              };
            }
            if (idxPred >= 0 && taskFileId && row[idxPred] != null && String(row[idxPred]).trim()) {
              depCandidates.push({ taskId: taskFileId, preds: String(row[idxPred]) });
            }

            var existingMatch = wbs ? existingByWbs[collection][wbs] : null;
            var existingInOther = wbs ? existingByWbs[otherCollection][wbs] : null;
            var docRef = projRef();

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

          // These rollups (project dates, EAC/CPI/CV/SV, baseline/actual cost, cost snapshots) belong to THIS
          // project — never the shared company document, which every project in the company would read.
          var bizDocRef = projRef();

          // Task links -> Dependencies card. Runs once every task write above
          // has landed (so each task's Firestore id exists), and never fails
          // the schedule import: a problem here just adds a note to the
          // completion message.
          function syncScheduleDependencies() {
            if (idxPred === -1) return Promise.resolve('');
            if (idxTaskId === -1) return Promise.resolve(' A Predecessors column was found, but there is no "ID" column, so no dependencies were created (add the ID column to the export).');
            if (idxWbs === -1) return Promise.resolve(' A Predecessors column was found, but there is no WBS column, so no dependencies were created.');
            if (!depCandidates.length) return Promise.resolve(' No predecessor links were found in the Predecessors column.');

            var depCol = projRef().collection('dependencies');
            return Promise.all([
              projRef().collection('milestones').get(),
              projRef().collection('activities').get(),
              depCol.get()
            ]).then(function (res) {
              var byWbs = {};
              [['milestone', res[0]], ['activity', res[1]]].forEach(function (pair) {
                pair[1].forEach(function (d) {
                  var w = (d.data() || {}).wbs;
                  if (w) byWbs[String(w).trim()] = pair[0] + ':' + d.id;
                });
              });
              var existing = {};
              res[2].forEach(function (d) { existing[d.id] = d.data() || {}; });

              var plan = planScheduleDependencies(depCandidates, scheduleTasks, byWbs, existing,
                { email: userEmail, uid: userUid });
              var writes = plan.writes;
              var created = plan.created, updated = plan.updated, skipped = plan.skipped;

              // Firestore batches hold at most 500 writes.
              var chunks = [];
              for (var i = 0; i < writes.length; i += 400) chunks.push(writes.slice(i, i + 400));
              return chunks.reduce(function (chain, chunk) {
                return chain.then(function () {
                  var batch = db.batch();
                  chunk.forEach(function (w) {
                    var ref = depCol.doc(w.id);
                    if (w.isNew) batch.set(ref, w.data); else batch.update(ref, w.data);
                  });
                  return batch.commit();
                });
              }, Promise.resolve()).then(function () {
                return ' Dependencies: ' + created + ' created, ' + updated + ' updated' +
                  (skipped ? ', ' + skipped + ' link(s) skipped (a task wasn\'t imported or is a summary row)' : '') + '.';
              });
            });
          }

          return Promise.all(ops).then(function () {
            return syncScheduleDependencies().then(function (msg) {
              depMessage = msg;
            }, function (err) {
              error('dependency sync failed', err);
              depMessage = ' Dependencies could not be created from this file (' + (err && err.message ? err.message : err) + ').';
            });
          }).then(function () {
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
                // The ORIGINAL planned window (Baseline Start/Finish on the
                // top-level summary row), distinct from projectStartDate/
                // projectEndDate above (the CURRENT schedule, which drifts
                // as the plan changes) — Forecast Finish Date needs this to
                // compare "where we'll actually land" against "where the
                // plan originally said," same reasoning as BAC needing
                // baselineCost rather than the current Cost. Null when the
                // import has no Baseline_Start/Baseline_Finish columns.
                projectBaselineStartDate: boundsRow.baselineStart ? dateOnly(boundsRow.baselineStart) : null,
                projectBaselineEndDate: boundsRow.baselineFinish ? dateOnly(boundsRow.baselineFinish) : null,
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
              (idxWbs === -1 ? ' Note: no WBS column was found, so every row was created as new rather than matched against existing entries.' : '') +
              depMessage
            );
            input.value = '';
            render();
          });
        }).catch(function (err) {
          error('import failed', err);
          alert('Import failed: ' + (err && err.message ? err.message : err));
        }).finally(function () {
          if (window.drProgress) window.drProgress.hide();
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
      var milestonesQuery = projRef().collection('milestones').get();
      var activitiesQuery = projRef().collection('activities').get();

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
    projRef().collection('milestones')
      .onSnapshot({ includeMetadataChanges: true }, function (snap) {
        if (snap.metadata.hasPendingWrites) return;
        milestoneDocs = snap.docs.map(function (d) { return { id: d.id, data: d.data() || {} }; });
        render();
      }, function (err) { error('milestones snapshot failed', err); });

    projRef().collection('activities')
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
    wbsColumnEl = document.getElementById('ganttWbsColumn');

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
