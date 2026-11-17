'use strict';
/* WinGroove Reboot - Standalone Instruments Window Controller
 * Provides an authentic 8x2 grid layout matching classic WinGroove,
 * full text visibility of instrument presets, live auditioning,
 * and bidirectional sync with the main Player window.
 */

const native = window.wgNative || null;
const $ = (id) => document.getElementById(id);

const GM_CATEGORIES = [
  'Piano', 'Chromatic Percussion', 'Organ', 'Guitar',
  'Bass', 'Strings & Ensemble', 'Brass', 'Reed',
  'Pipe', 'Synth Lead', 'Synth Pad', 'Synth FX',
  'Ethnic', 'Percussive', 'Sound Effects', 'Drum Kits'
];

let soundfont = null;
let currentSongTitle = '';
let channelStates = [];
for (let i = 0; i < 16; i++) {
  channelStates.push({
    index: i,
    bank: i === 9 ? 128 : 0,
    program: 0,
    presetName: i === 9 ? 'Standard Kit' : 'Acoustic Grand Piano',
    defaultBank: i === 9 ? 128 : 0,
    defaultProgram: 0,
    defaultPresetName: i === 9 ? 'Standard Kit' : 'Acoustic Grand Piano',
    isOverride: false,
    activeNotes: 0,
  });
}

let activeTargetCh = 0;
let isAttached = true;
let drawerOpen = false;

// Audition Synth in Instruments Window
let auditionCtx = null;
function getAuditionCtx() {
  if (!auditionCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) auditionCtx = new AudioCtx();
  }
  if (auditionCtx && auditionCtx.state === 'suspended') auditionCtx.resume();
  return auditionCtx;
}

function playAuditionVoice(bank, program, noteNum) {
  if (!soundfont) return;
  const ctx = getAuditionCtx();
  if (!ctx) return;

  const preset = soundfont.presets.find((p) => p.bank === bank && p.program === program) ||
                 soundfont.presets.find((p) => (bank === 128 ? p.bank === 128 : p.bank === 0));
  if (!preset) return;

  const note = noteNum || 60;
  const zones = preset.zones.filter((z) => {
    const lo = z.keyRange ? z.keyRange.lo : 0;
    const hi = z.keyRange ? z.keyRange.hi : 127;
    return note >= lo && note <= hi;
  });

  const now = ctx.currentTime;
  zones.forEach((z) => {
    const s = soundfont.samples[z.sampleID];
    if (!s || !s.buffer) return;

    const src = ctx.createBufferSource();
    src.buffer = s.buffer;

    const root = z.overridingRootKey != null ? z.overridingRootKey : (s.originalPitch || 60);
    const tune = (z.coarseTune || 0) * 100 + (z.fineTune || 0);
    src.detune.value = (note - root) * 100 + tune;

    const g = ctx.createGain();
    const att = Math.max(0.005, (z.generators && z.generators[34] ? Math.pow(2, z.generators[34] / 1200) : 0.01));
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.5, now + att);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);

    src.connect(g);
    g.connect(ctx.destination);
    src.start(now);
    src.stop(now + 1.25);
  });
}

function renderGrid() {
  const colL = $('colLeft');
  const colR = $('colRight');
  colL.innerHTML = '';
  colR.innerHTML = '';

  for (let i = 0; i < 16; i++) {
    const st = channelStates[i];
    const row = document.createElement('div');
    row.className = 'inst-row' + (st.isOverride ? ' is-override' : '') + (i === activeTargetCh ? ' active-target' : '');
    row.dataset.ch = i;

    const chNum = i + 1;
    row.innerHTML =
      '<div class="inst-ch-badge" title="Channel ' + chNum + '">' + (chNum < 10 ? '0' + chNum : chNum) + '</div>' +
      '<div class="inst-display-box" title="Click to browse instruments">' +
        '<span class="inst-text">' + escapeHtml(st.presetName) + '</span>' +
      '</div>' +
      '<div class="inst-spin-btns">' +
        '<button class="inst-spin-up" title="Previous Instrument">▲</button>' +
        '<button class="inst-spin-down" title="Next Instrument">▼</button>' +
      '</div>';

    // Click on display box opens drawer and sets active target
    const box = row.querySelector('.inst-display-box');
    box.onclick = () => {
      selectTargetChannel(i);
      openDrawer();
    };

    // Spin buttons step through presets
    row.querySelector('.inst-spin-up').onclick = (e) => {
      e.stopPropagation();
      stepChannelPreset(i, -1);
    };
    row.querySelector('.inst-spin-down').onclick = (e) => {
      e.stopPropagation();
      stepChannelPreset(i, 1);
    };

    if (i < 8) colL.appendChild(row);
    else colR.appendChild(row);
  }
}

function updateChannelVisuals() {
  const rows = document.querySelectorAll('.inst-row');
  rows.forEach((row) => {
    const ch = parseInt(row.dataset.ch, 10);
    const st = channelStates[ch];
    if (!st) return;

    row.classList.toggle('is-override', !!st.isOverride);
    row.classList.toggle('active-target', ch === activeTargetCh);

    const txt = row.querySelector('.inst-text');
    if (txt && txt.textContent !== st.presetName) {
      txt.textContent = st.presetName;
    }
  });
}

function selectTargetChannel(ch) {
  activeTargetCh = ch;
  updateChannelVisuals();
  $('drawerTargetLabel').textContent = 'Ch ' + (ch + 1) + ': ' + channelStates[ch].presetName + (ch === 9 ? ' [Drums]' : '');
}

function stepChannelPreset(ch, dir) {
  if (!soundfont || !soundfont.presets) return;
  const isDrums = ch === 9;
  const valid = soundfont.presets.filter((p) => (isDrums ? p.bank === 128 : p.bank === 0));
  if (!valid.length) return;

  const st = channelStates[ch];
  let curIdx = valid.findIndex((p) => p.bank === st.bank && p.program === st.program);
  if (curIdx === -1) curIdx = 0;

  let nextIdx = curIdx + dir;
  if (nextIdx < 0) nextIdx = valid.length - 1;
  if (nextIdx >= valid.length) nextIdx = 0;

  const target = valid[nextIdx];
  applyPresetOverride(ch, target.bank, target.program, target.name);
}

function applyPresetOverride(ch, bank, program, name) {
  channelStates[ch].bank = bank;
  channelStates[ch].program = program;
  channelStates[ch].presetName = name;
  channelStates[ch].isOverride = (bank !== channelStates[ch].defaultBank || program !== channelStates[ch].defaultProgram);

  updateChannelVisuals();

  // Send command to player
  if (native && native.sendInstrumentsCmd) {
    native.sendInstrumentsCmd({
      type: 'setOverride',
      ch,
      bank,
      program,
      name
    });
  }

  $('instStatusText').textContent = 'Ch ' + (ch + 1) + ' set to: ' + name;
}

function revertChannel(ch) {
  const st = channelStates[ch];
  st.bank = st.defaultBank;
  st.program = st.defaultProgram;
  st.presetName = st.defaultPresetName;
  st.isOverride = false;

  updateChannelVisuals();

  if (native && native.sendInstrumentsCmd) {
    native.sendInstrumentsCmd({
      type: 'revertOverride',
      ch
    });
  }

  $('instStatusText').textContent = 'Ch ' + (ch + 1) + ' restored to default (' + st.defaultPresetName + ')';
}

function resetAllChannels() {
  for (let i = 0; i < 16; i++) {
    const st = channelStates[i];
    st.bank = st.defaultBank;
    st.program = st.defaultProgram;
    st.presetName = st.defaultPresetName;
    st.isOverride = false;
  }
  updateChannelVisuals();

  if (native && native.sendInstrumentsCmd) {
    native.sendInstrumentsCmd({ type: 'resetAllOverrides' });
  }

  $('instStatusText').textContent = 'All channels restored to song defaults';
}

function openDrawer() {
  drawerOpen = true;
  $('instDrawer').classList.add('open');
  renderDrawerPresets();
  if (native && native.setInstrumentsHeight) {
    native.setInstrumentsHeight(560);
  }
}

function closeDrawer() {
  drawerOpen = false;
  $('instDrawer').classList.remove('open');
  if (native && native.setInstrumentsHeight) {
    native.setInstrumentsHeight(380);
  }
}

function renderDrawerPresets() {
  const listbox = $('instListbox');
  listbox.innerHTML = '';
  if (!soundfont || !soundfont.presets) {
    listbox.innerHTML = '<div class="drawer-empty-msg">No SoundFont loaded yet</div>';
    return;
  }

  const query = ($('instSearch').value || '').trim().toLowerCase();
  const cat = $('instCatFilter').value;
  const isDrumsTarget = activeTargetCh === 9;

  let filtered = soundfont.presets.filter((p) => {
    if (isDrumsTarget && p.bank !== 128 && cat !== 'all') return false;
    if (!isDrumsTarget && p.bank === 128 && cat !== 'drums') return false;

    if (query && !p.name.toLowerCase().includes(query)) return false;

    if (cat === 'drums') return p.bank === 128;
    if (cat && p.bank === 0) {
      const idx = Math.floor(p.program / 8);
      const catKey = getCategoryKey(idx);
      if (catKey !== cat) return false;
    }
    return true;
  });

  if (!filtered.length) {
    listbox.innerHTML = '<div class="drawer-empty-msg">No matching instruments found</div>';
    return;
  }

  filtered.forEach((p) => {
    const item = document.createElement('div');
    item.className = 'drawer-preset-item';
    const isCur = channelStates[activeTargetCh].bank === p.bank && channelStates[activeTargetCh].program === p.program;
    if (isCur) item.classList.add('selected');

    item.innerHTML =
      '<span class="preset-prog">' + (p.bank === 128 ? 'Drum ' + p.program : (p.program + 1)) + '</span>' +
      '<span class="preset-name">' + escapeHtml(p.name) + '</span>';

    item.onclick = () => {
      document.querySelectorAll('.drawer-preset-item').forEach((el) => el.classList.remove('selected'));
      item.classList.add('selected');
      applyPresetOverride(activeTargetCh, p.bank, p.program, p.name);
    };

    item.ondblclick = () => {
      applyPresetOverride(activeTargetCh, p.bank, p.program, p.name);
      playAuditionVoice(p.bank, p.program, parseInt($('auditionNote').value, 10) || 60);
    };

    listbox.appendChild(item);
  });
}

function getCategoryKey(catIdx) {
  const map = [
    'piano', 'chromatic', 'organ', 'guitar',
    'bass', 'strings', 'brass', 'reed',
    'pipe', 'synth_lead', 'synth_pad', 'synth_fx',
    'ethnic', 'percussive', 'sfx'
  ];
  return map[catIdx] || '';
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// IPC Handlers from Player
if (native) {
  if (native.onInstrumentsState) {
    native.onInstrumentsState((st) => {
      if (st.soundfont) {
        soundfont = st.soundfont;
      }
      if (st.songTitle) {
        currentSongTitle = st.songTitle;
      }
      if (st.channels && Array.isArray(st.channels)) {
        for (let i = 0; i < 16; i++) {
          if (st.channels[i]) {
            Object.assign(channelStates[i], st.channels[i]);
          }
        }
        updateChannelVisuals();
      }
    });
  }

  if (native.onInstrumentsWinStatus) {
    native.onInstrumentsWinStatus((status) => {
      if (typeof status.attached === 'boolean') {
        isAttached = status.attached;
        $('btnDockToggle').classList.toggle('active', isAttached);
        $('btnDockToggle').title = isAttached ? 'Attached to Player (Click to Float)' : 'Floating (Click to Dock)';
      }
    });
  }
}

// Window Chrome Buttons
$('btnInstClose').onclick = () => {
  if (native && native.toggleInstrumentsWindow) {
    native.toggleInstrumentsWindow(false);
  }
};

$('btnDockToggle').onclick = () => {
  isAttached = !isAttached;
  if (native && native.setInstrumentsAttached) {
    native.setInstrumentsAttached(isAttached, 'bottom');
  }
};

// Drawer controls
$('instSearch').oninput = renderDrawerPresets;
$('instCatFilter').onchange = renderDrawerPresets;
$('btnCloseDrawer').onclick = closeDrawer;
$('btnRevertChannel').onclick = () => revertChannel(activeTargetCh);
$('btnResetAll').onclick = resetAllChannels;

$('btnAudition').onclick = () => {
  const st = channelStates[activeTargetCh];
  const note = parseInt($('auditionNote').value, 10) || 60;
  playAuditionVoice(st.bank, st.program, note);
};

// Initial setup
renderGrid();
updateChannelVisuals();

// Ask Player for current state on startup
if (native && native.sendInstrumentsCmd) {
  native.sendInstrumentsCmd({ type: 'queryState' });
}
