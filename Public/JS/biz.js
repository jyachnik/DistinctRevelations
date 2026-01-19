// /Public/JS/biz.js
(function () {
  function onFirebaseReady() {
    return new Promise((resolve) => {
      if (window.firebase && window.db && window.auth) return resolve();
      document.addEventListener("firebase:ready", resolve, { once: true });
    });
  }

  function currentUserReady() {
    return new Promise((resolve) => {
      const u = auth.currentUser;
      if (u) return resolve(u);
      const off = auth.onAuthStateChanged((user) => {
        off(); resolve(user || null);
      });
    });
  }

  async function resolveBusinessKey() {
    // 1) URL → 2) sessionStorage
    const usp = new URLSearchParams(location.search);
    let biz = usp.get("business") || sessionStorage.getItem("businessKey");

    if (!biz) {
      // 3) users/{uid}.businessKey → 4) membership doc
      const uid = auth.currentUser && auth.currentUser.uid;
      if (!uid) throw new Error("Not signed in");

      try {
        const userDoc = await db.doc(`users/${uid}`).get();
        if (userDoc.exists) {
          biz =
            userDoc.get("businessKey") ||
            userDoc.get("business_key") ||
            userDoc.get("business") ||
            null;
        }
      } catch (e) {
        console.warn("[biz] user doc read failed:", e.code || e.message);
      }

      if (!biz) {
        try {
          const cg = await db
            .collectionGroup("members")
            .where("uid", "==", uid)
            .limit(1)
            .get();
          if (!cg.empty) biz = cg.docs[0].ref.parent.parent.id; // businesses/{biz}
        } catch (e) {
          console.warn("[biz] membership lookup failed:", e.code || e.message);
        }
      }
    }

    if (!biz) throw new Error("Business key is missing.");

    // Verify membership exists
    const memberRef = db.doc(`businesses/${biz}/members/${auth.currentUser.uid}`);
    const member = await memberRef.get().catch(() => null);
    if (!member || !member.exists) {
      location.href = "/Public/select-business.html?reason=noMembership&business=" +
        encodeURIComponent(biz);
      return null;
    }

    sessionStorage.setItem("businessKey", biz);
    window.BIZ_KEY = biz; // optional convenience

    // Normalize URL (optional)
    try {
      if (location.search !== `?business=${encodeURIComponent(biz)}`) {
        history.replaceState(null, "", `${location.pathname}?business=${encodeURIComponent(biz)}`);
      }
    } catch (_) {}

    return biz;
  }

  (async function start() {
    await onFirebaseReady();
    window.auth = firebase.auth();
    window.db   = firebase.firestore();

    const user = await currentUserReady();
    if (!user) { location.href = "/Public/index.html"; return; }

    let biz;
    try {
      biz = await resolveBusinessKey();
      if (!biz) return;
    } catch (e) {
      alert("Business key missing. Please select a business.");
      location.href = "/Public/select-business.html?reason=missingBusiness";
      return;
    }

    // The single signal all components use:
    document.dispatchEvent(new CustomEvent("dashboard:ready", {
      detail: { businessKey: biz }
    }));
  })();
})();