// Audio analysis: onsets, tempo and beat grid, pitch, chords and key.
// Pure functions over PCM (no DOM, no Web Audio) so they can be tested in node.
// The long-running ones are async and yield to the event loop so the UI stays responsive.
import type { Seconds } from './types';

export interface AnalysisOptions {
  signal?: AbortSignal;
  onProgress?: (stage: string, fraction: number) => void;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Returns a function to await inside hot loops; it yields at most every ~10 ms of work. */
function pacer(signal?: AbortSignal) {
  let last = now();
  return async () => {
    if (signal?.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
    if (now() - last > 10) {
      await tick();
      last = now();
    }
  };
}

// ── FFT ──────────────────────────────────────────────────────────────────

interface FftPlan {
  n: number;
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
  hann: Float64Array;
}
const plans = new Map<number, FftPlan>();

function plan(n: number): FftPlan {
  let p = plans.get(n);
  if (p) return p;
  const bits = Math.round(Math.log2(n));
  if (1 << bits !== n) throw new Error('FFT size must be a power of two');
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  const hann = new Float64Array(n);
  for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  p = { n, cos, sin, rev, hann };
  plans.set(n, p);
  return p;
}

/** In-place radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array) {
  const { n, cos, sin, rev } = plan(re.length);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const a = start + k, b = a + half;
        const wr = cos[t], wi = -sin[t];
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

const nearestPow2 = (x: number) => 2 ** Math.max(6, Math.round(Math.log2(Math.max(1, x))));

/** Windowed mono frame mixed on the fly from all channels (no big mono copy). */
function fillFrame(channels: Float32Array[], start: number, re: Float64Array, hann: Float64Array) {
  const n = re.length;
  const total = channels[0].length;
  const inv = 1 / channels.length;
  for (let i = 0; i < n; i++) {
    const p = start + i;
    let s = 0;
    if (p >= 0 && p < total) for (let c = 0; c < channels.length; c++) s += channels[c][p];
    re[i] = s * inv * hann[i];
  }
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ── Onsets ───────────────────────────────────────────────────────────────

export interface OnsetEnvelope {
  /** Spectral flux per frame (log-compressed, half-wave rectified). */
  env: Float32Array;
  hopSec: Seconds;
  frameSec: Seconds;
}

export async function onsetEnvelope(channels: Float32Array[], sampleRate: number, opts: AnalysisOptions = {}): Promise<OnsetEnvelope> {
  const total = channels[0]?.length ?? 0;
  const frame = nearestPow2(sampleRate * 0.023);
  const hop = total / sampleRate > 600 ? frame / 2 : frame / 4;
  const frames = total >= frame ? Math.floor((total - frame) / hop) + 1 : 0;
  const env = new Float32Array(frames);
  const { hann } = plan(frame);
  const re = new Float64Array(frame), im = new Float64Array(frame);
  const maxBin = Math.min(frame / 2 - 1, Math.floor(10000 / (sampleRate / frame)));
  const prev = new Float64Array(maxBin + 1);
  const scale = 1 / (frame * 0.25);
  const pace = pacer(opts.signal);
  for (let f = 0; f < frames; f++) {
    fillFrame(channels, f * hop, re, hann);
    im.fill(0);
    fft(re, im);
    let flux = 0;
    for (let k = 1; k <= maxBin; k++) {
      const lm = Math.log1p(50 * Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale);
      const d = lm - prev[k];
      if (f > 0 && d > 0) flux += d;
      prev[k] = lm;
    }
    env[f] = flux;
    if ((f & 127) === 0) {
      await pace();
      opts.onProgress?.('Finding hits', f / frames);
    }
  }
  return { env, hopSec: hop / sampleRate, frameSec: frame / sampleRate };
}

/** Approximate onset times (seconds) from the envelope. Higher sensitivity finds more. */
export function pickOnsets(oe: OnsetEnvelope, sensitivity = 1, minGap = 0.05): Seconds[] {
  const { env, hopSec, frameSec } = oe;
  const n = env.length;
  if (n < 3) return [];
  let max = 0;
  for (let i = 0; i < n; i++) if (env[i] > max) max = env[i];
  if (max <= 0) return [];
  const w = Math.max(2, Math.round(0.12 / hopSec));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + env[i];
  const sens = Math.max(0.1, sensitivity);
  const out: { t: number; v: number }[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = env[i];
    if (v < env[i - 1] || v <= env[i + 1]) continue;
    const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
    const mean = (pre[b] - pre[a]) / (b - a);
    if (v <= mean * (1 + 0.9 / sens) + (max * 0.05) / sens) continue;
    const t = i * hopSec + frameSec * 0.5;
    const last = out[out.length - 1];
    if (last && t - last.t < minGap) {
      if (v > last.v) out[out.length - 1] = { t, v };
    } else out.push({ t, v });
  }
  return out.map((o) => o.t);
}

/** Move an approximate onset onto the steepest rise of the waveform around it. */
export function refineOnset(channels: Float32Array[], sampleRate: number, t: Seconds): Seconds {
  const total = channels[0].length;
  const box = Math.max(1, Math.round(sampleRate * 0.001));
  const w0 = Math.max(0, Math.floor((t - 0.04) * sampleRate));
  const w1 = Math.min(total - 2 * box - 1, Math.ceil((t + 0.02) * sampleRate));
  if (w1 <= w0) return t;
  const len = w1 - w0 + 2 * box + 1;
  const a = new Float32Array(len);
  const inv = 1 / channels.length;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let c = 0; c < channels.length; c++) s += Math.abs(channels[c][w0 + i]);
    a[i] = s * inv;
  }
  const pre = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + a[i];
  let best = -Infinity, at = 0;
  for (let i = 0; i + 2 * box <= len; i++) {
    const rise = pre[i + 2 * box] - pre[i + box] - (pre[i + box] - pre[i]);
    if (rise > best) {
      best = rise;
      at = i + box;
    }
  }
  return (w0 + at) / sampleRate;
}

export function refineOnsets(channels: Float32Array[], sampleRate: number, times: Seconds[]): Seconds[] {
  const out: number[] = [];
  for (const t of times) {
    const r = refineOnset(channels, sampleRate, t);
    if (!out.length || r - out[out.length - 1] > 0.02) out.push(r);
  }
  return out;
}

// ── Tempo and beat grid ──────────────────────────────────────────────────

export interface TempoEstimate {
  bpm: number;
  /** Time of a downbeat (bar start), seconds, within the first bar of the audio. */
  offset: Seconds;
  /** 0..1, how strongly the audio follows a steady pulse. */
  confidence: number;
  /** Time of the first beat (0 ≤ phase < one beat); the bar start is one of the next four beats. */
  phase: Seconds;
  /** Onset strength accumulated on each of the four beats of the bar. */
  onsetSums: number[];
}

function detrend(env: Float32Array, w: number): Float32Array {
  const n = env.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + env[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
    out[i] = Math.max(0, env[i] - (pre[b] - pre[a]) / (b - a));
  }
  return out;
}

function comb(o: Float32Array, period: number, phase: number, end = o.length): number {
  let s = 0, c = 0;
  const last = Math.min(end, o.length) - 1;
  for (let t = phase; t < last; t += period) {
    const i = t | 0, f = t - i;
    s += o[i] * (1 - f) + o[i + 1] * f;
    c++;
  }
  return c ? s / c : 0;
}

function bestComb(o: Float32Array, bpmLo: number, bpmHi: number, bpmStep: number, hopSec: number, from: number, to: number) {
  // Score on o[from, to) by shifting the window start into the phase.
  const seg = o.subarray(from, to);
  let best = { bpm: bpmLo, phase: 0, score: -1, mean: 0 };
  for (let b = bpmLo; b <= bpmHi + 1e-9; b += bpmStep) {
    const P = 60 / (b * hopSec);
    let sum = 0, cnt = 0, top = -1, topPhase = 0;
    for (let ph = 0; ph < P; ph += 0.5) {
      const s = comb(seg, P, ph);
      sum += s;
      cnt++;
      if (s > top) {
        top = s;
        topPhase = ph;
      }
    }
    if (top > best.score) best = { bpm: b, phase: topPhase + from, score: top, mean: sum / cnt };
  }
  return best;
}

export function estimateTempo(
  oe: OnsetEnvelope,
  onsets: Seconds[] = [],
  opts: { minBpm?: number; maxBpm?: number } = {},
): TempoEstimate | null {
  const { env, hopSec, frameSec } = oe;
  const n = env.length;
  const minBpm = opts.minBpm ?? 70;
  const maxBpm = opts.maxBpm ?? 180;
  if (n * hopSec < 3) return null;
  const o = detrend(env, Math.max(2, Math.round(0.3 / hopSec)));

  // Autocorrelation of the novelty curve.
  const maxLag = Math.ceil((4 * 60) / minBpm / hopSec) + 2;
  const ac = new Float64Array(maxLag + 1);
  for (let L = 0; L <= maxLag && L < n; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += o[i] * o[i + L];
    ac[L] = s / (n - L);
  }
  if (ac[0] <= 0) return null;
  const at = (L: number) => {
    if (L >= maxLag) return 0;
    const i = Math.floor(L), f = L - i;
    return (ac[i] * (1 - f) + ac[i + 1] * f) / ac[0];
  };
  let b0 = 0, bestSal = -1;
  for (let b = minBpm; b <= maxBpm; b += 0.25) {
    const L = 60 / (b * hopSec);
    const prior = Math.exp(-0.5 * (Math.log2(b / 115) / 0.55) ** 2);
    const sal = (at(L) + 0.5 * at(2 * L) + 0.25 * at(4 * L)) * prior;
    if (sal > bestSal) {
      bestSal = sal;
      b0 = b;
    }
  }
  if (bestSal <= 0) return null;

  // Refine tempo and phase with a comb filter: coarse on a window, fine on the whole file.
  const dur = n * hopSec;
  const winFrames = Math.min(n, Math.round(40 / hopSec));
  const winStart = Math.max(0, Math.min(n - winFrames, Math.round(n * 0.15)));
  const winSec = winFrames * hopSec;
  const coarseStep = Math.max(0.005, (b0 * 1.5 * hopSec) / winSec);
  const c1 = bestComb(o, b0 * 0.985, b0 * 1.015, coarseStep, hopSec, winStart, winStart + winFrames);
  const fineStep = Math.max(0.002, (c1.bpm * 1.5 * hopSec) / dur);
  const span = Math.max(coarseStep * 1.5, fineStep * 2);
  const c2 = bestComb(o, c1.bpm - span, c1.bpm + span, fineStep, hopSec, 0, n);
  const bpm = c2.bpm;
  const P = 60 / bpm;
  const ratio = c2.mean > 0 ? c2.score / c2.mean : 1;
  const confidence = Math.max(0, Math.min(1, (ratio - 1) / 2));

  // Phase in seconds (flux peaks sit near the frame centre), then correct it against refined onsets.
  let phase = (c2.phase * hopSec + frameSec * 0.5) % P;
  const resid: number[] = [];
  for (const t of onsets) {
    const k = Math.round((t - phase) / P);
    const r = t - (phase + k * P);
    if (Math.abs(r) < 0.1 * P) resid.push(r);
  }
  if (resid.length >= 4) phase = (((phase + median(resid)) % P) + P) % P;

  // Which of the four beats is the bar start: the one with the strongest accumulated onsets.
  const sums = [0, 0, 0, 0];
  for (let j = 0, t = phase; t < dur; j++, t += P) {
    const f = Math.round((t - frameSec * 0.5) / hopSec);
    let s = 0;
    for (let d = -1; d <= 1; d++) s = Math.max(s, o[Math.min(n - 1, Math.max(0, f + d))]);
    sums[j % 4] += s;
  }
  let m = 0;
  for (let i = 1; i < 4; i++) if (sums[i] > sums[m] * 1.05) m = i;
  return { bpm: Math.round(bpm * 1000) / 1000, offset: phase + m * P, confidence, phase, onsetSums: sums };
}

/**
 * Choose which beat starts the bar using harmony: chords usually change on bar lines, so the beat
 * position where the chroma changes most (consistently, over the whole file) is the bar start.
 * Falls back to the onset-based guess when no position stands out (static harmony, very short audio).
 */
export function refineDownbeat(t: TempoEstimate, chroma: Chroma, duration: Seconds): TempoEstimate {
  const P = 60 / t.bpm;
  const beats = Math.floor((duration - t.phase) / P);
  if (beats < 16 || chroma.nFrames < 8) return t;
  const beatVector = (j: number): Float64Array | null => {
    const a = t.phase + j * P, b = a + P;
    const acc = new Float64Array(12);
    let used = 0;
    for (let f = Math.max(0, Math.floor((a - chroma.frameSec / 2) / chroma.hopSec)); f < chroma.nFrames; f++) {
      const centre = f * chroma.hopSec + chroma.frameSec / 2;
      if (centre >= b) break;
      if (centre < a) continue;
      let s = 0;
      for (let i = 0; i < 12; i++) s += chroma.data[f * 12 + i];
      if (s <= 1e-7) continue;
      for (let i = 0; i < 12; i++) acc[i] += chroma.data[f * 12 + i] / s;
      used++;
    }
    return used ? acc : null;
  };
  const change = new Float64Array(4), count = new Int32Array(4);
  let prev = beatVector(0);
  for (let j = 1; j < beats; j++) {
    const cur = beatVector(j);
    if (prev && cur) {
      let dot = 0, np = 0, nc = 0;
      for (let i = 0; i < 12; i++) {
        dot += prev[i] * cur[i];
        np += prev[i] * prev[i];
        nc += cur[i] * cur[i];
      }
      change[j % 4] += 1 - dot / (Math.sqrt(np * nc) || 1);
      count[j % 4]++;
    }
    prev = cur;
  }
  const avg = [0, 1, 2, 3].map((r) => (count[r] ? change[r] / count[r] : 0));
  let best = 0;
  for (let r = 1; r < 4; r++) if (avg[r] > avg[best]) best = r;
  const others = avg.filter((_, r) => r !== best);
  const second = Math.max(...others);
  // The position must clearly stand out, and the change must be real (not noise on a static chord).
  if (avg[best] < 0.03 || avg[best] < second * 1.5) return t;
  return { ...t, offset: t.phase + best * P };
}

// ── Pitch (YIN) ──────────────────────────────────────────────────────────

export interface NoteEstimate {
  /** Nearest MIDI note. */
  midi: number;
  /** Deviation from that note, cents (−50..50). */
  cents: number;
  freq: number;
  /** 0..1 */
  clarity: number;
  /** Fraction of analysed frames that were pitched. */
  voiced: number;
}

function yin(x: Float32Array, W: number, tauMin: number, tauMax: number, threshold: number): { tau: number; clarity: number } | null {
  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let j = 0; j < W; j++) {
      const diff = x[j] - x[j + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }
  const cm = new Float64Array(tauMax + 1);
  cm[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    run += d[tau];
    cm[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  let tau = -1;
  for (let t = Math.max(2, tauMin); t < tauMax; t++) {
    if (cm[t] < threshold) {
      while (t + 1 < tauMax && cm[t + 1] < cm[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;
  const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1];
  const den = a - 2 * b + c;
  const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
  return { tau: tau + Math.max(-1, Math.min(1, shift)), clarity: 1 - b };
}

/** Dominant pitch of a region: median over the pitched frames. Returns null for noise and drums. */
export function detectNote(channels: Float32Array[], sampleRate: number, from: Seconds, to: Seconds): NoteEstimate | null {
  const total = channels[0]?.length ?? 0;
  const a = Math.max(0, Math.floor(from * sampleRate));
  const b = Math.min(total, Math.ceil(Math.min(to, from + 4) * sampleRate));
  const dec = Math.max(1, Math.floor(sampleRate / 6000));
  const M = Math.floor((b - a) / dec);
  const sr = sampleRate / dec;
  const fmin = 45, fmax = 1500;
  const tauMax = Math.ceil(sr / fmin);
  const tauMin = Math.floor(sr / fmax);
  const W = 1024;
  if (M < W + tauMax) return null;
  const x = new Float32Array(M);
  const inv = 1 / (dec * channels.length);
  for (let i = 0; i < M; i++) {
    let s = 0;
    for (let c = 0; c < channels.length; c++) for (let k = 0; k < dec; k++) s += channels[c][a + i * dec + k];
    x[i] = s * inv;
  }
  const hop = 512;
  const frameLen = W + tauMax + 1;
  const rms: number[] = [];
  const starts: number[] = [];
  for (let s = 0; s + frameLen <= M; s += hop) {
    let e = 0;
    for (let i = 0; i < W; i++) e += x[s + i] * x[s + i];
    rms.push(Math.sqrt(e / W));
    starts.push(s);
  }
  const maxRms = Math.max(...rms, 1e-9);
  const midis: number[] = [];
  const clar: number[] = [];
  let considered = 0;
  for (let f = 0; f < starts.length; f++) {
    if (rms[f] < maxRms * 0.08) continue;
    considered++;
    const r = yin(x.subarray(starts[f], starts[f] + frameLen), W, tauMin, tauMax, 0.15);
    if (!r || r.clarity < 0.8) continue;
    const freq = sr / r.tau;
    midis.push(69 + 12 * Math.log2(freq / 440));
    clar.push(r.clarity);
  }
  if (!considered || midis.length < 2 || midis.length / considered < 0.3) return null;
  const m = median(midis);
  // Octave jumps are common; keep frames close to the median.
  const close = midis.filter((v) => Math.abs(v - m) < 1);
  if (close.length < 2) return null;
  const mm = median(close);
  const midi = Math.round(mm);
  return {
    midi,
    cents: Math.round((mm - midi) * 100),
    freq: 440 * 2 ** ((mm - 69) / 12),
    clarity: clar.reduce((s, v) => s + v, 0) / clar.length,
    voiced: midis.length / considered,
  };
}

// ── Chroma, chords and key ───────────────────────────────────────────────

export const PITCH_CLASSES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export interface Chroma {
  /** nFrames × 12, row-major, unnormalised. */
  data: Float32Array;
  nFrames: number;
  hopSec: Seconds;
  frameSec: Seconds;
  /** Sum of each frame's chroma, to spot silence. */
  energy: Float32Array;
}

/** Chroma of [from, to) seconds. Peaks in the spectrum vote for their nearest pitch class. */
export async function computeChroma(
  channels: Float32Array[],
  sampleRate: number,
  range?: { from?: Seconds; to?: Seconds },
  opts: AnalysisOptions = {},
): Promise<Chroma> {
  const total = channels[0]?.length ?? 0;
  const a0 = Math.max(0, Math.floor((range?.from ?? 0) * sampleRate));
  const b0 = Math.min(total, Math.ceil((range?.to ?? total / sampleRate) * sampleRate));
  const frame = nearestPow2(sampleRate * 0.19);
  const hop = frame / 2;
  const nFrames = b0 - a0 >= frame / 2 ? Math.max(1, Math.floor((b0 - a0 - frame) / hop) + 1) : 0;
  const data = new Float32Array(nFrames * 12);
  const energy = new Float32Array(nFrames);
  const { hann } = plan(frame);
  const re = new Float64Array(frame), im = new Float64Array(frame);
  const binHz = sampleRate / frame;
  const kMin = Math.max(2, Math.floor(65 / binHz)), kMax = Math.min(frame / 2 - 2, Math.floor(4500 / binHz));
  const mag = new Float64Array(kMax + 2);
  const pace = pacer(opts.signal);
  for (let f = 0; f < nFrames; f++) {
    fillFrame(channels, a0 + f * hop, re, hann);
    im.fill(0);
    fft(re, im);
    let top = 0;
    for (let k = kMin - 1; k <= kMax + 1; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / frame;
      if (mag[k] > top) top = mag[k];
    }
    const floor = top * 0.03;
    let sum = 0;
    for (let k = kMin; k <= kMax; k++) {
      const m = mag[k];
      if (m < floor || m <= mag[k - 1] || m < mag[k + 1]) continue;
      const den = mag[k - 1] - 2 * m + mag[k + 1];
      const shift = den !== 0 ? (0.5 * (mag[k - 1] - mag[k + 1])) / den : 0;
      const freq = (k + Math.max(-0.5, Math.min(0.5, shift))) * binHz;
      const pc = ((Math.round(69 + 12 * Math.log2(freq / 440)) % 12) + 12) % 12;
      data[f * 12 + pc] += m;
      sum += m;
    }
    energy[f] = sum;
    if ((f & 15) === 0) {
      await pace();
      opts.onProgress?.('Listening for harmony', f / nFrames);
    }
  }
  return { data, nFrames, hopSec: hop / sampleRate, frameSec: frame / sampleRate, energy };
}

interface Quality {
  suffix: string;
  intervals: number[];
  bias: number;
}
const QUALITIES: Quality[] = [
  { suffix: '', intervals: [0, 4, 7], bias: 0 },
  { suffix: 'm', intervals: [0, 3, 7], bias: 0 },
  { suffix: '7', intervals: [0, 4, 7, 10], bias: -0.04 },
  { suffix: 'maj7', intervals: [0, 4, 7, 11], bias: -0.05 },
  { suffix: 'm7', intervals: [0, 3, 7, 10], bias: -0.04 },
];

interface Template {
  root: number;
  q: number;
  vec: Float64Array;
  norm: number;
}
const TEMPLATES: Template[] = [];
for (let q = 0; q < QUALITIES.length; q++) {
  for (let root = 0; root < 12; root++) {
    const vec = new Float64Array(12);
    for (const iv of QUALITIES[q].intervals) vec[(root + iv) % 12] = 1;
    TEMPLATES.push({ root, q, vec, norm: Math.sqrt(QUALITIES[q].intervals.length) });
  }
}

export const chordName = (root: number, q: number) => `${PITCH_CLASSES[root]}${QUALITIES[q].suffix}`;

function similarities(c: ArrayLike<number>, off: number): Float64Array {
  let n2 = 0;
  for (let i = 0; i < 12; i++) n2 += c[off + i] * c[off + i];
  const n = Math.sqrt(n2) || 1;
  const out = new Float64Array(TEMPLATES.length);
  for (let t = 0; t < TEMPLATES.length; t++) {
    const tpl = TEMPLATES[t];
    let dot = 0;
    for (let i = 0; i < 12; i++) dot += tpl.vec[i] * c[off + i];
    out[t] = dot / (n * tpl.norm) + QUALITIES[tpl.q].bias;
  }
  return out;
}

export interface ChordGuess {
  name: string;
  root: number;
  quality: string;
  /** Cosine similarity with the chord template, 0..1. */
  score: number;
}

export interface ChordSegment extends ChordGuess {
  start: Seconds;
  end: Seconds;
}

/** Best chord for the chroma between `from` and `to` (seconds). */
export function chordForRange(chroma: Chroma, from: Seconds, to: Seconds): ChordGuess | null {
  const acc = new Float64Array(12);
  let used = 0;
  for (let f = 0; f < chroma.nFrames; f++) {
    const centre = f * chroma.hopSec + chroma.frameSec / 2;
    if (centre < from || centre > to) continue;
    for (let i = 0; i < 12; i++) acc[i] += chroma.data[f * 12 + i];
    used++;
  }
  if (!used) {
    // A selection shorter than a frame: use the frame nearest its middle.
    const f = Math.round(((from + to) / 2 - chroma.frameSec / 2) / chroma.hopSec);
    if (f < 0 || f >= chroma.nFrames) return null;
    for (let i = 0; i < 12; i++) acc[i] = chroma.data[f * 12 + i];
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += acc[i];
  if (sum <= 1e-7) return null;
  const sims = similarities(acc, 0);
  let best = 0;
  for (let t = 1; t < sims.length; t++) if (sims[t] > sims[best]) best = t;
  const tpl = TEMPLATES[best];
  return { name: chordName(tpl.root, tpl.q), root: tpl.root, quality: QUALITIES[tpl.q].suffix || 'maj', score: Math.max(0, sims[best]) };
}

/**
 * Chord progression: chroma is averaged per unit (a beat when a grid is known, else half a second),
 * scored against chord templates, and smoothed with a Viterbi pass so single noisy units don't flip the chord.
 */
export function detectChords(chroma: Chroma, grid: { bpm: number; offset: Seconds } | null, duration: Seconds): ChordSegment[] {
  if (!chroma.nFrames) return [];
  const unit = grid ? 60 / grid.bpm : 0.5;
  const t0 = grid ? grid.offset - Math.ceil(grid.offset / unit) * unit : 0;
  const nUnits = Math.max(1, Math.ceil((duration - t0) / unit));
  const acc = new Float64Array(nUnits * 12);
  const cnt = new Int32Array(nUnits);
  for (let f = 0; f < chroma.nFrames; f++) {
    const centre = f * chroma.hopSec + chroma.frameSec / 2;
    const u = Math.floor((centre - t0) / unit);
    if (u < 0 || u >= nUnits) continue;
    // Normalise each frame so loud frames don't dominate the unit.
    let s = 0;
    for (let i = 0; i < 12; i++) s += chroma.data[f * 12 + i];
    if (s <= 1e-7) continue;
    for (let i = 0; i < 12; i++) acc[u * 12 + i] += chroma.data[f * 12 + i] / s;
    cnt[u]++;
  }
  const S = TEMPLATES.length + 1; // + "no chord"
  const ALPHA = 8, SWITCH = 2.2;
  const emit = new Float64Array(nUnits * S);
  for (let u = 0; u < nUnits; u++) {
    if (!cnt[u]) {
      for (let s = 0; s < TEMPLATES.length; s++) emit[u * S + s] = 0;
      emit[u * S + TEMPLATES.length] = ALPHA;
      continue;
    }
    const sims = similarities(acc, u * 12);
    for (let s = 0; s < TEMPLATES.length; s++) emit[u * S + s] = ALPHA * sims[s];
    emit[u * S + TEMPLATES.length] = ALPHA * 0.5;
  }
  const score = new Float64Array(S), next = new Float64Array(S);
  const back = new Uint8Array(nUnits * S);
  for (let s = 0; s < S; s++) score[s] = emit[s];
  for (let u = 1; u < nUnits; u++) {
    let bi = 0;
    for (let s = 1; s < S; s++) if (score[s] > score[bi]) bi = s;
    for (let s = 0; s < S; s++) {
      const stay = score[s], move = score[bi] - SWITCH;
      if (stay >= move) {
        next[s] = stay + emit[u * S + s];
        back[u * S + s] = s;
      } else {
        next[s] = move + emit[u * S + s];
        back[u * S + s] = bi;
      }
    }
    score.set(next);
  }
  let state = 0;
  for (let s = 1; s < S; s++) if (score[s] > score[state]) state = s;
  const path = new Uint8Array(nUnits);
  for (let u = nUnits - 1; u >= 0; u--) {
    path[u] = state;
    state = back[u * S + state];
  }
  const segs: ChordSegment[] = [];
  for (let u = 0; u < nUnits; ) {
    let v = u;
    while (v + 1 < nUnits && path[v + 1] === path[u]) v++;
    if (path[u] < TEMPLATES.length) {
      const tpl = TEMPLATES[path[u]];
      let sim = 0;
      for (let k = u; k <= v; k++) sim += emit[k * S + path[u]] / ALPHA;
      segs.push({
        name: chordName(tpl.root, tpl.q),
        root: tpl.root,
        quality: QUALITIES[tpl.q].suffix || 'maj',
        score: Math.max(0, sim / (v - u + 1)),
        start: Math.max(0, t0 + u * unit),
        end: Math.min(duration, t0 + (v + 1) * unit),
      });
    }
    u = v + 1;
  }
  return segs;
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface KeyEstimate {
  tonic: number;
  mode: 'major' | 'minor';
  name: string;
  /** Pearson correlation with the key profile, −1..1. */
  score: number;
}

/** Krumhansl–Schmuckler key finding over the whole chroma. */
export function detectKey(chroma: Chroma): KeyEstimate | null {
  const acc = new Float64Array(12);
  for (let f = 0; f < chroma.nFrames; f++) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += chroma.data[f * 12 + i];
    if (s <= 1e-7) continue;
    for (let i = 0; i < 12; i++) acc[i] += chroma.data[f * 12 + i] / s;
  }
  const mean = acc.reduce((s, v) => s + v, 0) / 12;
  if (mean <= 0) return null;
  const corr = (profile: number[], rot: number) => {
    const pm = profile.reduce((s, v) => s + v, 0) / 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) {
      const x = acc[(i + rot) % 12] - mean, y = profile[i] - pm;
      num += x * y;
      da += x * x;
      db += y * y;
    }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  };
  let best: KeyEstimate | null = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const score = corr(mode === 'major' ? MAJOR : MINOR, tonic);
      if (!best || score > best.score) best = { tonic, mode, name: `${PITCH_CLASSES[tonic]} ${mode}`, score };
    }
  }
  return best;
}

// ── Whole-sample analysis ────────────────────────────────────────────────

export interface SampleAnalysis {
  duration: Seconds;
  sampleRate: number;
  envelope: OnsetEnvelope;
  /** Refined onset times at the default sensitivity. */
  onsets: Seconds[];
  tempo: TempoEstimate | null;
  chroma: Chroma;
  chords: ChordSegment[];
  key: KeyEstimate | null;
}

export async function analyzeSample(channels: Float32Array[], sampleRate: number, opts: AnalysisOptions = {}): Promise<SampleAnalysis> {
  const duration = (channels[0]?.length ?? 0) / sampleRate;
  const stage = (lo: number, hi: number) => (name: string, f: number) => opts.onProgress?.(name, lo + (hi - lo) * f);
  const envelope = await onsetEnvelope(channels, sampleRate, { signal: opts.signal, onProgress: stage(0, 0.45) });
  const onsets = refineOnsets(channels, sampleRate, pickOnsets(envelope));
  opts.onProgress?.('Finding the tempo', 0.5);
  await tick();
  const rough = estimateTempo(envelope, onsets);
  const chroma = await computeChroma(channels, sampleRate, undefined, { signal: opts.signal, onProgress: stage(0.55, 0.92) });
  const tempo = rough && refineDownbeat(rough, chroma, duration);
  opts.onProgress?.('Naming chords', 0.95);
  await tick();
  const chords = detectChords(chroma, tempo, duration);
  const key = detectKey(chroma);
  opts.onProgress?.('Done', 1);
  return { duration, sampleRate, envelope, onsets, tempo, chroma, chords, key };
}
