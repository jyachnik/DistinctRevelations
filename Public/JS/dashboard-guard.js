// /Public/JS/dashboard-guard.js — patient guard + bounce diagnostics
(() => {
  const qs = new URLSearchParams(location.search);
  const businessKey = qs.get('business') || localStorage.getItem('businessKey') || '';
  const DEBUG = qs.get('debugAuth') === '1';  // use /dashboard.html?...&debugAuth=1 to prevent redirect

  // Redirect target keeps business param so you land back to the same biz login
  const LOGIN_URL = (() => {
    const base = location.pathname.replace(/[^/]+$/, ''); // "/Public/"
    const q = businessKey ? `?business=${encodeURIComponent(businessKey)}` : '';
    return `${base}index.html${q}#client-login`;
  })();

  const JUST_KEY = 'dr:justSignedIn';
  const KICK_KEY = 'dr:lastKick'; // breadcrumb read on index

  function saveKick(reason, extra) {
    try {
      sessionStorage.setItem(KICK_KEY, JSON.stringify({
        reason,
        businessKey,
        when: Date.now(),
        ...extra
      }));
    } catch (_) {}
  }
  function kick(reason, extra) {
    saveKick(reason, extra);
    if (DEBUG) {
      console.warn('[guard] (debugAuth=1) would redirect:', reason, extra);
      // don't redirect in debug mode
      return;
    }
    location.replace(LOGIN_URL);
  }

  function whenAuth(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (window.auth) return resolve(window.auth);
      const t = setTimeout(() => reject(new Error('auth timeout')), timeoutMs);
      if (typeof window.onFirebaseReady === 'function') {
        window.onFirebaseReady(() => { clearTimeout(t); resolve(window.auth); });
      } else {
        const fn = () => { clearTimeout(t); document.removeEventListener('firebase-ready', fn); resolve(window.auth); };
        document.addEventListener('firebase-ready', fn, { once: true });
      }
    });
  }

  function waitForUser(auth, graceMs) {
    return new Promise((resolve) => {
      if (auth?.currentUser) return resolve(auth.currentUser);
      let done = false;
      const start = Date.now();
      const iv = setInterval(() => {
        if (done) return;
        if (auth?.currentUser) { done = true; clearInterval(iv); try { unsub && unsub(); } catch {} return resolve(auth.currentUser); }
        if (Date.now() - start > graceMs) { done = true; clearInterval(iv); try { unsub && unsub(); } catch {} return resolve(null); }
      }, 120);
      const unsub = auth?.onAuthStateChanged?.call(auth, (u) => {
        if (!done && u) { done = true; clearInterval(iv); try { unsub && unsub(); } catch {} resolve(u); }
      });
    });
  }

  (async () => {
    // 0) business key present?
    if (!businessKey) return kick('no-business-key');

    // 1) Firebase/auth readiness
    let auth;
    try { auth = await whenAuth(15000); } catch { /* ignore, wait a tiny bit */ }
    if (!auth) { await new Promise(r => setTimeout(r, 500)); auth = window.auth; }
    if (!auth) return kick('firebase-not-ready');

    // 2) Be patient if just signed in
    let graceMs = 3000;
    try {
      const ts = Number(sessionStorage.getItem(JUST_KEY) || '0');
      if (ts && (Date.now() - ts) < 15000) graceMs = 9000;
      if (ts) sessionStorage.removeItem(JUST_KEY);
    } catch {}

    const user = await waitForUser(auth, graceMs);
    if (!user) return kick('no-user-after-grace', { graceMs });

    // 3) Access check in Firestore
    const db = window.db;
    if (!db) return kick('firestore-not-ready', { uid: user.uid, email: user.email });

    try {
      const bizRef  = db.collection('businesses').doc(businessKey);
      const bizSnap = await bizRef.get();
      if (!bizSnap.exists) return kick('business-doc-missing', { uid: user.uid, email: user.email });

      const biz = bizSnap.data() || {};
      const isOwner = biz.ownerUid === user.uid;

      let isMember = false;
      if (!isOwner) {
        // If your project does not use businesses/{biz}/members/{uid}, this will be false.
        const mSnap = await bizRef.collection('members').doc(user.uid).get();
        isMember = mSnap.exists;
      }

      if (!isOwner && !isMember) {
        return kick('no-access', { uid: user.uid, email: user.email, ownerUid: biz.ownerUid || null });
      }

      // ✅ Access granted: clear any previous breadcrumb and continue
      try { sessionStorage.removeItem(KICK_KEY); } catch {}
      document.documentElement.classList.remove('auth-pending');
      console.log('[guard] Access OK for', user.email, '→ business', businessKey, '(owner:', isOwner, 'member:', isMember, ')');

    } catch (e) {
      return kick('access-check-error', { error: String(e), uid: user.uid, email: user.email });
    }
  })();
})();