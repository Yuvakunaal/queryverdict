// TEST-ONLY build (P-022). Produces dist-harness/, which is never deployed. Later modules add
// fault-injection entry points here; nothing under harness/ may be imported by src/.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { BASE_PATH } from './scripts/csp.mjs';

const duckdbPkg = JSON.parse(readFileSync(new URL('./node_modules/@duckdb/duckdb-wasm/package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  base: BASE_PATH,
  root: fileURLToPath(new URL('./harness', import.meta.url)),
  plugins: [react()],
  define: { __DUCKDB_WASM_VERSION__: JSON.stringify(duckdbPkg.version) },
  // Serve the vendored extensions to the harness too (same origin as its pages).
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  build: {
    target: 'es2022',
    outDir: fileURLToPath(new URL('./dist-harness', import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  preview: { host: '127.0.0.1' },
});
