// User-level operations. Every edit goes through commit()/gestures so it is undoable.
import { unwrap } from 'solid-js/store';
import type { AudioClip, Clip, Instrument, Pattern, PatternClip, Project, SampleKind, SampleMeta, SampleSourceRef, Track } from '../model/types';
import { createAudioClip, createInstrument, createPatternClip, createTrack, newId } from '../model/project';
import { clonePattern, createPattern } from '../model/tracker';
import { BEATS_PER_BAR, clipEnd, normalizeClip, snapBeat } from '../model/timing';
import { duplicateClip, songEnd, splitClip } from '../model/clips';
import { encodeWav, type WavFormat } from '../model/wav';
import { bufferFromChannels, channelsOf } from '../audio/samples';
import { renderOffline } from '../audio/export';
import { CaptureError, type CaptureTake } from '../audio/capture';
import { saveSample } from './db';
import {
  audio,
  commit,
  normalizeAll,
  playhead,
  project,
  samples,
  selectedClipIds,
  setPlayhead,
  setUi,
  toast,
  ui,
} from './app';

// ── Samples ──────────────────────────────────────────────────────────────

/** Register decoded audio, add it to the project and persist it. */
export async function addSample(
  channels: Float32Array[],
  sampleRate: number,
  info: { name: string; kind: SampleKind; fileName?: string; capture?: SampleSourceRef; beats?: number; bpm?: number },
): Promise<SampleMeta> {
  const id = newId('s');
  const buffer = bufferFromChannels(channels, sampleRate);
  samples.add(id, buffer);
  const meta: SampleMeta = {
    id,
    name: info.name,
    kind: info.kind,
    sampleRate,
    channels: channels.length,
    frames: buffer.length,
    duration: buffer.duration,
    createdAt: Date.now(),
    fileName: info.fileName,
    capture: info.capture,
    beats: info.beats,
    bpm: info.bpm,
  };
  commit(`add ${info.name}`, (p) => p.samples.push(meta), { checkOverlaps: false });
  try {
    await saveSample(project.id, id, sampleRate, channels);
  } catch (e: any) {
    toast(`Couldn’t store “${info.name}” in the browser (${e?.message ?? e}). It stays in this session — export a bundle to keep it.`, 'error', 0);
  }
  return meta;
}

const stripExt = (n: string) => n.replace(/\.[a-z0-9]+$/i, '');

export async function importFiles(files: File[], place?: { trackId: string; beat: number }) {
  const { ctx } = audio();
  let beat = place?.beat ?? 0;
  const metas: SampleMeta[] = [];
  for (const f of files) {
    try {
      const buf = await ctx.decodeAudioData(await f.arrayBuffer());
      const meta = await addSample(channelsOf(buf), buf.sampleRate, { name: stripExt(f.name), kind: 'import', fileName: f.name });
      metas.push(meta);
      if (place) {
        const clip = addClipFromSample(meta.id, place.trackId, beat);
        if (clip) beat = clipEnd(clip);
      }
    } catch (e: any) {
      toast(`Couldn’t decode “${f.name}” — ${e?.message ?? 'unsupported format'}.`, 'error');
    }
  }
  if (metas.length && !place) toast(`Imported ${metas.length} sample${metas.length > 1 ? 's' : ''}. Drag them onto a track.`);
  return metas;
}

export function renameSample(id: string, name: string) {
  commit('rename sample', (p) => {
    const s = p.samples.find((x) => x.id === id);
    if (s) s.name = name;
  }, { checkOverlaps: false });
}

export function sampleUsage(id: string) {
  return {
    clips: project.clips.filter((c) => c.kind === 'audio' && c.sampleId === id).length,
    instruments: project.instruments.filter((i) => i.sampleId === id).length,
  };
}

export function removeSample(id: string) {
  const u = sampleUsage(id);
  if (u.clips || u.instruments) {
    toast('That sample is still used by clips or instruments.', 'warn');
    return;
  }
  commit('remove sample', (p) => {
    p.samples = p.samples.filter((s) => s.id !== id);
  }, { checkOverlaps: false });
}

// ── Clips ────────────────────────────────────────────────────────────────

export function addClipFromSample(sampleId: string, trackId: string, beat: number, extra: Partial<AudioClip> = {}): AudioClip | null {
  const meta = project.samples.find((s) => s.id === sampleId);
  if (!meta) return null;
  const clip = createAudioClip(meta, trackId, Math.max(0, beat), project.bpm, extra);
  const ok = commit(`place ${meta.name}`, (p) => p.clips.push(clip));
  if (ok) setUi('selection', { kind: 'clips', ids: [clip.id] });
  return ok ? clip : null;
}

export function addPatternClip(trackId: string, beat: number) {
  const n = project.patterns.length + 1;
  const pattern = createPattern(`Pattern ${n}`);
  const clip = createPatternClip(pattern, trackId, Math.max(0, beat));
  const ok = commit('new pattern', (p) => {
    p.patterns.push(pattern);
    p.clips.push(clip);
  });
  if (ok) setUi('selection', { kind: 'clips', ids: [clip.id] });
  return ok ? clip : null;
}

export function updateClip(id: string, label: string, fn: (c: Clip, p: Project) => Clip) {
  return commit(label, (p) => {
    const i = p.clips.findIndex((c) => c.id === id);
    if (i >= 0) p.clips[i] = normalizeClip(fn(p.clips[i], p), p.bpm);
  });
}

export function deleteSelected() {
  const ids = new Set(selectedClipIds());
  if (!ids.size) return;
  commit(ids.size > 1 ? `delete ${ids.size} clips` : 'delete clip', (p) => {
    p.clips = p.clips.filter((c) => !ids.has(c.id));
    prunePatterns(p);
  });
  setUi('selection', { kind: 'none' });
}

/** Patterns not referenced by any clip are dropped. */
function prunePatterns(p: Project) {
  const used = new Set(p.clips.filter((c) => c.kind === 'pattern').map((c) => (c as PatternClip).patternId));
  p.patterns = p.patterns.filter((x) => used.has(x.id));
}

export function duplicateSelected() {
  const sel = project.clips.filter((c) => selectedClipIds().includes(c.id));
  if (!sel.length) return;
  const start = Math.min(...sel.map((c) => c.start));
  const end = Math.max(...sel.map(clipEnd));
  const shift = end - start;
  const copies = sel.map((c) => duplicateClip(unwrap(c), c.start + shift));
  if (commit('duplicate', (p) => p.clips.push(...copies))) setUi('selection', { kind: 'clips', ids: copies.map((c) => c.id) });
}

export function splitAt(beat: number) {
  const ids = selectedClipIds();
  const targets = project.clips.filter((c) => (ids.length ? ids.includes(c.id) : true) && c.start < beat && clipEnd(c) > beat);
  if (!targets.length) return toast('Nothing to split at the playhead.', 'info', 1500);
  const newIds: string[] = [];
  commit('split', (p) => {
    for (const t of targets) {
      const i = p.clips.findIndex((c) => c.id === t.id);
      const parts = splitClip(unwrap(p.clips[i]), beat, p.bpm);
      if (!parts) continue;
      p.clips.splice(i, 1, parts[0], parts[1]);
      newIds.push(parts[0].id, parts[1].id);
    }
  });
  setUi('selection', { kind: 'clips', ids: newIds });
}

export function makeUnique(clipId: string) {
  commit('make unique', (p) => {
    const c = p.clips.find((x) => x.id === clipId) as PatternClip | undefined;
    const src = c && p.patterns.find((x) => x.id === c.patternId);
    if (!c || !src) return;
    const copy = clonePattern(unwrap(src), `${src.name}·${p.patterns.length + 1}`);
    p.patterns.push(copy);
    c.patternId = copy.id;
    c.name = copy.name;
  }, { checkOverlaps: false });
}

export function linkedCount(patternId: string) {
  return project.clips.filter((c) => c.kind === 'pattern' && c.patternId === patternId).length;
}

export function updatePattern(id: string, label: string, fn: (p: Pattern) => Pattern) {
  commit(label, (proj) => {
    const i = proj.patterns.findIndex((x) => x.id === id);
    if (i >= 0) proj.patterns[i] = fn(unwrap(proj.patterns[i]));
  }, { checkOverlaps: false });
}

// ── Tracks ───────────────────────────────────────────────────────────────

export function addTrack() {
  commit('add track', (p) => {
    p.tracks.push(createTrack(p.tracks.length));
  }, { checkOverlaps: false });
}

export function removeTrack(id: string) {
  const n = project.clips.filter((c) => c.trackId === id).length;
  if (project.tracks.length <= 1) return;
  if (n && !confirm(`Remove this track and its ${n} clip${n > 1 ? 's' : ''}?`)) return;
  commit('remove track', (p) => {
    p.tracks = p.tracks.filter((t) => t.id !== id);
    p.clips = p.clips.filter((c) => c.trackId !== id);
    prunePatterns(p);
  }, { checkOverlaps: false });
}

export function updateTrack(id: string, label: string, patch: Partial<Track>) {
  commit(label, (p) => {
    const t = p.tracks.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
  }, { checkOverlaps: false });
}

// ── Markers, loop, tempo ─────────────────────────────────────────────────

export function addMarker(beat: number) {
  const b = snapBeat(beat, BEATS_PER_BAR, true);
  if (project.markers.some((m) => Math.abs(m.beat - b) < 1e-6)) return;
  const letter = String.fromCharCode(65 + (project.markers.length % 26));
  commit('add section', (p) => {
    p.markers.push({ id: newId('m'), beat: b, name: `Section ${letter}` });
    p.markers.sort((a, z) => a.beat - z.beat);
  }, { checkOverlaps: false });
}

export function updateMarker(id: string, patch: { beat?: number; name?: string }) {
  commit('edit section', (p) => {
    const m = p.markers.find((x) => x.id === id);
    if (m) Object.assign(m, patch);
    p.markers.sort((a, z) => a.beat - z.beat);
  }, { checkOverlaps: false });
}

export function removeMarker(id: string) {
  commit('remove section', (p) => {
    p.markers = p.markers.filter((m) => m.id !== id);
  }, { checkOverlaps: false });
}

/** Beat range of the section starting at a marker (to the next marker or song end). */
export function sectionRange(markerId: string): [number, number] | null {
  const ms = project.markers;
  const i = ms.findIndex((m) => m.id === markerId);
  if (i < 0) return null;
  const end = ms[i + 1]?.beat ?? Math.max(songEnd(project.clips), ms[i].beat + BEATS_PER_BAR);
  return [ms[i].beat, end];
}

export function setLoop(patch: Partial<Project['loop']>) {
  commit('loop range', (p) => {
    Object.assign(p.loop, patch);
    if (p.loop.end < p.loop.start) [p.loop.start, p.loop.end] = [p.loop.end, p.loop.start];
  }, { checkOverlaps: false });
}

export function setBpm(bpm: number) {
  if (!Number.isFinite(bpm)) return;
  bpm = Math.max(20, Math.min(400, Math.round(bpm * 100) / 100));
  commit('tempo', (p) => {
    p.bpm = bpm;
    normalizeAll(p);
  });
}

// ── Instruments ──────────────────────────────────────────────────────────

export function instrumentFromSample(sampleId: string): Instrument | null {
  const meta = project.samples.find((s) => s.id === sampleId);
  if (!meta) return null;
  const ins = createInstrument(meta);
  commit('new instrument', (p) => p.instruments.push(ins), { checkOverlaps: false });
  setUi('tracker', 'instrumentId', ins.id);
  setUi('selection', { kind: 'instrument', id: ins.id });
  return ins;
}

/** Make an instrument from an audio clip's region. */
export function instrumentFromClip(clipId: string) {
  const c = project.clips.find((x) => x.id === clipId) as AudioClip | undefined;
  const meta = c && project.samples.find((s) => s.id === c.sampleId);
  if (!c || !meta) return;
  const ins = { ...createInstrument(meta, c.name ?? meta.name), start: c.srcStart, end: c.srcEnd, loopStart: c.srcStart, loopEnd: c.srcEnd };
  commit('new instrument', (p) => p.instruments.push(ins), { checkOverlaps: false });
  setUi('tracker', 'instrumentId', ins.id);
  setUi('selection', { kind: 'instrument', id: ins.id });
}

export function updateInstrument(id: string, label: string, patch: Partial<Instrument>) {
  commit(label, (p) => {
    const i = p.instruments.find((x) => x.id === id);
    if (i) Object.assign(i, patch);
  }, { checkOverlaps: false });
}

export function removeInstrument(id: string) {
  commit('remove instrument', (p) => {
    p.instruments = p.instruments.filter((i) => i.id !== id);
  }, { checkOverlaps: false });
  if (ui.tracker.instrumentId === id) setUi('tracker', 'instrumentId', project.instruments[0]?.id ?? null);
}

// ── Transport ────────────────────────────────────────────────────────────

export async function play(from = ui.cursor) {
  const { engine } = audio();
  engine.metronome = ui.metronome;
  try {
    await engine.play(from);
  } catch (e: any) {
    toast(`Playback failed: ${e?.message ?? e}`, 'error');
  }
}

export function stop() {
  const { engine, capture } = audio();
  if (capture.status !== 'idle') return capture.status === 'recording' && ui.capture.length === 'free' ? capture.stop() : capture.cancel();
  engine.stop();
  setPlayhead(ui.cursor);
}

export function togglePlay() {
  if (audio().engine.playing) stop();
  else void play();
}

export function seek(beat: number) {
  beat = Math.max(0, beat);
  setUi('cursor', beat);
  setPlayhead(beat);
  if (audio().engine.playing) void play(beat);
}

// ── Capture ──────────────────────────────────────────────────────────────

let takeCounter = 0;

export async function startCapture() {
  const { capture } = audio();
  const c = ui.capture;
  const destTrackId = c.destTrackId ?? project.tracks[0]?.id;
  if (!destTrackId) return;
  const source =
    c.source === 'input' ? ({ kind: 'input' } as const) : c.source === 'master' ? ({ kind: 'master' } as const) : ({ kind: 'track', trackId: c.source } as const);
  if (source.kind === 'track' && source.trackId === destTrackId) {
    // Allowed (the clip appears only when capture ends), but worth a heads-up.
    toast('Printing a track onto itself — the new clip will overlap the source.', 'warn');
  }
  let startBeat = ui.cursor;
  let endBeat: number | null = null;
  if (c.length === 'loop') {
    startBeat = project.loop.start;
    endBeat = project.loop.end;
  } else if (c.length === 'bars') {
    startBeat = ui.snap ? snapBeat(ui.cursor, BEATS_PER_BAR, true) : ui.cursor;
    endBeat = startBeat + c.bars * BEATS_PER_BAR;
  }
  try {
    const take = await capture.start({
      source,
      startBeat,
      endBeat,
      countInBeats: c.countInBars * BEATS_PER_BAR,
      offsetMs: source.kind === 'input' ? c.offsetMs : 0,
      mono: c.mono,
    });
    await finishTake(take, destTrackId);
  } catch (e: any) {
    if (e instanceof CaptureError && e.kind === 'cancelled') toast('Capture cancelled — nothing was changed.', 'info', 2000);
    else toast(e?.message ?? String(e), 'error', 0);
  }
}

async function finishTake(take: CaptureTake, destTrackId: string) {
  if (!take.channels[0]?.length) return toast('The take was empty.', 'warn');
  takeCounter++;
  const p = project;
  const src = take.source;
  const trackName = src.kind === 'track' ? p.tracks.find((t) => t.id === src.trackId)?.name : undefined;
  const sounding = p.clips.filter(
    (c) => (src.kind === 'master' || (src.kind === 'track' && c.trackId === src.trackId)) && c.start < take.endBeat && clipEnd(c) > take.startBeat,
  );
  const ref: SampleSourceRef = {
    source: src.kind,
    trackId: src.kind === 'track' ? src.trackId : undefined,
    trackName,
    deviceLabel: src.kind === 'input' ? audio().capture.input?.label : undefined,
    startBeat: take.startBeat,
    endBeat: take.endBeat,
    bpm: take.bpm,
    clipIds: src.kind === 'input' ? undefined : sounding.map((c) => c.id),
    sampleIds: src.kind === 'input' ? undefined : [...new Set(sounding.filter((c): c is AudioClip => c.kind === 'audio').map((c) => c.sampleId))],
  };
  const name =
    src.kind === 'input' ? `Take ${takeCounter}` : src.kind === 'master' ? `Print · Master ${takeCounter}` : `Print · ${trackName ?? 'Track'} ${takeCounter}`;
  const beats = take.tempoBound ? take.endBeat - take.startBeat : undefined;
  const meta = await addSample(take.channels, take.sampleRate, {
    name,
    kind: src.kind === 'input' ? 'recording' : 'print',
    capture: ref,
    beats,
    bpm: take.tempoBound ? take.bpm : undefined,
  });
  // Neutral clip at the captured start; tempo-bound captures follow the project tempo.
  // If the destination is already layered there, use the next track that has room.
  const ids = project.tracks.map((t) => t.id);
  const start = Math.max(0, ids.indexOf(destTrackId));
  const order = [...ids.slice(start), ...ids.slice(0, start)];
  const verb = src.kind === 'input' ? 'Recorded' : 'Printed';
  for (const trackId of order) {
    const clip = createAudioClip(meta, trackId, take.startBeat, project.bpm, take.tempoBound ? { timing: 'tempo', sourceBpm: take.bpm } : {});
    if (commit(`capture ${name}`, (proj) => proj.clips.push(clip), { quiet: true })) {
      setUi('selection', { kind: 'clips', ids: [clip.id] });
      const tName = project.tracks.find((t) => t.id === trackId)?.name;
      toast(trackId === destTrackId ? `${verb} “${name}”.` : `${verb} “${name}” onto ${tName} — the destination already had clips there.`);
      return;
    }
  }
  toast(`${verb} “${name}”. It’s in the pool — no track had room at that position.`, 'warn');
}

// ── Export ───────────────────────────────────────────────────────────────

export async function exportWav(range: [number, number], tail: number, format: WavFormat, name: string) {
  const { ctx } = audio();
  const r = await renderOffline(structuredClone(unwrap(project)), samples, {
    startBeat: range[0],
    endBeat: range[1],
    tail,
    sampleRate: ctx.sampleRate,
  });
  const bytes = encodeWav(r.channels, r.sampleRate, format);
  download(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), `${name}.wav`);
  return r;
}

export function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const songRange = (): [number, number] => [0, Math.max(BEATS_PER_BAR, songEnd(project.clips))];

export { playhead };
