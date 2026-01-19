// signup.js

(function () {
  const $ = (id) => document.getElementById(id);

  document.addEventListener('DOMContentLoaded', () => {
    const form = $('signupForm');
    if (!form) return;

    const firstEl    = $('su-first');
    const lastEl     = $('su-last');
    const businessEl = $('su-business');
    const emailEl    = $('su-email');
    const phoneEl    = $('su-phone');
    const passEl     = $('su-pass');
    const pass2El    = $('su-pass2');
    const statusEl   = $('su-status');

    async function handleSignup(e) {
      e.preventDefault();

      const first    = (firstEl.value || '').trim();
      const last     = (lastEl.value || '').trim();
      const business = (businessEl.value || '').trim();
      const email    = (emailEl.value || '').trim().toLowerCase();
      const phone    = (phoneEl.value || '').trim();
      const pass     = passEl.value || '';
      const pass2    = pass2El.value || '';

      if (!first || !last || !business || !email || !phone || !pass || !pass2) {
        statusEl.textContent = 'Please fill in all fields.';
        statusEl.style.color = '#ff6b6b';
        return;
      }

      if (pass !== pass2) {
        statusEl.textContent = 'Passwords do not match.';
        statusEl.style.color = '#ff6b6b';
        return;
      }

      try {
        statusEl.textContent = 'Creating account…';
        statusEl.style.color = '';

        const cred = await window.auth.createUserWithEmailAndPassword(email, pass);
        const user = cred.user;

        const db = window.db;
        const fb = window.firebase;

        // Normalize business name to use as ID + lookup key
        const businessKey  = business.trim();              // what you want to see under /businesses
        const businessNorm = businessKey.toLowerCase();    // for searches

        // 1) Find or create business at /businesses/{businessKey}
        const bizRef = db.collection('businesses').doc(businessKey);
        const bizSnap = await bizRef.get();

        if (bizSnap.exists) {
          // Optionally update name fields if needed
          await bizRef.set(
            {
              name:      businessKey,
              nameLower: businessNorm
            },
            { merge: true }
          );
        } else {
          await bizRef.set({
            name:      businessKey,
            nameLower: businessNorm,
            createdAt: fb.firestore.FieldValue.serverTimestamp()
          });
        }

        // 2) Store user profile and mapping at /users/{email}
        //    This is what login-simple.js expects for non-owners.
        await db.collection('users').doc(user.uid).set({
  uid:          user.uid,
  firstName:    first,
  lastName:     last,
  businessName: businessKey,
  businessKey:  businessKey,
  business:     businessKey,
  email:        email,
  phone:        phone,
  createdAt:    fb.firestore.FieldValue.serverTimestamp()
}, { merge: true });
// 3) Add user into /businesses/{businessKey}/users for Q&A assignees
await db.collection('businesses')
  .doc(businessKey)
  .collection('users')
  .doc(user.uid)        // or email, but be consistent
  .set({
    uid:       user.uid,
    email:     email,
    firstName: first,
    lastName:  last,
    role:      'member',
    addedAt:   fb.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  
        statusEl.textContent = 'Account created. You can now log in.';
        statusEl.style.color = '#7bd389';
        form.reset();
      } catch (err) {
        console.error('[signup] error', err);
        statusEl.textContent = err && err.message ? err.message : 'Could not create account.';
        statusEl.style.color = '#ff6b6b';
      }
    }

    form.addEventListener('submit', handleSignup);
  });
})();
