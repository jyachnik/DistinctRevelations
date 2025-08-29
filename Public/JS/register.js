// /Public/js/register.js
import { auth, db } from "../firebaseInit.js";
import {
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { doc, setDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  const form = $("registerForm");
  if (!form) return;

  const nameEl  = $("regName");
  const emailEl = $("regEmail");
  const passEl  = $("regPassword");

  // use existing <p id="registerMsg"> or create one
  let msgEl = $("registerMsg") || $("registerStatus");
  if (!msgEl) {
    msgEl = document.createElement("p");
    msgEl.id = "registerMsg";
    msgEl.className = "hint";
    form.appendChild(msgEl);
  }
  const setMsg = (t, ok=false) => {
    msgEl.textContent = t;
    msgEl.style.color = ok ? "#7bd389" : "#ffb3b3";
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setMsg("");

    const name  = (nameEl?.value || "").trim();
    const email = (emailEl?.value || "").trim();
    const pass  =  passEl?.value || "";

    if (!name || !email || pass.length < 6) {
      setMsg("Please fill all fields (password 6+ chars).");
      return;
    }

    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;

    try {
      // 1) Create Auth user
      const cred = await createUserWithEmailAndPassword(auth, email, pass);

      // 2) Optional display name
      await updateProfile(cred.user, { displayName: name }).catch(()=>{});

      // 3) Create user profile doc
      await setDoc(doc(db, "users", cred.user.uid), {
        displayName: name,
        email,
        businessKey: null,    // you can set this later as admin
        role: "user",
        approved: false,
        createdAt: serverTimestamp()
      }, { merge: true });

      // 4) Optional: verification email
      await sendEmailVerification(cred.user).catch(()=>{});

      setMsg("Account created! Please check your email to verify.", true);
      form.reset();

      // close the modal after a moment
      const modal = form.closest(".modal");
      if (modal) setTimeout(() => {
        modal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("no-scroll");
      }, 1200);

    } catch (err) {
      console.error("register error:", err);
      const map = {
        "auth/operation-not-allowed": "Enable Email/Password in Firebase Auth.",
        "auth/email-already-in-use": "That email is already in use.",
        "auth/invalid-email": "That email address looks invalid.",
        "auth/weak-password": "Password must be at least 6 characters.",
        "auth/network-request-failed": "Network error. Please try again."
      };
      setMsg(map[err.code] || `${err.code || "error"}: ${err.message || "Could not create account."}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
});