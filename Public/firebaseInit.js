// firebaseInit.js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js';
import { getAuth }        from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';
import { getFirestore }   from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';
import { getStorage }     from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-storage.js';

const firebaseConfig = {
  apiKey: "AIzaSyDL2A4DnV6qC3_m-wAw8gIuo99QGI0xs4g",
      authDomain: "distinct-revelations.firebaseapp.com",
      projectId: "distinct-revelations",
      storageBucket: "distinct-revelations.firebasestorage.app",
      messagingSenderId: "545119150837",
      appId: "1:545119150837:web:894dc80daf9a5aa416dbbc"
};

const app     = initializeApp(firebaseConfig);
const auth    = getAuth(app);
const db      = getFirestore(app);
const storage = getStorage(app);

console.log('✅ firebaseInit.js: app, auth, db, storage ready');

// export all four
export { app, auth, db, storage };