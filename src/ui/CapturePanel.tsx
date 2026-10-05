import { For, Show, createResource, createSignal } from 'solid-js';
import { BEATS_PER_BAR, formatBBT } from '../model/timing';
import { audio, project, setUi, toast, ui } from '../store/app';
import { startCapture } from '../store/actions';
import { CaptureManager } from '../audio/capture';
import { Meter, NumberField, Segmented, Toggle } from './controls';
import { captureStatus, elapsed, inputInfo, inputLevels, monitoring } from './captureState';

export function CapturePanel() {
  const c = () => ui.capture;
  const busy = () => captureStatus() !== 'idle';
  const [devices, { refetch }] = createResource(() => CaptureManager.listInputs());
  const [enabling, setEnabling] = createSignal(false);
  const isInput = () => c().source === 'input';
  const verb = () => (isInput() ? 'Record' : 'Print');

  const enable = async () => {
    setEnabling(true);
    try {
      const info = await audio().capture.enableInput(c().deviceId || undefined, !c().mono);
      if (ui.capture.offsetMs === 0) setUi('capture', 'offsetMs', audio().capture.suggestedOffsetMs());
      setUi('capture', 'deviceId', info.deviceId);
      void refetch();
    } catch (e: any) {
      toast(e?.message ?? String(e), 'error');
    } finally {
      setEnabling(false);
    }
  };

  const range = () => {
    if (c().length === 'loop') return `${formatBBT(project.loop.start)} → ${formatBBT(project.loop.end)} (loop range)`;
    if (c().length === 'bars') return `${c().bars} bar${c().bars > 1 ? 's' : ''} from ${formatBBT(ui.snap ? Math.round(ui.cursor / BEATS_PER_BAR) * BEATS_PER_BAR : ui.cursor)}`;
    return `From ${formatBBT(ui.cursor)} until you stop`;
  };

  const settingsLine = () => {
    const s = inputInfo()?.settings;
    if (!s) return '';
    const parts = [
      s.sampleRate ? `${s.sampleRate} Hz` : null,
      s.channelCount ? `${s.channelCount} ch` : null,
      s.echoCancellation ? 'echo cancellation on' : null,
      s.noiseSuppression ? 'noise suppression on' : null,
      s.autoGainControl ? 'auto gain on' : null,
    ].filter(Boolean);
    return parts.join(', ');
  };

  const processingOn = () => {
    const s = inputInfo()?.settings;
    return !!(s && (s.echoCancellation || s.noiseSuppression || s.autoGainControl));
  };

  return (
    <aside class="capture" aria-label="Capture">
      <div class="capture-head">
        <h2>Capture</h2>
        <button type="button" class="icon-btn" title="Close" onClick={() => setUi('captureOpen', false)}>
          ×
        </button>
      </div>

      <div class="cap-section">
        <label class="field">
          <span class="nf-label">Source</span>
          <select aria-label="Source" value={c().source} disabled={busy()} onChange={(e) => setUi('capture', 'source', e.currentTarget.value)}>
            <option value="input">Input (microphone or interface)</option>
            <option value="master">Master — the whole mix with effects</option>
            <For each={project.tracks}>{(t) => <option value={t.id}>{`${t.name} — after volume and pan`}</option>}</For>
          </select>
        </label>

        <Show when={isInput()}>
          <div class="cap-input">
            <Show
              when={inputInfo()}
              fallback={
                <button type="button" class="primary" disabled={enabling()} onClick={enable}>
                  {enabling() ? 'Asking for access…' : 'Enable input'}
                </button>
              }
            >
              <label class="field">
                <span class="nf-label">Device</span>
                <select
                  aria-label="Device"
                  value={c().deviceId}
                  disabled={busy()}
                  onChange={(e) => {
                    setUi('capture', 'deviceId', e.currentTarget.value);
                    void enable();
                  }}
                >
                  <For each={devices() ?? []}>{(d, i) => <option value={d.deviceId}>{d.label || `Input ${i() + 1}`}</option>}</For>
                </select>
              </label>
              <p class="cap-note" classList={{ warn: processingOn() }}>
                {processingOn() ? `The browser kept some speech processing on: ${settingsLine()}.` : `Raw input: ${settingsLine()}.`}
              </p>
              <div class="cap-levels">
                <Meter level={inputLevels()[0] ?? 0} label="Input left" />
                <Meter level={inputLevels()[1] ?? 0} label="Input right" />
              </div>
              <Toggle
                label="Monitor input"
                on={monitoring()}
                onChange={(v) => audio().capture.setMonitoring(v)}
                title="Hear the input through your outputs. Use headphones to avoid feedback."
              >
                {monitoring() ? 'Monitoring on' : 'Monitoring off'}
              </Toggle>
              <button type="button" class="text-btn" onClick={() => audio().capture.disableInput()}>
                Disable input
              </button>
            </Show>
          </div>
        </Show>
        <Show when={!isInput()}>
          <div class="cap-levels">
            <Meter level={inputLevels()[0] ?? 0} label="Capture level left" />
            <Meter level={inputLevels()[1] ?? 0} label="Capture level right" />
          </div>
          <p class="cap-note">Printing plays the range in real time, so live changes are captured. The metronome and previews are never included.</p>
        </Show>
      </div>

      <div class="cap-section">
        <label class="field">
          <span class="nf-label">Destination</span>
          <select aria-label="Destination" value={c().destTrackId ?? ''} disabled={busy()} onChange={(e) => setUi('capture', 'destTrackId', e.currentTarget.value)}>
            <For each={project.tracks}>{(t) => <option value={t.id}>{t.name}</option>}</For>
          </select>
        </label>
        <span class="nf-label">Length</span>
        <Segmented
          label="Length"
          value={c().length}
          disabled={busy()}
          options={[
            { value: 'free', label: 'Free' },
            { value: 'bars', label: 'Bars' },
            { value: 'loop', label: 'Loop range' },
          ]}
          onChange={(v) => setUi('capture', 'length', v)}
        />
        <div class="cap-row">
          <Show when={c().length === 'bars'}>
            <NumberField label="Bars" value={c().bars} min={1} max={64} step={1} dragPx={8} edit={{ begin() {}, end() {}, change: (v) => setUi('capture', 'bars', v) }} />
          </Show>
          <NumberField label="Count-in" value={c().countInBars} min={0} max={4} step={1} dragPx={12} unit={c().countInBars === 1 ? 'bar' : 'bars'} edit={{ begin() {}, end() {}, change: (v) => setUi('capture', 'countInBars', v) }} />
        </div>
        <p class="cap-note">{range()}</p>
        <div class="cap-row">
          <Show when={isInput()}>
            <NumberField
              label="Alignment"
              value={c().offsetMs}
              min={-500}
              max={1000}
              step={1}
              dragPx={2}
              unit="ms"
              format={(v) => v.toFixed(0)}
              edit={{ begin() {}, end() {}, change: (v) => setUi('capture', 'offsetMs', v) }}
              title="How late the input arrives. The take is moved earlier by this amount. Adjust if recordings land late or early."
            />
          </Show>
          <Toggle label="Mono" on={c().mono} onChange={(v) => setUi('capture', 'mono', v)} title="Save a single channel" disabled={busy()} />
        </div>
      </div>

      <div class="cap-actions">
        <Show
          when={busy()}
          fallback={
            <button type="button" class="primary rec-btn" onClick={() => void startCapture()} disabled={isInput() && !inputInfo()}>
              {verb()}
            </button>
          }
        >
          <Show when={c().length === 'free' && captureStatus() === 'recording'}>
            <button type="button" class="primary rec-btn" onClick={() => audio().capture.stop()}>
              Stop and keep
            </button>
          </Show>
          <button type="button" class="ghost" onClick={() => audio().capture.cancel()}>
            Cancel take
          </button>
        </Show>
      </div>
      <p class="cap-status" role="status">
        <Show when={busy()} fallback={<span>{isInput() ? 'Recordings become new samples and clips on the destination track.' : 'Prints become new samples; source clips stay as they are.'}</span>}>
          <span class="cap-live">
            {captureStatus() === 'count-in' ? 'Counting in…' : captureStatus() === 'finishing' ? 'Finishing the take…' : `${verb() === 'Record' ? 'Recording' : 'Printing'} ${elapsed().toFixed(1)} s`}
          </span>
        </Show>
      </p>
    </aside>
  );
}
