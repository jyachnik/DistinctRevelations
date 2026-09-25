// Public/JS/dr-progress.js
// A shared, full-screen "this is working" indicator for anything that
// takes a visible moment with no natural step-by-step progress to report
// (a single Run Analysis API call, an import's parse+Firestore-write
// pass) — an indeterminate animated bar, not a real 0-100% figure, since
// none of these operations are actually chunked/streamed.
//
// Usage: window.drProgress.show('Importing schedule…'); ... .then(() =>
// window.drProgress.hide());  show() calls nest safely (a counter, not a
// boolean) so an operation that itself triggers another doesn't have the
// inner one's hide() close the outer one's indicator early.
//
// Loaded early (a plain <script>, not through the auth-gated loadScript()
// cascade) so it's available no matter which module needs it first.

(function () {
  'use strict';

  var overlay = null;
  var openCount = 0;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'dr-progress-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
      '<div class="dr-progress-box">' +
        '<div class="dr-progress-bar"><div class="dr-progress-bar-fill"></div></div>' +
        '<p class="dr-progress-message"></p>' +
      '</div>';
    document.body.appendChild(overlay);
    return overlay;
  }

  window.drProgress = {
    show: function (message) {
      var el = ensureOverlay();
      openCount++;
      el.querySelector('.dr-progress-message').textContent = message || 'Working…';
      el.classList.add('is-open');
      el.setAttribute('aria-hidden', 'false');
    },
    hide: function () {
      if (!overlay) return;
      openCount = Math.max(0, openCount - 1);
      if (openCount === 0) {
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
      }
    }
  };
})();
