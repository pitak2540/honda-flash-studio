'use strict';
/* Honda Flash Studio Mobile — TunerPro XDF parser.
 * Parses XDF v1.x XML: tables, z-data layout (addr/size/rows/cols/endian/signed),
 * linear math equations, axis breakpoints (inline LABELs or linked tables), categories.
 * Titles are TIS-620 (Thai) encoded as Latin-1 code points — decoded here.
 * mmedtypeflags bit 0x01 = signed, bit 0x02 = LSB-first (little-endian). (verified vs real bins)
 */
(function (global) {

  function decodeTis620(s) {
    if (!s) return '';
    let out = '';
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i);
      if (c >= 0xA1 && c <= 0xFB) out += String.fromCharCode(0x0E00 + (c - 0xA0)); else out += s[i]; }
    return out.trim();
  }
  // linear equation -> {a,b,f}: display = a*raw + b  (handles X, X*k, X*k+b, X-40, X/500 ...)
  function linearize(eq) {
    if (!eq) return { a: 1, b: 0, f: x => x };
    const e = eq.replace(/x/gi, 'X');
    if (!/^[\sX0-9.+\-*/()eE]+$/.test(e)) return { a: 1, b: 0, f: x => x };
    let f; try { f = new Function('X', 'return (' + e + ');'); f(0); } catch { return { a: 1, b: 0, f: x => x }; }
    const b = f(0), a = f(1) - f(0); return { a, b, f };
  }
  function attr(el, n, d) { return el && el.getAttribute(n) != null ? el.getAttribute(n) : d; }
  function intOf(v, d) { if (v == null) return d; const n = parseInt(v); return isNaN(n) ? d : n; }
  function norm(id) { return (id || '').toLowerCase(); }
  function childText(el, tag) { if (!el) return null; for (const ch of el.children) if (ch.tagName === tag) return ch.textContent; return null; }

  function axisInfo(axisEl) {
    if (!axisEl) return { linkId: null, linkTable: null, labels: null, lin: linearize('X'), count: 0 };
    const embed = axisEl.querySelector('embedinfo');
    const linkId = embed ? norm(embed.getAttribute('linkobjid')) : null;
    const labelEls = axisEl.querySelectorAll('LABEL');
    let labels = null;
    if (labelEls.length > 1) { labels = []; labelEls.forEach(l => labels.push(l.getAttribute('value'))); }
    const mathEl = axisEl.querySelector('MATH');
    return { linkId: (linkId && linkId !== '0x0') ? linkId : null, linkTable: null, labels,
      lin: linearize(mathEl ? mathEl.getAttribute('equation') : 'X'),
      count: intOf(childText(axisEl, 'indexcount'), 0) };
  }

  function parse(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('XDF อ่านไม่ได้ (รูปแบบไฟล์ผิด)');
    const bo = doc.querySelector('BASEOFFSET');
    const base = intOf(attr(bo, 'offset', '0'), 0), subtract = attr(bo, 'subtract', '0') === '1';
    const cats = {}; doc.querySelectorAll('XDFHEADER > CATEGORY').forEach(c => { cats[attr(c, 'index', '')] = decodeTis620(c.getAttribute('name') || ''); });
    const tables = [], byId = {};
    doc.querySelectorAll('XDFTABLE').forEach(t => {
      const id = norm(t.getAttribute('uniqueid'));
      let title = ''; for (const ch of t.children) if (ch.tagName === 'title') { title = decodeTis620(ch.textContent); break; }
      const axes = Array.from(t.querySelectorAll('XDFAXIS'));
      const zAxis = axes.find(a => a.getAttribute('id') === 'z'); if (!zAxis) return;
      const z = zAxis.querySelector('EMBEDDEDDATA'); if (!z) return;
      const addr = intOf(attr(z, 'mmedaddress', null), null); if (addr == null) return;
      const bits = intOf(attr(z, 'mmedelementsizebits', '8'), 8);
      const flags = intOf(attr(z, 'mmedtypeflags', '0'), 0);
      const catMem = t.querySelector('CATEGORYMEM');
      const catName = catMem ? cats[String(intOf(catMem.getAttribute('category'), -1) - 0)] || cats[catMem.getAttribute('category')] : '';
      const rec = {
        id, title: title || ('ตาราง ' + id),
        addr: addr + (subtract ? -base : base),
        elemBits: bits, bpc: bits / 8,
        rows: intOf(attr(z, 'mmedrowcount', '1'), 1),
        cols: intOf(attr(z, 'mmedcolcount', '1'), 1),
        signed: !!(flags & 0x01), endian: (flags & 0x02) ? 'le' : 'be',
        decimals: intOf(childText(zAxis, 'decimalpl'), 0),
        lin: linearize(zAxis.querySelector('MATH') ? zAxis.querySelector('MATH').getAttribute('equation') : 'X'),
        category: catName || '',
        axX: axisInfo(axes.find(a => a.getAttribute('id') === 'x')),
        axY: axisInfo(axes.find(a => a.getAttribute('id') === 'y'))
      };
      tables.push(rec); byId[id] = rec;
    });
    // resolve axis links
    tables.forEach(t => { if (t.axX.linkId) t.axX.linkTable = byId[t.axX.linkId] || null;
      if (t.axY.linkId) t.axY.linkTable = byId[t.axY.linkId] || null; });
    return { base, subtract, tables, byId };
  }

  function readRaw(bin, o, bpc, le, signed) {
    let v;
    if (bpc === 1) { v = bin[o] || 0; if (signed && v > 127) v -= 256; return v; }
    v = le ? ((bin[o] || 0) | ((bin[o + 1] || 0) << 8)) : (((bin[o] || 0) << 8) | (bin[o + 1] || 0));
    if (signed && v > 32767) v -= 65536; return v;
  }
  function writeRaw(bin, o, bpc, le, raw) {
    if (bpc === 1) { bin[o] = raw & 255; return; }
    if (le) { bin[o] = raw & 255; bin[o + 1] = (raw >> 8) & 255; } else { bin[o] = (raw >> 8) & 255; bin[o + 1] = raw & 255; }
  }

  function readValue(bin, tb, r, c) {
    const o = tb.addr + (r * tb.cols + c) * tb.bpc;
    return tb.lin.f(readRaw(bin, o, tb.bpc, tb.endian === 'le', tb.signed));
  }
  function writeValue(bin, tb, r, c, val) {
    const o = tb.addr + (r * tb.cols + c) * tb.bpc;
    const { a, b } = tb.lin; const max = tb.elemBits === 8 ? 255 : 65535;
    let raw = a !== 0 ? Math.round((val - b) / a) : Math.round(val);
    if (tb.signed) { const lim = tb.elemBits === 8 ? 127 : 32767; raw = Math.max(-lim - 1, Math.min(lim, raw)); if (raw < 0) raw += max + 1; }
    else raw = Math.max(0, Math.min(max, raw));
    writeRaw(bin, o, tb.bpc, tb.endian === 'le', raw);
  }
  // labels for an axis object (as stored on tb.axX / tb.axY)
  function axisLabels(bin, axis, count) {
    if (!axis) return seq(count);
    if (axis.labels && axis.labels.length > 1) return axis.labels.slice(0, count);
    const lt = axis.linkTable;
    if (lt) { const flat = []; const n = lt.rows * lt.cols;
      for (let i = 0; i < n; i++) { const r = Math.floor(i / lt.cols), c = i % lt.cols; flat.push(fmtNum(readValue(bin, lt, r, c), lt.decimals)); }
      if (flat.length >= count) return flat.slice(0, count);
      while (flat.length < count) flat.push(String(flat.length));
      return flat;
    }
    return seq(count);
  }
  function seq(n) { const a = []; for (let i = 0; i < n; i++) a.push(String(i)); return a; }
  function fmtNum(v, dec) { if (dec > 0) return (Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec)).toString(); return String(Math.round(v)); }

  global.HFXdf = { parse, readValue, writeValue, axisLabels, decodeTis620, fmtNum };
})(typeof window !== 'undefined' ? window : globalThis);
