// Decoded audio, kept outside the reactive project store.
import { computePeaks, type Peaks } from '../model/peaks';

export interface LoadedSample {
  id: string;
  buffer: AudioBuffer;
  peaks: Peaks;
  /** Lazily built reversed copy for the tracker's reverse effect. */
  reversed?: AudioBuffer;
}

export class SampleRegistry {
  private map = new Map<string, LoadedSample>();
  private listeners = new Set<(id: string) => void>();

  get(id: string): LoadedSample | undefined {
    return this.map.get(id);
  }

  has(id: string) {
    return this.map.has(id);
  }

  add(id: string, buffer: AudioBuffer): LoadedSample {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    const entry: LoadedSample = { id, buffer, peaks: computePeaks(channels, buffer.sampleRate) };
    this.map.set(id, entry);
    this.listeners.forEach((l) => l(id));
    return entry;
  }

  remove(id: string) {
    this.map.delete(id);
  }

  clear() {
    this.map.clear();
  }

  reversed(id: string): AudioBuffer | undefined {
    const s = this.map.get(id);
    if (!s) return undefined;
    if (!s.reversed) {
      const b = s.buffer;
      const r = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
      for (let c = 0; c < b.numberOfChannels; c++) {
        const src = b.getChannelData(c);
        const dst = r.getChannelData(c);
        for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
      }
      s.reversed = r;
    }
    return s.reversed;
  }

  onAdd(fn: (id: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function bufferFromChannels(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const b = new AudioBuffer({ length: Math.max(1, channels[0]?.length ?? 1), numberOfChannels: Math.max(1, channels.length), sampleRate });
  channels.forEach((ch, c) => b.copyToChannel(ch as Float32Array<ArrayBuffer>, c));
  return b;
}

export function channelsOf(b: AudioBuffer): Float32Array[] {
  return Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
}
