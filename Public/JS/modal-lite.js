// js/modal-lite.js
(function () {
  const open  = id => document.getElementById(id)?.setAttribute('aria-hidden', 'false');
  const close = id => document.getElementById(id)?.setAttribute('aria-hidden', 'true');
  document.addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]');
    if (o) { e.preventDefault(); open(o.dataset.open); }
    const c = e.target.closest('[data-close]');
    if (c) { e.preventDefault(); close(c.dataset.close); }
  });
})();