#!/usr/bin/env node
/* WinGroove Reboot - fetch the default soundfont into soundfonts/ and renderer/soundfonts/
 *
 * Resolution order:
 *   1. A WinGroove.sf2 already placed in soundfonts/ or renderer/soundfonts/ (never overwritten)
 *   2. WG_SOUNDFONT_PATH  - local path to an .sf2 (e.g. your own WinGroove-style bank)
 *   3. WG_SOUNDFONT_URL   - direct download URL of an .sf2
 *   4. Fallback: TimGM6mb.sf2 (6 MB, GPL-2.0, Tim Brechbill) - a small 90s-era GM bank
 *      that is close in size and character to WinGroove's original ~4-8 MB sample set.
 *
 * Flags: --soft  never fail the install if the download fails
 *        --force replace an existing WinGroove.sf2
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const FALLBACK_URL = 'https://raw.githubusercontent.com/craffel/pretty-midi/main/pretty_midi/TimGM6mb.sf2';
const dest1 = path.join(__dirname, '..', 'soundfonts', 'WinGroove.sf2');
const dest2 = path.join(__dirname, '..', 'renderer', 'soundfonts', 'WinGroove.sf2');
const soft = process.argv.includes('--soft');
const force = process.argv.includes('--force');

function isSf2(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0);
    fs.closeSync(fd);
    return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'sfbk';
  } catch (_) { return false; }
}

function syncCopies(src) {
  [dest1, dest2].forEach((d) => {
    fs.mkdirSync(path.dirname(d), { recursive: true });
    if (src !== d) {
      try { fs.copyFileSync(src, d); } catch (_) {}
    }
  });
}

function download(url, out, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'wingroove-reboot' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), out, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = +res.headers['content-length'] || 0;
      let got = 0;
      const tmp = out + '.part';
      const ws = fs.createWriteStream(tmp);
      res.on('data', (c) => {
        got += c.length;
        if (total && process.stdout.isTTY) process.stdout.write('\r  ' + Math.round((got / total) * 100) + '%');
      });
      res.pipe(ws);
      ws.on('finish', () => { ws.close(() => { fs.renameSync(tmp, out); if (process.stdout.isTTY) process.stdout.write('\n'); resolve(); }); });
      ws.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(path.dirname(dest1), { recursive: true });
  fs.mkdirSync(path.dirname(dest2), { recursive: true });

  if (!force) {
    if (fs.existsSync(dest1) && isSf2(dest1)) {
      console.log('[soundfont] using existing', path.relative(process.cwd(), dest1));
      syncCopies(dest1);
      return;
    }
    if (fs.existsSync(dest2) && isSf2(dest2)) {
      console.log('[soundfont] using existing', path.relative(process.cwd(), dest2));
      syncCopies(dest2);
      return;
    }
  }

  const localPath = process.env.WG_SOUNDFONT_PATH;
  if (localPath) {
    if (!isSf2(localPath)) throw new Error('WG_SOUNDFONT_PATH is not a valid .sf2: ' + localPath);
    syncCopies(localPath);
    console.log('[soundfont] copied', localPath);
    return;
  }

  const url = process.env.WG_SOUNDFONT_URL || FALLBACK_URL;
  console.log('[soundfont] downloading', url);
  await download(url, dest1);
  if (!isSf2(dest1)) { fs.unlinkSync(dest1); throw new Error('downloaded file is not a SoundFont 2'); }
  syncCopies(dest1);
  console.log('[soundfont] saved to soundfonts/ and renderer/soundfonts/ (' + (fs.statSync(dest1).size / 1048576).toFixed(1) + ' MB)');
})().catch((err) => {
  console.error('[soundfont] ' + err.message);
  if (!soft) process.exit(1);
  console.error('[soundfont] continuing without a default soundfont - load one from the app menu.');
});
