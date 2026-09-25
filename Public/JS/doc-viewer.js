/* ============================================================================
   Document viewer — a side panel that opens the ORIGINAL project document a
   fact came from and highlights the whole section it was found in.

   How it finds the section: the AI's source carries the document id and the
   section's position. The file is fetched from Storage (Storage rules already
   limit it to the roles the document is shared with), re-read with the same
   extractor used at import (doc-text.js) so position N is the same section, and
   — for Word files — drawn with docx-preview. Each extracted block of text is then
   matched, in order, to the block drawn on screen, so a section becomes a run of
   highlighted paragraphs / table rows. Spreadsheets (and any Word file that can't
   be lined up) get the plain Text tab, with the section highlighted there.

   Pure parts (align / plan) are exported for tests: window.drDocViewerInternals.
   ============================================================================ */

(function (root) {
  'use strict';

  var JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
  var DOCX_PREVIEW_URL = 'https://cdn.jsdelivr.net/npm/docx-preview@0.3.3/dist/docx-preview.min.js';
  var LOOKAHEAD = 12;

  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

  // blocks: doc-text docxBlocks() output. cands: what is on screen, in order: [{ tag, text }].
  // Returns, per block, the index of the on-screen candidate it matches (or -1). Forward-only, so
  // a block that isn't drawn (or a marker like a list number) never derails the ones after it.
  function align(blocks, cands) {
    var map = [], cur = 0;
    blocks.forEach(function (b) {
      var found = -1, bt = norm(b.text);
      for (var j = cur; j < Math.min(cands.length, cur + LOOKAHEAD); j++) {
        var c = cands[j];
        if (b.kind === 't') { if (c.tag === 'TABLE') { found = j; break; } continue; }
        if (c.tag === 'TABLE') continue;
        var ct = norm(c.text);
        // drawn text may carry a generated list number / bullet in front
        if (ct === bt || (bt && ct.indexOf(bt) !== -1 && ct.length - bt.length <= 14)) { found = j; break; }
      }
      map.push(found);
      if (found >= 0) cur = found + 1;
    });
    return map;
  }

  // range: { head, refs:[[block,line]] } from docxSections(xml, true). -> [{ cand, rows|null }]
  // rows null = the whole drawn block; otherwise the table rows (0-based, empty rows not counted).
  function plan(range, blocks, map) {
    var items = [], byBlock = {};
    if (!range) return items;
    if (range.head >= 0 && map[range.head] >= 0) items.push({ cand: map[range.head], rows: null });
    (range.refs || []).forEach(function (r) {
      var bi = r[0], li = r[1];
      if (!byBlock[bi]) byBlock[bi] = [];
      byBlock[bi].push(li);
    });
    Object.keys(byBlock).map(Number).sort(function (a, b) { return a - b; }).forEach(function (bi) {
      var b = blocks[bi], cand = map[bi];
      if (!b || cand < 0) return;
      if (b.kind !== 't') { items.push({ cand: cand, rows: null }); return; }
      var lines = byBlock[bi];
      if (lines.length >= b.lines.length) { items.push({ cand: cand, rows: null }); return; }
      items.push({ cand: cand, rows: lines.map(function (l) { return l + (b.headRows || 0); }) });
    });
    return items;
  }

  // The section a source points at: by position when the title agrees, else by title.
  function resolveSection(sections, src) {
    var i = src.sectionIndex;
    if (sections[i] && sections[i].title === src.sectionTitle) return i;
    for (var k = 0; k < sections.length; k++) if (sections[k].title === src.sectionTitle) return k;
    return -1;
  }

  root.drDocViewerInternals = { align: align, plan: plan, resolveSection: resolveSection, norm: norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.drDocViewerInternals;
  if (typeof document === 'undefined') return;

  // ---------------------------------------------------------------- browser part
  var ns = '[doc-viewer]';
  var el = null, state = null, loadToken = 0;

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function loadScript(url, test) {
    if (test()) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load the document reader — check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }
  function loadJsZip() { return loadScript(JSZIP_URL, function () { return !!root.JSZip; }); }

  function ensure() {
    if (el) return el;
    el = document.createElement('aside');
    el.id = 'drDocViewer'; el.className = 'dv'; el.setAttribute('aria-hidden', 'true');
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Project document');
    el.innerHTML =
      '<div class="dv-head"><div class="dv-title"></div><button type="button" class="dv-close" aria-label="Close document">&times;</button></div>' +
      '<div class="dv-srcs"></div>' +
      '<div class="dv-tabs"><button type="button" data-tab="fmt" class="is-on">Document</button><button type="button" data-tab="txt">Text</button></div>' +
      '<div class="dv-note" role="status"></div>' +
      '<div class="dv-body"><div class="dv-fmt"></div><div class="dv-txt" hidden></div></div>';
    document.body.appendChild(el);
    el.querySelector('.dv-close').addEventListener('click', close);
    el.querySelectorAll('.dv-tabs button').forEach(function (b) {
      b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
    });
    // Escape closes this panel first, leaving the Ask window open behind it
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && el.classList.contains('is-open')) { e.stopImmediatePropagation(); close(); }
    }, true);
    return el;
  }

  function close() {
    if (!el) return;
    el.classList.remove('is-open'); el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('dr-viewer-open');
  }

  function showTab(t) {
    el.querySelectorAll('.dv-tabs button').forEach(function (b) { b.classList.toggle('is-on', b.getAttribute('data-tab') === t); });
    el.querySelector('.dv-fmt').hidden = t !== 'fmt';
    el.querySelector('.dv-txt').hidden = t !== 'txt';
    if (t === 'txt') { var h = el.querySelector('.dv-txt .dv-hit'); if (h) h.scrollIntoView({ block: 'start' }); }
    else { var f = el.querySelector('.dv-fmt .dv-hl'); if (f) f.scrollIntoView({ block: 'start' }); }
  }
  function note(t, warn) { var n = el.querySelector('.dv-note'); n.textContent = t || ''; n.className = 'dv-note' + (warn ? ' is-warn' : ''); n.style.display = t ? '' : 'none'; }

  function storagePath(docId) { return 'documents/' + root.BIZ_KEY + '/' + (root.PROJECT_KEY || 'default') + '/' + docId; }
  // path: an explicit Storage path (Project Documents' File Manager / private-share rows, which
  // don't live under the documents/ prefix) — falls back to the Document Register convention above
  // when omitted, so every existing Ask-the-Project caller is unaffected.
  function fetchOriginal(path) {
    return root.firebase.storage().ref().child(path).getDownloadURL()
      .then(function (url) { return fetch(url); })
      .then(function (res) { if (!res.ok) throw new Error('The document could not be opened (HTTP ' + res.status + ').'); return res.arrayBuffer(); });
  }

  // Parse the original into { kind, sections, blocks?, buffer }.
  function parse(src, buffer) {
    var T = root.drDocText, ext = String(src.ext || '').toLowerCase();
    if (ext === 'docx') {
      return loadJsZip().then(function () { return root.JSZip.loadAsync(buffer); }).then(function (zip) {
        var f = zip.file('word/document.xml');
        return (f ? f.async('string') : Promise.resolve('')).then(function (xml) {
          return { kind: 'docx', sections: T.docxSections(xml, true), blocks: T.docxBlocks(xml), buffer: buffer };
        });
      });
    }
    if (!root.XLSX) return Promise.reject(new Error('The spreadsheet reader has not loaded yet — try again in a moment.'));
    var wb = root.XLSX.read(buffer, { type: 'array' });
    var sheets = wb.SheetNames.map(function (n) { return { name: n, rows: root.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) }; });
    return Promise.resolve({ kind: 'sheets', sections: T.sheetSections(sheets), buffer: buffer });
  }

  function renderText(doc, hit) {
    var box = el.querySelector('.dv-txt');
    box.innerHTML = doc.sections.map(function (s, i) {
      return '<div class="dv-sec' + (i === hit ? ' dv-hit' : '') + '"><div class="dv-sec-t">' + esc(s.title) + '</div><div class="dv-sec-b">' + esc(s.text.split('\n').slice(1).join('\n')) + '</div></div>';
    }).join('');
  }

  // Draw the Word file and remember what each drawn block is.
  function renderFormatted(doc) {
    var box = el.querySelector('.dv-fmt');
    box.innerHTML = '';
    return loadJsZip().then(function () { return loadScript(DOCX_PREVIEW_URL, function () { return !!root.docx; }); }).then(function () {
      return root.docx.renderAsync(doc.buffer, box, null, { inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true, renderHeaders: false, renderFooters: false, renderFootnotes: false, renderEndnotes: false });
    }).then(function () {
      var nodes = [];
      box.querySelectorAll('section > article').forEach(function (art) {
        Array.prototype.forEach.call(art.children, function (c) {
          if (c.tagName === 'TABLE' || norm(c.textContent)) nodes.push(c);
        });
      });
      doc.nodes = nodes;
      doc.map = align(doc.blocks, nodes.map(function (n) { return { tag: n.tagName, text: n.textContent }; }));
      // the drawn page is wider than the panel: scale it down to fit
      var page = box.querySelector('section');
      if (page && page.offsetWidth) box.firstElementChild.style.zoom = Math.min(1, (box.clientWidth - 4) / (page.offsetWidth + 24));
    });
  }

  // Highlight section `idx`. Returns how many blocks were marked.
  function highlight(doc, idx) {
    el.querySelectorAll('.dv-fmt .dv-hl').forEach(function (n) { n.classList.remove('dv-hl'); });
    if (doc.kind !== 'docx' || !doc.nodes || idx < 0) return 0;
    var items = plan(doc.sections[idx].range, doc.blocks, doc.map), marked = 0;
    items.forEach(function (it) {
      var node = doc.nodes[it.cand];
      if (!node) return;
      if (it.rows === null) { node.classList.add('dv-hl'); marked++; return; }
      var trs = Array.prototype.filter.call(node.querySelectorAll('tr'), function (tr) { return norm(tr.textContent); });
      it.rows.forEach(function (r) { if (trs[r]) { trs[r].classList.add('dv-hl'); marked++; } });
    });
    return marked;
  }

  function show(src) {
    var doc = state.doc, token = state.token;
    var idx = resolveSection(doc.sections, src);
    renderText(doc, idx);
    var marked = 0;
    if (doc.kind === 'docx') { try { marked = highlight(doc, idx); } catch (e) { console.warn(ns, 'highlight failed', e); } }
    el.querySelector('.dv-tabs').style.display = doc.kind === 'docx' ? '' : 'none';
    if (token !== state.token) return;
    if (idx < 0) {
      // A plain "View" click (no citation to pinpoint) is expected to land here every time —
      // the "changed since the answer" copy only makes sense when there WAS a specific answer.
      if (src.standalone) note('', false);
      else note('This document has been changed since the answer was written, so the exact section could not be found. It is shown from the top.', true);
      showTab(doc.kind === 'docx' ? 'fmt' : 'txt');
    } else if (doc.kind === 'docx' && marked) {
      note('Highlighted: ' + doc.sections[idx].title, false);
      showTab('fmt');
    } else {
      note(doc.kind === 'docx' ? 'The section could not be pinpointed in the formatted page, so it is shown in the Text view.' : 'Highlighted: ' + doc.sections[idx].title, doc.kind === 'docx');
      showTab('txt');
    }
  }

  function drawSourceChips(list, current) {
    var box = el.querySelector('.dv-srcs');
    if (!list || list.length < 2) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = '';
    box.innerHTML = '<span class="dv-srcs-l">Sources in this answer:</span>' + list.map(function (s) {
      return '<button type="button" class="dv-chip' + (s === current ? ' is-on' : '') + '" data-n="' + esc(s.n) + '" title="' + esc(s.label) + '">[' + esc(s.n) + ']</button>';
    }).join('');
    box.querySelectorAll('.dv-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = list.filter(function (x) { return String(x.n) === b.getAttribute('data-n'); })[0];
        if (s) open(s, list);
      });
    });
  }

  // src: an askProject source ({ docId, docLabel, ext, sectionIndex, sectionTitle, n }), or a plain
  // { docId, docLabel, ext, storagePath, standalone: true } from Project Documents' "View" button —
  // storagePath overrides the default documents/ convention; list: the answer's document sources (omit for a plain view).
  function open(src, list) {
    if (!src || !src.docId) return;
    ensure();
    var token = ++loadToken;
    el.querySelector('.dv-title').textContent = src.docLabel || src.docTitle || 'Document';
    drawSourceChips(list, src);
    el.classList.add('is-open'); el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('dr-viewer-open');

    // same document as last time: no need to fetch and draw again
    if (state && state.docId === src.docId && state.doc) { state.token = token; show(src); return; }

    state = { docId: src.docId, token: token, doc: null };
    el.querySelector('.dv-fmt').innerHTML = ''; el.querySelector('.dv-txt').innerHTML = '';
    note('Opening the document…', false);
    fetchOriginal(src.storagePath || storagePath(src.docId)).then(function (buf) { return parse(src, buf); }).then(function (doc) {
      if (token !== loadToken) return;
      state.doc = doc;
      return (doc.kind === 'docx' ? renderFormatted(doc) : Promise.resolve()).catch(function (e) {
        console.warn(ns, 'formatted view failed — using text view', e); doc.nodes = null;
      });
    }).then(function () {
      if (token !== loadToken || !state.doc) return;
      state.token = token; show(src);
    }).catch(function (err) {
      if (token !== loadToken) return;
      console.error(ns, 'open failed', err);
      state = null;
      note((err && err.code === 'storage/object-not-found') ? 'The original file is no longer stored.' :
        (err && err.code === 'storage/unauthorized') ? 'Your role does not have access to this document.' :
        ((err && err.message) || 'The document could not be opened.'), true);
    });
  }

  root.drDocViewer = { open: open, close: close };
})(typeof window !== 'undefined' ? window : this);
