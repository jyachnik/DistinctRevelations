// Public/JS/dr-cross-refs.js
// Shared registry of short reference codes (D-003, A-055, ISS-001, the
// synthetic ACT-01/M-01, etc.) mentioned inside AI Insight sentences
// (see ai-insights.js) — each card module registers its own rows here as
// it renders its table, and ai-insights.js turns any recognized code
// found in an insight sentence into a clickable button that opens a
// popup with that record's details and a "Go to card" jump.
//
// In-memory only, rebuilt on every render — same lifecycle as
// ai-insights.js's own latestFacts cache, no persistence needed.
//
// Loaded early (a plain <script>, not through the auth-gated loadScript()
// cascade) so it's guaranteed ready before any card module registers
// rows or ai-insights.js tries to linkify text.

(function () {
  'use strict';

  var registry = new Map();

  function register(code, info) {
    if (!code) return;
    registry.set(code, info || {});
  }

  function lookup(code) {
    return registry.get(code) || null;
  }

  // Matches D-003, A-055, ISS-001, ACT-01, M-01, and any other
  // letters-then-digits code shape a spreadsheet's own ID column might
  // use — generous on purpose. A match that isn't actually a registered
  // code (an incidental hyphenated token, a quarter label like "Q2-2026")
  // is left untouched by protect() below, so being generous here carries
  // no false-positive risk.
  var CODE_RE = /\b([A-Za-z]{1,6}-\d{1,5})\b/g;

  // Replaces every RECOGNIZED code in plain text with a single private-
  // use-area placeholder character before escapeHtml/boldNumbers ever
  // see it. Necessary because boldNumbers() would otherwise treat the
  // hyphen in e.g. "D-003" as a minus sign and wrap the digits in
  // <strong>, splitting the code across a tag boundary so it could never
  // be matched back into a link. Returns both the placeholder text and
  // the ordered list of codes it replaced, so a later restore() call can
  // swap them for real link HTML once escaping/bolding/truncation are
  // all done.
  function protect(text) {
    var occurrences = [];
    var result = String(text).replace(CODE_RE, function (match, code) {
      if (!registry.has(code)) return match;
      var idx = occurrences.length;
      if (idx > 0xff) return match; // absurdly many codes in one sentence; leave the rest as plain text
      occurrences.push(code);
      return String.fromCharCode(0xE000 + idx);
    });
    return { text: result, occurrences: occurrences };
  }

  function escAttr(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // Swaps placeholder characters (inserted by protect(), still present
  // even after the surrounding text has been escaped/bolded/truncated)
  // for the real clickable button HTML. A placeholder that got cut off
  // by the 2-line truncation in ai-insights.js simply won't appear here
  // and is silently dropped — no crash, the sentence just loses that one
  // link.
  function restore(html, occurrences) {
    if (!occurrences || !occurrences.length) return html;
    return html.replace(/[-]/g, function (ch) {
      var idx = ch.charCodeAt(0) - 0xE000;
      var code = occurrences[idx];
      if (code == null) return '';
      var label = escAttr(code);
      return '<button type="button" class="dr-ref-link" data-ref-code="' + label + '">' + label + '</button>';
    });
  }

  function openRefPopup(code, info) {
    var fieldsHtml = (info.fields || [])
      .filter(function (f) { return f && f.value; })
      .map(function (f) {
        return '<div class="dr-ref-field"><span class="dr-ref-field-label">' + escAttr(f.label) + ':</span> ' +
          '<span class="dr-ref-field-value">' + escAttr(f.value) + '</span></div>';
      }).join('');

    var canView = !window.drAccess || window.drAccess.canViewReport(info.cardId);
    var goHtml = canView
      ? '<button type="button" class="dr-ref-goto-btn" data-goto-card="' + escAttr(info.cardId) + '">Go to ' + escAttr(info.cardLabel) + ' →</button>'
      : '<p class="dr-ref-no-access">You don’t have access to view this card.</p>';

    var bodyHtml =
      (info.summary ? '<p class="dr-ref-summary">' + escAttr(info.summary) + '</p>' : '') +
      fieldsHtml +
      '<p class="dr-ref-found-in">Found in: ' + escAttr(info.cardLabel) + '</p>' +
      goHtml;

    window.drModal.open({ title: code, bodyHtml: bodyHtml });
  }

  // Event delegation (not per-button listeners) — insight text and
  // popups get rebuilt/replaced on every render, same reasoning as
  // ai-insights.js's own .ai-insight-viewmore handling.
  document.addEventListener('click', function (e) {
    var refBtn = e.target.closest('.dr-ref-link');
    if (refBtn) {
      var code = refBtn.getAttribute('data-ref-code');
      var info = lookup(code);
      if (info && window.drModal) openRefPopup(code, info);
      return;
    }
    var goBtn = e.target.closest('.dr-ref-goto-btn');
    if (goBtn) {
      var card = document.getElementById(goBtn.getAttribute('data-goto-card'));
      if (!card) return;
      if (window.drModal) window.drModal.close();
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      card.classList.add('dr-ref-highlight');
      setTimeout(function () { card.classList.remove('dr-ref-highlight'); }, 1500);
    }
  });

  window.drRefs = {
    register: register,
    lookup: lookup,
    protect: protect,
    restore: restore
  };
})();
