/** Snapshot-based undo stack. Snapshots are whole project states (small JSON). */
export class History<T> {
  private past: { state: T; label: string }[] = [];
  private future: { state: T; label: string }[] = [];
  constructor(private limit = 200) {}

  /** Record the state *before* an edit. */
  push(before: T, label = 'edit') {
    this.past.push({ state: before, label });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: T): { state: T; label: string } | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ state: current, label: entry.label });
    return entry;
  }

  redo(current: T): { state: T; label: string } | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ state: current, label: entry.label });
    return entry;
  }

  clear() {
    this.past = [];
    this.future = [];
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  get undoLabel() {
    return this.past.at(-1)?.label;
  }
  get redoLabel() {
    return this.future.at(-1)?.label;
  }
}
