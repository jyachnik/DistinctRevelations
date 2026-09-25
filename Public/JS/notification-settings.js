// Public/JS/notification-settings.js
// "Notification Phone Number" setting — where SMS alerts get sent (a new
// Q&A question, and the daily overdue-items digest — see
// functions/index.js's notifyOwnerOnNewQuestion/sendOverdueDigest).
// Stored on businesses/{biz}.notificationPhone. Deliberately a SEPARATE
// field from the older OWNER_PHONE_NUMBER Cloud Functions env value the
// existing "new member joined" text already uses — not unified, per
// explicit request. Owner-only, in-page overlay (same .dr-modal-*
// pattern as Insight Mode/Data Imports — see insight-mode-settings.js),
// not a separate popup window.

(function () {
  'use strict';

  var OWNER_EMAIL = (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) || window.ownerEmail || '';
  var OWNER_LIST = (window.APP_CONFIG && window.APP_CONFIG.OWNERS) || [];

  function isOwnerEmail(email) {
    email = (email || '').toLowerCase();
    return (OWNER_EMAIL && email === OWNER_EMAIL.toLowerCase()) ||
      OWNER_LIST.map(function (e) { return (e || '').toLowerCase(); }).indexOf(email) !== -1;
  }

  // E.164: a leading +, then 7-15 digits — matches the format Twilio
  // itself requires and functions/.env.example's own example values.
  var PHONE_RE = /^\+\d{7,15}$/;

  function openOverlay() {
    var overlay = document.getElementById('notificationSettingsOverlay');
    if (!overlay) return;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
  }
  function closeOverlay() {
    var overlay = document.getElementById('notificationSettingsOverlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
  }
  window.drOpenNotificationSettings = openOverlay;

  function waitForBusinessKey(cb) {
    if (window.BIZ_KEY) { cb(window.BIZ_KEY); return; }
    if (typeof window.waitForBusinessKey === 'function') {
      window.waitForBusinessKey(function (bizKey) { window.BIZ_KEY = bizKey; cb(bizKey); });
      return;
    }
    setTimeout(function () { waitForBusinessKey(cb); }, 150);
  }

  function setStatus(el, text, cls) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'notification-settings-status' + (cls ? ' ' + cls : '');
  }

  function init() {
    var closeBtn = document.getElementById('notificationSettingsClose');
    var overlay = document.getElementById('notificationSettingsOverlay');
    var panel = document.getElementById('notificationSettingsPanel');
    var input = document.getElementById('notificationPhoneInput');
    var saveBtn = document.getElementById('notificationPhoneSaveBtn');
    var statusEl = document.getElementById('notificationPhoneStatus');

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
        var phone = (snap.exists && snap.data() && snap.data().notificationPhone) || '';
        // Don't clobber an in-progress edit if another tab/session updates
        // this while the popup is open — only sync when the field isn't
        // currently focused.
        if (input && document.activeElement !== input) input.value = phone;
      }, function (err) {
        console.warn('[notification-settings] listener failed', err);
      });

      if (saveBtn) {
        saveBtn.addEventListener('click', function () {
          var value = (input && input.value || '').trim();
          if (value && !PHONE_RE.test(value)) {
            if (input) input.classList.add('is-invalid');
            setStatus(statusEl, 'Enter a valid phone number in E.164 format, e.g. +15551234567.', 'err');
            return;
          }
          if (input) input.classList.remove('is-invalid');
          setStatus(statusEl, 'Saving…', '');
          docRef.set({ notificationPhone: value || null }, { merge: true }).then(function () {
            setStatus(statusEl, 'Saved ✓', 'ok');
          }).catch(function (err) {
            setStatus(statusEl, 'Could not save: ' + (err && err.message ? err.message : err), 'err');
          });
        });
      }

      if (input) {
        input.addEventListener('input', function () {
          input.classList.remove('is-invalid');
          setStatus(statusEl, '', '');
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
