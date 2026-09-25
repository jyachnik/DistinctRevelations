// Public/JS/ai-analysis.js
// The "Project Analysis" panel above the Gantt Timeline — a 1-2 sentence
// executive summary plus a short flagged-questions list, considering
// every card and every import together, generated on demand by the
// Owner via the "Run Analysis" button (never automatically — a full
// analysis reads across the whole project and costs more than a single
// card's rephrase). Calls the runProjectAnalysis Cloud Function, which
// writes its result to businesses/{biz}.aiAnalysis; this file both shows
// that result immediately on a successful run AND listens live so a run
// from another tab/session (or another Owner) shows up here too.
// Owner-only, same as every other owner-only metrics card.

(function () {
  'use strict';

  var OWNER_EMAIL = (window.APP_CONFIG && window.APP_CONFIG.OWNER_EMAIL) || window.ownerEmail || '';
  var OWNER_LIST = (window.APP_CONFIG && window.APP_CONFIG.OWNERS) || [];

  function isOwnerEmail(email) {
    email = (email || '').toLowerCase();
    return (OWNER_EMAIL && email === OWNER_EMAIL.toLowerCase()) ||
      OWNER_LIST.map(function (e) { return (e || '').toLowerCase(); }).indexOf(email) !== -1;
  }

  function waitForBusinessKey(cb) {
    if (window.BIZ_KEY) { cb(window.BIZ_KEY); return; }
    if (typeof window.waitForBusinessKey === 'function') {
      window.waitForBusinessKey(function (bizKey) { window.BIZ_KEY = bizKey; cb(bizKey); });
      return;
    }
    setTimeout(function () { waitForBusinessKey(cb); }, 150);
  }

  function fmtWhen(d) {
    if (!d) return '';
    try {
      return window.drDateFmt ? window.drDateFmt.dateTime(d) : d.toLocaleString();
    } catch (e) { return d.toLocaleString(); }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; });
  }

  var watchItemsById = {}; // index -> item, for the "…more detail" popup

  function watchItemMetaHtml(item) {
    return (item.who ? '<p><strong>Who:</strong> ' + escapeHtml(item.who) + '</p>' : '') +
      (item.why ? '<p><strong>Why:</strong> ' + escapeHtml(item.why) + '</p>' : '') +
      (item.when ? '<p><strong>When:</strong> ' + escapeHtml(item.when) + '</p>' : '') +
      (item.expectedResult ? '<p><strong>Expected result:</strong> ' + escapeHtml(item.expectedResult) + '</p>' : '');
  }

  function watchItemHtml(item, i) {
    // Older saved analyses (before this structure existed) may still be a
    // plain string — render those as a bare finding with no meta row
    // rather than breaking.
    if (typeof item === 'string') {
      return '<li class="ai-watch-item"><div class="ai-watch-what">' + escapeHtml(item) + '</div></li>';
    }
    watchItemsById[i] = item;
    var hasMeta = item.who || item.why || item.when || item.expectedResult;
    return '<li class="ai-watch-item">' +
      '<div class="ai-watch-what">' + escapeHtml(item.what) +
      (hasMeta ? ' <button type="button" class="ai-watch-viewmore" data-item-id="' + i + '">…more detail</button>' : '') +
      '</div>' +
    '</li>';
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.ai-watch-viewmore');
    if (!btn) return;
    var item = watchItemsById[btn.getAttribute('data-item-id')];
    if (!item || !window.drModal) return;
    window.drModal.open({ title: item.what, bodyHtml: watchItemMetaHtml(item) });
  });

  // ---- Executive (Summary) wording ------------------------------------------------------------
  var lastData = null;

  function execHtml(ex) {
    var h = '<p class="ai-exec-headline">' + escapeHtml(ex.headline) + '</p>';
    if (ex.assessment) h += '<p class="ai-exec-assessment">' + escapeHtml(ex.assessment) + '</p>';
    if (ex.keyMessages && ex.keyMessages.length) {
      h += '<ul class="ai-exec-messages">' + ex.keyMessages.map(function (m) { return '<li>' + escapeHtml(m) + '</li>'; }).join('') + '</ul>';
    }
    if (ex.risksToObjectives && ex.risksToObjectives.length) {
      h += '<h3 class="ai-exec-h">Exposure to objectives</h3><ul class="ai-exec-cards">' + ex.risksToObjectives.map(function (r) {
        return '<li><strong>' + escapeHtml(r.risk) + '</strong>' +
          (r.businessImpact ? '<span><em>Impact:</em> ' + escapeHtml(r.businessImpact) + '</span>' : '') +
          (r.response ? '<span><em>Response:</em> ' + escapeHtml(r.response) + '</span>' : '') + '</li>';
      }).join('') + '</ul>';
    }
    if (ex.decisionsNeeded && ex.decisionsNeeded.length) {
      h += '<h3 class="ai-exec-h">Decisions needed from leadership</h3><ul class="ai-exec-cards ai-exec-decisions">' + ex.decisionsNeeded.map(function (d) {
        return '<li><strong>' + escapeHtml(d.decision) + '</strong>' +
          (d.by ? '<span><em>By:</em> ' + escapeHtml(d.by) + '</span>' : '') +
          (d.consequence ? '<span><em>If not:</em> ' + escapeHtml(d.consequence) + '</span>' : '') + '</li>';
      }).join('') + '</ul>';
    }
    if (ex.outlook) h += '<p class="ai-exec-outlook"><strong>Outlook:</strong> ' + escapeHtml(ex.outlook) + '</p>';
    return h;
  }

  function renderExec(card, data) {
    var box = card.querySelector('#aiExecBlock');
    if (!box) return;
    if (!data || !data.executiveSummary) {
      box.innerHTML = '<p class="ai-analysis-summary is-placeholder">No analysis has been run for this project yet. The project owner runs it from this card.</p>';
    } else if (!data.executive) {
      box.innerHTML = '<p class="ai-analysis-summary is-placeholder">There is no executive summary for this analysis yet — it was run before that existed, or the executive step did not complete. Run the analysis again to generate it.</p>';
    } else {
      box.innerHTML = execHtml(data.executive);
    }
  }

  // Which block(s) this person sees: Summary and/or Detail, within what their role may have.
  function applyView(card) {
    var V = window.drAiVersion;
    if (!V) return;
    var eff = V.effective();
    var exec = card.querySelector('#aiExecBlock'), det = card.querySelector('#aiDetailBlock');
    var tog = card.querySelector('#aiViewToggle');
    var cs = card.querySelector('#aiViewSummary'), cd = card.querySelector('#aiViewDetail');
    if (exec) exec.hidden = !eff.summary;
    if (det) det.hidden = !eff.detail;
    if (exec && det) card.classList.toggle('ai-both-views', eff.summary && eff.detail);
    if (tog) tog.hidden = !V.canChoose();
    if (cs) cs.checked = eff.summary;
    if (cd) cd.checked = eff.detail;
  }

  function wireView(card) {
    var V = window.drAiVersion;
    var cs = card.querySelector('#aiViewSummary'), cd = card.querySelector('#aiViewDetail');
    if (!V || !cs || !cd || cs.getAttribute('data-wired')) return;
    cs.setAttribute('data-wired', '1');
    function changed() { V.setState({ summary: cs.checked, detail: cd.checked }); }
    cs.addEventListener('change', changed);
    cd.addEventListener('change', changed);
    V.onChange(function () { applyView(card); });
    applyView(card);
  }

  function render(card, data) {
    lastData = data;
    renderExec(card, data);
    applyView(card);
    var summaryEl = card.querySelector('#aiAnalysisSummary');
    var prevReviewEl = card.querySelector('#aiAnalysisPrevReview');
    var listEl = card.querySelector('#aiAnalysisWatchlist');
    var metaEl = card.querySelector('#aiAnalysisMeta');

    if (!data || !data.executiveSummary) {
      if (summaryEl) { summaryEl.textContent = 'Click "Run Analysis" to generate an executive summary across every card and import in this project.'; summaryEl.classList.add('is-placeholder'); }
      if (prevReviewEl) { prevReviewEl.hidden = true; prevReviewEl.textContent = ''; }
      if (listEl) { listEl.hidden = true; listEl.innerHTML = ''; }
      if (metaEl) metaEl.textContent = '';
      return;
    }

    if (summaryEl) { summaryEl.textContent = data.executiveSummary; summaryEl.classList.remove('is-placeholder'); }

    if (prevReviewEl) {
      if (data.previousStepsReview) {
        prevReviewEl.hidden = false;
        prevReviewEl.innerHTML = '<strong>Since last analysis:</strong> ' + escapeHtml(data.previousStepsReview);
      } else {
        prevReviewEl.hidden = true;
        prevReviewEl.textContent = '';
      }
    }

    var items = Array.isArray(data.watchItems) ? data.watchItems : [];
    if (listEl) {
      if (items.length) {
        listEl.hidden = false;
        listEl.innerHTML = items.map(watchItemHtml).join('');
      } else {
        listEl.hidden = true;
        listEl.innerHTML = '';
      }
    }

    if (metaEl) {
      var when = data.generatedAt && data.generatedAt.toDate ? data.generatedAt.toDate() : (data.generatedAt ? new Date(data.generatedAt) : null);
      metaEl.textContent = when ? 'Last analyzed: ' + fmtWhen(when) : '';
    }
  }

  function init() {
    var card = document.getElementById('aiAnalysisCard');
    var runBtn = document.getElementById('aiAnalysisRunBtn');
    if (!card) return;

    if (!window.db || !window.functions) { setTimeout(init, 150); return; }

    waitForBusinessKey(function (bizKey) {
      // Waits for dr-access-control.js to resolve role/permissions before
      // deciding canView — unlike the other card modules (which re-run a
      // standalone render function once access resolves), this one wires
      // its Firestore listener and Run Analysis button INSIDE the gate
      // itself, so there's no separate render call to safely re-invoke;
      // deferring the whole block avoids ever wiring anything off a
      // stale "not ready yet" read.
      var readyPromise = window.drAccess ? window.drAccess.whenReady() : Promise.resolve();
      readyPromise.then(function () {
      var user = (window.auth && window.auth.currentUser) || {};
      var isOwner = isOwnerEmail(user.email);
      var canView = isOwner || (window.drAccess && window.drAccess.canViewReport('aiAnalysisCard'));
      card.classList.toggle('owner', isOwner);
      card.classList.toggle('report-access-granted', canView);
      wireView(card);
      // Run Analysis calls a paid Cloud Function (Anthropic API) and
      // rewrites every card's insight text project-wide — owner-only
      // regardless of who else can view this card's summary.
      if (runBtn) runBtn.hidden = !isOwner;
      if (!canView) return;

      // The analysis result is stored per PROJECT.
      var docRef = window.db.collection('businesses').doc(bizKey).collection('projects').doc(window.PROJECT_KEY || 'default');
      docRef.onSnapshot(function (snap) {
        var data = (snap.exists && snap.data()) || {};
        render(card, data.aiAnalysis);
      }, function (err) {
        console.warn('[ai-analysis] listener failed', err);
      });

      if (runBtn) {
        runBtn.addEventListener('click', function () {
          if (runBtn.disabled) return;
          runBtn.disabled = true;
          var originalLabel = runBtn.textContent;
          runBtn.textContent = 'Analyzing…';
          if (window.drProgress) window.drProgress.show('Reading every card and import, and generating the analysis — this can take a minute…');

          var cardFacts = window.drInsight ? window.drInsight.getFacts() : {};
          // Default callable timeout is 70s — rewriting every card plus the
          // summary in one response can run longer than that, so this needs
          // to match the Cloud Function's own 480s timeout or the client
          // gives up on a request that's still successfully working server-side.
          var callable = window.functions.httpsCallable('runProjectAnalysis', { timeout: 480000 });
          callable({ bizKey: bizKey, projKey: window.PROJECT_KEY || 'default', cardFacts: cardFacts }).then(function (result) {
            if (window.drInsight) window.drInsight.applyAnalysisResult(result.data);
            render(card, Object.assign({}, result.data, { generatedAt: new Date() }));
          }).catch(function (err) {
            console.error('[ai-analysis] runProjectAnalysis failed', err);
            alert('Could not run analysis: ' + (err && err.message ? err.message : err));
          }).finally(function () {
            runBtn.disabled = false;
            runBtn.textContent = originalLabel;
            if (window.drProgress) window.drProgress.hide();
          });
        });
      }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
