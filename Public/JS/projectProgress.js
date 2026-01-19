// /Public/JS/projectProgress.js
// Vertical cylinder project progress linked to businesses/{biz}.projectProgress


(function () {
  var LOG = "[projectProgress]";
  // Read owner email from a global or environment config
var OWNER_EMAIL =
  (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) ||
  (window.ownerEmail) ||
  '';

  function clamp(num, min, max) {
    return Math.min(max, Math.max(min, num));
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

  function renderProgress(percent, card, fillEl, labelEl) {
    var p = clamp(Math.round(percent || 0), 0, 100);

    if (fillEl) fillEl.style.height = p + "%";
    if (labelEl) labelEl.textContent = p + "%";
    if (card) card.setAttribute("data-progress", String(p));

    console.log(LOG, "renderProgress →", p);
  }

  function init() {
    console.log(LOG, "init called");

    waitForFirebase(function (DR) {
      waitForBusinessKey(function (bizKey) {
        var user = DR.auth.currentUser || {};
        var email = (user.email || "").toLowerCase();
        var isOwner = email === OWNER_EMAIL;

        console.log(LOG, "context:", {
          bizKey: bizKey,
          email: user.email || "",
          isOwner: isOwner
        });

        // DOM lookups
        var card =
          document.querySelector("section.project-progress") ||
          document.querySelector(".project-progress.card");

        var container = document.getElementById("progress-bar-container");
        var fillEl = document.getElementById("progress-bar-fill");
        var labelEl = document.getElementById("progress-label");

        if (!card || !container || !fillEl || !labelEl) {
          console.warn(LOG, "Required DOM not found", {
            hasCard: !!card,
            hasContainer: !!container,
            hasFill: !!fillEl,
            hasLabel: !!labelEl
          });
          return;
        }

        // Tag owner vs non-owner on the card for CSS
        if (isOwner) card.classList.add("owner");
        else card.classList.remove("owner");

        var docRef = DR.db.collection("businesses").doc(bizKey);

        // Live Firestore listener
        docRef.onSnapshot(function (snap) {
          if (!snap.exists) {
            console.warn(LOG, "businesses/" + bizKey + " does not exist yet, defaulting to 0%");
            renderProgress(0, card, fillEl, labelEl);
            return;
          }
          var data = snap.data() || {};
          var raw = data.projectProgress;
          var value = typeof raw === "number" ? raw : parseFloat(raw || "0");
          if (!isFinite(value)) value = 0;
          renderProgress(value, card, fillEl, labelEl);
        }, function (err) {
          console.error(LOG, "Snapshot failed:", err);
        });

        function persistProgress(percent) {
          if (!isOwner) return;
          var p = clamp(Math.round(percent || 0), 0, 100);
          console.log(LOG, "Saving projectProgress", p, "for", bizKey);

          docRef.update({ projectProgress: p }).catch(function (err) {
            console.error(LOG, "Update failed:", err);
            try {
              alert("Could not update Project Progress: " + (err && err.message ? err.message : err));
            } catch (e) {}
          });
        }

        // Owner can click inside the cylinder to set progress
        if (isOwner) {
          container.addEventListener("click", function (evt) {
            var rect = container.getBoundingClientRect();
            var y = evt.clientY - rect.top;
            var height = rect.height || 1;

            // y from top; 0 → 100%, height → 0%
            var percent = 100 - (y / height) * 100;
            var clamped = clamp(percent, 0, 100);

            console.log(LOG, "click →", { y: y, height: height, percent: clamped });
            renderProgress(clamped, card, fillEl, labelEl);
            persistProgress(clamped);
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