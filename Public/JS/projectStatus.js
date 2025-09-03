// /Public/JS/projectStatus.js
// Project Status controller using Firebase compat (window.auth, window.db).
// Works with your HTML structure: .project-status .status-options [data-status]

const { auth, db } = window;
const OWNER_EMAIL = "john@distinctrevelations.com";

/* business key sync */
function getBizKeyImmediate() {
  return new URL(location.href).searchParams.get("business") || window.BIZ_KEY || null;
}
function onBizReady(cb) {
  const k = getBizKeyImmediate();
  if (k) return cb(k);
  window.addEventListener("business:ready", (e) => cb(e.detail.businessKey), { once: true });
}

/* DOM */
function getNodes() {
  const optionsRoot = document.querySelector(".project-status .status-options");
  const optionLights = optionsRoot ? optionsRoot.querySelectorAll("[data-status]") : [];
  return { optionsRoot, optionLights };
}
function highlight(optionLights, status) {
  optionLights.forEach(el => {
    const active = String(el.dataset.status || "").toLowerCase() === String(status || "").toLowerCase();
    el.classList.toggle("active", active);
    el.classList.toggle("selected", active); // support either classname
  });
}

/* FS helpers */
function businessDoc(biz) {
  return db.collection("businesses").doc(biz);
}

/* Boot */
(function init() {
  const { optionsRoot, optionLights } = getNodes();
  if (!(optionsRoot && optionLights.length)) {
    // Not on this page
    return;
  }

  onBizReady((businessKey) => {
    auth.onAuthStateChanged((user) => {
      const isOwner = !!user && String(user.email || "").toLowerCase() === OWNER_EMAIL;

      // Live updates
      businessDoc(businessKey).onSnapshot(
        (snap) => {
          const data = snap.exists ? (snap.data() || {}) : {};
          const status = data.status || "onTrack";
          highlight(optionLights, status);
        },
        (err) => console.warn("projectStatus: listener error:", err && (err.message || err))
      );

      if (isOwner) {
        optionsRoot.style.cursor = "pointer";
        optionLights.forEach(light => {
          light.addEventListener("click", async () => {
            const newStatus = light.dataset.status;
            try {
              await businessDoc(businessKey).set({ status: newStatus }, { merge: true });
            } catch (e) {
              console.error("projectStatus: save failed", e);
              alert("Failed to save project status.");
            }
          });
        });
      } else {
        optionsRoot.style.cursor = "default";
      }
    });
  });
})();

/* legacy export to satisfy existing inline import */
export function initProjectStatus() {}