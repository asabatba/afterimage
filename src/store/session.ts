// Project lifecycle: startup recovery, autosave, new/open/delete, bundles.
import { createEffect, on } from 'solid-js';
import { reconcile, unwrap } from 'solid-js/store';
import { bufferFromChannels, channelsOf } from '../audio/samples';
import { createProject, migrateProject } from '../model/project';
import type { Project } from '../model/types';
import { download } from './actions';
import { audio, project, resetHistory, samples, setPlayhead, setProject, setUi, toast, ui } from './app';
import { BUNDLE_EXT, createBundle, readBundle } from './bundle';
import * as db from './db';

const SESSION_KEY = 'session';
interface SessionInfo {
  projectId: string;
  clean: boolean;
}

let loading = false;

async function loadIntoApp(p: Project) {
  loading = true;
  try {
    audio().engine.stop();
    samples.clear();
    const rows = await db.loadSamples(p.id);
    for (const r of rows)
      samples.add(
        r.id,
        bufferFromChannels(
          r.channels.map((b) => new Float32Array(b)),
          r.sampleRate,
        ),
      );
    const missing = p.samples.filter((s) => !samples.has(s.id));
    setProject(reconcile(p));
    resetHistory();
    setUi({
      selection: { kind: 'none' },
      cursor: 0,
      tracker: { ...ui.tracker, instrumentId: p.instruments[0]?.id ?? null, row: 0, col: 0, field: 0, block: null },
      capture: { ...ui.capture, destTrackId: p.tracks[0]?.id ?? null },
    });
    setPlayhead(0);
    if (missing.length)
      toast(
        `${missing.length} sample${missing.length > 1 ? 's are' : ' is'} missing audio in browser storage: ${missing.map((m) => m.name).join(', ')}.`,
        'error',
        0,
      );
    await db.setKv(SESSION_KEY, { projectId: p.id, clean: false } satisfies SessionInfo);
  } finally {
    loading = false;
  }
}

/** On startup: reopen the last project; mention recovery if the last session didn't close cleanly. */
export async function startSession() {
  try {
    const info = await db.getKv<SessionInfo>(SESSION_KEY);
    const row = info && (await db.loadProjectRow(info.projectId));
    if (row) {
      await loadIntoApp(migrateProject(JSON.parse(row.json)));
      if (!info!.clean) toast(`Recovered “${row.name}” from autosave (${new Date(row.updatedAt).toLocaleTimeString()}).`, 'info', 5000);
    } else {
      const p = createProject();
      await loadIntoApp(p);
      await db.saveProject(p);
    }
  } catch (e: any) {
    toast(`Browser storage is unavailable (${e?.message ?? e}). Work won’t be autosaved — export bundles to keep it.`, 'error', 0);
    setUi('saveState', 'error');
  }
  const markClean = () => {
    void db.setKv(SESSION_KEY, { projectId: project.id, clean: true } satisfies SessionInfo);
  };
  window.addEventListener('pagehide', markClean);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') markClean();
    else void db.setKv(SESSION_KEY, { projectId: project.id, clean: false } satisfies SessionInfo);
  });
}

/** Debounced autosave of the project JSON whenever it changes. */
export function installAutosave() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  createEffect(
    on(
      () => JSON.stringify(project),
      () => {
        if (loading) return;
        setUi('saveState', 'saving');
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            await db.saveProject(unwrap(project));
            setUi({ saveState: 'saved', savedAt: Date.now() });
          } catch (e: any) {
            setUi('saveState', 'error');
            toast(`Autosave failed (${e?.message ?? e}). Export a bundle to keep your work safe.`, 'error', 0);
          }
        }, 600);
      },
      { defer: true },
    ),
  );
}

export async function newProject() {
  const p = createProject();
  await db.saveProject(p);
  await loadIntoApp(p);
  toast('New project.');
}

export async function openProject(id: string) {
  const row = await db.loadProjectRow(id);
  if (!row) return toast('That project no longer exists.', 'error');
  await db.saveProject(unwrap(project));
  await loadIntoApp(migrateProject(JSON.parse(row.json)));
}

export async function deleteProjectById(id: string) {
  await db.deleteProject(id);
  if (id === project.id) {
    const rest = await db.listProjects();
    if (rest[0]) await openProject(rest[0].id);
    else await newProject();
  }
}

export async function duplicateCurrentProject(name: string) {
  const copy = structuredClone(unwrap(project));
  copy.id = createProject().id;
  copy.name = name;
  copy.createdAt = copy.updatedAt = Date.now();
  await db.saveProject(copy);
  for (const s of copy.samples) {
    const l = samples.get(s.id);
    if (l) await db.saveSample(copy.id, s.id, l.buffer.sampleRate, channelsOf(l.buffer));
  }
  await loadIntoApp(copy);
}

export const listProjects = db.listProjects;

// ── Bundles ──────────────────────────────────────────────────────────────

export function exportBundle() {
  const { zip, missing } = createBundle(unwrap(project), (id) => {
    const s = samples.get(id);
    return s ? { channels: channelsOf(s.buffer), sampleRate: s.buffer.sampleRate } : undefined;
  });
  if (missing.length) toast(`Skipped samples with no audio: ${missing.join(', ')}`, 'warn');
  const safe = project.name.replace(/[^\w\- ]+/g, '').trim() || 'afterimage';
  download(new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), `${safe}${BUNDLE_EXT}`);
}

export async function importBundle(file: File) {
  try {
    const { project: p, samples: audioData } = readBundle(new Uint8Array(await file.arrayBuffer()));
    // Always import as a new project so nothing existing is overwritten.
    const fresh = createProject();
    p.id = fresh.id;
    p.updatedAt = Date.now();
    await db.saveProject(p);
    for (const s of audioData) await db.saveSample(p.id, s.id, s.sampleRate, s.channels);
    await openProject(p.id);
    toast(`Opened bundle “${p.name}” (${audioData.length} samples).`);
  } catch (e: any) {
    toast(e?.message ?? String(e), 'error');
  }
}
