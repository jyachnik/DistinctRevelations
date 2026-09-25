// Public/JS/dr-access-control.js
// Resolves the current user's role for the current project, reads the
// Permissions matrix (Settings ▸ Permissions, per-project) that role is
// checked against, and applies whole-card hiding for every report a role
// hasn't been granted. Report-index.js and individual card modules read
// window.drAccess.canViewReport()/canUseAction() to gate sidebar entries
// and card-specific functionality; see permissions.js for the matrix data
// shape and the "hide-only, never grant" rule for actions that are still
// hardcoded owner-only at the Firestore rules layer.
//
// Resolved ONCE per page load — select-project.js always does a full
// location.replace() navigation when switching projects, so there's no
// live mid-session project change to invalidate a cache for.

(function () {
  'use strict';

  var TAG = '[dr-access-control]';
  function log() { console.log.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function warn() { console.warn.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function error() { console.error.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }

  var OWNER_EMAIL = 'john@distinctrevelations.com';

  var readyResolvers = [];
  var readyPromise = new Promise(function (resolve) { readyResolvers.push(resolve); });

  // "Mark Done" -> "markDone" — identical to permissions.js's actionSlug(),
  // duplicated rather than shared (this repo's modules are each
  // self-contained, no shared-utils file convention to hook into).
  function actionSlug(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+(.)/g, function (_, c) { return c.toUpperCase(); });
  }

  function resolveBusinessKey() {
    var params = new URLSearchParams(window.location.search || '');
    return params.get('business') || (window.localStorage && window.localStorage.getItem('businessKey')) || window.BIZ_KEY || null;
  }

  function resolveProjectKey() {
    return window.PROJECT_KEY || (window.localStorage && window.localStorage.getItem('projectKey')) || 'default';
  }

  function waitForFirebase() {
    return new Promise(function (resolve) {
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        if (window.db && window.auth) {
          clearInterval(iv);
          resolve();
        } else if (tries > 150) {
          clearInterval(iv);
          warn('db/auth never appeared after 15s — access control cannot resolve.');
          resolve();
        }
      }, 100);
    });
  }

  function waitForUser(auth) {
    return new Promise(function (resolve) {
      if (auth.currentUser) return resolve(auth.currentUser);
      var unsub = auth.onAuthStateChanged(function (user) {
        if (user) { unsub && unsub(); resolve(user); }
      });
    });
  }

  var reportPermissions = {};

  // Reports that bypass this matrix entirely for view access — currently
  // none. Meetings/Events went through a few iterations (grantable, then
  // always-open) before landing on: a normal, matrix-governed checkbox
  // like every other card (see permissions.js's own ALWAYS_VISIBLE_IDS,
  // kept in sync by hand with this).
  var ALWAYS_VISIBLE_REPORTS = {};

  window.drAccess = {
    ready: false,
    role: null,
    canViewReport: function (reportId) {
      if (ALWAYS_VISIBLE_REPORTS[reportId]) return true;
      if (window.drAccess.role === 'owner') return true;
      if (!window.drAccess.ready || !window.drAccess.role) return false;
      var perm = reportPermissions[reportId];
      return !!(perm && perm[window.drAccess.role] === true);
    },
    canUseAction: function (reportId, actionLabel) {
      if (window.drAccess.role === 'owner') return true;
      if (!window.drAccess.ready || !window.drAccess.role) return false;
      var perm = reportPermissions[reportId];
      var actionPerm = perm && perm.actions && perm.actions[actionSlug(actionLabel)];
      return !!(actionPerm && actionPerm[window.drAccess.role] === true);
    },
    // Could a given role view this report? Used by the Status Report to work
    // out which roles may open a saved copy (owner always can).
    canRoleViewReport: function (role, reportId) {
      if (role === 'owner') return true;
      var perm = reportPermissions[reportId];
      return !!(perm && perm[role] === true);
    },
    // AI wording versions (Permissions: "AI wording — Executive version" / "— Detail version").
    // A role with neither ticked keeps the current detailed wording, so existing roles are unchanged.
    // The owner has both. Mirrored on the server in functions/ask-handler.js.
    canRoleUseVersion: function (role, version) {
      if (role === 'owner') return true;
      var e = reportPermissions.aiExecutiveVersionAction, d = reportPermissions.aiDetailVersionAction;
      var exec = !!(e && e[role] === true), detail = !!(d && d[role] === true);
      if (!exec && !detail) detail = true;
      return version === 'executive' ? exec : detail;
    },
    canUseVersion: function (version) {
      if (!window.drAccess.role) return false;
      return window.drAccess.canRoleUseVersion(window.drAccess.role, version);
    },
    whenReady: function () { return readyPromise; }
  };

  var FILLER_QUOTES = [
    'Plan the work, work the plan.',
    'Scope, time, cost — pick your trade-offs deliberately, never by accident.',
    'A project without a critical path is just a guess with a due date.',
    'Risks you name and track lose their power to surprise you.',
    'Progress you can’t measure is just motion.',
    'The plan is a hypothesis — the schedule tells you if it’s still true.',
    'Every stakeholder deserves the same facts, delivered on the same cadence.',
    'What gets tracked gets managed.'
  ];
  function stableIndex(seed, mod) {
    var h = 0;
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return h % mod;
  }

  // A picture card (the same elegant quote-card design used for the Risk
  // Heat Map / Risk Reserve picture — dark navy gradient, serif italic
  // quote, oversized gold quote mark — every filler picture uses this one
  // consistent look now, each just with its own different quote).
  // Pictures are ONLY ever used to balance a grid row that still has at
  // least one visible card — never in place of a hidden card on its own.
  // `forced` (optional) pins a specific quote/attribution instead of the
  // random-but-stable one — used at two specific, named positions (see
  // layoutRows() below) rather than every filler picture everywhere.
  var pictureCount = 0;
  function makePicture(forced) {
    pictureCount++;
    var seed = 'picture' + pictureCount;
    var el = document.createElement('section');
    el.className = 'card report-filler dr-row-picture';
    el.setAttribute('aria-hidden', 'true');
    var box = document.createElement('div');
    box.className = 'dr-report-filler-box' + (forced && forced.shapeClass ? ' ' + forced.shapeClass : '');
    if (forced && forced.customHtml) {
      box.innerHTML = forced.customHtml;
    } else {
      var quote = (forced && forced.quote) || FILLER_QUOTES[stableIndex(seed, FILLER_QUOTES.length)];
      box.innerHTML = '<span class="dr-report-filler-mark" aria-hidden="true">“</span>' +
        '<p class="dr-report-filler-quote">' + quote + '”</p>' +
        (forced && forced.attribution ? '<p class="dr-report-filler-attribution">— ' + forced.attribution + '</p>' : '');
    }
    el.appendChild(box);
    return el;
  }

  // The two specific pictures requested to land at named positions: the
  // filler between Risk Exposure Trend and Resource Hours Trend (when
  // Defect Trend is hidden for the current role) — a circle-shaped PMBOK
  // Guide quote — and the filler immediately to the right of Top Slipped
  // Tasks (when its 2-column row partner is hidden) — a triangle-shaped
  // Maslow's Hierarchy of Needs pyramid with a Maslow quote at the bottom.
  var RISK_ANALYSIS_QUOTE = {
    shapeClass: 'dr-shape-circle',
    quote: 'Qualitative risk analysis assesses the priority of identified risks, using their relative probability of occurrence and their corresponding impact on project objectives.',
    attribution: 'PMI, A Guide to the Project Management Body of Knowledge (PMBOK® Guide)'
  };
  var MASLOW_HIERARCHY_PICTURE = {
    shapeClass: 'dr-shape-triangle',
    customHtml:
      '<div class="dr-maslow-pyramid">' +
        '<div class="dr-maslow-tier dr-maslow-tier-5" title="Self-Actualization"></div>' +
        '<div class="dr-maslow-tier dr-maslow-tier-4" title="Esteem"></div>' +
        '<div class="dr-maslow-tier dr-maslow-tier-3" title="Love / Belonging"></div>' +
        '<div class="dr-maslow-tier dr-maslow-tier-2" title="Safety"></div>' +
        '<div class="dr-maslow-tier dr-maslow-tier-1" title="Physiological"></div>' +
      '</div>' +
      '<span class="dr-report-filler-mark dr-maslow-mark" aria-hidden="true">“</span>' +
      '<p class="dr-report-filler-quote dr-maslow-quote">What a man can be, he must be.”</p>' +
      '<p class="dr-report-filler-attribution">— Abraham Maslow, <em>Motivation and Personality</em></p>'
  };

  function place(el, row, col) {
    el.setAttribute('data-dr-row', row);
    el.style.setProperty('--dr-row', row);
    if (col) el.style.setProperty('--dr-col', col);
  }
  function isHidden(el) { return el.classList.contains('report-hidden'); }

  // Lays out one grid container's cards in fixed rows of perRow (in
  // document order) and balances each row with pictures:
  //   3 per row: 3 visible -> as is; 2 visible -> card, PICTURE, card;
  //              1 visible -> PICTURE, card, PICTURE (card centered);
  //              0 visible -> the row disappears (no pictures).
  //   2 per row: 2 visible -> as is; 1 visible -> the card keeps its slot
  //              and a picture takes the other; 0 -> the row disappears.
  // Rows are numbered only for rows that show something, so a vanished row
  // leaves no gap. Returns the next free row number.
  function layoutRows(container, perRow) {
    container.querySelectorAll(':scope > .dr-row-picture').forEach(function (n) { n.remove(); });
    container.querySelectorAll(':scope > [data-dr-row]').forEach(function (n) {
      n.removeAttribute('data-dr-row');
      n.style.removeProperty('--dr-row');
      n.style.removeProperty('--dr-col');
    });
    var cards = Array.prototype.filter.call(container.children, function (c) {
      return c.classList.contains('card') && !c.classList.contains('dr-row-picture');
    });
    var row = 1;
    for (var i = 0; i < cards.length; i += perRow) {
      var group = cards.slice(i, i + perRow);
      var vis = group.filter(function (c) { return !isHidden(c); });
      if (!vis.length) continue;
      if (vis.length === perRow) {
        vis.forEach(function (c, k) { place(c, row, k + 1); });
      } else if (perRow === 3 && vis.length === 2) {
        place(vis[0], row, 1);
        var midForced = (vis[0].id === 'riskExposureTrendCard' && vis[1].id === 'resourceHoursTrendCard') ? RISK_ANALYSIS_QUOTE : null;
        var mid = makePicture(midForced); container.appendChild(mid); place(mid, row, 2);
        place(vis[1], row, 3);
      } else if (perRow === 3) {
        var left = makePicture(), right = makePicture();
        container.appendChild(left); container.appendChild(right);
        place(left, row, 1); place(vis[0], row, 2); place(right, row, 3);
      } else {
        var slot = group.indexOf(vis[0]) + 1;
        var picForced = (vis[0].id === 'topSlippedCard' && slot === 1) ? MASLOW_HIERARCHY_PICTURE : null;
        var pic = makePicture(picForced); container.appendChild(pic);
        place(vis[0], row, slot); place(pic, row, slot === 1 ? 2 : 1);
      }
      row++;
    }
    return row;
  }

  function layoutGridRows() {
    var chartsRow = document.querySelector('.dashboard-charts-row');
    if (!chartsRow) return;
    var twoCol = chartsRow.querySelector(':scope > .charts-row-two-col');
    if (twoCol) {
      var anyVisible = layoutRows(twoCol, 2) > 1;
      twoCol.classList.toggle('report-hidden', !anyVisible);
    }
    var nextRow = layoutRows(chartsRow, 3);
    if (twoCol) {
      twoCol.removeAttribute('data-dr-row');
      twoCol.style.removeProperty('--dr-row');
      if (!isHidden(twoCol)) place(twoCol, nextRow);
    }
  }

  // Summary tiles (one strip): a hidden tile is simply removed and the rest
  // share the width — no pictures here. If none are left, drop the strip
  // and its spacer entirely.
  function layoutSummaryRow() {
    var row = document.querySelector('.dashboard-summary-row');
    if (!row) return;
    var any = Array.prototype.some.call(row.children, function (c) { return !isHidden(c); });
    row.classList.toggle('report-hidden', !any);
    var spacer = document.querySelector('.dashboard-summary-row-spacer');
    if (spacer) spacer.classList.toggle('report-hidden', !any);
  }

  // Whole-card hiding — loops window.drReportList (report-index.js), which
  // already carries every real card's id, published for exactly this kind
  // of cross-cutting use. !important sidesteps needing to understand or
  // replicate each card's own bespoke visibility CSS (some use
  // .owner-only-card.owner{display:block}, others a card-specific
  // :not(.owner) rule) — this always wins regardless. Then rows are
  // balanced with pictures where the rule above calls for them.
  function applyReportVisibility() {
    var list = window.drReportList || [];
    list.forEach(function (rep) {
      var el = document.getElementById(rep.id);
      if (!el) return;
      el.classList.toggle('report-hidden', !window.drAccess.canViewReport(rep.id));
    });
    layoutSummaryRow();
    layoutGridRows();
  }

  // Hardcoded, not Permissions-matrix-governed (explicit owner request) —
  // the Time Frame control simply doesn't apply to the Admin role.
  function applyAdminOverrides(role) {
    if (role !== 'admin') return;
    var el = document.getElementById('chartsGlobalTimeframe');
    if (el) el.classList.add('report-hidden');
  }

  function finish(role, perms) {
    window.drAccess.role = role;
    reportPermissions = perms || {};
    window.drAccess.ready = true;
    log('resolved', { role: role, reportCount: Object.keys(reportPermissions).length });
    applyReportVisibility();
    applyAdminOverrides(role);
    readyResolvers.forEach(function (resolve) { resolve(); });
    try { window.dispatchEvent(new CustomEvent('dr-access:ready')); } catch (e) {}
  }

  function start() {
    waitForFirebase().then(function () {
      var auth = window.auth, db = window.db;
      if (!auth || !db) { finish(null, {}); return; }
      waitForUser(auth).then(function (user) {
        var bizKey = resolveBusinessKey();
        var projKey = resolveProjectKey();
        if (!bizKey) { warn('no business key; treating as no access.'); finish(null, {}); return; }

        var email = ((user && user.email) || '').toLowerCase().trim();
        var projRef = db.collection('businesses').doc(bizKey).collection('projects').doc(projKey);

        if (email === OWNER_EMAIL) {
          projRef.get().then(function (snap) {
            var data = (snap.exists && snap.data()) || {};
            finish('owner', data.reportPermissions || {});
          }).catch(function (err) {
            error('owner project read failed (proceeding as owner anyway)', err);
            finish('owner', {});
          });
          return;
        }

        var uid = user && user.uid;
        if (!uid) { finish(null, {}); return; }

        Promise.all([
          projRef.collection('members').doc(uid).get().catch(function () { return null; }),
          projRef.get().catch(function () { return null; })
        ]).then(function (results) {
          var memberSnap = results[0];
          var projSnap = results[1];
          var role = (memberSnap && memberSnap.exists && memberSnap.data().role) || null;
          var perms = (projSnap && projSnap.exists && projSnap.data().reportPermissions) || {};
          finish(role, perms);
        });
      });
    });
  }

  start();
})();
