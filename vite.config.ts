import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { BASE_PATH, CSP } from './scripts/csp.mjs';

const duckdbPkg = JSON.parse(readFileSync(new URL('./node_modules/@duckdb/duckdb-wasm/package.json', import.meta.url), 'utf8')) as { version: string };

/** Injects the meta CSP into production builds only (Vite's dev server needs inline scripts). */
function metaCsp(): Plugin {
  return {
    name: 'qv-meta-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig({
  base: BASE_PATH,
  plugins: [react(), metaCsp()],
  define: { __DUCKDB_WASM_VERSION__: JSON.stringify(duckdbPkg.version) },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false },
  preview: { host: '127.0.0.1' },
  server: { host: '127.0.0.1' },
});
