/* ============================================================================
   Team Charter — how THIS project's team agrees to work together: mission,
   values, working agreements, communication norms, decision-making, and
   conflict resolution. Distinct from Project Charter (a real uploaded
   document defining the PROJECT's purpose/sponsor/scope) and Team
   Directory (the contact roster) — this is the team's own working
   agreement, owner-editable, single document (not a list/log).

   Sample content shown (with a banner) until the owner saves real
   content — same "sample until replaced" convention as every other new
   card this session.

   Firestore: businesses/{biz}/projects/{proj}/teamCharter/main
   Fields: { mission, values, workingAgreements, communicationNorms,
             decisionMaking, conflictResolution,
             updatedAt, updatedBy }
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[team-charter]';
  var FIELDS = ['mission', 'values', 'workingAgreements', 'communicationNorms', 'decisionMaking', 'conflictResolution'];

  var SAMPLE = {
    mission: 'Deliver a reliable, well-communicated project by treating every teammate’s time and attention as a shared resource — we’d rather over-communicate a risk early than surprise each other with it late.',
    values: '• Transparency — say the real status, not the hoped-for one.\n• Ownership — if you see it, you own getting it tracked, even if it isn’t "your" task.\n• Respect for focus time — default to async updates; reserve meetings for decisions that actually need a room.\n• Blameless problem-solving — defects and slips are the process’s problem to fix, not a person’s fault to assign.',
    workingAgreements: '• Update your own tasks’ status before end of day, not just before standup.\n• A blocked task gets flagged in Q&A the same day it’s discovered — not at the next status meeting.\n• Core collaboration hours: 10am–3pm project time zone; outside that, replies land next business day.\n• Code/deliverable reviews get a first pass within 1 business day.',
    communicationNorms: '• Status updates: weekly written summary, posted the same day every week.\n• Urgent/blocking issues: flagged immediately via Q&A + direct message, not left for the weekly summary.\n• Decisions: logged in the Decision Log with rationale, not just discussed verbally and forgotten.\n• Meetings: agenda shared beforehand; notes and action items captured the same day.',
    decisionMaking: 'Day-to-day delivery decisions are made by whoever owns that piece of work. Scope, budget, or schedule-impacting decisions go through Change Control. When there’s no clear owner, the Project Manager makes the call after a brief round of input — we optimize for a timely decision over a perfect consensus.',
    conflictResolution: 'Raise a disagreement directly with the other person first, in good faith. If it’s not resolved within a couple of days, bring it to the Project Manager for a decision. Disagreements about facts get settled by checking the actual data (the dashboard, the documents) before anyone’s opinion.'
  };

  var LABELS = {
    mission: 'Team Mission / Purpose',
    values: 'Core Values',
    workingAgreements: 'Working Agreements / Ground Rules',
    communicationNorms: 'Communication Norms',
    decisionMaking: 'Decision-Making Approach',
    conflictResolution: 'Conflict Resolution Approach'
  };

  var ctx = { biz: null, proj: null, userEmail: '', isOwner: false, data: null };
  var card, bodyEl, banner;
  var inputs = {}, saveBtn, statusEl;

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function docRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default').collection('teamCharter').doc('main');
  }

  function canWrite() { return ctx.isOwner; }

  function paint() {
    if (!card || !bodyEl) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('teamCharterCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView) return;

    var usingSample = !ctx.data;
    var data = ctx.data || SAMPLE;
    if (banner) banner.hidden = !usingSample;

    FIELDS.forEach(function (f) {
      if (inputs[f] && document.activeElement !== inputs[f]) inputs[f].value = data[f] || '';
    });

    var viewEl = document.getElementById('tcReadOnlyView');
    if (viewEl) {
      viewEl.innerHTML = FIELDS.map(function (f) {
        return '<div class="tc-field-view"><h4>' + esc(LABELS[f]) + '</h4><p>' + (data[f] ? nl2br(data[f]) : '<span class="tc-empty">Not set.</span>') + '</p></div>';
      }).join('');
    }

    if (window.drInsight) {
      window.drInsight.set('teamCharterCard', usingSample ? 'Showing sample team charter content — the owner can edit and save the real one.' : 'Team charter last updated' + (data.updatedBy ? ' by ' + data.updatedBy : '') + '.');
    }
  }

  function save() {
    if (!canWrite()) return;
    var ref = docRef();
    if (!ref) return;
    var payload = {};
    FIELDS.forEach(function (f) { payload[f] = inputs[f] ? inputs[f].value.trim() : ''; });
    payload.updatedAt = new Date();
    payload.updatedBy = ctx.userEmail || '';
    if (statusEl) statusEl.textContent = 'Saving…';
    ref.set(payload, { merge: true })
      .then(function () { if (statusEl) statusEl.textContent = 'Saved.'; })
      .catch(function (err) {
        console.error(ns, 'save error', err);
        if (statusEl) statusEl.textContent = 'Could not save: ' + (err && err.message ? err.message : err);
      });
  }

  function applyWriteAccess() {
    var addOnlyEls = document.querySelectorAll('.tc-add-only');
    for (var i = 0; i < addOnlyEls.length; i++) addOnlyEls[i].style.display = canWrite() ? '' : 'none';
    var readOnlyEls = document.querySelectorAll('.tc-read-only');
    for (var j = 0; j < readOnlyEls.length; j++) readOnlyEls[j].style.display = canWrite() ? 'none' : '';
    paint();
  }

  function listen() {
    var ref = docRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      ctx.data = (snap.exists && Object.keys(snap.data() || {}).length) ? snap.data() : null;
      paint();
    }, function (err) { console.warn(ns, 'listen error (expected if not granted view access)', err && err.code); });
  }

  function detectContext() {
    card = document.getElementById('teamCharterCard');
    bodyEl = document.getElementById('tcBody');
    banner = document.getElementById('teamCharterSampleBanner');
    FIELDS.forEach(function (f) { inputs[f] = document.getElementById('tc-' + f); });
    saveBtn = document.getElementById('tc-save');
    statusEl = document.getElementById('tc-status');

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function init() {
    detectContext();
    if (!ctx.biz || !card) return;
    if (saveBtn) saveBtn.addEventListener('click', save);
    listen();
    if (window.drAccess) window.drAccess.whenReady().then(applyWriteAccess);
    else applyWriteAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
