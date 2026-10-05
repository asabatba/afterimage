import { For, Index, Show, createMemo, createSignal, createEffect, on } from 'solid-js';
import type { Cell, FxCode, Pattern, PatternClip } from '../model/types';
import { NOTE_OFF } from '../model/types';
import {
  FX_CODES,
  FX_HELP,
  copyBlock,
  hex2,
  keyToNote,
  normBlock,
  noteName,
  pasteBlock,
  patternLengthBeats,
  resizePattern,
  rowAtBeat,
  setCell,
  transposeBlock,
  clearBlock,
  type Block,
} from '../model/tracker';
import { audio, playhead, playing, project, setUi, ui } from '../store/app';
import { linkedCount, makeUnique, updatePattern } from '../store/actions';
import { NumberField, bindEdit } from './controls';

// Field layout inside a column: note | ins hi, ins lo | vel hi, vel lo | fx | fx hi, fx lo
const FIELDS = 8;
let clipboard: (Cell | null)[][] | null = null;

export function TrackerEditor(props: { clip: PatternClip }) {
  let grid!: HTMLDivElement;
  const pattern = () => project.patterns.find((p) => p.id === props.clip.patternId);
  const cur = () => ui.tracker;
  const [help, setHelp] = createSignal(false);
  const linked = () => linkedCount(props.clip.patternId);
  const insIndex = (id?: string) => (id ? project.instruments.findIndex((i) => i.id === id) : -1);

  const edit = (label: string, fn: (p: Pattern) => Pattern) => {
    const p = pattern();
    if (p) updatePattern(p.id, label, fn);
  };

  const playRow = createMemo(() => {
    const p = pattern();
    if (!p || !playing()) return -1;
    const b = playhead();
    if (b < props.clip.start || b >= props.clip.start + props.clip.length) return -1;
    return rowAtBeat(p, b - props.clip.start + props.clip.offset);
  });

  // Keep the cursor row (or the playing row) visible.
  createEffect(
    on([() => cur().row, playRow], ([row, pr]) => {
      const target = ui.followPlayhead && (pr as number) >= 0 ? (pr as number) : (row as number);
      grid?.querySelector(`[data-row="${target}"]`)?.scrollIntoView({ block: 'nearest' });
    }),
  );

  const move = (dRow: number, dField: number, extend: boolean) => {
    const p = pattern();
    if (!p) return;
    let { row, col, field } = cur();
    const anchor = cur().block && extend ? null : { row, col };
    row = Math.max(0, Math.min(p.rows - 1, row + dRow));
    let f = col * FIELDS + field + dField;
    f = Math.max(0, Math.min(p.columns * FIELDS - 1, f));
    // Skip the hidden second nibble positions when moving across columns quickly.
    col = Math.floor(f / FIELDS);
    field = f % FIELDS;
    if (extend) {
      const b = cur().block ?? { row0: anchor!.row, col0: anchor!.col, row1: row, col1: col };
      setUi('tracker', { row, col, field, block: { ...b, row1: row, col1: col } });
    } else setUi('tracker', { row, col, field, block: null });
  };

  const currentBlock = (): Block => cur().block ?? { row0: cur().row, row1: cur().row, col0: cur().col, col1: cur().col };

  // Chord entry: keys held together land in adjacent columns on the same row.
  const held = new Map<string, () => void>();
  let chord: { row: number; col: number; n: number } | null = null;

  const enterNote = (code: string) => {
    const p = pattern();
    if (!p) return false;
    const note = keyToNote(code, cur().octave);
    if (note === null) return false;
    if (held.has(code)) return true; // key repeat
    let row = cur().row, col = cur().col;
    if (chord && held.size > 0) {
      chord.n++;
      row = chord.row;
      col = Math.min(p.columns - 1, chord.col + chord.n);
    } else {
      chord = { row, col, n: 0 };
    }
    const insId = ui.tracker.instrumentId ?? project.instruments[0]?.id;
    edit('enter note', (pp) => setCell(pp, row, col, { note, instrumentId: insId }));
    const ins = project.instruments.find((i) => i.id === insId);
    held.set(code, ins ? audio().engine.auditionNote(ins, note) : () => {});
    if (chord.n === 0) setUi('tracker', { row: Math.min(p.rows - 1, row + cur().step), block: null });
    return true;
  };

  const releaseKey = (code: string) => {
    const r = held.get(code);
    if (r) {
      r();
      held.delete(code);
    }
    if (!held.size) chord = null;
  };

  const setHex = (digit: number) => {
    const p = pattern();
    if (!p) return;
    const { row, col, field } = cur();
    const cell = p.cells[row]?.[col] ?? {};
    const hiNib = field === 1 || field === 3 || field === 6;
    const merge = (old: number | undefined) => {
      const o = old ?? 0;
      return hiNib ? (digit << 4) | (o & 0xf) : (o & 0xf0) | digit;
    };
    if (field === 1 || field === 2) {
      const idx = merge(insIndex(cell.instrumentId) + 1) - 1;
      const ins = project.instruments[idx];
      if (!ins) return;
      edit('instrument', (pp) => setCell(pp, row, col, { instrumentId: ins.id }));
    } else if (field === 3 || field === 4) {
      edit('velocity', (pp) => setCell(pp, row, col, { vel: Math.min(0x80, merge(cell.vel ?? 0x80)) }));
    } else if (field === 6 || field === 7) {
      edit('effect value', (pp) => setCell(pp, row, col, { fxValue: merge(cell.fxValue), fx: cell.fx ?? 'P' }));
    }
    if (hiNib) setUi('tracker', 'field', field + 1);
    else setUi('tracker', { field: field - 1, row: Math.min(p.rows - 1, row + cur().step) });
  };

  const clearField = () => {
    const { row, col, field } = cur();
    if (cur().block) return edit('clear', (pp) => clearBlock(pp, cur().block!));
    if (field === 0) edit('clear', (pp) => setCell(pp, row, col, null));
    else if (field <= 2) edit('clear', (pp) => setCell(pp, row, col, { instrumentId: undefined }));
    else if (field <= 4) edit('clear', (pp) => setCell(pp, row, col, { vel: undefined }));
    else edit('clear', (pp) => setCell(pp, row, col, { fx: undefined, fxValue: undefined }));
    const p = pattern();
    if (p) setUi('tracker', 'row', Math.min(p.rows - 1, row + cur().step));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const p = pattern();
    if (!p) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (mod) {
      if (k === 'c' || k === 'x') {
        clipboard = copyBlock(p, currentBlock());
        if (k === 'x') edit('cut', (pp) => clearBlock(pp, currentBlock()));
        return handled();
      }
      if (k === 'v' && clipboard) {
        edit('paste', (pp) => pasteBlock(pp, cur().row, cur().col, clipboard!));
        return handled();
      }
      if (k === 'a') {
        setUi('tracker', 'block', { row0: 0, row1: p.rows - 1, col0: 0, col1: p.columns - 1 });
        return handled();
      }
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        const semis = (k === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        edit('transpose', (pp) => transposeBlock(pp, currentBlock(), semis));
        return handled();
      }
      return; // let undo/redo etc. through
    }
    switch (k) {
      case 'ArrowUp':
        move(-1, 0, e.shiftKey);
        return handled();
      case 'ArrowDown':
        move(1, 0, e.shiftKey);
        return handled();
      case 'ArrowLeft':
        move(0, e.shiftKey ? -FIELDS : -1, false);
        return handled();
      case 'ArrowRight':
        move(0, e.shiftKey ? FIELDS : 1, false);
        return handled();
      case 'Tab':
        setUi('tracker', { col: (cur().col + (e.shiftKey ? p.columns - 1 : 1)) % p.columns, field: 0, block: null });
        return handled();
      case 'PageUp':
        move(-16, 0, e.shiftKey);
        return handled();
      case 'PageDown':
        move(16, 0, e.shiftKey);
        return handled();
      case 'Home':
        setUi('tracker', { row: 0, block: null });
        return handled();
      case 'End':
        setUi('tracker', { row: p.rows - 1, block: null });
        return handled();
      case 'Delete':
      case 'Backspace':
        clearField();
        return handled();
      case 'Escape':
        setUi('tracker', 'block', null);
        return handled();
    }
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      setUi('tracker', 'octave', Math.max(0, Math.min(8, cur().octave + (e.code === 'BracketLeft' ? -1 : 1))));
      return handled();
    }
    if (e.repeat && cur().field === 0) return handled();
    const field = cur().field;
    if (field === 0) {
      if (e.code === 'Digit1' || e.code === 'Backquote') {
        edit('note off', (pp) => setCell(pp, cur().row, cur().col, { note: NOTE_OFF, instrumentId: undefined, vel: undefined }));
        setUi('tracker', 'row', Math.min(p.rows - 1, cur().row + cur().step));
        return handled();
      }
      if (enterNote(e.code)) return handled();
      return;
    }
    if (field === 5) {
      const code = k.toUpperCase() as FxCode;
      if (FX_CODES.includes(code)) {
        const cell = p.cells[cur().row]?.[cur().col];
        edit('effect', (pp) => setCell(pp, cur().row, cur().col, { fx: code, fxValue: cell?.fxValue ?? defaultFx(code) }));
        setUi('tracker', 'field', 6);
        return handled();
      }
      return;
    }
    if (/^[0-9a-f]$/i.test(k)) {
      setHex(parseInt(k, 16));
      return handled();
    }
  };

  const onKeyUp = (e: KeyboardEvent) => releaseKey(e.code);

  let dragging = false;
  const cellDown = (e: PointerEvent, row: number, col: number, field: number) => {
    e.preventDefault();
    grid.focus();
    if (e.shiftKey) {
      const b = cur().block ?? { row0: cur().row, col0: cur().col, row1: row, col1: col };
      setUi('tracker', { block: { ...b, row1: row, col1: col }, row, col, field });
    } else {
      setUi('tracker', { row, col, field, block: null });
      dragging = true;
      const up = () => {
        dragging = false;
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointerup', up);
    }
  };
  const cellEnter = (row: number, col: number) => {
    if (!dragging) return;
    const r0 = cur().block?.row0 ?? cur().row;
    const c0 = cur().block?.col0 ?? cur().col;
    if (r0 === row && c0 === col && !cur().block) return;
    setUi('tracker', 'block', { row0: r0, col0: c0, row1: row, col1: col });
  };

  const inBlock = (row: number, col: number) => {
    const b = cur().block;
    if (!b) return false;
    const n = normBlock(b);
    return row >= n.row0 && row <= n.row1 && col >= n.col0 && col <= n.col1;
  };

  const patternEdit = (label: string, fn: (p: Pattern, v: number) => Pattern) =>
    bindEdit(label, (proj, v) => {
      const i = proj.patterns.findIndex((x) => x.id === props.clip.patternId);
      if (i >= 0) proj.patterns[i] = fn(structuredClone(proj.patterns[i]), v);
    });

  return (
    <Show when={pattern()} fallback={<p class="detail-empty">This clip’s pattern is missing.</p>}>
      {(p) => (
        <div class="tracker">
          <div class="tracker-bar">
            <input
              class="name-input"
              aria-label="Pattern name"
              value={p().name}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              onChange={(e) => edit('rename pattern', (pp) => ({ ...pp, name: e.currentTarget.value }))}
            />
            <Show when={linked() > 1}>
              <span class="linked">
                Linked to {linked() - 1} other clip{linked() > 2 ? 's' : ''}
                <button type="button" class="text-btn" onClick={() => makeUnique(props.clip.id)}>
                  Make unique
                </button>
              </span>
            </Show>
            <NumberField label="Rows" value={p().rows} min={1} max={256} step={1} dragPx={3} edit={patternEdit('rows', (pp, v) => resizePattern(pp, v, pp.columns))} />
            <NumberField label="Rows/beat" value={p().rowsPerBeat} min={1} max={16} step={1} dragPx={10} edit={patternEdit('rows per beat', (pp, v) => ({ ...pp, rowsPerBeat: v }))} />
            <NumberField label="Columns" value={p().columns} min={1} max={16} step={1} dragPx={10} edit={patternEdit('columns', (pp, v) => resizePattern(pp, pp.rows, v))} />
            <NumberField label="Swing" value={p().swing * 100} min={0} max={50} step={1} dragPx={3} unit="%" format={(v) => v.toFixed(0)} edit={patternEdit('swing', (pp, v) => ({ ...pp, swing: v / 100 }))} title="Delays every second row; timing only" />
            <NumberField label="Octave" value={cur().octave} min={0} max={8} step={1} dragPx={10} edit={{ begin() {}, end() {}, change: (v) => setUi('tracker', 'octave', v) }} title="[ and ] change octave" />
            <NumberField label="Step" value={cur().step} min={0} max={16} step={1} dragPx={10} edit={{ begin() {}, end() {}, change: (v) => setUi('tracker', 'step', v) }} title="Rows to advance after entering a note" />
            <label class="tracker-ins">
              <span class="nf-label">Instrument</span>
              <select
                value={ui.tracker.instrumentId ?? ''}
                onChange={(e) => setUi('tracker', 'instrumentId', e.currentTarget.value || null)}
                disabled={!project.instruments.length}
              >
                <Show when={!project.instruments.length}>
                  <option value="">none yet</option>
                </Show>
                <For each={project.instruments}>{(ins, i) => <option value={ins.id}>{`${hex2(i() + 1)} ${ins.name}`}</option>}</For>
              </select>
            </label>
            <button type="button" class="ghost small" aria-expanded={help()} onClick={() => setHelp(!help())}>
              Keys
            </button>
          </div>

          <Show when={help()}>
            <div class="tracker-help">
              <p>
                Notes: <kbd>Z</kbd>–<kbd>M</kbd> and <kbd>Q</kbd>–<kbd>P</kbd> play two octaves; hold keys together for a chord. <kbd>1</kbd> enters note-off,{' '}
                <kbd>[</kbd> <kbd>]</kbd> change octave, <kbd>Delete</kbd> clears.
              </p>
              <p>
                Other fields take hex digits. Shift+arrows or drag select a block; <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>X</kbd>/<kbd>V</kbd> copy, cut, paste;{' '}
                <kbd>Ctrl</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> transpose (add <kbd>Shift</kbd> for octaves).
              </p>
              <ul>
                <For each={FX_CODES}>
                  {(c) => (
                    <li>
                      <b>{c}</b> {FX_HELP[c]}
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>

          <Show when={!project.instruments.length}>
            <p class="tracker-hint">Notes need an instrument: use “Instrument” on a sample in the pool, or “Make instrument” on an audio clip.</p>
          </Show>

          <div
            class="tracker-grid"
            ref={grid}
            tabIndex={0}
            role="grid"
            aria-label={`Pattern ${p().name}`}
            aria-rowcount={p().rows}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onBlur={() => [...held.keys()].forEach(releaseKey)}
            style={{ '--cols': p().columns }}
          >
            <div class="tr-row tr-head" role="row">
              <span class="tr-num" />
              <Index each={Array.from({ length: p().columns })}>
                {(_, c) => (
                  <span class="tr-col-head" role="columnheader">
                    {c + 1}
                  </span>
                )}
              </Index>
            </div>
            <Index each={p().cells}>
              {(row, r) => (
                <div
                  class="tr-row"
                  role="row"
                  data-row={r}
                  classList={{
                    beat: r % p().rowsPerBeat === 0,
                    bar: r % (p().rowsPerBeat * 4) === 0,
                    'play-row': playRow() === r,
                    'cursor-row': cur().row === r,
                  }}
                >
                  <span class="tr-num">{String(r).padStart(2, '0')}</span>
                  <Index each={row()}>
                    {(cell, c) => {
                      const at = (f: number) => cur().row === r && cur().col === c && cur().field === f;
                      const v = () => cell();
                      const ins = () => {
                        const i = insIndex(v()?.instrumentId);
                        return i >= 0 ? hex2(i + 1) : v()?.instrumentId ? '??' : '··';
                      };
                      const field = (f: number, text: string, cls: string) => (
                        <span class={`tr-f ${cls}`} classList={{ cur: at(f) }} onPointerDown={(e) => cellDown(e, r, c, f)}>
                          {text}
                        </span>
                      );
                      return (
                        <span
                          class="tr-cell"
                          role="gridcell"
                          classList={{ sel: inBlock(r, c), off: v()?.note === NOTE_OFF, empty: !v() }}
                          onPointerEnter={() => cellEnter(r, c)}
                        >
                          {field(0, noteName(v()?.note), 'note')}
                          {field(1, ins()[0], 'ins g')}
                          {field(2, ins()[1], 'ins')}
                          {field(3, hex2(v()?.vel)[0], 'vel g')}
                          {field(4, hex2(v()?.vel)[1], 'vel')}
                          {field(5, v()?.fx ?? '·', 'fx g')}
                          {field(6, v()?.fx ? hex2(v()?.fxValue)[0] : '·', 'fxv')}
                          {field(7, v()?.fx ? hex2(v()?.fxValue)[1] : '·', 'fxv')}
                        </span>
                      );
                    }}
                  </Index>
                </div>
              )}
            </Index>
          </div>
          <div class="tracker-foot">
            {p().rows} rows make {patternLengthBeats(p())} beats. This clip plays {props.clip.length.toFixed(2)} beats, starting {props.clip.offset.toFixed(2)} beats into the pattern.
          </div>
        </div>
      )}
    </Show>
  );
}

function defaultFx(code: FxCode) {
  if (code === 'P') return 0x80;
  if (code === 'F') return 0xff;
  if (code === 'R') return 0x01;
  return 0x00;
}
