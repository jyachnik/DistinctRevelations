/* Public/JS/dr-last-updated.js
   Shared "Last updated: <date>" stamp for the 8 cards that each have their
   own dedicated Data Imports file (Risk Register, Assumptions Log,
   Constraints Log, Quality/Defects Log, Issue Log, RACI, Resource Hours,
   Activity Log) — these don't all get re-imported together, so each one
   needs to show ITS OWN last-import time, not a shared page-load moment.
   A tiny shared helper instead of 7 near-identical copies of the same
   format-and-set-textContent logic across 7 different files. */
(function () {
  function toJsDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function format(v) {
    var d = toJsDate(v);
    if (!d) return null;
    return window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString();
  }

  function render(elId, v) {
    var el = document.getElementById(elId);
    if (!el) return;
    var formatted = format(v);
    el.textContent = formatted ? 'Last updated: ' + formatted : '';
  }

  window.drLastUpdated = { format: format, render: render };
})();
