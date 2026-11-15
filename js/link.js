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
    // user-gesture entry: choose a transport and pair a device
    async choose(prefer) {
      // prefer: 'ftdi' | 'serial' | undefined(auto)
      const caps = this.capabilities();
      let order = prefer === 'serial' ? ['serial', 'ftdi']
                : prefer === 'ftdi'   ? ['ftdi', 'serial']
                : ['ftdi', 'serial']; // auto: FTDI-WebUSB first (works on Android)
      let lastErr = null;
      for (const k of order) {
        if (k === 'ftdi' && caps.usb) {
          const b = new FtdiUsb();
          try { if (await b.request()) { this.backend = b; this.kind = 'ftdi'; return true; } }
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
      if (caps.usb) { const b = new FtdiUsb(); if (await b.pickPaired()) { this.backend = b; this.kind = 'ftdi'; return true; } }
      if (caps.serial) { const b = new WebSerial(); if (await b.pickPaired()) { this.backend = b; this.kind = 'serial'; return true; } }
      return false;
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

  global.HFLink = Link;
})(typeof window !== 'undefined' ? window : globalThis);
