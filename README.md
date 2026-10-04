# WinGroove Reboot

A from-scratch remake of **WinGroove**, the classic Windows 95/98 software-wavetable MIDI player, as a downloadable desktop app (Windows, macOS, Linux) built with Electron and Web Audio.

## Features

- SoundFont 2 (.sf2) wavetable synth: SF2 DAHDSR envelopes, loops, lowpass filter, exclusive classes, velocity layers
- 16 MIDI channels, GM drums on ch 10, bank select, pitch bend + RPN bend range, sustain, CC7/10/11/91
- WinGroove-style software reverb and output compressor
- Standard MIDI Files format 0/1/2, `.rmi` RIFF wrappers, `.kar`, SMPTE timing
- Retro Win98 UI: green LCD (time, BPM, live voice count), 16 channel meters with pan indicators, click a meter to mute
- Transport: play/pause, stop, prev/next, +-5s, seek bar, repeat all/one/off, shuffle
- Volume, reverb, tempo (50-200%), transpose (+-12), polyphony (24-128)
- Playlist with drag and drop, double-click to play
- Save as WAV (offline render, like WinGroove's original converter)
- Open `.mid` files from Explorer/Finder (file associations), single-instance

## Run

```
npm install        # also downloads the default soundfont
npm start          # desktop app
npm run web        # or run in a browser at http://localhost:8080
```

Keys: Space play/pause, Ctrl+O open, Ctrl+Left/Right seek, Delete remove.

## Build installers

```
npm run dist:win    # NSIS setup .exe + portable .exe
npm run dist:mac    # .dmg (x64 + arm64)
npm run dist:linux  # .AppImage
```

### Automated builds (GitHub Actions)

The workflow lives at `ci/build.yml`. Move it to `.github/workflows/build.yml` (GitHub web UI: open the file, edit, change the path) to enable it. After that, push a tag like `v1.0.0` (or run it from the Actions tab) and it builds all three platforms and attaches the installers to a Release.

## About the soundfont

The original WinGroove software synth used its own built-in proprietary sample set, not a public `.sf2`. There is no official, freely licensed WinGroove SoundFont, so this repo does not ship one.

Default behaviour:

1. If `renderer/soundfonts/WinGroove.sf2` exists, it is used.
2. Otherwise `npm install` downloads **TimGM6mb.sf2** (6 MB, GPL-2.0) - a small late-90s GM bank with a similar lo-fi wavetable character.
3. You can point it at any bank (for example a WinGroove-style bank you own) with `WG_SOUNDFONT_PATH` or `WG_SOUNDFONT_URL` - see `renderer/soundfonts/README.md`. In CI, set the repo secret `WG_SOUNDFONT_URL`.

Any `.sf2` can also be loaded at runtime from the SoundFont menu or by dropping it onto the window.

## Layout

```
main.js / preload.js       Electron main process + secure IPC bridge
renderer/index.html        UI
renderer/style.css         Win98 theme
renderer/js/app.js         UI controller
renderer/js/synth.js       SF2 synth engine
renderer/js/sf2.js         SF2 parser
renderer/js/midifile.js    MIDI parser
renderer/js/player.js      Look-ahead sequencer
renderer/js/wav.js         WAV encoder
scripts/fetch-soundfont.js Default soundfont downloader
ci/build.yml               GitHub Actions build workflow (move to .github/workflows/)
```

## License

MIT for the code. Soundfonts keep their own licenses. WinGroove is a trademark of its original author; this is an unaffiliated fan remake.
