import type { AudioClip, Beats, Clip, Seconds } from './types';

export const BEATS_PER_BAR = 4;
export const MIN_REGION: Seconds = 0.005;
export const EPS = 1e-9;

export const secPerBeat = (bpm: number) => 60 / bpm;
export const beatsToSec = (beats: Beats, bpm: number): Seconds => (beats * 60) / bpm;
export const secToBeats = (sec: Seconds, bpm: number): Beats => (sec * bpm) / 60;

export const clipEnd = (c: Clip): Beats => c.start + c.length;

export const regionDuration = (c: AudioClip): Seconds => Math.max(0, c.srcEnd - c.srcStart);

/**
 * Source seconds consumed per output second.
 * Free mode: the inverse of the stretch factor.
 * Tempo mode: project tempo / source tempo, so the region keeps its beat length.
 */
export function clipRate(c: AudioClip, bpm: number): number {
  if (c.timing === 'tempo') return bpm / c.sourceBpm;
  return 1 / c.stretch;
}

/** Length of one pass through the region on the arrangement, in beats. */
export function contentLengthBeats(c: AudioClip, bpm: number): Beats {
  return secToBeats(regionDuration(c) / clipRate(c, bpm), bpm);
}

/** Pitch shift actually heard, in semitones. */
export function effectivePitch(c: AudioClip, bpm: number): number {
  if (c.repitch) return 12 * Math.log2(clipRate(c, bpm));
  return c.semitones + c.cents / 100;
}

/** Whether a clip needs the time/pitch processor, or can play as a plain buffer. */
export function needsStretch(c: AudioClip, bpm: number): boolean {
  if (c.repitch) return false;
  return Math.abs(clipRate(c, bpm) - 1) > 1e-6 || Math.abs(c.semitones + c.cents / 100) > 1e-6;
}

/** Keep a non-looping clip's arrangement length in step with its content. */
export function normalizeClip<C extends Clip>(c: C, bpm: number): C {
  if (c.kind !== 'audio' || c.loop) return c;
  const length = contentLengthBeats(c, bpm);
  if (Math.abs(length - c.length) < EPS) return c;
  return { ...c, length };
}

/**
 * Position in the sample (seconds) heard at `local` beats after the clip start.
 * Looped clips wrap inside their region.
 */
export function sourcePosAt(c: AudioClip, bpm: number, local: Beats): Seconds {
  const rate = clipRate(c, bpm);
  if (!c.loop) return c.srcStart + beatsToSec(local, bpm) * rate;
  const period = contentLengthBeats(c, bpm);
  if (period <= EPS) return c.srcStart;
  const p = mod(local + c.loopOffset, period);
  return c.srcStart + beatsToSec(p, bpm) * rate;
}

/** Beats (from clip start) at which the looped content next wraps, after `local`. */
export function nextWrapAfter(c: AudioClip, bpm: number, local: Beats): Beats | null {
  if (!c.loop) return null;
  const period = contentLengthBeats(c, bpm);
  if (period <= EPS) return null;
  const phase = mod(local + c.loopOffset, period);
  return local + (period - phase);
}

export function mod(a: number, n: number): number {
  const r = a % n;
  return r < 0 ? r + n : r;
}

export function snapBeat(beat: Beats, grid: Beats, enabled: boolean): Beats {
  if (!enabled || grid <= 0) return beat;
  return Math.round(beat / grid) * grid;
}

/** Equal-power fade gain for a clip at `local` beats; fades are in beats. */
export function fadeGainAt(local: Beats, length: Beats, fadeIn: Beats, fadeOut: Beats): number {
  let g = 1;
  if (fadeIn > EPS && local < fadeIn) g *= Math.sin((Math.max(0, local) / fadeIn) * (Math.PI / 2));
  const fromEnd = length - local;
  if (fadeOut > EPS && fromEnd < fadeOut) g *= Math.sin((Math.max(0, fromEnd) / fadeOut) * (Math.PI / 2));
  return g;
}

export const dbToGain = (db: number) => (db <= -96 ? 0 : 10 ** (db / 20));
export const gainToDb = (g: number) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

/** "bar.beat.sixteenth", 1-based. Negative beats are shown as count-in. */
export function formatBBT(beat: Beats): string {
  const neg = beat < -EPS;
  const b = Math.abs(beat) + EPS;
  const bar = Math.floor(b / BEATS_PER_BAR);
  const bt = Math.floor(b % BEATS_PER_BAR);
  const six = Math.floor((b % 1) * 4);
  return `${neg ? '-' : ''}${bar + 1}.${bt + 1}.${six + 1}`;
}

export function formatTime(sec: Seconds): string {
  const neg = sec < 0;
  const s = Math.abs(sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${neg ? '-' : ''}${m}:${r.toFixed(3).padStart(6, '0')}`;
}
