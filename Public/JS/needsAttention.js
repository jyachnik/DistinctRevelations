/* ============================================================================
   Needs Attention — a single feed aggregating overdue/urgent items across
   cards that otherwise only surface if you visit each one individually.
   The underlying item data itself is still read-only, reused as-is from
   the SAME collections/fields each source card already reads (project doc
   riskRegister/issueLog/qualityDefects, and the dependencies/signoffs/
   changeRequests/decisions/qna/milestones subcollections), so it can never
   show something that disagrees with what's on that card.

   Each entry also carries which document/card it came from (shown inline,
   not just implied by the click-through) and an owner-checkable "Reviewed"
   box. Checking it prompts for a Resolution and an optional "what was
   learned" note, then stamps date/time/who; all of that is stored in its
   OWN collection (needsAttentionAck), NOT as new fields on the source
   records — several of those (changeRequests especially) have narrow,
   decision-specific update rules that a generic "mark reviewed" write
   would violate. See firestore.rules's needsAttentionAck block.

   Save Report compiles every reviewed item (straight from
   needsAttentionAck, so a resolved item that's since dropped off the
   live "needs attention" list is still included) into a timestamped
   snapshot in needsAttentionReports — issue/risk, resolution, who
   resolved it, when, and what was learned, one row per reviewed item.
   Past snapshots stay listed under Saved Reports.

   "Needs attention" per source (stated plainly since these are judgment
   calls, not something the data itself labels):
     - Risks:          open AND score (probability x impact) >= 15 (high)
     - Issues:         open AND (severity Critical/High OR past target resolution date)
     - Defects:        open AND severity Critical/High
     - Dependencies:   not Resolved AND past need-by date
     - Sign-offs:      decision pending AND past due date
     - Change Requests: still pending (owner or sponsor) after 7+ days
     - Decisions:       still Proposed after 7+ days
     - Q&A:             not completed AND past due date
     - Meeting action items: not done AND past due date

   Each row links back (click) to the card it came from via
   window.drScrollToId (report-index.js).

   Firestore:
     businesses/{biz}/projects/{proj}                         (riskRegister[], issueLog[], qualityDefects[], read-only)
     businesses/{biz}/projects/{proj}/dependencies             (read-only)
     businesses/{biz}/projects/{proj}/signoffs                 (read-only)
     businesses/{biz}/projects/{proj}/changeRequests           (read-only)
     businesses/{biz}/projects/{proj}/decisions                (read-only)
     businesses/{biz}/projects/{proj}/qna                      (read-only)
     businesses/{biz}/projects/{proj}/milestones                (actionItems[], read-only)
     businesses/{biz}/projects/{proj}/needsAttentionAck/{id}
       (owner-writable: { group, itemId, title, doc, reviewedAt, reviewedBy, reviewedByUid, resolution, lessonLearned })
     businesses/{biz}/projects/{proj}/needsAttentionReports/{id}
       (owner-writable: { generatedAt, generatedBy, items: [{group, doc, title, resolution, lessonLearned, reviewedBy, reviewedAt}] })
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[needs-attention]';
  var MAX_PER_GROUP = 8;
  var PENDING_AGE_DAYS = 7;

  // Human-readable "document" name per source — shown inline on each entry
  // so it's clear which record needs to be opened and updated to resolve it,
  // not just implied by clicking the title.
  var DOC_LABELS = {
    risks: 'Risk Register',
    issues: 'Issue Log',
    defects: 'Quality Defects Log',
    dependencies: 'Dependencies Log',
    signoffs: 'Deliverable Sign-off',
    changeRequests: 'Change Control Log',
    decisions: 'Decision Log',
    qna: 'Q&A Tracker',
    actionItems: 'Milestone Minutes / Action Items'
  };

  var ctx = {
    biz: null, proj: null, isOwner: false, userEmail: '', userUid: '',
    risks: [], issues: [], defects: [],
    dependencies: [], signoffs: [], changeRequests: [], decisions: [], qna: [], milestones: [],
    ack: {}, // key ("<group>__<itemId>") -> { reviewedAt, reviewedBy }
    expanded: {} // group key -> true once "Show N more" has been clicked
  };
  var card, bodyEl;

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function toDate(v) { if (!v) return null; if (v.toDate) return v.toDate(); var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtDate(v) { var d = toDate(v); return d ? (window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString()) : ''; }
  function fmtDateTime(v) { var d = toDate(v); return d ? (d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : ''; }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
  function isOpenStatus(status) { return !/^(closed|resolved|done|complete|completed|cancelled)$/i.test(String(status || '').trim()); }
  function daysAgo(v) { var d = toDate(v); return d ? Math.floor((Date.now() - d.getTime()) / 86400000) : null; }
  function overdue(v, today) { var d = toDate(v); return !!(d && d < today); }
  function ackKey(group, itemId) { return group + '__' + itemId; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }
  function ackRef(key) {
    var p = projRef();
    return p ? p.collection('needsAttentionAck').doc(key) : null;
  }

  // ---------------------------------------------------------------------------
  // Build the grouped, sorted list of "needs attention" items
  // ---------------------------------------------------------------------------
  function buildGroups() {
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var groups = [];

    var riskItems = (ctx.risks || []).filter(function (r) {
      return isOpenStatus(r.status) && ((num(r.probability) || 0) * (num(r.impact) || 0)) >= 15;
    }).map(function (r) {
      var score = (num(r.probability) || 0) * (num(r.impact) || 0);
      return { id: r.id || r.description, title: r.description || 'Untitled risk', detail: 'Score ' + score + (r.owner ? ' — ' + r.owner : ''), sortKey: -score };
    });
    groups.push({ key: 'risks', label: 'High-Exposure Open Risks', cardId: 'riskRegisterCard', items: riskItems });

    var issueItems = (ctx.issues || []).filter(function (x) {
      if (!isOpenStatus(x.status)) return false;
      var sev = String(x.severity || '').toLowerCase();
      return sev === 'critical' || sev === 'high' || overdue(x.targetResolutionDate, today);
    }).map(function (x) {
      var isOverdue = overdue(x.targetResolutionDate, today);
      return { id: x.id || x.description, title: x.description || 'Untitled issue', detail: (x.severity || 'Unspecified severity') + (isOverdue ? ' — overdue since ' + fmtDate(x.targetResolutionDate) : ''), sortKey: isOverdue ? -1000 : 0 };
    });
    groups.push({ key: 'issues', label: 'Open Issues (Critical/High or Overdue)', cardId: 'issueLogCard', items: issueItems });

    var defectItems = (ctx.defects || []).filter(function (x) {
      if (!isOpenStatus(x.status)) return false;
      var sev = String(x.severity || '').toLowerCase();
      return sev === 'critical' || sev === 'high';
    }).map(function (x) { return { id: x.id || x.description, title: x.description || 'Untitled defect', detail: (x.severity || '') + (x.assignedTo ? ' — ' + x.assignedTo : ''), sortKey: 0 }; });
    groups.push({ key: 'defects', label: 'Open Defects (Critical/High)', cardId: 'qualityDefectsCard', items: defectItems });

    var depItems = (ctx.dependencies || []).filter(function (d) {
      return d.status !== 'Resolved' && overdue(d.needByDate, today);
    }).map(function (d) { return { id: d.id, title: d.title || ((d.predecessorTitle || '') + ' → ' + (d.successorTitle || '')), detail: 'Needed by ' + fmtDate(d.needByDate) + (d.owner ? ' — ' + d.owner : ''), sortKey: -(today - toDate(d.needByDate)) }; });
    groups.push({ key: 'dependencies', label: 'Overdue Dependencies', cardId: 'dependenciesCard', items: depItems });

    var signoffItems = (ctx.signoffs || []).filter(function (s) {
      return (s.decision || 'pending') === 'pending' && overdue(s.dueDate, today);
    }).map(function (s) { return { id: s.id, title: s.title || 'Untitled deliverable', detail: 'Due ' + fmtDate(s.dueDate) + (s.kind ? ' — ' + s.kind : ''), sortKey: -(today - toDate(s.dueDate)) }; });
    groups.push({ key: 'signoffs', label: 'Overdue Sign-offs', cardId: 'deliverableSignoffCard', items: signoffItems });

    var crItems = (ctx.changeRequests || []).filter(function (c) {
      var ownerDecision = c.ownerDecision || 'pending', sponsorDecision = c.sponsorDecision || (c.needsSponsorApproval ? 'pending' : 'n/a');
      var pending = ownerDecision === 'pending' || sponsorDecision === 'pending';
      var age = daysAgo(c.createdAt);
      return pending && age != null && age >= PENDING_AGE_DAYS;
    }).map(function (c) { return { id: c.id, title: c.title || 'Untitled change request', detail: 'Pending ' + daysAgo(c.createdAt) + ' days — ' + (c.priority || ''), sortKey: -(daysAgo(c.createdAt) || 0) }; });
    groups.push({ key: 'changeRequests', label: 'Long-Pending Change Requests', cardId: 'changeControlLogCard', items: crItems });

    var decItems = (ctx.decisions || []).filter(function (d) {
      var age = daysAgo(d.createdAt);
      return d.status === 'Proposed' && age != null && age >= PENDING_AGE_DAYS;
    }).map(function (d) { return { id: d.id, title: d.title || 'Untitled decision', detail: 'Proposed ' + daysAgo(d.createdAt) + ' days ago' + (d.category ? ' — ' + d.category : ''), sortKey: -(daysAgo(d.createdAt) || 0) }; });
    groups.push({ key: 'decisions', label: 'Long-Proposed Decisions', cardId: 'decisionLogCard', items: decItems });

    var qnaItems = (ctx.qna || []).filter(function (q) { return !q.completed && overdue(q.dueDate, today); })
      .map(function (q) { return { id: q.id, title: q.message || 'Untitled item', detail: (q.type || 'Item') + ' — overdue since ' + fmtDate(q.dueDate) + (q.assignedTo ? ' — ' + q.assignedTo : ''), sortKey: -(today - toDate(q.dueDate)) }; });
    groups.push({ key: 'qna', label: 'Overdue Q&A / Tasks', cardId: 'qnaSummaryCard', items: qnaItems });

    var actionItems = [];
    (ctx.milestones || []).forEach(function (m) {
      (m.actionItems || []).forEach(function (a, idx) {
        if (a.done) return;
        if (!overdue(a.dueDate, today)) return;
        actionItems.push({ id: m.id + '_ai' + idx, title: a.text || 'Untitled action item', detail: 'From "' + (m.title || 'a meeting') + '" — overdue since ' + fmtDate(a.dueDate) + (a.owner ? ' — ' + a.owner : ''), sortKey: -(today - toDate(a.dueDate)) });
      });
    });
    groups.push({ key: 'actionItems', label: 'Overdue Meeting Action Items', cardId: 'milestoneSection', items: actionItems });

    groups.forEach(function (g) {
      g.doc = DOC_LABELS[g.key] || g.label;
      g.items.forEach(function (it) { it.group = g.key; });
      g.items.sort(function (a, b) { return a.sortKey - b.sortKey; });
    });
    return groups.filter(function (g) { return g.items.length; });
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function render() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('needsAttentionCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    var saveReportBtn = document.getElementById('naSaveReportBtn');
    if (saveReportBtn) saveReportBtn.style.display = ctx.isOwner ? '' : 'none';
    if (!canView || !bodyEl) return;

    var groups = buildGroups();
    var totalCount = groups.reduce(function (n, g) { return n + g.items.length; }, 0);

    if (!groups.length) {
      bodyEl.innerHTML = '<p class="metrics-sample-banner">Nothing needs attention right now — every tracked item is current or accounted for.</p>';
      if (window.drInsight) window.drInsight.set('needsAttentionCard', 'Nothing needs attention right now.');
      return;
    }

    bodyEl.innerHTML = groups.map(function (g) {
      var isExpanded = !!ctx.expanded[g.key];
      var shown = isExpanded ? g.items : g.items.slice(0, MAX_PER_GROUP);
      var more = g.items.length - shown.length;
      var itemsHtml = shown.map(function (it) {
        var key = ackKey(it.group, it.id);
        var ack = ctx.ack[key];
        var checkbox = '<input type="checkbox" class="na-reviewed-checkbox" data-group="' + esc(it.group) + '" data-id="' + esc(it.id) + '" data-title="' + esc(it.title) + '" data-doc="' + esc(g.doc) + '"' +
          (ack ? ' checked' : '') + (ctx.isOwner ? '' : ' disabled') + ' title="' + (ctx.isOwner ? 'Mark reviewed' : 'Owner only') + '" />';
        var reviewedNote = ack ? '<div class="na-item-reviewed">✓ Reviewed ' + esc(fmtDateTime(ack.reviewedAt)) + (ack.reviewedBy ? ' by ' + esc(ack.reviewedBy) : '') + '</div>' +
          (ack.resolution ? '<div class="na-item-resolution"><strong>Resolution:</strong> ' + esc(ack.resolution) + '</div>' : '') +
          (ack.lessonLearned ? '<div class="na-item-lesson"><strong>Lesson learned:</strong> ' + esc(ack.lessonLearned) + '</div>' : '') : '';
        return '<li class="na-entry' + (ack ? ' na-entry-reviewed' : '') + '">' +
          '<label class="na-check">' + checkbox + '</label>' +
          '<div class="na-entry-body">' +
          '<button type="button" class="na-item-link" data-card="' + esc(g.cardId) + '">' + esc(it.title) + '</button>' +
          (it.detail ? ' <span class="na-item-detail">' + esc(it.detail) + '</span>' : '') +
          '<div class="na-item-doc">Document: <button type="button" class="na-doc-link" data-card="' + esc(g.cardId) + '">' + esc(g.doc) + '</button></div>' +
          reviewedNote +
          '</div></li>';
      }).join('');
      var moreHtml = more > 0
        ? '<li class="na-more"><button type="button" class="na-more-btn" data-group="' + esc(g.key) + '">Show ' + more + ' more</button></li>'
        : (isExpanded && g.items.length > MAX_PER_GROUP
          ? '<li class="na-more"><button type="button" class="na-more-btn" data-group="' + esc(g.key) + '">Show fewer</button></li>'
          : '');
      return '<div class="na-group"><h4>' + esc(g.label) + ' <span class="na-group-count">(' + g.items.length + ')</span></h4><ul class="na-item-list">' + itemsHtml + moreHtml + '</ul></div>';
    }).join('');

    if (window.drInsight) window.drInsight.set('needsAttentionCard', totalCount + ' item' + (totalCount === 1 ? '' : 's') + ' across ' + groups.length + ' area' + (groups.length === 1 ? '' : 's') + ' need attention.');
  }

  // ---------------------------------------------------------------------------
  // "Reviewed" checkbox — writes/deletes a doc in needsAttentionAck, never
  // touches the source record itself (see file header for why). Checking
  // it opens a small compose prompt for Resolution / What was learned
  // (both saved onto the ack doc, along with the item's own title/doc
  // label so a later Save Report can build a report from ack data alone,
  // even once the underlying item is no longer "needing attention").
  // ---------------------------------------------------------------------------
  function unmarkReviewed(group, itemId) {
    if (!ctx.isOwner) return;
    var ref = ackRef(ackKey(group, itemId));
    if (!ref) return;
    ref.delete().catch(function (err) { console.error(ns, 'unmarkReviewed error', err); });
  }

  function openReviewCompose(group, itemId, title, docLabel) {
    if (!ctx.isOwner || !window.drModal) return;
    var html = '<label class="td-compose-field">Resolution<textarea id="na-resolution-input" rows="3" placeholder="What was done to resolve this?"></textarea></label>' +
      '<label class="td-compose-field">What was learned (optional)<textarea id="na-lesson-input" rows="3" placeholder="Anything worth remembering for next time?"></textarea></label>' +
      '<div class="td-compose-actions"><button type="button" id="na-resolve-save" class="primary">Save &amp; Mark Reviewed</button><span id="na-resolve-status" class="doc-share-status"></span></div>';
    window.drModal.open({ title: 'Mark Reviewed — ' + title, bodyHtml: html });
    var saveBtn = document.getElementById('na-resolve-save');
    if (saveBtn) saveBtn.addEventListener('click', function () { saveReview(group, itemId, title, docLabel); });
  }

  function saveReview(group, itemId, title, docLabel) {
    var resolutionEl = document.getElementById('na-resolution-input');
    var lessonEl = document.getElementById('na-lesson-input');
    var statusEl = document.getElementById('na-resolve-status');
    var ref = ackRef(ackKey(group, itemId));
    if (!ref) return;
    var ts = (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue && window.firebase.firestore.FieldValue.serverTimestamp()) || new Date();
    ref.set({
      group: group, itemId: itemId, title: title || '', doc: docLabel || '',
      reviewedAt: ts, reviewedBy: ctx.userEmail || '', reviewedByUid: ctx.userUid || '',
      resolution: resolutionEl ? resolutionEl.value.trim() : '',
      lessonLearned: lessonEl ? lessonEl.value.trim() : ''
    }).then(function () { if (window.drModal) window.drModal.close(); })
      .catch(function (err) {
        console.error(ns, 'saveReview error', err);
        if (statusEl) statusEl.textContent = 'Could not save: ' + (err && err.message ? err.message : err);
      });
  }

  function bindEvents() {
    if (!bodyEl) return;
    bodyEl.addEventListener('click', function (ev) {
      var moreBtn = ev.target.closest('.na-more-btn');
      if (moreBtn) {
        var group = moreBtn.getAttribute('data-group');
        ctx.expanded[group] = !ctx.expanded[group];
        render();
        return;
      }
      var btn = ev.target.closest('.na-item-link, .na-doc-link');
      if (!btn) return;
      var cardId = btn.getAttribute('data-card');
      if (cardId && window.drScrollToId) window.drScrollToId(cardId);
    });
    bodyEl.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || !t.classList || !t.classList.contains('na-reviewed-checkbox')) return;
      var group = t.getAttribute('data-group'), id = t.getAttribute('data-id');
      if (t.checked) {
        // Revert the native checkbox now — the real checked state comes
        // back from the Firestore snapshot once the compose prompt is
        // actually saved, so cancelling it leaves nothing behind.
        t.checked = false;
        openReviewCompose(group, id, t.getAttribute('data-title') || '', t.getAttribute('data-doc') || '');
      } else {
        unmarkReviewed(group, id);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Save Report — compiles every currently-reviewed item (straight from
  // needsAttentionAck, NOT the live "needs attention" filter, since a
  // resolved item usually no longer qualifies as needing attention and
  // would otherwise disappear from a report about it) into one timestamped
  // snapshot doc. Each ack doc already carries its own title/doc label
  // (captured at review time — see saveReview above), so this needs no
  // cross-referencing back to the source records.
  // ---------------------------------------------------------------------------
  function reportItemsFromAck() {
    return Object.keys(ctx.ack).map(function (key) {
      var a = ctx.ack[key] || {};
      return {
        group: a.group || '', doc: a.doc || DOC_LABELS[a.group] || '', title: a.title || '(untitled item)',
        resolution: a.resolution || '', lessonLearned: a.lessonLearned || '',
        reviewedBy: a.reviewedBy || '', reviewedAt: a.reviewedAt || null
      };
    }).sort(function (x, y) { return (toDate(y.reviewedAt) || 0) - (toDate(x.reviewedAt) || 0); });
  }

  function reportBodyHtml(items) {
    if (!items.length) return '<p>No reviewed items yet — check an item off above (with its resolution and what was learned) before saving a report.</p>';
    var rows = items.map(function (it) {
      return '<tr><td>' + esc(it.doc) + '</td><td>' + esc(it.title) + '</td>' +
        '<td>' + (it.resolution ? esc(it.resolution) : '—') + '</td>' +
        '<td>' + (it.reviewedBy ? esc(it.reviewedBy) : '—') + '</td>' +
        '<td>' + esc(fmtDateTime(it.reviewedAt)) + '</td>' +
        '<td>' + (it.lessonLearned ? esc(it.lessonLearned) : '—') + '</td></tr>';
    }).join('');
    return '<div class="metrics-table-wrap na-report-table-wrap"><table class="na-report-table">' +
      '<thead><tr><th>Source</th><th>Issue / Risk</th><th>Resolution</th><th>Resolved By</th><th>Date</th><th>Lesson Learned</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function showReport(title, items) {
    if (!window.drModal) return;
    window.drModal.open({ title: title, bodyHtml: reportBodyHtml(items) });
  }

  function saveReport() {
    if (!ctx.isOwner) return;
    var p = projRef();
    if (!p) return;
    var items = reportItemsFromAck();
    var ts = new Date();
    p.collection('needsAttentionReports').add({ generatedAt: ts, generatedBy: ctx.userEmail || '', items: items })
      .then(function () { showReport('Needs Attention Report — ' + fmtDateTime(ts), items); refreshSavedList(); })
      .catch(function (err) {
        console.error(ns, 'saveReport error', err);
        alert('Could not save report: ' + (err && err.message ? err.message : err));
      });
  }

  function refreshSavedList() {
    var p = projRef();
    var listEl = document.getElementById('naSavedList');
    if (!p || !listEl) return;
    p.collection('needsAttentionReports').orderBy('generatedAt', 'desc').limit(25).get().then(function (snap) {
      if (snap.empty) { listEl.innerHTML = '<li class="na-more">No saved reports yet.</li>'; return; }
      listEl.innerHTML = snap.docs.map(function (d) {
        var r = d.data() || {};
        return '<li><button type="button" class="na-saved-report-btn" data-id="' + esc(d.id) + '">' +
          esc(fmtDateTime(r.generatedAt)) + (r.generatedBy ? ' — ' + esc(r.generatedBy) : '') +
          ' (' + (Array.isArray(r.items) ? r.items.length : 0) + ' item' + ((Array.isArray(r.items) && r.items.length === 1) ? '' : 's') + ')</button></li>';
      }).join('');
    }).catch(function (err) { console.warn(ns, 'refreshSavedList error', err && err.code); });
  }

  function openSavedReport(id) {
    var p = projRef();
    if (!p) return;
    p.collection('needsAttentionReports').doc(id).get().then(function (doc) {
      if (!doc.exists) return;
      var r = doc.data() || {};
      showReport('Needs Attention Report — ' + fmtDateTime(r.generatedAt), Array.isArray(r.items) ? r.items : []);
    }).catch(function (err) { console.warn(ns, 'openSavedReport error', err && err.code); });
  }

  function bindReportEvents() {
    var saveBtn = document.getElementById('naSaveReportBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveReport);
    var listEl = document.getElementById('naSavedList');
    if (listEl) {
      listEl.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.na-saved-report-btn');
        if (btn) openSavedReport(btn.getAttribute('data-id'));
      });
      refreshSavedList();
    }
  }

  // ---------------------------------------------------------------------------
  // Live listeners — same collections each source card already reads.
  // ---------------------------------------------------------------------------
  function listenAll() {
    var p = projRef();
    if (!p) return;
    p.onSnapshot(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      ctx.risks = Array.isArray(data.riskRegister) ? data.riskRegister : [];
      ctx.issues = Array.isArray(data.issueLog) ? data.issueLog : [];
      ctx.defects = Array.isArray(data.qualityDefects) ? data.qualityDefects : [];
      render();
    }, function (err) { console.warn(ns, 'project doc listen error', err && err.code); });

    p.collection('dependencies').onSnapshot(function (snap) {
      ctx.dependencies = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data() || {}); });
      render();
    }, function (err) { console.warn(ns, 'dependencies listen error', err && err.code); });

    p.collection('signoffs').onSnapshot(function (snap) {
      ctx.signoffs = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data() || {}); });
      render();
    }, function (err) { console.warn(ns, 'signoffs listen error', err && err.code); });

    p.collection('changeRequests').onSnapshot(function (snap) {
      ctx.changeRequests = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data() || {}); });
      render();
    }, function (err) { console.warn(ns, 'changeRequests listen error', err && err.code); });

    p.collection('decisions').onSnapshot(function (snap) {
      ctx.decisions = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data() || {}); });
      render();
    }, function (err) { console.warn(ns, 'decisions listen error', err && err.code); });

    p.collection('qna').onSnapshot(function (snap) {
      ctx.qna = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data() || {}); });
      render();
    }, function (err) { console.warn(ns, 'qna listen error', err && err.code); });

    p.collection('milestones').onSnapshot(function (snap) {
      ctx.milestones = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data() || {}); });
      render();
    }, function (err) { console.warn(ns, 'milestones listen error', err && err.code); });

    p.collection('needsAttentionAck').onSnapshot(function (snap) {
      var ack = {};
      snap.forEach(function (doc) { ack[doc.id] = doc.data() || {}; });
      ctx.ack = ack;
      render();
    }, function (err) { console.warn(ns, 'needsAttentionAck listen error (expected if not granted view access)', err && err.code); });
  }

  function init() {
    card = document.getElementById('needsAttentionCard');
    bodyEl = document.getElementById('naBody');
    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    if (!ctx.biz || !card) return;

    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.userUid = (user && user.uid) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();

    bindEvents();
    bindReportEvents();
    listenAll();
    if (window.drAccess) window.drAccess.whenReady().then(render);
    else render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
