// select-business.js
import { db } from './firebaseInit.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

export async function showBusinessModalForOwner(user) {
  const email = user.email;
  if (email !== 'john@distinctrevelations.com') return;

  console.log('👑 Owner logged in — loading business list');
  const modal    = document.getElementById('businessSelectModal');
  const dropdown = document.getElementById('businessDropdown');
  const selectBtn= document.getElementById('selectBusinessBtn');
  const closeBtn = document.getElementById('closeBusinessModal');

  // Clear any existing options
  dropdown.innerHTML = '';

  try {
    const snap = await getDocs(collection(db, 'businesses'));
    console.log('📦 Businesses found:', snap.size);

    if (snap.empty) {
      dropdown.innerHTML = '<option disabled>No businesses available</option>';
    } else {
      snap.forEach(docSnap => {
        const opt = document.createElement('option');
        opt.value       = docSnap.id;
        opt.textContent = docSnap.data().name || docSnap.id;
        dropdown.appendChild(opt);
      });
    }

    // Show the modal
    modal.classList.remove('hidden');

    // Close handler
    closeBtn.onclick = () => modal.classList.add('hidden');

    // Select handler
    selectBtn.onclick = () => {
      const bizKey = dropdown.value;
      if (bizKey) {
        window.location.href = `dashboard.html?business=${bizKey}`;
      }
    };
  } catch (err) {
    console.error('❌ Failed to load businesses:', err);
  }
}

// Attach to window so login.js can call it:
window.showBusinessModalForOwner = showBusinessModalForOwner;