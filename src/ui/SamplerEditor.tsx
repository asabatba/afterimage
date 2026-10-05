import { For, createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { Instrument, Project } from '../model/types';
import { noteName } from '../model/tracker';
import { audio, beginGesture, endGesture, live, project, samples, samplesVersion } from '../store/app';
import { updateInstrument } from '../store/actions';
import { NumberField, Slider, Toggle, bindEdit, fmtHz, fmtSigned } from './controls';
import { drawSampleWave, setupCanvas } from './draw';
import { keyToNote } from '../model/tracker';

function insEdit(id: string, label: string, fn: (i: Instrument, v: number, p: Project) => void) {
  return bindEdit(label, (p, v) => {
    const i = p.instruments.find((x) => x.id === id);
    if (i) fn(i, v, p);
  });
}

export function SamplerEditor(props: { instrument: Instrument }) {
  const ins = () => props.instrument;
  const id = () => ins().id;
  const meta = () => project.samples.find((s) => s.id === ins().sampleId);
  const [octave, setOctave] = createSignal(4);
  const held = new Map<string, () => void>();

  const play = (note: number) => audio().engine.auditionNote(ins(), note);

  return (
    <div
      class="sampler"
      tabIndex={0}
      aria-label={`Sampler ${ins().name}. Use the computer keyboard to play.`}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey) return;
        if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
          setOctave((o) => Math.max(0, Math.min(8, o + (e.code === 'BracketLeft' ? -1 : 1))));
          e.preventDefault();
          return;
        }
        const n = keyToNote(e.code, octave());
        if (n === null || e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        held.set(e.code, play(n));
      }}
      onKeyUp={(e) => {
        held.get(e.code)?.();
        held.delete(e.code);
      }}
    >
      <div class="insp-wave">
        <div class="insp-title">
          <input
            class="name-input"
            aria-label="Instrument name"
            value={ins().name}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            onChange={(e) => updateInstrument(id(), 'rename instrument', { name: e.currentTarget.value })}
          />
          <span class="insp-sub">Sampler using “{meta()?.name ?? 'missing sample'}”. Focus this panel and play with Z–M, Q–P; [ and ] change octave.</span>
        </div>
        <InstrumentWave instrument={ins()} />
        <Keyboard octave={octave()} onPlay={play} />
      </div>
      <div class="insp-controls">
        <fieldset>
          <legend>Tuning</legend>
          <NumberField label="Root" value={ins().rootNote} min={0} max={127} step={1} dragPx={6} format={(v) => noteName(v)} edit={insEdit(id(), 'root note', (i, v) => (i.rootNote = v))} title="The note at which the sample plays at its recorded pitch" />
          <NumberField label="Fine" value={ins().fineTune} min={-100} max={100} step={1} dragPx={2} unit="ct" format={(v) => fmtSigned(v)} edit={insEdit(id(), 'fine tune', (i, v) => (i.fineTune = v))} />
          <NumberField label="Gain" value={ins().gainDb} min={-48} max={12} step={0.1} dragPx={2} unit="dB" format={(v) => fmtSigned(v, 1)} edit={insEdit(id(), 'gain', (i, v) => (i.gainDb = v))} />
        </fieldset>
        <fieldset>
          <legend>Envelope</legend>
          <NumberField label="Attack" value={ins().env.attack * 1000} min={1} max={5000} step={1} dragPx={1} unit="ms" format={(v) => v.toFixed(0)} edit={insEdit(id(), 'attack', (i, v) => (i.env.attack = v / 1000))} />
          <NumberField label="Decay" value={ins().env.decay * 1000} min={1} max={10000} step={5} dragPx={1} unit="ms" format={(v) => v.toFixed(0)} edit={insEdit(id(), 'decay', (i, v) => (i.env.decay = v / 1000))} />
          <NumberField label="Sustain" value={ins().env.sustain * 100} min={0} max={100} step={1} dragPx={2} unit="%" format={(v) => v.toFixed(0)} edit={insEdit(id(), 'sustain', (i, v) => (i.env.sustain = v / 100))} />
          <NumberField label="Release" value={ins().env.release * 1000} min={5} max={10000} step={5} dragPx={1} unit="ms" format={(v) => v.toFixed(0)} edit={insEdit(id(), 'release', (i, v) => (i.env.release = v / 1000))} />
        </fieldset>
        <fieldset>
          <legend>Loop and filter</legend>
          <Toggle label="Loop" on={ins().loop} onChange={(v) => updateInstrument(id(), v ? 'loop on' : 'loop off', { loop: v })} title="Sustain by looping between the blue markers" />
          <Slider
            label="Cutoff"
            min={Math.log2(40)}
            max={Math.log2(20000)}
            value={Math.log2(ins().filterCutoff)}
            format={() => fmtHz(ins().filterCutoff)}
            edit={insEdit(id(), 'cutoff', (i, v) => (i.filterCutoff = Math.round(2 ** v)))}
          />
          <NumberField label="Resonance" value={ins().filterQ} min={0.1} max={20} step={0.1} dragPx={3} format={(v) => v.toFixed(1)} edit={insEdit(id(), 'resonance', (i, v) => (i.filterQ = v))} />
        </fieldset>
      </div>
    </div>
  );
}

function InstrumentWave(props: { instrument: Instrument }) {
  let wrap!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const [w, setW] = createSignal(600);
  const h = 110;
  const dur = () => project.samples.find((s) => s.id === props.instrument.sampleId)?.duration ?? 1;
  const x = (s: number) => (s / dur()) * w();
  onMount(() => {
    const ro = new ResizeObserver(() => setW(wrap.clientWidth));
    ro.observe(wrap);
    onCleanup(() => ro.disconnect());
  });
  createEffect(
    on([w, () => props.instrument.sampleId, samplesVersion], () => {
      const s = samples.get(props.instrument.sampleId);
      const g = setupCanvas(canvas, w(), h);
      if (s) drawSampleWave(g, s.peaks, s.buffer.duration, w(), h, '#d9b47c');
    }),
  );
  const drag = (e: PointerEvent, key: 'start' | 'end' | 'loopStart' | 'loopEnd') => {
    e.preventDefault();
    e.stopPropagation();
    const id = props.instrument.id;
    const x0 = e.clientX;
    const v0 = props.instrument[key];
    const D = dur();
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        moved = true;
        beginGesture();
      }
      const v = Math.max(0, Math.min(D, v0 + ((ev.clientX - x0) / w()) * D));
      live((p) => {
        const i = p.instruments.find((q) => q.id === id);
        if (!i) return;
        if (key === 'start') i.start = Math.min(v, i.end - 0.001);
        if (key === 'end') i.end = Math.max(v, i.start + 0.001);
        if (key === 'loopStart') i.loopStart = Math.min(v, i.loopEnd - 0.001);
        if (key === 'loopEnd') i.loopEnd = Math.max(v, i.loopStart + 0.001);
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) endGesture('sampler region');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  return (
    <div class="region" ref={wrap} style={{ height: `${h}px` }}>
      <canvas ref={canvas} />
      <div class="region-dim" style={{ left: 0, width: `${x(props.instrument.start)}px` }} />
      <div class="region-dim" style={{ left: `${x(props.instrument.end)}px`, right: 0 }} />
      <div class="region-handle" style={{ left: `${x(props.instrument.start)}px` }} onPointerDown={(e) => drag(e, 'start')} title="Sample start" />
      <div class="region-handle end" style={{ left: `${x(props.instrument.end)}px` }} onPointerDown={(e) => drag(e, 'end')} title="Sample end" />
      <div class="loop-handle" classList={{ off: !props.instrument.loop }} style={{ left: `${x(props.instrument.loopStart)}px` }} onPointerDown={(e) => drag(e, 'loopStart')} title="Loop start" />
      <div class="loop-handle end" classList={{ off: !props.instrument.loop }} style={{ left: `${x(props.instrument.loopEnd)}px` }} onPointerDown={(e) => drag(e, 'loopEnd')} title="Loop end" />
    </div>
  );
}

const BLACK = new Set([1, 3, 6, 8, 10]);

function Keyboard(props: { octave: number; onPlay: (n: number) => () => void }) {
  const notes = () => Array.from({ length: 25 }, (_, i) => (props.octave + 1) * 12 + i);
  const whites = () => notes().filter((n) => !BLACK.has(n % 12));
  const blacks = () =>
    notes()
      .filter((n) => BLACK.has(n % 12))
      .map((n) => ({ n, left: whites().filter((w) => w < n).length }));
  const press = (e: PointerEvent, n: number) => {
    e.preventDefault();
    const release = props.onPlay(n);
    const up = () => {
      release();
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointerup', up);
  };
  return (
    <div class="keys" role="group" aria-label="Audition keyboard" style={{ '--whites': whites().length }}>
      <For each={whites()}>
        {(n) => (
          <button type="button" class="key" aria-label={noteName(n)} onPointerDown={(e) => press(e, n)}>
            <span>{n % 12 === 0 ? noteName(n).replace('-', '') : ''}</span>
          </button>
        )}
      </For>
      <For each={blacks()}>
        {(b) => (
          <button
            type="button"
            class="key black"
            aria-label={noteName(b.n)}
            style={{ left: `calc(${b.left} * 100% / var(--whites))` }}
            onPointerDown={(e) => press(e, b.n)}
          />
        )}
      </For>
    </div>
  );
}
