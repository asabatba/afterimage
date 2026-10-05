import { Match, Show, Switch, createMemo } from 'solid-js';
import type { AudioClip, PatternClip } from '../model/types';
import { project, setUi, ui } from '../store/app';
import { deleteSelected, duplicateSelected } from '../store/actions';
import { ClipInspector } from './ClipInspector';
import { TrackerEditor } from './TrackerEditor';
import { SamplerEditor } from './SamplerEditor';
import { Mixer } from './Mixer';

export function BottomPanel() {
  let startY = 0, startH = 0;
  const onResize = (e: PointerEvent) => {
    e.preventDefault();
    startY = e.clientY;
    startH = ui.bottomHeight;
    const move = (ev: PointerEvent) => setUi('bottomHeight', Math.max(140, Math.min(window.innerHeight - 220, startH + startY - ev.clientY)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <section class="bottom" classList={{ closed: !ui.bottomOpen }} style={{ height: ui.bottomOpen ? `${ui.bottomHeight}px` : undefined }}>
      <div class="bottom-resize" onPointerDown={onResize} role="separator" aria-orientation="horizontal" aria-label="Resize panel" />
      <div class="bottom-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={ui.bottomTab === 'detail'} onClick={() => setUi({ bottomTab: 'detail', bottomOpen: true })}>
          <DetailTitle />
        </button>
        <button type="button" role="tab" aria-selected={ui.bottomTab === 'mixer'} onClick={() => setUi({ bottomTab: 'mixer', bottomOpen: true })}>
          Mixer
        </button>
        <span class="tp-spacer" />
        <button type="button" class="ghost small" onClick={() => setUi('bottomOpen', !ui.bottomOpen)} aria-expanded={ui.bottomOpen}>
          {ui.bottomOpen ? 'Collapse' : 'Expand'}
        </button>
      </div>
      <Show when={ui.bottomOpen}>
        <div class="bottom-body">
          <Show when={ui.bottomTab === 'mixer'} fallback={<Detail />}>
            <Mixer />
          </Show>
        </div>
      </Show>
    </section>
  );
}

const selected = () => {
  const s = ui.selection;
  if (s.kind === 'clips' && s.ids.length === 1) return project.clips.find((c) => c.id === s.ids[0]) ?? null;
  return null;
};

function DetailTitle() {
  const t = createMemo(() => {
    const s = ui.selection;
    if (s.kind === 'instrument') return 'Sampler';
    const c = selected();
    if (c?.kind === 'audio') return 'Clip';
    if (c?.kind === 'pattern') return 'Tracker';
    return 'Detail';
  });
  return <>{t()}</>;
}

function Detail() {
  const instrument = () => (ui.selection.kind === 'instrument' ? project.instruments.find((i) => i.id === (ui.selection as any).id) : undefined);
  return (
    <Switch fallback={<Empty />}>
      <Match when={instrument()} keyed>
        {(ins) => <SamplerEditor instrument={project.instruments.find((i) => i.id === ins.id)!} />}
      </Match>
      <Match when={selected()?.kind === 'audio' && selected()!.id} keyed>
        {(id) => <ClipInspector clip={project.clips.find((c) => c.id === id) as AudioClip} />}
      </Match>
      <Match when={selected()?.kind === 'pattern' && selected()!.id} keyed>
        {(id) => <TrackerEditor clip={project.clips.find((c) => c.id === id) as PatternClip} />}
      </Match>
      <Match when={ui.selection.kind === 'clips' && (ui.selection as any).ids.length > 1}>
        <div class="detail-empty">
          <p>{(ui.selection as any).ids.length} clips selected.</p>
          <div class="insp-actions">
            <button type="button" class="ghost" onClick={duplicateSelected}>
              Duplicate
            </button>
            <button type="button" class="ghost" onClick={deleteSelected}>
              Delete
            </button>
          </div>
        </div>
      </Match>
    </Switch>
  );
}

function Empty() {
  return (
    <div class="detail-empty">
      <p class="detail-empty-title">Select a clip to shape it.</p>
      <p>
        Audio clips open their waveform, pitch and timing here; pattern clips open the tracker; instruments open the sampler. Space plays from the cursor, S splits at the
        playhead, Ctrl+D duplicates, Alt-drag copies, Shift-drag slips content, Alt-drag a right edge to stretch.
      </p>
    </div>
  );
}
