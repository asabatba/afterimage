// Pure arrangement editing operations. Each returns new objects; the store
// applies them and records undo history.

import { newId } from './project';
import { beatsToSec, clipEnd, clipRate, contentLengthBeats, EPS, MIN_REGION, mod, normalizeClip, regionDuration, secToBeats, sourcePosAt } from './timing';
import type { AudioClip, Beats, Clip, PatternClip } from './types';

export const MIN_CLIP_BEATS = 1 / 64;

export function moveClip<C extends Clip>(c: C, start: Beats, trackId = c.trackId): C {
  return { ...c, start: Math.max(0, start), trackId };
}

/** Drag the left edge. Content stays anchored to the arrangement. */
export function trimStart<C extends Clip>(c: C, newStart: Beats, bpm: number): C {
  const end = clipEnd(c);
  newStart = Math.min(Math.max(0, newStart), end - MIN_CLIP_BEATS);
  const delta = newStart - c.start;
  if (c.kind === 'pattern') {
    return { ...c, start: newStart, length: end - newStart, offset: c.offset + delta };
  }
  const a = c as AudioClip;
  if (a.loop) {
    return { ...a, start: newStart, length: end - newStart, loopOffset: a.loopOffset + delta } as C;
  }
  const rate = clipRate(a, bpm);
  let srcStart = a.srcStart + beatsToSec(delta, bpm) * rate;
  srcStart = Math.min(Math.max(0, srcStart), a.srcEnd - MIN_REGION);
  // Recompute the start from the clamped source so the content stays aligned.
  const realDelta = secToBeats((srcStart - a.srcStart) / rate, bpm);
  return normalizeClip({ ...a, srcStart, start: a.start + realDelta, fadeIn: Math.min(a.fadeIn, end - (a.start + realDelta)) }, bpm) as C;
}

/** Drag the right edge (trim / extend loop). */
export function trimEnd<C extends Clip>(c: C, newEnd: Beats, bpm: number, sampleDuration = Infinity): C {
  newEnd = Math.max(c.start + MIN_CLIP_BEATS, newEnd);
  if (c.kind === 'pattern' || (c as AudioClip).loop) {
    const length = newEnd - c.start;
    const out = { ...c, length } as C;
    if (out.kind === 'audio') out.fadeOut = Math.min(out.fadeOut, length);
    return out;
  }
  const a = c as AudioClip;
  const rate = clipRate(a, bpm);
  let srcEnd = a.srcStart + beatsToSec(newEnd - a.start, bpm) * rate;
  srcEnd = Math.max(a.srcStart + MIN_REGION, Math.min(sampleDuration, srcEnd));
  const out = normalizeClip({ ...a, srcEnd }, bpm);
  return { ...out, fadeOut: Math.min(out.fadeOut, out.length) } as C;
}

/** Alt-drag the right edge: change speed so the content fills `newLength`, keeping pitch. */
export function stretchTo(c: AudioClip, newLength: Beats, bpm: number): AudioClip {
  newLength = Math.max(MIN_CLIP_BEATS, newLength);
  const region = regionDuration(c);
  if (region <= 0) return c;
  if (c.loop) {
    // Stretch the looped content proportionally to the clip length change.
    const factor = newLength / c.length;
    const scaled = scaleContent(c, factor, bpm);
    return { ...scaled, length: newLength };
  }
  if (c.timing === 'tempo') {
    return normalizeClip({ ...c, sourceBpm: (newLength * 60) / region }, bpm);
  }
  return normalizeClip({ ...c, stretch: beatsToSec(newLength, bpm) / region }, bpm);
}

function scaleContent(c: AudioClip, factor: number, bpm: number): AudioClip {
  if (c.timing === 'tempo') return { ...c, sourceBpm: c.sourceBpm * factor, loopOffset: c.loopOffset * factor };
  void bpm;
  return { ...c, stretch: c.stretch * factor, loopOffset: c.loopOffset * factor };
}

/** Shift drag: move the content inside the clip without moving the clip. */
export function slip<C extends Clip>(c: C, deltaBeats: Beats, bpm: number, sampleDuration = Infinity, patternLength = Infinity): C {
  if (c.kind === 'pattern') {
    const offset = Number.isFinite(patternLength) ? mod(c.offset - deltaBeats, patternLength) : c.offset - deltaBeats;
    return { ...c, offset };
  }
  const a = c as AudioClip;
  if (a.loop) {
    const period = contentLengthBeats(a, bpm);
    return { ...a, loopOffset: period > EPS ? mod(a.loopOffset - deltaBeats, period) : 0 } as C;
  }
  const rate = clipRate(a, bpm);
  const region = regionDuration(a);
  let srcStart = a.srcStart - beatsToSec(deltaBeats, bpm) * rate;
  srcStart = Math.max(0, Math.min(sampleDuration - region, srcStart));
  return { ...a, srcStart, srcEnd: srcStart + region } as C;
}

/** Split a clip at an arrangement beat. Returns null if the beat is outside the clip. */
export function splitClip(c: Clip, at: Beats, bpm: number): [Clip, Clip] | null {
  if (at <= c.start + MIN_CLIP_BEATS || at >= clipEnd(c) - MIN_CLIP_BEATS) return null;
  const leftLen = at - c.start;
  const rightLen = clipEnd(c) - at;
  if (c.kind === 'pattern') {
    const left: PatternClip = { ...c, length: leftLen };
    const right: PatternClip = { ...c, id: newId('c'), start: at, length: rightLen, offset: c.offset + leftLen };
    return [left, right];
  }
  if (c.loop) {
    const left: AudioClip = { ...c, length: leftLen, fadeOut: 0, fadeIn: Math.min(c.fadeIn, leftLen) };
    const right: AudioClip = {
      ...c,
      id: newId('c'),
      start: at,
      length: rightLen,
      loopOffset: c.loopOffset + leftLen,
      fadeIn: 0,
      fadeOut: Math.min(c.fadeOut, rightLen),
    };
    return [left, right];
  }
  const cut = sourcePosAt(c, bpm, leftLen);
  const left = normalizeClip({ ...c, srcEnd: cut, fadeOut: 0, fadeIn: Math.min(c.fadeIn, leftLen) }, bpm);
  const right = normalizeClip({ ...c, id: newId('c'), start: at, srcStart: cut, fadeIn: 0, fadeOut: Math.min(c.fadeOut, rightLen) }, bpm);
  return [left, right];
}

export function duplicateClip<C extends Clip>(c: C, start = clipEnd(c), trackId = c.trackId): C {
  return { ...c, id: newId('c'), start, trackId };
}

/** Arrangement span of a group of clips. */
export function groupSpan(clips: Clip[]): { start: Beats; end: Beats; length: Beats } {
  if (!clips.length) return { start: 0, end: 0, length: 0 };
  const start = Math.min(...clips.map((c) => c.start));
  const end = Math.max(...clips.map(clipEnd));
  return { start, end, length: end - start };
}

export const MAX_COPIES = 512;

/** `count` further copies of a group, each `step` beats after the last (default: the group's own length). */
export function repeatClips(group: Clip[], count: number, step?: Beats): Clip[] {
  const s = step ?? groupSpan(group).length;
  if (!group.length || !(s > EPS)) return [];
  const out: Clip[] = [];
  for (let k = 1; k <= Math.min(MAX_COPIES, Math.floor(count)); k++) for (const c of group) out.push(duplicateClip(c, c.start + k * s));
  return out;
}

/**
 * Repeat a group until `target` (a beat). Copies starting at or past the target are dropped; with
 * `trimLast` the copy that crosses it is shortened to end exactly there, otherwise it is dropped.
 */
export function fillClips(
  group: Clip[],
  target: Beats,
  bpm: number,
  sampleDuration: (c: Clip) => number = () => Infinity,
  step?: Beats,
  trimLast = true,
): Clip[] {
  const { start: s0, end: e0, length } = groupSpan(group);
  const s = step ?? length;
  if (!group.length || !(s > EPS) || target <= e0 + EPS) return [];
  const out: Clip[] = [];
  for (let k = 1; k <= MAX_COPIES && s0 + k * s < target - EPS; k++) {
    for (const c of group) {
      const start = c.start + k * s;
      if (start >= target - EPS) continue;
      let copy = duplicateClip(c, start);
      if (clipEnd(copy) > target + EPS) {
        if (!trimLast || target - start < MIN_CLIP_BEATS * 4) continue;
        copy = trimEnd(copy, target, bpm, sampleDuration(c));
      }
      out.push(copy);
    }
  }
  return out;
}

/** Copies of `clips` moved so the earliest starts at `at`, with track rows shifted by `rowShift` (clamped). */
export function pasteClips(clips: Clip[], at: Beats, trackIds: string[], rowShift = 0): Clip[] {
  if (!clips.length || !trackIds.length) return [];
  const first = Math.min(...clips.map((c) => c.start));
  return clips.map((c) => {
    const row = Math.min(trackIds.length - 1, Math.max(0, Math.max(0, trackIds.indexOf(c.trackId)) + rowShift));
    return duplicateClip(c, Math.max(0, at + (c.start - first)), trackIds[row]);
  });
}

export function setFades(c: AudioClip, fadeIn: Beats, fadeOut: Beats): AudioClip {
  fadeIn = Math.max(0, Math.min(c.length, fadeIn));
  fadeOut = Math.max(0, Math.min(c.length - fadeIn, fadeOut));
  return { ...c, fadeIn, fadeOut };
}

// ── Overlaps and crossfades ───────────────────────────────────────────────

export interface OverlapProblem {
  trackId: string;
  clipIds: string[];
  reason: 'too-many-layers' | 'contained';
}

/**
 * Audio clips on one track may overlap pairwise (the overlap becomes a crossfade),
 * but never three at once and never one fully inside another.
 * Additional layers belong on another track.
 */
export function checkOverlaps(clips: Clip[]): OverlapProblem | null {
  const byTrack = new Map<string, AudioClip[]>();
  for (const c of clips) {
    if (c.kind !== 'audio') continue;
    const list = byTrack.get(c.trackId) ?? [];
    list.push(c);
    byTrack.set(c.trackId, list);
  }
  for (const [trackId, list] of byTrack) {
    list.sort((a, b) => a.start - b.start || b.length - a.length);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i],
          b = list[j];
        if (b.start >= clipEnd(a) - EPS) break;
        if (clipEnd(b) <= clipEnd(a) + EPS) return { trackId, clipIds: [a.id, b.id], reason: 'contained' };
        // A third clip starting before `a` ends makes three layers at once.
        const c = list[j + 1];
        if (c && c.start < clipEnd(a) - EPS) return { trackId, clipIds: [a.id, b.id, c.id], reason: 'too-many-layers' };
      }
    }
  }
  return null;
}

/**
 * Fades actually applied at playback: explicit fades, widened to cover any
 * overlap with the neighbouring clip on the same track (equal-power crossfade).
 */
export function effectiveFades(c: AudioClip, clips: Clip[]): { fadeIn: Beats; fadeOut: Beats } {
  let fadeIn = c.fadeIn;
  let fadeOut = c.fadeOut;
  const end = clipEnd(c);
  for (const o of clips) {
    if (o.id === c.id || o.kind !== 'audio' || o.trackId !== c.trackId) continue;
    const oEnd = clipEnd(o);
    if (o.start < c.start - EPS && oEnd > c.start + EPS && oEnd < end) {
      fadeIn = Math.max(fadeIn, oEnd - c.start);
    }
    if (o.start > c.start + EPS && o.start < end - EPS && oEnd > end) {
      fadeOut = Math.max(fadeOut, end - o.start);
    }
  }
  return { fadeIn: Math.min(fadeIn, c.length), fadeOut: Math.min(fadeOut, c.length) };
}

export function songEnd(clips: Clip[]): Beats {
  return clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}
