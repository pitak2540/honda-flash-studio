'use strict';
/* Honda Flash Studio Mobile — serial transport layer (browser).
 * Two back-ends behind one interface:
 *   - FTDI over WebUSB  (Android Chrome: the FT232 cable is NOT a serial port there)
 *   - Web Serial        (desktop Chrome, or any CDC/VCP cable the OS exposes)
 * Exposes byte-level primitives identical to what the ported ecu/flash logic needs:
 *   open(baud) / write(bytes) / rx (Uint8Array) / clearRx() / purge() /
 *   setBreak(on) / setRTS(on) / close() / isOpen
 * 10400 8N1, RTS high — same as the desktop app.
 */
(function (global) {

  // ---- shared rx ring ----
  function makeRx() {
    return { buf: new Uint8Array(0) };
  }
  function appendRx(state, chunk) {
    if (!chunk || !chunk.length) return;
    const n = state.buf.length + chunk.length;
    const next = new Uint8Array(n);
    next.set(state.buf, 0); next.set(chunk, state.buf.length);
    // cap at 1 MiB (keep tail) — matches desktop behaviour
    state.buf = n > 1048576 ? next.subarray(n - 524288).slice() : next;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ============================================================= *
   *  FTDI WebUSB back-end
   * ============================================================= */
  const FTDI_REQ = {
    RESET: 0x00, SET_MODEM_CTRL: 0x01, SET_FLOW_CTRL: 0x02,
    SET_BAUDRATE: 0x03, SET_DATA: 0x04, SET_LATENCY: 0x09
  };
  // FT232-class divisor (3 MHz base), fractional code table (eighths -> code)
  function ftdiDivisor(baud) {
    const base = 3000000;
    const frac = [0, 3, 2, 4, 1, 5, 6, 7];
    let divInt = Math.floor(base / baud);
    let rem = base - divInt * baud;
    let e = Math.round(rem * 8 / baud);
    if (e > 7) { divInt++; e = 0; }
    const value = (divInt | (frac[e] << 14)) >>> 0;
    return { wValue: value & 0xFFFF, wIndex: (value >> 16) & 0xFFFF };
  }

  class FtdiUsb {
    constructor() { this.dev = null; this.inEp = 0x81; this.outEp = 0x02; this.iface = 0;
      this._rx = makeRx(); this._reading = false; this._open = false; this._pktDelayBytes = 64; }

    static supported() { return !!(global.navigator && navigator.usb); }

    async request() {
      // must be called from a user gesture
      this.dev = await navigator.usb.requestDevice({ filters: [
        { vendorId: 0x0403, productId: 0x6001 }, // FT232R / FT232BM
        { vendorId: 0x0403, productId: 0x6010 }, // FT2232
        { vendorId: 0x0403, productId: 0x6014 }, // FT232H
        { vendorId: 0x0403, productId: 0x6015 }, // FT-X
        { vendorId: 0x0403 }
      ] });
      return !!this.dev;
    }
    async pickPaired() {
      if (!navigator.usb.getDevices) return false;
      const list = await navigator.usb.getDevices();
      this.dev = list.find(d => d.vendorId === 0x0403) || null;
      return !!this.dev;
    }

    async _ctrlOut(request, value, index) {
      return this.dev.controlTransferOut({ requestType: 'vendor', recipient: 'device',
        request, value, index });
    }

    async open(baud) {
      if (!this.dev) throw new Error('ยังไม่ได้เลือกสาย USB');
      await this.dev.open();
      if (this.dev.configuration === null) await this.dev.selectConfiguration(1);
      // find bulk endpoints on the first interface
      const cfg = this.dev.configuration;
      let chosen = null;
      for (const itf of cfg.interfaces) {
        const alt = itf.alternates[0];
        const bin = alt.endpoints.find(e => e.direction === 'in' && e.type === 'bulk');
        const bout = alt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
        if (bin && bout) { chosen = { n: itf.interfaceNumber, in: bin.endpointNumber | 0x80, out: bout.endpointNumber }; break; }
      }
      if (!chosen) throw new Error('ไม่พบ endpoint ของ FTDI');
      this.iface = chosen.n; this.inEp = chosen.in; this.outEp = chosen.out;
      try { await this.dev.claimInterface(this.iface); }
      catch (e) { throw new Error('จับ interface ไม่ได้ (ไดรเวอร์ FTDI อาจจับอยู่): ' + e.message); }

      // SIO reset, latency, baud, 8N1, RTS high
      await this._ctrlOut(FTDI_REQ.RESET, 0, this.iface + 1);        // reset SIO
      await this._ctrlOut(FTDI_REQ.SET_LATENCY, 2, this.iface + 1);  // 2 ms latency
      const d = ftdiDivisor(baud);
      await this._ctrlOut(FTDI_REQ.SET_BAUDRATE, d.wValue, d.wIndex || (this.iface + 1));
      await this._ctrlOut(FTDI_REQ.SET_DATA, 0x0008, this.iface + 1); // 8 data, no parity, 1 stop
      await this._ctrlOut(FTDI_REQ.SET_FLOW_CTRL, 0, this.iface + 1); // no flow control
      await this._ctrlOut(FTDI_REQ.SET_MODEM_CTRL, 0x0202, this.iface + 1); // RTS on
      this._open = true; this._rx = makeRx();
      this._startRead();
    }

    _startRead() {
      if (this._reading) return; this._reading = true;
      const loop = async () => {
        while (this._reading && this._open) {
          try {
            const r = await this.dev.transferIn(this.inEp & 0x0f, 64);
            if (r && r.data && r.data.byteLength > 2) {
              // FTDI prepends 2 modem-status bytes to every IN packet — strip them
              const bytes = new Uint8Array(r.data.buffer, r.data.byteOffset + 2, r.data.byteLength - 2);
              appendRx(this._rx, bytes.slice());
            }
          } catch (e) { if (this._open) await sleep(4); else break; }
        }
      };
      loop();
    }

    get rx() { return this._rx.buf; }
    clearRx() { this._rx.buf = new Uint8Array(0); }
    get isOpen() { return this._open; }

    async write(bytes) {
      if (!this._open) throw new Error('พอร์ตปิดอยู่');
      const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
      await this.dev.transferOut(this.outEp & 0x0f, u8);
    }
    async setBreak(on) { if (this._open) await this._ctrlOut(FTDI_REQ.SET_DATA, on ? 0x4008 : 0x0008, this.iface + 1); }
    async setRTS(on)   { if (this._open) await this._ctrlOut(FTDI_REQ.SET_MODEM_CTRL, on ? 0x0202 : 0x0200, this.iface + 1); }
    async purge()      { this.clearRx(); if (this._open) { try { await this._ctrlOut(FTDI_REQ.RESET, 1, this.iface + 1); await this._ctrlOut(FTDI_REQ.RESET, 2, this.iface + 1); } catch {} } }
    async close() {
      this._reading = false; this._open = false;
      try { await this.dev.releaseInterface(this.iface); } catch {}
      try { await this.dev.close(); } catch {}
    }
  }

  /* ============================================================= *
   *  Tactrix OpenPort 2.0 back-end (WebUSB, CDC data interface)
   *  Wire protocol per bisak/openport-j2534 docs/PROTOCOL.md (measured on
   *  firmware 1.17 + Tactrix DLL). USB 0403:cc4d, bulk OUT 0x02 / IN 0x82.
   *  Host -> cable : "at<verb><ch> <args> <seq>\r\n" [+ payload bytes]
   *  Cable -> host : "ar<verb> ... <seq>\r\n"   (ASCII reply)
   *                  'a''r'<ch digit><len><status><payload> (binary frame)
   *  K-line is driven as ISO14230 channel 4 with ISO9141_NO_CHECKSUM (our
   *  frames already carry Honda checksums) and LOOPBACK so our own TX is
   *  echoed into rx exactly like the FTDI/K-line path expects.
   *  Honda's 70 ms BREAK wake-up = ground pin 7 (atv 7 -2) then release (atv 7 -1).
   * ============================================================= */
  const OP_VID = 0x0403, OP_PID = 0xcc4d;
  class OpenPortUsb {
    constructor(dev) { this.dev = dev || null; this.iface = 1; this.inEp = 0x82; this.outEp = 0x02; this.ch = 4;
      this._rx = makeRx(); this._reading = false; this._open = false; this._buf = new Uint8Array(0);
      this._seq = 256; this._pending = new Map(); this._log = []; }
    static supported() { return !!(global.navigator && navigator.usb); }
    static isOpenPort(dev) { return !!dev && dev.vendorId === OP_VID && dev.productId === OP_PID; }

    async request() {
      this.dev = await navigator.usb.requestDevice({ filters: [{ vendorId: OP_VID, productId: OP_PID }] });
      return !!this.dev;
    }
    async pickPaired() {
      if (!navigator.usb.getDevices) return false;
      const list = await navigator.usb.getDevices();
      this.dev = list.find(OpenPortUsb.isOpenPort) || null; return !!this.dev;
    }

    async open(baud) {
      if (!this.dev) throw new Error('ยังไม่ได้เลือกสาย OpenPort');
      await this.dev.open();
      if (this.dev.configuration === null) await this.dev.selectConfiguration(1);
      // the CDC data interface: the one with a bulk IN + bulk OUT pair
      let chosen = null;
      for (const itf of this.dev.configuration.interfaces) {
        const alt = itf.alternates[0];
        const bin = alt.endpoints.find(e => e.direction === 'in' && e.type === 'bulk');
        const bout = alt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
        if (bin && bout) { chosen = { n: itf.interfaceNumber, in: bin.endpointNumber, out: bout.endpointNumber }; break; }
      }
      if (!chosen) throw new Error('ไม่พบ data interface ของ OpenPort (ถ้าเสียบ microSD อยู่ ให้ถอดออก)');
      this.iface = chosen.n; this.inEp = chosen.in; this.outEp = chosen.out;
      try { await this.dev.claimInterface(this.iface); }
      catch (e) { throw new Error('จับ interface ของ OpenPort ไม่ได้ (' + e.message + ')'); }
      this._open = true; this._buf = new Uint8Array(0); this._rx = makeRx(); this._pending.clear();
      this._startRead();
      // sync: end any half line, reset, close all, identify (PROTOCOL.md §4/§9.1)
      await this._raw('\r\n\r\n'); await sleep(60);
      await this._cmd('atz', null, 1500); await this._cmd('ata', null, 1500);
      await this._raw('ati\r\n'); await sleep(250);
      // open K-line: ISO14230 (ch4) · flags 0x1000 K_LINE_ONLY | 0x200 NO_CHECKSUM, fall back to NO_CHECKSUM only
      let r = await this._cmd('ato4 4608 ' + (baud || 10400) + ' 0', null, 2000);
      if (!r.ok) r = await this._cmd('ato4 512 ' + (baud || 10400) + ' 0', null, 2000);
      if (!r.ok) { await this.close().catch(() => {}); throw new Error('OpenPort เปิด K-line ไม่ได้ (are ' + r.code + ') — ตรวจว่าเสียบ OBD/มีไฟ 12V'); }
      await this._cmd('ats4 3 1', null, 1500);                       // LOOPBACK → echo our TX like FTDI
      await this._cmd('atf4 1 0 1', Uint8Array.of(0, 0), 1500);       // PASS filter: mask 00 / pattern 00
      this.clearRx();
    }

    // ---- command plumbing ----
    async _raw(text) { if (!this._open) throw new Error('Port closed'); await this.dev.transferOut(this.outEp, new TextEncoder().encode(text)); }
    _cmd(line, payload, timeoutMs) {
      if (!this._open) return Promise.resolve({ ok: false, code: -1, line: 'closed' });
      const seq = this._seq++; if (this._seq > 2000000000) this._seq = 256;
      const head = new TextEncoder().encode(line + ' ' + seq + '\r\n');
      let out = head;
      if (payload && payload.length) { out = new Uint8Array(head.length + payload.length); out.set(head, 0); out.set(payload, head.length); }
      return new Promise(resolve => {
        const t = setTimeout(() => { this._pending.delete(seq); resolve({ ok: false, code: 9, line: 'timeout', seq }); }, timeoutMs || 1500);
        this._pending.set(seq, { resolve: r => { clearTimeout(t); resolve(r); } });
        this.dev.transferOut(this.outEp, out).catch(e => { clearTimeout(t); this._pending.delete(seq); resolve({ ok: false, code: -2, line: String(e && e.message || e), seq }); });
      });
    }

    // ---- stream parser (ASCII replies + binary frames interleave) ----
    _startRead() {
      if (this._reading) return; this._reading = true;
      const loop = async () => {
        while (this._reading && this._open) {
          try { const r = await this.dev.transferIn(this.inEp, 64);
            if (r && r.data && r.data.byteLength) this._feed(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength).slice()); }
          catch (e) { if (this._open) await sleep(4); else break; }
        }
      };
      loop();
    }
    _feed(bytes) {
      const n = this._buf.length + bytes.length; const nb = new Uint8Array(n); nb.set(this._buf, 0); nb.set(bytes, this._buf.length); this._buf = nb;
      for (;;) {
        const b = this._buf;
        if (b.length < 3) return;
        if (b[0] !== 0x61 || b[1] !== 0x72) { this._buf = b.subarray(1); continue; }   // resync on 'a','r'
        const b2 = b[2];
        if (b2 >= 0x30 && b2 <= 0x39) {                                               // binary frame
          if (b.length < 4) return; const len = b[3]; if (b.length < 4 + len) return;
          const status = b[4], payload = b.subarray(5, 4 + len).slice();
          this._frame(String.fromCharCode(b2), status, payload);
          this._buf = b.subarray(4 + len); continue;
        }
        let nl = -1; for (let i = 2; i < b.length; i++) if (b[i] === 0x0a) { nl = i; break; }   // ASCII reply
        if (nl < 0) { if (b.length > 512) this._buf = new Uint8Array(0); return; }
        const line = String.fromCharCode.apply(null, b.subarray(0, nl)).replace(/\r$/, '');
        this._reply(line); this._buf = b.subarray(nl + 1);
      }
    }
    _reply(line) {
      this._log.push(line); if (this._log.length > 50) this._log.shift();
      const parts = line.trim().split(/\s+/); const verb = (parts[0] || '').slice(2, 3);
      if (verb === 'i') return;                                                       // 'ari ...' version text (unnumbered)
      const last = parts[parts.length - 1]; const seq = /^\d+$/.test(last) ? parseInt(last) : null;
      if (seq == null || !this._pending.has(seq)) return;
      const p = this._pending.get(seq); this._pending.delete(seq);
      if (verb === 'e') p.resolve({ ok: false, code: parseInt(parts[1]) || 7, line, seq });
      else p.resolve({ ok: true, code: 0, line, seq, verb });
    }
    _frame(ch, status, payload) {
      // K-line (PROTOCOL.md §7.9): 0x00 data / 0x20 loopback data carry the raw bytes;
      // 0x80/0xA0 start, 0x40/0x60 end and 0x10 carry only a timestamp → ignore them.
      if (status === 0x00 || status === 0x20) appendRx(this._rx, payload);
    }

    get rx() { return this._rx.buf; }
    clearRx() { this._rx.buf = new Uint8Array(0); }
    get isOpen() { return this._open; }
    async write(bytes) {
      const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
      // budget 1 s on the bus (what Tactrix's DLL sends); the cable answers aro <seq> once sent
      const r = await this._cmd('att' + this.ch + ' ' + u8.length + ' 0 1000000', u8, 2500);
      if (!r.ok && r.code !== 9) throw new Error('OpenPort ส่งไม่ได้ (are ' + r.code + ')');
    }
    async setBreak(on) { if (!this._open) return; await this._cmd(on ? 'atv 7 -2' : 'atv 7 -1', null, 1000); }   // ground / release K
    async setRTS() { /* not applicable */ }
    async purge() { this.clearRx(); }
    async close() {
      const wasOpen = this._open;
      try { if (wasOpen) { await this._cmd('atc' + this.ch, null, 800); await this._cmd('atz', null, 800); } } catch {}
      this._reading = false; this._open = false;
      for (const [, p] of this._pending) p.resolve({ ok: false, code: -1, line: 'closed' }); this._pending.clear();
      try { await this.dev.releaseInterface(this.iface); } catch {}
      try { await this.dev.close(); } catch {}
    }
  }

  /* ============================================================= *
   *  Web Serial back-end
   * ============================================================= */
  class WebSerial {
    constructor() { this.port = null; this.reader = null; this.writer = null;
      this._rx = makeRx(); this._reading = false; this._open = false; }
    static supported() { return !!(global.navigator && navigator.serial); }

    async request() {
      this.port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x0403 }] });
      return !!this.port;
    }
    async pickPaired() {
      if (!navigator.serial.getPorts) return false;
      const list = await navigator.serial.getPorts();
      this.port = list[0] || null; return !!this.port;
    }
    async open(baud) {
      if (!this.port) throw new Error('ยังไม่ได้เลือกพอร์ต');
      await this.port.open({ baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
      try { await this.port.setSignals({ requestToSend: true, dataTerminalReady: true }); } catch {}
      this._open = true; this._rx = makeRx();
      this.writer = this.port.writable.getWriter();
      this._startRead();
    }
    _startRead() {
      if (this._reading) return; this._reading = true;
      const loop = async () => {
        while (this._reading && this._open && this.port.readable) {
          try {
            this.reader = this.port.readable.getReader();
            while (true) { const { value, done } = await this.reader.read();
              if (done) break; if (value && value.length) appendRx(this._rx, value); }
          } catch (e) { /* stream glitch */ }
          finally { try { this.reader.releaseLock(); } catch {} }
          if (!this._open) break; await sleep(2);
        }
      };
      loop();
    }
    get rx() { return this._rx.buf; }
    clearRx() { this._rx.buf = new Uint8Array(0); }
    get isOpen() { return this._open; }
    async write(bytes) { const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes); await this.writer.write(u8); }
    async setBreak(on) { try { await this.port.setSignals({ break: on }); } catch {} }
    async setRTS(on)   { try { await this.port.setSignals({ requestToSend: on }); } catch {} }
    async purge()      { this.clearRx(); }
    async close() {
      this._reading = false; this._open = false;
      try { if (this.reader) await this.reader.cancel(); } catch {}
      try { if (this.writer) this.writer.releaseLock(); } catch {}
      try { await this.port.close(); } catch {}
    }
  }

  /* ============================================================= *
   *  Unified Link
   * ============================================================= */
  const Link = {
    backend: null,       // active back-end instance
    kind: null,          // 'ftdi' | 'serial'

    capabilities() {
      return { usb: FtdiUsb.supported(), serial: WebSerial.supported() };
    },
    // route a picked USB device to the right back-end by its product id
    _usbBackend(dev) {
      if (OpenPortUsb.isOpenPort(dev)) { const b = new OpenPortUsb(dev); this.backend = b; this.kind = 'openport'; return b; }
      const b = new FtdiUsb(); b.dev = dev; this.backend = b; this.kind = 'ftdi'; return b;
    },
    // user-gesture entry: choose a transport and pair a device
    async choose(prefer) {
      // prefer: 'ftdi' | 'openport' | 'serial' | undefined(auto)
      const caps = this.capabilities();
      let order = prefer === 'serial' ? ['serial', 'usb']
                : prefer === 'ftdi' || prefer === 'openport' ? ['usb', 'serial']
                : ['usb', 'serial']; // auto: WebUSB first (works on Android)
      let lastErr = null;
      for (const k of order) {
        if (k === 'usb' && caps.usb) {
          const filters = prefer === 'openport' ? [{ vendorId: OP_VID, productId: OP_PID }]
            : prefer === 'ftdi' ? [{ vendorId: 0x0403, productId: 0x6001 }, { vendorId: 0x0403, productId: 0x6010 }, { vendorId: 0x0403, productId: 0x6014 }, { vendorId: 0x0403, productId: 0x6015 }, { vendorId: 0x0403 }]
            : [{ vendorId: 0x0403, productId: 0x6001 }, { vendorId: 0x0403, productId: 0x6010 }, { vendorId: 0x0403, productId: 0x6014 }, { vendorId: 0x0403, productId: 0x6015 }, { vendorId: OP_VID, productId: OP_PID }, { vendorId: 0x0403 }];
          try { const dev = await navigator.usb.requestDevice({ filters }); if (dev) { this._usbBackend(dev); return true; } }
          catch (e) { lastErr = e; }
        }
        if (k === 'serial' && caps.serial) {
          const b = new WebSerial();
          try { if (await b.request()) { this.backend = b; this.kind = 'serial'; return true; } }
          catch (e) { lastErr = e; }
        }
      }
      if (lastErr) throw lastErr;
      throw new Error('เบราว์เซอร์นี้ไม่รองรับ WebUSB/Web Serial — ใช้ Chrome บน Android หรือเดสก์ท็อป');
    },
    async reconnectPaired() {
      const caps = this.capabilities();
      if (caps.usb && navigator.usb.getDevices) {
        const list = await navigator.usb.getDevices();
        const dev = list.find(d => d.vendorId === 0x0403); if (dev) { this._usbBackend(dev); return true; }
      }
      if (caps.serial) { const b = new WebSerial(); if (await b.pickPaired()) { this.backend = b; this.kind = 'serial'; return true; } }
      return false;
    },
    deviceLabel() {
      if (!this.backend) return '';
      if (this.kind === 'openport') return 'Tactrix OpenPort 2.0';
      if (this.kind === 'ftdi') return 'FTDI K-line';
      return 'Serial';
    },

    async open(baud) { return this.backend.open(baud || 10400); },
    get rx() { return this.backend ? this.backend.rx : new Uint8Array(0); },
    clearRx() { if (this.backend) this.backend.clearRx(); },
    get isOpen() { return !!(this.backend && this.backend.isOpen); },
    async write(b) { return this.backend.write(b); },
    async setBreak(on) { return this.backend.setBreak(on); },
    async setRTS(on) { return this.backend.setRTS(on); },
    async purge() { return this.backend.purge(); },
    async close() { if (this.backend) { await this.backend.close(); } }
  };

  Link._OpenPortUsb = OpenPortUsb; Link._FtdiUsb = FtdiUsb;
  global.HFLink = Link;
})(typeof window !== 'undefined' ? window : globalThis);
