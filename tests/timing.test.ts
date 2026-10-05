import { describe, expect, it } from 'vitest';
import { createAudioClip } from '../src/model/project';
import { sample } from './helpers';
import {
  clipRate,
  contentLengthBeats,
  effectivePitch,
  fadeGainAt,
  formatBBT,
  needsStretch,
  nextWrapAfter,
  normalizeClip,
  snapBeat,
  sourcePosAt,
} from '../src/model/timing';

describe('clip timing', () => {
  it('a 4 s phrase at 120 bpm spans 8 beats', () => {
    const c = createAudioClip(sample(4), 't', 0, 120);
    expect(c.length).toBeCloseTo(8);
    expect(clipRate(c, 120)).toBe(1);
    expect(needsStretch(c, 120)).toBe(false);
  });

  it('pitch shift keeps duration and needs the stretcher', () => {
    const c = normalizeClip({ ...createAudioClip(sample(4), 't', 0, 120), semitones: 3 }, 120);
    expect(c.length).toBeCloseTo(8);
    expect(effectivePitch(c, 120)).toBe(3);
    expect(needsStretch(c, 120)).toBe(true);
  });

  it('stretching to 6 s keeps pitch', () => {
    const c = normalizeClip({ ...createAudioClip(sample(4), 't', 0, 120), stretch: 1.5 }, 120);
    expect(c.length).toBeCloseTo(12); // 6 s at 120 bpm
    expect(effectivePitch(c, 120)).toBe(0);
    expect(clipRate(c, 120)).toBeCloseTo(2 / 3);
  });

  it('tempo-follow keeps beat length when the project tempo changes', () => {
    const c = { ...createAudioClip(sample(4), 't', 0, 120), timing: 'tempo' as const, sourceBpm: 120 };
    expect(contentLengthBeats(c, 120)).toBeCloseTo(8);
    expect(contentLengthBeats(c, 90)).toBeCloseTo(8);
    expect(clipRate(c, 90)).toBeCloseTo(0.75);
    // free clips keep seconds instead
    const f = createAudioClip(sample(4), 't', 0, 120);
    expect(contentLengthBeats(f, 90)).toBeCloseTo(6);
  });

  it('repitch couples speed and pitch', () => {
    const c = { ...createAudioClip(sample(4), 't', 0, 120), repitch: true, stretch: 0.5, semitones: 7 };
    expect(effectivePitch(c, 120)).toBeCloseTo(12);
    expect(needsStretch(c, 120)).toBe(false);
  });

  it('looped clips wrap inside the region', () => {
    const c = { ...createAudioClip(sample(2), 't', 0, 120, { loop: true }), length: 16 };
    expect(contentLengthBeats(c, 120)).toBeCloseTo(4);
    expect(sourcePosAt(c, 120, 5)).toBeCloseTo(0.5);
    expect(nextWrapAfter(c, 120, 5)).toBeCloseTo(8);
    const off = { ...c, loopOffset: 1 };
    expect(sourcePosAt(off, 120, 0)).toBeCloseTo(0.5);
  });

  it('snaps to grid only when enabled', () => {
    expect(snapBeat(1.37, 0.25, true)).toBe(1.25);
    expect(snapBeat(1.37, 0.25, false)).toBe(1.37);
  });

  it('equal-power fades', () => {
    expect(fadeGainAt(0, 8, 1, 0)).toBe(0);
    expect(fadeGainAt(0.5, 8, 1, 0)).toBeCloseTo(Math.SQRT1_2);
    expect(fadeGainAt(4, 8, 1, 1)).toBe(1);
    expect(fadeGainAt(8, 8, 1, 1)).toBeCloseTo(0);
  });

  it('formats bar.beat.sixteenth', () => {
    expect(formatBBT(0)).toBe('1.1.1');
    expect(formatBBT(5.25)).toBe('2.2.2');
    expect(formatBBT(-4)).toBe('-2.1.1');
  });
});
