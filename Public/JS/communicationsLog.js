/* ============================================================================
   Communications Log — closes the loop on the Communications Plan by
   tracking whether each PLANNED communication actually went out on
   schedule. Distinct from Team Directory's ad-hoc email log (one-off
   sends to selected people) — this is specifically about the Communications
   Plan's own recurring cadence (audience/topic/frequency), read live from
   that same collection (never duplicated).

   Two parts:
     1. Plan Compliance — one row per Communications Plan item, showing when
        it was last actually logged as sent and whether that's within its
        planned frequency (On track/Due soon/Overdue) — computed here, not
        stored, from the frequency string Communications Plan already has
        and the most recent matching log entry.
     2. The log itself — append-only entries (date sent, channel used,
        notes), owner-only add/delete, no edit (a ledger, not a draft —
        same reasoning as Risk Reserve's draws and Team Directory's email
        log).

   Firestore:
     businesses/{biz}/projects/{proj}/communicationsPlan  (read-only here; owned by communicationsPlan.js)
     businesses/{biz}/projects/{proj}/communicationsLog/{id}
       { planItemId, planItemLabel, dateSent, channel, notes,
         sentBy, createdAt, createdBy, createdByUid }
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[communications-log]';
  var ctx = { biz: null, proj: null, userEmail: '', userUid: '', isOwner: false, planItems: [], logRows: [] };
  var card, complianceEl, tbody, planSel, dateInput, channelSel, notesInput, addBtn;

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var CHANNELS = ['Email', 'Meeting', 'Status Report', 'Dashboard', 'Phone/Call', 'Other'];
  var FREQUENCY_DAYS = { Daily: 1, Weekly: 7, Biweekly: 14, Monthly: 30, Quarterly: 90 };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function toDate(v) { if (!v) return null; if (v.toDate) return v.toDate(); var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtDate(v) { var d = toDate(v); return d ? (window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString()) : '—'; }
  function toDateInput(v) { var d = toDate(v) || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function canWrite() { return ctx.isOwner; }
  function isSample(id) { return String(id || '').indexOf('sample-') === 0; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }
  function logRef() { var p = projRef(); return p ? p.collection('communicationsLog') : null; }

  function planLabel(item) { return (item.audience || 'Untitled audience') + (item.topic ? ' — ' + item.topic : ''); }

  function lastSentFor(planItemId) {
    var matches = ctx.logRows.filter(function (r) { return r.planItemId === planItemId; })
      .map(function (r) { return toDate(r.dateSent); }).filter(Boolean);
    if (!matches.length) return null;
    return matches.reduce(function (m, d) { return d > m ? d : m; });
  }

  function complianceFor(item) {
    var threshold = FREQUENCY_DAYS[item.frequency];
    var last = lastSentFor(item.id);
    if (!threshold) return { code: 'none', label: last ? 'Last sent ' + fmtDate(last) : 'Not tracked (frequency: ' + (item.frequency || 'unset') + ')' };
    if (!last) return { code: 'red', label: 'Never logged' };
    var daysSince = (Date.now() - last.getTime()) / 86400000;
    if (daysSince <= threshold) return { code: 'green', label: 'On track — last sent ' + fmtDate(last) };
    if (daysSince <= threshold * 1.5) return { code: 'amber', label: 'Due soon — last sent ' + fmtDate(last) };
    return { code: 'red', label: 'Overdue — last sent ' + fmtDate(last) };
  }
  function statusClass(code) { return code === 'red' ? 'severity-high' : code === 'amber' ? 'severity-medium' : code === 'green' ? 'severity-low' : 'severity-unknown'; }

  function render() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('communicationsLogCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView) return;

    if (complianceEl) {
      if (!ctx.planItems.length) {
        complianceEl.innerHTML = '<p class="metrics-sample-banner">No Communications Plan items yet — add one on the Communications Plan card above.</p>';
      } else {
        complianceEl.innerHTML = '<table class="cl-compliance-table"><thead><tr><th>Audience / Topic</th><th>Frequency</th><th>Status</th></tr></thead><tbody>' +
          ctx.planItems.map(function (item) {
            var c = complianceFor(item);
            return '<tr><td>' + esc(planLabel(item)) + '</td><td>' + esc(item.frequency || '—') + '</td>' +
              '<td><span class="severity-badge ' + statusClass(c.code) + '">' + esc(c.label) + '</span></td></tr>';
          }).join('') + '</tbody></table>';
      }
    }

    if (tbody) {
      var rows = ctx.logRows.slice().sort(function (a, b) { return toDate(b.dateSent) - toDate(a.dateSent); });
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="metrics-empty">No communications logged yet.</td></tr>';
      } else {
        tbody.innerHTML = rows.map(function (r) {
          var delBtn = '<button type="button" class="delete-btn cl-del" data-id="' + esc(r.id) + '"' + (canWrite() ? '' : ' disabled aria-disabled="true" title="Owner only"') + '>🗑️</button>';
          return '<tr data-id="' + esc(r.id) + '">' +
            '<td>' + esc(fmtDate(r.dateSent)) + '</td>' +
            '<td>' + esc(r.planItemLabel) + '</td>' +
            '<td>' + esc(r.channel) + '</td>' +
            '<td class="wrap-text">' + esc(r.notes) + '</td>' +
            '<td>' + delBtn + '</td></tr>';
        }).join('');
      }
    }

    if (window.drInsight) {
      var overdue = ctx.planItems.filter(function (item) { return complianceFor(item).code === 'red'; });
      var text = ctx.planItems.length + ' planned communication' + (ctx.planItems.length === 1 ? '' : 's') + ' tracked.';
      if (overdue.length) text += ' ' + overdue.length + ' overdue.';
      window.drInsight.set('communicationsLogCard', ctx.planItems.length ? text : '');
    }
  }

  function setPlanOptions() {
    if (!planSel) return;
    var keep = planSel.value;
    planSel.innerHTML = '<option value="">' + (ctx.planItems.length ? 'Which planned communication' : 'No Communications Plan items yet') + '</option>' +
      ctx.planItems.map(function (item) { return '<option value="' + esc(item.id) + '">' + esc(planLabel(item)) + '</option>'; }).join('');
    planSel.value = keep;
  }

  function readForm() {
    var item = ctx.planItems.find(function (i) { return i.id === (planSel && planSel.value); });
    return {
      planItemId: item ? item.id : '', planItemLabel: item ? planLabel(item) : '',
      dateSent: dateInput.value ? new Date(dateInput.value + 'T00:00:00') : new Date(),
      channel: channelSel.value || '', notes: notesInput.value.trim()
    };
  }
  function clearForm() {
    if (notesInput) notesInput.value = '';
    if (dateInput) dateInput.value = toDateInput(new Date());
    if (planSel) planSel.value = '';
    if (channelSel) channelSel.value = '';
  }

  function addEntry() {
    if (!canWrite()) return;
    var data = readForm();
    if (!data.planItemId) { alert('Pick which planned communication this was.'); return; }
    var ref = logRef();
    if (!ref) return;
    data.createdAt = new Date(); data.createdBy = ctx.userEmail || ''; data.createdByUid = ctx.userUid || ''; data.sentBy = ctx.userEmail || '';
    ref.add(data).catch(function (err) { console.error(ns, 'addEntry error', err); alert('Could not save — please try again: ' + (err && err.message ? err.message : err)); });
    clearForm();
  }
  function deleteEntry(id) {
    if (!canWrite() || isSample(id)) return;
    var ref = logRef();
    if (!ref) return;
    var confirmed = window.drConfirm ? window.drConfirm('Delete this log entry? This cannot be undone.', { title: 'Delete Log Entry' }) : Promise.resolve(window.confirm('Delete this log entry?'));
    confirmed.then(function (ok) { if (ok) ref.doc(id).delete().catch(function (err) { console.error(ns, 'deleteEntry error', err); }); });
  }

  function bindEvents() {
    if (addBtn) addBtn.addEventListener('click', addEntry);
    if (tbody) tbody.addEventListener('click', function (ev) {
      var t = ev.target.closest('.cl-del');
      if (t) deleteEntry(t.getAttribute('data-id'));
    });
  }

  function listenPlan() {
    var p = projRef();
    if (!p) return;
    p.collection('communicationsPlan').onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.planItems = rows;
      setPlanOptions();
      render();
    }, function (err) { console.warn(ns, 'plan listen error', err && err.code); });
  }
  function listenLog() {
    var ref = logRef();
    if (!ref) return;
    ref.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.logRows = rows;
      render();
    }, function (err) { console.warn(ns, 'log listen error', err && err.code); });
  }

  function applyAccess() {
    var els = document.querySelectorAll('.cl-add-only');
    for (var i = 0; i < els.length; i++) els[i].style.display = canWrite() ? '' : 'none';
    render();
  }

  function init() {
    card = document.getElementById('communicationsLogCard');
    complianceEl = document.getElementById('clCompliance');
    tbody = document.querySelector('#communicationsLogTable tbody');
    planSel = document.getElementById('cl-plan-item'); dateInput = document.getElementById('cl-date');
    channelSel = document.getElementById('cl-channel'); notesInput = document.getElementById('cl-notes');
    addBtn = document.getElementById('cl-add');
    if (channelSel && !channelSel.options.length) {
      channelSel.innerHTML = '<option value="">Channel</option>' + CHANNELS.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    }
    if (dateInput && !dateInput.value) dateInput.value = toDateInput(new Date());

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    if (!ctx.biz || !card) return;

    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.userUid = (user && user.uid) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();

    bindEvents();
    listenPlan();
    listenLog();
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
