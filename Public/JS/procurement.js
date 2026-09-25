/* ============================================================================
   Procurement / Vendor Log — two lists on one card:
     • Purchases / Contracts — what is being bought, from whom, contract value
       vs. invoiced / paid, key dates, and flags (delivery overdue, contract
       expiring / expired, over contract value).
     • Vendors — the directory: category, contact, and which team member
       manages the vendor.
   Real-time add/edit/delete, modeled on decisionLog.js. Both lists share the
   'procurementCard' Permissions grants (owner always; Client Partner /
   Project Manager per the matrix; everyone with view sees the dollar
   figures). See firestore.rules's vendors / purchases blocks.
   Firestore: businesses/{biz}/projects/{proj}/vendors/{doc}
     name, category, contactName, contactEmail, contactPhone, vendorOwner, notes
   Firestore: businesses/{biz}/projects/{proj}/purchases/{doc}
     item, vendorId, vendorName, contractType, status, contractValue,
     invoicedAmount, paidAmount, needByDate, contractStart, contractEnd,
     deliveryDue, contractUrl, notes, linkedRiskId/Title, linkedItemId/Title
   (both also: createdAt/By/ByUid, updatedAt/By)
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[procurement]';
  var CARD_ID = 'procurementCard';
  var PAGE_SIZE = 15;
  var EXPIRING_DAYS = 30;

  var ctx = {
    biz: null, proj: null, userEmail: '', userUid: '', isOwner: false,
    vendors: [], purchases: [], risks: [], items: [],
    editingPurchase: null, editingVendor: null, tab: 'purchases',
    pSort: { key: 'deliveryDue', dir: 'asc' }, vSort: { key: 'name', dir: 'asc' },
    pPage: 1, vPage: 1
  };

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  var CONTRACT_TYPES = ['Fixed Price', 'Time & Materials', 'Purchase Order', 'Subscription', 'Other'];
  var STATUSES = ['Planned', 'RFP Issued', 'Selected', 'Contracted', 'Delivered', 'Closed', 'Cancelled'];
  var CLOSED_STATUSES = ['Delivered', 'Closed', 'Cancelled'];        // no delivery expected any more
  var FINISHED_STATUSES = ['Closed', 'Cancelled'];                    // contract term no longer matters
  var CATEGORIES = ['Software', 'Hardware', 'Consulting', 'Construction', 'Logistics', 'Legal', 'Other'];

  function daysFromNow(n) { var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; }
  // Sample rows — shown only until a real record exists in that list; never
  // written to Firestore. ids start with "sample-" so every action refuses them.
  var SAMPLE_VENDORS = [
    { id: 'sample-v1', name: 'Northwind Hosting', category: 'Software', contactName: 'Dana Whitfield', contactEmail: 'dana@northwind.example', contactPhone: '555-0142', vendorOwner: 'Project manager', notes: 'Managed hosting and CDN.' },
    { id: 'sample-v2', name: 'Summit Build Co.', category: 'Construction', contactName: 'Omar Haddad', contactEmail: 'omar@summit.example', contactPhone: '555-0177', vendorOwner: 'Owner', notes: 'General contractor for the build-out.' },
    { id: 'sample-v3', name: 'BrightPath Consulting', category: 'Consulting', contactName: 'Lena Fischer', contactEmail: 'lena@brightpath.example', contactPhone: '555-0190', vendorOwner: 'Client partner', notes: 'Change-management support.' }
  ];
  var SAMPLE_PURCHASES = [
    { id: 'sample-p1', item: 'Managed hosting — 12 months', vendorName: 'Northwind Hosting', contractType: 'Subscription', status: 'Contracted', contractValue: 48000, invoicedAmount: 24000, paidAmount: 24000, needByDate: daysFromNow(-20), contractStart: daysFromNow(-90), contractEnd: daysFromNow(20), deliveryDue: daysFromNow(-60), contractUrl: '', notes: 'Renewal decision due before end date.', linkedRiskTitle: '', linkedItemTitle: '' },
    { id: 'sample-p2', item: 'Build-out construction', vendorName: 'Summit Build Co.', contractType: 'Fixed Price', status: 'Contracted', contractValue: 220000, invoicedAmount: 245000, paidAmount: 190000, needByDate: daysFromNow(-30), contractStart: daysFromNow(-120), contractEnd: daysFromNow(90), deliveryDue: daysFromNow(-5), contractUrl: '', notes: 'Change orders pushed invoiced above the contract.', linkedRiskTitle: 'Vendor may delay construction start', linkedItemTitle: 'Construction' },
    { id: 'sample-p3', item: 'Change-management workshops', vendorName: 'BrightPath Consulting', contractType: 'Time & Materials', status: 'Selected', contractValue: 30000, invoicedAmount: 0, paidAmount: 0, needByDate: daysFromNow(14), contractStart: daysFromNow(21), contractEnd: daysFromNow(120), deliveryDue: daysFromNow(60), contractUrl: '', notes: '', linkedRiskTitle: '', linkedItemTitle: '' },
    { id: 'sample-p4', item: 'Network switches', vendorName: 'Northwind Hosting', contractType: 'Purchase Order', status: 'Delivered', contractValue: 12500, invoicedAmount: 12500, paidAmount: 12500, needByDate: daysFromNow(-45), contractStart: null, contractEnd: null, deliveryDue: daysFromNow(-40), contractUrl: '', notes: '', linkedRiskTitle: '', linkedItemTitle: '' }
  ];

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function getDB() {
    return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore());
  }
  function projDocRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz).collection('projects').doc(ctx.proj || 'default');
  }
  function vendorsRef() { var p = projDocRef(); return p ? p.collection('vendors') : null; }
  function purchasesRef() { var p = projDocRef(); return p ? p.collection('purchases') : null; }
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
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
  var money = (typeof Intl !== 'undefined' && Intl.NumberFormat)
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : null;
  function fmtMoney(v) {
    if (v == null || v === '' || isNaN(Number(v))) return '—';
    return money ? money.format(Number(v)) : '$' + Math.round(Number(v)).toLocaleString();
  }
  function isSample(id) { return String(id || '').indexOf('sample-') === 0; }
  function startOfToday() { var t = new Date(); t.setHours(0, 0, 0, 0); return t; }

  // Owner always; a Client Partner / Project Manager per the Permissions
  // matrix (firestore.rules enforces the same grants). Applies to both lists.
  function can(action) {
    return ctx.isOwner || !!(window.drAccess && window.drAccess.canUseAction(CARD_ID, action));
  }
  function canWrite() { return can('Add') || can('Edit'); }
  function canActOn(id, action) { return can(action) && !isSample(id); }

  function vendorNameFor(p) {
    var v = p.vendorId && ctx.vendors.find(function (x) { return x.id === p.vendorId; });
    return v ? v.name : (p.vendorName || '');
  }

  // Which dollar amounts mean anything at a given status:
  //   Planned / RFP Issued  — no vendor chosen yet, so none
  //   Selected              — the agreed / quoted contract value only
  //                           (nothing can be invoiced or paid before a contract)
  //   Contracted onward     — all three (a Cancelled contract can still have
  //                           deposits or fees paid)
  function moneyApplies(status, field) {
    var s = status || 'Planned';
    if (s === 'Planned' || s === 'RFP Issued') return false;
    if (s === 'Selected') return field === 'contractValue';
    return true;
  }
  // A record's amount, or null when it doesn't apply at its status — so a
  // stale figure left over from an earlier status never shows, totals or flags.
  function moneyOf(p, field) {
    return moneyApplies(p.status, field) ? num(p[field]) : null;
  }
  function balanceOf(p) {
    var v = moneyOf(p, 'contractValue');
    if (v == null) return null;
    return v - (moneyOf(p, 'paidAmount') || 0);
  }

  // Problems worth a glance — computed, never stored.
  function flagsOf(p) {
    var flags = [], today = startOfToday(), st = p.status || 'Planned';
    var due = toDate(p.deliveryDue);
    if (due && CLOSED_STATUSES.indexOf(st) === -1 && due.getTime() < today.getTime()) {
      flags.push({ text: 'Delivery overdue', cls: 'severity-high' });
    }
    var end = toDate(p.contractEnd);
    if (end && st === 'Contracted') {
      var days = Math.round((end.getTime() - today.getTime()) / 86400000);
      if (days < 0) flags.push({ text: 'Contract expired', cls: 'severity-high' });
      else if (days <= EXPIRING_DAYS) flags.push({ text: 'Expires in ' + days + 'd', cls: 'severity-medium' });
    }
    var value = moneyOf(p, 'contractValue');
    if (value != null && value > 0 && ((moneyOf(p, 'invoicedAmount') || 0) > value || (moneyOf(p, 'paidAmount') || 0) > value)) {
      flags.push({ text: 'Over contract value', cls: 'severity-high' });
    }
    return flags;
  }
  function statusBadgeClass(s) {
    if (s === 'Delivered' || s === 'Closed') return 'severity-low';
    if (s === 'Contracted') return 'severity-medium';
    if (s === 'Cancelled') return 'severity-high';
    return 'severity-unknown';
  }
  function safeLink(url) {
    var u = String(url || '').trim();
    if (!u) return '—';
    if (/^https?:\/\//i.test(u)) return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">Open</a>';
    return esc(u);
  }

  // ---------------------------------------------------------------------
  // DOM refs (filled in detectContext)
  // ---------------------------------------------------------------------
  var card, els = {};

  function fillSelect(sel, placeholder, values) {
    if (!sel || sel.options.length) return;
    var o0 = document.createElement('option');
    o0.value = ''; o0.textContent = placeholder;
    sel.appendChild(o0);
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    });
  }
  function setOptions(sel, placeholder, emptyText, items) {
    if (!sel) return;
    var keep = sel.value;
    sel.innerHTML = '<option value="">' + (items.length ? placeholder : emptyText) + '</option>' +
      items.map(function (i) { return '<option value="' + esc(i.id) + '">' + esc(i.label) + '</option>'; }).join('');
    sel.value = keep;
  }
  function populateStaticSelects() {
    fillSelect(els.pType, 'Contract type', CONTRACT_TYPES);
    fillSelect(els.pStatus, 'Status', STATUSES);
    fillSelect(els.vCategory, 'Category', CATEGORIES);
    fillSelect(els.pfStatus, 'All Status', STATUSES);
    fillSelect(els.pfType, 'All Types', CONTRACT_TYPES);
    fillSelect(els.vfCategory, 'All Categories', CATEGORIES);
  }
  function refreshVendorOptions() {
    setOptions(els.pVendor, 'Vendor: pick from directory…', 'No vendors yet — type one below',
      ctx.vendors.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); })
        .map(function (v) { return { id: v.id, label: v.name }; }));
  }
  // Risk Register entries (array field on the project doc) + schedule items.
  function loadLinkables() {
    var p = projDocRef();
    if (!p) return;
    p.get().then(function (snap) {
      var data = (snap.exists && snap.data()) || {};
      ctx.risks = (Array.isArray(data.riskRegister) ? data.riskRegister : [])
        .filter(function (r) { return r && r.id; })
        .map(function (r) { return { id: String(r.id), title: r.description || r.id }; });
      setOptions(els.pRisk, 'Linked risk (optional)', 'No risks in this project yet',
        ctx.risks.map(function (r) { return { id: r.id, label: r.id + ' — ' + r.title }; }));
    }).catch(function (err) { console.warn(ns, 'could not load risks', err && err.code); });
    Promise.all([p.collection('milestones').get(), p.collection('activities').get()]).then(function (res) {
      var items = [];
      res[0].forEach(function (d) { var x = d.data() || {}; items.push({ id: 'milestone:' + d.id, title: x.title || 'Untitled', kind: 'Milestone' }); });
      res[1].forEach(function (d) { var x = d.data() || {}; items.push({ id: 'activity:' + d.id, title: x.title || x.activity || 'Untitled', kind: 'Task' }); });
      items.sort(function (a, b) { return a.title.localeCompare(b.title); });
      ctx.items = items;
      setOptions(els.pItem, 'Linked task/milestone (optional)', 'No tasks/milestones yet',
        items.map(function (it) { return { id: it.id, label: it.kind + ': ' + it.title }; }));
    }).catch(function (err) { console.warn(ns, 'could not load schedule items', err && err.code); });
  }

  // ---------------------------------------------------------------------
  // Paging / sorting helpers shared by both lists
  // ---------------------------------------------------------------------
  function sortRows(rows, sort, valueFn) {
    var dir = sort.dir === 'desc' ? -1 : 1;
    return rows.slice().sort(function (a, b) {
      var av = valueFn(a, sort.key), bv = valueFn(b, sort.key);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }
  function pageInfo(prefix, page, total, noun) {
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    var info = document.getElementById(prefix + 'PageInfo');
    var prev = document.getElementById(prefix + 'PagePrev');
    var next = document.getElementById(prefix + 'PageNext');
    if (info) info.textContent = 'Page ' + page + ' of ' + pages + ' (' + total + ' ' + noun + (total === 1 ? '' : 's') + ')';
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= pages;
    return pages;
  }
  function markSorted(tableId, sort) {
    document.querySelectorAll('#' + tableId + ' thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === sort.key) th.classList.add(sort.dir);
    });
  }
  function actionButtons(cls, id, canEdit, canDelete, tip) {
    return '<button type="button" class="edit-btn ' + cls + '-edit" data-id="' + esc(id) + '"' +
      (canEdit ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>✏️</button>' +
      '<button type="button" class="delete-btn ' + cls + '-del" data-id="' + esc(id) + '"' +
      (canDelete ? '' : ' disabled aria-disabled="true" title="' + tip + '"') + '>🗑️</button>';
  }
  function tipFor(id) { return isSample(id) ? 'Sample data — add a real record first' : 'You do not have permission for this action'; }

  // ---------------------------------------------------------------------
  // Purchases list
  // ---------------------------------------------------------------------
  function pSortValue(r, key) {
    if (['contractValue', 'invoicedAmount', 'paidAmount'].indexOf(key) !== -1) return moneyOf(r, key) == null ? -Infinity : moneyOf(r, key);
    if (key === 'balance') { var b = balanceOf(r); return b == null ? -Infinity : b; }
    if (['needByDate', 'contractStart', 'contractEnd', 'deliveryDue'].indexOf(key) !== -1) { var d = toDate(r[key]); return d ? d.getTime() : Number.MAX_SAFE_INTEGER; }
    if (key === 'vendorName') return vendorNameFor(r).toLowerCase();
    if (key === 'flags') return flagsOf(r).length;
    return String(r[key] || '').toLowerCase();
  }

  function paintPurchases() {
    var tbody = $('#purchasesTable tbody');
    if (!tbody) return;
    var usingSample = !ctx.purchases.length;
    var banner = document.getElementById('purchasesSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var source = usingSample ? SAMPLE_PURCHASES : ctx.purchases;

    var fs = els.pfStatus ? els.pfStatus.value : '', ft = els.pfType ? els.pfType.value : '';
    var rows = source.filter(function (r) { return (!fs || (r.status || 'Planned') === fs) && (!ft || r.contractType === ft); });
    rows = sortRows(rows, ctx.pSort, pSortValue);

    var pages = pageInfo('purchases', ctx.pPage, rows.length, 'purchase');
    if (ctx.pPage > pages) ctx.pPage = pages;
    if (ctx.pPage < 1) ctx.pPage = 1;
    var pageRows = rows.slice((ctx.pPage - 1) * PAGE_SIZE, ctx.pPage * PAGE_SIZE);
    markSorted('purchasesTable', ctx.pSort);

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="17" class="metrics-empty">No purchases match the selected filters.</td></tr>';
    } else {
      tbody.innerHTML = pageRows.map(function (r) {
        var bal = balanceOf(r);
        var flags = flagsOf(r).map(function (f) { return '<span class="severity-badge ' + f.cls + '">' + esc(f.text) + '</span>'; }).join(' ') || '—';
        var linked = [];
        if (r.linkedRiskTitle) linked.push('Risk: ' + esc(r.linkedRiskTitle));
        if (r.linkedItemTitle) linked.push('Task: ' + esc(r.linkedItemTitle));
        var tip = tipFor(r.id);
        return '<tr data-id="' + esc(r.id) + '">' +
          '<td>' + esc(r.item) + '</td>' +
          '<td>' + esc(vendorNameFor(r) || '—') + '</td>' +
          '<td>' + esc(r.contractType || '—') + '</td>' +
          '<td><span class="severity-badge ' + statusBadgeClass(r.status) + '">' + esc(r.status || 'Planned') + '</span></td>' +
          '<td>' + fmtMoney(moneyOf(r, 'contractValue')) + '</td>' +
          '<td>' + fmtMoney(moneyOf(r, 'invoicedAmount')) + '</td>' +
          '<td>' + fmtMoney(moneyOf(r, 'paidAmount')) + '</td>' +
          '<td>' + (bal == null ? '—' : fmtMoney(bal)) + '</td>' +
          '<td>' + esc(fmtDate(r.needByDate)) + '</td>' +
          '<td>' + esc(fmtDate(r.contractStart)) + '</td>' +
          '<td>' + esc(fmtDate(r.contractEnd)) + '</td>' +
          '<td>' + esc(fmtDate(r.deliveryDue)) + '</td>' +
          '<td>' + flags + '</td>' +
          '<td>' + (linked.length ? linked.join('<br>') : '—') + '</td>' +
          '<td>' + safeLink(r.contractUrl) + '</td>' +
          '<td class="wrap-text">' + esc(r.notes) + '</td>' +
          '<td class="pc-actions">' + actionButtons('pc', r.id, canActOn(r.id, 'Edit'), canActOn(r.id, 'Delete'), tip) + '</td>' +
          '</tr>';
      }).join('');
    }

    if (window.drInsight) {
      var sum = function (k) { return rows.reduce(function (t, r) { return t + (moneyOf(r, k) || 0); }, 0); };
      var overdue = 0, expiring = 0, over = 0;
      rows.forEach(function (r) {
        flagsOf(r).forEach(function (f) {
          if (f.text === 'Delivery overdue') overdue++;
          else if (f.text === 'Over contract value') over++;
          else expiring++;
        });
      });
      var text = rows.length + ' purchase' + (rows.length === 1 ? '' : 's') + ': ' + fmtMoney(sum('contractValue')) +
        ' contracted, ' + fmtMoney(sum('invoicedAmount')) + ' invoiced, ' + fmtMoney(sum('paidAmount')) + ' paid. ' +
        overdue + ' delivery overdue, ' + expiring + ' contract' + (expiring === 1 ? '' : 's') + ' expiring or expired, ' +
        over + ' over contract value.';
      if (usingSample) text += ' (sample data)';
      window.drInsight.set(CARD_ID, rows.length ? text : '');
    }
  }

  // Locks the dollar inputs that don't apply at the chosen status (see
  // moneyApplies). A value typed earlier is stashed rather than lost, so
  // flipping the status back before saving restores it; on save, locked
  // fields are written as null.
  function moneyInputs() {
    return [['contractValue', els.pValue], ['invoicedAmount', els.pInvoiced], ['paidAmount', els.pPaid]];
  }
  function applyMoneyRules() {
    var status = els.pStatus.value || 'Planned';
    var why = (status === 'Planned' || status === 'RFP Issued')
      ? 'No amounts at "' + status + '" — no vendor has been selected yet.'
      : 'Nothing is invoiced or paid until a contract is in place (status: ' + status + ').';
    moneyInputs().forEach(function (pair) {
      var el = pair[1];
      if (!el) return;
      if (moneyApplies(status, pair[0])) {
        if (el.disabled) {
          el.disabled = false;
          el.title = '';
          if (!el.value && el.dataset.stash) el.value = el.dataset.stash;
          el.dataset.stash = '';
        }
      } else if (!el.disabled) {
        el.dataset.stash = el.value;
        el.value = '';
        el.disabled = true;
        el.title = why;
      } else {
        el.title = why;
      }
    });
  }

  function readPurchaseForm() {
    var vendor = ctx.vendors.find(function (v) { return v.id === (els.pVendor && els.pVendor.value); });
    var risk = ctx.risks.find(function (r) { return r.id === (els.pRisk && els.pRisk.value); });
    var item = ctx.items.find(function (x) { return x.id === (els.pItem && els.pItem.value); });
    function dateVal(el) { return el.value ? new Date(el.value + 'T00:00:00') : null; }
    return {
      item: els.pName.value.trim(),
      vendorId: vendor ? vendor.id : '',
      vendorName: vendor ? vendor.name : els.pVendorText.value.trim(),
      contractType: els.pType.value || 'Other',
      status: els.pStatus.value || 'Planned',
      contractValue: els.pValue.disabled ? null : num(els.pValue.value),
      invoicedAmount: els.pInvoiced.disabled ? null : num(els.pInvoiced.value),
      paidAmount: els.pPaid.disabled ? null : num(els.pPaid.value),
      needByDate: dateVal(els.pNeedBy), contractStart: dateVal(els.pStart), contractEnd: dateVal(els.pEnd), deliveryDue: dateVal(els.pDelivery),
      contractUrl: els.pUrl.value.trim(), notes: els.pNotes.value.trim(),
      linkedRiskId: risk ? risk.id : '', linkedRiskTitle: risk ? risk.title : '',
      linkedItemId: item ? item.id : '', linkedItemTitle: item ? item.title : ''
    };
  }
  function clearPurchaseForm() {
    ['pName', 'pVendorText', 'pValue', 'pInvoiced', 'pPaid', 'pNeedBy', 'pStart', 'pEnd', 'pDelivery', 'pUrl', 'pNotes']
      .forEach(function (k) { if (els[k]) els[k].value = ''; });
    ['pVendor', 'pType', 'pStatus', 'pRisk', 'pItem'].forEach(function (k) { if (els[k]) els[k].value = ''; });
    moneyInputs().forEach(function (pair) { if (pair[1]) pair[1].dataset.stash = ''; });
    applyMoneyRules();
  }
  function resetPurchaseEdit() {
    ctx.editingPurchase = null;
    els.pAdd.textContent = 'Add';
    els.pCancel.style.display = 'none';
    clearPurchaseForm();
  }
  function fail(what, err) {
    console.error(ns, what + ' failed', err);
    alert('Could not ' + what + ': ' + (err && err.message ? err.message : err));
  }
  function savePurchase() {
    if (!can(ctx.editingPurchase ? 'Edit' : 'Add') || !els.pName.value.trim()) return;
    var ref = purchasesRef();
    if (!ref) return;
    var payload = readPurchaseForm();
    if (ctx.editingPurchase) {
      payload.updatedAt = serverTs(); payload.updatedBy = ctx.userEmail;
      ref.doc(ctx.editingPurchase).update(payload).catch(function (err) { fail('save', err); });
      resetPurchaseEdit();
      return;
    }
    payload.createdAt = serverTs(); payload.createdBy = ctx.userEmail; payload.createdByUid = ctx.userUid;
    ref.add(payload).catch(function (err) { fail('save', err); });
    clearPurchaseForm();
  }
  function startEditPurchase(id) {
    var r = ctx.purchases.find(function (x) { return x.id === id; });
    if (!r || !canActOn(id, 'Edit')) return;
    ctx.editingPurchase = id;
    els.pName.value = r.item || '';
    var known = r.vendorId && ctx.vendors.some(function (v) { return v.id === r.vendorId; });
    els.pVendor.value = known ? r.vendorId : '';
    els.pVendorText.value = known ? '' : (r.vendorName || '');
    els.pType.value = r.contractType || '';
    els.pStatus.value = r.status || '';
    els.pValue.value = r.contractValue == null ? '' : r.contractValue;
    els.pInvoiced.value = r.invoicedAmount == null ? '' : r.invoicedAmount;
    els.pPaid.value = r.paidAmount == null ? '' : r.paidAmount;
    els.pNeedBy.value = toDateInput(r.needByDate); els.pStart.value = toDateInput(r.contractStart);
    els.pEnd.value = toDateInput(r.contractEnd); els.pDelivery.value = toDateInput(r.deliveryDue);
    els.pUrl.value = r.contractUrl || ''; els.pNotes.value = r.notes || '';
    els.pRisk.value = r.linkedRiskId || ''; els.pItem.value = r.linkedItemId || '';
    // Values are set first, then locked/cleared to match the record's status.
    moneyInputs().forEach(function (pair) { if (pair[1]) { pair[1].disabled = false; pair[1].dataset.stash = ''; } });
    applyMoneyRules();
    els.pAdd.textContent = 'Update';
    els.pCancel.style.display = '';
  }
  function removePurchase(id) {
    if (!canActOn(id, 'Delete')) return;
    var confirmed = window.drConfirm
      ? window.drConfirm('Delete this purchase record? This cannot be undone.', { title: 'Delete Purchase' })
      : Promise.resolve(window.confirm('Delete this purchase record?'));
    confirmed.then(function (ok) {
      if (!ok) return;
      purchasesRef().doc(id).delete().catch(function (err) { fail('delete', err); });
    });
  }

  // ---------------------------------------------------------------------
  // Vendors list
  // ---------------------------------------------------------------------
  function purchaseCountFor(v) {
    return ctx.purchases.filter(function (p) { return p.vendorId === v.id; }).length;
  }
  function vSortValue(r, key) {
    if (key === 'purchases') return purchaseCountFor(r);
    return String(r[key] || '').toLowerCase();
  }

  function paintVendors() {
    var tbody = $('#vendorsTable tbody');
    if (!tbody) return;
    var usingSample = !ctx.vendors.length;
    var banner = document.getElementById('vendorsSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var source = usingSample ? SAMPLE_VENDORS : ctx.vendors;

    var fc = els.vfCategory ? els.vfCategory.value : '';
    var rows = source.filter(function (r) { return !fc || r.category === fc; });
    rows = sortRows(rows, ctx.vSort, vSortValue);

    var pages = pageInfo('vendors', ctx.vPage, rows.length, 'vendor');
    if (ctx.vPage > pages) ctx.vPage = pages;
    if (ctx.vPage < 1) ctx.vPage = 1;
    var pageRows = rows.slice((ctx.vPage - 1) * PAGE_SIZE, ctx.vPage * PAGE_SIZE);
    markSorted('vendorsTable', ctx.vSort);

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="metrics-empty">No vendors match the selected filter.</td></tr>';
      return;
    }
    tbody.innerHTML = pageRows.map(function (r) {
      var tip = tipFor(r.id);
      var email = r.contactEmail ? '<a href="mailto:' + esc(r.contactEmail) + '">' + esc(r.contactEmail) + '</a>' : '—';
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td>' + esc(r.name) + '</td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(r.contactName || '—') + '</td>' +
        '<td>' + email + '</td>' +
        '<td>' + esc(r.contactPhone || '—') + '</td>' +
        '<td>' + esc(r.vendorOwner || '—') + '</td>' +
        '<td>' + (usingSample ? '—' : purchaseCountFor(r)) + '</td>' +
        '<td class="wrap-text">' + esc(r.notes) + '</td>' +
        '<td class="pc-actions">' + actionButtons('vd', r.id, canActOn(r.id, 'Edit'), canActOn(r.id, 'Delete'), tip) + '</td>' +
        '</tr>';
    }).join('');
  }

  function readVendorForm() {
    return {
      name: els.vName.value.trim(), category: els.vCategory.value || 'Other',
      contactName: els.vContact.value.trim(), contactEmail: els.vEmail.value.trim(), contactPhone: els.vPhone.value.trim(),
      vendorOwner: els.vOwner.value.trim(), notes: els.vNotes.value.trim()
    };
  }
  function clearVendorForm() {
    ['vName', 'vContact', 'vEmail', 'vPhone', 'vOwner', 'vNotes'].forEach(function (k) { if (els[k]) els[k].value = ''; });
    if (els.vCategory) els.vCategory.value = '';
  }
  function resetVendorEdit() {
    ctx.editingVendor = null;
    els.vAdd.textContent = 'Add';
    els.vCancel.style.display = 'none';
    clearVendorForm();
  }
  function saveVendor() {
    if (!can(ctx.editingVendor ? 'Edit' : 'Add') || !els.vName.value.trim()) return;
    var ref = vendorsRef();
    if (!ref) return;
    var payload = readVendorForm();
    if (ctx.editingVendor) {
      payload.updatedAt = serverTs(); payload.updatedBy = ctx.userEmail;
      ref.doc(ctx.editingVendor).update(payload).catch(function (err) { fail('save', err); });
      resetVendorEdit();
      return;
    }
    payload.createdAt = serverTs(); payload.createdBy = ctx.userEmail; payload.createdByUid = ctx.userUid;
    ref.add(payload).catch(function (err) { fail('save', err); });
    clearVendorForm();
  }
  function startEditVendor(id) {
    var r = ctx.vendors.find(function (x) { return x.id === id; });
    if (!r || !canActOn(id, 'Edit')) return;
    ctx.editingVendor = id;
    els.vName.value = r.name || ''; els.vCategory.value = r.category || '';
    els.vContact.value = r.contactName || ''; els.vEmail.value = r.contactEmail || ''; els.vPhone.value = r.contactPhone || '';
    els.vOwner.value = r.vendorOwner || ''; els.vNotes.value = r.notes || '';
    els.vAdd.textContent = 'Update';
    els.vCancel.style.display = '';
  }
  function removeVendor(id) {
    var r = ctx.vendors.find(function (x) { return x.id === id; });
    if (!r || !canActOn(id, 'Delete')) return;
    var used = purchaseCountFor(r);
    var msg = 'Delete vendor "' + r.name + '"?' + (used ? ' ' + used + ' purchase record' + (used === 1 ? ' still refers' : 's still refer') +
      ' to it and will keep showing the vendor name as text.' : '') + ' This cannot be undone.';
    var confirmed = window.drConfirm ? window.drConfirm(msg, { title: 'Delete Vendor' }) : Promise.resolve(window.confirm(msg));
    confirmed.then(function (ok) {
      if (!ok) return;
      vendorsRef().doc(id).delete().catch(function (err) { fail('delete', err); });
    });
  }

  // ---------------------------------------------------------------------
  // Access / tabs / paint
  // ---------------------------------------------------------------------
  function paint() {
    if (!card) return;
    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport(CARD_ID));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView) return;
    paintPurchases();
    paintVendors();
  }
  function applyAccess() {
    var nodes = document.querySelectorAll('.pc-add-only');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.id === 'pc-cancel-edit' || el.id === 'vd-cancel-edit') { if (!canWrite()) el.style.display = 'none'; continue; }
      el.style.display = canWrite() ? '' : 'none';
    }
    paint();
  }
  function showTab(name) {
    ctx.tab = name;
    ['purchases', 'vendors'].forEach(function (t) {
      var pane = document.getElementById('pc-pane-' + t), tab = document.getElementById('pc-tab-' + t);
      if (pane) pane.hidden = t !== name;
      if (tab) tab.classList.toggle('active', t === name);
    });
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function bindSort(tableId, sortObj, onChange) {
    var thead = document.querySelector('#' + tableId + ' thead');
    if (!thead) return;
    thead.addEventListener('click', function (ev) {
      var th = ev.target.closest('th[data-sort]');
      if (!th) return;
      var key = th.getAttribute('data-sort');
      if (sortObj.key === key) sortObj.dir = sortObj.dir === 'asc' ? 'desc' : 'asc';
      else { sortObj.key = key; sortObj.dir = 'asc'; }
      onChange();
    });
  }

  function bindEvents() {
    document.getElementById('pc-tab-purchases').addEventListener('click', function () { showTab('purchases'); });
    document.getElementById('pc-tab-vendors').addEventListener('click', function () { showTab('vendors'); });

    $('#purchasesTable tbody').addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t) return;
      var id = t.getAttribute('data-id');
      if (t.classList.contains('pc-edit')) startEditPurchase(id);
      else if (t.classList.contains('pc-del')) removePurchase(id);
    });
    $('#vendorsTable tbody').addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t) return;
      var id = t.getAttribute('data-id');
      if (t.classList.contains('vd-edit')) startEditVendor(id);
      else if (t.classList.contains('vd-del')) removeVendor(id);
    });

    [els.pfStatus, els.pfType].forEach(function (s) { if (s) s.addEventListener('change', function () { ctx.pPage = 1; paintPurchases(); }); });
    if (els.vfCategory) els.vfCategory.addEventListener('change', function () { ctx.vPage = 1; paintVendors(); });
    $('#purchasesFilterReset').addEventListener('click', function () {
      [els.pfStatus, els.pfType].forEach(function (s) { if (s) s.value = ''; });
      ctx.pPage = 1; paintPurchases();
    });
    $('#vendorsFilterReset').addEventListener('click', function () {
      if (els.vfCategory) els.vfCategory.value = '';
      ctx.vPage = 1; paintVendors();
    });

    document.getElementById('purchasesPagePrev').addEventListener('click', function () { ctx.pPage--; paintPurchases(); });
    document.getElementById('purchasesPageNext').addEventListener('click', function () { ctx.pPage++; paintPurchases(); });
    document.getElementById('vendorsPagePrev').addEventListener('click', function () { ctx.vPage--; paintVendors(); });
    document.getElementById('vendorsPageNext').addEventListener('click', function () { ctx.vPage++; paintVendors(); });

    [els.pRisk, els.pItem].forEach(function (s) { if (s) s.addEventListener('mousedown', loadLinkables); });
    els.pStatus.addEventListener('change', applyMoneyRules);
    els.pAdd.addEventListener('click', savePurchase);
    els.pCancel.addEventListener('click', resetPurchaseEdit);
    els.vAdd.addEventListener('click', saveVendor);
    els.vCancel.addEventListener('click', resetVendorEdit);

    bindSort('purchasesTable', ctx.pSort, paintPurchases);
    bindSort('vendorsTable', ctx.vSort, paintVendors);
  }

  function listen() {
    var vr = vendorsRef(), pr = purchasesRef();
    if (vr) vr.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (d) { var x = d.data() || {}; x.id = d.id; rows.push(x); });
      ctx.vendors = rows;
      refreshVendorOptions();
      paint();
    }, function (err) { console.warn(ns, 'vendors listen error (expected if not a project member)', err && err.code); });
    if (pr) pr.onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (d) { var x = d.data() || {}; x.id = d.id; rows.push(x); });
      ctx.purchases = rows;
      paint();
    }, function (err) { console.warn(ns, 'purchases listen error (expected if not a project member)', err && err.code); });
  }

  function detectContext() {
    card = document.getElementById(CARD_ID);
    var map = {
      pName: '#pc-item', pVendor: '#pc-vendor', pVendorText: '#pc-vendor-text', pType: '#pc-type', pStatus: '#pc-status',
      pValue: '#pc-value', pInvoiced: '#pc-invoiced', pPaid: '#pc-paid',
      pNeedBy: '#pc-needby', pStart: '#pc-start', pEnd: '#pc-end', pDelivery: '#pc-delivery',
      pRisk: '#pc-risk', pItem: '#pc-task', pUrl: '#pc-url', pNotes: '#pc-notes', pAdd: '#pc-add', pCancel: '#pc-cancel-edit',
      pfStatus: '#purchasesFilterStatus', pfType: '#purchasesFilterType',
      vName: '#vd-name', vCategory: '#vd-category', vContact: '#vd-contact', vEmail: '#vd-email', vPhone: '#vd-phone',
      vOwner: '#vd-owner', vNotes: '#vd-notes', vAdd: '#vd-add', vCancel: '#vd-cancel-edit', vfCategory: '#vendorsFilterCategory'
    };
    Object.keys(map).forEach(function (k) { els[k] = $(map[k]); });

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';
    var user = (window.auth && window.auth.currentUser) ||
      (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) || null;
    ctx.userEmail = (user && user.email) || '';
    ctx.userUid = (user && user.uid) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function init() {
    detectContext();
    if (!ctx.biz || !card || !els.pAdd || !els.vAdd) return;
    populateStaticSelects();
    bindEvents();
    applyMoneyRules();
    showTab('purchases');
    loadLinkables();
    listen();
    if (window.drAccess) window.drAccess.whenReady().then(applyAccess);
    else applyAccess();
  }

  // Read-only helpers for the Status Report (status-report.js), so the flag
  // and amount rules live in exactly one place.
  window.drProcurement = { flagsOf: flagsOf, moneyOf: moneyOf, balanceOf: balanceOf };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
