// Core project data. Everything here is plain, serialisable JSON.
// Decoded audio never lives in the project: samples are referenced by id and
// their PCM data is held by the sample registry (src/store/samples.ts).

export type Id = string;

/** Times on the arrangement are in beats (quarter notes, 4/4). */
export type Beats = number;
/** Times inside a sample are in seconds. */
export type Seconds = number;

export type SampleKind = 'import' | 'recording' | 'print';

export interface SampleSourceRef {
  /** What was captured: an input device, a track or the master bus. */
  source: 'input' | 'track' | 'master';
  trackId?: Id;
  trackName?: string;
  deviceLabel?: string;
  /** Captured arrangement range, in beats. */
  startBeat: Beats;
  endBeat: Beats;
  bpm: number;
  /** Ids of the clips that were sounding in the captured range (prints only). */
  clipIds?: Id[];
  /** Ids of the samples those clips used (prints only). */
  sampleIds?: Id[];
}

export interface SampleMeta {
  id: Id;
  name: string;
  kind: SampleKind;
  sampleRate: number;
  channels: number;
  /** Length in frames. */
  frames: number;
  duration: Seconds;
  createdAt: number;
  /** Original file name for imports. */
  fileName?: string;
  /** For recordings and prints: where the audio came from. */
  capture?: SampleSourceRef;
  /** Beat length of tempo-bound captures. */
  beats?: number;
  /** Tempo the sample was captured at (tempo-bound captures). */
  bpm?: number;
}

export type TimingMode = 'free' | 'tempo';

interface ClipBase {
  id: Id;
  trackId: Id;
  /** Arrangement position, beats. */
  start: Beats;
  /** Length on the arrangement, beats. */
  length: Beats;
  name?: string;
}

export interface AudioClip extends ClipBase {
  kind: 'audio';
  sampleId: Id;
  /** Region of the sample this clip plays, seconds. */
  srcStart: Seconds;
  srcEnd: Seconds;
  /** When true the region repeats to fill the clip; otherwise length follows the content. */
  loop: boolean;
  /** For looped clips: where in the (stretched) region playback begins, in beats of output. */
  loopOffset: Beats;
  gainDb: number;
  /** Fade lengths in beats. */
  fadeIn: Beats;
  fadeOut: Beats;
  /** Pitch shift that preserves duration (ignored in repitch mode). */
  semitones: number;
  cents: number;
  timing: TimingMode;
  /** Free mode: output duration / source duration (1 = original speed). */
  stretch: number;
  /** Tempo mode: tempo the region was played at. */
  sourceBpm: number;
  /** Couple speed and pitch, like a tape/sampler (no time-stretch processing). */
  repitch: boolean;
}

export interface PatternClip extends ClipBase {
  kind: 'pattern';
  patternId: Id;
  /** Where in the pattern this clip starts, beats (slip). */
  offset: Beats;
}

export type Clip = AudioClip | PatternClip;

export const NOTE_OFF = -1;

export type FxCode = 'O' | 'R' | 'P' | 'F' | 'D' | 'V';

export interface Cell {
  /** MIDI note number, or NOTE_OFF. */
  note?: number;
  instrumentId?: Id;
  /** 0..128 (0x00..0x80). Undefined = full. */
  vel?: number;
  fx?: FxCode;
  /** 0..255 */
  fxValue?: number;
}

export interface Pattern {
  id: Id;
  name: string;
  rows: number;
  rowsPerBeat: number;
  /** Number of note columns (chords use several). */
  columns: number;
  /** 0..0.5 — fraction of a row by which odd rows are delayed. */
  swing: number;
  /** cells[row][column]; null when empty. */
  cells: (Cell | null)[][];
}

export interface Envelope {
  attack: Seconds;
  decay: Seconds;
  sustain: number; // 0..1
  release: Seconds;
}

export interface Instrument {
  id: Id;
  name: string;
  sampleId: Id;
  /** MIDI note at which the sample plays at its original pitch. */
  rootNote: number;
  /** Fine tune in cents. */
  fineTune: number;
  /** Region of the sample used by the instrument. */
  start: Seconds;
  end: Seconds;
  env: Envelope;
  loop: boolean;
  loopStart: Seconds;
  loopEnd: Seconds;
  filterCutoff: number; // Hz
  filterQ: number;
  gainDb: number;
}

export interface Track {
  id: Id;
  name: string;
  color: 'amber' | 'blue' | 'ivory' | 'rust' | 'sage';
  volumeDb: number;
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  /** Track low-pass cutoff, Hz (20000 = open). */
  lowpass: number;
  delaySend: number; // 0..1
  reverbSend: number; // 0..1
}

export interface Marker {
  id: Id;
  beat: Beats;
  name: string;
}

export interface FxSettings {
  /** Delay time in beats. */
  delayBeats: number;
  delayFeedback: number;
  delayTone: number; // Hz
  delayReturn: number; // 0..1
  reverbSeconds: number;
  reverbPreDelayMs: number;
  reverbReturn: number; // 0..1
}

export interface Project {
  id: Id;
  version: 1;
  name: string;
  bpm: number;
  tracks: Track[];
  clips: Clip[];
  patterns: Pattern[];
  instruments: Instrument[];
  samples: SampleMeta[];
  markers: Marker[];
  loop: { enabled: boolean; start: Beats; end: Beats };
  fx: FxSettings;
  masterDb: number;
  createdAt: number;
  updatedAt: number;
}
