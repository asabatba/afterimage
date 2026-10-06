// Beat grids on a sample's own timeline (seconds), and the maths for snapping and slicing to them.
import type { BeatGrid, Seconds } from './types';

export const beatSeconds = (g: BeatGrid): Seconds => 60 / g.bpm;

/** Fractional beat index of a time; beat 0 is the grid's downbeat. */
export const beatAt = (g: BeatGrid, t: Seconds): number => (t - g.offset) / beatSeconds(g);

/** Time of a beat index. */
export const timeOfBeat = (g: BeatGrid, beat: number): Seconds => g.offset + beat * beatSeconds(g);

/** Snap a time to the nearest multiple of `division` beats. */
export function snapToGrid(g: BeatGrid, t: Seconds, division = 1): Seconds {
  return timeOfBeat(g, Math.round(beatAt(g, t) / division) * division);
}

export interface GridLine {
  t: Seconds;
  /** Beat index relative to the downbeat (a multiple of the division). */
  beat: number;
  kind: 'bar' | 'beat' | 'sub';
}

/** Grid lines inside [from, to], at every `division` beats (4 = bars only). */
export function gridLines(g: BeatGrid, from: Seconds, to: Seconds, division = 1): GridLine[] {
  const out: GridLine[] = [];
  const first = Math.ceil(beatAt(g, from) / division - 1e-9);
  const last = Math.floor(beatAt(g, to) / division + 1e-9);
  for (let i = first; i <= last; i++) {
    const beat = i * division;
    const bar = Math.abs(beat / 4 - Math.round(beat / 4)) < 1e-9;
    const onBeat = Math.abs(beat - Math.round(beat)) < 1e-9;
    out.push({ t: timeOfBeat(g, beat), beat, kind: bar ? 'bar' : onBeat ? 'beat' : 'sub' });
  }
  return out;
}

/** Nearest onset to `t` within `tol` seconds. */
export function nearestOnset(onsets: Seconds[], t: Seconds, tol: Seconds): Seconds | null {
  let lo = 0,
    hi = onsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  let best: number | null = null;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= onsets.length) continue;
    if (Math.abs(onsets[i] - t) <= tol && (best === null || Math.abs(onsets[i] - t) < Math.abs(best - t))) best = onsets[i];
  }
  return best;
}

export type SliceMode = { kind: 'grid'; division: number } | { kind: 'hits' };

/**
 * Cut points for slicing [from, to]. Slices start on a grid line (or an onset) so each one begins
 * on a beat or a hit: the lead-in before the first cut is dropped, and a tail shorter than 10 % of a
 * step is dropped too. Returns increasing boundaries; consecutive pairs are the slices.
 */
export function sliceBoundaries(grid: BeatGrid | null, onsets: Seconds[], from: Seconds, to: Seconds, mode: SliceMode): Seconds[] {
  const eps = 0.004;
  let cuts: number[];
  if (mode.kind === 'grid') {
    if (!grid) return [];
    cuts = gridLines(grid, from - eps, to + eps, mode.division).map((l) => l.t);
  } else {
    cuts = onsets.filter((t) => t >= from - eps && t <= to + eps);
  }
  cuts = cuts.map((t) => Math.min(to, Math.max(from, t)));
  if (!cuts.length) return [];
  const out = [...cuts];
  const step = mode.kind === 'grid' && grid ? beatSeconds(grid) * mode.division : 0.05;
  const tail = to - out[out.length - 1];
  if (tail > step * 0.1 && tail > 0.01) out.push(to);
  // De-duplicate boundaries that collapsed together.
  return out.filter((t, i) => i === 0 || t - out[i - 1] > 0.002);
}

// ── Tap tempo ────────────────────────────────────────────────────────────

export interface TapFit {
  bpm: number;
  /** Time of a bar start (the first tap is taken as beat 1), within the first bar. */
  offset: Seconds;
  taps: number;
  /** RMS distance of the points the fit used from the fitted grid, in ms. */
  errorMs: number;
  /** True when the fit was refined using detected hits near the taps. */
  snapped: boolean;
}

const medianOf = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Least-squares line t = a + k·P through (k, t) points. */
function lineFit(ks: number[], ts: number[]): { a: number; P: number; rms: number } {
  const n = ks.length;
  const mk = ks.reduce((s, v) => s + v, 0) / n;
  const mt = ts.reduce((s, v) => s + v, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (ks[i] - mk) * (ts[i] - mt);
    den += (ks[i] - mk) ** 2;
  }
  const P = den > 0 ? num / den : 0;
  const a = mt - P * mk;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ts[i] - (a + P * ks[i])) ** 2;
  return { a, P, rms: Math.sqrt(ss / n) };
}

/**
 * Tempo and beat positions from taps made in time with the music. Needs at least four taps at a
 * steady pace (30–300 bpm); a skipped beat is tolerated. When detected `onsets` line up with the beats
 * that were tapped, the fit is redone on those (they are exact, taps are human) so the grid lands on
 * the hits rather than on the tap jitter.
 */
export function fitTaps(taps: Seconds[], onsets: Seconds[] = []): TapFit | null {
  if (taps.length < 4) return null;
  const t = [...taps].sort((x, y) => x - y);
  const gaps = t.slice(1).map((v, i) => v - t[i]);
  let P = medianOf(gaps);
  if (!(P >= 0.2 && P <= 2)) return null;
  // Beat index of each tap, counted tap to tap so a slightly wrong period cannot drift the indices.
  let ks: number[] = [];
  let fit = { a: t[0], P, rms: 0 };
  for (let pass = 0; pass < 2; pass++) {
    ks = [0];
    for (let i = 1; i < t.length; i++) ks.push(ks[i - 1] + Math.max(1, Math.round(gaps[i - 1] / P)));
    fit = lineFit(ks, t);
    P = fit.P;
  }
  if (!(P >= 0.2 && P <= 2) || fit.rms > 0.2 * P) return null;

  let { a, rms } = fit;
  let snapped = false;
  const kMax = ks[ks.length - 1];
  const matchedK: number[] = [];
  const matchedT: number[] = [];
  for (let k = 0; k <= kMax; k++) {
    const pred = a + k * P;
    let best: number | null = null;
    for (const o of onsets) {
      if (o < pred - 0.15 * P) continue;
      if (o > pred + 0.15 * P) break;
      if (best === null || Math.abs(o - pred) < Math.abs(best - pred)) best = o;
    }
    if (best !== null) {
      matchedK.push(k);
      matchedT.push(best);
    }
  }
  if (matchedK.length >= Math.max(4, 0.6 * (kMax + 1))) {
    const refined = lineFit(matchedK, matchedT);
    if (refined.rms <= rms && refined.P >= 0.2 && refined.P <= 2 && Math.abs(refined.P - P) < 0.03 * P) {
      ({ a, P, rms } = refined);
      snapped = true;
    }
  }
  const bar = 4 * P;
  return { bpm: 60 / P, offset: ((a % bar) + bar) % bar, taps: t.length, errorMs: rms * 1000, snapped };
}
