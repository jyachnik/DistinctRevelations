// /Public/JS/filemanager.js
// ES module using Firebase COMPAT globals (window.db, window.storage, window.auth)
// Policy implemented:
//  - Everyone in the same business can read file metadata
//  - Non-owner users can upload & delete ONLY their own files
//  - Owner (john@distinctrevelations.com) can do everything
//  - Legacy items (no ownerUid / old storage path) show a delete button for the
//    listed owner, but if Storage rules reject the object delete we explain why
//    and DO NOT remove metadata (prevents orphaning).

const { db, storage, auth } = window;
const OWNER_EMAIL = "john@distinctrevelations.com";

const $ = (id) => document.getElementById(id);
const fmtSize = (b) => (typeof b === "number" ? `${(b / 1024).toFixed(1)} KB` : "");

function emailOf(user) { return (user?.email || "").toLowerCase(); }
function sameEmail(a, b) { return (a || "").toLowerCase() === (b || "").toLowerCase(); }

/* -------------------- row builder -------------------- */
function buildRow(snap, me, isOwner) {
  const d = snap.data();
  const tr = document.createElement("tr");

  // File Name
  const tdName = document.createElement("td");
  tdName.textContent = d.fileName || "";
  tr.appendChild(tdName);

  // Type
  const tdType = document.createElement("td");
  tdType.textContent = d.type || "";
  tr.appendChild(tdType);

  // Size
  const tdSize = document.createElement("td");
  tdSize.textContent = fmtSize(d.size);
  tr.appendChild(tdSize);

  // Created Date
  const tdCreated = document.createElement("td");
  const created = d.created?.toDate ? d.created.toDate() : null;
  tdCreated.textContent = created ? created.toLocaleString() : "";
  tr.appendChild(tdCreated);

  // Owner (email)
  const tdOwner = document.createElement("td");
  tdOwner.textContent = d.ownerEmail || d.owner || "";
  tr.appendChild(tdOwner);

  // Download
  const tdDl = document.createElement("td");
  const a = document.createElement("a");
  a.href = d.url || "#";
  a.target = "_blank";
  a.rel = "noopener";
  a.className = "btn-link";
  a.textContent = "Download";
  tdDl.appendChild(a);
  tr.appendChild(tdDl);

  // Delete
  const tdDel = document.createElement("td");

  // ✅ Who can see the delete button?
  // - Owner (admin)
  // - Uploader (ownerUid === me.uid)
  // - Fallback for legacy docs: ownerEmail or owner matches my email
  const myEmail = emailOf(me);
  const legacyEmailMatch =
    sameEmail(d.ownerEmail, myEmail) || sameEmail(d.owner, myEmail);

  const canDelete = isOwner || (me && d.ownerUid === me.uid) || legacyEmailMatch;

  if (canDelete) {
    const btn = document.createElement("button");
    btn.className = "delete-btn";
    btn.title = "Delete";
    btn.textContent = "🗑";
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this file?")) return;

      // First try to remove the Storage object
      let storageDeleted = false;
      if (d.storagePath) {
        try {
          await storage.ref(d.storagePath).delete();
          storageDeleted = true;
        } catch (err) {
          const code = err?.code || "";
          // If a non-owner tries to delete a legacy object (no /{uid}/ in path),
          // Storage rules will block with 'storage/unauthorized'.
          const isLegacyPath = !String(d.storagePath).includes(`/${me?.uid}/`);
          if (code === "storage/unauthorized" && !isOwner && isLegacyPath) {
            alert(
              "This is a legacy file stored without your user ID. " +
              "Only the project owner can remove it from Storage. " +
              "Please ask the owner to delete it."
            );
            return; // ⛔ do not delete metadata to avoid orphaning
          }
          // If it's not found, we can still remove metadata
          if (code !== "storage/object-not-found") {
            console.warn("Storage delete warning:", err);
          }
        }
      }

      // Remove Firestore metadata (allowed for owner or the item's owner)
      try {
        await snap.ref.delete();
        // For visibility: if Storage remained (legacy), tell the user
        if (!storageDeleted && !isOwner) {
          console.info(
            "File metadata removed. The Storage object remains and can be cleaned up by the owner."
          );
        }
      } catch (e) {
        console.error("File metadata delete failed:", e);
        alert("Could not delete file metadata.");
      }
    });
    tdDel.appendChild(btn);
  } else {
    tdDel.textContent = "—";
  }

  tr.appendChild(tdDel);
  return tr;
}

/* -------------------- main entry -------------------- */
export function loadFileManager(businessKey, userEmail) {
  if (!businessKey) {
    console.warn("filemanager: missing businessKey");
    return;
  }
  if (loadFileManager._bound) return;
  loadFileManager._bound = true;

  // Elements (keep IDs aligned with dashboard.html)
  const container     = $("fileManagerContainer");
  const openBtn       = $("openFileModal");
  const modal         = $("fileUploadModal");
  const closeBtn      = $("closeFileUploadModal");
  const cancelBtn     = $("cancelFileUpload");
  const fileInput     = $("fileInput");
  const selectedText  = $("selectedFilesText");
  const statusText    = $("uploadStatus");
  const confirmBtn    = $("confirmFileUpload");

  const filterUser    = $("filterUser");
  const filterType    = $("filterFileType");
  const table         = $("fileTable");
  const tableBody     = $("fileTableBody");

  if (
    !container || !openBtn || !modal || !fileInput || !selectedText ||
    !statusText || !confirmBtn || !tableBody
  ) {
    console.warn("filemanager: required DOM missing; skipping init");
    return;
  }

  // Modal helpers
  const showModal = () => modal.classList.remove("hidden");
  const hideModal = () => {
    modal.classList.add("hidden");
    statusText.textContent = "";
    selectedText.textContent = "No files selected";
    fileInput.value = "";
  };

  openBtn.addEventListener("click", showModal);
  closeBtn && closeBtn.addEventListener("click", hideModal);
  cancelBtn && cancelBtn.addEventListener("click", hideModal);

  // Trigger file picker too
  openBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const names = Array.from(fileInput.files || []).map((f) => f.name);
    selectedText.textContent = names.length ? names.join(", ") : "No files selected";
  });

  // Auth gate
  auth.onAuthStateChanged((user) => {
    if (!user) return;

    const me = { uid: user.uid, email: emailOf(user) };
    const isOwner = me.email === OWNER_EMAIL;

    // Upload handler — writes to /{biz}/files/{uid}/… and metadata with ownerUid
    let isUploading = false;
    confirmBtn.addEventListener("click", async () => {
      if (isUploading) return;
      const files = Array.from(fileInput.files || []);
      if (!files.length) {
        alert("Please select at least one file.");
        return;
      }
      isUploading = true;
      statusText.textContent = "Uploading…";

      try {
        for (const f of files) {
          const safe = f.name.replace(/[^\w.\-() ]+/g, "_");
          const storagePath = `${businessKey}/files/${me.uid}/${Date.now()}_${safe}`; // 👈 UID in path (required by rules)
          console.log("[FileManager] uploading to:", storagePath);

          const ref = storage.ref(storagePath);
          await ref.put(f);
          const url = await ref.getDownloadURL();

          await db.collection("businesses").doc(businessKey).collection("files").add({
            fileName:   safe,
            type:       safe.includes(".") ? safe.split(".").pop().toLowerCase() : "",
            size:       f.size,
            created:    firebase.firestore.FieldValue.serverTimestamp(),
            owner:      user.email || "",
            ownerEmail: user.email || "",
            ownerUid:   me.uid,            // ✅ rules need this
            url,
            storagePath,
            businessKey
          });
        }
        statusText.textContent = "Upload complete.";
        setTimeout(hideModal, 600);
      } catch (e) {
        console.error("Upload failed:", e);
        statusText.textContent = "Upload failed.";
        alert("One or more files failed to upload.");
      } finally {
        isUploading = false;
      }
    });

    // Realtime list
    let docs = [];
    const unsub = db
      .collection("businesses").doc(businessKey)
      .collection("files")
      .orderBy("created", "desc")
      .onSnapshot(
        (snap) => {
          docs = snap.docs.slice();
          populateFilters(docs, filterUser, filterType);
          render(docs, tableBody, me, isOwner, filterUser, filterType);
        },
        (err) => console.warn("filemanager listener error:", err && (err.message || err))
      );

    // client-side sorting
    if (table) {
      const ths = table.querySelectorAll("th[data-sort]");
      ths.forEach((th) => {
        th.style.cursor = "pointer";
        th.addEventListener("click", () => {
          const fld = th.dataset.sort;
          const dir = th.classList.contains("asc") ? "desc" : "asc";
          ths.forEach((x) => x.classList.remove("asc", "desc"));
          th.classList.add(dir);
          render(docs, tableBody, me, isOwner, filterUser, filterType, { field: fld, dir });
        });
      });
    }

    window.addEventListener("beforeunload", () => unsub && unsub());
  });
}

/* -------------------- filters + render -------------------- */
function populateFilters(docs, filterUser, filterType) {
  if (!filterUser || !filterType) return;
  const owners = Array.from(
    new Set(docs.map((d) => (d.data().ownerEmail || d.data().owner || "").toLowerCase()).filter(Boolean))
  );
  const types = Array.from(
    new Set(docs.map((d) => (d.data().type || "").toLowerCase()).filter(Boolean))
  );
  filterUser.innerHTML =
    '<option value="">All Users</option>' + owners.map((o) => `<option>${o}</option>`).join("");
  filterType.innerHTML =
    '<option value="">All Types</option>' + types.map((t) => `<option>${t}</option>`).join("");
}

function render(docs, tbody, me, isOwner, filterUser, filterType, sort) {
  if (!tbody) return;
  tbody.innerHTML = "";

  let list = docs.slice();

  // filter
  const fUser = (filterUser?.value || "").toLowerCase();
  const fType = (filterType?.value || "").toLowerCase();
  list = list.filter((s) => {
    const d = s.data();
    const owner = String(d.ownerEmail || d.owner || "").toLowerCase();
    const type  = String(d.type || "").toLowerCase();
    return (!fUser || owner === fUser) && (!fType || type === fType);
  });

  // sort
  if (sort?.field) {
    const asc = sort.dir !== "desc";
    list.sort((a, b) => {
      const da = a.data();
      const dbb = b.data();
      let av, bv;
      switch (sort.field) {
        case "name":
          av = (da.fileName || "").toLowerCase();
          bv = (dbb.fileName || "").toLowerCase();
          break;
        case "type":
          av = (da.type || "").toLowerCase();
          bv = (dbb.type || "").toLowerCase();
          break;
        case "size":
          av = da.size || 0;
          bv = dbb.size || 0;
          break;
        case "createdAt":
          av = da.created?.toDate ? da.created.toDate().getTime() : 0;
          bv = dbb.created?.toDate ? dbb.created.toDate().getTime() : 0;
          break;
        case "owner":
          av = (da.ownerEmail || da.owner || "").toLowerCase();
          bv = (dbb.ownerEmail || dbb.owner || "").toLowerCase();
          break;
        default:
          av = 0; bv = 0;
      }
      if (av < bv) return asc ? -1 : 1;
      if (av > bv) return asc ? 1 : -1;
      return 0;
    });
  }

  list.forEach((snap) => tbody.appendChild(buildRow(snap, me, isOwner)));
}