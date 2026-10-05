// IndexedDB persistence via Dexie: project JSON autosave, immutable sample PCM,
// and a small key/value table for session recovery.
import Dexie, { type Table } from 'dexie';
import type { Project } from '../model/types';

export interface ProjectRow {
  id: string;
  name: string;
  json: string;
  updatedAt: number;
}

export interface SampleRow {
  id: string;
  projectId: string;
  sampleRate: number;
  /** One Float32 PCM buffer per channel. */
  channels: ArrayBuffer[];
}

export interface KvRow {
  key: string;
  value: unknown;
}

class AfterimageDB extends Dexie {
  projects!: Table<ProjectRow, string>;
  samples!: Table<SampleRow, string>;
  kv!: Table<KvRow, string>;
  constructor() {
    super('afterimage');
    this.version(1).stores({
      projects: 'id, updatedAt',
      samples: 'id, projectId',
      kv: 'key',
    });
  }
}

export const db = new AfterimageDB();

export async function saveProject(p: Project) {
  await db.projects.put({ id: p.id, name: p.name, json: JSON.stringify(p), updatedAt: Date.now() });
}

export async function saveSample(projectId: string, id: string, sampleRate: number, channels: Float32Array[]) {
  await db.samples.put({
    id,
    projectId,
    sampleRate,
    channels: channels.map((c) => c.slice().buffer as ArrayBuffer),
  });
}

export async function loadProjectRow(id: string) {
  return db.projects.get(id);
}

export async function loadSamples(projectId: string) {
  return db.samples.where('projectId').equals(projectId).toArray();
}

export async function listProjects() {
  return db.projects.orderBy('updatedAt').reverse().toArray();
}

export async function deleteProject(id: string) {
  await db.transaction('rw', db.projects, db.samples, async () => {
    await db.projects.delete(id);
    await db.samples.where('projectId').equals(id).delete();
  });
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  return (await db.kv.get(key))?.value as T | undefined;
}

export async function setKv(key: string, value: unknown) {
  await db.kv.put({ key, value });
}
