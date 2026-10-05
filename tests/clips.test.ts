import { describe, expect, it } from 'vitest';
import { checkOverlaps, duplicateClip, effectiveFades, slip, splitClip, stretchTo, trimEnd, trimStart } from '../src/model/clips';
import { gainAutomation, planAudio } from '../src/model/playback';
import { createAudioClip, createPatternClip } from '../src/model/project';
import { sourcePosAt } from '../src/model/timing';
import { createPattern } from '../src/model/tracker';
import type { AudioClip } from '../src/model/types';
import { sample } from './helpers';

const bpm = 120;
const clip = (start = 0, dur = 4, extra: Partial<AudioClip> = {}) => createAudioClip(sample(dur), 't1', start, bpm, extra);

describe('arrangement edits', () => {
  it('trims the start without moving content', () => {
    const c = trimStart(clip(0), 2, bpm);
    expect(c.start).toBeCloseTo(2);
    expect(c.srcStart).toBeCloseTo(1);
    expect(c.length).toBeCloseTo(6);
  });

  it('trimming beyond the sample start is clamped', () => {
    const c = trimStart(clip(4), 0, bpm);
    expect(c.start).toBeCloseTo(4);
    expect(c.srcStart).toBe(0);
  });

  it('trims the end and clamps to the sample', () => {
    const c = trimEnd(clip(0), 4, bpm, 4);
    expect(c.srcEnd).toBeCloseTo(2);
    expect(c.length).toBeCloseTo(4);
    expect(trimEnd(clip(0), 40, bpm, 4).srcEnd).toBe(4);
  });

  it('looped clips extend freely', () => {
    const c = trimEnd(clip(0, 2, { loop: true }), 32, bpm, 2);
    expect(c.length).toBe(32);
    expect(c.srcEnd).toBe(2);
  });

  it('stretch-drag preserves the region and changes speed', () => {
    const c = stretchTo(clip(0), 12, bpm);
    expect(c.stretch).toBeCloseTo(1.5);
    expect(c.length).toBeCloseTo(12);
    expect(c.srcEnd).toBe(4);
  });

  it('stretch-drag in tempo mode edits the source tempo', () => {
    const c = stretchTo({ ...clip(0), timing: 'tempo', sourceBpm: 120 }, 16, bpm);
    expect(c.sourceBpm).toBeCloseTo(240);
    expect(c.length).toBeCloseTo(16);
  });

  it('slips content inside the clip', () => {
    const c = trimEnd(trimStart(clip(0), 2, bpm), 6, bpm, 4); // region 1..3 s
    const s = slip(c, 1, bpm, 4); // drag right by a beat = content earlier by 0.5 s
    expect(s.start).toBe(c.start);
    expect(s.srcStart).toBeCloseTo(0.5);
    expect(s.srcEnd).toBeCloseTo(2.5);
  });

  it('splits audio clips at the exact source position', () => {
    const c = { ...clip(0), stretch: 2, length: 16 };
    const [a, b] = splitClip(c, 4, bpm)!;
    expect(a.length).toBeCloseTo(4);
    expect(b.start).toBe(4);
    expect((b as AudioClip).srcStart).toBeCloseTo(1); // 2 s of output at half speed
    expect(b.length).toBeCloseTo(12);
    expect(b.id).not.toBe(a.id);
  });

  it('splits looped clips continuing the loop phase', () => {
    const c = { ...clip(0, 2, { loop: true }), length: 16 };
    const [, b] = splitClip(c, 5, bpm)! as AudioClip[];
    expect(sourcePosAt(b, bpm, 0)).toBeCloseTo(sourcePosAt(c, bpm, 5));
  });

  it('splits pattern clips by offset', () => {
    const p = createPattern('A');
    const pc = createPatternClip(p, 't1', 0);
    const [a, b] = splitClip(pc, 4, bpm)!;
    expect(a.length).toBe(4);
    expect(b.kind === 'pattern' && b.offset).toBe(4);
  });

  it('duplicates after the original by default', () => {
    const c = clip(2);
    const d = duplicateClip(c);
    expect(d.start).toBeCloseTo(10);
    expect(d.id).not.toBe(c.id);
  });
});

describe('overlaps and crossfades', () => {
  it('allows two partially overlapping clips and crossfades them', () => {
    const a = clip(0); // 0..8
    const b = clip(6); // 6..14
    expect(checkOverlaps([a, b])).toBeNull();
    expect(effectiveFades(a, [a, b]).fadeOut).toBeCloseTo(2);
    expect(effectiveFades(b, [a, b]).fadeIn).toBeCloseTo(2);
  });

  it('rejects a third simultaneous layer', () => {
    const a = clip(0),
      b = clip(4),
      c = clip(6);
    expect(checkOverlaps([a, b, c])?.reason).toBe('too-many-layers');
  });

  it('rejects a clip fully inside another', () => {
    const a = clip(0, 4),
      b = clip(2, 1);
    expect(checkOverlaps([a, b])?.reason).toBe('contained');
  });

  it('ignores clips on different tracks', () => {
    const a = clip(0),
      b = { ...clip(2), trackId: 't2' },
      c = { ...clip(4), trackId: 't3' };
    expect(checkOverlaps([a, b, c])).toBeNull();
  });
});

describe('playback planning', () => {
  it('plans from the middle of a clip', () => {
    const a = clip(4);
    const plan = planAudio(a, [a], bpm, 6, Infinity)!;
    expect(plan.local).toBe(2);
    expect(plan.srcPos).toBeCloseTo(1);
    expect(plan.endBeat).toBeCloseTo(12);
  });

  it('cuts at a loop boundary', () => {
    const a = clip(0);
    expect(planAudio(a, [a], bpm, 0, 4)!.endBeat).toBe(4);
    expect(planAudio(a, [a], bpm, 9, 20)).toBeNull();
  });

  it('builds fade automation without overlapping curves', () => {
    const steps = gainAutomation(0, 8, 1, 2, 1);
    expect(steps[0]).toMatchObject({ type: 'set', at: 0, value: 0 });
    const curves = steps.filter((s) => s.type === 'curve') as any[];
    expect(curves).toHaveLength(2);
    expect(curves[0].at + curves[0].dur).toBeLessThanOrEqual(curves[1].at);
    expect(curves[1].values.at(-1)).toBeCloseTo(0);
  });

  it('starts mid fade-out with the right value', () => {
    const steps = gainAutomation(7, 8, 0, 2, 1);
    expect((steps[0] as any).value).toBeCloseTo(Math.sin(Math.PI / 4));
  });
});
