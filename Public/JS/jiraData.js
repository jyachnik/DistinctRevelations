/* ============================================================================
   Jira data layer — ONE Firestore listener on projects/{proj}/jiraIssues
   and ONE set of sample issues, shared by every Jira-sourced card
   (Backlog Tracker, Kanban, Sprint Burndown, Velocity, Epic Progress,
   Blocked Issues, Team Workload). Without this, each card would run its
   own listener against the same collection and keep its own copy of the
   sample data — six+ cards all duplicating both, with real risk of the
   sample sets quietly drifting apart from each other. Loaded before any
   card that uses window.drJiraData (see dashboard.html's loadScript order).

   Real version (not built yet): a scheduled Cloud Function polls the
   Jira REST API (same pattern as the existing daily overdue-task digest)
   and writes normalized issues here via the Admin SDK. The moment that
   collection has documents, every subscribed card gets real data on its
   next render — nothing else changes.
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[jiraData]';
  var subscribers = [];
  var state = { issues: [], usingSample: true, ready: false };

  // Sample issues — the single source every Jira card falls back to until
  // a real sync exists. ids start with "sample-"; nothing in this app
  // ever writes to jiraIssues from the client (see firestore.rules), so
  // there's no action to refuse them from — the prefix is just so a card
  // can label itself "sample data" without a separate flag per row.
  var SAMPLE_ISSUES = [
    { id: 'sample-1', key: 'PWR-101', summary: 'Define MVP scope for Phase I rollout', type: 'Epic', status: 'In Progress', priority: 'High', assignee: 'J. Alvarez', storyPoints: null, sprint: '—', dueDate: new Date(2026, 10, 14) },
    { id: 'sample-2', key: 'PWR-102', summary: 'Integrate GPS feed with asset tracking service', type: 'Story', status: 'In Progress', priority: 'High', assignee: 'M. Chen', storyPoints: 8, sprint: 'Sprint 14', dueDate: new Date(2026, 9, 24) },
    { id: 'sample-3', key: 'PWR-103', summary: 'Set up email notification service', type: 'Story', status: 'Done', priority: 'Medium', assignee: 'S. Patel', storyPoints: 5, sprint: 'Sprint 13', dueDate: new Date(2026, 9, 10) },
    { id: 'sample-4', key: 'PWR-104', summary: 'Fix null pointer on empty asset list', type: 'Bug', status: 'To Do', priority: 'Highest', assignee: 'M. Chen', storyPoints: 2, sprint: 'Sprint 14', dueDate: new Date(2026, 9, 22) },
    { id: 'sample-5', key: 'PWR-105', summary: 'Design security dashboard wireframes', type: 'Task', status: 'Done', priority: 'Medium', assignee: 'R. Nolan', storyPoints: 3, sprint: 'Sprint 13', dueDate: new Date(2026, 9, 8) },
    { id: 'sample-6', key: 'PWR-106', summary: 'Underestimated integration time with third-party GPS vendor', type: 'Bug', status: 'In Review', priority: 'Highest', assignee: 'J. Alvarez', storyPoints: 5, sprint: 'Sprint 14', dueDate: new Date(2026, 9, 25) },
    { id: 'sample-7', key: 'PWR-107', summary: 'Build resource-capacity API endpoint', type: 'Story', status: 'In Progress', priority: 'Medium', assignee: 'S. Patel', storyPoints: 5, sprint: 'Sprint 14', dueDate: new Date(2026, 9, 27) },
    { id: 'sample-8', key: 'PWR-108', summary: 'Write UAT test cases for asset tracking', type: 'Task', status: 'To Do', priority: 'Medium', assignee: 'R. Nolan', storyPoints: 3, sprint: 'Sprint 15', dueDate: new Date(2026, 10, 3) },
    { id: 'sample-9', key: 'PWR-109', summary: 'Specialized AI/security resource availability', type: 'Epic', status: 'To Do', priority: 'High', assignee: 'J. Alvarez', storyPoints: null, sprint: '—', dueDate: new Date(2026, 11, 1) },
    { id: 'sample-10', key: 'PWR-110', summary: 'Reduce dashboard initial load time', type: 'Task', status: 'To Do', priority: 'Low', assignee: 'M. Chen', storyPoints: 2, sprint: 'Sprint 15', dueDate: new Date(2026, 10, 5) },
    { id: 'sample-11', key: 'PWR-111', summary: 'Login session expires too early on mobile', type: 'Bug', status: 'Done', priority: 'Medium', assignee: 'S. Patel', storyPoints: 1, sprint: 'Sprint 13', dueDate: new Date(2026, 9, 9) },
    { id: 'sample-12', key: 'PWR-112', summary: 'Vendor integration deadline for Phase I MVP', type: 'Story', status: 'In Review', priority: 'High', assignee: 'R. Nolan', storyPoints: 8, sprint: 'Sprint 14', dueDate: new Date(2026, 9, 26) }
  ];

  function notify() {
    subscribers.forEach(function (cb) {
      try { cb(state); } catch (e) { console.error(ns, 'subscriber threw', e); }
    });
  }

  function getDB() {
    return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore());
  }
  function issuesRef(biz, proj) {
    var db = getDB();
    if (!db || !biz) return null;
    return db.collection('businesses').doc(biz).collection('projects').doc(proj || 'default').collection('jiraIssues');
  }

  function start() {
    var biz = window.BIZ_KEY || window.businessKey || null;
    var proj = window.PROJECT_KEY || 'default';
    var ref = issuesRef(biz, proj);
    if (!ref) { state.ready = true; notify(); return; }

    ref.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      state.issues = rows.length ? rows : SAMPLE_ISSUES;
      state.usingSample = !rows.length;
      state.ready = true;
      notify();
    }, function (err) {
      console.warn(ns, 'listen error (expected if not a project member, or no Jira sync yet)', err && err.code);
      state.issues = SAMPLE_ISSUES;
      state.usingSample = true;
      state.ready = true;
      notify();
    });
  }

  window.drJiraData = {
    // cb(state) fires immediately with the current state, then again on
    // every change. Returns an unsubscribe function.
    subscribe: function (cb) {
      subscribers.push(cb);
      if (state.ready) cb(state);
      return function unsubscribe() {
        var i = subscribers.indexOf(cb);
        if (i !== -1) subscribers.splice(i, 1);
      };
    },
    getState: function () { return state; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
