// header.js — dashboard header wiring, expects bizKey + user passed in
// Uses: window.db (Firestore) and window.storage (Firebase Storage)
// DOM: #companyName, #companyLogo, .upload-logo-label, #logoFileInput

(function () {
  const TAG = '[header]';
  const OWNER_EMAIL = 'john@distinctrevelations.com';

  const L = (...a) => console.log(TAG, ...a);
  const W = (...a) => console.warn(TAG, ...a);
  const E = (...a) => console.error(TAG, ...a);

  function findHeaderEls() {
    const nameEl =
      document.getElementById('companyName') ||
      document.querySelector('[data-role="business-name"]');

    const logoImg =
      document.getElementById('companyLogo') ||
      document.getElementById('business-logo') ||
      document.getElementById('client-logo') ||
      document.querySelector('[data-role="business-logo"]');

    const uploadLabel =
      document.querySelector('.upload-logo-label') ||
      document.querySelector('[data-role="logo-upload-label"]');

    const fileInput =
      document.getElementById('logoFileInput') ||
      document.querySelector('[data-role="logo-file-input"]');

    const userEmailEl = document.getElementById('headerUserEmail');
    const logoutBtn = document.getElementById('headerLogoutBtn');

    L('DOM elements:', {
      hasNameEl: !!nameEl,
      hasLogoImg: !!logoImg,
      hasUploadLabel: !!uploadLabel,
      hasFileInput: !!fileInput,
      hasUserEmailEl: !!userEmailEl,
      hasLogoutBtn: !!logoutBtn,
    });

    return { nameEl, logoImg, uploadLabel, fileInput, userEmailEl, logoutBtn };
  }

  // Show who's signed in, and wire the Log Out button.
  function wireUserInfo(user, els, isOwner) {
    if (els.userEmailEl) {
      if (user && user.email) {
        var emailSpan = document.createElement('span');
        // Non-owner logins (members, Client PM, exec sponsor) get a red cue
        // on just the email — not the whole "Signed in as" label — so it's
        // always visually obvious which role you're viewing as.
        emailSpan.className = 'header-user-email-value' + (isOwner ? '' : ' non-owner');
        emailSpan.textContent = user.email;

        els.userEmailEl.textContent = 'Signed in as ';
        els.userEmailEl.appendChild(emailSpan);
      } else {
        els.userEmailEl.textContent = '';
      }
    }

    if (els.logoutBtn && !els.logoutBtn.__wired) {
      els.logoutBtn.__wired = true;
      els.logoutBtn.addEventListener('click', function () {
        const auth = window.auth || (window.firebase && window.firebase.auth && window.firebase.auth());
        if (!auth) { W('logout: auth not available'); return; }
        auth.signOut().then(function () {
          try {
            sessionStorage.removeItem('businessKey');
            localStorage.removeItem('businessKey');
          } catch (e) {}
          window.location.href = 'index.html';
        }).catch(function (err) {
          E('logout failed', err);
          alert('Could not log out. Please try again.');
        });
      });
    }
  }

  // Wire upload (owner only)
  function wireUpload(fileInput, bizKey, els) {
    if (!fileInput) {
      W('wireUpload: no fileInput');
      return;
    }
    if (!window.storage || !window.db) {
      E('wireUpload: storage or db missing');
      return;
    }
    if (fileInput.__headerUploadWired) return;
    fileInput.__headerUploadWired = true;

    fileInput.addEventListener('change', function (e) {
      const file = e.target.files && e.target.files[0];
      if (!file) {
        L('upload: no file selected');
        return;
      }

      L('upload: starting', {
        name: file.name,
        size: file.size,
        type: file.type,
      });

      const path = 'logos/' + bizKey + '/' + Date.now() + '_' + file.name;
      const ref = window.storage.ref().child(path);

      ref
        .put(file)
        .then((snap) => {
          L('upload: stored at', path);
          return snap.ref.getDownloadURL();
        })
        .then((url) => {
          L('upload: download URL', url);
          return window.db
            .collection('businesses')
            .doc(bizKey)
            .set({ logoUrl: url }, { merge: true })
            .then(() => {
              L('upload: Firestore logoUrl updated for', bizKey);
              if (els.logoImg) {
                els.logoImg.src = url;
                els.logoImg.style.display = 'inline-block';
              }
            });
        })
        .catch((err) => {
          E('upload: error', err);
          alert('There was an error uploading the logo. Check console for details.');
        })
        .finally(() => {
          fileInput.value = '';
        });
    });
  }

  // Load business doc and keep header in sync
  function bindBusinessDoc(bizKey, els) {
    if (!window.db) {
      E('bindBusinessDoc: db missing');
      return;
    }

    L('bindBusinessDoc: listening to businesses/' + bizKey);

    window.db
      .collection('businesses')
      .doc(bizKey)
      .onSnapshot(
        (doc) => {
          if (!doc.exists) {
            // IMPORTANT: still show at least the key as name
            W('business doc missing, using bizKey as display name:', bizKey);
            if (els.nameEl) {
              els.nameEl.textContent = bizKey;
              els.nameEl.style.display = 'block';
            }
            // No logo yet — will be filled in once created by upload or admin
            return;
          }

          const data = doc.data() || {};
          L('business snapshot:', data);

          const name =
            data.businessName ||
            data.name ||
            data.companyName ||
            bizKey;
          const logoUrl = data.logoUrl || '';

          if (els.nameEl) {
            els.nameEl.textContent = name;
            els.nameEl.style.display = 'block';
          }

          if (els.logoImg && logoUrl) {
            els.logoImg.src = logoUrl;
            els.logoImg.alt = name + ' Logo';
            els.logoImg.style.display = 'inline-block';
          }
        },
        (err) => {
          E('bindBusinessDoc: snapshot error', err);
        }
      );
  }

  // Main entry point: called from dash-loader with bizKey + user
  function initDashboardHeader(bizKey, user) {
    L('initDashboardHeader called', {
      bizKey,
      email: user && user.email,
    });

    if (!bizKey) {
      E('initDashboardHeader: no business key');
      return;
    }

    window.BIZ_KEY = bizKey; // make it globally visible for other scripts

    const els = findHeaderEls();
    const isOwner =
      user &&
      user.email &&
      user.email.toLowerCase().trim() === OWNER_EMAIL;

    // Toggle upload controls
    if (els.uploadLabel && els.fileInput) {
      els.uploadLabel.style.display = isOwner ? 'inline-flex' : 'none';
      els.fileInput.disabled = !isOwner;
      L('upload controls:', {
        isOwner,
        labelDisplay: els.uploadLabel.style.display,
        fileDisabled: els.fileInput.disabled,
      });

      if (isOwner) {
        wireUpload(els.fileInput, bizKey, els);
      }
    } else {
      L('no upload controls found (label/input)');
    }

    // Bind Firestore business doc → header (with fallback to bizKey)
    bindBusinessDoc(bizKey, els);

    wireUserInfo(user, els, isOwner);
  }

  // Expose to global so dash-loader can call it
  window.initDashboardHeader = initDashboardHeader;
  L('script loaded, initDashboardHeader exposed');
})();