// /Public/JS/projectStatus.js
// Traffic-light Project Status widget — READ-ONLY display. The status is
// now computed automatically from SPI and/or CPI (see burndown.js's
// writeAutoProjectStatus, which runs once per session for the Owner —
// only the Owner has Firestore write permission on this document) rather
// than clicked/set manually, so this file just renders whatever's
// currently in businesses/{biz}.projectStatus, live via onSnapshot, plus
// a "Last updated" timestamp in the header from the same document.

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

        // Read-only for everyone now — no more click-to-set.
        rows.forEach(function (row) {
          row.style.cursor = "default";
        });

        // The status light and its SPI/CPI reasoning are per PROJECT (the company document is shared).
        var docRef = DR.db.collection("businesses").doc(bizKey).collection("projects").doc(window.PROJECT_KEY || "default");
        var lastUpdatedEl = document.getElementById("headerLastUpdated");

        // Live listener — also drives the header's "Last updated" text
        // from the same document, so it stays in sync automatically
        // whenever burndown.js's auto-status write lands (no separate
        // listener needed).
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

            if (lastUpdatedEl) {
              var computedAt = data.projectStatusComputedAt;
              var d = computedAt && computedAt.toDate ? computedAt.toDate() : (computedAt ? new Date(computedAt) : null);
              lastUpdatedEl.textContent = d && !isNaN(d.getTime())
                ? 'Last updated: ' + (window.drDateFmt ? window.drDateFmt.dateTime(d) : d.toLocaleString())
                : '';
            }

            if (window.drInsight) {
              if (code === 'unknown') {
                window.drInsight.set('projectStatusCard', '');
              } else {
                var spi = typeof data.spi === 'number' ? data.spi : null;
                var cpi = typeof data.cpi === 'number' ? data.cpi : null;
                var reasons = [];
                if (spi !== null) reasons.push('SPI ' + spi.toFixed(2) + (spi < 1 ? ' (behind schedule)' : ' (on/ahead of schedule)'));
                if (cpi !== null) reasons.push('CPI ' + cpi.toFixed(2) + (cpi < 1 ? ' (over budget)' : ' (on/under budget)'));
                var statusText = (STATUS_META[code] || STATUS_META.unknown).label;
                var text = 'Overall status is ' + statusText + '.';
                if (reasons.length) text += ' Driven by ' + reasons.join(' and ') + '.';
                window.drInsight.set('projectStatusCard', text);
              }
            }
          },
          function (err) {
            console.error(LOG, "Snapshot failed:", err);
          }
        );
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();