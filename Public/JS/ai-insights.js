// Public/JS/ai-insights.js
// A small "AI Insight" box in each card, just above its Q&A→/Files→
// quick-links corner — a 1-2 sentence summary of what that card's own
// data actually shows right now.
//
// The FACTS are always computed deterministically by each calling module
// (burndown.js, qna.js, etc.) from the same numbers already driving that
// card's chart/table — every call site still just does
// window.drInsight.set('someCardId', 'text'), unchanged. What this file
// decides is which TEXT to actually show for that card:
//   - Insight Mode "Standard" (the default, free, no API calls): always
//     show the rule-based sentence as-is.
//   - Insight Mode "AI": show the polished sentence from the business's
//     last "Run Analysis" pass (see ai-analysis.js / the runProjectAnalysis
//     Cloud Function) instead, if one exists for this card — otherwise
//     fall back to the rule-based sentence until the owner runs one.
// AI generation is on-demand only (the owner-triggered "Run Analysis"
// button), never automatic — a full project analysis reads every import
// and costs more than a per-card call, so nothing here fires it on its
// own. That also means the AI sentence for a card stays put across a
// Time Frame change instead of flickering back to the rule-based one —
// it reflects whichever period was selected at the last analysis run,
// until the owner runs it again.
//
// Loaded early (a plain <script>, not through the auth-gated loadScript()
// cascade) so it's guaranteed ready before burndown.js/etc. try to call it.

(function () {
  'use strict';

  var insightMode = 'standard';
  var cachedCardText = {}; // cardId -> AI-phrased text from the last analysis run
  var cachedCardTextExec = {}; // cardId -> the executive (C-level) wording from the same run
  var latestFacts = {};    // cardId -> current rule-based facts text (null when hidden)
  var historyFacts = {};   // cardId -> period-independent "fluctuation across time" text, for timeframe charts only
  var fullTextByCard = {}; // cardId -> whatever text is currently shown (rule or AI) — what "View more" opens

  function ensureBox(cardId) {
    var card = document.getElementById(cardId);
    if (!card) return null;
    var box = card.querySelector(':scope > .ai-insight-box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'ai-insight-box';
      // No separate label span anymore — the ✨ icon renders INSIDE
      // .ai-insight-headline now (applyText() prepends it to the text),
      // right before the first word, rather than as a sibling before
      // .ai-insight-text. It used to sit on its own line whenever the
      // headline wrapped: .ai-insight-headline is display:-webkit-box
      // (needed for the 2-line clamp), and a block-level element nested
      // inside an inline .ai-insight-text forced a line break before it,
      // pushing the icon (an inline sibling right before that block) onto
      // its own line above the text instead of sitting beside it.
      box.innerHTML = '<span class="ai-insight-text"></span>';
      card.appendChild(box);
    }
    return box;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
  }

  // Bolds numeric figures ($1.2M, 76%, 0.38, 184, etc.) within the insight
  // text so they stand out at a glance — the rest of the sentence stays
  // italic (see .ai-insight-text in quick-links.css).
  function boldNumbers(text) {
    return escapeHtml(text).replace(/[-+]?\$?\d[\d,]*(\.\d+)?\s?[KMB%]?/gi, function (m) {
      return '<strong>' + m + '</strong>';
    });
  }

  function viewMoreButtonHtml(cardId) {
    return ' <button type="button" class="ai-insight-viewmore" data-card-id="' + escapeHtml(cardId) + '">…more detail</button>';
  }

  // window.drRefs (dr-cross-refs.js) turns any recognized D-003/A-055/
  // etc. reference code into a clickable popup — protect() must run on
  // the RAW text before boldNumbers() ever sees it (boldNumbers would
  // otherwise treat a code's hyphen as a minus sign and wrap its digits
  // in <strong>, splitting the code across a tag boundary), and
  // restore() swaps the placeholder characters it left behind for the
  // real link HTML after boldNumbers is done.
  function renderProtected(text) {
    var protection = window.drRefs ? window.drRefs.protect(text) : null;
    var html = boldNumbers(protection ? protection.text : text);
    return protection ? window.drRefs.restore(html, protection.occurrences) : html;
  }

  // A getBoundingClientRect-measurement-and-binary-search approach lived
  // here before, cutting the text at whatever prefix length fit within a
  // measured 2-line pixel height. It worked for most cards but
  // reproducibly never clamped for the always-visible pinned summary
  // cards specifically, across repeated testing sessions — never root-
  // caused despite extensive investigation (the algorithm read as
  // correct; something about that measurement in that specific context
  // silently never triggered it). Replaced with a plain CSS line-clamp
  // (see .ai-insight-headline in quick-links.css) plus a cheap character-
  // length heuristic for whether a "…more detail" button is worth
  // showing at all — it can't mismeasure a box it never measures, so
  // whatever that was, this sidesteps it entirely rather than needing to
  // find it.
  var SHOW_MORE_THRESHOLD = 110;

  function applyText(cardId, text) {
    var box = ensureBox(cardId);
    if (!box) return;
    if (!text) { box.hidden = true; delete fullTextByCard[cardId]; return; }
    box.hidden = false;
    fullTextByCard[cardId] = text;
    var textEl = box.querySelector('.ai-insight-text');
    if (!textEl) return;

    var protection = window.drRefs ? window.drRefs.protect(text) : null;
    var protectedText = protection ? protection.text : text;
    var html = boldNumbers(protectedText);
    html = protection ? window.drRefs.restore(html, protection.occurrences) : html;
    var btnHtml = protectedText.length > SHOW_MORE_THRESHOLD ? viewMoreButtonHtml(cardId) : '';
    // ✨ prepended INSIDE the headline, right before the first word —
    // icon only, no "Insight"/"AI Insight" wording — rather than as a
    // separate element before it (see ensureBox() for why that broke).
    textEl.innerHTML = '<strong class="ai-insight-headline"><span class="ai-insight-label">✨</span> ' + html + '</strong>' + btnHtml;
  }

  // Event delegation (not a per-button listener) — insight boxes get
  // rebuilt/replaced on every render, so a directly-attached listener
  // would need rewiring every time; delegating to document sidesteps that.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.ai-insight-viewmore');
    if (!btn) return;
    var cardId = btn.getAttribute('data-card-id');
    var full = fullTextByCard[cardId];
    if (!full || !window.drModal) return;
    var card = document.getElementById(cardId);
    var h2 = card ? card.querySelector('h2') : null;
    var cardTitle = h2 ? h2.textContent.replace(/\s+/g, ' ').trim() : 'Insight';
    window.drModal.open({
      title: cardTitle,
      bodyHtml: '<p class="dr-insight-modal-text">' + renderProtected(full) + '</p>'
    });
  });

  // The executive wording (Permissions: "AI wording — Executive version", or Summary ticked on the
  // Executive Overview card) replaces the technical text whenever the last analysis produced one —
  // it costs nothing extra to show, so it does not depend on the Insight Mode setting.
  function wantsExec() { return !!(window.drAiVersion && window.drAiVersion.wording() === 'executive'); }
  function renderForCard(cardId, ruleText) {
    if (wantsExec() && cachedCardTextExec[cardId]) {
      applyText(cardId, cachedCardTextExec[cardId]);
    } else if (insightMode === 'ai' && cachedCardText[cardId]) {
      applyText(cardId, cachedCardText[cardId]);
    } else {
      applyText(cardId, ruleText);
    }
  }

  function rerenderAll() {
    Object.keys(latestFacts).forEach(function (cardId) {
      if (latestFacts[cardId]) renderForCard(cardId, latestFacts[cardId]);
    });
  }

  window.drInsight = {
    // text: '' or null/undefined hides the box entirely (e.g. no data yet).
    set: function (cardId, text) {
      latestFacts[cardId] = text || null;
      if (!text) {
        applyText(cardId, '');
        delete cachedCardText[cardId];
        delete historyFacts[cardId];
        return;
      }
      renderForCard(cardId, text);
    },
    // Called by timeframe-driven charts (burndown.js etc.) alongside set()
    // — a period-INDEPENDENT description of how this card's numbers have
    // moved across the whole project history, so Run Analysis can describe
    // fluctuation even though the on-screen sentence only covers whichever
    // single period is currently selected.
    setHistory: function (cardId, text) {
      if (text) historyFacts[cardId] = text; else delete historyFacts[cardId];
    },
    // The current rule-based facts (plus any history text) for every card
    // that has any right now — this is exactly what ai-analysis.js sends
    // to runProjectAnalysis, so the AI is always grounded in the same
    // numbers already on screen, plus how they've moved over time.
    getFacts: function () {
      var out = {};
      Object.keys(latestFacts).forEach(function (id) {
        if (!latestFacts[id]) return;
        out[id] = historyFacts[id] ? { current: latestFacts[id], history: historyFacts[id] } : latestFacts[id];
      });
      return out;
    },
    getMode: function () { return insightMode; },
    // Called by ai-analysis.js right after a successful Run Analysis, and
    // by this file's own Firestore listener below whenever another tab/
    // session updates it.
    applyAnalysisResult: function (result) {
      cachedCardText = (result && result.cardText) || {};
      cachedCardTextExec = (result && result.cardTextExec) || {};
      rerenderAll();
    }
  };

  if (window.drAiVersion) window.drAiVersion.onChange(function () { rerenderAll(); });

  function applyMode(mode) {
    var next = mode === 'ai' ? 'ai' : 'standard';
    if (next === insightMode) return;
    insightMode = next;
    rerenderAll();
  }

  function waitForBusinessKey(cb) {
    if (window.BIZ_KEY) { cb(window.BIZ_KEY); return; }
    if (typeof window.waitForBusinessKey === 'function') {
      window.waitForBusinessKey(function (bizKey) { window.BIZ_KEY = bizKey; cb(bizKey); });
      return;
    }
    setTimeout(function () { waitForBusinessKey(cb); }, 150);
  }

  function init() {
    if (!window.db) { setTimeout(init, 150); return; }
    waitForBusinessKey(function (bizKey) {
      window.db.collection('businesses').doc(bizKey).onSnapshot(function (snap) {
        var data = (snap.exists && snap.data()) || {};
        applyMode(data.insightMode);
      }, function (err) {
        console.warn('[ai-insights] business doc listener failed', err);
      });
      // The AI-phrased card text comes from THIS project's last analysis (stored on the project doc).
      window.db.collection('businesses').doc(bizKey).collection('projects').doc(window.PROJECT_KEY || 'default').onSnapshot(function (snap) {
        var data = (snap.exists && snap.data()) || {};
        if (data.aiAnalysis) window.drInsight.applyAnalysisResult(data.aiAnalysis);
      }, function (err) {
        console.warn('[ai-insights] project doc listener failed', err);
      });
    });
  }

  init();
})();
