import { Show, createSignal, onCleanup } from 'solid-js';
import { BEATS_PER_BAR, beatsToSec, formatBBT, formatTime } from '../model/timing';
import { audio, canRedo, canUndo, playhead, playing, project, redo, setUi, ui, undo, undoLabel } from '../store/app';
import { setBpm, setLoop, startCapture, stop, togglePlay } from '../store/actions';
import { exportBundle, importBundle } from '../store/session';
import { NumberField, Toggle } from './controls';
import { captureStatus } from './captureState';

const GRIDS: { v: number; label: string }[] = [
  { v: 4, label: 'Bar' },
  { v: 1, label: '1/4' },
  { v: 0.5, label: '1/8' },
  { v: 0.25, label: '1/16' },
  { v: 0.125, label: '1/32' },
];

export function Transport() {
  const [menu, setMenu] = createSignal(false);
  let fileInput!: HTMLInputElement;
  const close = (e: PointerEvent) => {
    if (!(e.target as HTMLElement).closest('.menu-wrap')) setMenu(false);
  };
  window.addEventListener('pointerdown', close);
  onCleanup(() => window.removeEventListener('pointerdown', close));

  const capturing = () => captureStatus() !== 'idle';

  return (
    <header class="transport">
      <div class="wordmark" aria-label="Afterimage">
        <span class="wm-plate" aria-hidden="true">
          AFTERIMAGE
        </span>
        <span class="wm-ink">AFTERIMAGE</span>
      </div>

      <div class="tp-group" role="group" aria-label="Transport">
        <button type="button" class="tp-btn play" aria-pressed={playing()} onClick={togglePlay} title="Play / stop (Space)">
          <Show when={playing()} fallback={<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" /></svg>}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" /></svg>
          </Show>
          <span class="sr">{playing() ? 'Stop' : 'Play'}</span>
        </button>
        <button
          type="button"
          class="tp-btn rec"
          aria-pressed={capturing()}
          onClick={() => (capturing() ? stop() : (setUi('captureOpen', true), void startCapture()))}
          title={capturing() ? 'Stop capture' : 'Start capture with the settings in the capture panel (R)'}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5" /></svg>
          <span class="sr">{capturing() ? 'Stop capture' : 'Record or print'}</span>
        </button>
      </div>

      <div class="tp-position" aria-live="off">
        <span class="pos-bbt">{formatBBT(playhead())}</span>
        <span class="pos-time">{formatTime(beatsToSec(playhead(), project.bpm))}</span>
      </div>

      <div class="tp-group">
        <NumberField
          label="Tempo"
          value={project.bpm}
          min={20}
          max={400}
          step={0.5}
          dragPx={3}
          unit="bpm"
          format={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))}
          edit={{ begin() {}, change: (v) => setBpm(v), end() {} }}
          title="Project tempo. Drag, use arrow keys, or double-click to type."
        />
        <span class="tp-meter-sig" title="Time signature">4/4</span>
      </div>

      <div class="tp-group">
        <Toggle label="Loop" on={project.loop.enabled} onChange={(v) => setLoop({ enabled: v })} title="Loop the range in the ruler (L)" />
        <Toggle
          label="Click"
          on={ui.metronome}
          onChange={(v) => {
            setUi('metronome', v);
            audio().engine.metronome = v;
          }}
          title="Metronome (never recorded or printed)"
        />
        <Toggle label="Snap" on={ui.snap} onChange={(v) => setUi('snap', v)} title="Snap to grid (G). Hold Ctrl while dragging for free placement." />
        <select class="tp-select" aria-label="Grid" value={ui.grid} onChange={(e) => setUi('grid', parseFloat(e.currentTarget.value))} disabled={!ui.snap}>
          {GRIDS.map((g) => (
            <option value={g.v}>{g.label}</option>
          ))}
        </select>
      </div>

      <div class="tp-group">
        <button type="button" class="ghost" disabled={!canUndo()} onClick={undo} title={`Undo ${undoLabel() ?? ''} (Ctrl+Z)`}>
          Undo
        </button>
        <button type="button" class="ghost" disabled={!canRedo()} onClick={redo} title="Redo (Ctrl+Shift+Z)">
          Redo
        </button>
      </div>

      <div class="tp-spacer" />

      <div class="tp-group">
        <Toggle label="Pool" on={ui.poolOpen} onChange={(v) => setUi('poolOpen', v)} title="Sample and instrument pool" />
        <Toggle
          label="Mixer"
          on={ui.bottomOpen && ui.bottomTab === 'mixer'}
          onChange={(v) => setUi(v ? { bottomOpen: true, bottomTab: 'mixer' } : { bottomTab: 'detail' })}
        />
        <Toggle label="Capture" on={ui.captureOpen} onChange={(v) => setUi('captureOpen', v)} title="Record and print" />
      </div>

      <SaveIndicator />

      <div class="menu-wrap">
        <button type="button" class="ghost" aria-haspopup="menu" aria-expanded={menu()} onClick={() => setMenu(!menu())}>
          {project.name}
        </button>
        <Show when={menu()}>
          <div class="menu" role="menu">
            <button type="button" role="menuitem" onClick={() => (setMenu(false), setUi('projectsOpen', true))}>
              Projects…
            </button>
            <button type="button" role="menuitem" onClick={() => (setMenu(false), setUi('exportOpen', true))}>
              Export WAV…
            </button>
            <hr />
            <button type="button" role="menuitem" onClick={() => (setMenu(false), exportBundle())}>
              Save project bundle
            </button>
            <button type="button" role="menuitem" onClick={() => (setMenu(false), fileInput.click())}>
              Open project bundle…
            </button>
          </div>
        </Show>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) void importBundle(f);
            e.currentTarget.value = '';
          }}
        />
      </div>
    </header>
  );
}

function SaveIndicator() {
  const text = () => {
    switch (ui.saveState) {
      case 'saving':
        return 'Saving…';
      case 'saved':
        return `Saved ${new Date(ui.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      case 'error':
        return 'Not saved';
      default:
        return '';
    }
  };
  return (
    <span class="save-state" classList={{ error: ui.saveState === 'error' }} role="status">
      {text()}
    </span>
  );
}

export const BAR = BEATS_PER_BAR;
