// milestone.js

import { auth, db } from './firebaseInit.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';
import {
  collection,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

const OWNER_EMAIL = 'john@distinctrevelations.com';

// — DOM refs —
const formEl       = document.getElementById('milestoneForm');
const titleInput   = document.getElementById('milestoneTitle');
const statusSelect = document.getElementById('milestoneStatus');
const dateInput    = document.getElementById('milestoneDueDate');
const tableEl      = document.getElementById('milestoneTable');
const tbodyEl      = tableEl.querySelector('tbody');
const headerRow    = tableEl.querySelector('thead tr');

let businessKey = null;
let entries     = [];

// 1️⃣ Watch auth state
onAuthStateChanged(auth, async user => {
  if (!user) return;

  const isOwner = user.email === OWNER_EMAIL;

  // Show/hide Add form
  formEl.style.display = isOwner ? '' : 'none';

  // (Re)wire the form submit for the owner
  formEl.removeEventListener('submit', handleAddMilestone);
  if (isOwner) {
    formEl.addEventListener('submit', handleAddMilestone);
  }

  // Toggle .owner on table (CSS shows/hides .actions column)
  tableEl.classList.toggle('owner', isOwner);

  // Inject or remove <th class="actions"> in the header
  const thActions = headerRow.querySelector('th.actions');
  if (isOwner) {
    if (!thActions) {
      const th = document.createElement('th');
      th.classList.add('actions');
      th.textContent = 'Actions';
      headerRow.appendChild(th);
    }
  } else if (thActions) {
    thActions.remove();
  }

  // Get businessKey from URL
  businessKey = new URLSearchParams(window.location.search).get('business');
  if (!businessKey) {
    console.error('No business key in URL');
    return;
  }

  // Load and render
  await loadMilestones();
  renderMilestones();
});

// 2️⃣ Load from Firestore
async function loadMilestones() {
  try {
    const snap = await getDocs(
      collection(db, 'businesses', businessKey, 'milestones')
    );
    entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error('Error loading milestones:', err);
  }
}

// 3️⃣ Handle Add form submission
async function handleAddMilestone(evt) {
  evt.preventDefault();
  const title   = titleInput.value.trim();
  const status  = statusSelect.value;
  const dueDate = dateInput.value;  // YYYY-MM-DD

  if (!title || !status || !dueDate) return;

  try {
    await addDoc(
      collection(db, 'businesses', businessKey, 'milestones'),
      { title, status, dueDate, createdAt: serverTimestamp() }
    );
    formEl.reset();
    await loadMilestones();
    renderMilestones();
  } catch (err) {
    console.error('Error adding milestone:', err);
  }
}

// 4️⃣ Render the table rows
function renderMilestones() {
  tbodyEl.innerHTML = '';
  const isOwner = tableEl.classList.contains('owner');

  entries.forEach(entry => {
    const tr = document.createElement('tr');

    // Title
    const tdTitle = document.createElement('td');
    tdTitle.textContent = entry.title;
    tr.appendChild(tdTitle);

    // Status
    const tdStatus = document.createElement('td');
    tdStatus.textContent = entry.status;
    tr.appendChild(tdStatus);

    // Due Date (MM/DD/YYYY)
    const tdDate = document.createElement('td');
    tdDate.style.whiteSpace = 'nowrap';
    const [y, m, d] = entry.dueDate.split('-');
    tdDate.textContent = `${m.padStart(2,'0')}/${d.padStart(2,'0')}/${y}`;
    tr.appendChild(tdDate);

    // Actions cell
    const tdAct = document.createElement('td');
    tdAct.classList.add('actions');
    if (isOwner) {
      // Edit button
      const editBtn = document.createElement('button');
      editBtn.className   = 'edit-btn';
      editBtn.title       = 'Edit';
      editBtn.textContent = '✎';
      editBtn.onclick     = () => startEdit(entry);
      tdAct.appendChild(editBtn);

      // Delete button
      const delBtn = document.createElement('button');
      delBtn.className   = 'delete-btn';
      delBtn.title       = 'Delete';
      delBtn.textContent = '🗑';
      delBtn.onclick     = () => confirmDelete(entry.id);
      tdAct.appendChild(delBtn);
    }
    tr.appendChild(tdAct);

    tbodyEl.appendChild(tr);
  });
}

// 5️⃣ Inline edit via prompt()
async function startEdit(entry) {
  const newTitle  = prompt('Edit Title:', entry.title);
  if (newTitle === null) return;
  const newStatus = prompt('Edit Status:', entry.status);
  if (newStatus === null) return;
  const newDate   = prompt('Edit Date (YYYY-MM-DD):', entry.dueDate);
  if (newDate === null) return;

  try {
    await updateDoc(
      doc(db, 'businesses', businessKey, 'milestones', entry.id),
      { title: newTitle, status: newStatus, dueDate: newDate }
    );
    await loadMilestones();
    renderMilestones();
  } catch (err) {
    console.error('Error saving edits:', err);
  }
}

// 6️⃣ Confirm & delete
async function confirmDelete(id) {
  if (!confirm('Delete this milestone?')) return;
  try {
    await deleteDoc(
      doc(db, 'businesses', businessKey, 'milestones', id)
    );
    await loadMilestones();
    renderMilestones();
  } catch (err) {
    console.error('Error deleting milestone:', err);
  }
}