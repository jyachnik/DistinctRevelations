/* ============================================================================
   doc-text.js — turns project documents into searchable text SECTIONS, for the
   Document Register and "Ask the Project" (an AI answers questions from these
   sections). Pure functions, no Firestore and no DOM, so the same code runs in
   the browser (importer) and in Node (tests).

     docxSections(documentXml)          Word body XML  -> sections
     sheetSections(sheets)              [{name, rows}] -> sections
     parseFileName(name)                "25-PowerMgmt - Risk Register v 1.0.xlsx" ->
                                        { number, title, version, ext }
     phaseFromPath(path)                "PM Structure/Planning/x.docx" -> "Planning"

   A section is { title, text, words }. Word documents split at headings (and
   again if a heading's body runs long); tables become one "Column: value | ..."
   line per row so questions about a row still match its column names; each
   spreadsheet sheet becomes groups of rows. Every section text starts with its
   own title so a match on the heading is a match on the section.
   ============================================================================ */

(function (root) {
  'use strict';

  var TARGET_WORDS = 320;       // a section that grows past this is split
  var MAX_SECTIONS = 1500;      // per document — a runaway file can't fill Firestore
  var MAX_TOTAL_CHARS = 700000; // keep one document's text safely under Firestore's 1 MiB limit

  function words(s) { return String(s || '').split(/\s+/).filter(Boolean).length; }
  function xmlDecode(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }
  function paraText(pXml) {
    var out = '', re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g, m;
    while ((m = re.exec(pXml)) !== null) out += m[1] != null ? m[1] : ' ';
    return xmlDecode(out).replace(/\s+/g, ' ').trim();
  }
  function headingLevel(pXml) {
    var st = /<w:pStyle w:val="([^"]+)"/.exec(pXml);
    if (!st) return 0;
    var v = st[1];
    if (/^Title$/i.test(v)) return 1;
    var m = /^Heading\s*(\d)/i.exec(v);
    return m ? Math.min(+m[1], 9) : 0;
  }

  // Many documents mark headings with bold, larger, numbered text ("1.1 Purpose")
  // instead of a Word heading style. Recognise those: bold AND (a large size, or a
  // short numbered line). Bold lead-ins inside a list ("Scope baseline - ...") have
  // neither, so they stay body text. Returns a level 2-4, or 0.
  function pseudoHeadingLevel(pXml, text) {
    if (!/<w:b\/>|<w:b w:val="(1|true)"\/>/.test(pXml)) return 0;
    var sz = +((/<w:sz w:val="(\d+)"/.exec(pXml) || [])[1] || 0);
    var num = /^(\d+(?:\.\d+)*)\.?\s+\S/.exec(text);
    var short = text.split(/\s+/).length <= 14;
    if (num && short) return Math.min(2 + num[1].split('.').length - 1, 4);
    if (sz >= 38 && short) return 2;
    if (sz >= 28 && short) return 3;
    return 0;
  }

  // One table -> lines of text.
  function tableLines(tblXml) {
    var rows = tblXml.split('</w:tr>').slice(0, -1).map(function (tr) {
      return tr.split('</w:tc>').slice(0, -1).map(function (tc) {
        return (tc.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).map(paraText).filter(Boolean).join('; ');
      });
    }).filter(function (r) { return r.some(Boolean); });
    if (!rows.length) return [];
    var cols = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    // Two-column "Label: | value" tables (document control blocks, WBS entries).
    var out;
    if (cols === 2 && /:\s*$/.test(rows[0][0] || '')) {
      out = rows.map(function (r) { return (r[0] || '').replace(/:\s*$/, '') + ': ' + (r[1] || ''); });
      out.headRows = 0;
      return out;
    }
    if (rows.length === 1) { out = [rows[0].filter(Boolean).join(' | ')]; out.headRows = 0; return out; }
    var head = rows[0];
    out = rows.slice(1).map(function (r) {
      return r.map(function (c, i) { return c ? ((head[i] ? head[i] + ': ' : '') + c) : ''; }).filter(Boolean).join(' | ');
    });
    out.headRows = 1;   // the first row became the column labels, so line i is table row i + 1
    return out;
  }

  // Body blocks in document order: { kind:'p', level, text, bullet } | { kind:'t', lines }
  function docxBlocks(xml) {
    var blocks = [], re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g, m;
    while ((m = re.exec(xml)) !== null) {
      var chunk = m[0];
      if (chunk.indexOf('<w:tbl>') === 0) {
        var lines = tableLines(chunk);
        if (lines.length) blocks.push({ kind: 't', lines: lines, headRows: lines.headRows || 0 });
      } else {
        var text = paraText(chunk);
        if (!text) continue;
        blocks.push({ kind: 'p', level: headingLevel(chunk) || pseudoHeadingLevel(chunk, text), text: text, bullet: chunk.indexOf('<w:numPr>') !== -1 });
      }
    }
    return blocks;
  }

  // Groups blocks into sections under the heading path ("Cost > Budget > Labor").
  // With withRanges, each section also says which blocks of the document it covers:
  //   range: { head: index of its heading block (or -1), refs: [[block, line], ...] }
  // The viewer uses that to highlight the section in the original file. Stored sections don't carry it.
  function docxSections(xml, withRanges) {
    var blocks = docxBlocks(xml), sections = [], path = [], cur = null;
    function open(title, head) { cur = { title: title, lines: [], head: head == null ? -1 : head, refs: [] }; sections.push(cur); }
    function pathTitle() { return path.filter(Boolean).join(' > ') || 'Document'; }
    open('Document');
    blocks.forEach(function (b, bi) {
      if (b.kind === 'p' && b.level > 0 && b.level <= 4) {
        path = path.slice(0, b.level - 1);
        while (path.length < b.level - 1) path.push('');
        path[b.level - 1] = b.text;
        if (cur && !cur.lines.length) sections.pop();       // an empty heading followed by another heading
        open(pathTitle(), bi);
        return;
      }
      var lines = b.kind === 't' ? b.lines : [(b.bullet ? '- ' : '') + b.text];
      lines.forEach(function (ln, li) {
        // split an over-long section at a line boundary
        if (words(cur.lines.join(' ')) + words(ln) > TARGET_WORDS && cur.lines.length) {
          var t = cur.title.replace(/ \(part \d+\)$/, '');
          var n = (/ \(part (\d+)\)$/.exec(cur.title) || [0, 1])[1];
          open(t + ' (part ' + (+n + 1) + ')');
        }
        cur.lines.push(ln);
        cur.refs.push([bi, li]);
      });
    });
    return finish(sections, withRanges);
  }

  // Sheets: groups of rows, each row "Header: value | Header: value".
  function sheetSections(sheets) {
    var sections = [];
    (sheets || []).forEach(function (sh) {
      var rows = (sh.rows || []).filter(function (r) { return r && r.some(function (c) { return String(c == null ? '' : c).trim() !== ''; }); });
      if (!rows.length) return;
      // header = first row whose cells are mostly text and that has >= 2 filled cells
      var hIdx = 0;
      for (var i = 0; i < Math.min(rows.length, 8); i++) {
        var filled = rows[i].filter(function (c) { return String(c == null ? '' : c).trim() !== ''; });
        if (filled.length >= 2 && filled.every(function (c) { return isNaN(Number(c)); }) && new Set(filled.map(String)).size === filled.length) { hIdx = i; break; }
      }
      var head = rows[hIdx].map(function (c) { return String(c == null ? '' : c).replace(/\s+/g, ' ').trim(); });
      // title rows above the header (merged cells repeat their text in every column: keep each once)
      var pre = rows.slice(0, hIdx).map(function (r) {
        var seen = {};
        return r.map(function (c) { return String(c == null ? '' : c).trim(); }).filter(function (c) { if (!c || seen[c]) return false; seen[c] = true; return true; }).join(' ');
      }).filter(Boolean);
      var cur = { title: 'Sheet: ' + sh.name, lines: pre.slice(0, 4) }, part = 1;
      sections.push(cur);
      rows.slice(hIdx + 1).forEach(function (r) {
        var line = r.map(function (c, i) {
          var v = String(c == null ? '' : (c instanceof Date ? c.toISOString().slice(0, 10) : c)).replace(/\s+/g, ' ').trim();
          return v ? ((head[i] ? head[i] + ': ' : '') + v) : '';
        }).filter(Boolean).join(' | ');
        if (!line) return;
        if (words(cur.lines.join(' ')) + words(line) > TARGET_WORDS && cur.lines.length) {
          part++;
          cur = { title: 'Sheet: ' + sh.name + ' (part ' + part + ')', lines: [] };
          sections.push(cur);
        }
        cur.lines.push(line);
      });
    });
    return finish(sections);
  }

  function finish(raw, withRanges) {
    var out = [], chars = 0, dropped = 0;
    raw.forEach(function (s) {
      var body = s.lines.join('\n').trim();
      if (!body) return;
      var text = s.title + '\n' + body;
      if (out.length >= MAX_SECTIONS || chars + text.length > MAX_TOTAL_CHARS) { dropped++; return; }
      chars += text.length;
      var item = { title: s.title, text: text, words: words(text) };
      if (withRanges) item.range = { head: s.head == null ? -1 : s.head, refs: s.refs || [] };
      out.push(item);
    });
    if (dropped) out.truncated = dropped;
    return out;
  }

  // "25-PowerMgmt - Risk Register v 1.0.xlsx" -> { number:'25', title:'Risk Register', version:'1.0', ext:'xlsx' }
  function parseFileName(name) {
    var base = String(name || '').split(/[\\/]/).pop();
    var ext = ((/\.([A-Za-z0-9]+)$/.exec(base) || [])[1] || '').toLowerCase();
    var stem = base.replace(/\.[A-Za-z0-9]+$/, '').trim();
    var number = '';
    var m = /^(\d+(?:\.\d+)?)\s*[-_ ]\s*/.exec(stem);
    if (m) { number = m[1]; stem = stem.slice(m[0].length); }
    var version = '';
    var v = /\s+v\s*(\d+(?:\.\d+)?)\s*$/i.exec(stem);
    if (v) { version = v[1]; stem = stem.slice(0, v.index); }
    stem = stem.replace(/^[A-Za-z]*Mgmt\s*-\s*/i, '').replace(/^\s*[-_]\s*/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    return { number: number, title: stem || base, version: version, ext: ext };
  }

  var PHASES = ['Pre-work', 'Initiation', 'Planning', 'Execution', 'Closing'];
  function phaseFromPath(path) {
    var segs = String(path || '').split(/[\\/]/);
    for (var i = segs.length - 2; i >= 0; i--) {
      for (var p = 0; p < PHASES.length; p++) { if (segs[i].toLowerCase() === PHASES[p].toLowerCase()) return PHASES[p]; }
    }
    return '';
  }

  var api = { docxSections: docxSections, docxBlocks: docxBlocks, sheetSections: sheetSections, parseFileName: parseFileName, phaseFromPath: phaseFromPath, PHASES: PHASES, words: words };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.drDocText = api;
})(typeof window !== 'undefined' ? window : this);
