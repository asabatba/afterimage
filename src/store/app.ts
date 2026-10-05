// Application state: the project (Solid store), UI state, undo history and
// the audio singletons. Decoded audio stays in the SampleRegistry.
import { createSignal, batch } from 'solid-js';
import { createStore, produce, reconcile, unwrap } from 'solid-js/store';
import type { Project } from '../model/types';
import { createProject } from '../model/project';
import { History } from '../model/history';
import { normalizeClip } from '../model/timing';
import { checkOverlaps } from '../model/clips';
import { AudioEngine } from '../audio/engine';
import { SampleRegistry } from '../audio/samples';
import { CaptureManager } from '../audio/capture';

// ── Project ──────────────────────────────────────────────────────────────

export const [project, setProject] = createStore<Project>(createProject());
/** Plain (non-reactive) view of the project for the audio engine. */
export const rawProject = () => unwrap(project);

// ── UI state ─────────────────────────────────────────────────────────────

export type Selection =
  | { kind: 'none' }
  | { kind: 'clips'; ids: string[] }
  | { kind: 'instrument'; id: string };

export interface UiState {
  selection: Selection;
  snap: boolean;
  grid: number; // beats
  pxPerBeat: number;
  trackHeight: number;
  poolOpen: boolean;
  captureOpen: boolean;
  bottomTab: 'detail' | 'mixer';
  bottomOpen: boolean;
  bottomHeight: number;
  metronome: boolean;
  /** Insertion point (where play starts), beats. */
  cursor: number;
  followPlayhead: boolean;
  exportOpen: boolean;
  projectsOpen: boolean;
  saveState: 'saved' | 'saving' | 'error' | 'idle';
  savedAt: number;
  tracker: {
    octave: number;
    step: number;
    instrumentId: string | null;
    row: number;
    col: number;
    field: number; // 0 note, 1-2 instrument, 3-4 velocity, 5 fx, 6-7 fx value
    block: { row0: number; row1: number; col0: number; col1: number } | null;
  };
  capture: {
    source: 'input' | 'master' | string; // string = track id
    destTrackId: string | null;
    countInBars: number;
    length: 'free' | 'bars' | 'loop';
    bars: number;
    offsetMs: number;
    mono: boolean;
    deviceId: string;
  };
}

export const [ui, setUi] = createStore<UiState>({
  selection: { kind: 'none' },
  snap: true,
  grid: 0.25,
  pxPerBeat: 28,
  trackHeight: 68,
  poolOpen: true,
  captureOpen: false,
  bottomTab: 'detail',
  bottomOpen: true,
  bottomHeight: 300,
  metronome: false,
  cursor: 0,
  followPlayhead: true,
  exportOpen: false,
  projectsOpen: false,
  saveState: 'idle',
  savedAt: 0,
  tracker: { octave: 4, step: 1, instrumentId: null, row: 0, col: 0, field: 0, block: null },
  capture: {
    source: 'input',
    destTrackId: null,
    countInBars: 1,
    length: 'free',
    bars: 4,
    offsetMs: 0,
    mono: false,
    deviceId: '',
  },
});

export const [playing, setPlaying] = createSignal(false);
export const [playhead, setPlayhead] = createSignal(0);
export const [samplesVersion, setSamplesVersion] = createSignal(0);

// ── Toasts ───────────────────────────────────────────────────────────────

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'warn';
  text: string;
}
const [toasts, setToasts] = createSignal<Toast[]>([]);
export { toasts };
let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = kind === 'error' ? 9000 : 3500) {
  const id = ++toastId;
  setToasts((t) => [...t.slice(-4), { id, kind, text }]);
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
}
export const dismissToast = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

// ── Audio singletons ─────────────────────────────────────────────────────

export const samples = new SampleRegistry();
samples.onAdd(() => setSamplesVersion((v) => v + 1));

let _ctx: AudioContext | null = null;
let _engine: AudioEngine | null = null;
let _capture: CaptureManager | null = null;

export function audio() {
  if (!_ctx) {
    _ctx = new AudioContext({ latencyHint: 'interactive' });
    _engine = new AudioEngine(_ctx, { project: rawProject, samples });
    _engine.onPlayState((p) => setPlaying(p));
    _capture = new CaptureManager(_engine);
  }
  return { ctx: _ctx, engine: _engine!, capture: _capture! };
}

// ── Undo history ─────────────────────────────────────────────────────────

const history = new History<Project>();
const [historyVersion, setHistoryVersion] = createSignal(0);
export const canUndo = () => (historyVersion(), history.canUndo);
export const canRedo = () => (historyVersion(), history.canRedo);
export const undoLabel = () => (historyVersion(), history.undoLabel);

const snapshot = (): Project => structuredClone(unwrap(project));
let gestureBefore: Project | null = null;

/**
 * Apply an edit with undo. `fn` mutates a draft of the project.
 * Returns false (and reverts) if the edit leaves illegal clip overlaps.
 */
export function commit(label: string, fn: (p: Project) => void, opts: { checkOverlaps?: boolean; quiet?: boolean } = {}): boolean {
  const before = gestureBefore ?? snapshot();
  setProject(produce((p) => {
    fn(p);
    p.updatedAt = Date.now();
  }));
  if (opts.checkOverlaps !== false) {
    const problem = checkOverlaps(project.clips);
    if (problem) {
      setProject(reconcile(before));
      if (!opts.quiet) overlapToast(problem.reason);
      return false;
    }
  }
  if (!gestureBefore) {
    history.push(before, label);
    setHistoryVersion((v) => v + 1);
  }
  return true;
}

export function overlapToast(reason: 'too-many-layers' | 'contained') {
  toast(
    reason === 'too-many-layers'
      ? 'Only two clips can overlap on a track (as a crossfade). Put extra layers on another track.'
      : 'A clip can’t sit entirely inside another on the same track. Use another track for layering.',
    'warn',
  );
}

/** Start a continuous edit (drag): live updates without history until `endGesture`. */
export function beginGesture() {
  gestureBefore = snapshot();
}

/** Live update during a gesture (no history, no overlap check). */
export function live(fn: (p: Project) => void) {
  setProject(produce(fn));
}

/** Finish a gesture. Reverts if overlaps are illegal; records one undo step otherwise. */
export function endGesture(label: string, changed = true): boolean {
  const before = gestureBefore;
  gestureBefore = null;
  if (!before || !changed) return true;
  const problem = checkOverlaps(project.clips);
  if (problem) {
    setProject(reconcile(before));
    overlapToast(problem.reason);
    return false;
  }
  history.push(before, label);
  setHistoryVersion((v) => v + 1);
  setProject('updatedAt', Date.now());
  return true;
}

export function cancelGesture() {
  if (gestureBefore) setProject(reconcile(gestureBefore));
  gestureBefore = null;
}

export function undo() {
  const e = history.undo(snapshot());
  if (!e) return;
  batch(() => {
    setProject(reconcile(e.state));
    pruneSelection();
  });
  setHistoryVersion((v) => v + 1);
  toast(`Undo ${e.label}`, 'info', 1200);
}

export function redo() {
  const e = history.redo(snapshot());
  if (!e) return;
  batch(() => {
    setProject(reconcile(e.state));
    pruneSelection();
  });
  setHistoryVersion((v) => v + 1);
  toast(`Redo ${e.label}`, 'info', 1200);
}

export function resetHistory() {
  history.clear();
  setHistoryVersion((v) => v + 1);
}

function pruneSelection() {
  const s = ui.selection;
  if (s.kind === 'clips') {
    const ids = s.ids.filter((id) => project.clips.some((c) => c.id === id));
    setUi('selection', ids.length ? { kind: 'clips', ids } : { kind: 'none' });
  } else if (s.kind === 'instrument' && !project.instruments.some((i) => i.id === s.id)) {
    setUi('selection', { kind: 'none' });
  }
}

/** Re-derive lengths of non-looping clips (after tempo or content changes). */
export function normalizeAll(p: Project) {
  p.clips = p.clips.map((c) => normalizeClip(c, p.bpm));
}

// ── Selection helpers ────────────────────────────────────────────────────

export const selectedClipIds = () => (ui.selection.kind === 'clips' ? ui.selection.ids : []);
export const isSelected = (id: string) => ui.selection.kind === 'clips' && ui.selection.ids.includes(id);
export function selectClips(ids: string[], additive = false) {
  if (additive && ui.selection.kind === 'clips') {
    const set = new Set(ui.selection.ids);
    ids.forEach((id) => (set.has(id) ? set.delete(id) : set.add(id)));
    setUi('selection', set.size ? { kind: 'clips', ids: [...set] } : { kind: 'none' });
  } else setUi('selection', ids.length ? { kind: 'clips', ids } : { kind: 'none' });
}
