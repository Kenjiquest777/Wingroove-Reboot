/* WinGroove Reboot - 16-bit PCM WAV encoder */
(function (root) {
  'use strict';
  function encode(ab) {
    const ch = Math.min(2, ab.numberOfChannels);
    const len = ab.length;
    const rate = ab.sampleRate;
    const chans = [];
    for (let c = 0; c < ch; c++) chans.push(ab.getChannelData(c));
    const bytes = len * ch * 2;
    const buf = new ArrayBuffer(44 + bytes);
    const dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); w(8, 'WAVE');
    w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
    w(36, 'data'); dv.setUint32(40, bytes, true);
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return buf;
  }
  const api = { encode };
  root.WGWav = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
