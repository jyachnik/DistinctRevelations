// /Public/JS/dashboard-business-loader.js
// Persists businessKey and broadcasts it for all components.

(function () {
  if (window.__bizLoader__) return; window.__bizLoader__ = true;

  const params = new URLSearchParams(location.search);
  const fromUrl = (params.get('business') || '').trim();
  const fromLS  = (localStorage.getItem('businessKey') || '').trim();
  const biz = fromUrl || fromLS || null;

  if (biz) {
    try { localStorage.setItem('businessKey', biz); } catch (_) {}
    window.BIZ_KEY = biz;

    // Minimal session facade (supports waitforbusinesskey-shim.js)
    window.DRSession = window.DRSession || {
      _session: { businessKey: biz },
      getSession() { return Promise.resolve(this._session); },
      setBusinessKey(k) {
        this._session.businessKey = k;
        try { localStorage.setItem('businessKey', k); } catch {}
      }
    };

    window.dispatchEvent(new CustomEvent('business:ready', { detail: { businessKey: biz } }));
  } else {
    console.warn('[business-loader] No business key found (URL or localStorage)');
  }

  // Phase 2 of the multi-project feature — resolve/persist the project id
  // the same way the business key just was above. Every business always
  // has at least the auto-created 'default' project (see
  // functions/index.js's ensureDefaultProject/mirror functions, and
  // select-project.js's own treatment of 'default' as the implicit
  // project when nothing's been explicitly picked), so this now always
  // resolves to a real value instead of leaving window.PROJECT_KEY
  // undefined — every card module reading it can assume it's set, the
  // same guarantee window.BIZ_KEY already provides.
  const projFromUrl = (params.get('project') || '').trim();
  const projFromLS = (localStorage.getItem('projectKey') || '').trim();
  const proj = projFromUrl || projFromLS || 'default';
  try { localStorage.setItem('projectKey', proj); } catch (_) {}
  try { sessionStorage.setItem('projectKey', proj); } catch (_) {}
  window.PROJECT_KEY = proj;
  window.dispatchEvent(new CustomEvent('project:ready', { detail: { projectId: proj } }));

  // Optional: kick File Manager after auth (keeps your previous behavior)
  const { auth } = window;
  if (auth && typeof auth.onAuthStateChanged === 'function' && biz) {
    auth.onAuthStateChanged(user => {
      if (!user) return;
      try { loadFileManager(biz, (user.email || '').toLowerCase()); }
      catch (e) { /* ignore if not present on page */ }
    });
  }

})();