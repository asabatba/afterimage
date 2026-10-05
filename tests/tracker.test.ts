import { describe, expect, it } from 'vitest';
import { createPatternClip } from '../src/model/project';
import {
  clipEventsInRange,
  clonePattern,
  copyBlock,
  createPattern,
  keyToNote,
  noteName,
  pasteBlock,
  patternEvents,
  resizePattern,
  rowTime,
  setCell,
  transposeBlock,
} from '../src/model/tracker';
import { NOTE_OFF } from '../src/model/types';

describe('tracker', () => {
  it('defaults to 64 rows at four rows per beat', () => {
    const p = createPattern('A');
    expect(p.rows).toBe(64);
    expect(p.rowsPerBeat).toBe(4);
    expect(p.cells).toHaveLength(64);
  });

  it('names notes and maps the keyboard', () => {
    expect(noteName(60)).toBe('C-4');
    expect(noteName(61)).toBe('C#4');
    expect(noteName(NOTE_OFF)).toBe('═══');
    expect(keyToNote('KeyZ', 4)).toBe(60);
    expect(keyToNote('KeyQ', 4)).toBe(72);
    expect(keyToNote('KeyA', 4)).toBeNull();
  });

  it('swing delays odd rows only', () => {
    const p = { ...createPattern('A'), swing: 0.5 };
    expect(rowTime(p, 0)).toBe(0);
    expect(rowTime(p, 1)).toBeCloseTo(0.25 + 0.125);
    expect(rowTime(p, 2)).toBe(0.5);
  });

  it('note durations run to the next note or note-off in the same column', () => {
    let p = createPattern('A', 16);
    p = setCell(p, 0, 0, { note: 60, instrumentId: 'i1' });
    p = setCell(p, 4, 0, { note: NOTE_OFF });
    p = setCell(p, 0, 1, { note: 64, vel: 0x40 });
    p = setCell(p, 8, 1, { note: 67 });
    p = setCell(p, 2, 1, { fx: 'P', fxValue: 0 });
    const ev = patternEvents(p);
    const notes = ev.filter((e) => e.kind === 'note') as any[];
    expect(notes).toHaveLength(3);
    const c0 = notes.find((n) => n.col === 0);
    expect(c0.duration).toBe(1);
    const chord = notes.filter((n) => n.row === 0);
    expect(chord).toHaveLength(2);
    expect(chord.find((n) => n.col === 1).vel).toBe(0.5);
    const last = notes.find((n) => n.note === 67);
    expect(last.duration).toBe(2); // to the end of a 16-row pattern
    expect(ev.find((e) => e.kind === 'fx')).toMatchObject({ fx: 'P', time: 0.5 });
  });

  it('remembers the last instrument in a column', () => {
    let p = createPattern('A', 8);
    p = setCell(p, 0, 0, { note: 60, instrumentId: 'i2' });
    p = setCell(p, 2, 0, { note: 62 });
    const notes = patternEvents(p) as any[];
    expect(notes[1].instrumentId).toBe('i2');
  });

  it('places repeating events inside a clip with offset', () => {
    let p = createPattern('A', 8, 4); // 2 beats long
    p = setCell(p, 0, 0, { note: 60 });
    const ev = patternEvents(p);
    const clip = { ...createPatternClip(p, 't', 10), length: 5, offset: 1 };
    const placed = clipEventsInRange(clip, p, ev, 0, 100);
    // pattern origin at 9; notes at 11 and 13 (9 is before the clip start)
    expect(placed.map((x) => x.beat)).toEqual([11, 13]);
    expect(placed[1].end).toBe(15); // clipped at clip end
    expect(clipEventsInRange(clip, p, ev, 11.5, 13)).toHaveLength(0);
  });

  it('copies, pastes and transposes blocks', () => {
    let p = createPattern('A', 8, 4, 2);
    p = setCell(p, 0, 0, { note: 60 });
    p = setCell(p, 1, 1, { note: NOTE_OFF });
    const data = copyBlock(p, { row0: 0, row1: 1, col0: 0, col1: 1 });
    p = pasteBlock(p, 4, 0, data);
    expect(p.cells[4][0]?.note).toBe(60);
    expect(p.cells[5][1]?.note).toBe(NOTE_OFF);
    p = transposeBlock(p, { row0: 0, row1: 7, col0: 0, col1: 1 }, 12);
    expect(p.cells[0][0]?.note).toBe(72);
    expect(p.cells[5][1]?.note).toBe(NOTE_OFF);
  });

  it('clearing a cell field removes empty cells', () => {
    let p = createPattern('A', 4, 4, 1);
    p = setCell(p, 0, 0, { note: 60 });
    p = setCell(p, 0, 0, { note: undefined });
    expect(p.cells[0][0]).toBeNull();
  });

  it('resizes and clones without sharing cells', () => {
    let p = createPattern('A', 4, 4, 1);
    p = setCell(p, 0, 0, { note: 60 });
    const r = resizePattern(p, 8, 2);
    expect(r.cells).toHaveLength(8);
    expect(r.cells[0]).toHaveLength(2);
    const c = clonePattern(p);
    expect(c.id).not.toBe(p.id);
    expect(c.cells[0][0]).not.toBe(p.cells[0][0]);
  });
});
