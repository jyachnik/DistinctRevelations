// Public/JS/ai-version.js
// Which WORDING of AI results this person sees: "executive" (short, C-level) or "detail" (the
// current technical version). Decided per role in Settings > Permissions ("AI wording —
// Executive version" / "— Detail version"; see dr-access-control.js canUseVersion). A role with
// both gets the Summary / Detail checkboxes on the Executive Overview card, and those checkboxes
// also pick the wording used for the card insights and Ask the Project's default.
//
// Loaded early (a plain <script>) like ai-insights.js, which uses it.

(function () {
  'use strict';

  var KEY = 'drAiViewState';
  var state = { summary: true, detail: false };   // Summary on, Detail off until the person changes it
  try {
    var saved = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved === 'object') state = { summary: saved.summary !== false, detail: saved.detail === true };
  } catch (e) { /* storage unavailable: defaults */ }

  var listeners = [];
  function notify() { listeners.slice().forEach(function (fn) { try { fn(); } catch (e) { console.warn('[ai-version] listener failed', e); } }); }

  // Before role/permissions resolve, behave like today (detail only); the ready event re-notifies.
  function allowed() {
    var a = window.drAccess;
    if (!a || !a.role) return { executive: false, detail: true };
    return { executive: !!a.canUseVersion('executive'), detail: !!a.canUseVersion('detail') };
  }

  // The checkbox state after applying what this person may have (never both off).
  function effective() {
    var al = allowed();
    if (!al.executive) return { summary: false, detail: true };
    if (!al.detail) return { summary: true, detail: false };
    var s = { summary: state.summary, detail: state.detail };
    if (!s.summary && !s.detail) s.summary = true;
    return s;
  }

  // Wording for things that show one text at a time (card insights, Ask's default):
  // executive only when the person may have it and Summary is ticked without Detail.
  function wording() {
    var al = allowed();
    if (al.executive && !al.detail) return 'executive';
    if (!al.executive) return 'detail';
    var e = effective();
    return (e.summary && !e.detail) ? 'executive' : 'detail';
  }

  window.drAiVersion = {
    allowed: allowed,
    effective: effective,
    wording: wording,
    // both wordings available -> the person gets to choose
    canChoose: function () { var al = allowed(); return al.executive && al.detail; },
    setState: function (patch) {
      state = { summary: patch && 'summary' in patch ? !!patch.summary : state.summary, detail: patch && 'detail' in patch ? !!patch.detail : state.detail };
      if (!state.summary && !state.detail) state.summary = true;   // never both off
      try { window.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
      notify();
    },
    onChange: function (fn) { listeners.push(fn); }
  };

  window.addEventListener('dr-access:ready', notify);
})();
