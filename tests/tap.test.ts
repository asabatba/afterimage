import { describe, expect, it } from 'vitest';
import { fitTaps } from '../src/model/grid';

/** Deterministic jitter in [-1, 1]. */
const jitter = (i: number) => Math.sin(i * 12.9898) * 0.5 + Math.cos(i * 4.1414) * 0.5;

const taps = (bpm: number, first: number, n: number, jitterMs = 0, skip: number[] = []) => {
  const P = 60 / bpm;
  return Array.from({ length: n }, (_, k) => k)
    .filter((k) => !skip.includes(k))
    .map((k) => first + k * P + (jitterMs / 1000) * jitter(k));
};

describe('fitTaps', () => {
  it('reads tempo and phase from clean taps', () => {
    const f = fitTaps(taps(112, 3.2, 12))!;
    expect(f.bpm).toBeCloseTo(112, 2);
    const bar = (60 / 112) * 4;
    expect(f.offset).toBeCloseTo(3.2 % bar, 4);
    expect(f.taps).toBe(12);
    expect(f.snapped).toBe(false);
  });

  it('copes with human jitter', () => {
    const f = fitTaps(taps(96, 1.0, 24, 25))!;
    expect(Math.abs(f.bpm - 96)).toBeLessThan(0.8);
    expect(f.errorMs).toBeLessThan(30);
  });

  it('tolerates a skipped beat without losing the pulse', () => {
    const f = fitTaps(taps(120, 0.5, 16, 8, [6]))!;
    expect(Math.abs(f.bpm - 120)).toBeLessThan(0.6);
  });

  it('puts the grid on detected hits rather than on the taps', () => {
    const P = 60 / 100;
    const truth = (k: number) => 2.0 + k * P;
    // Sloppy taps (±35 ms, one-sided bias) but exact onsets on the beat plus some off-beat ones.
    const tapTimes = Array.from({ length: 16 }, (_, k) => truth(k) + 0.02 + 0.035 * jitter(k));
    const onsets = Array.from({ length: 16 }, (_, k) => [truth(k), truth(k) + P / 2]).flat();
    const f = fitTaps(tapTimes, onsets)!;
    expect(f.snapped).toBe(true);
    expect(f.bpm).toBeCloseTo(100, 2);
    const bar = P * 4;
    expect(Math.abs(((f.offset - (2.0 % bar) + bar * 1.5) % bar) - bar / 2)).toBeLessThan(0.002);
  });

  it('ignores hits that are not near the tapped beats', () => {
    const f = fitTaps(taps(110, 1, 10), [0.1, 0.2, 5.5, 9.77])!;
    expect(f.snapped).toBe(false);
  });

  it('needs four taps at a plausible pace', () => {
    expect(fitTaps(taps(120, 0, 3))).toBeNull();
    expect(fitTaps([])).toBeNull();
    expect(fitTaps([0, 0.05, 0.1, 0.15, 0.2])).toBeNull(); // 1200 bpm
    expect(fitTaps([0, 3, 6, 9, 12])).toBeNull(); // 20 bpm
  });

  it('rejects taps with no steady pulse', () => {
    expect(fitTaps([0, 0.3, 1.1, 1.3, 2.4, 2.5, 3.9])).toBeNull();
  });

  it('works in any time base (taps measured on a wall clock)', () => {
    const f = fitTaps(taps(140, 12345.6, 10))!;
    expect(f.bpm).toBeCloseTo(140, 2);
    expect(f.offset).toBeLessThan((60 / 140) * 4);
  });
});
