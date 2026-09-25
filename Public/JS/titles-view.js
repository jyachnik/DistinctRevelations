/* ============================================================================
   "Tiled" view — a second way to look at the same dashboard: a
   category-grouped, 4-column grid of tiles (one per report card, showing
   only its icon/title/subtitle) instead of the full Dashboard page.
   Clicking a tile opens that card's REAL, live DOM element in a popup —
   moved via appendChild, not cloned, so every listener (Firestore
   real-time updates, form buttons, sort/filter, everything) keeps working
   exactly as it does on the page. Closing the popup moves it back to
   exactly where it came from.

   Reuses report-index.js's own data (window.drAllReportEntries,
   window.drReportCategories) and its already-resolved permission state
   (the sidebar's own rendered <a data-target> elements) as the single
   source of truth for which cards exist, what they're called, and
   whether the current role can see them — nothing here is a second copy
   that could drift out of sync with the sidebar.

   Action-triggering entries (Ask the Project, Status Report, Change
   Report, Permissions, etc. — anything with an `action` in REPORTS)
   have no single "whole card" DOM node to move; clicking their tile
   instead fires a synthetic click on the sidebar's own already-wired
   <a data-target> for that id, which reuses 100% of report-index.js's
   existing dispatch (including the disabled/toast path for a role the
   Permissions matrix hasn't granted it).

   The global Time Frame control now lives permanently in the left
   sidebar (#reportSidebar, always on screen regardless of Dashboard vs.
   Tiled view or any open card popup — see dashboard.html/burndown.js), so
   unlike everything else in this file it never needs to be moved into a
   card's popup; every timeframe-aware chart just re-renders in place
   wherever it currently lives when the dropdown changes.
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[titles-view]';

  // Wide-format cards (timelines, tables, logs) get the modal box itself
  // widened to ~96vw instead of the normal 1000px cap — a 1000px box
  // crushes a Gantt timeline or a wide log table down to where it's
  // barely usable. Explicit "modal width = 100%" request, applied to
  // every log/register/table-style card.
  var WIDE_CARD_IDS = [
    'executiveRoadmapCard', 'ganttSection', 'qnaSection', 'fileManagerSection',
    'benefitsRealizationCard', 'glossaryCard', 'dependenciesCard', 'milestoneSection',
    'procurementCard', 'requirementsTraceabilityCard', 'qualityDefectsCard',
    'costOfQualityCard', 'deliverableSignoffCard', 'assumptionsLogCard',
    'constraintsLogCard', 'riskRegisterCard', 'issueLogCard', 'stakeholderRegisterCard',
    'communicationsPlanCard', 'communicationsLogCard', 'teamDirectoryCard',
    'changeControlLogCard', 'baselineChangeCard', 'decisionLogCard'
  ];
  // Smaller cards that should stay their own natural width but be
  // CENTERED in the modal instead of stretching/sitting flush-left
  // (align-items:stretch's default when a child's own max-width is
  // narrower than the box).
  var CENTERED_CARD_IDS = ['riskHeatMapCard'];
  // Team Charter's modal specifically: 8.5in ≈ 816px at 96dpi.
  var CARD_MODAL_WIDTH_PX = { teamCharterCard: 816 };

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  var mainView, gridView, viewSelect;
  var activeModal = null; // { overlay, restore() } — only one card popup open at a time

  // ---------------------------------------------------------------------------
  // View switching
  // ---------------------------------------------------------------------------
  function showDashboard() {
    if (activeModal) closeModal();
    if (mainView) mainView.hidden = false;
    if (gridView) gridView.hidden = true;
    window.scrollTo(0, 0);
  }
  function showTitlesView() {
    if (mainView) mainView.hidden = true;
    if (gridView) { gridView.hidden = false; buildGrid(); }
    // Switching views doesn't reset scroll position on its own — someone
    // scrolled halfway down the Dashboard page and then switching here
    // would land the viewport partway down THIS page's content too,
    // making the first category look like it's simply missing.
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------------------
  // Grid building — reads report-index.js's own data + the sidebar's own
  // already-rendered links (the authoritative "can this role see it, and
  // does a real link exist" check) rather than recomputing permissions.
  // ---------------------------------------------------------------------------
  function sidebarLink(id) {
    var list = document.getElementById('reportIndexList');
    return list ? list.querySelector('a[data-target="' + id + '"]') : null;
  }

  // These 6 already sit permanently at the top of the page (the pinned
  // summary row, moved out of <main> so it stays visible in Tiled view
  // too — see dashboard.html) — a tile for each here would just be a
  // redundant second copy of something already always on screen.
  var ALREADY_PINNED_IDS = ['projectStatusCard', 'projectProgressCard', 'qnaSummaryCard', 'schedulePerformanceCard', 'forecastFinishCard', 'costPerformanceCard'];

  function buildGrid() {
    if (!gridView) return;
    var entries = window.drAllReportEntries;
    var categories = window.drReportCategories;
    if (!entries || !categories) { gridView.innerHTML = '<p class="tv-empty">Still loading…</p>'; return; }

    var byId = {};
    entries.forEach(function (e) { byId[e.id] = e; });

    var html = categories.map(function (cat) {
      var tiles = cat.ids.map(function (id) {
        if (ALREADY_PINNED_IDS.indexOf(id) !== -1) return '';
        var entry = byId[id];
        if (!entry) return '';
        var link = sidebarLink(id);
        if (!link) return ''; // no sidebar link = owner-only denied, or a scroll-to card with no live element

        var isNormalCard = !entry.action;
        // A normal card whose real element is currently permission-hidden
        // shouldn't show a tile either — matches the Dashboard page,
        // where that card simply isn't there for this role.
        if (isNormalCard) {
          var el = document.getElementById(id);
          if (!el || el.classList.contains('report-hidden')) return '';
        }
        var isDisabled = link.getAttribute('data-disabled') === '1';
        // A real <button> per tile so clicking anywhere opens it; the
        // info icon inside is its OWN <button> (chart-info.js's exact
        // hover-panel structure, reused so both surfaces share one
        // authored copy) — button-in-button isn't valid HTML, so the
        // tile itself is a div with button semantics instead.
        var info = window.drChartInfo && window.drChartInfo[id];
        var infoHtml = info
          ? '<span class="chart-info-wrap"><button type="button" class="chart-info-btn" title="About this" aria-label="About this" data-card-id="' + esc(id) + '">ℹ️</button><div class="chart-info-panel">' + info.body + '</div></span>'
          : '';

        return '<div class="tv-tile' + (isDisabled ? ' tv-tile-disabled' : '') + '" data-id="' + esc(id) + '" role="button" tabindex="0"' +
          (isDisabled ? ' aria-disabled="true"' : '') + '>' +
          infoHtml +
          '<span class="tv-tile-icon" data-no-translate>' + (entry.icon || '') + '</span>' +
          '<span class="tv-tile-title">' + esc(entry.label) + '</span>' +
          '<span class="tv-tile-subtitle">' + esc(entry.desc) + '</span>' +
          '</div>';
      }).filter(Boolean).join('');
      if (!tiles) return '';
      return '<div class="tv-category"><h3 class="tv-category-heading">' + esc(cat.name) + '</h3>' +
        '<div class="tv-tile-grid">' + tiles + '</div></div>';
    }).join('');

    gridView.innerHTML = html || '<p class="tv-empty">Nothing to show yet.</p>';
  }

  // ---------------------------------------------------------------------------
  // Tile click — action entries reuse the sidebar's own dispatch via a
  // synthetic click; normal cards open the live-card popup.
  // ---------------------------------------------------------------------------
  function onTileClick(id) {
    var entries = window.drAllReportEntries || [];
    var entry = entries.filter(function (e) { return e.id === id; })[0];
    if (!entry) return;
    if (entry.action) {
      var link = sidebarLink(id);
      if (link) link.click();
      return;
    }
    openCardModal(id);
  }

  // ---------------------------------------------------------------------------
  // Live-card popup — moves the real DOM node into an overlay, then back
  // to its exact original spot on close. A comment node marks the exact
  // original position so restoration is correct even if something else
  // changed sibling order while it was moved.
  // ---------------------------------------------------------------------------
  function openCardModal(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (activeModal) closeModal();

    var placeholder = document.createComment('tv-placeholder-' + id);
    el.parentNode.insertBefore(placeholder, el);

    var overlay = document.createElement('div');
    overlay.className = 'tv-card-modal-overlay';
    var box = document.createElement('div');
    box.className = 'tv-card-modal-box' +
      (WIDE_CARD_IDS.indexOf(id) !== -1 ? ' tv-card-modal-box-wide' : '') +
      (CENTERED_CARD_IDS.indexOf(id) !== -1 ? ' tv-card-modal-box-centered' : '');
    if (CARD_MODAL_WIDTH_PX[id]) box.style.maxWidth = CARD_MODAL_WIDTH_PX[id] + 'px';

    // The close button lives in its OWN sticky bar, separate from the
    // scrolling content below — otherwise it would scroll out of reach on
    // a tall card. See CSS for how the card's own .section-header sticks
    // within .tv-card-modal-scroll (the actual scrolling element).
    var closeBar = document.createElement('div');
    closeBar.className = 'tv-card-modal-close-bar';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tv-card-modal-close';
    closeBtn.textContent = '✕ Close';
    closeBtn.addEventListener('click', closeModal);
    closeBar.appendChild(closeBtn);

    var scrollArea = document.createElement('div');
    scrollArea.className = 'tv-card-modal-scroll';
    scrollArea.appendChild(el);

    box.appendChild(closeBar);
    box.appendChild(scrollArea);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);

    activeModal = {
      overlay: overlay,
      restore: function () {
        if (placeholder.parentNode) placeholder.parentNode.replaceChild(el, placeholder);
        overlay.remove();
      }
    };
  }

  function closeModal() {
    if (!activeModal) return;
    activeModal.restore();
    activeModal = null;
  }

  // Reused by quick-links.js: its "Q&A →" / "Files →" corner links
  // normally scroll to that section on the Dashboard page, which does
  // nothing useful while Tiled view's #dashboardMainView is hidden. When
  // a tile-hosted card popup is open, quick-links.js instead calls this
  // directly — openCardModal() already closes whatever's open first
  // (see its own "if (activeModal) closeModal();" above), so this alone
  // gives "close the current one, open the target at 100% width" for
  // qnaSection/fileManagerSection (both in WIDE_CARD_IDS).
  window.drOpenTileCard = openCardModal;
  window.drTiledModalActive = function () { return !!activeModal; };

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  // Mobile + tablet lock — RWD strategy per explicit direction: the
  // Dashboard view's dense multi-column layout isn't reflowed into a
  // narrow column, it's replaced outright by Tiled view below this
  // width (see responsive-dashboard.css, same 1024px breakpoint, which
  // hides #drViewSelectWrap and handles the rest of the layout — this
  // is just the JS half, forcing the actual view and disabling the
  // control so nothing can switch back to Dashboard while it's locked).
  var MOBILE_LOCK_QUERY = '(max-width: 1024px)';
  // Debounced, deliberately — connecting a screen-mirroring/casting setup
  // can make the OS briefly renegotiate display resolution before
  // settling on the final one, which can flicker the reported viewport
  // width across this query's threshold several times in a burst rather
  // than changing once (reported: this caused the page to visibly freeze
  // the instant mirroring connected, laptop screen included — each
  // flicker was synchronously rebuilding the whole Tiled grid via
  // showTitlesView()/buildGrid()). Waiting for things to actually settle
  // before reacting collapses a burst into one correct action instead of
  // however many the negotiation happened to trigger.
  var viewLockTimer = null;
  function enforceViewLock(mq) {
    if (!viewSelect) return;
    if (viewLockTimer) clearTimeout(viewLockTimer);
    viewLockTimer = setTimeout(function () {
      if (mq.matches) {
        viewSelect.value = 'titles';
        viewSelect.disabled = true;
        showTitlesView();
      } else {
        viewSelect.disabled = false;
        // Deliberately doesn't force Dashboard back on when widening past
        // the lock — if the user had picked Tiled themselves before ever
        // going narrow, resizing back up shouldn't yank them out of it.
      }
    }, 300);
  }

  function init() {
    mainView = document.getElementById('dashboardMainView');
    gridView = document.getElementById('titlesSubtitlesView');
    viewSelect = document.getElementById('drViewSelect');
    if (!mainView || !gridView || !viewSelect) { console.warn(ns, 'expected elements missing'); return; }

    viewSelect.addEventListener('change', function () {
      if (viewSelect.value === 'titles') showTitlesView(); else showDashboard();
    });

    if (typeof window.matchMedia === 'function') {
      var mq = window.matchMedia(MOBILE_LOCK_QUERY);
      enforceViewLock(mq);
      if (mq.addEventListener) mq.addEventListener('change', function () { enforceViewLock(mq); });
      else if (mq.addListener) mq.addListener(function () { enforceViewLock(mq); }); // older Safari
    }

    gridView.addEventListener('click', function (e) {
      // The info icon's own click is handled by chart-info.js's own
      // document-level listener (it opens window.drModal) — don't ALSO
      // treat it as "open this tile's card".
      if (e.target.closest('.chart-info-wrap')) return;
      var tile = e.target.closest('.tv-tile');
      if (!tile || tile.getAttribute('aria-disabled') === 'true') return;
      onTileClick(tile.getAttribute('data-id'));
    });
    // .tv-tile is a div with role="button", not a real <button> (a real
    // info <button> nests inside it, and button-in-button isn't valid
    // HTML) — Enter/Space need to be wired by hand for the same reason a
    // real button gets them for free.
    gridView.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('.chart-info-wrap')) return;
      var tile = e.target.closest('.tv-tile');
      if (!tile || tile.getAttribute('aria-disabled') === 'true') return;
      e.preventDefault();
      onTileClick(tile.getAttribute('data-id'));
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && activeModal) closeModal();
    });

    // If the grid is open when permissions resolve/change, rebuild so
    // tiles reflect the just-updated access state.
    window.addEventListener('dr-access:ready', function () { if (!gridView.hidden) buildGrid(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
