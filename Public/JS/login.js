// login.js
import { auth, db } from './firebaseInit.js';
import { signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

const loginBtn = document.getElementById('loginBtn');
const errorMsg = document.getElementById('errorMsg');

loginBtn.addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  errorMsg.textContent = '';

  try {
    console.log('🔒 Attempting login for:', email);
    const { user } = await signInWithEmailAndPassword(auth, email, password);
    console.log('✅ Firebase signIn succeeded:', user.uid);

    // --- OWNER BYPASS ---
    if (email === 'john@distinctrevelations.com') {
      // this function should pop up your business-select modal
      window.showBusinessModalForOwner(user);
      return;
    }

    // --- REGULAR USER PATH ---
    const userRef = doc(db, 'users', user.uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      throw new Error('No user profile found in Firestore.');
    }
    const { businessKey } = userSnap.data();
    if (!businessKey) {
      throw new Error('Your account is not yet assigned to a business.');
    }

    // Redirect to dashboard
    window.location.href = `dashboard.html?business=${businessKey}`;

  } catch (err) {
    console.error('🔥 login error:', err.code, err.message);
    let msg = 'Login failed. Please try again.';
    switch (err.code) {
      case 'auth/invalid-email':
        msg = 'Invalid email format.';
        break;
      case 'auth/user-not-found':
        msg = 'No account found with that email.';
        break;
      case 'auth/wrong-password':
        msg = 'Incorrect password.';
        break;
      // Firestore lookup errors fall through below
    }
    if (err.message.startsWith('No user profile')) {
      msg = err.message;
    }
    errorMsg.textContent = `❌ ${msg}`;
  }
});