// Small, keyboard-accessible controls bound to undoable project edits.
import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js';
import type { Project } from '../model/types';
import { beginGesture, commit, endGesture, live } from '../store/app';

/** Handlers for a continuous control editing the project: one undo step per gesture. */
// Gesture state is module-level: JSX props are re-evaluated lazily, so the
// handler object seen by begin() and end() may differ.
let gestureActive = false;
export function bindEdit(label: string, apply: (p: Project, v: number) => void, opts: { checkOverlaps?: boolean } = {}) {
  return {
    begin() {
      if (gestureActive) return;
      gestureActive = true;
      beginGesture();
    },
    change(v: number) {
      if (gestureActive) live((p) => apply(p, v));
      else commit(label, (p) => apply(p, v), { checkOverlaps: opts.checkOverlaps ?? false });
    },
    end() {
      if (!gestureActive) return;
      gestureActive = false;
      endGesture(label);
    },
  };
}

type Edit = ReturnType<typeof bindEdit>;

export interface NumberFieldProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Pixels of vertical drag per step. */
  dragPx?: number;
  format?: (v: number) => string;
  parse?: (s: string) => number;
  unit?: string;
  edit: Edit;
  disabled?: boolean;
  width?: string;
  title?: string;
}

const clamp = (v: number, lo = -Infinity, hi = Infinity) => Math.min(hi, Math.max(lo, v));

/** A number you can drag vertically, step with arrow keys, or type (double-click / Enter). */
export function NumberField(props: NumberFieldProps) {
  const [editing, setEditing] = createSignal(false);
  const step = () => props.step ?? 1;
  const fmt = (v: number) => (props.format ? props.format(v) : String(Math.round(v / step()) * step()));
  const snap = (v: number) => {
    const s = step();
    return clamp(Math.round(v / s) * s, props.min, props.max);
  };
  let startY = 0, startV = 0, moved = false;

  const onPointerDown = (e: PointerEvent) => {
    if (props.disabled || editing() || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startY = e.clientY;
    startV = props.value;
    moved = false;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    const dy = startY - e.clientY;
    if (!moved && Math.abs(dy) < 3) return;
    if (!moved) {
      moved = true;
      props.edit.begin();
    }
    const fine = e.shiftKey ? 0.1 : 1;
    const v = snap(startV + (dy / (props.dragPx ?? 4)) * step() * fine);
    if (v !== props.value) props.edit.change(v);
  };
  const onPointerUp = () => {
    if (moved) props.edit.end();
    moved = false;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (editing()) return;
    const k = e.key;
    const mult = e.shiftKey ? 10 : 1;
    if (k === 'ArrowUp' || k === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      props.edit.change(snap(props.value + step() * mult));
    } else if (k === 'ArrowDown' || k === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      props.edit.change(snap(props.value - step() * mult));
    } else if (k === 'Enter') {
      e.preventDefault();
      setEditing(true);
    }
  };
  const accept = (s: string) => {
    setEditing(false);
    const v = props.parse ? props.parse(s) : parseFloat(s);
    if (Number.isFinite(v)) props.edit.change(clamp(v, props.min, props.max));
  };

  return (
    <label class="nf" classList={{ disabled: props.disabled }} title={props.title}>
      <span class="nf-label">{props.label}</span>
      <Show
        when={editing()}
        fallback={
          <span
            class="nf-value"
            role="spinbutton"
            tabIndex={props.disabled ? -1 : 0}
            aria-label={props.label}
            aria-valuenow={props.value}
            aria-valuemin={props.min}
            aria-valuemax={props.max}
            aria-disabled={props.disabled}
            style={{ width: props.width }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDblClick={() => !props.disabled && setEditing(true)}
            onKeyDown={onKeyDown}
          >
            {fmt(props.value)}
            <Show when={props.unit}>
              <span class="nf-unit">{props.unit}</span>
            </Show>
          </span>
        }
      >
        <input
          class="nf-input"
          style={{ width: props.width }}
          value={fmt(props.value)}
          ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') accept(e.currentTarget.value);
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={(e) => accept(e.currentTarget.value)}
        />
      </Show>
    </label>
  );
}

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  edit: Edit;
  format?: (v: number) => string;
  vertical?: boolean;
  hideLabel?: boolean;
  disabled?: boolean;
  class?: string;
}

/** Native range input (keyboard accessible) with gesture-grouped undo. */
export function Slider(props: SliderProps) {
  let dragging = false;
  return (
    <label class={`slider ${props.vertical ? 'vertical' : ''} ${props.class ?? ''}`} classList={{ disabled: props.disabled }}>
      <Show when={!props.hideLabel}>
        <span class="slider-label">{props.label}</span>
      </Show>
      <input
        type="range"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step={props.step ?? 'any'}
        value={props.value}
        disabled={props.disabled}
        onPointerDown={() => {
          dragging = true;
          props.edit.begin();
        }}
        onPointerUp={() => {
          dragging = false;
          props.edit.end();
        }}
        onInput={(e) => props.edit.change(parseFloat(e.currentTarget.value))}
        onKeyDown={(e) => e.stopPropagation()}
        onDblClick={() => void 0}
        onLostPointerCapture={() => {
          if (dragging) {
            dragging = false;
            props.edit.end();
          }
        }}
      />
      <Show when={props.format}>
        <span class="slider-value">{props.format!(props.value)}</span>
      </Show>
    </label>
  );
}

export function Toggle(props: { label: string; on: boolean; onChange: (v: boolean) => void; title?: string; class?: string; children?: JSX.Element; disabled?: boolean }) {
  return (
    <button
      type="button"
      class={`toggle ${props.class ?? ''}`}
      aria-pressed={props.on}
      title={props.title ?? props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
    >
      {props.children ?? props.label}
    </button>
  );
}

export function Segmented<T extends string>(props: { label: string; value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === o.value}
            title={o.title}
            disabled={props.disabled}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

/** Peak meter with a short hold. `level` is linear amplitude. */
export function Meter(props: { level: number; vertical?: boolean; label?: string }) {
  const [hold, setHold] = createSignal(0);
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const db = () => (props.level > 0 ? 20 * Math.log10(props.level) : -96);
  const pos = (d: number) => clamp((d + 60) / 60, 0, 1);
  const fill = () => {
    const p = pos(db());
    if (p > hold()) {
      setHold(p);
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => setHold(0), 1200);
    }
    return p;
  };
  onCleanup(() => clearTimeout(holdTimer));
  return (
    <div
      class={`meter ${props.vertical ? 'vertical' : ''}`}
      classList={{ clip: props.level >= 0.999 }}
      role="meter"
      aria-label={props.label ?? 'Level'}
      aria-valuemin={-60}
      aria-valuemax={0}
      aria-valuenow={Math.round(db())}
    >
      <div class="meter-fill" style={props.vertical ? { height: `${fill() * 100}%` } : { width: `${fill() * 100}%` }} />
      <div class="meter-hold" style={props.vertical ? { bottom: `${hold() * 100}%` } : { left: `${hold() * 100}%` }} />
    </div>
  );
}

export const fmtDb = (v: number) => (v <= -60 ? '−∞' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`);
export const fmtPan = (v: number) => (Math.abs(v) < 0.005 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`);
export const fmtHz = (v: number) => (v >= 19950 ? 'open' : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
export const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
export const fmtSigned = (v: number, digits = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
