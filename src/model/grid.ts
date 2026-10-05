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
  let lo = 0, hi = onsets.length;
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
