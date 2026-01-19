/* ============================================================================
 Q&A Tracker – wired to existing dashboard.html / qna.css

 Assumes Firestore: businesses/{biz}/qna/{doc}
 Doc fields (best‑effort):
 {
   type,
   message,
   assignedTo,
   completed,
   createdBy,
   createdByUid,
   timestamp
 }
============================================================================ */

(function () {
  'use strict';

  var ns = '[qna]';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); }

  // DOM references (adapted to current dashboard.html/qna.css)
  var tbody;              // <tbody> of Q&A table
  var typeSel;            // "Type" select in the input row
  var assignedSel;        // "Assign to" select in the input row
  var msgInput;           // textarea / text input for the message
  var addBtn;             // Add button

  var filterDoneSel;      // Filter by Done/Not Done
  var filterTypeSel;      // Filter by Type
  var filterAssignedSel;  // Filter by Assigned

  // Context
  var ctx = {
    biz: null,
    userEmail: '',
    userUid: '',
    isOwner: false,
    rows: [],
    editingId: null
  };

  var OWNER_EMAIL = 'john@distinctrevelations.com';

  function fmtDate(ts) {
    if (!ts) return '';
    try {
      return (ts.toDate ? ts.toDate() : new Date(ts)).toLocaleString();
    } catch (_) {
      return '';
    }
  }

  function canEdit(row) {
    return ctx.isOwner ||
      (String(row.createdBy || '').toLowerCase() === ctx.userEmail.toLowerCase());
  }

  function canDelete(row) {
    return ctx.isOwner ||
      (String(row.createdBy || '').toLowerCase() === ctx.userEmail.toLowerCase());
  }

  // Build filter dropdown options based on loaded data
  function rebuildFilters() {
    if (!filterTypeSel || !filterAssignedSel) return;

    var types = new Set();
    var assignees = new Set();

    ctx.rows.forEach(function (r) {
      if (r.type) types.add(r.type);
      if (r.assignedTo) assignees.add(r.assignedTo);
    });

    filterTypeSel.innerHTML = '<option value="">All Types</option>';
    Array.from(types).sort().forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      filterTypeSel.appendChild(opt);
    });

    filterAssignedSel.innerHTML = '<option value="">All Assignees</option>';
    Array.from(assignees).sort().forEach(function (a) {
      var opt2 = document.createElement('option');
      opt2.value = a;
      opt2.textContent = a;
      filterAssignedSel.appendChild(opt2);
    });
  }

// Load all company users into the "Assign to" dropdown
function loadAssignees() {
  if (!assignedSel || !ctx.biz) return;

  // Clear any old options
  assignedSel.innerHTML = '';

  // Optional "Unassigned" choice
  var optNone = document.createElement('option');
  optNone.value = '';
  optNone.textContent = 'Unassigned';
  assignedSel.appendChild(optNone);

  // Firestore path: businesses/{biz}/users
  firebase.firestore()
    .collection('businesses')
    .doc(ctx.biz)
    .collection('users')
    .get()
    .then(function (snap) {
      snap.forEach(function (doc) {
        var u = doc.data();
        var opt = document.createElement('option');

        opt.value = u.email || doc.id;
        opt.textContent = u.email || doc.id;

        assignedSel.appendChild(opt);
      });
    })
    .catch(function (err) {
      console.error(ns, 'loadAssignees error', err);
    });
}

  // Render table body
  function paint() {
    if (!tbody) return;

    var fd = filterDoneSel ? filterDoneSel.value : '';
    var ft = filterTypeSel ? filterTypeSel.value : '';
    var fa = filterAssignedSel ? filterAssignedSel.value : '';

    var rows = ctx.rows.filter(function (r) {
      var okD = !fd ||
        (fd === 'done' && !!r.completed) ||
        (fd === 'notDone' && !r.completed);
      var okT = !ft || (String(r.type || '') === ft);
      var okA = !fa || (String(r.assignedTo || '') === fa);
      return okD && okT && okA;
    });

    tbody.innerHTML = rows.map(function (r) {
      var canE = canEdit(r);
      var canD = canDelete(r);

      var editBtn = canE
        ? '<button class="edit-btn" data-id="' + r.id + '" title="Edit">&#9998;</button>'
        : '—';

      var delBtn = canD
        ? '<button class="delete-btn" data-id="' + r.id + '" title="Delete">&#128465;</button>'
        : '—';

      var chk = '<input type="checkbox" class="qna-done-toggle" data-id="' + r.id + '" ' +
                (r.completed ? 'checked' : '') + '>';

      return [
        '<tr data-id="' + r.id + '" class="' + (r.completed ? 'completed' : '') + '">',
          '<td>' + (r.type || '') + '</td>',
          '<td>' + (r.message || '') + '</td>',
          '<td>' + (r.assignedTo || '') + '</td>',
          '<td>' + fmtDate(r.timestamp) + '</td>',
          '<td style="text-align:center">' + chk + '</td>',
          '<td style="text-align:center">' + editBtn + delBtn + '</td>',
        '</tr>'
      ].join('');
    }).join('');
  }

  // Load all company users into the Assign‑To dropdown
  function loadAssignableUsers() {
    if (!ctx.biz || !assignedSel) return;
    var db = firebase.firestore();
    db.collection('users')
      .where('biz', '==', ctx.biz)
      .orderBy('email')
      .get()
      .then(function (snap) {
        var frag = document.createDocumentFragment();
        snap.forEach(function (doc) {
          var u = doc.data();
          if (!u.email) return;
          var opt = document.createElement('option');
          opt.value = u.email;
          opt.textContent = u.email;
          frag.appendChild(opt);
        });
        assignedSel.innerHTML = '<option value="">Unassigned</option>';
        assignedSel.appendChild(frag);
      })
      .catch(function (err) {
        console.error(ns, 'loadAssignableUsers failed', err);
      });
  }

  // Firestore subscription
  function subscribe(biz) {
    var db = firebase.firestore();
    db.collection('businesses').doc(biz).collection('qna')
      .orderBy('timestamp', 'desc')
      .onSnapshot(function (snap) {
        ctx.rows = [];
        snap.forEach(function (doc) {
          var d = doc.data() || {};
          d.id = doc.id;
          ctx.rows.push(d);
        });
        rebuildFilters();
        paint();
      }, function (err) {
        console.error(ns, 'qna snapshot error', err);
      });
  }

  // Add / update entry
  function onAddClick(evt) {
    evt.preventDefault();
    if (!ctx.biz || !msgInput) return;

    var type = typeSel ? typeSel.value.trim() : '';
    var msg = msgInput.value.trim();
    var assigned = assignedSel ? assignedSel.value.trim() : '';

    if (!msg) return;

    var db = firebase.firestore();
    var col = db.collection('businesses').doc(ctx.biz).collection('qna');

    if (ctx.editingId) {
      // Update existing document (owner or creator only)
      col.doc(ctx.editingId).update({
        type: type,
        message: msg,
        assignedTo: assigned
      }).then(function () {
        ctx.editingId = null;
        msgInput.value = '';
      }).catch(function (err) {
        console.error(ns, 'update failed', err);
      });
    } else {
      // Create new
      col.add({
        type: type,
        message: msg,
        assignedTo: assigned,
        completed: false,
        createdBy: ctx.userEmail || '',
        createdByUid: ctx.userUid || '',
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      }).then(function () {
        msgInput.value = '';
      }).catch(function (err) {
        console.error(ns, 'add failed', err);
      });
    }
  }

  function onDelete(id) {
    if (!ctx.biz || !id) return;
    var db = firebase.firestore();
    db.collection('businesses').doc(ctx.biz)
      .collection('qna').doc(id).delete()
      .catch(function (err) {
        console.error(ns, 'delete failed', err);
      });
  }

  function onEdit(id) {
    var row = ctx.rows.find(function (r) { return r.id === id; });
    if (!row) return;

    ctx.editingId = id;

    if (typeSel) typeSel.value = row.type || '';
    if (assignedSel) assignedSel.value = row.assignedTo || '';
    if (msgInput) msgInput.value = row.message || '';
  }

  // Initialise with existing HTML / CSS
  function init(context) {
    ctx.biz = context.biz;
    ctx.userEmail = (context.user || context.email || '').toLowerCase();
    ctx.userUid = context.uid || '';
    ctx.isOwner = (ctx.userEmail === OWNER_EMAIL);

    // Hook into existing DOM:
    // table: |Type|Message|Assigned|Date|Done|Actions|
    tbody = $('#qnaTableBody') || $('.qna-table tbody');

    // input controls: use the first row above the table:
    typeSel = $('#qnaType') || $('#qna-type');
    assignedSel = $('#qnaAssigned') || $('#qna-assigned');
  loadAssignees();
    msgInput = $('#qnaMessage') || $('#qna-message');
    addBtn = $('#qnaAddBtn') || $('#qna-add');

    // filters:
    filterDoneSel = $('#qnaFilterDone') || $('#qna-filter-done');
    filterTypeSel = $('#qnaFilterType') || $('#qna-filter-type');
    filterAssignedSel = $('#qnaFilterAssigned') || $('#qna-filter-assigned');

    if (addBtn) {
      addBtn.addEventListener('click', onAddClick);
    }

    if (filterDoneSel) filterDoneSel.addEventListener('change', paint);
    if (filterTypeSel) filterTypeSel.addEventListener('change', paint);
    if (filterAssignedSel) filterAssignedSel.addEventListener('change', paint);

    if (tbody) {
      tbody.addEventListener('click', function (evt) {
        var t = evt.target;
        var id = t.getAttribute('data-id');

        if (t.classList.contains('delete-btn') && id) {
          if (!confirm('Delete this Q&A item?')) return;
          return onDelete(id);
        }
        if (t.classList.contains('edit-btn') && id) {
          return onEdit(id);
        }
      });

      tbody.addEventListener('change', function (evt) {
        var t = evt.target;
        if (!t.classList.contains('qna-done-toggle')) return;
        var id = t.getAttribute('data-id');
        if (!id) return;
        var db = firebase.firestore();
        db.collection('businesses').doc(ctx.biz)
          .collection('qna').doc(id)
          .update({ completed: !!t.checked })
          .catch(function (err) {
            console.error(ns, 'toggle completed failed', err);
          });
      });
    }

    loadAssignableUsers();
    subscribe(ctx.biz);
  }

 // ----- Auto‑init pattern (same idea as projectStatus/projectProgress)
function waitForFirebase(cb) {
  if (window.db && window.auth) {
    cb({ db: window.db, auth: window.auth });
    return;
  }
  setTimeout(function () { waitForFirebase(cb); }, 150);
}

function waitForBusinessKey(cb) {
  if (window.BIZ_KEY) {
    cb(window.BIZ_KEY);
    return;
  }
  if (typeof window.waitForBusinessKey === 'function') {
    window.waitForBusinessKey(function (bizKey) {
      window.BIZ_KEY = bizKey;
      cb(bizKey);
    });
    return;
  }
  setTimeout(function () { waitForBusinessKey(cb); }, 150);
}

// Auto‑start Q&A once DOM + Firebase + bizKey are ready
function autoStartQna() {
  waitForFirebase(function (DR) {
    waitForBusinessKey(function (bizKey) {
      var user = DR.auth.currentUser || {};
      if (typeof window.initQna === 'function') {
        window.initQna({
          biz: bizKey,
          user: {
            email: user.email || '',
            uid: user.uid || ''
          }
        });
      }
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoStartQna);
} else {
  autoStartQna();
}

// keep this line so manual callers still work:
window.initQna = init;

})();
