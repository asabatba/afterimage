import { createSignal } from 'solid-js';
import type { Meters } from '../audio/engine';

const [meters, setMeters] = createSignal<Meters>({ master: [0, 0], tracks: {} });
export { meters, setMeters };
