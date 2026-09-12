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
    if (window.drDateFmt) return window.drDateFmt.date(ts);
    try {
      var d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toLocaleDateString();
    } catch (e) {
      console.warn(TAG, 'fmtDate failed', e);
      return '';
    }
  }

  // "Ahead" / "On Schedule" / "Behind" — actual % complete vs. where the
  // item should be given how much of its own start->due window has
  // elapsed. Deliberately plain-language, not a raw SPI/EVM figure.
  function computePace(row, completed) {
    if (completed || !window.drRag) return null;

    var due = window.drRag.toJsDate(row.dueDate);
    var start = window.drRag.toJsDate(row.startDate) || window.drRag.toJsDate(row.createdAt);
    if (!due || !start) return null;

    due = window.drRag.dateOnly(due);
    start = window.drRag.dateOnly(start);
    var today = window.drRag.dateOnly(new Date());
    if (due <= start || today <= start) return null;

    var expectedPct = Math.max(0, Math.min(100, ((today - start) / (due - start)) * 100));
    var actualPct = typeof row.progress === 'number' ? row.progress :
      ((row.status || '').toLowerCase() === 'in progress' ? 50 : 0);

    var diff = actualPct - expectedPct;
    if (diff >= 10) return { code: 'ahead', label: 'Ahead of schedule' };
    if (diff <= -10) return { code: 'behind', label: 'Behind schedule' };
    return { code: 'on-track', label: 'On schedule' };
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
    responsibleInput: null,
    dateInput: null,
    submitBtn: null,
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
      dom.responsibleInput = byId('activityResponsible');
      dom.dateInput = byId('activityDate');
      dom.submitBtn = dom.form.querySelector('button[type="submit"]');
    }

    dom.importInput = byId('activityImport');
    dom.importBtn = byId('importBtn');
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
    } else if (key === 'responsible') {
      av = (a.responsible || '').toLowerCase();
      bv = (b.responsible || '').toLowerCase();
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
      '<tr><td colspan="6" class="empty">No activity logged yet.</td></tr>';
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

      var completed = (r.status || '').toLowerCase() === 'completed';
      var jeopardy = window.drRag
        ? window.drRag.compute(r.createdAt, r.dueDate, completed)
        : { code: 'none', label: '' };
      var pace = computePace(r, completed);
      var ragCell =
        '<span class="dr-rag dr-rag-' + jeopardy.code + '" title="' + jeopardy.label + '"></span>' +
        '<span class="dr-rag-label">' + jeopardy.label + '</span>' +
        (pace ? '<div class="dr-pace dr-pace-' + pace.code + '">' + pace.label + '</div>' : '');

      var responsible = r.responsible || '';

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
        '<td title="' + responsible + '">' +
        responsible +
        '</td>' +
        '<td>' +
        due +
        '</td>' +
        '<td class="dr-rag-cell">' +
        ragCell +
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
        if (dom.responsibleInput) dom.responsibleInput.value = row.responsible || '';
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
        if (dom.submitBtn) dom.submitBtn.textContent = 'Update Activity';
      });
    });

    $all('.delete-btn', dom.tableBody).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        if (!id || !ctx.biz || !ctx.isOwner) return;

        var confirmed = window.drConfirm
          ? window.drConfirm('Delete this activity item? This cannot be undone.', { title: 'Delete Activity' })
          : Promise.resolve(window.confirm('Delete this activity item?'));

        confirmed.then(function (ok) {
          if (!ok) return;

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
  // ---------- Responsible-party dropdown (company roster + owner) ----------
  function loadResponsibleOptions(db, biz) {
    if (!dom.responsibleInput) return;

    var seen = {};
    var sel = dom.responsibleInput;
    var current = sel.value || '';

    function addOption(email) {
      if (!email) return;
      var key = email.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      var opt = document.createElement('option');
      opt.value = email;
      opt.textContent = email;
      sel.appendChild(opt);
    }

    sel.innerHTML = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Responsible';
    sel.appendChild(placeholder);

    if (OWNER_EMAIL) addOption(OWNER_EMAIL);

    db.collection('businesses').doc(biz).collection('users').get().then(function (snap) {
      snap.forEach(function (doc) {
        var u = doc.data() || {};
        if (u.email) addOption(u.email);
      });
      if (current) sel.value = current;
    }).catch(function (err) {
      console.error(TAG, 'loadResponsibleOptions error', err);
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

    loadResponsibleOptions(db, biz);

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
    responsible: data.responsible || '',
    dueDate: data.dueDate || data.due || null,
    dueDateText: data.dueDateText || '',
    startDate: data.startDate || null,
    progress: data.progress,
    changeLog: data.changeLog || [],
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
        alert('Choose an Excel (.xlsx) or CSV file first.');
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

        // 'name' matches a plain MS Project export's Name column, same as
        // the Gantt importer already recognizes.
        var idxTitle    = colIndex(['title', 'activity', 'name']);
        var idxDesc     = colIndex(['desc', 'description', 'activity description', 'details']);
        var idxStatus   = colIndex(['status']);
        var idxStart    = colIndex(['start', 'startdate', 'start date', 'start_date']);
        var idxDate     = colIndex(['duedate', 'due date', 'date', 'end', 'enddate', 'end date', 'finish', 'finish_date', 'finish date']);
        var idxProgress = colIndex(['progress', '% complete', 'percent complete', 'percent_complete']);
        var idxResource = colIndex(['resource_names', 'resource names', 'resources', 'responsible']);
        var idxWbs      = colIndex(['wbs']);

        if (idxTitle === -1) {
          alert('Excel sheet must have a Title, Activity, or Name column.');
          return;
        }

        var db = getDB();
        if (!db) {
          alert('Firestore not available.');
          return;
        }

        var col = db.collection('businesses').doc(ctx.biz).collection('activities');

        function parseCell(v) {
          if (v == null || v === '') return null;
          if (typeof v === 'number') {
            var jsDate = XLSX.SSF.parse_date_code(v);
            if (jsDate) return new Date(jsDate.y, jsDate.m - 1, jsDate.d);
          }
          var d = new Date(v);
          return isNaN(d.getTime()) ? null : d;
        }

        function dfmt(v) {
          return fmtDate(v) || 'not set';
        }

        function serverNow() {
          return window.firebase &&
            window.firebase.firestore &&
            window.firebase.firestore.FieldValue &&
            window.firebase.firestore.FieldValue.serverTimestamp
              ? window.firebase.firestore.FieldValue.serverTimestamp()
              : new Date();
        }

        // Existing activities are already loaded live via onSnapshot —
        // match incoming rows against them by WBS (the stable id MS
        // Project assigns each row) so re-importing an updated file
        // UPDATES matching rows instead of creating duplicates every time.
        var existingByWbs = {};
        (ctx.rows || []).forEach(function (r) {
          if (r.wbs) existingByWbs[String(r.wbs).trim()] = r;
        });

        // Process remaining rows
        var ops = [];
        var createdCount = 0, updatedCount = 0;
        for (var r = 1; r < rows.length; r++) {
          var row = rows[r] || [];
          var title = (row[idxTitle] != null ? String(row[idxTitle]).trim() : '');
          if (!title) continue; // skip empty rows

          var desc = idxDesc >= 0 && row[idxDesc] != null ? String(row[idxDesc]).trim() : '';
          var dueDate = idxDate >= 0 ? parseCell(row[idxDate]) : null;
          var startDate = idxStart >= 0 ? parseCell(row[idxStart]) : null;
          var responsible = idxResource >= 0 && row[idxResource] != null ? String(row[idxResource]).trim() : '';
          var wbs = (idxWbs >= 0 && row[idxWbs] != null) ? String(row[idxWbs]).trim() : '';

          // MS Project's own CSV export writes Percent_Complete as a 0-1
          // fraction (0.33 = 33%) and Status as an internal numeric code
          // (0/2/3), not a readable word — so when a progress column is
          // present, derive a real Stage from it instead of using the raw
          // Status column. Fall back to raw Status text for simpler sheets
          // that only ever had a readable status column and no progress.
          var status;
          if (idxProgress >= 0 && row[idxProgress] != null) {
            var rawProgress = Number(row[idxProgress]);
            if (isNaN(rawProgress)) rawProgress = 0;
            var progress = rawProgress > 0 && rawProgress <= 1 ? rawProgress * 100 : rawProgress;
            progress = Math.max(0, Math.min(100, progress));
            status = progress >= 100 ? 'Completed' : (progress > 0 ? 'In Progress' : 'Not Started');
          } else {
            status = idxStatus >= 0 && row[idxStatus] != null ? String(row[idxStatus]).trim() : '';
          }

          var payload = {
            title: title,
            desc: desc,
            description: desc,
            status: status,
            wbs: wbs || null
          };
          if (dueDate) payload.dueDate = dueDate;
          if (startDate) payload.startDate = startDate;
          if (responsible) payload.responsible = responsible;

          var existingMatch = wbs ? existingByWbs[wbs] : null;

          if (existingMatch) {
            var edits = [];
            if ((existingMatch.title || '') !== title) edits.push({ field: 'Title', from: existingMatch.title || 'not set', to: title });
            if ((existingMatch.status || '') !== status) edits.push({ field: 'Stage', from: existingMatch.status || 'not set', to: status });
            if ((existingMatch.responsible || '') !== responsible) edits.push({ field: 'Responsible', from: existingMatch.responsible || 'unassigned', to: responsible || 'unassigned' });
            if (dfmt(existingMatch.dueDate) !== dfmt(dueDate)) edits.push({ field: 'Due date', from: dfmt(existingMatch.dueDate), to: dfmt(dueDate) });

            payload.updatedAt = serverNow();
            payload.updatedBy = ctx.userEmail || '';
            if (edits.length) {
              payload.changeLog = (existingMatch.changeLog || []).slice(-4);
              payload.changeLog.push({ changes: edits, changedAt: new Date(), changedBy: ctx.userEmail || 'Someone' });
            }

            ops.push(col.doc(existingMatch.id).update(payload));
            updatedCount++;
          } else {
            payload.createdBy = ctx.userEmail || '';
            payload.createdAt = serverNow();
            payload.changeLog = [{
              changes: [{ field: 'Activity created', from: '—', to: title }],
              changedAt: new Date(),
              changedBy: ctx.userEmail || 'Someone'
            }];
            ops.push(col.add(payload));
            createdCount++;
          }
        }

        if (!ops.length) {
          alert('No valid activity rows found in Excel file.');
          return;
        }

        await Promise.all(ops);
        alert('Import complete: ' + createdCount + ' created, ' + updatedCount + ' updated.' +
          (idxWbs === -1 ? ' Note: no WBS column was found, so every row was created as new rather than matched against existing entries.' : ''));
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
      var responsible =
        (dom.responsibleInput && dom.responsibleInput.value && dom.responsibleInput.value.trim()) ||
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
        responsible: responsible,
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

      // Log what actually changed (same shape the Gantt change-log uses)
      // so burndown/burnup — and the Gantt's "modified" indicator — have
      // real data regardless of whether an edit came from here or a drag.
      if (id) {
        var before = ctx.rows.find(function (r) { return r.id === id; });
        if (before) {
          // This form has no Start Date field of its own — startDate only
          // ever gets set by a Gantt drag or an import. But editing just
          // Due Date here, with no check against an existing startDate, is
          // exactly how an activity ends up with start after due (the
          // Gantt silently papers over an inverted range for display — the
          // underlying data is genuinely broken until this is caught).
          if (payload.dueDate && before.startDate) {
            var existingStartJs = window.drRag ? window.drRag.toJsDate(before.startDate) : new Date(before.startDate);
            if (existingStartJs && payload.dueDate < existingStartJs) {
              try {
                alert(
                  "Due date cannot be before this activity's start date (" +
                    (window.drDateFmt ? window.drDateFmt.date(existingStartJs) : existingStartJs.toDateString()) +
                    "). Reschedule the start date on the Engagement Timeline first, or choose a later due date."
                );
              } catch (_) {}
              return;
            }
          }

          var edits = [];
          if ((before.status || '') !== status) {
            edits.push({ field: 'Stage', from: before.status || 'not set', to: status });
          }
          if ((before.responsible || '') !== responsible) {
            edits.push({ field: 'Responsible', from: before.responsible || 'unassigned', to: responsible || 'unassigned' });
          }
          var beforeDueStr = fmtDate(before.dueDate) || 'not set';
          var afterDueStr = payload.dueDate ? fmtDate(payload.dueDate) : beforeDueStr;
          if (beforeDueStr !== afterDueStr) {
            edits.push({ field: 'Due date', from: beforeDueStr, to: afterDueStr });
          }
          if (edits.length) {
            payload.changeLog = (before.changeLog || []).slice(-4);
            payload.changeLog.push({ changes: edits, changedAt: new Date(), changedBy: ctx.userEmail || 'Someone' });
          }
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
        // A creation is itself a change worth surfacing in the Change
        // Report — without this, new activities show up on the Gantt but
        // never appear in the exportable change history.
        payload.changeLog = [{
          changes: [{ field: 'Activity created', from: '—', to: title }],
          changedAt: new Date(),
          changedBy: ctx.userEmail || 'Someone'
        }];

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
      if (dom.responsibleInput) dom.responsibleInput.value = '';
      if (dom.dateInput) dom.dateInput.value = '';
      if (dom.submitBtn) dom.submitBtn.textContent = 'Add Activity';
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
