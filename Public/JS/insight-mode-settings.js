// Public/JS/insight-mode-settings.js
// "Insight Mode" setting — Standard (free, rule-based sentences) vs AI
// (Claude-phrased card insights + the executive-summary Project Analysis
// panel above the Gantt Timeline). Stored on businesses/{biz}.insightMode,
// business-level only for now (project-level scoping is a later addition
// once this app's multi-project support ships). Owner-only, opened as an
// in-page overlay from the Report Index's Settings list — same modal
// pattern as Data Imports (see settings.js), not a separate popup window.

(function () {
  'use strict';

  var OWNER_EMAIL = (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) || window.ownerEmail || '';
  var OWNER_LIST = (window.APP_CONFIG && window.APP_CONFIG.OWNERS) || [];

  function isOwnerEmail(email) {
    email = (email || '').toLowerCase();
    return (OWNER_EMAIL && email === OWNER_EMAIL.toLowerCase()) ||
      OWNER_LIST.map(function (e) { return (e || '').toLowerCase(); }).indexOf(email) !== -1;
  }

  function openOverlay() {
    var overlay = document.getElementById('insightModeOverlay');
    if (!overlay) return;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
  }
  function closeOverlay() {
    var overlay = document.getElementById('insightModeOverlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
  }
  window.drOpenInsightModeModal = openOverlay;

  function waitForBusinessKey(cb) {
    if (window.BIZ_KEY) { cb(window.BIZ_KEY); return; }
    if (typeof window.waitForBusinessKey === 'function') {
      window.waitForBusinessKey(function (bizKey) { window.BIZ_KEY = bizKey; cb(bizKey); });
      return;
    }
    setTimeout(function () { waitForBusinessKey(cb); }, 150);
  }

  function init() {
    var closeBtn = document.getElementById('insightModeClose');
    var overlay = document.getElementById('insightModeOverlay');
    var panel = document.getElementById('insightModePanel');
    var radios = document.querySelectorAll('input[name="insightModeRadio"]');

    if (closeBtn) closeBtn.addEventListener('click', closeOverlay);
    if (overlay) {
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeOverlay(); });
    }

    if (!window.db) { setTimeout(init, 150); return; }

    waitForBusinessKey(function (bizKey) {
      var user = (window.auth && window.auth.currentUser) || {};
      var isOwner = isOwnerEmail(user.email);
      if (panel) panel.classList.toggle('owner', isOwner);
      if (!isOwner) return;

      var docRef = window.db.collection('businesses').doc(bizKey);
      docRef.onSnapshot(function (snap) {
        var mode = (snap.exists && snap.data() && snap.data().insightMode) || 'standard';
        radios.forEach(function (r) { r.checked = (r.value === mode); });
      }, function (err) {
        console.warn('[insight-mode-settings] listener failed', err);
      });

      radios.forEach(function (r) {
        r.addEventListener('change', function () {
          if (!r.checked) return;
          docRef.set({ insightMode: r.value }, { merge: true }).catch(function (err) {
            alert('Could not save Insight Mode: ' + (err && err.message ? err.message : err));
          });
        });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
