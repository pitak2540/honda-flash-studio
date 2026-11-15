'use strict';
/* Honda Flash Studio Mobile — UI wiring */
(function () {
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const Ecu = window.HFEcu, Link = window.HFLink;
  const flasher = new window.HFFlasher();

  const TITLES = { overview:'ภาพรวม', firmware:'เฟิร์มแวร์', flashecu:'แฟลช ECU', maptune:'ตารางจูน', diag:'วิเคราะห์', history:'ประวัติ', settings:'ตั้งค่า' };

  const state = { bin: null, binName: '', binInfo: null, gaugeMode: 'digital', flashing: false };
  try { state.gaugeMode = localStorage.getItem('hfs-gaugemode') || 'digital'; } catch {}

  /* ---------- navigation ---------- */
  function go(screen) {
    if (screen === 'more') { openSheet(); return; }
    $$('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === screen));
    $$('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.go === screen));
    $('#pageTitle').textContent = TITLES[screen] || '';
    closeSheet();
    window.scrollTo(0, 0);
    if (screen === 'flashecu') onEnterFlash();
    else if (prevScreen === 'flashecu' && !state.flashing) resumeLive();
    if (screen === 'diag') buildGauges();
    if (screen === 'maptune') onEnterMap();
    prevScreen = screen;
  }
  let prevScreen = 'overview';
  $$('.navbtn').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
  $$('.sheetitem').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
  function openSheet() { $('#moreSheet').hidden = false; }
  function closeSheet() { $('#moreSheet').hidden = true; }
  $('#moreSheet .sheet-bg').addEventListener('click', closeSheet);

  /* ---------- popup ---------- */
  function popup(title, msg, bad) {
    $('#popupTitle').textContent = title; $('#popupMsg').textContent = msg || '';
    const ic = $('#popupIcon'); ic.textContent = bad ? '✕' : '✓'; ic.classList.toggle('bad', !!bad);
    $('#popup').hidden = false;
  }
  $('#popupOk').addEventListener('click', () => $('#popup').hidden = true);

  /* ---------- connection pill ---------- */
  function setPill(mode, text) { const p = $('#connState'); p.className = 'connpill ' + mode; p.textContent = text; }

  /* ---------- part number from filename + box map ---------- */
  function partFromFile(f) {
    const m = /(3\d{4}-?K[0-9A-Z]{1,3}-?[0-9A-Za-z]{2,4})/.exec(f || '');
    if (!m) return '';
    let p = m[1].toUpperCase().replace(/[_ ]/g, '-');
    p = p.replace(/^(3\d{4})-?(K[0-9A-Z]{1,3})-?([0-9A-Z]{2,4}).*$/, '$1-$2-$3');
    return p;
  }
  function boxPart(id) { try { return id ? (localStorage.getItem('hfs-boxpart-' + id) || '') : ''; } catch { return ''; } }
  function setBoxPart(id, p) { try { if (id && p) localStorage.setItem('hfs-boxpart-' + id, p); } catch {} }

  /* ---------- jobs (history) ---------- */
  function loadJobs() { try { return JSON.parse(localStorage.getItem('hfs-jobs') || '[]'); } catch { return []; } }
  function saveJobs(j) { try { localStorage.setItem('hfs-jobs', JSON.stringify(j.slice(0, 50))); } catch {} }
  function addJob(type, file, status, ok) {
    const j = loadJobs(); j.unshift({ type, file, status, ok, t: Date.now() }); saveJobs(j); renderJobs();
  }
  function jobRow(j) {
    const d = new Date(j.t); const ts = d.toLocaleString('th-TH', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    const cls = j.ok === false ? 'bad' : (j.ok === true ? 'ok' : '');
    const ic = j.ok === false ? '✗' : (j.ok === true ? '✓' : '•');
    return `<div class="jobrow ${cls}"><span class="ji">${ic}</span><div class="jb"><b>${j.type}</b><small>${j.file || ''} · ${j.status || ''}</small></div><span class="jt">${ts}</span></div>`;
  }
  function renderJobs() {
    const j = loadJobs();
    const html = j.length ? j.map(jobRow).join('') : '<div class="empty">ยังไม่มีประวัติ</div>';
    const recent = j.length ? j.slice(0, 4).map(jobRow).join('') : '<div class="empty">ยังไม่มีประวัติ</div>';
    $('#histBody').innerHTML = html; $('#ovJobs').innerHTML = recent;
  }
  $('#histClear').addEventListener('click', () => { saveJobs([]); renderJobs(); });

  /* ---------- gauges ---------- */
  const GAUGES = [
    { k:'rpm', label:'รอบเครื่อง', unit:'rpm', min:0, max:14000 },
    { k:'ect', label:'อุณหภูมิน้ำ', unit:'°C', min:0, max:150 },
    { k:'tps', label:'ลิ้นเร่ง', unit:'%', min:0, max:100 },
    { k:'tpsV', label:'TPS', unit:'V', min:0, max:5 },
    { k:'bat', label:'แรงดันไฟ', unit:'V', min:0, max:16 },
    { k:'inj', label:'หัวฉีด', unit:'ms', min:0, max:20 },
    { k:'ign', label:'องศาไฟ', unit:'°', min:-10, max:50 },
    { k:'afr', label:'AFR', unit:'λ', min:10, max:20 }
  ];
  const DIAL = { r:48, cx:60, cy:70, len:150.8 }; // semicircle path length
  function buildGauges() {
    const wrap = $('#gauges'); if (!wrap) return;
    wrap.innerHTML = GAUGES.map(g => {
      if (state.gaugeMode === 'analog') {
        return `<div class="gauge analog" data-k="${g.k}">
          <div class="g-top"><span class="g-name">${g.label}</span><span class="g-val" id="gv-${g.k}">0<small> ${g.unit}</small></span></div>
          <div class="g-dialwrap"><svg viewBox="0 0 120 80">
            <path d="M12,70 A48,48 0 0,1 108,70" fill="none" stroke="#e8ebf0" stroke-width="9" stroke-linecap="round"/>
            <path id="ga-${g.k}" d="M12,70 A48,48 0 0,1 108,70" fill="none" stroke="url(#gg)" stroke-width="9" stroke-linecap="round" stroke-dasharray="${DIAL.len}" stroke-dashoffset="${DIAL.len}"/>
            <defs><linearGradient id="gg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e11b22"/><stop offset="1" stop-color="#d10a11"/></linearGradient></defs>
          </svg></div></div>`;
      }
      return `<div class="gauge" data-k="${g.k}">
        <div class="g-top"><span class="g-name">${g.label}</span><span class="g-val" id="gv-${g.k}">0<small> ${g.unit}</small></span></div>
        <div class="g-bar-wrap"><div class="gbar"><i id="gb-${g.k}"></i></div></div></div>`;
    }).join('');
  }
  function setGaugeMode(m) { state.gaugeMode = m; try { localStorage.setItem('hfs-gaugemode', m); } catch {}
    $$('#gaugeSeg .tbtn').forEach(b => b.classList.toggle('active', b.dataset.mode === m)); buildGauges(); }
  $$('#gaugeSeg .tbtn').forEach(b => b.addEventListener('click', () => setGaugeMode(b.dataset.mode)));

  function updGauges(d) {
    GAUGES.forEach(g => {
      let v = d[g.k]; if (v == null || isNaN(v)) v = g.min;
      const el = $('#gv-' + g.k); if (el) el.innerHTML = fmt(v, g.k) + '<small> ' + g.unit + '</small>';
      const pct = Math.max(0, Math.min(1, (v - g.min) / (g.max - g.min)));
      if (state.gaugeMode === 'analog') { const arc = document.getElementById('ga-' + g.k); if (arc) arc.style.strokeDashoffset = (DIAL.len * (1 - pct)).toFixed(1); }
      else { const bar = document.getElementById('gb-' + g.k); if (bar) bar.style.width = (pct * 100).toFixed(0) + '%'; }
    });
  }
  function fmt(v, k) { if (k === 'rpm') return Math.round(v); if (k === 'tpsV' || k === 'afr' || k === 'inj' || k === 'bat') return Number(v).toFixed(1); return Math.round(v); }

  /* ---------- live data ---------- */
  Ecu.bus.addEventListener('live', e => {
    const d = e.detail;
    // overview mini
    $('#mg-rpm').textContent = Math.round(d.rpm || 0);
    $('#mg-ect').textContent = Math.round(d.ect || 0);
    $('#mg-tps').textContent = Math.round(d.tps || 0);
    $('#mg-afr').textContent = (d.afr != null ? Number(d.afr).toFixed(1) : '0');
    const vv = d.bat; if (vv != null && !isNaN(vv) && Number(vv) > 0) $('#ovVolt').textContent = Number(vv).toFixed(1) + ' V';
    // full gauges
    if ($('.screen[data-screen="diag"]').classList.contains('active')) updGauges(d);
  });
  Ecu.bus.addEventListener('state', e => { paintState(e.detail); });
  Ecu.bus.addEventListener('log', e => { /* reserved */ });

  function paintState(st) {
    const id = st.ecmId || '';
    const code = boxPart(id) || st.fileCode || '';
    if (st.connected) {
      setPill('on', '✓ เชื่อมต่อแล้ว');
      $('#connectBtn').hidden = true; $('#disconnectBtn').hidden = false;
      $('#cc-state').textContent = 'เชื่อมต่อแล้ว';
      $('#cc-sub').textContent = 'ค้างการเชื่อมต่อจนกว่าจะถอดสาย' + (id ? ' · กล่อง ' + id : '');
      $('#cc-ring').style.strokeDashoffset = '0';
      $('#ovVehicle').textContent = code || id || 'เชื่อมต่อแล้ว';
      $('#fl-conn').textContent = 'เชื่อมต่อแล้ว'; $('#fl-id').textContent = id || '—';
    } else {
      setPill('off', 'ยังไม่เชื่อมต่อ');
      $('#connectBtn').hidden = false; $('#disconnectBtn').hidden = true;
      $('#cc-state').textContent = 'พร้อมเชื่อมต่อ';
      $('#cc-sub').textContent = 'เสียบสาย FTDI เข้ามือถือ (OTG) แล้วกดเชื่อมต่อ';
      $('#cc-ring').style.strokeDashoffset = '327';
      $('#fl-conn').textContent = 'ยังไม่เชื่อมต่อ';
    }
  }

  /* ---------- connect / disconnect ---------- */
  $('#connectBtn').addEventListener('click', async () => {
    const prefer = ($('#transportSel') || {}).value || 'auto';
    setPill('busy', 'กำลังเชื่อมต่อ...'); $('#cc-state').textContent = 'กำลังเชื่อมต่อ...';
    try {
      if (!Link.backend) { await Link.choose(prefer === 'auto' ? undefined : prefer); }
      const r = await Ecu.connect();
      if (!r.ok) { setPill('off', 'เชื่อมต่อไม่ได้'); $('#cc-state').textContent = 'เชื่อมต่อไม่ได้';
        popup('เชื่อมต่อไม่สำเร็จ', reason(r.reason), true); }
    } catch (e) {
      setPill('off', 'ยังไม่เชื่อมต่อ'); $('#cc-state').textContent = 'พร้อมเชื่อมต่อ';
      popup('เลือกสายไม่สำเร็จ', e.message || String(e), true);
    }
  });
  $('#disconnectBtn').addEventListener('click', async () => { await Ecu.disconnect(); try { await Link.close(); } catch {} });
  function reason(r) {
    const m = { ECM_NO_RESPONSE:'ECU ไม่ตอบ — เปิดกุญแจ ON และตรวจสาย K-line', NO_FTDI_PORT:'ไม่พบสาย FTDI', PORT_IN_USE:'พอร์ตถูกใช้งานอยู่' };
    return m[r] || r || 'ไม่ทราบสาเหตุ';
  }

  /* ---------- firmware ---------- */
  async function loadStockList() {
    try {
      const r = await fetch('assets/bins/manifest.json'); const list = await r.json();
      const sel = $('#stockSel');
      list.forEach(x => { const o = document.createElement('option'); o.value = x.file; o.textContent = x.label; sel.appendChild(o); });
    } catch {}
  }
  $('#fileInput').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    setBin(buf, f.name);
  });
  $('#stockUse').addEventListener('click', async () => {
    const file = $('#stockSel').value; if (!file) { popup('ยังไม่ได้เลือก', 'เลือกรุ่นก่อนครับ', true); return; }
    try { const r = await fetch('assets/bins/' + encodeURIComponent(file)); const buf = new Uint8Array(await r.arrayBuffer()); setBin(buf, file); }
    catch (e) { popup('โหลดไฟล์ไม่ได้', e.message, true); }
  });
  function setBin(buf, name) {
    state.bin = buf; state.binName = name;
    const det = flasher.detectEcuType(buf);
    let model = ''; for (let i = 1; i < 16; i++) { const c = buf[i]; if (c >= 32 && c < 127) model += String.fromCharCode(c); else break; }
    const types = { 0:'Keihin (auto)', 1:'Keihin', 2:'Keihin 256k', 3:'Shindengen', 4:'Shindengen', 5:'Shindengen SH' };
    state.binInfo = { det, model };
    $('#fx-file').textContent = name;
    $('#fx-size').textContent = (buf.length / 1024).toFixed(0) + ' KB (' + buf.length + ' bytes)';
    $('#fx-det').textContent = types[det.ecuType] || ('type ' + det.ecuType);
    $('#fx-model').textContent = model.length >= 3 ? model : '—';
    $('#fwInfo').hidden = false;
    $('#fl-file').textContent = name;
    // step 2 done
    stepState(2, true);
  }
  $('#toFlash').addEventListener('click', () => go('flashecu'));

  /* ---------- flash ---------- */
  function stepState(n, done) { const el = $(`.step[data-step="${n}"]`); if (el) { el.classList.toggle('done', !!done); } }
  function flog(msg) { const l = $('#flLog'); const d = document.createElement('div'); d.textContent = msg; l.appendChild(d); l.scrollTop = l.scrollHeight; }

  async function onEnterFlash() {
    // reflect connection + file
    const st = Ecu.getState();
    $('#fl-file').textContent = state.binName || '—';
    stepState(1, st.connected); stepState(2, !!state.bin);
    if (st.connected && !state.flashing) {
      // ready the flasher on the shared, open link
      Ecu._stopPolling();
      $('#flStatus').textContent = 'เตรียมพร้อมกล่อง...';
      const info = await flasher.attachAndReadInfo(st.ecmId);
      if (info && info.success) {
        $('#fl-id').textContent = info.ecmId; $('#fl-fc').textContent = info.flashCount;
        $('#flStatus').textContent = 'พร้อมแฟลช'; stepState(1, true);
        if (info.isRecovery) showWarn('⚠ กล่องอยู่ในโหมด Recovery (ID ลงท้าย 0000)');
      } else { $('#flStatus').textContent = 'เตรียมกล่องไม่สำเร็จ — ลองเชื่อมต่อใหม่'; }
    } else if (!st.connected) {
      $('#flStatus').textContent = 'ยังไม่เชื่อมต่อ — ไปหน้าหลักเพื่อเชื่อมต่อก่อน';
    }
  }
  function showWarn(t) { const w = $('#fl-warn'); w.hidden = false; w.textContent = t; }
  async function resumeLive() { try { if (Ecu.getState().connected) { Ecu._startPolling(50); } } catch {} }

  // flasher events
  flasher.addEventListener('status', e => { $('#flStatus').textContent = e.detail; flog(e.detail); });
  flasher.addEventListener('error', e => { $('#flStatus').textContent = '✗ ' + e.detail; flog('ERROR: ' + e.detail); });
  flasher.addEventListener('progress', e => {
    const d = e.detail;
    if (d.phase === 'pre-write') { $('#flStatus').textContent = 'เตรียมเขียน... ' + (d.countdown || 0) + 's'; return; }
    const pct = Math.round((d.percentage || 0) * 100);
    $('#flBar').style.width = pct + '%'; $('#flPct').textContent = pct + '%';
    $('#flSpd').textContent = (d.speedKbs ? d.speedKbs.toFixed(1) + ' KB/s' : '') + (d.etaSeconds ? ' · เหลือ ' + Math.ceil(d.etaSeconds) + 's' : '');
  });
  flasher.addEventListener('complete', e => {
    const ok = e.detail; state.flashing = false;
    $('#flStart').hidden = false; $('#flAbort').hidden = true;
    const id = ($('#fl-id').textContent || '').trim();
    addJob('Flash ECU', state.binName, ok ? '✓ สำเร็จ' : '✗ ไม่สำเร็จ', ok);
    if (ok) {
      stepState(3, true); $('#flBar').style.width = '100%'; $('#flPct').textContent = '100%';
      if (id && id !== '—') { const part = partFromFile(state.binName); if (part) setBoxPart(id, part); }
      popup('จูนเสร็จแล้ว ✓', 'กรุณาปิดกุญแจ (OFF) แล้วเปิดใหม่อีกครั้งครับ', false);
    } else {
      popup('แฟลชไม่สำเร็จ', 'ตรวจสาย/ไฟ และรุ่นไฟล์ให้ตรงกับกล่อง แล้วลองใหม่', true);
    }
  });

  $('#flStart').addEventListener('click', async () => {
    if (!licensed()) { lockGate('แฟลช ECU'); return; }
    const st = Ecu.getState();
    if (!Link.isOpen || !st.connected) { popup('ยังไม่พร้อม', 'ยังไม่เชื่อมต่อกล่อง ไปหน้าหลักเพื่อเชื่อมต่อก่อน', true); return; }
    if (!state.bin) { popup('ยังไม่เลือกไฟล์', 'ไปหน้า "ไฟล์" เพื่อเลือกเฟิร์มแวร์ก่อน', true); return; }
    state.flashing = true; $('#flStart').hidden = true; $('#flAbort').hidden = false;
    $('#flLog').innerHTML = ''; $('#flBar').style.width = '0%'; $('#flPct').textContent = '0%';
    // ensure flasher attached
    if (!flasher.ecmId || flasher.ecmId === '-') { Ecu._stopPolling(); await flasher.attachAndReadInfo(st.ecmId); }
    await flasher.startFlash(state.bin, {});
  });
  $('#flAbort').addEventListener('click', () => { flasher.abort(); $('#flStatus').textContent = 'กำลังยกเลิก...'; });

  /* ---------- diagnostics: DTC ---------- */
  $('#dtcRead').addEventListener('click', async () => {
    if (!Ecu.getState().connected) { popup('ยังไม่เชื่อมต่อ', 'เชื่อมต่อกล่องก่อน', true); return; }
    $('#dtcList').innerHTML = '<div class="empty">กำลังอ่าน...</div>';
    const r = await Ecu.readDTC();
    if (!r.ok) { $('#dtcList').innerHTML = '<div class="empty">อ่านไม่สำเร็จ: ' + reason(r.reason) + '</div>'; return; }
    if (!r.codes.length) { $('#dtcList').innerHTML = '<div class="empty">✓ ไม่พบรหัสปัญหา</div>'; return; }
    $('#dtcList').innerHTML = r.codes.map(c => `<div class="dtcrow"><b>DTC ${c.description}</b></div>`).join('');
  });
  $('#dtcClear').addEventListener('click', async () => {
    if (!Ecu.getState().connected) { popup('ยังไม่เชื่อมต่อ', 'เชื่อมต่อกล่องก่อน', true); return; }
    const r = await Ecu.clearDTC();
    if (r.ok) popup('ล้างรหัสแล้ว', 'เหลือรหัส ' + r.remaining + ' รายการ', false);
    else popup('ล้างไม่สำเร็จ', reason(r.reason), true);
  });
  $$('.hubitem').forEach(h => h.addEventListener('click', () => {
    popup('ใช้บนเดสก์ท็อป', 'เครื่องมือ "' + h.textContent + '" เป็นงานเขียน EEPROM ขั้นสูง แนะนำให้ทำบนโปรแกรม Honda Flash Studio เดสก์ท็อปเพื่อความปลอดภัยของกล่อง', false);
  }));

  /* ---------- settings ---------- */
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; $('#installBtn').disabled = false; });
  $('#installBtn').addEventListener('click', async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); deferredPrompt = null; $('#installBtn').disabled = true; });
  $('#wipeBtn').addEventListener('click', () => { try { localStorage.clear(); } catch {} renderJobs(); popup('ล้างแล้ว', 'ลบประวัติและการตั้งค่าในเครื่องแล้ว', false); });
  try { const t = localStorage.getItem('hfs-transport'); if (t) $('#transportSel').value = t; } catch {}
  $('#transportSel').addEventListener('change', e => { try { localStorage.setItem('hfs-transport', e.target.value); } catch {} });

  /* ---------- map tune (XDF-driven table editor) ---------- */
  const mt = { view:'2d', yaw:-0.6, pitch:1.1, zoom:0.9, tb:null, cols:0, rows:0, vals:[], orig:[], xLabels:[], yLabels:[], decimals:0 };
  $('#toMap') && $('#toMap').addEventListener('click', () => go('maptune'));

  async function loadMapSources() {
    try { const r = await fetch('assets/bins/manifest.json'); const list = await r.json();
      const sel = $('#mtBinSel'); state.binList = list;
      list.forEach(x => { const o = document.createElement('option'); o.value = x.file; o.textContent = x.label; sel.appendChild(o); }); } catch {}
    try { const r = await fetch('assets/defs/manifest.json'); const list = await r.json();
      const sel = $('#mtXdfSel'); state.xdfList = list;
      list.forEach(x => { const o = document.createElement('option'); o.value = x.file; o.textContent = x.label; sel.appendChild(o); }); } catch {}
  }
  function onEnterMap() {
    $('#srcBin').textContent = state.binName || '—';
    if (state.xdf && state.xdfName) $('#srcXdf').textContent = state.xdfName;
  }
  function setSharedBin(buf, name) {
    state.bin = buf; state.binName = name;
    $('#srcBin').textContent = name;
    $('#fl-file').textContent = name; $('#fx-file').textContent = name;
  }
  function matchXdf(name) {
    if (!state.xdfList) return null;
    const m = /K[0-9A-Z]{1,3}-?[0-9A-Za-z]{2,3}/i.exec((name || '').toUpperCase());
    if (!m) return null; const code = m[0].replace(/-/g, '');
    return state.xdfList.find(x => x.label.toUpperCase().replace(/-/g, '') === code) || null;
  }
  async function useXdf(file) {
    try { const r = await fetch('assets/defs/' + encodeURIComponent(file)); const txt = await r.text();
      state.xdf = HFXdf.parse(txt); state.xdfName = file.replace(/\.xdf$/i, '');
      $('#srcXdf').textContent = state.xdfName + ' (' + state.xdf.tables.length + ' ตาราง)';
      $('#mtXdfSel').value = file;
    } catch (e) { state.xdf = null; $('#srcXdf').textContent = 'อ่าน XDF ไม่ได้'; }
  }

  $('#mtAddBin').addEventListener('click', () => $('#mtBinFile').click());
  $('#mtBinFile').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return;
    setSharedBin(new Uint8Array(await f.arrayBuffer()), f.name);
    const x = matchXdf(f.name); if (x && !state.xdf) useXdf(x.file); });
  $('#mtBinSel').addEventListener('change', async e => { const file = e.target.value; if (!file) return;
    try { const r = await fetch('assets/bins/' + encodeURIComponent(file)); setSharedBin(new Uint8Array(await r.arrayBuffer()), file);
      const x = matchXdf(file); if (x) { useXdf(x.file); } } catch {} });
  $('#mtAddXdf').addEventListener('click', () => $('#mtXdfFile').click());
  $('#mtXdfFile').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return;
    const txt = await f.text(); try { state.xdf = HFXdf.parse(txt); state.xdfName = f.name.replace(/\.xdf$/i, '');
      $('#srcXdf').textContent = state.xdfName + ' (' + state.xdf.tables.length + ' ตาราง)'; }
    catch (err) { popup('XDF ผิดรูปแบบ', err.message, true); } });
  $('#mtXdfSel').addEventListener('change', e => { if (e.target.value) useXdf(e.target.value); });

  $('#mtEnter').addEventListener('click', () => {
    if (!state.bin) { popup('ยังไม่มี BIN', 'เพิ่มไฟล์ BIN หรือเลือก BIN ในตัวก่อน', true); return; }
    if (!state.xdf || !state.xdf.tables.length) { popup('ยังไม่มี XDF', 'เพิ่มไฟล์ XDF หรือเลือก XDF ในตัว (ตัวบอกตำแหน่งตาราง) ก่อน', true); return; }
    const sel = $('#mtTableSel'); sel.innerHTML = '';
    state.xdf.tables.forEach((tb, i) => { const o = document.createElement('option'); o.value = i;
      o.textContent = (tb.category ? '[' + tb.category + '] ' : '') + tb.title + '  (' + tb.rows + '×' + tb.cols + ')'; sel.appendChild(o); });
    $('#mtEditor').hidden = false; loadTable(0);
    $('#mtEditor').scrollIntoView({ behavior: 'smooth' });
  });
  $('#mtTableSel').addEventListener('change', e => loadTable(+e.target.value));

  function loadTable(idx) {
    const tb = state.xdf.tables[idx]; if (!tb) return;
    mt.tb = tb; mt.cols = tb.cols; mt.rows = tb.rows; mt.decimals = tb.decimals || 0;
    mt.vals = []; mt.orig = [];
    for (let r = 0; r < tb.rows; r++) { const row = [], orow = [];
      for (let c = 0; c < tb.cols; c++) { const v = HFXdf.readValue(state.bin, tb, r, c); row.push(v); orow.push(v); }
      mt.vals.push(row); mt.orig.push(orow); }
    mt.xLabels = HFXdf.axisLabels(state.bin, tb.axX, tb.cols);
    mt.yLabels = HFXdf.axisLabels(state.bin, tb.axY, tb.rows);
    $('#mtStat').textContent = tb.title + ' · ' + tb.rows + '×' + tb.cols + ' @ 0x' + tb.addr.toString(16).toUpperCase() + ' · ' + tb.elemBits + '-bit ' + tb.endian.toUpperCase();
    if (mt.view === '3d') { setView('3d'); } else { setView('2d'); }
  }

  /* ---- shared helpers ---- */
  function gridExtent() { let mn = Infinity, mx = -Infinity;
    for (const row of mt.vals) for (const v of row) { if (v < mn) mn = v; if (v > mx) mx = v; }
    if (!isFinite(mn)) { mn = 0; mx = 1; } if (mn === mx) mx = mn + 1; return { mn, mx }; }
  const RAMP = [[30,99,208],[25,179,107],[244,208,63],[232,99,26],[214,31,31]];
  function ramp(t) { t = Math.max(0, Math.min(1, t)); const seg = t * (RAMP.length - 1);
    const i = Math.min(RAMP.length - 2, Math.floor(seg)), f = seg - i; const a = RAMP[i], b = RAMP[i + 1];
    return [Math.round(a[0]+(b[0]-a[0])*f), Math.round(a[1]+(b[1]-a[1])*f), Math.round(a[2]+(b[2]-a[2])*f)]; }
  function heat(v, mn, mx) { const [r, g, b] = ramp((v - mn) / (mx - mn)); const m = 0.5;
    return `rgb(${Math.round(r+(255-r)*m)},${Math.round(g+(255-g)*m)},${Math.round(b+(255-b)*m)})`; }
  function fmtCell(v) { const d = mt.decimals; return d > 0 ? Number(v).toFixed(d) : Math.round(v); }
  function mtMsg(t, bad) { const m = $('#mtMsg'); m.hidden = false; m.textContent = t; m.style.color = bad ? '#b0060c' : '#16a34a'; }

  function renderGrid() {
    const { mn, mx } = gridExtent();
    let html = '<tr><th class="corner">L\\RPM</th>';
    for (let c = 0; c < mt.cols; c++) html += '<th>' + (mt.xLabels[c] != null ? mt.xLabels[c] : c) + '</th>';
    html += '</tr>';
    for (let r = 0; r < mt.rows; r++) {
      html += '<tr><td class="rowh">' + (mt.yLabels[r] != null ? mt.yLabels[r] : r) + '</td>';
      for (let c = 0; c < mt.cols; c++) { const v = mt.vals[r][c];
        html += `<td class="cell" style="background:${heat(v, mn, mx)}"><input data-r="${r}" data-c="${c}" value="${fmtCell(v)}" inputmode="decimal"></td>`; }
      html += '</tr>';
    }
    const g = $('#mtGrid'); g.innerHTML = html;
    g.querySelectorAll('input').forEach(inp => { inp.addEventListener('change', () => {
      const r = +inp.dataset.r, c = +inp.dataset.c; let nv = parseFloat(inp.value);
      if (isNaN(nv)) { inp.value = fmtCell(mt.vals[r][c]); return; } mt.vals[r][c] = nv; recolor(); }); });
  }
  function recolor() {
    if (mt.view === '3d') { render3D(); return; }
    const { mn, mx } = gridExtent();
    $('#mtGrid').querySelectorAll('input').forEach(inp => { const r = +inp.dataset.r, c = +inp.dataset.c; const v = mt.vals[r][c];
      inp.value = fmtCell(v); inp.parentElement.style.background = heat(v, mn, mx); });
  }

  /* ---------- 3D surface ---------- */
  function setView(v) {
    mt.view = v;
    $$('#mtViewSeg .tbtn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    $('#mt2dWrap').hidden = v !== '2d'; $('#mt3dWrap').hidden = v !== '3d';
    if (v === '3d') { sizeCanvas(); render3D(); } else renderGrid();
  }
  $$('#mtViewSeg .tbtn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  function sizeCanvas() { const cv = $('#mt3d'); const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth || 320, h = 340; cv.width = w * dpr; cv.height = h * dpr; cv._dpr = dpr; }
  function rot3(x, y, z) {
    const cy = Math.cos(mt.yaw), sy = Math.sin(mt.yaw);
    let x1 = x * cy - y * sy, y1 = x * sy + y * cy, z1 = z;
    const cp = Math.cos(mt.pitch), sp = Math.sin(mt.pitch);
    let y2 = y1 * cp - z1 * sp, z2 = y1 * sp + z1 * cp;
    return { x: x1, y: y2, depth: z2 };
  }
  function render3D() {
    const cv = $('#mt3d'); if (!cv.width) sizeCanvas();
    const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height, dpr = cv._dpr || 1;
    ctx.clearRect(0, 0, W, H);
    const rows = mt.rows, cols = mt.cols; if (rows < 1 || cols < 1) return;
    const { mn, mx } = gridExtent();
    const cxg = (cols - 1) / 2, cyg = (rows - 1) / 2;
    const base = Math.min(W / (cols + 1), H / (rows + 1)) * 0.95 * mt.zoom;
    const zH = Math.min(W, H) * 0.30 * mt.zoom;
    const ox = W / 2, oy = H * 0.40;
    const P = [];
    for (let r = 0; r < rows; r++) { P[r] = [];
      for (let c = 0; c < cols; c++) { const t = (mt.vals[r][c] - mn) / (mx - mn);
        const pr = rot3((c - cxg), (r - cyg), t * (zH / base));
        P[r][c] = { sx: ox + pr.x * base, sy: oy - pr.y * base, depth: pr.depth, t }; } }
    if (rows < 2 || cols < 2) { // 1D curve -> draw line of points
      ctx.strokeStyle = '#e11b22'; ctx.lineWidth = 2 * dpr; ctx.beginPath();
      let first = true; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const p = P[r][c];
        if (first) { ctx.moveTo(p.sx, p.sy); first = false; } else ctx.lineTo(p.sx, p.sy); } ctx.stroke();
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const p = P[r][c]; const [cr,cg,cb]=ramp(p.t);
        ctx.fillStyle=`rgb(${cr},${cg},${cb})`; ctx.beginPath(); ctx.arc(p.sx,p.sy,4*dpr,0,7); ctx.fill(); }
      return;
    }
    const quads = [];
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
      const a = P[r][c], b2 = P[r][c + 1], d = P[r + 1][c + 1], e = P[r + 1][c];
      quads.push({ pts: [a, b2, d, e], depth: (a.depth+b2.depth+d.depth+e.depth)/4, t: (a.t+b2.t+d.t+e.t)/4 }); }
    quads.sort((q1, q2) => q1.depth - q2.depth);
    for (const q of quads) { const [r1, g1, b1] = ramp(q.t);
      ctx.beginPath(); ctx.moveTo(q.pts[0].sx, q.pts[0].sy);
      for (let i = 1; i < 4; i++) ctx.lineTo(q.pts[i].sx, q.pts[i].sy); ctx.closePath();
      ctx.fillStyle = `rgb(${r1},${g1},${b1})`; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.lineWidth = 1 * dpr; ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = (13 * dpr) + 'px Prompt, sans-serif'; ctx.textAlign = 'center';
    const rpmPt = rot3((cols - 1 - cxg), (0 - cyg), 0);
    ctx.fillText('RPM →', ox + rpmPt.x * base, oy - rpmPt.y * base + 18 * dpr);
    const loadPt = rot3((0 - cxg), (rows - 1 - cyg), 0);
    ctx.fillText('โหลด →', ox + loadPt.x * base - 10 * dpr, oy - loadPt.y * base + 18 * dpr);
  }
  (function () {
    const cv = $('#mt3d'); if (!cv) return;
    let dragging = false, lx = 0, ly = 0, pinchD = 0;
    cv.addEventListener('pointerdown', e => { dragging = true; lx = e.clientX; ly = e.clientY; try { cv.setPointerCapture(e.pointerId); } catch {} });
    cv.addEventListener('pointermove', e => { if (!dragging) return;
      mt.yaw += (e.clientX - lx) * 0.01; mt.pitch += (e.clientY - ly) * 0.01;
      mt.pitch = Math.max(0.2, Math.min(1.45, mt.pitch)); lx = e.clientX; ly = e.clientY; render3D(); });
    cv.addEventListener('pointerup', () => dragging = false);
    cv.addEventListener('pointercancel', () => dragging = false);
    cv.addEventListener('wheel', e => { e.preventDefault(); mt.zoom *= (e.deltaY < 0 ? 1.08 : 0.92); mt.zoom = Math.max(0.4, Math.min(3, mt.zoom)); render3D(); }, { passive: false });
    cv.addEventListener('touchmove', e => { if (e.touches.length === 2) { e.preventDefault();
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      if (pinchD) { mt.zoom *= d / pinchD; mt.zoom = Math.max(0.4, Math.min(3, mt.zoom)); render3D(); } pinchD = d; } }, { passive: false });
    cv.addEventListener('touchend', () => pinchD = 0);
  })();

  /* ---- bulk + save ---- */
  $('#mtApplyPct').addEventListener('click', () => { if (!mt.tb) return; const p = (parseFloat($('#mtPct').value) || 100) / 100;
    for (let r = 0; r < mt.rows; r++) for (let c = 0; c < mt.cols; c++) mt.vals[r][c] *= p; recolor(); });
  $('#mtPlus').addEventListener('click', () => { if (!mt.tb) return; const d = parseFloat($('#mtDelta').value) || 0;
    for (let r = 0; r < mt.rows; r++) for (let c = 0; c < mt.cols; c++) mt.vals[r][c] += d; recolor(); });
  $('#mtMinus').addEventListener('click', () => { if (!mt.tb) return; const d = parseFloat($('#mtDelta').value) || 0;
    for (let r = 0; r < mt.rows; r++) for (let c = 0; c < mt.cols; c++) mt.vals[r][c] -= d; recolor(); });
  $('#mtReset').addEventListener('click', () => { if (!mt.tb) return;
    mt.vals = mt.orig.map(row => row.slice()); recolor(); });

  function applyToBin() { if (!mt.tb) return;
    for (let r = 0; r < mt.rows; r++) for (let c = 0; c < mt.cols; c++) HFXdf.writeValue(state.bin, mt.tb, r, c, mt.vals[r][c]); }
  $('#mtSave').addEventListener('click', () => {
    if (!licensed()) { lockGate('บันทึกไฟล์ BIN'); return; }
    if (!state.bin || !mt.tb) return; applyToBin();
    mt.orig = mt.vals.map(row => row.slice());
    if (state.binName && !/\(แก้ไข\)/.test(state.binName)) { state.binName = state.binName.replace(/(\.bin)?$/i, '') + ' (แก้ไข).bin';
      $('#srcBin').textContent = state.binName; $('#fl-file').textContent = state.binName; $('#fx-file').textContent = state.binName; }
    mtMsg('✓ บันทึก "' + mt.tb.title + '" ลงไฟล์แล้ว — ไปหน้าแฟลชเพื่อเขียนลงกล่อง (checksum คำนวณใหม่อัตโนมัติ)');
    addJob('แก้ตารางจูน', mt.tb.title, '✓ บันทึก', true);
  });
  $('#mtDownload').addEventListener('click', () => {
    if (!licensed()) { lockGate('ดาวน์โหลด BIN'); return; }
    if (!state.bin) return; applyToBin();
    const blob = new Blob([state.bin], { type: 'application/octet-stream' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = (state.binName || 'tuned').replace(/\s*\(แก้ไข\)/, '').replace(/\.bin$/i, '') + '_tuned.bin';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    mtMsg('✓ ดาวน์โหลดไฟล์ที่แก้แล้ว');
  });

  /* ---------- license lock ---------- */
  const Lic = window.HFLicense;
  function licensed() { return Lic && Lic.ok(); }
  function lockGate(feature) {
    popup('🔒 ต้องปลดล็อกก่อน', 'ฟีเจอร์ "' + feature + '" ถูกล็อก ต้องซื้อคีย์ปลดล็อก — ไปที่ ตั้งค่า > ปลดล็อกการใช้งาน เพื่อใส่คีย์', true);
    setTimeout(() => go('settings'), 400);
  }
  function updateLicUI(stt) {
    const s = stt || Lic.info();
    const badge = $('#licBadge'), state = $('#licState');
    $('#licDev').textContent = Lic.deviceId();
    if (s.licensed) {
      badge.className = 'lic-badge ok'; badge.textContent = '✓ ปลดล็อกแล้ว';
      state.className = 'lic-state ok';
      state.innerHTML = 'ปลดล็อกแล้ว · ผู้ใช้ <b>' + (s.name || '-') + '</b>' + (s.exp ? ' · หมดอายุ ' + new Date(s.exp).toLocaleDateString('th-TH') : ' · ถาวร');
      $('#licDeact').hidden = false; $('#licActivate').textContent = 'เปลี่ยนคีย์';
      $('#flStart').textContent = 'เริ่มแฟลช'; $('#mtSave').textContent = 'บันทึกลงไฟล์'; $('#mtDownload').textContent = 'ดาวน์โหลด .bin';
    } else {
      badge.className = 'lic-badge lock'; badge.textContent = '🔒 ล็อก';
      state.className = 'lic-state';
      state.innerHTML = 'ฟีเจอร์ <b>แฟลช ECU</b> และ <b>บันทึก/ดาวน์โหลด BIN</b> ถูกล็อก — ต้องซื้อคีย์ปลดล็อก' + (s.reason ? ' (' + s.reason + ')' : '');
      $('#licDeact').hidden = true; $('#licActivate').textContent = 'ปลดล็อก';
      $('#flStart').textContent = '🔒 เริ่มแฟลช (ล็อก)'; $('#mtSave').textContent = '🔒 บันทึกลงไฟล์'; $('#mtDownload').textContent = '🔒 ดาวน์โหลด .bin';
    }
  }
  $('#licActivate').addEventListener('click', async () => {
    const key = $('#licInput').value.trim();
    if (!key) { popup('ยังไม่ได้ใส่คีย์', 'วางคีย์ปลดล็อกในช่องก่อน', true); return; }
    const r = await Lic.activate(key);
    if (r.ok) { $('#licInput').value = ''; popup('ปลดล็อกสำเร็จ ✓', 'ขอบคุณครับ ' + (r.name || '') + ' — ใช้แฟลชและบันทึกไฟล์ได้แล้ว', false); }
    else popup('คีย์ใช้ไม่ได้', r.reason || 'คีย์ไม่ถูกต้อง', true);
  });
  $('#licDeact').addEventListener('click', () => { Lic.deactivate(); popup('ปิดการใช้งานคีย์แล้ว', 'เครื่องนี้กลับเป็นโหมดล็อก', false); });

  /* ---------- boot ---------- */
  function boot() {
    if (Lic) { Lic.onChange(updateLicUI); Lic.init().then(updateLicUI).catch(() => updateLicUI()); }
    const caps = Link.capabilities();
    if (!caps.usb && !caps.serial) {
      setPill('off', 'เบราว์เซอร์ไม่รองรับ');
      $('#cc-sub').textContent = 'ใช้ Chrome บน Android (ต่อสาย OTG) หรือ Chrome เดสก์ท็อป';
      $('#connectBtn').disabled = true;
    }
    loadStockList(); loadMapSources(); renderJobs(); setGaugeMode(state.gaugeMode);
    // try to silently re-pick a previously granted device (no auto-open)
    Link.reconnectPaired().catch(() => {});
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  boot();
})();
