// TEST-ONLY build: the production app plus harness/index.html (negative controls, fault injection).
// Output goes to dist-harness/, which is never deployed. The production build (vite.config.ts)
// does not include harness/ and is checked for harness markers by tests/e2e/security.spec.ts.
import { defineConfig, mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import base from './vite.config';

export default mergeConfig(
  base,
  defineConfig({
    build: {
      outDir: 'dist-harness',
      rollupOptions: {
        input: {
          app: fileURLToPath(new URL('./index.html', import.meta.url)),
          harness: fileURLToPath(new URL('./harness/index.html', import.meta.url)),
        },
      },
    },
    preview: { port: 4174 },
  }),
);
