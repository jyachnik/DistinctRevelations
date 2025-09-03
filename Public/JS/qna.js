// /Public/JS/qna.js
// Fully functional Q&A module using Firebase **compat** (window.auth, window.db).
// Keeps original behavior and UI wiring, but now waits for the business key,
// guards DOM lookups, and enforces permissions (owner or assignee can edit/complete/delete).

/* ---------------- Firebase (compat) ---------------- */
const { auth, db } = window; // provided by firebaseInit.js (compat)
const OWNER_EMAIL = 'john@distinctrevelations.com';

/* ---------------- Business key sync ---------------- */
function getBizKeyImmediate() {
  return new URL(location.href).searchParams.get('business') || window.BIZ_KEY || null;
}
function onBizReady(cb) {
  const k = getBizKeyImmediate();
  if (k) return cb(k);
  // dashboard-business-loader.js dispatches this when it resolves the key
  window.addEventListener('business:ready', (e) => cb(e.detail.businessKey), { once: true });
}

/* ---------------- DOM refs (original ids) ---------------- */
const formEl         = document.getElementById('qnaForm');
const msgEl          = document.getElementById('qnaMessage');
const typeEl         = document.getElementById('qnaType');
const assignFormEl   = document.getElementById('qnaAssignedTo');
const filterDoneEl   = document.getElementById('filterDone');
const filterTypeEl   = document.getElementById('filterType');       // filter dropdown
const filterAssignEl = document.getElementById('filterAssignedTo');
const tableBodyEl    = document.getElementById('qnaTableBody');

// Stats
const openQnEl = document.getElementById('openQuestionsCount');
const openTkEl = document.getElementById('openTasksCount');

// Modals / actions
const saveEditBtn      = document.getElementById('saveEditBtn');
const confirmDeleteBtn = document.getElementById('confirmDelete');

/* ---------------- State ---------------- */
let businessKey = null;
let userEmail   = null;
let entries     = [];
let currentSort = { column: null, direction: 'desc' };
let editingId   = null;
let deletingId  = null;
let unsub       = null;

/* ---------------- Utilities ---------------- */
function safeText(v) { return (v ?? '').toString(); }
function mmddyyyy(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}
function canModify(entry) {
  return userEmail === OWNER_EMAIL || userEmail === entry.assignedTo;
}

/* ---------------- Data (compat) ---------------- */
function qnaColl() {
  return db.collection('businesses').doc(businessKey).collection('qna');
}

async function loadAssignDropdowns() {
  if (!assignFormEl || !filterAssignEl) return;
  try {
    const snap = await db.collection('businesses').doc(businessKey).collection('users').get();
    const emails = [...new Set(snap.docs.map(d => d.data()?.email).filter(Boolean))];
    if (!emails.includes(OWNER_EMAIL)) emails.unshift(OWNER_EMAIL);

    assignFormEl.innerHTML   = '<option value="">Assign To</option>';
    filterAssignEl.innerHTML = '<option value="">Filter by Assigned</option>';
    for (const e of emails) {
      assignFormEl.innerHTML   += `<option value="${e}">${e}</option>`;
      filterAssignEl.innerHTML += `<option value="${e}">${e}</option>`;
    }
  } catch (e) {
    console.warn('QnA: failed to load assigned users', e);
  }
}

function populateTypeFilter() {
  if (!filterTypeEl) return;
  const types = ['question', 'task', 'note'];
  filterTypeEl.innerHTML = '<option value="">Filter by Type</option>';
  types.forEach(t => filterTypeEl.innerHTML += `<option value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`);
}

function startListener() {
  if (!tableBodyEl) return;
  if (typeof unsub === 'function') unsub();

  unsub = qnaColl().orderBy('timestamp', 'desc').onSnapshot(
    (snap) => {
      entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Stats
      let qCount = 0, tCount = 0;
      for (const e of entries) {
        if (!e.completed) {
          if (e.type === 'question') qCount++;
          else if (e.type === 'task') tCount++;
        }
      }
      if (openQnEl) openQnEl.textContent = qCount;
      if (openTkEl) openTkEl.textContent = tCount;

      renderTable();
    },
    (err) => console.error('QnA snapshot error', err)
  );
}

/* ---------------- UI Wiring ---------------- */
function wireForm() {
  if (!formEl || formEl.dataset.bound === '1') return;
  formEl.dataset.bound = '1';
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!msgEl || !typeEl || !assignFormEl) return;

    const message    = msgEl.value.trim();
    const type       = typeEl.value;
    const assignedTo = assignFormEl.value;
    if (!message || !type || !assignedTo) return;

    try {
      await qnaColl().add({
        message,
        type,
        assignedTo,
        completed: false,
        createdBy: userEmail,
        businessKey,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      });
      formEl.reset();
    } catch (err) {
      console.error('Add QnA failed', err);
    }
  });
}

function wireFiltersAndSorting() {
  filterDoneEl   && filterDoneEl  .addEventListener('change', renderTable);
  filterTypeEl   && filterTypeEl  .addEventListener('change', renderTable);
  filterAssignEl && filterAssignEl.addEventListener('change', renderTable);

  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.sort; // 'type' | 'message' | 'assignedTo' | 'timestamp'
      if (currentSort.column === col) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort.column = col;
        currentSort.direction = 'asc';
      }
      document.querySelectorAll('th[data-sort]').forEach(h => h.classList.remove('asc', 'desc'));
      th.classList.add(currentSort.direction);
      renderTable();
    });
  });
}

function wireModals() {
  // Close edit modal
  document.querySelectorAll('#editModal #cancelEditBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = document.getElementById('editModal');
      m && m.classList.add('hidden');
    });
  });
  saveEditBtn && saveEditBtn.addEventListener('click', saveEdit);

  // Close delete modal
  document.querySelectorAll('#deleteConfirmModal #cancelDelete').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = document.getElementById('deleteConfirmModal');
      m && m.classList.add('hidden');
    });
  });
  confirmDeleteBtn && confirmDeleteBtn.addEventListener('click', confirmDelete);
}

/* ---------------- Rendering ---------------- */
function renderTable() {
  const tbody = tableBodyEl;
  if (!tbody) return;

  tbody.innerHTML = '';

  const doneFilter   = (filterDoneEl?.value || '').trim();
  const typeFilter   = (filterTypeEl?.value || '').trim().toLowerCase();
  const assignFilter = (filterAssignEl?.value || '').trim();

  let list = entries.filter(e => {
    if (doneFilter === 'done'    && !e.completed) return false;
    if (doneFilter === 'notDone' &&  e.completed) return false;
    if (typeFilter && String(e.type || '').toLowerCase() !== typeFilter) return false;
    if (assignFilter && String(e.assignedTo || '') !== assignFilter) return false;
    return true;
  });

  if (currentSort.column) {
    const col = currentSort.column;
    const dir = currentSort.direction;
    list.sort((a, b) => {
      if (col === 'timestamp') {
        const av = a.timestamp?.toDate()?.getTime() || 0;
        const bv = b.timestamp?.toDate()?.getTime() || 0;
        return dir === 'asc' ? av - bv : bv - av;
      }
      const av = safeText(a[col]).toLowerCase();
      const bv = safeText(b[col]).toLowerCase();
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }

  for (const e of list) {
    const tr = document.createElement('tr');
    if (e.completed) tr.classList.add('completed');

    // Type / Message / Assigned
    const tdType = document.createElement('td');      tdType.textContent = e.type || '';
    const tdMsg  = document.createElement('td');      tdMsg.textContent  = e.message || '';
    const tdAsg  = document.createElement('td');      tdAsg.textContent  = e.assignedTo || '';
    tr.appendChild(tdType); tr.appendChild(tdMsg); tr.appendChild(tdAsg);

    // Date
    const tdDate = document.createElement('td');
    tdDate.textContent = mmddyyyy(e.timestamp);
    tdDate.style.whiteSpace = 'nowrap';
    tr.appendChild(tdDate);

    // Done (only owner or assignee can toggle)
    const tdDone = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!e.completed;
    cb.disabled = !canModify(e);
    cb.addEventListener('change', async (ev) => {
      try {
        await qnaColl().doc(e.id).update({ completed: ev.target.checked });
        tr.classList.toggle('completed', ev.target.checked);
      } catch (err) {
        console.error('Toggle completed failed', err);
        ev.target.checked = !ev.target.checked; // revert
      }
    });
    tdDone.appendChild(cb);
    tr.appendChild(tdDone);

    // Actions (edit/delete)
    const tdAct = document.createElement('td');
    tdAct.style.textAlign = 'center';
    if (canModify(e)) {
      const editBtn = document.createElement('button');
      editBtn.className = 'edit-btn';
      editBtn.title = 'Edit';
      editBtn.textContent = '✎';
      editBtn.addEventListener('click', () => {
        const modal = document.getElementById('editModal');
        const input = document.getElementById('editMessage');
        if (modal && input) {
          input.value = e.message || '';
          modal.classList.remove('hidden');
          editingId = e.id;
        }
      });
      tdAct.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'delete-btn';
      delBtn.title = 'Delete';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', () => {
        const modal = document.getElementById('deleteConfirmModal');
        if (modal) {
          modal.classList.remove('hidden');
          deletingId = e.id;
        } else if (confirm('Delete this Q&A?')) {
          confirmDelete();
        }
      });
      tdAct.appendChild(delBtn);
    }
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  }
}

/* ---------------- Edit / Delete ---------------- */
async function saveEdit() {
  const input = document.getElementById('editMessage');
  if (!input) return;
  const newMsg = input.value.trim();
  if (!newMsg || !editingId) return;
  try {
    await qnaColl().doc(editingId).update({ message: newMsg });
  } catch (err) {
    console.error('Save edit failed', err);
  } finally {
    const m = document.getElementById('editModal');
    m && m.classList.add('hidden');
    editingId = null;
  }
}

async function confirmDelete() {
  if (!deletingId) return;
  try {
    await qnaColl().doc(deletingId).delete();
  } catch (err) {
    console.error('Delete failed', err);
  } finally {
    const m = document.getElementById('deleteConfirmModal');
    m && m.classList.add('hidden');
    deletingId = null;
  }
}

/* ---------------- Boot ---------------- */
(function init() {
  // If the QnA section isn't on this page, skip quietly
  const hasUI = formEl || tableBodyEl;
  if (!hasUI) return;

  populateTypeFilter();
  wireFiltersAndSorting();
  wireModals();

  onBizReady((biz) => {
    businessKey = biz;

    if (!auth || typeof auth.onAuthStateChanged !== 'function') {
      console.warn('QnA: auth not available; continuing read-only');
      startListener();
      return;
    }

    auth.onAuthStateChanged((user) => {
      if (!user) return;
      userEmail = (user.email || '').toLowerCase();

      // Everyone can read; only owner/assignee can modify (UI + rules)
      startListener();
      loadAssignDropdowns();
      wireForm();
    });
  });

  window.addEventListener('beforeunload', () => {
    if (typeof unsub === 'function') unsub();
  });
})();