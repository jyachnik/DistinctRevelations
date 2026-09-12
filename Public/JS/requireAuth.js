/* /Public/JS/requireAuth.js — anti-bounce + patient auth guard (v3) */
/* eslint-disable no-console */
(function () {
  var VERSION   = 'v3.0';
  var LOGIN_URL = '/index.html#client-login';
  var JUST_KEY  = 'dr:justSignedIn';

  function log(){ var a=[].slice.call(arguments); a.unshift('[requireAuth '+VERSION+']'); console.log.apply(console,a); }
  function warn(){ var a=[].slice.call(arguments); a.unshift('[requireAuth '+VERSION+']'); console.warn.apply(console,a); }

  // ---------------------------------------------------------------------------
  // 0) Anti-bounce gate: temporarily block any attempt to navigate to index.html
  //    while we patiently wait for Firebase Auth to restore the session.
  // ---------------------------------------------------------------------------
  var _assign = location.assign.bind(location);
  var _replace = location.replace.bind(location);

  var NAV_STATE = { gateOpen:false, pending:null, released:false };

  function isLoginUrl(u){
    try {
      var x = String(u || '');
      return /\/index\.html(#client\-login)?$/i.test(x) || /#client\-login$/i.test(x);
    } catch(_) { return false; }
  }

  function allowNavigationNow(){
    if (NAV_STATE.released) return;
    NAV_STATE.gateOpen = true;
    NAV_STATE.released = true;
    if (NAV_STATE.pending) { // honor the queued attempt
      var to = NAV_STATE.pending; NAV_STATE.pending = null;
      _replace(to);
    }
  }

  // Intercept *all* navigation attempts
  location.assign = function(u){
    if (!NAV_STATE.gateOpen && isLoginUrl(u)) { NAV_STATE.pending = u; warn('blocked assign →', u); return; }
    return _assign(u);
  };
  location.replace = function(u){
    if (!NAV_STATE.gateOpen && isLoginUrl(u)) { NAV_STATE.pending = u; warn('blocked replace →', u); return; }
    return _replace(u);
  };

  // If we absolutely don’t get a user after the full guard below, we’ll call
  // allowNavigationNow() and then do a single location.replace(LOGIN_URL).
  // ---------------------------------------------------------------------------

  // Wait for firebaseInit to expose window.auth
  function whenAuth(timeoutMs){
    if (timeoutMs===void 0) timeoutMs=15000;
    return new Promise(function(res,rej){
      if (window.auth) return res(window.auth);
      var t=setTimeout(function(){ rej(new Error('auth timeout')); }, timeoutMs);
      if (typeof window.onFirebaseReady==='function'){
        window.onFirebaseReady(function(){ clearTimeout(t); res(window.auth); });
      } else {
        var fn=function(){ clearTimeout(t); document.removeEventListener('firebase-ready',fn); res(window.auth); };
        document.addEventListener('firebase-ready',fn,{ once:true });
      }
    });
  }

  // Wait up to graceMs for currentUser to appear (or onAuthStateChanged to fire)
  function waitForUser(auth, graceMs){
    return new Promise(function(resolve){
      if (auth && auth.currentUser) return resolve(auth.currentUser);
      var start = Date.now(), done=false;

      var iv = setInterval(function(){
        if (done) return;
        if (auth && auth.currentUser){
          done=true; clearInterval(iv); try{unsub&&unsub();}catch(_){}
          return resolve(auth.currentUser);
        }
        if (Date.now()-start > graceMs){
          done=true; clearInterval(iv); try{unsub&&unsub();}catch(_){}
          return resolve(null);
        }
      }, 120);

      var unsub = auth && auth.onAuthStateChanged && auth.onAuthStateChanged(function(u){
        if (done) return;
        if (u){ done=true; clearInterval(iv); try{unsub&&unsub();}catch(_){}
          resolve(u);
        }
      });
    });
  }

  async function guard(){
    log('guarding', location.pathname);

    var auth;
    try { auth = await whenAuth(15000); }
    catch (e) { warn('auth delayed:', e && (e.message||e)); }

    // Default patience
    var graceMs = 3000;

    // If we *just* signed in, be generously patient (common cross-page race)
    try {
      var ts = Number(sessionStorage.getItem(JUST_KEY) || '0');
      if (ts && (Date.now() - ts) < 15000) graceMs = 9000;
      if (ts) sessionStorage.removeItem(JUST_KEY);
    } catch(_){}

    if (!auth) { await new Promise(r=>setTimeout(r,500)); auth = window.auth; }

    var user = await waitForUser(auth, graceMs);

    if (user){
      log('access granted', { uid:user.uid, email:user.email||null });
      allowNavigationNow(); // open the gate for any future, intentional nav
      return; // stay on dashboard
    }

    // Still no user → now allow and perform the single intentional redirect
    log('no user after', graceMs, 'ms → redirecting to login');
    allowNavigationNow();
    _replace(LOGIN_URL);
  }

  document.addEventListener('DOMContentLoaded', guard);

  // Back/forward navigation can restore this page from the browser's
  // bfcache without re-running any JS (including the DOMContentLoaded
  // guard above) — so hitting Back after logging out could otherwise show
  // the last-rendered dashboard even though the session is gone.
  // event.persisted === true means "this is a bfcache restore, not a fresh
  // load" — re-run the guard so a signed-out user gets bounced to login.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      log('bfcache restore detected — re-checking auth');
      guard();
    }
  });
})();