// Canvas drawing for waveforms and pattern previews (from cached peaks).
import type { AudioClip, Pattern, PatternClip, Track } from '../model/types';
import { peakSpan, type Peaks } from '../model/peaks';
import { EPS, clipRate, contentLengthBeats, beatsToSec, mod } from '../model/timing';
import { patternEvents, patternLengthBeats } from '../model/tracker';
import { NOTE_OFF } from '../model/types';

export const TRACK_COLORS: Record<Track['color'], { line: string; fill: string; wave: string; ink: string }> = {
  amber: { line: '#bf9152', fill: '#3d3226', wave: '#d9b47c', ink: '#e2c08f' },
  blue: { line: '#7290ab', fill: '#27313b', wave: '#9cb6cc', ink: '#a9c1d6' },
  sage: { line: '#8c9b79', fill: '#2d3328', wave: '#aebb9c', ink: '#c3cdb4' },
  rust: { line: '#b06c47', fill: '#3a2a22', wave: '#cf8f6a', ink: '#e0aa8a' },
  ivory: { line: '#b4ad9f', fill: '#34322e', wave: '#d8d1c2', ink: '#ede6d6' },
};

export function setupCanvas(canvas: HTMLCanvasElement, w: number, h: number) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return g;
}

/**
 * Draw an audio clip's waveform for the visible span.
 * `x0` is the pixel offset of the canvas from the clip's left edge.
 */
export function drawClipWave(
  g: CanvasRenderingContext2D,
  clip: AudioClip,
  peaks: Peaks,
  bpm: number,
  pxPerBeat: number,
  x0: number,
  w: number,
  h: number,
  color: string,
) {
  const rate = clipRate(clip, bpm);
  const period = clip.loop ? contentLengthBeats(clip, bpm) : Infinity;
  const mid = h / 2;
  const amp = h / 2 - 1;
  g.fillStyle = color;
  const secPerPx = beatsToSec(1 / pxPerBeat, bpm) * rate;
  for (let x = 0; x < w; x++) {
    const local = (x0 + x) / pxPerBeat;
    let p = local;
    if (clip.loop && period > EPS) p = mod(local + clip.loopOffset, period);
    const s0 = clip.srcStart + beatsToSec(p, bpm) * rate;
    if (s0 > clip.srcEnd + 1e-6) continue;
    const [lo, hi] = peakSpan(peaks, s0, Math.min(clip.srcEnd, s0 + secPerPx));
    const y0 = mid - hi * amp;
    const y1 = mid - lo * amp;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
  // Loop seams.
  if (clip.loop && period > EPS) {
    g.fillStyle = 'rgba(237,230,214,0.25)';
    const firstSeam = period - mod(clip.loopOffset, period);
    for (let b = firstSeam; b < clip.length; b += period) {
      const x = b * pxPerBeat - x0;
      if (x >= 0 && x < w) g.fillRect(Math.round(x), 0, 1, h);
    }
  }
}

/** Waveform of a whole sample (inspector / sampler). */
export function drawSampleWave(g: CanvasRenderingContext2D, peaks: Peaks, duration: number, w: number, h: number, color: string, from = 0, to = duration) {
  const mid = h / 2;
  const amp = h / 2 - 2;
  g.fillStyle = color;
  const span = (to - from) / w;
  for (let x = 0; x < w; x++) {
    const s = from + x * span;
    const [lo, hi] = peakSpan(peaks, s, s + span);
    g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
  }
}

/** Note blocks for a pattern clip. */
export function drawPatternPreview(
  g: CanvasRenderingContext2D,
  clip: PatternClip,
  pattern: Pattern,
  pxPerBeat: number,
  x0: number,
  w: number,
  h: number,
  color: string,
) {
  const events = patternEvents(pattern).filter((e) => e.kind === 'note');
  const L = patternLengthBeats(pattern);
  if (!events.length || L <= 0) return;
  let lo = 127, hi = 0;
  for (const e of events) if (e.kind === 'note' && e.note !== NOTE_OFF) { lo = Math.min(lo, e.note); hi = Math.max(hi, e.note); }
  const range = Math.max(12, hi - lo + 1);
  const pad = 3;
  const rowH = Math.max(2, Math.min(5, (h - 2 * pad) / range));
  g.fillStyle = color;
  const firstPass = Math.floor((clip.offset + x0 / pxPerBeat) / L) - 1;
  const lastPass = Math.ceil((clip.offset + (x0 + w) / pxPerBeat) / L) + 1;
  for (let pass = firstPass; pass <= lastPass; pass++) {
    for (const e of events) {
      if (e.kind !== 'note') continue;
      const local = pass * L + e.time - clip.offset;
      const end = Math.min(local + e.duration, clip.length, pass * L + L - clip.offset);
      if (end <= 0 || local >= clip.length) continue;
      const xa = Math.max(0, local) * pxPerBeat - x0;
      const xb = end * pxPerBeat - x0;
      if (xb < 0 || xa > w) continue;
      const y = h - pad - ((e.note - lo + 1) / range) * (h - 2 * pad);
      g.globalAlpha = 0.45 + 0.55 * e.vel;
      g.fillRect(xa, y, Math.max(1.5, xb - xa - 1), rowH);
    }
  }
  g.globalAlpha = 1;
}
