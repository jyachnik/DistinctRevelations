/* ============================================================================
   Project Charter — not a card, just a link (Reports ▸ Executive ▸ Project
   Charter). The charter itself is a real document the owner imports/re-imports
   through Document Register (Settings ▸ Data Imports ▸ Project Documents) —
   this only finds whichever imported document is titled "...charter..." and
   opens it in the existing document viewer (doc-viewer.js), the same
   "standalone" mode Project Documents' View button uses. Re-importing a new
   version (same or different filename) is entirely the owner's own workflow;
   this always resolves to whatever matches right now, so it never goes stale.

   Firestore: businesses/{biz}/projects/{proj}/documents/{doc}  (read-only here)
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[project-charter-link]';

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() {
    var biz = window.BIZ_KEY || window.businessKey, proj = window.PROJECT_KEY || 'default';
    return getDB().collection('businesses').doc(biz).collection('projects').doc(proj);
  }

  function findAndOpen() {
    var isOwner = window.drAccess && window.drAccess.role === 'owner';
    var role = window.drAccess && window.drAccess.role;
    // Same query-gating rule as Document Register: an unfiltered read is owner-only at the
    // rules layer, so a non-owner must scope the query to their own role up front.
    var q = isOwner ? projRef().collection('documents') : projRef().collection('documents').where('allowedRoles', 'array-contains', role);
    q.get().then(function (snap) {
      var rows = snap.docs.map(function (d) { var x = d.data() || {}; x.id = d.id; return x; });
      var match = rows.filter(function (r) { return /charter/i.test(r.title || r.fileName || ''); })
        .sort(function (a, b) {
          var ad = a.importedAt && a.importedAt.toMillis ? a.importedAt.toMillis() : 0;
          var bd = b.importedAt && b.importedAt.toMillis ? b.importedAt.toMillis() : 0;
          return bd - ad;
        })[0];
      if (!match) {
        alert('No Project Charter document has been imported yet. Import it from Settings ▸ Data Imports ▸ Project Documents.');
        return;
      }
      if (!window.drDocViewer) { alert('The document reader has not loaded yet — try again in a moment.'); return; }
      var biz = window.BIZ_KEY || window.businessKey, proj = window.PROJECT_KEY || 'default';
      window.drDocViewer.open({
        docId: match.id, docLabel: match.title || match.fileName, ext: match.ext,
        storagePath: match.storagePath || ('documents/' + biz + '/' + proj + '/' + match.id),
        standalone: true
      });
    }).catch(function (err) {
      console.error(ns, 'lookup failed', err);
      alert('Could not open the Project Charter: ' + (err && err.message ? err.message : err));
    });
  }

  function openCharter() {
    if (!getDB()) { alert('Still loading — try again in a moment.'); return; }
    if (window.drAccess) window.drAccess.whenReady().then(findAndOpen);
    else findAndOpen();
  }

  window.drOpenProjectCharter = openCharter;
})();
