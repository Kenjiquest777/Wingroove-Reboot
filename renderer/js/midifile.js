/* WinGroove Reboot - Standard MIDI File parser (format 0/1/2, RMID wrapper, SMPTE timing) */
(function (root) {
  'use strict';

  function latin1(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length && i < 128; i++) {
      const c = bytes[i];
      if (c >= 32) s += String.fromCharCode(c);
    }
    return s;
  }

  function parse(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const at = (i) => String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);
    const u32 = (i) => ((u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3]) >>> 0;
    const u16 = (i) => (u8[i] << 8) | u8[i + 1];

    // Locate the header (handles .rmi RIFF wrappers and junk prefixes)
    let base = -1;
    for (let i = 0; i + 14 <= u8.length && i < 8192; i++) {
      if (u8[i] === 0x4d && at(i) === 'MThd') { base = i; break; }
    }
    if (base < 0) throw new Error('Not a Standard MIDI File');

    const hdrLen = u32(base + 4);
    const format = u16(base + 8);
    const ntracks = u16(base + 10);
    const division = u16(base + 12);

    let p = base + 8 + hdrLen;
    const raw = [];
    let seq = 0;
    let title = '';

    for (let t = 0; t < ntracks && p + 8 <= u8.length; t++) {
      while (p + 8 <= u8.length && at(p) !== 'MTrk') p += 8 + u32(p + 4);
      if (p + 8 > u8.length) break;
      const len = u32(p + 4);
      const end = Math.min(u8.length, p + 8 + len);
      let q = p + 8;
      let tick = 0;
      let running = 0;
      const vlq = () => {
        let v = 0;
        let b;
        do { b = u8[q++]; v = v * 128 + (b & 0x7f); } while (b & 0x80 && q < end);
        return v;
      };

      while (q < end) {
        tick += vlq();
        if (q >= end) break;
        let st = u8[q];
        if (st & 0x80) q++;
        else { if (!running) break; st = running; }

        if (st === 0xff) {
          const type = u8[q++];
          const l = vlq();
          const d = u8.subarray(q, q + l);
          q += l;
          if (type === 0x51 && l >= 3) raw.push({ tick, seq: seq++, type: 'tempo', uspq: (d[0] << 16) | (d[1] << 8) | d[2] });
          else if (type === 0x03 && !title && t === 0) title = latin1(d).trim();
          else if (type === 0x2f) break;
          continue;
        }
        if (st === 0xf0 || st === 0xf7) { q += vlq(); running = 0; continue; }
        if (st > 0xf0) continue;

        running = st;
        const cmd = st & 0xf0;
        const ch = st & 0x0f;
        const a = u8[q++] & 0x7f;
        const b = cmd === 0xc0 || cmd === 0xd0 ? 0 : u8[q++] & 0x7f;
        if (cmd === 0x90 && b === 0) raw.push({ tick, seq: seq++, st: 0x80, ch, a, b: 64 });
        else if (cmd !== 0xa0 && cmd !== 0xd0) raw.push({ tick, seq: seq++, st: cmd, ch, a, b });
      }
      p = end;
    }

    // Merge tracks: controllers first, then note-offs, then note-ons at equal ticks
    const prio = (e) => (e.type === 'tempo' ? 0 : e.st === 0x90 ? 2 : e.st === 0x80 ? 1 : 0);
    raw.sort((x, y) => x.tick - y.tick || prio(x) - prio(y) || x.seq - y.seq);

    const smpte = (division & 0x8000) !== 0;
    const secPerTickSmpte = smpte ? 1 / ((256 - (division >> 8)) * (division & 0xff || 1)) : 0;
    const tpq = division || 480;
    let uspq = 500000;
    let lastTick = 0;
    let time = 0;
    const tempos = [];
    let noteCount = 0;
    for (const e of raw) {
      time += (e.tick - lastTick) * (smpte ? secPerTickSmpte : uspq / 1e6 / tpq);
      lastTick = e.tick;
      e.time = time;
      if (e.type === 'tempo') { uspq = e.uspq || 500000; tempos.push({ time, uspq }); }
      else if (e.st === 0x90) noteCount++;
    }

    return { format, tracks: ntracks, division, events: raw, tempos, title, noteCount, duration: time + 1 };
  }

  const api = { parse };
  root.WGMidi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
