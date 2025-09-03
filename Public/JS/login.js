// /Public/JS/login.js  (Firebase COMPAT: uses window.auth, window.db)
const { auth, db } = window;
const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  
 
  
  const form = $('loginForm');
  if (!form) return;

 if (form.dataset.bound === '1') return;
form.dataset.bound = '1';


  const emailEl = $('loginEmail');
  const passEl  = $('loginPassword');

  let msgEl = $('loginMsg');
  if (!msgEl) {
    msgEl = document.createElement('p');
    msgEl.id = 'loginMsg';
    msgEl.className = 'hint';
    form.appendChild(msgEl);
  }
  const setMsg = (t, ok=false) => {
    msgEl.textContent = t || '';
    msgEl.style.color = ok ? '#7bd389' : '#ffb3b3';
  };

  let busy = false;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    setMsg('');

    try {
      const email = (emailEl?.value || '').trim();
      const pass  = passEl?.value || '';
      if (!email || !pass) { setMsg('Enter email and password.'); return; }

      // DIAGNOSTIC: log origin so you can confirm it’s on the allowed domain list
      console.log('Origin:', location.origin);

      // AUTH (compat)
      const cred = await auth.signInWithEmailAndPassword(email, pass);
      const user = cred.user;

      if (email.toLowerCase() === 'john@distinctrevelations.com') {
        if (window.showBusinessModalForOwner) {
          window.showBusinessModalForOwner(user);
          return;
        }
        window.location.href = 'dashboard.html';
        return;
      }

      // PROFILE (compat)
      const snap = await db.collection('users').doc(user.uid).get();
      if (!snap.exists) throw new Error('no-profile');

      const data = snap.data() || {};
      const bizKey = data.businessKey;
      if (!bizKey) throw new Error('no-business');

      window.location.href = `dashboard.html?business=${encodeURIComponent(bizKey)}`;

    } catch (err) {
      console.error('login error:', err);
      // Show the exact code/message to speed up debugging
      if (err && err.code) console.warn('Auth code:', err.code);
      if (err && err.message) console.warn('Auth message:', err.message);

      const map = {
        'auth/invalid-email':         'Invalid email address.',
        'auth/user-not-found':        'No account with that email.',
        'auth/wrong-password':        'Incorrect password.',
        'auth/user-disabled':         'This account is disabled.',
        'auth/network-request-failed':'Network error. Please try again.',
        'auth/operation-not-allowed': 'Email/password sign-in is disabled.',
        'auth/too-many-requests':     'Too many attempts. Try again later.'
      };
      if (map[err.code]) setMsg(`❌ ${map[err.code]}`);
      else if (err.message === 'no-profile')  setMsg('❌ No user profile found in Firestore.');
      else if (err.message === 'no-business') setMsg('❌ Your account isn’t assigned to a business yet.');
      else setMsg('❌ Login failed. Check console for details.');
    } finally {
      busy = false; // allow another try
      if (submitBtn) submitBtn.disabled = false;
    }
  });
});