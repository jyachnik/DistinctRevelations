/* ============================================================================
   Benefits Realization / KPI Tracker — real-time add/edit/delete, modeled
   directly on team-directory.js's structure (live subcollection, owner-only-
   card visibility gating, owner-only write gating enforced at the Firestore
   rules layer — see firestore.rules's benefitsRealization block).

   Each KPI has a baseline value/date and a target value/date, then the owner
   logs dated ACTUAL READINGS over time (readings[], append-only via
   arrayUnion) — a real trend, not just a current snapshot. Status (On track/
   Behind pace/At risk/Achieved/No data) is auto-computed from the latest
   reading against baseline/target and how much of the baseline→target
   calendar window has elapsed — a KPI-specific formula, NOT the shared
   window.drRag (that one is date-only/duration-based and assumes a
   start/due pair, not a value trending toward a target; reusing it here
   would silently misreport every KPI).

   Firestore: businesses/{biz}/projects/{proj}/benefitsRealization/{doc}
   Fields: { title, kpiMetric, unit, owner, notes,
             baselineValue, baselineDate, targetValue, targetDate,
             readings: [{value, date, note, recordedAt, recordedBy}],
             createdAt, createdBy, createdByUid, updatedAt, updatedBy }
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[benefitsRealization]';

  var ctx = { biz: null, proj: null, userEmail: '', userUid: '', isOwner: false, rows: [], editingId: null };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var SAMPLE_BENEFITS = [
    {
      id: 'sample-1', title: 'Faster ticket resolution', kpiMetric: 'Avg. resolution time (hrs)', unit: 'hrs', owner: 'Support Lead',
      notes: 'Reduce average support ticket resolution time by adopting the new workflow.',
      baselineValue: 48, baselineDate: new Date('2026-01-06'), targetValue: 24, targetDate: new Date('2026-12-01'),
      readings: [
        { value: 48, date: new Date('2026-01-06'), note: 'Baseline reading', recordedAt: new Date('2026-01-06'), recordedBy: '' },
        { value: 39, date: new Date('2026-05-01'), note: '', recordedAt: new Date('2026-05-01'), recordedBy: '' },
        { value: 33, date: new Date('2026-09-01'), note: '', recordedAt: new Date('2026-09-01'), recordedBy: '' }
      ]
    },
    {
      id: 'sample-2', title: 'Customer satisfaction lift', kpiMetric: 'CSAT score', unit: '%', owner: 'Product Owner',
      notes: 'Raise customer satisfaction score after the redesigned onboarding ships.',
      baselineValue: 62, baselineDate: new Date('2026-01-06'), targetValue: 85, targetDate: new Date('2026-12-01'),
      readings: [
        { value: 62, date: new Date('2026-01-06'), note: 'Baseline reading', recordedAt: new Date('2026-01-06'), recordedBy: '' },
        { value: 64, date: new Date('2026-05-01'), note: '', recordedAt: new Date('2026-05-01'), recordedBy: '' }
      ]
    }
  ];

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function toDate(v) { if (!v) return null; if (v.toDate) return v.toDate(); var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtDate(v) { var d = toDate(v); return d ? (window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString()) : '—'; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function toInputDate(v) { var d = toDate(v); return d ? (d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())) : ''; }
  function fmtNum(n) { return typeof n === 'number' && !isNaN(n) ? (Math.round(n * 100) / 100).toString() : '—'; }
  function sortedReadings(row) { return (row.readings || []).slice().sort(function (a, b) { return toDate(a.date) - toDate(b.date); }); }

  var card, tbody;
  var titleInput, metricInput, unitInput, ownerInput, baselineValueInput, baselineDateInput, targetValueInput, targetDateInput, notesInput;
  var addBtn, cancelEditBtn;

  function canWrite() { return ctx.isOwner; }
  function canActOnRow(id) { return canWrite() && String(id || '').indexOf('sample-') !== 0; }

  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function benefitsRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default').collection('benefitsRealization');
  }

  // ---------------------------------------------------------------------------
  // Status — value progress (latest reading vs. baseline/target) compared
  // against how much of the baseline→target calendar window has elapsed.
  // ---------------------------------------------------------------------------
  function computeStatus(row) {
    var readings = sortedReadings(row);
    if (!readings.length) return { code: 'none', label: 'No data yet' };
    var latest = readings[readings.length - 1];
    var baseline = typeof row.baselineValue === 'number' ? row.baselineValue : null;
    var target = typeof row.targetValue === 'number' ? row.targetValue : null;
    if (baseline == null || target == null || target === baseline) return { code: 'none', label: 'No target set' };

    var valueProgress = ((latest.value - baseline) / (target - baseline)) * 100;
    if (valueProgress >= 100) return { code: 'done', label: 'Achieved' };

    var today = new Date();
    var targetDate = toDate(row.targetDate);
    if (targetDate && today > targetDate) return { code: 'red', label: 'Missed target date' };

    var baselineDate = toDate(row.baselineDate) || toDate(row.createdAt);
    if (!targetDate || !baselineDate || targetDate <= baselineDate) {
      if (valueProgress >= 75) return { code: 'green', label: 'On track' };
      if (valueProgress >= 40) return { code: 'amber', label: 'Behind' };
      return { code: 'red', label: 'At risk' };
    }

    var expected = Math.max(0, Math.min(100, ((today - baselineDate) / (targetDate - baselineDate)) * 100));
    var gap = expected - valueProgress;
    if (gap >= 40) return { code: 'red', label: 'At risk' };
    if (gap >= 15) return { code: 'amber', label: 'Behind pace' };
    return { code: 'green', label: 'On track' };
  }
  function statusClass(code) {
    if (code === 'red') return 'severity-high';
    if (code === 'amber') return 'severity-medium';
    if (code === 'green') return 'severity-low';
    return 'severity-unknown'; // done or none
  }

  // Thin 2px line, rounded ends, single hue tied to this KPI's own status,
  // a dashed target reference line, a dot on the latest point — same mark
  // language as the rest of this app's charts, sized to sit in a table cell.
  function sparkline(row, code) {
    var readings = sortedReadings(row);
    if (!readings.length) return '';
    var vals = readings.map(function (r) { return r.value; });
    if (typeof row.baselineValue === 'number') vals.push(row.baselineValue);
    if (typeof row.targetValue === 'number') vals.push(row.targetValue);
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (min === max) { min -= 1; max += 1; }
    var W = 100, H = 28, PAD = 4;
    function x(i) { return readings.length > 1 ? PAD + (i / (readings.length - 1)) * (W - PAD * 2) : W / 2; }
    function y(v) { return H - PAD - ((v - min) / (max - min)) * (H - PAD * 2); }
    var color = code === 'red' ? '#dd3333' : code === 'amber' ? '#e0a800' : code === 'done' ? '#898781' : '#2f9e44';
    var targetLine = typeof row.targetValue === 'number'
      ? '<line x1="0" y1="' + y(row.targetValue).toFixed(1) + '" x2="' + W + '" y2="' + y(row.targetValue).toFixed(1) + '" stroke="#999" stroke-width="1" stroke-dasharray="2,2" />' : '';
    var line = readings.length > 1
      ? '<polyline points="' + readings.map(function (r, i) { return x(i).toFixed(1) + ',' + y(r.value).toFixed(1); }).join(' ') + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />' : '';
    var last = readings[readings.length - 1];
    var dot = '<circle cx="' + x(readings.length - 1).toFixed(1) + '" cy="' + y(last.value).toFixed(1) + '" r="1.75" fill="' + color + '" stroke="#fff" stroke-width="1" />';
    return '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" class="br-spark">' + targetLine + line + dot + '</svg>';
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('benefitsRealizationCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    var usingSample = !ctx.rows || !ctx.rows.length;
    var banner = document.getElementById('benefitsRealizationSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var rows = usingSample ? SAMPLE_BENEFITS : ctx.rows;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="metrics-empty">No benefits/KPIs tracked yet.</td></tr>';
      return;
    }

    var counts = { green: 0, amber: 0, red: 0, done: 0, none: 0 };
    tbody.innerHTML = rows.map(function (r) {
      var canAct = canActOnRow(r.id);
      var disabledTitle = usingSample ? 'Sample data — add a real KPI to edit' : 'Owner only';
      var status = computeStatus(r);
      counts[status.code] = (counts[status.code] || 0) + 1;
      var readings = sortedReadings(r);
      var latest = readings.length ? readings[readings.length - 1] : null;
      var unit = r.unit ? (' ' + esc(r.unit)) : '';
      var latestText = latest ? (fmtNum(latest.value) + unit + ' <span class="br-latest-date">(' + esc(fmtDate(latest.date)) + ')</span>') : '—';
      var baseTarget = fmtNum(r.baselineValue) + unit + ' → ' + fmtNum(r.targetValue) + unit;
      var logBtn = '<button type="button" class="br-log" data-id="' + esc(r.id) + '"' + (canAct ? '' : ' disabled aria-disabled="true" title="' + disabledTitle + '"') + ' title="Log a reading">➕</button>';
      var histBtn = readings.length ? '<button type="button" class="br-hist" data-id="' + esc(r.id) + '" title="View readings">🕘</button>' : '';
      var editBtn = '<button type="button" class="edit-btn br-edit" data-id="' + esc(r.id) + '"' + (canAct ? '' : ' disabled aria-disabled="true" title="' + disabledTitle + '"') + '>✏️</button>';
      var delBtn = '<button type="button" class="delete-btn br-del" data-id="' + esc(r.id) + '"' + (canAct ? '' : ' disabled aria-disabled="true" title="' + disabledTitle + '"') + '>🗑️</button>';
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td>' + esc(r.title) + '</td>' +
        '<td>' + esc(r.kpiMetric) + '</td>' +
        '<td>' + baseTarget + '</td>' +
        '<td>' + latestText + '</td>' +
        '<td>' + sparkline(r, status.code) + '</td>' +
        '<td><span class="severity-badge ' + statusClass(status.code) + '">' + esc(status.label) + '</span></td>' +
        '<td>' + logBtn + histBtn + editBtn + delBtn + '</td></tr>';
    }).join('');

    if (window.drInsight) {
      var bits = [];
      if (counts.done) bits.push(counts.done + ' achieved');
      if (counts.green) bits.push(counts.green + ' on track');
      if (counts.amber) bits.push(counts.amber + ' behind pace');
      if (counts.red) bits.push(counts.red + ' at risk');
      if (counts.none) bits.push(counts.none + ' with no data yet');
      var text = rows.length + ' benefit' + (rows.length === 1 ? '' : 's') + ' tracked' + (bits.length ? ' — ' + bits.join(', ') + '.' : '.');
      if (usingSample) text += ' (sample data)';
      window.drInsight.set('benefitsRealizationCard', text);
    }
  }

  // ---------------------------------------------------------------------------
  // CRUD (definition fields only — readings[] is append-only, never touched here)
  // ---------------------------------------------------------------------------
  function readForm() {
    return {
      title: titleInput ? titleInput.value.trim() : '',
      kpiMetric: metricInput ? metricInput.value.trim() : '',
      unit: unitInput ? unitInput.value.trim() : '',
      owner: ownerInput ? ownerInput.value.trim() : '',
      notes: notesInput ? notesInput.value.trim() : '',
      baselineValue: baselineValueInput && baselineValueInput.value !== '' ? parseFloat(baselineValueInput.value) : null,
      baselineDate: baselineDateInput && baselineDateInput.value ? new Date(baselineDateInput.value + 'T00:00:00') : null,
      targetValue: targetValueInput && targetValueInput.value !== '' ? parseFloat(targetValueInput.value) : null,
      targetDate: targetDateInput && targetDateInput.value ? new Date(targetDateInput.value + 'T00:00:00') : null
    };
  }
  function clearForm() {
    [titleInput, metricInput, unitInput, ownerInput, baselineValueInput, targetValueInput, notesInput].forEach(function (el) { if (el) el.value = ''; });
    [baselineDateInput, targetDateInput].forEach(function (el) { if (el) el.value = ''; });
  }

  function addBenefit() {
    if (!titleInput || !canWrite()) return;
    var data = readForm();
    if (!data.title) return;
    var ref = benefitsRef();
    if (!ref) return;
    var ts = (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue && window.firebase.firestore.FieldValue.serverTimestamp()) || new Date();
    data.readings = [];
    data.createdAt = ts; data.createdBy = ctx.userEmail || ''; data.createdByUid = ctx.userUid || '';
    ref.add(data).catch(function (err) { console.error(ns, 'addBenefit error', err); alert('Could not save — please try again: ' + (err && err.message ? err.message : err)); });
    clearForm();
  }

  function startEdit(id) {
    var row = ctx.rows.find(function (r) { return r.id === id; });
    if (!row || !titleInput || !canActOnRow(id)) return;
    ctx.editingId = id;
    if (titleInput) titleInput.value = row.title || '';
    if (metricInput) metricInput.value = row.kpiMetric || '';
    if (unitInput) unitInput.value = row.unit || '';
    if (ownerInput) ownerInput.value = row.owner || '';
    if (baselineValueInput) baselineValueInput.value = typeof row.baselineValue === 'number' ? row.baselineValue : '';
    if (baselineDateInput) baselineDateInput.value = toInputDate(row.baselineDate);
    if (targetValueInput) targetValueInput.value = typeof row.targetValue === 'number' ? row.targetValue : '';
    if (targetDateInput) targetDateInput.value = toInputDate(row.targetDate);
    if (notesInput) notesInput.value = row.notes || '';
    if (addBtn) addBtn.textContent = 'Update';
    if (cancelEditBtn) cancelEditBtn.style.display = '';
  }

  function cancelEdit() {
    ctx.editingId = null;
    if (addBtn) addBtn.textContent = 'Add';
    if (cancelEditBtn) cancelEditBtn.style.display = 'none';
    clearForm();
  }

  function saveEdit() {
    if (!ctx.editingId || !canWrite()) return;
    var ref = benefitsRef();
    if (!ref || !titleInput) return;
    var payload = readForm();
    if (!payload.title) return;
    payload.updatedAt = new Date();
    payload.updatedBy = ctx.userEmail || '';
    ref.doc(ctx.editingId).update(payload).catch(function (err) { console.error(ns, 'saveEdit error', err); alert('Could not save — please try again: ' + (err && err.message ? err.message : err)); });
    ctx.editingId = null;
    if (addBtn) addBtn.textContent = 'Add';
    if (cancelEditBtn) cancelEditBtn.style.display = 'none';
    clearForm();
  }

  function deleteBenefit(id) {
    if (!canActOnRow(id)) return;
    var ref = benefitsRef();
    if (!ref) return;
    var confirmed = window.drConfirm ? window.drConfirm('Delete this benefit/KPI? This cannot be undone.', { title: 'Delete Benefit / KPI' }) : Promise.resolve(window.confirm('Delete this benefit/KPI?'));
    confirmed.then(function (ok) { if (ok) ref.doc(id).delete().catch(function (err) { console.error(ns, 'deleteBenefit error', err); }); });
  }

  // ---------------------------------------------------------------------------
  // Readings — append-only via arrayUnion; a plain Date (not
  // serverTimestamp(), which Firestore rejects inside arrays).
  // ---------------------------------------------------------------------------
  function openLogReading(id) {
    var row = ctx.rows.find(function (r) { return r.id === id; });
    if (!row || !canActOnRow(id) || !window.drModal) return;
    var todayStr = toInputDate(new Date());
    var html = '<label class="td-compose-field">Value (' + esc(row.unit || 'no unit set') + ')<input id="br-reading-value" type="number" step="any" /></label>' +
      '<label class="td-compose-field">Date<input id="br-reading-date" type="date" value="' + esc(todayStr) + '" /></label>' +
      '<label class="td-compose-field">Note (optional)<textarea id="br-reading-note" rows="3"></textarea></label>' +
      '<div class="td-compose-actions"><button type="button" id="br-reading-save" class="primary">Save Reading</button><span id="br-reading-status" class="doc-share-status"></span></div>';
    window.drModal.open({ title: 'Log a reading — ' + (row.title || ''), bodyHtml: html });
    var saveBtn = document.getElementById('br-reading-save');
    if (saveBtn) saveBtn.addEventListener('click', function () { saveReading(id); });
  }

  function saveReading(id) {
    var valEl = document.getElementById('br-reading-value'), dateEl = document.getElementById('br-reading-date');
    var noteEl = document.getElementById('br-reading-note'), statusEl = document.getElementById('br-reading-status');
    var value = valEl ? parseFloat(valEl.value) : NaN;
    if (isNaN(value)) { if (statusEl) statusEl.textContent = 'Enter a numeric value.'; return; }
    var dateVal = dateEl && dateEl.value ? new Date(dateEl.value + 'T00:00:00') : new Date();
    var ref = benefitsRef();
    if (!ref) return;
    var entry = { value: value, date: dateVal, note: noteEl ? noteEl.value.trim() : '', recordedAt: new Date(), recordedBy: ctx.userEmail || '' };
    var FV = window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue;
    var writeP = FV ? ref.doc(id).update({ readings: FV.arrayUnion(entry) })
      : ref.doc(id).update({ readings: sortedReadings((ctx.rows.find(function (r) { return r.id === id; }) || {})).concat([entry]) });
    writeP.then(function () { if (window.drModal) window.drModal.close(); })
      .catch(function (err) { console.error(ns, 'saveReading error', err); if (statusEl) statusEl.textContent = 'Could not save: ' + (err && err.message ? err.message : err); });
  }

  function showHistory(id) {
    var row = ctx.rows.find(function (r) { return r.id === id; });
    if (!row || !window.drModal) return;
    var readings = sortedReadings(row).slice().reverse();
    var unit = row.unit ? (' ' + esc(row.unit)) : '';
    var html = readings.length ? readings.map(function (r) {
      return '<div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #ddd">' +
        '<p style="font-weight:bold">' + esc(fmtDate(r.date)) + ' — ' + fmtNum(r.value) + unit + '</p>' +
        (r.note ? '<p>' + esc(r.note) + '</p>' : '') +
        '<p style="font-size:0.75rem;color:#777">Logged ' + esc(fmtDate(r.recordedAt)) + (r.recordedBy ? ' by ' + esc(r.recordedBy) : '') + '</p></div>';
    }).join('') : '<p>No readings logged yet.</p>';
    window.drModal.open({ title: 'Readings — ' + (row.title || ''), bodyHtml: html });
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------
  function bindTableEvents() {
    if (!tbody) return;
    tbody.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t) return;
      if (t.classList.contains('br-edit')) startEdit(t.getAttribute('data-id'));
      else if (t.classList.contains('br-del')) deleteBenefit(t.getAttribute('data-id'));
      else if (t.classList.contains('br-log')) openLogReading(t.getAttribute('data-id'));
      else if (t.classList.contains('br-hist')) showHistory(t.getAttribute('data-id'));
    });
  }
  function bindAdd() {
    if (!addBtn) return;
    addBtn.addEventListener('click', function () { if (ctx.editingId) saveEdit(); else addBenefit(); });
    if (cancelEditBtn) cancelEditBtn.addEventListener('click', cancelEdit);
  }

  function listenBenefits() {
    var ref = benefitsRef();
    if (!ref) return;
    ref.orderBy('title').onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      ctx.rows = rows;
      paint();
    }, function (err) {
      console.warn(ns, 'listen error (expected if not granted view access)', err && err.code);
    });
  }

  function detectContextFromDOM() {
    card = document.getElementById('benefitsRealizationCard');
    tbody = $('#benefitsRealizationTable tbody');
    titleInput = $('#br-title'); metricInput = $('#br-metric'); unitInput = $('#br-unit'); ownerInput = $('#br-owner');
    baselineValueInput = $('#br-baseline-value'); baselineDateInput = $('#br-baseline-date');
    targetValueInput = $('#br-target-value'); targetDateInput = $('#br-target-date'); notesInput = $('#br-notes');
    addBtn = $('#br-add'); cancelEditBtn = $('#br-cancel-edit');

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';

    var user = (window.auth && window.auth.currentUser) || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.userUid = (user && user.uid) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function applyWriteAccess() {
    var addOnlyEls = document.querySelectorAll('.br-add-only');
    for (var i = 0; i < addOnlyEls.length; i++) {
      var el = addOnlyEls[i];
      if (el.id === 'br-cancel-edit') { if (!canWrite()) el.style.display = 'none'; continue; }
      el.style.display = canWrite() ? '' : 'none';
    }
    paint();
  }

  function init() {
    detectContextFromDOM();
    if (!ctx.biz || !card) return;
    bindTableEvents();
    bindAdd();
    listenBenefits();
    if (window.drAccess) window.drAccess.whenReady().then(applyWriteAccess);
    else applyWriteAccess();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
