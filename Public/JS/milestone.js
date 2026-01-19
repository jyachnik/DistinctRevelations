// Public/JS/milestone.js
// Milestones widget – waits for firebaseInit + business context.

// Non-owner can view only.

(function () {
  const TAG = "[milestone]";
var OWNER_EMAIL =
  (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) ||
  window.ownerEmail ||
  '';
  let db = null;
  let auth = null;
  let bizKey = null;
  let userEmail = null;
  let isOwner = false;
  let colRef = null;

  // Track whether we're editing an existing milestone
  let editingId = null;

  // ---------- Logging helpers ----------
  function log() {
    console.log.apply(console, [TAG].concat(Array.from(arguments)));
  }
  function warn() {
    console.warn.apply(console, [TAG].concat(Array.from(arguments)));
  }
  function error() {
    console.error.apply(console, [TAG].concat(Array.from(arguments)));
  }

  // ---------- Business context ----------
  function resolveBusinessContext() {
    // 1) URL (?business=xyz-corporation)
    const params = new URLSearchParams(window.location.search || "");
    const fromUrl = params.get("business");

    // 2) Session/local storage (same pattern as dash-guard/dash-gate)
    const fromSession =
      (window.sessionStorage && window.sessionStorage.getItem("dr-business")) ||
      null;
    const fromLocal =
      (window.localStorage && window.localStorage.getItem("dr-business")) ||
      null;

    // 3) fallback to any global BIZ_KEY the dash-loader may set
    bizKey = fromUrl || fromSession || fromLocal || window.BIZ_KEY || bizKey;

    if (!bizKey) {
      warn("Unable to resolve business key; cannot load milestones.");
      return false;
    }

    const email = (auth.currentUser && auth.currentUser.email) || userEmail || "";
    userEmail = email;

   // Treat configured OWNER_EMAIL as the owner/admin
isOwner =
  !!email &&
  !!OWNER_EMAIL &&
  email.toLowerCase() === OWNER_EMAIL.toLowerCase();

    log("business context", { bizKey, email: userEmail, isOwner });
    return true;
  }

  // ---------- DOM lookup ----------
  function getDom() {
    // Section wrapper for milestones card
    const section =
      document.querySelector(".milestone-section") ||
      document.getElementById("milestoneSection") ||
      null;

    const form = document.getElementById("milestoneForm");
    const titleInput = document.getElementById("milestoneTitle");
    const statusSelect = document.getElementById("milestoneStatus");
    const dateInput = document.getElementById("milestoneDueDate");
    const table = document.getElementById("milestoneTable");
    const tbody = table ? table.querySelector("tbody") : null;
    const submitBtn = form
      ? form.querySelector("button[type='submit']")
      : null;

    const ok =
      section &&
      form &&
      titleInput &&
      statusSelect &&
      dateInput &&
      table &&
      tbody &&
      submitBtn;

    if (!ok) {
      warn("Required milestone DOM not found; aborting.", {
        section: !!section,
        form: !!form,
        title: !!titleInput,
        status: !!statusSelect,
        date: !!dateInput,
        table: !!table,
        tbody: !!tbody,
        submitBtn: !!submitBtn
      });
      return null;
    }

    // Non-owners can view, but not add/edit/delete
    if (!isOwner) {
      form.style.display = "none";
    }

    return {
      section,
      form,
      titleInput,
      statusSelect,
      dateInput,
      table,
      tbody,
      submitBtn
    };
  }

  // ---------- Rendering ----------
  function renderSnapshot(dom, snapshot) {
    const { tbody } = dom;
    tbody.innerHTML = "";

    if (snapshot.empty) {
      return;
    }

    snapshot.forEach((doc) => {
      const data = doc.data() || {};
      const tr = document.createElement("tr");
      tr.dataset.id = doc.id;

      // Title
      const titleTd = document.createElement("td");
      titleTd.textContent = data.title || "";

      // Location / Status
      const locTd = document.createElement("td");
      locTd.textContent = data.status || data.location || "";

      // Date
      const dateTd = document.createElement("td");
      let dateStr = "";
      if (data.dueDate) {
        try {
          const d = data.dueDate.toDate
            ? data.dueDate.toDate()
            : new Date(data.dueDate);
          if (!isNaN(d.getTime())) {
            dateStr = d.toLocaleDateString();
          }
        } catch (e) {
          // ignore parse issues
        }
      }
      dateTd.textContent = dateStr;

      tr.appendChild(titleTd);
      tr.appendChild(locTd);
      tr.appendChild(dateTd);

      // Actions column
      const actionsTd = document.createElement("td");
      actionsTd.className = "milestone-actions";

      if (isOwner) {
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "milestone-edit-btn";
        editBtn.dataset.action = "edit";
        editBtn.title = "Edit milestone";
        editBtn.textContent = "✏️";

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "milestone-delete-btn";
        delBtn.dataset.action = "delete";
        delBtn.title = "Delete milestone";
        delBtn.textContent = "🗑️";

        actionsTd.appendChild(editBtn);
        actionsTd.appendChild(delBtn);
      }

      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    });
  }

  // ---------- Editing helpers ----------
  function enterEditMode(dom, docId, data) {
    const { titleInput, statusSelect, dateInput, submitBtn, section } = dom;

    editingId = docId;

    // Fill form with current values
    titleInput.value = data.title || "";

    // Location / status dropdown
    const currentStatus = data.status || data.location || "";
    if (currentStatus) {
      // try to match option by value OR text
      let found = false;
      Array.from(statusSelect.options).forEach((opt) => {
        if (
          opt.value.toLowerCase() === currentStatus.toLowerCase() ||
          opt.textContent.toLowerCase() === currentStatus.toLowerCase()
        ) {
          statusSelect.value = opt.value;
          found = true;
        }
      });
      if (!found) {
        // leave as-is if not matched
      }
    }

    // Date picker – convert to yyyy-mm-dd
    if (data.dueDate) {
      try {
        const d = data.dueDate.toDate
          ? data.dueDate.toDate()
          : new Date(data.dueDate);
        if (!isNaN(d.getTime())) {
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          dateInput.value = `${yyyy}-${mm}-${dd}`;
        }
      } catch (e) {
        // ignore parse
      }
    } else {
      dateInput.value = "";
    }

    submitBtn.textContent = "Update Milestone";
    submitBtn.classList.add("milestone-update-mode");

    // Add / show a cancel link inside the section footer if not already there
    let cancel = section.querySelector(".milestone-cancel-edit");
    if (!cancel) {
      cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "milestone-cancel-edit";
      cancel.textContent = "Cancel Edit";
      section.appendChild(cancel);

      cancel.addEventListener("click", function () {
        exitEditMode(dom);
      });
    } else {
      cancel.style.display = "inline-block";
    }
  }

  function exitEditMode(dom) {
    const { titleInput, statusSelect, dateInput, submitBtn, section } = dom;

    editingId = null;
    titleInput.value = "";
    dateInput.value = "";
    if (statusSelect.options.length) {
      statusSelect.selectedIndex = 0;
    }

    submitBtn.textContent = "Add Milestone";
    submitBtn.classList.remove("milestone-update-mode");

    const cancel = section.querySelector(".milestone-cancel-edit");
    if (cancel) {
      cancel.style.display = "none";
    }
  }

  // ---------- Handlers ----------
  function attachHandlers(dom) {
    const { form, titleInput, statusSelect, dateInput, tbody } = dom;

    // Add / Update submit handler – owner only
    if (isOwner && form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();

        const title = titleInput.value.trim();
        const status = statusSelect.value || "";
        const dateVal = dateInput.value; // yyyy-mm-dd

        if (!title) {
          alert("Please enter a milestone title.");
          return;
        }

        let dueDate = null;
        if (dateVal) {
          const iso = dateVal + "T00:00:00";
          const d = new Date(iso);
          if (!isNaN(d.getTime())) {
            dueDate = d;
          }
        }

        const basePayload = {
          title,
          status,
          dueDate: dueDate || null
        };

        if (editingId) {
          // Update existing
          const payload = Object.assign(
            {
              updatedAt: new Date(),
              updatedBy: userEmail || null
            },
            basePayload
          );

          log("updating milestone", { id: editingId, payload });

          colRef
            .doc(editingId)
            .update(payload)
            .then(() => {
              exitEditMode(dom);
            })
            .catch((err) => {
              error("update failed:", err);
              alert(
                "Could not update milestone: " +
                  (err && err.message ? err.message : "Unknown error")
              );
            });
        } else {
          // Add new
          const payload = Object.assign(
            {
              createdAt: new Date(),
              createdBy: userEmail || null
            },
            basePayload
          );

          log("adding milestone", payload);

          colRef
            .add(payload)
            .then(() => {
              titleInput.value = "";
              statusSelect.selectedIndex = 0;
              dateInput.value = "";
            })
            .catch((err) => {
              error("add failed:", err);
              alert(
                "Could not add milestone: " +
                  (err && err.message ? err.message : "Unknown error")
              );
            });
        }
      });
    }

    // Edit/delete click handlers – owner only
    if (isOwner && tbody) {
      tbody.addEventListener("click", function (e) {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;

        const action = btn.dataset.action;
        const tr = btn.closest("tr");
        const id = tr && tr.dataset.id;
        if (!id) return;

        if (action === "delete") {
          if (!window.confirm("Delete this milestone?")) return;

          colRef
            .doc(id)
            .delete()
            .catch((err) => {
              error("delete failed:", err);
              alert(
                "Could not delete milestone: " +
                  (err && err.message ? err.message : "Unknown error")
              );
            });
        } else if (action === "edit") {
          // Grab current data from Firestore to ensure we have full object
          colRef
            .doc(id)
            .get()
            .then((docSnap) => {
              if (!docSnap.exists) return;
              const data = docSnap.data() || {};
              enterEditMode(dom, id, data);
            })
            .catch((err) => {
              error("edit fetch failed:", err);
              alert(
                "Could not load milestone for editing: " +
                  (err && err.message ? err.message : "Unknown error")
              );
            });
        }
      });
    }
  }

  // ---------- Main start ----------
  function start() {
    db = window.db || null;
    auth = window.auth || null;

    if (!db || !auth) {
      warn("Firebase SDK still missing even after firebase-ready.");
      return;
    }

    const user = auth.currentUser;
    userEmail = user && user.email ? user.email : null;

    if (!resolveBusinessContext()) {
      return;
    }

    colRef = db
      .collection("businesses")
      .doc(bizKey)
      .collection("milestones");

    const dom = getDom();
    if (!dom) return;

    log("initialized", { bizKey, email: userEmail, isOwner });

    // Live snapshot listener
    colRef.orderBy("dueDate").onSnapshot(
      (snapshot) => {
        log("snapshot size", snapshot.size);
        renderSnapshot(dom, snapshot);
      },
      (err) => {
        error("snapshot error:", err);
      }
    );

    attachHandlers(dom);
  }

  // ---------- Wait for Firebase ----------
  function waitForFirebaseAndStart() {
    if (window.db && window.auth) {
      start();
      return;
    }

    log("waiting for firebase-ready…");

    window.addEventListener(
      "firebase-ready",
      function handle() {
        window.removeEventListener("firebase-ready", handle);
        start();
      },
      { once: true }
    );
  }

  // Kick all off after DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForFirebaseAndStart);
  } else {
    waitForFirebaseAndStart();
  }
})();
