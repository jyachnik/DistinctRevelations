/* ============================================================================
   Q&A Tracker – wired to existing dashboard.html / qna.css
   Firestore: businesses/{biz}/qna/{doc}
   Fields: { type, message, response, assignedTo, completed,
             createdBy, createdByUid, timestamp }
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[qna]';

  // ---------------------------------------------------------------------------
  // Context
  // ---------------------------------------------------------------------------
  var ctx = {
    biz: null,
    userEmail: '',
    userUid: '',
    isOwner: false,
    rows: [],
    editingId: null,
    sort: { key: null, dir: 'asc' } // for header sorting
  };

 // Read owner email from a global or environment config
var OWNER_EMAIL = '';
if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
  OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];  // primary owner from app-config.js
} else if (window.ownerEmail) {
  OWNER_EMAIL = window.ownerEmail;
}

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  // ---------------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------------
  var tbody;
  var typeSel;
  var assignedSel;
  var dueInput;
  var msgInput;
  var responseInput;
  var addBtn;
  var filterDoneSel;
  var filterTypeSel;
  var filterAssignedSel;

  // ---------------------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------------------
  function fmtDate(ts) {
    if (!ts) return '';
    if (window.drDateFmt) return window.drDateFmt.dateTime(ts);
    try {
      var d = ts.toDate ? ts.toDate() : (ts instanceof Date ? ts : new Date(ts));
      return d.toLocaleString();
    } catch (_) {
      return '';
    }
  }

  function fmtDateOnly(v) {
    if (window.drDateFmt) return window.drDateFmt.date(v);
    var d = toJsDate(v);
    return d ? d.toLocaleDateString() : '';
  }

  function toJsDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    // An already-invalid Date (e.g. new Date('garbage')) is still truthy
    // and still `instanceof Date` — validate it here too.
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function toDateInputValue(v) {
    var d = toJsDate(v);
    if (!d) return '';
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  // RAG (red/amber/green) jeopardy — shared formula, see dr-rag.js.
  function computeJeopardy(row) {
    if (window.drRag) return window.drRag.compute(row.timestamp, row.dueDate, row.completed);
    return row.completed ? { code: 'done', label: 'Done' } : { code: 'none', label: 'No due date' };
  }

  function canEdit(row) {
    if (ctx.isOwner) return true;
    if (!ctx.userEmail && !ctx.userUid) return false; // not signed in
    if (ctx.userUid && row.createdByUid && row.createdByUid === ctx.userUid) return true;
    return String(row.createdBy || '').toLowerCase() === ctx.userEmail.toLowerCase();
  }

  function canDelete(row) {
    return canEdit(row);
  }

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------
  function rebuildFilters() {
    if (!filterTypeSel || !filterAssignedSel) return;

    var types = new Set();
    var assignees = new Set();

    ctx.rows.forEach(function (r) {
      if (r.type) types.add(r.type);
      if (r.assignedTo) assignees.add(r.assignedTo);
    });

    // Type filter
    filterTypeSel.innerHTML = '';
    var optAllT = document.createElement('option');
    optAllT.value = '';
    optAllT.textContent = 'All types';
    filterTypeSel.appendChild(optAllT);

    Array.from(types)
      .sort()
      .forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        filterTypeSel.appendChild(opt);
      });

    // Assigned filter
    filterAssignedSel.innerHTML = '';
    var optAllA = document.createElement('option');
    optAllA.value = '';
    optAllA.textContent = 'All assignees';
    filterAssignedSel.appendChild(optAllA);

    Array.from(assignees)
      .sort()
      .forEach(function (a) {
        var opt2 = document.createElement('option');
        opt2.value = a;
        opt2.textContent = a;
        filterAssignedSel.appendChild(opt2);
      });
  }

  // ---------------------------------------------------------------------------
  // Firestore refs
  // ---------------------------------------------------------------------------
  function getDB() {
    return (
      window.db ||
      (window.firebase &&
        window.firebase.firestore &&
        window.firebase.firestore())
    );
  }

  function qnaRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('qna');
  }

  function usersRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('users');
  }

  // ---------------------------------------------------------------------------
  // Assignees
  // ---------------------------------------------------------------------------
 console.log('[qna] OWNER_EMAIL at load =', OWNER_EMAIL);
 
  function loadAssignees() {
    if (!assignedSel || !ctx.biz) return;
 console.log('[qna] loadAssignees biz=', ctx.biz, 'owner=', OWNER_EMAIL);

    var ref = usersRef();
    if (!ref) return;

    assignedSel.innerHTML = '';

    var optNone = document.createElement('option');
    optNone.value = '';
    optNone.textContent = 'Assign To'; 
    assignedSel.appendChild(optNone);

    var seen = new Set();

  // Always include owner if configured correctly
  var ownerEmail = OWNER_EMAIL;
  if (ownerEmail && ownerEmail.indexOf('{') === -1) {
    seen.add(ownerEmail.toLowerCase());
    var ownerOpt = document.createElement('option');
    ownerOpt.value = ownerEmail;
    ownerOpt.textContent = ownerEmail;
    assignedSel.appendChild(ownerOpt);
  }

    ref
      .get()
      .then(function (snap) {
        snap.forEach(function (doc) {
          var u = doc.data();
          if (!u || !u.email) return;
          var email = String(u.email).trim();
          if (!email) return;
          var key = email.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          var opt = document.createElement('option');
          opt.value = email;
          opt.textContent = email;
          assignedSel.appendChild(opt);
        });
      })
      .catch(function (err) {
        console.error(ns, 'loadAssignees error', err);
      });
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function paint() {
    if (!tbody) {
      console.warn(ns, 'no tbody found; cannot render qna');
      return;
    }

    var fd = filterDoneSel ? filterDoneSel.value : '';
    var ft = filterTypeSel ? filterTypeSel.value : '';
    var fa = filterAssignedSel ? filterAssignedSel.value : '';

    var rows = ctx.rows.filter(function (r) {
      var okD =
        !fd ||
        (fd === 'done' && !!r.completed) ||
        (fd === 'notDone' && !r.completed);
      var okT = !ft || String(r.type || '') === ft;
      var okA = !fa || String(r.assignedTo || '') === fa;
      return okD && okT && okA;
    });

    // Sort
    if (ctx.sort && ctx.sort.key) {
      var key = ctx.sort.key;
      var dir = ctx.sort.dir === 'desc' ? -1 : 1;

      rows = rows.slice().sort(function (a, b) {
        var av, bv;

        if (key === 'dueDate') {
          av = (toJsDate(a.dueDate) || new Date(0)).getTime();
          bv = (toJsDate(b.dueDate) || new Date(0)).getTime();
        } else if (key === 'responseAt') {
          av = (toJsDate(a.responseAt) || new Date(0)).getTime();
          bv = (toJsDate(b.responseAt) || new Date(0)).getTime();
        } else {
          av = (a[key] || '').toString().toLowerCase();
          bv = (b[key] || '').toString().toLowerCase();
        }

        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }

    tbody.innerHTML = rows
      .map(function (r) {
        var canE = canEdit(r);
        var canD = canDelete(r);

        var chk =
          '<input type="checkbox" class="qna-done" data-id="' +
          r.id +
          '"' +
          (r.completed ? ' checked' : '') +
          '>';

        var editBtn =
          '<button type="button" class="edit-btn qna-edit" data-id="' +
          r.id +
          '"' + (canE ? '' : ' disabled aria-disabled="true" title="You can only edit items you created"') +
          '>✏️</button>';

        var delBtn =
          '<button type="button" class="delete-btn qna-del" data-id="' +
          r.id +
          '"' + (canD ? '' : ' disabled aria-disabled="true" title="You can only delete items you created"') +
          '>🗑️</button>';

        var jeopardy = computeJeopardy(r);
        var dueDisplay = fmtDateOnly(r.dueDate) || '—';
        var jeopardyBadge =
          '<span class="qna-rag qna-rag-' + jeopardy.code + '" title="' + jeopardy.label + '"></span>' +
          '<span class="qna-rag-label">' + jeopardy.label + '</span>'; // visually hidden, for screen readers

        return (
          '<tr data-id="' +
          r.id +
          '">' +
          '<td>' +
          (r.type || '') +
          '</td>' +
          '<td>' +
          (r.message || '') +
          '</td>' +
          '<td>' +
          (r.response || '') +
          '</td>' +
          '<td class="qna-responded-cell">' +
          (r.response && r.responseAt
            ? fmtDate(r.responseAt) + (r.responseBy ? '<div class="qna-response-meta">' + r.responseBy + '</div>' : '')
            : (r.response ? '<span class="qna-no-timestamp" title="Responded before this was tracked">—</span>' : '—')) +
          '</td>' +
          '<td>' +
  (r.assignedTo || '') +
'</td>' +
          '<td>' +
          dueDisplay +
          '</td>' +
          '<td class="qna-jeopardy-cell">' +
          jeopardyBadge +
          '</td>' +
          '<td>' +
          chk +
          '</td>' +
          '<td>' +
          editBtn +
          delBtn +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
  }
function updateStats() {
  var qs = 0, ts = 0, is = 0, rs = 0;

  (ctx.rows || []).forEach(function (r) {
    var t = (r.type || '').toLowerCase();
    if (t === 'question') qs++;
    else if (t === 'task') ts++;
    else if (t === 'issue') is++;
    else if (t === 'risk') rs++;
  });

  var elQ = document.getElementById('qna-stat-questions');
  var elT = document.getElementById('qna-stat-tasks');
  var elI = document.getElementById('qna-stat-issues');
  var elR = document.getElementById('qna-stat-risks');

  if (elQ) elQ.textContent = qs;
  if (elT) elT.textContent = ts;
  if (elI) elI.textContent = is;
  if (elR) elR.textContent = rs;
}
  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------
  function addItem() {
    if (!msgInput) return;

    var msg = msgInput.value.trim();
    var response = responseInput ? responseInput.value.trim() : '';
    var type = (typeSel && typeSel.value) || '';
    var assignedTo = (assignedSel && assignedSel.value) || '';
    var dueDate = dueInput && dueInput.value ? new Date(dueInput.value + 'T00:00:00') : null;

    if (!msg) return;

    var ref = qnaRef();
    if (!ref) return;

    var ts =
      (window.firebase &&
        window.firebase.firestore &&
        window.firebase.firestore.FieldValue &&
        window.firebase.firestore.FieldValue.serverTimestamp &&
        window.firebase.firestore.FieldValue.serverTimestamp()) || new Date();

    var payload = {
      type: type,
      message: msg,
      response: response,
      assignedTo: assignedTo,
      dueDate: dueDate,
      completed: false,
      createdBy: ctx.userEmail || '',
      createdByUid: ctx.userUid || '',
      timestamp: ts
    };
    if (response) {
      payload.responseAt = ts;
      payload.responseBy = ctx.userEmail || '';
    }

    ref
      .add(payload)
      .catch(function (err) {
        console.error(ns, 'addItem error', err);
      });

    msgInput.value = '';
    if (responseInput) responseInput.value = '';
    if (dueInput) dueInput.value = '';
  }

  function startEdit(id) {
    var row = ctx.rows.find(function (r) {
      return r.id === id;
    });
    if (!row || !msgInput) return;

    ctx.editingId = id;
    msgInput.value = row.message || '';
    if (responseInput) responseInput.value = row.response || '';
    if (typeSel) typeSel.value = row.type || '';
    if (assignedSel) assignedSel.value = row.assignedTo || '';
    if (dueInput) dueInput.value = toDateInputValue(row.dueDate);
    if (addBtn) addBtn.textContent = 'Update';
  }

  function saveEdit() {
    if (!ctx.editingId) return;

    var ref = qnaRef();
    if (!ref || !msgInput) return;

    var msg = msgInput.value.trim();
    var response = responseInput ? responseInput.value.trim() : '';
    var type = (typeSel && typeSel.value) || '';
    var assignedTo = (assignedSel && assignedSel.value) || '';
    var dueDate = dueInput && dueInput.value ? new Date(dueInput.value + 'T00:00:00') : null;

    var existing = ctx.rows.find(function (r) { return r.id === ctx.editingId; });
    var responseChanged = !!existing && (existing.response || '') !== response;

    var payload = {
      message: msg,
      response: response,
      type: type,
      assignedTo: assignedTo,
      dueDate: dueDate
    };
    if (responseChanged && response) {
      var now =
        (window.firebase &&
          window.firebase.firestore &&
          window.firebase.firestore.FieldValue &&
          window.firebase.firestore.FieldValue.serverTimestamp &&
          window.firebase.firestore.FieldValue.serverTimestamp()) || new Date();
      payload.responseAt = now;
      payload.responseBy = ctx.userEmail || '';
    }

    ref
      .doc(ctx.editingId)
      .update(payload)
      .catch(function (err) {
        console.error(ns, 'saveEdit error', err);
      });

    ctx.editingId = null;
    if (addBtn) addBtn.textContent = 'Add';
    msgInput.value = '';
    if (responseInput) responseInput.value = '';
    if (dueInput) dueInput.value = '';
  }

  function deleteItem(id) {
    var ref = qnaRef();
    if (!ref) return;

    var confirmed = window.drConfirm
      ? window.drConfirm('Delete this Q&A item? This cannot be undone.', { title: 'Delete Item' })
      : Promise.resolve(window.confirm('Delete this item?'));

    confirmed.then(function (ok) {
      if (!ok) return;
      ref
        .doc(id)
        .delete()
        .catch(function (err) {
          console.error(ns, 'deleteItem error', err);
        });
    });
  }

  function updateCompleted(id, done) {
    var ref = qnaRef();
    if (!ref) return;
    ref
      .doc(id)
      .update({ completed: !!done })
      .catch(function (err) {
        console.error(ns, 'updateCompleted error', err);
      });
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------
  function bindTableEvents() {
    if (!tbody) return;

    tbody.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t) return;

      if (t.classList.contains('qna-edit')) {
        startEdit(t.getAttribute('data-id'));
      } else if (t.classList.contains('qna-del')) {
        deleteItem(t.getAttribute('data-id'));
      }
    });

    tbody.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t) return;
      if (t.classList.contains('qna-done')) {
        updateCompleted(t.getAttribute('data-id'), !!t.checked);
      }
    });
  }

  function bindFilters() {
    if (filterDoneSel) filterDoneSel.addEventListener('change', paint);
    if (filterTypeSel) filterTypeSel.addEventListener('change', paint);
    if (filterAssignedSel) filterAssignedSel.addEventListener('change', paint);
  }

  function bindAdd() {
    if (!addBtn) return;
    addBtn.addEventListener('click', function () {
      if (ctx.editingId) {
        saveEdit();
      } else {
        addItem();
      }
    });
  }

  function bindSortHeader() {
    var thead = document.querySelector('#qna-table thead');
    if (!thead) return;

    thead.addEventListener('click', function (ev) {
      var th = ev.target.closest('th[data-sort]');
      if (!th) return;

      var key = th.getAttribute('data-sort');
      if (ctx.sort.key === key) {
        ctx.sort.dir = ctx.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        ctx.sort.key = key;
        ctx.sort.dir = 'asc';
      }

      // update CSS classes for arrows
      Array.prototype.forEach.call(
        thead.querySelectorAll('th[data-sort]'),
        function (el) {
          el.classList.remove('asc', 'desc');
        }
      );
      th.classList.add(ctx.sort.dir);

      paint();
    });
  }

  // ---------------------------------------------------------------------------
  // Snapshot listener
  // ---------------------------------------------------------------------------
  function listenQna() {
    var ref = qnaRef();
    if (!ref) return;

    ref
      .orderBy('timestamp', 'desc')
      .onSnapshot(function (snap) {
        var rows = [];
        snap.forEach(function (doc) {
          var d = doc.data() || {};
          d.id = doc.id;
          rows.push(d);
        });
        ctx.rows = rows;
        rebuildFilters();
        updateStats();      // NEW: drive counts from current rows
        paint();
      });
  }

  // ---------------------------------------------------------------------------
  // Context detection
  // ---------------------------------------------------------------------------
  function detectContextFromDOM() {
    tbody = $('#qna-table tbody');
    typeSel = $('#qna-type');
    assignedSel = $('#qna-assigned');
    dueInput = $('#qna-due');
    msgInput = $('#qna-message');
    responseInput = $('#qna-response');
    addBtn = $('#qna-add');
    filterDoneSel = $('#qna-filter-done');
    filterTypeSel = $('#qna-filter-type');
    filterAssignedSel = $('#qna-filter-assigned');

    // Biz and user from globals / auth
    ctx.biz = window.BIZ_KEY || window.businessKey || null;

    var user =
      (window.auth && window.auth.currentUser) ||
      (window.firebase &&
        window.firebase.auth &&
        window.firebase.auth().currentUser) ||
      null;

    ctx.userEmail = (user && user.email) || '';
    ctx.userUid = (user && user.uid) || '';

    ctx.isOwner =
      !!ctx.userEmail &&
      ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();

    console.log(ns, 'context:', {
      biz: ctx.biz,
      email: ctx.userEmail,
      isOwner: ctx.isOwner
    });
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init() {
    console.log(ns, 'init called');

    detectContextFromDOM();
    if (!ctx.biz) {
      console.warn(ns, 'no biz context; qna disabled');
      return;
    }

    bindTableEvents();
    bindFilters();
    bindAdd();
    bindSortHeader();
    loadAssignees();
    listenQna();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
