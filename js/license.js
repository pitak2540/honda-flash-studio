'use strict';
/* Honda Flash Studio Mobile — offline license lock.
 * Gated features: FLASH + SAVE/DOWNLOAD BIN. Everything else (connect, live data,
 * DTC, viewing/editing tables on screen) stays free.
 * Keys are ECDSA P-256 signed tokens: they CANNOT be forged without the seller's
 * private key. (A client-side gate can still be bypassed by editing the app's code —
 * for strong protection add server validation; this stops casual sharing/forging.)
 * Key format:  base64url(payloadJSON) "." base64url(rawSig64)
 *   payload = { n:"ชื่อผู้ซื้อ", d:"*"|deviceId, x:expiryEpochMs|0 }
 */
(function (global) {
  const PUBLIC_JWK = { kty: 'EC', crv: 'P-256',
    x: 'zHCaelq9ML6rTpC3ua3ESdOgtdQGqIz97M-S1zR-sGk',
    y: 'BMoSyiMI_vm0PYCdnWEeCCnJNxV21W_uBMbXYlSY9qA' };

  const LS_KEY = 'hfs-license', LS_DEV = 'hfs-devid';
  let st = { licensed: false, name: '', exp: 0, reason: '' };
  let pubKey = null;

  const enc = new TextEncoder();
  function b64urlToBytes(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function bytesToStr(u) { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return s; }

  function deviceId() {
    let d = null; try { d = localStorage.getItem(LS_DEV); } catch {}
    if (!d) { const u = new Uint8Array(6); (global.crypto || {}).getRandomValues ? crypto.getRandomValues(u) : u.forEach((_, i) => u[i] = Math.floor(Math.random() * 256));
      d = Array.from(u).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      try { localStorage.setItem(LS_DEV, d); } catch {} }
    return d;
  }

  async function getPub() { if (pubKey) return pubKey;
    pubKey = await crypto.subtle.importKey('jwk', PUBLIC_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); return pubKey; }

  async function verifyKey(keyStr) {
    try {
      keyStr = (keyStr || '').trim().replace(/\s+/g, '');
      const dot = keyStr.indexOf('.'); if (dot < 0) return { ok: false, reason: 'รูปแบบคีย์ไม่ถูกต้อง' };
      const p64 = keyStr.slice(0, dot), s64 = keyStr.slice(dot + 1);
      const payload = JSON.parse(bytesToStr(b64urlToBytes(p64)));
      const sig = b64urlToBytes(s64);
      const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await getPub(), sig, enc.encode(p64));
      if (!ok) return { ok: false, reason: 'คีย์ไม่ถูกต้อง (ลายเซ็นไม่ผ่าน)' };
      if (payload.d && payload.d !== '*' && payload.d !== deviceId()) return { ok: false, reason: 'คีย์นี้ผูกกับเครื่องอื่น' };
      if (payload.x && payload.x > 0 && Date.now() > payload.x) return { ok: false, reason: 'คีย์หมดอายุแล้ว' };
      return { ok: true, name: payload.n || '', exp: payload.x || 0, bound: payload.d && payload.d !== '*' };
    } catch (e) { return { ok: false, reason: 'อ่านคีย์ไม่ได้' }; }
  }

  async function init() {
    let saved = null; try { saved = localStorage.getItem(LS_KEY); } catch {}
    if (!saved) { st = { licensed: false, name: '', exp: 0, reason: 'ยังไม่ได้ปลดล็อก' }; return st; }
    const v = await verifyKey(saved);
    st = v.ok ? { licensed: true, name: v.name, exp: v.exp, reason: '' } : { licensed: false, name: '', exp: 0, reason: v.reason };
    if (!v.ok) { try { localStorage.removeItem(LS_KEY); } catch {} }
    return st;
  }
  async function activate(keyStr) {
    const v = await verifyKey(keyStr);
    if (!v.ok) return v;
    try { localStorage.setItem(LS_KEY, (keyStr || '').trim().replace(/\s+/g, '')); } catch {}
    st = { licensed: true, name: v.name, exp: v.exp, reason: '' };
    emit();
    return v;
  }
  function deactivate() { try { localStorage.removeItem(LS_KEY); } catch {} st = { licensed: false, name: '', exp: 0, reason: 'ปิดการใช้งานแล้ว' }; emit(); }

  const listeners = [];
  function onChange(fn) { listeners.push(fn); }
  function emit() { listeners.forEach(fn => { try { fn(st); } catch {} }); }

  function ok() { return !!st.licensed; }
  function info() { return { ...st, deviceId: deviceId() }; }

  global.HFLicense = { init, activate, deactivate, ok, info, deviceId, onChange, verifyKey };
})(typeof window !== 'undefined' ? window : globalThis);
