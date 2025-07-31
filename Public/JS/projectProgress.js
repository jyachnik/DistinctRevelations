/// projectProgress.js
// Fully functional vertical progress bar with click-to-set & persistent save in Firestore

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";
import { db } from "./firebaseInit.js";

const OWNER_EMAIL = "john@distinctrevelations.com";

// Read ?business=... from URL
function getBusinessKey() {
  return new URLSearchParams(window.location.search).get("business");
}

// Initialize component after auth
onAuthStateChanged(getAuth(), async user => {
  if (!user) return;
  const businessKey = getBusinessKey();
  if (!businessKey) return;
  initProjectProgress(businessKey, user.email);
});

/**
 * Set up the vertical progress bar:
 * - Loads saved projectProgress from Firestore
 * - Owner-only: click on bar to set new percentage
 * - Updates Firestore and UI accordingly
 */
async function initProjectProgress(businessKey, userEmail) {
  const isOwner = (userEmail === OWNER_EMAIL);
  const container = document.getElementById("progress-bar-container");
  const fillElem = document.getElementById("progress-bar-fill");
  const labelElem = document.getElementById("progress-label");
  const businessRef = doc(db, "businesses", businessKey);

  // Load existing percentage
  let pct = 0;
  try {
    const snap = await getDoc(businessRef);
    if (snap.exists() && typeof snap.data().projectProgress === 'number') {
      pct = snap.data().projectProgress;
    }
  } catch (err) {
    console.error('Error loading projectProgress:', err);
  }
  // Initial UI update
  updateUI(pct);

  // Non-owner: disable interaction
  if (!isOwner) {
    container.style.cursor = 'default';
    return;
  }

  // Owner: clicking sets new percentage
  container.style.cursor = 'pointer';
  container.addEventListener('click', async e => {
    const rect = container.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    let newPct = Math.round(((rect.height - clickY) / rect.height) * 100);
    newPct = Math.max(0, Math.min(100, newPct));
    try {
      await updateDoc(businessRef, { projectProgress: newPct });
      console.log('Saved new projectProgress:', newPct);
      updateUI(newPct);
    } catch (err) {
      console.error('Error saving projectProgress:', err);
      alert('Failed to save progress. See console.');
    }
  });

  /**
   * Updates the bar height, label text, and label position
   * @param {number} value - percentage 0-100
   */
  function updateUI(value) {
    fillElem.style.height = value + '%';
    labelElem.textContent = value + '%';
    labelElem.style.bottom = value + '%';
  }
}
