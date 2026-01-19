// js/modal-lite.js
(function () {
  function open(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('hidden');          // show the modal
    el.setAttribute('aria-hidden', 'false');
  }

  function close(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('hidden');             // hide the modal
    el.setAttribute('aria-hidden', 'true');
  }

  document.addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]');
    if (o) {
      e.preventDefault();
      open(o.dataset.open);
      return;
    }

    const c = e.target.closest('[data-close]');
    if (c) {
      e.preventDefault();
      close(c.dataset.close);
    }
  });
})();