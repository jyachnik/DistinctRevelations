
/* Classic shim so legacy components can keep calling window.waitForBusinessKey().
   It delegates to the modern DRSession. */
(function () {
  'use strict';
  if (!window.DRSession) {
    console.warn('[shim] DRSession not ready yet; waitForBusinessKey will retry.');
  }
  window.waitForBusinessKey = function waitForBusinessKey() {
    return (window.DRSession
      ? window.DRSession.getSession()
      : new Promise(function (resolve) {
          var t = setInterval(function () {
            if (window.DRSession && typeof window.DRSession.getSession === 'function') {
              clearInterval(t);
              resolve(window.DRSession.getSession());
            }
          }, 50);
        })
    ).then(function (s) { return s.businessKey; });
  };

  // Phase 1 of the multi-project feature: resolves the picked project id
  // the same way waitForBusinessKey() resolves the business key — no
  // module reads this yet (that's Phase 2), but it's available from day
  // one so Phase 2 has something ready to call.
  function readProjectKey() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      return (params.get('project') ||
        (window.sessionStorage && window.sessionStorage.getItem('projectKey')) ||
        (window.localStorage && window.localStorage.getItem('projectKey')) ||
        window.PROJECT_KEY || '').trim() || null;
    } catch (e) { return null; }
  }
  window.waitForProjectId = function waitForProjectId() {
    var existing = readProjectKey();
    if (existing) return Promise.resolve(existing);
    return new Promise(function (resolve) {
      window.addEventListener('project:ready', function onReady(e) {
        window.removeEventListener('project:ready', onReady);
        resolve((e && e.detail && e.detail.projectId) || readProjectKey());
      });
    });
  };
})();
