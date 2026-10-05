// The audio engine: transport, look-ahead scheduler, clip playback and tracker
// voices. The same class renders offline for export, so playback and export
// share scheduling, DSP and effects.
import type { AudioClip, Clip, Instrument, PatternClip, Project } from '../model/types';
import { EPS, beatsToSec, clipEnd, dbToGain, secToBeats } from '../model/timing';
import { planAudio, clipsToStart, type AudioPlan } from '../model/playback';
import { effectiveFades } from '../model/clips';
import { clipEventsInRange, patternEvents, type NoteEvent } from '../model/tracker';
import { MixerGraph, analyserPeak } from './graph';
import { StretchPool, type StretchNode } from './stretchPool';
import { startVoice, type Voice } from './voices';
import type { SampleRegistry } from './samples';

export interface EngineHost {
  project(): Project;
  samples: SampleRegistry;
}

interface Anchor {
  time: number; // ctx time
  beat: number;
  bpm: number;
}

interface Occurrence {
  clipId: string;
  sig: string;
  pitchSig: string;
  anchor: Anchor;
  until: number; // segment bound (loop end) in beats
  beat0: number;
  beat1: number;
  t0: number;
  t1: number;
  fade: GainNode;
  clipGain: GainNode;
  declick: GainNode;
  src?: AudioBufferSourceNode;
  stretch?: StretchNode;
  stretchPending?: boolean;
  /** Resolves once the stretch node has its schedule (offline export waits for it). */
  ready?: Promise<unknown>;
  stopped: boolean;
}

interface VoiceRec {
  key: string; // clipId:col
  clipId: string;
  clipSig: string;
  voice: Voice;
  start: number;
}

export interface Meters {
  master: [number, number];
  tracks: Record<string, number>;
}

const BASE_LEAD = 0.05;
const TICK_MS = 25;
const DECLICK = 0.004;

/** What makes an audio clip's playback different (gain is handled separately). */
function audioSig(c: AudioClip, p: Project) {
  const { gainDb: _g, name: _n, ...rest } = c;
  return JSON.stringify([rest, effectiveFades(c, p.clips), p.bpm]);
}
/** The same, ignoring pitch: equal pitch-only sigs mean a glide is enough. */
function pitchOnlySig(c: AudioClip, p: Project) {
  const { gainDb: _g, name: _n, semitones: _s, cents: _c, ...rest } = c;
  return JSON.stringify([rest, effectiveFades(c, p.clips), p.bpm]);
}
function patternClipSig(c: PatternClip) {
  return `${c.trackId}|${c.start}|${c.length}|${c.offset}|${c.patternId}`;
}

export class AudioEngine {
  readonly graph: MixerGraph;
  readonly pool: StretchPool;
  readonly realtime: boolean;

  playing = false;
  metronome = false;
  /** Metronome always clicks before this beat (count-in). */
  countInUntil = -Infinity;

  private anchors: Anchor[] = [];
  private cursor = 0;
  private fresh = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private occs: Occurrence[] = [];
  private voices: VoiceRec[] = [];
  private lastLoopKey = '';
  private lastBpm = 0;
  private stretchInUse = false;
  private scratch = new Float32Array(2048);
  private auditionSrc: AudioBufferSourceNode | null = null;
  private listeners = new Set<(playing: boolean) => void>();

  constructor(readonly ctx: BaseAudioContext, readonly host: EngineHost) {
    this.realtime = typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
    this.graph = new MixerGraph(ctx, this.realtime);
    this.pool = new StretchPool(ctx);
  }

  onPlayState(fn: (playing: boolean) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((l) => l(this.playing));
  }

  // ── Timing ────────────────────────────────────────────────────────────

  get lead() {
    return BASE_LEAD + (this.stretchInUse ? this.pool.latency : 0);
  }

  private timeOf(beat: number, a: Anchor = this.anchors[this.anchors.length - 1]) {
    return a.time + beatsToSec(beat - a.beat, a.bpm);
  }

  private anchorAt(t: number): Anchor {
    let a = this.anchors[0];
    for (const x of this.anchors) if (x.time <= t + 1e-9) a = x;
    return a;
  }

  /** Beat at a context time (following loop wraps). */
  beatAtTime(t: number): number {
    if (!this.anchors.length) return 0;
    const a = this.anchorAt(t);
    return a.beat + secToBeats(t - a.time, a.bpm);
  }

  /** Beat currently heard, compensating output latency. */
  position(): number {
    const ctx = this.ctx as AudioContext;
    const lat = this.realtime ? (ctx.outputLatency || 0) + (ctx.baseLatency || 0) : 0;
    return this.beatAtTime(this.ctx.currentTime - lat);
  }

  // ── Transport ─────────────────────────────────────────────────────────

  /** Create stretch nodes ahead of playback for every clip that needs one. */
  async prepare() {
    const p = this.host.project();
    const stretched = p.clips.filter((c): c is AudioClip => c.kind === 'audio' && isStretched(c, p.bpm));
    this.stretchInUse = stretched.length > 0;
    if (!stretched.length) return;
    await this.pool.ensure(Math.min(32, maxConcurrent(stretched) + 2));
  }

  /** Start playing at `fromBeat`. Resolves with the context time at which that beat sounds. */
  async play(fromBeat: number): Promise<number> {
    if (this.playing) this.halt();
    if (this.realtime && this.ctx.state === 'suspended') await (this.ctx as AudioContext).resume();
    await this.prepare();
    const p = this.host.project();
    this.graph.sync(p);
    const time = this.ctx.currentTime + this.lead;
    this.anchors = [{ time, beat: fromBeat, bpm: p.bpm }];
    this.cursor = fromBeat;
    this.fresh = true;
    this.playing = true;
    this.lastBpm = p.bpm;
    this.lastLoopKey = loopKey(p);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
    this.emit();
    return time;
  }

  stop() {
    if (!this.playing) return;
    this.halt();
    this.countInUntil = -Infinity;
    this.emit();
  }

  private halt() {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const now = this.ctx.currentTime;
    for (const o of this.occs) this.stopOcc(o, now);
    for (const v of this.voices) v.voice.stopNow();
    this.voices = [];
    setTimeout(() => this.cleanup(true), 400);
  }

  private tick() {
    if (!this.playing) return;
    const p = this.host.project();
    const horizon = this.ctx.currentTime + this.lead + 0.12;
    let guard = 0;
    while (this.playing && this.timeOf(this.cursor) < horizon && guard++ < 64) {
      const loop = p.loop;
      const looping = loop.enabled && loop.end - loop.start > 1 / 16 && this.cursor < loop.end - EPS;
      const segEnd = looping ? loop.end : Infinity;
      const a = this.anchors[this.anchors.length - 1];
      const hBeat = a.beat + secToBeats(horizon - a.time, a.bpm);
      const b1 = Math.min(segEnd, Math.max(hBeat, this.cursor + 1 / 64));
      this.scheduleWindow(p, this.cursor, b1, this.fresh, segEnd);
      this.fresh = false;
      this.cursor = b1;
      if (looping && b1 >= segEnd - EPS) {
        const t = this.timeOf(segEnd);
        this.anchors.push({ time: t, beat: loop.start, bpm: p.bpm });
        this.cursor = loop.start;
        this.fresh = true;
      }
    }
    // Forget anchors that can no longer be referenced.
    const now = this.ctx.currentTime;
    while (this.anchors.length > 2 && this.anchors[1].time < now - 2) this.anchors.shift();
    this.cleanup(false);
  }

  private scheduleWindow(p: Project, b0: number, b1: number, fresh: boolean, until: number) {
    const audio = p.clips.filter((c): c is AudioClip => c.kind === 'audio');
    for (const c of clipsToStart(audio, b0, b1, fresh) as AudioClip[]) {
      const plan = planAudio(c, p.clips, p.bpm, b0, until);
      if (plan) this.startOcc(plan, p, this.anchors[this.anchors.length - 1], until);
    }
    for (const c of p.clips) {
      if (c.kind !== 'pattern' || c.start >= b1 || clipEnd(c) <= b0) continue;
      this.schedulePattern(p, c, b0, b1, until, this.anchors[this.anchors.length - 1]);
    }
    if (this.metronome || b0 < this.countInUntil) {
      for (let b = Math.ceil(b0 - EPS); b < b1 - EPS; b++) {
        if (this.metronome || b < this.countInUntil) this.click(this.timeOf(b), mod4(b) === 0);
      }
    }
  }

  // ── Audio clips ───────────────────────────────────────────────────────

  private startOcc(plan: AudioPlan, p: Project, anchor: Anchor, until: number, preassigned?: StretchNode): Occurrence | null {
    const c = plan.clip;
    const strip = this.graph.strip(c.trackId);
    const sample = this.host.samples.get(c.sampleId);
    if (!strip || !sample) return null;
    const ctx = this.ctx;
    const t0 = this.timeOf(plan.beat, anchor);
    const t1 = this.timeOf(plan.endBeat, anchor);
    if (t1 <= t0) return null;

    const fade = ctx.createGain();
    const clipGain = ctx.createGain();
    const declick = ctx.createGain();
    clipGain.gain.value = dbToGain(c.gainDb);
    fade.connect(clipGain).connect(declick).connect(strip.input);

    // Fades and crossfades (equal power), in context time.
    let lastEnd = -Infinity;
    const minStep = 2 / ctx.sampleRate;
    for (const s of plan.gain) {
      const at = Math.max(t0, this.timeOf(c.start + s.at, anchor));
      if (s.type === 'set') {
        fade.gain.setValueAtTime(s.value, at);
        lastEnd = at;
      } else {
        const start = Math.max(at, lastEnd + minStep);
        const dur = beatsToSec(s.dur, anchor.bpm) - (start - at);
        if (dur > minStep) {
          fade.gain.setValueCurveAtTime(s.values, start, dur);
          lastEnd = start + dur;
        }
      }
    }
    // De-click cuts that land mid-clip (seek, loop wrap).
    declick.gain.setValueAtTime(plan.local > EPS ? 0 : 1, t0);
    if (plan.local > EPS) declick.gain.linearRampToValueAtTime(1, t0 + DECLICK);
    if (plan.endBeat < clipEnd(c) - EPS && t1 - DECLICK > t0 + DECLICK) {
      declick.gain.setValueAtTime(1, t1 - DECLICK);
      declick.gain.linearRampToValueAtTime(0, t1);
    }

    const occ: Occurrence = {
      clipId: c.id,
      sig: audioSig(c, p),
      pitchSig: pitchOnlySig(c, p),
      anchor,
      until,
      beat0: plan.beat,
      beat1: plan.endBeat,
      t0,
      t1,
      fade,
      clipGain,
      declick,
      stopped: false,
    };
    this.occs.push(occ);

    if (plan.stretch && preassigned) {
      occ.ready = this.startStretch(occ, preassigned, plan);
    } else if (plan.stretch) {
      this.stretchInUse = true;
      const node = this.pool.tryAcquire(c.sampleId, sample.buffer, ctx.currentTime);
      if (node) this.startStretch(occ, node, plan);
      else {
        // Pool exhausted: create a node, then join late if needed.
        occ.stretchPending = true;
        this.pool.acquire(c.sampleId, sample.buffer, ctx.currentTime).then((n) => {
          occ.stretchPending = false;
          if (occ.stopped) {
            this.pool.release(n, ctx.currentTime);
            return;
          }
          const lateBy = ctx.currentTime + this.lead - occ.t0;
          if (lateBy > 0) {
            const b = Math.min(occ.beat1, occ.beat0 + secToBeats(lateBy, anchor.bpm));
            const late = planAudio(c, this.host.project().clips, anchor.bpm, b, occ.until);
            if (!late) return this.pool.release(n, ctx.currentTime);
            occ.t0 = this.timeOf(late.beat, anchor);
            this.startStretch(occ, n, late);
          } else this.startStretch(occ, n, plan);
        });
      }
    } else {
      const src = ctx.createBufferSource();
      src.buffer = sample.buffer;
      src.playbackRate.value = c.repitch ? plan.rate : 1;
      if (c.loop) {
        src.loop = true;
        src.loopStart = c.srcStart;
        src.loopEnd = c.srcEnd;
      }
      src.connect(fade);
      src.start(t0, Math.min(plan.srcPos, sample.buffer.duration));
      src.stop(t1 + 0.01);
      occ.src = src;
    }
    return occ;
  }

  private startStretch(occ: Occurrence, node: StretchNode, plan: AudioPlan): Promise<unknown> {
    const c = plan.clip;
    node.connect(occ.fade);
    occ.stretch = node;
    const a = node.schedule({
      output: occ.t0,
      active: true,
      input: plan.srcPos,
      rate: plan.rate,
      semitones: plan.semitones,
      loopStart: c.loop ? c.srcStart : 0,
      loopEnd: c.loop ? c.srcEnd : 0,
    });
    const b = node.schedule({ output: occ.t1 + 0.01, active: false });
    return Promise.all([a, b]);
  }

  private stopOcc(o: Occurrence, at: number) {
    if (o.stopped) return;
    o.stopped = true;
    const now = this.ctx.currentTime;
    at = Math.max(at, now);
    if (at >= o.t1) return;
    const end = at + 0.02;
    o.declick.gain.cancelScheduledValues(at);
    o.declick.gain.setTargetAtTime(0, at, DECLICK);
    if (o.src) {
      try {
        o.src.stop(at < o.t0 ? at : end);
      } catch {
        /* ignore */
      }
    }
    if (o.stretch) o.stretch.schedule({ output: at < o.t0 ? Math.max(now, at) : end, active: false });
    o.t1 = Math.min(o.t1, end);
  }

  private cleanup(all: boolean) {
    const now = this.ctx.currentTime;
    const tail = this.pool.latency + 0.1;
    this.occs = this.occs.filter((o) => {
      const done = all ? o.stopped || now > o.t1 + tail : now > o.t1 + tail;
      if (!done || o.stretchPending) return true;
      try {
        o.declick.disconnect();
      } catch {
        /* ignore */
      }
      if (o.stretch) this.pool.release(o.stretch, now);
      return false;
    });
    this.voices = this.voices.filter((v) => v.voice.endTime > now);
  }

  // ── Tracker ───────────────────────────────────────────────────────────

  private schedulePattern(p: Project, c: PatternClip, b0: number, b1: number, until: number, anchor: Anchor) {
    const pattern = p.patterns.find((x) => x.id === c.patternId);
    const strip = this.graph.strip(c.trackId);
    if (!pattern || !strip) return;
    const events = patternEvents(pattern);
    for (const pe of clipEventsInRange(c, pattern, events, b0, b1)) {
      const key = `${c.id}:${pe.event.col}`;
      const t = this.timeOf(pe.beat, anchor);
      if (pe.event.kind === 'fx') {
        const v = [...this.voices].reverse().find((x) => x.key === key && x.start <= t + 1e-6);
        v?.voice.setFx(pe.event.fx, pe.event.fxValue, t);
        continue;
      }
      const e = pe.event as NoteEvent;
      const ins = p.instruments.find((i) => i.id === e.instrumentId) ?? (e.instrumentId ? undefined : p.instruments[0]);
      if (!ins) continue;
      const sample = this.host.samples.get(ins.sampleId);
      if (!sample) continue;
      const end = this.timeOf(Math.min(pe.end, until), anchor);
      if (end <= t) continue;
      const voice = startVoice(
        this.ctx,
        { out: strip.input, delay: this.graph.delayIn, reverb: this.graph.reverbIn },
        {
          instrument: ins,
          buffer: sample.buffer,
          reversedBuffer: () => this.host.samples.reversed(ins.sampleId),
          note: e.note,
          vel: e.vel,
          start: t,
          end,
          fx: e.fx,
          fxValue: e.fxValue,
        },
      );
      this.voices.push({ key, clipId: c.id, clipSig: patternClipSig(c), voice, start: t });
    }
  }

  // ── Live edits ────────────────────────────────────────────────────────

  /** Apply project changes to the graph and to anything already scheduled. */
  sync(p: Project) {
    this.graph.sync(p);
    if (!this.playing) return;
    if (p.bpm !== this.lastBpm || loopKey(p) !== this.lastLoopKey) {
      const beat = this.beatAtTime(this.ctx.currentTime + BASE_LEAD);
      this.lastBpm = p.bpm;
      this.lastLoopKey = loopKey(p);
      void this.play(beat);
      return;
    }
    const now = this.ctx.currentTime;
    const t = now + this.lead;
    const byId = new Map<string, Clip>(p.clips.map((c) => [c.id, c]));

    // Stretched clips added mid-play need nodes soon.
    const stretched = p.clips.filter((c): c is AudioClip => c.kind === 'audio' && isStretched(c, p.bpm));
    if (stretched.length) {
      this.stretchInUse = true;
      void this.pool.ensure(Math.min(32, maxConcurrent(stretched) + 2));
    }

    for (const o of this.occs) {
      if (o.stopped || o.t1 <= t) continue;
      const c = byId.get(o.clipId);
      if (!c || c.kind !== 'audio') {
        this.stopOcc(o, now + 0.005);
        continue;
      }
      o.clipGain.gain.setTargetAtTime(dbToGain(c.gainDb), now, 0.015);
      const sig = audioSig(c, p);
      if (sig === o.sig) continue;
      if (o.stretch && isStretched(c, p.bpm) && pitchOnlySig(c, p) === o.pitchSig) {
        // Pitch-only change: glide the processor, keep everything else.
        const plan = planAudio(c, p.clips, p.bpm, o.beat0, o.until)!;
        o.stretch.schedule({ output: Math.max(o.t0, t), semitones: plan.semitones });
        o.stretch.schedule({ output: o.t1 + 0.01, active: false });
        o.sig = sig;
        continue;
      }
      // Anything else: cut this occurrence; the pass below restarts it with the new settings.
      this.stopOcc(o, Math.max(o.t0, t));
    }

    // Clips that should be sounding in already-scheduled time but have no live
    // occurrence (new, moved or changed clips). Covers the current pass and,
    // after a scheduled loop wrap, the next one.
    const a = this.anchorAt(t);
    const from = this.anchors.indexOf(a);
    for (let i = from; i < this.anchors.length; i++) {
      const A = this.anchors[i];
      const isLast = i === this.anchors.length - 1;
      const startBeat = i === from ? Math.max(A.beat, A.beat + secToBeats(t - A.time, A.bpm)) : A.beat;
      const bound = isLast ? this.cursor : p.loop.end;
      const until = p.loop.enabled && A.beat < p.loop.end ? p.loop.end : Infinity;
      for (const c of p.clips) {
        if (c.kind !== 'audio') continue;
        if (c.start >= bound - EPS || clipEnd(c) <= startBeat + EPS) continue;
        const live = this.occs.some((o) => o.clipId === c.id && !o.stopped && o.t1 > t && o.anchor === A);
        if (live) continue;
        const plan = planAudio(c, p.clips, p.bpm, startBeat, until);
        if (plan) this.startOcc(plan, p, A, until);
      }
    }

    // Tracker voices whose clip moved or vanished stop now.
    const pcs = new Map(p.clips.filter((c): c is PatternClip => c.kind === 'pattern').map((c) => [c.id, patternClipSig(c)]));
    for (const v of this.voices) {
      if (pcs.get(v.clipId) !== v.clipSig && v.voice.endTime > now) v.voice.stopNow();
    }
  }

  // ── Metronome, audition, meters ───────────────────────────────────────

  private click(t: number, accent: boolean) {
    if (!this.realtime) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.32, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(g).connect(this.graph.cue);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  async auditionSample(id: string, from = 0, to?: number) {
    this.stopAudition();
    const s = this.host.samples.get(id);
    if (!s) return;
    if (this.realtime && this.ctx.state === 'suspended') await (this.ctx as AudioContext).resume();
    const src = this.ctx.createBufferSource();
    src.buffer = s.buffer;
    src.connect(this.graph.cue);
    const t = this.ctx.currentTime + 0.01;
    src.start(t, from, to !== undefined ? Math.max(0.001, to - from) : undefined);
    src.onended = () => {
      if (this.auditionSrc === src) this.auditionSrc = null;
    };
    this.auditionSrc = src;
  }

  stopAudition() {
    try {
      this.auditionSrc?.stop();
    } catch {
      /* ignore */
    }
    this.auditionSrc = null;
  }

  /** Play an instrument note on the cue route (never captured). Returns a release function. */
  auditionNote(ins: Instrument, note: number, vel = 1): () => void {
    const s = this.host.samples.get(ins.sampleId);
    if (!s) return () => {};
    if (this.realtime && this.ctx.state === 'suspended') void (this.ctx as AudioContext).resume();
    const t = this.ctx.currentTime + 0.005;
    const v = startVoice(
      this.ctx,
      { out: this.graph.cue },
      { instrument: ins, buffer: s.buffer, note, vel, start: t, end: t + 30 },
    );
    return () => v.release(this.ctx.currentTime);
  }

  meters(): Meters {
    const m = this.graph.masterAnalysers;
    const master: [number, number] = m ? [analyserPeak(m[0], this.scratch), analyserPeak(m[1], this.scratch)] : [0, 0];
    const tracks: Record<string, number> = {};
    const s1024 = this.scratch.subarray(0, 1024) as Float32Array<ArrayBuffer>;
    for (const [id, s] of this.graph.strips) if (s.analyser) tracks[id] = analyserPeak(s.analyser, s1024);
    return { master, tracks };
  }

  // ── Offline (export) ──────────────────────────────────────────────────

  /**
   * Schedule [startBeat, endBeat) for offline rendering, starting at context time `at`.
   * Waits until every stretch node has received its schedule.
   */
  async scheduleOffline(startBeat: number, endBeat: number, at: number) {
    const p = this.host.project();
    this.graph.sync(p);
    const anchor: Anchor = { time: at, beat: startBeat, bpm: p.bpm };
    this.anchors = [anchor];
    const audio = p.clips.filter((c): c is AudioClip => c.kind === 'audio');
    const pending: Promise<unknown>[] = [];
    for (const c of clipsToStart(audio, startBeat, endBeat, true) as AudioClip[]) {
      const plan = planAudio(c, p.clips, p.bpm, startBeat, endBeat);
      if (!plan) continue;
      if (plan.stretch) {
        const sample = this.host.samples.get(c.sampleId);
        if (!sample) continue;
        // Offline nodes are one-shot: one per clip, never returned to the pool.
        const node = await this.pool.acquire(c.sampleId, sample.buffer, 0);
        const occ = this.startOcc(plan, p, anchor, endBeat, node);
        if (occ?.ready) pending.push(occ.ready);
      } else this.startOcc(plan, p, anchor, endBeat);
    }
    for (const c of p.clips) {
      if (c.kind !== 'pattern' || c.start >= endBeat || clipEnd(c) <= startBeat) continue;
      this.schedulePattern(p, c, startBeat, endBeat, endBeat, anchor);
    }
    await Promise.all(pending);
  }

  dispose() {
    this.halt();
    this.pool.dispose();
  }
}

function isStretched(c: AudioClip, bpm: number) {
  const rate = c.timing === 'tempo' ? bpm / c.sourceBpm : 1 / c.stretch;
  return !c.repitch && (Math.abs(rate - 1) > 1e-6 || Math.abs(c.semitones + c.cents / 100) > 1e-6);
}

/** Most stretched clips sounding at once (sweep over start/end points). */
function maxConcurrent(clips: Clip[]) {
  const pts: [number, number][] = [];
  for (const c of clips) pts.push([c.start, 1], [clipEnd(c), -1]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0, m = 0;
  for (const [, d] of pts) m = Math.max(m, (n += d));
  return m;
}

function loopKey(p: Project) {
  return p.loop.enabled ? `${p.loop.start}-${p.loop.end}` : 'off';
}

function mod4(b: number) {
  return ((b % 4) + 4) % 4;
}
