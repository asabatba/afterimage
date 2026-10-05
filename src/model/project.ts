import { contentLengthBeats, normalizeClip } from './timing';
import type { AudioClip, Instrument, Pattern, PatternClip, Project, SampleMeta, Track } from './types';

let counter = 0;
export function newId(prefix = ''): string {
  counter = (counter + 1) % 1e6;
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${rnd}`;
}

const TRACK_COLORS: Track['color'][] = ['amber', 'blue', 'amber', 'blue', 'sage', 'rust', 'ivory', 'blue'];

export function createTrack(index: number): Track {
  return {
    id: newId('t'),
    name: `Track ${index + 1}`,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    volumeDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    lowpass: 20000,
    delaySend: 0,
    reverbSend: 0,
  };
}

export function createProject(name = 'Untitled collage'): Project {
  const now = Date.now();
  return {
    id: newId('p'),
    version: 1,
    name,
    bpm: 120,
    tracks: Array.from({ length: 8 }, (_, i) => createTrack(i)),
    clips: [],
    patterns: [],
    instruments: [],
    samples: [],
    markers: [],
    loop: { enabled: false, start: 0, end: 16 },
    fx: {
      delayBeats: 0.75,
      delayFeedback: 0.35,
      delayTone: 4500,
      delayReturn: 0.8,
      reverbSeconds: 2.4,
      reverbPreDelayMs: 18,
      reverbReturn: 0.8,
    },
    masterDb: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function createAudioClip(sample: SampleMeta, trackId: string, start: number, bpm: number, extra: Partial<AudioClip> = {}): AudioClip {
  const clip: AudioClip = {
    id: newId('c'),
    kind: 'audio',
    trackId,
    start,
    length: 0,
    name: sample.name,
    sampleId: sample.id,
    srcStart: 0,
    srcEnd: sample.duration,
    loop: false,
    loopOffset: 0,
    gainDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    semitones: 0,
    cents: 0,
    timing: 'free',
    stretch: 1,
    sourceBpm: bpm,
    repitch: false,
    ...extra,
  };
  if (clip.loop && clip.length <= 0) clip.length = contentLengthBeats(clip, bpm);
  return normalizeClip(clip, bpm);
}

export function createPatternClip(pattern: Pattern, trackId: string, start: number): PatternClip {
  return {
    id: newId('c'),
    kind: 'pattern',
    trackId,
    start,
    length: pattern.rows / pattern.rowsPerBeat,
    name: pattern.name,
    patternId: pattern.id,
    offset: 0,
  };
}

export function createInstrument(sample: SampleMeta, name?: string): Instrument {
  return {
    id: newId('i'),
    name: name ?? sample.name,
    sampleId: sample.id,
    rootNote: 60,
    fineTune: 0,
    start: 0,
    end: sample.duration,
    env: { attack: 0.002, decay: 0.2, sustain: 1, release: 0.08 },
    loop: false,
    loopStart: 0,
    loopEnd: sample.duration,
    filterCutoff: 20000,
    filterQ: 0.7,
    gainDb: 0,
  };
}

/** Bring older or hand-edited project JSON up to the current shape. */
export function migrateProject(raw: any): Project {
  const base = createProject(raw?.name);
  const p: Project = { ...base, ...raw, fx: { ...base.fx, ...(raw?.fx ?? {}) }, loop: { ...base.loop, ...(raw?.loop ?? {}) } };
  p.version = 1;
  p.tracks = (p.tracks ?? []).map((t: Track, i: number) => ({ ...createTrack(i), ...t }));
  p.clips = p.clips ?? [];
  p.patterns = p.patterns ?? [];
  p.instruments = p.instruments ?? [];
  p.samples = p.samples ?? [];
  p.markers = p.markers ?? [];
  return p;
}
