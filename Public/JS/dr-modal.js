// Public/JS/dr-modal.js
// A generic, reusable "popup window within the app" — one shared overlay
// element created lazily on first use and its content swapped per call,
// so new features (insight "View more", chart "About this chart", etc.)
// don't each need their own static overlay markup hand-written into
// dashboard.html. Reuses the existing .dr-modal-* look (change-report.css)
// for visual consistency with the app's other popups.
//
// Usage: window.drModal.open({ title: '...', bodyHtml: '...' })
//
// Loaded early (a plain <script>, not through the auth-gated loadScript()
// cascade) so it's guaranteed ready before anything tries to call it.

(function () {
  'use strict';

  var overlay = null;
  var noBackdropClose = false;   // opts.noBackdropClose: a stray click outside must not close it (Ask the Project)
  var onCloseCb = null;          // opts.onClose: called whenever the window closes

  function close() {
    if (overlay) {
      overlay.classList.remove('is-open');
      overlay.setAttribute('aria-hidden', 'true');
    }
    var cb = onCloseCb; onCloseCb = null;
    if (cb) { try { cb(); } catch (e) { console.warn('[dr-modal] onClose failed', e); } }
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'dr-modal-overlay';
    overlay.id = 'drGenericModalOverlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
      '<div class="dr-modal-box dr-modal-box-wide" role="dialog" aria-modal="true">' +
        '<div class="dr-modal-header"><h3 class="dr-modal-title"></h3><button type="button" class="dr-modal-close" aria-label="Close">&times;</button></div>' +
        '<div class="dr-modal-body"></div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) { if (e.target === overlay && !noBackdropClose) close(); });
    overlay.querySelector('.dr-modal-close').addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('is-open')) close();
    });
    return overlay;
  }

  window.drModal = {
    open: function (opts) {
      var el = ensureOverlay();
      onCloseCb = (opts && opts.onClose) || null;
      noBackdropClose = !!(opts && opts.noBackdropClose);
      el.querySelector('.dr-modal-box').className = 'dr-modal-box dr-modal-box-wide' + ((opts && opts.boxClass) ? ' ' + opts.boxClass : '');
      el.querySelector('.dr-modal-title').textContent = (opts && opts.title) || '';
      var bodyEl = el.querySelector('.dr-modal-body');
      if (opts && opts.bodyHtml != null) bodyEl.innerHTML = opts.bodyHtml;
      else bodyEl.textContent = (opts && opts.bodyText) || '';
      el.classList.add('is-open');
      el.setAttribute('aria-hidden', 'false');
    },
    close: close
  };
})();
