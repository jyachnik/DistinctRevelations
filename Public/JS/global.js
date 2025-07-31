// scripts/global.js
import {
  getAuth,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

document.addEventListener("DOMContentLoaded", () => {
  // --- Firebase ---
  const auth = getAuth();
  const db   = getFirestore();

  // --- Modal Elements ---
  const regModal     = document.getElementById("registerModal");
  const fgtModal     = document.getElementById("forgotPasswordModal");
  const openRegBtn   = document.getElementById("openRegisterModal");
  const closeRegBtn  = document.getElementById("closeRegisterModal");
  const openFgtBtn   = document.getElementById("openForgotModal");
  const closeFgtBtn  = document.getElementById("closeForgotModal");

  const loginSection = document.getElementById("loginSection");    // if you have a login modal
  const openLoginBtn = document.getElementById("openLoginModal");  // optional
  const closeLoginBtn= document.getElementById("closeLoginModal");

  // Helper to show/hide
  function toggle(modal, show) {
    if (show) modal.classList.remove("hidden");
    else      modal.classList.add("hidden");
  }

  // --- Modal Controls ---
  openRegBtn.addEventListener("click", e => { e.preventDefault(); toggle(regModal, true); });
  closeRegBtn.addEventListener("click", () => toggle(regModal, false));
  openFgtBtn.addEventListener("click", e => { e.preventDefault(); toggle(fgtModal, true); });
  closeFgtBtn.addEventListener("click", () => toggle(fgtModal, false));

  // Close on backdrop click
  [regModal, fgtModal].forEach(modal => {
    modal.addEventListener("click", e => {
      if (e.target === modal) toggle(modal, false);
    });
  });

  // --- Register Form ---
  const registerForm   = document.getElementById("registerForm");
  const registerStatus = document.getElementById("registerStatus");

  registerForm.addEventListener("submit", async e => {
    e.preventDefault();
    registerStatus.textContent = "Registering…";

    const {
      firstName,
      lastName,
      businessName,
      businessCategory,
      address1,
      address2,
      city,
      state,
      zip,
      phone,
      registerEmail,
      registerPassword
    } = registerForm.elements;

    try {
      // 1) Auth
      const cred = await createUserWithEmailAndPassword(
        auth,
        registerEmail.value.trim(),
        registerPassword.value
      );

      // 2) Firestore profile
      await setDoc(doc(db, "users", cred.user.uid), {
        firstName: firstName.value.trim(),
        lastName:  lastName.value.trim(),
        businessName: businessName.value.trim(),
        businessCategory: businessCategory.value,
        address1: address1.value.trim(),
        address2: address2.value.trim(),
        city: city.value.trim(),
        state: state.value.trim(),
        zip: zip.value.trim(),
        phone: phone.value.trim(),
        createdAt: new Date()
      });

      registerStatus.textContent = "Success! You can now log in.";
      registerForm.reset();
    } catch (err) {
      console.error(err);
      registerStatus.textContent = err.message;
    }
  });

  // --- Password Reset ---
  const resetEmail  = document.getElementById("resetEmail");
  const resetBtn    = document.getElementById("sendResetButton");
  const resetStatus = document.getElementById("resetStatus");

  resetBtn.addEventListener("click", async () => {
    const email = resetEmail.value.trim();
    resetStatus.textContent = "Sending reset email…";
    try {
      await sendPasswordResetEmail(auth, email);
      resetStatus.textContent = "Reset email sent! Check your inbox.";
    } catch (err) {
      console.error(err);
      resetStatus.textContent = err.message;
    }
  });

  // --- Optional: Login Form ---
  const loginForm = document.getElementById("loginForm");
  const loginStatus = document.getElementById("loginStatus");

  if (loginForm) {
    loginForm.addEventListener("submit", async e => {
      e.preventDefault();
      loginStatus.textContent = "Logging in…";
      const { loginEmail, loginPassword } = loginForm.elements;
      try {
        await signInWithEmailAndPassword(
          auth,
          loginEmail.value.trim(),
          loginPassword.value
        );
        loginStatus.textContent = "Logged in! Redirecting…";
        // e.g., window.location.href = "/dashboard.html";
      } catch (err) {
        console.error(err);
        loginStatus.textContent = err.message;
      }
    });
  }

  // --- (Placeholder) Business Selector ---
  // const bizModal = document.getElementById("businessModal");
  // ...wire up open/close and Firestore logic as needed...
});