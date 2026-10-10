/* WinGroove Reboot - Web Audio SoundFont synthesizer
 * Voice chain: BufferSource -> [lowpass] -> envelope -> panner -> channel gain -> bus
 * Software Reverb: Stereo multi-tap echo + diffuse tail with master send control.
 * Sound Leveler: Dynamic range compressor with automatic makeup gain.
 */
(function (root) {
  'use strict';

  const tc = (x) => Math.pow(2, x / 1200); // timecents -> seconds
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* Vintage software reverb impulse response:
   * Combines discrete stereo early echo taps with a decaying diffuse tail.
   */
  function makeImpulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);

    // Discrete early echo taps (time in seconds, gain, pan: -1 left .. +1 right)
    const taps = [
      { t: 0.032, g: 0.55, pan: -0.7 },
      { t: 0.062, g: 0.45, pan: 0.7 },
      { t: 0.098, g: 0.40, pan: -0.5 },
      { t: 0.145, g: 0.35, pan: 0.6 },
      { t: 0.205, g: 0.28, pan: -0.3 },
      { t: 0.275, g: 0.24, pan: 0.4 },
      { t: 0.355, g: 0.18, pan: 0.0 },
      { t: 0.445, g: 0.14, pan: -0.4 },
    ];

    for (const tap of taps) {
      const idx = Math.floor(tap.t * rate);
      if (idx < len) {
        const lg = tap.g * (0.5 - tap.pan * 0.5);
        const rg = tap.g * (0.5 + tap.pan * 0.5);
        left[idx] += lg;
        right[idx] += rg;
      }
    }

    // Dense decaying diffuse body with subtle high-frequency damping
    let lpL = 0;
    let lpR = 0;
    for (let i = 0; i < len; i++) {
      const progress = i / len;
      const env = Math.pow(1 - progress, decay);
      const nL = (Math.random() * 2 - 1) * env * 0.65;
      const nR = (Math.random() * 2 - 1) * env * 0.65;
      lpL += (nL - lpL) * 0.6;
      lpR += (nR - lpR) * 0.6;
      left[i] += lpL;
      right[i] += lpR;
    }
    return buf;
  }

  class WGSynth {
    constructor(ctx, sf, opts) {
      opts = opts || {};
      this.ctx = ctx;
      this.sf = sf;
      this.buffers = new Map();
      this.voices = [];
      this.polyphony = opts.polyphony || 64;
      this.transpose = opts.transpose || 0;
      this.onNote = null;

      // Master output stage
      this.out = ctx.createGain();
      this.out.gain.value = opts.volume == null ? 0.8 : opts.volume;

      // Dynamic Compressor / Sound Leveling stage
      this.comp = ctx.createDynamicsCompressor();
      this.compGain = ctx.createGain();
      this.levelingAmount = opts.leveling == null ? 0.5 : opts.leveling;
      this.applyCompressor(this.levelingAmount, 0);

      // Main summing bus
      this.bus = ctx.createGain();
      this.bus.gain.value = 0.55;

      this.bus.connect(this.comp);
      this.comp.connect(this.compGain);
      this.compGain.connect(this.out);
      this.out.connect(ctx.destination);

      // Software Reverb & Echo stage
      this.reverbSendBus = ctx.createGain();
      this.reverbSendBus.gain.value = 1.0;

      this.reverb = ctx.createConvolver();
      this.reverb.normalize = false;
      this.reverb.buffer = makeImpulse(ctx, 2.4, 2.8);

      this.reverbLevel = ctx.createGain();
      this.reverbMaster = opts.reverb == null ? 0.6 : opts.reverb;
      this.reverbLevel.gain.value = this.reverbMaster * 1.5;

      this.reverbSendBus.connect(this.reverb);
      this.reverb.connect(this.reverbLevel);
      this.reverbLevel.connect(this.bus);

      // 16 MIDI Channels
      this.channels = [];
      for (let i = 0; i < 16; i++) {
        const gain = ctx.createGain();
        const send = ctx.createGain();
        gain.connect(this.bus);
        gain.connect(send);
        send.connect(this.reverbSendBus);
        const c = { index: i, gain, send, muted: false, override: null };
        this.channels.push(c);
        this.resetChannel(c, 0);
      }
    }

    /* ---------- configuration ---------- */
    setSoundfont(sf) {
      this.hardStop();
      this.sf = sf;
      this.buffers.clear();
      for (const c of this.channels) c.preset = undefined;
    }
    setVolume(v) { this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

    setReverb(v) {
      this.reverbMaster = Math.max(0, v);
      const t = this.ctx.currentTime;
      this.reverbLevel.gain.setTargetAtTime(this.reverbMaster * 1.5, t, 0.03);
      for (const c of this.channels) this.applySend(c, t);
    }

    setCompressor(amount) {
      this.levelingAmount = clamp(amount, 0, 1);
      this.applyCompressor(this.levelingAmount, this.ctx.currentTime);
    }

    applyCompressor(amount, t) {
      const comp = this.comp;
      const makeup = this.compGain;
      if (!comp || !makeup) return;
      if (amount <= 0.01) {
        // Transparent bypass
        comp.threshold.setTargetAtTime(0, t, 0.02);
        comp.ratio.setTargetAtTime(1, t, 0.02);
        makeup.gain.setTargetAtTime(1.0, t, 0.02);
      } else {
        // WinGroove sound leveling: brings up quiet passages and tames peaks
        const thresh = -12 - amount * 24; // -12dB down to -36dB
        const ratio = 2.5 + amount * 7.5; // 2.5:1 up to 10:1
        const knee = 12 - amount * 4;
        const makeupLevel = 1.0 + amount * 0.7; // Automatic makeup gain
        comp.threshold.setTargetAtTime(thresh, t, 0.02);
        comp.ratio.setTargetAtTime(ratio, t, 0.02);
        comp.knee.setTargetAtTime(knee, t, 0.02);
        comp.attack.setTargetAtTime(0.005, t, 0.02);
        comp.release.setTargetAtTime(0.18, t, 0.02);
        makeup.gain.setTargetAtTime(makeupLevel, t, 0.02);
      }
    }

    setPolyphony(n) { this.polyphony = n; }
    setMute(ch, m) {
      const c = this.channels[ch];
      c.muted = m;
      this.applyGain(c, this.ctx.currentTime);
    }
    setChannelOverride(ch, bank, program) {
      const c = this.channels[ch];
      if (!c) return;
      if (bank == null || program == null) {
        c.override = null;
      } else {
        c.override = { bank: +bank, program: +program };
      }
      c.preset = undefined;
      if (this.ctx) {
        const now = this.ctx.currentTime;
        for (const v of this.voices) {
          if (v.ch === ch && !v.released) this.releaseVoice(v, now, true);
        }
      }
    }
    clearChannelOverrides() {
      for (const c of this.channels) {
        c.override = null;
        c.preset = undefined;
      }
    }
    getChannelOverride(ch) {
      return this.channels[ch] ? this.channels[ch].override : null;
    }
    channelPresetName(ch) {
      const p = this.presetFor(this.channels[ch]);
      return p ? p.name : '';
    }
    channelSongPresetName(ch) {
      const c = this.channels[ch];
      const p = this.sf ? this.sf.find(c.bank, c.program) : null;
      return p ? p.name : '';
    }
    activeCount(t) {
      let n = 0;
      for (const v of this.voices) if (!v.stolen && v.start <= t && v.endTime > t) n++;
      return n;
    }

    /* Audition a note for testing instruments in the instrument window */
    auditionNote(bank, program, key = 60, vel = 100, duration = 0.8) {
      if (!this.sf || !this.ctx) return;
      const p = this.sf.find(bank, program);
      if (!p) return;
      const now = this.ctx.currentTime;
      const k = clamp(key, 0, 127);
      const v = clamp(vel, 1, 127);
      for (const r of p.regions) {
        if (k < r.keyLo || k > r.keyHi || v < r.velLo || v > r.velHi) continue;
        const dummyChannel = { index: -1, pan: 64, bend: 0, bendRange: 2, gain: this.bus };
        this.startVoice(dummyChannel, k, k, v, now, r);
      }
      setTimeout(() => {
        const t = this.ctx.currentTime;
        for (const voice of this.voices) {
          if (voice.ch === -1 && !voice.released) this.releaseVoice(voice, t, false);
        }
      }, Math.max(100, Math.floor(duration * 1000)));
    }

    /* ---------- channel state ---------- */
    resetChannel(c, t) {
      c.program = 0;
      c.bank = c.index === 9 ? 128 : 0;
      c.volume = 100;
      c.expression = 127;
      c.pan = 64;
      c.sustain = false;
      c.bend = 0;
      c.bendRange = 2;
      c.rpnMsb = 127;
      c.rpnLsb = 127;
      c.reverb = 40;
      c.preset = undefined;
      this.applyGain(c, t);
      this.applySend(c, t);
    }
    resetAll(t) { for (const c of this.channels) this.resetChannel(c, t); }

    applyGain(c, t) {
      const v = c.muted ? 0 : Math.pow(c.volume / 127, 2) * Math.pow(c.expression / 127, 2);
      c.gain.gain.setTargetAtTime(v, t, 0.008);
    }

    applySend(c, t) {
      // Vintage software synth send: combine channel CC91 send with a solid minimum baseline
      // so master reverb slider always yields audible reverberation/echo even if MIDI sends CC91=0
      const ccSend = c.reverb / 127;
      const effective = (0.35 + 0.65 * ccSend) * this.reverbMaster;
      c.send.gain.setTargetAtTime(effective, t, 0.02);
    }

    presetFor(c) {
      if (c.override) {
        return this.sf ? this.sf.find(c.override.bank, c.override.program) : null;
      }
      if (c.preset === undefined) c.preset = this.sf ? this.sf.find(c.bank, c.program) : null;
      return c.preset;
    }

    getBuffer(idx) {
      let b = this.buffers.get(idx);
      if (b) return b;
      const s = this.sf.samples[idx];
      const data = this.sf.data;
      const start = s.start;
      const end = clamp(s.end, start + 1, data.length);
      const rate = clamp(s.rate, 3000, 384000);
      const buffer = this.ctx.createBuffer(1, end - start, rate);
      const out = buffer.getChannelData(0);
      for (let i = 0; i < out.length; i++) out[i] = data[start + i] / 32768;
      b = { buffer, rate, rateFix: s.rate / rate };
      this.buffers.set(idx, b);
      return b;
    }

    /* ---------- MIDI event dispatch ---------- */
    handle(e, t) {
      switch (e.st) {
        case 0x90: this.noteOn(e.ch, e.a, e.b, t); break;
        case 0x80: this.noteOff(e.ch, e.a, t); break;
        case 0xb0: this.controlChange(e.ch, e.a, e.b, t); break;
        case 0xc0: this.programChange(e.ch, e.a); break;
        case 0xe0: this.pitchBend(e.ch, e.a, e.b, t); break;
        default: break;
      }
    }

    noteOn(ch, key, vel, t) {
      const c = this.channels[ch];
      const bank = c.override ? c.override.bank : c.bank;
      const drum = bank === 128;
      const k = drum ? key : clamp(key + this.transpose, 0, 127);
      const p = this.presetFor(c);
      if (!p) return;
      for (const r of p.regions) {
        if (k < r.keyLo || k > r.keyHi || vel < r.velLo || vel > r.velHi) continue;
        this.startVoice(c, key, k, vel, t, r);
      }
      if (this.onNote) this.onNote(ch, k, vel, t);
    }

    startVoice(c, rawKey, key, vel, t, r) {
      const ctx = this.ctx;
      const g = r.gen;
      const s = this.sf.samples[r.sample];

      if (g[57]) {
        for (const v of this.voices) {
          if (v.ch === c.index && v.excl === g[57] && v.endTime > t && !v.released) this.releaseVoice(v, t, true);
        }
      }
      this.enforcePolyphony(t);

      const bi = this.getBuffer(r.sample);
      const len = bi.buffer.length;
      const src = ctx.createBufferSource();
      src.buffer = bi.buffer;

      const root = g[58] >= 0 ? g[58] : s.pitch;
      const nk = g[46] >= 0 ? g[46] : key;
      const semis = ((nk - root) * g[56]) / 100 + g[51] + (g[52] + s.corr) / 100;
      const rate = Math.pow(2, semis / 12) * bi.rateFix;
      src.playbackRate.value = rate;
      src.detune.value = c.bend * c.bendRange * 100;

      const offset = clamp(g[0] + g[4] * 32768, 0, len - 1);
      const mode = g[54] & 3;
      let looping = false;
      if (mode === 1 || mode === 3) {
        const ls = clamp(s.loopStart - s.start + g[2] + g[45] * 32768, 0, len);
        const le = clamp(s.loopEnd - s.start + g[3] + g[50] * 32768, 0, len);
        if (le - ls > 1) {
          src.loop = true;
          src.loopStart = ls / bi.rate;
          src.loopEnd = le / bi.rate;
          looping = true;
        }
      }

      // Volume envelope (SF2 DAHDSR)
      const velAmp = Math.pow((g[47] >= 0 ? g[47] : vel) / 127, 2);
      const peak = Math.pow(10, -Math.max(0, g[48]) / 200) * velAmp;
      const delay = tc(g[33]);
      const attack = tc(g[34]);
      const hold = tc(g[35] + g[39] * (60 - key));
      const decay = tc(g[36] + g[40] * (60 - key));
      const release = clamp(tc(g[38]), 0.006, 8);
      const sustain = Math.pow(10, -clamp(g[37], 0, 1440) / 200);

      const env = ctx.createGain();
      const e = env.gain;
      e.value = 0;
      const t0 = t + (delay > 0.0015 ? delay : 0);
      if (attack < 0.002) e.setValueAtTime(peak, t0);
      else { e.setValueAtTime(0, t0); e.linearRampToValueAtTime(peak, t0 + attack); }
      const td = t0 + attack + (hold > 0.0015 ? hold : 0);
      e.setValueAtTime(peak, td);
      if (sustain < 0.999) e.setTargetAtTime(peak * sustain, td, Math.max(decay, 0.002) / 5);

      let head = src;
      let filter = null;
      if (g[8] < 13500) {
        filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = clamp(8.176 * tc(g[8]), 20, ctx.sampleRate / 2 - 100);
        filter.Q.value = clamp(g[9] / 10, 0, 40);
        src.connect(filter);
        head = filter;
      }
      head.connect(env);
      const pan = ctx.createStereoPanner();
      pan.pan.value = clamp(g[17] / 500 + (c.pan - 64) / 63, -1, 1);
      env.connect(pan);
      pan.connect(c.gain);
      src.start(t, offset / bi.rate);

      const v = {
        ch: c.index, key: rawKey, src, env, excl: g[57], start: t, release, mode,
        released: false, sustained: false, stolen: false,
        endTime: looping ? Infinity : t + (len - offset) / bi.rate / rate + 0.02,
        nodes: [src, filter, env, pan],
      };
      src.onended = () => {
        v.endTime = Math.min(v.endTime, this.ctx.currentTime);
        for (const n of v.nodes) if (n) { try { n.disconnect(); } catch (_) { /* already gone */ } }
      };
      this.voices.push(v);
    }

    enforcePolyphony(t) {
      this.voices = this.voices.filter((v) => v.endTime > t);
      const alive = this.voices.filter((v) => !v.stolen);
      while (alive.length >= this.polyphony) {
        const victim = alive.find((v) => v.released) || alive[0]; // oldest first
        this.releaseVoice(victim, t, true);
        victim.stolen = true;
        alive.splice(alive.indexOf(victim), 1);
      }
    }

    releaseVoice(v, t, fast) {
      const rel = fast ? 0.012 : v.release;
      const e = v.env.gain;
      if (e.cancelAndHoldAtTime) e.cancelAndHoldAtTime(t);
      else e.cancelScheduledValues(t);
      e.setTargetAtTime(0, t, rel / 5);
      const stopAt = Math.max(t, v.start) + rel * 1.5 + 0.02;
      try { v.src.stop(stopAt); } catch (_) { /* ignore */ }
      v.released = true;
      v.endTime = Math.min(v.endTime, stopAt);
    }

    noteOff(ch, key, t) {
      const c = this.channels[ch];
      for (const v of this.voices) {
        if (v.ch !== ch || v.key !== key || v.released) continue;
        if (c.sustain) v.sustained = true;
        else this.releaseVoice(v, t);
      }
    }

    controlChange(ch, cc, val, t) {
      const c = this.channels[ch];
      switch (cc) {
        case 0: // bank select MSB (GM2/XG drum banks map to 128)
          if (ch !== 9) {
            c.bank = val === 120 || val === 127 ? 128 : val;
            if (!c.override) c.preset = undefined;
          }
          break;
        case 6: if (c.rpnMsb === 0 && c.rpnLsb === 0) c.bendRange = val; break;
        case 7: c.volume = val; this.applyGain(c, t); break;
        case 10: c.pan = val; break;
        case 11: c.expression = val; this.applyGain(c, t); break;
        case 64:
          c.sustain = val >= 64;
          if (!c.sustain) for (const v of this.voices) if (v.ch === ch && v.sustained && !v.released) this.releaseVoice(v, t);
          break;
        case 91:
          c.reverb = val;
          this.applySend(c, t);
          break;
        case 100: c.rpnLsb = val; break;
        case 101: c.rpnMsb = val; break;
        case 120: for (const v of this.voices) if (v.ch === ch) this.releaseVoice(v, t, true); break;
        case 121:
          c.expression = 127; c.bend = 0; c.sustain = false; c.rpnMsb = 127; c.rpnLsb = 127;
          this.applyGain(c, t);
          break;
        case 123: for (const v of this.voices) if (v.ch === ch && !v.released) this.releaseVoice(v, t); break;
        default: break;
      }
    }

    programChange(ch, program) {
      const c = this.channels[ch];
      c.program = program;
      if (!c.override) c.preset = undefined;
    }

    pitchBend(ch, lsb, msb, t) {
      const c = this.channels[ch];
      c.bend = (((msb << 7) | lsb) - 8192) / 8192;
      const cents = c.bend * c.bendRange * 100;
      for (const v of this.voices) if (v.ch === ch && v.endTime > t) v.src.detune.setValueAtTime(cents, t);
    }

    allNotesOff(t) { for (const v of this.voices) if (!v.released) this.releaseVoice(v, t); }

    hardStop() {
      const now = this.ctx.currentTime;
      for (const v of this.voices) {
        try {
          v.env.gain.cancelScheduledValues(0);
          v.env.gain.setValueAtTime(0, now);
          v.src.stop();
        } catch (_) { /* ignore */ }
      }
      this.voices = [];
    }
  }

  /* Render a whole song offline (MIDI -> WAV, like the original WinGroove converter). */
  WGSynth.renderOffline = function (sf, song, opts, onProgress) {
    opts = opts || {};
    const speed = opts.speed || 1;
    const sr = 44100;
    const dur = song.duration / speed + 2.5;
    const Offline = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    const oc = new Offline(2, Math.ceil(dur * sr), sr);
    const syn = new WGSynth(oc, sf, opts);
    (opts.mutedChannels || []).forEach((m, i) => { if (m) syn.setMute(i, true); });
    if (opts.channelOverrides) {
      opts.channelOverrides.forEach((ov, i) => {
        if (ov) syn.setChannelOverride(i, ov.bank, ov.program);
      });
    }
    const evs = song.events;
    let i = 0;
    const sched = (limit) => {
      while (i < evs.length && evs[i].time / speed < limit) {
        const e = evs[i++];
        if (e.type !== 'tempo') syn.handle(e, e.time / speed + 0.05);
      }
    };
    const WIN = 4;
    sched(WIN);
    for (let k = 1; k * WIN < dur; k++) {
      const at = k * WIN - 1;
      oc.suspend(at).then(() => {
        sched((k + 1) * WIN);
        if (onProgress) onProgress(at / dur);
        oc.resume();
      });
    }
    return oc.startRendering();
  };

  root.WGSynth = WGSynth;
  if (typeof module !== 'undefined' && module.exports) module.exports = WGSynth;
})(typeof window !== 'undefined' ? window : globalThis);