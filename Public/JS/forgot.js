// /Public/forgot.js
const { auth, db } = window;
import { sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";

const $ = (id) => document.getElementById(id);
const ok = (el, msg) => { el.textContent = msg; el.style.color = "#7bd389"; };
const err = (el, msg) => { el.textContent = msg; el.style.color = "#ffb3b3"; };

document.addEventListener("DOMContentLoaded", () => {
  const form = $("forgotForm");
  if (!form) return;

  const emailEl = $("forgotEmail");
  let msgEl = $("forgotMsg");
  if (!msgEl) {
    msgEl = document.createElement("p");
    msgEl.id = "forgotMsg";
    msgEl.className = "hint";
    form.appendChild(msgEl);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = (emailEl?.value || "").trim();
    if (!email) return err(msgEl, "Please enter your email.");

    try {
      // default hosted reset page (no redirect needed)
      await sendPasswordResetEmail(auth, email);
      ok(msgEl, "Reset link sent. Check your inbox (and spam).");

      // Optional: auto-close modal after a short pause
      setTimeout(() => {
        const modal = document.getElementById("forgotModal");
        if (modal) modal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("no-scroll");
      }, 1200);
    } catch (e) {
      const map = {
        "auth/invalid-email": "That email address looks invalid.",
        "auth/user-not-found": "No account with that email.",
        "auth/too-many-requests": "Too many attempts. Try again shortly.",
        "auth/network-request-failed": "Network error. Please try again."
      };
      err(msgEl, map[e.code] || `Could not send reset email (${e.code}).`);
      console.error("Forgot password error:", e);
    }
  });
});