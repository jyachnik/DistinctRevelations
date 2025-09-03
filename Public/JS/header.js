// /Public/JS/header.js
// Firebase COMPAT (uses window.auth, window.db, window.storage set by firebaseInit.js)
// Read-only for clients; admin (john@distinctrevelations.com) can update logo/status/progress.

const { auth, db, storage } = window;
const OWNER_EMAIL = "john@distinctrevelations.com";

// -------- business key sync --------
function getBizKeyImmediate() {
  return new URL(location.href).searchParams.get("business") || window.BIZ_KEY || null;
}
function onBizReady(cb) {
  const k = getBizKeyImmediate();
  if (k) return cb(k);
  window.addEventListener("business:ready", (e) => cb(e.detail.businessKey), { once: true });
}

// -------- DOM (support common ids; first that exists wins) --------
const pick = (...ids) => ids.map(id => document.getElementById(id)).find(Boolean);
const $logoImg   = pick("companyLogo","businessLogo","headerLogo");
const $nameEl    = pick("companyName","businessName","headerCompanyName");
const $statusEl  = pick("projectStatus","statusBadge","headerStatus");
const $progress  = pick("projectProgress","progressBar","headerProgress");
const $saveBtn   = pick("saveHeaderBtn","headerSave");
const $logoInput = pick("logoFile","logoUpload");
const $statusSel = pick("statusSelect","headerStatusSelect");
const $progInput = pick("progressInput","headerProgressInput");

let businessKey = null;
let isOwner = false;

function applyReadOnly() {
  [$saveBtn,$logoInput,$statusSel,$progInput].forEach(el => { if (el) el.style.display = isOwner ? "" : "none"; });
}

async function loadHeader() {
  try {
    const snap = await db.collection("businesses").doc(businessKey).get();
    const data = snap.exists ? (snap.data() || {}) : {};
    if ($nameEl)   $nameEl.textContent = data.name || $nameEl.textContent || "";
    if ($statusEl) $statusEl.textContent = data.status || "Active";
    if ($progress) {
      const v = Number(data.progress ?? 0);
      if ($progress.tagName === "PROGRESS") $progress.value = v;
      else $progress.style.width = `${Math.max(0, Math.min(100, v))}%`;
    }
    if ($logoImg && data.logoUrl) $logoImg.src = data.logoUrl;

    if ($statusSel) $statusSel.value = data.status || "Active";
    if ($progInput) $progInput.value = Number(data.progress ?? 0);
  } catch (e) {
    console.warn("Header: load failed", e.message || e);
  }
}

async function saveHeader() {
  if (!isOwner) return;

  const patch = {};
  if ($statusSel) patch.status = $statusSel.value || "Active";
  if ($progInput) patch.progress = Number($progInput.value || 0);

  // optional logo upload
  if ($logoInput && $logoInput.files && $logoInput.files[0]) {
    const f = $logoInput.files[0];
    const safe = f.name.replace(/[^\w.\-() ]+/g, "_");
    const path = `logos/${businessKey}/${Date.now()}_${safe}`;
    try {
      await storage.ref(path).put(f);
      patch.logoUrl = await storage.ref(path).getDownloadURL();
    } catch (e) {
      console.error("Header: logo upload failed", e);
      alert("Logo upload failed.");
    }
  }

  try {
    await db.collection("businesses").doc(businessKey).set(patch, { merge: true });
    await loadHeader();
  } catch (e) {
    console.error("Header: save failed", e);
    alert("Could not save header.");
  }
}

(function init() {
  // If none of the header nodes exist on this page, skip silently.
  if (!($logoImg || $nameEl || $statusEl || $progress || $saveBtn || $logoInput || $statusSel || $progInput)) return;

  onBizReady((biz) => {
    businessKey = biz;

    if (!auth || typeof auth.onAuthStateChanged !== "function") {
      console.warn("Header: auth not available; loading read-only");
      loadHeader();
      return;
    }

    auth.onAuthStateChanged((user) => {
      isOwner = !!user && String(user.email || "").toLowerCase() === OWNER_EMAIL;
      applyReadOnly();
      loadHeader();
      if ($saveBtn) $saveBtn.onclick = saveHeader;
    });
  });
})();