// /Public/JS/lets-talk.js
// Classic (compat) version — waits for onFirebaseReady before touching Firebase.
// Submits the “Let’s Talk” form to Firestore. If a businessKey exists, saves under
// businesses/{businessKey}/leads; otherwise saves to a public leads collection.

(function () {
  var LOG = "[lets-talk]";

  console.log(LOG, "loaded");

  function wireForm(DR) {
    try {
      var db   = DR && DR.db;
      var auth = DR && DR.auth;
      var bk   = DR && DR.businessKey;

      console.log(LOG, "SDK ready. user:", (auth && auth.currentUser && auth.currentUser.email) || "(signed out)", "businessKey:", bk || "(none)");

      // Find your form (adjust the selector if your form has a different id)
      var form = document.querySelector("#letsTalkForm");
      if (!form) {
        console.warn(LOG, "Form #letsTalkForm not found on this page. Nothing to wire up.");
        return;
      }

      // Grab inputs (adjust names/selectors to match your markup)
      var nameEl    = form.querySelector('[name="name"], #name, .name');
      var emailEl   = form.querySelector('[name="email"], #email, .email');
      var phoneEl   = form.querySelector('[name="phone"], #phone, .phone');
      var messageEl = form.querySelector('[name="message"], #message, .message');

      form.addEventListener("submit", async function (e) {
        e.preventDefault();

        var name    = (nameEl && nameEl.value || "").trim();
        var email   = (emailEl && emailEl.value || "").trim();
        var phone   = (phoneEl && phoneEl.value || "").trim();
        var message = (messageEl && messageEl.value || "").trim();

        if (!email && !phone) {
          console.warn(LOG, "Please provide at least an email or phone.");
          try { alert("Please provide at least an email or phone."); } catch (_) {}
          return;
        }

        // Choose collection: business-scoped if we have a businessKey; else a public inbox.
        var colRef = bk
          ? db.collection("businesses").doc(bk).collection("leads")
          : db.collection("leads_public");

        var payload = {
          name: name || null,
          email: email || null,
          phone: phone || null,
          message: message || null,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          source: "lets-talk",
          // who is submitting (if logged in)
          submittedBy: (auth && auth.currentUser && auth.currentUser.email) || null,
          // keep track of which business (if any)
          businessKey: bk || null,
          page: location.pathname + location.search
        };

        console.log(LOG, "Submitting lead…", payload);

        try {
          var docRef = await colRef.add(payload);
          console.log(LOG, "Lead saved with id:", docRef.id);
          try { form.reset(); } catch (_) {}
          try { alert("Thanks! We’ll be in touch shortly."); } catch (_) {}
        } catch (err) {
          console.error(LOG, "Failed to save lead:", err);
          try { alert("Sorry—something went wrong. Please try again."); } catch (_) {}
        }
      });

      console.log(LOG, "form wired");
    } catch (err) {
      console.error(LOG, "wireForm error:", err);
    }
  }

  // ✅ Wait for Firebase SDK to be ready before wiring anything
  if (window.onFirebaseReady) {
    onFirebaseReady(wireForm);
  } else {
    // If the stub/init wasn’t loaded for some reason, fail gracefully.
    console.warn(LOG, "onFirebaseReady not found. Make sure firebaseInit.js (and the small ready-stub) load before this file.");
  }
})();