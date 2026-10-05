import { describe, expect, it } from 'vitest';
import { History } from '../src/model/history';
import { computePeaks, peakSpan } from '../src/model/peaks';
import { decodeWav, encodeWav } from '../src/model/wav';

describe('wav', () => {
  const sr = 44100;
  const ch = [new Float32Array([0, 0.5, -0.5, 1, -1, 0.123456]), new Float32Array([0.25, -0.25, 0, 0, 0.9, -0.9])];

  it('round-trips 32-bit float losslessly', () => {
    const d = decodeWav(encodeWav(ch, sr, 'f32'));
    expect(d.sampleRate).toBe(sr);
    expect(Array.from(d.channels[0])).toEqual(Array.from(ch[0]));
    expect(Array.from(d.channels[1])).toEqual(Array.from(ch[1]));
  });

  it('round-trips 24-bit within quantisation', () => {
    const d = decodeWav(encodeWav(ch, sr, 'pcm24'));
    d.channels[0].forEach((v, i) => expect(v).toBeCloseTo(ch[0][i], 5));
  });

  it('round-trips 16-bit within quantisation', () => {
    const d = decodeWav(encodeWav(ch, sr, 'pcm16'));
    d.channels[1].forEach((v, i) => expect(v).toBeCloseTo(ch[1][i], 3));
  });
});

describe('peaks', () => {
  it('summarises min/max across channels and levels', () => {
    const sr = 1000;
    const a = new Float32Array(1000);
    a[10] = 0.8;
    a[900] = -0.6;
    const p = computePeaks([a], sr, 16);
    expect(peakSpan(p, 0, 1)).toEqual([expect.closeTo(-0.6), expect.closeTo(0.8)]);
    expect(peakSpan(p, 0, 0.05)[1]).toBeCloseTo(0.8);
    expect(peakSpan(p, 0.5, 0.6)).toEqual([0, 0]);
  });
});

describe('history', () => {
  it('undoes and redoes snapshots', () => {
    const h = new History<number>();
    h.push(1, 'a');
    h.push(2, 'b');
    expect(h.undo(3)?.state).toBe(2);
    expect(h.undo(2)?.state).toBe(1);
    expect(h.redo(1)?.state).toBe(2);
    h.push(5);
    expect(h.canRedo).toBe(false);
  });
});
