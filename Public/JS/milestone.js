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
  let projKey = null;
  let userEmail = null;
  let isOwner = false;
  let colRef = null;

  // Track whether we're editing an existing milestone
  let editingId = null;
  let editingOriginalData = null;

  // dom/lastSnapshot are module-level (not local to start()) so the
  // Prev/Next pagination buttons, wired once in attachHandlers, can
  // re-render off the same already-loaded snapshot without a fresh
  // Firestore read.
  let dom = null;
  let lastSnapshot = null;
  let milestonePage = 1;
  const MILESTONE_PAGE_SIZE = 15;
  let milestoneSort = { key: null, dir: 'asc' };
  const MILESTONE_CONFIRMED_OPTIONS = ["Pending Approval", "Approved", "Denied", "Postponed"];

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

    // Multi-project cutover — every business always has at least the
    // auto-created 'default' project (dashboard-business-loader.js
    // guarantees window.PROJECT_KEY is set by the time this runs).
    projKey = window.PROJECT_KEY || projKey || 'default';

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
    const typeSelect = document.getElementById("milestoneType");
    const statusSelect = document.getElementById("milestoneStatus");
    const otherDescInput = document.getElementById("milestoneOtherDesc");
    const placeInput = document.getElementById("milestonePlace");
    const dateInput = document.getElementById("milestoneDueDate");
    const table = document.getElementById("milestoneTable");
    const tbody = table ? table.querySelector("tbody") : null;
    const submitBtn = form
      ? form.querySelector("button[type='submit']")
      : null;
    const cancelBtn = document.getElementById("milestoneCancelEdit");

    const ok =
      section &&
      form &&
      titleInput &&
      typeSelect &&
      statusSelect &&
      dateInput &&
      table &&
      tbody &&
      submitBtn &&
      cancelBtn;

    if (!ok) {
      warn("Required milestone DOM not found; aborting.", {
        section: !!section,
        form: !!form,
        title: !!titleInput,
        type: !!typeSelect,
        status: !!statusSelect,
        date: !!dateInput,
        table: !!table,
        tbody: !!tbody,
        submitBtn: !!submitBtn,
        cancelBtn: !!cancelBtn
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
    // Whole-card visibility is now grantable via the Permissions matrix
    // (Settings ▸ Permissions) — a role with Meetings/Events checked sees
    // the full card, not just the Gantt chart summary. Reuses the existing
    // milestone.css rule (.milestone-section:not(.owner){display:none}),
    // so this toggles "owner" for anyone WITH view access, not literally
    // only the owner — Add/Edit/Delete/Checklist stay owner-only
    // regardless (see the table's own "owner" toggle just above, which is
    // intentionally still isOwner-only).
    if (section) {
      var canViewMilestones = isOwner || (window.drAccess && window.drAccess.canViewReport('milestoneSection'));
      section.classList.toggle("owner", !!canViewMilestones);
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
      typeSelect,
      statusSelect,
      otherDescInput,
      placeInput,
      dateInput,
      table,
      tbody,
      submitBtn,
      cancelBtn
    };
  }

  // ---------- Rendering ----------
  // Builds one <tr> for a single meeting/event doc — split out from
  // renderSnapshot so pagination can build rows for only the current
  // page's slice instead of the whole collection every render.
  function buildMilestoneRow(doc, data, itemType) {
      const tr = document.createElement("tr");
      tr.dataset.id = doc.id;
      // Real due date, not the display-formatted text — MM/DD/YY with a
      // 2-digit year round-trips through new Date() inconsistently across
      // browsers, so the checklist popup reads this instead of re-parsing
      // whatever's shown in the Date cell.
      const dueJsForChecklist = window.drRag ? window.drRag.toJsDate(data.dueDate) : (data.dueDate ? new Date(data.dueDate) : null);
      if (dueJsForChecklist && !isNaN(dueJsForChecklist.getTime())) {
        tr.dataset.due = dueJsForChecklist.toISOString();
      }

      // Title
      const titleTd = document.createElement("td");
      titleTd.textContent = data.title || "";

      // Type
      const typeTd = document.createElement("td");
      typeTd.textContent = itemType;

      // Location / Status
      const locTd = document.createElement("td");
      const venue = data.status || data.location || "";
      locTd.textContent =
        venue === "Other" && data.locationOther
          ? "Other: " + data.locationOther
          : venue;

      // Place — the specific location within the Venue above (e.g. Venue
      // "On-site" + Place "Conference Room 101"), a separate free-text
      // field independent of which venue is picked.
      const placeTd = document.createElement("td");
      placeTd.textContent = data.place || "";

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

      // Status — now driven by how much of the Setup Checklist is checked
      // off, not schedule jeopardy (per explicit request). An occurred
      // (past-dated) meeting/event still reads as "Occurred" regardless of
      // checklist state, same as before, since that's a settled fact.
      const ragTd = document.createElement("td");
      ragTd.className = "dr-rag-cell";
      const dueJs = dueJsForChecklist;
      const occurred = window.drRag && dueJs && window.drRag.dateOnly(dueJs) < window.drRag.dateOnly(new Date());
      let checklistStatus;
      if (occurred) {
        checklistStatus = { code: "done", label: "Occurred" };
      } else {
        const checklistDone = Array.isArray(data.checklistDone) ? data.checklistDone : [];
        const totalItems = CHECKLIST_TEMPLATE.length;
        const doneCount = checklistDone.filter(function (v) { return v === true; }).length;
        if (doneCount === 0) checklistStatus = { code: "red", label: "Not Started" };
        else if (doneCount >= totalItems) checklistStatus = { code: "green", label: "Ready" };
        else checklistStatus = { code: "amber", label: "In Progress (" + doneCount + "/" + totalItems + ")" };
      }
      ragTd.innerHTML =
        '<span class="dr-rag dr-rag-' + checklistStatus.code + '" title="' + checklistStatus.label + '"></span>' +
        '<span class="dr-rag-label">' + checklistStatus.label + "</span>";

      // Confirmed — owner-editable, saved straight to Firestore the
      // moment it's changed (no separate submit step), same inline-edit
      // pattern as Risk Register's "Contributing to SPI" checkbox.
      // Non-owners see the current value as plain text, not a control
      // they can't use anyway.
      const confirmedTd = document.createElement("td");
      confirmedTd.style.textAlign = "center";
      const confirmedValue = data.confirmed || "Pending Approval";
      if (isOwner) {
        const confirmedSelect = document.createElement("select");
        confirmedSelect.className = "milestone-confirmed-select";
        confirmedSelect.dataset.action = "confirmed";
        MILESTONE_CONFIRMED_OPTIONS.forEach(function (opt) {
          const optionEl = document.createElement("option");
          optionEl.value = opt;
          optionEl.textContent = opt;
          if (opt === confirmedValue) optionEl.selected = true;
          confirmedSelect.appendChild(optionEl);
        });
        confirmedTd.appendChild(confirmedSelect);
      } else {
        confirmedTd.textContent = confirmedValue;
      }

      tr.appendChild(titleTd);
      tr.appendChild(typeTd);
      tr.appendChild(locTd);
      tr.appendChild(placeTd);
      tr.appendChild(dateTd);
      tr.appendChild(ragTd);
      tr.appendChild(confirmedTd);

      // Actions column
      const actionsTd = document.createElement("td");
      actionsTd.className = "milestone-actions";

      // Setup Checklist — visible to everyone (read-only reference, not an
      // edit action), unlike Edit/Delete which stay owner-only below.
      const checklistBtn = document.createElement("button");
      checklistBtn.type = "button";
      checklistBtn.className = "milestone-checklist-btn";
      checklistBtn.dataset.action = "checklist";
      checklistBtn.title = "Open setup checklist in a new window";
      checklistBtn.textContent = "📋";
      actionsTd.appendChild(checklistBtn);

      // Minutes & Action Items — same "visible to everyone, opens in its
      // own window" precedent as the Setup Checklist button above (the
      // underlying write still goes through canEditScheduleData() in
      // firestore.rules, same as checklistDone; a non-owner sees the same
      // permission error the checklist popup already shows if they try).
      const minutesBtn = document.createElement("button");
      minutesBtn.type = "button";
      minutesBtn.className = "milestone-minutes-btn";
      minutesBtn.dataset.action = "minutes";
      minutesBtn.title = "Open meeting minutes & action items in a new window";
      minutesBtn.textContent = "📝";
      actionsTd.appendChild(minutesBtn);

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

      return { tr, dueJs, occurred };
  }

  function renderSnapshot(dom, snapshot) {
    const { tbody } = dom;
    tbody.innerHTML = "";

    if (snapshot.empty) {
      tbody.innerHTML = '<tr><td colspan="8" class="metrics-empty">No meetings or events yet.</td></tr>';
      if (window.drInsight) window.drInsight.set('milestoneSection', '');
      const pageInfoEl = document.getElementById('milestonePageInfo');
      if (pageInfoEl) pageInfoEl.textContent = '';
      return;
    }

    // This card is Meetings/Events ONLY now (per explicit request) — a
    // plain "Milestone" type, or an existing pre-Type record (type is a
    // brand-new field; nothing imported/entered before this had one), is
    // skipped rather than shown here. Older entries need to be edited
    // once to pick a Type before they'll reappear.
    const items = [];
    snapshot.forEach((doc) => {
      const data = doc.data() || {};
      const itemType = data.type || "";
      if (itemType !== "Meeting" && itemType !== "Event") return;
      items.push({ doc, data, itemType });
    });

    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="metrics-empty">No meetings or events yet — existing entries need a Type set (edit them, or add a new one) before they\'ll show up here.</td></tr>';
      if (window.drInsight) window.drInsight.set('milestoneSection', '');
      const pageInfoEl = document.getElementById('milestonePageInfo');
      if (pageInfoEl) pageInfoEl.textContent = '';
      return;
    }

    // Click-to-sort — same generic pattern used elsewhere in this app,
    // duplicated per this repo's self-contained-module convention. Sorts
    // the underlying {doc, data, itemType} items BEFORE they're built
    // into <tr> elements (buildMilestoneRow already returns a live DOM
    // node, not sortable data), using a small proxy value per column:
    // "statusProgress" mirrors buildMilestoneRow's own RAG derivation
    // (occurred > all-checked > partially-checked > not-started).
    const theadEl = dom.table ? dom.table.querySelector('thead') : null;
    if (theadEl && !theadEl.__sortWired) {
      theadEl.__sortWired = true;
      theadEl.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-sort]');
        if (!th) return;
        const key = th.getAttribute('data-sort');
        if (milestoneSort.key === key) {
          milestoneSort.dir = milestoneSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          milestoneSort.key = key;
          milestoneSort.dir = 'asc';
        }
        if (lastSnapshot) renderSnapshot(dom, lastSnapshot);
      });
    }
    function statusProgressValue({ data }) {
      const dueJs = window.drRag ? window.drRag.toJsDate(data.dueDate) : (data.dueDate ? new Date(data.dueDate) : null);
      const occurred = window.drRag && dueJs && window.drRag.dateOnly(dueJs) < window.drRag.dateOnly(new Date());
      if (occurred) return 1000; // settled, ranks above any in-progress checklist
      const checklistDone = Array.isArray(data.checklistDone) ? data.checklistDone : [];
      return checklistDone.filter((v) => v === true).length;
    }
    function sortValue(item, key) {
      switch (key) {
        case 'title': return (item.data.title || '').toLowerCase();
        case 'itemType': return item.itemType.toLowerCase();
        case 'location': {
          const venue = item.data.status || item.data.location || '';
          return venue.toLowerCase();
        }
        case 'place': return (item.data.place || '').toLowerCase();
        case 'dueDate': {
          const d = window.drRag ? window.drRag.toJsDate(item.data.dueDate) : (item.data.dueDate ? new Date(item.data.dueDate) : null);
          return d ? d.getTime() : 0;
        }
        case 'statusProgress': return statusProgressValue(item);
        case 'confirmed': return (item.data.confirmed || 'Pending Approval').toLowerCase();
        default: return '';
      }
    }
    if (milestoneSort.key) {
      const dir = milestoneSort.dir === 'desc' ? -1 : 1;
      items.sort((a, b) => {
        const av = sortValue(a, milestoneSort.key);
        const bv = sortValue(b, milestoneSort.key);
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    theadEl && theadEl.querySelectorAll('th[data-sort]').forEach((th) => {
      th.classList.remove('asc', 'desc');
      if (milestoneSort.key && th.getAttribute('data-sort') === milestoneSort.key) th.classList.add(milestoneSort.dir);
    });

    // Stats (insight text, "next up") cover every meeting/event in the
    // project, not just whichever page is currently showing.
    let upcomingCount = 0;
    let nextItem = null;
    const now = window.drRag ? window.drRag.dateOnly(new Date()) : new Date();

    const built = items.map(({ doc, data, itemType }, idx) => {
      const row = buildMilestoneRow(doc, data, itemType);
      // No natural human-readable code for a meeting/event (just a
      // Firestore doc id) — a synthetic, position-based one instead, same
      // caveat as RACI's ACT-## codes: regenerated fresh every render, only
      // meaningful for "whichever item this sentence is naming right now."
      const refCode = 'M-' + String(idx + 1).padStart(2, '0');
      if (window.drRefs) {
        window.drRefs.register(refCode, {
          cardId: 'milestoneSection', cardLabel: 'Meetings/Events',
          summary: data.title || itemType,
          fields: [{ label: 'Type', value: itemType }, { label: 'Place', value: data.place }, { label: 'Status', value: data.status }]
        });
      }
      if (row.dueJs && !isNaN(row.dueJs.getTime()) && !row.occurred) {
        upcomingCount++;
        if (!nextItem || row.dueJs < nextItem.due) {
          nextItem = { due: row.dueJs, title: data.title || itemType, type: itemType, refCode: refCode };
        }
      }
      return row.tr;
    });

    const totalPages = Math.max(1, Math.ceil(built.length / MILESTONE_PAGE_SIZE));
    if (milestonePage > totalPages) milestonePage = totalPages;
    if (milestonePage < 1) milestonePage = 1;
    const startIdx = (milestonePage - 1) * MILESTONE_PAGE_SIZE;
    built.slice(startIdx, startIdx + MILESTONE_PAGE_SIZE).forEach((tr) => tbody.appendChild(tr));

    const pageInfoEl = document.getElementById('milestonePageInfo');
    if (pageInfoEl) pageInfoEl.textContent = 'Page ' + milestonePage + ' of ' + totalPages + ' (' + built.length + (built.length === 1 ? ' row' : ' rows') + ')';
    const prevBtnEl = document.getElementById('milestonePagePrev');
    const nextBtnEl = document.getElementById('milestonePageNext');
    if (prevBtnEl) prevBtnEl.disabled = milestonePage <= 1;
    if (nextBtnEl) nextBtnEl.disabled = milestonePage >= totalPages;

    if (window.drInsight) {
      let text = built.length + (built.length === 1 ? ' meeting/event tracked' : ' meetings/events tracked') + ', ' + upcomingCount + ' still upcoming.';
      if (nextItem) {
        const daysAway = Math.round((nextItem.due - now) / 86400000);
        text += ' Next up: ' + nextItem.refCode + ' — "' + nextItem.title + '" (' + nextItem.type + ') in ' + daysAway + (daysAway === 1 ? ' day.' : ' days.');
      }
      window.drInsight.set('milestoneSection', text);
    }
  }

  // ---------- Editing helpers ----------
  function enterEditMode(dom, docId, data) {
    const { titleInput, typeSelect, statusSelect, otherDescInput, placeInput, dateInput, submitBtn, cancelBtn } = dom;

    editingId = docId;
    editingOriginalData = data || {};

    // Fill form with current values
    titleInput.value = data.title || "";
    // Existing (pre-Type) entries have no type field at all — leave the
    // dropdown on its blank prompt so editing forces a real choice,
    // rather than silently defaulting to one.
    typeSelect.value = data.type || "";
    if (placeInput) placeInput.value = data.place || "";

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

    submitBtn.textContent = "Update Meeting/Event";
    submitBtn.classList.add("milestone-update-mode");

    // Static button (sits next to Update in the form itself, per explicit
    // layout request) — just toggle visibility; the click listener is
    // wired once in attachHandlers rather than recreated every edit.
    cancelBtn.style.display = "inline-block";
  }

  function exitEditMode(dom) {
    const { titleInput, typeSelect, statusSelect, otherDescInput, placeInput, dateInput, submitBtn, cancelBtn } = dom;

    editingId = null;
    editingOriginalData = null;
    titleInput.value = "";
    dateInput.value = "";
    if (typeSelect.options.length) {
      typeSelect.selectedIndex = 0;
    }
    if (statusSelect.options.length) {
      statusSelect.selectedIndex = 0;
    }
    if (otherDescInput) {
      otherDescInput.value = "";
      otherDescInput.style.display = "none";
    }
    if (placeInput) placeInput.value = "";

    submitBtn.textContent = "Add Meeting/Event";
    submitBtn.classList.remove("milestone-update-mode");

    cancelBtn.style.display = "none";
  }

  // ---------- Handlers ----------
  function attachHandlers(dom) {
    const { form, titleInput, typeSelect, statusSelect, otherDescInput, placeInput, dateInput, tbody, cancelBtn } = dom;

    if (cancelBtn && !cancelBtn.__wired) {
      cancelBtn.__wired = true;
      cancelBtn.addEventListener("click", function () {
        exitEditMode(dom);
      });
    }

    // Add / Update submit handler – owner only
    if (isOwner && form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();

        const title = titleInput.value.trim();
        const type = typeSelect.value || "";
        const status = statusSelect.value || "";
        const locationOther = status === "Other" && otherDescInput ? otherDescInput.value.trim() : "";
        const place = placeInput ? placeInput.value.trim() : "";
        const dateVal = dateInput.value; // yyyy-mm-dd

        if (!title) {
          alert("Please enter a milestone title.");
          return;
        }
        if (!type) {
          alert("Please select a Type (Meeting, Event, or Milestone).");
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
          type,
          status,
          locationOther: locationOther || null,
          place: place || null,
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
              typeSelect.selectedIndex = 0;
              statusSelect.selectedIndex = 0;
              if (placeInput) placeInput.value = "";
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

    // Setup Checklist — visible to everyone, so wired unconditionally
    // (unlike edit/delete above). Title/date come straight off the row
    // already in the DOM, but checklistDone is fetched fresh from
    // Firestore each time so the popup always reflects the latest saved
    // check state, even if it was changed from a previous popup session.
    if (tbody && !tbody.__checklistWired) {
      tbody.__checklistWired = true;
      tbody.addEventListener("click", function (e) {
        const btn = e.target.closest('button[data-action="checklist"]');
        if (!btn) return;
        const tr = btn.closest("tr");
        if (!tr) return;
        const id = tr.dataset.id;
        const cells = tr.querySelectorAll("td");
        const title = cells[0] ? cells[0].textContent.trim() : "Untitled";
        const type = cells[1] ? cells[1].textContent.trim() : "";
        const eventDate = tr.dataset.due ? new Date(tr.dataset.due) : null;

        colRef.doc(id).get().then(function (docSnap) {
          const checklistDone = (docSnap.exists && Array.isArray(docSnap.data().checklistDone)) ? docSnap.data().checklistDone : [];
          openChecklistWindow(id, title, type, eventDate, checklistDone);
        }).catch(function (err) {
          error("checklist fetch failed:", err);
          openChecklistWindow(id, title, type, eventDate, []);
        });
      });
    }

    // Minutes & Action Items — same fetch-fresh-then-open pattern as the
    // checklist above.
    if (tbody && !tbody.__minutesWired) {
      tbody.__minutesWired = true;
      tbody.addEventListener("click", function (e) {
        const btn = e.target.closest('button[data-action="minutes"]');
        if (!btn) return;
        const tr = btn.closest("tr");
        if (!tr) return;
        const id = tr.dataset.id;
        const cells = tr.querySelectorAll("td");
        const title = cells[0] ? cells[0].textContent.trim() : "Untitled";
        const type = cells[1] ? cells[1].textContent.trim() : "";

        colRef.doc(id).get().then(function (docSnap) {
          const data = (docSnap.exists && docSnap.data()) || {};
          openMinutesWindow(id, title, type, data.minutesNotes || "", Array.isArray(data.actionItems) ? data.actionItems : []);
        }).catch(function (err) {
          error("minutes fetch failed:", err);
          openMinutesWindow(id, title, type, "", []);
        });
      });
    }

    // Confirmed dropdown — saves the moment it's changed, same
    // inline-edit-and-save pattern as the checklist button above. Reads
    // the doc first (rather than trusting a dataset attribute for the
    // "from" value) so the changeLog entry is accurate even if two tabs
    // are open, same reasoning as every other changeLog write in this app.
    if (tbody && !tbody.__confirmedWired) {
      tbody.__confirmedWired = true;
      tbody.addEventListener("change", function (e) {
        const sel = e.target.closest('select[data-action="confirmed"]');
        if (!sel) return;
        const tr = sel.closest("tr");
        if (!tr) return;
        const id = tr.dataset.id;
        const value = sel.value;

        colRef.doc(id).get().then(function (docSnap) {
          const before = (docSnap.exists && docSnap.data()) || {};
          const previousValue = before.confirmed || "Pending Approval";
          const changeLog = (before.changeLog || []).slice(-4);
          if (previousValue !== value) {
            changeLog.push({
              changes: [{ field: "Confirmed", from: previousValue, to: value }],
              changedAt: new Date(),
              changedBy: userEmail || "Someone"
            });
          }
          return colRef.doc(id).update({
            confirmed: value,
            updatedAt: new Date(),
            updatedBy: userEmail || null,
            changeLog: changeLog
          });
        }).catch(function (err) {
          error("save confirmed status failed:", err);
          alert("Could not save — please try again: " + (err && err.message ? err.message : err));
        });
      });
    }

    const pagePrevBtn = document.getElementById("milestonePagePrev");
    const pageNextBtn = document.getElementById("milestonePageNext");
    if (pagePrevBtn && !pagePrevBtn.__wired) {
      pagePrevBtn.__wired = true;
      pagePrevBtn.addEventListener("click", function () {
        milestonePage--;
        if (lastSnapshot) renderSnapshot(dom, lastSnapshot);
      });
    }
    if (pageNextBtn && !pageNextBtn.__wired) {
      pageNextBtn.__wired = true;
      pageNextBtn.addEventListener("click", function () {
        milestonePage++;
        if (lastSnapshot) renderSnapshot(dom, lastSnapshot);
      });
    }

    // Up/down page-scroll — same directional pad as Assumptions Log/
    // Constraints Log's own scroll buttons.
    const scrollUpBtn = document.getElementById("milestonePageUp");
    const scrollDownBtn = document.getElementById("milestonePageDown");
    if (scrollUpBtn && !scrollUpBtn.__wired) {
      scrollUpBtn.__wired = true;
      scrollUpBtn.addEventListener("click", function () {
        const scrollEl = document.querySelector(".milestone-table-container");
        if (scrollEl) scrollEl.scrollBy({ top: -scrollEl.clientHeight * 0.6, behavior: "smooth" });
      });
    }
    if (scrollDownBtn && !scrollDownBtn.__wired) {
      scrollDownBtn.__wired = true;
      scrollDownBtn.addEventListener("click", function () {
        const scrollEl = document.querySelector(".milestone-table-container");
        if (scrollEl) scrollEl.scrollBy({ top: scrollEl.clientHeight * 0.6, behavior: "smooth" });
      });
    }
  }

  // Called from the popup window (same-origin, via window.opener) whenever
  // a checkbox is toggled — persists straight to Firestore so the main
  // table's Status column (checklist-completion based, see renderSnapshot)
  // updates the moment the popup's live listener re-fires. ALWAYS returns
  // a Promise resolving to {ok, message} — never rejects — so the popup
  // (a separate window, calling across window.opener) can show the user
  // whether it actually saved instead of failing silently, which is what
  // was happening before: a permission error, for instance, only ever
  // reached the console, never the person clicking the checkbox.
  window.drMilestoneChecklist = {
    save: function (docId, checklistDone) {
      if (!colRef) return Promise.resolve({ ok: false, message: "Not ready yet — please try again." });
      return colRef.doc(docId).update({ checklistDone: checklistDone }).then(function () {
        return { ok: true, message: "Saved" };
      }).catch(function (err) {
        error("checklist save failed:", err);
        var msg = (err && err.code === "permission-denied")
          ? "You don't have permission to update this checklist."
          : "Save failed: " + (err && err.message ? err.message : "unknown error");
        return { ok: false, message: msg };
      });
    }
  };

  // Same cross-window save bridge as drMilestoneChecklist above, for the
  // Minutes & Action Items popup.
  window.drMilestoneMinutes = {
    save: function (docId, payload) {
      if (!colRef) return Promise.resolve({ ok: false, message: "Not ready yet — please try again." });
      return colRef.doc(docId).update({
        minutesNotes: payload.notes || "",
        actionItems: Array.isArray(payload.actionItems) ? payload.actionItems : [],
        updatedAt: new Date(),
        updatedBy: userEmail || null
      }).then(function () {
        return { ok: true, message: "Saved" };
      }).catch(function (err) {
        error("minutes save failed:", err);
        var msg = (err && err.code === "permission-denied")
          ? "You don't have permission to update minutes for this meeting/event."
          : "Save failed: " + (err && err.message ? err.message : "unknown error");
        return { ok: false, message: msg };
      });
    }
  };

  // ---------- Setup Checklist popup window ----------
  // Opens in a genuinely separate browser window (not an in-page modal)
  // so it doesn't disturb the dashboard's own layout — same pattern as
  // the Health Scorecard's "View full list" risk popup (see burndown.js).
  // The checklist itself is a suggested TEMPLATE (per explicit request:
  // "you can populate this list on what you think is appropriate"), not
  // data pulled from Firestore — due dates are computed backward from the
  // meeting/event's own date; Owner Responsible defaults to a plausible
  // role per task since there's no per-checklist-item owner field today.
  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function fmtChecklistDate(d) {
    if (!d || isNaN(d.getTime())) return "—";
    return window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString();
  }

  // { task, daysBefore, owner } — daysBefore is relative to the event's own
  // due date; negative means "after" (the follow-up step). Shared between
  // buildChecklistItems (the popup) and renderSnapshot (the main table's
  // completion-based Status column), so both always agree on the total
  // item count.
  const CHECKLIST_TEMPLATE = [
    { task: "Obtain budget approval", daysBefore: 14, owner: "Project Manager" },
    { task: "Define objective & agenda", daysBefore: 14, owner: "Project Manager" },
    { task: "Confirm attendee list", daysBefore: 14, owner: "Project Manager" },
    { task: "Send calendar invite / save-the-date", daysBefore: 10, owner: "Coordinator" },
    { task: "Book venue or set up virtual meeting link", daysBefore: 10, owner: "Coordinator" },
    { task: "Prepare materials, slides, or handouts", daysBefore: 5, owner: "Presenter/Lead" },
    { task: "Confirm A/V, tech, and logistics", daysBefore: 3, owner: "IT/Support" },
    { task: "Send reminder to attendees", daysBefore: 1, owner: "Coordinator" },
    { task: "Conduct meeting/event", daysBefore: 0, owner: "Facilitator" },
    { task: "Send follow-up notes & action items", daysBefore: -1, owner: "Project Manager" }
  ];

  function buildChecklistItems(eventDate) {
    return CHECKLIST_TEMPLATE.map(function (item) {
      var due = null;
      if (eventDate && !isNaN(eventDate.getTime())) {
        due = new Date(eventDate.getTime() - item.daysBefore * 86400000);
      }
      return { task: item.task, due: due, owner: item.owner };
    });
  }

  function openChecklistWindow(docId, title, type, eventDate, checklistDone) {
    const bizKey = (function () {
      try { return (new URLSearchParams(window.location.search).get("business") || window.BIZ_KEY || "").trim(); }
      catch (e) { return ""; }
    })();
    const qnaUrl = "dashboard.html?business=" + encodeURIComponent(bizKey) + "#qnaSection";
    const filesUrl = "dashboard.html?business=" + encodeURIComponent(bizKey) + "#fileManagerSection";

    const items = buildChecklistItems(eventDate && !isNaN(eventDate.getTime()) ? eventDate : null);
    const doneArr = Array.isArray(checklistDone) ? checklistDone : [];

    const rows = items.map(function (item, idx) {
      const checked = doneArr[idx] === true ? " checked" : "";
      return "<tr><td>" + escHtml(item.task) + "</td><td>" + escHtml(fmtChecklistDate(item.due)) + "</td><td>" + escHtml(item.owner) + "</td>" +
        "<td style=\"text-align:center;\"><input type=\"checkbox\" data-idx=\"" + idx + "\"" + checked + " /></td></tr>";
    }).join("");

    const html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Setup Checklist</title><style>" +
      "body{font-family:Arial,Helvetica,sans-serif;margin:20px;color:#222;padding-bottom:40px;position:relative;min-height:calc(100vh - 60px);}" +
      "h1{font-size:1.25rem;margin:0 0 2px;}" +
      "p.sub{color:#666;font-size:0.85rem;margin:0 0 16px;}" +
      "table{border-collapse:collapse;width:100%;font-size:0.85rem;}" +
      "th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top;}" +
      "th{background:#f3f3f3;}" +
      "a{color:#2a78d6;text-decoration:none;}" +
      "a:hover{text-decoration:underline;}" +
      "#saveStatus{font-size:0.78rem;margin:10px 0 0;min-height:1.2em;}" +
      "#saveStatus.ok{color:#2f9e44;}" +
      "#saveStatus.err{color:#dd3333;font-weight:600;}" +
      "#progressLine{font-size:0.85rem;font-weight:600;margin:0 0 10px;}" +
      ".quick-links-corner{position:absolute;right:8px;bottom:4px;display:flex;gap:10px;font-size:0.72rem;}" +
      "</style></head><body>" +
      "<h1>" + escHtml(title) + (type ? " <span style=\"font-weight:normal;color:#666;\">(" + escHtml(type) + ")</span>" : "") + "</h1>" +
      "<p class=\"sub\">Suggested setup checklist. Checking items here saves immediately and updates the main table's Status column — how many are checked off drives Not Started / In Progress / Ready.</p>" +
      "<p id=\"progressLine\"></p>" +
      "<table><thead><tr><th>Task</th><th>Due Date</th><th>Owner Responsible</th><th>Done</th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table>" +
      "<p id=\"saveStatus\"></p>" +
      "<div class=\"quick-links-corner\"><a href=\"" + qnaUrl + "\" target=\"_blank\" rel=\"noopener\">Q&amp;A →</a><a href=\"" + filesUrl + "\" target=\"_blank\" rel=\"noopener\">Files →</a></div>" +
      "<script>" +
      "var STATE=" + JSON.stringify(doneArr.length ? doneArr : items.map(function(){ return false; })) + ";" +
      "var TOTAL=STATE.length;" +
      "var statusEl=document.getElementById('saveStatus');" +
      "var progressEl=document.getElementById('progressLine');" +
      "function renderProgress(){var n=STATE.filter(Boolean).length;progressEl.textContent=n+' of '+TOTAL+' complete';}" +
      "function doSave(){" +
      "if(!(window.opener&&window.opener.drMilestoneChecklist)){statusEl.className='err';statusEl.textContent='Could not reach the dashboard tab to save — keep this window open alongside it, not instead of it.';return;}" +
      "statusEl.className='';statusEl.textContent='Saving…';" +
      "window.opener.drMilestoneChecklist.save(" + JSON.stringify(docId) + ",STATE.slice()).then(function(result){" +
      "statusEl.className=result.ok?'ok':'err';" +
      "statusEl.textContent=result.ok?'Saved ✓':result.message;" +
      "});" +
      "}" +
      "document.querySelectorAll('input[type=checkbox][data-idx]').forEach(function(cb){" +
      "cb.addEventListener('change',function(){" +
      "STATE[Number(cb.getAttribute('data-idx'))]=cb.checked;" +
      "renderProgress();" +
      "doSave();" +
      "});});" +
      "renderProgress();" +
      // Best-effort extra save right as the window closes, in case a
      // rapid last-second checkbox click didn't get a chance to confirm
      // its own save before the user closed the popup.
      "window.addEventListener('beforeunload',function(){" +
      "if(window.opener&&window.opener.drMilestoneChecklist){window.opener.drMilestoneChecklist.save(" + JSON.stringify(docId) + ",STATE.slice());}" +
      "});" +
      "</script>" +
      "</body></html>";

    const win = window.open("", "_blank", "width=760,height=640");
    if (!win) { alert("Please allow pop-ups to view the setup checklist in a new window."); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  // ---------- Minutes & Action Items popup window ----------
  // Same separate-window precedent as the Setup Checklist above (doesn't
  // disturb the dashboard's own layout). Unlike the checklist's
  // auto-save-per-checkbox, notes is free text — one explicit Save button
  // covers both the notes textarea and the action items table together,
  // plus the same best-effort beforeunload save as a safety net.
  function openMinutesWindow(docId, title, type, notes, actionItems) {
    const rows = (actionItems || []).map(function (item, idx) {
      return "<tr data-idx=\"" + idx + "\">" +
        "<td><input type=\"text\" class=\"ai-text\" value=\"" + escHtml(item.text || "") + "\" placeholder=\"Action item\" /></td>" +
        "<td><input type=\"text\" class=\"ai-owner\" value=\"" + escHtml(item.owner || "") + "\" placeholder=\"Owner\" /></td>" +
        "<td><input type=\"date\" class=\"ai-due\" value=\"" + escHtml(item.dueDate || "") + "\" /></td>" +
        "<td style=\"text-align:center;\"><input type=\"checkbox\" class=\"ai-done\"" + (item.done ? " checked" : "") + " /></td>" +
        "<td style=\"text-align:center;\"><button type=\"button\" class=\"ai-del\" title=\"Remove\">🗑️</button></td></tr>";
    }).join("");

    const html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Minutes & Action Items</title><style>" +
      "body{font-family:Arial,Helvetica,sans-serif;margin:20px;color:#222;padding-bottom:40px;}" +
      "h1{font-size:1.25rem;margin:0 0 2px;}" +
      "p.sub{color:#666;font-size:0.85rem;margin:0 0 16px;}" +
      "h2{font-size:1rem;margin:18px 0 6px;}" +
      "textarea{width:100%;min-height:120px;box-sizing:border-box;font-family:inherit;font-size:0.88rem;padding:8px;border:1px solid #ccc;border-radius:4px;resize:vertical;}" +
      "table{border-collapse:collapse;width:100%;font-size:0.85rem;margin-top:6px;}" +
      "th,td{border:1px solid #ddd;padding:5px 6px;text-align:left;vertical-align:top;}" +
      "th{background:#f3f3f3;}" +
      "input[type=text],input[type=date]{width:100%;box-sizing:border-box;font-family:inherit;font-size:0.85rem;padding:4px 6px;border:1px solid #ccc;border-radius:3px;}" +
      "button{cursor:pointer;}" +
      ".ai-del{border:none;background:transparent;font-size:0.95rem;}" +
      "#addRowBtn{margin-top:8px;padding:5px 12px;font-size:0.82rem;border:1px solid #004e92;color:#004e92;background:#fff;border-radius:4px;}" +
      "#saveBtn{margin-top:16px;padding:8px 20px;font-size:0.88rem;background:#004e92;color:#fff;border:none;border-radius:4px;}" +
      "#saveStatus{font-size:0.78rem;margin:10px 0 0;min-height:1.2em;}" +
      "#saveStatus.ok{color:#2f9e44;}" +
      "#saveStatus.err{color:#dd3333;font-weight:600;}" +
      "</style></head><body>" +
      "<h1>" + escHtml(title) + (type ? " <span style=\"font-weight:normal;color:#666;\">(" + escHtml(type) + ")</span>" : "") + "</h1>" +
      "<p class=\"sub\">Meeting notes and action items — click Save to write both back to the dashboard.</p>" +
      "<h2>Notes</h2>" +
      "<textarea id=\"notesInput\" placeholder=\"What was discussed, decided, or noted…\">" + escHtml(notes) + "</textarea>" +
      "<h2>Action Items</h2>" +
      "<table id=\"aiTable\"><thead><tr><th>Item</th><th>Owner</th><th>Due</th><th>Done</th><th></th></tr></thead>" +
      "<tbody id=\"aiBody\">" + rows + "</tbody></table>" +
      "<button type=\"button\" id=\"addRowBtn\">+ Add Action Item</button><br/>" +
      "<button type=\"button\" id=\"saveBtn\">Save</button>" +
      "<p id=\"saveStatus\"></p>" +
      "<script>" +
      "var tbody=document.getElementById('aiBody');" +
      "function addRow(item){" +
      "item=item||{text:'',owner:'',dueDate:'',done:false};" +
      "var tr=document.createElement('tr');" +
      "tr.innerHTML='<td><input type=\"text\" class=\"ai-text\" placeholder=\"Action item\" /></td>'+" +
      "'<td><input type=\"text\" class=\"ai-owner\" placeholder=\"Owner\" /></td>'+" +
      "'<td><input type=\"date\" class=\"ai-due\" /></td>'+" +
      "'<td style=\"text-align:center;\"><input type=\"checkbox\" class=\"ai-done\" /></td>'+" +
      "'<td style=\"text-align:center;\"><button type=\"button\" class=\"ai-del\" title=\"Remove\">\\uD83D\\uDDD1\\uFE0F</button></td>';" +
      "tbody.appendChild(tr);" +
      "}" +
      "document.getElementById('addRowBtn').addEventListener('click',function(){addRow();});" +
      "tbody.addEventListener('click',function(e){" +
      "var btn=e.target.closest('.ai-del');" +
      "if(btn){btn.closest('tr').remove();}" +
      "});" +
      "function collect(){" +
      "var items=[];" +
      "tbody.querySelectorAll('tr').forEach(function(tr){" +
      "var text=tr.querySelector('.ai-text').value.trim();" +
      "var owner=tr.querySelector('.ai-owner').value.trim();" +
      "var due=tr.querySelector('.ai-due').value;" +
      "var done=tr.querySelector('.ai-done').checked;" +
      "if(text||owner||due){items.push({text:text,owner:owner,dueDate:due,done:done});}" +
      "});" +
      "return items;" +
      "}" +
      "var statusEl=document.getElementById('saveStatus');" +
      "function doSave(){" +
      "if(!(window.opener&&window.opener.drMilestoneMinutes)){statusEl.className='err';statusEl.textContent='Could not reach the dashboard tab to save — keep this window open alongside it, not instead of it.';return;}" +
      "statusEl.className='';statusEl.textContent='Saving…';" +
      "window.opener.drMilestoneMinutes.save(" + JSON.stringify(docId) + ",{notes:document.getElementById('notesInput').value,actionItems:collect()}).then(function(result){" +
      "statusEl.className=result.ok?'ok':'err';" +
      "statusEl.textContent=result.ok?'Saved ✓':result.message;" +
      "});" +
      "}" +
      "document.getElementById('saveBtn').addEventListener('click',doSave);" +
      "window.addEventListener('beforeunload',function(){" +
      "if(window.opener&&window.opener.drMilestoneMinutes){window.opener.drMilestoneMinutes.save(" + JSON.stringify(docId) + ",{notes:document.getElementById('notesInput').value,actionItems:collect()});}" +
      "});" +
      "</script>" +
      "</body></html>";

    const win = window.open("", "_blank", "width=760,height=680");
    if (!win) { alert("Please allow pop-ups to view meeting minutes in a new window."); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  // ---------- Main start ----------
  function start() {
    db = window.db || null;
    auth = window.auth || null;

    if (!db || !auth) {
      warn("Firebase SDK still missing even after firebase-ready.");
      return;
    }

    // auth.currentUser is often still null here — the "firebase-ready"
    // event only means the SDK itself has initialized, not that Firebase
    // Auth has finished restoring the signed-in session (that happens
    // asynchronously, slightly later). Reading auth.currentUser
    // synchronously at this point used to lock isOwner to false for the
    // rest of the session — even for the real owner — since it was only
    // ever computed once. Every other owner-gated card in this app waits
    // on onAuthStateChanged instead; this now does the same, and re-syncs
    // the owner-only UI (and re-renders any milestones already loaded) on
    // every auth resolution, not just the first.
    let started = false;

    auth.onAuthStateChanged((user) => {
      userEmail = user && user.email ? user.email : null;

      if (!resolveBusinessContext()) {
        return;
      }

      if (!started) {
        started = true;

        colRef = db
          .collection("businesses")
          .doc(bizKey)
          .collection("projects")
          .doc(projKey || "default")
          .collection("milestones");

        dom = getDom();
        if (!dom) return;

        log("initialized", { bizKey, email: userEmail, isOwner });

        // Live snapshot listener
        colRef.orderBy("dueDate").onSnapshot(
          (snapshot) => {
            log("snapshot size", snapshot.size);
            lastSnapshot = snapshot;
            renderSnapshot(dom, snapshot);
          },
          (err) => {
            error("snapshot error:", err);
          }
        );

        attachHandlers(dom);

        // getDom()'s canViewMilestones check reads window.drAccess.
        // canViewReport() — if dr-access-control.js hasn't resolved
        // role/permissions yet at this point (a real timing race either
        // way), the section stays hidden with no second chance to show
        // itself once access resolves. Re-apply the class toggle (and
        // re-render from the cached snapshot) once it's known to be
        // resolved.
        if (window.drAccess) {
          window.drAccess.whenReady().then(function () {
            getDom();
            if (lastSnapshot) renderSnapshot(dom, lastSnapshot);
          });
        }
        return;
      }

      // Auth resolved AFTER the first pass (e.g. a late session restore) —
      // re-apply the owner-only class toggles and re-render the already-
      // loaded rows so Edit/Delete appear without needing a page reload.
      if (!dom) return;
      getDom();
      if (lastSnapshot) renderSnapshot(dom, lastSnapshot);
    });
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
