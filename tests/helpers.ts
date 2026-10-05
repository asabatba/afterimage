import type { SampleMeta } from '../src/model/types';

export const sample = (duration = 4, id = 's1'): SampleMeta => ({
  id,
  name: 'phrase',
  kind: 'import',
  sampleRate: 48000,
  channels: 2,
  frames: duration * 48000,
  duration,
  createdAt: 0,
});
