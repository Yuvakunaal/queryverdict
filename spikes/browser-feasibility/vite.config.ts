import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const duckdbPkg = JSON.parse(readFileSync(new URL('./node_modules/@duckdb/duckdb-wasm/package.json', import.meta.url), 'utf8')) as { version: string };

// GitHub Pages serves a project site from /<repo>/. Build and preview under the same subpath.
const BASE = '/queryverdict/';

// A meta Content-Security-Policy, injected into production builds only (Vite's dev server
// needs inline scripts). GitHub Pages cannot send CSP headers, so a meta tag is the only
// option there. Whether it also governs the engine's worker is tested in tests/e2e.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function metaCsp(): Plugin {
  return {
    name: 'qv-meta-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig({
  base: BASE,
  plugins: [react(), metaCsp()],
  define: { __DUCKDB_WASM_VERSION__: JSON.stringify(duckdbPkg.version) },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4096 },
  preview: { host: '127.0.0.1' },
  server: { host: '127.0.0.1' },
});
