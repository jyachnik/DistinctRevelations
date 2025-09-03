/* /Public/JS/firebaseInit.js */
(function () {
  const firebaseConfig = {
    apiKey: "AIzaSyDL2A4DnV6qC3_m-wAw8gIuo99QGI0xs4g",
    authDomain: "distinct-revelations.firebaseapp.com",
    databaseURL: "https://distinct-revelations-default-rtdb.firebaseio.com",
    projectId: "distinct-revelations",
    storageBucket: "distinct-revelations.appspot.com",   // <-- fix this
    messagingSenderId: "545119150837",
    appId: "1:545119150837:web:894dc80daf9a5aa416dbbc",
    measurementId: "G-CGG8EDHMHC"
  };

  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
    console.log('Firebase init OK');
  }

  window.auth    = firebase.auth();
  window.db      = firebase.firestore();
  window.storage = firebase.storage();
})();