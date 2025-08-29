// qna.js
import { auth, db } from '../firebaseInit.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

const OWNER_EMAIL = 'john@distinctrevelations.com';

// — DOM refs —
const formEl         = document.getElementById('qnaForm');
const msgEl          = document.getElementById('qnaMessage');
const typeEl         = document.getElementById('qnaType');
const assignFormEl   = document.getElementById('qnaAssignedTo');
const filterDoneEl   = document.getElementById('filterDone');
const filterTypeEl   = document.getElementById('filterType');    // now points to the FILTER dropdown :contentReference[oaicite:3]{index=3}
const filterAssignEl = document.getElementById('filterAssignedTo');
const tableBodyEl    = document.getElementById('qnaTableBody');

// Stats elements
const openQnEl = document.getElementById('openQuestionsCount');
const openTkEl = document.getElementById('openTasksCount');

// Modal buttons
const saveEditBtn      = document.getElementById('saveEditBtn');
const confirmDeleteBtn = document.getElementById('confirmDelete');

let businessKey = null;
let userEmail   = null;
let entries     = [];
let currentSort = { column: null, direction: 'desc' };
let editingId   = null;
let deletingId  = null;

// — Auth & initialization —
onAuthStateChanged(auth, async user => {
  if (!user) return;
  userEmail = user.email;
  businessKey = new URLSearchParams(location.search).get('business');
  if (!businessKey) return console.error('No business key in URL');

  await loadAssignDropdowns();
  populateTypeFilter();                                       // populate filterTypeEl
  startListener();
  wireForm();
  wireFiltersAndSorting();
  wireModals();
});

// — Populate “Assign To” dropdowns —
async function loadAssignDropdowns() {
  const snap   = await getDocs(collection(db, 'businesses', businessKey, 'users'));
  const emails = [...new Set(snap.docs.map(d=>d.data().email).filter(Boolean))];
  if (!emails.includes(OWNER_EMAIL)) emails.unshift(OWNER_EMAIL);

  assignFormEl.innerHTML   = '<option value="">Assign To</option>';
  filterAssignEl.innerHTML = '<option value="">Filter by Assigned</option>';
  for (const e of emails) {
    assignFormEl.innerHTML   += `<option value="${e}">${e}</option>`;
    filterAssignEl.innerHTML += `<option value="${e}">${e}</option>`;
  }
}

// — Populate “Filter by Type” dropdown to match your stored e.type values —
function populateTypeFilter() {
  const types = ['question','task','note'];
  filterTypeEl.innerHTML = '<option value="">Filter by Type</option>';
  types.forEach(t => {
    filterTypeEl.innerHTML += `<option value="${t}">${t[0].toUpperCase()+t.slice(1)}</option>`;
  });
}

// — Real-time listener + stats update —
function startListener() {
  const q = query(
    collection(db, 'businesses', businessKey, 'qna'),
    orderBy('timestamp','desc')
  );
  onSnapshot(q, snap => {
    entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // update stats
    let qCount=0, tCount=0;
    entries.forEach(e => {
      if (!e.completed) {
        if (e.type==='question') qCount++;
        else if (e.type==='task') tCount++;
      }
    });
    openQnEl.textContent = qCount;
    openTkEl.textContent = tCount;

    renderTable();
  }, err => console.error('QnA snapshot error', err));
}

// — Wire “Add” form —
function wireForm() {
  formEl.addEventListener('submit', async e => {
    e.preventDefault();
    const message    = msgEl.value.trim();
    const type       = typeEl.value;
    const assignedTo = assignFormEl.value;
    if (!message || !type || !assignedTo) return;
    await addDoc(
      collection(db, 'businesses', businessKey, 'qna'),
      { message, type, assignedTo, completed: false, createdBy: userEmail, timestamp: serverTimestamp() }
    );
    formEl.reset();
  });
}

// — Filters & Sorting —
function wireFiltersAndSorting() {
  filterDoneEl  .addEventListener('change', renderTable);
  filterTypeEl  .addEventListener('change', renderTable);
  filterAssignEl.addEventListener('change', renderTable);

  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (currentSort.column===col) {
        currentSort.direction = currentSort.direction==='asc' ? 'desc' : 'asc';
      } else {
        currentSort.column    = col;
        currentSort.direction = 'asc';
      }
      document.querySelectorAll('th[data-sort]').forEach(h=>h.classList.remove('asc','desc'));
      th.classList.add(currentSort.direction);
      renderTable();
    });
  });
}

// — Modal wiring (fixes Cancel buttons) —
function wireModals() {
  // Edit modal – header × and footer Cancel
  document.querySelectorAll('#editModal #cancelEditBtn')
    .forEach(btn => btn.addEventListener('click', () => {
      document.getElementById('editModal').classList.add('hidden');
    }));
  saveEditBtn.addEventListener('click', saveEdit);

  // Delete modal – header × and footer Cancel
  document.querySelectorAll('#deleteConfirmModal #cancelDelete')
    .forEach(btn => btn.addEventListener('click', () => {
      document.getElementById('deleteConfirmModal').classList.add('hidden');
    }));
  confirmDeleteBtn.addEventListener('click', confirmDelete);
}

// — Render table with filters, sorting & permissions —
function renderTable() {
  const tbody = tableBodyEl;
  tbody.innerHTML = '';

  const fv = filterTypeEl.value.trim().toLowerCase();         // normalized filter
  let list = entries
    .filter(e => {
      if (filterDoneEl.value==='done'   && !e.completed) return false;
      if (filterDoneEl.value==='notDone'&&   e.completed) return false;
      if (fv && e.type.toLowerCase()!==fv) return false;        // case-insensitive compare
      if (filterAssignEl.value && e.assignedTo!==filterAssignEl.value) return false;
      return true;
    })
    .sort((a,b) => {
      if (!currentSort.column) return 0;
      let av = a[currentSort.column], bv = b[currentSort.column];
      if (currentSort.column==='timestamp') {
        av = av.toDate().getTime(); bv = bv.toDate().getTime();
        return currentSort.direction==='asc' ? av-bv : bv-av;
      }
      av = (av||'').toString().toLowerCase();
      bv = (bv||'').toString().toLowerCase();
      return currentSort.direction==='asc'
        ? av.localeCompare(bv)
        : bv.localeCompare(av);
    });

  for (const e of list) {
    const tr = document.createElement('tr');
    if (e.completed) tr.classList.add('completed');

    // Type / Message / Assigned
    ['type','message','assignedTo'].forEach(field => {
      const td = document.createElement('td');
      td.textContent = e[field]||'';
      tr.appendChild(td);
    });

    // Date (MM/DD/YYYY)
    const tdDate = document.createElement('td');
    const dt = e.timestamp?.toDate();
    tdDate.textContent = dt
      ? `${String(dt.getMonth()+1).padStart(2,'0')}/`+
        `${String(dt.getDate()).padStart(2,'0')}/`+
        `${dt.getFullYear()}`
      : '';
    tdDate.style.whiteSpace = 'nowrap';
    tr.appendChild(tdDate);

    // Done checkbox
    const tdDone = document.createElement('td');
    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = e.completed;
    cb.disabled = !(userEmail===OWNER_EMAIL||userEmail===e.assignedTo);
    cb.addEventListener('change', async ev => {
      await updateDoc(
        doc(db,'businesses',businessKey,'qna',e.id),
        { completed: ev.target.checked }
      );
      tr.classList.toggle('completed', ev.target.checked);
    });
    tdDone.appendChild(cb);
    tr.appendChild(tdDone);

    // Actions (owner or assigned user only)
    const tdAct = document.createElement('td');
    tdAct.style.textAlign = 'center';
    if (userEmail===OWNER_EMAIL||userEmail===e.assignedTo) {
      const editBtn = document.createElement('button');
      editBtn.className   = 'edit-btn';
      editBtn.textContent = '✎';
      editBtn.addEventListener('click', () => {
        document.getElementById('editModal').classList.remove('hidden');
        msgEl.value   = e.message;
        editingId     = e.id;
      });
      tdAct.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.className   = 'delete-btn';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', () => {
        document.getElementById('deleteConfirmModal').classList.remove('hidden');
        deletingId = e.id;
      });
      tdAct.appendChild(delBtn);
    }
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  }
}

// — Save edits from Edit Modal —
async function saveEdit() {
  const newMsg = document.getElementById('editMessage').value.trim();
  if (!newMsg) return;
  await updateDoc(
    doc(db,'businesses',businessKey,'qna',editingId),
    { message: newMsg }
  );
  document.getElementById('editModal').classList.add('hidden');
}

// — Confirm & perform delete —
async function confirmDelete() {
  await deleteDoc(
    doc(db,'businesses',businessKey,'qna',deletingId)
  );
  document.getElementById('deleteConfirmModal').classList.add('hidden');
}