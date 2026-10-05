// WAV encode/decode. 32-bit float is used for lossless sample storage in bundles.
export type WavFormat = 'f32' | 'pcm24' | 'pcm16';

export function encodeWav(channels: Float32Array[], sampleRate: number, format: WavFormat = 'f32'): Uint8Array {
  const nch = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytesPer = format === 'f32' ? 4 : format === 'pcm24' ? 3 : 2;
  const dataBytes = frames * nch * bytesPer;
  const isFloat = format === 'f32';
  // Float WAVs carry a 'fact' chunk and an 18-byte fmt chunk.
  const fmtSize = isFloat ? 18 : 16;
  const factSize = isFloat ? 12 : 0;
  const headerSize = 12 + 8 + fmtSize + factSize + 8;
  const buf = new ArrayBuffer(headerSize + dataBytes);
  const v = new DataView(buf);
  let o = 0;
  const str = (s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i));
  };
  str('RIFF');
  v.setUint32(o, headerSize - 8 + dataBytes, true); o += 4;
  str('WAVE');
  str('fmt ');
  v.setUint32(o, fmtSize, true); o += 4;
  v.setUint16(o, isFloat ? 3 : 1, true); o += 2;
  v.setUint16(o, nch, true); o += 2;
  v.setUint32(o, sampleRate, true); o += 4;
  v.setUint32(o, sampleRate * nch * bytesPer, true); o += 4;
  v.setUint16(o, nch * bytesPer, true); o += 2;
  v.setUint16(o, bytesPer * 8, true); o += 2;
  if (isFloat) {
    v.setUint16(o, 0, true); o += 2;
    str('fact');
    v.setUint32(o, 4, true); o += 4;
    v.setUint32(o, frames, true); o += 4;
  }
  str('data');
  v.setUint32(o, dataBytes, true); o += 4;

  if (isFloat) {
    for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) { v.setFloat32(o, channels[c][i], true); o += 4; }
  } else if (format === 'pcm24') {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < nch; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        let x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        if (x < 0) x += 0x1000000;
        v.setUint8(o, x & 0xff); v.setUint8(o + 1, (x >> 8) & 0xff); v.setUint8(o + 2, (x >> 16) & 0xff);
        o += 3;
      }
  } else {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < nch; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        v.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
        o += 2;
      }
  }
  return new Uint8Array(buf);
}

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
}

export function decodeWav(bytes: Uint8Array): DecodedWav {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12;
  let fmt: { format: number; nch: number; rate: number; bits: number } | null = null;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      let format = v.getUint16(body, true);
      if (format === 0xfffe) format = v.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE sub-format
      fmt = { format, nch: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt');
      const bytesPer = fmt.bits / 8;
      const frames = Math.floor(Math.min(size, bytes.byteLength - body) / (bytesPer * fmt.nch));
      const channels = Array.from({ length: fmt.nch }, () => new Float32Array(frames));
      let p = body;
      for (let i = 0; i < frames; i++)
        for (let c = 0; c < fmt.nch; c++) {
          let s: number;
          if (fmt.format === 3 && fmt.bits === 32) s = v.getFloat32(p, true);
          else if (fmt.format === 3 && fmt.bits === 64) s = v.getFloat64(p, true);
          else if (fmt.bits === 16) s = v.getInt16(p, true) / 0x8000;
          else if (fmt.bits === 24) {
            let x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
            if (x & 0x800000) x -= 0x1000000;
            s = x / 0x800000;
          } else if (fmt.bits === 32) s = v.getInt32(p, true) / 0x80000000;
          else if (fmt.bits === 8) s = (v.getUint8(p) - 128) / 128;
          else throw new Error(`Unsupported WAV bit depth ${fmt.bits}`);
          channels[c][i] = s;
          p += bytesPer;
        }
      return { sampleRate: fmt.rate, channels };
    }
    o = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}
