import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { browserBoundaryPlugin } from '../../scripts/browser-boundary.mjs';

export default defineConfig({
  root: fileURLToPath(new URL('./client', import.meta.url)),
  plugins: [browserBoundaryPlugin(), react()],
  build: { outDir: '../dist/client', emptyOutDir: true, sourcemap: false, manifest: true },
});
