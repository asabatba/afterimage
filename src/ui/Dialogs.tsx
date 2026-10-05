import { createResource, createSignal, For, Show } from 'solid-js';
import { beatsToSec, formatBBT, formatTime } from '../model/timing';
import type { WavFormat } from '../model/wav';
import { exportWav, sectionRange, songRange } from '../store/actions';
import { dismissToast, project, setProject, setUi, toast, toasts, ui } from '../store/app';
import { deleteProjectById, duplicateCurrentProject, listProjects, newProject, openProject } from '../store/session';
import { NumberField, Segmented } from './controls';

function Modal(props: { title: string; onClose: () => void; children: any }) {
  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') props.onClose();
        }}
      >
        <div class="modal-head">
          <h2>{props.title}</h2>
          <button type="button" class="icon-btn" onClick={props.onClose} title="Close">
            ×
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

export function ExportDialog() {
  const [which, setWhich] = createSignal<'song' | 'loop' | string>('song');
  const [tail, setTail] = createSignal(3);
  const [format, setFormat] = createSignal<WavFormat>('pcm24');
  const [busy, setBusy] = createSignal(false);
  const range = (): [number, number] => {
    const w = which();
    if (w === 'song') return songRange();
    if (w === 'loop') return [project.loop.start, project.loop.end];
    return sectionRange(w) ?? songRange();
  };
  const run = async () => {
    setBusy(true);
    try {
      const [a, b] = range();
      const label = which() === 'song' ? '' : which() === 'loop' ? ' (loop)' : ` (${project.markers.find((m) => m.id === which())?.name})`;
      const r = await exportWav([a, b], tail(), format(), `${project.name}${label}`);
      toast(
        r.peak > 1 ? `Exported. The mix peaks at +${(20 * Math.log10(r.peak)).toFixed(1)} dBFS — lower the master to avoid clipping.` : 'Exported WAV.',
        r.peak > 1 ? 'warn' : 'info',
        6000,
      );
      setUi('exportOpen', false);
    } catch (e: any) {
      toast(`Export failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Export WAV" onClose={() => setUi('exportOpen', false)}>
      <div class="modal-body">
        <label class="field">
          <span class="nf-label">Range</span>
          <select value={which()} onChange={(e) => setWhich(e.currentTarget.value)}>
            <option value="song">Whole song</option>
            <option value="loop">Loop range</option>
            <For each={project.markers}>{(m) => <option value={m.id}>{`Section: ${m.name}`}</option>}</For>
          </select>
        </label>
        <p class="cap-note">
          {formatBBT(range()[0])} → {formatBBT(range()[1])}, {formatTime(beatsToSec(range()[1] - range()[0], project.bpm))} plus {tail().toFixed(1)} s of
          effects tail.
        </p>
        <NumberField
          label="Effects tail"
          value={tail()}
          min={0}
          max={30}
          step={0.5}
          dragPx={4}
          unit="s"
          format={(v) => v.toFixed(1)}
          edit={{ begin() {}, end() {}, change: setTail }}
          title="Extra time after the range so delay and reverb can ring out"
        />
        <span class="nf-label">Format</span>
        <Segmented
          label="Format"
          value={format()}
          onChange={setFormat}
          options={[
            { value: 'pcm16', label: '16-bit' },
            { value: 'pcm24', label: '24-bit' },
            { value: 'f32', label: '32-bit float' },
          ]}
        />
        <p class="cap-note">Stereo, at the project sample rate. Rendering uses the same engine, effects and timing as playback.</p>
      </div>
      <div class="modal-foot">
        <button type="button" class="ghost" onClick={() => setUi('exportOpen', false)}>
          Cancel
        </button>
        <button type="button" class="primary" disabled={busy()} onClick={run}>
          {busy() ? 'Rendering…' : 'Export WAV'}
        </button>
      </div>
    </Modal>
  );
}

export function ProjectsDialog() {
  const [list, { refetch }] = createResource(() => listProjects());
  const close = () => setUi('projectsOpen', false);
  return (
    <Modal title="Projects" onClose={close}>
      <div class="modal-body">
        <label class="field">
          <span class="nf-label">This project’s name</span>
          <input
            class="name-input"
            value={project.name}
            onChange={(e) => setProject('name', e.currentTarget.value.trim() || 'Untitled collage')}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </label>
        <ul class="project-list">
          <For each={list() ?? []}>
            {(row) => (
              <li classList={{ current: row.id === project.id }}>
                <button
                  type="button"
                  class="project-open"
                  disabled={row.id === project.id}
                  onClick={async () => {
                    await openProject(row.id);
                    close();
                  }}
                >
                  <span class="pool-name">{row.name}</span>
                  <span class="pool-dur">{new Date(row.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </button>
                <button
                  type="button"
                  class="icon-btn"
                  title={`Delete ${row.name}`}
                  onClick={async () => {
                    if (!confirm(`Delete “${row.name}” and all its samples from this browser?`)) return;
                    await deleteProjectById(row.id);
                    void refetch();
                  }}
                >
                  ×
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="modal-foot">
        <button
          type="button"
          class="ghost"
          onClick={async () => {
            await duplicateCurrentProject(`${project.name} copy`);
            close();
          }}
        >
          Duplicate this project
        </button>
        <button
          type="button"
          class="primary"
          onClick={async () => {
            await newProject();
            close();
          }}
        >
          New project
        </button>
      </div>
    </Modal>
  );
}

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      <For each={toasts()}>
        {(t) => (
          <div class={`toast ${t.kind}`}>
            <span>{t.text}</span>
            <button type="button" class="icon-btn" title="Dismiss" onClick={() => dismissToast(t.id)}>
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

export function Dialogs() {
  return (
    <>
      <Show when={ui.exportOpen}>
        <ExportDialog />
      </Show>
      <Show when={ui.projectsOpen}>
        <ProjectsDialog />
      </Show>
      <Toasts />
    </>
  );
}
