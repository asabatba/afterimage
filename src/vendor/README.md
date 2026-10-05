# Vendored: signalsmith-stretch 1.3.2

Official JS/WASM release of [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) by Geraint Luff (MIT licence),
copied from the `signalsmith-stretch` npm package with four small patches, all marked `AFTERIMAGE patch`:

1. `schedule()` only replaces segments at or after the new segment's output time. Upstream drops every
   pending segment after *now*, which makes it impossible to queue a start and a stop ahead of time.
2. A node that has been inactive for longer than its own latency stops running its STFT, so idle pooled
   nodes cost almost nothing.
3. Position updates are posted every 10 s instead of every 100 ms (AFTERIMAGE tracks time itself).
4. If the `blob:` worklet module is refused (e.g. when the app is opened from `file://`), it retries with a `data:` URL.

`input`/`loopStart`/`loopEnd`/`rate`/`semitones` semantics are unchanged.
