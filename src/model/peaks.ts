// Waveform peak summaries, computed once per sample (never in audio callbacks).

export interface Peaks {
  /** Frames per bin at the finest level. */
  binSize: number;
  sampleRate: number;
  frames: number;
  /** Mip levels: level k has bins of binSize * 2^k frames. */
  levels: { min: Float32Array; max: Float32Array }[];
}

export function computePeaks(channels: Float32Array[], sampleRate: number, binSize = 64): Peaks {
  const frames = channels[0]?.length ?? 0;
  const bins = Math.max(1, Math.ceil(frames / binSize));
  const min = new Float32Array(bins);
  const max = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    let lo = Infinity, hi = -Infinity;
    const end = Math.min(frames, (b + 1) * binSize);
    for (let i = b * binSize; i < end; i++) {
      for (let c = 0; c < channels.length; c++) {
        const s = channels[c][i];
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
    }
    min[b] = lo === Infinity ? 0 : lo;
    max[b] = hi === -Infinity ? 0 : hi;
  }
  const levels = [{ min, max }];
  while (levels.at(-1)!.min.length > 1) {
    const prev = levels.at(-1)!;
    const n = Math.ceil(prev.min.length / 2);
    const lmin = new Float32Array(n), lmax = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = 2 * i, b = Math.min(2 * i + 1, prev.min.length - 1);
      lmin[i] = Math.min(prev.min[a], prev.min[b]);
      lmax[i] = Math.max(prev.max[a], prev.max[b]);
    }
    levels.push({ min: lmin, max: lmax });
  }
  return { binSize, sampleRate, frames, levels };
}

/** Min/max over a source-time span (seconds), choosing a mip level to match. */
export function peakSpan(p: Peaks, t0: number, t1: number): [number, number] {
  if (t1 < t0) [t0, t1] = [t1, t0];
  const f0 = Math.max(0, Math.floor(t0 * p.sampleRate));
  const f1 = Math.min(p.frames, Math.ceil(t1 * p.sampleRate));
  if (f1 <= f0) {
    const b = Math.min(p.levels[0].min.length - 1, Math.floor(f0 / p.binSize));
    return b >= 0 && f0 < p.frames ? [p.levels[0].min[b], p.levels[0].max[b]] : [0, 0];
  }
  const span = (f1 - f0) / p.binSize;
  const level = Math.max(0, Math.min(p.levels.length - 1, Math.floor(Math.log2(Math.max(1, span)))));
  const size = p.binSize * 2 ** level;
  const L = p.levels[level];
  const b0 = Math.floor(f0 / size);
  const b1 = Math.min(L.min.length - 1, Math.max(b0, Math.ceil(f1 / size) - 1));
  let lo = Infinity, hi = -Infinity;
  for (let b = b0; b <= b1; b++) {
    if (L.min[b] < lo) lo = L.min[b];
    if (L.max[b] > hi) hi = L.max[b];
  }
  return [lo === Infinity ? 0 : lo, hi === -Infinity ? 0 : hi];
}
