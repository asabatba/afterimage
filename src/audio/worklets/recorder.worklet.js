// AFTERIMAGE recorder. Captures frames [startFrame, stopFrame) of its input into
// preallocated chunks and hands them to a worker over a MessagePort. The worker
// returns each chunk after copying, so the audio thread never allocates.
class AfterimageRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.channels = o.channels || 2;
    this.chunkFrames = o.chunkFrames || 4096;
    this.pool = [];
    for (let i = 0; i < (o.poolSize || 48); i++) {
      const bufs = [];
      for (let c = 0; c < this.channels; c++) bufs.push(new Float32Array(this.chunkFrames));
      this.pool.push(bufs);
    }
    this.current = null;
    this.fill = 0;
    this.active = false;
    this.startFrame = 0;
    this.stopFrame = Infinity;
    this.written = 0;
    this.overrun = false;
    this.sink = null;
    this.seq = 0;
    this.levelFrames = 0;
    this.levels = new Float32Array(this.channels);
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (m.type === 'port') {
      this.sink = m.port;
      this.sink.onmessage = (ev) => {
        if (ev.data && ev.data.type === 'return') this.pool.push(ev.data.buffers);
      };
    } else if (m.type === 'start') {
      this.startFrame = m.startFrame;
      this.stopFrame = m.stopFrame == null ? Infinity : m.stopFrame;
      this.written = 0;
      this.fill = 0;
      this.overrun = false;
      this.current = null;
      this.active = true;
      this.seq = 0;
    } else if (m.type === 'stop') {
      this.stopFrame = Math.max(this.startFrame, m.atFrame == null ? currentFrame : m.atFrame);
    } else if (m.type === 'cancel') {
      if (this.active) {
        this.active = false;
        if (this.current) this.pool.push(this.current);
        this.current = null;
        if (this.sink) this.sink.postMessage({ type: 'cancel' });
      }
    }
  }

  flush(final) {
    if (this.current && this.fill > 0 && this.sink) {
      const bufs = this.current;
      this.sink.postMessage({ type: 'chunk', seq: this.seq++, frames: this.fill, buffers: bufs }, bufs.map((b) => b.buffer));
    } else if (this.current) {
      this.pool.push(this.current);
    }
    this.current = null;
    this.fill = 0;
    if (final && this.sink) this.sink.postMessage({ type: 'end', frames: this.written, overrun: this.overrun });
  }

  process(inputs) {
    const input = inputs[0] || [];
    const n = 128;
    // Input level metering, ~30 times a second.
    for (let c = 0; c < this.channels; c++) {
      const ch = input[c] || input[0];
      if (!ch) continue;
      let p = this.levels[c];
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i] < 0 ? -ch[i] : ch[i];
        if (v > p) p = v;
      }
      this.levels[c] = p;
    }
    this.levelFrames += n;
    if (this.levelFrames >= sampleRate / 30) {
      this.port.postMessage({ type: 'level', levels: Array.from(this.levels) });
      this.levels.fill(0);
      this.levelFrames = 0;
    }

    if (!this.active) return true;
    const f0 = currentFrame;
    for (let i = 0; i < n; i++) {
      const frame = f0 + i;
      if (frame < this.startFrame) continue;
      if (frame >= this.stopFrame) {
        this.active = false;
        this.flush(true);
        this.port.postMessage({ type: 'done', frames: this.written, overrun: this.overrun });
        return true;
      }
      if (!this.current) {
        this.current = this.pool.pop() || null;
        this.fill = 0;
        if (!this.current) {
          if (!this.overrun) this.port.postMessage({ type: 'overrun' });
          this.overrun = true;
          continue;
        }
      }
      for (let c = 0; c < this.channels; c++) {
        const ch = input[c] || input[0];
        this.current[c][this.fill] = ch ? ch[i] : 0;
      }
      this.fill++;
      this.written++;
      if (this.fill === this.chunkFrames) this.flush(false);
    }
    return true;
  }
}

registerProcessor('afterimage-recorder', AfterimageRecorder);
