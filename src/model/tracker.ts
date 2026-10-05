// Tracker pattern data and timing. Pure.
import type { Beats, Cell, FxCode, Pattern, PatternClip } from './types';
import { NOTE_OFF } from './types';
import { newId } from './project';
import { EPS, mod } from './timing';

export const FX_CODES: FxCode[] = ['O', 'R', 'P', 'F', 'D', 'V'];
export const FX_HELP: Record<FxCode, string> = {
  O: 'Offset — start point, 00–FF across the sample',
  R: 'Reverse — 01 plays backwards, 00 forwards',
  P: 'Pan — 00 left, 80 centre, FF right',
  F: 'Filter — low-pass cutoff, 00 dark … FF open',
  D: 'Delay send — 00–FF',
  V: 'Reverb send — 00–FF',
};

export const MAX_VEL = 0x80;

export function createPattern(name: string, rows = 64, rowsPerBeat = 4, columns = 4): Pattern {
  return {
    id: newId('pt'),
    name,
    rows,
    rowsPerBeat,
    columns,
    swing: 0,
    cells: Array.from({ length: rows }, () => Array.from({ length: columns }, () => null)),
  };
}

export function clonePattern(p: Pattern, name = `${p.name}′`): Pattern {
  return { ...p, id: newId('pt'), name, cells: p.cells.map((r) => r.map((c) => (c ? { ...c } : null))) };
}

export const patternLengthBeats = (p: Pattern): Beats => p.rows / p.rowsPerBeat;

export function resizePattern(p: Pattern, rows: number, columns: number): Pattern {
  rows = Math.max(1, Math.min(256, Math.round(rows)));
  columns = Math.max(1, Math.min(16, Math.round(columns)));
  const cells = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => p.cells[r]?.[c] ?? null),
  );
  return { ...p, rows, columns, cells };
}

/** Beat time of a row inside the pattern, with swing applied to odd rows. */
export function rowTime(p: Pattern, row: number): Beats {
  const rowLen = 1 / p.rowsPerBeat;
  return row * rowLen + (row % 2 === 1 ? p.swing * rowLen : 0);
}

// ── Note names ───────────────────────────────────────────────────────────

const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

/** MIDI 60 → "C-4". */
export function noteName(n: number | undefined): string {
  if (n === undefined) return '···';
  if (n === NOTE_OFF) return '═══';
  const oct = Math.floor(n / 12) - 1;
  return `${NAMES[mod(n, 12)]}${oct}`;
}

export const hex2 = (v: number | undefined) => (v === undefined ? '··' : v.toString(16).toUpperCase().padStart(2, '0'));

/** Two-row piano layout (FastTracker style). Returns semitone offset from the base octave's C. */
const KEY_OFFSETS: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21,
  Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

export function keyToNote(code: string, octave: number): number | null {
  const off = KEY_OFFSETS[code];
  if (off === undefined) return null;
  const n = (octave + 1) * 12 + off;
  return n >= 0 && n <= 127 ? n : null;
}

// ── Events ───────────────────────────────────────────────────────────────

export interface NoteEvent {
  kind: 'note';
  row: number;
  col: number;
  time: Beats; // within pattern
  duration: Beats; // until next note/off in the same column, or pattern end
  note: number;
  instrumentId?: string;
  vel: number; // 0..1
  fx?: FxCode;
  fxValue?: number;
}

export interface FxEvent {
  kind: 'fx';
  row: number;
  col: number;
  time: Beats;
  fx: FxCode;
  fxValue: number;
}

export type PatternEvent = NoteEvent | FxEvent;

/** Flatten a pattern into timed events. Effects on rows without a note modify the column's sounding voice. */
export function patternEvents(p: Pattern): PatternEvent[] {
  const out: PatternEvent[] = [];
  const total = patternLengthBeats(p);
  for (let col = 0; col < p.columns; col++) {
    let pending: NoteEvent | null = null;
    let lastInstrument: string | undefined;
    for (let row = 0; row < p.rows; row++) {
      const cell = p.cells[row]?.[col];
      if (!cell) continue;
      const t = rowTime(p, row);
      if (cell.note !== undefined) {
        if (pending) {
          pending.duration = t - pending.time;
          pending = null;
        }
        if (cell.note !== NOTE_OFF) {
          if (cell.instrumentId) lastInstrument = cell.instrumentId;
          pending = {
            kind: 'note',
            row,
            col,
            time: t,
            duration: total - t,
            note: cell.note,
            instrumentId: cell.instrumentId ?? lastInstrument,
            vel: (cell.vel ?? MAX_VEL) / MAX_VEL,
            fx: cell.fx,
            fxValue: cell.fx ? cell.fxValue ?? 0 : undefined,
          };
          out.push(pending);
        }
      } else if (cell.fx) {
        out.push({ kind: 'fx', row, col, time: t, fx: cell.fx, fxValue: cell.fxValue ?? 0 });
      }
    }
  }
  out.sort((a, b) => a.time - b.time || a.col - b.col);
  return out;
}

export interface PlacedEvent<E extends PatternEvent = PatternEvent> {
  event: E;
  /** Absolute arrangement beat. */
  beat: Beats;
  /** For notes: absolute end beat, clipped to the clip end. */
  end: Beats;
  /** Which pass through the pattern (to key voices uniquely). */
  pass: number;
}

/**
 * Events of a pattern clip falling in [from, to) on the arrangement.
 * The pattern repeats inside the clip, starting `offset` beats in.
 */
export function clipEventsInRange(clip: PatternClip, p: Pattern, events: PatternEvent[], from: Beats, to: Beats): PlacedEvent[] {
  const L = patternLengthBeats(p);
  const clipStart = clip.start;
  const clipEndBeat = clip.start + clip.length;
  const lo = Math.max(from, clipStart);
  const hi = Math.min(to, clipEndBeat);
  if (hi <= lo + EPS || L <= 0) return [];
  const origin = clipStart - clip.offset; // arrangement beat of pattern time 0 (pass 0)
  const firstPass = Math.floor((lo - origin) / L) - 1;
  const lastPass = Math.floor((hi - origin) / L) + 1;
  const out: PlacedEvent[] = [];
  for (let pass = firstPass; pass <= lastPass; pass++) {
    const passStart = origin + pass * L;
    for (const e of events) {
      const beat = passStart + e.time;
      if (beat < lo - EPS || beat >= hi - EPS) continue;
      if (beat < clipStart - EPS) continue;
      const end = e.kind === 'note' ? Math.min(beat + e.duration, clipEndBeat, passStart + L) : beat;
      out.push({ event: e, beat, end, pass });
    }
  }
  out.sort((a, b) => a.beat - b.beat);
  return out;
}

// ── Block editing ────────────────────────────────────────────────────────

export interface Block {
  row0: number;
  row1: number; // inclusive
  col0: number;
  col1: number; // inclusive
}

export function normBlock(b: Block): Block {
  return {
    row0: Math.min(b.row0, b.row1),
    row1: Math.max(b.row0, b.row1),
    col0: Math.min(b.col0, b.col1),
    col1: Math.max(b.col0, b.col1),
  };
}

export function copyBlock(p: Pattern, b: Block): (Cell | null)[][] {
  const n = normBlock(b);
  const out: (Cell | null)[][] = [];
  for (let r = n.row0; r <= n.row1; r++) {
    const row: (Cell | null)[] = [];
    for (let c = n.col0; c <= n.col1; c++) {
      const cell = p.cells[r]?.[c];
      row.push(cell ? { ...cell } : null);
    }
    out.push(row);
  }
  return out;
}

export function mapBlock(p: Pattern, b: Block, fn: (cell: Cell | null, row: number, col: number) => Cell | null): Pattern {
  const n = normBlock(b);
  const cells = p.cells.map((row, r) =>
    row.map((cell, c) => (r >= n.row0 && r <= n.row1 && c >= n.col0 && c <= n.col1 ? fn(cell, r, c) : cell)),
  );
  return { ...p, cells };
}

export const clearBlock = (p: Pattern, b: Block) => mapBlock(p, b, () => null);

export function pasteBlock(p: Pattern, row: number, col: number, data: (Cell | null)[][]): Pattern {
  const cells = p.cells.map((r) => r.slice());
  data.forEach((dr, i) =>
    dr.forEach((cell, j) => {
      const r = row + i, c = col + j;
      if (r < p.rows && c < p.columns) cells[r][c] = cell ? { ...cell } : null;
    }),
  );
  return { ...p, cells };
}

export function transposeBlock(p: Pattern, b: Block, semis: number): Pattern {
  return mapBlock(p, b, (cell) => {
    if (!cell || cell.note === undefined || cell.note === NOTE_OFF) return cell;
    return { ...cell, note: Math.max(0, Math.min(127, cell.note + semis)) };
  });
}

export function setCell(p: Pattern, row: number, col: number, patch: Partial<Cell> | null): Pattern {
  const cells = p.cells.map((r) => r.slice());
  if (patch === null) cells[row][col] = null;
  else {
    const merged: Cell = { ...(cells[row][col] ?? {}), ...patch };
    for (const k of Object.keys(merged) as (keyof Cell)[]) if (merged[k] === undefined) delete merged[k];
    cells[row][col] = Object.keys(merged).length ? merged : null;
  }
  return { ...p, cells };
}

/** Index of the row sounding at a pattern-relative beat (ignores swing). */
export function rowAtBeat(p: Pattern, beat: Beats): number {
  return Math.floor(mod(beat, patternLengthBeats(p)) * p.rowsPerBeat + EPS);
}
