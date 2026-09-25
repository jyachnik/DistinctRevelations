/* ============================================================================
   Project Documents import (owner-only) — one upload for all the project's
   planning documents. Pick as many .xlsx / .csv / .docx files as you like; each
   is recognised by its CONTENT (column headers / table headers), not its file
   name, a preview shows exactly what would be created or refreshed, and nothing
   is written until you confirm.

   Stage 1 importers:
     • Stakeholder Register (+ Stakeholder Engagement Assessment Matrix, joined by
       Stakeholder ID)                       -> Stakeholder Register card
     • Dependencies Log                      -> Dependencies card
     • Change Log (workbook sheet)           -> Change Control Log card
     • Procurement Plan (Word table)         -> Procurement: Planned purchases
     • WBS Dictionary (Word tables)          -> Deliverable Sign-off acceptance criteria

   Re-importing is safe: every record gets a deterministic id (imp_<source id>), so
   a second import refreshes the fields the file provides instead of duplicating.

   Structure: (1) pure helpers + readers, (2) one planner per document type
   (parsed files in -> planned writes out; no Firestore, unit-tested in Node),
   (3) the browser UI that reads files, previews and applies the plans.
   ============================================================================ */

(function (root) {
  'use strict';

  // The text extractor (doc-text.js) — a plain script in the browser, a require in Node tests.
  var T = (typeof module !== 'undefined' && module.exports) ? require('./doc-text.js') : null;
  function TT() { return T || (T = root.drDocText); }

  // ---------------------------------------------------------------------
  // 1. Pure helpers
  // ---------------------------------------------------------------------
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function str(v) {
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).replace(/\s+$/g, '').replace(/^\s+/g, '');
  }
  function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // Dates arrive as Excel serial numbers (spreadsheets), ISO strings, "3/1/2026",
  // or "March 1, 2026" (Word tables). Anything else (e.g. "As needed") -> null.
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate());
    if (typeof v === 'number') {
      if (v > 20000 && v < 80000) { var d = new Date(Math.round((v - 25569) * 86400000)); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
      return null;
    }
    var s = String(v).trim();
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
    if (/\b(19|20)\d{2}\b/.test(s) && /[a-z]{3}/i.test(s)) {
      var t = Date.parse(s.replace(/\(.*?\)/g, ''));
      if (!isNaN(t)) { var d2 = new Date(t); return new Date(d2.getFullYear(), d2.getMonth(), d2.getDate()); }
    }
    return null;
  }

  // Finds the header row (within the first rows of a sheet) that contains every
  // needle as part of one of its cells. Returns { row, cols(needle -> index) } or null.
  function findHeader(rows, needles) {
    for (var r = 0; r < Math.min(rows.length, 12); r++) {
      var cells = (rows[r] || []).map(norm);
      var cols = {}, ok = true;
      for (var i = 0; i < needles.length; i++) {
        var want = norm(needles[i]), idx = -1;
        for (var c = 0; c < cells.length; c++) { if (cells[c] && cells[c].indexOf(want) !== -1) { idx = c; break; } }
        if (idx === -1) { ok = false; break; }
        cols[needles[i]] = idx;
      }
      if (ok) return { row: r, header: rows[r], cols: cols };
    }
    return null;
  }
  // Column index whose header contains `name`, or -1.
  function col(header, name) {
    var want = norm(name);
    for (var c = 0; c < header.length; c++) { if (norm(header[c]).indexOf(want) !== -1) return c; }
    return -1;
  }
  function cellAt(row, idx) { return idx >= 0 && row ? str(row[idx]) : ''; }

  // ---- Word (.docx) table extraction: pure, works on word/document.xml text
  function xmlDecode(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
  function paraText(pXml) {
    var out = '', re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g, m;
    while ((m = re.exec(pXml)) !== null) out += m[1] != null ? m[1] : ' ';
    return xmlDecode(out);
  }
  function paragraphsOf(xml) { return (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []); }
  // Returns [{ title, rows:[[cellText]] }] — `title` = the heading right before the table.
  function docxTables(xml) {
    var tables = [], chunks = xml.split('</w:tbl>');
    for (var i = 0; i < chunks.length - 1; i++) {
      var parts = chunks[i].split('<w:tbl>');
      var prefix = parts.slice(0, -1).join('<w:tbl>'), tblXml = parts[parts.length - 1];
      var title = '';
      paragraphsOf(prefix).forEach(function (p) {
        var st = /<w:pStyle w:val="([^"]+)"/.exec(p);
        if (st && /^Heading|Title/i.test(st[1])) { var t = paraText(p).trim(); if (t) title = t; }
      });
      var rows = tblXml.split('</w:tr>').slice(0, -1).map(function (tr) {
        return tr.split('</w:tc>').slice(0, -1).map(function (tc) {
          return paragraphsOf(tc).map(paraText).map(function (t) { return t.trim(); }).filter(Boolean).join('\n');
        });
      });
      tables.push({ title: title, rows: rows });
    }
    return tables;
  }

  // ---------------------------------------------------------------------
  // 2. Planners. Each takes the parsed files (and, if it needs the current
  //    state of Firestore, env) and returns
  //    { writes:[{collection,id,data}], summary, warnings:[], options? }.
  //    Parsed file shapes:
  //      { name, kind:'sheets', sheets:[{ name, rows:[[cell]] }] }
  //      { name, kind:'docx',   tables:[{ title, rows:[[text]] }] }
  // ---------------------------------------------------------------------
  function eachSheet(files, fn) {
    files.forEach(function (f) { if (f.kind === 'sheets') f.sheets.forEach(function (sh) { fn(sh, f); }); });
  }
  function eachTable(files, fn) {
    files.forEach(function (f) { if (f.kind === 'docx') f.tables.forEach(function (t) { fn(t, f); }); });
  }

  // ---- Stakeholders (+ SEAM) ------------------------------------------
  var LEVEL3 = { h: 'High', m: 'Medium', l: 'Low', high: 'High', medium: 'Medium', low: 'Low' };
  var ENGAGE = { u: 'Unaware', r: 'Resistant', n: 'Neutral', s: 'Supportive', l: 'Leading',
    unaware: 'Unaware', resistant: 'Resistant', neutral: 'Neutral', supportive: 'Supportive', leading: 'Leading' };

  function stakeholderSources(files) {
    var reg = null, seam = null, names = [];
    eachSheet(files, function (sh, f) {
      var h = findHeader(sh.rows, ['stakeholder id', 'engagement strategy']);
      if (h && !reg) { reg = { sh: sh, h: h }; names.push(f.name); return; }
      var h2 = findHeader(sh.rows, ['stakeholder id', 'current', 'desired']);
      if (h2 && !seam) { seam = { sh: sh, h: h2 }; names.push(f.name); }
    });
    return { reg: reg, seam: seam, names: names };
  }
  function planStakeholders(files) {
    var src = stakeholderSources(files), byId = {}, order = [], warnings = [];
    function rec(id) { if (!byId[id]) { byId[id] = { sourceId: id }; order.push(id); } return byId[id]; }

    if (src.reg) {
      var H = src.reg.h.header, rows = src.reg.sh.rows;
      var c = {
        id: col(H, 'stakeholder id'), name: col(H, 'name'), org: col(H, 'group'), ie: col(H, 'internal'),
        needs: col(H, 'primary interests'), strat: col(H, 'engagement strategy'), what: col(H, 'key communications'),
        how: col(H, 'channel'), freq: col(H, 'frequency'), owner: col(H, 'owner'), auth: col(H, 'key decisions'),
        risk: col(H, 'new assumptions'), follow: col(H, 'follow-up'), added: col(H, 'date added'), notes: col(H, 'notes')
      };
      for (var r = src.reg.h.row + 1; r < rows.length; r++) {
        var id = cellAt(rows[r], c.id);
        if (!id) continue;
        var x = rec(id);
        x.name = cellAt(rows[r], c.name); x.organization = cellAt(rows[r], c.org); x.internalExternal = cellAt(rows[r], c.ie);
        x.requirements = cellAt(rows[r], c.needs); x.engagementStrategy = cellAt(rows[r], c.strat);
        x.keyComms = cellAt(rows[r], c.what); x.channel = cellAt(rows[r], c.how); x.frequency = cellAt(rows[r], c.freq);
        x.stakeholderOwner = cellAt(rows[r], c.owner); x.authority = cellAt(rows[r], c.auth);
        x.riskAssumptions = cellAt(rows[r], c.risk); x.followUp = cellAt(rows[r], c.follow); x.regNotes = cellAt(rows[r], c.notes);
      }
    }
    if (src.seam) {
      var S = src.seam.h.header, srows = src.seam.sh.rows;
      var s = { id: col(S, 'stakeholder id'), name: col(S, 'name'), inf: col(S, 'influence'), imp: col(S, 'impact'),
        cur: col(S, 'current'), des: col(S, 'desired'), gap: col(S, 'gap'), review: col(S, 'review date') };
      for (var q = src.seam.h.row + 1; q < srows.length; q++) {
        var sid = cellAt(srows[q], s.id);
        if (!sid) continue;
        var y = rec(sid);
        if (!y.name) y.name = cellAt(srows[q], s.name);
        var inf = LEVEL3[cellAt(srows[q], s.inf).toLowerCase()], imp = LEVEL3[cellAt(srows[q], s.imp).toLowerCase()];
        if (inf) y.influence = inf;
        if (imp) y.interest = imp;
        var cu = ENGAGE[cellAt(srows[q], s.cur).toLowerCase()], de = ENGAGE[cellAt(srows[q], s.des).toLowerCase()];
        if (cu) y.currentEngagement = cu;
        if (de) y.desiredEngagement = de;
        y.engagementGap = cellAt(srows[q], s.gap);
        var rv = parseDate(srows[q][s.review]); if (rv) y.seamReviewDate = rv;
      }
      warnings.push('Interest is taken from the Engagement Matrix "Impact" column (the register has no separate interest rating).');
    }
    if (src.reg && !src.seam) warnings.push('No Stakeholder Engagement Assessment Matrix was selected, so influence, interest and engagement levels stay blank.');
    if (!src.reg && src.seam) warnings.push('No Stakeholder Register was selected, so only names and engagement levels are imported.');

    var writes = order.map(function (id) {
      var x = byId[id], lines = [];
      if (x.engagementStrategy) lines.push('Strategy: ' + x.engagementStrategy);
      var comms = [x.keyComms, x.channel, x.frequency].filter(Boolean).join(' — ');
      if (comms) lines.push('Communications: ' + comms);
      if (x.stakeholderOwner) lines.push('Owner: ' + x.stakeholderOwner);
      if (x.authority) lines.push('Authority: ' + x.authority);
      if (x.riskAssumptions) lines.push('Assumptions/risks: ' + x.riskAssumptions);
      if (x.followUp) lines.push('Follow-up: ' + x.followUp);
      if (x.regNotes) lines.push(x.regNotes);
      var data = {
        name: x.name || id, role: '', organization: [x.organization, x.internalExternal ? '(' + x.internalExternal + ')' : ''].filter(Boolean).join(' '),
        email: '', phone: '', requirements: x.requirements || '', notes: lines.join('\n'),
        engagementStrategy: x.engagementStrategy || '', keyComms: x.keyComms || '', channel: x.channel || '', frequency: x.frequency || '',
        stakeholderOwner: x.stakeholderOwner || '', authority: x.authority || '', followUp: x.followUp || '',
        internalExternal: x.internalExternal || '', sourceId: id, source: 'import'
      };
      ['influence', 'interest', 'currentEngagement', 'desiredEngagement', 'engagementGap', 'seamReviewDate'].forEach(function (k) { if (x[k]) data[k] = x[k]; });
      return { collection: 'stakeholders', id: 'imp_' + id, data: data };
    });
    return { writes: writes, summary: writes.length + ' stakeholders' + (src.seam ? ' with influence, interest and current/desired engagement' : ''), warnings: warnings };
  }

  // ---- Dependencies Log -------------------------------------------------
  function depStatus(s) {
    s = String(s || '');
    if (/closed|done|complete|resolved/i.test(s)) return 'Resolved';
    if (/block/i.test(s)) return 'Blocked';
    if (/risk/i.test(s)) return 'At Risk';
    return 'Open';
  }
  function planDependencies(files) {
    var writes = [], warnings = [], names = [];
    eachSheet(files, function (sh) {
      var h = findHeader(sh.rows, ['dependency id', 'dependency description']);
      if (!h) return;
      var H = h.header;
      var c = { id: col(H, 'dependency id'), logged: col(H, 'date logged'), type: col(H, 'type'), cat: col(H, 'category'),
        desc: col(H, 'dependency description'), succ: col(H, 'dependent'), owner: col(H, 'owner'), need: col(H, 'needed by'),
        status: col(H, 'status'), risk: col(H, 'risk if'), cont: col(H, 'contingency'), notes: col(H, 'notes') };
      for (var r = h.row + 1; r < sh.rows.length; r++) {
        var row = sh.rows[r], id = cellAt(row, c.id);
        if (!id) continue;
        var pred = cellAt(row, c.desc), succ = cellAt(row, c.succ);
        var impact = [cellAt(row, c.risk), cellAt(row, c.cont) ? 'Workaround: ' + cellAt(row, c.cont) : ''].filter(Boolean).join(' — ');
        var external = /external/i.test(cellAt(row, c.type));
        writes.push({ collection: 'dependencies', id: 'imp_' + id, data: {
          title: pred + ' -> ' + succ, predecessorId: '', predecessorTitle: pred, successorId: '', successorTitle: succ,
          dependencyType: external ? 'External' : 'Internal / Cross-project', relationship: 'Finish-to-Start',
          status: depStatus(cellAt(row, c.status)), owner: cellAt(row, c.owner), needByDate: parseDate(row[c.need]),
          impact: impact, category: cellAt(row, c.cat), sourceId: id, source: 'import'
        } });
      }
    });
    if (!writes.length) return null;
    warnings.push('Each dependency is imported as "description -> dependent deliverable" and is not linked to schedule tasks (the log names workstreams, not task IDs); link them by editing a row if you want.');
    return { writes: writes, summary: writes.length + ' dependencies', warnings: warnings };
  }

  // ---- Change Log (workbook sheet) ---------------------------------------
  function parseScheduleDays(s) {
    var m = /schedule:\s*([+-]?\d+(?:\.\d+)?)\s*(day|week)/i.exec(s);
    if (m) return Math.round(parseFloat(m[1]) * (/week/i.test(m[2]) ? 7 : 1));
    if (/schedule:\s*no impact/i.test(s)) return 0;
    return null;
  }
  function parseCost(s) {
    var m = /cost:\s*([+-]?)\s*\$\s*([\d,.]+)\s*([KkMm])?/i.exec(s);
    if (m) { var n = parseFloat(m[2].replace(/,/g, '')) * (/k/i.test(m[3] || '') ? 1000 : /m/i.test(m[3] || '') ? 1000000 : 1); return m[1] === '-' ? -n : n; }
    if (/cost:\s*no impact/i.test(s)) return 0;
    return null;
  }
  function planChangeLog(files) {
    var writes = [], warnings = [];
    eachSheet(files, function (sh) {
      var h = findHeader(sh.rows, ['change id', 'impact analysis']);
      if (!h) return;
      var H = h.header;
      var c = { id: col(H, 'change id'), date: col(H, 'date'), reqs: col(H, 'affected req'), type: col(H, 'change type'),
        desc: col(H, 'description'), impact: col(H, 'impact analysis'), by: col(H, 'approved by'), status: col(H, 'status') };
      for (var r = h.row + 1; r < sh.rows.length; r++) {
        var row = sh.rows[r], id = cellAt(row, c.id);
        if (!id) continue;
        var desc = cellAt(row, c.desc), impact = cellAt(row, c.impact), by = cellAt(row, c.by), status = cellAt(row, c.status);
        var when = parseDate(row[c.date]) || new Date();
        var needsSponsor = /sponsor/i.test(by);
        var approved = /approv/i.test(status), rejected = /reject|denied/i.test(status);
        var type = cellAt(row, c.type);
        var data = {
          title: clip(desc.split(/[.!?]\s/)[0] || desc, 90),
          description: desc + (cellAt(row, c.reqs) ? '\n\nAffected requirements: ' + cellAt(row, c.reqs) : ''),
          reason: ('Imported from the Change Log (' + type + ').' + (impact ? '\nImpact analysis: ' + impact : '')).trim(),
          changeType: /scope|defer|enhance|clarif/i.test(type) ? 'Scope' : /schedul/i.test(type) ? 'Schedule' : /cost/i.test(type) ? 'Cost' : /quality/i.test(type) ? 'Quality' : 'Other',
          priority: 'Medium', scheduleImpactDays: parseScheduleDays(impact), costImpact: parseCost(impact),
          linkedItemType: '', linkedItemId: '', linkedItemTitle: '', needsSponsorApproval: needsSponsor,
          proposedBy: 'Imported', proposedByUid: '', createdAt: when,
          ownerDecision: approved ? 'approved' : rejected ? 'rejected' : 'pending',
          sponsorDecision: needsSponsor ? (approved ? 'approved' : rejected ? 'rejected' : 'pending') : 'n/a',
          sourceId: id, source: 'import'
        };
        if (approved || rejected) {
          data.ownerDecidedAt = when; data.ownerDecidedBy = 'Imported change log'; data.ownerComment = 'Approved by: ' + by;
          if (needsSponsor) { data.sponsorDecidedAt = when; data.sponsorDecidedBy = 'Imported change log'; data.sponsorComment = 'Approved by: ' + by; }
        }
        writes.push({ collection: 'changeRequests', id: 'imp_' + id, data: data });
      }
    });
    if (!writes.length) return null;
    warnings.push('Original decision dates come from the log; the decision stamp reads "Imported change log". Each row\'s "Approved By" list is kept in the decision comment.');
    return { writes: writes, summary: writes.length + ' change requests', warnings: warnings };
  }

  // ---- Procurement Plan (Word table) --------------------------------------
  function planProcurement(files) {
    var writes = [], warnings = [];
    eachTable(files, function (t) {
      var h = findHeader(t.rows, ['procurement category', 'required by', 'lead time']);
      if (!h) return;
      var H = h.header, c = { cat: col(H, 'procurement category'), by: col(H, 'required by'), lead: col(H, 'lead time') };
      for (var r = h.row + 1; r < t.rows.length; r++) {
        var row = t.rows[r], item = cellAt(row, c.cat);
        if (!item) continue;
        var reqRaw = cellAt(row, c.by), needBy = parseDate(reqRaw);
        writes.push({ collection: 'purchases', id: 'imp_proc_' + (r - h.row), data: {
          item: item, vendorId: '', vendorName: '', contractType: 'Other', status: 'Planned',
          contractValue: null, invoicedAmount: null, paidAmount: null, needByDate: needBy, contractStart: null, contractEnd: null, deliveryDue: null,
          contractUrl: '', notes: ['Lead time: ' + cellAt(row, c.lead), needBy ? '' : 'Required by: ' + reqRaw].filter(Boolean).join('. '),
          linkedRiskId: '', linkedRiskTitle: '', linkedItemId: '', linkedItemTitle: '', sourceId: 'proc-' + (r - h.row), source: 'import'
        } });
      }
    });
    if (!writes.length) return null;
    warnings.push('Imported as Planned purchases (no vendor or dollar amounts yet — those apply once a vendor is selected).');
    return { writes: writes, summary: writes.length + ' planned purchases', warnings: warnings };
  }

  // ---- WBS Dictionary (Word tables) -> Deliverable Sign-off ------------------
  function wbsKey(w) { return String(w == null ? '' : w).trim().replace(/\.0+$/, ''); }
  function readWbsEntries(files) {
    var out = [];
    eachTable(files, function (t) {
      if (!t.rows.length || !/^wbs id/i.test(norm(t.rows[0][0]))) return;
      var kv = {};
      t.rows.forEach(function (r) { kv[norm(r[0])] = r[1] || ''; });
      var wbs = wbsKey(kv['wbs id'] || t.rows[0][1]);
      if (!wbs) return;
      out.push({ wbs: wbs, name: (t.title || '').replace(/^\s*[\d.]+\s*/, '').trim(), description: kv['description'] || '',
        deliverables: kv['deliverables'] || '', acceptance: kv['acceptance criteria'] || '', responsible: kv['responsible role'] || '' });
    });
    return out;
  }
  // env: { existing(collection) -> Promise<{[id]: data}> }
  function planWbsAcceptance(files, env, opts) {
    var entries = readWbsEntries(files).filter(function (e) { return e.acceptance; });
    if (!entries.length) return Promise.resolve(null);
    return Promise.all([env.existing('milestones'), env.existing('activities'), env.existing('signoffs')]).then(function (res) {
      var byWbs = {};   // wbs -> 'milestone:<id>' | 'activity:<id>'
      [['milestone', res[0]], ['activity', res[1]]].forEach(function (p) {
        Object.keys(p[1]).forEach(function (id) { var w = p[1][id] && p[1][id].wbs; if (w) byWbs[wbsKey(w)] = p[0] + ':' + id; });
      });
      var signoffByLink = {};
      Object.keys(res[2]).forEach(function (id) { var l = res[2][id] && res[2][id].linkedItemId; if (l) signoffByLink[l] = id; });

      var writes = [], filled = 0, alreadyHad = 0, unmatched = [];
      entries.forEach(function (e) {
        var link = byWbs[e.wbs], sid = link && signoffByLink[link];
        if (sid) {
          if (res[2][sid].acceptanceCriteria && !opts.overwrite) { alreadyHad++; return; }
          writes.push({ collection: 'signoffs', id: sid, data: { acceptanceCriteria: e.acceptance }, update: true });
          filled++;
        } else unmatched.push(e);
      });
      var created = 0;
      if (opts.createMissing) {
        unmatched.forEach(function (e) {
          writes.push({ collection: 'signoffs', id: 'imp_wbs_' + e.wbs, data: {
            title: (e.wbs + ' ' + (e.name || 'Deliverable')).trim(), kind: 'Deliverable', linkedItemId: byWbs[e.wbs] || '', linkedItemTitle: '',
            acceptanceCriteria: e.acceptance, dueDate: null, evidenceUrl: '', decision: 'pending', round: 1, history: [],
            createdBy: 'Imported', createdByUid: '', sourceId: 'wbs-' + e.wbs, source: 'import' } });
          created++;
        });
      }
      return {
        writes: writes,
        summary: entries.length + ' WBS entries have acceptance criteria: ' + filled + ' added to existing sign-off items' +
          (created ? ', ' + created + ' new sign-off items created' : '') + '; ' + alreadyHad + ' items already had criteria (kept); ' +
          (created ? 0 : unmatched.length) + ' WBS entries have no sign-off item' + (created ? '' : ' yet') + '.',
        warnings: unmatched.length && !created ? ['To fill criteria, first run Deliverable Sign-off ▸ "Add schedule milestones" (or tick the option below to create items for the WBS entries without one).'] : [],
        options: [
          { key: 'createMissing', label: 'Also create sign-off items for the ' + unmatched.length + ' WBS entries that have none', value: !!opts.createMissing },
          { key: 'overwrite', label: 'Replace acceptance criteria that are already filled in', value: !!opts.overwrite }
        ]
      };
    });
  }

  // ---- Documents -> Document Register + AI-readable text ---------------------
  // Every readable file (Word / spreadsheet / csv) becomes a register record plus
  // its extracted text sections; the original is kept in Storage. `allowedRoles`
  // decides who can see the document AND who the AI may quote it to.
  var ROLE_SETS = {
    owner: [],
    partner: ['clientPartner'],
    pm: ['clientPartner', 'projectManager'],
    all: ['clientPartner', 'projectManager', 'admin', 'member']
  };
  var ROLE_SET_LABEL = { owner: 'Owner only', partner: 'Owner + Client Partner', pm: 'Owner + Client Partner + Project Manager', all: 'Everyone in the project' };
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90); }
  var CONTENT_TYPE = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel', csv: 'text/csv'
  };
  var DEFAULT_EXCLUDE = /claude prompts|download test/i;
  function planDocuments(files, env, opts) {
    opts = opts || {};
    var vis = ROLE_SETS[opts.visibility] ? opts.visibility : 'pm';
    var writes = [], uploads = [], warnings = [], totalWords = 0, totalSections = 0, noText = [], fileChoices = [];
    // Obvious non-project files are off by default; the owner can change any of them.
    var isExcluded = function (n) { return Array.isArray(opts.exclude) ? opts.exclude.indexOf(n) !== -1 : DEFAULT_EXCLUDE.test(n); };
    files.forEach(function (f) {
      if (!f.sections || !f.sections.length) { noText.push(f.name); return; }
      fileChoices.push({ name: f.name, included: !isExcluded(f.name) });
      if (isExcluded(f.name)) return;
      var meta = TT().parseFileName(f.name);
      var phase = (opts.phase && opts.phase !== 'auto') ? opts.phase : (TT().phaseFromPath(f.path || f.name) || '');
      var id = 'doc_' + slug([phase, meta.number, meta.title, meta.version, meta.ext].filter(Boolean).join('-'));
      var words = f.sections.reduce(function (t, s) { return t + s.words; }, 0);
      totalWords += words; totalSections += f.sections.length;
      var storagePath = f.buffer ? 'documents/' + (opts.biz || '_') + '/' + (opts.proj || '_') + '/' + id : '';
      writes.push({ collection: 'documents', id: id, data: {
        number: meta.number, title: meta.title, version: meta.version, ext: meta.ext, fileName: f.name, phase: phase,
        sourceFolder: opts.sourceLabel || '', sourcePath: (f.path && f.path !== f.name) ? f.path : '',
        words: words, sectionCount: f.sections.length, size: f.size || 0,
        allowedRoles: ROLE_SETS[vis].slice(), visibility: vis, storagePath: storagePath, hasOriginal: !!storagePath, source: 'import'
      } });
      writes.push({ collection: 'documentText', id: id, data: { sections: f.sections, words: words, truncated: f.sections.truncated || 0 } });
      if (f.buffer) uploads.push({ id: id, path: storagePath, buffer: f.buffer, contentType: CONTENT_TYPE[meta.ext] || 'application/octet-stream' });
      if (f.sections.truncated) warnings.push(f.name + ': very long — ' + f.sections.truncated + ' section(s) at the end were left out.');
    });
    if (!writes.length) return null;
    var n = writes.length / 2;
    if (noText.length) warnings.push('No readable text in: ' + noText.slice(0, 6).join(', ') + (noText.length > 6 ? ', …' : ''));
    warnings.push('Visible to: ' + ROLE_SET_LABEL[vis] + '. The AI only quotes a document to roles that can see it. Originals are kept so they can be downloaded from the register.');
    return { writes: writes, uploads: uploads, count: n, fileChoices: fileChoices,
      summary: n + ' documents (' + totalSections + ' sections, about ' + totalWords.toLocaleString('en-US') + ' words) into the Document Register for AI questions', warnings: warnings };
  }

  // ---- registry -------------------------------------------------------------
  // A job = one recognised document set. plan(files, env, opts) -> Promise<plan|null>.
  var IMPORTERS = [
    { id: 'documents', label: 'Document Register + AI text', target: 'Document Register (AI can answer from these)', collections: ['documents'], optional: true,
      claims: function (files) { return files.filter(function (f) { return f.sections && f.sections.length; }).map(function (f) { return f.name; }); },
      plan: function (files, env, opts) { return Promise.resolve(planDocuments(files, env, opts)); } },
    { id: 'stakeholders', label: 'Stakeholder Register', target: 'Stakeholder Register card', collections: ['stakeholders'],
      claims: function (files) { return stakeholderSources(files).names; }, plan: function (files) { return Promise.resolve(planStakeholders(files)); } },
    { id: 'dependencies', label: 'Dependencies Log', target: 'Dependencies card', collections: ['dependencies'],
      claims: function (files) { var n = []; eachSheet(files, function (sh, f) { if (findHeader(sh.rows, ['dependency id', 'dependency description'])) n.push(f.name); }); return n; },
      plan: function (files) { return Promise.resolve(planDependencies(files)); } },
    { id: 'changelog', label: 'Change Log', target: 'Change Control Log card', collections: ['changeRequests'],
      claims: function (files) { var n = []; eachSheet(files, function (sh, f) { if (findHeader(sh.rows, ['change id', 'impact analysis'])) n.push(f.name); }); return n; },
      plan: function (files) { return Promise.resolve(planChangeLog(files)); } },
    { id: 'procurement', label: 'Procurement Plan', target: 'Procurement Log (planned purchases)', collections: ['purchases'],
      claims: function (files) { var n = []; eachTable(files, function (t, f) { if (findHeader(t.rows, ['procurement category', 'required by', 'lead time'])) n.push(f.name); }); return n; },
      plan: function (files) { return Promise.resolve(planProcurement(files)); } },
    { id: 'wbs', label: 'WBS Dictionary', target: 'Deliverable Sign-off (acceptance criteria)', collections: ['signoffs'],
      claims: function (files) { var n = []; eachTable(files, function (t, f) { if (t.rows.length && /^wbs id/i.test(norm(t.rows[0][0])) && n.indexOf(f.name) === -1) n.push(f.name); }); return n; },
      plan: function (files, env, opts) { return planWbsAcceptance(files, env, opts || {}); } }
  ];

  // Which importers apply to this batch of files (and which files each one used).
  function detectJobs(files) {
    var jobs = [], claimed = {};
    IMPORTERS.forEach(function (imp) {
      var names = imp.claims(files);
      if (!names.length) return;
      names.forEach(function (n) { claimed[n] = true; });
      jobs.push({ id: imp.id, label: imp.label, target: imp.target, collections: imp.collections, files: names.filter(function (n, i) { return names.indexOf(n) === i; }), importer: imp });
    });
    var unrecognised = files.filter(function (f) { return !claimed[f.name]; }).map(function (f) { return f.name; });
    return { jobs: jobs, unrecognised: unrecognised };
  }

  // Firestore rejects `undefined`; NaN would be stored as a number nobody wants.
  function cleanData(o) {
    var out = {};
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (v === undefined || (typeof v === 'number' && isNaN(v))) return;
      out[k] = v;
    });
    return out;
  }

  var core = {
    planDocuments: planDocuments, ROLE_SETS: ROLE_SETS,
    norm: norm, parseDate: parseDate, findHeader: findHeader, docxTables: docxTables, detectJobs: detectJobs, IMPORTERS: IMPORTERS,
    planStakeholders: planStakeholders, planDependencies: planDependencies, planChangeLog: planChangeLog,
    planProcurement: planProcurement, planWbsAcceptance: planWbsAcceptance, readWbsEntries: readWbsEntries,
    parseScheduleDays: parseScheduleDays, parseCost: parseCost, cleanData: cleanData
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.drPmImportCore = core;

  // ---------------------------------------------------------------------
  // 3. Browser UI (Data Imports panel)
  // ---------------------------------------------------------------------
  var ns = '[pm-doc-import]';
  var JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function db() { return window.db || (window.firebase && window.firebase.firestore && window.firebase.firestore()); }
  function projRef() { return db().collection('businesses').doc(window.BIZ_KEY).collection('projects').doc(window.PROJECT_KEY || 'default'); }
  function isOwner() { return !!(window.drAccess && window.drAccess.role === 'owner'); }

  function loadJsZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = JSZIP_URL; s.async = true;
      s.onload = function () { resolve(window.JSZip); };
      s.onerror = function () { reject(new Error('Could not load the Word-document reader — check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }
  // File -> parsed file for the planners. Also keeps the original bytes (stored in the
  // Document Register) and the extracted text sections (what the AI reads). "path" is the
  // folder-relative path when a whole folder was picked.
  function readOne(file) {
    var name = file.name, path = file.webkitRelativePath || name;
    if (/^~\$/.test(name)) return Promise.resolve(null);              // Word's temporary lock files
    if (/\.docx$/i.test(name)) {
      return Promise.all([file.arrayBuffer(), loadJsZip()]).then(function (r) {
        return r[1].loadAsync(r[0]).then(function (zip) {
          var f = zip.file('word/document.xml');
          return (f ? f.async('string') : Promise.resolve('')).then(function (xml) {
            return { name: name, path: path, kind: 'docx', tables: docxTables(xml), sections: TT().docxSections(xml), buffer: r[0], size: r[0].byteLength };
          });
        });
      });
    }
    if (/\.(xlsx|xls|csv)$/i.test(name)) {
      if (!window.XLSX) return Promise.reject(new Error('The spreadsheet reader has not loaded yet — try again in a moment.'));
      return file.arrayBuffer().then(function (buf) {
        var wb = window.XLSX.read(buf, { type: 'array' });
        var sheets = wb.SheetNames.map(function (n) {
          return { name: n, rows: window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) };
        });
        return { name: name, path: path, kind: 'sheets', sheets: sheets, sections: TT().sheetSections(sheets), buffer: buf, size: buf.byteLength };
      });
    }
    return Promise.resolve(null);
  }

  core.readOne = readOne;   // exposed for tests: File-like { name, arrayBuffer() } -> parsed file

  function env() {
    return {
      existing: function (collection) {
        return projRef().collection(collection).get().then(function (snap) {
          var o = {}; snap.forEach(function (d) { o[d.id] = d.data() || {}; }); return o;
        });
      }
    };
  }

  // Change the message of the already-open overlay (does not nest, so one hide() still closes it).
  function progress(msg) {
    var el = document.querySelector('.dr-progress-message');
    if (el) el.textContent = msg;
  }

  // Originals are immutable in Storage, so a re-import removes the old copy first.
  function uploadOriginals(uploads) {
    var st = window.firebase.storage(), i = 0, done = 0;
    function one(u) {
      var ref = st.ref().child(u.path);
      return ref.delete().catch(function (err) { if (!(err && err.code === 'storage/object-not-found')) throw err; })
        .then(function () { return ref.put(u.buffer, { contentType: u.contentType }); })
        .then(function () { done++; progress('Storing originals… ' + done + ' of ' + uploads.length); });
    }
    function worker() {
      if (i >= uploads.length) return Promise.resolve();
      var u = uploads[i++];
      return one(u).then(worker);
    }
    return Promise.all([worker(), worker(), worker()]);
  }

  function applyPlan(plan) {
    var d = db(), FV = window.firebase.firestore.FieldValue, user = window.auth && window.auth.currentUser;
    var by = (user && user.email) || 'Imported';
    var uid = (user && user.uid) || '';
    // documentText rows are big (a whole document's text) — keep those batches small.
    var groups = [], small = [], big = [];
    plan.writes.forEach(function (w) { (w.collection === 'documentText' ? big : small).push(w); });
    for (var i = 0; i < small.length; i += 400) groups.push(small.slice(i, i + 400));
    for (var j = 0; j < big.length; j += 6) groups.push(big.slice(j, j + 6));
    var uploads = plan.uploads && plan.uploads.length ? uploadOriginals(plan.uploads) : Promise.resolve();
    return uploads.then(function () {
      return groups.reduce(function (chain, chunk, gi) {
        return chain.then(function () {
          progress('Saving records… ' + (gi + 1) + ' of ' + groups.length);
          var batch = d.batch();
          chunk.forEach(function (w) {
            var ref = projRef().collection(w.collection).doc(w.id);
            var data = cleanData(w.data);
            if (w.update) { data.updatedAt = FV.serverTimestamp(); data.updatedBy = by; batch.set(ref, data, { merge: true }); return; }
            data.importedAt = FV.serverTimestamp(); data.importedBy = by;
            if (!('createdAt' in data)) data.createdAt = FV.serverTimestamp();
            if (!('createdBy' in data)) data.createdBy = by;
            if (!('createdByUid' in data)) data.createdByUid = uid;
            batch.set(ref, data, { merge: true });
          });
          return batch.commit();
        });
      }, Promise.resolve());
    }).then(function () {
      if (plan.sourceLabel) return projRef().set({ documentsSourceLabel: plan.sourceLabel }, { merge: true });
    });
  }

  function init() {
    var input = document.getElementById('pmDocImportInput'), scanBtn = document.getElementById('pmDocImportScanBtn');
    var folderInput = document.getElementById('pmDocImportFolderInput');
    var out = document.getElementById('pmDocImportResults');
    if (!input || !scanBtn || !out || scanBtn.__wired) return;
    scanBtn.__wired = true;
    var state = { files: [], jobs: [] };
    function ctl(id) { return document.getElementById(id); }

    function panelOpts() {
      return {
        visibility: ctl('pmDocVisibility') ? ctl('pmDocVisibility').value : 'pm',
        phase: ctl('pmDocPhase') ? ctl('pmDocPhase').value : 'auto',
        sourceLabel: ctl('pmDocSourceLabel') ? ctl('pmDocSourceLabel').value.trim() : '',
        biz: window.BIZ_KEY, proj: window.PROJECT_KEY || 'default'
      };
    }
    function setMsg(html) { out.innerHTML = html; }

    function renderJobs(unrecognised, previews) {
      var html = previews.map(function (p, i) {
        var pl = p.plan, primary = p.job.collections[0];
        var mine = pl.writes.filter(function (w) { return w.collection === primary; });
        var existing = p.existing || {};
        var updates = mine.filter(function (w) { return w.update || existing[w.collection + '/' + w.id]; }).length;
        var news = mine.length - updates;
        var fileList = p.job.files.length > 8 ? p.job.files.length + ' files' : p.job.files.map(esc).join(', ');
        return '<div class="pmdi-job"><label class="pmdi-head"><input type="checkbox" class="pmdi-check" data-i="' + i + '" checked /> ' +
          '<strong>' + esc(p.job.label) + '</strong> &rarr; ' + esc(p.job.target) + '</label>' +
          '<div class="pmdi-files">' + fileList + '</div>' +
          '<div class="pmdi-sum">' + esc(pl.summary) + ' <span class="pmdi-counts">(' + news + ' new, ' + updates + ' refreshed)</span></div>' +
          (pl.warnings || []).map(function (w) { return '<div class="pmdi-warn">' + esc(w) + '</div>'; }).join('') +
          (pl.fileChoices && pl.fileChoices.length ? '<details class="pmdi-details"><summary>Choose which of the ' + pl.fileChoices.length + ' files to include</summary><div class="pmdi-filelist">' +
            pl.fileChoices.map(function (fc) {
              return '<label class="pmdi-fileopt"><input type="checkbox" class="pmdi-filebox" data-i="' + i + '" data-name="' + esc(fc.name) + '"' + (fc.included ? ' checked' : '') + ' /> ' + esc(fc.name) + '</label>';
            }).join('') + '</div></details>' : '') +
          (pl.options || []).map(function (o) {
            return '<label class="pmdi-opt"><input type="checkbox" class="pmdi-optbox" data-i="' + i + '" data-k="' + esc(o.key) + '"' + (o.value ? ' checked' : '') + ' /> ' + esc(o.label) + '</label>';
          }).join('') + '</div>';
      }).join('');
      if (unrecognised.length) html += '<div class="pmdi-skip">Not used for structured import (' + unrecognised.length + '): ' +
        (unrecognised.length > 8 ? unrecognised.slice(0, 8).map(esc).join(', ') + ', …' : unrecognised.map(esc).join(', ')) + '</div>';
      html += previews.length ? '<button type="button" id="pmDocImportApplyBtn" class="btn-primary">Import selected</button>'
        : '<div class="pmdi-warn">Nothing readable was found in the selected files. It reads Word (.docx), Excel (.xlsx) and .csv files.</div>';
      setMsg(html);

      // Changing an option re-plans that one job so the counts stay honest.
      out.querySelectorAll('.pmdi-optbox').forEach(function (b) {
        b.addEventListener('change', function () {
          var p = previews[+b.getAttribute('data-i')];
          p.opts[b.getAttribute('data-k')] = b.checked;
          p.job.importer.plan(state.files, env(), p.opts).then(function (np) { p.plan = np; renderJobs(unrecognised, previews); });
        });
      });
      out.querySelectorAll('.pmdi-filebox').forEach(function (b) {
        b.addEventListener('change', function () {
          var i = +b.getAttribute('data-i'), p = previews[i];
          p.opts.exclude = Array.prototype.map.call(out.querySelectorAll('.pmdi-filebox[data-i="' + i + '"]'), function (x) { return x; })
            .filter(function (x) { return !x.checked; }).map(function (x) { return x.getAttribute('data-name'); });
          p.job.importer.plan(state.files, env(), p.opts).then(function (np) { p.plan = np; renderJobs(unrecognised, previews); });
        });
      });
      var apply = document.getElementById('pmDocImportApplyBtn');
      if (apply) apply.addEventListener('click', function () {
        var picked = previews.filter(function (p, i) { var c = out.querySelector('.pmdi-check[data-i="' + i + '"]'); return c && c.checked; });
        if (!picked.length) { alert('Tick at least one item to import.'); return; }
        apply.disabled = true;
        if (window.drProgress) window.drProgress.show('Importing project documents…');
        var label = panelOpts().sourceLabel;
        picked.reduce(function (chain, p) {
          if (p.job.id === 'documents') p.plan.sourceLabel = label;
          return chain.then(function () { return applyPlan(p.plan); });
        }, Promise.resolve()).then(function () {
          var msg = picked.map(function (p) { return p.job.label + ' (' + (p.plan.count || p.plan.writes.length) + ')'; }).join(', ');
          setMsg('<div class="pmdi-done">Imported: ' + esc(msg) + '. The cards update automatically.</div>');
          input.value = ''; if (folderInput) folderInput.value = '';
        }).catch(function (err) {
          console.error(ns, 'import failed', err);
          setMsg('<div class="pmdi-warn">Import failed: ' + esc(err && err.message ? err.message : err) + '</div>');
        }).finally(function () { if (window.drProgress) window.drProgress.hide(); });
      });
    }

    // Choosing a folder pre-fills the source label with that folder's name.
    if (folderInput) folderInput.addEventListener('change', function () {
      var f = folderInput.files && folderInput.files[0];
      var lbl = ctl('pmDocSourceLabel');
      if (f && f.webkitRelativePath && lbl && !lbl.value.trim()) lbl.value = f.webkitRelativePath.split('/')[0];
    });

    scanBtn.addEventListener('click', function () {
      if (!isOwner()) { alert('Only the owner can import project documents.'); return; }
      var picked = Array.prototype.slice.call(input.files || []).concat(Array.prototype.slice.call((folderInput && folderInput.files) || []));
      if (!picked.length) { setMsg('<div class="pmdi-warn">Choose files or a folder first.</div>'); return; }
      var includeDocs = !ctl('pmDocIncludeDocs') || ctl('pmDocIncludeDocs').checked;
      setMsg('Reading ' + picked.length + ' file(s)… (large folders take a moment)');
      Promise.all(picked.map(readOne)).then(function (files) {
        state.files = files.filter(Boolean);
        var det = detectJobs(state.files);
        var jobs = det.jobs.filter(function (j) { return includeDocs || j.id !== 'documents'; });
        var structuredNames = {};
        jobs.forEach(function (j) { if (j.id !== 'documents') j.files.forEach(function (n) { structuredNames[n] = true; }); });
        var leftover = state.files.map(function (f) { return f.name; }).filter(function (n) { return !structuredNames[n]; });
        return Promise.all(jobs.map(function (job) {
          var opts = panelOpts();
          return job.importer.plan(state.files, env(), opts).then(function (plan) {
            if (!plan) return null;
            // Which of the records this plan would write already exist (so the preview can say "refreshed")?
            return Promise.all(job.collections.map(function (c) { return env().existing(c).then(function (m) { return { c: c, m: m }; }); }))
              .then(function (lists) {
                var existing = {};
                lists.forEach(function (l) { Object.keys(l.m).forEach(function (id) { existing[l.c + '/' + id] = true; }); });
                return { job: job, plan: plan, existing: existing, opts: opts };
              });
          });
        })).then(function (previews) {
          state.jobs = previews.filter(Boolean);
          renderJobs(includeDocs ? [] : det.unrecognised.concat(leftover.filter(function (n) { return det.unrecognised.indexOf(n) === -1; })), state.jobs);
        });
      }).catch(function (err) {
        console.error(ns, 'scan failed', err);
        setMsg('<div class="pmdi-warn">Could not read the files: ' + esc(err && err.message ? err.message : err) + '</div>');
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : this);
