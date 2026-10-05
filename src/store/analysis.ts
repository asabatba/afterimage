// Analysis of pool samples (tempo, beats, hits, chords, key). Results live in memory only: they are
// cheap to recompute, while the beat grid the user actually relies on is stored on the sample itself.
import { createSignal } from 'solid-js';
import { analyzeSample, chordForRange, computeChroma, detectNote, type ChordGuess, type NoteEstimate, type SampleAnalysis } from '../model/analysis';
import { channelsOf } from '../audio/samples';
import { project, samples, toast } from './app';
import { setSampleGrid } from './actions';

const cache = new Map<string, SampleAnalysis>();
const [rev, bump] = createSignal(0);
const [progress, setProgress] = createSignal<Record<string, { stage: string; fraction: number }>>({});
const running = new Map<string, Promise<SampleAnalysis | null>>();

/** Reactive: the cached analysis of a sample, if it has been analysed this session. */
export const analysisOf = (id: string): SampleAnalysis | undefined => (rev(), cache.get(id));
export const analysisProgress = (id: string) => progress()[id];

/**
 * Analyse a sample (once per session unless forced). The first analysis of a sample with no beat grid
 * adopts the detected tempo as its grid, as one undoable step.
 */
export function analyseSample(id: string, opts: { force?: boolean } = {}): Promise<SampleAnalysis | null> {
  const cached = cache.get(id);
  if (cached && !opts.force) return Promise.resolve(cached);
  const busy = running.get(id);
  if (busy) return busy;
  const loaded = samples.get(id);
  if (!loaded) return Promise.resolve(null);
  const promise = (async () => {
    try {
      const a = await analyzeSample(channelsOf(loaded.buffer), loaded.buffer.sampleRate, {
        onProgress: (stage, fraction) => setProgress((p) => ({ ...p, [id]: { stage, fraction } })),
      });
      cache.set(id, a);
      bump((v) => v + 1);
      const meta = project.samples.find((m) => m.id === id);
      if (meta && !meta.grid && a.tempo) setSampleGrid(id, { bpm: a.tempo.bpm, offset: a.tempo.offset }, 'detect tempo');
      return a;
    } catch (e: any) {
      toast(`Couldn’t analyse the sample — ${e?.message ?? e}`, 'error');
      return null;
    } finally {
      running.delete(id);
      setProgress((p) => {
        const { [id]: _done, ...rest } = p;
        return rest;
      });
    }
  })();
  running.set(id, promise);
  return promise;
}

/** Put the sample's beat grid back to what analysis found. */
export function useDetectedGrid(id: string) {
  const t = cache.get(id)?.tempo;
  if (t) setSampleGrid(id, { bpm: t.bpm, offset: t.offset }, 'reset beat grid');
}

export interface RegionInfo {
  note: NoteEstimate | null;
  chord: ChordGuess | null;
}

/** Pitch and chord of a region, computed on demand (long regions are cut to their first 20 seconds). */
export async function detectRegion(sampleId: string, from: number, to: number): Promise<RegionInfo> {
  const loaded = samples.get(sampleId);
  if (!loaded) return { note: null, chord: null };
  const ch = channelsOf(loaded.buffer);
  const sr = loaded.buffer.sampleRate;
  const end = Math.min(to, from + 20);
  const note = detectNote(ch, sr, from, end);
  const chroma = await computeChroma(ch, sr, { from, to: end });
  return { note, chord: chordForRange(chroma, 0, end - from) };
}
