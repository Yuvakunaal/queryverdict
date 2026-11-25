// Engine assets are imported as URLs so Vite copies them into the build and serves them
// from the app's own origin. No CDN. The cross-origin-isolated (threads) bundle is
// deliberately excluded: GitHub Pages cannot send COOP/COEP headers.
import type { DuckDBBundles } from '@duckdb/duckdb-wasm';
import mvpModule from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehModule from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

export const BUNDLES: DuckDBBundles = {
  mvp: { mainModule: mvpModule, mainWorker: mvpWorker },
  eh: { mainModule: ehModule, mainWorker: ehWorker },
};

export const DUCKDB_WASM_PACKAGE_VERSION = __DUCKDB_WASM_VERSION__;

/** Same-origin URL of the vendored extension repository (see scripts/vendor-extensions.mjs). */
export function extensionRepositoryUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}duckdb-ext`, window.location.href).href.replace(/\/$/, '');
}

export function bundleName(mainModule: string): 'eh' | 'mvp' | 'unknown' {
  if (mainModule === ehModule) return 'eh';
  if (mainModule === mvpModule) return 'mvp';
  return 'unknown';
}
