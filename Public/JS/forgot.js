/* /JS/forgot.js */

console.log('[forgot] script loaded');

document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('forgotForm');
  var msg  = document.getElementById('forgotMsg');

  if (!form) {
    console.error('[forgot] form not found');
    return;
  }

  function setMsg(t, ok) {
    if (msg) {
      msg.textContent = t;
      msg.style.color = ok ? '#2f9e44' : '#d33';
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var emailInput = form.querySelector('[name="email"]');
    var email = emailInput ? emailInput.value.trim() : '';
    console.log('[forgot] submitting', email);

    if (!email) {
      setMsg('Please enter your email.');
      return;
    }

    var auth = window.auth;
    if (!auth) {
      console.error('[forgot] window.auth is missing');
      setMsg('Auth not ready.');
      return;
    }

    setMsg('Sending…');

    auth.sendPasswordResetEmail(email)
      .then(function () {
        console.log('[forgot] reset email sent');
        setMsg('Reset email sent.', true);
      })
      .catch(function (err) {
        console.error('[forgot] error', err);
        setMsg(err.message || 'Could not send reset email.');
      });
  });
});