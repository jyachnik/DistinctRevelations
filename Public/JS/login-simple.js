/* =========================================================================
   login-simple.js — explicit owner login → modal → key → dashboard
   ========================================================================= */

(function () {

  const TAG = '[login]';

  // Owners list from app-config.js
  const OWNERS =
    (window.APP_CONFIG && window.APP_CONFIG.OWNERS) ||
    [];

  const L = (...a) => console.log(TAG, ...a);
  const W = (...a) => console.warn(TAG, ...a);
  const E = (...a) => console.error(TAG, ...a);
  const $ = (id) => document.getElementById(id);

  console.log('[login] OWNERS from config =', OWNERS);

  // ---------------- helpers ----------------
  function getURLKey(){ try{ return (new URLSearchParams(location.search).get('business')||'').trim(); }catch{return '';} }
  function getStoredKey(){ try{ return (sessionStorage.getItem('businessKey')||localStorage.getItem('businessKey')||'').trim(); }catch{return '';} }
  function persistKey(k){ try{ localStorage.setItem('businessKey',k); }catch{} try{ sessionStorage.setItem('businessKey',k); }catch{} }
  function clearKeys(){ try{ localStorage.removeItem('businessKey'); }catch{} try{ sessionStorage.removeItem('businessKey'); }catch{} }
  function redirectToDashboard(biz, opts={}){ const qp=new URLSearchParams({business:biz}); if(opts.admin) qp.set('admin','1'); const url='dashboard.html?'+qp.toString(); L('redirect →', url); window.location.href=url; }
  function modalShow(){ const m=$('businessSelectModal'); L('modal DOM?',{hasModal:!!m}); if(!m) return; if(typeof m.show==='function') m.show(); else { m.style.display='flex'; m.setAttribute('aria-hidden','false'); } }

  // ---------------- robust bootstrap ----------------
  function startWhenReady(){
    let tries=0;
    const tick=()=>{
      tries++;
      const {auth, db}=window;
      if(auth && db){
        L('SDK ready after', tries, 'ticks');
        boot(auth, db);
        return true;
      }
      if(tries%10===0) L('waiting for SDK…', {tries, hasAuth:!!auth, hasDB:!!db});
      return false;
    };
    if(tick()) return;
    const onEvt=()=>{ if(tick()) cleanup(); };
    function cleanup(){ try{document.removeEventListener('firebase-ready', onEvt);}catch{} try{clearInterval(iv);}catch{} }
    document.addEventListener('firebase-ready', onEvt);
    const iv=setInterval(tick,100);
    if(typeof window.onFirebaseReady==='function'){
      try{ onFirebaseReady(()=>{ if(tick()) cleanup(); }); }catch(e){ W('onFirebaseReady hook failed:', e?.message||e); }
    }
  }

  // ---------------- form wiring ----------------
  function wireForm(auth, db){
    const form=$('loginForm'), emailEl=$('loginEmail'), passEl=$('loginPassword');
    const submitBtn = form && form.querySelector('button[type="submit"]');
    L('wireForm →', { hasForm: !!form, hasEmail: !!emailEl, hasPass: !!passEl, hasBtn: !!submitBtn });

    async function doLogin(e){
      if(e) e.preventDefault();
      const email=(emailEl?.value||'').trim(), pass=(passEl?.value||'').trim();
      L('submit →',{ emailMasked: email.replace(/(.{2}).+(@.*)/,'$1***$2'), passLen: pass.length });
      if(!email||!pass){ W('missing email or password'); return; }
      try{
        clearKeys();                 // ensure fresh selection
        window.__explicitLogin = true;
        L('signInWithEmailAndPassword() starting…');
        await auth.signInWithEmailAndPassword(email, pass);
        L('signInWithEmailAndPassword() resolved.');

        // CRITICAL: call router immediately after sign-in resolves
        await postLoginRouter(auth, db);

      }catch(err){
        E('sign-in failed:', err?.message||err);
        alert(err?.message||'Sign-in failed.');
      }
    }

    form && form.addEventListener('submit', doLogin, { capture: true });
    submitBtn && submitBtn.addEventListener('click', doLogin, { capture: true });
  }

  // ---------------- routing after login ----------------
  async function postLoginRouter(auth, db){
    const user = auth.currentUser;
    const email = (user?.email || '').toLowerCase();
const isOwner = OWNERS.some(
    e => e && e.toLowerCase() === email
  );
    const urlKey=getURLKey(), lsKey=getStoredKey();
    console.table({ TAG, email, isOwner, urlKey, lsKey, explicit: !!window.__explicitLogin });

    // Only proceed on explicit login (prevents auto-modal from preexisting sessions)
    if(!window.__explicitLogin){
      L('not an explicit login; ignoring (pre-existing session or reload).');
      return;
    }

    if(isOwner){
      // Owner must pick fresh each explicit login
      if (urlKey || lsKey) { L('ignoring existing key at login; owner must pick fresh.'); clearKeys(); }
      if(typeof window.showBusinessModalForOwner==='function'){
        L('owner → opening Select Business modal (index.html) …');
        modalShow();                       // visible now
        window.showBusinessModalForOwner({
  email: user.email,
  isOwner: true
}); // populates list; persists key; redirects on Continue
        return;
      }
      E('showBusinessModalForOwner missing — ensure select-business.js and modal IDs exist on index.html');
      L('DOM checks:', {
        modal: !!document.getElementById('businessSelectModal'),
        dropdown: !!document.getElementById('businessDropdown'),
        button: !!document.getElementById('selectBusinessBtn')
      });
      alert('Business picker not available. Ensure select-business.js is loaded and modal exists.');
      return;
    }

    // Non-owner
    let key = urlKey||lsKey;
    if(!key){
      try{
        L('resolving non-owner business mapping …');
        const byId = await db.collection('users').doc(email).get();
        if (byId.exists) key = (byId.data()?.businessKey || byId.data()?.business || '').trim();
        if (!key) {
          const qs = await db.collection('users').where('email','==',email).limit(1).get();
          if (!qs.empty) key = (qs.docs[0].data()?.businessKey || qs.docs[0].data()?.business || '').trim();
        }
      }catch(e){ W('resolve failed:', e?.message||e); }
    }
    if(key){ persistKey(key); L('non-owner resolved →', key); return redirectToDashboard(key); }
    E('non-owner not mapped; stopping.'); alert('Your account is not linked to a business. Please contact the administrator.');
  }

  async function boot(auth, db){
    wireForm(auth, db);

    // We still listen for auth changes (helpful on first load),
    // but the explicit submit path above already calls the router.
    auth.onAuthStateChanged(async (user)=>{
      L('onAuthStateChanged:', { hasUser: !!user, email: (user?.email||'').toLowerCase(), explicit: !!window.__explicitLogin });
      if(!user) return;
      try{ await postLoginRouter(auth, db); }catch(e){ E('post-login error:', e); }
    });
  }

  // kick
  startWhenReady();
})();