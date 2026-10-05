// Tracker sampler voices built from native nodes, scheduled sample-accurately
// on the audio clock: source ─► filter ─► envelope ─► pan ─► destination (+ sends).
import type { FxCode, Instrument } from '../model/types';
import { dbToGain } from '../model/timing';

export interface VoiceTargets {
  out: AudioNode;
  delay?: AudioNode;
  reverb?: AudioNode;
}

export interface VoiceParams {
  instrument: Instrument;
  buffer: AudioBuffer;
  reversedBuffer?: () => AudioBuffer | undefined;
  note: number;
  vel: number; // 0..1
  start: number; // ctx time
  end: number; // ctx time of note-off
  fx?: FxCode;
  fxValue?: number;
}

export interface Voice {
  setFx(fx: FxCode, value: number, at: number): void;
  release(at: number): void;
  stopNow(): void;
  readonly endTime: number;
}

/** 00..FF → 40 Hz .. 20 kHz, exponential. */
export const fxCutoff = (v: number) => 40 * Math.pow(500, v / 255);
/** 00..FF → −1 .. +1 with 80 at centre. */
export const fxPan = (v: number) => Math.max(-1, Math.min(1, (v - 0x80) / 0x7f));

export function startVoice(ctx: BaseAudioContext, targets: VoiceTargets, p: VoiceParams): Voice {
  const ins = p.instrument;
  const reverse = p.fx === 'R' && (p.fxValue ?? 0) > 0;
  const buffer = (reverse && p.reversedBuffer?.()) || p.buffer;
  const dur = buffer.duration;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = Math.pow(2, (p.note - ins.rootNote + ins.fineTune / 100) / 12);

  // Region in buffer time (mirrored when reversed).
  let regionStart = Math.max(0, Math.min(dur, ins.start));
  let regionEnd = Math.max(regionStart, Math.min(dur, ins.end));
  if (reverse) [regionStart, regionEnd] = [dur - regionEnd, dur - regionStart];
  let offset = regionStart;
  if (p.fx === 'O') offset = regionStart + ((p.fxValue ?? 0) / 256) * (regionEnd - regionStart);
  if (ins.loop && ins.loopEnd > ins.loopStart && !reverse) {
    src.loop = true;
    src.loopStart = ins.loopStart;
    src.loopEnd = ins.loopEnd;
  }

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = Math.min(ins.filterCutoff, ctx.sampleRate / 2 - 100);
  filter.Q.value = ins.filterQ;
  if (p.fx === 'F') filter.frequency.value = Math.min(fxCutoff(p.fxValue ?? 255), ctx.sampleRate / 2 - 100);

  const env = ctx.createGain();
  const pan = ctx.createStereoPanner();
  if (p.fx === 'P') pan.pan.value = fxPan(p.fxValue ?? 0x80);
  src.connect(filter).connect(env).connect(pan).connect(targets.out);

  let delaySend: GainNode | null = null;
  let reverbSend: GainNode | null = null;
  const ensureSend = (kind: 'D' | 'V') => {
    const target = kind === 'D' ? targets.delay : targets.reverb;
    if (!target) return null;
    if (kind === 'D' && !delaySend) {
      delaySend = ctx.createGain();
      delaySend.gain.value = 0;
      pan.connect(delaySend).connect(target);
    }
    if (kind === 'V' && !reverbSend) {
      reverbSend = ctx.createGain();
      reverbSend.gain.value = 0;
      pan.connect(reverbSend).connect(target);
    }
    return kind === 'D' ? delaySend : reverbSend;
  };
  if (p.fx === 'D' || p.fx === 'V') {
    const g = ensureSend(p.fx);
    if (g) g.gain.value = (p.fxValue ?? 0) / 255;
  }

  // ADSR
  const peak = p.vel * dbToGain(ins.gainDb);
  const { attack, decay, sustain, release } = ins.env;
  const a = Math.max(0.001, attack);
  const t0 = p.start;
  const g = env.gain;
  g.setValueAtTime(0, t0);
  g.linearRampToValueAtTime(peak, t0 + a);
  g.setTargetAtTime(peak * sustain, t0 + a, Math.max(0.001, decay) / 4);

  // Without a loop the voice cannot outlast its region.
  const rate = src.playbackRate.value;
  const naturalEnd = src.loop ? Infinity : t0 + (regionEnd - offset) / rate;
  src.start(t0, Math.min(offset, Math.max(0, dur - 1e-4)));

  let endTime = Math.min(naturalEnd, p.end + Math.max(0.005, release));
  let released = false;
  const doRelease = (at: number) => {
    if (released) return;
    released = true;
    const r = Math.max(0.005, release);
    const at2 = Math.max(at, t0 + 0.001);
    g.cancelScheduledValues(at2);
    // setTargetAtTime from the current value; reaches ~0 after 5 time constants.
    g.setTargetAtTime(0, at2, r / 5);
    endTime = Math.min(naturalEnd, at2 + r);
    try {
      src.stop(endTime + 0.01);
    } catch {
      /* already stopped */
    }
  };
  doRelease(p.end);

  src.onended = () => {
    try {
      pan.disconnect();
    } catch {
      /* ignore */
    }
  };

  return {
    get endTime() {
      return endTime;
    },
    setFx(fx, value, at) {
      if (fx === 'P') pan.pan.setTargetAtTime(fxPan(value), at, 0.005);
      else if (fx === 'F') filter.frequency.setTargetAtTime(Math.min(fxCutoff(value), ctx.sampleRate / 2 - 100), at, 0.005);
      else if (fx === 'D' || fx === 'V') ensureSend(fx)?.gain.setTargetAtTime(value / 255, at, 0.005);
    },
    release(at) {
      released = false;
      doRelease(at);
    },
    stopNow() {
      const now = ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(0, now, 0.004);
      try {
        src.stop(now + 0.03);
      } catch {
        /* ignore */
      }
    },
  };
}
