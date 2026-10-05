import { Show, createEffect, on, onCleanup, onMount } from 'solid-js';
import { audio, canRedo, canUndo, playing, project, rawProject, redo, selectClips, selectedClipIds, setPlayhead, setUi, toast, ui, undo } from './store/app';
import {
  addMarker,
  copySelected,
  cutSelected,
  deleteSelected,
  duplicateSelected,
  pasteClipboard,
  seek,
  setLoop,
  splitAt,
  startCapture,
  stop,
  togglePlay,
} from './store/actions';
import { groupSpan } from './model/clips';
import { installAutosave, startSession } from './store/session';
import { Transport } from './ui/Transport';
import { Pool } from './ui/Pool';
import { Arrangement, arrangementView } from './ui/Arrangement';
import { BottomPanel } from './ui/Detail';
import { CapturePanel } from './ui/CapturePanel';
import { Dialogs } from './ui/Dialogs';
import { setMeters } from './ui/meters';
import { playhead } from './store/app';
import { setCaptureStatus, setElapsed, setInputInfo, setInputLevels, setMonitoringSignal } from './ui/captureState';

function isTyping(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  if (!t) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

export function App() {
  const { engine, capture } = audio();

  // Push every project change to the audio engine (graph levels, live clip edits).
  createEffect(on(() => JSON.stringify(project), () => engine.sync(rawProject())));
  installAutosave();

  engine.onPlayState((p) => {
    if (!p) setPlayhead(ui.cursor);
  });
  capture.onChange(() => {
    setCaptureStatus(capture.status);
    setInputInfo(capture.input ? { ...capture.input } : null);
    setMonitoringSignal(capture.monitoring);
  });

  // Point the recorder's level meter at the chosen source while the panel is open.
  createEffect(
    on([() => ui.captureOpen, () => ui.capture.source], ([open, source]) => {
      if (!open || capture.status !== 'idle') return;
      const s = source as string;
      const src = s === 'input' ? ({ kind: 'input' } as const) : s === 'master' ? ({ kind: 'master' } as const) : ({ kind: 'track', trackId: s } as const);
      capture.select(src).catch(() => {});
    }),
  );
  createEffect(() => {
    if (!ui.capture.destTrackId && project.tracks[0]) setUi('capture', 'destTrackId', project.tracks[0].id);
  });

  let raf = 0;
  let frame = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    frame++;
    if (engine.playing) setPlayhead(Math.max(engine.position(), -64));
    if (frame % 2 === 0) {
      setMeters(engine.meters());
      setInputLevels(capture.levels);
      if (capture.status !== 'idle') setElapsed(capture.elapsed());
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
      return;
    }
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) canRedo() && redo();
      else canUndo() && undo();
      return;
    }
    if (mod && k === 'y') {
      e.preventDefault();
      if (canRedo()) redo();
      return;
    }
    if (mod && k === 'd') {
      e.preventDefault();
      duplicateSelected();
      return;
    }
    if (mod && (k === 'c' || k === 'x' || k === 'v')) {
      // The tracker has its own clipboard for cells, and text selections copy as usual.
      if ((e.target as HTMLElement | null)?.closest?.('.tracker')) return;
      if (k !== 'v' && window.getSelection()?.toString()) return;
      e.preventDefault();
      if (k === 'c') copySelected();
      else if (k === 'x') cutSelected();
      else pasteClipboard();
      return;
    }
    if (mod && k === 'e') {
      e.preventDefault();
      splitAt(playing() ? playhead() : ui.cursor);
      return;
    }
    if (mod && k === 's') {
      e.preventDefault();
      toast('Your work autosaves in this browser. Use “Save project bundle” in the project menu for a portable copy.', 'info', 3000);
      return;
    }
    if (mod) return;
    switch (k) {
      case 'delete':
      case 'backspace':
        e.preventDefault();
        deleteSelected();
        break;
      case 's':
        splitAt(playing() ? playhead() : ui.cursor);
        break;
      case 'l':
        setLoop({ enabled: !project.loop.enabled });
        break;
      case 'g':
        setUi('snap', !ui.snap);
        break;
      case 'm':
        addMarker(playing() ? playhead() : ui.cursor);
        break;
      case 'r':
        setUi('captureOpen', true);
        if (capture.status === 'idle') void startCapture();
        else stop();
        break;
      case 'home':
        seek(0);
        break;
      case 'z': {
        // Zoom to the selected clips, or fit the whole song.
        const sel = project.clips.filter((c) => selectedClipIds().includes(c.id));
        if (sel.length) {
          const s = groupSpan(sel);
          arrangementView.zoomTo(s.start, s.end);
        } else arrangementView.fit();
        break;
      }
      case 'escape':
        selectClips([]);
        break;
      case '=':
      case '+':
        setUi('pxPerBeat', Math.min(400, ui.pxPerBeat * 1.25));
        break;
      case '-':
        setUi('pxPerBeat', Math.max(3, ui.pxPerBeat / 1.25));
        break;
    }
  };

  onMount(() => {
    void startSession();
    raf = requestAnimationFrame(loop);
    window.addEventListener('keydown', onKey);
    // Dropping files outside a track would otherwise navigate away.
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    });
  });

  return (
    <div class="app" classList={{ 'pool-open': ui.poolOpen, 'capture-open': ui.captureOpen }}>
      <Transport />
      <div class="workspace">
        <Show when={ui.poolOpen}>
          <Pool />
        </Show>
        <main class="main">
          <Arrangement />
          <BottomPanel />
        </main>
        <Show when={ui.captureOpen}>
          <CapturePanel />
        </Show>
      </div>
      <Dialogs />
    </div>
  );
}
