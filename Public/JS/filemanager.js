/* ============================================================================
   File Manager
   Firestore: businesses/{biz}/files/{doc}
   Doc shape:
     {
       fileName,          // string
       type,              // extension or MIME short, e.g. 'pdf', 'docx'
       size,              // bytes (number)
       owner,             // owner email
       createdAt,         // Firestore Timestamp
       storagePath,       // gs:// or path under bucket
       url                // https download URL
     }
   Storage path (example):
     gs://.../{bizId}/files/{timestamp}_{originalName}
   ========================================================================== */

(function () {
  'use strict';

  var NS = '[filemanager]';
  var OWNER_EMAIL =
  (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) ||
  (window.ownerEmail) ||
  '';
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ---- DOM helpers ----
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  // ---- State ----
  var ctx = {
    biz: null,
    proj: null,
    userEmail: '',
    userUid: '',
    isOwner: false,
    rows: [],             // { id, fileName, type, size, owner, ownerUid, createdAt, url, storagePath }
    companyMembers: {},   // { emailLower: email } from businesses/{biz}/users + owner
    allUsers: [],
    allTypes: [],
    sort: { key: 'name', dir: 'asc' },
    page: 1
  };
  var FILE_PAGE_SIZE = 15;

  // ---- DOM refs ----
  var dom = {
    tableBody: null,
    userFilter: null,
    typeFilter: null,
    fileInput: null,
    uploadBtn: null,
    table: null,
    pagePrev: null,
    pageNext: null,
    pageInfo: null
  };

  // ---- Firebase helpers ----
  function getDB() {
    return window.db ||
      (window.firebase && window.firebase.firestore && window.firebase.firestore());
  }
  function getAuth() {
    return window.auth ||
      (window.firebase && window.firebase.auth && window.firebase.auth());
  }
  function getStorage() {
    return (window.firebase && window.firebase.storage && window.firebase.storage()) || null;
  }

  // Own-file ownership AND the Permissions matrix's Delete grant — a
  // non-owner needs both, since Firestore rules already restrict this
  // write to "owner or the file's own uploader" regardless of what this
  // matrix says, so the matrix can only narrow further, never widen.
  function canDeleteOwnFile(ownerUid, ownerEmail) {
    if (ctx.isOwner) return true;
    var isOwnFile = (ctx.userUid && ownerUid && ownerUid === ctx.userUid) ||
      (ctx.userEmail && ownerEmail && String(ownerEmail).toLowerCase() === ctx.userEmail.toLowerCase());
    return isOwnFile && !!(window.drAccess && window.drAccess.canUseAction('fileManagerSection', 'Delete'));
  }

  // Business key resolver (same logic as other components)
  function resolveBizKey(required) {
    return new Promise(function (resolve) {
      var tries = 0;

      function fromRuntime() {
        return window.BIZ_KEY || window.businessKey || null;
      }
      function fromStorage() {
        try {
          return (
            sessionStorage.getItem('bizKey') ||
            localStorage.getItem('bizKey') ||
            null
          );
        } catch (_) {
          return null;
        }
      }
      function fromURL() {
        try {
          var qs = new URLSearchParams(location.search);
          var k = qs.get('business');
          return k || null;
        } catch (_) {
          return null;
        }
      }

      function attempt() {
        tries++;
        var k = fromRuntime() || fromStorage() || fromURL();
        if (k) {
          window.BIZ_KEY = k;
          window.businessKey = k;
          try { sessionStorage.setItem('bizKey', k); } catch (_) {}
          return done(k);
        }
        if (!required || tries > 40) return done(null);
        setTimeout(attempt, 150);
      }

      function done(k) {
        resolve(k || null);
      }

      attempt();
    });
  }

  // ---- utils ----
  function extOf(name) {
    var i = (name || '').lastIndexOf('.');
    return i > -1 ? (name.substring(i + 1) || '').toLowerCase() : '';
  }

  function fmtSize(n) {
    if (!n && n !== 0) return '';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    var v = Number(n);
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return (Math.round(v * 10) / 10) + ' ' + u[i];
  }

  function fmtDate(ts) {
    if (!ts) return '';
    if (window.drDateFmt) return window.drDateFmt.dateTime(ts);
    try {
      var d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toLocaleString();
    } catch (_) {
      return '';
    }
  }

  function sortedRows() {
    var rows = ctx.rows.slice();
    var key = ctx.sort.key;
    var dir = ctx.sort.dir === 'desc' ? -1 : 1;

    rows.sort(function (a, b) {
      var av, bv;

      if (key === 'name') {
        av = (a.fileName || '').toLowerCase();
        bv = (b.fileName || '').toLowerCase();
      } else if (key === 'type') {
        av = (a.type || '').toLowerCase();
        bv = (b.type || '').toLowerCase();
      } else if (key === 'size') {
        av = Number(a.size || 0);
        bv = Number(b.size || 0);
      } else if (key === 'created') {
        av = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() :
             (a.createdAt instanceof Date ? a.createdAt.getTime() : 0);
        bv = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() :
             (b.createdAt instanceof Date ? b.createdAt.getTime() : 0);
      } else if (key === 'owner') {
        av = (a.owner || '').toLowerCase();
        bv = (b.owner || '').toLowerCase();
      } else {
        return 0;
      }

      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      return 0;
    });

    return rows;
  }

  // ---- rendering ----
  function render() {
    if (!dom.tableBody) return;

    var rows = sortedRows();

    // apply header sort classes
    if (dom.table) {
      $all('thead th[data-sort]', dom.table).forEach(function (th) {
        var key = th.getAttribute('data-sort');
        th.classList.remove('sorted-asc', 'sorted-desc');
        if (ctx.sort.key === key) {
          th.classList.add(ctx.sort.dir === 'desc' ? 'sorted-desc' : 'sorted-asc');
        }
      });
    }


    var uf = (dom.userFilter && dom.userFilter.value) || '';
    var tf = (dom.typeFilter && dom.typeFilter.value) || '';

    rows = rows.filter(function (r) {
      var okU = !uf || (String(r.owner || '').toLowerCase() === uf.toLowerCase());
      var okT = !tf || (String(r.type || '').toLowerCase() === tf.toLowerCase());
      return okU && okT;
    });

    if (!rows.length) {
      dom.tableBody.innerHTML =
        '<tr><td colspan="6" class="empty">No files uploaded yet.</td></tr>';
      if (dom.pageInfo) dom.pageInfo.textContent = '';
      if (dom.pagePrev) dom.pagePrev.disabled = true;
      if (dom.pageNext) dom.pageNext.disabled = true;
      if (window.drInsight) window.drInsight.set('fileManagerSection', '');
      return;
    }

    var filteredRows = rows;
    var totalPages = Math.max(1, Math.ceil(rows.length / FILE_PAGE_SIZE));
    if (ctx.page > totalPages) ctx.page = totalPages;
    if (ctx.page < 1) ctx.page = 1;
    var startIdx = (ctx.page - 1) * FILE_PAGE_SIZE;
    rows = rows.slice(startIdx, startIdx + FILE_PAGE_SIZE);

    if (dom.pageInfo) dom.pageInfo.textContent = 'Page ' + ctx.page + ' of ' + totalPages;
    if (dom.pagePrev) dom.pagePrev.disabled = ctx.page <= 1;
    if (dom.pageNext) dom.pageNext.disabled = ctx.page >= totalPages;

    dom.tableBody.innerHTML = rows.map(function (r) {
      var canDelete = canDeleteOwnFile(r.ownerUid, r.owner);

      var size = fmtSize(r.size);
      var created = fmtDate(r.createdAt);
      var type = r.type || extOf(r.fileName) || '';

      var rawUrl = r.url || '';
      var nameCell = r.fileName || '(untitled)';

      // "Open" (inline preview) removed — it never worked reliably across
      // file types (Office docs never preview at all; browsers vary on
      // PDFs/images). Download is the one dependable action.
      var canDownload = ctx.isOwner || !!(window.drAccess && window.drAccess.canUseAction('fileManagerSection', 'Download'));
      var dlBtn = (rawUrl && canDownload)
        ? '<button type="button" class="file-download-btn" data-id="' + r.id + '" title="Download">⬇</button>'
        : '';
      var delBtn = canDelete
        ? '<button type="button" class="file-delete-btn" data-id="' + r.id + '" title="Delete">🗑</button>'
        : '<button type="button" class="file-delete-btn" disabled title="You can only delete your own files">🗑</button>';

      var actionsCell = dlBtn + delBtn;

      return (
        '<tr data-id="' + r.id + '">' +
          '<td>' + nameCell + '</td>' +
          '<td style="text-align:center">' + type + '</td>' +
          '<td style="text-align:right">' + size + '</td>' +
          '<td>' + created + '</td>' +
          '<td>' + (r.owner || '') + '</td>' +
          '<td class="file-actions-cell">' + actionsCell + '</td>' +
        '</tr>'
      );
    }).join('');

    wireRowActions();

    if (window.drInsight) {
      var totalSize = filteredRows.reduce(function (s, r) { return s + (r.size || 0); }, 0);
      var byOwner = {};
      filteredRows.forEach(function (r) { var o = r.owner || 'Unknown'; byOwner[o] = (byOwner[o] || 0) + 1; });
      var topOwner = Object.keys(byOwner).sort(function (a, b) { return byOwner[b] - byOwner[a]; })[0];
      var text = filteredRows.length + ' file' + (filteredRows.length === 1 ? '' : 's') + ' on hand, totaling ' + fmtSize(totalSize) + '.';
      if (topOwner) {
        text += ' Most uploads (' + byOwner[topOwner] + ') came from ' + topOwner + '.';
      }
      window.drInsight.set('fileManagerSection', text);
    }
  }

  function wireRowActions() {
    if (!dom.tableBody) return;
    $all('.file-delete-btn', dom.tableBody).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        if (!id || btn.disabled) return;
        onDeleteFile(id);
      });
    });
    $all('.file-download-btn', dom.tableBody).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var row = ctx.rows.find(function (r) { return r.id === id; });
        if (!row || !row.url) return;
        downloadFile(row.url, row.fileName || 'download', btn);
      });
    });
  }

  // Force an actual download (rather than a same-tab navigation) by
  // fetching the file as a blob and saving it via a same-origin blob: URL —
  // the <a download> attribute alone isn't reliably honored for
  // cross-origin Firebase Storage URLs.
  function downloadFile(url, fileName, btn) {
    if (btn) btn.disabled = true;
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      })
      .then(function (blob) {
        var blobUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = blobUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 1000);
      })
      .catch(function (err) {
        console.error(NS, 'download failed', err);
        alert('Download failed: ' + (err && err.message ? err.message : err));
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  // ---- filters ----
  function populateFilters() {
    if (dom.userFilter) {
      var sel = dom.userFilter;
      var cur = sel.value || '';
      sel.innerHTML = '<option value="">All Users</option>' +
        ctx.allUsers.map(function (u) {
          return '<option value="' + u + '">' + u + '</option>';
        }).join('');
      if (cur) sel.value = cur;
    }

    if (dom.typeFilter) {
      var st = dom.typeFilter;
      var curT = st.value || '';
      st.innerHTML = '<option value="">All Types</option>' +
        ctx.allTypes.map(function (t) {
          return '<option value="' + t + '">' + t.toUpperCase() + '</option>';
        }).join('');
      if (curT) st.value = curT;
    }
  }

  // ---- Company roster (for the "User" filter — all members, not just uploaders) ----
  function usersRef(db, biz) {
    return db.collection('businesses').doc(biz).collection('users');
  }

  function loadCompanyMembers(db, biz) {
    var members = {};
    if (OWNER_EMAIL) members[OWNER_EMAIL.toLowerCase()] = OWNER_EMAIL;

    usersRef(db, biz).get().then(function (snap) {
      snap.forEach(function (doc) {
        var u = doc.data() || {};
        if (u.email) members[String(u.email).toLowerCase()] = u.email;
      });
      ctx.companyMembers = members;

      // Merge into whatever the filter already shows (e.g. from file
      // owners) so a roster load that lands after the first files
      // snapshot doesn't drop anyone already listed.
      var merged = {};
      (ctx.allUsers || []).forEach(function (e) { merged[e.toLowerCase()] = e; });
      Object.keys(members).forEach(function (k) { merged[k] = members[k]; });
      ctx.allUsers = Object.keys(merged).map(function (k) { return merged[k]; }).sort();

      populateFilters();
    }).catch(function (err) {
      console.error(NS, 'loadCompanyMembers error', err);
    });
  }

  // ---- Firestore refs ----
  function filesRef() {
    var db = getDB();
    return db.collection('businesses').doc(ctx.biz)
      .collection('projects').doc(ctx.proj || 'default')
      .collection('files');
  }

  // ---- Firestore subscription ----
  function subscribeFiles(biz, user) {
    var db = getDB();
    if (!db) {
      console.error(NS, 'Firestore not available');
      return;
    }
console.log('[filemanager] biz key =', biz);
    ctx.biz = biz;
    // Multi-project cutover — every business always has at least the
    // auto-created 'default' project (dashboard-business-loader.js
    // guarantees window.PROJECT_KEY is set by the time this runs).
    ctx.proj = window.PROJECT_KEY || 'default';
    ctx.userEmail = (user && user.email ? user.email : '').toLowerCase();
    ctx.userUid = (user && user.uid) || '';
    ctx.isOwner = ctx.userEmail === OWNER_EMAIL.toLowerCase();
    ctx.companyMembers = ctx.companyMembers || {};

    loadCompanyMembers(db, biz);

    var col = filesRef();
    col.orderBy('createdAt', 'desc').onSnapshot(function (snap) {
      console.log('[filemanager] snapshot size =', snap.size); // add this
      var rows = [];
      var users = Object.assign({}, ctx.companyMembers);
      var types = {};

      snap.forEach(function (doc) {
        var d = doc.data() || {};
        var name = d.fileName || d.name || '';
        var t = (d.type || extOf(name) || '').toLowerCase();
        var owner = d.owner || d.createdBy || '';

        rows.push({
          id: doc.id,
          fileName: name,
          type: t,
          size: d.size || 0,
          owner: owner,
          ownerUid: d.ownerUid || '',
          createdAt: d.createdAt || d.createdAtClient || d.created || null,
          url: d.url || '',
          storagePath: d.storagePath || d.path || ''
        });

        // Merge in case a file's owner predates the current membership
        // roster (e.g. a removed member's past uploads still list them).
        if (owner) users[owner.toLowerCase()] = owner;
        if (t) types[t] = t;
      });

      ctx.rows = rows;
      ctx.allUsers = Object.keys(users).map(function (k) { return users[k]; }).sort();
      ctx.allTypes = Object.keys(types).sort();
      populateFilters();
      render();
    }, function (err) {
      console.error(NS, 'files snapshot failed', err);
    });
  }

  // ---- Upload ----
  function onUploadClick() {
  if (!dom.fileInput || !dom.fileInput.files || !dom.fileInput.files[0]) {
    alert('Choose a file first.');
    return;
  }

  var file = dom.fileInput.files[0];
  var storage = getStorage();
  var db = getDB();
  if (!storage || !db || !ctx.biz) {
    alert('Upload not available (missing Firebase).');
    return;
  }

  var ext = extOf(file.name);

  // Correct path to match Storage rules: files/{biz}/{...}
  var path = 'files/' + ctx.biz + '/' + Date.now() + '_' + file.name;
  var ref = storage.ref().child(path);

  // Add custom metadata so rules can use resource.metadata.owner.
  // contentType matters for "Open": without it, Storage falls back to a
  // generic type and browsers download the file instead of previewing it
  // inline (PDFs, images) in the new tab "Open" opens.
  var metadata = {
    contentType: file.type || 'application/octet-stream',
    customMetadata: {
      owner: ctx.userEmail || '',
      ownerUid: ctx.userUid || ''
    }
  };

  dom.uploadBtn.disabled = true;

  ref.put(file, metadata).then(function (snap) {
    return snap.ref.getDownloadURL().then(function (url) {
      var doc = {
        fileName: file.name,
        type: ext || (file.type || ''),
        size: file.size,
        owner: ctx.userEmail || '',
        ownerUid: ctx.userUid || '',
        createdAt: (window.firebase &&
                    window.firebase.firestore &&
                    window.firebase.firestore.FieldValue &&
                    window.firebase.firestore.FieldValue.serverTimestamp()) ||
                   new Date(),
        // serverTimestamp() reads back as null until the write round-trips
        // to the server, which would otherwise show a blank date on this
        // client's own just-uploaded row for a moment. This client-side
        // fallback fills that gap; it's overwritten by the real value once
        // Firestore resolves it.
        createdAtClient: new Date(),
        storagePath: path,
        url: url
      };
      return filesRef().add(doc);
    });
  }).then(function () {
    dom.fileInput.value = '';
    if (window.drModal) {
      window.drModal.open({ title: 'Upload Complete', bodyHtml: '<p>"' + esc(file.name) + '" was uploaded successfully.</p>' });
    } else {
      alert('"' + file.name + '" was uploaded successfully.');
    }
  }).catch(function (err) {
    console.error(NS, 'upload failed', err);
    var msg = (err && err.message) ? err.message : String(err);
    if (window.drModal) {
      window.drModal.open({ title: 'Upload Failed', bodyHtml: '<p>' + esc(msg) + '</p>' });
    } else {
      alert('Upload failed: ' + msg);
    }
  }).finally(function () {
    dom.uploadBtn.disabled = false;
  });
}

  // ---- Delete ----
  function onDeleteFile(id) {
    if (!id || !ctx.biz) return;

    var confirmed = window.drConfirm
      ? window.drConfirm('Delete this file? This cannot be undone.', { title: 'Delete File' })
      : Promise.resolve(window.confirm('Delete this file?'));

    confirmed.then(function (ok) {
      if (ok) doDeleteFile(id);
    });
  }

  function doDeleteFile(id) {
    var db = getDB();
    var storage = getStorage();
    if (!db) return;

    var docRef = filesRef().doc(id);

    docRef.get().then(function (doc) {
      if (!doc.exists) return;

      var data = doc.data() || {};
      var owner = (data.owner || '').toLowerCase();
      var ownerUid = data.ownerUid || '';
      var canDelete = canDeleteOwnFile(ownerUid, owner);

      if (!canDelete) {
        alert('You can only delete your own files.');
        return;
      }

      var path = data.storagePath || data.path || null;

      // Delete the actual Storage object FIRST. If that fails, the
      // Firestore record (which holds the only pointer to the blob) is
      // left intact so the delete can be retried instead of leaving an
      // orphaned, unreferenced file in Storage forever.
      var storageDeletion = (storage && path)
        ? storage.ref().child(path).delete().catch(function (err) {
            // "object-not-found" just means it's already gone — fine to proceed.
            if (err && err.code === 'storage/object-not-found') return;
            throw err;
          })
        : Promise.resolve();

      return storageDeletion.then(function () {
        return docRef.delete();
      });
    }).catch(function (err) {
      console.error(NS, 'delete failed', err);
      alert('Delete failed: ' + (err && err.message ? err.message : err));
    });
  }

  // ---- sorting header clicks ----
  function bindSortHeaders() {
    if (!dom.table) return;
    $all('thead th[data-sort]', dom.table).forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (!key) return;
        if (ctx.sort.key === key) {
          ctx.sort.dir = ctx.sort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          ctx.sort = { key: key, dir: 'asc' };
        }
        ctx.page = 1;
        render();
      });
    });
  }

  // ---- boot ----
  function bindDOM() {
    dom.table = $('#fileTable');
    dom.tableBody = $('#fileTableBody');
    dom.userFilter = $('#fileUserFilter');
    dom.typeFilter = $('#fileTypeFilter');
    dom.fileInput = $('#fileInput');
    dom.uploadBtn = $('#fileUploadBtn');
    dom.pagePrev = $('#filePagePrev');
    dom.pageNext = $('#filePageNext');
    dom.pageInfo = $('#filePageInfo');

    if (dom.userFilter) {
      dom.userFilter.addEventListener('change', function () { ctx.page = 1; render(); });
    }
    if (dom.typeFilter) {
      dom.typeFilter.addEventListener('change', function () { ctx.page = 1; render(); });
    }
    if (dom.uploadBtn) {
      dom.uploadBtn.addEventListener('click', onUploadClick);
    }
    if (dom.pagePrev) {
      dom.pagePrev.addEventListener('click', function () {
        if (ctx.page > 1) { ctx.page--; render(); }
      });
    }
    if (dom.pageNext) {
      dom.pageNext.addEventListener('click', function () {
        ctx.page++;
        render();
      });
    }
  }

  function start() {
    var auth = getAuth();
    if (!auth) {
      console.error(NS, 'Auth not available');
      return;
    }

    bindDOM();
    bindSortHeaders();

    auth.onAuthStateChanged(function (user) {
      if (!user) {
        ctx.rows = [];
        render();
        return;
      }
      resolveBizKey(true).then(function (biz) {
        if (!biz) return;
        subscribeFiles(biz, user);
        if (window.drAccess) window.drAccess.whenReady().then(applyActionAccess);
      });
    });
  }

  // Hides the Upload button entirely for a non-owner role that hasn't
  // been granted "Upload" — also re-renders the table so Download/Delete
  // buttons (which read window.drAccess too) reflect the resolved grant
  // instead of whatever they showed before access was ready.
  function applyActionAccess() {
    var canUpload = ctx.isOwner || !!(window.drAccess && window.drAccess.canUseAction('fileManagerSection', 'Upload'));
    if (dom.uploadBtn) dom.uploadBtn.style.display = canUpload ? '' : 'none';
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
