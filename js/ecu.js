'use strict';
/* Honda Flash Studio Mobile — ECU read/live/DTC (faithful byte-port of desktop ecu.js).
 * Same K-line commands, timing and parse math; only the serial plumbing is HFLink.
 * Reading is non-destructive (cannot brick an ECU). 10400 8N1.
 */
(function (global) {
  const L = global.HFLink;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const bus = new EventTarget();
  function emit(type, detail) { bus.dispatchEvent(new CustomEvent(type, { detail })); }
  function log(msg, level = 'info') { emit('log', { level, msg, t: Date.now() }); }

  let state = { connected: false, ecmType: 0, pollHz: 0, totalErrors: 0, ecmId: '', fileCode: '' };
  let polling = false, pollTimer = null, pollCount = 0, hzTs = 0, o2Counter = 0, lastO2 = null, lastGood = null, consecErr = 0;

  const AFR_V = [0, 0.02, 0.04, 0.1, 0.35, 0.7, 0.8, 0.9, 0.95, 1];
  const AFR_A = [20, 18, 17, 16, 15, 14, 13, 12, 11, 10];
  let cmd1 = null, cmdO2 = Uint8Array.of(114, 7, 114, 32, 0, 11, 234);
  let minLenB = 27, minO2B = 13; // byte lengths (desktop hex/2)

  // ---- rx helpers (bytes) ----
  function rx() { return L.rx; }
  function rxLen() { return L.rx.length; }
  function rxHex() { let s = ''; const b = L.rx; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0'); return s; }
  function clearRx() { L.clearRx(); }
  async function write(bytes) { return L.write(bytes); }
  async function flushInput() { return L.purge(); }
  async function setBreak(on) { return L.setBreak(on); }

  // wait until rx reaches needBytes (or stabilises), bounded by timeout
  function readResponse(timeout = 200, needBytes = 0) {
    return new Promise(resolve => {
      const start = Date.now(); let prev = 0, stable = 0;
      const tick = () => {
        const now = Date.now(), len = rxLen();
        if (now - start >= timeout) return resolve(rx().slice());
        if (needBytes > 0 && len < needBytes) { prev = len; stable = 0; return setTimeout(tick, 1); }
        if (len > 0 && len === prev) { if (++stable >= 3) return resolve(rx().slice()); } else stable = 0;
        prev = len; setTimeout(tick, 1);
      };
      setTimeout(tick, 1);
    });
  }

  // ---------- init + detect ----------
  async function doInit() {
    await setBreak(false); await sleep(100); await setBreak(true); await sleep(70); await setBreak(false); await sleep(150);
    await write([254, 4, 114, 140]); await sleep(50); clearRx();
    await write([114, 5, 113, 0, 24]);
    const r = await readResponse(800, 7);
    const h = hexOf(r);
    return (r.length >= 2 && (h.includes('0207') || h.includes('7205') || h.includes('7100') || r.length >= 7));
  }
  function hexOf(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0'); return s; }

  async function detectType() {
    try {
      await flushInput(); clearRx(); await write([114, 7, 114, 19, 0, 14, 244]);
      let r = await readResponse(500, 7);
      if (r.length > 15) { state.ecmType = 7; }
      else {
        await flushInput(); await sleep(50); clearRx(); await write([114, 7, 114, 23, 0, 15, 239]);
        r = await readResponse(500, 7);
        if (r.length > 15) state.ecmType = 4; else state.ecmType = 1;
      }
    } catch { state.ecmType = 1; }
    await flushInput(); setCmdBytes();
    log('ตรวจพบ ECM Type ' + state.ecmType);
  }

  // strip leading command echo (if present), return remaining bytes
  function stripEcho(resp, cmd) {
    if (resp.length >= cmd.length) { let eq = true; for (let i = 0; i < cmd.length; i++) if (resp[i] !== cmd[i]) { eq = false; break; }
      if (eq) return resp.subarray(cmd.length); }
    return resp;
  }

  async function readEcmId() {
    try {
      const cmd = [114, 7, 114, 0, 0, 5, 16];
      await flushInput(); clearRx(); await write(cmd); await sleep(30);
      const r = await readResponse(700, 10);
      if (!r || r.length < 10) return;
      const h = stripEcho(r, cmd);
      if (h.length >= 10) {
        let id = ''; for (let i = 5; i < 10; i++) id += h[i].toString(16).toUpperCase().padStart(2, '0');
        if (/^[0-9A-F]{10}$/.test(id) && id !== '0000000000') { state.ecmId = id; log('รหัสกล่อง (ECM ID): ' + id, 'ok'); }
      }
    } catch {}
  }
  async function readFileCode() {
    try {
      const cmd = [114, 7, 114, 128, 0, 8, 141];
      await flushInput(); clearRx(); await write(cmd); await sleep(30);
      const r = await readResponse(700, 12);
      if (!r || r.length < 12) return;
      const h = stripEcho(r, cmd);
      let s = '';
      for (let i = 6; i < 13 && i < h.length; i++) { const bv = h[i]; if (bv >= 32 && bv < 127) s += String.fromCharCode(bv); else break; }
      s = s.trim();
      if (s.length >= 3 && /^[0-9A-Za-z\- ]+$/.test(s)) { state.fileCode = s; log('รหัสไฟล์ในกล่อง: ' + s, 'ok'); }
    } catch {}
  }
  function setCmdBytes() {
    cmdO2 = Uint8Array.of(114, 7, 114, 32, 0, 11, 234); minO2B = 13;
    if (state.ecmType === 1) { cmd1 = Uint8Array.of(114, 7, 114, 17, 0, 20, 240); minLenB = 27; }
    else if (state.ecmType === 4) { cmd1 = Uint8Array.of(114, 7, 114, 23, 0, 15, 239); minLenB = 22; }
    else { cmd1 = Uint8Array.of(114, 7, 114, 19, 0, 14, 244); minLenB = 21; }
  }

  // ---------- connect ----------
  async function connect() {
    try {
      log('เปิดพอร์ต...');
      await L.open(10400); await sleep(2000);
      log('Init ECM...');
      let ok = await doInit();
      if (!ok) { log('init ครั้งแรกไม่ผ่าน ลองใหม่'); await sleep(500); await L.close(); await reopen(); await sleep(1000); ok = await doInit(); }
      if (!ok) { await L.close(); return { ok: false, reason: 'ECM_NO_RESPONSE' }; }
      await L.close(); await sleep(200); await reopen(); await sleep(300);
      await detectType();
      await readEcmId();
      await readFileCode();
      state.connected = true; state.totalErrors = 0; consecErr = 0;
      emit('state', { ...state });
      log('เชื่อมต่อแล้ว · ECM Type ' + state.ecmType + (state.ecmId ? ' · ID ' + state.ecmId : ''), 'ok');
      startPolling(50);
      return { ok: true, state: { ...state } };
    } catch (e) { try { await L.close(); } catch {} log('เชื่อมต่อล้มเหลว: ' + e.message, 'error'); return { ok: false, reason: e.message }; }
  }
  // reopen the SAME paired device (no new permission prompt needed)
  async function reopen() { await L.open(10400); }

  async function disconnect() {
    stopPolling(); try { await L.close(); } catch {}
    state = { connected: false, ecmType: 0, pollHz: 0, totalErrors: 0, ecmId: '', fileCode: '' };
    emit('state', { ...state }); return { ok: true };
  }
  function getState() { return { ...state }; }

  // ---------- polling ----------
  function startPolling(interval = 50) {
    if (!state.connected || polling) return; polling = true; consecErr = 0; pollCount = 0; hzTs = Date.now(); o2Counter = 0;
    pollLoop(interval);
  }
  function stopPolling() { polling = false; if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
  async function pollLoop(interval) {
    if (!polling || !state.connected) return;
    const t0 = Date.now();
    try { await pollOnce(); pollCount++; consecErr = 0; }
    catch (e) { consecErr++; state.totalErrors++;
      if (consecErr >= 20) { log('ขาดการเชื่อมต่อ: ' + e.message, 'error'); state.connected = false; emit('state', { ...state }); return; }
      try { await flushInput(); } catch {}
      if (lastGood) emit('live', lastGood); }
    const dt = Date.now() - hzTs;
    if (dt >= 500) { state.pollHz = Math.round(pollCount * 1000 / dt * 10) / 10; pollCount = 0; hzTs = Date.now(); }
    if (polling) { const spent = Date.now() - t0; pollTimer = setTimeout(() => pollLoop(interval), Math.max(1, interval - spent)); }
  }
  async function pollOnce() {
    if (!state.connected || !L.isOpen) throw new Error('Port not open');
    await flushInput(); await write(cmd1);
    const r = await readResponse(200, minLenB);
    if (!r || r.length < minLenB) throw new Error('Short response ' + (r ? r.length : 0));
    if (++o2Counter >= 3) { o2Counter = 0; try { await flushInput(); await write(cmdO2);
      const o = await readResponse(200, minO2B); if (o && o.length >= minO2B) lastO2 = o; } catch {} }
    const d = parseECM(r); if (!d) return;
    parseO2(lastO2, d);
    d.pollHz = state.pollHz; d.ecmType = state.ecmType; d.totalErrors = state.totalErrors;
    lastGood = { ...d };
    emit('live', d);
  }
  // byte b(i) — desktop used hex offset o; byte index = o/2
  function parseECM(u8) {
    try {
      if (!u8 || u8.length < 14) return null;
      const b = i => (i < u8.length ? u8[i] : 0);
      const d = { rpm: 0, tps: 0, tpsV: 0, ect: 0, o2: 0, afr: 0, ltft: 0, bat: 0, inj: 0, ign: 0 };
      d.rpm = b(12) * 256 + b(13);
      d.tpsV = Math.round(b(14) * 195 / 10 / 1000 * 100) / 100;
      d.tps = b(15) * 0.5;
      d.ect = b(17) - 40;
      if (state.ecmType === 1) {
        d.bat = Math.round(b(24) / 10 * 10) / 10;
        d.inj = Math.round((b(26) * 256 + b(27)) / 250 * 10) / 10;
        d.ign = (b(28) - 128) * 0.5;
        if (u8.length > 46) d.ltft = Math.round((b(46) * 39 / 50 - 100) * 10) / 10;
      } else {
        d.bat = Math.round(b(22) / 10 * 10) / 10;
        d.inj = Math.round((b(23) * 256 + b(24)) / 250 * 10) / 10;
        d.ign = (b(25) - 128) * 0.5;
        d.ltft = (state.ecmType === 4 && u8.length > 26) ? Math.round((b(26) * 39 / 50 - 100) * 10) / 10 : 0;
      }
      return d;
    } catch { return null; }
  }
  function lookupAFR(v) {
    if (v <= AFR_V[0]) return AFR_A[0]; if (v >= AFR_V[AFR_V.length - 1]) return AFR_A[AFR_A.length - 1];
    for (let i = 0; i < AFR_V.length - 1; i++) if (v >= AFR_V[i] && v <= AFR_V[i + 1]) {
      const t = (v - AFR_V[i]) / (AFR_V[i + 1] - AFR_V[i]); return AFR_A[i] + t * (AFR_A[i + 1] - AFR_A[i]); }
    return 14.7;
  }
  function parseO2(u8, d) { try { if (!u8 || u8.length < 13) return;
    const raw = u8[12] || 0;
    d.o2 = Math.round(raw / 753.75 * 14.7 * 1000) / 1000; d.afr = Math.round(lookupAFR(d.o2) * 10) / 10; } catch {} }

  // ---------- DTC ----------
  const DTC_DB = {
    1:'(MAP) วงจรเซ็นเซอร์ความดันสัมบูรณ์ท่อร่วมผิดปกติ',2:'(MAP) ประสิทธิภาพเซ็นเซอร์ MAP',
    7:'(ECT/EOT) วงจรเซ็นเซอร์อุณหภูมิน้ำหล่อเย็นผิดปกติ',8:'(TPS) วงจรเซ็นเซอร์ตำแหน่งปีกผีเสื้อผิดปกติ',
    9:'(IAT) วงจรเซ็นเซอร์อุณหภูมิอากาศเข้าผิดปกติ',10:'(MAP) วงจรเซ็นเซอร์ความดันสัมบูรณ์ท่อร่วมผิดปกติ',
    11:'(VSS) วงจรเซ็นเซอร์ความเร็วรถผิดปกติ',12:'วงจรควบคุมหัวฉีด/หัวฉีดหลัก No.1 ผิดปกติ',
    14:'หมายเลข 3 วงจรหัวฉีดหลักผิดปกติ',15:'หมายเลข 4 วงจรหัวฉีดหลักผิดปกติ',16:'หมายเลข 1 วงจรหัวฉีดทุติยภูมิผิดปกติ',
    17:'หมายเลข 2 วงจรหัวฉีดรองผิดปกติ',18:'เครื่องกำเนิดพัลส์ CAM - ไม่มีสัญญาณ',19:'เครื่องกำเนิดพัลส์จุดระเบิด - ไม่มีสัญญาณ',
    20:'EEPROM ล้มเหลว',21:'วงจรเซ็นเซอร์ออกซิเจนผิดปกติ',22:'วงจรเซ็นเซอร์ออกซิเจน No.2 ผิดปกติ',
    23:'วงจรฮีตเตอร์ออกซิเจนเซ็นเซอร์ผิดปกติ',24:'วงจรฮีตเตอร์ออกซิเจนเซ็นเซอร์ No.2 ผิดปกติ',
    29:'(IACV) วงจรควบคุมอากาศเดินเบาผิดปกติ',33:'EEPROM ล้มเหลว',52:'(CKP) วงจรเซ็นเซอร์เพลาข้อเหวี่ยงผิดปกติ',
    54:'วงจรเซ็นเซอร์แบงก์แองเกิลผิดปกติ',57:'(ECT) วงจรเซ็นเซอร์อุณหภูมิน้ำหล่อเย็นผิดปกติ',
    71:'(TP) สัญญาณเซ็นเซอร์ตำแหน่งปีกผีเสื้อ No.1',72:'(TP) เซ็นเซอร์ตำแหน่งปีกผีเสื้อ No.2',
    73:'ซิงค์ระหว่าง TP No.1 และ No.2 ผิดพลาด',82:'(FISV) วงจรโซลินอยด์วาล์วเดินเบาเร็วผิดปกติ',
    88:'(EVAP) ระบบควบคุมไอระเหยผิดปกติ',89:'การฉีดอากาศทุติยภูมิ/วาล์ว AISV ผิดปกติ',
    91:'วงจรควบคุมคอยล์จุดระเบิดหลักผิดปกติ',103:'ข้อผิดพลาด CAN bus จาก ECM ไปแดชบอร์ด'
  };
  function dtcDesc(c) { return DTC_DB[c] || 'ไม่มีฐานข้อมูล รออัพเดท'; }
  // desktop parseDTC worked on hex offsets; byte offset = hexoff/2
  function parseDTC(u8) {
    const codes = []; if (!u8 || u8.length <= 17) return { codes, rawCount: 0 };
    const raw = [];
    for (let i = 1; i <= 18; i++) {
      let off = (i < 7 ? i * 2 + 18 : (i < 13 ? i * 2 + 40 : i * 2 + 62)) / 2; // byte index
      if (off + 1 > u8.length) break;
      raw.push(u8[off] || 0);
      if (raw.length >= 2 && raw[raw.length - 1] === 0 && raw[raw.length - 2] === 0) { raw.pop(); raw.pop(); break; }
    }
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const code = raw[i], sub = raw[i + 1];
      codes.push({ code, description: code + '-' + sub + ': ' + dtcDesc(code), found: !!DTC_DB[code] });
    }
    return { codes, rawCount: codes.length };
  }
  async function readDTC() {
    if (!state.connected) return { ok: false, reason: 'NOT_CONNECTED' };
    stopPolling(); await L.close(); await sleep(150);
    try {
      await reopen(); await flushInput(); await sleep(50); clearRx();
      for (const c of [[114,5,116,1,20],[114,5,116,2,19],[114,5,116,3,18]]) { await write(c); await sleep(50); }
      await sleep(300); const u8 = rx().slice(); await L.close();
      const p = parseDTC(u8);
      await reconnectAfter();
      return { ok: true, codes: p.codes.map((c, i) => ({ no: i + 1, ...c })), count: p.rawCount };
    } catch (e) { try { await L.close(); } catch {} await reconnectAfter(); return { ok: false, reason: e.message }; }
  }
  async function clearDTC() {
    if (!state.connected) return { ok: false, reason: 'NOT_CONNECTED' };
    stopPolling(); await L.close(); await sleep(150);
    try {
      await reopen();
      await setBreak(false); await sleep(100); await setBreak(true); await sleep(70); await setBreak(false); await sleep(150);
      await write([254,4,114,140]); await sleep(30); await write([114,5,0,240,153]); await sleep(30); await flushInput();
      await write([114,5,96,3,38]); await sleep(50); await write([114,5,96,1,40]); await sleep(50); await sleep(1000);
      await flushInput(); await sleep(50); clearRx();
      for (const c of [[114,5,116,1,20],[114,5,116,2,19],[114,5,116,3,18]]) { await write(c); await sleep(50); }
      await sleep(300); const u8 = rx().slice(); await L.close();
      const p = parseDTC(u8); await reconnectAfter();
      return { ok: true, cleared: true, remaining: p.codes.length };
    } catch (e) { try { await L.close(); } catch {} await reconnectAfter(); return { ok: false, reason: e.message }; }
  }
  async function reconnectAfter() {
    try { await sleep(200); await reopen(); await sleep(300); await doInit(); await L.close();
      await sleep(100); await reopen(); await sleep(200); await detectType();
      state.connected = true; emit('state', { ...state }); startPolling(50);
    } catch {}
  }

  async function readLive() { return lastGood ? { ok: true, data: lastGood } : { ok: false, reason: 'NO_DATA' }; }

  global.HFEcu = {
    bus, connect, disconnect, getState, readDTC, clearDTC, readLive,
    _reopen: reopen, _stopPolling: stopPolling, _startPolling: startPolling,
    _setBreak: setBreak, _write: write, _flush: flushInput, _readResponse: readResponse,
    _state: () => state, _setConnected: v => { state.connected = v; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
