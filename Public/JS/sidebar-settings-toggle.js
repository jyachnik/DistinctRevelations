/* Public/JS/sidebar-settings-toggle.js
   Collapses/expands the "View & Time Frame" block in the sidebar (see
   dashboard.html — #drSidebarSettings) — collapsed by default so the
   Reports list below it gets most of the sidebar's limited vertical
   room. Doesn't touch either control's own behavior; View and Time
   Frame keep the exact same ids/wiring (titles-view.js, burndown.js)
   they had before this was collapsible.

   No Firebase dependency — loaded early, plain DOM only, same pattern
   as summary-row-toggle.js.
*/
(function () {
  'use strict';

  function init() {
    var toggle = document.getElementById('drSidebarSettingsToggle');
    var body = document.getElementById('drSidebarSettingsBody');
    if (!toggle || !body) return;

    toggle.addEventListener('click', function () {
      var wasOpen = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!wasOpen));
      body.hidden = wasOpen;
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
