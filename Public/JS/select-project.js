/* ========================================================================
   select-project.js — user picks a project BEFORE dashboard, right after
   a business is resolved. Modeled directly on select-business.js: same
   modal show/hide shape, same waitForFirebase, same persistKey pattern —
   new collection (businesses/{biz}/projects), and it always ends by
   navigating to the dashboard (single visible project → skip the modal
   entirely; zero → show a clear no-access/create-first-project message
   instead of an empty dropdown).
   ======================================================================== */
(function () {
  const TAG = '[select-project]';
  const L = (...a) => console.log(TAG, ...a);
  const W = (...a) => console.warn(TAG, ...a);
  const E = (...a) => console.error(TAG, ...a);
  const $ = (id) => document.getElementById(id);

  const IS_DASH = /\/dashboard\.html(\?|$)/i.test(location.pathname);

  function showModal() {
    const m = $('projectSelectModal');
    L('showModal()', { hasModal: !!m });
    if (!m) return;
    if (typeof m.show === 'function') m.show();
    else { m.style.display = 'flex'; m.setAttribute('aria-hidden', 'false'); }
  }
  function hideModal() {
    const m = $('projectSelectModal');
    if (!m) return;
    if (typeof m.hide === 'function') m.hide();
    else { m.style.display = 'none'; m.setAttribute('aria-hidden', 'true'); }
  }

  function waitForFirebase(ms = 15000) {
    return new Promise((resolve) => {
      const ok = () => !!(window.db && window.auth);
      if (ok()) return resolve({ db: window.db, auth: window.auth });
      const tick = () => { if (ok()) { cleanup(); resolve({ db: window.db, auth: window.auth }); } };
      function cleanup() { try { document.removeEventListener('firebase-ready', tick); } catch {} try { clearInterval(iv); } catch {} try { clearTimeout(to); } catch {} }
      document.addEventListener('firebase-ready', tick);
      const iv = setInterval(tick, 100);
      const to = setTimeout(() => { cleanup(); resolve({ db: window.db, auth: window.auth }); }, ms);
    });
  }

  function persistKey(projId) {
    try { localStorage.setItem('projectKey', projId); } catch {}
    try { sessionStorage.setItem('projectKey', projId); } catch {}
    try {
      window.PROJECT_KEY = projId;
      window.__projPicked = true;
      window.dispatchEvent(new CustomEvent('project:ready', { detail: { projectId: projId } }));
    } catch {}
  }

  // Durable diagnostic: console logs on the login page don't reliably
  // survive the redirect to dashboard.html in every setup ("Preserve log"
  // hasn't been sticking across navigation while debugging this feature),
  // so every decision point also writes a breadcrumb here — dashboard.html
  // prints it on load, regardless of console state.
  function breadcrumb(step, data) {
    L(step, data);
    try {
      const trail = JSON.parse(sessionStorage.getItem('dr-select-project-debug') || '[]');
      trail.push({ step, data, at: Date.now() });
      sessionStorage.setItem('dr-select-project-debug', JSON.stringify(trail));
    } catch {}
  }

  function goToDashboard(bizKey, projId, opts = {}) {
    const qp = new URLSearchParams({ business: bizKey, project: projId });
    if (opts.admin) qp.set('admin', '1');
    const url = 'dashboard.html?' + qp.toString();
    breadcrumb('redirecting', { url });
    // replace(), not href= — an href assignment adds a NEW history entry
    // every time a project is picked, so switching projects a few times in
    // one session leaves a stack of separate real dashboard pages behind
    // (one per project visited). Each is a genuine prior page the
    // back-button trap on a LATER page can't reach across (popstate never
    // fires for that — the browser just reloads the old page instead).
    // replace() overwrites the current entry instead of adding one, so
    // there's only ever a single real "on the dashboard" entry to guard.
    window.location.replace(url);
  }

  // Every visible project. Owner: a plain list of the whole projects
  // collection (Firestore CAN statically prove isOwnerEmail() holds
  // regardless of document content, so an unfiltered list is allowed).
  //
  // Non-owner: NOT a list — Firestore denies an unfiltered
  // businesses/{biz}/projects .get() (or a collectionGroup('members')
  // query) outright for a non-owner, because it can't statically prove an
  // exists()-based rule holds for every possible result, even when every
  // document actually returned would in fact be allowed. Instead this
  // reads the project ids off the user's OWN businesses/{biz}/users/{uid}
  // doc (a plain get(), always safe) — kept in sync by
  // manage-project-access.js's addMember/removeMember/deleteProject — and
  // then get()s each project doc individually, which IS allowed since a
  // get() on a specific, known document isn't subject to the same
  // list-query proof requirement.
  // The 'default' project id is reserved for the legacy-data mirror
  // (functions/index.js's ensureDefaultProject) — an internal fallback
  // shell, not a project anyone actually created. It's excluded from the
  // picker's own options; goToDashboard()'s error-fallback path still uses
  // it directly by id, bypassing this list entirely, so that behavior is
  // unaffected.
  const LEGACY_DEFAULT_PROJECT_ID = 'default';

  async function visibleProjects(db, bizKey, user, isOwner) {
    if (isOwner) {
      const snap = await db.collection('businesses').doc(bizKey).collection('projects').get();
      return snap.docs
        .filter(d => d.id !== LEGACY_DEFAULT_PROJECT_ID)
        .map(d => ({ id: d.id, name: (d.data() || {}).name || d.id }));
    }
    const uid = user && user.uid;
    if (!uid) return [];
    const userDoc = await db.collection('businesses').doc(bizKey).collection('users').doc(uid).get();
    const projectIds = ((userDoc.exists && userDoc.data().projectIds) || [])
      .filter(pid => pid !== LEGACY_DEFAULT_PROJECT_ID);
    const results = await Promise.all(projectIds.map(pid =>
      db.collection('businesses').doc(bizKey).collection('projects').doc(pid).get()
        .then(d => d.exists ? { id: pid, name: (d.data() || {}).name || pid } : null)
        .catch(() => null)
    ));
    return results.filter(Boolean);
  }

  // user: { email, uid, isOwner }
  window.showProjectModalForUser = async function (bizKey, user, opts = {}) {
    breadcrumb('called', { bizKey, user, opts });
    if (window.__projPicked) { breadcrumb('blocked-already-picked', {}); return; }
    if (!bizKey) { breadcrumb('blocked-no-bizKey', {}); return; }

    breadcrumb('waiting-for-firebase', {});
    const { db } = await waitForFirebase();
    breadcrumb('firebase-ready', { hasDb: !!db });
    if (!db) { breadcrumb('blocked-no-db', {}); return; }

    let projects;
    try {
      breadcrumb('loading-visible-projects', {});
      projects = await visibleProjects(db, bizKey, user, !!user.isOwner);
      breadcrumb('visible-projects-loaded', { projects });
    } catch (e) {
      breadcrumb('visible-projects-ERROR', { code: e && e.code, message: e && e.message });
      // Fail open to the dashboard rather than stranding the user — Phase 1
      // doesn't scope any card data by project yet, so a picker failure
      // shouldn't block access to the (still shared) dashboard.
      return goToDashboard(bizKey, 'default', { admin: opts.admin });
    }

    if (projects.length === 1) {
      breadcrumb('single-project-autoskip', projects[0]);
      persistKey(projects[0].id);
      return goToDashboard(bizKey, projects[0].id, { admin: opts.admin });
    }

    if (projects.length === 0) {
      breadcrumb('zero-projects', { isOwner: user.isOwner });
      const msg = user.isOwner
        ? 'No projects yet for this company. Use Settings ▸ Manage Project Access on the dashboard to create your first project.'
        : 'The project is either under construction/maintenance or you have not been granted privileges to view this project.';
      alert(msg);
      // Owner still has a legacy/shared dashboard to fall back to; a
      // non-owner with zero access has nowhere useful to go.
      if (user.isOwner) return goToDashboard(bizKey, 'default', { admin: opts.admin });
      E('non-owner has no visible projects; stopping.');
      return;
    }

    breadcrumb('showing-picker', { projectIds: projects.map(p => p.id) });
    showModal();
    const modal = $('projectSelectModal');
    const dropdown = $('projectDropdown');
    const btn = $('selectProjectBtn');
    if (!modal || !dropdown || !btn) { breadcrumb('modal-DOM-missing', { hasModal: !!modal, hasDropdown: !!dropdown, hasBtn: !!btn }); return; }

    dropdown.innerHTML = '';
    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      dropdown.appendChild(opt);
    });
    btn.disabled = false;
    breadcrumb('picker-populated-and-ready', { optionCount: dropdown.options.length });

    (modal.querySelectorAll('[data-close="projectSelectModal"]') || []).forEach(el => {
      el.addEventListener('click', () => { L('close clicked'); hideModal(); }, { once: true });
    });

    btn.onclick = function () {
      const projId = (dropdown && dropdown.value || '').trim();
      L('Continue clicked →', { projId });
      if (!projId) return W('no project selected');
      persistKey(projId);
      hideModal();
      goToDashboard(bizKey, projId, { admin: opts.admin });
    };
  };

  if (IS_DASH) L('loaded on dashboard; will not open modal here.');
  L('ready');
})();
