import { For } from 'solid-js';
import type { Project, Track } from '../model/types';
import { project } from '../store/app';
import { updateTrack } from '../store/actions';
import { Meter, NumberField, Slider, bindEdit, fmtDb, fmtHz, fmtPan, fmtPct } from './controls';
import { TRACK_COLORS } from './draw';
import { meters } from './meters';

const trackEdit = (id: string, label: string, fn: (t: Track, v: number) => void) =>
  bindEdit(label, (p, v) => {
    const t = p.tracks.find((x) => x.id === id);
    if (t) fn(t, v);
  });
const projEdit = (label: string, fn: (p: Project, v: number) => void) => bindEdit(label, fn);

const DELAY_OPTIONS = [
  { v: 0.25, label: '1/16' },
  { v: 0.5, label: '1/8' },
  { v: 0.75, label: '3/16' },
  { v: 1, label: '1/4' },
  { v: 1.5, label: '3/8' },
  { v: 2, label: '1/2' },
];

export function Mixer() {
  return (
    <div class="mixer" role="region" aria-label="Mixer">
      <For each={project.tracks}>{(t) => <Strip track={t} />}</For>
      <div class="strip fx-strip">
        <div class="strip-top">
          <span class="strip-name">Shared effects</span>
        </div>
        <div class="fx-block">
          <span class="fx-title">Delay</span>
          <label class="fx-row">
            <span class="nf-label">Time</span>
            <select
              value={project.fx.delayBeats}
              onChange={(e) => projEdit('delay time', (p, v) => (p.fx.delayBeats = v)).change(parseFloat(e.currentTarget.value))}
            >
              {DELAY_OPTIONS.map((o) => (
                <option value={o.v}>{o.label}</option>
              ))}
            </select>
          </label>
          <Slider label="Feedback" min={0} max={0.95} value={project.fx.delayFeedback} format={fmtPct} edit={projEdit('delay feedback', (p, v) => (p.fx.delayFeedback = v))} />
          <Slider label="Tone" min={Math.log2(500)} max={Math.log2(16000)} value={Math.log2(project.fx.delayTone)} format={() => fmtHz(project.fx.delayTone)} edit={projEdit('delay tone', (p, v) => (p.fx.delayTone = Math.round(2 ** v)))} />
          <Slider label="Return" min={0} max={1} value={project.fx.delayReturn} format={fmtPct} edit={projEdit('delay return', (p, v) => (p.fx.delayReturn = v))} />
        </div>
        <div class="fx-block">
          <span class="fx-title">Reverb</span>
          <NumberField label="Decay" value={project.fx.reverbSeconds} min={0.2} max={12} step={0.1} dragPx={3} unit="s" format={(v) => v.toFixed(1)} edit={projEdit('reverb decay', (p, v) => (p.fx.reverbSeconds = v))} />
          <NumberField label="Pre-delay" value={project.fx.reverbPreDelayMs} min={0} max={200} step={1} dragPx={2} unit="ms" format={(v) => v.toFixed(0)} edit={projEdit('reverb pre-delay', (p, v) => (p.fx.reverbPreDelayMs = v))} />
          <Slider label="Return" min={0} max={1} value={project.fx.reverbReturn} format={fmtPct} edit={projEdit('reverb return', (p, v) => (p.fx.reverbReturn = v))} />
        </div>
      </div>
      <div class="strip master-strip">
        <div class="strip-top">
          <span class="strip-name">Master</span>
        </div>
        <div class="strip-fader">
          <Slider label="Master volume" hideLabel vertical min={-48} max={6} step={0.1} value={project.masterDb} edit={projEdit('master volume', (p, v) => (p.masterDb = v))} />
          <div class="stereo-meter">
            <Meter vertical level={meters().master[0]} label="Master left" />
            <Meter vertical level={meters().master[1]} label="Master right" />
          </div>
        </div>
        <span class="strip-value">{fmtDb(project.masterDb)} dB</span>
        <span class="strip-peak" classList={{ clip: Math.max(...meters().master) >= 0.999 }}>
          peak {fmtDb(20 * Math.log10(Math.max(1e-6, ...meters().master)))}
        </span>
      </div>
    </div>
  );
}

function Strip(props: { track: Track }) {
  const t = () => props.track;
  return (
    <div class="strip" style={{ '--track-color': TRACK_COLORS[t().color].line }}>
      <div class="strip-top">
        <span class="strip-name" title={t().name}>
          {t().name}
        </span>
        <button type="button" class="tb mute" aria-pressed={t().mute} title="Mute" onClick={() => updateTrack(t().id, 'mute', { mute: !t().mute })}>
          M
        </button>
        <button type="button" class="tb solo" aria-pressed={t().solo} title="Solo" onClick={() => updateTrack(t().id, 'solo', { solo: !t().solo })}>
          S
        </button>
      </div>
      <div class="strip-body">
        <div class="strip-fader">
          <Slider label={`${t().name} volume`} hideLabel vertical min={-48} max={6} step={0.1} value={t().volumeDb} edit={trackEdit(t().id, 'volume', (x, v) => (x.volumeDb = v))} />
          <Meter vertical level={meters().tracks[t().id] ?? 0} label={`${t().name} level`} />
        </div>
        <div class="strip-params">
          <Slider label="Pan" min={-1} max={1} value={t().pan} format={fmtPan} edit={trackEdit(t().id, 'pan', (x, v) => (x.pan = Math.abs(v) < 0.03 ? 0 : v))} />
          <Slider label="Low-pass" min={Math.log2(60)} max={Math.log2(20000)} value={Math.log2(t().lowpass)} format={() => fmtHz(t().lowpass)} edit={trackEdit(t().id, 'low-pass', (x, v) => (x.lowpass = v >= Math.log2(19900) ? 20000 : Math.round(2 ** v)))} />
          <Slider label="Delay" min={0} max={1} value={t().delaySend} format={fmtPct} edit={trackEdit(t().id, 'delay send', (x, v) => (x.delaySend = v))} />
          <Slider label="Reverb" min={0} max={1} value={t().reverbSend} format={fmtPct} edit={trackEdit(t().id, 'reverb send', (x, v) => (x.reverbSend = v))} />
        </div>
      </div>
      <span class="strip-value">{fmtDb(t().volumeDb)} dB</span>
    </div>
  );
}
