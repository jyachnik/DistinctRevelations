/* session-classic.js — resilient bootstrap with Firebase wait */
/* eslint-disable no-console */
(function () {
  const log = (...a) => console.log('[session-classic]', ...a);
  const warn = (...a) => console.warn('[session-classic]', ...a);

  // Poll for Firebase Auth (compat or modular)
  function waitForFirebaseAuth(timeoutMs = 8000, intervalMs = 50) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function check() {
        const fb = window.fb || window.firebase || {};
        try {
          // compat
          if (fb.auth && typeof fb.auth === 'function') {
            const auth = fb.auth();
            if (auth) return resolve({ fb, auth, hasCompat: true });
          }
          // modular (exposed by firebaseInit on window.fb if you ever swap)
          if (typeof fb.getAuth === 'function') {
            const auth = fb.getAuth();
            if (auth) return resolve({ fb, auth, hasCompat: false });
          }
        } catch (_) { /* ignore and retry */ }

        if (Date.now() - start > timeoutMs) {
          return reject(new Error('No Firebase Auth found'));
        }
        setTimeout(check, intervalMs);
      })();
    });
  }

  function isIndexPage() {
    const p = (location.pathname || '').toLowerCase();
    return p.endsWith('/index.html') || p === '/' || p.endsWith('/public/') || p.endsWith('/public');
  }

  function removeClientLoginHashIfNotIndex() {
    if (location.hash === '#client-login' && !isIndexPage()) {
      log('removing #client-login hash on non-index page');
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    log('file loaded');
    removeClientLoginHashIfNotIndex();

    try {
      // Prefer the explicit signal from firebaseInit.js
      if (typeof window.onFirebaseReady === 'function') {
        await new Promise((res) => window.onFirebaseReady(res));
      } else {
        // Fallback: polling (previous behavior)
        await waitForFirebaseAuth();
      }

      const fb = window.fb || window.firebase || {};
      const auth = fb.auth ? fb.auth() : (fb.getAuth ? fb.getAuth() : null);
      if (!auth) throw new Error('No Firebase Auth found after wait');

      log('auth ready ->', { appName: auth.app?.name, signedIn: !!auth.currentUser });

      // Subscribe to auth state
      const onAuthStateChanged =
        auth.onAuthStateChanged?.bind(auth) || fb.onAuthStateChanged || (() => () => {});
      onAuthStateChanged((user) => {
        let sess = null;
        try {
          const s = sessionStorage.getItem('dr:session');
          if (s) sess = JSON.parse(s);
        } catch { /* ignore */ }

        const describe = user
          ? {
              uid: user.uid,
              email: user.email || '',
              businessKey: sess?.businessKey || null,
              isOwner: !!sess?.isOwner,
            }
          : { user: null };

        log('auth state changed:', describe);
        // No redirects here; protected routes handled elsewhere.
      });
    } catch (e) {
      // Don’t interrupt page load; other scripts will still get Auth when ready.
      warn(e.message || e);
      console.warn('[session-classic] Auth not ready yet; continuing without popup.');
    }
  });
})();