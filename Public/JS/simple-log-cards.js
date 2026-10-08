/* ============================================================================
   Simple log cards — a small factory for append-style, one-row-per-period
   records: real-time list, add/edit/delete, owner-only writes, sample rows
   until a real entry exists. Same shape as the other list cards built this
   session (Baseline Change, Cost of Quality, …), generalized so it isn't
   rewritten five times for near-identical Agile-ceremony artifacts:
     Release Plan, Daily Stand-up Notes, Sprint Review/Demo Notes,
     Sprint Retrospective Notes, Release Notes
   (instantiated in agile-log-cards.js).

   Firestore: businesses/{biz}/projects/{proj}/{collectionName}/{id}
   Fields: one per config field key, plus createdAt/By/ByUid, updatedAt/By.
   ============================================================================ */

(function () {
  'use strict';

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function serverTs() { return window.firebase.firestore.FieldValue.serverTimestamp(); }
  function toDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    var d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(v) {
    var d = toDate(v);
    if (!d) return '—';
    return window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString();
  }
  function toDateInput(v) {
    var d = toDate(v);
    if (!d) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function isSample(id) { return String(id || '').indexOf('sample-') === 0; }

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  // cfg: { cardId, collectionName, bodyPrefix, dateField,
  //        fields: [{key, label, type: 'text'|'textarea'|'date'|'select'}],
  //        sample: [{id, ...fields}] }
  function buildSimpleLogCard(cfg) {
    var ns = '[' + cfg.cardId + ']';
    var ctx = { biz: null, proj: null, userEmail: '', userUid: '', isOwner: false, rows: [], editingId: null };
    var card, tbody, banner, addBtn, cancelBtn, inputs = {};

    function projDocRef() {
      var db = getDB();
      if (!db || !ctx.biz) return null;
      return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
    }
    function colRef() { var p = projDocRef(); return p ? p.collection(cfg.collectionName) : null; }

    // Owner-only, end to end (same shape as Stakeholder Register/Team Directory) —
    // there's nothing here for the Permissions matrix to gate per-role, so this is
    // a plain isOwner check, not window.drAccess.canUseAction.
    function canWrite() { return ctx.isOwner; }
    function canActOn(id) { return canWrite() && !isSample(id); }
    function tipFor(id) { return isSample(id) ? 'Sample data — add a real entry first' : 'Only the owner can do this.'; }

    function sortValue(r) { var d = toDate(r[cfg.dateField]); return d ? d.getTime() : 0; }

    function paint() {
      if (!card) return;
      var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(cfg.cardId));
      card.classList.toggle('owner', ctx.isOwner);
      card.classList.toggle('report-access-granted', canView);
      if (!canView || !tbody) return;

      var usingSample = !ctx.rows.length;
      if (banner) banner.hidden = !usingSample;
      var rows = (usingSample ? cfg.sample : ctx.rows).slice().sort(function (a, b) { return sortValue(b) - sortValue(a); });

      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="' + (cfg.fields.length + 1) + '" class="metrics-empty">No entries yet.</td></tr>';
      } else {
        tbody.innerHTML = rows.map(function (r) {
          var tip = tipFor(r.id);
          var cells = cfg.fields.map(function (f) {
            var v = r[f.key];
            return '<td' + (f.type === 'textarea' ? ' class="wrap-text"' : '') + '>' + (f.type === 'date' ? esc(fmtDate(v)) : esc(v)) + '</td>';
          }).join('');
          return '<tr data-id="' + esc(r.id) + '">' + cells +
            '<td class="actions">' +
            '<button type="button" class="edit-btn ' + cfg.bodyPrefix + '-edit" data-id="' + esc(r.id) + '"' +
              (canActOn(r.id) ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>✏️</button>' +
            '<button type="button" class="delete-btn ' + cfg.bodyPrefix + '-del" data-id="' + esc(r.id) + '"' +
              (canActOn(r.id) ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>🗑️</button>' +
            '</td></tr>';
        }).join('');
      }

      if (window.drInsight) {
        var text = rows.length + ' entr' + (rows.length === 1 ? 'y' : 'ies') + (usingSample ? ' (sample data)' : '');
        window.drInsight.set(cfg.cardId, rows.length ? text : '');
      }
    }

    function readForm() {
      var payload = {};
      cfg.fields.forEach(function (f) {
        var el = inputs[f.key];
        if (!el) return;
        payload[f.key] = f.type === 'date' ? (el.value ? new Date(el.value + 'T00:00:00') : null) : el.value.trim();
      });
      return payload;
    }
    function clearForm() { cfg.fields.forEach(function (f) { if (inputs[f.key]) inputs[f.key].value = ''; }); }
    function resetEdit() {
      ctx.editingId = null;
      addBtn.textContent = 'Add';
      if (cancelBtn) cancelBtn.style.display = 'none';
      clearForm();
    }
    function fail(what, err) {
      console.error(ns, what + ' failed', err);
      alert('Could not ' + what + ': ' + (err && err.message ? err.message : err));
    }

    function save() {
      if (!canWrite()) return;
      var required = cfg.fields[0], reqEl = required && inputs[required.key];
      if (reqEl && !String(reqEl.value || '').trim()) return;
      var ref = colRef();
      if (!ref) return;
      var payload = readForm();
      if (ctx.editingId) {
        payload.updatedAt = serverTs(); payload.updatedBy = ctx.userEmail;
        ref.doc(ctx.editingId).update(payload).catch(function (err) { fail('save', err); });
        resetEdit();
        return;
      }
      payload.createdAt = serverTs(); payload.createdBy = ctx.userEmail; payload.createdByUid = ctx.userUid;
      ref.add(payload).catch(function (err) { fail('save', err); });
      clearForm();
    }
    function startEdit(id) {
      var row = ctx.rows.find(function (x) { return x.id === id; });
      if (!row || !canActOn(id)) return;
      ctx.editingId = id;
      cfg.fields.forEach(function (f) {
        var el = inputs[f.key];
        if (!el) return;
        el.value = f.type === 'date' ? toDateInput(row[f.key]) : (row[f.key] || '');
      });
      addBtn.textContent = 'Update';
      if (cancelBtn) cancelBtn.style.display = '';
    }
    function remove(id) {
      if (!canActOn(id)) return;
      var confirmed = window.drConfirm
        ? window.drConfirm('Delete this entry? This cannot be undone.', { title: 'Delete Entry' })
        : Promise.resolve(window.confirm('Delete this entry?'));
      confirmed.then(function (ok) {
        if (!ok) return;
        colRef().doc(id).delete().catch(function (err) { fail('delete', err); });
      });
    }

    function applyAccess() {
      var nodes = document.querySelectorAll('#' + cfg.cardId + ' .' + cfg.bodyPrefix + '-add-only');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el === cancelBtn) { if (!canWrite()) el.style.display = 'none'; continue; }
        el.style.display = canWrite() ? '' : 'none';
      }
      paint();
    }

    function bindEvents() {
      tbody.addEventListener('click', function (ev) {
        var t = ev.target.closest('button');
        if (!t) return;
        var id = t.getAttribute('data-id');
        if (t.classList.contains(cfg.bodyPrefix + '-edit')) startEdit(id);
        else if (t.classList.contains(cfg.bodyPrefix + '-del')) remove(id);
      });
      addBtn.addEventListener('click', save);
      if (cancelBtn) cancelBtn.addEventListener('click', resetEdit);
    }

    function listen() {
      var ref = colRef();
      if (!ref) return;
      ref.onSnapshot(function (snap) {
        var rows = [];
        snap.forEach(function (d) { var x = d.data() || {}; x.id = d.id; rows.push(x); });
        ctx.rows = rows;
        paint();
      }, function (err) { console.warn(ns, 'listen error (expected if not a project member)', err && err.code); });
    }

    function detectContext() {
      card = document.getElementById(cfg.cardId);
      tbody = document.querySelector('#' + cfg.bodyPrefix + 'Table tbody');
      cfg.fields.forEach(function (f) { inputs[f.key] = document.getElementById(cfg.bodyPrefix + '-' + f.key); });
      addBtn = document.getElementById(cfg.bodyPrefix + '-add');
      cancelBtn = document.getElementById(cfg.bodyPrefix + '-cancel-edit');
      banner = document.getElementById(cfg.bodyPrefix + 'SampleBanner');

      ctx.biz = window.BIZ_KEY || window.businessKey || null;
      ctx.proj = window.PROJECT_KEY || 'default';
      var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
      ctx.userEmail = (user && user.email) || '';
      ctx.userUid = (user && user.uid) || '';
      ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
    }

    function init() {
      detectContext();
      if (!ctx.biz || !card || !tbody || !addBtn) return;
      bindEvents();
      listen();
      if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
      else applyAccess();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  }

  window.drBuildSimpleLogCard = buildSimpleLogCard;
})();
