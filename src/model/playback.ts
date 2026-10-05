// Pure planning helpers used by the audio engine (and tested without audio).
import type { AudioClip, Beats, Clip, Project } from './types';
import { EPS, clipEnd, clipRate, effectivePitch, fadeGainAt, needsStretch, sourcePosAt, dbToGain } from './timing';
import { effectiveFades } from './clips';

export type GainStep =
  | { type: 'set'; at: Beats; value: number }
  | { type: 'curve'; at: Beats; dur: Beats; values: Float32Array };

const CURVE_POINTS = 48;

/**
 * Gain automation for playing a clip from `from` (beats from clip start) to its end.
 * Returns steps in clip-local beats.
 */
export function gainAutomation(from: Beats, length: Beats, fadeIn: Beats, fadeOut: Beats, gain: number): GainStep[] {
  const steps: GainStep[] = [];
  const at = (x: Beats) => gain * fadeGainAt(x, length, fadeIn, fadeOut);
  steps.push({ type: 'set', at: from, value: at(from) });
  const fadeOutStart = length - fadeOut;
  const pushCurve = (a: Beats, b: Beats) => {
    if (b - a <= EPS) return;
    const values = new Float32Array(CURVE_POINTS);
    for (let i = 0; i < CURVE_POINTS; i++) values[i] = at(a + ((b - a) * i) / (CURVE_POINTS - 1));
    steps.push({ type: 'curve', at: a, dur: b - a, values });
  };
  const fi = fadeIn > EPS ? fadeIn : 0;
  const fo = fadeOut > EPS ? fadeOutStart : length;
  if (fi > fo) {
    // Fades meet: one combined curve.
    pushCurve(from, length);
  } else {
    if (from < fi) pushCurve(from, fi);
    if (fadeOut > EPS) pushCurve(Math.max(from, fo), length);
  }
  return steps;
}

export interface AudioPlan {
  clip: AudioClip;
  /** Arrangement beat where this occurrence starts sounding. */
  beat: Beats;
  /** Arrangement beat where it stops (clip end or segment end). */
  endBeat: Beats;
  /** Clip-local beat at the start. */
  local: Beats;
  /** Source seconds at start. */
  srcPos: number;
  rate: number;
  semitones: number;
  stretch: boolean;
  gain: GainStep[];
}

/**
 * Plan playing an audio clip from arrangement beat `from` until `until` (e.g. loop end).
 * Returns null if nothing sounds in that span.
 */
export function planAudio(clip: AudioClip, clips: Clip[], bpm: number, from: Beats, until: Beats): AudioPlan | null {
  const start = Math.max(from, clip.start);
  const end = Math.min(until, clipEnd(clip));
  if (end - start <= EPS) return null;
  const local = start - clip.start;
  const { fadeIn, fadeOut } = effectiveFades(clip, clips);
  return {
    clip,
    beat: start,
    endBeat: end,
    local,
    srcPos: sourcePosAt(clip, bpm, local),
    rate: clipRate(clip, bpm),
    semitones: effectivePitch(clip, bpm),
    stretch: needsStretch(clip, bpm),
    gain: gainAutomation(local, clip.length, fadeIn, fadeOut, dbToGain(clip.gainDb)),
  };
}

/** Solo/mute resolution: which tracks are audible. */
export function audibleTracks(p: Project): Set<string> {
  const anySolo = p.tracks.some((t) => t.solo);
  return new Set(p.tracks.filter((t) => !t.mute && (!anySolo || t.solo)).map((t) => t.id));
}

/** Clips starting in [from, to) — or overlapping `from` when `includeOverlapping`. */
export function clipsToStart(clips: Clip[], from: Beats, to: Beats, includeOverlapping: boolean): Clip[] {
  return clips.filter((c) => {
    if (c.start >= from - EPS && c.start < to - EPS) return true;
    return includeOverlapping && c.start < from && clipEnd(c) > from + EPS;
  });
}
