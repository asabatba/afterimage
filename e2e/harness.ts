// Test harness exposing the audio engine to Playwright (dev server only).
import { createProject, createAudioClip, createPatternClip, createInstrument } from '../src/model/project';
import { createPattern, setCell } from '../src/model/tracker';
import { normalizeClip } from '../src/model/timing';
import { SampleRegistry } from '../src/audio/samples';
import { renderOffline } from '../src/audio/export';
import type { SampleMeta, Project } from '../src/model/types';

const SR = 48000;

function tone(freq: number, seconds: number, amp = 0.5) {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = amp * Math.sin((2 * Math.PI * freq * i) / SR); l[i] = v; r[i] = v; }
  return [l, r];
}

function meta(id: string, seconds: number): SampleMeta {
  return { id, name: id, kind: 'import', sampleRate: SR, channels: 2, frames: seconds * SR, duration: seconds, createdAt: 0 };
}

/** Dominant frequency via zero crossings over a steady window. */
function freqOf(ch: Float32Array, from: number, to: number) {
  let crossings = 0, first = -1, last = -1;
  for (let i = from + 1; i < to; i++) {
    if (ch[i - 1] <= 0 && ch[i] > 0) { crossings++; if (first < 0) first = i; last = i; }
  }
  return crossings > 1 ? ((crossings - 1) * SR) / (last - first) : 0;
}

/** Seconds where the RMS envelope exceeds a fraction of its peak. */
function activeSpan(ch: Float32Array, frac = 0.3) {
  const win = 480; const env: number[] = [];
  for (let i = 0; i + win <= ch.length; i += win) { let s = 0; for (let j = 0; j < win; j++) s += ch[i + j] ** 2; env.push(Math.sqrt(s / win)); }
  const peak = Math.max(...env); let a = -1, b = -1;
  env.forEach((v, i) => { if (v > peak * frac) { if (a < 0) a = i; b = i; } });
  return { start: (a * win) / SR, end: ((b + 1) * win) / SR, peak };
}

async function scenario(edit: (p: Project, samples: SampleRegistry) => void, endBeat: number, tail = 0) {
  const samples = new SampleRegistry();
  const ctx = new OfflineAudioContext(2, SR, SR);
  const t = tone(440, 4);
  const b = ctx.createBuffer(2, t[0].length, SR); b.copyToChannel(t[0], 0); b.copyToChannel(t[1], 1);
  samples.add('s1', b);
  const p = createProject(); p.bpm = 120; p.samples.push(meta('s1', 4));
  edit(p, samples);
  const r = await renderOffline(p, samples, { startBeat: 0, endBeat, tail, sampleRate: SR });
  return r;
}

(window as any).gate2 = async () => {
  const out: any = {};
  // Plain clip (bypass)
  let r = await scenario((p) => { p.clips.push(createAudioClip(p.samples[0], p.tracks[0].id, 0, 120)); }, 12);
  out.plain = { f: freqOf(r.channels[0], SR, 3 * SR), span: activeSpan(r.channels[0]) };
  // +3 semitones, duration preserved
  r = await scenario((p) => { p.clips.push(normalizeClip({ ...createAudioClip(p.samples[0], p.tracks[0].id, 0, 120), semitones: 3 }, 120)); }, 12);
  out.up3 = { f: freqOf(r.channels[0], SR, 3 * SR), span: activeSpan(r.channels[0]) };
  // stretched to 6 s, pitch preserved
  r = await scenario((p) => { p.clips.push(normalizeClip({ ...createAudioClip(p.samples[0], p.tracks[0].id, 0, 120), stretch: 1.5 }, 120)); }, 16);
  out.stretch6 = { f: freqOf(r.channels[0], SR, 4 * SR), span: activeSpan(r.channels[0]) };
  // repitch: half speed = an octave down, 8 s
  r = await scenario((p) => { p.clips.push(normalizeClip({ ...createAudioClip(p.samples[0], p.tracks[0].id, 0, 120), stretch: 2, repitch: true }, 120)); }, 20);
  out.repitch = { f: freqOf(r.channels[0], SR, 6 * SR), span: activeSpan(r.channels[0]) };
  // clip starting at beat 4 (2 s), stretched — alignment of the onset
  r = await scenario((p) => { p.clips.push(normalizeClip({ ...createAudioClip(p.samples[0], p.tracks[0].id, 4, 120), semitones: -5 }, 120)); }, 16);
  out.offsetStart = { span: activeSpan(r.channels[0]) };
  // tracker: an instrument note at beat 2, an octave up
  r = await scenario((p) => {
    const ins = createInstrument(p.samples[0]); ins.env.release = 0.01; p.instruments.push(ins);
    let pat = createPattern('A', 16, 4, 1); pat = setCell(pat, 8, 0, { note: 72, instrumentId: ins.id }); pat = setCell(pat, 12, 0, { note: -1 });
    p.patterns.push(pat); p.clips.push(createPatternClip(pat, p.tracks[1].id, 0));
  }, 8);
  out.tracker = { f: freqOf(r.channels[0], 1.05 * SR, 1.45 * SR), span: activeSpan(r.channels[0]) };
  // reverb tail is rendered after the range
  r = await scenario((p) => { const c = createAudioClip(p.samples[0], p.tracks[0].id, 0, 120); p.clips.push(c); p.tracks[0].reverbSend = 1; }, 8, 3);
  out.tail = { length: r.channels[0].length / SR, lateEnergy: activeSpan(r.channels[0].subarray(Math.round(4.2 * SR)), 0.01).peak };
  return out;
};
(window as any).ready = true;
