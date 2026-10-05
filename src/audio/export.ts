// Offline render: a fresh engine on an OfflineAudioContext with the same
// scheduling, DSP and effects as playback. Rendering starts after an internal
// preroll (so the stretcher can compensate its latency) which is then removed.
import type { Project } from '../model/types';
import { beatsToSec } from '../model/timing';
import { AudioEngine } from './engine';
import type { SampleRegistry } from './samples';

export interface RenderOptions {
  startBeat: number;
  endBeat: number;
  /** Effects tail appended after the range, seconds. */
  tail: number;
  sampleRate: number;
}

export interface RenderResult {
  channels: Float32Array[];
  sampleRate: number;
  /** Peak absolute sample value (to flag clipping). */
  peak: number;
}

export async function renderOffline(project: Project, samples: SampleRegistry, opts: RenderOptions): Promise<RenderResult> {
  const preroll = 0.35;
  const body = beatsToSec(opts.endBeat - opts.startBeat, project.bpm);
  const total = preroll + body + Math.max(0, opts.tail);
  const frames = Math.ceil(total * opts.sampleRate);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate: opts.sampleRate });
  const snapshot = structuredClone(project);
  const engine = new AudioEngine(ctx, { project: () => snapshot, samples });
  await engine.scheduleOffline(opts.startBeat, opts.endBeat, preroll);
  const rendered = await ctx.startRendering();
  const skip = Math.round(preroll * opts.sampleRate);
  const len = rendered.length - skip;
  const channels = [0, 1].map((c) => rendered.getChannelData(c).slice(skip, skip + len));
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  return { channels, sampleRate: opts.sampleRate, peak };
}
