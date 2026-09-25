/* ============================================================================
   Org Chart — a visual reporting-lines tree built from Team Directory's own
   roster (name/role/department + the reportsTo field added there this
   session). Read-only, no writes, no new collection — the SAME
   teamDirectory subcollection Team Directory already owns; this card only
   ever reads it.

   Roots = members with no reportsTo (or one pointing at someone who no
   longer exists). A cycle guard (A reports to B who reports to A — bad
   data, but not impossible once it's owner-hand-edited) stops recursion by
   tracking the current path, rather than hanging the page.

   Firestore: businesses/{biz}/projects/{proj}/teamDirectory  (read-only here)
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[org-chart]';
  var ctx = { biz: null, proj: null, isOwner: false, rows: [], userEmail: '', userUid: '' };
  var card, treeEl, addForm, addReportsToSel;

  function canWrite() { return ctx.isOwner; }

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function teamRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default').collection('teamDirectory');
  }

  function personBoxHtml(r) {
    return '<div class="oc-box"><div class="oc-name">' + esc(r.name || 'Unnamed') + '</div>' +
      (r.role ? '<div class="oc-role">' + esc(r.role) + '</div>' : '') +
      (r.department ? '<div class="oc-dept">' + esc(r.department) + '</div>' : '') + '</div>';
  }

  function renderNode(r, byManager, path) {
    var children = byManager[r.id] || [];
    var nextPath = path.concat([r.id]);
    var childrenHtml = children
      .filter(function (c) { return path.indexOf(c.id) === -1; }) // cycle guard
      .map(function (c) { return renderNode(c, byManager, nextPath); }).join('');
    return '<li>' + personBoxHtml(r) + (childrenHtml ? '<ul class="oc-children">' + childrenHtml + '</ul>' : '') + '</li>';
  }

  function render() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('orgChartCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (addForm) addForm.hidden = !canWrite();
    populateAddReportsToSelect();
    if (!canView || !treeEl) return;

    var empty = document.getElementById('ocEmpty');
    if (!ctx.rows.length) {
      treeEl.hidden = true;
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    treeEl.hidden = false;

    // Shrinks box size/spacing as the roster grows, so a bigger team stays
    // readable within the card rather than just growing wider and wider —
    // recomputed every render, so it adjusts automatically as people are
    // added or removed (see .oc-compact/.oc-compact-2 in metrics.css).
    var count = ctx.rows.length;
    treeEl.classList.toggle('oc-compact', count > 12);
    treeEl.classList.toggle('oc-compact-2', count > 24);

    var byId = {};
    ctx.rows.forEach(function (r) { byId[r.id] = r; });
    var byManager = {};
    ctx.rows.forEach(function (r) {
      var mgr = r.reportsTo && byId[r.reportsTo] ? r.reportsTo : null;
      if (mgr) { (byManager[mgr] = byManager[mgr] || []).push(r); }
    });
    var roots = ctx.rows.filter(function (r) { return !(r.reportsTo && byId[r.reportsTo]); })
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

    treeEl.innerHTML = '<ul class="oc-root">' + roots.map(function (r) { return renderNode(r, byManager, []); }).join('') + '</ul>';

    if (window.drInsight) {
      var withManager = ctx.rows.length - roots.length;
      window.drInsight.set('orgChartCard', ctx.rows.length + ' team member' + (ctx.rows.length === 1 ? '' : 's') + ', ' + roots.length + ' at the top of the chart, ' + withManager + ' reporting to someone.');
    }
  }

  // Rebuilt from the current roster every render — same "Reports To" list
  // Team Directory's own form uses, so a level added here can immediately
  // become a manager for the next one added right after.
  function populateAddReportsToSelect() {
    if (!addReportsToSel) return;
    var keep = addReportsToSel.value;
    var candidates = ctx.rows.slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    addReportsToSel.innerHTML = '<option value="">Reports to: none (top level)</option>' +
      candidates.map(function (r) { return '<option value="' + esc(r.id) + '">' + esc(r.name) + (r.role ? (' — ' + esc(r.role)) : '') + '</option>'; }).join('');
    addReportsToSel.value = candidates.some(function (r) { return r.id === keep; }) ? keep : '';
  }

  function wireAddForm() {
    addForm = document.getElementById('ocAddForm');
    addReportsToSel = document.getElementById('ocAddReportsTo');
    if (!addForm || addForm.__wired) return;
    addForm.__wired = true;
    addForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!canWrite()) return;
      var ref = teamRef();
      if (!ref) return;
      var nameEl = document.getElementById('ocAddName');
      var roleEl = document.getElementById('ocAddRole');
      var deptEl = document.getElementById('ocAddDept');
      var name = nameEl ? nameEl.value.trim() : '';
      if (!name) return;
      var reportsToId = addReportsToSel ? addReportsToSel.value : '';
      var reportsToRow = reportsToId ? ctx.rows.find(function (r) { return r.id === reportsToId; }) : null;

      var ts = (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue &&
        window.firebase.firestore.FieldValue.serverTimestamp && window.firebase.firestore.FieldValue.serverTimestamp()) || new Date();

      ref.add({
        name: name,
        role: roleEl ? roleEl.value.trim() : '',
        department: deptEl ? deptEl.value.trim() : '',
        reportsTo: reportsToId, reportsToName: reportsToRow ? reportsToRow.name : '',
        email: '', phone: '', notes: '',
        version: 1, versions: [],
        createdAt: ts, createdBy: ctx.userEmail || '', createdByUid: ctx.userUid || ''
      }).then(function () {
        addForm.reset();
      }).catch(function (err) {
        console.error(ns, 'add person error', err);
        alert('Could not save — please try again: ' + (err && err.message ? err.message : err));
      });
    });
  }

  function listenTeam() {
    var ref = teamRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.rows = rows;
      render();
    }, function (err) { console.warn(ns, 'listen error (expected if not granted view access)', err && err.code); });
  }

  function init() {
    card = document.getElementById('orgChartCard');
    treeEl = document.getElementById('ocTree');
    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    if (!ctx.biz || !card) return;

    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    var userEmail = (user && user.email) || '';
    ctx.isOwner = !!userEmail && userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
    ctx.userEmail = userEmail;
    ctx.userUid = (user && user.uid) || '';

    wireAddForm();
    listenTeam();
    if (window.drAccess) window.drAccess.whenReady().then(render);
    else render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
