// filemanager.js
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-storage.js";
import { db, auth } from "./firebaseInit.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";

const OWNER_EMAIL = "john@distinctrevelations.com";

export async function loadFileManager(businessKey, userEmail) {
  if (loadFileManager._initialized) {
    console.log("🛑 filemanager already initialized; skipping re-bind");
    return;
  }
  loadFileManager._initialized = true;

  console.log("⚙️ loadFileManager()", { businessKey, userEmail });

  // UI elements
  const openBtn       = document.getElementById("openFileModal");
  const uploadModal   = document.getElementById("fileUploadModal");
  const closeBtn      = document.getElementById("closeFileUploadModal");
  const fileInput     = document.getElementById("fileInput");
  const selectedText  = document.getElementById("selectedFilesText");
  const statusText    = document.getElementById("uploadStatus");
  const confirmBtn    = document.getElementById("confirmFileUpload");
  const cancelBtn     = document.getElementById("cancelFileUpload");
  const deleteModal   = document.getElementById("deleteConfirmModal");
  const cancelDelBtn  = document.getElementById("cancelDelete");
  const confirmDelBtn = document.getElementById("confirmDelete");
  const table         = document.getElementById("fileTable");
  const tbody         = document.getElementById("fileTableBody");
  const filterUser    = document.getElementById("filterUser");
  const filterType    = document.getElementById("filterFileType");

  // Always show the “Upload Files” button
  openBtn.style.display = "";
  // Make the native file‐picker visible
  fileInput.style.display = "inline-block";

  // — Open / close modal —
  openBtn.addEventListener("click", () => {
    uploadModal.classList.remove("hidden");
    fileInput.value = "";
    selectedText.textContent = "No files selected";
    statusText.textContent  = "";
  });
  [closeBtn, cancelBtn].forEach(btn =>
    btn.addEventListener("click", () => uploadModal.classList.add("hidden"))
  );

  // — File selection —
  fileInput.addEventListener("change", e => {
    const names = Array.from(e.target.files).map(f => f.name);
    selectedText.textContent = names.join(", ") || "No files selected";
  });

  // — Upload flow (any signed-in user) —
  let isUploading = false;
  confirmBtn.addEventListener("click", async () => {
    if (isUploading) return;        // ← prevent double‐fire
    isUploading = true;

    const files = Array.from(fileInput.files);
    if (!files.length) {
      alert("Please select at least one file.");
      isUploading = false;
      return;
    }
    statusText.textContent = "Uploading…";

    try {
      await Promise.all(files.map(file =>
        new Promise((resolve, reject) => {
          const path = `${businessKey}/files/${Date.now()}_${file.name}`;
          const ref  = storageRef(getStorage(), path);
          const task = uploadBytesResumable(ref, file);

          task.on("state_changed",
            snap => {
              const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
              statusText.textContent = `Uploading ${file.name}: ${pct}%`;
            },
            err => reject(err),
            async () => {
              const url = await getDownloadURL(ref);
              await addDoc(
                collection(db, "businesses", businessKey, "files"),
                {
                  fileName:    file.name,
                  type:        file.name.split(".").pop().toLowerCase(),
                  size:        file.size,
                  created:     serverTimestamp(),
                  owner:       userEmail,
                  url,
                  storagePath: path
                }
              );
              resolve();
            }
          );
        })
      ));

      statusText.textContent = "All uploads complete!";
      setTimeout(() => uploadModal.classList.add("hidden"), 800);
    } catch (err) {
      console.error("Upload failed:", err);
      alert("Upload error – check console");
    } finally {
      isUploading = false;
    }
  });

  // — Delete flow —
  let pendingDeletion = null;
  cancelDelBtn.addEventListener("click", () => {
    pendingDeletion = null;
    deleteModal.classList.add("hidden");
  });
  confirmDelBtn.addEventListener("click", async () => {
    if (!pendingDeletion) {
      return deleteModal.classList.add("hidden");
    }
    const { snap, row, path } = pendingDeletion;
    try {
      await deleteObject(storageRef(getStorage(), path));
      await deleteDoc(doc(db, "businesses", businessKey, "files", snap.id));
      row.remove();
    } catch (e) {
      console.error("Delete failed:", e);
      alert("Error deleting file – check console");
    }
    pendingDeletion = null;
    deleteModal.classList.add("hidden");
  });

  // — Listing, filtering, sorting —
  let docs = [], sortField = null, sortAsc = true;

  async function populateFilters() {
    const usersSnap = await getDocs(collection(db, "businesses", businessKey, "users"));
    const bizUsers  = usersSnap.docs.map(d => d.data().email);
    const owners    = docs.map(d => d.data().owner);
    const emails    = Array.from(new Set([OWNER_EMAIL, ...bizUsers, ...owners])).sort();

    filterUser.innerHTML =
      '<option value="">All Users</option>' +
      emails.map(e => `<option>${e}</option>`).join("");

    const types = Array.from(new Set(docs.map(d => d.data().type))).sort();
    filterType.innerHTML =
      '<option value="">All Types</option>' +
      types.map(t => `<option>${t}</option>`).join("");
  }

  function renderTable() {
    tbody.innerHTML = "";
    docs.slice()
      .sort((a, b) => {
        if (!sortField) return 0;
        let av = a.data()[sortField], bv = b.data()[sortField];
        if (sortField === "created") {
          av = av.toDate().getTime();
          bv = bv.toDate().getTime();
        }
        return (av < bv ? -1 : 1) * (sortAsc ? 1 : -1);
      })
      .forEach(snap => {
        const d = snap.data();
        if (filterUser.value && d.owner !== filterUser.value) return;
        if (filterType.value && d.type  !== filterType.value)  return;

        const tr = document.createElement("tr");
        ["fileName","type","size","created","owner"].forEach(field => {
          const td = document.createElement("td");
          if (field === "size") {
            td.textContent = `${(d.size/1024).toFixed(1)} KB`;
          } else if (field === "created") {
            td.textContent = d.created.toDate().toLocaleString();
          } else {
            td.textContent = d[field];
          }
          tr.appendChild(td);
        });

        // download link
        const dlTd = document.createElement("td");
        dlTd.innerHTML = `<a href="${d.url}" target="_blank">⬇</a>`;
        tr.appendChild(dlTd);

        // delete icon if allowed
        const delTd = document.createElement("td");
        if (userEmail === OWNER_EMAIL || userEmail === d.owner) {
          const btn = document.createElement("button");
          btn.className   = "icon-btn delete";
          btn.title       = "Delete";
          btn.textContent = "🗑";
          btn.addEventListener("click", () => {
            pendingDeletion = { snap, row: tr, path: d.storagePath };
            deleteModal.classList.remove("hidden");
          });
          delTd.appendChild(btn);
        }
        tr.appendChild(delTd);

        tbody.appendChild(tr);
      });
  }

  onSnapshot(
    query(collection(db, "businesses", businessKey, "files"), orderBy("created","desc")),
    snap => {
      docs = snap.docs;
      populateFilters();
      renderTable();
    },
    err => console.error("File list error:", err)
  );

  filterUser .addEventListener("change", renderTable);
  filterType .addEventListener("change", renderTable);

  table.querySelectorAll("th[data-sort]").forEach(th => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const fld = th.getAttribute("data-sort");
      if (sortField === fld) sortAsc = !sortAsc;
      else { sortField = fld; sortAsc = true; }
      renderTable();
    });
  });
}

// auto-initialize when signed-in
onAuthStateChanged(auth, user => {
  const businessKey = new URLSearchParams(location.search).get("business");
  if (user && businessKey) {
    loadFileManager(businessKey, user.email);
  }
});
