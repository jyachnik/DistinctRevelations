// Public/JS/quick-links.js
// Adds a small "Go to Q&A" / "Go to Files" link pair to the bottom-right
// corner of every card/section, so any section is one click from asking
// a question or checking a related file — without needing to scroll the
// whole dashboard by hand. Pure DOM decoration: no Firebase/auth needed,
// so it runs immediately rather than waiting on any of the async widget
// loaders. A card gets its OWN section skipped (Q&A doesn't link to
// itself, File Manager doesn't link to itself).

(function () {
  'use strict';

  function scrollToId(id) {
    var el = document.getElementById(id);
    if (!el) return;
    // Same offset logic as the page-load hash-scroll below in this file
    // — #dashboardHeader AND .dashboard-summary-row are both fixed on top
    // of the viewport, so a plain scrollIntoView() would land the
    // target's own title right behind the summary row, cut off.
    var header = document.getElementById('dashboardHeader');
    var headerHeight = header ? header.offsetHeight : 0;
    var summaryRow = document.querySelector('.dashboard-summary-row');
    var summaryRowHeight = summaryRow ? summaryRow.offsetHeight : 0;
    var top = el.getBoundingClientRect().top + window.scrollY - headerHeight - summaryRowHeight - 12;
    window.scrollTo({ top: top, behavior: 'smooth' });
  }

  function addQuickLinks(container) {
    if (container.querySelector(':scope > .quick-links-corner')) return; // already added
    // The Report Index sidebar card is a navigation index of every card
    // (Q&A/File Manager included) — a Q&A/Files shortcut in its own
    // corner is redundant there in a way it isn't on any other card.
    if (container.id === 'reportIndexCard') return;
    var isQna = container.id === 'qnaSection';
    var isFileManager = container.id === 'fileManagerSection';

    var wrap = document.createElement('div');
    wrap.className = 'quick-links-corner';

    // In Tiled view (titles-view.js), the Dashboard page these links
    // normally scroll to is hidden — scrolling to it does nothing. When a
    // card is open in a tile popup, jump there instead: close the current
    // popup and open the target one (titles-view.js's own openCardModal
    // already closes whatever's open before showing the new one, and
    // Q&A/File Manager both open at their own widened 100% layout).
    function goTo(id) {
      if (window.drTiledModalActive && window.drTiledModalActive() && window.drOpenTileCard) window.drOpenTileCard(id);
      else scrollToId(id);
    }

    if (!isQna && document.getElementById('qnaSection')) {
      var qnaLink = document.createElement('a');
      qnaLink.href = '#qnaSection';
      qnaLink.textContent = 'Q&A →';
      qnaLink.addEventListener('click', function (e) { e.preventDefault(); goTo('qnaSection'); });
      wrap.appendChild(qnaLink);
    }
    if (!isFileManager && document.getElementById('fileManagerSection')) {
      var fileLink = document.createElement('a');
      fileLink.href = '#fileManagerSection';
      fileLink.textContent = 'Files →';
      fileLink.addEventListener('click', function (e) { e.preventDefault(); goTo('fileManagerSection'); });
      wrap.appendChild(fileLink);
    }

    if (wrap.children.length) container.appendChild(wrap);
  }

  function init() {
    // Most sections use .card; Q&A uses its own .qna-section class (see
    // dashboard.html) — covered by name explicitly since it isn't a .card.
    var containers = document.querySelectorAll('.card, #qnaSection');
    containers.forEach(addQuickLinks);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
