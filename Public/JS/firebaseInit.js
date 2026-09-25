// /Public/JS/firebaseInit.js  — compat SDK initializer (no "type=module")
(function () {
  const TAG = "[firebaseInit]";

  // Using compat SDKs loaded via <script src="...firebase-*-compat.js">
  // DO NOT convert this file to ESM or add "type=module".
  if (!window.firebase || !firebase.app) {
    console.error(TAG, "Firebase compat SDKs not loaded yet.");
    return;
  }

  // >>>>>>  MAKE SURE THESE VALUES MATCH YOUR FIREBASE PROJECT  <<<<<<
  // (Only storageBucket was the blocker in your logs.)
  const firebaseConfig = {
    apiKey: "AIzaSyDL2A4DnV6qC3_m-wAw8gIuo99QGI0xs4g",
  authDomain: "distinct-revelations.firebaseapp.com",
  databaseURL: "https://distinct-revelations-default-rtdb.firebaseio.com",
  projectId: "distinct-revelations",
  storageBucket: "distinct-revelations.firebasestorage.app",
  messagingSenderId: "545119150837",
  appId: "1:545119150837:web:894dc80daf9a5aa416dbbc",
  measurementId: "G-CGG8EDHMHC"
  };

  // Initialize (compat)
  const app = firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const storage = firebase.storage();
  // Guarded — not every page that loads this file also loads the
  // firebase-functions-compat SDK, and this file must not throw either way.
  const functionsInstance = typeof firebase.functions === 'function' ? firebase.functions() : null;

  // Expose globals (your other scripts rely on these names)
  window.firebaseApp = app;
  window.auth = auth;
  window.db = db;
  window.storage = storage;
  window.functions = functionsInstance;

  // handy namespaces used in other files
  window.firebaseFirestore = firebase.firestore;
  window.fbstore = firebase.storage;

  console.log(TAG, "initialized compat 10.12.2");
  console.log(TAG, "Storage bound to bucket →", app.options.storageBucket);

  // Signal readiness just like your working pattern
  document.dispatchEvent(new Event("firebase-ready"));
  window.dispatchEvent(new Event("firebase-ready"));
})();