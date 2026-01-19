// /Public/JS/projectStatus.js
// Traffic-light Project Status widget.

// businesses/{biz}.projectStatus. Non-owners see the lights but can’t change.

(function () {
  var LOG = "[projectStatus]";
 // Read owner email from a global or environment config
// Read owner email(s) from global config
var OWNER_EMAIL =
  (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) ||
  (window.ownerEmail) ||
  '';

var OWNER_LIST = (window.APP_CONFIG && window.APP_CONFIG.OWNERS) || [];

  var STATUS_META = {
    critical: { code: "critical", label: "Critical" },
    caution:  { code: "caution",  label: "Caution"  },
    onTrack:  { code: "onTrack",  label: "On Plan"  },
    unknown:  { code: "unknown",  label: "Not Set"  }
  };

  function normalizeStatus(raw) {
    if (!raw) return "unknown";
    raw = String(raw).toLowerCase().trim();
    if (raw === "red" || raw.indexOf("crit") === 0) return "critical";
    if (raw === "yellow" || raw === "amber" || raw.indexOf("caut") === 0) return "caution";
    if (raw === "green" || raw.indexOf("on") === 0 || raw.indexOf("track") >= 0) return "onTrack";
    if (raw === "critical" || raw === "caution" || raw === "ontrack") return raw;
    return "unknown";
  }

  function applyStatusToDOM(card, labelEl, rows, code) {
    var meta = STATUS_META[code] || STATUS_META.unknown;

    if (labelEl) {
      labelEl.textContent = "Current Status: " + meta.label;
    }

    if (card) {
      card.setAttribute("data-current-status", meta.code);
      // Card background must stay white – do NOT theme the card itself.
      card.classList.remove("status-critical", "status-caution", "status-ontrack", "status-unknown");
    }

    if (rows && rows.length) {
      rows.forEach(function (row) {
        var rowCode = row.getAttribute("data-code") || row.dataset.code || "";
        var light = row.querySelector(".light");

        row.classList.remove("active");
        row.setAttribute("aria-pressed", "false");
        if (light) {
          light.classList.remove("selected");
        }

        if (normalizeStatus(rowCode) === meta.code && light) {
          row.classList.add("active");
          row.setAttribute("aria-pressed", "true");
          light.classList.add("selected"); // blue ring + brighter via CSS
        }
      });
    }

    console.log(LOG, "rendered status:", meta);
  }

  function waitForFirebase(cb) {
    if (window.firebase && window.auth && window.db) {
      cb({ firebase: firebase, auth: auth, db: db });
      return;
    }
    setTimeout(function () { waitForFirebase(cb); }, 150);
  }

  function waitForBusinessKey(cb) {
    if (window.BIZ_KEY) {
      cb(window.BIZ_KEY);
      return;
    }
    if (typeof window.waitForBusinessKey === "function") {
      window.waitForBusinessKey(function (bizKey) {
        window.BIZ_KEY = bizKey;
        cb(bizKey);
      });
      return;
    }
    setTimeout(function () { waitForBusinessKey(cb); }, 150);
  }

  function init() {
    console.log(LOG, "init called");

    waitForFirebase(function (DR) {
      waitForBusinessKey(function (bizKey) {
        var user = DR.auth.currentUser || {};
  var email = (user.email || '').toLowerCase();

  // allow either a single OWNER_EMAIL or any in OWNERS[]
  var isOwner =
    (OWNER_EMAIL && email === OWNER_EMAIL.toLowerCase()) ||
    OWNER_LIST.map(function (e) { return (e || '').toLowerCase(); })
              .indexOf(email) !== -1;

        console.log(LOG, "context:", { bizKey: bizKey, email: user.email || "", isOwner: isOwner });

        var card =
          document.getElementById("projectStatusCard") ||
          document.querySelector(".project-status.card");
        if (!card) {
          console.warn(LOG, "Project Status card not found in DOM.");
          return;
        }

        var labelEl =
          document.getElementById("projectStatusLabel") ||
          card.querySelector(".project-status-label");

        var rows = Array.prototype.slice.call(
          card.querySelectorAll(".status-row")
        );

        console.log(LOG, "DOM elements:", {
          hasCard: !!card,
          hasLabel: !!labelEl,
          rowCount: rows.length
        });

        // pointer cursor only for owner
        rows.forEach(function (row) {
          row.style.cursor = isOwner ? "pointer" : "default";
        });

        var docRef = DR.db.collection("businesses").doc(bizKey);

        // Live listener
        docRef.onSnapshot(
          function (snap) {
            if (!snap.exists) {
              console.warn(LOG, "businesses/" + bizKey + " does not exist yet.");
              applyStatusToDOM(card, labelEl, rows, "unknown");
              return;
            }
            var data = snap.data() || {};
            var rawStatus =
              data.projectStatus ||
              data.status ||
              data.project_status ||
              "";

            var code = normalizeStatus(rawStatus);
            console.log(LOG, "business snapshot:", {
              rawStatus: rawStatus,
              normalized: code
            });
            applyStatusToDOM(card, labelEl, rows, code);
          },
          function (err) {
            console.error(LOG, "Snapshot failed:", err);
          }
        );

        function persistStatus(code) {
          if (!isOwner) return;

          code = normalizeStatus(code);
          if (!code || code === "unknown") {
            try { alert("Please select a valid status."); } catch (_e) {}
            return;
          }

          console.log(LOG, "Saving status", code, "for", bizKey);
          docRef.update({ projectStatus: code }).catch(function (err) {
            console.error(LOG, "Update failed:", err);
            try {
              alert(
                "Could not update Project Status: " +
                  (err && err.message ? err.message : err)
              );
            } catch (_e) {}
          });
        }

        if (isOwner) {
          rows.forEach(function (row) {
            row.addEventListener("click", function () {
              var code =
                row.getAttribute("data-code") ||
                row.dataset.code ||
                (row.querySelector(".light") &&
                  row.querySelector(".light").getAttribute("data-status")) ||
                "";

              code = normalizeStatus(code);
              console.log(LOG, "row click →", code);
              applyStatusToDOM(card, labelEl, rows, code);
              persistStatus(code);
            });
          });
        }
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();