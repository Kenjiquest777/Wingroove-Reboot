/* WinGroove Reboot - UI controller */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const native = window.wgNative || null;
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };
  const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const PREFS_KEY = 'wg.prefs.v1';
  const prefs = Object.assign(
    { vol: 80, rev: 60, comp: 50, spd: 100, key: 0, poly: 64, repeat: 'all', shuffle: false },
    (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (_) { return {}; } })()
  );
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ } };

  let ctx = null;
  let synth = null;
  let player = null;
  let sf = null;
  let sfLabel = '';
  const list = []; // { name, data, song, error }
  let cur = -1;
  let sel = -1;
  const level = new Float32Array(16);
  const peak = new Float32Array(16);
  const muted = new Array(16).fill(false);
  const channelOverrides = new Array(16).fill(null); // { bank, program } | null
  const pending = []; // note events waiting to hit the meters at their scheduled time

  // Instrument Window state
  let instTargetCh = 0; // 0..15 (Ch 1..16)
  let instSelectedPreset = null; // { bank, program, name }

  const status = (t) => { $('status').textContent = t; };
  const instStatus = (t) => { $('instStatus').textContent = t; };

  /* ---------- GM Category Mapping ---------- */
  const GM_CATEGORIES = [
    'Piano', 'Chromatic Perc', 'Organ', 'Guitar',
    'Bass', 'Strings', 'Ensemble', 'Brass',
    'Reed', 'Pipe', 'Synth Lead', 'Synth Pad',
    'Synth FX', 'Ethnic', 'Percussive', 'SFX'
  ];

  function buildPresetOptions(soundfont) {
    if (!soundfont || !soundfont.presets || !soundfont.presets.length) {
      return '<option value="default">(Song Default)</option>';
    }
    const presets = soundfont.presets.slice().sort((a, b) => {
      if ((a.bank === 128) !== (b.bank === 128)) return a.bank === 128 ? 1 : -1;
      if (a.bank !== b.bank) return a.bank - b.bank;
      return a.program - b.program;
    });

    let html = '<option value="default">(Song Default)</option>';
    const melodic0 = presets.filter((p) => p.bank === 0);
    const drums = presets.filter((p) => p.bank === 128);
    const others = presets.filter((p) => p.bank !== 0 && p.bank !== 128);

    if (melodic0.length) {
      if (melodic0.length >= 100) {
        for (let i = 0; i < 16; i++) {
          const cat = GM_CATEGORIES[i];
          const sub = melodic0.filter((p) => p.program >= i * 8 && p.program < (i + 1) * 8);
          if (sub.length) {
            html += '<optgroup label="' + cat + '">';
            for (const p of sub) {
              const num = String(p.program + 1).padStart(3, '0');
              html += '<option value="' + p.bank + ':' + p.program + '">' + num + ': ' + escapeHtml(p.name) + '</option>';
            }
            html += '</optgroup>';
          }
        }
      } else {
        html += '<optgroup label="Melodic">';
        for (const p of melodic0) {
          const num = String(p.program + 1).padStart(3, '0');
          html += '<option value="' + p.bank + ':' + p.program + '">' + num + ': ' + escapeHtml(p.name) + '</option>';
        }
        html += '</optgroup>';
      }
    }

    if (drums.length) {
      html += '<optgroup label="Drum Kits (Bank 128)">';
      for (const p of drums) {
        const num = String(p.program + 1).padStart(3, '0');
        html += '<option value="' + p.bank + ':' + p.program + '">' + num + ': ' + escapeHtml(p.name) + '</option>';
      }
      html += '</optgroup>';
    }

    if (others.length) {
      const byBank = new Map();
      for (const p of others) {
        if (!byBank.has(p.bank)) byBank.set(p.bank, []);
        byBank.get(p.bank).push(p);
      }
      for (const [b, group] of byBank.entries()) {
        html += '<optgroup label="Bank ' + b + '">';
        for (const p of group) {
          const num = String(p.program + 1).padStart(3, '0');
          html += '<option value="' + p.bank + ':' + p.program + '">' + num + ': ' + escapeHtml(p.name) + '</option>';
        }
        html += '</optgroup>';
      }
    }
    return html;
  }

  function populatePresetSelects() {
    const html = buildPresetOptions(sf);
    meterEls.forEach((m, i) => {
      const prevVal = m.select.value;
      m.select.innerHTML = html;
      if (channelOverrides[i]) {
        m.select.value = channelOverrides[i].bank + ':' + channelOverrides[i].program;
      } else if (synth) {
        const c = synth.channels[i];
        m.select.value = c.bank + ':' + c.program;
      } else {
        m.select.value = prevVal || 'default';
      }
    });
    updateInstCategories();
    renderInstPresets();
    renderInstChTable();
  }

  function clearAllOverrides(silent) {
    channelOverrides.fill(null);
    if (synth) synth.clearChannelOverrides();
    meterEls.forEach((m, i) => {
      m.select.classList.remove('override');
      if (synth) {
        const c = synth.channels[i];
        m.select.value = c.bank + ':' + c.program;
        m.select.title = 'Ch ' + (i + 1) + ': ' + (synth.channelPresetName(i) || '(none)') + ' - click to swap instrument';
      } else {
        m.select.value = 'default';
      }
    });
    renderInstChTable();
    if (!silent) {
      status('Channel instruments reverted to song defaults');
      instStatus('All 16 channels reverted to song defaults');
    }
  }

  /* ---------- audio bootstrap ---------- */
  function ensureAudio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC({ latencyHint: 'playback' });
      synth = new WGSynth(ctx, sf, {
        volume: prefs.vol / 100,
        reverb: prefs.rev / 100,
        leveling: prefs.comp / 100,
        polyphony: prefs.poly,
        transpose: prefs.key
      });
      synth.onNote = (ch, k, vel, t) => pending.push({ ch, vel, t });
      muted.forEach((m, i) => { if (m) synth.setMute(i, true); });
      channelOverrides.forEach((ov, i) => { if (ov) synth.setChannelOverride(i, ov.bank, ov.program); });
      player = new WGPlayer(synth);
      player.setSpeed(prefs.spd / 100);
      player.onEnd = onSongEnd;
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  function useSoundfont(bytes, label) {
    try {
      sf = WGSF2.parse(bytes);
      sfLabel = label || sf.name;
      $('sfName').textContent = sfLabel + ' (' + sf.presets.length + ' presets)';
      if (synth) synth.setSoundfont(sf);
      populatePresetSelects();
      status('SoundFont loaded: ' + sfLabel);
      instStatus('Loaded: ' + sfLabel + ' with ' + sf.presets.length + ' presets');
      return true;
    } catch (err) {
      status('SoundFont error: ' + err.message);
      instStatus('SoundFont error: ' + err.message);
      return false;
    }
  }

  async function loadDefaultSoundfont() {
    status('Loading WinGroove soundfont...');
    let bytes = null;
    try {
      if (native) bytes = await native.readDefaultSoundfont();
      if (!bytes) {
        const r = await fetch('soundfonts/WinGroove.sf2');
        if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
      }
    } catch (_) { bytes = null; }
    if (bytes && bytes.length) useSoundfont(bytes, 'WinGroove.sf2');
    else {
      $('sfName').textContent = 'no soundfont';
      status('No default soundfont found. Use SoundFont... to load a .sf2 (run "npm run fetch-soundfont").');
    }
  }

  /* ---------- playlist ---------- */
  function addFiles(items) {
    let firstNew = -1;
    for (const it of items) {
      if (/\.sf2$/i.test(it.name)) { useSoundfont(it.data, it.name); continue; }
      const entry = { name: it.name, data: it.data, song: null, error: null };
      try { entry.song = WGMidi.parse(it.data); } catch (err) { entry.error = err.message; }
      list.push(entry);
      if (firstNew < 0) firstNew = list.length - 1;
    }
    renderList();
    if (firstNew >= 0 && (cur < 0 || !player || !player.playing)) select(firstNew, true);
  }

  function renderList() {
    const ol = $('playlist');
    ol.innerHTML = '';
    list.forEach((e, i) => {
      const li = document.createElement('li');
      const len = e.song ? ' [' + fmt(e.song.duration) + ']' : e.error ? ' [error]' : '';
      li.textContent = (e.song && e.song.title ? e.song.title + ' - ' : '') + e.name + len;
      li.title = e.error || e.name;
      if (i === sel) li.classList.add('sel');
      if (i === cur) li.classList.add('cur');
      if (e.error) li.classList.add('err');
      li.onclick = () => { sel = i; renderList(); };
      li.ondblclick = () => select(i, true);
      ol.appendChild(li);
    });
  }

  function select(i, autoplay) {
    if (i < 0 || i >= list.length) return;
    const e = list[i];
    if (!e.song) { status('Cannot play ' + e.name + ': ' + e.error); return; }
    clearAllOverrides(true);
    ensureAudio();
    cur = i; sel = i;
    player.load(e.song);
    $('lcdTitle').textContent = e.song.title || e.name;
    $('lcdLen').textContent = fmt(e.song.duration);
    document.title = (e.song.title || e.name) + ' - WinGroove Reboot';
    renderList();
    renderInstChTable();
    if (autoplay) play();
  }

  function nextIndex(dir) {
    if (!list.length) return -1;
    if (prefs.shuffle && list.length > 1) {
      let n; do { n = Math.floor(Math.random() * list.length); } while (n === cur);
      return n;
    }
    let n = cur + dir;
    if (n >= list.length) n = prefs.repeat === 'all' ? 0 : -1;
    if (n < 0 && dir < 0) n = prefs.repeat === 'all' ? list.length - 1 : 0;
    return n;
  }

  function onSongEnd() {
    if (prefs.repeat === 'one') { play(); return; }
    const n = nextIndex(1);
    if (n >= 0) select(n, true); else { stop(); updatePlayBtn(); }
  }

  /* ---------- transport ---------- */
  function play() {
    if (!sf) { status('Load a SoundFont first.'); return; }
    ensureAudio();
    if (cur < 0 && list.length) { select(0, false); }
    if (!player.song) return;
    player.play();
    status('Playing');
    updatePlayBtn();
  }
  function togglePlay() {
    ensureAudio();
    if (player && player.playing) { player.pause(); status('Paused'); updatePlayBtn(); }
    else play();
  }
  function stop() {
    if (player) { player.stop(); }
    clearAllOverrides(true);
    status('Stopped');
    updatePlayBtn();
  }
  function nudge(sec) { if (player && player.song) player.seek(player.position + sec * player.speed); }
  function updatePlayBtn() { $('btnPlay').innerHTML = player && player.playing ? '&#10074;&#10074;' : '&#9654;'; }

  /* ---------- file pickers ---------- */
  function readBrowserFiles(files) {
    return Promise.all(Array.from(files).map((f) => f.arrayBuffer().then((b) => ({ name: f.name, data: new Uint8Array(b) }))));
  }
  async function openMidi() {
    if (native) addFiles(await native.openMidi()); else $('fileMidi').click();
  }
  async function openSf() {
    if (native) { const r = await native.openSoundfont(); if (r[0]) useSoundfont(r[0].data, r[0].name); }
    else $('fileSf').click();
  }
  $('fileMidi').onchange = async (e) => { addFiles(await readBrowserFiles(e.target.files)); e.target.value = ''; };
  $('fileSf').onchange = async (e) => {
    const r = await readBrowserFiles(e.target.files);
    if (r[0]) useSoundfont(r[0].data, r[0].name);
    e.target.value = '';
  };

  async function saveWav() {
    const e = list[cur];
    if (!e || !e.song || !sf) { status('Select a song (and soundfont) first.'); return; }
    status('Rendering WAV... 0%');
    try {
      const ab = await WGSynth.renderOffline(sf, e.song, {
        speed: prefs.spd / 100,
        volume: prefs.vol / 100,
        reverb: prefs.rev / 100,
        leveling: prefs.comp / 100,
        polyphony: prefs.poly,
        transpose: prefs.key,
        mutedChannels: muted,
        channelOverrides: channelOverrides,
      }, (p) => status('Rendering WAV... ' + Math.round(p * 100) + '%'));
      const wav = WGWav.encode(ab);
      const name = e.name.replace(/\.[^.]+$/, '') + '.wav';
      if (native) {
        const p = await native.saveFile(name, new Uint8Array(wav));
        status(p ? 'Saved ' + p : 'Save cancelled');
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        status('Saved ' + name);
      }
    } catch (err) { status('Render failed: ' + err.message); }
  }

  /* ---------- meters ---------- */
  const meterEls = [];
  (function buildMeters() {
    const root = $('meters');
    for (let i = 0; i < 16; i++) {
      const d = document.createElement('div');
      d.className = 'ch';
      d.innerHTML =
        '<div class="num" title="Ch ' + (i + 1) + ' - Click to mute / Double-click for Instruments">' + (i + 1) + '</div>' +
        '<div class="bar" title="Ch ' + (i + 1) + ' - Click to mute"><div class="fill"></div><div class="peak"></div></div>' +
        '<div class="pan" title="Stereo Pan"><i></i></div>' +
        '<select class="inst-sel" title="Ch ' + (i + 1) + ': Instrument - Click to swap"><option value="default">(Song Default)</option></select>';

      const numEl = d.querySelector('.num');
      const barEl = d.querySelector('.bar');
      const select = d.querySelector('.inst-sel');

      const toggleMute = (e) => {
        e.stopPropagation();
        muted[i] = !muted[i];
        d.classList.toggle('muted', muted[i]);
        if (synth) synth.setMute(i, muted[i]);
        status('Ch ' + (i + 1) + ': ' + (muted[i] ? 'Muted' : 'Unmuted'));
      };
      numEl.onclick = toggleMute;
      barEl.onclick = toggleMute;
      numEl.ondblclick = (e) => {
        e.stopPropagation();
        openInstWindow(i);
      };

      select.onclick = (e) => e.stopPropagation();
      select.onmousedown = (e) => e.stopPropagation();
      select.onchange = (e) => {
        e.stopPropagation();
        ensureAudio();
        const val = select.value;
        if (val === 'default') {
          channelOverrides[i] = null;
          if (synth) synth.setChannelOverride(i, null);
          select.classList.remove('override');
          if (synth) {
            const c = synth.channels[i];
            select.value = c.bank + ':' + c.program;
          }
          status('Ch ' + (i + 1) + ' reverted to song default');
        } else {
          const parts = val.split(':').map(Number);
          channelOverrides[i] = { bank: parts[0], program: parts[1] };
          if (synth) synth.setChannelOverride(i, parts[0], parts[1]);
          select.classList.add('override');
          const name = synth ? synth.channelPresetName(i) : '';
          status('Ch ' + (i + 1) + ' swapped to: ' + name);
        }
        renderInstChTable();
      };

      select.onmouseenter = () => {
        if (synth) {
          const curName = synth.channelPresetName(i) || '(none)';
          const isOver = !!channelOverrides[i];
          status('Ch ' + (i + 1) + ': ' + curName + (isOver ? ' [SWAPPED]' : '') + ' (click to swap instrument)');
        }
      };

      root.appendChild(d);
      meterEls.push({
        d,
        fill: d.querySelector('.fill'),
        peak: d.querySelector('.peak'),
        pan: d.querySelector('.pan i'),
        select
      });
    }
  })();

  /* ---------- WinGroove Instruments Window ---------- */
  function openInstWindow(targetCh) {
    if (typeof targetCh === 'number' && targetCh >= 0 && targetCh < 16) {
      instTargetCh = targetCh;
    }
    updateInstTargetTitle();
    renderInstChTable();
    renderInstPresets();
    $('dlgInst').classList.remove('hidden');
    instStatus('Select a channel and double-click an instrument to assign');
  }

  function closeInstWindow() {
    $('dlgInst').classList.add('hidden');
  }

  function updateInstTargetTitle() {
    $('instTargetChTitle').textContent = 'Target: Channel ' + (instTargetCh + 1) + (instTargetCh === 9 ? ' [Drums]' : '');
  }

  function updateInstCategories() {
    const sel = $('instCatFilter');
    sel.innerHTML =
      '<option value="all">All Categories</option>' +
      '<option value="drums">Drum Kits (Bank 128)</option>';
    GM_CATEGORIES.forEach((cat, idx) => {
      sel.innerHTML += '<option value="cat:' + idx + '">' + (idx + 1) + '. ' + cat + '</option>';
    });
  }

  function getFilteredPresets() {
    if (!sf || !sf.presets) return [];
    const catVal = $('instCatFilter').value || 'all';
    const query = ($('instSearch').value || '').trim().toLowerCase();

    return sf.presets.filter((p) => {
      // Category filter
      if (catVal === 'drums') {
        if (p.bank !== 128) return false;
      } else if (catVal.startsWith('cat:')) {
        const idx = Number(catVal.slice(4));
        if (p.bank !== 0) return false;
        if (p.program < idx * 8 || p.program >= (idx + 1) * 8) return false;
      }

      // Search text filter
      if (query) {
        const nameMatch = p.name.toLowerCase().includes(query);
        const progMatch = String(p.program + 1).includes(query);
        if (!nameMatch && !progMatch) return false;
      }
      return true;
    }).sort((a, b) => {
      if ((a.bank === 128) !== (b.bank === 128)) return a.bank === 128 ? 1 : -1;
      if (a.bank !== b.bank) return a.bank - b.bank;
      return a.program - b.program;
    });
  }

  function renderInstPresets() {
    const box = $('instListbox');
    box.innerHTML = '';
    const presets = getFilteredPresets();

    if (!presets.length) {
      box.innerHTML = '<div style="padding:6px; color:#888;">(No instruments match filter)</div>';
      instSelectedPreset = null;
      return;
    }

    presets.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'inst-preset-item';
      const num = String(p.program + 1).padStart(3, '0');
      const bTag = p.bank !== 0 ? ' [B:' + p.bank + ']' : '';
      item.textContent = num + ': ' + p.name + bTag;
      item.title = 'Bank ' + p.bank + ' Prog ' + p.program + ' - ' + p.name;

      if (instSelectedPreset && instSelectedPreset.bank === p.bank && instSelectedPreset.program === p.program) {
        item.classList.add('selected');
      }

      item.onclick = () => {
        instSelectedPreset = p;
        box.querySelectorAll('.inst-preset-item').forEach((el) => el.classList.remove('selected'));
        item.classList.add('selected');
        instStatus('Selected: ' + num + ': ' + p.name + ' (Bank ' + p.bank + ')');
      };

      item.ondblclick = () => {
        instSelectedPreset = p;
        assignSelectedInstrument();
      };

      box.appendChild(item);
    });

    if (!instSelectedPreset && presets.length) {
      instSelectedPreset = presets[0];
      const first = box.querySelector('.inst-preset-item');
      if (first) first.classList.add('selected');
    }
  }

  function renderInstChTable() {
    const table = $('instChTable');
    table.innerHTML = '';

    for (let i = 0; i < 16; i++) {
      const row = document.createElement('div');
      row.className = 'inst-ch-row';
      if (i === instTargetCh) row.classList.add('selected');
      if (channelOverrides[i]) row.classList.add('override');

      let curName = '(none)';
      if (synth) curName = synth.channelPresetName(i) || '(none)';

      const isOver = !!channelOverrides[i];
      row.innerHTML =
        '<span class="ch-idx">Ch ' + String(i + 1).padStart(2, '0') + (i === 9 ? ' [D]' : '') + '</span>' +
        '<span class="ch-name" title="' + escapeHtml(curName) + '">' + escapeHtml(curName) + '</span>' +
        '<span class="ch-tag">' + (isOver ? 'CUSTOM' : 'DEFAULT') + '</span>';

      row.onclick = () => {
        instTargetCh = i;
        updateInstTargetTitle();
        renderInstChTable();
      };

      table.appendChild(row);
    }
  }

  function assignSelectedInstrument() {
    if (!instSelectedPreset) {
      instStatus('Please select an instrument from the list first.');
      return;
    }
    ensureAudio();
    const ch = instTargetCh;
    const p = instSelectedPreset;

    channelOverrides[ch] = { bank: p.bank, program: p.program };
    if (synth) synth.setChannelOverride(ch, p.bank, p.program);

    meterEls[ch].select.value = p.bank + ':' + p.program;
    meterEls[ch].select.classList.add('override');

    renderInstChTable();
    status('Ch ' + (ch + 1) + ' assigned to: ' + p.name);
    instStatus('Channel ' + (ch + 1) + ' assigned to: ' + p.name);
  }

  function auditionCurrentPreset() {
    if (!instSelectedPreset) {
      instStatus('Please select an instrument to audition.');
      return;
    }
    ensureAudio();
    const key = Number($('instAuditionKey').value) || 60;
    if (synth && synth.auditionNote) {
      synth.auditionNote(instSelectedPreset.bank, instSelectedPreset.program, key, 105, 0.9);
      instStatus('Auditioning: ' + instSelectedPreset.name + ' on key ' + key);
    }
  }

  // Instrument Window event handlers
  $('btnInst').onclick = () => openInstWindow(cur >= 0 ? instTargetCh : 0);
  $('instClose').onclick = closeInstWindow;
  $('btnInstAssign').onclick = assignSelectedInstrument;
  $('btnInstAudition').onclick = auditionCurrentPreset;
  $('btnInstResetSelected').onclick = () => {
    ensureAudio();
    channelOverrides[instTargetCh] = null;
    if (synth) synth.setChannelOverride(instTargetCh, null);
    meterEls[instTargetCh].select.classList.remove('override');
    if (synth) {
      const c = synth.channels[instTargetCh];
      meterEls[instTargetCh].select.value = c.bank + ':' + c.program;
    }
    renderInstChTable();
    instStatus('Channel ' + (instTargetCh + 1) + ' reverted to song default');
  };
  $('btnInstResetAll').onclick = () => clearAllOverrides(false);
  $('instCatFilter').onchange = () => renderInstPresets();
  $('instSearch').oninput = () => renderInstPresets();

  let lastFrame = performance.now();
  let lastInstTableSync = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (ctx) {
      const t = ctx.currentTime;
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        if (p.t <= t) {
          const c = synth.channels[p.ch];
          const v = (p.vel / 127) * (c.volume / 127) * (c.expression / 127);
          if (v > level[p.ch]) level[p.ch] = v;
          pending.splice(i, 1);
        }
      }
      if (pending.length > 4000) pending.splice(0, pending.length - 4000);
    }
    for (let i = 0; i < 16; i++) {
      level[i] = Math.max(0, level[i] - dt * 1.6);
      if (level[i] > peak[i]) peak[i] = level[i]; else peak[i] = Math.max(0, peak[i] - dt * 0.5);
      const m = meterEls[i];
      m.fill.style.height = (level[i] * 100).toFixed(1) + '%';
      m.peak.style.bottom = 'calc(' + (peak[i] * 100).toFixed(1) + '% - 2px)';
      if (synth) {
        const c = synth.channels[i];
        m.pan.style.left = 'calc(' + ((c.pan / 127) * 100).toFixed(0) + '% - 1px)';

        // Sync instrument selector if not manually overridden and not currently focused
        if (!channelOverrides[i]) {
          const key = c.bank + ':' + c.program;
          if (m.select.value !== key && document.activeElement !== m.select) {
            m.select.value = key;
          }
        }
        const curName = synth.channelPresetName(i) || '(none)';
        const isOver = !!channelOverrides[i];
        const titleText = 'Ch ' + (i + 1) + ': ' + curName + (isOver ? ' [SWAPPED - click to revert/change]' : ' [click to swap]');
        if (m.select.title !== titleText) m.select.title = titleText;
      }
    }
    if (player && player.song) {
      const pos = player.position;
      $('lcdTime').textContent = fmt(pos);
      $('lcdBpm').textContent = Math.round(player.bpmAt(pos) * player.speed);
      $('lcdVoices').textContent = String(synth.activeCount(ctx.currentTime)).padStart(2, '0');
      if (!seeking) $('seek').value = Math.round((pos / player.song.duration) * 1000);

      // Periodically keep Instruments window table updated during playback if visible
      if (now - lastInstTableSync > 350 && !$('dlgInst').classList.contains('hidden')) {
        lastInstTableSync = now;
        renderInstChTable();
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---------- controls wiring ---------- */
  let seeking = false;
  const seek = $('seek');
  seek.addEventListener('input', () => {
    seeking = true;
    if (player && player.song) $('lcdTime').textContent = fmt((seek.value / 1000) * player.song.duration);
  });
  seek.addEventListener('change', () => {
    seeking = false;
    if (player && player.song) player.seek((seek.value / 1000) * player.song.duration);
  });

  function bindSlider(id, key, label, apply) {
    const el = $(id);
    el.value = prefs[key];
    const show = () => { $(id + 'V').textContent = label(+el.value); };
    show();
    el.addEventListener('input', () => { prefs[key] = +el.value; show(); apply(+el.value); savePrefs(); });
  }
  bindSlider('vol', 'vol', (v) => v, (v) => synth && synth.setVolume(v / 100));
  bindSlider('rev', 'rev', (v) => v, (v) => synth && synth.setReverb(v / 100));
  bindSlider('comp', 'comp', (v) => v + '%', (v) => synth && synth.setCompressor(v / 100));
  bindSlider('spd', 'spd', (v) => v + '%', (v) => player && player.setSpeed(v / 100));
  bindSlider('key', 'key', (v) => (v > 0 ? '+' : '') + v, (v) => {
    if (!synth) return;
    synth.transpose = v;
    if (player.playing) player.seek(player.position);
  });
  $('poly').value = String(prefs.poly);
  $('poly').onchange = (e) => { prefs.poly = +e.target.value; if (synth) synth.setPolyphony(prefs.poly); savePrefs(); };

  const repeatModes = ['all', 'one', 'off'];
  const showRepeat = () => { $('btnLoop').textContent = 'REP: ' + prefs.repeat.toUpperCase(); $('btnLoop').classList.toggle('on', prefs.repeat !== 'off'); };
  showRepeat();
  $('btnLoop').onclick = () => { prefs.repeat = repeatModes[(repeatModes.indexOf(prefs.repeat) + 1) % 3]; showRepeat(); savePrefs(); };
  $('btnShuffle').classList.toggle('on', prefs.shuffle);
  $('btnShuffle').onclick = () => { prefs.shuffle = !prefs.shuffle; $('btnShuffle').classList.toggle('on', prefs.shuffle); savePrefs(); };

  $('btnPlay').onclick = togglePlay;
  $('btnStop').onclick = stop;
  $('btnRew').onclick = () => nudge(-5);
  $('btnFwd').onclick = () => nudge(5);
  $('btnPrev').onclick = () => { if (player && player.position > 3) player.seek(0); else select(nextIndex(-1), true); };
  $('btnNext').onclick = () => select(nextIndex(1), true);
  $('btnOpen').onclick = openMidi;
  $('btnAdd').onclick = openMidi;
  $('btnSf').onclick = openSf;
  $('btnSfFolder').onclick = () => {
    if (native && native.openSoundfontsFolder) native.openSoundfontsFolder();
    else status('SoundFonts folder: soundfonts/ in your app directory.');
  };
  $('btnWav').onclick = saveWav;
  $('btnResetCh').onclick = () => clearAllOverrides(false);
  $('btnRemove').onclick = () => {
    if (sel < 0) return;
    if (sel === cur) { stop(); cur = -1; } else if (sel < cur) cur--;
    list.splice(sel, 1);
    sel = Math.min(sel, list.length - 1);
    renderList();
  };
  $('btnClear').onclick = () => {
    stop();
    clearAllOverrides(true);
    list.length = 0;
    cur = sel = -1;
    renderList();
    $('lcdTitle').textContent = 'Drop .mid files here';
    $('lcdLen').textContent = '--:--';
  };
  $('btnAbout').onclick = () => $('about').classList.remove('hidden');
  $('aboutClose').onclick = () => $('about').classList.add('hidden');
  $('aboutOk').onclick = () => $('about').classList.add('hidden');

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if (e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft' && e.ctrlKey) nudge(-5);
    else if (e.key === 'ArrowRight' && e.ctrlKey) nudge(5);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); openMidi(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      if ($('dlgInst').classList.contains('hidden')) openInstWindow(); else closeInstWindow();
    }
    else if (e.key === 'Escape') {
      closeInstWindow();
      $('about').classList.add('hidden');
    }
    else if (e.key === 'Delete') $('btnRemove').click();
  });

  /* ---------- drag & drop ---------- */
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').classList.remove('hidden'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.add('hidden'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop').classList.add('hidden');
    const files = Array.from(e.dataTransfer.files).filter((f) => /\.(midi?|rmi|kar|sf2)$/i.test(f.name));
    addFiles(await readBrowserFiles(files));
  });

  /* ---------- boot ---------- */
  if (native) native.onOpenFiles((files) => addFiles(files));
  loadDefaultSoundfont().then(() => { if (native) native.ready(); });
})();