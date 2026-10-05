// Collects recorder chunks arriving on a MessagePort, returns each chunk's
// buffers to the recorder for reuse, and assembles the take at the end.
// Runs in the capture worker, or on the main thread if workers are unavailable.

export interface Take {
  channels: Float32Array[];
  frames: number;
  overrun: boolean;
}

export function attachCollector(port: MessagePort, onTake: (t: Take) => void) {
  let chunks: { seq: number; data: Float32Array[]; frames: number }[] = [];
  port.onmessage = (ev) => {
    const d = ev.data;
    if (d.type === 'chunk') {
      const bufs = d.buffers as Float32Array[];
      chunks.push({ seq: d.seq, frames: d.frames, data: bufs.map((b) => b.slice(0, d.frames)) });
      port.postMessage({ type: 'return', buffers: bufs }, bufs.map((b) => b.buffer));
    } else if (d.type === 'end') {
      chunks.sort((a, b) => a.seq - b.seq);
      const nch = chunks[0]?.data.length ?? 2;
      const total = d.frames as number;
      const channels = Array.from({ length: nch }, () => new Float32Array(total));
      let o = 0;
      for (const c of chunks) {
        const n = Math.min(c.frames, total - o);
        for (let ch = 0; ch < nch; ch++) channels[ch].set(c.data[ch].subarray(0, n), o);
        o += n;
      }
      chunks = [];
      onTake({ channels, frames: total, overrun: !!d.overrun });
    } else if (d.type === 'cancel') {
      chunks = [];
    }
  };
}
