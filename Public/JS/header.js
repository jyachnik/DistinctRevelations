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
    const projectNameEl = document.getElementById('headerProjectName');

    // A second, more discoverable "Upload Logo" trigger inside the Data
    // Imports modal — same underlying #logoFileInput/upload flow, not a
    // separate upload path, so it can only ever show what the header
    // shows (see wireExtraLogoPreviews/bindBusinessDoc below).
    const extraLogoImgs = document.querySelectorAll('#dataImportsLogoPreview');
    const extraUploadBtn = document.getElementById('dataImportsUploadLogoBtn');

    L('DOM elements:', {
      hasNameEl: !!nameEl,
      hasLogoImg: !!logoImg,
      hasUploadLabel: !!uploadLabel,
      hasFileInput: !!fileInput,
      hasUserEmailEl: !!userEmailEl,
      hasLogoutBtn: !!logoutBtn,
    });

    return { nameEl, logoImg, uploadLabel, fileInput, userEmailEl, logoutBtn, extraLogoImgs, extraUploadBtn, projectNameEl };
  }

  // The Data Imports modal's "Upload Logo" button has no upload logic of
  // its own — it just clicks the SAME hidden #logoFileInput that
  // wireUpload() below already handles, so there's exactly one upload
  // code path regardless of how many places can trigger it.
  function wireExtraUploadTrigger(fileInput, extraUploadBtn) {
    if (!fileInput || !extraUploadBtn || extraUploadBtn.__wired) return;
    extraUploadBtn.__wired = true;
    extraUploadBtn.addEventListener('click', function () { fileInput.click(); });
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
        // If a Permissions popup save is still in flight in THIS tab, wait
        // for it — logging out navigates this tab away, which would abort
        // the write mid-request even though the popup already reported
        // "Saved ✓" (the popup's own close-guard only protects against
        // closing itself mid-save, not a logout click over here).
        const pendingSaves = window.drPermissions_waitForPendingSaves
          ? window.drPermissions_waitForPendingSaves()
          : Promise.resolve();
        pendingSaves.then(function () {
          return auth.signOut();
        }).then(function () {
          try {
            sessionStorage.removeItem('businessKey');
            localStorage.removeItem('businessKey');
            sessionStorage.removeItem('projectKey');
            localStorage.removeItem('projectKey');
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
              (els.extraLogoImgs || []).forEach(function (img) {
                img.src = url;
                img.style.display = 'inline-block';
              });
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
          if (logoUrl) {
            (els.extraLogoImgs || []).forEach(function (img) {
              img.src = logoUrl;
              img.alt = name + ' Logo';
              img.style.display = 'inline-block';
            });
          }
        },
        (err) => {
          E('bindBusinessDoc: snapshot error', err);
        }
      );
  }

  // Shows which project is currently selected (Phase 1 of the
  // multi-project feature) — purely a label for now, since every project
  // still shares the same underlying company-level dashboard data until
  // Phase 2 rewires each card module to read/write project-scoped paths.
  // Reads window.PROJECT_KEY (set earlier by dashboard.html's dash-guard,
  // before this script even runs) rather than waiting on an event, since
  // it's already resolved with its 'default' fallback by then.
  function bindProjectDoc(bizKey, els) {
    if (!els.projectNameEl) return;
    var projectId = window.PROJECT_KEY;
    if (!projectId || projectId === 'default') {
      // The legacy/shared 'default' project isn't a real named project a
      // user picked — nothing useful to show.
      els.projectNameEl.style.display = 'none';
      return;
    }
    var db = window.db;
    if (!db) { W('bindProjectDoc: db not ready'); return; }
    db.collection('businesses').doc(bizKey).collection('projects').doc(projectId).get()
      .then(function (snap) {
        var name = snap.exists && (snap.data() || {}).name;
        if (name) {
          els.projectNameEl.textContent = name;
          els.projectNameEl.style.display = 'block';
        } else {
          els.projectNameEl.style.display = 'none';
        }
      })
      .catch(function (err) {
        E('bindProjectDoc failed', err);
        els.projectNameEl.style.display = 'none';
      });
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

    if (els.extraUploadBtn) {
      els.extraUploadBtn.style.display = isOwner ? '' : 'none';
      if (isOwner) wireExtraUploadTrigger(els.fileInput, els.extraUploadBtn);
    }

    // Bind Firestore business doc → header (with fallback to bizKey)
    bindBusinessDoc(bizKey, els);
    bindProjectDoc(bizKey, els);

    wireUserInfo(user, els, isOwner);
  }

  // Expose to global so dash-loader can call it
  window.initDashboardHeader = initDashboardHeader;
  L('script loaded, initDashboardHeader exposed');
})();