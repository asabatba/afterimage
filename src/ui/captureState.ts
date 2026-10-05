import { createSignal } from 'solid-js';
import type { CaptureStatus, InputInfo } from '../audio/capture';

const [captureStatus, setCaptureStatus] = createSignal<CaptureStatus>('idle');
const [inputLevels, setInputLevels] = createSignal<number[]>([0, 0]);
const [inputInfo, setInputInfo] = createSignal<InputInfo | null>(null);
const [monitoring, setMonitoringSignal] = createSignal(false);
const [elapsed, setElapsed] = createSignal(0);

export { captureStatus, setCaptureStatus, inputLevels, setInputLevels, inputInfo, setInputInfo, monitoring, setMonitoringSignal, elapsed, setElapsed };
