import { describe, expect, it } from 'vitest';
import { regionClip, sliceClips } from '../src/model/chop';
import { checkOverlaps, fillClips, groupSpan, pasteClips, repeatClips } from '../src/model/clips';
import { beatAt, gridLines, nearestOnset, sliceBoundaries, snapToGrid, timeOfBeat } from '../src/model/grid';
import { createAudioClip, createPatternClip } from '../src/model/project';
import { clipEnd } from '../src/model/timing';
import { createPattern } from '../src/model/tracker';
import type { AudioClip, SampleMeta } from '../src/model/types';
import { sample } from './helpers';

const bpm = 120;
const grid = { bpm: 120, offset: 0.25 }; // beat = 0.5 s

describe('beat grid maths', () => {
  it('maps times to beats and back', () => {
    expect(beatAt(grid, 0.75)).toBeCloseTo(1);
    expect(timeOfBeat(grid, 4)).toBeCloseTo(2.25);
  });

  it('snaps to beats and subdivisions', () => {
    expect(snapToGrid(grid, 1.0)).toBeCloseTo(1.25);
    expect(snapToGrid(grid, 1.1, 0.5)).toBeCloseTo(1.0);
    expect(snapToGrid(grid, 0.8, 0.5)).toBeCloseTo(0.75);
    expect(snapToGrid(grid, 1.1, 4)).toBeCloseTo(0.25);
  });

  it('lists lines with bar and beat kinds', () => {
    const l = gridLines(grid, 0, 3, 1);
    expect(l.map((x) => x.kind)).toEqual(['bar', 'beat', 'beat', 'beat', 'bar', 'beat']);
    expect(l[0].t).toBeCloseTo(0.25);
    expect(l.filter((x) => x.kind === 'bar').map((x) => x.t)).toEqual([0.25, 2.25]);
    expect(gridLines(grid, 0, 5, 4).map((x) => x.t)).toEqual([0.25, 2.25, 4.25]);
  });

  it('finds the nearest onset within tolerance', () => {
    const on = [0.1, 0.5, 0.9];
    expect(nearestOnset(on, 0.52, 0.05)).toBe(0.5);
    expect(nearestOnset(on, 0.7, 0.05)).toBeNull();
    expect(nearestOnset([], 1, 1)).toBeNull();
  });
});

describe('slicing', () => {
  it('cuts at grid lines, dropping the lead-in', () => {
    const b = sliceBoundaries(grid, [], 0, 4.25, { kind: 'grid', division: 4 });
    // bar lines at 0.25 and 2.25; the 2 s tail to 4.25 is a full bar, so it is kept
    expect(b).toEqual([0.25, 2.25, 4.25]);
  });

  it('keeps a long tail and drops a tiny one', () => {
    expect(sliceBoundaries(grid, [], 0, 3.5, { kind: 'grid', division: 4 })).toEqual([0.25, 2.25, 3.5]);
    expect(sliceBoundaries(grid, [], 0, 2.3, { kind: 'grid', division: 4 }).length).toBe(2);
  });

  it('cuts at hits inside the range', () => {
    expect(sliceBoundaries(null, [0.1, 0.6, 1.2, 2.5], 0.5, 2, { kind: 'hits' })).toEqual([0.6, 1.2, 2]);
  });

  it('needs a grid for grid slices', () => {
    expect(sliceBoundaries(null, [], 0, 4, { kind: 'grid', division: 1 })).toEqual([]);
  });
});

describe('region clips', () => {
  const meta = (grid?: SampleMeta['grid']): SampleMeta => ({ ...sample(60), name: 'song', grid });

  it('places a free clip at the project tempo', () => {
    const c = regionClip(meta(), 10, 14, 't1', 8, bpm);
    expect(c.srcStart).toBe(10);
    expect(c.srcEnd).toBe(14);
    expect(c.timing).toBe('free');
    expect(c.length).toBeCloseTo(8); // 4 s at 120 bpm
  });

  it('follows tempo when the sample has a grid, keeping bar length at any project tempo', () => {
    const m = meta({ bpm: 100, offset: 0 });
    const c = regionClip(m, 0, (60 / 100) * 8, 't1', 0, 140);
    expect(c.timing).toBe('tempo');
    expect(c.sourceBpm).toBe(100);
    expect(c.length).toBeCloseTo(8);
  });

  it('lays slices end to end without overlaps', () => {
    const m = meta({ bpm: 120, offset: 0 });
    const clips = sliceClips(m, [0, 2, 4, 6, 8.5], 't1', 4, bpm);
    expect(clips.length).toBe(4);
    expect(clips.map((c) => c.start)).toEqual([4, 8, 12, 16]);
    expect(clips[3].length).toBeCloseTo(5);
    expect(checkOverlaps(clips)).toBeNull();
  });

  it('clamps the region into the sample', () => {
    const c = regionClip(meta(), -3, 999, 't1', 0, bpm);
    expect(c.srcStart).toBe(0);
    expect(c.srcEnd).toBe(60);
  });
});

describe('repeat, fill and paste', () => {
  const clip = (start = 0, dur = 2, track = 't1', extra: Partial<AudioClip> = {}) => createAudioClip(sample(dur), track, start, bpm, extra);

  it('measures a group', () => {
    expect(groupSpan([clip(4, 2), clip(0, 1, 't2')])).toEqual({ start: 0, end: 8, length: 8 });
  });

  it('repeats back to back', () => {
    const c = clip(0, 2); // 4 beats
    const copies = repeatClips([c], 3);
    expect(copies.map((x) => x.start)).toEqual([4, 8, 12]);
    expect(new Set(copies.map((x) => x.id)).size).toBe(3);
    expect(checkOverlaps([c, ...copies])).toBeNull();
  });

  it('repeats a multi-clip group as a unit and honours a step', () => {
    const a = clip(0, 1, 't1'),
      b = clip(2, 1, 't2');
    const copies = repeatClips([a, b], 2, 8);
    expect(copies.map((x) => [x.trackId, x.start])).toEqual([
      ['t1', 8],
      ['t2', 10],
      ['t1', 16],
      ['t2', 18],
    ]);
  });

  it('does nothing for a zero step', () => {
    expect(repeatClips([clip()], 3, 0)).toEqual([]);
    expect(repeatClips([], 3)).toEqual([]);
  });

  it('fills up to a target and trims the last copy', () => {
    const c = clip(0, 2); // 4 beats
    const out = fillClips([c], 14, bpm, () => 2);
    expect(out.map((x) => x.start)).toEqual([4, 8, 12]);
    expect(clipEnd(out[2])).toBeCloseTo(14);
    expect(out[2].length).toBeCloseTo(2);
    expect((out[2] as AudioClip).srcEnd).toBeCloseTo(1);
    expect(checkOverlaps([c, ...out])).toBeNull();
  });

  it('can drop the partial copy instead of trimming', () => {
    const out = fillClips([clip(0, 2)], 14, bpm, () => 2, undefined, false);
    expect(out.map((x) => x.start)).toEqual([4, 8]);
  });

  it('fills exactly to a bar line with no partial copy', () => {
    expect(fillClips([clip(0, 2)], 16, bpm).map((x) => x.start)).toEqual([4, 8, 12]);
  });

  it('does nothing when the target is not past the clip', () => {
    expect(fillClips([clip(0, 2)], 4, bpm)).toEqual([]);
    expect(fillClips([clip(0, 2)], 2, bpm)).toEqual([]);
  });

  it('fills a looped clip and a pattern clip by shortening them', () => {
    const loop = clip(0, 1, 't1', { loop: true, length: 2 });
    const out = fillClips([loop], 5, bpm);
    expect(out.map((x) => x.start)).toEqual([2, 4]);
    expect(out[1].length).toBeCloseTo(1);
    const pat = createPatternClip(createPattern('p', 16), 't1', 0); // 4 beats
    const pout = fillClips([pat], 6, bpm);
    expect(pout[0].length).toBeCloseTo(2);
    expect(pout[0].kind === 'pattern' && pout[0].patternId).toBe(pat.patternId);
  });

  it('pastes at a beat, keeping relative positions and shifting rows', () => {
    const tracks = ['t1', 't2', 't3'];
    const a = clip(4, 1, 't1'),
      b = clip(6, 1, 't2');
    const out = pasteClips([a, b], 16, tracks, 1);
    expect(out.map((x) => [x.trackId, x.start])).toEqual([
      ['t2', 16],
      ['t3', 18],
    ]);
    const clamped = pasteClips([a, b], 0, tracks, 5);
    expect(clamped.every((x) => x.trackId === 't3')).toBe(true);
    expect(out[0].id).not.toBe(a.id);
  });
});
