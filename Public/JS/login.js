// login.js (module)
if (!window.firebase || !firebase.apps?.length) {
  console.error('[init] Firebase not initialized. Ensure firebaseInit.js is included BEFORE this file.');
} else {
  var auth    = firebase.auth();
  var db      = firebase.firestore();
  var storage = firebase.storage(); // only where needed (file manager)
}

import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, getDoc
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
const auth = getAuth();
const db = getFirestore();

function onReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

async function resolveBusinessKey(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  if (snap.exists()) {
    const u = snap.data();
    return u.businessKey ?? u.business ?? null;
  }
  return null;
}

// JS/login.js
document.addEventListener('DOMContentLoaded', () => {
  const loginBtn = document.querySelector('#btnLogin,[data-login],button[name="login"]');
  const emailEl  = document.querySelector('#email,[name="email"]');
  const passEl   = document.querySelector('#password,[name="password"]');

  if (!loginBtn || !emailEl || !passEl) {
    console.warn('[login] Missing login elements on this page');
    return;
  }

  loginBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const email = emailEl.value.trim();
      const pass  = passEl.value;

      await auth.signInWithEmailAndPassword(email, pass);

      // Pull the business key for this user
      const uid = auth.currentUser.uid;
      const snap = await db.collection('users').doc(uid).get();
      const biz  = snap.data()?.businessKey;
      if (!biz) throw new Error('No businessKey on user profile');

      // Redirect to dashboard
      location.href = `dashboard.html?business=${encodeURIComponent(biz)}`;
    } catch (err) {
      console.error('[login] failed:', err);
      alert(err.message);
    }
  });
});

onReady(() => {
  const loginBtn =
    document.getElementById('loginBtn') ||
    document.getElementById('btnLogin') ||
    document.querySelector('[data-login], button[name="login"]');
  if (!loginBtn) {
    console.error('Login button not found. Give it id="loginBtn" or [data-login].');
    return;
  }
  loginBtn.addEventListener('click', onLogin);
});

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  const biz = await resolveBusinessKey(user.uid);
  if (biz) location.href = `./dashboard.html?business=${encodeURIComponent(biz)}`;
});