// Public/JS/language.js
// Portal-wide Language switcher. Loaded as an early, static <script> (not
// through the deferred module cascade) specifically so its MutationObserver
// is watching the page from the very first DOM change — every other card
// module renders its content well after this file has already started
// observing.
//
// How translation actually happens: a MutationObserver watches for new
// DOM content (every module in this app re-renders via .innerHTML, which
// removes old nodes and adds brand-new ones — this observer's childList
// scope catches that), walks any new text nodes, and batch-translates
// whatever isn't already cached through the translatePageText Cloud
// Function (see functions/index.js — that function proxies Google
// Translate's UNOFFICIAL public endpoint, not the paid API, so treat
// translation quality/availability as best-effort, not guaranteed).
//
// Known limitation: this only reaches plain DOM text nodes. Chart.js
// renders its own labels/legends onto a <canvas>, which isn't part of the
// DOM text tree at all — chart text stays in English regardless of the
// selected language. Fixing that would mean translating every chart's
// `label`/`labels` strings before construction, across ~15 separate
// render functions — out of scope for this pass.

(function () {
  'use strict';

  var TAG = '[language]';
  function log() { console.log.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function warn() { console.warn.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }

  var STORAGE_KEY = 'dr-language';
  var CACHE_KEY_PREFIX = 'dr-lang-cache-';

  // English pinned first and treated as the default — order here is the
  // order shown in the picker window.
  var LANGUAGES = [
    { code: 'en', name: 'English', native: 'English', isDefault: true },
    { code: 'es', name: 'Spanish', native: 'Español' },
    { code: 'fr', name: 'French', native: 'Français' },
    { code: 'de', name: 'German', native: 'Deutsch' },
    { code: 'pt', name: 'Portuguese', native: 'Português' },
    { code: 'it', name: 'Italian', native: 'Italiano' },
    { code: 'zh-CN', name: 'Chinese (Simplified)', native: '中文（简体）' },
    { code: 'ja', name: 'Japanese', native: '日本語' },
    { code: 'ko', name: 'Korean', native: '한국어' },
    { code: 'ar', name: 'Arabic', native: 'العربية' },
    { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
    { code: 'ru', name: 'Russian', native: 'Русский' }
  ];

  function getSavedLanguage() {
    try { return window.localStorage.getItem(STORAGE_KEY) || 'en'; } catch (e) { return 'en'; }
  }
  function saveLanguage(code) {
    try { window.localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* private/blocked storage — translation still works this load, just won't persist */ }
  }

  function loadCache(langCode) {
    try {
      var raw = window.localStorage.getItem(CACHE_KEY_PREFIX + langCode);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function saveCache(langCode, cache) {
    try { window.localStorage.setItem(CACHE_KEY_PREFIX + langCode, JSON.stringify(cache)); } catch (e) { /* over quota or blocked — cache just won't persist across reloads */ }
  }

  // ---------- Translation pipeline ----------
  var currentLang = 'en';
  var cache = {};
  var pendingNodes = []; // text nodes awaiting translation, collected between debounced scans
  var scanScheduled = false;
  var translating = false; // reentrancy guard — our own nodeValue writes shouldn't retrigger a scan storm

  function hasLetters(s) { return /[A-Za-z]/.test(s); }

  function collectTranslatableNodes(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        var tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'OPTION' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        if (parent.closest('[data-no-translate]')) return NodeFilter.FILTER_REJECT;
        var text = node.nodeValue;
        if (!text || !text.trim() || !hasLetters(text)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var out = [];
    var n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function applyTranslations(nodes, map) {
    translating = true;
    nodes.forEach(function (node) {
      // __drOriginal is remembered on first touch so re-translating (or a
      // future language switch) always starts from the true English
      // source, never from a previously-applied translation.
      var original = node.__drOriginal != null ? node.__drOriginal : node.nodeValue;
      var translated = map[original.trim()];
      if (translated) {
        node.__drOriginal = original;
        // Text nodes commonly carry leading/trailing whitespace from HTML
        // source indentation — preserved here rather than replacing the
        // whole value with the (trimmed) translation, which could run
        // adjacent text together.
        var leading = original.match(/^\s*/)[0];
        var trailing = original.match(/\s*$/)[0];
        node.nodeValue = leading + translated + trailing;
      }
    });
    translating = false;
  }

  function callTranslateFn(texts, targetLang) {
    if (!window.functions || typeof window.functions.httpsCallable !== 'function') {
      return Promise.reject(new Error('functions SDK not ready'));
    }
    var callable = window.functions.httpsCallable('translatePageText', { timeout: 30000 });
    return callable({ texts: texts, targetLang: targetLang }).then(function (result) {
      return (result.data && result.data.translations) || [];
    });
  }

  function runScan() {
    scanScheduled = false;
    if (currentLang === 'en' || translating) { pendingNodes = []; return; }

    var nodes = pendingNodes;
    pendingNodes = [];
    if (!nodes.length) return;

    // De-dupe by original text — no point asking the same short label to
    // be translated 40 times because it appears in 40 table rows.
    var uniqueTexts = [];
    var seen = {};
    var toTranslateMap = {}; // text -> already-cached translation, filled in below

    nodes.forEach(function (node) {
      var text = node.__drOriginal != null ? node.__drOriginal : node.nodeValue;
      var key = text.trim();
      if (!key) return;
      if (cache[key]) return; // already known — applied below without a network call
      if (!seen[key]) { seen[key] = true; uniqueTexts.push(key); }
    });

    // Apply whatever's already cached immediately, regardless of whether
    // anything new needs a network round-trip.
    applyTranslations(nodes, cache);

    if (!uniqueTexts.length) return;

    callTranslateFn(uniqueTexts, currentLang).then(function (translations) {
      uniqueTexts.forEach(function (text, i) {
        if (translations[i]) cache[text] = translations[i];
      });
      saveCache(currentLang, cache);
      applyTranslations(nodes, cache);
    }).catch(function (err) {
      warn('translation request failed', err);
    });
  }

  function scheduleScan(root) {
    var nodes = collectTranslatableNodes(root);
    if (nodes.length) {
      pendingNodes = pendingNodes.concat(nodes);
      if (!scanScheduled) {
        scanScheduled = true;
        setTimeout(runScan, 500);
      }
    }
  }

  var observer = null;
  function startObserving() {
    if (observer) return;
    observer = new MutationObserver(function (mutations) {
      if (translating) return;
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (added) {
          if (added.nodeType === Node.TEXT_NODE) {
            scheduleScan(added.parentElement || document.body);
          } else if (added.nodeType === Node.ELEMENT_NODE) {
            scheduleScan(added);
          }
        });
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function activateLanguage(code) {
    currentLang = code;
    if (code === 'en') return;
    cache = loadCache(code);
    startObserving();
    scheduleScan(document.body);
  }

  // ---------- Public API ----------
  // Called by the picker popup (via window.opener) when a language is
  // chosen. Persists the choice and reloads — a full reload is the
  // simplest reliable way to guarantee every card, including ones that
  // haven't rendered yet this session, gets picked up by the observer
  // from its very first paint rather than translated haphazardly mid-way
  // through an already-loaded page.
  window.drApplyLanguage = function (code) {
    saveLanguage(code);
    window.location.reload();
  };
  window.drResetLanguage = function () {
    saveLanguage('en');
    window.location.reload();
  };

  function openLanguageWindow() {
    var saved = getSavedLanguage();
    var rows = LANGUAGES.map(function (l) {
      var isCurrent = l.code === saved;
      return '<button type="button" class="lang-row' + (isCurrent ? ' lang-row-current' : '') + '" data-code="' + l.code + '">' +
        '<span class="lang-name">' + l.name + (l.isDefault ? ' <em>(Default)</em>' : '') + '</span>' +
        '<span class="lang-native">' + l.native + '</span>' +
        (isCurrent ? '<span class="lang-check">&#10003;</span>' : '') +
        '</button>';
    }).join('');

    // The literal word "Language" in the title is never translated —
    // deliberately not run through this page's own translation pipeline
    // (this is a wholly separate popup window/document, outside the main
    // page's DOM, so the observer there can't reach it anyway) — so
    // anyone who picks a language they can't read can always find their
    // way back here by the one word that stays legible.
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>Language</title><style>' +
      'body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:20px;color:#222;background:#fff;}' +
      'h1{font-size:1.15rem;margin:0 0 4px;}' +
      'p.sub{color:#666;font-size:0.82rem;margin:0 0 16px;}' +
      '.lang-list{display:flex;flex-direction:column;gap:6px;margin-bottom:18px;}' +
      '.lang-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid #e0e0e0;border-radius:6px;background:#fff;cursor:pointer;font-size:0.9rem;text-align:left;}' +
      '.lang-row:hover{background:#f5f7fa;border-color:#004e92;}' +
      '.lang-row-current{border-color:#004e92;background:#eef4fb;}' +
      '.lang-name em{color:#898781;font-style:normal;font-size:0.78rem;}' +
      '.lang-native{color:#666;}' +
      '.lang-check{color:#004e92;font-weight:700;}' +
      '.reset-row{border-top:1px solid #e0e0e0;padding-top:14px;}' +
      '#resetBtn{width:100%;padding:10px 12px;border:1px solid #dd3333;border-radius:6px;background:#fff;color:#dd3333;font-size:0.9rem;cursor:pointer;}' +
      '#resetBtn:hover{background:#fdecec;}' +
      '#note{font-size:0.75rem;color:#898781;margin-top:14px;}' +
      '</style></head><body>' +
      '<h1>Language</h1>' +
      '<p class="sub">Choose the portal\'s display language. Selecting one reloads the portal.</p>' +
      '<div class="lang-list">' + rows + '</div>' +
      '<div class="reset-row"><button type="button" id="resetBtn">Reset to English</button></div>' +
      '<p id="note">Machine-translated — wording may not always be exact.</p>' +
      '<script>' +
      'document.querySelectorAll(".lang-row").forEach(function(btn){' +
      'btn.addEventListener("click", function(){' +
      'if (window.opener && window.opener.drApplyLanguage) window.opener.drApplyLanguage(btn.getAttribute("data-code"));' +
      'window.close();' +
      '});});' +
      'document.getElementById("resetBtn").addEventListener("click", function(){' +
      'if (window.opener && window.opener.drResetLanguage) window.opener.drResetLanguage();' +
      'window.close();' +
      '});' +
      '</' + 'script>' +
      '</body></html>';

    var win = window.open('', '_blank', 'width=420,height=560');
    if (!win) { alert('Please allow pop-ups to choose a Language.'); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  window.drOpenLanguageWindow = openLanguageWindow;

  // ---------- Boot ----------
  var saved = getSavedLanguage();
  if (saved !== 'en') {
    // If the DOM isn't ready yet, wait — observing from before any body
    // content exists is fine, the observer just has nothing to do until
    // nodes start appearing.
    if (document.body) {
      activateLanguage(saved);
    } else {
      document.addEventListener('DOMContentLoaded', function () { activateLanguage(saved); });
    }
  }
  log('initialized, current language =', saved);
})();
