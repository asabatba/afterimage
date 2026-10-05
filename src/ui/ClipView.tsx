import { Show, createEffect, createMemo, on } from 'solid-js';
import { unwrap } from 'solid-js/store';
import type { AudioClip, Clip, PatternClip } from '../model/types';
import { clipEnd, effectivePitch, snapBeat, clipRate } from '../model/timing';
import { trimStart, trimEnd, stretchTo, slip, setFades, effectiveFades, fillClips, groupSpan, repeatClips } from '../model/clips';
import { patternLengthBeats } from '../model/tracker';
import { newId } from '../model/project';
import { beginGesture, endGesture, isSelected, live, project, samples, samplesVersion, selectClips, setUi, ui } from '../store/app';
import { TRACK_COLORS, drawClipWave, drawPatternPreview, setupCanvas } from './draw';

export interface ViewWindow {
  scrollLeft: () => number;
  viewW: () => number;
}

type Mode = 'move' | 'copy' | 'slip' | 'trimL' | 'trimR' | 'stretch' | 'fadeIn' | 'fadeOut' | 'fill';

const EDGE = 6;

export function ClipView(props: { clip: Clip; view: ViewWindow }) {
  let canvas!: HTMLCanvasElement;
  const ppb = () => ui.pxPerBeat;
  const track = () => project.tracks.find((t) => t.id === props.clip.trackId);
  const colors = () => TRACK_COLORS[track()?.color ?? 'amber'];
  const meta = () => (props.clip.kind === 'audio' ? project.samples.find((s) => s.id === (props.clip as AudioClip).sampleId) : undefined);
  const pattern = () => (props.clip.kind === 'pattern' ? project.patterns.find((p) => p.id === (props.clip as PatternClip).patternId) : undefined);
  const left = () => props.clip.start * ppb();
  const width = () => Math.max(2, props.clip.length * ppb());
  const h = () => ui.trackHeight - 6;

  // Visible span of the clip, so long clips draw only what is on screen.
  const vis = createMemo(() => {
    const vl = props.view.scrollLeft() - 40;
    const vr = props.view.scrollLeft() + props.view.viewW() + 40;
    const a = Math.max(left(), vl);
    const b = Math.min(left() + width(), vr);
    return b > a ? { x0: Math.floor(a - left()), w: Math.ceil(b - a) } : null;
  });

  const waveH = () => h() - 16;

  createEffect(
    on(
      () => [vis(), JSON.stringify(props.clip), ppb(), project.bpm, samplesVersion(), colors(), pattern() && JSON.stringify(pattern()!.cells), waveH()] as const,
      () => {
        const v = vis();
        if (!canvas || !v) return;
        canvas.style.left = `${v.x0}px`;
        const g = setupCanvas(canvas, v.w, waveH());
        const c = props.clip;
        if (c.kind === 'audio') {
          const s = samples.get(c.sampleId);
          if (s) drawClipWave(g, c, s.peaks, project.bpm, ppb(), v.x0, v.w, waveH(), colors().wave);
        } else {
          const p = pattern();
          if (p) drawPatternPreview(g, c, p, ppb(), v.x0, v.w, waveH(), colors().wave);
        }
      },
    ),
  );

  const badges = createMemo(() => {
    const c = props.clip;
    const out: string[] = [];
    if (c.kind === 'audio') {
      const pitch = effectivePitch(c, project.bpm);
      if (c.repitch) out.push('repitch');
      if (Math.abs(pitch) > 0.005) out.push(`${pitch > 0 ? '+' : '−'}${Math.abs(pitch).toFixed(Math.abs(pitch % 1) > 0.005 ? 2 : 0)} st`);
      const r = clipRate(c, project.bpm);
      if (Math.abs(r - 1) > 0.001) out.push(`×${(1 / r).toFixed(2)}`);
      if (c.timing === 'tempo') out.push('tempo');
      if (c.gainDb !== 0) out.push(`${c.gainDb > 0 ? '+' : '−'}${Math.abs(c.gainDb).toFixed(1)} dB`);
    } else {
      const n = project.clips.filter((x) => x.kind === 'pattern' && x.patternId === c.patternId).length;
      if (n > 1) out.push(`linked ×${n}`);
    }
    return out;
  });

  const fades = () => (props.clip.kind === 'audio' ? effectiveFades(props.clip, project.clips) : { fadeIn: 0, fadeOut: 0 });

  // The repeat handle sits on the selected clip that ends last, so dragging it extends the whole selection.
  const rightmost = createMemo(() => {
    if (!isSelected(props.clip.id)) return false;
    const sel = project.clips.filter((c) => isSelected(c.id));
    return sel.reduce((m, c) => (clipEnd(c) > clipEnd(m) ? c : m), sel[0])?.id === props.clip.id;
  });

  const onPointerDown = (e: PointerEvent, zone?: Mode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const id = props.clip.id;
    setUi('activeTrackId', props.clip.trackId);
    const additive = e.ctrlKey || e.metaKey;
    if (additive) {
      selectClips([id], true);
      return;
    }
    const wasSelected = isSelected(id);
    if (!wasSelected) selectClips([id]);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    let mode: Mode = zone ?? 'move';
    if (!zone) {
      if (x < Math.min(EDGE, rect.width / 4)) mode = 'trimL';
      else if (x > rect.width - Math.min(EDGE, rect.width / 4)) mode = e.altKey ? 'stretch' : 'trimR';
      else if (e.shiftKey) mode = 'slip';
      else if (e.altKey) mode = 'copy';
    }
    startDrag(e, mode, wasSelected);
  };

  const startDrag = (e: PointerEvent, mode: Mode, wasSelected: boolean) => {
    const startX = e.clientX, startY = e.clientY;
    const bpm = project.bpm;
    const primary = structuredClone(unwrap(props.clip)) as Clip;
    const group: Clip[] =
      mode === 'move' || mode === 'copy' || mode === 'fill'
        ? project.clips.filter((c) => isSelected(c.id)).map((c) => structuredClone(unwrap(c)) as Clip)
        : [primary];
    const trackIds = project.tracks.map((t) => t.id);
    const sampleDur = (c: Clip) => (c.kind === 'audio' ? project.samples.find((s) => s.id === c.sampleId)?.duration ?? Infinity : Infinity);
    const patLen = (c: Clip) => {
      if (c.kind !== 'pattern') return Infinity;
      const p = project.patterns.find((x) => x.id === c.patternId);
      return p ? patternLengthBeats(p) : Infinity;
    };
    let moved = false;
    let copies: Clip[] | null = null;
    // Repeat handle: the copies currently in the project, kept across moves so only the changed tail is rebuilt.
    let made: Clip[] = [];
    const span = groupSpan(group);
    const snap = (b: number, ev: PointerEvent) => snapBeat(b, ui.grid, ui.snap && !ev.ctrlKey);

    const onMove = (ev: PointerEvent) => {
      const dxPx = ev.clientX - startX;
      const dyPx = ev.clientY - startY;
      if (!moved && Math.abs(dxPx) < 3 && Math.abs(dyPx) < 3) return;
      if (!moved) {
        moved = true;
        beginGesture();
        document.body.dataset.dragging = mode;
      }
      const dx = dxPx / ui.pxPerBeat;
      if (mode === 'fill') {
        // Whole copies as the pointer passes them; hold Shift to fill exactly to the pointer with a trimmed last copy.
        const reach = snap(span.end + dx, ev);
        const next = ev.shiftKey
          ? fillClips(group, reach, bpm, sampleDur, undefined, true)
          : repeatClips(group, Math.max(0, Math.floor((reach - span.end) / span.length + 0.5)));
        const sig = (c: Clip) => `${c.trackId}:${c.start}:${c.length}`;
        let keep = 0;
        while (keep < made.length && keep < next.length && sig(made[keep]) === sig(next[keep])) keep++;
        if (keep === made.length && keep === next.length) return;
        const drop = new Set(made.slice(keep).map((c) => c.id));
        const add = next.slice(keep);
        made = [...made.slice(0, keep), ...add];
        live((p) => {
          if (drop.size) p.clips = p.clips.filter((c) => !drop.has(c.id));
          p.clips.push(...structuredClone(add));
        });
        return;
      }
      if (mode === 'move' || mode === 'copy') {
        const dRows = Math.round(dyPx / ui.trackHeight);
        const newStart = Math.max(0, snap(primary.start + dx, ev));
        const delta = newStart - primary.start;
        if (mode === 'copy' && !copies) {
          copies = group.map((c) => ({ ...c, id: newId('c') }));
          live((p) => p.clips.push(...structuredClone(copies!)));
          selectClips(copies.map((c) => c.id));
        }
        const targets = mode === 'copy' ? copies! : group;
        live((p) => {
          targets.forEach((orig, i) => {
            const c = p.clips.find((x) => x.id === orig.id);
            if (!c) return;
            const src = group[i];
            const ti = Math.min(trackIds.length - 1, Math.max(0, trackIds.indexOf(src.trackId) + dRows));
            c.start = Math.max(0, src.start + delta);
            c.trackId = trackIds[ti];
          });
        });
        return;
      }
      live((p) => {
        const i = p.clips.findIndex((x) => x.id === primary.id);
        if (i < 0) return;
        let next: Clip = primary;
        if (mode === 'trimL') next = trimStart(primary, snap(primary.start + dx, ev), bpm);
        else if (mode === 'trimR') next = trimEnd(primary, snap(clipEnd(primary) + dx, ev), bpm, sampleDur(primary));
        else if (mode === 'stretch' && primary.kind === 'audio') next = stretchTo(primary, snap(clipEnd(primary) + dx, ev) - primary.start, bpm);
        else if (mode === 'slip') next = slip(primary, ev.ctrlKey || !ui.snap ? dx : snapBeat(dx, ui.grid, true), bpm, sampleDur(primary), patLen(primary));
        else if (mode === 'fadeIn' && primary.kind === 'audio') next = setFades(primary, Math.max(0, primary.fadeIn + dx), primary.fadeOut);
        else if (mode === 'fadeOut' && primary.kind === 'audio') next = setFades(primary, primary.fadeIn, Math.max(0, primary.fadeOut - dx));
        p.clips[i] = next;
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      delete document.body.dataset.dragging;
      if (moved) {
        const labels: Record<Mode, string> = {
          move: 'move', copy: 'copy', slip: 'slip', trimL: 'trim', trimR: 'trim', stretch: 'stretch', fadeIn: 'fade', fadeOut: 'fade', fill: 'repeat',
        };
        if (mode === 'fill') {
          if (made.length) selectClips(made.map((c) => c.id));
          endGesture(labels[mode], made.length > 0);
        } else endGesture(labels[mode]);
      } else if (wasSelected) {
        selectClips([props.clip.id]);
      }
      if (!moved) setUi('bottomTab', 'detail');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const isPrint = () => meta()?.kind === 'print';
  const isRec = () => meta()?.kind === 'recording';

  return (
    <div
      class="clip"
      classList={{
        selected: isSelected(props.clip.id),
        pattern: props.clip.kind === 'pattern',
        print: isPrint(),
        missing: props.clip.kind === 'audio' ? (samplesVersion(), !samples.has((props.clip as AudioClip).sampleId)) : !pattern(),
      }}
      style={{
        left: `${left()}px`,
        width: `${width()}px`,
        height: `${h()}px`,
        '--clip-line': colors().line,
        '--clip-fill': colors().fill,
        '--clip-ink': colors().ink,
      }}
      data-clip-id={props.clip.id}
      aria-label={`${props.clip.kind === 'audio' ? 'Audio' : 'Pattern'} clip ${props.clip.name ?? ''}`}
      onPointerDown={(e) => onPointerDown(e)}
      onDblClick={(e) => {
        e.stopPropagation();
        setUi({ bottomOpen: true, bottomTab: 'detail' });
      }}
    >
      <div class="clip-head">
        <span class="clip-name">{props.clip.name ?? (props.clip.kind === 'pattern' ? pattern()?.name : meta()?.name)}</span>
        <Show when={isPrint() || isRec()}>
          <span class="clip-kind">{isPrint() ? 'print' : 'take'}</span>
        </Show>
        {badges().map((b) => (
          <span class="clip-badge">{b}</span>
        ))}
      </div>
      <canvas ref={canvas} class="clip-canvas" />
      <Show when={rightmost()}>
        <span
          class="fill-handle"
          title="Drag right to repeat the selection (Shift: fill exactly to the pointer)"
          onPointerDown={(e) => onPointerDown(e, 'fill')}
        />
      </Show>
      <Show when={props.clip.kind === 'audio'}>
        <svg class="clip-fades" width={width()} height={waveH()} style={{ top: '16px' }} aria-hidden="true">
          <Show when={fades().fadeIn > 0}>
            <path d={`M0 ${waveH()} L${fades().fadeIn * ppb()} 0`} />
          </Show>
          <Show when={fades().fadeOut > 0}>
            <path d={`M${width() - fades().fadeOut * ppb()} 0 L${width()} ${waveH()}`} />
          </Show>
        </svg>
        <span
          class="fade-handle in"
          style={{ left: `${Math.min(width() - 8, (props.clip as AudioClip).fadeIn * ppb())}px` }}
          title="Drag to fade in"
          onPointerDown={(e) => onPointerDown(e, 'fadeIn')}
        />
        <span
          class="fade-handle out"
          style={{ left: `${Math.max(0, width() - 8 - (props.clip as AudioClip).fadeOut * ppb())}px` }}
          title="Drag to fade out"
          onPointerDown={(e) => onPointerDown(e, 'fadeOut')}
        />
      </Show>
    </div>
  );
}
