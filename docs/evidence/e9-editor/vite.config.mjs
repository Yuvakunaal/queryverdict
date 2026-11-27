// E9: same Vite version, base path, CSP meta plugin, target and asset settings as the production config.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { BASE_PATH, CSP } from '../../../scripts/csp.mjs';
const entry = process.env.E9_ENTRY;
if (!entry) throw new Error('E9_ENTRY required');
const metaCsp = { name: 'qv-meta-csp', apply: 'build', transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }] };
export default defineConfig({
  base: BASE_PATH,
  plugins: [react(), metaCsp],
  build: { target: 'es2022', outDir: `dist-${entry}`, emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false, rollupOptions: { input: `${entry}.html` } },
  preview: { host: '127.0.0.1' },
});
