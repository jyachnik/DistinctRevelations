// /Public/select-business.js
const { auth, db } = window;
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

export async function showBusinessModalForOwner(user) {
  if (!user?.email || user.email.toLowerCase() !== 'john@distinctrevelations.com') return;

  const modal     = document.getElementById('businessSelectModal');
  const dropdown  = document.getElementById('businessDropdown');
  const selectBtn = document.getElementById('selectBusinessBtn');
  const closeEls  = modal?.querySelectorAll('[data-close="businessSelectModal"]') || [];

  if (!modal || !dropdown || !selectBtn) {
    console.warn('Admin modal elements missing');
    return;
  }

  // open modal
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('no-scroll');

  // loading state
  dropdown.innerHTML = '<option disabled selected>Loading…</option>';
  selectBtn.disabled = true;

  try {
    const snap = await getDocs(collection(db, 'businesses'));
    dropdown.innerHTML = ''; // clear

    if (snap.empty) {
      dropdown.innerHTML = '<option disabled selected>No companies found</option>';
      selectBtn.disabled = true;
    } else {
      snap.forEach(docSnap => {
        const id   = docSnap.id;
        const name = docSnap.data()?.name || id;
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = name;
        dropdown.appendChild(opt);
      });
      selectBtn.disabled = false;
    }
  } catch (e) {
    console.error('Failed to load businesses:', e);
    dropdown.innerHTML = '<option disabled selected>Error loading companies</option>';
    selectBtn.disabled = true;
  }

  // handlers
  const close = () => {
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('no-scroll');
  };
  closeEls.forEach(btn => btn.addEventListener('click', close, { once: true }));

  selectBtn.onclick = () => {
    const bizKey = dropdown.value;
    if (!bizKey) return;
    close();
    window.location.href = `dashboard.html?business=${encodeURIComponent(bizKey)}&admin=1`;
  };
}

// expose globally so login.js can call it safely
window.showBusinessModalForOwner = showBusinessModalForOwner;