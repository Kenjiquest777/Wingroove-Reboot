/* WinGroove Reboot - look-ahead MIDI sequencer driving WGSynth */
(function (root) {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const LOOKAHEAD = 0.15;

  class WGPlayer {
    constructor(synth) {
      this.synth = synth;
      this.song = null;
      this.playing = false;
      this.speed = 1;
      this.idx = 0;
      this.startCtx = 0;
      this.startSong = 0;
      this.seekPos = 0;
      this.timer = null;
      this.onEnd = null;
    }
    get ctx() { return this.synth.ctx; }

    load(song) { this.stop(); this.song = song; this.seekPos = 0; }

    get position() {
      if (!this.song) return 0;
      if (!this.playing) return this.seekPos;
      return clamp(this.startSong + (this.ctx.currentTime - this.startCtx) * this.speed, 0, this.song.duration);
    }

    play() {
      if (!this.song || this.playing) return;
      const now = this.ctx.currentTime;
      this.synth.hardStop();
      this.synth.resetAll(now);
      // Chase controllers / programs / bends up to the seek point
      const ev = this.song.events;
      let i = 0;
      while (i < ev.length && ev[i].time < this.seekPos) {
        const e = ev[i];
        const skip = e.type === 'tempo' || e.st === 0x90 || e.st === 0x80 ||
          (e.st === 0xb0 && (e.a === 64 || e.a === 120 || e.a === 123));
        if (!skip) this.synth.handle(e, now);
        i++;
      }
      this.idx = i;
      this.startSong = this.seekPos;
      this.startCtx = now + 0.06;
      this.playing = true;
      this.pump();
      this.timer = setInterval(() => this.pump(), 25);
    }

    pump() {
      if (!this.playing) return;
      const ctx = this.ctx;
      const horizon = ctx.currentTime + LOOKAHEAD;
      const ev = this.song.events;
      while (this.idx < ev.length) {
        const e = ev[this.idx];
        const t = this.startCtx + (e.time - this.startSong) / this.speed;
        if (t > horizon) break;
        if (e.type !== 'tempo') this.synth.handle(e, Math.max(t, ctx.currentTime));
        this.idx++;
      }
      if (this.idx >= ev.length && this.position >= this.song.duration) this.finish();
    }

    halt() {
      clearInterval(this.timer);
      this.timer = null;
      this.playing = false;
      this.synth.hardStop();
    }
    pause() {
      if (!this.playing) return;
      this.seekPos = this.position;
      this.halt();
    }
    stop() {
      if (this.playing) this.halt();
      this.seekPos = 0;
    }
    seek(sec) {
      if (!this.song) return;
      const was = this.playing;
      if (was) this.halt();
      this.seekPos = clamp(sec, 0, this.song.duration);
      if (was) this.play();
    }
    setSpeed(s) {
      if (this.playing) {
        const pos = this.position;
        this.startSong = pos;
        this.startCtx = this.ctx.currentTime;
      }
      this.speed = s;
    }
    finish() {
      clearInterval(this.timer);
      this.timer = null;
      this.playing = false;
      this.seekPos = 0;
      this.synth.allNotesOff(this.ctx.currentTime);
      if (this.onEnd) setTimeout(this.onEnd, 0);
    }
    bpmAt(pos) {
      if (!this.song) return 0;
      let us = 500000;
      for (const e of this.song.tempos) { if (e.time > pos) break; us = e.uspq; }
      return 60e6 / us;
    }
  }

  root.WGPlayer = WGPlayer;
  if (typeof module !== 'undefined' && module.exports) module.exports = WGPlayer;
})(typeof window !== 'undefined' ? window : globalThis);
