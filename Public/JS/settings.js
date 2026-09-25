// Public/JS/settings.js
// Handles the Data Imports modal (open/close/backdrop-click) — the real
// import controls, opened from the "Data Imports" entry at the bottom of
// the Report Index list (see report-index.js) rather than a separate
// always-visible sidebar card. window.drOpenDataImportsModal is exposed
// so report-index.js can trigger it without needing to know how the
// modal itself works. Pure DOM wiring, no Firebase needed itself.

(function () {
  'use strict';

  function openDataImportsModal() {
    var overlay = document.getElementById('dataImportsOverlay');
    if (!overlay) return;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function closeDataImportsModal() {
    var overlay = document.getElementById('dataImportsOverlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
  }

  window.drOpenDataImportsModal = openDataImportsModal;

  function init() {
    var closeBtn = document.getElementById('dataImportsClose');
    var overlay = document.getElementById('dataImportsOverlay');

    if (closeBtn) closeBtn.addEventListener('click', closeDataImportsModal);
    if (overlay) {
      overlay.addEventListener('mousedown', function (e) {
        if (e.target === overlay) closeDataImportsModal();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
