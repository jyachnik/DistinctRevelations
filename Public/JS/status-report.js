/* ============================================================================
   Status Report (PDF) — one click builds a project status report from the live
   data and downloads it; optionally a copy is saved to the "Saved reports"
   list in this same window.

   What goes in: only sections the person's role can already view on the
   dashboard (each part of the report is tied to one dashboard card and is
   included only if drAccess.canViewReport(card)). The person can also
   untick whole sections.

   Saved copies: stored at Storage reports/{biz}/{proj}/{id} with a Firestore
   record projects/{proj}/statusReports/{id}. The record's allowedRoles lists
   the roles that can view EVERY section the report contains, and both rule
   files (firestore.rules / storage.rules) show a saved report only to the
   owner and those roles — a report with budget detail is never visible to a
   role that can't see the budget on the dashboard. Deliberately not filed in
   File Manager, whose rules let every project member read every file.

   Layout of this file:
     1. small pure helpers
     2. section definitions (pure builders: data in -> {kv, bullets, tables})
     3. PDF renderer (jsPDF + jspdf-autotable, loaded on first use)
     4. data loading
     5. dialog + saved-reports list
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[status-report]';
  var REPORT_ID = 'statusReportAction';
  var JSPDF_URL = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
  var JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
  var AUTOTABLE_URL = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js';
  var ROLES = ['clientPartner', 'projectManager', 'admin', 'member'];
  var ROLE_LABEL = { owner: 'Owner', clientPartner: 'Client Partner', projectManager: 'Project Manager', admin: 'Admin', member: 'Member' };
  var MAX_ROWS = 8;
  var ANALYSIS_NOTE = 'Each section answers the question a senior executive would ask. The figures come straight from the project data. The Analysis lines are AI-assisted and machine-checked: every figure, date and record ID in them must appear in the figures shown for that section, and any sentence that does not is removed.';

  // ---------------------------------------------------------------------
  // 1. Pure helpers
  // ---------------------------------------------------------------------
  function toDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    var d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(v) {
    var d = toDate(v);
    if (!d) return '—';
    return window.drDateFmt ? window.drDateFmt.date(d) : d.toLocaleDateString('en-US');
  }
  function money(v) {
    var n = Number(v);
    return isNaN(n) ? '—' : (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
  function startOf(d) { var t = new Date(d); t.setHours(0, 0, 0, 0); return t; }
  function isOpen(status) { return !/^(closed|resolved|done|complete|completed|cancelled)$/i.test(String(status || '').trim()); }
  var SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
  function sevRank(s) { return SEVERITY_RANK[String(s || '').trim().toLowerCase()] || 0; }
  function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); if (!s) return '—'; return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function cell(s) { return s == null || s === '' ? '—' : String(s); }
  var STATUS_LABEL = { critical: 'Critical', caution: 'Caution', onTrack: 'On Plan' };

  // jsPDF's built-in fonts only cover Latin-1 (+ a few Windows punctuation
  // marks): swap the characters this app's text commonly contains that they
  // can't draw, and drop anything else outside that range (emoji etc.).
  var TEXT_SWAP = { 8594: '->', 8658: '->', 10003: 'v', 10004: 'v', 8805: '>=', 8804: '<=', 8216: "'", 8217: "'", 8220: '"', 8221: '"', 160: ' ' };
  var TEXT_KEEP = { 9: 1, 10: 1, 8211: 1, 8212: 1, 8226: 1, 8230: 1 };   // tab, newline, en/em dash, bullet, ellipsis
  function pdfText(s) {
    var str = String(s == null ? '' : s), out = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (TEXT_SWAP[c] != null) out += TEXT_SWAP[c];
      else if ((c >= 32 && c <= 126) || (c >= 161 && c <= 255) || TEXT_KEEP[c]) out += str.charAt(i);
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Colour coordination. The words that carry meaning are coloured (the TEXT itself, never a highlight)
  // exactly as the portal colours them: red = late / negative / rated high, amber = caution, green = on
  // track, grey = done. Schedule efficiency, cost efficiency and forecast finish use the portal's own rules
  // (burndown.js): an index of 1.00 or more is green, 0.90 to 0.99 is amber, below 0.90 is red; a forecast
  // finish on or ahead of plan is green, 1 to 9 days late is amber, 10 or more days late is red.
  //   signed figures: minus = bold red, plus = bold black
  // ---------------------------------------------------------------------
  var C_RED = [221, 51, 51], C_AMBER = [224, 168, 0], C_GREEN = [47, 158, 68], C_GREY = [138, 138, 138], C_BLACK = [0, 0, 0], C_INK = [30, 30, 30], C_NAVY = [11, 37, 69];
  var RATING = { 'Caution': C_AMBER, 'Critical': C_RED, 'On Plan': C_GREEN };
  function indexColor(v) { return v >= 1 ? C_GREEN : v >= 0.9 ? C_AMBER : C_RED; }
  function lateColor(days) { return days <= 0 ? C_GREEN : days < 10 ? C_AMBER : C_RED; }
  // "14d late" / "3d early" / "On plan" -> days late (negative = early), or null
  function daysLate(label) {
    var s = String(label == null ? '' : label), m = /(\d+)\s*d(?:ays?)?\s*(late|early)/i.exec(s);
    if (m) return m[2].toLowerCase() === 'late' ? +m[1] : -(+m[1]);
    return /on plan/i.test(s) ? 0 : null;
  }
  var RICH_RE = /(Caution|Critical|On Plan)|(\(\d+ rated high\)|\b\d+ rated high\b)|((?<![\w\/.])[+\-−]\$?\d[\d,]*(?:\.\d+)?[KMB%]?)|\b(late|overdue|blocked|rejected|worsening|worsened)\b|\b(on track)\b|(?<=\b(?:are|is) )(complete|completed)\b/g;

  function tokenizeRich(s) {
    var out = [], last = 0, m;
    RICH_RE.lastIndex = 0;
    while ((m = RICH_RE.exec(s)) !== null) {
      if (m.index > last) out.push({ t: s.slice(last, m.index) });
      var w = m[0];
      if (m[1]) out.push({ t: w, bold: true, color: RATING[w] });
      else if (m[2]) out.push(parseInt(/\d+/.exec(w)[0], 10) > 0 ? { t: w, bold: true, color: C_RED } : { t: w });     // "(8 rated high)" is red; "(0 rated high)" is not
      else if (m[3]) out.push({ t: w, bold: true, color: /^\+/.test(w) ? C_BLACK : C_RED });
      else if (m[4]) out.push({ t: w, bold: true, color: C_RED });
      else if (m[5]) out.push({ t: w, bold: true, color: C_GREEN });
      else out.push({ t: w, bold: true, color: C_GREY });
      last = m.index + w.length;
    }
    if (last < s.length) out.push({ t: s.slice(last) });
    return out;
  }
  // text -> [{ t, bold?, color? }]. marks: [{ t, color }] — words to colour first (e.g. the SPI value in its portal colour).
  function richSegments(text, marks) {
    var s = String(text == null ? '' : text), pieces = [{ t: s }];
    (marks || []).forEach(function (mk) {
      if (!mk || !mk.t) return;
      var next = [];
      pieces.forEach(function (pc) {
        if (pc.marked || pc.t.indexOf(mk.t) === -1) { next.push(pc); return; }
        pc.t.split(mk.t).forEach(function (part, i) { if (i) next.push({ t: mk.t, bold: true, color: mk.color, marked: true }); if (part) next.push({ t: part }); });
      });
      pieces = next;
    });
    var out = [];
    pieces.forEach(function (pc) { if (pc.marked) out.push({ t: pc.t, bold: true, color: pc.color }); else tokenizeRich(pc.t).forEach(function (x) { out.push(x); }); });
    return out;
  }
  // A whole table cell: a signed figure, a rating, or a late/overdue/blocked state.
  function cellStyleFor(text) {
    var t = String(text == null ? '' : text).trim(), m = /^([+\-−])\s?\$?\d/.exec(t);
    if (m) return { color: m[1] === '+' ? C_BLACK : C_RED };
    if (RATING[t]) return { color: RATING[t] };
    if (t.length <= 30 && /\b(overdue|blocked|late|rejected)\b/i.test(t)) return { color: C_RED };   // a short state, not a sentence that happens to contain the word
    return null;
  }
  function hex(c) { return c ? c.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('').toUpperCase() : undefined; }
  // The same colouring as Word runs
  function docRuns(text, marks) {
    return richSegments(text, marks).map(function (sg) { return { t: sg.t, bold: sg.bold, color: hex(sg.color) }; });
  }

  // The derived status the Change Control Log shows (there is no stored status).
  function changeStatus(r) {
    if (r.ownerDecision === 'rejected' || r.sponsorDecision === 'rejected') return 'Rejected';
    if (r.ownerDecision === 'approved' && (!r.needsSponsorApproval || r.sponsorDecision === 'approved')) return 'Approved';
    if (r.ownerDecision === 'approved') return 'Pending Sponsor';
    return 'Pending Owner';
  }
  var SIGNOFF_LABEL = { pending: 'Pending', accepted: 'Accepted', conditional: 'Accepted with Conditions', rejected: 'Rejected' };

  // ---------------------------------------------------------------------
  // 2. Section definitions. Each part is tied to ONE dashboard card and is
  //    only built when that card is viewable and its section is selected.
  //    build(D) returns { kv:[[label,value]], bullets:[text], tables:[{title,head,body,note}] }.
  //    D = { today, projectName, project, biz, dom, facts(id), lists:{...}, procurement }
  // ---------------------------------------------------------------------
  function fact(D, id) { var t = D.facts ? D.facts(id) : ''; return t ? [t] : []; }
  function domTable(D, key, title) {
    var t = D.dom && D.dom.tables && D.dom.tables[key];
    if (!t || !t.body || !t.body.length) return [];
    return [{ title: title, head: t.head, body: t.body.slice(0, 6).map(function (r) { return r.map(function (c) { return clip(c, 60); }); }) }];
  }
  function list(D, name) { return (D.lists && D.lists[name]) || []; }

  function riskRows(D) {
    var rows = (D.project && D.project.riskRegister) || [];
    return rows.filter(function (r) { return r && isOpen(r.status); }).map(function (r) {
      var score = num(r.score); if (score == null) score = (num(r.probability) || 0) * (num(r.impact) || 0);
      return { r: r, score: score };
    }).sort(function (a, b) { return b.score - a.score; });
  }
  function openByRow(arr) { return (arr || []).filter(function (r) { return r && isOpen(r.status); }); }

  function pendingChanges(D) { return list(D, 'changeRequests').filter(function (r) { return /^Pending/.test(changeStatus(r)); }); }
  function depIssues(D) {
    var today = startOf(D.today);
    return list(D, 'dependencies').filter(function (r) {
      if (r.status === 'Resolved') return false;
      var d = toDate(r.needByDate);
      return r.status === 'Blocked' || r.status === 'At Risk' || (d && d.getTime() < today.getTime());
    });
  }
  function signoffOverdue(D, r) {
    var d = toDate(r.dueDate);
    return (r.decision || 'pending') === 'pending' && d && d.getTime() < startOf(D.today).getTime();
  }

  var DEFS = [
    { id: 'health', title: 'Health & Performance', parts: [
      { card: 'projectStatusCard', build: function (D) {
        return { kv: [['Project status', STATUS_LABEL[D.project && D.project.projectStatus] || '']], bullets: fact(D, 'projectStatusCard') }; } },
      { card: 'projectProgressCard', build: function (D) {
        return { kv: [['Time elapsed', D.dom.timeElapsed], ['Tasks completed', D.dom.tasksCompleted]] }; } },
      { card: 'qnaSummaryCard', build: function (D) {
        var q = D.dom.qna || {};
        return { kv: [['Q&A open items', 'Questions ' + cell(q.questions) + ' · Tasks ' + cell(q.tasks) + ' · Issues ' + cell(q.issues) + ' · Risks ' + cell(q.risks)]] }; } },
      { card: 'schedulePerformanceCard', build: function (D) {
        return { kv: [['Schedule Performance Index (SPI)', D.dom.spi]], bullets: fact(D, 'schedulePerformanceCard') }; } },
      { card: 'forecastFinishCard', build: function (D) {
        return { kv: [['Forecast finish date', [D.dom.forecast, D.dom.forecastLabel].filter(Boolean).join(' — ')]], bullets: fact(D, 'forecastFinishCard') }; } },
      { card: 'costPerformanceCard', build: function (D) {
        return { kv: [['Cost Performance Index (CPI)', D.dom.cpi]], bullets: fact(D, 'costPerformanceCard') }; } },
      { card: 'healthScorecardCard', build: function (D) { return { bullets: fact(D, 'healthScorecardCard') }; } }
    ] },

    { id: 'schedule', title: 'Schedule & Deliverables', parts: [
      { card: 'burndownCard', build: function (D) { return { bullets: fact(D, 'burndownCard') }; } },
      { card: 'criticalPathCard', build: function (D) { return { bullets: fact(D, 'criticalPathCard'), tables: domTable(D, 'criticalPath', 'Critical path — top items') }; } },
      { card: 'topSlippedCard', build: function (D) { return { bullets: fact(D, 'topSlippedCard'), tables: domTable(D, 'topSlipped', 'Top slipped tasks') }; } },
      { card: 'milestoneTrendCard', build: function (D) { return { bullets: fact(D, 'milestoneTrendCard'), tables: domTable(D, 'milestoneTrend', 'Milestone trend') }; } },
      { card: 'milestoneSection', build: function (D) {
        var today = startOf(D.today), horizon = new Date(today.getTime() + 30 * 86400000);
        var ms = list(D, 'milestones').filter(function (m) { return !m.isSummary; });
        var upcoming = ms.filter(function (m) { var d = toDate(m.dueDate); return d && d >= today && d <= horizon; })
          .sort(function (a, b) { return toDate(a.dueDate) - toDate(b.dueDate); });
        var late = ms.filter(function (m) { var d = toDate(m.dueDate); return d && d < today && (num(m.progress) || 0) < 100 && m.status !== 'Completed'; }).length;
        return { tables: [{ title: 'Meetings & events — next 30 days', head: ['Title', 'Due', 'Status'],
          body: upcoming.slice(0, MAX_ROWS).map(function (m) { return [clip(m.title, 70), fmtDate(m.dueDate), cell(m.status)]; }),
          note: upcoming.length + ' upcoming in the next 30 days' + (late ? '; ' + late + ' past due and not complete.' : '.') }] }; } },
      { card: 'deliverableSignoffCard', build: function (D) {
        var rows = list(D, 'signoffs').slice().sort(function (a, b) {
          var ao = signoffOverdue(D, a) ? 0 : ((a.decision || 'pending') === 'pending' ? 1 : 2);
          var bo = signoffOverdue(D, b) ? 0 : ((b.decision || 'pending') === 'pending' ? 1 : 2);
          return ao - bo || (toDate(a.dueDate) || 0) - (toDate(b.dueDate) || 0);
        });
        var pending = rows.filter(function (r) { return (r.decision || 'pending') === 'pending'; }).length;
        var overdue = rows.filter(function (r) { return signoffOverdue(D, r); }).length;
        return { tables: [{ title: 'Deliverable sign-off', head: ['Item', 'Kind', 'Due', 'Status', 'Decided by'],
          body: rows.slice(0, MAX_ROWS).map(function (r) {
            return [clip(r.title, 60), cell(r.kind), fmtDate(r.dueDate), (SIGNOFF_LABEL[r.decision || 'pending'] || 'Pending') + (signoffOverdue(D, r) ? ' (overdue)' : ''), cell(r.decidedBy)];
          }),
          note: rows.length + ' item(s): ' + pending + ' pending (' + overdue + ' overdue).' }] }; } }
    ] },

    { id: 'risk', title: 'Risks, Issues & Quality', parts: [
      { card: 'riskRegisterCard', build: function (D) {
        var rows = riskRows(D);
        return { tables: [{ title: 'Top open risks', head: ['ID', 'Description', 'Prob.', 'Impact', 'Score', 'Owner', 'Status'],
          body: rows.slice(0, 5).map(function (x) { var r = x.r; return [cell(r.id), clip(r.description, 90), cell(r.probability), cell(r.impact), cell(x.score || ''), cell(r.owner), cell(r.status)]; }),
          note: rows.length + ' open risk(s) in the Risk Register.' }] }; } },
      { card: 'issueLogCard', build: function (D) {
        var rows = openByRow(D.project && D.project.issueLog).sort(function (a, b) { return sevRank(b.severity) - sevRank(a.severity); });
        return { tables: [{ title: 'Open issues', head: ['ID', 'Description', 'Severity', 'Owner', 'Status'],
          body: rows.slice(0, 5).map(function (r) { return [cell(r.id), clip(r.description, 100), cell(r.severity), cell(r.owner), cell(r.status)]; }),
          note: rows.length + ' open issue(s).' }] }; } },
      { card: 'qualityDefectsCard', build: function (D) {
        var rows = openByRow(D.project && D.project.qualityDefects).sort(function (a, b) { return sevRank(b.severity) - sevRank(a.severity); });
        return { tables: [{ title: 'Open defects', head: ['ID', 'Description', 'Severity', 'Assigned to', 'Status'],
          body: rows.slice(0, 5).map(function (r) { return [cell(r.id), clip(r.description, 100), cell(r.severity), cell(r.assignedTo), cell(r.status)]; }),
          note: rows.length + ' open defect(s).' }] }; } }
    ] },

    { id: 'governance', title: 'Governance: Changes, Decisions & Dependencies', parts: [
      { card: 'changeControlLogCard', build: function (D) {
        var rows = pendingChanges(D);
        return { tables: [{ title: 'Change requests awaiting a decision', head: ['Title', 'Type', 'Priority', 'Schedule impact (days)', 'Requested by', 'Status'],
          body: rows.slice(0, MAX_ROWS).map(function (r) { return [clip(r.title, 70), cell(r.changeType), cell(r.priority), cell(r.scheduleImpactDays), cell(r.proposedBy), changeStatus(r)]; }),
          note: rows.length + ' pending of ' + list(D, 'changeRequests').length + ' total.' }] }; } },
      { card: 'decisionLogCard', build: function (D) {
        var rows = list(D, 'decisions').slice().sort(function (a, b) {
          return (toDate(b.dateDecided || b.createdAt) || 0) - (toDate(a.dateDecided || a.createdAt) || 0); });
        return { tables: [{ title: 'Recent decisions', head: ['Decision', 'Category', 'Status', 'Decision-makers', 'Date'],
          body: rows.slice(0, 5).map(function (r) { return [clip(r.title, 80), cell(r.category), cell(r.status), clip(r.decisionMakers, 40), fmtDate(r.dateDecided)]; }),
          note: rows.length + ' decision(s) logged.' }] }; } },
      { card: 'dependenciesCard', build: function (D) {
        var rows = depIssues(D).sort(function (a, b) { return (toDate(a.needByDate) || 8e15) - (toDate(b.needByDate) || 8e15); });
        return { tables: [{ title: 'Dependencies needing attention (blocked, at risk or overdue)', head: ['Predecessor', 'Successor', 'Status', 'Owner', 'Need-by'],
          body: rows.slice(0, MAX_ROWS).map(function (r) { return [clip(r.predecessorTitle, 45), clip(r.successorTitle, 45), cell(r.status), cell(r.owner), fmtDate(r.needByDate)]; }),
          note: rows.length + ' of ' + list(D, 'dependencies').length + ' dependencies need attention.' }] }; } }
    ] },

    { id: 'procurement', title: 'Procurement & Vendors', parts: [
      { card: 'procurementCard', build: function (D) {
        var P = D.procurement, purchases = list(D, 'purchases');
        if (!P) return { bullets: ['Procurement detail is unavailable in this view.'] };
        var sum = function (k) { return purchases.reduce(function (t, r) { return t + (P.moneyOf(r, k) || 0); }, 0); };
        var flagged = purchases.map(function (r) { return { r: r, f: P.flagsOf(r) }; }).filter(function (x) { return x.f.length; });
        return {
          kv: [['Contracted / invoiced / paid', money(sum('contractValue')) + ' / ' + money(sum('invoicedAmount')) + ' / ' + money(sum('paidAmount'))]],
          tables: [{ title: 'Purchases with flags', head: ['Item', 'Vendor', 'Status', 'Contract value', 'Flags'],
            body: flagged.slice(0, MAX_ROWS).map(function (x) {
              return [clip(x.r.item, 55), clip(x.r.vendorName, 30), cell(x.r.status), P.moneyOf(x.r, 'contractValue') == null ? '—' : money(P.moneyOf(x.r, 'contractValue')),
                x.f.map(function (f) { return f.text; }).join('; ')]; }),
            note: purchases.length + ' purchase record(s); ' + flagged.length + ' flagged.' }] }; } }
    ] },

    { id: 'budget', title: 'Budget & Cost Detail', parts: [
      { card: 'costPerformanceCard', build: function (D) {
        return { kv: [['Schedule variance (SV)', D.dom.sv], ['Cost variance (CV)', D.dom.cv], ['Estimate at completion (EAC)', D.dom.eac],
          ['Estimate to complete (ETC)', D.dom.etc], ['Variance at completion (VAC)', D.dom.vac]] }; } },
      { card: 'cashFlowCard', build: function (D) { return { bullets: fact(D, 'cashFlowCard') }; } },
      { card: 'evmCard', build: function (D) { return { bullets: fact(D, 'evmCard') }; } },
      { card: 'budgetVsActualCard', build: function (D) { return { bullets: fact(D, 'budgetVsActualCard') }; } },
      { card: 'etcVsEacCard', build: function (D) { return { bullets: fact(D, 'etcVsEacCard') }; } }
    ] },

    { id: 'people', title: 'Lessons Learned & Stakeholders', parts: [
      { card: 'lessonsLearnedCard', build: function (D) {
        var rows = list(D, 'lessonsLearned').slice().sort(function (a, b) { return (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0); });
        return { tables: [{ title: 'Recent lessons learned', head: ['Lesson', 'Type', 'Impact', 'Status', 'Recommendation'],
          body: rows.slice(0, 5).map(function (r) { return [clip(r.title, 55), cell(r.lessonType), cell(r.impact), cell(r.status), clip(r.recommendation, 80)]; }),
          note: rows.length + ' lesson(s) logged.' }] }; } },
      { card: 'stakeholderRegisterCard', build: function (D) {
        var rank = { high: 3, medium: 2, low: 1 };
        var rows = list(D, 'stakeholders').slice().sort(function (a, b) {
          return ((rank[String(b.influence).toLowerCase()] || 0) + (rank[String(b.interest).toLowerCase()] || 0)) -
                 ((rank[String(a.influence).toLowerCase()] || 0) + (rank[String(a.interest).toLowerCase()] || 0)); });
        return { tables: [{ title: 'Key stakeholders', head: ['Name', 'Role', 'Influence', 'Interest', 'Engagement (now -> desired)'],
          body: rows.slice(0, 6).map(function (r) { return [clip(r.name, 35), clip(r.role, 35), cell(r.influence), cell(r.interest), (r.currentEngagement || r.desiredEngagement) ? cell(r.currentEngagement) + ' -> ' + cell(r.desiredEngagement) : '—']; }),
          note: rows.length + ' stakeholder(s) registered.' }] }; } }
    ] }
  ];

  // Which sections the person can include at all: those with at least one
  // viewable part.
  function availableSections(can) {
    return DEFS.filter(function (s) { return s.parts.some(function (p) { return can(p.card); }); })
      .map(function (s) { return { id: s.id, title: s.title }; });
  }

  // Builds the selected sections from data. `can(card)` gates each part.
  // Returns { sections:[{id,title,kv,bullets,tables}], cards:[cardIds used] }.
  function assemble(D, can, selectedIds) {
    var cards = {}, out = [];
    DEFS.forEach(function (def) {
      if (selectedIds.indexOf(def.id) === -1) return;
      var sec = { id: def.id, title: def.title, kv: [], bullets: [], tables: [] };
      def.parts.forEach(function (p) {
        if (!can(p.card)) return;
        var r = p.build(D) || {};
        cards[p.card] = true;
        (r.kv || []).forEach(function (row) { if (row[1] != null && row[1] !== '' && row[1] !== '—') sec.kv.push(row); });
        (r.bullets || []).forEach(function (b) { if (b) sec.bullets.push(b); });
        (r.tables || []).forEach(function (t) { sec.tables.push(t); });
      });
      if (sec.kv.length || sec.bullets.length || sec.tables.length) out.push(sec);
    });
    return { sections: out, cards: Object.keys(cards) };
  }

  // Executive summary: the AI analysis' own summary when this person may see
  // it, otherwise a short paragraph composed from the numbers already in the
  // sections being included (never from anything they can't see).
  function buildSummary(D, includedCards, can) {
    var has = function (c) { return includedCards.indexOf(c) !== -1; };
    var ai = D.project && D.project.aiAnalysis;
    if (ai && ai.executiveSummary && can('aiAnalysisCard')) {
      var when = toDate(ai.generatedAt);
      return {
        text: ai.executiveSummary,
        note: 'AI-assisted analysis' + (when ? ', last run ' + fmtDate(when) : '') + '.',
        watch: (Array.isArray(ai.watchItems) ? ai.watchItems : []).slice(0, 6).map(function (w) { return w.what; }).filter(Boolean),
        cards: ['aiAnalysisCard']
      };
    }
    var s = [], name = D.projectName || 'The project';
    var st = STATUS_LABEL[D.project && D.project.projectStatus];
    if (has('projectStatusCard') && st) s.push(name + ' is currently rated ' + st + '.');
    if (has('projectProgressCard') && D.dom.timeElapsed && D.dom.tasksCompleted) s.push('Time elapsed is ' + D.dom.timeElapsed + ' with ' + D.dom.tasksCompleted + ' of tasks completed.');
    if (has('schedulePerformanceCard') && D.dom.spi) s.push('The Schedule Performance Index is ' + D.dom.spi + '.');
    if (has('forecastFinishCard') && D.dom.forecast) s.push('The forecast finish date is ' + D.dom.forecast + '.');
    if (has('costPerformanceCard') && D.dom.cpi) s.push('The Cost Performance Index is ' + D.dom.cpi + '.');
    var highRisks = has('riskRegisterCard') ? riskRows(D).filter(function (x) { return x.score >= 15; }).length : null;
    if (highRisks != null) s.push(highRisks + ' open risk(s) score 15 or higher.');
    if (has('deliverableSignoffCard')) {
      var pend = list(D, 'signoffs').filter(function (r) { return (r.decision || 'pending') === 'pending'; }).length;
      s.push(pend + ' deliverable sign-off(s) are pending.');
    }
    if (has('changeControlLogCard')) s.push(pendingChanges(D).length + ' change request(s) await a decision.');
    if (has('dependenciesCard')) s.push(depIssues(D).length + ' dependenc' + (depIssues(D).length === 1 ? 'y needs' : 'ies need') + ' attention.');
    if (!s.length) return null;
    return { text: s.join(' '), note: '', watch: [], cards: [] };
  }

  // ---------------------------------------------------------------------
  // 2b. Executive part (Part 1): C-level summary text, KPI strip and four graphs.
  //     Only for roles that may have the executive wording (Permissions: "AI wording —
  //     Executive version"). Every figure is gated by the same dashboard card as in Part 2.
  // ---------------------------------------------------------------------
  function pctNum(t) { var n = parseFloat(String(t == null ? '' : t).replace('%', '')); return isNaN(n) ? null : n; }
  function scheduleWord(v) { return v >= 1.05 ? 'ahead of plan' : v >= 0.98 ? 'on plan' : v >= 0.9 ? 'slightly behind plan' : 'materially behind plan'; }
  function costWord(v) { return v >= 1.05 ? 'under budget' : v >= 0.98 ? 'on budget' : v >= 0.9 ? 'slightly over budget' : 'materially over budget'; }
  function riskBand(score) { return score >= 15 ? 'high' : score >= 8 ? 'medium' : 'low'; }
  function sevBand(s) { var r = sevRank(s); return r >= 3 ? 'high' : r === 2 ? 'medium' : 'low'; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  function costFigures(D, can) {
    if (!can('costPerformanceCard')) return { bac: null, actual: null, eac: null };
    var p = D.project || {};
    return { bac: num(p.projectBaselineCost), actual: num(p.projectActualCost), eac: num(p.projectEAC) };
  }
  function exposureCounts(D, can) {
    var rows = [];
    function tally(label, arr, band) {
      var c = { label: label, high: 0, medium: 0, low: 0 };
      arr.forEach(function (x) { c[band(x)]++; });
      rows.push(c);
    }
    if (can('riskRegisterCard')) tally('Risks', riskRows(D), function (x) { return riskBand(x.score); });
    if (can('issueLogCard')) tally('Issues', openByRow(D.project && D.project.issueLog), function (r) { return sevBand(r.severity); });
    if (can('qualityDefectsCard')) tally('Defects', openByRow(D.project && D.project.qualityDefects), function (r) { return sevBand(r.severity); });
    return rows;
  }
  function milestoneCounts(D, can) {
    if (!can('milestoneSection')) return null;
    var today = startOf(D.today), soon = new Date(today.getTime() + 30 * 86400000);
    var c = { complete: 0, onTrack: 0, dueSoon: 0, late: 0 };
    list(D, 'milestones').filter(function (m) { return !m.isSummary; }).forEach(function (m) {
      var d = toDate(m.dueDate);
      if (m.status === 'Completed' || (num(m.progress) || 0) >= 100) c.complete++;
      else if (d && d < today) c.late++;
      else if (d && d <= soon) c.dueSoon++;
      else c.onTrack++;
    });
    return (c.complete + c.onTrack + c.dueSoon + c.late) ? c : null;
  }

  // The KPI strip: [{ label, value, sub, color }] for whatever the role may see. `color` is the portal's colour for it.
  function execKpis(D, can) {
    var out = [], p = D.project || {};
    if (can('projectStatusCard') && STATUS_LABEL[p.projectStatus]) {
      var lab = STATUS_LABEL[p.projectStatus];
      out.push({ label: 'Overall status', value: lab, color: RATING[lab], sub: p.projectStatus === 'onTrack' ? 'Delivering to plan' : p.projectStatus === 'caution' ? 'Needs attention' : 'Leadership attention' });
    }
    var spi = can('schedulePerformanceCard') ? num(D.dom.spi) : null;
    if (spi != null) out.push({ label: 'Schedule efficiency', value: D.dom.spi, color: indexColor(spi), sub: scheduleWord(spi) });
    var cpi = can('costPerformanceCard') ? num(D.dom.cpi) : null;
    if (cpi != null) out.push({ label: 'Cost efficiency', value: D.dom.cpi, color: indexColor(cpi), sub: costWord(cpi) });
    if (can('forecastFinishCard') && D.dom.forecast && D.dom.forecast !== '—') {
      var dl = daysLate(D.dom.forecastLabel);
      out.push({ label: 'Forecast finish', value: D.dom.forecast, color: dl == null ? undefined : lateColor(dl), sub: D.dom.forecastLabel || '' });
    }
    return out;
  }

  // The portal colours for the index values and the forecast, applied wherever those figures appear in the text.
  function portalMarks(D, can) {
    var marks = [];
    var spi = can('schedulePerformanceCard') ? num(D.dom.spi) : null, cpi = can('costPerformanceCard') ? num(D.dom.cpi) : null;
    if (spi != null) marks.push({ t: String(D.dom.spi), color: indexColor(spi) });
    if (cpi != null && String(D.dom.cpi) !== String(D.dom.spi)) marks.push({ t: String(D.dom.cpi), color: indexColor(cpi) });
    if (can('forecastFinishCard') && D.dom.forecast && D.dom.forecast !== '—') {
      var dl = daysLate(D.dom.forecastLabel);
      if (dl != null) {
        if (D.dom.forecastLabel) marks.push({ t: '(' + D.dom.forecastLabel + ')', color: lateColor(dl) });
        marks.push({ t: String(D.dom.forecast), color: lateColor(dl) });
      }
    }
    return marks;
  }

  // ---- ranked lists the report (and the "What's next" tables) draw on -------------------------------
  function owner(v) { return String(v == null ? '' : v).trim() || 'Owner not recorded'; }
  function riskScore(r) { var s = num(r.score); return s != null ? s : (num(r.probability) || 0) * (num(r.impact) || 0); }
  function highRisks(D) { return riskRows(D).filter(function (x) { return x.score >= 15; }); }     // riskRows is already highest-score first
  // dependencies that need attention, classed and ranked: blocked, then at risk, then overdue; earliest need-by first
  function depRanked(D) {
    var today = startOf(D.today), rank = { blocked: 0, atrisk: 1, overdue: 2 };
    return depIssues(D).map(function (r) {
      var d = toDate(r.needByDate), cls = r.status === 'Blocked' ? 'blocked' : r.status === 'At Risk' ? 'atrisk' : 'overdue';
      return { r: r, cls: cls, d: d, over: d && d < today ? Math.round((today - startOf(d)) / 86400000) : 0 };
    }).sort(function (a, b) { return rank[a.cls] - rank[b.cls] || (a.d ? a.d.getTime() : 8e15) - (b.d ? b.d.getTime() : 8e15); });
  }
  var DEP_CLASS = { blocked: 'Blocked', atrisk: 'At risk', overdue: 'Overdue' };

  // Who / what / when, from the project records only (an owner the records do not hold is shown as
  // "Owner not recorded"). The first row of a merged list is where to start — see mergeNext/capStart.
  function chartNext(D, can, id) {
    var rows = [], today = startOf(D.today), soon = new Date(today.getTime() + 30 * 86400000);
    function push(who, what, when) { rows.push({ who: who, what: what, when: when || '—' }); }
    if (id === 'progress') {
      var t = D.dom && D.dom.tables && D.dom.tables.topSlipped;
      if (t && can('topSlippedCard')) {
        var iT = t.head.indexOf('Task'), iS = t.head.indexOf('Slip'), iD = t.head.indexOf('Current Due');
        t.body.slice(0, 3).forEach(function (r) { push(owner(''), 'Recover "' + clip(r[iT], 60) + '"' + (iS >= 0 && r[iS] ? ' — slipped ' + r[iS] : ''), iD >= 0 ? r[iD] : ''); });
      }
    } else if (id === 'milestones' && can('milestoneSection')) {
      list(D, 'milestones').filter(function (m) { return !m.isSummary && m.status !== 'Completed' && (num(m.progress) || 0) < 100 && toDate(m.dueDate) && toDate(m.dueDate) <= soon; })
        .sort(function (a, b) { return toDate(a.dueDate) - toDate(b.dueDate); }).slice(0, 4)
        .forEach(function (m) { var d = toDate(m.dueDate); push(owner(''), 'Deliver "' + clip(m.title, 60) + '"' + (d < today ? ' — late' : ''), fmtDate(d)); });
    } else if (id === 'budget' && can('changeControlLogCard')) {
      pendingChanges(D).slice().sort(function (a, b) { return (num(b.costImpact) || 0) - (num(a.costImpact) || 0); }).slice(0, 3).forEach(function (r) {
        push(changeStatus(r) === 'Pending Sponsor' ? 'Client Partner (Sponsor)' : 'Project Owner', 'Decide "' + clip(r.title, 55) + '" (' + (num(r.scheduleImpactDays) != null ? (num(r.scheduleImpactDays) > 0 ? '+' : '') + num(r.scheduleImpactDays) + ' days, ' : '') + (num(r.costImpact) != null ? (num(r.costImpact) < 0 ? '-' : '+') + money(Math.abs(num(r.costImpact))) : 'no cost recorded') + ')', '');
      });
    } else if (id === 'exposure') {
      if (can('riskRegisterCard')) highRisks(D).slice(0, 4).forEach(function (x) { push(owner(x.r.owner), 'Reduce "' + clip(x.r.description, 55) + '" (score ' + x.score + ')', ''); });
      if (can('issueLogCard')) openByRow(D.project && D.project.issueLog).filter(function (r) { return sevRank(r.severity) >= 3; }).slice(0, 2)
        .forEach(function (r) { push(owner(r.owner), 'Resolve issue "' + clip(r.description, 55) + '"', fmtDate(r.targetResolutionDate)); });
    }
    return rows;
  }
  // Vendor purchases flagged (delivery overdue, etc.) — its own function since it feeds the Vendors and
  // dependencies section's suggested next steps, separately from the change-request decisions in Budget's.
  function vendorFlagNext(D, can) {
    var rows = [];
    if (!(can('procurementCard') && D.procurement)) return rows;
    var vendors = list(D, 'vendors'), P = D.procurement;
    list(D, 'purchases').map(function (r) { return { r: r, f: P.flagsOf(r) }; }).filter(function (x) { return x.f.length; }).slice(0, 4).forEach(function (x) {
      var v = vendors.filter(function (vv) { return vv.id === x.r.vendorId || vv.name === x.r.vendorName; })[0];
      rows.push({ who: owner(v && v.vendorOwner), what: 'Resolve "' + clip(x.r.item, 45) + '" (' + clip(x.r.vendorName, 25) + '): ' + x.f.map(function (f) { return f.text; }).join('; '), when: fmtDate(x.r.deliveryDue || x.r.needByDate) });
    });
    return rows;
  }
  // Combines any number of next-step lists into one, flagging only the very first row "start here".
  function mergeNext() {
    var rows = [];
    Array.prototype.forEach.call(arguments, function (arr) { (arr || []).forEach(function (r) { rows.push(Object.assign({}, r, { start: false })); }); });
    if (rows.length) rows[0].start = true;
    return rows;
  }
  // A short, static explanation of how to read each section — the "Exhibit guide". Sections with a
  // graph append that graph's own legend (see execSections) after this lead-in.
  var SECTION_GUIDE = {
    bottom: 'The verdict below draws only on the figures your role can see elsewhere in this report.',
    changed: 'Comparing the two most recent schedule imports, to show which figures moved and by how much.',
    schedule: 'Progress against the calendar, and every milestone in the plan. Schedule efficiency and the forecast finish are measured against the original baseline, not the current schedule window.',
    budget: 'Approved budget, spend to date and the forecast at completion, plus what has been committed to vendors.',
    scope: 'Change requests, deliverable acceptance and open defects — what has changed from the approved scope, and whether it has been accepted.',
    risks: 'Every open risk, issue and defect, split by severity.',
    decisions: 'Everything currently waiting on an owner or sponsor decision, with the impact of leaving it undecided.',
    vendors: 'Dependencies and vendor commitments that could delay the date or add cost, ranked by how urgently each needs attention.',
    next: 'Every milestone, deliverable and dependency due in the next 30 days, earliest first.'
  };
  // Where a reader who wants more than this summary should look in the portal — the exact card names
  // shown in the Reports list there, so the pointer is always accurate and consistent.
  var SECTION_PORTAL = {
    bottom: 'Executive Overview',
    changed: 'Executive Overview and Cost Performance Index',
    schedule: 'Gantt Timeline, Schedule Performance Index and Burndown',
    budget: 'Cost Performance Index and Procurement / Vendor Log',
    scope: 'Change Control Log, Deliverable Sign-off and Quality / Defects Log',
    risks: 'Risk Register (Confirmed), Issue Log (Confirmed) and Quality / Defects Log',
    decisions: 'Change Control Log and Deliverable Sign-off',
    vendors: 'Dependencies and Procurement / Vendor Log',
    next: 'Meetings/Events and Dependencies'
  };

  // The late milestones, earliest due date first (the most overdue) — used only by the milestones
  // graph's Insight (how LONG the worst one has been late, distinct from the counts already stated).
  function lateMilestonesList(D, can) {
    if (!can('milestoneSection')) return [];
    var today = startOf(D.today);
    return list(D, 'milestones').filter(function (m) { return !m.isSummary; }).filter(function (m) {
      if (m.status === 'Completed' || (num(m.progress) || 0) >= 100) return false;
      var d = toDate(m.dueDate); return d && d < today;
    }).map(function (m) { return { title: m.title, due: toDate(m.dueDate) }; }).sort(function (a, b) { return a.due - b.due; });
  }
  // The owner who appears most often across the high-rated risks and high-severity issues, if any name
  // repeats — used only by the exposure graph's Insight (concentration, distinct from the counts already
  // stated and the named actions in Suggested next steps).
  function topExposureOwner(D, can) {
    var names = [];
    if (can('riskRegisterCard')) highRisks(D).forEach(function (x) { var o = String(x.r.owner || '').trim(); if (o) names.push(o); });
    if (can('issueLogCard')) openByRow(D.project && D.project.issueLog).filter(function (r) { return sevRank(r.severity) >= 3; }).forEach(function (r) { var o = String(r.owner || '').trim(); if (o) names.push(o); });
    if (!names.length) return null;
    var counts = {};
    names.forEach(function (n) { counts[n] = (counts[n] || 0) + 1; });
    var top = Object.keys(counts).reduce(function (best, n) { return !best || counts[n] > counts[best] ? n : best; }, null);
    return { name: top, count: counts[top], total: names.length };
  }

  // What each graph tells the team, in the parts the report shows beside/below it. `insight` is a single
  // extra, specific observation — never a restatement of `says`/`meaning`/`worth` — meant to pre-empt the
  // next question a reader would otherwise have to go into the portal to answer.
  //   reading  how to read the picture      says  what the numbers are      meaning  the implication for the team
  //   worth    facts worth checking when two measures appear to disagree     insight  one further, specific fact
  // The schedule verdict comes from ONE yardstick — schedule efficiency and the forecast finish against the original
  // baseline — so the report never calls delivery "ahead" while calling the project late.
  function explainChart(kind, f) {
    var reading = '', says = '', meaning = '', worth = [], insight = '';
    if (kind === 'progress') {
      reading = 'Each bar is a share of the whole project: blue is time elapsed, green is work completed, gold is budget used. The dashed line marks where the calendar says the team should be; a bar that stops short of it is behind.';
      var haveBoth = f.time != null && f.tasks != null, gap = haveBoth ? Math.round(f.tasks - f.time) : 0;
      var behind = (f.spi != null && f.spi < 1) || (f.lateDays != null && f.lateDays > 0);
      if (haveBoth) {
        says = 'Work completed stands at ' + Math.round(f.tasks) + '% against ' + Math.round(f.time) + '% of the schedule elapsed' +
          (Math.abs(gap) < 3 ? ' — level with the calendar.' : gap > 0 ? ' — ' + gap + ' points ahead of the calendar.' : ' — ' + Math.abs(gap) + ' points behind the calendar.');
      } else says = f.time != null ? Math.round(f.time) + '% of the schedule has elapsed.' : Math.round(f.tasks) + '% of tasks are complete.';
      if (f.spent != null) says += ' Spend is at ' + Math.round(f.spent) + '% of the approved budget.';
      if (behind && haveBoth && gap >= -2) {
        // the two views disagree: say so, and show the facts that explain the gap
        says += ' Measured against the original plan the project is behind' + (f.spi != null ? ': schedule efficiency is ' + f.spiText : '') + (f.lateDays != null && f.lateDays > 0 ? ' and the forecast finish is ' + f.lateDays + ' days late' : '') + '.';
        meaning = 'Task count and the calendar look level, but the plan is behind. The two views use different yardsticks: the count treats every task the same and measures time against the current schedule window, while schedule efficiency and the forecast finish are measured against the original baseline. The team should work from the baseline view.';
        if (f.baseEnd && f.curEnd && f.curEnd.getTime() > f.baseEnd.getTime()) worth.push('The current schedule ends on ' + fmtDate(f.curEnd) + ', ' + Math.round((f.curEnd - f.baseEnd) / 86400000) + ' days after the baseline end of ' + fmtDate(f.baseEnd) + ', so time elapsed is measured against a later finish than the original plan.');
        if (f.weighted != null && f.tasks != null && f.weighted < f.tasks - 2) worth.push('Counting partial progress on in-progress tasks, work is ' + Math.round(f.weighted) + '% complete against ' + Math.round(f.tasks) + '% by task count, so the tasks finished so far are shorter than average.');
        if (!worth.length) worth.push('Whether the tasks completed so far are the ones that set the finish date.');
      } else if (haveBoth) {
        meaning = behind
          ? 'Work is behind where the calendar says it should be, so the committed finish date is under pressure. The team will need a recovery plan, or agreement with leadership on a later date.'
          : (Math.abs(gap) < 3 ? 'We are keeping pace with the calendar, so the committed finish date holds unless something new goes wrong.'
            : gap > 0 ? 'Work is ahead of the calendar, which gives the team room to absorb a surprise later on.'
            : 'Work is behind where the calendar says it should be, so the committed finish date is under pressure. The team will need a recovery plan, or agreement with leadership on a later date.');
      }
      if (f.spent != null && f.tasks != null && f.spent > f.tasks + 10) meaning += ' Money is being used faster than work is being completed.';
      // Insight: how spend is tracking against DELIVERED work specifically (a ratio not stated anywhere
      // else — Key Finding states each percentage on its own, never their gap).
      if (f.spent != null && f.tasks != null) {
        var spendGap = Math.round(f.spent - f.tasks);
        insight = Math.abs(spendGap) < 5
          ? 'Spend is tracking closely with delivered work (' + Math.round(f.spent) + '% of budget consumed vs. ' + Math.round(f.tasks) + '% of tasks complete).'
          : spendGap > 0
          ? 'Spend is running ' + spendGap + ' points ahead of delivered work (' + Math.round(f.spent) + '% of budget consumed vs. ' + Math.round(f.tasks) + '% of tasks complete) — cost is outpacing progress.'
          : 'Delivered work is running ' + Math.abs(spendGap) + ' points ahead of spend (' + Math.round(f.tasks) + '% of tasks complete vs. ' + Math.round(f.spent) + '% of budget consumed) — a favourable sign.';
      }
    } else if (kind === 'budget') {
      reading = 'Grey is the approved budget, blue is what the team has spent, and the third bar is where spend is forecast to finish (red if over budget, green if not). The dashed line marks the approved budget.';
      var parts = [];
      if (f.actual != null && f.bac) parts.push('Spend to date is ' + f.fmt(f.actual) + ' of a ' + f.fmt(f.bac) + ' approved budget (' + Math.round(f.actual / f.bac * 100) + '%).');
      if (f.eac != null && f.bac) {
        var v = f.eac - f.bac, pv = Math.abs(v) / f.bac * 100;
        parts.push('The forecast at completion is ' + f.fmt(f.eac) + ', ' + (pv < 0.5 ? 'in line with the approved budget.' : f.fmt(Math.abs(v)) + ' (' + pv.toFixed(pv < 10 ? 1 : 0) + '%) ' + (v > 0 ? 'over' : 'under') + ' budget.'));
        meaning = pv < 0.5 ? 'The forecast matches the approved budget, so no additional funding is being requested.'
          : v > 0 ? 'At the current run-rate the project finishes over budget. The team and leadership will need to agree how to close the gap: fund it, reduce scope, or accept the overrun.'
          : 'The forecast is below the approved budget, which leaves headroom the team can hold as a cushion or release.';
      } else if (f.actual != null && f.bac) meaning = 'There is no cost forecast yet, so the finish position cannot be judged from spend alone.';
      says = parts.join(' ');
      // Insight: how much of the budget is already tied up in vendor contracts — a ratio not stated
      // anywhere else (Key Finding states the vendor total and the budget total separately, never as a share).
      if (f.vendorTotal != null && f.bac) {
        insight = 'Vendor commitments (' + f.fmt(f.vendorTotal) + ') account for ' + Math.round(f.vendorTotal / f.bac * 100) + '% of the approved budget.';
      }
    } else if (kind === 'exposure') {
      reading = 'Each bar counts the open items of one kind, split by severity: red is high, amber is medium and green is low, with the number inside each segment.';
      says = f.total
        ? f.parts.join(', ').replace(/, ([^,]*)$/, ' and $1') + '. Risks are banded by score (15 or more high, 8 to 14 medium).'
        : 'There are no open risks, issues or defects.';
      meaning = !f.total ? 'Nothing is open, so there is no exposure to manage.'
        : f.high ? f.high + (f.high === 1 ? ' item is' : ' items are') + ' rated high — these are the ones the team will most likely need to escalate for a decision; the rest are lower-rated.'
        : 'Nothing open is rated high, so nothing needs to be escalated right now.';
      // Insight: is exposure concentrated with one person, or spread out? Neither Key Finding (counts) nor
      // Suggested next steps (named individual actions) says this.
      if (f.topOwner && f.topOwner.count >= 2) {
        insight = f.topOwner.name + ' owns ' + f.topOwner.count + ' of the ' + f.topOwner.total + ' high-rated risk and issue items — exposure is concentrated with one person.';
      } else if (f.topOwner) {
        insight = 'High-rated exposure is spread across ' + f.topOwner.total + ' different owner' + (f.topOwner.total === 1 ? '' : 's') + ', so no single person carries an outsized share.';
      }
    } else if (kind === 'milestones') {
      reading = 'The ring is every milestone in the plan: grey is complete, green is on track, amber falls due within 30 days and red is late.';
      says = f.complete + ' of ' + f.all + ' milestones are complete' + (f.dueSoon ? '; ' + f.dueSoon + (f.dueSoon === 1 ? ' falls' : ' fall') + ' due within 30 days' : '') +
        (f.late ? ' and ' + f.late + ' ' + (f.late === 1 ? 'is' : 'are') + ' late.' : ', and none are late.');
      meaning = f.late ? (f.late === 1 ? 'One committed date has already been missed' : f.late + ' committed dates have already been missed') + '.' + (f.dueSoon ? ' ' + f.dueSoon + ' more ' + (f.dueSoon === 1 ? 'falls' : 'fall') + ' due in the next 30 days — ' + (f.dueSoon === 1 ? 'that is the next date' : 'those are the next dates') + ' the team is committed to.' : '')
        : f.dueSoon ? 'No committed date has been missed so far. ' + f.dueSoon + (f.dueSoon === 1 ? ' falls' : ' fall') + ' due in the next 30 days — ' + (f.dueSoon === 1 ? 'that is the next date' : 'those are the next dates') + ' the team is committed to.'
        : 'No committed date has been missed and none fall due in the next 30 days.';
      // Insight: HOW LATE the worst one is, by name — a duration neither the ring's counts nor the
      // Suggested next steps table (which lists what to do, not how overdue it already is) states.
      if (f.lateList && f.lateList.length) {
        var worst = f.lateList[0], days = Math.round((startOf(f.today) - startOf(worst.due)) / 86400000);
        insight = 'The longest-outstanding milestone, "' + worst.title + '", has been late by ' + days + ' day' + (days === 1 ? '' : 's') + ' (was due ' + fmtDate(worst.due) + ').';
      }
    }
    return { reading: reading, says: says, meaning: meaning.trim(), worth: worth, insight: insight, caption: says };
  }

  // The four graphs, each { id, title, img:{dataUrl,w,h}, reading, says, meaning, worth[], insight, caption }.
  // Needs window.drReportCharts (canvas).
  function buildCharts(D, can) {
    var CH = (typeof window !== 'undefined') && window.drReportCharts;
    if (!CH) return [];
    var out = [], cost = costFigures(D, can), p = D.project || {};

    // 1. progress against the calendar
    var time = can('projectProgressCard') ? pctNum(D.dom.timeElapsed) : null, tasks = can('projectProgressCard') ? pctNum(D.dom.tasksCompleted) : null;
    var spent = (cost.bac && cost.actual != null) ? cost.actual / cost.bac * 100 : null;
    if (time != null || tasks != null) {
      var spi = can('schedulePerformanceCard') ? num(D.dom.spi) : null, dl = can('forecastFinishCard') ? daysLate(D.dom.forecastLabel) : null;
      out.push(Object.assign({ id: 'progress', title: 'Progress against the calendar', img: CH.progress({
        rows: [{ label: 'Time elapsed', pct: time, color: '#0056b3' }, { label: 'Tasks completed', pct: tasks, color: '#2f9e44' }, { label: 'Budget consumed', pct: spent, color: '#c9a45c' }],
        markerPct: time, markerNote: time != null ? 'Dashed line: where the calendar says the project should be' : '' }) },
        explainChart('progress', { time: time, tasks: tasks, spent: spent, spi: spi, spiText: D.dom.spi, lateDays: dl,
          baseEnd: toDate(p.projectBaselineEndDate), curEnd: toDate(p.projectEndDate), weighted: num(p.autoTaskProgressWeighted) })));
    }

    // 2. budget
    if (cost.bac != null || cost.actual != null || cost.eac != null) {
      var vendorTotal = (can('procurementCard') && D.procurement) ? list(D, 'purchases').reduce(function (t, r) { return t + (D.procurement.moneyOf(r, 'contractValue') || 0); }, 0) : null;
      out.push(Object.assign({ id: 'budget', title: 'Budget position', img: CH.budget(cost) },
        explainChart('budget', { bac: cost.bac, actual: cost.actual, eac: cost.eac, fmt: money, vendorTotal: vendorTotal })));
    }

    // 3. exposure
    var ex = exposureCounts(D, can);
    if (ex.length) {
      var high = ex.reduce(function (t, r) { return t + r.high; }, 0), total = ex.reduce(function (t, r) { return t + r.high + r.medium + r.low; }, 0);
      out.push(Object.assign({ id: 'exposure', title: 'Open exposure by severity', img: CH.exposure({ rows: ex }) },
        explainChart('exposure', { high: high, total: total, parts: exposureParts(ex), topOwner: topExposureOwner(D, can) })));
    }

    // 4. milestones
    var mc = milestoneCounts(D, can);
    if (mc) {
      var all = mc.complete + mc.onTrack + mc.dueSoon + mc.late;
      out.push(Object.assign({ id: 'milestones', title: 'Milestone status', img: CH.milestones(mc) },
        explainChart('milestones', { complete: mc.complete, dueSoon: mc.dueSoon, late: mc.late, all: all, lateList: lateMilestonesList(D, can), today: D.today })));
    }

    // 5. burndown — remaining work over time, reconstructed with the exact same math as the live
    // dashboard chart (window.drBurndownInternals, from burndown.js), so the two can never disagree.
    var BI = window.drBurndownInternals;
    if (can('burndownCard') && BI) {
      var msItems = list(D, 'milestones').map(function (r) { return { id: r.id, data: r }; });
      var actItems = list(D, 'activities').map(function (r) { return { id: r.id, data: r }; });
      var bdTasks = BI.buildTasksFrom(msItems, actItems, false);
      if (bdTasks.length) {
        var bdTimeline = BI.buildTimeline(bdTasks, D.today);
        if (bdTimeline.length > 1) {
          var bdData = BI.computeBurnBurnup(bdTasks, bdTimeline, D.today, 'tasks');
          out.push({ id: 'burndown', title: 'Remaining work over time', img: CH.burndown({ labels: bdTimeline.map(fmtDate), ideal: bdData.plannedRemaining, actual: bdData.actualRemaining, unit: 'tasks remaining' }),
            reading: 'The dashed line is the ideal pace to zero open tasks; the solid line is tasks actually remaining, reconstructed from recorded progress updates.',
            insight: burndownInsight(bdData) });
        }
      }
    }
    // Suggested next steps are attached at the SECTION level (execSections), not per picture — see mergeNext there.
    return out;
  }
  // A trajectory fact — is the gap between actual and ideal remaining work narrowing or widening over the
  // last few periods — distinct from the progress chart's snapshot ("N points ahead/behind right now").
  function burndownInsight(data) {
    var idx = [];
    (data.actualRemaining || []).forEach(function (v, i) { if (v != null) idx.push(i); });
    if (idx.length < 2) return '';
    var span = idx.slice(Math.max(0, idx.length - 4));
    var first = span[0], last = span[span.length - 1], periods = last - first;
    if (periods < 1) return '';
    // gap = ideal remaining minus actual remaining: positive means ahead of the ideal pace, negative
    // means behind it. The DELTA in that gap (not the gap itself) is the trend — "gained" if the team
    // is now further ahead (or less behind) than a few periods ago, "lost" if the reverse — a directional
    // read that stays correct whether the team started ahead of or behind the ideal line.
    var gapFirst = data.plannedRemaining[first] - data.actualRemaining[first];
    var gapLast = data.plannedRemaining[last] - data.actualRemaining[last];
    var rd = Math.round(Math.abs(gapLast - gapFirst));
    if (rd < 1) return 'The project has tracked the ideal pace evenly over the last ' + periods + ' periods, neither gaining nor losing ground.';
    return 'Over the last ' + periods + ' periods, the project has ' + (gapLast > gapFirst ? 'gained' : 'lost') + ' ' + rd + (rd === 1 ? ' task' : ' tasks') + ' ' + (gapLast > gapFirst ? 'on' : 'against') + ' the ideal pace.';
  }
  // "32 open risks (8 rated high), 5 open issues (1 rated high) and 3 open defects (none rated high)"
  function exposureParts(ex) {
    return ex.map(function (r) {
      var tot = r.high + r.medium + r.low, one = 'open ' + r.label.toLowerCase().replace(/s$/, ''), many = 'open ' + r.label.toLowerCase();
      return plural(tot, one, many) + (tot ? (r.high ? ' (' + r.high + ' rated high)' : ' (none rated high)') : '');
    });
  }

  // C-level text. From the AI analysis' executive block when the role may see the analysis and one
  // exists; otherwise composed from the same figures, in the same voice, so the section never comes
  // out empty just because nobody has run the analysis.
  function composeExec(D, can) {
    var name = D.projectName || 'The project', p = D.project || {}, s = [];
    var st = can('projectStatusCard') ? p.projectStatus : null;
    var verdict = st === 'critical' ? 'off track' : st === 'caution' ? 'at risk' : st === 'onTrack' ? 'on track' : '';
    var spi = can('schedulePerformanceCard') ? num(D.dom.spi) : null, cpi = can('costPerformanceCard') ? num(D.dom.cpi) : null;
    var cost = costFigures(D, can), keys = [], risks = [], decisions = [];

    var headline = st && STATUS_LABEL[st] ? name + ' is currently rated ' + STATUS_LABEL[st] + '.' : name + ' — status report.';   // the project's own rating, stated literally
    if (spi != null) s.push('Delivery is ' + scheduleWord(spi) + ' (schedule efficiency ' + D.dom.spi + ').');
    if (cpi != null) s.push('Spend is running ' + costWord(cpi) + ' (cost efficiency ' + D.dom.cpi + ').');
    if (cost.eac != null && cost.bac) { var v = cost.eac - cost.bac; s.push('The cost forecast at completion is ' + money(cost.eac) + (Math.abs(v) / cost.bac < 0.005 ? ', in line with the approved budget.' : ', ' + money(Math.abs(v)) + (v > 0 ? ' above' : ' below') + ' the approved budget.')); }
    if (can('forecastFinishCard') && D.dom.forecast && D.dom.forecast !== '—') keys.push('Forecast finish date is ' + D.dom.forecast + (D.dom.forecastLabel ? ' — ' + D.dom.forecastLabel + '.' : '.'));

    if (can('riskRegisterCard')) {
      var rr = riskRows(D), hi = rr.filter(function (x) { return x.score >= 15; });
      if (rr.length) keys.push(plural(rr.length, 'open risk') + (hi.length ? ' (' + hi.length + ' rated high).' : ' (none rated high).'));
      hi.slice(0, 3).forEach(function (x) { risks.push({ risk: clip(x.r.description, 140), businessImpact: 'Rated ' + x.score + ' out of 25 on the risk register.', response: x.r.owner ? 'Owner: ' + x.r.owner + '.' : '' }); });
    }
    if (can('changeControlLogCard')) {
      var pc = pendingChanges(D);
      if (pc.length) decisions.push({ decision: plural(pc.length, 'change request') + ' awaiting a decision', by: '', consequence: 'Scope, schedule or cost impact stays unresolved until decided.' });
    }
    if (can('deliverableSignoffCard')) {
      var od = list(D, 'signoffs').filter(function (r) { return signoffOverdue(D, r); });
      if (od.length) decisions.push({ decision: plural(od.length, 'deliverable') + ' overdue for acceptance', by: '', consequence: 'Downstream work and billing milestones may slip.' });
    }
    if (can('dependenciesCard')) { var di = depRanked(D); if (di.length) keys.push(plural(di.length, 'dependency', 'dependencies') + ' need attention (' + di.filter(function (x) { return x.cls === 'blocked'; }).length + ' blocked, ' + di.filter(function (x) { return x.cls === 'atrisk'; }).length + ' at risk, ' + di.filter(function (x) { return x.cls === 'overdue'; }).length + ' overdue).'); }
    if (!s.length && !keys.length && !risks.length && !decisions.length && !verdict) return null;
    return { headline: headline, assessment: s.join(' '), keyMessages: keys, risksToObjectives: risks, decisionsNeeded: decisions, outlook: '', source: 'data', note: '' };
  }

  // The executive part is organised by the questions a C-level reader actually asks, in this order.
  // Each section is built only from cards the role can view, and a section with nothing to say is left out.
  //   { id, title, question, lead, paras[], kpis[], bullets[], tables:[{title,head,body,widths,note}], charts[], marks[] }
  function execSections(D, can, t, kpis, charts) {
    var S = [], p = D.project || {}, today = startOf(D.today), soon = new Date(today.getTime() + 30 * 86400000);
    var cost = costFigures(D, can), marks = portalMarks(D, can);
    function chartsOf() { var ids = Array.prototype.slice.call(arguments); return charts.filter(function (c) { return ids.indexOf(c.id) !== -1; }); }
    function has(s) { return s.lead || (s.paras && s.paras.length) || (s.bullets && s.bullets.length) || (s.tables && s.tables.length) || (s.kpis && s.kpis.length) || (s.charts && s.charts.length); }
    // Every section carries the same four blocks (Exhibit guide, Key finding — its normal content below —,
    // Implication for the team, Suggested next steps); guide falls back to the static lead-in when a
    // section doesn't build its own (e.g. by appending a chart's legend).
    function add(s) {
      s.marks = s.marks || marks;
      if (!s.guide) s.guide = SECTION_GUIDE[s.id] || '';
      if (!s.next) s.next = [];
      s.portal = SECTION_PORTAL[s.id] || '';
      if (has(s)) S.push(s);
    }
    function signed(n, fmt) { return (n < 0 ? '-' : '+') + fmt(Math.abs(n)); }
    function more(n, cap, what) { return n > cap ? 'and ' + (n - cap) + ' more ' + what + ' — see the full register.' : ''; }
    // "N of the M things have/lacks X" — grammatical when there is only one to talk about.
    function lackPhrase(n, total, singular, plural, tail) {
      if (n === total && total === 1) return 'The only ' + singular + ' has ' + tail;
      return n + ' of the ' + total + ' ' + plural + ' have ' + tail;
    }

    // 1. Bottom line — the headline priorities across the whole report: the top risk, the top open
    //    decision and the top dependency issue, whichever the role can see.
    var bnext = [];
    if (can('riskRegisterCard')) { var bhr = highRisks(D)[0]; if (bhr) bnext.push({ who: owner(bhr.r.owner), what: 'Reduce "' + clip(bhr.r.description, 55) + '" (score ' + bhr.score + ')', when: '—' }); }
    if (can('changeControlLogCard')) { var bpc = pendingChanges(D)[0]; if (bpc) bnext.push({ who: changeStatus(bpc) === 'Pending Sponsor' ? 'Client Partner (Sponsor)' : 'Project Owner', what: 'Decide "' + clip(bpc.title, 55) + '"', when: '—' }); }
    if (can('dependenciesCard')) { var bdr = depRanked(D)[0]; if (bdr) bnext.push({ who: owner(bdr.r.owner), what: 'Unblock "' + clip(bdr.r.predecessorTitle, 40) + '" → "' + clip(bdr.r.successorTitle, 40) + '" (' + DEP_CLASS[bdr.cls] + ')', when: bdr.d ? fmtDate(bdr.d) : '—' }); }
    add({ id: 'bottom', title: 'Bottom line', question: 'Will we deliver the agreed outcome on time and on budget, and how confident are we?',
      lead: t ? t.headline : '', paras: t && t.assessment ? [t.assessment] : [], kpis: kpis, bullets: t ? (t.keyMessages || []) : [],
      implication: bnext.length ? 'The items below are the ones most likely to change the outcome if left unattended.' : '',
      next: mergeNext(bnext) });

    // 2. What changed — the last two schedule updates (each import stores a snapshot)
    var snaps = can('costPerformanceCard') ? (p.costSnapshots || []).map(function (x) {
      return { d: toDate(x.date), eac: num(x.eac), cpi: num(x.cpi), pct: num(x.percentComplete) };
    }).filter(function (x) { return x.d; }).sort(function (a, b) { return a.d - b.d; }) : [];
    if (snaps.length >= 2) {
      var pa = snaps[snaps.length - 2], pb = snaps[snaps.length - 1], ch = [], cnext = [];
      var costWorsening = pa.cpi != null && pb.cpi != null && pb.cpi < pa.cpi;
      var costImproving = pa.cpi != null && pb.cpi != null && pb.cpi > pa.cpi;
      if (pa.eac != null && pb.eac != null && Math.round(pa.eac) !== Math.round(pb.eac)) ch.push('Forecast cost moved from ' + money(pa.eac) + ' to ' + money(pb.eac) + ' (' + signed(pb.eac - pa.eac, money) + ').');
      if (pa.cpi != null && pb.cpi != null && Math.abs(pa.cpi - pb.cpi) >= 0.005) ch.push('Cost efficiency moved from ' + pa.cpi.toFixed(2) + ' to ' + pb.cpi.toFixed(2) + (costImproving ? ' — improving.' : ' — worsening.'));
      if (pa.pct != null && pb.pct != null && Math.abs(pa.pct - pb.pct) >= 0.5) ch.push('Work complete moved from ' + Math.round(pa.pct) + '% to ' + Math.round(pb.pct) + '%.');
      if (costWorsening) cnext.push({ who: 'Project Owner', what: 'Confirm the cause of the cost efficiency slip before the next update.', when: '—' });
      add({ id: 'changed', title: 'What changed since the last report', question: 'Is it getting better or worse, and what moved?',
        paras: ['Comparing the schedule updates of ' + fmtDate(pa.d) + ' and ' + fmtDate(pb.d) + ':'],
        bullets: ch.length ? ch : ['No material change in the cost forecast, cost efficiency or completion between those two updates.'],
        implication: costWorsening ? 'Cost efficiency is moving in the wrong direction; if that continues the forecast at completion will keep rising.'
          : costImproving ? 'Cost efficiency is recovering, which is worth confirming holds through the next update.'
          : 'Nothing here changes the outlook from the last report.',
        next: mergeNext(cnext) });
    }

    // 3. Schedule
    var progC = chartsOf('progress')[0], msC = chartsOf('milestones')[0], bdC = chartsOf('burndown')[0];
    var spi = can('schedulePerformanceCard') ? num(D.dom.spi) : null, sp = [], mc = milestoneCounts(D, can);
    var spentPct = (cost.bac && cost.actual != null) ? cost.actual / cost.bac * 100 : null;
    if (spi != null) sp.push('Delivery is ' + scheduleWord(spi) + ' (schedule efficiency ' + D.dom.spi + ').');
    if (can('forecastFinishCard') && D.dom.forecast && D.dom.forecast !== '—') sp.push('The forecast finish is ' + D.dom.forecast + (D.dom.forecastLabel ? ' (' + D.dom.forecastLabel + ')' : '') + '.');
    if (mc) {
      var mall = mc.complete + mc.onTrack + mc.dueSoon + mc.late;
      sp.push(mc.complete + ' of ' + mall + ' milestones are complete; ' + mc.late + ' ' + (mc.late === 1 ? 'is' : 'are') + ' late and ' + mc.dueSoon + ' ' + (mc.dueSoon === 1 ? 'falls' : 'fall') + ' due within 30 days.');
    }
    if (spentPct != null) sp.push('Spend is at ' + Math.round(spentPct) + '% of the approved budget.');
    add({ id: 'schedule', title: 'Schedule', question: 'Where are we against the date we committed to?', paras: sp.length ? [sp.join(' ')] : [],
      charts: chartsOf('progress', 'milestones', 'burndown'),
      guide: [SECTION_GUIDE.schedule, progC && progC.reading, msC && msC.reading, bdC && bdC.reading].filter(Boolean).join(' '),
      implication: [progC && progC.meaning, progC && progC.worth && progC.worth.length ? progC.worth.join(' ') : '', msC && msC.meaning].filter(Boolean).join(' '),
      next: mergeNext(chartNext(D, can, 'progress'), chartNext(D, can, 'milestones')) });

    // 4. Budget (and what has been committed to vendors)
    var budC = chartsOf('budget')[0];
    var bp = [], bb = [], purchases = (can('procurementCard') && D.procurement) ? list(D, 'purchases') : [];
    if (cost.actual != null && cost.bac) bp.push('Spend to date is ' + money(cost.actual) + ', ' + Math.round(cost.actual / cost.bac * 100) + '% of the ' + money(cost.bac) + ' approved budget.');
    if (cost.eac != null && cost.bac) {
      var v = cost.eac - cost.bac;
      bp.push('The forecast at completion is ' + money(cost.eac) + (Math.abs(v) / cost.bac < 0.005 ? ', in line with the approved budget.' : ', ' + money(Math.abs(v)) + (v > 0 ? ' over' : ' under') + ' the approved budget.'));
    }
    if (purchases.length) {
      var P = D.procurement, sum = function (k) { return purchases.reduce(function (a, r) { return a + (P.moneyOf(r, k) || 0); }, 0); };
      var nflag = purchases.filter(function (r) { return P.flagsOf(r).length; }).length;
      bb.push('Vendor commitments: ' + money(sum('contractValue')) + ' contracted, ' + money(sum('invoicedAmount')) + ' invoiced, ' + money(sum('paidAmount')) + ' paid across ' + plural(purchases.length, 'purchase') + (nflag ? '; ' + nflag + ' flagged.' : '.'));
    }
    add({ id: 'budget', title: 'Budget', question: 'What have we spent, what will it cost, and are we exposed?', paras: bp.length ? [bp.join(' ')] : [], bullets: bb,
      charts: chartsOf('budget'), guide: [SECTION_GUIDE.budget, budC && budC.reading].filter(Boolean).join(' '),
      implication: budC ? budC.meaning : '', next: mergeNext(chartNext(D, can, 'budget')) });

    // 5. Scope and deliverables
    var sc = [], scnext = [], scOverdue = 0, dh = 0;
    if (can('changeControlLogCard')) {
      var cr = list(D, 'changeRequests');
      if (cr.length) {
        var appr = cr.filter(function (r) { return changeStatus(r) === 'Approved'; }), pend = pendingChanges(D), rej = cr.filter(function (r) { return changeStatus(r) === 'Rejected'; });
        var days = appr.reduce(function (a, r) { return a + (num(r.scheduleImpactDays) || 0); }, 0), cst = appr.reduce(function (a, r) { return a + (num(r.costImpact) || 0); }, 0);
        sc.push(plural(cr.length, 'change request') + ': ' + appr.length + ' approved' + (appr.length ? ' (net ' + signed(days, function (n) { return n + ' days'; }) + ', ' + signed(cst, money) + ')' : '') + ', ' + pend.length + ' awaiting a decision, ' + rej.length + ' rejected.');
      }
    }
    if (can('deliverableSignoffCard')) {
      var so = list(D, 'signoffs');
      if (so.length) {
        var acc = so.filter(function (r) { return r.decision === 'accepted' || r.decision === 'conditional'; }).length, sp2 = so.filter(function (r) { return (r.decision || 'pending') === 'pending'; }).length;
        scOverdue = so.filter(function (r) { return signoffOverdue(D, r); }).length;
        sc.push('Deliverable acceptance: ' + acc + ' of ' + so.length + ' accepted; ' + sp2 + ' pending' + (scOverdue ? ', ' + scOverdue + ' overdue.' : '.'));
        so.filter(function (r) { return signoffOverdue(D, r); }).slice(0, 3).forEach(function (r) { scnext.push({ who: 'Client Partner', what: 'Accept "' + clip(r.title, 55) + '"', when: fmtDate(r.dueDate) }); });
      }
    }
    if (can('qualityDefectsCard')) {
      var dq = openByRow(p.qualityDefects); dh = dq.filter(function (r) { return sevRank(r.severity) >= 3; }).length;
      sc.push('Quality: ' + plural(dq.length, 'open defect') + (dq.length ? (dh ? ' (' + dh + ' rated high).' : ' (none rated high).') : '.'));
      dq.filter(function (r) { return sevRank(r.severity) >= 3; }).slice(0, 2).forEach(function (r) { scnext.push({ who: owner(r.assignedTo), what: 'Fix defect "' + clip(r.description, 55) + '" (' + cell(r.severity) + ')', when: '—' }); });
    }
    add({ id: 'scope', title: 'Scope and deliverables', question: 'Are we still building what was approved, and is it being accepted?', bullets: sc,
      implication: (scOverdue || dh) ? 'Overdue acceptance and open high-severity defects both stand in the way of calling this scope complete.' : (sc.length ? 'Nothing here is currently blocking scope from being called complete.' : ''),
      next: mergeNext(scnext) });

    // 6. Risks and issues — the counts, then every high-rated risk with its owner, ranked
    var exC = chartsOf('exposure')[0];
    var ex = exposureCounts(D, can), rp = [], rtables = [];
    if (ex.length) {
      var tot = ex.reduce(function (a, r) { return a + r.high + r.medium + r.low; }, 0);
      rp.push(tot ? exposureParts(ex).join(', ').replace(/, ([^,]*)$/, ' and $1') + '.' : 'There are no open risks, issues or defects.');
    }
    if (can('riskRegisterCard')) {
      var hr = highRisks(D), CAP_R = 15;
      if (hr.length) {
        var noResp = hr.slice(0, CAP_R).filter(function (x) { return !x.r.responseStrategy; }).length;
        rtables.push({ title: 'High-rated risks (score 15 or more), highest first — start with #1', head: ['#', 'Risk', 'Score', 'Owner', 'Status / response'], widths: [5, 44, 8, 19, 24],
          body: hr.slice(0, CAP_R).map(function (x, i) { return [String(i + 1), clip(x.r.description, 95), String(x.score), owner(x.r.owner), [cell(x.r.status), x.r.responseStrategy].filter(function (z) { return z && z !== '—'; }).join(' — ') || '—']; }),
          note: more(hr.length, CAP_R, 'high-rated risks'),
          insight: noResp ? lackPhrase(noResp, hr.slice(0, CAP_R).length, 'listed risk', 'listed risks', 'no response strategy recorded.') : 'Every listed risk has a recorded response strategy.' });
      }
    }
    var hiss = can('issueLogCard') ? openByRow(p.issueLog).filter(function (r) { return sevRank(r.severity) >= 3; }).sort(function (a, b) { return sevRank(b.severity) - sevRank(a.severity); }) : [];
    var hdef = can('qualityDefectsCard') ? openByRow(p.qualityDefects).filter(function (r) { return sevRank(r.severity) >= 3; }) : [];
    if (hiss.length || hdef.length) {
      var ib = hiss.slice(0, 6).map(function (r) { return ['Issue', cell(r.id), clip(r.description, 80), owner(r.owner), fmtDate(r.targetResolutionDate)]; })
        .concat(hdef.slice(0, 6).map(function (r) { return ['Defect', cell(r.id), clip(r.description, 80), owner(r.assignedTo), '—']; }));
      var noTarget = hiss.filter(function (r) { return !r.targetResolutionDate; }).length;
      rtables.push({ title: 'High-rated issues and defects', head: ['Type', 'ID', 'Description', 'Owner', 'Target date'], widths: [9, 10, 44, 20, 17], body: ib,
        note: more(hiss.length, 6, 'high-rated issues') || more(hdef.length, 6, 'high-rated defects'),
        insight: hiss.length ? (noTarget ? lackPhrase(noTarget, hiss.length, 'open issue', 'open issues', 'no target resolution date.') : 'Every open issue has a target resolution date.') : '' });
    }
    add({ id: 'risks', title: 'Risks and issues', question: 'What could hurt us, and who owns it?', paras: rp, tables: rtables, charts: chartsOf('exposure'),
      guide: [SECTION_GUIDE.risks, exC && exC.reading].filter(Boolean).join(' '),
      implication: exC ? exC.meaning : '', next: mergeNext(chartNext(D, can, 'exposure')) });

    // 7. Decisions and support needed — each with who decides
    var drows = [], dnext = [];
    if (can('changeControlLogCard')) pendingChanges(D).slice(0, 6).forEach(function (r) {
      var dd = num(r.scheduleImpactDays), cc = num(r.costImpact);
      var who = changeStatus(r) === 'Pending Sponsor' ? 'Client Partner (Sponsor)' : 'Project Owner';
      var impact = (dd != null || cc != null) ? [dd != null ? (dd > 0 ? '+' : dd < 0 ? '-' : '') + Math.abs(dd) + ' days' : '', cc != null ? signed(cc, money) : ''].filter(Boolean).join(', ') : 'Impact not recorded';
      drows.push(['Decide: ' + clip(r.title, 70), who, '—', impact]);
      dnext.push({ who: who, what: 'Decide "' + clip(r.title, 60) + '" (' + impact + ')', when: '—' });
    });
    if (can('deliverableSignoffCard')) list(D, 'signoffs').filter(function (r) { return signoffOverdue(D, r); }).slice(0, 6).forEach(function (r) {
      drows.push(['Accept: ' + clip(r.title, 70), 'Client Partner', fmtDate(r.dueDate), 'Overdue since ' + fmtDate(r.dueDate)]);
      dnext.push({ who: 'Client Partner', what: 'Accept "' + clip(r.title, 60) + '"', when: fmtDate(r.dueDate) });
    });
    var noImpact = drows.filter(function (r) { return r[3] === 'Impact not recorded'; }).length;
    add({ id: 'decisions', title: 'Decisions and support needed', question: 'What do you need from me?',
      paras: !drows.length && (can('changeControlLogCard') || can('deliverableSignoffCard')) ? ['Nothing is currently waiting on leadership.'] : [],
      tables: drows.length ? [{ head: ['Decision needed', 'Decision-maker', 'Needed by', 'Impact if not decided'], widths: [38, 20, 13, 29], body: drows,
        insight: noImpact ? lackPhrase(noImpact, drows.length, 'pending decision', 'pending decisions', 'no schedule or cost impact recorded, making it harder to prioritize by value.') : 'Every pending decision has a recorded schedule or cost impact.' }] : [],
      implication: drows.length ? plural(drows.length, 'item') + ' need' + (drows.length === 1 ? 's' : '') + ' a decision before work can proceed with certainty.' : '',
      next: mergeNext(dnext) });

    // 8. Vendors and dependencies — how many, which ones, who owns them, in the order to tackle them
    var vp = [], vtables = [], vnext = [];
    if (can('dependenciesCard')) {
      var dr = depRanked(D), CAP_D = 10;
      if (dr.length) {
        var nb = dr.filter(function (x) { return x.cls === 'blocked'; }).length, na = dr.filter(function (x) { return x.cls === 'atrisk'; }).length, no = dr.filter(function (x) { return x.cls === 'overdue'; }).length;
        vp.push(plural(dr.length, 'dependency', 'dependencies') + ' need attention: ' + nb + ' blocked, ' + na + ' at risk and ' + no + ' overdue.');
        var worstOver = dr.reduce(function (best, x) { return x.over > (best ? best.over : 0) ? x : best; }, null);
        vtables.push({ title: 'Dependencies needing attention — blocked first, then at risk, then overdue; earliest date first. Start with #1', head: ['#', 'Dependency', 'Status', 'Owner', 'Needed by', 'Impact'], widths: [5, 26, 10, 15, 15, 29],
          body: dr.slice(0, CAP_D).map(function (x, i) { return [String(i + 1), clip(x.r.predecessorTitle, 40) + ' → ' + clip(x.r.successorTitle, 40), DEP_CLASS[x.cls], owner(x.r.owner), x.d ? fmtDate(x.d) + (x.over ? ' (' + x.over + ' days overdue)' : '') : '—', clip(x.r.impact, 90) || '—']; }),
          note: more(dr.length, CAP_D, 'dependencies'),
          insight: (worstOver && worstOver.over > 0) ? 'The longest-outstanding item, "' + clip(worstOver.r.predecessorTitle, 30) + '" → "' + clip(worstOver.r.successorTitle, 30) + '", has been overdue for ' + worstOver.over + ' day' + (worstOver.over === 1 ? '' : 's') + '.' : '' });
        dr.slice(0, 4).forEach(function (x) { vnext.push({ who: owner(x.r.owner), what: DEP_CLASS[x.cls] + ': "' + clip(x.r.predecessorTitle, 40) + '" → "' + clip(x.r.successorTitle, 40) + '"', when: x.d ? fmtDate(x.d) : '—' }); });
      }
    }
    if (purchases.length) {
      var Pp = D.procurement, vendors = list(D, 'vendors');
      var fl = purchases.map(function (r) { return { r: r, f: Pp.flagsOf(r) }; }).filter(function (x) { return x.f.length; });
      if (fl.length) {
        var vendorCounts = {};
        fl.forEach(function (x) { var n = x.r.vendorName || 'an unnamed vendor'; vendorCounts[n] = (vendorCounts[n] || 0) + 1; });
        var topVendor = Object.keys(vendorCounts).reduce(function (b, n) { return !b || vendorCounts[n] > vendorCounts[b] ? n : b; }, null);
        vtables.push({ title: 'Vendor purchases with flags', head: ['Purchase', 'Vendor', 'Flag', 'Vendor owner', 'Delivery due'], widths: [26, 20, 24, 16, 14],
          body: fl.slice(0, 5).map(function (x) {
            var vv = vendors.filter(function (z) { return z.id === x.r.vendorId || z.name === x.r.vendorName; })[0];
            return [clip(x.r.item, 55), clip(x.r.vendorName, 30), x.f.map(function (f) { return f.text; }).join('; '), owner(vv && vv.vendorOwner), fmtDate(x.r.deliveryDue)];
          }), note: more(fl.length, 5, 'flagged purchases'),
          insight: fl.length < 2 ? '' : vendorCounts[topVendor] >= 2
            ? vendorCounts[topVendor] + ' of the ' + fl.length + ' flagged purchases are with the same vendor (' + topVendor + ').'
            : 'The flagged purchases involve ' + Object.keys(vendorCounts).length + ' different vendors, so no single vendor relationship is the common thread.' });
      }
    }
    vnext = vnext.concat(vendorFlagNext(D, can));
    add({ id: 'vendors', title: 'Vendors and dependencies', question: 'Are outside parties or hand-offs putting the date or spend at risk?', paras: vp.length ? [vp.join(' ')] : [], tables: vtables,
      implication: vp.length ? 'Blocked items stop downstream work entirely; they should be cleared first, then at-risk, then overdue.' : '',
      next: mergeNext(vnext) });

    // 9. Next 30 days
    var nx = [];
    if (can('milestoneSection')) list(D, 'milestones').filter(function (m) { return !m.isSummary && m.status !== 'Completed' && (num(m.progress) || 0) < 100; }).forEach(function (m) {
      var d = toDate(m.dueDate); if (d && d >= today && d <= soon) nx.push({ d: d, who: 'Owner not recorded', what: 'Deliver "' + clip(m.title, 60) + '"', row: [clip(m.title, 70), fmtDate(d), 'Milestone' + (m.status ? ' · ' + m.status : '')] });
    });
    if (can('deliverableSignoffCard')) list(D, 'signoffs').filter(function (r) { return (r.decision || 'pending') === 'pending'; }).forEach(function (r) {
      var d = toDate(r.dueDate); if (d && d >= today && d <= soon) nx.push({ d: d, who: 'Client Partner', what: 'Accept "' + clip(r.title, 60) + '"', row: [clip(r.title, 70), fmtDate(d), 'Deliverable sign-off'] });
    });
    if (can('dependenciesCard')) list(D, 'dependencies').filter(function (r) { return r.status !== 'Resolved'; }).forEach(function (r) {
      var d = toDate(r.needByDate); if (d && d >= today && d <= soon) nx.push({ d: d, who: owner(r.owner), what: 'Unblock "' + clip(r.predecessorTitle, 40) + '" → "' + clip(r.successorTitle, 40) + '"', row: [clip(r.predecessorTitle, 45) + ' → ' + clip(r.successorTitle, 45), fmtDate(d), 'Dependency needed'] });
    });
    nx.sort(function (a, b) { return a.d - b.d; });
    // Insight: does the load cluster in one particular week? (Monday-anchored week bucket.)
    var nextInsight = '';
    if (nx.length >= 2) {
      var weeks = {};
      nx.forEach(function (x) { var t2 = new Date(x.d); var day = (t2.getDay() + 6) % 7; t2.setDate(t2.getDate() - day); t2.setHours(0, 0, 0, 0);
        (weeks[t2.getTime()] = weeks[t2.getTime()] || []).push(x); });
      var busiest = Object.keys(weeks).map(function (k) { return weeks[k]; }).reduce(function (b, arr) { return arr.length > (b ? b.length : 0) ? arr : b; }, null);
      if (busiest && busiest.length >= 2) {
        var lo = new Date(Math.min.apply(null, busiest.map(function (x) { return x.d.getTime(); })));
        var hi = new Date(Math.max.apply(null, busiest.map(function (x) { return x.d.getTime(); })));
        nextInsight = busiest.length + ' of the ' + nx.length + ' items fall within the same week (' + fmtDate(lo) + (hi.getTime() !== lo.getTime() ? '–' + fmtDate(hi) : '') + ').';
      }
    }
    add({ id: 'next', title: 'Next 30 days', question: 'What happens next, and what should I expect to hear?',
      paras: t && t.outlook ? [t.outlook] : [],
      tables: nx.length ? [{ head: ['What', 'Due', 'Type'], widths: [56, 16, 28], body: nx.slice(0, 8).map(function (x) { return x.row; }), insight: nextInsight }] : [],
      implication: nx.length ? plural(nx.length, 'commitment') + ' fall' + (nx.length === 1 ? 's' : '') + ' due in the next 30 days; missing one carries straight into the following report.' : '',
      next: mergeNext(nx.slice(0, 6).map(function (x) { return { who: x.who, what: x.what, when: fmtDate(x.d) }; })) });
    return S;
  }

  // The facts a section shows, as plain lines — what the analysis may draw on (and nothing else).
  function tableFactLines(tb) {
    var f = [];
    (tb.body || []).forEach(function (r) { f.push(r.map(function (c, i) { return tb.head[i] + ': ' + c; }).join('; ')); });
    if (tb.note) f.push(tb.note);
    return f;
  }
  function sectionFacts(s) {
    var f = [];
    (s.kpis || []).forEach(function (k) { f.push(k.label + ': ' + k.value + (k.sub ? ' (' + k.sub + ')' : '')); });
    (s.paras || []).forEach(function (t) { f.push(t); });
    (s.bullets || []).forEach(function (t) { f.push(t); });
    (s.tables || []).forEach(function (tb) { f = f.concat(tableFactLines(tb)); });
    (s.charts || []).forEach(function (c) { if (c.says) f.push(c.says); (c.worth || []).forEach(function (w) { f.push(w); }); });
    return f.filter(Boolean).map(function (t) { return String(t).replace(/\s+/g, ' ').slice(0, 480); }).slice(0, 60);
  }
  // A section's facts, for suggesting next steps: its Key-finding facts, its (deterministic) implication,
  // and the record-based next steps already listed.
  function sectionNextFacts(s) {
    var f = sectionFacts(s).slice();
    if (s.implication) f.push(s.implication);
    (s.next || []).forEach(function (r) { if (!r.suggested) f.push(r.who + ' — ' + r.what + (r.when && r.when !== '—' ? ' — ' + r.when : '')); });
    return f.filter(Boolean).map(function (t) { return String(t).replace(/\s+/g, ' ').slice(0, 480); }).slice(0, 60);
  }

  // Asks the server for one checked analysis line per section, and suggested next steps for every section, and
  // attaches what survives (s.analysis; s.next rows marked suggested). The server sees only these facts (already
  // limited to what this role may view) and removes any sentence containing a number, date or record ID that is
  // not in them — a suggested step must also name an owner that appears in the facts. Failure just means no analysis.
  function addAnalysis(exec, projectName) {
    if (!exec || !exec.sections || !exec.sections.length) return Promise.resolve(false);
    if (!(window.functions && window.functions.httpsCallable)) return Promise.resolve(false);
    var all = [];
    exec.sections.forEach(function (s) { if (s.id !== 'bottom') all = all.concat(sectionFacts(s)); });
    var payload = exec.sections.map(function (s) {
      return { id: s.id, question: s.question, facts: s.id === 'bottom' ? sectionFacts(s).concat(all).slice(0, 80) : sectionFacts(s) };
    }).filter(function (p) { return p.facts.length; });
    var nextPayload = exec.sections.map(function (s) { return { id: s.id, facts: sectionNextFacts(s) }; }).filter(function (p) { return p.facts.length; });
    var call = window.functions.httpsCallable('reportAnalysis', { timeout: 120000 });
    return call({ bizKey: window.BIZ_KEY, projKey: window.PROJECT_KEY || 'default', projectName: projectName, sections: payload, charts: nextPayload }).then(function (res) {
      var got = (res && res.data && res.data.sections) || {}, steps = (res && res.data && res.data.nextSteps) || {}, any = false;
      exec.sections.forEach(function (s) {
        var g = got[s.id]; if (g && g.analysis) { s.analysis = g.analysis; any = true; }
        (steps[s.id] || []).forEach(function (st) {
          // a suggestion about an item the record-based rows already cover adds nothing: skip it
          var q = /"([^"]+)"/.exec(st.what), have = (s.next || []).some(function (r) { return q && r.what.indexOf(q[1]) !== -1; });
          if (have) return;
          s.next = (s.next || []).concat([{ who: st.who, what: st.what, when: st.when || '—', suggested: true }]); any = true;
        });
      });
      return any;
    }).catch(function (err) { console.warn(ns, 'analysis unavailable — the report is built without it', err && (err.code || err.message)); return false; });
  }

  function buildExec(D, canRaw) {
    var used = {};
    var can = function (c) { var ok = canRaw(c); if (ok) used[c] = true; return ok; };
    // Every figure in Part 1 is computed here from the project data. The only AI text is the per-section
    // "Analysis" line added afterwards by addAnalysis(), which is machine-checked against these figures.
    var ex = composeExec(D, can);
    var kpis = execKpis(D, can), charts = buildCharts(D, can);
    if (!ex && !kpis.length && !charts.length) return null;
    return { text: ex, kpis: kpis, charts: charts, sections: execSections(D, can, ex, kpis, charts), cards: Object.keys(used) };
  }


  // ---------------------------------------------------------------------
  // 2c. The report is framed three ways: tell them what you are going to tell them (a short answer and
  //     the list of what follows), tell them (the sections), tell them what you told them (a recap).
  //     Both frames are built only from the section content already in the report — the checked analysis
  //     lines and the computed figures — so they add nothing new and can never disagree with it.
  // ---------------------------------------------------------------------
  function firstSentence(t) {
    t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    var m = /^(.+?[.!?])(?:\s|$)/.exec(t);
    return m ? m[1] : t;
  }
  function recapLine(s) {
    if (s.analysis) return firstSentence(s.analysis);
    var t0 = s.tables && s.tables[0];
    if (s.id === 'decisions' && t0 && t0.body.length) return plural(t0.body.length, 'decision') + ' waiting on leadership: ' + t0.body.map(function (r) { return r[0]; }).join('; ') + '.';
    if (s.id === 'next' && t0 && t0.body.length) return plural(t0.body.length, 'dated item') + ' in the next 30 days, the first being ' + t0.body[0][0] + ' on ' + t0.body[0][1] + '.';
    var para = (s.paras || []).filter(function (p) { return !/:\s*$/.test(p); })[0];
    var line = para || (s.bullets || [])[0] || (t0 && t0.body[0] ? t0.body[0][0] : '') || s.lead || '';
    return firstSentence(line);
  }
  // Part 1: { short, agenda:[{n,title,question}], recap:[{n,title,text}] }
  function execFrame(exec) {
    var secs = (exec && exec.sections) || [], bottom = secs.filter(function (s) { return s.id === 'bottom'; })[0];
    return {
      short: bottom ? (bottom.analysis ? firstSentence(bottom.analysis) : (bottom.lead || '')) : '',
      agenda: secs.map(function (s, i) { return { n: i + 1, title: s.title, question: s.question }; }),
      recap: secs.map(function (s, i) { return { n: i + 1, title: s.title, text: recapLine(s) }; }).filter(function (r) { return r.text; })
    };
  }
  // Part 2: what the detail holds, and what it showed — counts and the sections' own notes only.
  function detailFrame(summary, sections) {
    var agenda = [], recap = [];
    if (summary) agenda.push({ title: 'Analyst summary', contains: 'the analyst overview and watch items' });
    sections.forEach(function (sec) {
      var c = [];
      if (sec.kv.length) c.push(plural(sec.kv.length, 'key measure'));
      if (sec.bullets.length) c.push(plural(sec.bullets.length, 'highlight'));
      sec.tables.forEach(function (t) { c.push(t.title.charAt(0).toLowerCase() + t.title.slice(1)); });
      agenda.push({ title: sec.title, contains: c.join(', ') });
      var notes = sec.tables.map(function (t) { return t.note; }).filter(Boolean);
      var line = notes.length ? notes.join(' ') : (sec.kv[0] ? sec.kv[0][0] + ': ' + sec.kv[0][1] + '.' : (sec.bullets[0] || ''));
      if (line) recap.push({ title: sec.title, text: line });
    });
    return { agenda: agenda, recap: recap };
  }

  // Roles (besides the owner) that can view every card the report used.
  function rolesAllowedFor(cards, canRoleView) {
    return ROLES.filter(function (role) { return cards.every(function (c) { return canRoleView(role, c); }); });
  }

  // ---------------------------------------------------------------------
  // 3. PDF renderer
  // ---------------------------------------------------------------------
  var PAGE = { w: 595.28, h: 841.89, m: 40 };
  var GOLD = [201, 164, 92];

  // exec (optional): Part 1 — { text, kpis, charts, sections } from buildExec. Without it the report is the detail sections only.
  function renderPdf(jsPDF, meta, summary, sections, exec) {
    var doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    var y;
    var W = PAGE.w - PAGE.m * 2, LIM = PAGE.h - 66;
    var ROW_COL2 = 190;      // where the second column of an aligned row starts (from the left margin)

    function ensure(h) { if (y + h > LIM) { doc.addPage(); y = PAGE.m; } }

    // ---- rich paragraph engine: word wrap with per-word style, widow/orphan control, indents
    function fontFor(bold, italic) { return bold ? (italic ? 'bolditalic' : 'bold') : (italic ? 'italic' : 'normal'); }
    // text | segments -> words; a word is a run of characters with no space (it may mix styles, e.g. "(+$40,000).")
    function toWords(src, base) {
      var segs = Array.isArray(src) ? src : richSegments(pdfText(src), base.marks), out = [], cur = null;
      segs.forEach(function (sg) {
        var st = { bold: sg.bold || base.bold, italic: base.italic, color: sg.color || base.color, pill: sg.pill };
        if (sg.t === 'On Plan') { if (!cur) { cur = { parts: [] }; out.push(cur); } cur.parts.push(Object.assign({ t: sg.t }, st)); return; }   // "On Plan" stays in one piece
        sg.t.split(/(\s+)/).forEach(function (tok) {
          if (tok === '') return;
          if (/^\s+$/.test(tok)) { cur = null; return; }
          if (!cur) { cur = { parts: [] }; out.push(cur); }
          cur.parts.push(Object.assign({ t: tok }, st));
        });
      });
      return out;
    }
    function partW(p, size) { doc.setFont('helvetica', fontFor(p.bold, p.italic)); doc.setFontSize(size); return doc.getTextWidth(p.t); }
    // greedy line breaking; boxFn(k) -> { x, w } for the k-th line (lets text flow around a picture)
    function layout(ws, size, boxFn) {
      var lines = [], k = 0, box = boxFn(0), cur = { x: box.x, items: [], used: 0 };
      doc.setFont('helvetica', 'normal'); doc.setFontSize(size);
      var sp = doc.getTextWidth(' ');
      ws.forEach(function (w) {
        var ww = w.parts.reduce(function (t, p) { return t + partW(p, size); }, 0), need = cur.items.length ? sp + ww : ww;
        if (cur.items.length && cur.used + need > box.w) { lines.push(cur); k++; box = boxFn(k); cur = { x: box.x, items: [], used: 0 }; need = ww; }
        cur.items.push({ w: w, gap: cur.items.length ? sp : 0 });
        cur.used += need;
      });
      if (cur.items.length) lines.push(cur);
      return lines;
    }
    function drawLine(line, top, size) {
      var x = line.x, base = top + size;
      line.items.forEach(function (it) {
        x += it.gap;
        it.w.parts.forEach(function (p) {
          var pw = partW(p, size), c = p.color || C_INK;
          doc.setFont('helvetica', fontFor(p.bold, p.italic)); doc.setFontSize(size);
          doc.setTextColor(c[0], c[1], c[2]); doc.text(p.t, x, base);
          x += pw;
        });
      });
    }
    // Places lines down the page. Widow/orphan control: never a single line alone at the foot of a page, and never a
    // single last line alone at the top of the next one.
    function placeLines(lines, lh, size, onFirst) {
      var i = 0, n = lines.length;
      while (i < n) {
        var avail = Math.floor((LIM - y) / lh), left = n - i, take = Math.min(avail, left);
        if (take < left) {
          if (left - take === 1 && take > 2) take -= 1;
          if (take < 2 && left >= 2) take = 0;
        }
        if (take < 1) { doc.addPage(); y = PAGE.m; continue; }
        for (var k = 0; k < take; k++) drawLine(lines[i + k], y + k * lh, size);
        if (i === 0 && onFirst) onFirst(y);
        y += take * lh; i += take;
        if (i < n) { doc.addPage(); y = PAGE.m; }
      }
    }
    // o: { x, w, italic, lead, gap, bullet }
    function para(src, size, color, bold, o) {
      o = o || {};
      var x0 = o.x != null ? o.x : PAGE.m, w0 = o.w != null ? o.w : PAGE.m + W - x0;
      var lines = layout(toWords(src, { bold: !!bold, italic: !!o.italic, color: color, marks: o.marks }), size, function () { return { x: x0, w: w0 }; });
      placeLines(lines, size * (o.lead || 1.45), size, o.bullet ? function (yy) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(size); doc.setTextColor(C_INK[0], C_INK[1], C_INK[2]); doc.text('•', x0 - 11, yy + size);
      } : null);
      y += o.gap != null ? o.gap : 5;
    }
    // indented bullet: the bullet sits in from the margin and wrapped lines line up under the text
    function bullet(src, size, marks) { para(src, size || 9.5, C_INK, false, { x: PAGE.m + 28, w: W - 28, bullet: true, gap: 4, marks: marks }); }
    // number + title in one column, text in a second column that starts in the same place on every row
    function rowCols(n, title, src, o) {
      o = o || {};
      var size = o.size || 9, x2 = PAGE.m + ROW_COL2, lh = size * 1.45;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(size);
      var tl = doc.splitTextToSize(pdfText(title), ROW_COL2 - 22 - 10);
      var lines = layout(toWords(src, { bold: false, italic: !!o.italic, color: o.color || [70, 80, 92] }), size, function () { return { x: x2, w: PAGE.m + W - x2 }; });
      while (lines.length < tl.length) lines.push({ x: x2, items: [] });
      ensure(Math.min(lines.length, 5) * lh);          // a row is kept together
      placeLines(lines, lh, size, function (yy) {
        doc.setFontSize(size); doc.setTextColor(C_NAVY[0], C_NAVY[1], C_NAVY[2]);
        doc.setFont('helvetica', 'normal'); doc.text(pdfText(n), PAGE.m + 6, yy + size);
        doc.setFont('helvetica', 'bold'); tl.forEach(function (t, k) { doc.text(t, PAGE.m + 22, yy + k * lh + size); });
      });
      y += 4;
    }
    function heading(text) {
      ensure(130);
      y += 12;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(0, 0, 0);
      doc.text(pdfText(text), PAGE.m, y);
      y += 6;
      doc.setDrawColor(GOLD[0], GOLD[1], GOLD[2]); doc.setLineWidth(1.5); doc.line(PAGE.m, y, PAGE.m + W, y);
      y += 18;
    }
    function subhead(text) {
      ensure(80); y += 10;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(C_NAVY[0], C_NAVY[1], C_NAVY[2]);
      doc.text(pdfText(text), PAGE.m, y + 10); y += 18;
    }
    function table(head, body, opts) {
      ensure(Math.min(body.length * 20 + 40, 90));
      doc.autoTable(Object.assign({
        startY: y, head: [head.map(pdfText)], body: body.map(function (r) { return r.map(pdfText); }),
        margin: { left: PAGE.m, right: PAGE.m, bottom: 66 }, theme: 'grid',
        headStyles: { fillColor: [0, 0, 0], textColor: [255, 255, 255], halign: 'center', fontSize: 8, valign: 'middle' },
        styles: { fontSize: 8.5, cellPadding: 4, overflow: 'linebreak', lineColor: [200, 200, 200], lineWidth: 0.4 },
        alternateRowStyles: { fillColor: [247, 247, 247] },
        didParseCell: function (data) {   // signed figures, ratings and late/overdue states in the portal's colours
          if (data.section !== 'body') return;
          var st = cellStyleFor(data.cell.raw);
          if (!st) return;
          data.cell.styles.fontStyle = 'bold'; data.cell.styles.textColor = st.color;
          if (st.fill) data.cell.styles.fillColor = st.fill;
        }
      }, opts || {}));
      y = doc.lastAutoTable.finalY + 12;
    }

    // Cover band: text centered; Distinct Revelations logo on the left, the company's logo on the right at a medium
    // size (about 80% of the Distinct Revelations logo). Either is simply left out if unavailable.
    var BAND = 118, cx = PAGE.w / 2;
    doc.setFillColor(0, 0, 0); doc.rect(0, 0, PAGE.w, BAND, 'F');
    function drawLogo(logo, rightSide, scale) {
      if (!logo || !logo.dataUrl || !logo.w || !logo.h) return;
      var maxW = 110 * scale, maxH = 86 * scale, k = Math.min(maxW / logo.w, maxH / logo.h);
      var w = logo.w * k, h = logo.h * k;
      var x = rightSide ? PAGE.w - PAGE.m - w : PAGE.m;
      try { doc.addImage(logo.dataUrl, 'PNG', x, (BAND - h) / 2, w, h); } catch (e) { /* a bad image never blocks the report */ }
    }
    drawLogo(meta.logoLeft, false, 1);
    drawLogo(meta.logoRight, true, 0.8);
    // Shrink long lines so they stay clear of the logos on both sides.
    function fitted(text, size, style, maxW) {
      doc.setFont('helvetica', style); doc.setFontSize(size);
      var t = pdfText(text);
      while (size > 8 && doc.getTextWidth(t) > maxW) { size -= 0.5; doc.setFontSize(size); }
      return t;
    }
    var textW = 290;
    doc.setTextColor(GOLD[0], GOLD[1], GOLD[2]);
    doc.text(fitted('Project Status Report', 24, 'bold', textW), cx, 48, { align: 'center' });
    doc.setTextColor(255, 255, 255);
    doc.text(fitted(meta.company || '', 14, 'bold', textW), cx, 70, { align: 'center' });
    doc.text(fitted('Project: ' + (meta.project || ''), 11, 'normal', textW), cx, 87, { align: 'center' });
    doc.setTextColor(200, 200, 200);
    doc.text(fitted('Generated ' + meta.generatedAt, 8.5, 'normal', textW), cx, 101, { align: 'center' });
    doc.text(fitted('by ' + (meta.generatedBy || '') + (meta.role ? ' (' + meta.role + ')' : ''), 8.5, 'normal', textW), cx, 112, { align: 'center' });
    y = 146;

    // ---- KPI strip: the rating as a Project Status pill, everything else in bold
    function kpiStrip(kpis) {
      if (!kpis.length) return;
      ensure(84);
      var gap = 8, n = kpis.length, bw = (W - gap * (n - 1)) / n, bh = 60;
      kpis.forEach(function (k, i) {
        var x = PAGE.m + i * (bw + gap);
        doc.setFillColor(244, 247, 251); doc.setDrawColor(210, 218, 228); doc.setLineWidth(0.6); doc.roundedRect(x, y, bw, bh, 4, 4, 'FD');
        doc.setFillColor(GOLD[0], GOLD[1], GOLD[2]); doc.rect(x, y + 6, 3, bh - 12, 'F');
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(90, 107, 125);
        doc.text(pdfText(String(k.label).toUpperCase()), x + 10, y + 15);
        var v = pdfText(k.value), size = 16;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(size);
        while (size > 9 && doc.getTextWidth(v) > bw - 24) { size -= 0.5; doc.setFontSize(size); }
        var kc = k.color || C_NAVY;
        doc.setTextColor(kc[0], kc[1], kc[2]); doc.text(v, x + 10, y + 36);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(90, 107, 125);
        var sub = doc.splitTextToSize(pdfText(k.sub || ''), bw - 18);
        if (sub[0]) doc.text(sub[0], x + 10, y + 51);
      });
      y += bh + 14;
    }

    // ---- every section is framed the same way: Exhibit guide, Key finding (its normal content, including any
    //      supporting pictures and, below each table, its own Insight), Implication for the team, Suggested
    //      next steps, then a pointer to where the full detail lives in the portal.
    function blockLabel(text) { para(text, 9.5, C_NAVY, true, { gap: 2 }); }
    // A short, italic "Insight" callout — mutually exclusive from guide/key finding/implication/next steps;
    // it states one further, specific fact (a ratio, a concentration, a duration) that pre-empts the next
    // question a reader would otherwise have to open the portal to answer.
    function insightPara(text, x, w, marks) {
      if (!text) return;
      var SIZE = 8.6, LH = SIZE * 1.45;
      ensure(LH + 10);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(SIZE); doc.setTextColor(C_NAVY[0], C_NAVY[1], C_NAVY[2]);
      doc.text('Insight', x, y + SIZE);
      y += LH + 1;
      var lines = layout(toWords(text, { color: [43, 53, 64], marks: marks }), SIZE, function () { return { x: x, w: w }; });
      placeLines(lines, LH, SIZE, null);
      y += 5;
    }
    // The graph alternates sides each time (left/right) so consecutive exhibits don't all line up the same
    // way; its Insight sits in the column on the OTHER side, beside the picture rather than below it.
    function chartsWithInsight(imgs, marks) {
      var IMG_W = 225, GAP = 18, TOP = 14;
      imgs.forEach(function (c, idx) {
        var ih = IMG_W * c.img.h / c.img.w;
        var imgLeft = idx % 2 === 0;
        var imgX = imgLeft ? PAGE.m : PAGE.m + W - IMG_W;
        var colX = imgLeft ? PAGE.m + IMG_W + GAP : PAGE.m;
        var colW = W - IMG_W - GAP;
        if (!c.insight) {
          ensure(TOP + ih + 16);
          doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(C_NAVY[0], C_NAVY[1], C_NAVY[2]);
          doc.text(pdfText(c.title), imgX, y + 10);
          try { doc.addImage(c.img.dataUrl, 'PNG', imgX, y + TOP, IMG_W, ih); } catch (e) { /* a bad image never blocks the report */ }
          doc.setDrawColor(210, 218, 228); doc.setLineWidth(0.6); doc.rect(imgX, y + TOP, IMG_W, ih);
          y += TOP + ih + 16;
          return;
        }
        var SIZE = 8.6, LH = SIZE * 1.45, labelH = LH + 1;
        var lines = layout(toWords(c.insight, { color: [43, 53, 64], marks: marks }), SIZE, function () { return { x: colX, w: colW }; });
        var textH = TOP + labelH + lines.length * LH;
        var blockH = Math.max(TOP + ih, textH) + 16;
        ensure(Math.min(blockH, 320));
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(C_NAVY[0], C_NAVY[1], C_NAVY[2]);
        doc.text(pdfText(c.title), imgX, y + 10);
        try { doc.addImage(c.img.dataUrl, 'PNG', imgX, y + TOP, IMG_W, ih); } catch (e) { /* a bad image never blocks the report */ }
        doc.setDrawColor(210, 218, 228); doc.setLineWidth(0.6); doc.rect(imgX, y + TOP, IMG_W, ih);
        doc.text('Insight', colX, y + TOP + SIZE);
        var off = TOP + labelH;
        lines.forEach(function (ln) { drawLine(ln, y + off, SIZE); off += LH; });
        y += blockH;
      });
    }
    function nextStepsTable(rows) {
      if (!rows || !rows.length) return;
      blockLabel('Suggested next steps');
      table(['Who', 'What', 'When'], rows.map(function (r) { return [r.who, (r.start ? 'Start here — ' : '') + (r.suggested ? 'Suggested: ' : '') + r.what, r.when || '—']; }),
        { columnStyles: { 0: { cellWidth: 105, fontStyle: 'bold' }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 68 } } });
    }

    if (exec) {
      heading('Part 1 · Executive Summary');
      // tell them what this summary will tell them
      var F1 = execFrame(exec);
      subhead('What this summary tells you');
      if (F1.short) para('The short answer: ' + F1.short, 10.5, C_INK, true, { gap: 8 });
      F1.agenda.forEach(function (a) { rowCols(a.n + '.', a.title, a.question, { italic: true, size: 9 }); });
      // tell them
      (exec.sections || []).forEach(function (s, i) {
        ensure(100);
        y += 16;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(13.5); doc.setTextColor(C_NAVY[0], C_NAVY[1], C_NAVY[2]);
        doc.text(pdfText((i + 1) + '. ' + s.title), PAGE.m, y + 11);
        y += 24;
        // 1. Exhibit guide
        if (s.guide) { blockLabel('Exhibit guide'); para(s.guide, 9, [90, 107, 125], false, { italic: true, gap: 8 }); }
        // 2. Key finding
        blockLabel('Key finding');
        var lead = (s.id === 'bottom' && s.analysis) ? s.analysis : s.lead;   // the checked analysis is the answer; the composed line stands in when there is none
        if (lead) para(lead, 12.5, C_NAVY, true, { gap: 7, marks: s.marks });
        if (s.analysis && s.id !== 'bottom') {
          var first = firstSentence(s.analysis), rest = s.analysis.slice(first.length).trim();
          var segs = richSegments(pdfText(first), s.marks).map(function (sg) { return Object.assign({}, sg, { bold: true }); });
          if (rest) segs.push({ t: ' ' }); segs = segs.concat(richSegments(pdfText(rest), s.marks));
          para(segs, 10, C_INK, false, { gap: 7 });    // the key insight (first sentence) in bold
        }
        (s.paras || []).forEach(function (t2) { para(t2, 10, C_INK, false, { gap: 6, marks: s.marks }); });
        if (s.kpis && s.kpis.length) { y += 2; kpiStrip(s.kpis); }
        (s.bullets || []).forEach(function (b2) { bullet(b2, 9.8, s.marks); });
        (s.tables || []).forEach(function (tb) {
          if (!tb.body.length) return;
          y += 4;
          if (tb.title) para(tb.title, 9.5, C_NAVY, true, { gap: 3 });
          var cs = {};
          (tb.widths || []).forEach(function (w, ci) { cs[ci] = { cellWidth: Math.round(W * w / 100) }; });
          cs[0] = Object.assign(cs[0] || {}, { fontStyle: 'bold' });
          table(tb.head, tb.body, { columnStyles: cs });
          if (tb.note) para(tb.note, 8.5, [110, 118, 128], false, { italic: true, gap: 6 });
          if (tb.insight) insightPara(tb.insight, PAGE.m, W, s.marks);
        });
        if (s.charts && s.charts.length) { y += 4; chartsWithInsight(s.charts, s.marks); }
        // 3. Implication for the team
        if (s.implication) { y += 2; blockLabel('Implication for the team'); para(s.implication, 10, C_INK, false, { gap: 8, marks: s.marks }); }
        // 4. Suggested next steps
        if (s.next && s.next.length) { y += 2; nextStepsTable(s.next); }
        // 5. Where to look for more, in the portal
        if (s.portal) para('Full detail: ' + s.portal + ' in the portal.', 8, [110, 118, 128], false, { italic: true, gap: 4 });
      });
      // tell them what they were told
      if (F1.recap.length) {
        heading('In summary — what we have told you');
        F1.recap.forEach(function (r) { rowCols(r.n + '.', r.title, r.text, { size: 9.5, color: C_INK }); });
        if ((exec.sections || []).some(function (s) { return s.analysis; }) || (exec.sections || []).some(function (s) { return (s.next || []).some(function (r) { return r.suggested; }); })) {
          y += 4; para('The analysis lines and suggested next steps are AI-assisted; every figure, date and name in them is taken from the project records.', 8, [110, 118, 128], false, { italic: true });
        }
      }
      if (summary || sections.length) { doc.addPage(); y = PAGE.m; heading('Part 2 · Detail'); }
    }

    // Part 2 (or the whole report when there is no executive part): say what is coming, then say it, then recap it
    var F2 = detailFrame(summary, sections);
    if (F2.agenda.length) {
      if (!exec) heading('What this report contains');
      else subhead('What this detail contains');
      F2.agenda.forEach(function (a, i) { rowCols((i + 1) + '.', a.title, a.contains || '', { italic: true, size: 9 }); });
      y += 10;
    }

    if (summary) {
      heading(exec ? 'Analyst Summary' : 'Executive Summary');
      para(summary.text, 10.5, C_INK, false, { gap: 6 });
      if (summary.note) para(summary.note, 8, [110, 118, 128], false, { italic: true, gap: 8 });
      if (summary.watch && summary.watch.length) {
        y += 4; para('Watch items', 10.5, C_NAVY, true, { gap: 4 });
        summary.watch.forEach(function (w) { bullet(w, 9.8); });
      }
    }

    sections.forEach(function (sec) {
      heading(sec.title);
      if (sec.kv.length) {
        table(['Measure', 'Value'], sec.kv, { columnStyles: { 0: { cellWidth: 200, fontStyle: 'bold' } },
          headStyles: { fillColor: [0, 0, 0], textColor: [255, 255, 255], halign: 'left', fontSize: 8 } });
      }
      if (sec.bullets.length) {
        y += 4;
        para('Highlights', 10.5, C_NAVY, true, { gap: 4 });
        sec.bullets.forEach(function (b) { bullet(b, 9.8); });
        y += 6;
      }
      sec.tables.forEach(function (t) {
        ensure(Math.min(t.body.length * 20 + 90, 130));
        para(t.title, 10.5, C_NAVY, true, { gap: 4 });
        if (t.body.length) table(t.head, t.body);
        else { para('None.', 9, [120, 120, 120]); }
        if (t.note) para(t.note, 8.5, [110, 118, 128], false, { italic: true, gap: 8 });
      });
    });
    if (F2.recap.length) {
      heading('In summary — what the detail showed');
      F2.recap.forEach(function (r) { rowCols('•', r.title, r.text, { size: 9.5, color: C_INK }); });
    }

    // Footer on every page: Distinct Revelations logo left, page information (bold) in the middle,
    // the confidential statement (italic) on the right.
    var n = doc.getNumberOfPages();
    for (var i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setDrawColor(200, 200, 200); doc.setLineWidth(0.5); doc.line(PAGE.m, PAGE.h - 46, PAGE.w - PAGE.m, PAGE.h - 46);
      var logo = meta.logoLeft;
      if (logo && logo.dataUrl && logo.w && logo.h) {
        var lh2 = 24, lw2 = lh2 * logo.w / logo.h;
        try { doc.addImage(logo.dataUrl, 'PNG', PAGE.m, PAGE.h - 41, lw2, lh2); } catch (e) { /* ignore */ }
      }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(50, 50, 50);
      doc.text('Page ' + i + ' of ' + n, PAGE.w / 2, PAGE.h - 25, { align: 'center' });
      var conf = pdfText('Confidential — ' + (meta.company || '') + ' · ' + (meta.project || '')), fs2 = 8;
      doc.setFont('helvetica', 'italic'); doc.setFontSize(fs2); doc.setTextColor(90, 100, 112);
      while (fs2 > 6 && doc.getTextWidth(conf) > 205) { fs2 -= 0.25; doc.setFontSize(fs2); }
      doc.text(conf, PAGE.w - PAGE.m, PAGE.h - 25, { align: 'right' });
    }
    return doc;
  }

  // ---------------------------------------------------------------------
  // 3b. Word (.docx) copy — the same content as the PDF, editable. Owner only (see generate()).
  //     Uses window.drDocx (docx-writer.js); graphs are placed with Tight text wrapping.
  // ---------------------------------------------------------------------
  function buildDocx(meta, summary, sections, exec) {
    var b = window.drDocx.builder({ footer: 'Confidential — ' + (meta.company || '') + ' · ' + (meta.project || ''), footerLogo: meta.logoLeft });
    b.cover({
      title: 'Project Status Report',
      lines: [{ text: meta.company || '', size: 14, bold: true }, { text: 'Project: ' + (meta.project || ''), size: 11 },
        { text: 'Generated ' + meta.generatedAt, size: 8.5, color: 'C8C8C8' }, { text: 'by ' + (meta.generatedBy || '') + (meta.role ? ' (' + meta.role + ')' : ''), size: 8.5, color: 'C8C8C8' }],
      logoLeft: meta.logoLeft, logoRight: meta.logoRight
    });
    var cellRuns = function (text) {
      var st = cellStyleFor(text);
      return st ? [{ t: text, bold: true, color: hex(st.color), fill: hex(st.fill) }] : null;
    };
    var NAVYH = '0B2545', SOFT = '5A6B7D';

    if (exec) {
      b.heading('Part 1 · Executive Summary', 1);
      var F1 = execFrame(exec);
      b.heading('What this summary tells you', 2);
      if (F1.short) b.para(docRuns('The short answer: ' + F1.short), { size: 10.5, bold: true, after: 140 });
      b.aligned(F1.agenda.map(function (a) { return { n: a.n + '.', title: a.title, content: [{ t: a.question, italic: true, color: '46505C' }] }; }));
      (exec.sections || []).forEach(function (s, i) {
        b.heading((i + 1) + '. ' + s.title, 2);
        // 1. Exhibit guide
        if (s.guide) { b.para('Exhibit guide', { size: 9.5, bold: true, color: NAVYH, after: 20, keepNext: true }); b.para(s.guide, { size: 9, italic: true, color: SOFT, after: 140 }); }
        // 2. Key finding
        b.para('Key finding', { size: 9.5, bold: true, color: NAVYH, after: 20, keepNext: true });
        var lead = (s.id === 'bottom' && s.analysis) ? s.analysis : s.lead;
        if (lead) b.para(docRuns(lead, s.marks), { size: 12.5, bold: true, color: NAVYH, after: 140 });
        if (s.analysis && s.id !== 'bottom') {
          var first = firstSentence(s.analysis), rest = s.analysis.slice(first.length).trim();
          var runs = docRuns(first, s.marks).map(function (r) { return Object.assign({}, r, { bold: true }); });
          if (rest) runs.push({ t: ' ' }); runs = runs.concat(docRuns(rest, s.marks));
          b.para(runs, { size: 10, after: 140 });
        }
        (s.paras || []).forEach(function (t2) { b.para(docRuns(t2, s.marks), { size: 10, after: 120 }); });
        if (s.kpis && s.kpis.length) b.kpis(s.kpis.map(function (k) { return Object.assign({}, k, { valueColor: hex(k.color) }); }));
        if (s.bullets && s.bullets.length) b.bullets(s.bullets.map(function (t2) { return docRuns(t2, s.marks); }), { size: 9.8 });
        (s.tables || []).forEach(function (tb) {
          if (!tb.body.length) return;
          if (tb.title) b.para(tb.title, { size: 9.5, bold: true, color: NAVYH, keepNext: true, after: 60, before: 100 });
          b.table({ head: tb.head, widths: tb.widths, boldFirst: true, body: tb.body, cellRuns: cellRuns });
          if (tb.note) b.para(tb.note, { size: 8.5, italic: true, color: '6E7680' });
          if (tb.insight) { b.para('Insight', { size: 8.6, bold: true, color: NAVYH, after: 20, keepNext: true }); b.para(docRuns(tb.insight, s.marks), { size: 8.6, after: 120 }); }
        });
        // The graph alternates sides each time; its Insight sits in the OTHER column, beside the picture.
        (s.charts || []).forEach(function (c, ci) {
          if (!c.insight) { b.picture(c.img, c.title, 3.2); return; }
          b.chartBlock({ img: c.img, title: c.title, imgLeft: ci % 2 === 0, paras: [{ label: 'Insight', runs: docRuns(c.insight, s.marks) }] });
        });
        // 3. Implication for the team
        if (s.implication) { b.para('Implication for the team', { size: 9.5, bold: true, color: NAVYH, after: 20, keepNext: true }); b.para(docRuns(s.implication, s.marks), { size: 10, after: 140 }); }
        // 4. Suggested next steps
        if (s.next && s.next.length) {
          b.para('Suggested next steps', { size: 9.5, bold: true, color: NAVYH, keepNext: true, after: 40 });
          b.table({ head: ['Who', 'What', 'When'], widths: [22, 60, 18], boldFirst: true, cellRuns: cellRuns,
            body: s.next.map(function (r) { return [r.who, (r.start ? 'Start here — ' : '') + (r.suggested ? 'Suggested: ' : '') + r.what, r.when || '—']; }) });
        }
        // 5. Where to look for more, in the portal
        if (s.portal) b.para('Full detail: ' + s.portal + ' in the portal.', { size: 8, italic: true, color: '6E7680', after: 100 });
      });
      if (F1.recap.length) {
        b.heading('In summary — what we have told you', 1);
        b.aligned(F1.recap.map(function (r) { return { n: r.n + '.', title: r.title, content: docRuns(r.text) }; }));
        if ((exec.sections || []).some(function (s) { return s.analysis; })) b.para('The analysis lines and suggested next steps are AI-assisted; every figure, date and name in them is taken from the project records.', { size: 8, italic: true, color: '6E7680' });
      }
      if (summary || sections.length) { b.pageBreak(); b.heading('Part 2 · Detail', 1); }
    }
    var F2 = detailFrame(summary, sections);
    if (F2.agenda.length) {
      b.heading(exec ? 'What this detail contains' : 'What this report contains', exec ? 2 : 1);
      b.aligned(F2.agenda.map(function (a, i) { return { n: (i + 1) + '.', title: a.title, content: [{ t: a.contains || '', italic: true, color: '46505C' }] }; }));
    }

    if (summary) {
      b.heading(exec ? 'Analyst Summary' : 'Executive Summary', 1);
      b.para(docRuns(summary.text), { size: 10.5 });
      if (summary.note) b.para(summary.note, { size: 8, italic: true, color: '6E7680' });
      if (summary.watch && summary.watch.length) { b.para('Watch items', { bold: true, color: NAVYH, keepNext: true, after: 60 }); b.bullets(summary.watch.map(function (t2) { return docRuns(t2); }), { size: 9.8 }); }
    }
    sections.forEach(function (sec) {
      b.heading(sec.title, 1);
      if (sec.kv.length) b.table({ head: ['Measure', 'Value'], widths: [34, 66], boldFirst: true, body: sec.kv, cellRuns: cellRuns });
      if (sec.bullets.length) { b.para('Highlights', { bold: true, color: NAVYH, keepNext: true, after: 60 }); b.bullets(sec.bullets.map(function (t2) { return docRuns(t2); }), { size: 9.8 }); }
      sec.tables.forEach(function (t) {
        b.para(t.title, { bold: true, color: NAVYH, keepNext: true, after: 60, before: 100 });
        if (t.body.length) b.table({ head: t.head, body: t.body, cellRuns: cellRuns }); else b.para('None.', { size: 9, color: '787878' });
        if (t.note) b.para(t.note, { size: 8.5, italic: true, color: '6E7680' });
      });
    });
    if (F2.recap.length) { b.heading('In summary — what the detail showed', 1); b.aligned(F2.recap.map(function (r) { return { n: '•', title: r.title, content: docRuns(r.text) }; })); }
    return b;
  }

  // ---------------------------------------------------------------------
  // 4. Data loading (browser only)
  // ---------------------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function text(sel) { var el = $(sel); return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
  function getDB() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() {
    return getDB().collection('businesses').doc(window.BIZ_KEY).collection('projects').doc(window.PROJECT_KEY || 'default');
  }
  function readTable(id) {
    var t = document.getElementById(id);
    if (!t) return null;
    var head = Array.prototype.map.call(t.querySelectorAll('thead th'), function (th) { return th.textContent.replace(/[↕▲▼]/g, '').replace(/\s+/g, ' ').trim(); });
    var body = Array.prototype.map.call(t.querySelectorAll('tbody tr'), function (tr) {
      return Array.prototype.map.call(tr.querySelectorAll('td'), function (td) { return td.textContent.replace(/\s+/g, ' ').trim(); });
    }).filter(function (r) { return r.length === head.length && r.join('').length; });
    return { head: head, body: body };
  }
  function readDom() {
    return {
      timeElapsed: text('#time-elapsed-label'), tasksCompleted: text('#task-progress-label'),
      spi: text('#schedulePerformanceValue'), forecast: text('#forecastFinishValue'), forecastLabel: text('#forecastFinishLabel'),
      cpi: text('#costPerfCPI'), sv: text('#costPerfSV'), cv: text('#costPerfCV'), eac: text('#costPerfEAC'), etc: text('#costPerfETC'), vac: text('#costPerfVAC'),
      qna: { questions: text('#qna-stat-questions'), tasks: text('#qna-stat-tasks'), issues: text('#qna-stat-issues'), risks: text('#qna-stat-risks') },
      tables: { criticalPath: readTable('criticalPathTable'), topSlipped: readTable('topSlippedTable'), milestoneTrend: readTable('milestoneTrendTable') }
    };
  }
  var COLLECTION_FOR_CARD = {
    milestoneSection: ['milestones'], deliverableSignoffCard: ['signoffs'], changeControlLogCard: ['changeRequests'],
    decisionLogCard: ['decisions'], dependenciesCard: ['dependencies'], procurementCard: ['purchases', 'vendors'],
    lessonsLearnedCard: ['lessonsLearned'], stakeholderRegisterCard: ['stakeholders']
  };

  var EXEC_CARDS = ['milestoneSection', 'changeControlLogCard', 'deliverableSignoffCard', 'dependenciesCard', 'procurementCard'];   // lists Part 1 draws on

  function loadData(can, selectedIds, includeExec) {
    var p = projRef();
    var needed = {};
    if (includeExec) {
      EXEC_CARDS.forEach(function (c) { if (can(c)) (COLLECTION_FOR_CARD[c] || []).forEach(function (n) { needed[n] = true; }); });
      // The burndown exhibit reconstructs its lines the same way the live dashboard chart does (burndown.js),
      // which needs the raw activities alongside milestones — not just the milestoneSection card's own need.
      if (can('burndownCard')) { needed.milestones = true; needed.activities = true; }
    }
    DEFS.forEach(function (def) {
      if (selectedIds.indexOf(def.id) === -1) return;
      def.parts.forEach(function (part) {
        if (can(part.card)) (COLLECTION_FOR_CARD[part.card] || []).forEach(function (c) { needed[c] = true; });
      });
    });
    var names = Object.keys(needed);
    return Promise.all([
      p.get(),
      getDB().collection('businesses').doc(window.BIZ_KEY).get(),
      Promise.all(names.map(function (n) { return p.collection(n).get(); }))
    ]).then(function (res) {
      var lists = {};
      names.forEach(function (n, i) {
        lists[n] = res[2][i].docs.map(function (d) { var x = d.data() || {}; x.id = d.id; return x; });
      });
      var project = (res[0].exists && res[0].data()) || {};
      var biz = (res[1].exists && res[1].data()) || {};
      return {
        today: new Date(), project: project, biz: biz, lists: lists, dom: readDom(),
        projectName: project.name || window.PROJECT_KEY, companyName: biz.name || biz.businessName || window.BIZ_KEY,
        facts: function (id) {
          var f = window.drInsight && window.drInsight.getFacts ? window.drInsight.getFacts()[id] : null;
          return f ? (typeof f === 'string' ? f : f.current) : '';
        },
        procurement: window.drProcurement || null
      };
    });
  }

  // Turns an image URL into { dataUrl, w, h } (PNG) for the PDF, or null. The
  // fetch -> blob -> canvas route avoids a cross-origin canvas taint (the
  // company logo lives in Firebase Storage).
  function loadLogo(url) {
    if (!url) return Promise.resolve(null);
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var obj = URL.createObjectURL(blob), img = new Image();
          img.onload = function () {
            try {
              var c = document.createElement('canvas');
              c.width = img.naturalWidth; c.height = img.naturalHeight;
              c.getContext('2d').drawImage(img, 0, 0);
              resolve({ dataUrl: c.toDataURL('image/png'), w: img.naturalWidth, h: img.naturalHeight });
            } catch (e) { reject(e); } finally { URL.revokeObjectURL(obj); }
          };
          img.onerror = function () { URL.revokeObjectURL(obj); reject(new Error('image decode failed')); };
          img.src = obj;
        });
      })
      .catch(function (err) { console.warn(ns, 'logo unavailable', url, err && err.message); return null; });
  }
  // Left: the Distinct Revelations logo. Right: the company's own logo — but
  // only if the company has uploaded one (until then the header just shows the
  // Distinct Revelations logo again, which would be a pointless duplicate).
  function loadCoverLogos() {
    var dr = document.querySelector('.dr-logo');
    var co = document.getElementById('companyLogo');
    var drSrc = dr && (dr.currentSrc || dr.src);
    var coSrc = co && (co.currentSrc || co.src);
    if (coSrc && drSrc && coSrc === drSrc) coSrc = '';
    return Promise.all([loadLogo(drSrc), loadLogo(coSrc)]).then(function (r) { return { left: r[0], right: r[1] }; });
  }

  function loadScriptOnce(url) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-dr-lib="' + url + '"]');
      if (existing) { if (existing.getAttribute('data-loaded')) resolve(); else existing.addEventListener('load', resolve); return; }
      var s = document.createElement('script');
      s.src = url; s.async = true; s.setAttribute('data-dr-lib', url);
      s.onload = function () { s.setAttribute('data-loaded', '1'); resolve(); };
      s.onerror = function () { reject(new Error('Could not load ' + url + ' — check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }
  function loadPdfLibs() {
    if (window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable) return Promise.resolve(window.jspdf.jsPDF);
    return loadScriptOnce(JSPDF_URL).then(function () { return loadScriptOnce(AUTOTABLE_URL); }).then(function () { return window.jspdf.jsPDF; });
  }

  // ---------------------------------------------------------------------
  // 5. Dialog + saved reports
  // ---------------------------------------------------------------------
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function canView(cardId) { return !!(window.drAccess && window.drAccess.canViewReport(cardId)); }
  function currentRole() { return window.drAccess && window.drAccess.role; }
  function user() { return (window.auth && window.auth.currentUser) || null; }
  function statusRef() { return projRef().collection('statusReports'); }
  function stamp(d) {
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function safeName(s) { return String(s || 'project').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'; }

  var busy = false;

  // includeExec: build Part 1 (executive summary + graphs); selectedIds: the Part 2 detail sections.
  // wantDocx: owner only — also builds an editable Word copy of the same report.
  function generate(selectedIds, saveCopy, setStatus, includeExec, wantDocx) {
    var role = currentRole();
    var can = function (c) { return canView(c); };
    setStatus('Loading data…');
    return Promise.all([loadData(can, selectedIds, includeExec), loadPdfLibs(), loadCoverLogos()]).then(function (res) {
      var D = res[0], jsPDF = res[1];
      setStatus('Building the report…');
      var body = assemble(D, can, selectedIds);
      var includedCards = body.cards;
      var summary = selectedIds.length ? buildSummary(D, includedCards, can) : null;
      var exec = includeExec ? buildExec(D, can) : null;
      if (exec) setStatus('Writing the checked analysis…');
      // the analysis lines come back from the server (checked there); without them the report is built from the figures alone
      return (exec ? addAnalysis(exec, D.projectName) : Promise.resolve(false)).then(function () {
      var usedCards = includedCards.concat(summary ? summary.cards : []).concat(exec ? exec.cards : []);
      // which wording each part is: a saved copy is only offered to roles that may have every part it holds
      if (exec) usedCards.push('ver:executive');
      if (body.sections.length || summary) usedCards.push('ver:detail');
      if (!body.sections.length && !summary && !exec) throw new Error('Nothing to include — none of the selected sections has data your role can view.');
      var now = new Date();
      var u = user();
      var meta = {
        company: D.companyName, project: D.projectName, generatedAt: now.toLocaleString('en-US'),
        generatedBy: (u && u.email) || '', role: ROLE_LABEL[role] || '',
        logoLeft: res[2].left, logoRight: res[2].right
      };
      var doc = renderPdf(jsPDF, meta, summary, body.sections, exec);
      var fileName = 'Status-Report_' + safeName(D.projectName) + '_' + stamp(now) + '.pdf';
      doc.save(fileName);
      var docxName = null;
      // The editable Word copy is for the owner only (checked here, not just in the dialog).
      var docxDone = (wantDocx && role === 'owner' && window.drDocx)
        ? loadScriptOnce(JSZIP_URL).then(function () { return buildDocx(meta, summary, body.sections, exec).build(window.JSZip); }).then(function (blob) {
            docxName = fileName.replace(/\.pdf$/, '.docx');
            setTimeout(function () { downloadBlob(blob, docxName); }, 600);   // after the PDF's own download has started
          }).catch(function (err) { console.error(ns, 'Word copy failed', err); setStatus('The PDF is ready, but the Word copy could not be built: ' + ((err && err.message) || err)); })
        : Promise.resolve();
      if (!saveCopy) return docxDone.then(function () { return { saved: false, fileName: fileName, docxName: docxName }; });

      setStatus('Saving a copy…');
      var allowed = rolesAllowedFor(usedCards, function (r, c) {
        if (c === 'ver:executive') return window.drAccess.canRoleUseVersion(r, 'executive');
        if (c === 'ver:detail') return window.drAccess.canRoleUseVersion(r, 'detail');
        return window.drAccess.canRoleViewReport(r, c);
      });
      return saveReport(doc.output('blob'), fileName, (exec ? ['executive'] : []).concat(body.sections.map(function (s) { return s.id; })), usedCards, allowed)
        .then(function () { return docxDone; }).then(function () { return { saved: true, fileName: fileName, allowed: allowed, docxName: docxName }; });
      });
    });
  }

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  function saveReport(blob, fileName, sectionIds, usedCards, allowedRoles) {
    var u = user();
    var storage = window.firebase.storage();
    var ref = statusRef().doc();               // id first: it names the file
    var path = 'reports/' + window.BIZ_KEY + '/' + (window.PROJECT_KEY || 'default') + '/' + ref.id;
    return storage.ref().child(path).put(blob, {
      contentType: 'application/pdf',
      customMetadata: { owner: (u && u.email) || '', ownerUid: (u && u.uid) || '' }
    }).then(function () {
      return ref.set({
        fileName: fileName, storagePath: path, size: blob.size,
        sections: sectionIds, cards: usedCards, allowedRoles: allowedRoles,
        createdAt: window.firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: (u && u.email) || '', createdByUid: (u && u.uid) || ''
      });
    }).catch(function (err) {
      // Don't leave an orphan PDF behind if the record could not be written.
      storage.ref().child(path).delete().catch(function () {});
      throw err;
    });
  }

  function loadSavedList() {
    var q = currentRole() === 'owner' ? statusRef() : statusRef().where('allowedRoles', 'array-contains', currentRole());
    return q.get().then(function (snap) {
      return snap.docs.map(function (d) { var x = d.data() || {}; x.id = d.id; return x; })
        .sort(function (a, b) { return (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0); }).slice(0, 25);
    });
  }

  function downloadSaved(row, btn) {
    btn.disabled = true;
    window.firebase.storage().ref().child(row.storagePath).getDownloadURL()
      .then(function (url) { return fetch(url); })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.blob(); })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = row.fileName || 'Status-Report.pdf';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      })
      .catch(function (err) { console.error(ns, 'download failed', err); alert('Download failed: ' + (err && err.message ? err.message : err)); })
      .finally(function () { btn.disabled = false; });
  }

  function deleteSaved(row, refresh) {
    var confirmed = window.drConfirm
      ? window.drConfirm('Delete the saved report "' + row.fileName + '"? This cannot be undone.', { title: 'Delete Saved Report' })
      : Promise.resolve(window.confirm('Delete this saved report?'));
    confirmed.then(function (ok) {
      if (!ok) return;
      window.firebase.storage().ref().child(row.storagePath).delete().catch(function (err) {
        if (!(err && err.code === 'storage/object-not-found')) throw err;
      }).then(function () { return statusRef().doc(row.id).delete(); })
        .then(refresh)
        .catch(function (err) { console.error(ns, 'delete failed', err); alert('Could not delete: ' + (err && err.message ? err.message : err)); });
    });
  }

  function openDialog() {
    if (!window.drModal) return;
    var V = window.drAccess;
    var allowExec = !!(V && V.canUseVersion('executive')), allowDetail = !!(V && V.canUseVersion('detail'));
    var sections = allowDetail ? availableSections(canView) : [];
    if (!sections.length && !allowExec) {
      window.drModal.open({ title: 'Status Report', bodyHtml: '<p>Your role does not currently have access to any of the sections a status report draws on. Ask the project owner to grant access in Settings ▸ Permissions.</p>' });
      return;
    }
    var boxes = sections.map(function (s) {
      return '<label style="display:block;margin:4px 0"><input type="checkbox" class="sr-section" value="' + esc(s.id) + '" checked /> ' + esc(s.title) + '</label>';
    }).join('');
    window.drModal.open({
      title: 'Status Report (PDF)',
      bodyHtml:
        '<p style="margin-top:0">Builds a PDF from the current project data. It includes only what your role can view on the dashboard.</p>' +
        (allowExec ? '<div style="margin:10px 0"><strong>Part 1 — Executive summary</strong>' +
          '<label style="display:block;margin:4px 0"><input type="checkbox" id="srExec" checked /> Executive summary, key figures and graphs</label></div>' : '') +
        (sections.length ? '<div style="margin:10px 0"><strong>' + (allowExec ? 'Part 2 — Detail' : 'Include') + ':</strong>' + boxes + '</div>' : '') +
        '<label style="display:block;margin:8px 0"><input type="checkbox" id="srSaveCopy" checked /> Also save a copy to “Saved reports” below</label>' +
        (currentRole() === 'owner' ? '<label style="display:block;margin:8px 0"><input type="checkbox" id="srDocx" checked /> Also download an editable Word (.docx) copy <span style="color:#666">(owner only — for adjustments, additions or deletions)</span></label>' : '') +
        '<div style="margin:10px 0"><button type="button" id="srGenerate" class="primary" style="height:32px;padding:0 16px">Generate &amp; download PDF</button> ' +
        '<span id="srStatus" style="margin-left:8px;font-size:0.85rem;color:#555"></span></div>' +
        '<h4 style="margin:18px 0 6px">Saved reports</h4>' +
        '<div id="srSaved" style="font-size:0.85rem">Loading…</div>'
    });
    var body = $('#drGenericModalOverlay .dr-modal-body');
    if (!body) return;
    var statusEl = body.querySelector('#srStatus'), savedEl = body.querySelector('#srSaved');
    function setStatus(t) { statusEl.textContent = t; }

    function refresh() {
      savedEl.textContent = 'Loading…';
      loadSavedList().then(function (rows) {
        if (!rows.length) { savedEl.innerHTML = '<em>No saved reports yet.</em>'; return; }
        savedEl.innerHTML = '<table style="width:100%;border-collapse:collapse" cellpadding="5" border="1"><thead><tr>' +
          '<th>Saved</th><th>By</th><th>Sections</th><th>Visible to</th><th></th></tr></thead><tbody>' +
          rows.map(function (r, i) {
            var canDel = currentRole() === 'owner' || r.createdByUid === (user() && user().uid);
            return '<tr><td>' + esc(fmtDate(r.createdAt)) + '</td><td>' + esc(r.createdBy) + '</td><td>' + esc((r.sections || []).length) + '</td>' +
              '<td>' + esc(['Owner'].concat((r.allowedRoles || []).map(function (x) { return ROLE_LABEL[x] || x; })).join(', ')) + '</td>' +
              '<td style="white-space:nowrap"><button type="button" class="sr-dl" data-i="' + i + '">Download</button> ' +
              (canDel ? '<button type="button" class="sr-del" data-i="' + i + '">Delete</button>' : '') + '</td></tr>';
          }).join('') + '</tbody></table>';
        savedEl.querySelectorAll('.sr-dl').forEach(function (b) { b.addEventListener('click', function () { downloadSaved(rows[+b.getAttribute('data-i')], b); }); });
        savedEl.querySelectorAll('.sr-del').forEach(function (b) { b.addEventListener('click', function () { deleteSaved(rows[+b.getAttribute('data-i')], refresh); }); });
      }).catch(function (err) {
        console.warn(ns, 'could not list saved reports', err && err.code);
        savedEl.innerHTML = '<em>Saved reports are unavailable right now.</em>';
      });
    }
    refresh();

    var gen = body.querySelector('#srGenerate');
    gen.addEventListener('click', function () {
      if (busy) return;
      var ids = Array.prototype.map.call(body.querySelectorAll('.sr-section:checked'), function (c) { return c.value; });
      var execBox = body.querySelector('#srExec'), includeExec = !!(execBox && execBox.checked);
      if (!ids.length && !includeExec) { setStatus('Pick at least one section.'); return; }
      busy = true; gen.disabled = true;
      generate(ids, body.querySelector('#srSaveCopy').checked, setStatus, includeExec, !!(body.querySelector('#srDocx') && body.querySelector('#srDocx').checked)).then(function (r) {
        setStatus((r.docxName ? 'PDF and Word copy downloaded. ' : '') + (r.saved ? 'Saved. Visible to: Owner' + (r.allowed.length ? ', ' + r.allowed.map(function (x) { return ROLE_LABEL[x]; }).join(', ') : ' only') + '.' : 'Downloaded.'));
        if (r.saved) refresh();
      }).catch(function (err) {
        console.error(ns, 'generate failed', err);
        setStatus('Could not build the report: ' + (err && err.message ? err.message : err));
      }).finally(function () { busy = false; gen.disabled = false; });
    });
  }

  window.drOpenStatusReport = function () {
    if (!canView(REPORT_ID) && currentRole() !== 'owner') return;
    openDialog();
  };
  // Exposed for tests only.
  window.drStatusReportInternals = {
    DEFS: DEFS, availableSections: availableSections, assemble: assemble, buildSummary: buildSummary, buildExec: buildExec, chartNext: chartNext, depRanked: depRanked, highRisks: highRisks, portalMarks: portalMarks, indexColor: indexColor, lateColor: lateColor, daysLate: daysLate, richSegments: richSegments, cellStyleFor: cellStyleFor, execFrame: execFrame, detailFrame: detailFrame, sectionFacts: sectionFacts, addAnalysis: addAnalysis, execSections: execSections, buildDocx: buildDocx, composeExec: composeExec, execKpis: execKpis, buildCharts: buildCharts, explainChart: explainChart,
    rolesAllowedFor: rolesAllowedFor, renderPdf: renderPdf, pdfText: pdfText, changeStatus: changeStatus,
    sectionNextFacts: sectionNextFacts, vendorFlagNext: vendorFlagNext, mergeNext: mergeNext, SECTION_GUIDE: SECTION_GUIDE,
    SECTION_PORTAL: SECTION_PORTAL, lateMilestonesList: lateMilestonesList, topExposureOwner: topExposureOwner, burndownInsight: burndownInsight
  };
})();
