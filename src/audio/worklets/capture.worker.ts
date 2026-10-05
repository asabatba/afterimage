// Capture worker: keeps PCM off the main thread while recording.
/// <reference lib="webworker" />
import { attachCollector } from './collector';

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'ping') (self as unknown as Worker).postMessage({ type: 'pong' });
  else if (m.type === 'port') {
    attachCollector(m.port as MessagePort, (take) => {
      (self as unknown as Worker).postMessage(
        { type: 'take', ...take },
        take.channels.map((c) => c.buffer),
      );
    });
  }
};
