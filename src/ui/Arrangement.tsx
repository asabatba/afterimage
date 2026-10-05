import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { Track } from '../model/types';
import { BEATS_PER_BAR, snapBeat } from '../model/timing';
import { songEnd } from '../model/clips';
import {
  beginGesture,
  endGesture,
  live,
  playhead,
  playing,
  project,
  selectClips,
  setUi,
  ui,
} from '../store/app';
import {
  addClipFromSample,
  addMarker,
  addPatternClip,
  addTrack,
  importFiles,
  removeMarker,
  removeTrack,
  seek,
  setLoop,
  updateMarker,
  updateTrack,
} from '../store/actions';
import { ClipView } from './ClipView';
import { TRACK_COLORS } from './draw';
import { meters } from './meters';

export const SAMPLE_MIME = 'application/x-afterimage-sample';

const COLORS: Track['color'][] = ['amber', 'blue', 'sage', 'rust', 'ivory'];

export function Arrangement() {
  let scroller!: HTMLDivElement;
  const [scrollLeft, setScrollLeft] = createSignal(0);
  const [viewW, setViewW] = createSignal(1000);
  const [dropBeat, setDropBeat] = createSignal<{ trackId: string; beat: number } | null>(null);
  const view = { scrollLeft, viewW };

  const headerW = 188;
  const totalBeats = createMemo(() => Math.max(songEnd(project.clips) + 16 * BEATS_PER_BAR, project.loop.end + 8, (viewW() / ui.pxPerBeat) * 1.2, 64 * BEATS_PER_BAR));
  const timelineW = () => totalBeats() * ui.pxPerBeat;

  onMount(() => {
    const ro = new ResizeObserver(() => setViewW(scroller.clientWidth - headerW));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });

  // Keep the playhead in view while playing.
  const followTimer = setInterval(() => {
    if (!playing() || !ui.followPlayhead || !scroller) return;
    const x = playhead() * ui.pxPerBeat;
    const l = scroller.scrollLeft;
    if (x < l || x > l + viewW() - 40) scroller.scrollLeft = Math.max(0, x - 60);
  }, 200);
  onCleanup(() => clearInterval(followTimer));

  const beatAtClientX = (clientX: number) => {
    const r = scroller.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - headerW + scroller.scrollLeft) / ui.pxPerBeat);
  };

  const onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const anchorBeat = beatAtClientX(e.clientX);
    const before = anchorBeat * ui.pxPerBeat - scroller.scrollLeft;
    const z = Math.min(400, Math.max(3, ui.pxPerBeat * Math.exp(-e.deltaY * 0.0025)));
    setUi('pxPerBeat', z);
    scroller.scrollLeft = anchorBeat * z - before;
  };

  // ── Lanes ──────────────────────────────────────────────────────────────

  const onLaneDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (!(e.ctrlKey || e.metaKey)) selectClips([]);
    seek(snapBeat(beatAtClientX(e.clientX), ui.grid, ui.snap));
  };

  const onLaneDbl = (e: MouseEvent, trackId: string) => {
    const beat = snapBeat(beatAtClientX(e.clientX), BEATS_PER_BAR, ui.snap);
    addPatternClip(trackId, beat);
    setUi({ bottomOpen: true, bottomTab: 'detail' });
  };

  const onDragOver = (e: DragEvent, trackId: string) => {
    const types = e.dataTransfer?.types ?? [];
    if (!types.includes(SAMPLE_MIME) && !types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    setDropBeat({ trackId, beat: snapBeat(beatAtClientX(e.clientX), ui.grid, ui.snap) });
  };

  const onDrop = (e: DragEvent, trackId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const beat = snapBeat(beatAtClientX(e.clientX), ui.grid, ui.snap);
    setDropBeat(null);
    const id = e.dataTransfer?.getData(SAMPLE_MIME);
    if (id) addClipFromSample(id, trackId, beat);
    else if (e.dataTransfer?.files.length) void importFiles([...e.dataTransfer.files], { trackId, beat });
  };

  // ── Ruler: scrub, loop band, sections ─────────────────────────────────

  const onRulerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const scrub = (ev: PointerEvent) => seek(snapBeat(beatAtClientX(ev.clientX), ui.grid, ui.snap && !ev.ctrlKey));
    scrub(e);
    if (playing()) return;
    const up = () => {
      window.removeEventListener('pointermove', scrub);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', scrub);
    window.addEventListener('pointerup', up);
  };

  const onLoopDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const b0 = beatAtClientX(e.clientX);
    const { start, end } = project.loop;
    const tol = 6 / ui.pxPerBeat;
    let mode: 'start' | 'end' | 'move' | 'new' = 'new';
    if (Math.abs(b0 - start) < tol) mode = 'start';
    else if (Math.abs(b0 - end) < tol) mode = 'end';
    else if (b0 > start && b0 < end) mode = 'move';
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const b = beatAtClientX(ev.clientX);
      const sn = (x: number) => Math.max(0, snapBeat(x, ui.grid, ui.snap && !ev.ctrlKey));
      if (!moved) {
        moved = true;
        beginGesture();
      }
      live((p) => {
        if (mode === 'start') p.loop.start = Math.min(sn(b), p.loop.end - ui.grid);
        else if (mode === 'end') p.loop.end = Math.max(sn(b), p.loop.start + ui.grid);
        else if (mode === 'move') {
          const d = sn(b - b0 + start) - start;
          p.loop.start = Math.max(0, start + d);
          p.loop.end = p.loop.start + (end - start);
        } else {
          const a = sn(Math.min(b, b0)), z = sn(Math.max(b, b0));
          if (z - a >= ui.grid) {
            p.loop.start = a;
            p.loop.end = z;
            p.loop.enabled = true;
          }
        }
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) endGesture('loop range');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const [editingMarker, setEditingMarker] = createSignal<string | null>(null);

  const onMarkerDown = (e: PointerEvent, id: string, beat0: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const x0 = e.clientX;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      if (!moved) {
        moved = true;
        beginGesture();
      }
      const b = Math.max(0, snapBeat(beat0 + (ev.clientX - x0) / ui.pxPerBeat, ui.snap ? 1 : 0, ui.snap));
      live((p) => {
        const m = p.markers.find((x) => x.id === id);
        if (m) m.beat = b;
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) {
        live((p) => p.markers.sort((a, z) => a.beat - z.beat));
        endGesture('move section');
      } else seek(beat0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const bars = createMemo(() => {
    const n = Math.ceil(totalBeats() / BEATS_PER_BAR);
    const every = ui.pxPerBeat * 4 < 26 ? (ui.pxPerBeat * 4 < 12 ? 8 : 4) : ui.pxPerBeat * 4 < 48 ? 2 : 1;
    const out: number[] = [];
    for (let i = 0; i < n; i += every) out.push(i);
    return out;
  });

  const gridBg = createMemo(() => {
    const beat = ui.pxPerBeat;
    const bar = beat * BEATS_PER_BAR;
    const sub = ui.snap && ui.grid * beat >= 8 ? ui.grid * beat : 0;
    const layers = [
      `repeating-linear-gradient(90deg, var(--rule) 0 1px, transparent 1px ${bar}px)`,
      beat >= 10 ? `repeating-linear-gradient(90deg, var(--rule-soft) 0 1px, transparent 1px ${beat}px)` : '',
      sub && sub < beat ? `repeating-linear-gradient(90deg, rgba(58,56,52,0.45) 0 1px, transparent 1px ${sub}px)` : '',
    ].filter(Boolean);
    return layers.join(',');
  });

  return (
    <div
      class="arr"
      ref={scroller}
      onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      onWheel={onWheel}
      onDragLeave={(e) => {
        if (!scroller.contains(e.relatedTarget as Node)) setDropBeat(null);
      }}
    >
      <div class="arr-inner" style={{ width: `${headerW + timelineW()}px` }}>
        <div class="arr-top">
          <div class="arr-corner">
            <span class="arr-corner-label">Tracks</span>
            <button type="button" class="ghost small" onClick={addTrack} title="Add a track">
              Add track
            </button>
          </div>
          <div class="ruler" style={{ width: `${timelineW()}px` }}>
            <div
              class="ruler-sections"
              onDblClick={(e) => addMarker(beatAtClientX(e.clientX))}
              title="Double-click to add a section marker"
            >
              <For each={project.markers}>
                {(m) => (
                  <div class="marker" style={{ left: `${m.beat * ui.pxPerBeat}px` }} onPointerDown={(e) => onMarkerDown(e, m.id, m.beat)}>
                    <Show
                      when={editingMarker() === m.id}
                      fallback={
                        <span
                          class="marker-name"
                          onDblClick={(e) => {
                            e.stopPropagation();
                            setEditingMarker(m.id);
                          }}
                        >
                          {m.name}
                        </span>
                      }
                    >
                      <input
                        class="marker-input"
                        value={m.name}
                        ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
                        onPointerDown={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') e.currentTarget.blur();
                          if (e.key === 'Escape') setEditingMarker(null);
                        }}
                        onBlur={(e) => {
                          const v = e.currentTarget.value.trim();
                          if (editingMarker() === m.id && v && v !== m.name) updateMarker(m.id, { name: v });
                          setEditingMarker(null);
                        }}
                      />
                    </Show>
                    <button
                      type="button"
                      class="marker-x"
                      title={`Remove ${m.name}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => removeMarker(m.id)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </For>
            </div>
            <div class="ruler-bars" onPointerDown={onRulerDown} title="Click or drag to move the playhead">
              <For each={bars()}>
                {(b) => (
                  <span class="bar-num" style={{ left: `${b * BEATS_PER_BAR * ui.pxPerBeat}px` }}>
                    {b + 1}
                  </span>
                )}
              </For>
            </div>
            <div
              class="ruler-loop"
              onPointerDown={onLoopDown}
              onDblClick={() => setLoop({ enabled: !project.loop.enabled })}
              title="Drag to set the loop range · double-click to toggle looping"
            >
              <div
                class="loop-range"
                classList={{ on: project.loop.enabled }}
                style={{ left: `${project.loop.start * ui.pxPerBeat}px`, width: `${(project.loop.end - project.loop.start) * ui.pxPerBeat}px` }}
              />
            </div>
          </div>
        </div>

        <div class="arr-body" style={{ '--grid-bg': gridBg() }}>
          <For each={project.tracks}>
            {(track) => (
              <div class="arr-row" style={{ height: `${ui.trackHeight}px` }}>
                <TrackHeader track={track} />
                <div
                  class="lane"
                  style={{ width: `${timelineW()}px` }}
                  onPointerDown={onLaneDown}
                  onDblClick={(e) => onLaneDbl(e, track.id)}
                  onDragOver={(e) => onDragOver(e, track.id)}
                  onDrop={(e) => onDrop(e, track.id)}
                  data-track-id={track.id}
                >
                  <For each={project.clips.filter((c) => c.trackId === track.id)}>{(clip) => <ClipView clip={clip} view={view} />}</For>
                  <Show when={dropBeat()?.trackId === track.id}>
                    <div class="drop-marker" style={{ left: `${dropBeat()!.beat * ui.pxPerBeat}px` }} />
                  </Show>
                </div>
              </div>
            )}
          </For>
          <Show when={project.clips.length === 0}>
            <div class="arr-empty" style={{ left: `${headerW + 24}px` }}>
              <p class="arr-empty-title">Start with a sound.</p>
              <p>Drop audio files on a track, drag a sample from the pool, or record one from the capture panel. Double-click a lane to start a tracker pattern.</p>
            </div>
          </Show>
          <Show when={project.loop.enabled}>
            <div
              class="loop-shade"
              style={{ left: `${headerW + project.loop.start * ui.pxPerBeat}px`, width: `${(project.loop.end - project.loop.start) * ui.pxPerBeat}px` }}
            />
          </Show>
          <For each={project.markers}>{(m) => <div class="marker-line" style={{ left: `${headerW + m.beat * ui.pxPerBeat}px` }} />}</For>
          <Show when={!playing()}>
            <div class="cursor-line" style={{ left: `${headerW + ui.cursor * ui.pxPerBeat}px` }} />
          </Show>
          <div class="playhead" classList={{ live: playing() }} style={{ transform: `translateX(${headerW + playhead() * ui.pxPerBeat}px)` }} />
        </div>
      </div>
    </div>
  );
}

function TrackHeader(props: { track: Track }) {
  const [editing, setEditing] = createSignal(false);
  const t = () => props.track;
  const armed = () => ui.capture.destTrackId === t().id;
  const level = () => meters().tracks[t().id] ?? 0;
  return (
    <div class="track-head" style={{ '--track-color': TRACK_COLORS[t().color].line }}>
      <button
        type="button"
        class="track-chip"
        title="Change track colour"
        aria-label={`Track colour: ${t().color}`}
        onClick={() => updateTrack(t().id, 'track colour', { color: COLORS[(COLORS.indexOf(t().color) + 1) % COLORS.length] })}
      />
      <div class="track-main">
        <Show
          when={editing()}
          fallback={
            <span class="track-name" onDblClick={() => setEditing(true)} title="Double-click to rename">
              {t().name}
            </span>
          }
        >
          <input
            class="track-name-input"
            value={t().name}
            ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditing(false);
            }}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (editing() && v && v !== t().name) updateTrack(t().id, 'rename track', { name: v });
              setEditing(false);
            }}
          />
        </Show>
        <div class="track-buttons">
          <button type="button" class="tb mute" aria-pressed={t().mute} title="Mute" onClick={() => updateTrack(t().id, 'mute', { mute: !t().mute })}>
            M
          </button>
          <button type="button" class="tb solo" aria-pressed={t().solo} title="Solo" onClick={() => updateTrack(t().id, 'solo', { solo: !t().solo })}>
            S
          </button>
          <button
            type="button"
            class="tb arm"
            aria-pressed={armed()}
            title="Capture destination — new recordings and prints land on this track"
            onClick={() => {
              setUi('capture', 'destTrackId', t().id);
              setUi('captureOpen', true);
            }}
          >
            ●
          </button>
          <button type="button" class="tb remove" title="Remove track" onClick={() => removeTrack(t().id)}>
            ×
          </button>
        </div>
        <div class="track-meter" style={{ width: `${Math.min(100, Math.max(0, (20 * Math.log10(level() || 1e-6) + 60) / 60) * 100)}%` }} />
      </div>
    </div>
  );
}

