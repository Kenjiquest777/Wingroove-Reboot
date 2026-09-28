/* WinGroove Reboot - SoundFont 2 (.sf2) parser
 * Parses RIFF/sfbk files into presets -> flattened regions (preset + instrument
 * generators merged per SF2.04 rules) plus raw 16-bit sample data.
 */
(function (root) {
  'use strict';

  const GEN_COUNT = 61;
  // Generators that are NOT additive at preset level (SF2.04 section 8.5)
  const NON_ADDITIVE = new Set([0, 1, 2, 3, 4, 12, 41, 43, 44, 45, 46, 47, 50, 53, 54, 57, 58]);
  const UNSIGNED = new Set([41, 43, 44, 53]);

  const DEFAULTS = new Int32Array(GEN_COUNT);
  DEFAULTS[8] = 13500; // initialFilterFc (open)
  for (const g of [21, 23, 25, 26, 27, 28, 30, 33, 34, 35, 36, 38]) DEFAULTS[g] = -12000;
  DEFAULTS[43] = 127 << 8; // keyRange 0-127
  DEFAULTS[44] = 127 << 8; // velRange 0-127
  DEFAULTS[46] = -1; // keynum
  DEFAULTS[47] = -1; // velocity
  DEFAULTS[56] = 100; // scaleTuning
  DEFAULTS[58] = -1; // overridingRootKey

  function str(dv, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = dv.getUint8(off + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }
  function fourcc(dv, off) {
    return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  }

  function parse(buffer) {
    if (buffer instanceof Uint8Array) buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const dv = new DataView(buffer);
    if (buffer.byteLength < 12 || fourcc(dv, 0) !== 'RIFF' || fourcc(dv, 8) !== 'sfbk') {
      throw new Error('Not a SoundFont 2 (.sf2) file');
    }

    const chunks = {};
    const end = Math.min(buffer.byteLength, 8 + dv.getUint32(4, true));
    let off = 12;
    while (off + 8 <= end) {
      const id = fourcc(dv, off);
      const size = dv.getUint32(off + 4, true);
      if (id === 'LIST') {
        const listEnd = Math.min(end, off + 8 + size);
        let p = off + 12;
        while (p + 8 <= listEnd) {
          const sid = fourcc(dv, p);
          const ss = dv.getUint32(p + 4, true);
          chunks[sid] = { off: p + 8, size: Math.min(ss, listEnd - p - 8) };
          p += 8 + ss + (ss & 1);
        }
      }
      off += 8 + size + (size & 1);
    }
    for (const n of ['smpl', 'phdr', 'pbag', 'pgen', 'inst', 'ibag', 'igen', 'shdr']) {
      if (!chunks[n]) throw new Error('SoundFont is missing the "' + n + '" chunk');
    }

    const smpl = chunks.smpl;
    const data = new Int16Array(buffer.slice(smpl.off, smpl.off + (smpl.size & ~1)));
    const name = chunks.INAM ? str(dv, chunks.INAM.off, chunks.INAM.size) : 'SoundFont';

    const records = (id, size, fn) => {
      const c = chunks[id];
      const out = [];
      const n = Math.floor(c.size / size);
      for (let i = 0; i < n; i++) out.push(fn(c.off + i * size));
      return out;
    };
    const bag = (o) => dv.getUint16(o, true);
    const gen = (o) => ({ op: dv.getUint16(o, true), s: dv.getInt16(o + 2, true), u: dv.getUint16(o + 2, true) });

    const phdr = records('phdr', 38, (o) => ({
      name: str(dv, o, 20),
      program: dv.getUint16(o + 20, true),
      bank: dv.getUint16(o + 22, true),
      bag: dv.getUint16(o + 24, true),
    }));
    const pbag = records('pbag', 4, bag);
    const pgen = records('pgen', 4, gen);
    const inst = records('inst', 22, (o) => ({ name: str(dv, o, 20), bag: dv.getUint16(o + 20, true) }));
    const ibag = records('ibag', 4, bag);
    const igen = records('igen', 4, gen);
    const samples = records('shdr', 46, (o) => {
      const pitch = dv.getUint8(o + 40);
      return {
        name: str(dv, o, 20),
        start: dv.getUint32(o + 20, true),
        end: dv.getUint32(o + 24, true),
        loopStart: dv.getUint32(o + 28, true),
        loopEnd: dv.getUint32(o + 32, true),
        rate: dv.getUint32(o + 36, true) || 44100,
        pitch: pitch > 127 ? 60 : pitch,
        corr: dv.getInt8(o + 41),
        type: dv.getUint16(o + 44, true),
      };
    });

    const zoneGens = (bags, gens, from, to) => {
      const zones = [];
      for (let b = from; b < to && b + 1 < bags.length; b++) {
        zones.push(gens.slice(bags[b], Math.min(bags[b + 1], gens.length)));
      }
      return zones;
    };
    const apply = (g, list) => {
      for (const x of list) if (x.op < GEN_COUNT) g[x.op] = UNSIGNED.has(x.op) ? x.u : x.s;
    };

    // Instruments: global zone + local zones, local overrides global.
    const instruments = [];
    for (let i = 0; i + 1 < inst.length; i++) {
      const zones = zoneGens(ibag, igen, inst[i].bag, inst[i + 1].bag);
      let global = null;
      const out = [];
      zones.forEach((z, idx) => {
        if (!z.some((x) => x.op === 53)) {
          if (idx === 0) global = z;
          return;
        }
        const g = new Int32Array(DEFAULTS);
        if (global) apply(g, global);
        apply(g, z);
        const s = samples[g[53]];
        if (!s || (s.type & 0x8000) || s.end <= s.start || s.end > data.length) return;
        out.push(g);
      });
      instruments.push({ name: inst[i].name, zones: out });
    }

    // Presets: preset generators are added on top of instrument generators.
    const presets = [];
    for (let p = 0; p + 1 < phdr.length; p++) {
      const zones = zoneGens(pbag, pgen, phdr[p].bag, phdr[p + 1].bag);
      let global = null;
      const regions = [];
      zones.forEach((z, idx) => {
        if (!z.some((x) => x.op === 41)) {
          if (idx === 0) global = z;
          return;
        }
        const add = new Int32Array(GEN_COUNT);
        let keys = 127 << 8;
        let vels = 127 << 8;
        let instIdx = -1;
        for (const list of global ? [global, z] : [z]) {
          for (const x of list) {
            if (x.op === 43) keys = x.u;
            else if (x.op === 44) vels = x.u;
            else if (x.op === 41) instIdx = x.u;
            else if (x.op < GEN_COUNT && !NON_ADDITIVE.has(x.op)) add[x.op] = x.s;
          }
        }
        const ins = instruments[instIdx];
        if (!ins) return;
        for (const ig of ins.zones) {
          const keyLo = Math.max(ig[43] & 255, keys & 255);
          const keyHi = Math.min(ig[43] >> 8, keys >> 8);
          const velLo = Math.max(ig[44] & 255, vels & 255);
          const velHi = Math.min(ig[44] >> 8, vels >> 8);
          if (keyLo > keyHi || velLo > velHi) continue;
          const g = new Int32Array(ig);
          for (let op = 0; op < GEN_COUNT; op++) if (add[op]) g[op] += add[op];
          regions.push({ keyLo, keyHi, velLo, velHi, sample: g[53], gen: g });
        }
      });
      presets.push({ name: phdr[p].name, bank: phdr[p].bank, program: phdr[p].program, regions });
    }

    const index = new Map();
    for (const p of presets) {
      const k = p.bank * 128 + p.program;
      if (!index.has(k)) index.set(k, p);
    }
    const firstMelodic = presets.find((p) => p.bank !== 128) || null;
    function find(bank, program) {
      const exact = index.get(bank * 128 + program);
      if (exact) return exact;
      if (bank === 128) return index.get(128 * 128) || null; // unknown drum kit -> Standard kit
      return index.get(program) || firstMelodic; // GS variation bank -> capital tone
    }

    return { name, presets, samples, data, find };
  }

  const api = { parse };
  root.WGSF2 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
