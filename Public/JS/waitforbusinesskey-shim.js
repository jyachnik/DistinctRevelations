
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
})();
