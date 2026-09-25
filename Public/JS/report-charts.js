/* ============================================================================
   report-charts.js — the four graphs in the Status Report's executive summary,
   drawn straight onto a canvas (no chart library) and returned as PNGs for the PDF.

     progress    time elapsed vs tasks completed (vs budget consumed), with a marker
                 showing where the calendar says the project should be
     budget      approved budget, spend to date, forecast at completion
     exposure    open risks / issues / defects by severity (stacked, numbers in the bars)
     milestones  complete / on track / due within 30 days / late, as a ring with a legend

   Every value is labelled directly and severity/status is never colour-only (each
   colour has a text label), so a printed black-and-white copy still reads. The title and
   the explanatory caption are set by the PDF itself (crisp text); these images hold only
   the graphic. Each function returns { dataUrl, w, h } (w/h in CSS px; the PNG is 2x).
   ============================================================================ */

(function (root) {
  'use strict';

  var FONT = 'Helvetica, Arial, sans-serif';
  var C = { ink: '#1c2733', muted: '#5a6b7d', track: '#e6eaef', grid: '#c9d2dc', blue: '#0056b3', gold: '#c9a45c', slate: '#6b7c93',
            // the portal's own palette (dr-rag.css / severity badges): red, amber, green, and grey for done
            red: '#dd3333', amber: '#e0a800', green: '#2f9e44', done: '#8a8a8a' };
  var SCALE = 2;

  function make(w, h) {
    var cv = document.createElement('canvas');
    cv.width = w * SCALE; cv.height = h * SCALE;
    var ctx = cv.getContext('2d');
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = 'alphabetic';
    return { cv: cv, ctx: ctx, w: w, h: h };
  }
  function done(o) { return { dataUrl: o.cv.toDataURL('image/png'), w: o.w, h: o.h }; }
  function font(ctx, size, weight) { ctx.font = (weight || 'normal') + ' ' + size + 'px ' + FONT; }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  // Word-wrap to maxW; returns lines.
  function wrap(ctx, text, maxW) {
    var words = String(text).split(/\s+/), lines = [], cur = '';
    words.forEach(function (w) {
      var t = cur ? cur + ' ' + w : w;
      if (cur && ctx.measureText(t).width > maxW) { lines.push(cur); cur = w; } else cur = t;
    });
    if (cur) lines.push(cur);
    return lines;
  }
  function money(n) {
    var a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return s + '$' + Math.round(a);
  }
  function noData(o, msg) {
    font(o.ctx, 13); o.ctx.fillStyle = C.muted; o.ctx.textAlign = 'center';
    o.ctx.fillText(msg || 'No data available', o.w / 2, o.h / 2); o.ctx.textAlign = 'left';
  }

  // ---- 1. progress: horizontal bars on a 0-100% track
  // d: { rows: [{ label, pct, color }], markerPct, markerNote }
  function progress(d) {
    var rows = (d.rows || []).filter(function (r) { return r.pct != null && !isNaN(r.pct); });
    var W = 520, rowH = 58, top = 14, H = top + rows.length * rowH + (d.markerNote ? 30 : 12);
    var o = make(W, H), ctx = o.ctx;
    if (!rows.length) { noData(o); return done(o); }
    var x0 = 14, x1 = W - 14, bw = x1 - x0;
    rows.forEach(function (r, i) {
      var y = top + i * rowH, p = Math.max(0, Math.min(100, r.pct));
      font(ctx, 13, 'bold'); ctx.fillStyle = C.ink; ctx.fillText(r.label, x0, y + 12);
      var ty = y + 22, th = 20;
      ctx.fillStyle = C.track; roundRect(ctx, x0, ty, bw, th, 4); ctx.fill();
      if (p > 0) { ctx.fillStyle = r.color || C.blue; roundRect(ctx, x0, ty, Math.max(bw * p / 100, 8), th, 4); ctx.fill(); }
      var txt = Math.round(r.pct) + '%';
      font(ctx, 13, 'bold');
      var tw = ctx.measureText(txt).width, fillEnd = x0 + bw * p / 100;
      if (fillEnd - x0 > tw + 16) { ctx.fillStyle = '#ffffff'; ctx.fillText(txt, fillEnd - tw - 8, ty + 15); }
      else { ctx.fillStyle = C.ink; ctx.fillText(txt, Math.min(fillEnd + 8, x1 - tw), ty + 15); }
    });
    if (d.markerPct != null && !isNaN(d.markerPct)) {
      var mx = x0 + bw * Math.max(0, Math.min(100, d.markerPct)) / 100;
      ctx.save(); ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(mx, top + 16); ctx.lineTo(mx, top + rows.length * rowH - 6); ctx.stroke(); ctx.restore();
      if (d.markerNote) { font(ctx, 11); ctx.fillStyle = C.muted; ctx.fillText(d.markerNote, x0, H - 10); }
    }
    return done(o);
  }

  // ---- 2. budget: vertical bars + a dashed line at the approved budget
  // d: { bac, actual, eac }   (numbers; any may be null)
  function budget(d) {
    var bars = [
      { label: 'Approved budget', v: d.bac, color: C.slate },
      { label: 'Spent to date', v: d.actual, color: C.blue },
      { label: 'Forecast at completion', v: d.eac, color: (d.eac != null && d.bac != null && d.eac > d.bac) ? C.red : C.green }
    ].filter(function (b) { return b.v != null && !isNaN(b.v); });
    var W = 520, H = 250, o = make(W, H), ctx = o.ctx;
    if (!bars.length) { noData(o); return done(o); }
    var max = Math.max.apply(null, bars.map(function (b) { return b.v; })) * 1.18 || 1;
    var base = 196, ph = 150, slot = (W - 40) / 3, bwid = Math.min(78, slot * 0.6);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(20, base + 0.5); ctx.lineTo(W - 20, base + 0.5); ctx.stroke();
    if (d.bac != null && !isNaN(d.bac)) {
      var y = base - ph * d.bac / max;
      ctx.save(); ctx.strokeStyle = C.ink; ctx.lineWidth = 1.2; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(W - 20, y); ctx.stroke(); ctx.restore();
    }
    var barsAt = ['Approved budget', 'Spent to date', 'Forecast at completion'];
    bars.forEach(function (b) {
      var i = barsAt.indexOf(b.label), cx = 20 + slot * i + slot / 2;
      var h = Math.max(2, ph * b.v / max);
      ctx.fillStyle = b.color;
      roundRect(ctx, cx - bwid / 2, base - h, bwid, h, 4); ctx.fill();
      ctx.fillRect(cx - bwid / 2, base - Math.min(h, 4), bwid, Math.min(h, 4));   // square baseline end
      font(ctx, 15, 'bold'); ctx.textAlign = 'center';
      ctx.lineWidth = 5; ctx.strokeStyle = '#ffffff'; ctx.strokeText(money(b.v), cx, base - h - 8);   // halo: stays legible over the dashed budget line
      ctx.fillStyle = C.ink; ctx.fillText(money(b.v), cx, base - h - 8);
      font(ctx, 12); ctx.fillStyle = C.muted;
      wrap(ctx, b.label, slot - 14).forEach(function (ln, k) { ctx.fillText(ln, cx, base + 18 + k * 14); });
      ctx.textAlign = 'left';
    });
    return done(o);
  }

  // ---- 3. exposure: stacked horizontal bars
  // d: { rows: [{ label, high, medium, low }] }
  function exposure(d) {
    var rows = (d.rows || []).filter(function (r) { return r && (r.high + r.medium + r.low) >= 0; });
    var W = 520, rowH = 50, top = 10, H = top + rows.length * rowH + 40;
    var o = make(W, H), ctx = o.ctx;
    if (!rows.length) { noData(o); return done(o); }
    var labelW = 96, x0 = 14 + labelW, right = 64, bw = W - x0 - right;
    var max = Math.max.apply(null, rows.map(function (r) { return r.high + r.medium + r.low; }).concat([1]));
    var segs = [['high', 'High', C.red], ['medium', 'Medium', C.amber], ['low', 'Low', C.green]];
    rows.forEach(function (r, i) {
      var y = top + i * rowH, total = r.high + r.medium + r.low, x = x0, bh = 26;
      font(ctx, 13, 'bold'); ctx.fillStyle = C.ink;
      ctx.fillText(r.label, 14, y + 18);
      if (!total) { ctx.fillStyle = C.track; roundRect(ctx, x0, y, bw * 0.02 + 6, bh, 4); ctx.fill(); }
      segs.forEach(function (s) {
        var n = r[s[0]]; if (!n) return;
        var w = bw * n / max;
        ctx.fillStyle = s[2]; ctx.fillRect(x, y, Math.max(w - 2, 2), bh);      // 2px gap between segments
        if (w >= 20) { font(ctx, 13, 'bold'); ctx.fillStyle = s[0] === 'medium' ? '#1c2733' : '#ffffff'; ctx.textAlign = 'center'; ctx.fillText(String(n), x + (w - 2) / 2, y + 18); ctx.textAlign = 'left'; }
        x += w;
      });
      font(ctx, 13); ctx.fillStyle = C.ink; ctx.fillText(total + ' open', W - right + 10, y + 18);
    });
    var ly = top + rows.length * rowH + 14, lx = x0;
    segs.forEach(function (s) {
      ctx.fillStyle = s[2]; ctx.fillRect(lx, ly - 10, 12, 12);
      font(ctx, 12); ctx.fillStyle = C.ink; ctx.fillText(s[1], lx + 18, ly);
      lx += 18 + ctx.measureText(s[1]).width + 22;
    });
    return done(o);
  }

  // ---- 4. milestones: ring + legend
  // d: { complete, onTrack, dueSoon, late }
  function milestones(d) {
    var parts = [
      { label: 'Complete', v: d.complete || 0, color: C.done },
      { label: 'On track', v: d.onTrack || 0, color: C.green },
      { label: 'Due within 30 days', v: d.dueSoon || 0, color: C.amber },
      { label: 'Late', v: d.late || 0, color: C.red }
    ];
    var total = parts.reduce(function (t, p) { return t + p.v; }, 0);
    var W = 520, H = 220, o = make(W, H), ctx = o.ctx;
    if (!total) { noData(o); return done(o); }
    var cx = 120, cy = 110, R = 84, r = 52, a = -Math.PI / 2;
    parts.forEach(function (p) {
      if (!p.v) return;
      var da = 2 * Math.PI * p.v / total;
      ctx.beginPath(); ctx.arc(cx, cy, R, a, a + da); ctx.arc(cx, cy, r, a + da, a, true); ctx.closePath();
      ctx.fillStyle = p.color; ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
      a += da;
    });
    ctx.textAlign = 'center';
    font(ctx, 28, 'bold'); ctx.fillStyle = C.ink; ctx.fillText(String(total), cx, cy + 6);
    font(ctx, 12); ctx.fillStyle = C.muted; ctx.fillText('milestones', cx, cy + 24);
    ctx.textAlign = 'left';
    var lx = 250, ly = 58;
    parts.forEach(function (p, i) {
      var y = ly + i * 40;
      ctx.fillStyle = p.color; roundRect(ctx, lx, y - 12, 16, 16, 3); ctx.fill();
      font(ctx, 20, 'bold'); ctx.fillStyle = C.ink; ctx.fillText(String(p.v), lx + 28, y + 3);
      font(ctx, 13); ctx.fillStyle = C.ink; ctx.fillText(p.label, lx + 28 + 40, y + 2);
    });
    return done(o);
  }

  // ---- 5. burndown: remaining work over time — ideal (dashed) vs. actual (solid), same two lines
  // and colours as the live dashboard chart (burndown.js), so the two never disagree.
  // d: { labels: [str...], ideal: [num...], actual: [num|null...], unit: 'tasks remaining' }
  function burndown(d) {
    var labels = d.labels || [], ideal = d.ideal || [], actual = d.actual || [];
    var n = labels.length;
    var W = 520, H = 250, o = make(W, H), ctx = o.ctx;
    if (n < 2) { noData(o); return done(o); }
    var top = 26, bottom = H - 56, left = 34, right = W - 14, pw = right - left, ph = bottom - top;
    var vals = ideal.concat(actual).filter(function (v) { return v != null && !isNaN(v); });
    var max = Math.max.apply(null, vals.concat([1])) * 1.15;
    function xAt(i) { return left + (n > 1 ? pw * i / (n - 1) : 0); }
    function yAt(v) { return bottom - ph * Math.max(0, v) / max; }

    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, bottom + 0.5); ctx.lineTo(right, bottom + 0.5); ctx.stroke();

    var todayIdx = -1;
    for (var i = actual.length - 1; i >= 0; i--) { if (actual[i] != null) { todayIdx = i; break; } }
    if (todayIdx >= 0 && todayIdx < n - 1) {
      var mx = xAt(todayIdx);
      ctx.save(); ctx.strokeStyle = C.ink; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(mx, top); ctx.lineTo(mx, bottom); ctx.stroke(); ctx.restore();
      font(ctx, 10); ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.fillText('Today', mx, top - 10); ctx.textAlign = 'left';
    }

    function drawSeries(vals2, color, dash, width) {
      var started = false;
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      vals2.forEach(function (v, i) {
        if (v == null || isNaN(v)) { started = false; return; }
        var x = xAt(i), y = yAt(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke(); ctx.restore();
    }
    drawSeries(ideal, '#4a3aa7', [5, 4], 2);
    drawSeries(actual, C.red, null, 2.4);
    if (todayIdx >= 0) {
      ctx.fillStyle = C.red; ctx.beginPath(); ctx.arc(xAt(todayIdx), yAt(actual[todayIdx]), 3.2, 0, 2 * Math.PI); ctx.fill();
    }

    var tickCount = Math.min(5, n), idxs = [];
    for (var k = 0; k < tickCount; k++) { var ix = Math.round(k * (n - 1) / (tickCount - 1 || 1)); if (idxs.indexOf(ix) === -1) idxs.push(ix); }
    font(ctx, 10); ctx.fillStyle = C.muted;
    // First/last tick labels are pinned to the plot edges — centering them there would run the
    // label off the canvas, so they align outward (left-edge label left-aligned, right-edge right-aligned)
    // while interior ticks stay centered on their point.
    idxs.forEach(function (ix, k2) {
      ctx.textAlign = k2 === 0 ? 'left' : (k2 === idxs.length - 1 ? 'right' : 'center');
      ctx.fillText(labels[ix], xAt(ix), bottom + 16);
    });
    ctx.textAlign = 'left';
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(max)), left - 6, top + 10);
    ctx.fillText('0', left - 6, bottom + 4);
    ctx.textAlign = 'left';
    if (d.unit) { font(ctx, 10); ctx.fillStyle = C.muted; ctx.fillText(d.unit, left, 14); }

    var ly = H - 12, lx = left;
    [['Ideal', '#4a3aa7'], ['Actual (approximate)', C.red]].forEach(function (s) {
      ctx.fillStyle = s[1]; ctx.fillRect(lx, ly - 9, 14, 3);
      font(ctx, 11); ctx.fillStyle = C.ink; ctx.fillText(s[0], lx + 20, ly - 5);
      lx += 20 + ctx.measureText(s[0]).width + 22;
    });
    return done(o);
  }

  root.drReportCharts = { progress: progress, budget: budget, exposure: exposure, milestones: milestones, burndown: burndown, money: money };
})(typeof window !== 'undefined' ? window : this);
