/* ============================================================================
   docx-writer.js — a small Word (.docx) writer, so the Status Report can also be
   handed to the owner as an EDITABLE copy (same content as the PDF, real Word
   headings / tables / text the owner can change).

   No library: a .docx is a zip of a few XML files, and JSZip (already used by the
   document importer) does the zipping. Graphs are placed with Word's "Tight" text
   wrapping (wp:wrapTight with a rectangular wrap polygon, exactly as Word writes
   it), so the explanation beside a graph flows around it like the PDF does.

     var b = drDocx.builder({ footer: 'Confidential ...', footerLogo: img });
     b.cover({ title, lines, logoLeft, logoRight });
     b.heading('Text', 1|2);  b.para('Text' | runs, { size, bold, italic, color, before, after });
     b.bullets([text | runs, ...]);  b.tabRow(n, title, textOrRuns);
     b.table({ head, body, widths, cellRuns });  b.kpis([{label,value,sub,valueFill}]);
     b.figure({ img, title, widthIn, paras:[{ label, text|runs, style }] });  b.pageBreak();
     b.build(JSZip).then(function (blob) {...});

   runs = [{ t, bold, italic, color, fill, size }] — coloured / highlighted words.
   Images are { dataUrl, w, h } (PNG). Everything is escaped; control characters are
   dropped. Paragraphs use widow/orphan control and headings keep with what follows.
   build() is pure XML assembly, so it can be checked in Node.
   ============================================================================ */

(function (root) {
  'use strict';

  var NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  var NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
  var NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  var NS_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
  var EMU_PER_IN = 914400;
  var TEXT_W = 9638;                   // A4 with 2 cm margins, in twips
  var GOLD = 'C9A45C', NAVY = '0B2545', GRAY = '5A6B7D';
  var TAB_COL = 3500;                  // where the second column of an aligned row starts (twips)

  function esc(s) {
    var str = String(s == null ? '' : s), out = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i), ch = str.charAt(i);
      if (c < 32 && c !== 9 && c !== 10) continue;                 // drop control characters (invalid in XML)
      out += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch;
    }
    return out;
  }

  // ---- runs and paragraphs
  function rPr(o) {
    o = o || {};
    var x = '';
    if (o.font) x += '<w:rFonts w:ascii="' + o.font + '" w:hAnsi="' + o.font + '" w:cs="' + o.font + '"/>';
    if (o.bold) x += '<w:b/><w:bCs/>';
    if (o.italic) x += '<w:i/><w:iCs/>';
    if (o.color) x += '<w:color w:val="' + o.color + '"/>';
    if (o.size) x += '<w:sz w:val="' + Math.round(o.size * 2) + '"/><w:szCs w:val="' + Math.round(o.size * 2) + '"/>';
    if (o.fill) x += '<w:shd w:val="clear" w:color="auto" w:fill="' + o.fill + '"/>';
    return x ? '<w:rPr>' + x + '</w:rPr>' : '';
  }
  function run(text, o) {
    var parts = String(text == null ? '' : text).split('\n'), x = '';
    parts.forEach(function (p, i) {
      if (i) x += '<w:r>' + rPr(o) + '<w:br/></w:r>';
      x += '<w:r>' + rPr(o) + '<w:t xml:space="preserve">' + esc(p) + '</w:t></w:r>';
    });
    return x;
  }
  // text | [runs] -> run XML; base = defaults for every run
  function runsXml(content, base) {
    base = base || {};
    if (Array.isArray(content)) {
      return content.map(function (r) {
        return run(r.t, { bold: r.bold != null ? r.bold : base.bold, italic: r.italic != null ? r.italic : base.italic, color: r.color || base.color, fill: r.fill, size: r.size || base.size });
      }).join('');
    }
    return run(content, base);
  }
  function pPr(o) {
    o = o || {};
    var x = '';
    if (o.style) x += '<w:pStyle w:val="' + o.style + '"/>';
    if (o.keepNext) x += '<w:keepNext/>';
    if (o.keepLines) x += '<w:keepLines/>';
    if (o.tabs) x += '<w:tabs>' + o.tabs.map(function (t) { return '<w:tab w:val="' + t.val + '" w:pos="' + t.pos + '"/>'; }).join('') + '</w:tabs>';
    if (o.shade) x += '<w:shd w:val="clear" w:color="auto" w:fill="' + o.shade + '"/>';
    if (o.before != null || o.after != null || o.line) {
      x += '<w:spacing' + (o.before != null ? ' w:before="' + o.before + '"' : '') + (o.after != null ? ' w:after="' + o.after + '"' : '') +
        (o.line ? ' w:line="' + o.line + '" w:lineRule="' + (o.lineRule || 'auto') + '"' : '') + '/>';
    }
    if (o.left != null || o.hanging != null) x += '<w:ind' + (o.left != null ? ' w:left="' + o.left + '"' : '') + (o.hanging != null ? ' w:hanging="' + o.hanging + '"' : '') + '/>';
    if (o.align) x += '<w:jc w:val="' + o.align + '"/>';
    return x ? '<w:pPr>' + x + '</w:pPr>' : '';
  }
  function para(inner, o) { return '<w:p>' + pPr(o) + inner + '</w:p>'; }

  function builder(opts) {
    opts = opts || {};
    var body = [], media = [], nextId = 1, footerMedia = null;

    function addImage(img) {
      var name = 'image' + (media.length + 1) + '.png', rid = 'rIdImg' + (media.length + 1);
      media.push({ name: name, rid: rid, b64: String(img.dataUrl).replace(/^data:image\/png;base64,/, '') });
      return { name: name, rid: rid };
    }
    function pic(ref, cx, cy, id) {
      return '<a:graphic xmlns:a="' + NS_A + '"><a:graphicData uri="' + NS_PIC + '"><pic:pic xmlns:pic="' + NS_PIC + '">' +
        '<pic:nvPicPr><pic:cNvPr id="' + id + '" name="' + ref.name + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
        '<pic:blipFill><a:blip r:embed="' + ref.rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
        '</pic:pic></a:graphicData></a:graphic>';
    }
    function size(img, widthIn, maxHeightIn) {
      var w = widthIn, h = widthIn * img.h / img.w;
      if (maxHeightIn && h > maxHeightIn) { h = maxHeightIn; w = h * img.w / img.h; }
      return { cx: Math.round(w * EMU_PER_IN), cy: Math.round(h * EMU_PER_IN), hIn: h };
    }
    function inlineWith(ref, img, widthIn, maxHeightIn, alt) {
      var s = size(img, widthIn, maxHeightIn), id = nextId++;
      return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + s.cx + '" cy="' + s.cy + '"/>' +
        '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="' + id + '" name="Picture ' + id + '" descr="' + esc(alt || '') + '"/>' +
        '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="' + NS_A + '" noChangeAspect="1"/></wp:cNvGraphicFramePr>' + pic(ref, s.cx, s.cy, id) + '</wp:inline></w:drawing></w:r>';
    }
    function inlineImage(img, widthIn, maxHeightIn, alt) { return inlineWith(addImage(img), img, widthIn, maxHeightIn, alt); }
    // Floating picture, left of the text, with TIGHT wrapping (the polygon is the full rectangle, as Word writes it).
    function tightImage(img, widthIn, alt) {
      var ref = addImage(img), s = size(img, widthIn), id = nextId++;
      return { hIn: s.hIn, xml: '<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="137160" simplePos="0" relativeHeight="' + (251658240 + id) + '" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="0">' +
        '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:align>left</wp:align></wp:positionH>' +
        '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
        '<wp:extent cx="' + s.cx + '" cy="' + s.cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
        '<wp:wrapTight wrapText="bothSides"><wp:wrapPolygon edited="0"><wp:start x="0" y="0"/><wp:lineTo x="0" y="21600"/><wp:lineTo x="21600" y="21600"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="0"/></wp:wrapPolygon></wp:wrapTight>' +
        '<wp:docPr id="' + id + '" name="Chart ' + id + '" descr="' + esc(alt || '') + '"/>' +
        '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="' + NS_A + '" noChangeAspect="1"/></wp:cNvGraphicFramePr>' + pic(ref, s.cx, s.cy, id) + '</wp:anchor></w:drawing></w:r>' };
    }

    // ---- tables
    function cell(inner, widthTw, o) {
      o = o || {};
      return '<w:tc><w:tcPr><w:tcW w:w="' + widthTw + '" w:type="dxa"/>' + (o.span ? '<w:gridSpan w:val="' + o.span + '"/>' : '') +
        (o.borders === false ? '<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders>' : '') +
        (o.fill ? '<w:shd w:val="clear" w:color="auto" w:fill="' + o.fill + '"/>' : '') +
        (o.valign ? '<w:vAlign w:val="' + o.valign + '"/>' : '') + '</w:tcPr>' + (inner || '<w:p/>') + '</w:tc>';
    }
    function tblPr(borders) {
      var line = borders === false ? 'nil' : 'single';
      var b = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (k) { return '<w:' + k + ' w:val="' + line + '" w:sz="4" w:space="0" w:color="C8C8C8"/>'; }).join('');
      return '<w:tblPr><w:tblW w:w="' + TEXT_W + '" w:type="dxa"/><w:tblBorders>' + b + '</w:tblBorders><w:tblLayout w:type="fixed"/>' +
        '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>';
    }
    function widthsTw(n, pct) {
      var w = pct && pct.length === n ? pct : Array.apply(null, Array(n)).map(function () { return 100 / n; });
      var sum = w.reduce(function (t, x) { return t + x; }, 0), tw = w.map(function (x) { return Math.floor(TEXT_W * x / sum); });
      tw[tw.length - 1] += TEXT_W - tw.reduce(function (t, x) { return t + x; }, 0);
      return tw;
    }
    function grid(tw) { return '<w:tblGrid>' + tw.map(function (x) { return '<w:gridCol w:w="' + x + '"/>'; }).join('') + '</w:tblGrid>'; }

    var api = {
      cover: function (c) {
        var tw = [1900, TEXT_W - 3800, 1900];
        var left = c.logoLeft ? para(inlineImage(c.logoLeft, 1.05, 0.95, 'Distinct Revelations logo'), { align: 'left', before: 60, after: 60 }) : '<w:p/>';
        // the company logo is medium-sized beside the Distinct Revelations logo (about 80%)
        var right = c.logoRight ? para(inlineImage(c.logoRight, 0.84, 0.76, 'Company logo'), { align: 'right', before: 60, after: 60 }) : '<w:p/>';
        var mid = para(run(c.title, { size: 24, bold: true, color: GOLD }), { align: 'center', before: 60, after: 20 }) +
          (c.lines || []).map(function (ln, i) { return para(run(ln.text, { size: ln.size || 11, bold: !!ln.bold, color: ln.color || 'FFFFFF' }), { align: 'center', after: i === (c.lines.length - 1) ? 60 : 20 }); }).join('');
        body.push('<w:tbl>' + tblPr(false) + grid(tw) + '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
          cell(left, tw[0], { fill: '000000', valign: 'center', borders: false }) + cell(mid, tw[1], { fill: '000000', valign: 'center', borders: false }) +
          cell(right, tw[2], { fill: '000000', valign: 'center', borders: false }) + '</w:tr></w:tbl>' + para('', { after: 160 }));
        return api;
      },
      heading: function (text, level) { body.push(para(run(text), { style: level === 2 ? 'Heading2' : 'Heading1', keepNext: true })); return api; },
      // content: text or runs. o: { size, bold, italic, color, before, after, keepNext, keepLines, align }
      para: function (content, o) {
        o = o || {};
        body.push(para(runsXml(content, { size: o.size, bold: o.bold, italic: o.italic, color: o.color }), { after: o.after == null ? 120 : o.after, before: o.before, keepNext: o.keepNext, keepLines: o.keepLines, align: o.align }));
        return api;
      },
      // indented bullets with a hanging indent, so wrapped lines line up under the text
      bullets: function (items, o) {
        o = o || {};
        (items || []).forEach(function (t) {
          body.push(para('<w:r><w:t>•</w:t></w:r><w:r><w:tab/></w:r>' + runsXml(t, { size: o.size }), { left: 720, hanging: 300, after: 60, keepLines: true, tabs: [{ val: 'left', pos: 720 }] }));
        });
        return api;
      },
      // Aligned rows: number | title | text. A borderless table, so the text column starts in the same place on
      // every row and wrapped lines (and long titles) stay inside their own column.
      aligned: function (rows, o) {
        o = o || {};
        var size = o.size || 9.5, tw = [520, 3000, TEXT_W - 3520];
        var x = '<w:tbl>' + tblPr(false) + grid(tw);
        rows.forEach(function (r) {
          x += '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
            cell(para(run(r.n, { size: size, color: NAVY }), { after: 50 }), tw[0], { borders: false }) +
            cell(para(run(r.title, { size: size, bold: true, color: NAVY }), { after: 50 }), tw[1], { borders: false }) +
            cell(para(runsXml(r.content, { size: size }), { after: 50 }), tw[2], { borders: false }) + '</w:tr>';
        });
        body.push(x + '</w:tbl>' + para('', { after: 100 }));
        return api;
      },
      // A plain picture with a title above it — used for the small supporting exhibits inside "Key finding"
      // (the explanatory text sits in its own Exhibit guide / Implication / Suggested next steps blocks instead).
      picture: function (img, title, widthIn) {
        body.push(para(run(title, { size: 10, bold: true, color: NAVY }), { after: 60, keepNext: true }));
        body.push(para(inlineImage(img, widthIn || 3.2, null, title), { after: 140 }));
        return api;
      },
      table: function (t) {
        if (!t.head || !t.head.length) return api;
        var tw = widthsTw(t.head.length, t.widths);
        var x = '<w:tbl>' + tblPr() + grid(tw) +
          '<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>' + t.head.map(function (h, i) { return cell(para(run(h, { size: 8.5, bold: true, color: 'FFFFFF' }), { after: 0, align: t.headAlign || 'left' }), tw[i], { fill: '000000' }); }).join('') + '</w:tr>';
        (t.body || []).forEach(function (r, ri) {
          x += '<w:tr><w:trPr><w:cantSplit/></w:trPr>' + r.map(function (c, i) {
            var text = c == null || c === '' ? '—' : c;
            var custom = t.cellRuns ? t.cellRuns(text, i) : null;     // e.g. red bold for a negative figure
            var inner = custom ? runsXml(custom, { size: 8.5, bold: t.boldFirst && i === 0 }) : run(text, { size: 8.5, bold: t.boldFirst && i === 0 });
            return cell(para(inner, { after: 0 }), tw[i], { fill: ri % 2 ? 'F7F7F7' : null });
          }).join('') + '</w:tr>';
        });
        body.push(x + '</w:tbl>' + para('', { after: 100 }));
        return api;
      },
      kpis: function (items) {
        if (!items || !items.length) return api;
        var tw = widthsTw(items.length);
        var x = '<w:tbl>' + tblPr() + grid(tw) + '<w:tr><w:trPr><w:cantSplit/></w:trPr>' + items.map(function (k, i) {
          var value = run(k.value, { size: 16, bold: true, color: k.valueColor || NAVY });
          return cell(para(run(String(k.label).toUpperCase(), { size: 7.5, color: GRAY }), { after: 20 }) + para(value, { after: 20 }) +
            para(run(k.sub || '', { size: 8, color: GRAY }), { after: 0 }), tw[i], { fill: 'F4F7FB' });
        }).join('') + '</w:tr></w:tbl>';
        body.push(x + para('', { after: 140 }));
        return api;
      },
      // A graph with the explanation set beside it, wrapping tight around it.
      figure: function (f) {
        var img = tightImage(f.img, f.widthIn || 3.3, f.title);
        var first = para(img.xml + run(f.title, { size: 11, bold: true, color: NAVY }), { keepNext: true, after: 80, before: 160 });
        var rest = (f.paras || []).map(function (p) {
          var inner = (p.label ? run(p.label, { size: 9, bold: true, color: p.labelColor || NAVY }) + '<w:r><w:br/></w:r>' : '') + runsXml(p.runs || p.text, { size: 9.5, italic: !!p.italic, color: p.color || '2B3540' });
          return para(inner, { after: 110, keepLines: true });
        }).join('');
        body.push(first + rest + para('<w:r><w:br w:type="textWrapping" w:clear="all"/></w:r>', { before: 0, after: 0, line: 20, lineRule: 'exact' }));
        return api;
      },
      // A graph and its explanation in two fixed columns, so the labelled parts always line up beside it.
      chartBlock: function (f) {
        var imgLeft = f.imgLeft !== false;
        var imgW = 3900, txtW = TEXT_W - imgW;
        var tw = imgLeft ? [imgW, txtW] : [txtW, imgW];
        var img = para(inlineImage(f.img, 2.55, 3.2, f.title), { after: 0 });
        var txt = para(run(f.title, { size: 11, bold: true, color: NAVY }), { after: 80, keepNext: true }) + (f.paras || []).map(function (p) {
          return para(run(p.label, { size: 9, bold: true, color: NAVY }), { after: 10, keepNext: true }) + para(runsXml(p.runs || p.text, { size: 9.5, italic: !!p.italic, color: p.color || '2B3540' }), { after: 100 });
        }).join('');
        var cells = imgLeft ? [cell(img, tw[0], { borders: false }), cell(txt, tw[1], { borders: false })] : [cell(txt, tw[0], { borders: false }), cell(img, tw[1], { borders: false })];
        body.push('<w:tbl>' + tblPr(false) + grid(tw) + '<w:tr>' + cells.join('') + '</w:tr></w:tbl>' + para('', { after: 60 }));
        return api;
      },
      pageBreak: function () { body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'); return api; },

      // The XML parts (exposed so tests can inspect them without zipping).
      parts: function () {
        var doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="' + NS_W + '" xmlns:r="' + NS_R + '" xmlns:wp="' + NS_WP + '" xmlns:a="' + NS_A + '" xmlns:pic="' + NS_PIC + '"><w:body>' +
          body.join('') + '<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/>' +
          '<w:pgMar w:top="1134" w:right="1134" w:bottom="1247" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>';
        var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="' + NS_W + '">' +
          '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>' +
          '<w:pPrDefault><w:pPr><w:widowControl/><w:spacing w:after="120" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
          '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
          '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
          '<w:pPr><w:keepNext/><w:keepLines/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="3" w:color="' + GOLD + '"/></w:pBdr><w:spacing w:before="320" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>' +
          '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
          '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="280" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="' + NAVY + '"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>' +
          '</w:styles>';
        // footer: logo left, page information (bold) centre, confidential statement (italic) right
        var flogo = '';
        if (opts.footerLogo) {
          var fr = { name: 'footerlogo.png', rid: 'rIdFtLogo', b64: String(opts.footerLogo.dataUrl).replace(/^data:image\/png;base64,/, '') };
          footerMedia = fr;
          flogo = inlineWith(fr, opts.footerLogo, 0.5, 0.3, 'Distinct Revelations logo');
        }
        var fld = function (instr) { return '<w:fldSimple w:instr="' + instr + '"><w:r><w:rPr><w:b/><w:sz w:val="17"/><w:color w:val="333333"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>'; };
        var footer = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="' + NS_W + '" xmlns:r="' + NS_R + '" xmlns:wp="' + NS_WP + '" xmlns:a="' + NS_A + '" xmlns:pic="' + NS_PIC + '"><w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="C8C8C8"/></w:pBdr>' +
          '<w:tabs><w:tab w:val="center" w:pos="' + Math.round(TEXT_W / 2) + '"/><w:tab w:val="right" w:pos="' + TEXT_W + '"/></w:tabs></w:pPr>' +
          flogo + '<w:r><w:tab/></w:r>' + run('Page ', { size: 8.5, bold: true, color: '333333' }) + fld('PAGE') + run(' of ', { size: 8.5, bold: true, color: '333333' }) + fld('NUMPAGES') +
          '<w:r><w:tab/></w:r>' + run(opts.footer || '', { size: 8, italic: true, color: '5A6B7D' }) + '</w:p></w:ftr>';
        var footerRels = footerMedia ? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="' + footerMedia.rid + '" Type="' + NS_R + '/image" Target="media/' + footerMedia.name + '"/></Relationships>' : '';
        var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rIdStyles" Type="' + NS_R + '/styles" Target="styles.xml"/><Relationship Id="rIdFooter" Type="' + NS_R + '/footer" Target="footer1.xml"/>' +
          media.map(function (m) { return '<Relationship Id="' + m.rid + '" Type="' + NS_R + '/image" Target="media/' + m.name + '"/>'; }).join('') + '</Relationships>';
        var types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
          '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>';
        var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="' + NS_R + '/officeDocument" Target="word/document.xml"/></Relationships>';
        return { document: doc, styles: styles, footer: footer, footerRels: footerRels, footerMedia: footerMedia, rels: rels, types: types, rootRels: rootRels, media: media };
      },

      build: function (JSZip) {
        var p = api.parts(), zip = new JSZip();
        zip.file('[Content_Types].xml', p.types);
        zip.file('_rels/.rels', p.rootRels);
        zip.file('word/document.xml', p.document);
        zip.file('word/styles.xml', p.styles);
        zip.file('word/footer1.xml', p.footer);
        if (p.footerRels) zip.file('word/_rels/footer1.xml.rels', p.footerRels);
        zip.file('word/_rels/document.xml.rels', p.rels);
        p.media.forEach(function (m) { zip.file('word/media/' + m.name, m.b64, { base64: true }); });
        if (p.footerMedia) zip.file('word/media/' + p.footerMedia.name, p.footerMedia.b64, { base64: true });
        return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      }
    };
    return api;
  }

  var exported = { builder: builder, esc: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.drDocx = exported;
})(typeof window !== 'undefined' ? window : this);
