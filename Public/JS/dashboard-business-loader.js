// /Public/JS/dashboard-business-loader.js
// Minimal loader that exposes the business key and starts File Manager.
// Uses Firebase compat globals from firebaseInit.js via window.auth.

import { loadFileManager } from "./filemanager.js"; // ✅ fixed path

(function () {
  const params = new URLSearchParams(location.search);
  const biz = params.get("business") || window.BIZ_KEY || null;

  if (biz) {
    window.BIZ_KEY = biz;
    window.dispatchEvent(new CustomEvent("business:ready", { detail: { businessKey: biz }}));
  } else {
    console.warn("dashboard-business-loader: no ?business= in URL");
  }

  const { auth } = window;
  if (auth && typeof auth.onAuthStateChanged === "function" && biz) {
    auth.onAuthStateChanged((user) => {
      if (!user) return;
      try { loadFileManager(biz, user.email || ""); }
      catch (e) { console.warn("dashboard-business-loader: loadFileManager failed:", e); }
    });
  }
})();