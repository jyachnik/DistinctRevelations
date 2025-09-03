/// /Public/JS/projectProgress.js
/// Vertical progress bar (owner can click to set 0–100); live updates for everyone.
/// Uses Firebase **compat** globals from firebaseInit.js: window.auth, window.db

const { auth, db } = window;
const OWNER_EMAIL = "john@distinctrevelations.com";

/* ---------------- business key sync ---------------- */
function getBizKeyImmediate() {
  return new URL(location.href).searchParams.get("business") || window.BIZ_KEY || null;
}
function onBizReady(cb) {
  const k = getBizKeyImmediate();
  if (k) return cb(k);
  window.addEventListener("business:ready", (e) => cb(e.detail.businessKey), { once: true });
}

/* ---------------- DOM (same ids you already use) ---- */
function getNodes() {
  const container = document.getElementById("progress-bar-container") || document.querySelector("[data-progress-container]");
  const fillElem  = document.getElementById("progress-bar-fill")       || document.querySelector("[data-progress-fill]");
  const labelElem = document.getElementById("progress-label")          || document.querySelector("[data-progress-label]");
  return { container, fillElem, labelElem };
}
function updateUI(fillElem, labelElem, value) {
  if (!fillElem || !labelElem) return;
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  fillElem.style.height = v + "%";
  labelElem.textContent = v + "%";
  labelElem.style.bottom = v + "%";
}

/* ---------------- Firestore helpers ----------------- */
function businessDoc(biz) {
  return db.collection("businesses").doc(biz);
}

/* ---------------- Boot ------------------------------ */
(function init() {
  const { container, fillElem, labelElem } = getNodes();
  if (!container || !fillElem || !labelElem) {
    // Not on this page — do nothing
    return;
  }

  onBizReady((businessKey) => {
    auth.onAuthStateChanged((user) => {
      const isOwner = !!user && String(user.email || "").toLowerCase() === OWNER_EMAIL;

      // Initial load + live updates
      businessDoc(businessKey).onSnapshot(
        (snap) => {
          const data = snap.exists ? (snap.data() || {}) : {};
          // Support both field names to stay compatible with your older header.js
          const pct = Number(data.progress ?? data.projectProgress ?? 0);
          updateUI(fillElem, labelElem, pct);
        },
        (err) => console.warn("Progress: listener error", err && (err.message || err))
      );

      // Owner only: click to set new % and persist to both fields (keeps header in sync)
      if (isOwner) {
        container.style.cursor = "pointer";
        container.addEventListener("click", async (e) => {
          const rect = container.getBoundingClientRect();
          const clickY = e.clientY - rect.top;
          let newPct = Math.round(((rect.height - clickY) / rect.height) * 100);
          newPct = Math.max(0, Math.min(100, newPct));
          try {
            await businessDoc(businessKey).set(
              { progress: newPct, projectProgress: newPct },
              { merge: true }
            );
            // UI will catch up via onSnapshot, but we can reflect immediately too
            updateUI(fillElem, labelElem, newPct);
          } catch (err) {
            console.error("Progress: save failed", err);
            alert("Failed to save progress.");
          }
        });
      } else {
        container.style.cursor = "default";
      }
    });
  });
})();