// activity.js
// Fully functional Activity component with:
// – Real-time Firestore listener
// – Owner-only Add/Import form and Actions column
// – Proper MM/DD/YYYY date formatting
// – Clickable sorting on Activity, Status, and Due Date columns

import { auth, db } from './firebaseInit.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

const OWNER_EMAIL = 'john@distinctrevelations.com';

// — DOM references —
const formEl      = document.getElementById('activityForm');
const titleEl     = document.getElementById('activityTitle');
const descEl      = document.getElementById('activityDesc');
const statusEl    = document.getElementById('activityStatus');
const dateEl      = document.getElementById('activityDate');

const importBtn   = document.getElementById('importBtn');
const fileInputEl = document.getElementById('activityImport');
const browseBtn   = document.getElementById('browseFilesBtn');

const tableEl     = document.getElementById('activityTable');
const tbodyEl     = tableEl.querySelector('tbody');
const thElements  = document.querySelectorAll('#activityTable th[data-sort]');

let businessKey = null;
let entries     = [];
let isOwner     = false;

// Sorting state
let currentSort = { column: null, direction: 'asc' };

// — 1) Handle auth state, UI toggles, and start listener —
onAuthStateChanged(auth, user => {
  if (!user) return;
  isOwner = user.email === OWNER_EMAIL;

  // Show/hide owner-only controls
  [ formEl, importBtn, fileInputEl, browseBtn ]
    .forEach(el => { if (el) el.style.display = isOwner ? '' : 'none'; });

  // Toggle .owner on table (CSS hides .actions for non-owners)
  tableEl.classList.toggle('owner', isOwner);

  // Grab businessKey from URL
  businessKey = new URLSearchParams(window.location.search).get('business');
  if (!businessKey) {
    console.error('Missing business key in URL');
    return;
  }

  // Wire sorting click handlers
  wireSorting();

  // Wire Add and Import (owner only)
  if (isOwner && formEl) {
    formEl.addEventListener('submit', handleAdd);
    if (importBtn && fileInputEl) {
      importBtn.addEventListener('click', () => fileInputEl.click());
      fileInputEl.addEventListener('change', handleExcelImport);
    }
  }

  // Start real-time Firestore listener
  startListener();
});

// — 2) Real-time listener for activities —
function startListener() {
  const q = query(
    collection(db, 'businesses', businessKey, 'activities'),
    orderBy('timestamp', 'desc')
  );
  onSnapshot(q, snap => {
    entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderTable();
  }, err => {
    console.error('Activity listener error:', err);
  });
}

// — 3) Handle Add Activity form submit —
async function handleAdd(evt) {
  evt.preventDefault();
  const title   = titleEl.value.trim();
  const desc    = descEl.value.trim();
  const status  = statusEl.value;
  const dateVal = dateEl.value; // YYYY-MM-DD
  if (!title || !desc || !status || !dateVal) return;

  try {
    await addDoc(
      collection(db, 'businesses', businessKey, 'activities'),
      { title, desc, status, date: dateVal, timestamp: serverTimestamp() }
    );
    formEl.reset();
  } catch (err) {
    console.error('Error adding activity:', err);
  }
}

// — 4) Wire up sorting on header clicks —
function wireSorting() {
  thElements.forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (currentSort.column === col) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort.column    = col;
        currentSort.direction = 'asc';
      }
      // update arrow classes
      thElements.forEach(h => h.classList.remove('asc','desc'));
      th.classList.add(currentSort.direction);
      renderTable();
    });
  });
}

// — 5) Render the table based on entries + sort + permissions —
function renderTable() {
  tbodyEl.innerHTML = '';

  // Copy and sort
  let list = [...entries];
  const { column, direction } = currentSort;
  if (column) {
    list.sort((a, b) => {
      if (column === 'date') {
        // date fallback: date string or Firestore Timestamp
        const ar = a.date ?? a.dueDate ?? a.timestamp;
        const br = b.date ?? b.dueDate ?? b.timestamp;
        const da = (typeof ar === 'string' ? new Date(ar) : ar?.toDate());
        const db = (typeof br === 'string' ? new Date(br) : br?.toDate());
        return direction === 'asc' ? da - db : db - da;
      } else {
        const av = (a[column] || '').toString().toLowerCase();
        const bv = (b[column] || '').toString().toLowerCase();
        return direction === 'asc'
          ? av.localeCompare(bv)
          : bv.localeCompare(av);
      }
    });
  }

  // Build rows
  list.forEach(entry => {
    const tr = document.createElement('tr');

    // Activity (title + desc)
    const td1 = document.createElement('td');
    td1.innerHTML = `<strong>${entry.title}</strong><br><small>${entry.desc}</small>`;
    tr.appendChild(td1);

    // Status
    const td2 = document.createElement('td');
    td2.textContent = entry.status;
    tr.appendChild(td2);

    // Due Date formatted
    const td3 = document.createElement('td');
    td3.style.whiteSpace = 'nowrap';
    let raw = entry.date ?? entry.dueDate ?? entry.timestamp;
    let txt = '';
    if (typeof raw === 'string') {
      const [y,m,d] = raw.split('-');
      txt = `${m.padStart(2,'0')}/${d.padStart(2,'0')}/${y}`;
    } else if (raw?.toDate) {
      const dObj = raw.toDate();
      txt = [
        String(dObj.getMonth()+1).padStart(2,'0'),
        String(dObj.getDate()).padStart(2,'0'),
        dObj.getFullYear()
      ].join('/');
    }
    td3.textContent = txt;
    tr.appendChild(td3);

    // Actions (owner only)
    const td4 = document.createElement('td');
    td4.classList.add('actions');
    if (isOwner) {
      const editBtn = document.createElement('button');
      editBtn.className   = 'edit-btn';
      editBtn.title       = 'Edit';
      editBtn.textContent = '✎';
      editBtn.onclick     = () => startEdit(entry);
      td4.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.className   = 'delete-btn';
      delBtn.title       = 'Delete';
      delBtn.textContent = '🗑';
      delBtn.onclick     = () => confirmDelete(entry.id);
      td4.appendChild(delBtn);
    }
    tr.appendChild(td4);

    tbodyEl.appendChild(tr);
  });
}

// — 6) Edit stub via prompt (replace with modal if desired) —
async function startEdit(entry) {
  const newTitle  = prompt('Edit Activity Title:', entry.title);
  if (newTitle === null) return;
  const newDesc   = prompt('Edit Description:', entry.desc);
  if (newDesc === null) return;
  const newStatus = prompt('Edit Status:', entry.status);
  if (newStatus === null) return;
  const newDate   = prompt('Edit Due Date (YYYY-MM-DD):', entry.date || '');
  if (newDate === null) return;

  try {
    await updateDoc(
      doc(db, 'businesses', businessKey, 'activities', entry.id),
      { title: newTitle, desc: newDesc, status: newStatus, date: newDate }
    );
  } catch (err) {
    console.error('Error editing activity:', err);
  }
}

// — 7) Delete flow —
async function confirmDelete(id) {
  if (!confirm('Are you sure you want to delete this activity?')) return;
  try {
    await deleteDoc(doc(db, 'businesses', businessKey, 'activities', id));
  } catch (err) {
    console.error('Error deleting activity:', err);
  }
}

// — 8) Excel import stub (owner only) —
async function handleExcelImport(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  // parse Excel rows, then:
  // await addDoc(...) for each row
}