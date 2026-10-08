/* ============================================================================
   error-monitor.js — a lightweight, console-only global error reporter.

   Loaded FIRST, before any other script on the page (see dashboard.html /
   index.html / track-record.html — it's the very first <script> in <head>),
   so it catches errors from anything that runs after it, including the
   dashboard's own inline access-guard script and the Firebase SDK loads.

   Deliberately console-only — no telemetry, no network calls, nothing is
   ever sent anywhere. Every entry is tagged "[dr-error]" so it's easy to
   filter for in DevTools, and kept in a small ring buffer (window.drErrors)
   so "was there an error on this page?" can be answered with one line
   (window.drErrors.list()) instead of scrolling the console.
   ============================================================================ */
(function () {
  'use strict';

  var MAX_KEPT = 50;
  var buffer = [];

  function record(entry) {
    entry.at = new Date().toISOString();
    buffer.push(entry);
    if (buffer.length > MAX_KEPT) buffer.shift();
    var label = '[dr-error] ' + entry.kind + (entry.source ? ' @ ' + entry.source : '');
    console.error(label, entry.message, entry.stack || '');
  }

  // Synchronous runtime errors (a thrown exception anywhere, a TypeError on
  // a null element, etc.). Resource-load failures (an <img>/<script> 404)
  // fire the same 'error' event but with no .message/.error — skipped here,
  // since those aren't JS bugs and would just be noise.
  window.addEventListener('error', function (ev) {
    if (!ev.message && !ev.error) return;
    record({
      kind: 'error',
      message: ev.message || (ev.error && ev.error.message) || 'Unknown error',
      source: ev.filename ? ev.filename.split('/').pop() + ':' + ev.lineno + ':' + ev.colno : '',
      stack: ev.error && ev.error.stack
    });
  });

  // A rejected Promise nobody .catch()'d — the single most common way a
  // Firestore/Cloud Function call fails silently in this app.
  window.addEventListener('unhandledrejection', function (ev) {
    var reason = ev.reason;
    record({
      kind: 'unhandled promise rejection',
      message: (reason && reason.message) || String(reason),
      stack: reason && reason.stack
    });
  });

  window.drErrors = {
    list: function () { return buffer.slice(); },
    clear: function () { buffer.length = 0; },
    count: function () { return buffer.length; }
  };
})();
