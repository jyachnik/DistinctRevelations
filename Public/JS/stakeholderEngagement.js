/* ============================================================================
   Stakeholder Engagement Assessment Matrix — the standard PMBOK visual:
   each stakeholder plotted by Current (C) engagement level against Desired
   (D) engagement level across the Unaware -> Resistant -> Neutral ->
   Supportive -> Leading scale, with a bar showing the gap to close between
   them. Read-only, no writes, no new Firestore field — the SAME
   currentEngagement/desiredEngagement fields the Stakeholder Register
   already collects (its own form already has both selects); this card is
   purely a different visualization of that same data, same precedent as
   Risk Heat Map / Org Chart this session.

   Sorted by gap size (desired further than current) descending — this
   matrix exists to prioritize engagement effort, so the stakeholders
   needing the most movement lead.

   Firestore: businesses/{biz}/projects/{proj}/stakeholders  (read-only here;
   owned by stakeholders.js)
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[stakeholder-engagement]';
  var LEVELS = ['Unaware', 'Resistant', 'Neutral', 'Supportive', 'Leading'];

  var ctx = { biz: null, proj: null, isOwner: false, rows: [] };
  var card, bodyEl, addForm;

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function stakeholdersRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default').collection('stakeholders');
  }

  function render() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('stakeholderEngagementCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (addForm) addForm.hidden = !canWrite();
    if (!canView || !bodyEl) return;

    var plottable = (ctx.rows || []).map(function (r) {
      var curIdx = LEVELS.indexOf(r.currentEngagement), desIdx = LEVELS.indexOf(r.desiredEngagement);
      return { row: r, curIdx: curIdx, desIdx: desIdx };
    }).filter(function (x) { return x.curIdx !== -1 && x.desIdx !== -1; });

    var skipped = (ctx.rows || []).length - plottable.length;
    var empty = document.getElementById('semEmpty');
    if (!plottable.length) {
      bodyEl.innerHTML = '';
      if (empty) empty.hidden = false;
      if (window.drInsight) window.drInsight.set('stakeholderEngagementCard', '');
      return;
    }
    if (empty) empty.hidden = true;

    plottable.sort(function (a, b) { return (b.desIdx - b.curIdx) - (a.desIdx - a.curIdx) || a.row.name.localeCompare(b.row.name); });

    var header = '<div class="sem-header-row"><div class="sem-label-spacer"></div><div class="sem-row">' +
      LEVELS.map(function (l) { return '<div class="sem-col-label">' + esc(l) + '</div>'; }).join('') + '</div></div>';

    var rows = plottable.map(function (x) {
      var min = Math.min(x.curIdx, x.desIdx), max = Math.max(x.curIdx, x.desIdx);
      var barHtml = x.curIdx !== x.desIdx ? '<div class="sem-bar" style="grid-column:' + (min + 1) + ' / ' + (max + 2) + ';"></div>' : '';
      var dotsHtml = x.curIdx === x.desIdx
        ? '<div class="sem-dot sem-dot-both" style="grid-column:' + (x.curIdx + 1) + ';" title="Current = Desired">C·D</div>'
        : '<div class="sem-dot sem-dot-current" style="grid-column:' + (x.curIdx + 1) + ';" title="Current: ' + esc(x.row.currentEngagement) + '">C</div>' +
          '<div class="sem-dot sem-dot-desired" style="grid-column:' + (x.desIdx + 1) + ';" title="Desired: ' + esc(x.row.desiredEngagement) + '">D</div>';
      return '<div class="sem-label">' + esc(x.row.name || 'Unnamed') + (x.row.role ? ' <span class="sem-role">(' + esc(x.row.role) + ')</span>' : '') + '</div>' +
        '<div class="sem-row">' + barHtml + dotsHtml + '</div>';
    }).join('');

    bodyEl.innerHTML = header + '<div class="sem-body">' + rows + '</div>' +
      (skipped ? '<p class="sem-skipped">' + skipped + ' stakeholder' + (skipped === 1 ? '' : 's') + ' not shown — missing a Current or Desired engagement level (set it in the Stakeholder Register).</p>' : '');

    if (window.drInsight) {
      var gaps = plottable.filter(function (x) { return x.desIdx > x.curIdx; });
      var text = plottable.length + ' stakeholder' + (plottable.length === 1 ? '' : 's') + ' plotted.';
      if (gaps.length) text += ' ' + gaps.length + ' need' + (gaps.length === 1 ? 's' : '') + ' movement toward their desired engagement level' + (gaps[0].row.name ? ', e.g. "' + gaps[0].row.name + '"' : '') + '.';
      window.drInsight.set('stakeholderEngagementCard', text);
    }
  }

  // Owner-only write, same precedent as Stakeholder Register itself
  // (which owns this collection) — a granted "view" role never gets Add
  // here either, matching every other owner-only card this session.
  function canWrite() { return ctx.isOwner; }

  function wireAddForm() {
    addForm = document.getElementById('semAddForm');
    if (!addForm || addForm.__wired) return;
    addForm.__wired = true;
    addForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!canWrite()) return;
      var ref = stakeholdersRef();
      if (!ref) return;
      var nameEl = document.getElementById('semAddName');
      var roleEl = document.getElementById('semAddRole');
      var curEl = document.getElementById('semAddCurrent');
      var desEl = document.getElementById('semAddDesired');
      var name = nameEl ? nameEl.value.trim() : '';
      if (!name) return;

      var ts = (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue &&
        window.firebase.firestore.FieldValue.serverTimestamp && window.firebase.firestore.FieldValue.serverTimestamp()) || new Date();
      var user = (window.auth && window.auth.currentUser) || null;

      ref.add({
        name: name,
        role: roleEl ? roleEl.value.trim() : '',
        organization: '', email: '', phone: '', requirements: '', influence: '', interest: '', notes: '',
        currentEngagement: (curEl && curEl.value) || '',
        desiredEngagement: (desEl && desEl.value) || '',
        createdAt: ts,
        createdBy: (user && user.email) || '',
        createdByUid: (user && user.uid) || ''
      }).then(function () {
        addForm.reset();
      }).catch(function (err) {
        console.error(ns, 'add stakeholder error', err);
        alert('Could not save — please try again: ' + (err && err.message ? err.message : err));
      });
    });
  }

  function listenStakeholders() {
    var ref = stakeholdersRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.rows = rows;
      render();
    }, function (err) { console.warn(ns, 'listen error (expected if not granted view access)', err && err.code); });
  }

  function init() {
    card = document.getElementById('stakeholderEngagementCard');
    bodyEl = document.getElementById('semBody');
    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    if (!ctx.biz || !card) return;

    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    var userEmail = (user && user.email) || '';
    ctx.isOwner = !!userEmail && userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();

    wireAddForm();
    listenStakeholders();
    if (window.drAccess) window.drAccess.whenReady().then(render);
    else render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
