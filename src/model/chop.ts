// Turning regions of a long sample (a whole song) into arrangement clips.
import type { AudioClip, Beats, SampleMeta, Seconds } from './types';
import { createAudioClip } from './project';

/** A sample with a beat grid places its clips in tempo mode, so slices stay in time with the project. */
function gridExtra(meta: SampleMeta): Partial<AudioClip> {
  return meta.grid ? { timing: 'tempo', sourceBpm: meta.grid.bpm } : {};
}

/** One clip playing [from, to] of a sample. */
export function regionClip(meta: SampleMeta, from: Seconds, to: Seconds, trackId: string, start: Beats, bpm: number, name?: string): AudioClip {
  const a = Math.max(0, Math.min(from, meta.duration));
  const b = Math.max(a + 0.005, Math.min(to, meta.duration));
  return createAudioClip(meta, trackId, start, bpm, { ...gridExtra(meta), srcStart: a, srcEnd: b, name: name ?? meta.name });
}

/** Contiguous clips for consecutive boundary pairs, laid end to end from `start`. */
export function sliceClips(meta: SampleMeta, bounds: Seconds[], trackId: string, start: Beats, bpm: number): AudioClip[] {
  const out: AudioClip[] = [];
  let at = start;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const c = regionClip(meta, bounds[i], bounds[i + 1], trackId, at, bpm, `${meta.name} ${i + 1}`);
    out.push(c);
    at = c.start + c.length;
  }
  return out;
}
