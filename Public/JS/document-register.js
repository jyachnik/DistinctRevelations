/* ============================================================================
   Project Documents — every document on the project in one popup: PM-imported
   documents (the original "Document Register" — plans, registers, logs…),
   File Manager's uploaded files (read-only reuse, unchanged), and files the
   owner shares privately with exactly one project member. Opened from the
   Reports list (Administration ▸ Project Documents), not a dashboard card —
   see report-index.js's "projectDocuments" action.

   Each source keeps its own real permission, enforced by firestore.rules /
   storage.rules, not just this UI:
     - documents:    allowedRoles array — who may see (and who "Ask the
                      Project" may quote) each one; only the owner writes.
     - files:        File Manager's own collection, read here EXACTLY as
                      File Manager itself reads it (every project member with
                      fileManagerSection access) — this popup never changes
                      that collection or its rules.
     - privateFiles: a NEW collection — a file the owner uploads for exactly
                      one chosen member; only the owner and that member may
                      ever read it. Kept separate from `files` on purpose: a
                      per-file flag there would break File Manager's own
                      unfiltered listener the moment one document became
                      unreadable to the current viewer.

   Firestore: businesses/{biz}/projects/{proj}/documents/{doc}
              businesses/{biz}/projects/{proj}/documentText/{doc} (owner-only)
              businesses/{biz}/projects/{proj}/files/{doc}        (read-only here)
              businesses/{biz}/projects/{proj}/privateFiles/{doc}
              businesses/{biz}/projects/{proj}/members/{uid}      (read-only, for the share-with picker)
   Storage:   documents/{biz}/{proj}/{doc}
              files/{biz}/...                                     (untouched — owned by filemanager.js)
              privatefiles/{biz}/{proj}/{doc}
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[document-register]';
  var PAGE_SIZE = 15;
  var VIEWABLE_EXT = { docx: 1, xlsx: 1, xls: 1, csv: 1 };
  var ROLE_SETS = {
    owner: [], partner: ['clientPartner'], pm: ['clientPartner', 'projectManager'],
    all: ['clientPartner', 'projectManager', 'admin', 'member']
  };
  var ROLE_LABEL = { clientPartner: 'Client Partner', projectManager: 'Project Manager', admin: 'Admin', member: 'Member' };
  var VIS_LABEL = { owner: 'Owner only', partner: 'Owner + Client Partner', pm: 'Owner + Client Partner + Project Manager', all: 'Everyone in the project' };
  var KIND_LABEL = { document: 'Document Register', file: 'File Manager', private: 'Private share' };

  var ctx = {
    biz: null, proj: null, isOwner: false, role: null, myUid: '', members: [],
    docRows: [], fileRows: [], privateRows: [], rows: [],
    sort: { key: 'title', dir: 'asc' }, page: 1, unsubs: [], started: false
  };
  var overlay, tbody;

  function $(sel) { return document.querySelector(sel); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function db() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() { return db().collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj); }
  function toDate(v) { if (!v) return null; if (v.toDate) return v.toDate(); var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtDate(v) { var d = toDate(v); return d ? (window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString()) : '—'; }
  function extOf(name) { var i = (name || '').lastIndexOf('.'); return i > -1 ? (name.substring(i + 1) || '').toLowerCase() : ''; }
  function visKeyFor(roles) {
    roles = roles || [];
    var keys = Object.keys(ROLE_SETS);
    for (var i = 0; i < keys.length; i++) {
      var set = ROLE_SETS[keys[i]];
      if (set.length === roles.length && set.every(function (r) { return roles.indexOf(r) !== -1; })) return keys[i];
    }
    return '';
  }
  function visText(r) {
    var k = r.visibility && ROLE_SETS[r.visibility] ? r.visibility : visKeyFor(r.allowedRoles);
    if (k) return VIS_LABEL[k];
    return 'Owner + ' + (r.allowedRoles || []).map(function (x) { return ROLE_LABEL[x] || x; }).join(', ');
  }
  function numKey(n) { var p = String(n || '').split('.'); return (parseInt(p[0], 10) || 0) * 1000 + (parseInt(p[1], 10) || 0); }
  function sortValue(r, key) {
    if (key === 'number') return numKey(r.number);
    if (key === 'when') { var d = toDate(r.whenDate); return d ? d.getTime() : 0; }
    return String(r[key] || '').toLowerCase();
  }

  // ---- normalize each source's raw doc into one row shape ----
  function documentRow(r) {
    return {
      id: r.id, kind: 'document', title: r.title, number: r.number || '', ext: r.ext || '', phase: r.phase || '',
      visLabel: visText(r), allowedRoles: r.allowedRoles || [], visibility: r.visibility || '',
      sourceLabel: r.sourceFolder || '—', whenDate: r.importedAt, hasOriginal: !!r.hasOriginal,
      storagePath: r.storagePath || ('documents/' + ctx.biz + '/' + ctx.proj + '/' + r.id), fileName: r.fileName || r.title, raw: r
    };
  }
  function fileRow(r) {
    var name = r.fileName || r.name || '(untitled)';
    return {
      id: r.id, kind: 'file', title: name, number: '', ext: (r.type || extOf(name) || '').toLowerCase(), phase: '',
      visLabel: 'Everyone in the project', allowedRoles: null, visibility: '',
      sourceLabel: r.owner || '—', whenDate: r.createdAt, hasOriginal: !!r.url,
      storagePath: r.storagePath || r.path || '', downloadUrl: r.url || '', fileName: name, raw: r
    };
  }
  function privateRow(r) {
    return {
      id: r.id, kind: 'private', title: r.fileName || '(untitled)', number: '', ext: (r.ext || extOf(r.fileName || '') || '').toLowerCase(), phase: '',
      visLabel: 'Just you and ' + (r.sharedWithEmail || 'one member'), allowedRoles: null, visibility: '',
      sourceLabel: r.createdBy || '—', whenDate: r.createdAt, hasOriginal: true,
      storagePath: r.storagePath || '', fileName: r.fileName, raw: r
    };
  }
  function recompute() {
    ctx.rows = ctx.docRows.concat(ctx.fileRows).concat(ctx.privateRows);
    var types = {};
    ctx.rows.forEach(function (r) { if (r.ext) types[r.ext] = 1; });
    fillTypeFilter(types);
    paint();
  }

  function filtered() {
    var fk = $('#documentsFilterKind') ? $('#documentsFilterKind').value : '';
    var ft = $('#documentsFilterType') ? $('#documentsFilterType').value : '';
    var q = $('#documentsSearch') ? $('#documentsSearch').value.trim().toLowerCase() : '';
    var dir = ctx.sort.dir === 'desc' ? -1 : 1, key = ctx.sort.key;
    return ctx.rows.filter(function (r) {
      return (!fk || r.kind === fk) && (!ft || r.ext === ft) && (!q || (r.title + ' ' + (r.number || '')).toLowerCase().indexOf(q) !== -1);
    }).sort(function (a, b) { var av = sortValue(a, key), bv = sortValue(b, key); return av < bv ? -dir : av > bv ? dir : 0; });
  }

  function paint() {
    if (!overlay || !tbody) return;
    var rows = filtered();
    var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (ctx.page > pages) ctx.page = pages;
    var pageRows = rows.slice((ctx.page - 1) * PAGE_SIZE, ctx.page * PAGE_SIZE);
    var info = $('#documentsPageInfo'), prev = $('#documentsPagePrev'), next = $('#documentsPageNext');
    if (info) info.textContent = 'Page ' + ctx.page + ' of ' + pages + ' (' + rows.length + ' document' + (rows.length === 1 ? '' : 's') + ')';
    if (prev) prev.disabled = ctx.page <= 1;
    if (next) next.disabled = ctx.page >= pages;
    document.querySelectorAll('#documentsTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === ctx.sort.key) th.classList.add(ctx.sort.dir);
    });

    var empty = $('#documentsEmpty');
    if (empty) empty.hidden = ctx.rows.length > 0;
    if (!rows.length) { tbody.innerHTML = ctx.rows.length ? '<tr><td colspan="7" class="metrics-empty">No documents match the filters.</td></tr>' : ''; return; }

    tbody.innerHTML = pageRows.map(function (r) {
      // File Manager rows keep File Manager's own Download action-grant exactly — this popup never
      // widens what a role can already do with those files, only Document Register and Private
      // shares (which never had a separate Download grant) stay download-able to anyone who can see the row.
      var canDownload = r.kind !== 'file' || ctx.isOwner || !!(window.drAccess && window.drAccess.canUseAction('fileManagerSection', 'Download'));
      var canView = r.hasOriginal && VIEWABLE_EXT[r.ext] && canDownload;
      var viewBtn = canView ? '<button type="button" class="doc-view" data-id="' + esc(r.id) + '" data-kind="' + r.kind + '" title="View in the document reader">👁</button>' : '';
      var dl = (r.hasOriginal && canDownload) ? '<button type="button" class="doc-dl" data-id="' + esc(r.id) + '" data-kind="' + r.kind + '" title="Download the original file">⬇</button>' : '';
      var vis = (ctx.isOwner && r.kind === 'document')
        ? '<select class="doc-vis" data-id="' + esc(r.id) + '">' + Object.keys(VIS_LABEL).map(function (k) {
            var cur = r.visibility && ROLE_SETS[r.visibility] ? r.visibility : visKeyFor(r.allowedRoles);
            return '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + esc(VIS_LABEL[k]) + '</option>'; }).join('') + '</select>'
        : esc(r.visLabel);
      var del = (ctx.isOwner && (r.kind === 'document' || r.kind === 'private'))
        ? '<button type="button" class="delete-btn doc-del" data-id="' + esc(r.id) + '" data-kind="' + r.kind + '">🗑️</button>' : '';
      return '<tr data-id="' + esc(r.id) + '" data-kind="' + r.kind + '">' +
        '<td>' + esc(r.number || '—') + '</td>' +
        '<td>' + esc(r.title) + '</td>' +
        '<td>' + esc(KIND_LABEL[r.kind]) + '</td>' +
        '<td>' + esc((r.ext || '').toUpperCase()) + '</td>' +
        '<td>' + vis + '</td>' +
        '<td>' + esc(fmtDate(r.whenDate)) + '</td>' +
        '<td class="doc-actions">' + viewBtn + dl + del + '</td></tr>';
    }).join('');
  }

  // ---- actions ----
  function view(row) {
    if (!window.drDocViewer) { alert('The document reader has not loaded yet — try again in a moment.'); return; }
    window.drDocViewer.open({ docId: row.id, docLabel: row.title, ext: row.ext, storagePath: row.storagePath, standalone: true });
  }
  function download(row, btn) {
    btn.disabled = true;
    var urlPromise = row.kind === 'file' && row.downloadUrl
      ? Promise.resolve(row.downloadUrl)
      : window.firebase.storage().ref().child(row.storagePath).getDownloadURL();
    urlPromise.then(function (url) { return fetch(url); })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.blob(); })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = row.fileName || row.title;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      })
      .catch(function (err) { console.error(ns, 'download failed', err); alert('Download failed: ' + (err && err.message ? err.message : err)); })
      .finally(function () { btn.disabled = false; });
  }
  function remove(row) {
    var isPrivate = row.kind === 'private';
    var msg = isPrivate
      ? 'Stop sharing "' + row.title + '"? It is deleted and ' + (row.raw.sharedWithEmail || 'the member') + ' will no longer be able to see it. This cannot be undone.'
      : 'Delete "' + row.title + '"? It is removed from the register and the AI can no longer answer from it. This cannot be undone.';
    var confirmed = window.drConfirm ? window.drConfirm(msg, { title: isPrivate ? 'Stop Sharing' : 'Delete Document' }) : Promise.resolve(window.confirm(msg));
    confirmed.then(function (ok) {
      if (!ok) return;
      var col = isPrivate ? 'privateFiles' : 'documents';
      var st = window.firebase.storage().ref().child(row.storagePath || (isPrivate ? '' : ('documents/' + ctx.biz + '/' + ctx.proj + '/' + row.id)));
      (row.storagePath ? st.delete().catch(function (err) { if (!(err && err.code === 'storage/object-not-found')) throw err; }) : Promise.resolve())
        .then(function () { return isPrivate ? null : projRef().collection('documentText').doc(row.id).delete(); })
        .then(function () { return projRef().collection(col).doc(row.id).delete(); })
        .catch(function (err) { console.error(ns, 'delete failed', err); alert('Could not delete: ' + (err && err.message ? err.message : err)); });
    });
  }
  function setVisibility(row, key) {
    projRef().collection('documents').doc(row.id).update({ visibility: key, allowedRoles: ROLE_SETS[key].slice() })
      .catch(function (err) { console.error(ns, 'visibility failed', err); alert('Could not change visibility: ' + (err && err.message ? err.message : err)); paint(); });
  }

  // ---- share-a-file-privately (owner only) ----
  function fillMemberPicker() {
    var sel = $('#documentsShareTo'); if (!sel) return;
    sel.innerHTML = '<option value="">Choose a person…</option>' + ctx.members.map(function (m) {
      return '<option value="' + esc(m.uid) + '">' + esc(m.email || m.uid) + '</option>';
    }).join('');
  }
  function loadMembers() {
    return projRef().collection('members').get().then(function (snap) {
      ctx.members = snap.docs.map(function (d) { var x = d.data() || {}; return { uid: d.id, email: x.email || '', role: x.role || 'member' }; })
        .filter(function (m) { return m.uid !== ctx.myUid; }).sort(function (a, b) { return a.email.localeCompare(b.email); });
      fillMemberPicker();
    }).catch(function (err) { console.warn(ns, 'member list failed', err); });
  }
  function shareFile() {
    var fileInput = $('#documentsShareFile'), sel = $('#documentsShareTo'), btn = $('#documentsShareBtn'), status = $('#documentsShareStatus');
    var file = fileInput && fileInput.files && fileInput.files[0];
    var toUid = sel && sel.value;
    if (!file || !toUid) { alert('Choose a file and a person to share it with.'); return; }
    var member = ctx.members.filter(function (m) { return m.uid === toUid; })[0];
    var path = 'privatefiles/' + ctx.biz + '/' + ctx.proj + '/' + Date.now() + '_' + file.name;
    btn.disabled = true; if (status) status.textContent = 'Uploading…';
    window.firebase.storage().ref().child(path).put(file, { contentType: file.type || 'application/octet-stream' })
      .then(function () {
        return projRef().collection('privateFiles').add({
          fileName: file.name, ext: extOf(file.name), size: file.size, storagePath: path,
          sharedWithUid: toUid, sharedWithEmail: member ? member.email : '',
          createdAt: window.firebase.firestore.FieldValue.serverTimestamp(), createdBy: (window.auth && window.auth.currentUser && window.auth.currentUser.email) || ''
        });
      })
      .then(function () {
        if (status) status.textContent = 'Shared "' + file.name + '" with ' + (member ? member.email : 'that person') + '.';
        fileInput.value = ''; sel.value = '';
      })
      .catch(function (err) {
        console.error(ns, 'share failed', err);
        if (status) status.textContent = '';
        alert('Could not share the file: ' + (err && err.message ? err.message : err));
      })
      .finally(function () { btn.disabled = false; });
  }

  function listen() {
    ctx.unsubs.forEach(function (u) { u(); }); ctx.unsubs = [];

    var docsQ = ctx.isOwner ? projRef().collection('documents') : projRef().collection('documents').where('allowedRoles', 'array-contains', ctx.role);
    ctx.unsubs.push(docsQ.onSnapshot(function (snap) {
      ctx.docRows = snap.docs.map(function (d) { var x = d.data() || {}; x.id = d.id; return documentRow(x); });
      recompute();
    }, function (err) { console.warn(ns, 'documents listen error', err && err.code); }));

    var canSeeFiles = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('fileManagerSection'));
    if (canSeeFiles) {
      ctx.unsubs.push(projRef().collection('files').onSnapshot(function (snap) {
        ctx.fileRows = snap.docs.map(function (d) { var x = d.data() || {}; x.id = d.id; return fileRow(x); });
        recompute();
      }, function (err) { console.warn(ns, 'files listen error', err && err.code); }));
    }

    var privQ = ctx.isOwner ? projRef().collection('privateFiles') : projRef().collection('privateFiles').where('sharedWithUid', '==', ctx.myUid);
    ctx.unsubs.push(privQ.onSnapshot(function (snap) {
      ctx.privateRows = snap.docs.map(function (d) { var x = d.data() || {}; x.id = d.id; return privateRow(x); });
      recompute();
    }, function (err) { console.warn(ns, 'privateFiles listen error', err && err.code); }));
  }
  function fillTypeFilter(types) {
    var el = $('#documentsFilterType'); if (!el) return;
    var keep = el.value;
    el.innerHTML = '<option value="">All Types</option>' + Object.keys(types).sort().map(function (v) { return '<option value="' + esc(v) + '">' + esc(v.toUpperCase()) + '</option>'; }).join('');
    el.value = keep;
  }

  function wireSourceLabel() {
    var box = $('#documentsSourceBox'), input = $('#documentsSourceLabel'), btn = $('#documentsSourceSave');
    if (!box) return;
    box.style.display = ctx.isOwner ? '' : 'none';
    if (!ctx.isOwner || btn.__wired) return;
    btn.__wired = true;
    projRef().get().then(function (s) { input.value = (s.exists && s.data().documentsSourceLabel) || ''; });
    btn.addEventListener('click', function () {
      projRef().set({ documentsSourceLabel: input.value.trim() }, { merge: true })
        .then(function () { btn.textContent = 'Saved'; setTimeout(function () { btn.textContent = 'Save'; }, 1200); })
        .catch(function (err) { alert('Could not save: ' + (err && err.message ? err.message : err)); });
    });
  }
  function wireSharePanel() {
    var box = $('#documentsSharePanel');
    if (!box) return;
    box.style.display = ctx.isOwner ? '' : 'none';
    if (!ctx.isOwner || box.__wired) return;
    box.__wired = true;
    loadMembers();
    var btn = $('#documentsShareBtn');
    if (btn) btn.addEventListener('click', shareFile);
  }

  function bind() {
    tbody.addEventListener('click', function (ev) {
      var b = ev.target.closest('button'); if (!b) return;
      var kind = b.getAttribute('data-kind');
      var list = kind === 'file' ? ctx.fileRows : kind === 'private' ? ctx.privateRows : ctx.docRows;
      var row = list.find(function (x) { return x.id === b.getAttribute('data-id'); }); if (!row) return;
      if (b.classList.contains('doc-view')) view(row);
      else if (b.classList.contains('doc-dl')) download(row, b);
      else if (b.classList.contains('doc-del')) remove(row);
    });
    tbody.addEventListener('change', function (ev) {
      var s = ev.target.closest('select.doc-vis'); if (!s) return;
      var row = ctx.docRows.find(function (x) { return x.id === s.getAttribute('data-id'); });
      if (row) setVisibility(row, s.value);
    });
    ['#documentsFilterKind', '#documentsFilterType'].forEach(function (sel) { var e = $(sel); if (e) e.addEventListener('change', function () { ctx.page = 1; paint(); }); });
    var search = $('#documentsSearch'); if (search) search.addEventListener('input', function () { ctx.page = 1; paint(); });
    var reset = $('#documentsFilterReset');
    if (reset) reset.addEventListener('click', function () { ['#documentsFilterKind', '#documentsFilterType'].forEach(function (s) { var e = $(s); if (e) e.value = ''; }); if (search) search.value = ''; ctx.page = 1; paint(); });
    $('#documentsPagePrev').addEventListener('click', function () { ctx.page--; paint(); });
    $('#documentsPageNext').addEventListener('click', function () { ctx.page++; paint(); });
    var thead = document.querySelector('#documentsTable thead');
    thead.addEventListener('click', function (ev) {
      var th = ev.target.closest('th[data-sort]'); if (!th) return;
      var k = th.getAttribute('data-sort');
      if (ctx.sort.key === k) ctx.sort.dir = ctx.sort.dir === 'asc' ? 'desc' : 'asc'; else { ctx.sort.key = k; ctx.sort.dir = 'asc'; }
      paint();
    });
  }

  // ---- overlay open/close ----
  // Idempotent and safe to call before role/permissions resolve — waits on drAccess itself, so a
  // click on "Project Documents" the instant the page loads doesn't race listen() into running with
  // ctx.role still unset (which would silently show nothing rather than the right role's documents).
  function ensureStarted() {
    if (ctx.started) return;
    ctx.started = true;
    var ready = window.drAccess ? window.drAccess.whenReady() : Promise.resolve();
    ready.then(function () {
      ctx.role = window.drAccess && window.drAccess.role;
      ctx.isOwner = ctx.role === 'owner';
      ctx.myUid = (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || '';
      if (!ctx.role) return;              // not a member of this project
      overlay.classList.toggle('owner', ctx.isOwner);
      wireSourceLabel();
      wireSharePanel();
      listen();
    });
  }
  function openOverlay() {
    if (!overlay) return;
    ensureStarted();
    overlay.classList.add('is-open'); overlay.setAttribute('aria-hidden', 'false');
  }
  function closeOverlay() {
    if (!overlay) return;
    overlay.classList.remove('is-open'); overlay.setAttribute('aria-hidden', 'true');
  }
  window.drOpenProjectDocuments = openOverlay;

  function init() {
    overlay = document.getElementById('projectDocumentsOverlay'); tbody = $('#documentsTable tbody');
    ctx.biz = window.BIZ_KEY || window.businessKey || null; ctx.proj = window.PROJECT_KEY || 'default';
    if (!ctx.biz || !overlay || !tbody) return;
    bind();
    var closeBtn = document.getElementById('projectDocumentsClose');
    if (closeBtn) closeBtn.addEventListener('click', closeOverlay);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeOverlay(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
