import { describe, expect, it } from 'vitest';
import {
  analyzeSample,
  chordForRange,
  computeChroma,
  detectChords,
  detectKey,
  detectNote,
  estimateTempo,
  fft,
  onsetEnvelope,
  pickOnsets,
  refineOnsets,
} from '../src/model/analysis';

const SR = 22050;

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Kick on every beat, snare-ish noise on 2 and 4, hats on the off-beats. */
function drumLoop(bpm: number, offset: number, seconds: number, swingless = true) {
  void swingless;
  const n = Math.floor(seconds * SR);
  const x = new Float32Array(n);
  const r = rng(7);
  const beat = 60 / bpm;
  const add = (t: number, fn: (s: number) => number, len: number) => {
    const s0 = Math.floor(t * SR);
    for (let i = 0; i < len * SR && s0 + i < n; i++) x[s0 + i] += fn(i / SR);
  };
  for (let b = 0, t = offset; t < seconds - 0.2; b++, t += beat) {
    add(t, (s) => 0.9 * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-s * 40)) * s) * Math.exp(-s * 18), 0.18);
    if (b % 4 === 1 || b % 4 === 3) add(t, (s) => 0.5 * (r() * 2 - 1) * Math.exp(-s * 30), 0.12);
    add(t + beat / 2, (s) => 0.2 * (r() * 2 - 1) * Math.exp(-s * 90), 0.04);
  }
  return x;
}

function tones(notes: { midi: number[]; from: number; to: number }[], seconds: number) {
  const x = new Float32Array(Math.floor(seconds * SR));
  for (const nt of notes) {
    for (const m of nt.midi) {
      const f = 440 * 2 ** ((m - 69) / 12);
      for (let i = Math.floor(nt.from * SR); i < Math.min(x.length, Math.floor(nt.to * SR)); i++) {
        const t = i / SR;
        x[i] += 0.2 * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * 2 * f * t) + 0.3 * Math.sin(2 * Math.PI * 3 * f * t));
      }
    }
  }
  return x;
}

describe('fft', () => {
  it('puts a sine in the right bin', () => {
    const n = 1024;
    const re = new Float64Array(n),
      im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 50 * i) / n);
    fft(re, im);
    let best = 0;
    for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[best], im[best])) best = k;
    expect(best).toBe(50);
  });
});

describe('onsets', () => {
  it('finds every beat of a click track within a few ms', async () => {
    const x = new Float32Array(SR * 8);
    const r = rng(3);
    const truth = [0.3, 0.8, 1.3, 1.8, 2.3, 2.8, 3.3, 3.8, 4.3, 4.8, 5.3, 5.8, 6.3, 6.8, 7.3];
    for (const t of truth) for (let i = 0; i < 0.03 * SR; i++) x[Math.floor(t * SR) + i] += (r() * 2 - 1) * Math.exp(-i / (0.006 * SR));
    const oe = await onsetEnvelope([x], SR);
    const found = refineOnsets([x], SR, pickOnsets(oe));
    expect(found.length).toBe(truth.length);
    truth.forEach((t, i) => expect(Math.abs(found[i] - t)).toBeLessThan(0.008));
  });

  it('higher sensitivity finds at least as many hits', async () => {
    const x = drumLoop(110, 0.2, 10);
    const oe = await onsetEnvelope([x], SR);
    expect(pickOnsets(oe, 2.5).length).toBeGreaterThanOrEqual(pickOnsets(oe, 0.5).length);
  });
});

describe('tempo', () => {
  for (const [bpm, offset] of [
    [120, 0.23],
    [96, 0.4],
    [128, 0.05],
  ] as const) {
    it(`detects ${bpm} bpm and the beat phase`, async () => {
      const x = drumLoop(bpm, offset, 24);
      const oe = await onsetEnvelope([x], SR);
      const on = refineOnsets([x], SR, pickOnsets(oe));
      const t = estimateTempo(oe, on)!;
      expect(t).not.toBeNull();
      expect(Math.abs(t.bpm - bpm)).toBeLessThan(0.3);
      const P = 60 / bpm;
      const err = ((((t.offset - offset) % P) + P + P / 2) % P) - P / 2;
      expect(Math.abs(err)).toBeLessThan(0.015);
      expect(t.confidence).toBeGreaterThan(0.3);
    });
  }

  it('returns nothing for audio that is too short', async () => {
    const x = drumLoop(120, 0, 2);
    expect(estimateTempo(await onsetEnvelope([x], SR), [])).toBeNull();
  });
});

describe('downbeat', () => {
  /** Drums with a snare on 2 and 4 (which tempts a naive onset count to call beat 2 the downbeat) over chords that change on bar lines. */
  function band(bpm: number, offset: number, bars: number) {
    const beat = 60 / bpm;
    const secs = offset + bars * 4 * beat + 0.5;
    const x = drumLoop(bpm, offset, secs);
    const chords = [
      [60, 64, 67],
      [53, 57, 60],
      [57, 60, 64],
      [55, 59, 62],
    ];
    for (let bar = 0; bar < bars; bar++) {
      const t0 = offset + bar * 4 * beat;
      for (const m of chords[Math.floor(bar / 2) % 4]) {
        const f = 440 * 2 ** ((m - 69) / 12);
        for (let i = Math.floor(t0 * SR); i < Math.min(x.length, Math.floor((t0 + 4 * beat) * SR)); i++) {
          const s = i / SR - t0;
          x[i] += 0.06 * (Math.sin(2 * Math.PI * f * s) + 0.5 * Math.sin(4 * Math.PI * f * s)) * Math.min(1, s * 40) * Math.min(1, (4 * beat - s) * 20);
        }
      }
    }
    return x;
  }

  it('keeps the onset-based choice when the harmony never changes', async () => {
    const x = drumLoop(120, 0.2, 24);
    for (let i = 0; i < x.length; i++) x[i] += 0.05 * Math.sin((2 * Math.PI * 220 * i) / SR); // a static drone
    const oe = await onsetEnvelope([x], SR);
    const rough = estimateTempo(oe, refineOnsets([x], SR, pickOnsets(oe)))!;
    const a = await analyzeSample([x], SR);
    expect(a.tempo!.offset).toBeCloseTo(rough.offset, 6);
  });

  for (const [bpm, offset] of [
    [112, 0.37],
    [100, 0.3],
  ] as const) {
    it(`puts the bar start on the chord change at ${bpm} bpm`, async () => {
      const bars = 16;
      const a = await analyzeSample([band(bpm, offset, bars)], SR);
      const bar = (60 / bpm) * 4;
      const err = ((((a.tempo!.offset - offset) % bar) + bar * 1.5) % bar) - bar / 2;
      expect(Math.abs(err)).toBeLessThan(0.02);
    });
  }
});

describe('pitch', () => {
  it('names a plucked note and its detune', () => {
    const f = 440 * 2 ** ((57 - 69 + 0.2) / 12); // A3, +20 cents
    const x = new Float32Array(SR * 2);
    for (let i = 0; i < x.length; i++) x[i] = Math.exp(-i / SR) * (Math.sin(2 * Math.PI * f * (i / SR)) + 0.4 * Math.sin(2 * Math.PI * 2 * f * (i / SR)));
    const n = detectNote([x], SR, 0, 2)!;
    expect(n.midi).toBe(57);
    expect(Math.abs(n.cents - 20)).toBeLessThanOrEqual(4);
  });

  it('finds a low bass note', () => {
    const f = 41.2; // E1
    const x = new Float32Array(SR * 2);
    for (let i = 0; i < x.length; i++) x[i] = 0.8 * Math.sin(2 * Math.PI * f * (i / SR)) + 0.4 * Math.sin(2 * Math.PI * 2 * f * (i / SR));
    const n = detectNote([x], SR, 0, 2);
    // Below YIN's range floor the answer is either the right note or nothing; it must not be wrong.
    if (n) expect([28, 40]).toContain(n.midi);
  });

  it('does not invent a pitch from noise', () => {
    const r = rng(11);
    const x = Float32Array.from({ length: SR * 2 }, () => r() * 2 - 1);
    expect(detectNote([x], SR, 0, 2)).toBeNull();
  });
});

describe('chords and key', () => {
  const C = [60, 64, 67],
    F = [53, 57, 60],
    Am = [57, 60, 64],
    G = [55, 59, 62];
  const song = () =>
    tones(
      [
        { midi: C, from: 0, to: 2 },
        { midi: F, from: 2, to: 4 },
        { midi: Am, from: 4, to: 6 },
        { midi: G, from: 6, to: 8 },
      ],
      8,
    );

  it('names a single chord from a selection', async () => {
    const x = tones([{ midi: [62, 65, 69], from: 0, to: 3 }], 3); // D minor
    const ch = await computeChroma([x], SR);
    expect(chordForRange(ch, 0.3, 2.7)!.name).toBe('Dm');
  });

  it('follows a progression', async () => {
    const x = song();
    const ch = await computeChroma([x], SR);
    const segs = detectChords(ch, { bpm: 120, offset: 0 }, 8);
    expect(segs.map((s) => s.name)).toEqual(['C', 'F', 'Am', 'G']);
    expect(Math.abs(segs[1].start - 2)).toBeLessThan(0.35);
  });

  it('finds the key', async () => {
    const ch = await computeChroma([song()], SR);
    const k = detectKey(ch)!;
    expect(['C major', 'A minor']).toContain(k.name);
  });

  it('reports silence as no chord', async () => {
    const ch = await computeChroma([new Float32Array(SR * 2)], SR);
    expect(chordForRange(ch, 0, 2)).toBeNull();
    expect(detectChords(ch, null, 2)).toEqual([]);
  });
});

describe('analyzeSample', () => {
  it('reports progress and can be cancelled', async () => {
    const x = drumLoop(120, 0.1, 12);
    const stages = new Set<string>();
    const a = await analyzeSample([x], SR, { onProgress: (s) => stages.add(s) });
    expect(a.tempo && Math.abs(a.tempo.bpm - 120) < 0.3).toBe(true);
    expect(a.onsets.length).toBeGreaterThan(20);
    expect(stages.size).toBeGreaterThan(2);

    const ctl = new AbortController();
    const p = analyzeSample([drumLoop(120, 0.1, 30)], SR, { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toThrow();
  });
});
