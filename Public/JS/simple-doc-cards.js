/* ============================================================================
   Simple single-document cards — a small factory for owner-edited, single-
   Firestore-doc narrative cards: one fixed doc, a few textarea fields, no
   versioning. Same shape as Team Charter (teamCharter.js), generalized so
   it isn't copy-pasted again for each of the PMI artifacts that are really
   just "the team's own written agreement," not a live list:
     Product Vision Statement, Definition of Ready, Definition of Done
   (instantiated in agile-doc-cards.js).

   Firestore: businesses/{biz}/projects/{proj}/{collectionName}/main
   Fields: one per config field key, plus updatedAt/updatedBy.
   ============================================================================ */

(function () {
  'use strict';

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }
  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  // cfg: { cardId, collectionName, bodyPrefix, noun, fields: [key,...], labels: {key:label}, sample: {key:text} }
  function buildSimpleDocCard(cfg) {
    var ns = '[' + cfg.cardId + ']';
    var ctx = { biz: null, proj: null, userEmail: '', isOwner: false, data: null };
    var card, banner, viewEl;
    var inputs = {}, saveBtn, statusEl;

    function docRef() {
      var db = getDB();
      if (!db || !ctx.biz) return null;
      return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default')
        .collection(cfg.collectionName).doc('main');
    }
    function canWrite() { return ctx.isOwner; }

    function paint() {
      if (!card) return;
      var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(cfg.cardId));
      card.classList.toggle('owner', ctx.isOwner);
      card.classList.toggle('report-access-granted', canView);
      if (!canView) return;

      var usingSample = !ctx.data;
      var data = ctx.data || cfg.sample;
      if (banner) banner.hidden = !usingSample;

      cfg.fields.forEach(function (f) {
        if (inputs[f] && document.activeElement !== inputs[f]) inputs[f].value = data[f] || '';
      });

      if (viewEl) {
        viewEl.innerHTML = cfg.fields.map(function (f) {
          return '<div class="tc-field-view"><h4>' + esc(cfg.labels[f]) + '</h4><p>' +
            (data[f] ? nl2br(data[f]) : '<span class="tc-empty">Not set.</span>') + '</p></div>';
        }).join('');
      }

      if (window.drInsight) {
        window.drInsight.set(cfg.cardId, usingSample
          ? 'Showing sample ' + cfg.noun + ' — the owner can edit and save the real one.'
          : (cfg.noun.charAt(0).toUpperCase() + cfg.noun.slice(1) + ' last updated' + (data.updatedBy ? ' by ' + data.updatedBy : '') + '.'));
      }
    }

    function save() {
      if (!canWrite()) return;
      var ref = docRef();
      if (!ref) return;
      var payload = {};
      cfg.fields.forEach(function (f) { payload[f] = inputs[f] ? inputs[f].value.trim() : ''; });
      payload.updatedAt = new Date();
      payload.updatedBy = ctx.userEmail || '';
      if (statusEl) statusEl.textContent = 'Saving…';
      ref.set(payload, { merge: true })
        .then(function () { if (statusEl) statusEl.textContent = 'Saved.'; })
        .catch(function (err) {
          console.error(ns, 'save error', err);
          if (statusEl) statusEl.textContent = 'Could not save: ' + (err && err.message ? err.message : err);
        });
    }

    function applyWriteAccess() {
      var addOnlyEls = document.querySelectorAll('#' + cfg.cardId + ' .' + cfg.bodyPrefix + '-add-only');
      for (var i = 0; i < addOnlyEls.length; i++) addOnlyEls[i].style.display = canWrite() ? '' : 'none';
      var readOnlyEls = document.querySelectorAll('#' + cfg.cardId + ' .' + cfg.bodyPrefix + '-read-only');
      for (var j = 0; j < readOnlyEls.length; j++) readOnlyEls[j].style.display = canWrite() ? 'none' : '';
      paint();
    }

    function listen() {
      var ref = docRef();
      if (!ref) return;
      ref.onSnapshot(function (snap) {
        ctx.data = (snap.exists && Object.keys(snap.data() || {}).length) ? snap.data() : null;
        paint();
      }, function (err) { console.warn(ns, 'listen error (expected if not granted view access)', err && err.code); });
    }

    function detectContext() {
      card = document.getElementById(cfg.cardId);
      banner = document.getElementById(cfg.bodyPrefix + 'SampleBanner');
      viewEl = document.getElementById(cfg.bodyPrefix + 'ReadOnlyView');
      cfg.fields.forEach(function (f) { inputs[f] = document.getElementById(cfg.bodyPrefix + '-' + f); });
      saveBtn = document.getElementById(cfg.bodyPrefix + '-save');
      statusEl = document.getElementById(cfg.bodyPrefix + '-status');

      ctx.biz = window.BIZ_KEY || window.businessKey || null;
      ctx.proj = window.PROJECT_KEY || 'default';
      var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
      ctx.userEmail = (user && user.email) || '';
      ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
    }

    function init() {
      detectContext();
      if (!ctx.biz || !card) return;
      if (saveBtn) saveBtn.addEventListener('click', save);
      listen();
      if (window.drAccess) window.drAccess.whenReady().then(applyWriteAccess);
      else applyWriteAccess();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  }

  window.drBuildSimpleDocCard = buildSimpleDocCard;
})();
