import { For, Show, createSignal } from 'solid-js';
import type { SampleMeta } from '../model/types';
import { hex2 } from '../model/tracker';
import { audio, project, setUi, ui } from '../store/app';
import { importFiles, instrumentFromSample, openSample, removeInstrument, removeSample, renameSample, sampleUsage } from '../store/actions';
import { SAMPLE_MIME } from './dnd';

const fmtDur = (s: number) => (s < 10 ? `${s.toFixed(2)}s` : s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

export function Pool() {
  let input!: HTMLInputElement;
  const [over, setOver] = createSignal(false);
  const [auditioning, setAuditioning] = createSignal<string | null>(null);

  const audition = (id: string) => {
    const { engine } = audio();
    if (auditioning() === id) {
      engine.stopAudition();
      setAuditioning(null);
      return;
    }
    void engine.auditionSample(id);
    setAuditioning(id);
    const dur = project.samples.find((s) => s.id === id)?.duration ?? 1;
    setTimeout(() => setAuditioning((a) => (a === id ? null : a)), dur * 1000 + 100);
  };

  return (
    <aside
      class="pool"
      classList={{ over: over() }}
      aria-label="Pool"
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer?.files.length) void importFiles([...e.dataTransfer.files]);
      }}
    >
      <section class="pool-section">
        <div class="pool-head">
          <h2>Samples</h2>
          <button type="button" class="ghost small" onClick={() => input.click()}>
            Import
          </button>
          <input
            ref={input}
            type="file"
            accept="audio/*,.wav,.aif,.aiff,.flac,.mp3,.ogg,.m4a"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = '';
              if (files.length) void importFiles(files);
            }}
          />
        </div>
        <Show
          when={project.samples.length}
          fallback={<p class="pool-empty">Drop audio files here or use Import. Recordings and prints appear here too.</p>}
        >
          <ul class="pool-list">
            <For each={project.samples}>
              {(s) => <SampleRow s={s} playing={auditioning() === s.id} onAudition={() => audition(s.id)} />}
            </For>
          </ul>
        </Show>
      </section>

      <section class="pool-section">
        <div class="pool-head">
          <h2>Instruments</h2>
        </div>
        <Show when={project.instruments.length} fallback={<p class="pool-empty">Turn a short sample into a tracker instrument with its “Instrument” button.</p>}>
          <ul class="pool-list">
            <For each={project.instruments}>
              {(ins, i) => (
                <li
                  class="pool-item instrument"
                  classList={{
                    selected: ui.selection.kind === 'instrument' && ui.selection.id === ins.id,
                    current: ui.tracker.instrumentId === ins.id,
                  }}
                >
                  <button
                    type="button"
                    class="pool-main"
                    onClick={() => {
                      setUi('selection', { kind: 'instrument', id: ins.id });
                      setUi('tracker', 'instrumentId', ins.id);
                      setUi({ bottomOpen: true, bottomTab: 'detail' });
                    }}
                    title="Edit in the sampler and use for new tracker notes"
                  >
                    <span class="ins-index">{hex2(i() + 1)}</span>
                    <span class="pool-name">{ins.name}</span>
                  </button>
                  <button type="button" class="icon-btn" title={`Remove ${ins.name}`} onClick={() => removeInstrument(ins.id)}>
                    ×
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </aside>
  );
}

function SampleRow(props: { s: SampleMeta; playing: boolean; onAudition: () => void }) {
  const [editing, setEditing] = createSignal(false);
  const used = () => {
    const u = sampleUsage(props.s.id);
    return u.clips + u.instruments;
  };
  return (
    <li
      class="pool-item sample"
      classList={{ selected: ui.selection.kind === 'sample' && ui.selection.id === props.s.id }}
      draggable={!editing()}
      onDragStart={(e) => {
        e.dataTransfer!.setData(SAMPLE_MIME, props.s.id);
        e.dataTransfer!.effectAllowed = 'copy';
      }}
      title="Drag onto a track"
    >
      <button type="button" class="icon-btn audition" aria-pressed={props.playing} onClick={props.onAudition} title={props.playing ? 'Stop preview' : 'Preview'}>
        {props.playing ? '■' : '▶'}
      </button>
      <div class="pool-text">
        <Show
          when={editing()}
          fallback={
            <span
              class="pool-name"
              onClick={() => openSample(props.s.id)}
              onDblClick={() => setEditing(true)}
              title={`${props.s.name} — click to open in the sample editor, double-click to rename, drag onto a track`}
            >
              {props.s.name}
            </span>
          }
        >
          <input
            class="pool-input"
            value={props.s.name}
            ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditing(false);
            }}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (editing() && v && v !== props.s.name) renameSample(props.s.id, v);
              setEditing(false);
            }}
          />
        </Show>
        <span class="pool-meta">
          <span class="pool-dur">{fmtDur(props.s.duration)}</span>
          <Show when={props.s.kind !== 'import'}>
            <span class="pool-kind" title={props.s.kind === 'print' ? 'Printed from the project' : 'Recorded from an input'}>
              {props.s.kind === 'print' ? 'print' : 'take'}
            </span>
          </Show>
          <Show when={props.s.grid}>
            <span class="pool-kind grid" title={`Beat grid: ${props.s.grid!.bpm.toFixed(2)} bpm. New clips from this sample follow the project tempo.`}>
              {Math.round(props.s.grid!.bpm)} bpm
            </span>
          </Show>
          <button type="button" class="text-btn" onClick={() => openSample(props.s.id)} title="Zoom in, find beats and chords, and cut pieces out">
            Edit
          </button>
          <button type="button" class="text-btn" onClick={() => instrumentFromSample(props.s.id)} title="Make a tracker instrument from this sample">
            Instrument
          </button>
          <Show when={!used()}>
            <button type="button" class="text-btn" title="Remove from pool" onClick={() => removeSample(props.s.id)}>
              Remove
            </button>
          </Show>
        </span>
      </div>
    </li>
  );
}
