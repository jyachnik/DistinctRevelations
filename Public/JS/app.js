(() => {
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

  const header  = $('.topbar');
  const drawer  = $('#mobileNav');
  const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const smooth = prefersReduced ? 'auto' : 'smooth';

  const openById  = (id) => { const el = id && $('#'+id); if (!el) return;
    el.setAttribute('aria-hidden','false'); document.body.classList.add('no-scroll'); document.body.style.overflow='hidden';
  };
  const closeById = (id) => { const el = id && $('#'+id); if (!el) return;
    el.setAttribute('aria-hidden','true'); document.body.classList.remove('no-scroll'); document.body.style.overflow='';
  };

  /* Year stamp */
  const y = $('#year'); if (y) y.textContent = new Date().getFullYear();

  /* Open/Close via data attributes (does not block anchors) */
  document.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-open]');
    if (openBtn){ e.preventDefault(); openById(openBtn.getAttribute('data-open')); return; }

    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn){
      const isAnchor = closeBtn.matches('a[href]');
      if (!isAnchor) e.preventDefault();
      closeById(closeBtn.getAttribute('data-close'));
      // no return → allow native anchor behavior
    }
  });

  /* Hamburger */
  const btn = $('#mobileMenuBtn');
  if (btn && drawer){
    btn.addEventListener('click', () => {
      const opening = drawer.getAttribute('aria-hidden') !== 'false';
      drawer.setAttribute('aria-hidden', opening ? 'false' : 'true');
      btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
      document.body.classList.toggle('no-scroll', opening);
      document.body.style.overflow = opening ? 'hidden' : '';
    });
  }

  /* LOGOS → always scroll to absolute top (capture so nothing can block it) */
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('a.brand, a.corner-logo');
    if (!a) return;

    const href = (a.getAttribute('href') || '').trim();
    const sameTop =
      href === '#top' || href === '#page-top' ||
      href === '/'    || href.endsWith('index.html') ||
      href.endsWith('home.html') || href === location.pathname;

    if (!sameTop) return;

    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    if (drawer) drawer.setAttribute('aria-hidden','true');
    $$('.modal').forEach(m => m.setAttribute('aria-hidden','true'));
    document.body.classList.remove('no-scroll'); document.body.style.overflow = '';

    // Scroll page to 0 with multiple fallbacks (covers any scroll root)
    try { window.scrollTo({ top: 0, behavior: smooth }); }
    catch { window.scrollTo(0, 0); }
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, true);

  /* ESC closes overlays */
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (drawer) drawer.setAttribute('aria-hidden','true');
    $$('.modal').forEach(m => m.setAttribute('aria-hidden','true'));
    document.body.classList.remove('no-scroll'); document.body.style.overflow = '';
  });

  /* Expose helpers (optional) */
  window.UI = { openById, closeById };
})();

/* ===== Shared PDF viewer (all case studies) ===== */
document.addEventListener('click', (e) => {
  const link = e.target.closest('.js-pdf[data-pdf]');
  if (!link) return;

  e.preventDefault();

  const src   = link.getAttribute('data-pdf');
  const modal = document.getElementById('pdfViewer');
  const frame = document.getElementById('pdfFrame');
  if (!src || !modal || !frame) return;

  // Use PDF.js viewer so it renders inline even if headers force download
  const absolute = new URL(src, location.href).href;
  const viewer   = `https://mozilla.github.io/pdf.js/web/viewer.html?file=${encodeURIComponent(absolute)}`;
  frame.src = viewer;

  const openTab  = modal.querySelector('.pdf-open-tab');
  const download = modal.querySelector('.pdf-download');
  if (openTab)  openTab.href  = src;
  if (download) download.href = src;

  modal.setAttribute('aria-hidden','false');
  document.body.classList.add('no-scroll');
  document.body.style.overflow = 'hidden';
});

document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close="pdfViewer"]');
  if (!closeBtn) return;
  const frame = document.getElementById('pdfFrame');
  if (frame) setTimeout(() => { frame.src = 'about:blank'; }, 150);
});