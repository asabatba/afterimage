import { describe, expect, it } from 'vitest';
import { createBundle, readBundle } from '../src/store/bundle';
import { createAudioClip, createProject } from '../src/model/project';
import { sample } from './helpers';

describe('project bundle', () => {
  it('round-trips the project and lossless sample audio', () => {
    const p = createProject('Bundle test');
    const s = { ...sample(0.001, 'sx'), frames: 48 };
    p.samples.push(s);
    p.clips.push(createAudioClip(s, p.tracks[0].id, 4, p.bpm));
    const ch = [Float32Array.from({ length: 48 }, (_, i) => Math.sin(i) * 0.7), Float32Array.from({ length: 48 }, (_, i) => i / 100)];
    const { zip, missing } = createBundle(p, () => ({ channels: ch, sampleRate: 48000 }));
    expect(missing).toEqual([]);
    const back = readBundle(zip);
    expect(back.project.name).toBe('Bundle test');
    expect(back.project.clips[0].start).toBe(4);
    expect(Array.from(back.samples[0].channels[0])).toEqual(Array.from(ch[0]));
    expect(Array.from(back.samples[0].channels[1])).toEqual(Array.from(ch[1]));
  });

  it('rejects other zips', () => {
    expect(() => readBundle(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
