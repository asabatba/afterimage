import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import solid from 'vite-plugin-solid';

// `npm run build` produces a normal multi-file build in dist/.
// `npm run build:single` inlines everything into one HTML file (dist-single/),
// which is handy for sharing a single portable file.
export default defineConfig(({ mode }) => ({
  plugins: [solid(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  build: {
    target: 'es2022',
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}));
