// Portable project bundle: a ZIP with the project JSON and every sample as a
// lossless 32-bit float WAV.
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import type { Project } from '../model/types';
import { decodeWav, encodeWav } from '../model/wav';
import { migrateProject } from '../model/project';

export const BUNDLE_EXT = '.afterimage.zip';

export interface BundleSample {
  id: string;
  sampleRate: number;
  channels: Float32Array[];
}

export function createBundle(project: Project, getChannels: (id: string) => { channels: Float32Array[]; sampleRate: number } | undefined) {
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 | 1 | 6 }]> = {};
  const missing: string[] = [];
  for (const s of project.samples) {
    const data = getChannels(s.id);
    if (!data) {
      missing.push(s.name);
      continue;
    }
    files[`samples/${s.id}.wav`] = [encodeWav(data.channels, data.sampleRate, 'f32'), { level: 1 }];
  }
  const manifest = { format: 'afterimage-bundle', version: 1, exportedAt: new Date().toISOString(), project };
  files['afterimage.json'] = [strToU8(JSON.stringify(manifest, null, 1)), { level: 6 }];
  return { zip: zipSync(files as any), missing };
}

export function readBundle(bytes: Uint8Array): { project: Project; samples: BundleSample[] } {
  const files = unzipSync(bytes);
  const manifestBytes = files['afterimage.json'];
  if (!manifestBytes) throw new Error('This file is not an AFTERIMAGE bundle (no afterimage.json).');
  const manifest = JSON.parse(strFromU8(manifestBytes));
  if (manifest.format !== 'afterimage-bundle') throw new Error('Unknown bundle format.');
  const project = migrateProject(manifest.project);
  const samples: BundleSample[] = [];
  for (const s of project.samples) {
    const wav = files[`samples/${s.id}.wav`];
    if (!wav) throw new Error(`Bundle is missing audio for “${s.name}”.`);
    const d = decodeWav(wav);
    samples.push({ id: s.id, sampleRate: d.sampleRate, channels: d.channels });
  }
  return { project, samples };
}
