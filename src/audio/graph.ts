// Mixer graph: track strips → master, shared delay/reverb, and separate
// routes for the metronome/audition and input monitoring (never captured).
//
//   clip/voice ─► strip.input ─► lowpass ─► volume ─► pan ─► post ─► mute ─┬─► master.in
//                                                          (track capture) ├─► delay send
//                                                                          └─► reverb send
//   master.in + fx returns ─► master.volume ─► master.out (master capture, meter) ─► destination
//   metronome / audition ─► cue ─► destination
//   input ─► inputGain ─► monitor (off by default) ─► destination
import type { FxSettings, Project, Track } from '../model/types';
import { audibleTracks } from '../model/playback';
import { beatsToSec, dbToGain } from '../model/timing';

const SMOOTH = 0.015;

export interface Strip {
  id: string;
  input: GainNode;
  lowpass: BiquadFilterNode;
  volume: GainNode;
  pan: StereoPannerNode;
  post: GainNode;
  mute: GainNode;
  delaySend: GainNode;
  reverbSend: GainNode;
  analyser?: AnalyserNode;
}

function set(param: AudioParam, value: number, ctx: BaseAudioContext, immediate = false) {
  if (!Number.isFinite(value)) return;
  if (immediate || !(ctx instanceof AudioContext)) {
    param.cancelScheduledValues(0);
    param.value = value;
  } else {
    param.cancelScheduledValues(ctx.currentTime);
    param.setTargetAtTime(value, ctx.currentTime, SMOOTH);
  }
}

export class MixerGraph {
  readonly strips = new Map<string, Strip>();
  readonly masterIn: GainNode;
  readonly masterVolume: GainNode;
  readonly masterOut: GainNode;
  readonly masterAnalysers: [AnalyserNode, AnalyserNode] | null;
  readonly delayIn: GainNode;
  readonly reverbIn: GainNode;
  readonly cue: GainNode;
  private delay: DelayNode;
  private delayFeedback: GainNode;
  private delayTone: BiquadFilterNode;
  private delayReturn: GainNode;
  private reverbPre: DelayNode;
  private convolver: ConvolverNode;
  private reverbReturn: GainNode;
  private reverbKey = '';
  private first = true;

  constructor(readonly ctx: BaseAudioContext, readonly metering: boolean) {
    this.masterIn = ctx.createGain();
    this.masterVolume = ctx.createGain();
    this.masterOut = ctx.createGain();
    this.masterIn.connect(this.masterVolume).connect(this.masterOut).connect(ctx.destination);
    if (metering) {
      const split = ctx.createChannelSplitter(2);
      const l = ctx.createAnalyser(), r = ctx.createAnalyser();
      l.fftSize = r.fftSize = 2048;
      this.masterOut.connect(split);
      split.connect(l, 0);
      split.connect(r, 1);
      this.masterAnalysers = [l, r];
    } else this.masterAnalysers = null;

    // Delay: feedback loop with a tone filter.
    this.delayIn = ctx.createGain();
    this.delay = ctx.createDelay(4);
    this.delayFeedback = ctx.createGain();
    this.delayTone = ctx.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayReturn = ctx.createGain();
    this.delayIn.connect(this.delay);
    this.delay.connect(this.delayTone);
    this.delayTone.connect(this.delayFeedback).connect(this.delay);
    this.delayTone.connect(this.delayReturn).connect(this.masterIn);

    // Reverb: pre-delay into a generated stereo impulse.
    this.reverbIn = ctx.createGain();
    this.reverbPre = ctx.createDelay(0.5);
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = false;
    this.reverbReturn = ctx.createGain();
    this.reverbIn.connect(this.reverbPre).connect(this.convolver).connect(this.reverbReturn).connect(this.masterIn);

    this.cue = ctx.createGain();
    this.cue.connect(ctx.destination);
  }

  private createStrip(t: Track): Strip {
    const ctx = this.ctx;
    const s: Strip = {
      id: t.id,
      input: ctx.createGain(),
      lowpass: ctx.createBiquadFilter(),
      volume: ctx.createGain(),
      pan: ctx.createStereoPanner(),
      post: ctx.createGain(),
      mute: ctx.createGain(),
      delaySend: ctx.createGain(),
      reverbSend: ctx.createGain(),
    };
    s.lowpass.type = 'lowpass';
    s.lowpass.Q.value = 0.707;
    s.input.connect(s.lowpass).connect(s.volume).connect(s.pan).connect(s.post).connect(s.mute);
    s.mute.connect(this.masterIn);
    s.mute.connect(s.delaySend).connect(this.delayIn);
    s.mute.connect(s.reverbSend).connect(this.reverbIn);
    if (this.metering) {
      s.analyser = ctx.createAnalyser();
      s.analyser.fftSize = 1024;
      s.post.connect(s.analyser);
    }
    this.strips.set(t.id, s);
    return s;
  }

  strip(id: string): Strip | undefined {
    return this.strips.get(id);
  }

  /** Bring the graph in line with the project (tracks, levels, fx). Cheap to call often. */
  sync(p: Project) {
    const immediate = this.first;
    this.first = false;
    const ids = new Set(p.tracks.map((t) => t.id));
    for (const [id, s] of this.strips) {
      if (!ids.has(id)) {
        s.mute.disconnect();
        this.strips.delete(id);
      }
    }
    const audible = audibleTracks(p);
    for (const t of p.tracks) {
      const im = immediate || !this.strips.has(t.id);
      const s = this.strips.get(t.id) ?? this.createStrip(t);
      set(s.lowpass.frequency, Math.min(t.lowpass, this.ctx.sampleRate / 2 - 100), this.ctx, im);
      set(s.volume.gain, dbToGain(t.volumeDb), this.ctx, im);
      set(s.pan.pan, t.pan, this.ctx, im);
      set(s.mute.gain, audible.has(t.id) ? 1 : 0, this.ctx, im);
      set(s.delaySend.gain, t.delaySend, this.ctx, im);
      set(s.reverbSend.gain, t.reverbSend, this.ctx, im);
    }
    set(this.masterVolume.gain, dbToGain(p.masterDb), this.ctx, immediate);
    this.syncFx(p.fx, p.bpm, immediate);
  }

  private syncFx(fx: FxSettings, bpm: number, immediate: boolean) {
    set(this.delay.delayTime, Math.min(3.9, beatsToSec(fx.delayBeats, bpm)), this.ctx, immediate);
    set(this.delayFeedback.gain, Math.min(0.95, fx.delayFeedback), this.ctx, immediate);
    set(this.delayTone.frequency, fx.delayTone, this.ctx, immediate);
    set(this.delayReturn.gain, fx.delayReturn, this.ctx, immediate);
    set(this.reverbPre.delayTime, fx.reverbPreDelayMs / 1000, this.ctx, immediate);
    set(this.reverbReturn.gain, fx.reverbReturn, this.ctx, immediate);
    const key = fx.reverbSeconds.toFixed(2);
    if (key !== this.reverbKey) {
      this.reverbKey = key;
      this.convolver.buffer = makeImpulse(this.ctx, fx.reverbSeconds);
    }
  }

  /** Longest tail the shared effects can produce, for export. */
  tailHint(p: Project) {
    const fb = Math.min(0.95, p.fx.delayFeedback);
    const delayTail = fb > 0 ? (beatsToSec(p.fx.delayBeats, p.bpm) * Math.log(0.001)) / Math.log(fb) : 0;
    return Math.max(p.fx.reverbSeconds, delayTail);
  }
}

/** Deterministic decaying-noise impulse; the tail darkens as it decays. */
export function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * Math.max(0.1, seconds)));
  const b = ctx.createBuffer(2, len, sr);
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };
  const decay = Math.log(1000) / (seconds * sr); // −60 dB at `seconds`
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const coeff = 0.15 + 0.8 * t; // more smoothing later in the tail
      lp += (rnd() - lp) * (1 - coeff);
      const env = Math.exp(-decay * i) * (i < sr * 0.004 ? i / (sr * 0.004) : 1);
      d[i] = lp * env;
    }
    // Unit energy, then −6 dB: a full send sits comfortably under the dry signal.
    let energy = 0;
    for (let i = 0; i < len; i++) energy += d[i] * d[i];
    const k = 0.5 / Math.sqrt(energy || 1);
    for (let i = 0; i < len; i++) d[i] *= k;
  }
  return b;
}

/** Peak level of an analyser's current block. */
export function analyserPeak(a: AnalyserNode, scratch: Float32Array<ArrayBuffer>): number {
  a.getFloatTimeDomainData(scratch);
  let peak = 0;
  for (let i = 0; i < scratch.length; i++) {
    const v = Math.abs(scratch[i]);
    if (v > peak) peak = v;
  }
  return peak;
}
