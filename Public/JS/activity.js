// Public/JS/activity.js – Activity Log for businesses/{biz}/activity
// Owner can create/update/delete; non‑owners are read‑only.

(function () {
  'use strict';

  var TAG = '[activity]';
  // Read owner email from a global or environment config
var OWNER_EMAIL =
  (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) ||
  (window.ownerEmail) ||
  '';

  // ---------- helpers ----------

  function getDB() {
    return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore());
  }

  function getAuth() {
    return window.auth || (window.firebase && window.firebase.auth && window.firebase.auth());
  }

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function fmtDate(ts) {
    if (!ts) return '';
    try {
      var d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toLocaleDateString();
    } catch (e) {
      console.warn(TAG, 'fmtDate failed', e);
      return '';
    }
  }

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
          try {
            sessionStorage.setItem('bizKey', k);
          } catch (_) {}
          return done(k);
        }

        if (typeof window.requireAuth === 'function') {
          window
            .requireAuth(false)
            .then(function (info) {
              if (info && info.businessKey) {
                window.BIZ_KEY = info.businessKey;
                try {
                  sessionStorage.setItem('bizKey', info.businessKey);
                } catch (_) {}
                return done(info.businessKey);
              }
              retry();
            })
            .catch(function () {
              retry();
            });
          return;
        }

        retry();
      }

      function retry() {
        if (!required) return done(null);
        if (tries > 40) {
          console.error(TAG, 'Business key is missing after retries.');
          return done(null);
        }
        setTimeout(attempt, 150);
      }

      function done(k) {
        resolve(k || null);
      }

      attempt();
    });
  }

  // ---------- state + DOM ----------

  var ctx = {
  biz: null,
  isOwner: false,
  userEmail: '',
  rows: [], // { id, title, description, status, dueDate, createdAt, createdBy }
  sort: { key: 'date', dir: 'desc' } // NEW: default sort by due date
};

  var dom = {
    table: null,
    tableBody: null,
    form: null,
    titleInput: null,
    descInput: null,
    statusInput: null,
    dateInput: null,
    importInput: null,
    importBtn: null
  };

  function bindDOM() {
    dom.table = byId('activityTable');
    dom.tableBody =
      (dom.table && dom.table.querySelector('tbody')) ||
      $('#activityTable tbody') ||
      byId('activityTableBody') ||
      $('#activityTable');

    dom.form = byId('activityForm');
    if (dom.form) {
      dom.titleInput = byId('activityTitle');
      dom.descInput = byId('activityDesc');
      dom.statusInput = byId('activityStatus');
      dom.dateInput = byId('activityDate');
    }

    dom.importInput = byId('activityImport');
    dom.importBtn = byId('importBtn');
  }
function sortedRows() {
  var rows = (ctx.rows || []).slice();
  var key = ctx.sort && ctx.sort.key;
  var dir = ctx.sort && ctx.sort.dir === 'desc' ? -1 : 1;
  if (!key) return rows;

  rows.sort(function (a, b) {
    var av, bv;

    if (key === 'date') {
      av = a.dueDate || a.dueDateText || '';
      bv = b.dueDate || b.dueDateText || '';

      av = av && av.toDate ? av.toDate() : (av instanceof Date ? av : new Date(av));
      bv = bv && bv.toDate ? bv.toDate() : (bv instanceof Date ? bv : new Date(bv));

      av = isNaN(av.getTime()) ? 0 : av.getTime();
      bv = isNaN(bv.getTime()) ? 0 : bv.getTime();
    } else if (key === 'title') {
      av = (a.title || '').toLowerCase();
      bv = (b.title || '').toLowerCase();
    } else if (key === 'status') {
      av = (a.status || '').toLowerCase();
      bv = (b.status || '').toLowerCase();
    } else {
      return 0;
    }

    if (av < bv) return -1 * dir;
    if (av > bv) return  1 * dir;
    return 0;
  });

  return rows;
}

// ---------- sorting ----------
function sortedRows() {
  var rows = (ctx.rows || []).slice();
  var key = ctx.sort && ctx.sort.key;
  var dir = ctx.sort && ctx.sort.dir === 'desc' ? -1 : 1;
  if (!key) return rows;

  rows.sort(function (a, b) {
    var av, bv;

    if (key === 'date') {
      av = a.dueDate || a.dueDateText || '';
      bv = b.dueDate || b.dueDateText || '';

      av = av && av.toDate ? av.toDate() : (av instanceof Date ? av : new Date(av));
      bv = bv && bv.toDate ? bv.toDate() : (bv instanceof Date ? bv : new Date(bv));

      av = isNaN(av.getTime()) ? 0 : av.getTime();
      bv = isNaN(bv.getTime()) ? 0 : bv.getTime();
    } else if (key === 'title') {
      av = (a.title  || '').toLowerCase();
      bv = (b.title  || '').toLowerCase();
    } else if (key === 'status') {
      av = (a.status || '').toLowerCase();
      bv = (b.status || '').toLowerCase();
    } else {
      return 0;
    }

    if (av < bv) return -1 * dir;
    if (av > bv) return  1 * dir;
    return 0;
  });

  return rows;
}



 // ---------- rendering ----------

function render() {
  if (!dom.tableBody) return;

  // use sorted copy of rows
  var rows = sortedRows();

  if (!rows || !rows.length) {
    dom.tableBody.innerHTML =
      '<tr><td colspan="4" class="empty">No activity logged yet.</td></tr>';
    return;
  }

  // update header sort arrow classes
  if (dom.table) {
    $all('thead th[data-sort]', dom.table).forEach(function (th) {
      var key = th.getAttribute('data-sort');
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (ctx.sort && ctx.sort.key === key) {
        th.classList.add(ctx.sort.dir === 'desc' ? 'sorted-desc' : 'sorted-asc');
      }
    });
  }

  dom.tableBody.innerHTML = rows
    .map(function (r) {
      var actions = '—';
      if (ctx.isOwner) {
        actions =
          '<button type="button" class="edit-btn" data-id="' +
          r.id +
          '">✎</button>' +
          '<button type="button" class="delete-btn" data-id="' +
          r.id +
          '">🗑</button>';
      }

      var title = r.title || '';
      var status = r.status || '';
      var due = r.dueDate ? fmtDate(r.dueDate) : (r.dueDateText || '');

      return (
        '<tr data-id="' +
        r.id +
        '">' +
        '<td>' +
        title +
        (r.description ? '<div class="activity-desc">' + r.description + '</div>' : '') +
        '</td>' +
        '<td>' +
        status +
        '</td>' +
        '<td>' +
        due +
        '</td>' +
        '<td class="actions">' +
        actions +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  if (ctx.isOwner) {
    wireRowActions();
  }
}

  function wireRowActions() {
    if (!dom.tableBody) return;

    $all('.edit-btn', dom.tableBody).forEach(function (btn) {
     btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var row = ctx.rows.find(function (r) {
          return r.id === id;
        })
        if (!row || !dom.form) return;

        if (dom.titleInput) dom.titleInput.value = row.title || '';
        if (dom.descInput) dom.descInput.value = row.description || '';
       if (dom.statusInput) {
  if (row.status) {
    dom.statusInput.value = row.status;
  } else {
    // no saved status → reset so placeholder "Select Status" shows
    dom.statusInput.value = '';
  }
}
        if (dom.dateInput) {
          try {
            if (row.dueDate && row.dueDate.toDate) {
              var d = row.dueDate.toDate();
              dom.dateInput.value = d.toISOString().slice(0, 10);
            } else if (row.dueDate instanceof Date) {
              dom.dateInput.value = row.dueDate.toISOString().slice(0, 10);
            } else {
              dom.dateInput.value = '';
            }
          } catch (_) {
            dom.dateInput.value = '';
          }
        }
        dom.form.setAttribute('data-edit-id', id);
      });
    });

    $all('.delete-btn', dom.tableBody).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        if (!id || !ctx.biz || !ctx.isOwner) return;

        if (!window.confirm('Delete this activity item?')) return;

        var db = getDB();
        if (!db) return;

        db.collection('businesses')
          .doc(ctx.biz)
          .collection('activities')
          .doc(id)
          .delete()
          .catch(function (err) {
            console.error(TAG, 'Delete failed', err);
            try {
              alert(
                'Could not delete activity: ' +
                  (err && err.message ? err.message : err)
              );
            } catch (_) {}
          });
      });
    });
  }
function bindSortHeaders() {
  if (!dom.table) return;
  $all('thead th[data-sort]', dom.table).forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (!key) return;

      if (ctx.sort && ctx.sort.key === key) {
        ctx.sort.dir = ctx.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        ctx.sort = { key: key, dir: 'asc' };
      }
      render();
    });
  });
}
  // ---------- Firestore subscription ----------

  function subscribe(biz, user) {
    var db = getDB();
    if (!db) {
      console.error(TAG, 'Firestore not available');
      return;
    }

    var email = (user && user.email ? user.email : '').toLowerCase();
    ctx.biz = biz;
    ctx.userEmail = email;
    ctx.isOwner = email === OWNER_EMAIL;

    // Mark table owner/non‑owner so CSS can hide Actions column
if (dom.table) {
  if (ctx.isOwner) dom.table.classList.add('owner');
  else dom.table.classList.remove('owner');
}

// Hide Add Activity form + Import bar for non‑owners
var panel = document.querySelector('.card.activity-panel');
if (!ctx.isOwner && panel) {
  var formSection   = panel.querySelector('#activityForm');
  var importSection = panel.querySelector('.activity-import');

  if (formSection) {
    formSection.style.display = 'none';
  }
  if (importSection) {
    importSection.style.display = 'none';
  }
}
var panel = document.querySelector('.card.activity-panel');

// Table owner flag (for Actions column)
if (dom.table) {
  if (ctx.isOwner) dom.table.classList.add('owner');
  else dom.table.classList.remove('owner');
}

// Panel owner flag (for form + import visibility via CSS)
if (panel) {
  if (ctx.isOwner) panel.classList.add('owner');
  else panel.classList.remove('owner');
}

console.log('[activity] panel owner flag', {
  email: ctx.userEmail,
  isOwner: ctx.isOwner,
  hasPanel: !!panel,
  panelClasses: panel && panel.className
});

    var col = db
      .collection('businesses')
      .doc(biz)
      .collection('activities');

    col.orderBy('createdAt', 'desc').onSnapshot(
      function (snap) {
        var rows = [];
        snap.forEach(function (doc) {
  var data = doc.data() || {};

  // 1) Get raw status from Firestore/import
  var rawStatus = data.status || '';

  // 2) Normalize to match your <select> options
  function normalizeStatus(s) {
    s = (s || '').toLowerCase().trim();
    if (!s) return '';
    if (s === 'not started') return 'Not Started';
    if (s === 'in progress') return 'In Progress';
    if (s === 'completed' || s === 'complete') return 'Completed';
    // fallback: capitalize first letter
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // 3) Use normalized status when building the row
  rows.push({
    id: doc.id,
    title: data.title || data.activity || '',
    description: data.description || data.desc || '',
    status: normalizeStatus(rawStatus),
    dueDate: data.dueDate || data.due || null,
    dueDateText: data.dueDateText || '',
    createdAt: data.createdAt || null,
    createdBy: data.createdBy || ''
  });
});
        ctx.rows = rows;
        render();
      },
      function (err) {
        console.error(TAG, 'Activity snapshot failed', err);
      }
    );

    if (ctx.isOwner && dom.form) {
      wireForm(col);
    } else if (dom.form) {
      // Non‑owners: prevent any submission
      dom.form.addEventListener('submit', function (e) {
        e.preventDefault();
      });
      $all('input, select, button', dom.form).forEach(function (el) {
        // Leave labels/type=date visually but block editing
        if (el.tagName === 'BUTTON') {
          el.disabled = true;
        } else {
          el.readOnly = true;
          el.disabled = true;
        }
      });
    }

    // Import controls: owner‑only
   // inside subscribe(biz, user) after ctx.isOwner is set and bindDOM() has run
if (dom.importBtn) var email = (user && user.email ? user.email : '').toLowerCase();
ctx.biz = biz;
ctx.userEmail = email;
ctx.isOwner = email === OWNER_EMAIL;

console.log('[activity] context →', {
  biz: biz,
  email: email,
  OWNER_EMAIL: OWNER_EMAIL,
  isOwner: ctx.isOwner
});{
  if (!ctx.isOwner) {
    dom.importBtn.disabled = true;
    dom.importBtn.onclick = null;
  } else {
    dom.importBtn.disabled = false;
    dom.importBtn.onclick = async function (e) {
      e.preventDefault();

      if (!dom.importInput || !dom.importInput.files || !dom.importInput.files[0]) {
        alert('Choose an Excel (.xlsx) file first.');
        return;
      }

      var file = dom.importInput.files[0];

      try {
        // Read file as ArrayBuffer
        var data = await file.arrayBuffer();

        // Parse workbook using SheetJS (already loaded on dashboard.html)
        var wb = XLSX.read(data, { type: 'array' });

        // Use the first worksheet
        var sheetName = wb.SheetNames[0];
        var ws = wb.Sheets[sheetName];

        // Convert to JSON (each row becomes an object keyed by header row)
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

        // Assume first row is headers
        if (!rows.length) {
          alert('Excel file has no rows.');
          return;
        }

        var header = rows[0].map(function (h) {
          return String(h || '').trim().toLowerCase();
        });

        // Helper to get column index by header name (case‑insensitive)
        function colIndex(nameOptions) {
          nameOptions = nameOptions.map(function (n) { return n.toLowerCase(); });
          for (var i = 0; i < header.length; i++) {
            if (nameOptions.indexOf(header[i]) !== -1) return i;
          }
          return -1;
        }

        var idxTitle = colIndex(['title', 'activity']);
        var idxDesc  = colIndex(['desc', 'description', 'activity description','details']);
        var idxStatus= colIndex(['status']);
        var idxDate  = colIndex(['duedate', 'due date', 'date']);

        if (idxTitle === -1) {
          alert('Excel sheet must have a Title or Activity column.');
          return;
        }

        var db = getDB();
        if (!db) {
          alert('Firestore not available.');
          return;
        }

        var col = db.collection('businesses').doc(ctx.biz).collection('activities');

        // Process remaining rows
        var ops = [];
        for (var r = 1; r < rows.length; r++) {
          var row = rows[r] || [];
          var title  = (row[idxTitle] != null ? String(row[idxTitle]).trim() : '');
          if (!title) continue; // skip empty rows

          var desc   = idxDesc  >= 0 && row[idxDesc]  != null ? String(row[idxDesc]).trim()  : '';
          var status = idxStatus>= 0 && row[idxStatus]!= null ? String(row[idxStatus]).trim() : '';
          var dateRaw= idxDate  >= 0 && row[idxDate]  != null ? String(row[idxDate]).trim()  : '';

          var payload = {
            title:  title,
            desc:   desc,
            description: desc,
            status: status,
            createdBy: ctx.userEmail || '',
            createdAt: window.firebase &&
                       window.firebase.firestore &&
                       window.firebase.firestore.FieldValue &&
                       window.firebase.firestore.FieldValue.serverTimestamp
                         ? window.firebase.firestore.FieldValue.serverTimestamp()
                         : new Date()
          };

          if (dateRaw) {
            // Try to parse as Excel date or plain string
            var asNum = Number(dateRaw);
            if (!isNaN(asNum) && asNum > 0) {
              // Excel serial date
              var jsDate = XLSX.SSF.parse_date_code(asNum);
              if (jsDate) {
                payload.dueDate = new Date(jsDate.y, jsDate.m - 1, jsDate.d);
              } else {
                payload.dueDateText = dateRaw;
              }
            } else {
              // Try Date constructor
              var d = new Date(dateRaw);
              if (!isNaN(d.getTime())) {
                payload.dueDate = d;
              } else {
                payload.dueDateText = dateRaw;
              }
            }
          }

          ops.push(col.add(payload));
        }

        if (!ops.length) {
          alert('No valid activity rows found in Excel file.');
          return;
        }

        await Promise.all(ops);
        alert('Imported ' + ops.length + ' activity item(s) from Excel.');
        // Clear file input
        dom.importInput.value = '';
      } catch (err) {
        console.error(TAG, 'Excel import failed', err);
        alert('Excel import failed: ' + (err && err.message ? err.message : err));
      }
    };
  }
}
  }

  // ---------- Form handling (owner only) ----------

  function wireForm(col) {
    if (!dom.form) return;

    dom.form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!ctx.isOwner) return;

      var id = dom.form.getAttribute('data-edit-id') || null;
      var title =
        (dom.titleInput && dom.titleInput.value && dom.titleInput.value.trim()) ||
        '';
      var desc =
        (dom.descInput && dom.descInput.value && dom.descInput.value.trim()) ||
        '';
      var status =
        (dom.statusInput && dom.statusInput.value && dom.statusInput.value.trim()) ||
        '';
      var dateRaw =
        (dom.dateInput && dom.dateInput.value && dom.dateInput.value.trim()) ||
        '';

      if (!title) {
        try {
          alert('Activity title is required.');
        } catch (_) {}
        return;
      }

      if (!status) {
        try {
          alert('Activity status is required.');
        } catch (_) {}
        return;
      }

      var payload = {
        title: title,
        description: desc,
        status: status,
        updatedAt:
          window.firebase &&
          window.firebase.firestore &&
          window.firebase.firestore.FieldValue &&
          window.firebase.firestore.FieldValue.serverTimestamp
            ? window.firebase.firestore.FieldValue.serverTimestamp()
            : new Date()
      };

      if (dateRaw) {
        try {
          payload.dueDate = new Date(dateRaw + 'T00:00:00');
        } catch (_) {
          payload.dueDateText = dateRaw;
        }
      }

      if (!id) {
        payload.createdAt =
          window.firebase &&
          window.firebase.firestore &&
          window.firebase.firestore.FieldValue &&
          window.firebase.firestore.FieldValue.serverTimestamp
            ? window.firebase.firestore.FieldValue.serverTimestamp()
            : new Date();
        payload.createdBy = ctx.userEmail || '';

        col
          .add(payload)
          .then(function () {
            resetForm();
          })
          .catch(function (err) {
            console.error(TAG, 'Add activity failed', err);
            try {
              alert(
                'Could not add activity: ' +
                  (err && err.message ? err.message : err)
              );
            } catch (_) {}
          });
      } else {
        col
          .doc(id)
          .update(payload)
          .then(function () {
            resetForm();
          })
          .catch(function (err) {
            console.error(TAG, 'Update activity failed', err);
            try {
              alert(
                'Could not update activity: ' +
                  (err && err.message ? err.message : err)
              );
            } catch (_) {}
          });
      }
    });

    function resetForm() {
      if (!dom.form) return;
      dom.form.removeAttribute('data-edit-id');
      if (dom.titleInput) dom.titleInput.value = '';
      if (dom.descInput) dom.descInput.value = '';
      if (dom.statusInput) dom.statusInput.value = '';
      if (dom.dateInput) dom.dateInput.value = '';
    }
  }

  // ---------- public API ----------

  window.activityAPI = {
    async add(data) {
      var biz = await resolveBizKey(true);
      if (!biz) return;
      var db = getDB();
      if (!db) return;

      var col = db
        .collection('businesses')
        .doc(biz)
        .collection('activities');

      var payload = Object.assign(
        {
          createdAt:
            window.firebase &&
            window.firebase.firestore &&
            window.firebase.firestore.FieldValue &&
            window.firebase.firestore.FieldValue.serverTimestamp
              ? window.firebase.firestore.FieldValue.serverTimestamp()
              : new Date(),
          createdBy: (ctx.userEmail || '').toLowerCase()
        },
        data || {}
      );

      return col.add(payload);
    }
  };

  // ---------- boot ----------

  function start() {
    var auth = getAuth();
    if (!auth) {
      console.error(TAG, 'Auth not available');
      return;
    }

    bindDOM();
bindSortHeaders(); // NEW

    auth.onAuthStateChanged(function (user) {
      if (!user) {
        ctx.rows = [];
        render();
        return;
      }

      resolveBizKey(true).then(function (biz) {
        if (!biz) return;
        subscribe(biz, user);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
