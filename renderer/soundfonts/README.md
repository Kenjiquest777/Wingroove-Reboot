# Soundfonts

The app loads `WinGroove.sf2` from this folder as its default bank.

- `npm install` (or `npm run fetch-soundfont`) downloads a default bank here automatically.
- To use your own bank, drop it here named `WinGroove.sf2`, or run:
  - `WG_SOUNDFONT_PATH=/path/to/bank.sf2 npm run fetch-soundfont -- --force`
  - `WG_SOUNDFONT_URL=https://example.com/bank.sf2 npm run fetch-soundfont -- --force`
- In CI, set the repo secret `WG_SOUNDFONT_URL` to bake a specific bank into the installers.

`.sf2` files are git-ignored so large/copyrighted sample data never lands in the repo.
