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
    userEmail: '',
    isOwner: false,
    rows: [],             // { id, fileName, type, size, owner, createdAt, url, storagePath }
    allUsers: [],
    allTypes: [],
    sort: { key: 'name', dir: 'asc' }
  };

  // ---- DOM refs ----
  var dom = {
    tableBody: null,
    userFilter: null,
    typeFilter: null,
    fileInput: null,
    uploadBtn: null,
    table: null
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
        '<tr><td colspan="7" class="empty">No files uploaded yet.</td></tr>';
      return;
    }

    dom.tableBody.innerHTML = rows.map(function (r) {
      var canDelete = ctx.isOwner ||
        (ctx.userEmail && r.owner &&
          r.owner.toLowerCase() === ctx.userEmail.toLowerCase());

      var size = fmtSize(r.size);
      var created = fmtDate(r.createdAt);
      var type = r.type || extOf(r.fileName) || '';

      var ext = (r.type || '').toLowerCase();


var rawUrl = r.url || '';

var nameCell = rawUrl
  ? '<a href="' + rawUrl + '" target="_blank" rel="noopener">' +
      (r.fileName || '(untitled)') +
    '</a>'
  : (r.fileName || '(untitled)');

var dlCell = rawUrl
  ? '<a href="' + rawUrl + '" target="_blank" rel="noopener">Open</a>'
  : '';


      var delBtn = canDelete
        ? '<button type="button" class="file-delete-btn" data-id="' + r.id + '">🗑</button>'
        : '<button type="button" class="file-delete-btn" disabled>🗑</button>';

      return (
        '<tr data-id="' + r.id + '">' +
          '<td>' + nameCell + '</td>' +
          '<td style="text-align:center">' + type + '</td>' +
          '<td style="text-align:right">' + size + '</td>' +
          '<td>' + created + '</td>' +
          '<td>' + (r.owner || '') + '</td>' +
          '<td style="text-align:center">' + dlCell + '</td>' +
          '<td style="text-align:center">' + delBtn + '</td>' +
        '</tr>'
      );
    }).join('');

    wireRowActions();
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

  // ---- Firestore subscription ----
  function subscribeFiles(biz, user) {
    var db = getDB();
    if (!db) {
      console.error(NS, 'Firestore not available');
      return;
    }
console.log('[filemanager] biz key =', biz);
    ctx.biz = biz;
    ctx.userEmail = (user && user.email ? user.email : '').toLowerCase();
    ctx.isOwner = ctx.userEmail === OWNER_EMAIL.toLowerCase();

    var col = db.collection('businesses').doc(biz).collection('files');
    col.orderBy('createdAt', 'desc').onSnapshot(function (snap) {
      console.log('[filemanager] snapshot size =', snap.size); // add this
      var rows = [];
      var users = {};
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
          createdAt: d.createdAt || d.created || null,
          url: d.url || '',
          storagePath: d.storagePath || d.path || ''
        });

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

  // Add custom metadata so rules can use resource.metadata.owner
  var metadata = {
    customMetadata: {
      owner: ctx.userEmail || ''
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
        createdAt: (window.firebase &&
                    window.firebase.firestore &&
                    window.firebase.firestore.FieldValue &&
                    window.firebase.firestore.FieldValue.serverTimestamp()) ||
                   new Date(),
        storagePath: path,
        url: url
      };
      return db.collection('businesses').doc(ctx.biz).collection('files').add(doc);
    });
  }).then(function () {
    dom.fileInput.value = '';
  }).catch(function (err) {
    console.error(NS, 'upload failed', err);
    alert('Upload failed: ' + (err && err.message ? err.message : err));
  }).finally(function () {
    dom.uploadBtn.disabled = false;
  });
}

  // ---- Delete ----
  function onDeleteFile(id) {
    if (!id || !ctx.biz) return;
    if (!window.confirm('Delete this file?')) return;

    var db = getDB();
    var storage = getStorage();
    if (!db) return;

    var docRef = db.collection('businesses').doc(ctx.biz).collection('files').doc(id);

    docRef.get().then(function (doc) {
      if (!doc.exists) return;

      var data = doc.data() || {};
      var owner = (data.owner || '').toLowerCase();
      var canDelete = ctx.isOwner ||
        (ctx.userEmail && owner === ctx.userEmail.toLowerCase());

      if (!canDelete) {
        alert('You can only delete your own files.');
        return;
      }

      var path = data.storagePath || data.path || null;

      return docRef.delete().then(function () {
        if (storage && path) {
          return storage.ref().child(path).delete().catch(function (err) {
            console.error(NS, 'storage delete failed', err);
          });
        }
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

    if (dom.userFilter) {
      dom.userFilter.addEventListener('change', render);
    }
    if (dom.typeFilter) {
      dom.typeFilter.addEventListener('change', render);
    }
    if (dom.uploadBtn) {
      dom.uploadBtn.addEventListener('click', onUploadClick);
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
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
