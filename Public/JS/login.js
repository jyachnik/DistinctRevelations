// login.js
import { auth, db } from '../firebaseInit.js';
import { signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  const form = $('loginForm');
  if (!form) {
    console.warn('loginForm not found');
    return;
  }

  const emailEl = $('loginEmail');
  const passEl  = $('loginPassword');

  // feedback line (create if missing)
  let msgEl = $('loginMsg');
  if (!msgEl) {
    msgEl = document.createElement('p');
    msgEl.id = 'loginMsg';
    msgEl.className = 'hint';
    form.appendChild(msgEl);
  }

  const setMsg = (text, ok = false) => {
    msgEl.textContent = text || '';
    msgEl.style.color = ok ? '#7bd389' : '#ffb3b3';
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('');
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const email = (emailEl?.value || '').trim();
      const pass  = passEl?.value || '';
      if (!email || !pass) { setMsg('Enter email and password.'); return; }

      const cred = await signInWithEmailAndPassword(auth, email, pass);
      const user = cred.user;

      // Owner bypass → show business selector modal if you have it
      if (email.toLowerCase() === 'john@distinctrevelations.com') {
        if (window.showBusinessModalForOwner) {
          window.showBusinessModalForOwner(user);
          return; // stay on page
        }
        // fallback: go to an owner dashboard
        window.location.href = 'dashboard.html';
        return;
      }

      // Regular user → look up businessKey
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (!snap.exists()) throw new Error('no-profile');
      const data = snap.data();
      if (!data.businessKey) throw new Error('no-business');

      // Redirect to company dashboard
      window.location.href = `dashboard.html?business=${encodeURIComponent(data.businessKey)}`;
    } catch (err) {
      console.error('login error:', err);
      const map = {
        'auth/invalid-email':  'Invalid email address.',
        'auth/user-not-found': 'No account with that email.',
        'auth/wrong-password': 'Incorrect password.',
        'auth/user-disabled':  'This account is disabled.',
      };
      if (map[err.code]) setMsg(`❌ ${map[err.code]}`);
      else if (err.message === 'no-profile')  setMsg('❌ No user profile found in Firestore.');
      else if (err.message === 'no-business') setMsg('❌ Your account isn’t assigned to a business yet.');
      else setMsg('❌ Login failed. Please try again.');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
});