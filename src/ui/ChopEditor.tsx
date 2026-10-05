// Sample chopper: a zoomable waveform of one pool sample with a beat grid, detected hits and chords,
// for pulling regions and slices out of a long recording and placing them on the arrangement.
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { chordForRange, detectNote, pickOnsets, refineOnsets, type ChordGuess, type NoteEstimate } from '../model/analysis';
import { beatAt, beatSeconds, gridLines, nearestOnset, sliceBoundaries, snapToGrid, timeOfBeat, type SliceMode } from '../model/grid';
import { peakSpan } from '../model/peaks';
import { formatTime } from '../model/timing';
import { noteName } from '../model/tracker';
import { audio, project, samples, samplesVersion, toast } from '../store/app';
import { analyseSample, analysisOf, analysisProgress, useDetectedGrid } from '../store/analysis';
import { instrumentFromRegion, placeRegion, setSampleGrid, setBpm, sliceToTrack } from '../store/actions';
import { channelsOf } from '../audio/samples';
import { NumberField, Segmented, Slider, Toggle, bindEdit, fmtSigned } from './controls';
import { TRACK_COLORS, drawSampleWave, setupCanvas } from './draw';
import { SLICE_MIME, type SliceDrag } from './dnd';

const H = 132;
const OVERVIEW_H = 28;
const HANDLE = 6;

type Range = { a: number; b: number };
type SnapMode = 'free' | 'beat' | 'hit';

/** Per-sample view and selection, so switching samples and coming back doesn't lose your place. */
const memory = new Map<string, { start: number; spp: number; sel: Range | null; cursor: number | null }>();

const SLICE_OPTIONS: { value: string; label: string }[] = [
  { value: 'bar', label: 'Bars' },
  { value: 'bar2', label: '2 beats' },
  { value: 'beat', label: 'Beats' },
  { value: 'half', label: '½ beats' },
  { value: 'hits', label: 'Hits' },
];
const sliceMode = (v: string): SliceMode => (v === 'hits' ? { kind: 'hits' } : { kind: 'grid', division: { bar: 4, bar2: 2, beat: 1, half: 0.5 }[v] ?? 1 });

const fmtLen = (s: number) => (s < 60 ? `${s.toFixed(3)} s` : formatTime(s));

export function ChopEditor(props: { sampleId: string }) {
  const id = props.sampleId;
  let root!: HTMLDivElement;
  let wave!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let overview!: HTMLDivElement;
  let overviewCanvas!: HTMLCanvasElement;

  const meta = () => project.samples.find((s) => s.id === id);
  const loaded = () => (samplesVersion(), samples.get(id));
  const dur = () => meta()?.duration ?? 1;
  const sr = () => meta()?.sampleRate ?? 44100;
  const grid = () => meta()?.grid;
  const analysis = () => analysisOf(id);
  const progress = () => analysisProgress(id);

  // ── View ───────────────────────────────────────────────────────────────
  const [w, setW] = createSignal(800);
  const [start, setStart] = createSignal(0);
  const [spp, setSpp] = createSignal(0.05); // seconds per pixel
  const minSpp = () => 1 / sr() / 12;
  const fitSpp = () => Math.max(minSpp(), dur() / Math.max(1, w()));
  const view = () => ({ from: start(), to: start() + w() * spp() });
  const xOf = (t: number) => (t - start()) / spp();
  const tOf = (x: number) => start() + x * spp();
  const clampT = (t: number) => Math.max(0, Math.min(dur(), t));

  /** True while the whole sample is in view, so it keeps fitting when the panel is resized. */
  let fitted = true;
  function setView(nextStart: number, nextSpp: number) {
    const s = Math.max(minSpp(), Math.min(fitSpp(), nextSpp));
    fitted = s >= fitSpp() * 0.999;
    setSpp(s);
    setStart(Math.max(0, Math.min(Math.max(0, dur() - w() * s), nextStart)));
  }
  function zoomAt(factor: number, anchorX = w() / 2) {
    const t = tOf(anchorX);
    const s = Math.max(minSpp(), Math.min(fitSpp(), spp() * factor));
    setView(t - anchorX * s, s);
  }
  const fit = () => setView(0, fitSpp());
  function zoomTo(a: number, b: number) {
    const pad = (b - a) * 0.08;
    const s = (b - a + 2 * pad) / Math.max(1, w());
    setView(a - pad, s);
  }

  // ── Selection, cursor, snapping ──────────────────────────────────────────
  const [sel, setSel] = createSignal<Range | null>(null);
  const [cursor, setCursor] = createSignal<number | null>(null);
  const [snap, setSnap] = createSignal<SnapMode>('beat');
  const [division, setDivision] = createSignal(1);
  const [showBeats, setShowBeats] = createSignal(true);
  const [showHits, setShowHits] = createSignal(true);
  const [showChords, setShowChords] = createSignal(true);
  const [sensitivity, setSensitivity] = createSignal(1);
  const [loopPreview, setLoopPreview] = createSignal(false);
  const [playPos, setPlayPos] = createSignal<number | null>(null);
  const [trackSel, setTrackSel] = createSignal('auto');
  const [sliceBy, setSliceBy] = createSignal('bar');

  /** Hits at the chosen sensitivity (the analysed set at the default). */
  const onsets = createMemo(() => {
    const a = analysis();
    if (!a) return [];
    if (Math.abs(sensitivity() - 1) < 1e-6) return a.onsets;
    const l = loaded();
    return l ? refineOnsets(channelsOf(l.buffer), l.buffer.sampleRate, pickOnsets(a.envelope, sensitivity())) : a.onsets;
  });

  function snapT(t: number, ev?: { altKey: boolean }): number {
    t = clampT(t);
    if (ev?.altKey) return t;
    const g = grid();
    if (snap() === 'beat' && g) return clampT(snapToGrid(g, t, division()));
    if (snap() === 'hit') return nearestOnset(onsets(), t, 10 * spp()) ?? t;
    return t;
  }

  const region = (): Range => sel() ?? { a: 0, b: dur() };

  // ── Canvas drawing ───────────────────────────────────────────────────────
  onMount(() => {
    const ro = new ResizeObserver(() => setW(Math.max(100, wave.clientWidth)));
    ro.observe(wave);
    setW(Math.max(100, wave.clientWidth));
    const saved = memory.get(id);
    if (saved) {
      setView(saved.start, saved.spp);
      setSel(saved.sel);
      setCursor(saved.cursor);
    } else fit();
    if (!analysis()) void analyseSample(id);
    onCleanup(() => {
      ro.disconnect();
      memory.set(id, { start: start(), spp: spp(), sel: sel(), cursor: cursor() });
      stopPreview();
    });
  });

  // Keep the whole-sample view fitted while the panel is resized and nothing was zoomed in.
  createEffect(on(w, () => (fitted ? fit() : setView(start(), spp()))));

  createEffect(() => {
    const l = loaded();
    const W = w();
    const g = setupCanvas(canvas, W, H);
    if (!l) return;
    const { from } = view();
    const perPx = spp();
    const rate = l.buffer.sampleRate;
    const mid = H / 2, amp = H / 2 - 3;
    g.fillStyle = TRACK_COLORS.amber.wave;
    const framesPerPx = perPx * rate;
    if (framesPerPx >= 48) {
      for (let x = 0; x < W; x++) {
        const t = from + x * perPx;
        if (t > dur()) break;
        const [lo, hi] = peakSpan(l.peaks, t, t + perPx);
        g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    } else {
      const chs = channelsOf(l.buffer);
      const total = l.buffer.length;
      if (framesPerPx >= 1) {
        for (let x = 0; x < W; x++) {
          const f0 = Math.floor((from + x * perPx) * rate), f1 = Math.min(total - 1, Math.max(f0, Math.floor((from + (x + 1) * perPx) * rate)));
          if (f0 >= total) break;
          let lo = Infinity, hi = -Infinity;
          for (let f = Math.max(0, f0); f <= f1; f++) {
            for (const c of chs) {
              if (c[f] < lo) lo = c[f];
              if (c[f] > hi) hi = c[f];
            }
          }
          g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
        }
      } else {
        // Closer than a pixel per sample: draw the actual curve.
        g.strokeStyle = TRACK_COLORS.amber.wave;
        g.lineWidth = 1.25;
        g.beginPath();
        const f0 = Math.max(0, Math.floor(from * rate) - 1), f1 = Math.min(total - 1, Math.ceil((from + W * perPx) * rate) + 1);
        for (let f = f0; f <= f1; f++) {
          let s = 0;
          for (const c of chs) s += c[f];
          const x = (f / rate - from) / perPx;
          const y = mid - (s / chs.length) * amp;
          if (f === f0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
        g.fillStyle = TRACK_COLORS.amber.wave;
      }
    }
    // Centre line.
    g.fillStyle = 'rgba(237,230,214,0.08)';
    g.fillRect(0, Math.round(mid), W, 1);

    const { to } = view();
    const gr = grid();
    if (showBeats() && gr) {
      const pxBeat = beatSeconds(gr) / perPx;
      const div = pxBeat >= 120 ? 0.25 : pxBeat >= 60 ? 0.5 : pxBeat >= 7 ? 1 : pxBeat * 4 >= 7 ? 4 : pxBeat * 16 >= 7 ? 16 : 64;
      g.font = '10px "JetBrains Mono Variable", ui-monospace, monospace';
      g.textBaseline = 'top';
      for (const ln of gridLines(gr, from, to, div)) {
        const x = Math.round((ln.t - from) / perPx);
        g.fillStyle = ln.kind === 'bar' ? 'rgba(237,230,214,0.42)' : ln.kind === 'beat' ? 'rgba(237,230,214,0.16)' : 'rgba(237,230,214,0.08)';
        g.fillRect(x, 0, 1, H);
        if (ln.kind === 'bar' && ln.beat >= 0 && pxBeat * Math.max(4, div) >= 26) {
          g.fillStyle = 'rgba(237,230,214,0.75)';
          g.fillText(String(Math.round(ln.beat / 4) + 1), x + 3, 2);
        }
      }
    }
    if (showHits()) {
      const hits = onsets();
      g.fillStyle = 'rgba(114,144,171,0.9)';
      let lo = 0, hi = hits.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (hits[m] < from) lo = m + 1;
        else hi = m;
      }
      for (let i = lo; i < hits.length && hits[i] <= to; i++) g.fillRect(Math.round((hits[i] - from) / perPx), H - 22, 1, 22);
    }
  });

  createEffect(() => {
    const l = loaded();
    const W = w();
    const g = setupCanvas(overviewCanvas, W, OVERVIEW_H);
    if (l) drawSampleWave(g, l.peaks, l.buffer.duration, W, OVERVIEW_H, TRACK_COLORS.amber.wave);
  });

  // ── Pointer: select, move the cursor, drag edges ────────────────────────
  const onWaveDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    root.focus();
    const rect = wave.getBoundingClientRect();
    const xAt = (cx: number) => cx - rect.left;
    const tAt = (cx: number, ev?: PointerEvent) => snapT(tOf(xAt(cx)), ev);
    const x0 = e.clientX;
    const cur = sel();
    const edge = cur ? (Math.abs(xAt(x0) - xOf(cur.a)) <= HANDLE ? 'a' : Math.abs(xAt(x0) - xOf(cur.b)) <= HANDLE ? 'b' : null) : null;
    const anchor = edge && cur ? (edge === 'a' ? cur.b : cur.a) : tAt(x0, e);
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      const t = tAt(ev.clientX, ev);
      if (Math.abs(t - anchor) > 1e-4) setSel({ a: Math.min(anchor, t), b: Math.max(anchor, t) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) {
        setCursor(tAt(x0, ev));
        setSel(null);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Double-click grabs the bar/beat (or the span between two hits) under the pointer. */
  const onWaveDbl = (e: MouseEvent) => {
    const t = tOf(e.clientX - wave.getBoundingClientRect().left);
    const g = grid();
    if (snap() === 'hit') {
      const hits = onsets();
      const next = hits.findIndex((h) => h > t);
      const a = hits[(next < 0 ? hits.length : next) - 1] ?? 0;
      const b = next < 0 ? dur() : hits[next];
      setSel({ a, b });
    } else if (g) {
      const d = division();
      const a = timeOfBeat(g, Math.floor(beatAt(g, t) / d) * d);
      setSel({ a: clampT(a), b: clampT(a + d * beatSeconds(g)) });
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(e.deltaY * 0.0025), e.clientX - wave.getBoundingClientRect().left);
    else setView(start() + (e.deltaX || e.deltaY) * spp(), spp());
  };

  const onOverviewDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = overview.getBoundingClientRect();
    const secPerOv = dur() / rect.width;
    const span = w() * spp();
    const inside = e.clientX - rect.left >= start() / secPerOv && e.clientX - rect.left <= (start() + span) / secPerOv;
    const grab = inside ? (e.clientX - rect.left) * secPerOv - start() : span / 2;
    const go = (ev: PointerEvent) => setView((ev.clientX - rect.left) * secPerOv - grab, spp());
    go(e);
    const up = () => {
      window.removeEventListener('pointermove', go);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', go);
    window.addEventListener('pointerup', up);
  };

  // ── Preview ──────────────────────────────────────────────────────────────
  let raf = 0;
  const tickPos = () => {
    const p = audio().engine.auditionPosition(id);
    setPlayPos(p);
    if (p === null) return;
    if (p < start() || p > start() + w() * spp()) setView(p - w() * spp() * 0.1, spp());
    raf = requestAnimationFrame(tickPos);
  };
  function stopPreview() {
    cancelAnimationFrame(raf);
    const { engine } = audio();
    if (engine.auditionPosition(id) !== null) engine.stopAudition();
    setPlayPos(null);
  }
  function startPreview(from?: number, to?: number) {
    const r = sel();
    const a = from ?? r?.a ?? cursor() ?? start();
    const b = to ?? r?.b ?? dur();
    cancelAnimationFrame(raf);
    void audio().engine.auditionSample(id, a, b, loopPreview()).then(() => {
      raf = requestAnimationFrame(tickPos);
    });
  }
  const togglePreview = () => (audio().engine.auditionPosition(id) !== null ? stopPreview() : startPreview());
  createEffect(on(loopPreview, () => audio().engine.auditionPosition(id) !== null && startPreview()));

  // ── Detection readouts for the selection ────────────────────────────────
  const [info, setInfo] = createSignal<{ note: NoteEstimate | null; chord: ChordGuess | null } | null>(null);
  createEffect(
    on([sel, analysis, loaded], () => {
      const r = sel();
      const l = loaded();
      if (!r || !l) return setInfo(null);
      const h = setTimeout(() => {
        const note = r.b - r.a >= 0.08 ? detectNote(channelsOf(l.buffer), l.buffer.sampleRate, r.a, r.b) : null;
        const a = analysis();
        setInfo({ note, chord: a ? chordForRange(a.chroma, r.a, r.b) : null });
      }, 120);
      onCleanup(() => clearTimeout(h));
    }),
  );

  // ── Actions ──────────────────────────────────────────────────────────────
  const targetTrack = () => (trackSel() === 'auto' ? undefined : trackSel());
  const place = (step: boolean) => {
    const r = region();
    if (r.b - r.a < 0.005) return;
    if (!placeRegion(id, r.a, r.b, { trackId: targetTrack() }) || !step) return;
    const s = sel();
    if (s && s.b + (s.b - s.a) <= dur() + 1e-6) setSel({ a: s.b, b: s.b + (s.b - s.a) });
  };
  const slice = () => {
    const r = region();
    const bounds = sliceBoundaries(grid() ?? null, onsets(), r.a, r.b, sliceMode(sliceBy()));
    sliceToTrack(id, bounds, { trackId: targetTrack() });
  };
  const sliceCount = () => {
    const r = region();
    const b = sliceBoundaries(grid() ?? null, onsets(), r.a, r.b, sliceMode(sliceBy()));
    return Math.max(0, b.length - 1);
  };
  const moveSel = (dir: 1 | -1) => {
    const s = sel();
    const g = grid();
    const len = s ? s.b - s.a : g ? beatSeconds(g) * division() : 1;
    const a = Math.max(0, Math.min(dur() - len, (s?.a ?? cursor() ?? 0) + dir * len));
    setSel({ a, b: a + len });
    if (audio().engine.auditionPosition(id) !== null) startPreview(a, a + len);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable || e.ctrlKey || e.metaKey) return;
    let handled = true;
    switch (e.key) {
      case ' ':
        togglePreview();
        break;
      case 'Enter':
        place(e.shiftKey);
        break;
      case '+':
      case '=':
        zoomAt(1 / 1.5);
        break;
      case '-':
        zoomAt(1.5);
        break;
      case 'f':
      case '0':
        fit();
        break;
      case 'z': {
        const r = sel();
        if (r) zoomTo(r.a, r.b);
        break;
      }
      case 'l':
        setLoopPreview(!loopPreview());
        break;
      case 'Escape':
        setSel(null);
        break;
      case 'ArrowRight':
        moveSel(1);
        break;
      case 'ArrowLeft':
        moveSel(-1);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const dragRegion = (e: DragEvent) => {
    const r = region();
    const payload: SliceDrag = { sampleId: id, from: r.a, to: r.b };
    e.dataTransfer!.setData(SLICE_MIME, JSON.stringify(payload));
    e.dataTransfer!.effectAllowed = 'copy';
  };

  const gridEdit = (label: string, fn: (g: NonNullable<ReturnType<typeof grid>>, v: number) => void) =>
    bindEdit(label, (p, v) => {
      const s = p.samples.find((x) => x.id === id);
      if (s?.grid) fn(s.grid, v);
    });

  const visibleChords = createMemo(() => {
    const a = analysis();
    if (!a || !showChords()) return [];
    const { from, to } = view();
    return a.chords.filter((c) => c.end > from && c.start < to);
  });

  const selBeats = () => {
    const g = grid();
    const r = region();
    return g ? ((r.b - r.a) / beatSeconds(g)) : null;
  };
  const posLabel = (t: number) => {
    const g = grid();
    if (!g || t < g.offset - 1e-3) return '';
    const b = beatAt(g, t);
    return `bar ${Math.floor(b / 4) + 1} · beat ${Math.floor(b % 4) + 1}`;
  };

  return (
    <div class="chop" ref={root} tabIndex={0} onKeyDown={onKeyDown} aria-label={`Sample editor for ${meta()?.name ?? 'sample'}`}>
      <div class="chop-main">
        <div class="chop-title">
          <b class="chop-name">{meta()?.name}</b>
          <span class="insp-sub">
            {fmtLen(dur())} · {(sr() / 1000).toFixed(1)} kHz · {meta()?.channels === 1 ? 'mono' : 'stereo'}
            <Show when={analysis()?.key}> · key {analysis()!.key!.name}</Show>
          </span>
          <span class="chop-views" role="group" aria-label="Show on the waveform">
            <Toggle label="Beats" on={showBeats()} onChange={setShowBeats} title="Show the beat grid" />
            <Toggle label="Hits" on={showHits()} onChange={setShowHits} title="Show detected hits" />
            <Toggle label="Chords" on={showChords()} onChange={setShowChords} title="Show detected chords" />
          </span>
        </div>

        <div class="chop-toolbar" role="toolbar" aria-label="Sample editor tools">
          <button type="button" class="ghost small" aria-pressed={playPos() !== null} onClick={togglePreview} title="Preview the selection, or from the cursor (Space)">
            {playPos() !== null ? '■ Stop' : '▶ Play'}
          </button>
          <Toggle label="Loop" on={loopPreview()} onChange={setLoopPreview} title="Repeat the previewed selection (L)" />
          <span class="chop-sep" />
          <button type="button" class="ghost small" onClick={() => zoomAt(1.5)} title="Zoom out (−)" aria-label="Zoom out">−</button>
          <button type="button" class="ghost small" onClick={() => zoomAt(1 / 1.5)} title="Zoom in (+, or Ctrl+wheel)" aria-label="Zoom in">+</button>
          <button type="button" class="ghost small" onClick={fit} title="Show the whole sample (F)">Fit</button>
          <button type="button" class="ghost small" disabled={!sel()} onClick={() => sel() && zoomTo(sel()!.a, sel()!.b)} title="Zoom to the selection (Z)">
            Selection
          </button>
          <span class="chop-sep" />
          <Segmented
            label="Snap selection to"
            value={snap()}
            options={[
              { value: 'free', label: 'Free', title: 'No snapping (hold Alt for this at any time)' },
              { value: 'beat', label: 'Grid', title: 'Snap to the beat grid' },
              { value: 'hit', label: 'Hits', title: 'Snap to detected hits' },
            ]}
            onChange={setSnap}
          />
          <select class="tp-select" aria-label="Grid size" value={division()} disabled={snap() !== 'beat'} onChange={(e) => setDivision(parseFloat(e.currentTarget.value))}>
            <option value={4}>Bar</option>
            <option value={1}>Beat</option>
            <option value={0.5}>½ beat</option>
            <option value={0.25}>¼ beat</option>
          </select>
        </div>

        <div class="chop-chords" aria-label="Detected chords" style={{ visibility: showChords() ? 'visible' : 'hidden' }}>
          <For each={visibleChords()}>
            {(c) => (
              <button
                type="button"
                class="chord"
                classList={{ minor: c.quality.startsWith('m') && !c.quality.startsWith('maj') }}
                style={{ left: `${Math.max(0, xOf(c.start))}px`, width: `${Math.max(2, xOf(c.end) - Math.max(0, xOf(c.start)) - 1)}px` }}
                title={`${c.name} · ${formatTime(c.start)} – ${formatTime(c.end)} · click to select`}
                onClick={() => setSel({ a: c.start, b: c.end })}
              >
                {xOf(c.end) - xOf(c.start) > 22 ? c.name : ''}
              </button>
            )}
          </For>
        </div>

        <div
          class="chop-wave"
          ref={wave}
          style={{ height: `${H}px` }}
          onPointerDown={onWaveDown}
          onDblClick={onWaveDbl}
          onWheel={onWheel}
          role="application"
          aria-label="Waveform. Drag to select a region, double-click to select a beat, Ctrl+wheel to zoom."
        >
          <canvas ref={canvas} />
          <Show when={sel()}>
            {(r) => (
              <div class="chop-sel" style={{ left: `${xOf(r().a)}px`, width: `${Math.max(1, xOf(r().b) - xOf(r().a))}px` }}>
                <span class="chop-edge a" />
                <span class="chop-edge b" />
              </div>
            )}
          </Show>
          <Show when={cursor() !== null}>
            <div class="chop-cursor" style={{ left: `${xOf(cursor()!)}px` }} />
          </Show>
          <Show when={playPos() !== null}>
            <div class="chop-playhead" style={{ left: `${xOf(playPos()!)}px` }} />
          </Show>
          <Show when={!loaded()}>
            <div class="chop-missing">This sample’s audio isn’t loaded.</div>
          </Show>
        </div>

        <div class="chop-overview" ref={overview} style={{ height: `${OVERVIEW_H}px` }} onPointerDown={onOverviewDown} title="Overview — drag to scroll">
          <canvas ref={overviewCanvas} />
          <Show when={sel()}>
            {(r) => <div class="chop-ov-sel" style={{ left: `${(r().a / dur()) * w()}px`, width: `${Math.max(1, ((r().b - r().a) / dur()) * w())}px` }} />}
          </Show>
          <div class="chop-viewport" style={{ left: `${(start() / dur()) * w()}px`, width: `${Math.min(w(), ((w() * spp()) / dur()) * w())}px` }} />
        </div>

        <div class="insp-readout">
          <span>
            <Show when={sel()} fallback={<>Whole sample</>}>
              Selection <b>{sel()!.a.toFixed(3)}</b>–<b>{sel()!.b.toFixed(3)}</b> s
            </Show>
            {' '}· <b>{fmtLen(region().b - region().a)}</b>
            <Show when={selBeats() !== null}>
              {' '}· <b>{selBeats()!.toFixed(2)}</b> beats
              <Show when={selBeats()! >= 3.99}> · <b>{(selBeats()! / 4).toFixed(2)}</b> bars</Show>
            </Show>
          </span>
          <Show when={cursor() !== null}>
            <span>
              Cursor <b>{formatTime(cursor()!)}</b>
              <Show when={posLabel(cursor()!)}> · {posLabel(cursor()!)}</Show>
            </span>
          </Show>
          <span class="chop-hint">Drag to select · double-click selects a beat · Space plays · Enter adds to the timeline · ←/→ step</span>
        </div>
      </div>

      <div class="chop-side">
        <fieldset>
          <legend>Use it</legend>
          <label class="nf" title="Which track receives the clip">
            <span class="nf-label">Track</span>
            <select aria-label="Target track" onChange={(e) => setTrackSel(e.currentTarget.value)}>
              <option value="auto" selected={trackSel() === 'auto'}>Auto (first with room)</option>
              <For each={project.tracks}>{(t) => <option value={t.id} selected={trackSel() === t.id}>{t.name}</option>}</For>
            </select>
          </label>
          <label class="nf" title="How to cut the selection, or the whole sample when nothing is selected">
            <span class="nf-label">Slice into</span>
            <select aria-label="Slice size" value={sliceBy()} onChange={(e) => setSliceBy(e.currentTarget.value)}>
              <For each={SLICE_OPTIONS}>{(o) => <option value={o.value} selected={sliceBy() === o.value}>{o.label}</option>}</For>
            </select>
          </label>
          <div class="insp-actions">
            <button type="button" class="primary small" onClick={() => place(false)} title="Place at the arrangement cursor (Enter)">
              Add to timeline
            </button>
            <button type="button" class="ghost small" onClick={() => place(true)} title="Place, then select the next region of the same length (Shift+Enter)">
              Add &amp; next
            </button>
            <span class="chop-drag" draggable={true} onDragStart={dragRegion} title="Drag the selection (or the whole sample) onto a track lane">
              ⠿ Drag
            </span>
          </div>
          <div class="insp-actions">
            <button type="button" class="ghost small" disabled={sliceCount() < 1} onClick={slice} title="Cut the selection (or the whole sample) and lay the pieces end to end from the cursor">
              Slice → timeline{sliceCount() > 0 ? ` (${sliceCount()})` : ''}
            </button>
            <button
              type="button"
              class="ghost small"
              onClick={() => {
                const r = region();
                instrumentFromRegion(id, r.a, r.b, `${meta()?.name ?? 'Sample'}${sel() ? ' region' : ''}`);
              }}
              title="Use the selection as a tracker instrument, tuned to its detected pitch"
            >
              Make instrument
            </button>
          </div>
        </fieldset>

        <fieldset>
          <legend>Tempo and beats</legend>
          <Show
            when={grid()}
            fallback={
              <div class="chop-note">
                <Show
                  when={progress()}
                  fallback={
                    <>
                      <span>{analysis() ? 'No steady tempo found.' : 'Not analysed yet.'}</span>
                      <button type="button" class="ghost small" onClick={() => setSampleGrid(id, { bpm: project.bpm, offset: cursor() ?? 0 }, 'add beat grid')}>
                        Set grid by hand
                      </button>
                    </>
                  }
                >
                  <span>Detecting tempo…</span>
                </Show>
              </div>
            }
          >
            <NumberField label="Tempo" value={grid()!.bpm} min={20} max={400} step={0.01} dragPx={1} unit="bpm" format={(v) => v.toFixed(2)} edit={gridEdit('beat grid tempo', (g, v) => (g.bpm = v))} title="Drag, use arrow keys, or double-click to type" />
            <NumberField label="Beat 1 at" value={grid()!.offset} min={-5} max={dur()} step={0.001} dragPx={1} unit="s" format={(v) => v.toFixed(3)} edit={gridEdit('beat grid offset', (g, v) => (g.offset = v))} title="Where a bar starts, in seconds" />
            <div class="chop-btns">
              <button type="button" class="text-btn" onClick={() => setSampleGrid(id, { ...grid()!, bpm: Math.min(400, grid()!.bpm * 2) })} title="Double the tempo">×2</button>
              <button type="button" class="text-btn" onClick={() => setSampleGrid(id, { ...grid()!, bpm: Math.max(20, grid()!.bpm / 2) })} title="Halve the tempo">÷2</button>
              <button type="button" class="text-btn" onClick={() => setSampleGrid(id, { ...grid()!, offset: grid()!.offset + beatSeconds(grid()!) })} title="Call the next beat the bar start">Downbeat +1</button>
              <button
                type="button"
                class="text-btn"
                onClick={() => {
                  const t = sel()?.a ?? cursor();
                  if (t !== null && t !== undefined) setSampleGrid(id, { ...grid()!, offset: t });
                  else toast('Click the waveform (or select a region) where a bar starts first.', 'info', 2200);
                }}
                title="Make the cursor or selection start the bar line"
              >
                Beat 1 ← cursor
              </button>
              <button type="button" class="text-btn" onClick={() => setBpm(grid()!.bpm)} title="Set the project tempo to this tempo">Use as project tempo</button>
              <Show when={analysis()?.tempo}>
                <button type="button" class="text-btn" onClick={() => useDetectedGrid(id)} title="Back to the detected grid">Reset</button>
              </Show>
              <button type="button" class="text-btn" onClick={() => setSampleGrid(id, undefined, 'clear beat grid')} title="Remove the grid">Clear</button>
            </div>
            <Show when={Math.abs(grid()!.bpm - project.bpm) > 0.01}>
              <span class="chop-note">
                Project is at {Number.isInteger(project.bpm) ? project.bpm : project.bpm.toFixed(1)} bpm, so clips from this sample play ×{(project.bpm / grid()!.bpm).toFixed(2)} to stay in time.
              </span>
            </Show>
          </Show>
          <Show when={progress()}>
            {(p) => (
              <div class="chop-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p().fraction * 100)} aria-label={p().stage}>
                <div style={{ width: `${Math.round(p().fraction * 100)}%` }} />
                <span>{p().stage}…</span>
              </div>
            )}
          </Show>
          <Show when={!progress() && analysis()}>
            <button type="button" class="text-btn" onClick={() => void analyseSample(id, { force: true })} title="Analyse the audio again">
              Re-analyse
            </button>
          </Show>
        </fieldset>

        <fieldset>
          <legend>Hits</legend>
          <Slider
            label="Sensitivity"
            min={0.3}
            max={3}
            step={0.05}
            value={sensitivity()}
            format={() => `${onsets().length} found`}
            edit={{ begin() {}, change: (v) => setSensitivity(v), end() {} }}
          />
        </fieldset>

        <fieldset>
          <legend>Selection</legend>
          <Show when={sel()} fallback={<span class="chop-note">Select a region to see its pitch and chord.</span>}>
            <div class="chop-chips">
              <span class="chip" title="Detected pitch of the selection">
                Note{' '}
                <b>
                  {info()?.note ? `${noteName(info()!.note!.midi)}${info()!.note!.cents ? ` ${fmtSigned(info()!.note!.cents)}¢` : ''}` : info() ? 'none' : '…'}
                </b>
              </span>
              <span class="chip" title="Best-fitting chord for the selection">
                Chord <b>{info()?.chord ? info()!.chord!.name : info() ? (analysis() ? 'none' : 'analysing…') : '…'}</b>
              </span>
            </div>
          </Show>
        </fieldset>

      </div>
    </div>
  );
}
