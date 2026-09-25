/* ============================================================================
   Discrepancy Report — Settings, owner-only. An expert-business-analyst pass
   (the discrepancyAnalysis Cloud Function, see functions/discrepancy-handler.js)
   comparing every card's live data against the team's uploaded documents,
   AND against other cards, for real contradictions — never gaps or missing
   data, only two things that state something different about the same fact.

   Each run is saved as its own timestamped record (an audit trail, never
   overwritten) with a checklist: check a finding off once it's been fixed.
   Every finding carries 1+ "locations" — jump straight to the dashboard
   card and/or the exact spot in the source document that it's citing,
   reusing window.drScrollToId (report-index.js) and window.drDocViewer
   (the same Evidence-panel jump Ask the Project's citations already use).

   Firestore: businesses/{biz}/projects/{proj}/discrepancyReports/{id}
   Fields: { generatedAt, generatedBy, stats,
     findings: [{ id, summary, detail, severity, locations: [...],
                  fixed, fixedAt, fixedBy }] }
   Owner-only read AND write (see firestore.rules) — unlike every other
   collection this session, even project members cannot read this one.
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[discrepancy-report]';
  var ctx = { biz: null, proj: null, userEmail: '', isOwner: false, currentReportId: null, currentFindings: [] };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var SEVERITY_CLASS = { high: 'severity-high', medium: 'severity-medium', low: 'severity-low' };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function toDate(v) { if (!v) return null; if (v.toDate) return v.toDate(); var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtDateTime(v) { var d = toDate(v); return d ? (window.drDateFmt ? window.drDateFmt.dateTime(d) : d.toLocaleString()) : '—'; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }
  function reportsRef() { var p = projRef(); return p ? p.collection('discrepancyReports') : null; }

  function cardLabel(cardId) {
    var entry = window.drAllReportEntries && window.drAllReportEntries.find(function (r) { return r.id === cardId; });
    return entry ? entry.label : (cardId || 'Dashboard');
  }

  function locationButtonHtml(loc, idx) {
    if (loc.kind === 'document') {
      var label = (loc.docLabel || 'Document') + (loc.sectionTitle ? ' — ' + loc.sectionTitle : '');
      return '<button type="button" class="dr-loc-btn dr-loc-doc" data-idx="' + idx + '" title="Open this document at this section">📄 ' + esc(label) + '</button>';
    }
    return '<button type="button" class="dr-loc-btn dr-loc-card" data-idx="' + idx + '" title="Jump to this card on the dashboard">📌 ' + esc(cardLabel(loc.card)) + '</button>';
  }

  function findingHtml(f) {
    var badge = '<span class="severity-badge ' + (SEVERITY_CLASS[f.severity] || 'severity-unknown') + '">' + esc(f.severity || 'medium') + '</span>';
    var fixedStamp = f.fixed ? '<span class="dr-fixed-stamp">Fixed ' + esc(fmtDateTime(f.fixedAt)) + (f.fixedBy ? ' by ' + esc(f.fixedBy) : '') + '</span>' : '';
    var locs = (f.locations || []).map(function (loc, idx) { return locationButtonHtml(loc, idx); }).join(' ');
    return '<li class="dr-finding' + (f.fixed ? ' dr-finding-fixed' : '') + '" data-id="' + esc(f.id) + '">' +
      '<div class="dr-finding-row"><label><input type="checkbox" class="dr-fixed-check"' + (f.fixed ? ' checked' : '') + ' /> Fixed</label>' + badge + fixedStamp + '</div>' +
      '<div class="dr-finding-summary">' + esc(f.summary) + '</div>' +
      '<div class="dr-finding-detail">' + esc(f.detail) + '</div>' +
      '<div class="dr-finding-locs">' + locs + '</div>' +
      '</li>';
  }

  function renderFindings(findings) {
    var el = $('#drFindingsList');
    if (!el) return;
    if (!findings.length) { el.innerHTML = '<p class="metrics-sample-banner">No discrepancies found in this run.</p>'; return; }
    el.innerHTML = '<ul class="dr-finding-list">' + findings.map(findingHtml).join('') + '</ul>';
  }

  function bindFindingsEvents() {
    var el = $('#drFindingsList');
    if (!el || el.__wired) return;
    el.__wired = true;
    el.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.dr-loc-btn');
      if (!btn) return;
      var li = btn.closest('.dr-finding');
      var finding = ctx.currentFindings.find(function (f) { return f.id === li.getAttribute('data-id'); });
      if (!finding) return;
      var loc = finding.locations[parseInt(btn.getAttribute('data-idx'), 10)];
      if (!loc) return;
      if (window.drModal) window.drModal.close();
      if (loc.kind === 'document' && window.drDocViewer) {
        window.drDocViewer.open({ docId: loc.docId, docLabel: loc.docLabel, docTitle: loc.docTitle, phase: loc.phase, ext: loc.ext, sectionIndex: loc.sectionIndex, sectionTitle: loc.sectionTitle }, []);
      } else if (loc.kind === 'data' && window.drScrollToId) {
        setTimeout(function () { window.drScrollToId(loc.card); }, 50);
      }
    });
    el.addEventListener('change', function (ev) {
      var chk = ev.target.closest('.dr-fixed-check');
      if (!chk) return;
      var li = chk.closest('.dr-finding');
      var id = li.getAttribute('data-id');
      toggleFixed(id, chk.checked);
    });
  }

  function toggleFixed(findingId, fixed) {
    if (!ctx.currentReportId) return;
    var ref = reportsRef();
    if (!ref) return;
    var newFindings = ctx.currentFindings.map(function (f) {
      return f.id === findingId ? Object.assign({}, f, { fixed: fixed, fixedAt: fixed ? new Date() : null, fixedBy: fixed ? (ctx.userEmail || '') : '' }) : f;
    });
    ctx.currentFindings = newFindings;
    renderFindings(newFindings);
    ref.doc(ctx.currentReportId).update({ findings: newFindings }).catch(function (err) {
      console.error(ns, 'toggleFixed error', err);
      alert('Could not save — please try again: ' + (err && err.message ? err.message : err));
    });
  }

  function loadReport(id, findings) {
    ctx.currentReportId = id;
    ctx.currentFindings = findings || [];
    renderFindings(ctx.currentFindings);
  }

  function refreshSavedList() {
    var el = $('#drSavedList');
    if (!el) return;
    var ref = reportsRef();
    if (!ref) return;
    el.textContent = 'Loading…';
    ref.orderBy('generatedAt', 'desc').limit(50).get().then(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      if (!rows.length) { el.innerHTML = '<p class="metrics-sample-banner">No saved runs yet — click "Run New Analysis" above.</p>'; return; }
      el.innerHTML = '<ul class="dr-saved-list">' + rows.map(function (r) {
        var findings = r.findings || [];
        var fixedCount = findings.filter(function (f) { return f.fixed; }).length;
        return '<li><button type="button" class="dr-saved-open" data-report-id="' + esc(r.id) + '">' + esc(fmtDateTime(r.generatedAt)) +
          ' — ' + findings.length + ' finding' + (findings.length === 1 ? '' : 's') + (findings.length ? ' (' + fixedCount + ' fixed)' : '') +
          (r.generatedBy ? ' — ' + esc(r.generatedBy) : '') + '</button></li>';
      }).join('') + '</ul>';
      el.querySelectorAll('.dr-saved-open').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var row = rows.find(function (r) { return r.id === btn.getAttribute('data-report-id'); });
          if (row) loadReport(row.id, row.findings || []);
        });
      });
    }).catch(function (err) {
      console.error(ns, 'refreshSavedList error', err);
      el.innerHTML = '<p>Could not load saved runs.</p>';
    });
  }

  function runAnalysis() {
    var btn = $('#drRunBtn'), statusEl = $('#drRunStatus');
    var call = window.functions && window.functions.httpsCallable ? window.functions.httpsCallable('discrepancyAnalysis', { timeout: 300000 }) : null;
    if (!call) { if (statusEl) statusEl.textContent = 'Not available right now — try again in a moment.'; return; }
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Running analysis — this checks every uploaded document against every card, it can take a minute…';
    call({ bizKey: ctx.biz, projKey: ctx.proj }).then(function (res) {
      var data = (res && res.data) || {};
      var findings = Array.isArray(data.findings) ? data.findings : [];
      var payload = { generatedAt: new Date(), generatedBy: ctx.userEmail || '', stats: data.stats || {}, findings: findings };
      var ref = reportsRef();
      if (!ref) return;
      return ref.add(payload).then(function (docRef) {
        if (statusEl) statusEl.textContent = findings.length ? ('Done — ' + findings.length + ' discrepanc' + (findings.length === 1 ? 'y' : 'ies') + ' found.') : 'Done — no discrepancies found.';
        loadReport(docRef.id, findings);
        refreshSavedList();
      });
    }).catch(function (err) {
      console.error(ns, 'runAnalysis error', err);
      var code = String((err && err.code) || '').replace(/^functions\//, '');
      if (statusEl) statusEl.textContent = code === 'resource-exhausted' ? err.message : 'Could not run the analysis: ' + (err && err.message ? err.message : err);
    }).finally(function () { if (btn) btn.disabled = false; });
  }

  function openDialog() {
    if (!window.drModal) return;
    if (!ctx.isOwner) {
      window.drModal.open({ title: 'Discrepancy Report', bodyHtml: '<p>Only the Owner can open the Discrepancy Report.</p>' });
      return;
    }
    window.drModal.open({
      title: 'Discrepancy Report',
      boxClass: 'dr-modal-box-wide',
      bodyHtml:
        '<p class="dr-intro">Checks every card\'s live data against your uploaded documents, and against other cards, for real contradictions — not gaps or missing data. Owner-only.</p>' +
        '<div class="dr-run-row"><button type="button" id="drRunBtn" class="primary">Run New Analysis</button> <span id="drRunStatus" class="doc-share-status"></span></div>' +
        '<h4 id="drCurrentTitle" class="dr-section-h">Findings</h4>' +
        '<div id="drFindingsList"><p class="metrics-sample-banner">Run a new analysis, or pick a past run below.</p></div>' +
        '<h4 class="dr-section-h">Saved Runs</h4>' +
        '<div id="drSavedList">Loading…</div>'
    });
    var runBtn = $('#drRunBtn');
    if (runBtn) runBtn.addEventListener('click', runAnalysis);
    bindFindingsEvents();
    refreshSavedList();
  }

  function detectContext() {
    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function init() {
    detectContext();
    if (window.auth && window.auth.onAuthStateChanged) {
      window.auth.onAuthStateChanged(function () { detectContext(); });
    }
  }

  window.drOpenDiscrepancyReport = function () {
    detectContext();
    openDialog();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
