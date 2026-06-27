import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      name: 'InkLoopSurfaceSDK',
      formats: ['es', 'iife'],
      fileName: (format) => `inkloop-surface-sdk.${format}.js`,
    },
  },
});
