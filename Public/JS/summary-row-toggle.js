/* Public/JS/summary-row-toggle.js
   Collapse/expand the fixed .dashboard-summary-row (Project Status,
   Project Progress, Q&A Summary, SPI, Forecast Finish, CPI) to save
   screen real estate — down arrow (▼) when hidden means "click to show",
   up arrow (▲) when shown means "click to hide", the standard convention.
   Two arrow buttons, one at each side of the row, both drive the exact
   same toggle and stay in sync — either one works regardless of which
   side of a wide row is in view.

   No Firebase dependency — loaded early, plain DOM only. Hiding each card
   (display:none) rather than the row itself keeps the toggle buttons'
   own row present and visible; report-index.js's own ResizeObserver on
   .dashboard-summary-row already measures its real height live and
   updates --dr-summary-row-height accordingly, so the in-flow spacer
   below it shrinks to match automatically — nothing extra to wire here
   for that part.
*/
(function () {
  'use strict';

  var STORAGE_KEY = 'dr-summary-row-collapsed';
  var BTN_IDS = ['summaryRowToggle', 'summaryRowToggleRight'];

  function buttons() {
    return BTN_IDS.map(function (id) { return document.getElementById(id); }).filter(Boolean);
  }

  function apply(collapsed) {
    var row = document.querySelector('.dashboard-summary-row');
    var btns = buttons();
    if (!row || !btns.length) return;
    Array.prototype.forEach.call(row.children, function (el) {
      if (BTN_IDS.indexOf(el.id) === -1) el.style.display = collapsed ? 'none' : '';
    });
    btns.forEach(function (btn) {
      btn.textContent = collapsed ? '▼' : '▲';
      btn.title = collapsed ? 'Show this row' : 'Hide this row';
      btn.setAttribute('aria-expanded', String(!collapsed));
    });
  }

  function init() {
    var btns = buttons();
    if (!btns.length) return;
    // Defaults to SHOWN (visible) — only a previously saved "collapsed"
    // choice hides it on load.
    var collapsed = false;
    try { collapsed = window.localStorage && window.localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { /* ignore */ }
    apply(collapsed);
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var isCurrentlyCollapsed = btn.getAttribute('aria-expanded') !== 'true';
        apply(!isCurrentlyCollapsed);
        try { if (window.localStorage) window.localStorage.setItem(STORAGE_KEY, isCurrentlyCollapsed ? '0' : '1'); } catch (e) { /* ignore */ }
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
