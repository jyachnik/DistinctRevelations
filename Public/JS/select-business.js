/* ========================================================================
   select-business.js — owner picks business BEFORE dashboard (final)
   ======================================================================== */
(function () {
  const TAG = '[select-business]';
  const OWNER =
  (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) ||
  window.ownerEmail ||
  '';
  const L = (...a)=>console.log(TAG, ...a);
  const W = (...a)=>console.warn(TAG, ...a);
  const E = (...a)=>console.error(TAG, ...a);
  const $ = (id)=>document.getElementById(id);

  // --- guards ---
  const IS_DASH = /\/dashboard\.html(\?|$)/i.test(location.pathname);
  if (IS_DASH) L('loaded on dashboard; will not open modal here.');
  if (window.__bizPicked) L('__bizPicked set; will not open modal again.');

  function showModal(){
    const m = $('businessSelectModal');
    L('showModal()', { hasModal: !!m });
    if (!m) return;
    if (typeof m.show === 'function') m.show();
    else { m.style.display='flex'; m.setAttribute('aria-hidden','false'); }
  }
  function hideModal(){
    const m = $('businessSelectModal');
    if (!m) return;
    if (typeof m.hide === 'function') m.hide();
    else { m.style.display='none'; m.setAttribute('aria-hidden','true'); }
  }

  function waitForFirebase(ms=15000){
    return new Promise((resolve)=>{
      const ok = ()=> !!(window.db && window.auth);
      if (ok()) { L('waitForFirebase: immediate'); return resolve({ db:window.db, auth:window.auth }); }
      const tick = ()=>{ if (ok()){ cleanup(); L('waitForFirebase: ready via poll'); resolve({ db:window.db, auth:window.auth }); } };
      function cleanup(){ try{ document.removeEventListener('firebase-ready', tick); }catch{} try{ clearInterval(iv); }catch{} try{ clearTimeout(to); }catch{} }
      document.addEventListener('firebase-ready', tick);
      const iv = setInterval(tick, 100);
      const to = setTimeout(()=>{ cleanup(); L('waitForFirebase: timeout fallback'); resolve({ db:window.db, auth:window.auth }); }, ms);
    });
  }

  function persistKey(biz){
    try{ localStorage.setItem('businessKey', biz); }catch{}
    try{ sessionStorage.setItem('businessKey', biz); }catch{}
    try{
      window.BIZ_KEY = biz;
      window.__bizPicked = true;  // prevent reopening
      window.dispatchEvent(new CustomEvent('business:ready', { detail:{ businessKey: biz } }));
    }catch{}
  }

 window.showBusinessModalForOwner = async function(user){
  // never open modal on dashboard or if already picked
  if (IS_DASH) return W('blocked: picker not allowed on dashboard');
  if (window.__bizPicked) return W('blocked: already picked in this session');

  const email = (user && user.email) || '';
  const isOwner = !!(user && user.isOwner);   // trust caller flag

  L('invoke', { email, isOwner });
  if (!isOwner) return W('blocked: not owner');

    showModal();  // visible immediately
    const { db } = await waitForFirebase();
    if (!db) { E('Firebase not ready; cannot list businesses.'); return; }

    const modal = $('businessSelectModal');
    const dropdown = $('businessDropdown');
    const btn = $('selectBusinessBtn');
    L('DOM check', { modal: !!modal, dropdown: !!dropdown, btn: !!btn });
    if (!modal || !dropdown || !btn) return E('Modal DOM missing (IDs).');

    btn.disabled = true;
    dropdown.innerHTML = '<option disabled selected>Loading…</option>';

    try{
      L('query: /businesses');
      const qs = await db.collection('businesses').get();
      dropdown.innerHTML = '';
      let count = 0;
      qs.forEach(doc=>{
        const d = doc.data()||{};
        const opt = document.createElement('option');
        opt.value = doc.id;
        opt.textContent = d.name || doc.id;
        dropdown.appendChild(opt);
        count++;
      });
      L('loaded businesses:', count);
      if (!count) dropdown.innerHTML = '<option disabled selected>No companies found</option>';
      btn.disabled = (count === 0);
    }catch(e){
      E('error loading businesses:', e?.code || e?.message || e);
      W('If code is "permission-denied", update Firestore rules to allow owner reads on /businesses/*');
      dropdown.innerHTML = '<option disabled selected>Permission denied loading companies</option>';
      btn.disabled = true;
      return;
    }

    // close handlers
    (modal.querySelectorAll('[data-close="businessSelectModal"]')||[]).forEach(el=>{
      el.addEventListener('click', ()=>{ L('close clicked'); hideModal(); }, { once:true });
    });

    // Continue: persist business, hand off to the project picker (which
    // does its own redirect to the dashboard once a project is resolved —
    // see select-project.js's showProjectModalForUser).
    btn.onclick = function(){
      const biz = (dropdown && dropdown.value || '').trim();
      L('Continue clicked →', { biz });
      if (!biz) return W('no business selected');

      persistKey(biz);
      hideModal();
      var hasPicker = typeof window.showProjectModalForUser === 'function';
      try {
        var trail = JSON.parse(sessionStorage.getItem('dr-select-project-debug') || '[]');
        trail.push({ step: 'select-business-continue', data: { biz, hasPicker }, at: Date.now() });
        sessionStorage.setItem('dr-select-project-debug', JSON.stringify(trail));
      } catch {}
      if (hasPicker) {
        window.showProjectModalForUser(biz, { email: user.email, isOwner: true }, { admin: true });
      } else {
        E('showProjectModalForUser missing — ensure select-project.js is loaded; falling back to legacy redirect.');
        window.location.replace('dashboard.html?business=' + encodeURIComponent(biz) + '&admin=1');
      }
    };
  };

  L('ready');
})();
