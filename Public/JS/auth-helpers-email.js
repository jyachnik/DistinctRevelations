// /Public/JS/auth-helpers-email.js
// Canonical identity = EMAIL. No UID dependency.

(function () {
  if (window.__authHelpersEmail__) return; window.__authHelpersEmail__ = true;

  window.DR = window.DR || {};

  DR.currentEmail = function () {
    const a = window.auth;
    const email = a && a.currentUser && a.currentUser.email;
    return (email || '').toLowerCase();
  };

  // Resolve business key from URL ?business -> localStorage -> users collection by email
  DR.resolveBusinessKey = async function (db) {
    // 1) URL
    try {
      const key = (new URLSearchParams(location.search).get('business') || '').trim();
      if (key) { localStorage.setItem('businessKey', key); return key; }
    } catch (_) {}

    // 2) localStorage
    try {
      const ls = (localStorage.getItem('businessKey') || '').trim();
      if (ls) return ls;
    } catch (_) {}

    // 3) users collection by email (docId=email, else query by 'email' field)
    const email = DR.currentEmail();
    if (!email || !db) return '';

    try {
      const byId = await db.collection('users').doc(email).get();
      if (byId.exists) {
        const d = byId.data() || {};
        const k = (d.businessKey || d.business || '').trim();
        if (k) { localStorage.setItem('businessKey', k); return k; }
      }
    } catch (_) {}

    try {
      const q = await db.collection('users').where('email', '==', email).limit(1).get();
      if (!q.empty) {
        const d = q.docs[0].data() || {};
        const k = (d.businessKey || d.business || '').trim();
        if (k) { localStorage.setItem('businessKey', k); return k; }
      }
    } catch (_) {}

    return '';
  };

  DR.isOwnerByEmail = async function (db, biz) {
    if (!db || !biz) return false;
    const me = DR.currentEmail();
    if (!me) return false;

    try {
      const doc = await db.collection('businesses').doc(biz).get();
      if (doc.exists) {
        const d = doc.data() || {};
        if ((d.ownerEmail || '').toLowerCase() === me) return true;
      }
    } catch (_) {}

    try {
      const m = await db.collection('businesses').doc(biz)
        .collection('members').doc(me).get();
      if (m.exists && (m.data()?.role || '').toLowerCase() === 'owner') return true;
    } catch (_) {}

    return false;
  };

  DR.isMemberByEmail = async function (db, biz) {
    if (!db || !biz) return false;
    const me = DR.currentEmail();
    if (!me) return false;
    const snap = await db.collection('businesses').doc(biz).collection('members').doc(me).get().catch(()=>null);
    return !!(snap && snap.exists);
  };

  DR.getRoleByEmail = async function (db, biz) {
    const me = DR.currentEmail();
    if (!me || !db || !biz) return null;
    const m = await db.collection('businesses').doc(biz).collection('members').doc(me).get().catch(()=>null);
    return (m && m.exists && (m.data().role || null)) || null;
  };
})();