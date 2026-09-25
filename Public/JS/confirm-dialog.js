/* Public/JS/confirm-dialog.js
   Shared promise-based confirm modal, replacing window.confirm() across the
   dashboard. Usage: const ok = await window.drConfirm('Delete this item?', {
     title: 'Delete Item', confirmText: 'Delete', danger: true
   });
*/
(function () {
  // Same .dr-modal-* header/body structure every other popup in this app
  // uses (dr-modal.js's "...more detail", Insight Mode, Notification
  // Settings, etc.) — a dark blue gradient header bar with a title + ×
  // close button, white body below — rather than this dialog's own
  // previously-bespoke centered/accent-bar look, per explicit request
  // that it match the rest of the app.
  function ensureDom() {
    var existing = document.getElementById('drConfirmOverlay');
    if (existing) return existing;

    var overlay = document.createElement('div');
    overlay.id = 'drConfirmOverlay';
    overlay.className = 'dr-modal-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
      '<div class="dr-modal-box dr-confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="drConfirmTitle" aria-describedby="drConfirmMsg">' +
        '<div class="dr-modal-header">' +
          '<h3 id="drConfirmTitle"></h3>' +
          '<button type="button" class="dr-modal-close dr-confirm-close" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="dr-modal-body">' +
          '<p id="drConfirmMsg" class="dr-confirm-message"></p>' +
          '<div class="dr-confirm-actions">' +
            '<button type="button" class="dr-confirm-cancel"></button>' +
            '<button type="button" class="dr-confirm-ok"></button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    return overlay;
  }

  function drConfirm(message, opts) {
    opts = opts || {};
    var title = opts.title || 'Please Confirm';
    var okText = opts.confirmText || 'Delete';
    var cancelText = opts.cancelText || 'Cancel';
    var danger = opts.danger !== false;

    return new Promise(function (resolve) {
      var overlay = ensureDom();
      var titleEl = overlay.querySelector('#drConfirmTitle');
      var msgEl = overlay.querySelector('.dr-confirm-message');
      var okBtn = overlay.querySelector('.dr-confirm-ok');
      var cancelBtn = overlay.querySelector('.dr-confirm-cancel');
      var closeBtn = overlay.querySelector('.dr-confirm-close');

      titleEl.textContent = title;
      msgEl.textContent = message || 'Are you sure?';
      okBtn.textContent = okText;
      cancelBtn.textContent = cancelText;
      okBtn.classList.toggle('is-danger', danger);

      var prevFocus = document.activeElement;
      var settled = false;

      function cleanup(result) {
        if (settled) return;
        settled = true;
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', onKey);
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        if (closeBtn) closeBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('mousedown', onBackdrop);
        try { prevFocus && prevFocus.focus(); } catch (e) {}
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      function onBackdrop(e) { if (e.target === overlay) cleanup(false); }
      function onKey(e) { if (e.key === 'Escape') cleanup(false); }

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      if (closeBtn) closeBtn.addEventListener('click', onCancel);
      overlay.addEventListener('mousedown', onBackdrop);
      document.addEventListener('keydown', onKey);

      overlay.classList.add('is-open');
      overlay.setAttribute('aria-hidden', 'false');
      setTimeout(function () { try { okBtn.focus(); } catch (e) {} }, 30);
    });
  }

  window.drConfirm = drConfirm;
})();
