/* Public/js/login-simple.js */
(function () {
  const form  = document.getElementById('loginForm');
  const email = document.getElementById('loginEmail');
  const pass  = document.getElementById('loginPassword');
  const msg   = document.getElementById('loginMsg');

  if (!form) return;

  const say = (t) => { if (msg) msg.textContent = t; };

  // Wait until firebaseInit has created window.auth
  const waitForAuth = () => new Promise((resolve) => {
    if (window.auth) return resolve(window.auth);
    const iv = setInterval(() => {
      if (window.auth) { clearInterval(iv); resolve(window.auth); }
    }, 50);
    setTimeout(() => { clearInterval(iv); resolve(null); }, 5000);
  });

  (async () => {
    const a = await waitForAuth();
    if (!a) { console.error('Firebase auth not ready'); say('Please reload.'); return; }

    // OPTIONAL: If you always want a fresh login on the home page while testing:
    // try { await a.signOut(); } catch {}

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      say('Signing in…');
      try {
        // Keep session between tabs; change to NONE if you want “no persistence”
        await a.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        await a.signInWithEmailAndPassword((email?.value || '').trim(), pass?.value || '');
        say('OK. Redirecting…');
        location.href = './dashboard.html';
      } catch (err) {
        console.error(err);
        say(err?.message || 'Could not sign in.');
      }
    });
  })();
})();