/* /Public/JS/qna-migrate.js
   One-time fixer for legacy Q&A docs. Owner-only.

   What it does:
   - Normalizes createdBy / assignedTo (lowercase, remove spaces, commas->dots)
   - Adds createdByUid when we can map email -> uid via businesses/{bk}/members
   - Runs in small batches with console progress logs
*/

(function () {
  const LOG = "[qna-migrate]";

  if (!window.onBusinessReady) {
    console.warn(LOG, "Load firebaseInit.js before qna-migrate.js");
    return;
  }

  function normMail(s) {
    if (!s) return "";
    return String(s).toLowerCase().replace(/\s+/g, "").replace(/,/g, ".");
  }

  // Expose a global to click or call from console
  window.runQnaFix = async function runQnaFix() {
    try {
      await new Promise((resolve) => onBusinessReady(resolve));
    } catch (e) {
      console.error(LOG, "Failed to get business context:", e);
      alert("Cannot run: business context not ready.");
      return;
    }

    const ctx = window.__businessCtx || null; // set by firebaseInit.js -> onBusinessReady
    // Many implementations pass ctx directly to the callback; try to capture it if not
    let DR = ctx;
    if (!DR || !DR.db || !DR.businessKey) {
      // Fallback: most of our code binds the object passed to onBusinessReady
      console.warn(LOG, "Attempting to capture context from last onBusinessReady call.");
    }

    // In our setup, onBusinessReady passes the context as the single argument.
    // So we re-register to capture it if needed.
    if (!DR) {
      await new Promise((resolve) => {
        onBusinessReady((inner) => {
          window.__businessCtx = inner;
          resolve(inner);
        });
      });
      DR = window.__businessCtx;
    }

    if (!DR || !DR.db || !DR.businessKey) {
      alert("Cannot run: missing business context.");
      return;
    }

    const db = DR.db;
    const bk = DR.businessKey;
    const user  = DR.auth && DR.auth.currentUser;
    const email = user ? (user.email || "") : "";
    const uid   = user ? user.uid : "";

    if (!DR.isOwner) {
      alert("This fix can only be run by the owner (john@distinctrevelations.com).");
      console.warn(LOG, "Blocked: not owner.", { email, uid });
      return;
    }

    console.log(LOG, "Starting migration for business:", bk, "as", email, "uid:", uid);

    // Build email->uid map from members (prefer members first)
    const emailToUid = {};
    try {
      const memSnap = await db.collection("businesses").doc(bk).collection("members").get();
      memSnap.forEach((d) => {
        const m = d.data() || {};
        const em = normMail(m.email || m.mail || "");
        const id = m.uid || d.id; // depending on your schema
        if (em && id) emailToUid[em] = id;
      });
      console.log(LOG, "Loaded members:", Object.keys(emailToUid).length);
    } catch (e) {
      console.warn(LOG, "Could not read members:", e);
    }

    const qnaCol = db.collection("businesses").doc(bk).collection("qna");
    let processed = 0;
    let changed = 0;

    // We’ll paginate by timestamp
    let pageSize = 300;
    let last = null;
    let keepGoing = true;

    while (keepGoing) {
      let query = qnaCol.orderBy("timestamp", "desc").limit(pageSize);
      if (last) query = query.startAfter(last);

      const snap = await query.get();
      if (snap.empty) break;

      const batch = db.batch();
      let batchOps = 0;

      snap.forEach((doc) => {
        processed++;
        const data = doc.data() || {};

        const origCreated = data.createdBy;
        const origAssign  = data.assignedTo;

        const nCreated = normMail(origCreated);
        const nAssign  = normMail(origAssign);

        let needsUpdate = false;
        const update = {};

        if (origCreated !== nCreated && nCreated) {
          update.createdBy = nCreated;
          needsUpdate = true;
        }
        if (origAssign !== nAssign && nAssign) {
          update.assignedTo = nAssign;
          needsUpdate = true;
        }

        if (!data.createdByUid && nCreated && emailToUid[nCreated]) {
          update.createdByUid = emailToUid[nCreated];
          needsUpdate = true;
        }

        if (needsUpdate) {
          batch.update(doc.ref, update);
          batchOps++;
          changed++;
        }
      });

      if (batchOps > 0) {
        await batch.commit();
        console.log(LOG, `Committed ${batchOps} fixes. Total changed: ${changed}, processed: ${processed}`);
      } else {
        console.log(LOG, `No changes needed in this page. Processed: ${processed}`);
      }

      const docs = snap.docs;
      last = docs[docs.length - 1];
      keepGoing = docs.length === pageSize;
    }

    console.log(LOG, "DONE. Processed:", processed, "Changed:", changed);
    alert(`[Q&A Fix] Done.\nProcessed: ${processed}\nChanged: ${changed}\nRefresh the page to use the updated data.`);
  };

  // Optional: add a button if present
  document.addEventListener("DOMContentLoaded", function () {
    const btn = document.getElementById("btnFixQna");
    if (btn) {
      btn.addEventListener("click", function () {
        window.runQnaFix();
      });
      console.log(LOG, "Hooked up #btnFixQna for owner-only migration.");
    }
  });
})();