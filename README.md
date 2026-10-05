# AFTERIMAGE

*A sample collage studio for the browser.* Implements compact spec v0.4: a waveform arrangement for
finishing songs from short samples, independent pitch/time per clip, a real tracker for short samples
played as instruments, recording, internal resampling ("Print"), autosave and WAV export.

```
npm install
npm run dev            # http://localhost:5173
npm test               # unit tests (Vitest)
npm run test:e2e       # browser tests incl. the four build gates (Playwright, Chromium)
npm run build          # production build → dist/
npm run build:single   # one self-contained HTML file → dist-single/index.html (works from file://)
```

Targets current Chromium and Firefox desktop. Verified here in headless Chromium; Firefox has not been run.

## Using it

- **Import** audio in the pool (or drop files on the pool or straight onto a track). Drag pool samples onto tracks.
- **Clips**: drag to move (across tracks too), edges to trim, **Alt-drag right edge** to stretch (pitch kept),
  **Shift-drag** to slip content, **Alt-drag** body to copy, squares at the top corners for fades.
  `S` splits at the playhead, `Ctrl+D` duplicates, `Delete` removes. Two clips may overlap on a track and
  crossfade (equal power); a third layer belongs on another track.
- **Snap** toggles with `G`; hold `Ctrl` while dragging for free placement. `Ctrl`+wheel or `+`/`−` zooms.
- **Ruler**: click/drag to move the cursor, drag the lower band for the loop range (`L` toggles), double-click the
  top band to add a section marker (`M` adds one at the cursor).
- **Clip panel**: semitones/cents (duration kept), length % (pitch kept) or *Follow tempo* with editable source
  tempo/beats, *Repitch* to couple speed and pitch, loop, gain, fades, region editor. Changes are heard live.
- **Tracker**: double-click an empty lane for a pattern clip (64 rows, 4 rows/beat). Keys `Z–M` / `Q–P`, hold keys
  for chords, `1` note-off, hex digits elsewhere, effects `O` offset, `R` reverse, `P` pan, `F` filter, `D` delay
  send, `V` reverb send. `Ctrl+C/X/V`, `Ctrl+↑/↓` transpose (+`Shift` octave). Pattern clips are linked;
  *Make unique* forks one. Make instruments from pool samples or from an audio clip's region.
- **Capture** panel: Input (raw, monitoring off by default), a track (after its filter, volume and pan) or the
  master (with shared effects). Free length, bars or loop range; count-in; alignment offset for inputs.
  The metronome and previews are never captured. Captures become new lossless samples and a neutral clip on the
  destination track (or the next track with room). *Cancel take* discards only the pending take.
- **Persistence**: autosaves to IndexedDB and reopens the last project; *Save project bundle* writes a ZIP with
  `afterimage.json` and every sample as 32-bit float WAV. *Export WAV* renders song, loop or a section with an
  explicit effects tail.

## Architecture

```
src/model/     pure, tested: types, timing math, clip edits, crossfades, tracker, playback planning, WAV, peaks, undo
src/audio/     engine (transport + look-ahead scheduler), mixer graph, stretch pool, tracker voices,
               capture (recorder worklet → worker), offline export
src/store/     Solid stores and undoable actions, Dexie persistence, fflate bundles, session recovery
src/ui/        Solid components; Canvas 2D waveforms from cached peaks
src/vendor/    Signalsmith Stretch 1.3.2 (MIT), lightly patched — see src/vendor/README.md
```

The UI talks to audio through one engine object; decoded audio lives in a `SampleRegistry` outside the reactive
store. The engine schedules against the audio clock with a look-ahead window, re-plans clips that change while
playing (pitch-only changes glide on the stretcher), and the exact same engine renders offline for export with an
internal preroll that is trimmed afterwards.

## Where this differs from the spec's stack

- **Signalsmith Stretch** is used as recommended, but vendored with small patches: upstream `schedule()` drops all
  pending segments after *now*, so a start and stop could not be queued ahead; idle nodes now skip DSP; worklet
  modules fall back to `data:` URLs on `file://`. Stretch nodes are pooled and pre-created before playback.
  Unchanged clips bypass stretching and play as plain buffers.
- **Tracker voices** use native `AudioBufferSourceNode` + filter + envelope + panner nodes scheduled
  sample-accurately, instead of a custom voice worklet. This gives the same timing with less code; a worklet can
  replace it if voice counts become a bottleneck.
- **Recorder** is a custom AudioWorklet with a preallocated chunk pool feeding a worker over a `MessagePort`
  (chunks are returned for reuse; an empty pool is reported as an overrun and the take is discarded). If a worker
  can't start (e.g. `file://`), the same collector runs on the main thread.
- **Kobalte** was not added: controls are native `button`/`select`/`input type=range` plus an ARIA spinbutton for
  drag-numbers, which keeps the bundle small and remains keyboard accessible.
- **Styles** are plain CSS with design tokens (`src/styles/tokens.css`) rather than CSS Modules.
- **WaveSurfer** isn't used; the inspector and sampler draw from the same peak cache as the arrangement.

## Build gates (automated in `e2e/`)

1. Edit, trim and re-pitch a stereo phrase while it loops — passes.
2. +3 semitones keeps a 4 s phrase at 4 s (measured 524.6 Hz from 440 Hz); stretching to 6 s keeps 440 Hz;
   repitch at half speed gives 220 Hz for 8 s; stretched-clip onsets land within a few ms; offline export used.
3. Three sections, a tracker part, an input take (Chromium's fake device), track and master prints: an empty
   track prints silence with the click on; a printed drum track starts within 6 ms of the range; prints are
   stereo and record their source clips; cancel leaves the project unchanged.
4. After reload all audio is restored from IndexedDB; a 2-minute export is 123.0 s with a 3 s tail and a
   kick at bar 60 lands within 3 ms.

Not yet measured: CPU with many simultaneous stretched clips (each needs its own node) and drum/chord/texture
quality beyond the synthetic fixtures. Deferred per spec: mobile, MIDI, plugins, collaboration, session
launching, warp markers, granular synthesis, overdubbing, comping.
