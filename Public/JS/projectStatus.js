// projectStatus.js
// Requires firebaseInit.js which exports { auth, db }

import { auth, db } from '../firebaseInit.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';
import {
  doc,
  onSnapshot,
  setDoc
} from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

const OWNER_EMAIL = 'john@distinctrevelations.com';

export function initProjectStatus(businessKey) {
  let userEmail = null;

  const statusDoc = doc(db, 'businesses', businessKey, 'settings', 'projectStatus');
  const container = document.querySelector('.project-status');
  const lights    = container.querySelectorAll('.light');

  function highlight(status) {
    lights.forEach(light => {
      if (light.dataset.status === status) light.classList.add('selected');
      else light.classList.remove('selected');
    });
  }

  onAuthStateChanged(auth, user => {
    if (!user) return;
    userEmail = user.email;

    // Enable clicks only for owner
    if (userEmail === OWNER_EMAIL) {
      lights.forEach(light => {
        light.style.cursor = 'pointer';
        light.addEventListener('click', async () => {
          const newStatus = light.dataset.status;
          try {
            await setDoc(statusDoc, { status: newStatus }, { merge: true });
          } catch (e) {
            console.error('Failed to save project status', e);
          }
        });
      });
    }
  });

  // Listen for changes (owner & non-owner both see updates)
  onSnapshot(statusDoc, snap => {
    if (snap.exists()) {
      const { status } = snap.data();
      highlight(status);
    }
  }, err => console.error('ProjectStatus listener error', err));
}