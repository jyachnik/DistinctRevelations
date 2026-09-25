/* ============================================================================
   Stakeholder Register — real-time add/edit/delete, modeled on qna.js's
   structure (live subcollection, filters, sort, pagination), but with
   Risk-Register-style owner-only-card visibility gating (this card
   defaults to hidden until the Owner grants view access) and owner-only
   write gating (Add/Edit/Delete are real owner-only at the Firestore
   rules layer — see firestore.rules's stakeholders block — so there is
   no per-non-owner "own item" concept here the way Q&A has one).
   Firestore: businesses/{biz}/projects/{proj}/stakeholders/{doc}
   Fields: { name, role, organization, email, phone, requirements,
             influence, interest, currentEngagement, desiredEngagement,
             notes, createdAt, createdBy, createdByUid, updatedAt,
             updatedBy }
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[stakeholders]';

  // ---------------------------------------------------------------------------
  // Context
  // ---------------------------------------------------------------------------
  var ctx = {
    biz: null,
    proj: null,
    userEmail: '',
    userUid: '',
    isOwner: false,
    rows: [],
    editingId: null,
    sort: { key: null, dir: 'asc' },
    page: 1
  };
  var STAKEHOLDER_PAGE_SIZE = 15;

  var OWNER_EMAIL = '';
  if (window.APP_CONFIG && Array.isArray(window.APP_CONFIG.OWNERS) && window.APP_CONFIG.OWNERS.length) {
    OWNER_EMAIL = window.APP_CONFIG.OWNERS[0];
  } else if (window.ownerEmail) {
    OWNER_EMAIL = window.ownerEmail;
  }

  // Engagement scale, in order — used both to populate the two
  // Engagement <select>s and to rank current-vs-desired for the
  // "engagement gap" insight.
  var ENGAGEMENT_LEVELS = ['Unaware', 'Resistant', 'Neutral', 'Supportive', 'Leading'];

  // ---------------------------------------------------------------------------
  // Sample/placeholder data — shown only until the Owner adds a real
  // entry, same pattern as issueLog.js/qualityDefects.js's SAMPLE_*
  // arrays. Never written to Firestore. IDs are prefixed "sample-" so
  // startEdit()/deleteStakeholder() can recognize and refuse to act on
  // them (see canActOnRow()) — unlike Issue Log/Quality Defects, this
  // card has real per-row Edit/Delete buttons, so sample rows need to be
  // explicitly non-interactive rather than just lacking buttons.
  // ---------------------------------------------------------------------------
  var SAMPLE_STAKEHOLDERS = [
    { id: 'sample-1', name: 'Alex Rivera', role: 'Executive Sponsor', organization: 'Client Co.', email: 'alex.rivera@example.com', phone: '', influence: 'High', interest: 'High', currentEngagement: 'Supportive', desiredEngagement: 'Leading', requirements: 'Monthly steering committee update; wants early warning on budget risk.', notes: 'Prefers a 1-page summary over the full dashboard.' },
    { id: 'sample-2', name: 'Priya Nandan', role: 'Finance Director', organization: 'Client Co.', email: 'priya.nandan@example.com', phone: '', influence: 'High', interest: 'Low', currentEngagement: 'Neutral', desiredEngagement: 'Supportive', requirements: 'Sign-off on any change request over $10k.', notes: 'Engage only around budget milestones — otherwise low-touch.' },
    { id: 'sample-3', name: 'Marcus Webb', role: 'End User Rep', organization: 'Client Co. — Operations', email: 'marcus.webb@example.com', phone: '', influence: 'Low', interest: 'High', currentEngagement: 'Resistant', desiredEngagement: 'Neutral', requirements: 'Wants training material well before go-live.', notes: 'Vocal about past rollout issues — worth a 1:1 early on.' },
    { id: 'sample-4', name: 'Dana Oyelaran', role: 'IT Support Lead', organization: 'Client Co. — IT', email: 'dana.oyelaran@example.com', phone: '', influence: 'Low', interest: 'Low', currentEngagement: 'Unaware', desiredEngagement: 'Neutral', requirements: 'Needs a heads-up before any system cutover affecting their team.', notes: '' }
  ];

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------------
  var card, tbody;
  var nameInput, roleInput, orgInput, emailInput, phoneInput;
  var influenceSel, interestSel, currentEngSel, desiredEngSel;
  var requirementsInput, notesInput;
  var addBtn, cancelEditBtn;
  var filterInfluenceSel, filterInterestSel, filterQuadrantSel, filterEngagementSel;

  // ---------------------------------------------------------------------------
  // Influence/Interest rank + derived Quadrant — same threshold pattern
  // as riskAssumptions.js's riskSeverity(): map to a numeric rank, bucket
  // at a cutoff. Medium rounds toward the "elevated" bucket on both axes
  // (better to over-engage than under-engage a stakeholder whose
  // influence/interest isn't clearly low) — see the plan file for the
  // full rationale.
  // ---------------------------------------------------------------------------
  var LEVEL_RANK = { high: 3, medium: 2, low: 1 };
  function isElevated(level) {
    var rank = LEVEL_RANK[String(level || '').toLowerCase()] || 0;
    return rank >= 2;
  }
  function quadrantFor(influence, interest) {
    var infElevated = isElevated(influence);
    var intElevated = isElevated(interest);
    if (infElevated && intElevated) return 'Manage Closely';
    if (infElevated && !intElevated) return 'Keep Satisfied';
    if (!infElevated && intElevated) return 'Keep Informed';
    return 'Monitor';
  }
  // Same severity-badge classes every H/M/L field in the app already
  // uses (metrics.css) — not a new badge system.
  function levelBadgeClass(level) {
    var l = String(level || '').toLowerCase();
    if (l === 'high') return 'severity-high';
    if (l === 'medium') return 'severity-medium';
    if (l === 'low') return 'severity-low';
    return 'severity-unknown';
  }
  function quadrantBadgeClass(quadrant) {
    // Manage Closely reads as the most urgent (red), Monitor the least
    // (green) — matching the severity color convention used elsewhere.
    if (quadrant === 'Manage Closely') return 'severity-high';
    if (quadrant === 'Keep Satisfied' || quadrant === 'Keep Informed') return 'severity-medium';
    return 'severity-low';
  }

  function isOwnItem(row) {
    if (!ctx.userEmail && !ctx.userUid) return false;
    if (ctx.userUid && row.createdByUid && row.createdByUid === ctx.userUid) return true;
    return String(row.createdBy || '').toLowerCase() === ctx.userEmail.toLowerCase();
  }

  // Real owner-only writes at the rules layer (see firestore.rules) — no
  // per-non-owner grant is meaningful here, unlike qna.js's canEdit/
  // canDelete, which check window.drAccess.canUseAction for a granted
  // role's OWN items.
  function canWrite() {
    return ctx.isOwner;
  }

  // Sample rows (id starts with "sample-") are display-only — they don't
  // exist in Firestore, so Edit/Delete must refuse to act on them even
  // if somehow invoked (defense in depth on top of the disabled buttons
  // paint() renders for them).
  function canActOnRow(id) {
    return canWrite() && String(id || '').indexOf('sample-') !== 0;
  }

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------
  function rebuildFilters() {
    if (!filterQuadrantSel) return;

    // Influence/Interest/Engagement option sets are fixed vocabularies
    // (not data-driven like Q&A's Type/Assigned filters), so they're
    // populated once in wireForm()/detectContextFromDOM(), not rebuilt
    // per-snapshot. Only the Quadrant filter is derived here, since it's
    // a computed value with a fixed 4-option set too — also static, so
    // nothing to rebuild. Kept as a no-op hook for symmetry with the
    // qna.js template in case a future data-driven filter is added here.
  }

  // ---------------------------------------------------------------------------
  // Firestore refs
  // ---------------------------------------------------------------------------
  function getDB() {
    return (
      window.db ||
      (window.firebase &&
        window.firebase.firestore &&
        window.firebase.firestore())
    );
  }

  function stakeholdersRef() {
    var db = getDB();
    if (!db || !ctx.biz) return null;
    return db.collection('businesses').doc(ctx.biz)
      .collection('projects').doc(ctx.proj || 'default')
      .collection('stakeholders');
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function paint() {
    if (!card) return;

    var canView = ctx.isOwner || !!(window.drAccess && window.drAccess.canViewReport('stakeholderRegisterCard'));
    card.classList.toggle('owner', ctx.isOwner);
    card.classList.toggle('report-access-granted', canView);
    if (!canView || !tbody) return;

    var usingSample = !ctx.rows || !ctx.rows.length;
    console.log(ns, 'paint', { biz: ctx.biz, proj: ctx.proj, isOwner: ctx.isOwner, realRows: (ctx.rows || []).length, usingSample: usingSample });
    var banner = document.getElementById('stakeholderSampleBanner');
    if (banner) banner.hidden = !usingSample;
    var sourceRows = usingSample ? SAMPLE_STAKEHOLDERS : ctx.rows;

    var fi = filterInfluenceSel ? filterInfluenceSel.value : '';
    var fn = filterInterestSel ? filterInterestSel.value : '';
    var fq = filterQuadrantSel ? filterQuadrantSel.value : '';
    var fe = filterEngagementSel ? filterEngagementSel.value : '';

    var rows = sourceRows.filter(function (r) {
      var okI = !fi || String(r.influence || '') === fi;
      var okN = !fn || String(r.interest || '') === fn;
      var okQ = !fq || quadrantFor(r.influence, r.interest) === fq;
      var okE = !fe || String(r.currentEngagement || '') === fe;
      return okI && okN && okQ && okE;
    });

    if (ctx.sort && ctx.sort.key) {
      var key = ctx.sort.key;
      var dir = ctx.sort.dir === 'desc' ? -1 : 1;
      rows = rows.slice().sort(function (a, b) {
        var av = (a[key] || '').toString().toLowerCase();
        var bv = (b[key] || '').toString().toLowerCase();
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }

    var totalPages = Math.max(1, Math.ceil(rows.length / STAKEHOLDER_PAGE_SIZE));
    if (ctx.page > totalPages) ctx.page = totalPages;
    if (ctx.page < 1) ctx.page = 1;
    var startIdx = (ctx.page - 1) * STAKEHOLDER_PAGE_SIZE;
    var pageRows = rows.slice(startIdx, startIdx + STAKEHOLDER_PAGE_SIZE);

    var pageInfoEl = document.getElementById('stakeholderPageInfo');
    var pagePrevEl = document.getElementById('stakeholderPagePrev');
    var pageNextEl = document.getElementById('stakeholderPageNext');
    if (pageInfoEl) pageInfoEl.textContent = 'Page ' + ctx.page + ' of ' + totalPages + ' (' + rows.length + (rows.length === 1 ? ' stakeholder' : ' stakeholders') + ')';
    if (pagePrevEl) pagePrevEl.disabled = ctx.page <= 1;
    if (pageNextEl) pageNextEl.disabled = ctx.page >= totalPages;

    document.querySelectorAll('#stakeholderTable thead th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === ctx.sort.key) th.classList.add(ctx.sort.dir);
    });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="13" class="metrics-empty">No stakeholders match the selected filters.</td></tr>';
      if (window.drInsight) window.drInsight.set('stakeholderRegisterCard', '');
      return;
    }

    tbody.innerHTML = pageRows.map(function (r) {
      var quadrant = quadrantFor(r.influence, r.interest);
      var canAct = canActOnRow(r.id);
      var disabledTitle = usingSample ? 'Sample data — add a real entry to edit' : 'Owner only';
      var editBtn = '<button type="button" class="edit-btn stakeholder-edit" data-id="' + r.id + '"' +
        (canAct ? '' : ' disabled aria-disabled="true" title="' + disabledTitle + '"') + '>✏️</button>';
      var delBtn = '<button type="button" class="delete-btn stakeholder-del" data-id="' + r.id + '"' +
        (canAct ? '' : ' disabled aria-disabled="true" title="' + disabledTitle + '"') + '>🗑️</button>';

      return (
        '<tr data-id="' + r.id + '">' +
        '<td>' + esc(r.name) + '</td>' +
        '<td>' + esc(r.role) + '</td>' +
        '<td>' + esc(r.organization) + '</td>' +
        '<td>' + esc(r.email) + '</td>' +
        '<td>' + esc(r.phone) + '</td>' +
        '<td><span class="severity-badge ' + levelBadgeClass(r.influence) + '">' + esc(r.influence || '—') + '</span></td>' +
        '<td><span class="severity-badge ' + levelBadgeClass(r.interest) + '">' + esc(r.interest || '—') + '</span></td>' +
        '<td><span class="severity-badge ' + quadrantBadgeClass(quadrant) + '">' + esc(quadrant) + '</span></td>' +
        '<td>' + esc(r.currentEngagement) + '</td>' +
        '<td>' + esc(r.desiredEngagement) + '</td>' +
        '<td class="wrap-text">' + esc(r.requirements) + '</td>' +
        '<td class="wrap-text">' + esc(r.notes) + '</td>' +
        '<td>' + editBtn + delBtn + '</td>' +
        '</tr>'
      );
    }).join('');

    if (window.drInsight) {
      var manageClosely = rows.filter(function (r) { return quadrantFor(r.influence, r.interest) === 'Manage Closely'; });
      var engagementGaps = rows.filter(function (r) {
        var cur = ENGAGEMENT_LEVELS.indexOf(r.currentEngagement);
        var des = ENGAGEMENT_LEVELS.indexOf(r.desiredEngagement);
        return cur !== -1 && des !== -1 && des > cur;
      });
      var text = rows.length + ' stakeholder' + (rows.length === 1 ? '' : 's') + ' tracked.';
      if (manageClosely.length) {
        text += ' ' + manageClosely.length + ' require' + (manageClosely.length === 1 ? 's' : '') + ' close management (high influence & interest)' +
          (manageClosely[0].name ? ', e.g. "' + manageClosely[0].name + '"' : '') + '.';
      }
      if (engagementGaps.length) {
        text += ' ' + engagementGaps.length + ' stakeholder' + (engagementGaps.length === 1 ? ' has' : 's have') + ' an engagement gap to close' +
          (engagementGaps[0].name ? ', e.g. "' + engagementGaps[0].name + '"' : '') + '.';
      }
      if (usingSample) text += ' (sample data)';
      window.drInsight.set('stakeholderRegisterCard', text);
    }
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------
  function readForm() {
    return {
      name: nameInput ? nameInput.value.trim() : '',
      role: roleInput ? roleInput.value.trim() : '',
      organization: orgInput ? orgInput.value.trim() : '',
      email: emailInput ? emailInput.value.trim() : '',
      phone: phoneInput ? phoneInput.value.trim() : '',
      requirements: requirementsInput ? requirementsInput.value.trim() : '',
      influence: (influenceSel && influenceSel.value) || '',
      interest: (interestSel && interestSel.value) || '',
      currentEngagement: (currentEngSel && currentEngSel.value) || '',
      desiredEngagement: (desiredEngSel && desiredEngSel.value) || '',
      notes: notesInput ? notesInput.value.trim() : ''
    };
  }

  function clearForm() {
    if (nameInput) nameInput.value = '';
    if (roleInput) roleInput.value = '';
    if (orgInput) orgInput.value = '';
    if (emailInput) emailInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (influenceSel) influenceSel.value = '';
    if (interestSel) interestSel.value = '';
    if (currentEngSel) currentEngSel.value = '';
    if (desiredEngSel) desiredEngSel.value = '';
    if (requirementsInput) requirementsInput.value = '';
    if (notesInput) notesInput.value = '';
  }

  function addStakeholder() {
    if (!nameInput || !canWrite()) return;
    var data = readForm();
    if (!data.name) return;

    var ref = stakeholdersRef();
    if (!ref) return;

    var ts = (window.firebase && window.firebase.firestore && window.firebase.firestore.FieldValue &&
      window.firebase.firestore.FieldValue.serverTimestamp && window.firebase.firestore.FieldValue.serverTimestamp()) || new Date();

    var payload = data;
    payload.createdAt = ts;
    payload.createdBy = ctx.userEmail || '';
    payload.createdByUid = ctx.userUid || '';

    ref.add(payload).catch(function (err) {
      console.error(ns, 'addStakeholder error', err);
      alert('Could not save — please try again: ' + (err && err.message ? err.message : err));
    });

    clearForm();
  }

  function startEdit(id) {
    // Looked up from ctx.rows (real Firestore rows only) — a sample-*
    // id is never in there, so this is already safe against sample
    // rows by construction; canActOnRow() is the explicit guard anyway.
    var row = ctx.rows.find(function (r) { return r.id === id; });
    if (!row || !nameInput || !canActOnRow(id)) return;

    ctx.editingId = id;
    if (nameInput) nameInput.value = row.name || '';
    if (roleInput) roleInput.value = row.role || '';
    if (orgInput) orgInput.value = row.organization || '';
    if (emailInput) emailInput.value = row.email || '';
    if (phoneInput) phoneInput.value = row.phone || '';
    if (influenceSel) influenceSel.value = row.influence || '';
    if (interestSel) interestSel.value = row.interest || '';
    if (currentEngSel) currentEngSel.value = row.currentEngagement || '';
    if (desiredEngSel) desiredEngSel.value = row.desiredEngagement || '';
    if (requirementsInput) requirementsInput.value = row.requirements || '';
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
    var ref = stakeholdersRef();
    if (!ref || !nameInput) return;

    var payload = readForm();
    if (!payload.name) return;
    payload.updatedAt = new Date();
    payload.updatedBy = ctx.userEmail || '';

    ref.doc(ctx.editingId).update(payload).catch(function (err) {
      console.error(ns, 'saveEdit error', err);
      alert('Could not save — please try again: ' + (err && err.message ? err.message : err));
    });

    ctx.editingId = null;
    if (addBtn) addBtn.textContent = 'Add';
    if (cancelEditBtn) cancelEditBtn.style.display = 'none';
    clearForm();
  }

  function deleteStakeholder(id) {
    if (!canActOnRow(id)) return;
    var ref = stakeholdersRef();
    if (!ref) return;

    var confirmed = window.drConfirm
      ? window.drConfirm('Delete this stakeholder? This cannot be undone.', { title: 'Delete Stakeholder' })
      : Promise.resolve(window.confirm('Delete this stakeholder?'));

    confirmed.then(function (ok) {
      if (!ok) return;
      ref.doc(id).delete().catch(function (err) {
        console.error(ns, 'deleteStakeholder error', err);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------
  function bindTableEvents() {
    if (!tbody) return;
    tbody.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t) return;
      if (t.classList.contains('stakeholder-edit')) {
        startEdit(t.getAttribute('data-id'));
      } else if (t.classList.contains('stakeholder-del')) {
        deleteStakeholder(t.getAttribute('data-id'));
      }
    });
  }

  function bindFilters() {
    function onFilterChange() { ctx.page = 1; paint(); }
    [filterInfluenceSel, filterInterestSel, filterQuadrantSel, filterEngagementSel].forEach(function (sel) {
      if (sel) sel.addEventListener('change', onFilterChange);
    });

    var resetBtn = $('#stakeholderFilterReset');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        [filterInfluenceSel, filterInterestSel, filterQuadrantSel, filterEngagementSel].forEach(function (sel) {
          if (sel) sel.value = '';
        });
        onFilterChange();
      });
    }
  }

  function bindPagination() {
    var prevBtn = document.getElementById('stakeholderPagePrev');
    var nextBtn = document.getElementById('stakeholderPageNext');
    if (prevBtn) prevBtn.addEventListener('click', function () { ctx.page--; paint(); });
    if (nextBtn) nextBtn.addEventListener('click', function () { ctx.page++; paint(); });
  }

  function bindAdd() {
    if (!addBtn) return;
    addBtn.addEventListener('click', function () {
      if (ctx.editingId) saveEdit();
      else addStakeholder();
    });
    if (cancelEditBtn) cancelEditBtn.addEventListener('click', cancelEdit);
  }

  function bindSortHeader() {
    var thead = document.querySelector('#stakeholderTable thead');
    if (!thead) return;
    thead.addEventListener('click', function (ev) {
      var th = ev.target.closest('th[data-sort]');
      if (!th) return;
      var key = th.getAttribute('data-sort');
      if (ctx.sort.key === key) {
        ctx.sort.dir = ctx.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        ctx.sort.key = key;
        ctx.sort.dir = 'asc';
      }
      paint();
    });
  }

  // ---------------------------------------------------------------------------
  // Static <select> population (fixed vocabularies, not data-driven)
  // ---------------------------------------------------------------------------
  function populateStaticSelects() {
    var LEVELS = ['High', 'Medium', 'Low'];
    function fillLevelSelect(sel, placeholder) {
      if (!sel || sel.options.length) return; // already populated
      var opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = placeholder;
      sel.appendChild(opt0);
      LEVELS.forEach(function (l) {
        var opt = document.createElement('option');
        opt.value = l;
        opt.textContent = l;
        sel.appendChild(opt);
      });
    }
    function fillEngagementSelect(sel, placeholder) {
      if (!sel || sel.options.length) return;
      var opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = placeholder;
      sel.appendChild(opt0);
      ENGAGEMENT_LEVELS.forEach(function (l) {
        var opt = document.createElement('option');
        opt.value = l;
        opt.textContent = l;
        sel.appendChild(opt);
      });
    }

    fillLevelSelect(influenceSel, 'Influence');
    fillLevelSelect(interestSel, 'Interest');
    fillEngagementSelect(currentEngSel, 'Current Engagement');
    fillEngagementSelect(desiredEngSel, 'Desired Engagement');

    fillLevelSelect(filterInfluenceSel, 'All Influence');
    fillLevelSelect(filterInterestSel, 'All Interest');
    fillEngagementSelect(filterEngagementSel, 'All Engagement');

    if (filterQuadrantSel && !filterQuadrantSel.options.length) {
      var opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = 'All Quadrants';
      filterQuadrantSel.appendChild(opt0);
      ['Manage Closely', 'Keep Satisfied', 'Keep Informed', 'Monitor'].forEach(function (q) {
        var opt = document.createElement('option');
        opt.value = q;
        opt.textContent = q;
        filterQuadrantSel.appendChild(opt);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot listener
  // ---------------------------------------------------------------------------
  function listenStakeholders() {
    var ref = stakeholdersRef();
    if (!ref) return;
    ref.orderBy('name').onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (doc) {
        var d = doc.data() || {};
        d.id = doc.id;
        rows.push(d);
      });
      ctx.rows = rows;
      rebuildFilters();
      paint();
    }, function (err) {
      // A non-owner without a view grant hits a permission-denied read —
      // expected, not an error to surface; paint() already hides the
      // card via the owner-only-card CSS class.
      console.warn(ns, 'listen error (expected if not granted view access)', err && err.code);
    });
  }

  // ---------------------------------------------------------------------------
  // Context detection + Add-form visibility (owner-only, matching
  // canWrite() — no window.drAccess.canUseAction check, since writes
  // aren't grantable for this card; see firestore.rules)
  // ---------------------------------------------------------------------------
  function detectContextFromDOM() {
    card = document.getElementById('stakeholderRegisterCard');
    tbody = $('#stakeholderTable tbody');
    nameInput = $('#stakeholder-name');
    roleInput = $('#stakeholder-role');
    orgInput = $('#stakeholder-organization');
    emailInput = $('#stakeholder-email');
    phoneInput = $('#stakeholder-phone');
    influenceSel = $('#stakeholder-influence');
    interestSel = $('#stakeholder-interest');
    currentEngSel = $('#stakeholder-current-engagement');
    desiredEngSel = $('#stakeholder-desired-engagement');
    requirementsInput = $('#stakeholder-requirements');
    notesInput = $('#stakeholder-notes');
    addBtn = $('#stakeholder-add');
    cancelEditBtn = $('#stakeholder-cancel-edit');
    filterInfluenceSel = $('#stakeholderFilterInfluence');
    filterInterestSel = $('#stakeholderFilterInterest');
    filterQuadrantSel = $('#stakeholderFilterQuadrant');
    filterEngagementSel = $('#stakeholderFilterEngagement');

    ctx.biz = window.BIZ_KEY || window.businessKey || null;
    ctx.proj = window.PROJECT_KEY || 'default';

    var user =
      (window.auth && window.auth.currentUser) ||
      (window.firebase && window.firebase.auth && window.firebase.auth().currentUser) ||
      null;
    ctx.userEmail = (user && user.email) || '';
    ctx.userUid = (user && user.uid) || '';
    ctx.isOwner = !!ctx.userEmail && ctx.userEmail.toLowerCase() === OWNER_EMAIL.toLowerCase();
  }

  function applyWriteAccess() {
    var addOnlyEls = document.querySelectorAll('.stakeholder-add-only');
    for (var i = 0; i < addOnlyEls.length; i++) {
      var el = addOnlyEls[i];
      if (el.id === 'stakeholder-cancel-edit') {
        if (!canWrite()) el.style.display = 'none';
        continue;
      }
      el.style.display = canWrite() ? '' : 'none';
    }
    paint();
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init() {
    detectContextFromDOM();
    if (!ctx.biz || !card) return;

    populateStaticSelects();
    bindTableEvents();
    bindFilters();
    bindPagination();
    bindAdd();
    bindSortHeader();
    listenStakeholders();

    if (window.drAccess) window.drAccess.whenReady().then(applyWriteAccess);
    else applyWriteAccess();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
