// TEST-ONLY build (P-022). Produces dist-harness/, which is never deployed. Later modules add
// fault-injection entry points here; nothing under harness/ may be imported by src/.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { BASE_PATH } from './scripts/csp.mjs';

export default defineConfig({
  base: BASE_PATH,
  root: fileURLToPath(new URL('./harness', import.meta.url)),
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: fileURLToPath(new URL('./dist-harness', import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  preview: { host: '127.0.0.1' },
});
