// /Public/JS/milestone.js
// Works with BOTH schemas and your current HTML ids (Title, Location, Date)

const { auth, db } = window;
const OWNER_EMAIL = "john@distinctrevelations.com";

/* helpers */
const $  = (id) => document.getElementById(id);
function getBizKeyImmediate() {
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
    const d = new Date(raw);
    if (!isNaN(d)) return `${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}/${d.getFullYear()}`;
    const [y,m,d2] = raw.split("-");
    if (y && m && d2) return `${m}/${d2}/${y}`;
    return raw;
  }
  if (raw?.toDate) {
    const d = raw.toDate();
    return `${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}/${d.getFullYear()}`;
  }
  return "";
}

/* DOM ids from your HTML */
const formEl    = $("milestoneForm");
const titleEl   = $("milestoneTitle");
const locEl     = $("milestoneStatus");   // in your HTML this is the "Venue" select
const dateEl    = $("milestoneDueDate");  // your date input id

const tableEl   = $("milestoneTable");
const tbodyEl   = tableEl ? (tableEl.querySelector("tbody")) : null;

/* state */
let businessKey = null;
let isOwner     = false;

let rowsNested  = [];
let rowsTopA    = [];
let rowsTopB    = [];

let unsubNested = null;
let unsubTopA   = null;
let unsubTopB   = null;

let writeTarget = "nested";

/* rendering */
function allRowsMerged() {
  const out = [];
  rowsNested.forEach(r => out.push({ ...r, _source: "nested" }));
  rowsTopA.forEach(r => out.push({ ...r, _source: "topA" }));
  rowsTopB.forEach(r => out.push({ ...r, _source: "topB" }));
  return out;
}

function render() {
  if (!tbodyEl) return;
  const list = allRowsMerged().slice().sort((a,b) => {
    const ad = a.dueDate?.toDate?.() || new Date(a.dueDate || a.date || 0);
    const bd = b.dueDate?.toDate?.() || new Date(b.dueDate || b.date || 0);
    return ad - bd;
  });

  tbodyEl.innerHTML = "";
  list.forEach(m => {
    const tr = document.createElement("tr");

    const tdTitle = document.createElement("td");
    tdTitle.textContent = m.title || "";
    tr.appendChild(tdTitle);

    const tdLoc = document.createElement("td");
    tdLoc.textContent = m.location || m.status || m.owner || m.ownerEmail || "";
    tr.appendChild(tdLoc);

    const tdDate = document.createElement("td");
    tdDate.style.whiteSpace = "nowrap";
    tdDate.textContent = fmtDate(m.dueDate || m.date);
    tr.appendChild(tdDate);

    const tdActions = document.createElement("td");
    tdActions.className = "actions";
    if (isOwner) {
      const editBtn = document.createElement("button");
      editBtn.className = "edit-btn";
      editBtn.title = "Edit";
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", () => editMilestone(m));
      tdActions.appendChild(editBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "delete-btn";
      delBtn.title = "Delete";
      delBtn.textContent = "🗑";
      delBtn.addEventListener("click", () => deleteMilestone(m));
      tdActions.appendChild(delBtn);
    }
    tr.appendChild(tdActions);

    tbodyEl.appendChild(tr);
  });
}

/* FS helpers */
function collNested() {
  return db.collection("businesses").doc(businessKey).collection("milestones");
}
function collTopA() { return db.collection("milestone").where("businessKey", "==", businessKey); }
function collTopB() { return db.collection("milestones").where("businessKey", "==", businessKey); }

function chooseWriteTarget() {
  if (rowsNested.length) { writeTarget = "nested"; return; }
  if (rowsTopA.length)   { writeTarget = "topA";  return; }
  if (rowsTopB.length)   { writeTarget = "topB";  return; }
  writeTarget = "nested";
}

/* listeners */
function startListeners() {
  unsubNested && unsubNested(); unsubTopA && unsubTopA(); unsubTopB && unsubTopB();

  unsubNested = collNested().onSnapshot(
    (snap) => { rowsNested = snap.docs.map(d => ({ id:d.id, ...d.data() })); chooseWriteTarget(); render(); },
    (err)  => console.warn("Milestones (nested) error:", err && (err.message || err))
  );
  unsubTopA = collTopA().onSnapshot(
    (snap) => { rowsTopA = snap.docs.map(d => ({ id:d.id, ...d.data() })); chooseWriteTarget(); render(); },
    (err)  => console.warn("Milestones (/milestone) error:", err && (err.message || err))
  );
  unsubTopB = collTopB().onSnapshot(
    (snap) => { rowsTopB = snap.docs.map(d => ({ id:d.id, ...d.data() })); chooseWriteTarget(); render(); },
    (err)  => console.warn("Milestones (/milestones) error:", err && (err.message || err))
  );
}

function getWriteRef(id) {
  if (writeTarget === "nested") return id ? collNested().doc(id) : collNested().doc();
  if (writeTarget === "topA")   return id ? db.collection("milestone").doc(id)  : db.collection("milestone").doc();
  if (writeTarget === "topB")   return id ? db.collection("milestones").doc(id) : db.collection("milestones").doc();
  return collNested().doc(id);
}

/* CRUD */
async function addMilestone(e) {
  e.preventDefault();
  if (!isOwner) return;

  const title  = (titleEl?.value || "").trim();
  const loc    = (locEl?.value   || "").trim();
  const date   = (dateEl?.value  || "").trim(); // YYYY-MM-DD
  if (!title || !loc || !date) return;

  try {
    const ref = getWriteRef();
    await ref.set({
      title,
      location: loc,
      dueDate: date,
      businessKey,
      ownerUid: auth.currentUser?.uid || null,
      ownerEmail: auth.currentUser?.email || null,
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    formEl && formEl.reset();
  } catch (e2) {
    console.error("Add milestone failed:", e2);
    alert("Could not add milestone.");
  }
}

async function editMilestone(m) {
  if (!isOwner) return;
  const title = prompt("Edit title:", m.title || "");
  if (title === null) return;
  const loc = prompt("Edit location:", m.location || m.status || m.owner || "");
  if (loc === null) return;
  const date = prompt("Edit due date (YYYY-MM-DD):", (m.dueDate || m.date || ""));
  if (date === null) return;

  try {
    const ref = (m._source === "nested")
      ? collNested().doc(m.id)
      : (m._source === "topA")
        ? db.collection("milestone").doc(m.id)
        : db.collection("milestones").doc(m.id);
    await ref.update({ title, location: loc, dueDate: date });
  } catch (e2) {
    console.error("Edit milestone failed:", e2);
    alert("Could not edit milestone.");
  }
}

async function deleteMilestone(m) {
  if (!isOwner) return;
  if (!confirm("Delete this milestone?")) return;
  try {
    const ref = (m._source === "nested")
      ? collNested().doc(m.id)
      : (m._source === "topA")
        ? db.collection("milestone").doc(m.id)
        : db.collection("milestones").doc(m.id);
    await ref.delete();
  } catch (e2) {
    console.error("Delete milestone failed:", e2);
    alert("Could not delete milestone.");
  }
}

/* boot */
(function init() {
  if (!tableEl || !tbodyEl) {
    console.warn("Milestone: table not found; skipping init");
    return;
  }

  onBizReady((biz) => {
    businessKey = biz;
    auth.onAuthStateChanged((user) => {
      isOwner = !!user && String(user.email || "").toLowerCase() === OWNER_EMAIL;
      if (formEl) formEl.style.display = isOwner ? "" : "none";
      if (isOwner && formEl && !formEl.dataset.bound) {
        formEl.addEventListener("submit", addMilestone);
        formEl.dataset.bound = "1";
      }
      startListeners();
    });
  });

  window.addEventListener("beforeunload", () => {
    unsubNested && unsubNested();
    unsubTopA && unsubTopA();
    unsubTopB && unsubTopB();
  });
})();