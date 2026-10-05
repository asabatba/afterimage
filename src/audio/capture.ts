// Recording and internal resampling ("Print").
//   input  → raw device input (monitoring is a separate, optional route)
//   track  → strip.post: after track filter, volume and pan; shared effects excluded
//   master → master.out: whole mix incl. shared effects; metronome/audition excluded
import { beatsToSec, secToBeats } from '../model/timing';
import type { AudioEngine } from './engine';
import workletSource from './worklets/recorder.worklet.js?raw';
import CaptureWorker from './worklets/capture.worker.ts?worker&inline';
import { attachCollector } from './worklets/collector';

/** Start the capture worker and confirm it answers; null if workers can't run here. */
function startWorker(): Promise<Worker | null> {
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = new CaptureWorker();
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      w.terminate();
      resolve(null);
    }, 1500);
    w.onmessage = (e) => {
      if (e.data?.type === 'pong') {
        clearTimeout(timer);
        resolve(w);
      }
    };
    w.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    w.postMessage({ type: 'ping' });
  });
}

export type CaptureSource = { kind: 'input' } | { kind: 'track'; trackId: string } | { kind: 'master' };

export interface CaptureOptions {
  source: CaptureSource;
  startBeat: number;
  /** null = free length, stopped by hand. */
  endBeat: number | null;
  countInBeats: number;
  /** Input only: how late the input arrives, ms. The take is shifted earlier by this much. */
  offsetMs: number;
  mono: boolean;
}

export interface CaptureTake {
  channels: Float32Array[];
  sampleRate: number;
  startBeat: number;
  endBeat: number;
  bpm: number;
  tempoBound: boolean;
  source: CaptureSource;
}

export type CaptureStatus = 'idle' | 'count-in' | 'recording' | 'finishing';

export interface InputInfo {
  label: string;
  deviceId: string;
  settings: MediaTrackSettings;
}

export class CaptureError extends Error {
  constructor(message: string, readonly kind: 'cancelled' | 'interrupted' | 'overrun' | 'permission' | 'device') {
    super(message);
  }
}

export class CaptureManager {
  status: CaptureStatus = 'idle';
  levels: number[] = [0, 0];
  input: InputInfo | null = null;
  monitoring = false;

  private node: AudioWorkletNode | null = null;
  /** Kept so the worker is not collected while capturing. */
  worker: Worker | null = null;
  private tap: GainNode;
  private inputGain: GainNode;
  private monitorGain: GainNode;
  private stream: MediaStream | null = null;
  private streamSource: MediaStreamAudioSourceNode | null = null;
  private connected: AudioNode | null = null;
  private pending: {
    resolve: (t: CaptureTake) => void;
    reject: (e: Error) => void;
    opts: CaptureOptions;
    bpm: number;
    startFrame: number;
  } | null = null;
  private listeners = new Set<() => void>();
  private captureTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private engine: AudioEngine) {
    const ctx = engine.ctx;
    this.tap = ctx.createGain();
    this.inputGain = ctx.createGain();
    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.inputGain.connect(this.monitorGain).connect(ctx.destination);
    (ctx as AudioContext).addEventListener?.('statechange', () => {
      if (this.pending && ctx.state !== 'running') this.fail(new CaptureError('Audio was interrupted — the take was discarded.', 'interrupted'));
    });
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((l) => l());
  }

  private get ctx() {
    return this.engine.ctx as AudioContext;
  }

  private async ensureNode() {
    if (this.node) return;
    const url = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } catch {
      // Some origins (file://) refuse blob: worklet modules.
      await this.ctx.audioWorklet.addModule(`data:text/javascript;charset=utf-8,${encodeURIComponent(workletSource)}`);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(this.ctx, 'afterimage-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { channels: 2, chunkFrames: 4096, poolSize: 48 },
    });
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    this.tap.connect(node).connect(silent).connect(this.ctx.destination);
    const ch = new MessageChannel();
    node.port.postMessage({ type: 'port', port: ch.port1 }, [ch.port1]);
    node.port.onmessage = (e) => this.onWorklet(e.data);
    const worker = await startWorker();
    if (worker) {
      worker.postMessage({ type: 'port', port: ch.port2 }, [ch.port2]);
      worker.onmessage = (e) => this.onTake(e.data);
    } else {
      // Workers unavailable (e.g. opened from file://): collect on the main thread.
      attachCollector(ch.port2, (take) => this.onTake({ type: 'take', ...take }));
    }
    this.node = node;
    this.worker = worker;
  }

  // ── Input ─────────────────────────────────────────────────────────────

  static async listInputs(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  }

  /** Ask for an input. Speech processing is requested off; actual settings are reported. */
  async enableInput(deviceId?: string, stereo = true): Promise<InputInfo> {
    if (!navigator.mediaDevices?.getUserMedia) throw new CaptureError('This browser does not expose audio inputs.', 'device');
    this.disableInput();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: stereo ? 2 : 1 },
          sampleRate: { ideal: this.ctx.sampleRate },
        },
      });
    } catch (e: any) {
      throw new CaptureError(
        e?.name === 'NotAllowedError' ? 'Microphone permission was denied.' : `Could not open the input (${e?.message ?? e}).`,
        e?.name === 'NotAllowedError' ? 'permission' : 'device',
      );
    }
    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      if (this.pending && this.pending.opts.source.kind === 'input') this.fail(new CaptureError('The input device disconnected — the take was discarded.', 'interrupted'));
      this.disableInput();
    });
    this.stream = stream;
    this.streamSource = this.ctx.createMediaStreamSource(stream);
    this.streamSource.connect(this.inputGain);
    this.input = { label: track.label || 'Input', deviceId: track.getSettings().deviceId ?? '', settings: track.getSettings() };
    await this.ensureNode();
    this.emit();
    return this.input;
  }

  disableInput() {
    this.streamSource?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.streamSource = null;
    this.input = null;
    this.emit();
  }

  setMonitoring(on: boolean) {
    this.monitoring = on;
    this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
    this.emit();
  }

  /** Estimated input→take delay, for the default alignment offset. */
  suggestedOffsetMs(): number {
    const ctx = this.ctx;
    const out = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    const inLat = Number((this.input?.settings as any)?.latency ?? 0) || 0;
    return Math.round((out + inLat) * 1000);
  }

  /** Point the recorder (and its level meter) at a source. */
  async select(source: CaptureSource) {
    await this.ensureNode();
    if (this.connected) {
      try {
        this.connected.disconnect(this.tap);
      } catch {
        /* ignore */
      }
    }
    const node =
      source.kind === 'input'
        ? this.inputGain
        : source.kind === 'master'
          ? this.engine.graph.masterOut
          : this.engine.graph.strip(source.trackId)?.post ?? null;
    if (!node) throw new CaptureError('That track no longer exists.', 'device');
    node.connect(this.tap);
    this.connected = node;
  }

  // ── Capture ───────────────────────────────────────────────────────────

  async start(opts: CaptureOptions): Promise<CaptureTake> {
    if (this.pending) throw new CaptureError('A capture is already running.', 'device');
    if (opts.source.kind === 'input' && !this.stream) throw new CaptureError('Enable an input first.', 'device');
    await this.select(opts.source);
    const bpm = this.engine.host.project().bpm;
    const sr = this.ctx.sampleRate;
    this.engine.countInUntil = opts.countInBeats > 0 ? opts.startBeat : -Infinity;
    const promise = new Promise<CaptureTake>((resolve, reject) => {
      this.pending = { resolve, reject, opts, bpm, startFrame: 0 };
    });
    const t = await this.engine.play(opts.startBeat - opts.countInBeats);
    let captureTime = t + beatsToSec(opts.countInBeats, bpm);
    if (opts.source.kind === 'input') captureTime += opts.offsetMs / 1000;
    const startFrame = Math.round(captureTime * sr);
    const stopFrame = opts.endBeat === null ? null : startFrame + Math.round(beatsToSec(opts.endBeat - opts.startBeat, bpm) * sr);
    this.pending!.startFrame = startFrame;
    this.node!.port.postMessage({ type: 'start', startFrame, stopFrame });
    this.status = opts.countInBeats > 0 ? 'count-in' : 'recording';
    this.emit();
    const wait = Math.max(0, (captureTime - this.ctx.currentTime) * 1000);
    this.captureTimer = setTimeout(() => {
      if (this.pending) {
        this.status = 'recording';
        this.emit();
      }
    }, wait);
    return promise;
  }

  /** Stop a free-length capture now (fixed captures stop by themselves). */
  stop() {
    if (!this.pending || !this.node) return;
    const frame = Math.round(this.ctx.currentTime * this.ctx.sampleRate);
    const extra = this.pending.opts.source.kind === 'input' ? Math.round((this.pending.opts.offsetMs / 1000) * this.ctx.sampleRate) : 0;
    this.node.port.postMessage({ type: 'stop', atFrame: Math.max(this.pending.startFrame, frame + extra) });
    this.status = 'finishing';
    this.emit();
  }

  /** Discard the pending take only; existing clips and samples are untouched. */
  cancel() {
    if (!this.pending) return;
    this.node?.port.postMessage({ type: 'cancel' });
    this.fail(new CaptureError('Capture cancelled.', 'cancelled'));
  }

  /** Seconds captured so far. */
  elapsed(): number {
    if (!this.pending || this.status === 'count-in') return 0;
    return Math.max(0, this.ctx.currentTime - this.pending.startFrame / this.ctx.sampleRate);
  }

  private fail(err: Error) {
    const p = this.pending;
    this.pending = null;
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.engine.stop();
    this.engine.countInUntil = -Infinity;
    this.status = 'idle';
    this.emit();
    p?.reject(err);
  }

  private onWorklet(m: any) {
    if (m.type === 'level') {
      this.levels = m.levels;
      return;
    }
    if (m.type === 'overrun') {
      this.node?.port.postMessage({ type: 'cancel' });
      this.fail(new CaptureError('The recorder fell behind and audio was lost — the take was discarded.', 'overrun'));
    } else if (m.type === 'done') {
      this.status = 'finishing';
      this.emit();
    }
  }

  private onTake(m: any) {
    if (m.type !== 'take' || !this.pending) return;
    const { opts, bpm, resolve } = this.pending;
    this.pending = null;
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.engine.stop();
    this.engine.countInUntil = -Infinity;
    this.status = 'idle';
    this.emit();
    let channels: Float32Array[] = m.channels;
    if (opts.mono && channels.length > 1) {
      const mono = new Float32Array(channels[0].length);
      if (opts.source.kind === 'input') mono.set(channels[0]);
      else for (let i = 0; i < mono.length; i++) mono[i] = (channels[0][i] + channels[1][i]) * 0.5;
      channels = [mono];
    }
    const seconds = m.frames / this.ctx.sampleRate;
    resolve({
      channels,
      sampleRate: this.ctx.sampleRate,
      startBeat: opts.startBeat,
      endBeat: opts.endBeat ?? opts.startBeat + secToBeats(seconds, bpm),
      bpm,
      tempoBound: opts.endBeat !== null,
      source: opts.source,
    });
  }
}
