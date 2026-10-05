// Pool of Signalsmith Stretch worklet nodes. Creating a node compiles the WASM
// inside the worklet, so nodes are created ahead of playback and reused.
import SignalsmithStretch from '../vendor/signalsmith-stretch.mjs';

export interface StretchNode extends AudioWorkletNode {
  schedule(seg: Record<string, unknown>): Promise<unknown>;
  addBuffers(buffers: Float32Array[]): Promise<number>;
  dropBuffers(): Promise<unknown>;
  latency(): Promise<number>;
  configure(cfg: Record<string, unknown>): Promise<unknown>;
}

interface PoolEntry {
  node: StretchNode;
  sampleId: string | null;
  busy: boolean;
  /** Context time after which a released node may be reused. */
  freeAt: number;
}

export class StretchPool {
  private entries: PoolEntry[] = [];
  private creating = 0;
  latency = 0.1;

  constructor(private ctx: BaseAudioContext) {}

  get size() {
    return this.entries.length;
  }

  private async create(): Promise<PoolEntry> {
    this.creating++;
    try {
      const node = (await SignalsmithStretch(this.ctx, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })) as StretchNode;
      this.latency = await node.latency();
      const entry: PoolEntry = { node, sampleId: null, busy: false, freeAt: 0 };
      this.entries.push(entry);
      return entry;
    } finally {
      this.creating--;
    }
  }

  /** Make sure at least `n` nodes exist (creating them outside audio processing). */
  async ensure(n: number) {
    const missing = n - this.entries.length - this.creating;
    if (missing > 0) await Promise.all(Array.from({ length: missing }, () => this.create()));
  }

  /** Synchronously take an idle node if one is available. */
  tryAcquire(sampleId: string, buffer: AudioBuffer, now: number): StretchNode | null {
    const free = this.entries.filter((e) => !e.busy && e.freeAt <= now);
    const entry = free.find((e) => e.sampleId === sampleId) ?? free[0];
    if (!entry) return null;
    this.load(entry, sampleId, buffer);
    return entry.node;
  }

  async acquire(sampleId: string, buffer: AudioBuffer, now: number): Promise<StretchNode> {
    const n = this.tryAcquire(sampleId, buffer, now);
    if (n) return n;
    const entry = await this.create();
    this.load(entry, sampleId, buffer);
    return entry.node;
  }

  private load(entry: PoolEntry, sampleId: string, buffer: AudioBuffer) {
    entry.busy = true;
    if (entry.sampleId !== sampleId) {
      entry.node.dropBuffers();
      const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
      entry.node.addBuffers(chans);
      entry.sampleId = sampleId;
    }
  }

  /** Return a node; it becomes reusable once its scheduled stop + tail has passed. */
  release(node: StretchNode, freeAt: number) {
    const e = this.entries.find((x) => x.node === node);
    if (!e) return;
    e.busy = false;
    e.freeAt = freeAt;
    try {
      node.disconnect();
    } catch {
      /* already disconnected */
    }
  }

  dispose() {
    for (const e of this.entries) {
      try {
        e.node.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.entries = [];
  }
}
