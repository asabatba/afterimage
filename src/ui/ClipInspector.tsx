import { Show, createEffect, on, onCleanup, onMount, createSignal } from 'solid-js';
import { unwrap } from 'solid-js/store';
import type { AudioClip, Project } from '../model/types';
import {
  MIN_REGION,
  clipRate,
  contentLengthBeats,
  effectivePitch,
  normalizeClip,
  regionDuration,
  beatsToSec,
  formatBBT,
} from '../model/timing';
import { beginGesture, endGesture, live, project, samples, samplesVersion, playhead, playing } from '../store/app';
import { instrumentFromClip, updateClip } from '../store/actions';
import { NumberField, Segmented, Toggle, bindEdit, fmtSigned } from './controls';
import { TRACK_COLORS, drawSampleWave, setupCanvas } from './draw';

function clipEdit(id: string, label: string, fn: (c: AudioClip, v: number, p: Project) => void) {
  return bindEdit(label, (p, v) => {
    const i = p.clips.findIndex((c) => c.id === id);
    if (i < 0 || p.clips[i].kind !== 'audio') return;
    const c = structuredClone(unwrap(p.clips[i])) as AudioClip;
    fn(c, v, p);
    p.clips[i] = normalizeClip(c, p.bpm);
  }, { checkOverlaps: true });
}

export function ClipInspector(props: { clip: AudioClip }) {
  const c = () => props.clip;
  const meta = () => project.samples.find((s) => s.id === c().sampleId);
  const bpm = () => project.bpm;
  const rate = () => clipRate(c(), bpm());
  const id = () => c().id;
  const track = () => project.tracks.find((t) => t.id === c().trackId);

  const set = (label: string, patch: Partial<AudioClip>) => updateClip(id(), label, (x) => ({ ...(x as AudioClip), ...patch }));

  const sourceInfo = () => {
    const m = meta();
    const cap = m?.capture;
    if (!m) return '';
    if (m.kind === 'import') return m.fileName ? `Imported from ${m.fileName}` : 'Imported';
    if (!cap) return m.kind === 'print' ? 'Printed' : 'Recorded';
    const range = `${formatBBT(cap.startBeat)} → ${formatBBT(cap.endBeat)} at ${cap.bpm} bpm`;
    if (cap.source === 'input') return `Recorded from ${cap.deviceLabel ?? 'input'}, ${range}`;
    const what = cap.source === 'master' ? 'the master bus' : (project.tracks.find((t) => t.id === cap.trackId)?.name ?? cap.trackName ?? 'a track');
    return `Printed from ${what}, ${range} · ${cap.clipIds?.length ?? 0} source clip${cap.clipIds?.length === 1 ? '' : 's'}`;
  };

  return (
    <div class="inspector">
      <div class="insp-wave">
        <div class="insp-title">
          <input
            class="name-input"
            value={c().name ?? meta()?.name ?? ''}
            aria-label="Clip name"
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            onChange={(e) => set('rename clip', { name: e.currentTarget.value })}
          />
          <span class="insp-sub">{sourceInfo()}</span>
        </div>
        <RegionEditor clip={c()} color={TRACK_COLORS[track()?.color ?? 'amber'].wave} />
        <div class="insp-readout">
          <span>
            Region <b>{c().srcStart.toFixed(3)}</b>–<b>{c().srcEnd.toFixed(3)}</b> s
          </span>
          <span>
            Plays <b>{beatsToSec(contentLengthBeats(c(), bpm()), bpm()).toFixed(3)}</b> s per pass
          </span>
          <span>
            Speed <b>{(rate() * 100).toFixed(1)}%</b>
          </span>
          <span>
            Pitch <b>{fmtSigned(effectivePitch(c(), bpm()), 2)}</b> st
          </span>
        </div>
      </div>

      <div class="insp-controls">
        <fieldset>
          <legend>Level</legend>
          <NumberField label="Gain" value={c().gainDb} min={-48} max={24} step={0.1} dragPx={2} unit="dB" format={(v) => fmtSigned(v, 1)} edit={clipEdit(id(), 'gain', (x, v) => (x.gainDb = v))} />
          <NumberField label="Fade in" value={c().fadeIn} min={0} max={c().length} step={1 / 16} dragPx={3} unit="beats" format={(v) => v.toFixed(2)} edit={clipEdit(id(), 'fade', (x, v) => (x.fadeIn = Math.min(v, x.length - x.fadeOut)))} />
          <NumberField label="Fade out" value={c().fadeOut} min={0} max={c().length} step={1 / 16} dragPx={3} unit="beats" format={(v) => v.toFixed(2)} edit={clipEdit(id(), 'fade', (x, v) => (x.fadeOut = Math.min(v, x.length - x.fadeIn)))} />
        </fieldset>

        <fieldset>
          <legend>Pitch</legend>
          <NumberField
            label="Semitones"
            value={c().semitones}
            min={-24}
            max={24}
            step={1}
            dragPx={8}
            format={(v) => fmtSigned(v)}
            disabled={c().repitch}
            edit={clipEdit(id(), 'pitch', (x, v) => (x.semitones = v))}
            title="Shift pitch without changing duration"
          />
          <NumberField
            label="Cents"
            value={c().cents}
            min={-100}
            max={100}
            step={1}
            dragPx={2}
            format={(v) => fmtSigned(v)}
            disabled={c().repitch}
            edit={clipEdit(id(), 'fine tune', (x, v) => (x.cents = v))}
          />
          <Toggle
            label="Repitch"
            on={c().repitch}
            onChange={(v) => set(v ? 'repitch on' : 'repitch off', { repitch: v })}
            title="Couple speed and pitch like tape — no time-stretch processing"
          />
        </fieldset>

        <fieldset>
          <legend>Time</legend>
          <Segmented
            label="Timing"
            value={c().timing}
            options={[
              { value: 'free', label: 'Free', title: 'Plays at its own speed regardless of tempo' },
              { value: 'tempo', label: 'Follow tempo', title: 'Keeps its beat length when the project tempo changes' },
            ]}
            onChange={(v) => {
              if (v === c().timing) return;
              if (v === 'tempo') {
                // Keep the current speed: source tempo = project tempo / current rate.
                set('follow tempo', { timing: 'tempo', sourceBpm: bpm() / rate() });
              } else set('free timing', { timing: 'free', stretch: 1 / rate() });
            }}
          />
          <Show
            when={c().timing === 'tempo'}
            fallback={
              <NumberField
                label="Length"
                value={c().stretch * 100}
                min={10}
                max={1000}
                step={1}
                dragPx={2}
                unit="%"
                format={(v) => v.toFixed(0)}
                edit={clipEdit(id(), 'stretch', (x, v) => (x.stretch = v / 100))}
                title="Duration relative to the original (pitch is kept unless Repitch is on). Alt-drag a clip's right edge to stretch."
              />
            }
          >
            <NumberField
              label="Source tempo"
              value={c().sourceBpm}
              min={20}
              max={600}
              step={0.1}
              dragPx={2}
              unit="bpm"
              format={(v) => v.toFixed(1)}
              edit={clipEdit(id(), 'source tempo', (x, v) => (x.sourceBpm = v))}
            />
            <NumberField
              label="Source beats"
              value={(regionDuration(c()) * c().sourceBpm) / 60}
              min={0.25}
              max={256}
              step={0.25}
              dragPx={6}
              format={(v) => v.toFixed(2)}
              edit={clipEdit(id(), 'source beats', (x, v) => (x.sourceBpm = (v * 60) / regionDuration(x)))}
              title="How many beats the region spans; sets the source tempo"
            />
          </Show>
          <Toggle
            label="Loop"
            on={c().loop}
            onChange={(v) =>
              updateClip(id(), v ? 'loop on' : 'loop off', (x) => {
                const a = x as AudioClip;
                return v ? { ...a, loop: true, loopOffset: 0, length: a.length } : normalizeClip({ ...a, loop: false }, bpm());
              })
            }
            title="Repeat the region to fill the clip; drag the right edge to extend"
          />
        </fieldset>

        <div class="insp-actions">
          <button
            type="button"
            class="ghost"
            onClick={() => set('reset pitch & time', { semitones: 0, cents: 0, stretch: 1, timing: 'free', repitch: false })}
          >
            Reset pitch & time
          </button>
          <button type="button" class="ghost" onClick={() => instrumentFromClip(id())} title="Use this region as a tracker instrument">
            Make instrument
          </button>
        </div>
      </div>
      <Show when={playing() && playhead() >= c().start && playhead() < c().start + c().length}>
        <span class="sr" aria-live="off">
          Playing
        </span>
      </Show>
    </div>
  );
}

/** Whole-sample waveform with draggable region bounds. */
function RegionEditor(props: { clip: AudioClip; color: string }) {
  let wrap!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const [w, setW] = createSignal(600);
  const h = 120;
  const meta = () => project.samples.find((s) => s.id === props.clip.sampleId);
  const dur = () => meta()?.duration ?? 1;
  const x = (s: number) => (s / dur()) * w();

  onMount(() => {
    const ro = new ResizeObserver(() => setW(wrap.clientWidth));
    ro.observe(wrap);
    onCleanup(() => ro.disconnect());
  });

  createEffect(
    on([w, () => props.clip.sampleId, samplesVersion, () => props.color], () => {
      const s = samples.get(props.clip.sampleId);
      const g = setupCanvas(canvas, w(), h);
      if (s) drawSampleWave(g, s.peaks, s.buffer.duration, w(), h, props.color);
    }),
  );

  const drag = (e: PointerEvent, which: 'start' | 'end' | 'both') => {
    e.preventDefault();
    e.stopPropagation();
    const id = props.clip.id;
    const x0 = e.clientX;
    const a0 = props.clip.srcStart, b0 = props.clip.srcEnd;
    const D = dur();
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        moved = true;
        beginGesture();
      }
      const ds = ((ev.clientX - x0) / w()) * D;
      live((p) => {
        const i = p.clips.findIndex((c) => c.id === id);
        if (i < 0) return;
        const c = { ...(p.clips[i] as AudioClip) };
        if (which === 'start') c.srcStart = Math.min(Math.max(0, a0 + ds), c.srcEnd - MIN_REGION);
        else if (which === 'end') c.srcEnd = Math.max(Math.min(D, b0 + ds), c.srcStart + MIN_REGION);
        else {
          const len = b0 - a0;
          c.srcStart = Math.min(Math.max(0, a0 + ds), D - len);
          c.srcEnd = c.srcStart + len;
        }
        p.clips[i] = normalizeClip(c, p.bpm);
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) endGesture('region');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div class="region" ref={wrap} style={{ height: `${h}px` }}>
      <canvas ref={canvas} />
      <div class="region-dim" style={{ left: 0, width: `${x(props.clip.srcStart)}px` }} />
      <div class="region-dim" style={{ left: `${x(props.clip.srcEnd)}px`, right: 0 }} />
      <div
        class="region-body"
        style={{ left: `${x(props.clip.srcStart)}px`, width: `${x(props.clip.srcEnd) - x(props.clip.srcStart)}px` }}
        onPointerDown={(e) => drag(e, 'both')}
        title="Drag to move the region (slip)"
      />
      <div class="region-handle" style={{ left: `${x(props.clip.srcStart)}px` }} onPointerDown={(e) => drag(e, 'start')} title="Region start" />
      <div class="region-handle end" style={{ left: `${x(props.clip.srcEnd)}px` }} onPointerDown={(e) => drag(e, 'end')} title="Region end" />
    </div>
  );
}
