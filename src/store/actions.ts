// User-level operations. Every edit goes through commit()/gestures so it is undoable.
import { createSignal } from 'solid-js';
import { unwrap } from 'solid-js/store';
import type { AudioClip, BeatGrid, Clip, Instrument, Pattern, PatternClip, Project, SampleKind, SampleMeta, SampleSourceRef, Track } from '../model/types';
import { createAudioClip, createInstrument, createPatternClip, createTrack, newId } from '../model/project';
import { clonePattern, createPattern, noteName } from '../model/tracker';
import { BEATS_PER_BAR, EPS, clipEnd, normalizeClip, snapBeat } from '../model/timing';
import { duplicateClip, fillClips, groupSpan, pasteClips, repeatClips, songEnd, splitClip } from '../model/clips';
import { regionClip, sliceClips } from '../model/chop';
import { detectNote } from '../model/analysis';
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
  selectClips,
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
  if (metas.length === 1 && !place) {
    openSample(metas[0].id);
    toast(`Imported “${metas[0].name}” and opened it in the sample editor — select a region to place it, or slice it.`);
  } else if (metas.length && !place) toast(`Imported ${metas.length} sample${metas.length > 1 ? 's' : ''}. Drag them onto a track.`);
  return metas;
}

/** Show a pool sample in the sample editor (bottom panel). */
export function openSample(id: string) {
  setUi('selection', { kind: 'sample', id });
  setUi({ bottomOpen: true, bottomTab: 'detail', bottomHeight: Math.max(ui.bottomHeight, 400) });
}

/** Set (or clear) a sample's beat grid. */
export function setSampleGrid(id: string, grid: BeatGrid | undefined, label = 'edit beat grid') {
  commit(label, (p) => {
    const s = p.samples.find((x) => x.id === id);
    if (!s) return;
    if (grid) s.grid = { bpm: Math.round(grid.bpm * 1000) / 1000, offset: grid.offset };
    else delete s.grid;
  }, { checkOverlaps: false });
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
  // A sample with a beat grid follows the project tempo, so it stays in time wherever it is placed.
  const grid: Partial<AudioClip> = meta.grid ? { timing: 'tempo', sourceBpm: meta.grid.bpm } : {};
  const clip = createAudioClip(meta, trackId, Math.max(0, beat), project.bpm, { ...grid, ...extra });
  const ok = commit(`place ${meta.name}`, (p) => p.clips.push(clip));
  if (ok) {
    setUi('selection', { kind: 'clips', ids: [clip.id] });
    setUi('activeTrackId', trackId);
  }
  return ok ? clip : null;
}

// ── Chopping: regions and slices of a long sample ────────────────────────

/** First track (starting at `preferred`) with no clip overlapping [start, end). */
function trackWithRoom(preferred: string | null | undefined, start: number, end: number): string | null {
  const ids = project.tracks.map((t) => t.id);
  const from = Math.max(0, ids.indexOf(preferred ?? ''));
  for (const id of [...ids.slice(from), ...ids.slice(0, from)]) {
    if (!project.clips.some((c) => c.trackId === id && c.start < end - EPS && clipEnd(c) > start + EPS)) return id;
  }
  return null;
}

/** Move the insertion point (without disturbing playback). */
function moveCursor(beat: number) {
  setUi('cursor', beat);
  if (!audio().engine.playing) setPlayhead(beat);
}

/** Place [from, to] of a sample at the cursor (or `beat`), then advance the cursor so the next one follows. */
export function placeRegion(sampleId: string, from: number, to: number, opts: { trackId?: string; beat?: number } = {}) {
  const meta = project.samples.find((s) => s.id === sampleId);
  if (!meta) return null;
  const beat = Math.max(0, opts.beat ?? ui.cursor);
  const probe = regionClip(meta, from, to, '', beat, project.bpm);
  const trackId = opts.trackId ?? trackWithRoom(ui.activeTrackId ?? ui.capture.destTrackId, beat, beat + probe.length);
  if (!trackId) {
    toast('No track has room at the cursor — move the cursor or clear some space.', 'warn');
    return null;
  }
  const clip = { ...probe, trackId };
  if (!commit(`place ${clip.name}`, (p) => p.clips.push(clip))) return null;
  // The selection stays on the sample so the editor remains open for the next piece.
  setUi('activeTrackId', trackId);
  moveCursor(clipEnd(clip));
  return clip;
}

/** Place consecutive pieces cut at `bounds`, end to end from the cursor. */
export function sliceToTrack(sampleId: string, bounds: number[], opts: { trackId?: string; beat?: number } = {}) {
  const meta = project.samples.find((s) => s.id === sampleId);
  if (!meta || bounds.length < 2) return toast('Nothing to slice here — widen the selection or change the slice size.', 'warn');
  const beat = Math.max(0, opts.beat ?? ui.cursor);
  const probe = sliceClips(meta, bounds, '', beat, project.bpm);
  const end = probe.length ? clipEnd(probe[probe.length - 1]) : beat;
  const trackId = opts.trackId ?? trackWithRoom(ui.activeTrackId ?? ui.capture.destTrackId, beat, end);
  if (!trackId) return toast('No track has room for the slices at the cursor — move the cursor or clear some space.', 'warn');
  const clips = probe.map((c) => ({ ...c, trackId }));
  if (!commit(`slice ${meta.name} into ${clips.length}`, (p) => p.clips.push(...clips))) return;
  setUi('activeTrackId', trackId);
  moveCursor(end);
  toast(`Placed ${clips.length} slices on ${project.tracks.find((t) => t.id === trackId)?.name ?? 'a track'}.`, 'info', 2500);
}

/** Drop a region of a sample onto a lane at a beat (drag from the sample editor). */
export function addRegionClip(sampleId: string, from: number, to: number, trackId: string, beat: number) {
  const meta = project.samples.find((s) => s.id === sampleId);
  if (!meta) return null;
  const clip = regionClip(meta, from, to, trackId, Math.max(0, beat), project.bpm);
  if (!commit(`place ${clip.name}`, (p) => p.clips.push(clip))) return null;
  setUi('activeTrackId', trackId);
  return clip;
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

// ── Copy, paste, repeat, fill ────────────────────────────────────────────

interface ClipboardData {
  clips: Clip[];
  patterns: Pattern[];
}
let clipboard: ClipboardData | null = null;
const [clipboardCount, setClipboardCount] = createSignal(0);
/** Reactive: how many clips are on the clipboard. */
export { clipboardCount };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const selectedClips = (): Clip[] =>
  project.clips.filter((c) => selectedClipIds().includes(c.id)).map((c) => structuredClone(unwrap(c)) as Clip);

export function copySelected(quiet = false): boolean {
  const clips = selectedClips();
  if (!clips.length) return false;
  const used = new Set(clips.filter((c): c is PatternClip => c.kind === 'pattern').map((c) => c.patternId));
  clipboard = { clips, patterns: project.patterns.filter((p) => used.has(p.id)).map((p) => structuredClone(unwrap(p))) };
  setClipboardCount(clips.length);
  if (!quiet) toast(`Copied ${plural(clips.length, 'clip')}. Ctrl+V pastes at the cursor; paste again to keep going.`, 'info', 1800);
  return true;
}

export function cutSelected() {
  if (!copySelected(true)) return;
  const n = clipboardCount();
  deleteSelected();
  toast(`Cut ${plural(n, 'clip')}.`, 'info', 1500);
}

/** Paste at the cursor (or `beat`). The cursor then moves to the end of the pasted clips, so pasting again continues. */
export function pasteClipboard(beat?: number) {
  if (!clipboard) return toast('Nothing to paste — copy some clips first (Ctrl+C).', 'info', 1800);
  const ids = project.tracks.map((t) => t.id);
  const rows = clipboard.clips.map((c) => Math.max(0, ids.indexOf(c.trackId)));
  const anchor = ids.indexOf(ui.activeTrackId ?? '');
  const at = Math.max(0, beat ?? (audio().engine.playing ? playhead() : ui.cursor));
  const copies = pasteClips(clipboard.clips, at, ids, anchor >= 0 ? anchor - Math.min(...rows) : 0);
  const pats = clipboard.patterns;
  const ok = commit(`paste ${plural(copies.length, 'clip')}`, (p) => {
    for (const pat of pats) if (!p.patterns.some((x) => x.id === pat.id)) p.patterns.push(structuredClone(pat));
    p.clips.push(...copies);
  });
  if (!ok) return;
  selectClips(copies.map((c) => c.id));
  setUi('activeTrackId', copies[0]?.trackId ?? ui.activeTrackId);
  moveCursor(groupSpan(copies).end);
}

/** Repeat step in beats, never smaller than the group (copies must not collide). */
function repeatStep(group: Clip[]): number | undefined {
  const unit = { auto: 0, bar: 4, bars2: 8, bars4: 16 }[ui.tools.step];
  if (!unit) return undefined;
  return Math.max(1, Math.ceil(groupSpan(group).length / unit - 1e-9)) * unit;
}

const sampleDurationOf = (c: Clip) => (c.kind === 'audio' ? project.samples.find((s) => s.id === c.sampleId)?.duration ?? Infinity : Infinity);

export function repeatSelected(count = ui.tools.repeatCount) {
  const group = selectedClips();
  if (!group.length) return;
  const copies = repeatClips(group, count, repeatStep(group));
  if (!copies.length) return toast('Nothing to repeat.', 'info', 1500);
  if (commit(`repeat ×${count}`, (p) => p.clips.push(...copies))) {
    selectClips(copies.map((c) => c.id));
    moveCursor(groupSpan(copies).end);
  }
}

/** Where a fill should stop, in beats, or null if the target has no usable position. */
export function fillTargetBeat(group: Clip[], target = ui.tools.fillTo): number | null {
  const end = groupSpan(group).end;
  const barEnd = Math.ceil(end / BEATS_PER_BAR - 1e-9) * BEATS_PER_BAR;
  switch (target) {
    case 'loop':
      return project.loop.end;
    case 'section':
      return project.markers.find((m) => m.beat > end + EPS)?.beat ?? null;
    case 'song':
      return songEnd(project.clips);
    case 'bars8':
      return barEnd + 8 * BEATS_PER_BAR;
    case 'bars16':
      return barEnd + 16 * BEATS_PER_BAR;
    case 'bars32':
      return barEnd + 32 * BEATS_PER_BAR;
  }
}

export function fillSelected(target = ui.tools.fillTo) {
  const group = selectedClips();
  if (!group.length) return;
  const to = fillTargetBeat(group, target);
  if (to === null) return toast('There is no later section marker to fill to — add one with M, or pick another target.', 'warn');
  const copies = fillClips(group, to, project.bpm, sampleDurationOf, repeatStep(group), true);
  if (!copies.length) return toast('Nothing to fill — the target is at or before the end of the selection.', 'info', 2200);
  if (commit(`fill to beat ${Math.round(to * 100) / 100}`, (p) => p.clips.push(...copies))) {
    selectClips(copies.map((c) => c.id));
    moveCursor(groupSpan(copies).end);
  }
}

/** Set the loop range around the selected clips and switch looping on. */
export function loopToSelection() {
  const group = selectedClips();
  if (!group.length) return;
  const { start, end } = groupSpan(group);
  setLoop({ start, end, enabled: true });
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

/**
 * Tune an instrument to a region's detected pitch: the root note becomes the detected note and the fine
 * tune corrects its detuning, so that key sounds in tune. Unpitched audio keeps the defaults.
 */
function tuneToRegion(ins: Instrument, from: number, to: number): string {
  const loaded = samples.get(ins.sampleId);
  const n = loaded && detectNote(channelsOf(loaded.buffer), loaded.buffer.sampleRate, from, to);
  if (!n || n.clarity < 0.85 || n.midi < 0 || n.midi > 127) return '';
  ins.rootNote = n.midi;
  ins.fineTune = Math.max(-100, Math.min(100, -n.cents));
  return ` Root set to ${noteName(n.midi)} (detected${n.cents ? `, ${n.cents > 0 ? '+' : ''}${n.cents} ct` : ''}).`;
}

export function instrumentFromSample(sampleId: string): Instrument | null {
  const meta = project.samples.find((s) => s.id === sampleId);
  if (!meta) return null;
  const ins = createInstrument(meta);
  const note = tuneToRegion(ins, 0, meta.duration);
  commit('new instrument', (p) => p.instruments.push(ins), { checkOverlaps: false });
  setUi('tracker', 'instrumentId', ins.id);
  setUi('selection', { kind: 'instrument', id: ins.id });
  if (note) toast(`Instrument “${ins.name}” created.${note}`, 'info', 3000);
  return ins;
}

/** Make an instrument from an audio clip's region. */
export function instrumentFromClip(clipId: string) {
  const c = project.clips.find((x) => x.id === clipId) as AudioClip | undefined;
  if (!c) return;
  instrumentFromRegion(c.sampleId, c.srcStart, c.srcEnd, c.name);
}

/** Make an instrument from any region of a sample. */
export function instrumentFromRegion(sampleId: string, from: number, to: number, name?: string) {
  const meta = project.samples.find((s) => s.id === sampleId);
  if (!meta) return;
  const ins = { ...createInstrument(meta, name ?? meta.name), start: from, end: to, loopStart: from, loopEnd: to };
  const note = tuneToRegion(ins, from, to);
  commit('new instrument', (p) => p.instruments.push(ins), { checkOverlaps: false });
  setUi('tracker', 'instrumentId', ins.id);
  setUi('selection', { kind: 'instrument', id: ins.id });
  if (note) toast(`Instrument “${ins.name}” created.${note}`, 'info', 3000);
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
