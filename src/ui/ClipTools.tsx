// Copy / paste / repeat / fill for the selected clips, in the bottom panel's tab bar.
import { Show } from 'solid-js';
import type { FillTarget, RepeatStep } from '../store/app';
import { selectedClipIds, setUi, ui } from '../store/app';
import { clipboardCount, copySelected, cutSelected, duplicateSelected, fillSelected, loopToSelection, pasteClipboard, repeatSelected } from '../store/actions';

const STEPS: { value: RepeatStep; label: string }[] = [
  { value: 'auto', label: 'clip length' },
  { value: 'bar', label: '1 bar' },
  { value: 'bars2', label: '2 bars' },
  { value: 'bars4', label: '4 bars' },
];

const TARGETS: { value: FillTarget; label: string }[] = [
  { value: 'loop', label: 'loop end' },
  { value: 'section', label: 'next section' },
  { value: 'song', label: 'song end' },
  { value: 'bars8', label: '+8 bars' },
  { value: 'bars16', label: '+16 bars' },
  { value: 'bars32', label: '+32 bars' },
];

export function ClipTools() {
  const n = () => selectedClipIds().length;
  return (
    <Show when={n() > 0 || clipboardCount() > 0}>
      <div class="clip-tools" role="toolbar" aria-label="Clip tools">
        <button type="button" class="ghost small" disabled={!n()} onClick={() => copySelected()} title="Copy the selected clips (Ctrl+C)">
          Copy
        </button>
        <button type="button" class="ghost small" disabled={!n()} onClick={cutSelected} title="Cut (Ctrl+X)">
          Cut
        </button>
        <button
          type="button"
          class="ghost small"
          disabled={!clipboardCount()}
          onClick={() => pasteClipboard()}
          title="Paste at the cursor on the active track (Ctrl+V). The cursor moves to the end, so pasting again continues."
        >
          Paste
        </button>
        <button type="button" class="ghost small" disabled={!n()} onClick={duplicateSelected} title="Duplicate right after the selection (Ctrl+D)">
          Duplicate
        </button>
        <span class="chop-sep" />
        <span class="tool-group">
          <button type="button" class="ghost small" disabled={!n()} onClick={() => repeatSelected()} title="Add this many copies, one after another">
            Repeat ×
          </button>
          <input
            class="count-input"
            type="number"
            min={1}
            max={64}
            aria-label="Number of copies"
            value={ui.tools.repeatCount}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => setUi('tools', 'repeatCount', Math.max(1, Math.min(64, Math.round(parseFloat(e.currentTarget.value) || 1))))}
          />
          <span class="tool-label">every</span>
          <select aria-label="Repeat spacing" value={ui.tools.step} onChange={(e) => setUi('tools', 'step', e.currentTarget.value as RepeatStep)}>
            {STEPS.map((s) => (
              <option value={s.value} selected={ui.tools.step === s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </span>
        <span class="tool-group">
          <button type="button" class="ghost small" disabled={!n()} onClick={() => fillSelected()} title="Repeat the selection until the target; the last copy is trimmed to fit">
            Fill to
          </button>
          <select aria-label="Fill target" value={ui.tools.fillTo} onChange={(e) => setUi('tools', 'fillTo', e.currentTarget.value as FillTarget)}>
            {TARGETS.map((t) => (
              <option value={t.value} selected={ui.tools.fillTo === t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </span>
        <button type="button" class="ghost small" disabled={!n()} onClick={loopToSelection} title="Loop the range covered by the selection">
          Loop it
        </button>
      </div>
    </Show>
  );
}
