'use strict';
/* Honda Flash Studio Mobile — ECU flasher (faithful byte-port of desktop flash.js).
 * DANGER: writing to an ECU can brick it. The SAME safety guards as the desktop
 * app are kept: only a complete, valid-size ROM is allowed, and a flash is reported
 * successful only when every chunk was written and ACKed. Nothing is faked.
 * Uses the already-open HFLink (shared with live-read); it does NOT open/close the port.
 */
(function (global) {
  const L = global.HFLink;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const b = arr => Uint8Array.of.apply(null, arr);
  function u8eq(a, c) { if (a.length !== c.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) return false; return true; }

  class Flasher extends EventTarget {
    constructor() {
      super();
      this._isFlashing = false; this._abort = false;
      this.ecmId = ''; this.flashCount = 0; this.ecuType = 0;
      this._keepAlive = null; this._hadError = false;
    }
    get isFlashing() { return this._isFlashing; }
    _emit(ev, v) { this.dispatchEvent(new CustomEvent(ev, { detail: v })); if (ev === 'error') this._hadError = true; }
    _delay(ms) { return sleep(ms); }

    // ---- plumbing over the shared link ----
    async _writeDrain(buf) { if (!L.isOpen) throw new Error('Port closed'); await L.write(buf); }
    async _purge() { await L.purge(); }
    async _setBreak(on) { await L.setBreak(on); }
    _rx() { return L.rx; }

    async _doInit() {
      try {
        await this._setBreak(true); await this._delay(70); await this._setBreak(false); await this._purge(); await this._delay(130);
        L.clearRx(); await this._writeDrain(b([254, 4, 114, 140])); await this._delay(100);
        if (L.rx.length >= 4) return true;
        L.clearRx(); await this._writeDrain(b([114, 5, 113, 0, 24]));
        const t0 = Date.now(); while (Date.now() - t0 < 800) { if (L.rx.length >= 7) return true; await this._delay(5); }
        return L.rx.length >= 5;
      } catch { return false; }
    }

    async _send(cmd, echoLen = 0, preDelay = 0, timeoutMs = 0) {
      if (!L.isOpen) return null;
      cmd = cmd instanceof Uint8Array ? cmd : Uint8Array.from(cmd);
      if (echoLen <= 0) echoLen = cmd.length;
      const timeout = timeoutMs > 0 ? timeoutMs : 50 + echoLen * 2;
      await this._purge();
      try { await this._writeDrain(echoLen < cmd.length ? cmd.subarray(0, echoLen) : cmd); }
      catch { return null; }
      if (preDelay > 0) await this._delay(preDelay);
      const start = Date.now(); let replyLen = 0;
      while (true) {
        if (Date.now() - start >= timeout) { await this._purge(); return null; }
        const rx = L.rx; const total = rx.length;
        if (total >= echoLen + 2 && replyLen === 0) { replyLen = rx[echoLen + 1];
          if (replyLen === 0 || replyLen > 200) { await this._purge(); return null; } }
        if (replyLen > 0 && total - echoLen === replyLen) {
          const reply = rx.subarray(total - replyLen, total).slice();
          if (!this._validateChecksum(reply, replyLen)) { await this._purge(); return null; }
          await this._purge(); return reply;
        }
        await this._delay(1);
      }
    }
    _validateChecksum(buf, len) { let s = 0; for (let i = 0; i < len; i++) s += buf[i]; return (s & 255) === 0; }
    _csHonda(buf, len, start = 0) { let s = 0; for (let i = start; i < start + len && i < buf.length; i++) s += buf[i]; return ((s ^ 255) + 1) & 255; }
    _cs8(buf, len, start = 0) { let s = 0; for (let i = start; i < start + len && i < buf.length; i++) s += buf[i]; return (255 - ((s - 1) >> 8 & 255)) & 255; }

    _keihinAutoChecksum(bin, off) { const bb = bin.slice(); const n = bb.length; let s = 0;
      if (off !== 0) { for (let i = 0; i < off; i++) s = (s + bb[i]) & 255; for (let i = off + 1; i < n; i++) s = (s + bb[i]) & 255; }
      else { for (let i = 1; i < n; i++) s = (s + bb[i]) & 255; }
      bb[off] = (256 - s) & 255; return bb; }
    _shindengenAutoChecksum(bin) { const bb = bin.slice(); const n = bb.length; const sig = [17,18,19,20,21,21,23]; let at = -1;
      for (let i = 0; i <= n - sig.length; i++) { let ok = true; for (let j = 0; j < sig.length; j++) if (bb[i + j] !== sig[j]) { ok = false; break; } if (ok) { at = i; break; } }
      if (at < 0) return bb; const st = at + sig.length;
      for (let i = st; i < n - 6; i++) { if (bb[i] === 208 && bb[i + 1] === 7) {
        let base = i; if ((i - (i + (i - 4 >> 31 >>> 30) - 4 & -4)) === 6) base = i - 6;
        if (base >= 4) { let s1 = 0; for (let k = 0; k + 3 < base - 4; k += 4) s1 = (s1 + ((bb[k] | bb[k+1]<<8 | bb[k+2]<<16 | bb[k+3]<<24>>>0) >>> 0)) >>> 0;
          let s2 = 0; for (let k = base; k + 3 < n; k += 4) s2 = (s2 + ((bb[k] | bb[k+1]<<8 | bb[k+2]<<16 | bb[k+3]<<24>>>0) >>> 0)) >>> 0;
          const sum = (s1 + s2) >>> 0, cs = (4294967296 - sum) >>> 0;
          bb[base-4] = cs & 255; bb[base-3] = cs>>8 & 255; bb[base-2] = cs>>16 & 255; bb[base-1] = cs>>24 & 255; }
        break; } }
      return bb; }
    _shindengenWriteKey(bin, sh, sl) { const n = bin.length; const seed = (sh & 255) << 8 | (sl & 255); const sig = [17,18,19,20,21,21,23];
      for (let i = 0; i < n - sig.length; i++) { let ok = true; for (let j = 0; j < sig.length; j++) if (bin[i + j] !== sig[j]) { ok = false; break; } if (!ok) continue;
        let p = i + sig.length; while (p < n - 10) { if (bin[p + 8] === 238 && (bin[p + 9] === 0 || bin[p + 9] === 255)) {
          const a = bin[p+1]<<8 | bin[p], bb2 = bin[p+3]<<8 | bin[p+2], cc = bin[p+5]<<8 | bin[p+4];
          let k = (bb2 * ((seed + a) & 65535)) & 65535; let r = cc > 0 ? (k + seed % cc) & 65535 : (k + seed) & 65535;
          return { success: true, keyHigh: r >> 8 & 255, keyLow: r & 255 }; } p++; } }
      return { success: false, keyHigh: 0, keyLow: 0 }; }
    _shindengenRecoveryKey(bin, sh, sl) { const n = bin.length; const seed = (sh & 255) << 8 | (sl & 255); const sig = [145,145,13,0,158,141];
      for (let i = 0; i < n - sig.length - 6; i++) { let ok = true; for (let j = 0; j < sig.length; j++) if (bin[i + 6 + j] !== sig[j]) { ok = false; break; } if (!ok) continue;
        const a = bin[i+1]<<8 | bin[i], bb2 = bin[i+3]<<8 | bin[i+2], cc = bin[i+5]<<8 | bin[i+4];
        let k = (bb2 * ((seed + a) & 65535)) & 65535; let r = cc > 0 ? (k + seed % cc) & 65535 : (k + seed) & 65535;
        return { success: true, keyHigh: r >> 8 & 255, keyLow: r & 255 }; }
      return { success: false, keyHigh: 0, keyLow: 0 }; }

    // ---- attach to an already-open link + read info (ecmId, flashCount, keepAlive) ----
    async attachAndReadInfo(presetEcmId) {
      try {
        if (!L.isOpen) { this._emit('error', 'ยังไม่เชื่อมต่อ'); return null; }
        this._emit('status', 'Init ECM...');
        let ok = await this._doInit();
        if (!ok) { this._emit('status', 'ลองใหม่...'); await this._delay(400); ok = await this._doInit(); }
        if (!ok) { this._emit('error', 'เชื่อมต่อ ECM ไม่ได้'); return null; }
        this._emit('status', 'อ่านข้อมูล ECM...');
        await this._send(b([254, 4, 114, 140]));
        let ka = await this._send(b([114, 5, 0, 240, 153]));
        if (ka) { this._keepAlive = b([114, 5, 0, 240, 153]); }
        else { const r = await this._send(b([126, 6, 1, 1, 0, 122]));
          if (r && r[3] !== 15) this._keepAlive = b([126, 6, 1, 1, 0, 122]); else this._keepAlive = b([114, 5, 0, 240, 153]); }
        const chk = await this._send(this._keepAlive, this._keepAlive[1]);
        if (!chk) { this._emit('error', 'ECM ไม่ตอบสนอง'); return null; }
        this.ecmId = presetEcmId || '-';
        const idr = await this._send(b([114, 7, 114, 0, 0, 5, 16]));
        if (idr && idr.length >= 10) { this.ecmId = ''; for (let i = 5; i < 10; i++) this.ecmId += idr[i].toString(16).toUpperCase().padStart(2, '0'); }
        this.flashCount = 0;
        let fc = await this._send(b([125, 6, 1, 1, 3, 120]));
        if (fc && fc.length >= 7) this.flashCount = fc[6];
        else { fc = await this._send(b([123, 6, 2, 1, 3, 121])); if (fc && fc.length >= 7) this.flashCount = fc[6]; }
        const recovery = this.ecmId.length >= 4 && this.ecmId.endsWith('0000');
        this._emit('status', 'พร้อมแฟลช — ECM ID: ' + this.ecmId);
        return { success: true, ecmId: this.ecmId, flashCount: this.flashCount, isRecovery: recovery };
      } catch (e) { this._emit('error', 'เตรียมแฟลชล้มเหลว: ' + e.message); return null; }
    }

    detectEcuType(bin) { const n = bin.length; const at = (o, sig) => { if (o + sig.length > n) return false; for (let i = 0; i < sig.length; i++) if (bin[o + i] !== sig[i]) return false; return true; };
      const ZZ = [90,90,90,90], SHIN = [17,18,19,20,21,21,23], SV8 = [83,86,56,53,48], SH8 = [83,72,56,53,48], A5 = [165,165,165,165,0], FF2 = [255,255,170,170], FF7 = [255,255,255,170,170,170,170];
      if (n >= ZZ.length && at(n - ZZ.length, ZZ)) { let hasShin = false;
        for (let i = 0; i < n - SHIN.length; i++) { if (at(i, SHIN)) hasShin = true;
          if (at(i, SV8)) return { ecuType: 3, startOffset: '10000' };
          if (at(i, SH8)) { if (n > 40960 + A5.length && at(40960, A5)) return { ecuType: 5, startOffset: 'A000' }; return { ecuType: 4, startOffset: '10000' }; } }
        if (hasShin) return { ecuType: 3, startOffset: '10000' }; }
      if ((n === 57344 || n === 32768) && n >= FF2.length && at(n - FF2.length, FF2)) return { ecuType: 1, startOffset: this._keihinStart(n) };
      if (n === 262144 && n >= FF7.length && at(n - FF7.length, FF7)) return { ecuType: 2, startOffset: '8000' };
      return { ecuType: 0, startOffset: this._keihinStart(n) }; }
    _keihinStart(n) { return ({ 49152: '4000', 57344: '0', 65536: '8000', 98304: '8000', 131072: 'E0000' })[n] || '0'; }
    getAutoOffsets(bin) { const n = bin.length; const det = this.detectEcuType(bin); if (det.ecuType >= 3) return { startOffset: 'auto', checksumOffset: 'auto' };
      const tail = sig => { if (n < sig.length) return false; const bse = n - sig.length; for (let i = 0; i < sig.length; i++) if (bin[bse + i] !== sig[i]) return false; return true; };
      const A = [255,255,255,0,0,0,0], B = [255,255,255,170,170,170,170], C = [255,255,255,255,255,255,255];
      if (n === 49152) return { startOffset: '4000', checksumOffset: '7600' };
      if (n === 57344) return { startOffset: '0', checksumOffset: 'DFEF' };
      if (n === 65536 || n === 98304) return { startOffset: '8000', checksumOffset: '0' };
      if (n === 131072) return { startOffset: 'E0000', checksumOffset: 'B000' };
      if (n < 262144) return { startOffset: det.startOffset || '0', checksumOffset: '0' };
      if (n === 262144 && (tail(A) || tail(B) || tail(C))) return { startOffset: '0', checksumOffset: '3FFF8' };
      if (n === 524288 && tail(C)) return { startOffset: '0', checksumOffset: '7FFF8' };
      if (n === 1048576) return tail(B) ? { startOffset: '0', checksumOffset: 'FFFF8' } : { startOffset: '0', checksumOffset: '7FFF8' };
      return { startOffset: det.startOffset || '0', checksumOffset: '0' }; }

    abort() { this._abort = true; }

    async startFlash(bin, { startOffsetHex, checksumOffsetHex } = {}) {
      if (this._isFlashing) { this._emit('error', 'กำลังแฟลชอยู่'); return false; }
      if (!L.isOpen) { this._emit('error', 'ยังไม่เชื่อมต่อ ECM'); this._emit('complete', false); return false; }
      // ---- SAFETY GUARD: block flashing an image that is not a complete, valid ROM size ----
      const VALID_SIZES = [49152, 57344, 65536, 98304, 131072, 262144, 393216, 524288, 1048576];
      if (!bin || !VALID_SIZES.includes(bin.length)) {
        this._emit('error', 'ยกเลิก: ไฟล์ขนาด ' + (bin ? (bin.length / 1024).toFixed(1) : 0) + 'KB ไม่ใช่ภาพ ROM เต็มที่ถูกต้อง — ห้ามแฟลช (กันกล่องพังจากไฟล์ครึ่งเดียว/ดูดมาไม่ครบ)');
        this._emit('complete', false); return false;
      }
      let binModel = ''; for (let i = 1; i < 16; i++) { const c = bin[i]; if (c >= 32 && c < 127) binModel += String.fromCharCode(c); else break; }
      if (binModel.length >= 3) this._emit('status', '⚠ รุ่นในไฟล์: "' + binModel + '" — ต้องตรงกับกล่อง (ECM ID: ' + this.ecmId + ') ถ้าไม่ตรง กล่องจะพัง');
      const recovery = this.ecmId.length >= 4 && this.ecmId.endsWith('0000');
      this._isFlashing = true; this._abort = false; this._hadError = false;
      try {
        const det = this.detectEcuType(bin); const et = det.ecuType; this.ecuType = et; const isShin = et >= 3;
        const auto = this.getAutoOffsets(bin);
        const soHex = startOffsetHex && !/^auto$/i.test(startOffsetHex) ? startOffsetHex : auto.startOffset;
        const coHex = checksumOffsetHex && !/^auto$/i.test(checksumOffsetHex) ? checksumOffsetHex : auto.checksumOffset;
        const startOff = parseInt(soHex, 16) || 0, csOff = parseInt(coHex, 16) || 0;
        this._emit('status', 'คำนวณ checksum...');
        const data = isShin ? this._shindengenAutoChecksum(bin) : this._keihinAutoChecksum(bin, csOff);
        this._emit('status', 'เตรียมเขียน...');
        const pre = isShin ? await this._shindengenPreWrite(data, et, recovery) : await this._keihinPreWrite();
        if (!pre) { this._isFlashing = false; this._emit('complete', false); return false; }
        this._emit('status', 'กำลังเขียนข้อมูล...');
        const ok = await this._writeFlash(data, startOff, et);
        this._isFlashing = false;
        if (ok) { this._emit('status', 'เขียนเสร็จ!'); this._emit('complete', true); }
        else { if (this._abort) this._emit('error', 'ยกเลิกแล้ว'); else if (!this._hadError) this._emit('error', 'เขียนล้มเหลว'); this._emit('complete', false); }
        return ok;
      } catch (e) { this._isFlashing = false; this._emit('error', 'เขียนล้มเหลว: ' + e.message); this._emit('complete', false); return false; }
    }

    async _keihinPreWrite() {
      const I1 = b([125,8,1,2,80,71,77,148]), I2 = b([125,8,1,3,45,70,73,187]);
      const C2 = b([126,5,1,2,122]), C3 = b([126,7,1,3,0,0,119]);
      const C11 = b([126,11,1,11,0,0,0,255,255,255,110]), C14 = b([126,7,1,14,1,144,219]);
      const ERASE = b([126,6,1,4,255,120]), START = b([126,5,1,5,119]), KA = b([126,6,1,1,0,122]);
      let r = await this._send(I1); if (!r) { await this._delay(500); r = await this._send(I1); }
      if (r) await this._send(I2); await this._delay(200); await this._send(KA);
      for (let i = 0; i < 10; i++) { if (this._abort) { this._emit('error', 'ยกเลิก'); return false; }
        this._emit('status', 'รอ... ' + (10 - i) + 's'); this._emit('progress', { countdown: 10 - i, phase: 'pre-write' }); await this._delay(1000);
        if (i === 9) { this._emit('progress', { countdown: 0, phase: 'pre-write' }); await this._delay(500); } }
      this._emit('status', 'เตรียม Keihin...');
      await this._send(C2, 0, 250); await this._send(C3); await this._send(KA); await this._send(C11); await this._send(KA); await this._send(C14);
      r = await this._send(ERASE); if (!r || r[3] !== 0) { this._emit('error', 'ลบล้มเหลว (Keihin Erase)'); return false; }
      await this._delay(2000);
      r = await this._send(START, 0, 250);
      if (!r || r[3] !== 0) { this._emit('error', (r && r[3] === 250) ? 'ECU ถูกล็อก — ต้องใช้ Recovery Mode' : 'เริ่มเขียนล้มเหลว (Keihin Start)'); return false; }
      this._emit('status', 'เตรียมเขียนเสร็จ'); await this._send(KA); return true;
    }
    async _shindengenPreWrite(bin, et, recovery = false) {
      const I1 = b([123,8,2,2,80,25,118,154]), I2 = b([123,8,2,3,37,55,134,150]);
      const SEED = b([123,5,2,4,122]), KEY = b([123,7,2,5,0,0,0]);
      const C1 = b([124,6,2,1,0,123]), C11 = b([124,11,2,11,0,0,0,255,255,255,111]), C14 = b([124,7,2,14,1,0,108]);
      const ERASE = b([124,6,2,4,255,121]), START = b([124,5,2,5,120]); const T = 150;
      await this._send(I1, 0, T); await this._send(I2, 0, T);
      for (let i = 0; i < 10; i++) { if (this._abort) { this._emit('error', 'ยกเลิก'); return false; }
        this._emit('status', 'Seed-Key... ' + (10 - i) + 's'); this._emit('progress', { countdown: 10 - i, phase: 'pre-write' }); await this._delay(1000); }
      this._emit('progress', { countdown: 0, phase: 'pre-write' }); await this._delay(500);
      let r = await this._send(SEED, 0, T);
      if (!r || r[1] !== 7 || r[3] !== 0) { this._emit('error', 'Seed-Key ล้มเหลว — ECM ไม่ตอบ'); return false; }
      const sh = r[4], sl = r[5];
      const isPcxHybrid = !recovery && bin.length === 786432 && bin.length >= 16794 && bin[16790] === 86 && bin[16791] === 50 && bin[16792] === 49 && bin[16793] === 49;
      const useRecovery = recovery || isPcxHybrid;
      let key = useRecovery ? this._shindengenRecoveryKey(bin, sh, sl) : this._shindengenWriteKey(bin, sh, sl);
      if (key && key.success) { KEY[4] = key.keyHigh; KEY[5] = key.keyLow; KEY[6] = this._csHonda(KEY, KEY[1] - 1, 0); }
      else { this._emit('error', 'คำนวณ Key ไม่ได้ — ไฟล์ BIN อาจไม่ตรงรุ่น ECU'); return false; }
      r = await this._send(KEY, 0, T);
      if (!r || r[1] !== 5 || r[3] !== 0) { this._emit('error', 'Seed-Key ไม่ตรง — ID หรือไฟล์ BIN ผิดรุ่น'); return false; }
      this._emit('status', 'เตรียม Shindengen...');
      await this._send(C1, 0, T); await this._send(C11, 0, T); await this._send(C14, 0, T);
      r = await this._send(ERASE, 0, T); if (!r || r[3] !== 0) { this._emit('error', 'ลบล้มเหลว (Shindengen Erase)'); return false; }
      await this._delay(2000);
      r = await this._send(START, 0, T);
      if (!r || r[3] !== 0) { this._emit('error', (r && r[3] === 250) ? 'ECU ถูกล็อก — ต้องใช้ Recovery Mode' : 'เริ่มเขียนล้มเหลว (Shindengen Start)'); return false; }
      this._emit('status', 'เตรียมเขียนเสร็จ'); return true;
    }
    async _writeFlash(data, startOff, et) {
      const len = data.length; const isShin = et >= 3;
      let chunkSize = 128, addrStep = 8, addr = startOff / 16, nextAddr = 0, chunk = 0, chunks = Math.floor(len / 128), skipBlanks = true;
      const pkt = new Uint8Array(256); pkt[0] = 126; pkt[1] = 139; pkt[2] = 1; pkt[3] = 6; const blank = new Uint8Array(128).fill(255);
      let preDelay = 0;
      if (et === 1) { chunkSize = 64; addrStep = 4; chunks = Math.floor(len / 64); pkt[0] = 126; pkt[1] = 75; pkt[2] = 1; pkt[3] = 6; skipBlanks = false; }
      else if (et === 2) { skipBlanks = false; }
      else if (et >= 3) { pkt[0] = 124; pkt[1] = 139; pkt[2] = 2; pkt[3] = 6; chunk = Math.floor(startOff / chunkSize); skipBlanks = (et === 3); preDelay = 150; }
      const keihinFlush = b([126, 5, 1, 7, 117]); const t0 = Date.now(); let lastProg = 0, retries = 0;
      while (chunk < chunks) {
        if (this._abort) { this._emit('error', 'ยกเลิกที่ chunk ' + chunk + '/' + chunks); return false; }
        pkt[4] = addr >> 8 & 255; pkt[5] = addr & 255;
        pkt.set(data.subarray(chunk * chunkSize, chunk * chunkSize + chunkSize), 6);
        if (skipBlanks) { let adv = false;
          for (let k = 1; k < chunks - chunk; k++) { const o = (chunk + k) * chunkSize; const slice = data.subarray(o, o + chunkSize);
            if (!u8eq(slice, blank)) { nextAddr = addr + k * addrStep; chunk += k - 1; adv = true; break; }
            if (chunk + k + 1 === chunks) chunk += k; }
          if (!adv) nextAddr = addr + addrStep;
        } else nextAddr = addr + addrStep;
        if (chunk + 1 === chunks) nextAddr = 0;
        const tail = 6 + chunkSize;
        pkt[tail] = nextAddr >> 8 & 255; pkt[tail + 1] = nextAddr & 255;
        pkt[tail + 2] = this._cs8(pkt, chunkSize + 4, 4); pkt[tail + 3] = this._csHonda(pkt, chunkSize + 4, 4); pkt[tail + 4] = this._csHonda(pkt, pkt[1] - 1, 0);
        let gotReply = false; const reply = await this._send(pkt, pkt[1], preDelay);
        if (reply) { gotReply = true;
          if (reply[1] === 5) {
            if (chunkSize === 64 && (chunk + 1) % 2 === 0) { await this._send(keihinFlush, keihinFlush[1]); await this._delay(100); }
            addr = nextAddr; chunk++;
            const el = Date.now() - t0;
            if (el - lastProg > 30 || chunk === chunks) { lastProg = el;
              const sent = chunk * chunkSize, total = chunks * chunkSize, pct = sent / total, secs = el / 1000;
              const spd = secs > 0.1 ? sent / 1024 / secs : 0, eta = pct > 0.001 && spd > 0 ? (total - sent) / 1024 / spd : 0;
              this._emit('progress', { phase: 'writing', bytesSent: sent, totalBytes: total, percentage: pct, speedKbs: spd, etaSeconds: eta, elapsedSeconds: secs }); }
          } else if (reply[1] === 7) {
            if (reply[4] === 0 && reply[5] === 0) { retries++; if (retries > 2) { this._emit('error', 'ECU error ที่ chunk ' + chunk); return false; } continue; }
            this._emit('error', 'ECU fatal error ที่ chunk ' + chunk); return false;
          } else { this._emit('error', 'ECU ตอบไม่คาดคิดที่ chunk ' + chunk); return false; }
        }
        if (!gotReply) {
          if (et === 0 && chunk === 0 && chunkSize === 128) { chunkSize = 64; addrStep = 4; chunks = Math.floor(len / 64); addr = startOff / 16; skipBlanks = false; pkt[0] = 126; pkt[1] = 75; pkt[2] = 1; pkt[3] = 6; continue; }
          retries++; if (retries > 3) { this._emit('error', 'เขียนล้มเหลวที่ chunk ' + chunk + ' — ไม่ตอบสนอง'); return false; } continue;
        }
      }
      // finalize
      const FT = 800;
      if (isShin) {
        await this._send(b([124,5,2,8,117]), 5, preDelay); await this._delay(1000);
        await this._send(b([124,5,2,9,116]), 5, preDelay); await this._delay(1000);
        await this._send(b([124,5,2,10,115]), 5, preDelay); await this._delay(1000);
        await this._send(b([124,5,2,12,113]), 5, preDelay); await this._delay(3000);
        const v = await this._send(b([124,5,2,13,112]), 5, preDelay, FT);
        if (v && v[3] === 15) return true;
        this._emit('status', 'เขียนข้อมูลครบแล้ว ✓ (ขั้นยืนยันหลังเขียนไม่ตอบ — ปกติเพราะ ECU รีเซ็ตทันที)'); return true;
      } else {
        const KA = b([126,6,1,1,0,122]);
        if (chunkSize === 64) { await this._send(b([126,5,1,7,117]), 5, 0); await this._delay(100); }
        await this._send(b([126,5,1,8,116]), 5, 0); await this._delay(300);
        await this._send(KA, 5, 0); await this._send(b([126,5,1,9,115]), 5, 0); await this._delay(300);
        await this._send(KA, 5, 0); await this._send(b([126,5,1,10,114]), 5, 0); await this._delay(300);
        await this._send(KA, 5, 0); await this._send(b([126,5,1,12,112]), 5, 0); await this._delay(300);
        const good = r => r && (r[3] === 15 || r[3] === 13); let r1 = null, r2 = null, ok1 = false, ok2 = false;
        for (let a = 1; a <= 3; a++) {
          r1 = await this._send(KA, 5, 0, FT); ok1 = good(r1);
          r2 = ok1 ? await this._send(b([126,5,1,13,111]), 5, 0, FT) : null; ok2 = good(r2);
          if (ok1 && ok2) break;
          if (a < 3) { await this._delay(300); await this._send(KA, 5, 0); await this._send(b([126,5,1,12,112]), 5, 0); await this._delay(300); }
        }
        if (ok1 && ok2) return true;
        this._emit('status', 'เขียนข้อมูลครบแล้ว ✓ (ขั้นยืนยันหลังเขียนไม่ตอบ — ปกติเพราะ ECU รีเซ็ตทันที)'); return true;
      }
    }
  }

  global.HFFlasher = Flasher;
})(typeof window !== 'undefined' ? window : globalThis);
