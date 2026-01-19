/* /JS/register.js — remove module imports */
if (!window.onFirebaseReady) console.error('Load firebaseInit.js first');

window.onFirebaseReady.then(function () {
  var form = document.getElementById('registerForm');
  if (!form) return;
  var msg = document.getElementById('registerMsg');

  function setMsg(t, ok) { if (msg) { msg.textContent = t; msg.style.color = ok ? '#2f9e44' : '#d33'; } }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name  = (form.querySelector('#regName') || {}).value || '';
    var email = (form.querySelector('#regEmail') || {}).value || '';
    var pass  = (form.querySelector('#regPassword') || {}).value || '';

    setMsg('Creating account…');

    auth.createUserWithEmailAndPassword(email, pass).then(function (cred) {
      if (name) cred.user.updateProfile({ displayName: name }).catch(function(){});
      return db.collection('users').doc(cred.user.uid).set({
        displayName: name || null,
        email: email,
        businessKey: null,
        role: 'user',
        approved: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }).then(function () {
      setMsg('Account created. Please verify your email.', true);
      try { cred && cred.user && cred.user.sendEmailVerification(); } catch(e) {}
      form.reset();
    }).catch(function (err) {
      console.error(err);
      setMsg('Could not create account: ' + (err.message || err.code));
    });
  });
});