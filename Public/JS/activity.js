// /Public/JS/activity.js
// Fully functional Activity module (COMPAT Firebase).
// - Waits for business key (from ?business= or window.BIZ_KEY or "business:ready" event)
// - Real-time listener (onSnapshot) scoped to a business
// - Owner-only UI: add/import/actions visible only to john@distinctrevelations.com
// - Click-to-sort on header cells with data-sort="activity|status|date"
// - Safe DOM guards so it never crashes if elements aren’t present

/* ---------------- Firebase (compat) ---------------- */
const { auth, db } = window; // set by firebaseInit.js
const OWNER_EMAIL = "john@distinctrevelations.com";

/* ---------------- Helpers ---------------- */
const $ = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);

function getBizKeyImmediate() {
  // URL first, then any global the loader set
  return new URL(location.href).searchParams.get("business") || window.BIZ_KEY || null;
}
function onBizReady(cb) {
  const k = getBizKeyImmediate();
  if (k) return cb(k);
  window.addEventListener("business:ready", (e) => cb(e.detail.businessKey), { once: true });
}

function fmtDate(raw) {
  if (!raw) return "";
  if (typeof raw === "string") {
    // Expecting YYYY-MM-DD
    const [y, m, d] = raw.split("-");
    if (y && m && d) return `${m.padStart(2, "0")}/${d.padStart(2, "0")}/${y}`;
    const dObj = new Date(raw);
    if (!isNaN(dObj)) {
      return [
        String(dObj.getMonth() + 1).padStart(2, "0"),
        String(dObj.getDate()).padStart(2, "0"),
        dObj.getFullYear(),
      ].join("/");
    }
    return raw;
  }
  if (raw && typeof raw.toDate === "function") {
    const dObj = raw.toDate();
    return [
      String(dObj.getMonth() + 1).padStart(2, "0"),
      String(dObj.getDate()).padStart(2, "0"),
      dObj.getFullYear(),
    ].join("/");
  }
  return "";
}

/* ---------------- DOM ---------------- */
const formEl      = $("activityForm");
const titleEl     = $("activityTitle");
const descEl      = $("activityDesc");
const statusEl    = $("activityStatus");
const dateEl      = $("activityDate");

const importBtn   = $("importBtn");
const fileInputEl = $("activityImport");
const browseBtn   = $("browseFilesBtn");

// Table support either <table id="activityTable"><tbody>… or a loose <tbody id="activityTbody">
const tableEl     = $("activityTable");
const tbodyEl     = tableEl ? (tableEl.querySelector("tbody") || $("activityTbody")) : $("activityTbody");
const thElements  = document.querySelectorAll('#activityTable th[data-sort]');

/* ---------------- State ---------------- */
let businessKey = null;
let isOwner     = false;
let unsub       = null;
let entries     = [];  // raw docs
let currentSort = { column: null, direction: "asc" };

/* ---------------- Render ---------------- */
function renderTable() {
  if (!tbodyEl) return;

  // clone and sort
  let list = [...entries];
  const { column, direction } = currentSort;

  if (column) {
    list.sort((a, b) => {
      if (column === "date") {
        const ar = a.date ?? a.dueDate ?? a.timestamp ?? null;
        const br = b.date ?? b.dueDate ?? b.timestamp ?? null;
        const ad = typeof ar === "string" ? new Date(ar) : ar?.toDate?.() || new Date(0);
        const bd = typeof br === "string" ? new Date(br) : br?.toDate?.() || new Date(0);
        return direction === "asc" ? ad - bd : bd - ad;
      } else if (column === "activity") {
        const av = `${a.title || ""} ${a.desc || ""}`.toLowerCase();
        const bv = `${b.title || ""} ${b.desc || ""}`.toLowerCase();
        return direction === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      } else { // status
        const av = (a.status || "").toLowerCase();
        const bv = (b.status || "").toLowerCase();
        return direction === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
    });
  }

  tbodyEl.innerHTML = "";
  for (const entry of list) {
    const tr  = document.createElement("tr");

    // Activity (title + desc)
    const t1  = document.createElement("td");
    t1.innerHTML = `<strong>${entry.title || ""}</strong><br><small>${entry.desc || ""}</small>`;
    tr.appendChild(t1);

    // Status
    const t2  = document.createElement("td");
    t2.textContent = entry.status || "";
    tr.appendChild(t2);

    // Due Date
    const t3  = document.createElement("td");
    t3.style.whiteSpace = "nowrap";
    t3.textContent = fmtDate(entry.date ?? entry.dueDate ?? entry.timestamp);
    tr.appendChild(t3);

    // Actions (owner only)
    const t4  = document.createElement("td");
    t4.className = "actions";
    if (isOwner) {
      const editBtn = document.createElement("button");
      editBtn.className = "edit-btn";
      editBtn.title     = "Edit";
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", () => startEdit(entry));
      t4.appendChild(editBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "delete-btn";
      delBtn.title     = "Delete";
      delBtn.textContent = "🗑";
      delBtn.addEventListener("click", () => confirmDelete(entry.id));
      t4.appendChild(delBtn);
    }
    tr.appendChild(t4);

    tbodyEl.appendChild(tr);
  }
}

function wireSorting() {
  if (!thElements || !thElements.length) return;
  thElements.forEach((th) => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const col = th.dataset.sort; // "activity" | "status" | "date"
      if (currentSort.column === col) {
        currentSort.direction = currentSort.direction === "asc" ? "desc" : "asc";
      } else {
        currentSort.column = col;
        currentSort.direction = "asc";
      }
      // update header arrow styles
      thElements.forEach(h => h.classList.remove("asc", "desc"));
      th.classList.add(currentSort.direction);
      renderTable();
    });
  });
}

/* ---------------- Firestore (compat) ---------------- */
function collRef() {
  // /businesses/{biz}/activities
  return db.collection("businesses").doc(businessKey).collection("activities");
}

function startListener() {
  if (!businessKey || !tbodyEl) return;
  // order by timestamp desc (may be null; Firestore will push nulls first/last)
  unsub = collRef().orderBy("timestamp", "desc").onSnapshot(
    (snap) => {
      entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderTable();
    },
    (err) => {
      console.error("Activity listener error:", err);
    }
  );
}

async function handleAdd(e) {
  e.preventDefault();
  if (!isOwner) return; // UI guard; rules should also enforce

  const title = (titleEl?.value || "").trim();
  const desc  = (descEl?.value || "").trim();
  const status = statusEl?.value || "";
  const dateVal = dateEl?.value || ""; // YYYY-MM-DD

  if (!title || !desc || !status || !dateVal) return;

  try {
    await collRef().add({
      title,
      desc,
      status,
      date: dateVal, // keep date string; we also maintain a server timestamp
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      businessKey,
      ownerUid: auth.currentUser?.uid || null,
      ownerEmail: auth.currentUser?.email || null,
    });
    formEl && formEl.reset();
  } catch (err) {
    console.error("Error adding activity:", err);
  }
}

async function startEdit(entry) {
  if (!isOwner) return;
  const newTitle  = prompt("Edit Activity Title:", entry.title || "");
  if (newTitle === null) return;
  const newDesc   = prompt("Edit Description:", entry.desc || "");
  if (newDesc === null) return;
  const newStatus = prompt("Edit Status:", entry.status || "");
  if (newStatus === null) return;
  const newDate   = prompt("Edit Due Date (YYYY-MM-DD):", entry.date || "");
  if (newDate === null) return;

  try {
    await collRef().doc(entry.id).update({
      title: newTitle,
      desc: newDesc,
      status: newStatus,
      date: newDate,
    });
  } catch (err) {
    console.error("Error editing activity:", err);
  }
}

async function confirmDelete(id) {
  if (!isOwner) return;
  if (!confirm("Are you sure you want to delete this activity?")) return;
  try {
    await collRef().doc(id).delete();
  } catch (err) {
    console.error("Error deleting activity:", err);
  }
}

/* ---------------- Import (stub) ---------------- */
function wireImport() {
  if (!isOwner || !importBtn || !fileInputEl) return;
  importBtn.addEventListener("click", () => fileInputEl.click());
  fileInputEl.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    // TODO: parse spreadsheet and add rows via collRef().add({...})
    // Keeping as a stub so it doesn't crash if not implemented yet.
    alert("Import stub: parse and write rows to Firestore here.");
    fileInputEl.value = "";
  });
}

/* ---------------- Owner UI toggles ---------------- */
function applyOwnerUI() {
  // Hide/Show form + import controls
  const controls = [formEl, importBtn, fileInputEl, browseBtn];
  controls.forEach((el) => { if (el) el.style.display = isOwner ? "" : "none"; });
  if (tableEl) tableEl.classList.toggle("owner", isOwner); // CSS can hide .actions for non-owners
}

/* ---------------- Boot ---------------- */
(function init() {
  // If table isn’t present on this page, safely skip the whole module
  if (!tableEl && !tbodyEl) {
    console.warn("Activity: table not found; skipping init");
    return;
  }

  // Sorting header clicks (works even before data arrives)
  wireSorting();

  // Wait for business key, then auth, then start
  onBizReady((biz) => {
    businessKey = biz;

    // on first auth ready, set owner UI and start listener
    if (!auth || typeof auth.onAuthStateChanged !== "function") {
      console.warn("Activity: auth not available; continuing without owner UI");
      startListener();
      return;
    }

    auth.onAuthStateChanged((user) => {
      isOwner = !!user && String(user.email || "").toLowerCase() === OWNER_EMAIL;
      applyOwnerUI();

      // Bind add form once
      if (isOwner && formEl && !formEl.dataset.bound) {
        formEl.addEventListener("submit", handleAdd);
        formEl.dataset.bound = "1";
      }
      // Import controls
      wireImport();

      // Start/Restart listener
      if (typeof unsub === "function") unsub();
      startListener();
    });
  });

  // Clean up on navigation (optional)
  window.addEventListener("beforeunload", () => { if (typeof unsub === "function") unsub(); });
})();