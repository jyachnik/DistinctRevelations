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
  let editingOriginalData = null;

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
    const otherDescInput = document.getElementById("milestoneOtherDesc");
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
    // Toggle so CSS can hide the Actions column entirely for non-owners
    // (see milestone.css: #milestoneTable:not(.owner) th.actions/td.actions).
    if (table) {
      table.classList.toggle("owner", !!isOwner);
    }
    // Milestones/Activities are now shown to clients via the Gantt chart
    // instead — this whole section is owner-only (see milestone.css:
    // .milestone-section:not(.owner) { display: none; }).
    if (section) {
      section.classList.toggle("owner", !!isOwner);
    }

    // Show the free-text "describe venue" input only when "Other" is picked.
    if (otherDescInput) {
      const syncOtherVisibility = () => {
        const isOther = statusSelect.value === "Other";
        otherDescInput.style.display = isOther ? "" : "none";
        if (!isOther) otherDescInput.value = "";
      };
      statusSelect.addEventListener("change", syncOtherVisibility);
      syncOtherVisibility();
    }

    return {
      section,
      form,
      titleInput,
      statusSelect,
      otherDescInput,
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
      const venue = data.status || data.location || "";
      locTd.textContent =
        venue === "Other" && data.locationOther
          ? "Other: " + data.locationOther
          : venue;

      // Date
      const dateTd = document.createElement("td");
      let dateStr = "";
      if (data.dueDate) {
        if (window.drDateFmt) {
          dateStr = window.drDateFmt.date(data.dueDate);
        } else {
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
      }
      dateTd.textContent = dateStr;

      // Jeopardy (RAG) — a past-dated milestone reads as "Occurred" rather
      // than "Overdue" (it's an event date, not an open task).
      const ragTd = document.createElement("td");
      ragTd.className = "dr-rag-cell";
      if (window.drRag) {
        const dueJs = window.drRag.toJsDate(data.dueDate);
        const occurred = dueJs && window.drRag.dateOnly(dueJs) < window.drRag.dateOnly(new Date());
        let jeopardy = window.drRag.compute(data.startDate || data.createdAt, data.dueDate, occurred);
        if (occurred) jeopardy = { code: "done", label: "Occurred" };
        ragTd.innerHTML =
          '<span class="dr-rag dr-rag-' + jeopardy.code + '" title="' + jeopardy.label + '"></span>' +
          '<span class="dr-rag-label">' + jeopardy.label + "</span>";
      }

      tr.appendChild(titleTd);
      tr.appendChild(locTd);
      tr.appendChild(dateTd);
      tr.appendChild(ragTd);

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
    const { titleInput, statusSelect, otherDescInput, dateInput, submitBtn, section } = dom;

    editingId = docId;
    editingOriginalData = data || {};

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

    if (otherDescInput) {
      const isOther = statusSelect.value === "Other";
      otherDescInput.style.display = isOther ? "" : "none";
      otherDescInput.value = isOther ? (data.locationOther || "") : "";
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
    const { titleInput, statusSelect, otherDescInput, dateInput, submitBtn, section } = dom;

    editingId = null;
    editingOriginalData = null;
    titleInput.value = "";
    dateInput.value = "";
    if (statusSelect.options.length) {
      statusSelect.selectedIndex = 0;
    }
    if (otherDescInput) {
      otherDescInput.value = "";
      otherDescInput.style.display = "none";
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
    const { form, titleInput, statusSelect, otherDescInput, dateInput, tbody } = dom;

    // Add / Update submit handler – owner only
    if (isOwner && form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();

        const title = titleInput.value.trim();
        const status = statusSelect.value || "";
        const locationOther = status === "Other" && otherDescInput ? otherDescInput.value.trim() : "";
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

        // This form has no Start Date field of its own — startDate only
        // ever gets set by a Gantt drag or an import. But editing just the
        // Due Date here, with no check against an existing startDate, is
        // exactly how a milestone ends up with start after due (the bar
        // still renders fine because the Gantt silently papers over an
        // inverted range for display — the underlying data is genuinely
        // broken until this is caught).
        if (editingId && dueDate) {
          const existingStart = editingOriginalData && editingOriginalData.startDate;
          if (existingStart) {
            const existingStartJs = window.drRag ? window.drRag.toJsDate(existingStart) : new Date(existingStart);
            if (existingStartJs && dueDate < existingStartJs) {
              alert(
                "Due date cannot be before this milestone's start date (" +
                  (window.drDateFmt ? window.drDateFmt.date(existingStartJs) : existingStartJs.toDateString()) +
                  "). Reschedule the start date on the Engagement Timeline first, or choose a later due date."
              );
              return;
            }
          }
        }

        const basePayload = {
          title,
          status,
          locationOther: locationOther || null,
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

          // Log what actually changed — same shape the Gantt change-log
          // uses, so an edit made here (not just a Gantt drag) still shows
          // up as real before/after history.
          const before = editingOriginalData || {};
          const edits = [];
          const dfmt = (v) => (window.drDateFmt ? window.drDateFmt.date(v) : (v ? String(v) : ''));
          const beforeVenue = before.status || before.location || "";
          if (beforeVenue !== status) edits.push({ field: "Venue", from: beforeVenue || "not set", to: status });
          const beforeDue = dfmt(before.dueDate) || "not set";
          const afterDue = dfmt(dueDate) || "not set";
          if (beforeDue !== afterDue) edits.push({ field: "Date", from: beforeDue, to: afterDue });
          if (edits.length) {
            payload.changeLog = (before.changeLog || []).slice(-4);
            payload.changeLog.push({ changes: edits, changedAt: new Date(), changedBy: userEmail || "Someone" });
          }

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
              createdBy: userEmail || null,
              // A creation is itself a change worth surfacing in the Change
              // Report — without this, new milestones show up on the Gantt
              // but never appear in the exportable change history.
              changeLog: [{
                changes: [{ field: 'Milestone created', from: '—', to: title }],
                changedAt: new Date(),
                changedBy: userEmail || "Someone"
              }]
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
          var confirmed = window.drConfirm
            ? window.drConfirm("Delete this milestone? This cannot be undone.", { title: "Delete Milestone" })
            : Promise.resolve(window.confirm("Delete this milestone?"));

          confirmed.then(function (ok) {
            if (!ok) return;
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
