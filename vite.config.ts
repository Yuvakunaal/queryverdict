import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { BASE_PATH, CSP } from './scripts/csp.mjs';

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
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false },
  preview: { host: '127.0.0.1' },
  server: { host: '127.0.0.1' },
});
