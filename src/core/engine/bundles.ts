// Engine assets are imported as URLs so Vite copies them into the build and the browser loads
// them from the app's own origin (no CDN). The cross-origin-isolated threads bundle is excluded:
// GitHub Pages cannot send COOP/COEP headers (docs/ARCHITECTURE.md §20).
import type { DuckDBBundles } from '@duckdb/duckdb-wasm';
import ehModule from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import mvpModule from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';

export const BUNDLES: DuckDBBundles = {
  mvp: { mainModule: mvpModule, mainWorker: mvpWorker },
  eh: { mainModule: ehModule, mainWorker: ehWorker },
};

/** Pinned engine package version (P-016), injected at build time from package.json. */
export const DUCKDB_WASM_PACKAGE_VERSION: string = __DUCKDB_WASM_VERSION__;

/** DuckDB core version the vendored extensions and engine-semantics suite were qualified for. */
export const QUALIFIED_DUCKDB_VERSION = 'v1.5.4';

export function bundleName(mainModule: string): 'eh' | 'mvp' {
  return mainModule === ehModule ? 'eh' : 'mvp';
}

/** Same-origin URL of the vendored extension repository (scripts/vendor-extensions.mjs). */
export function extensionRepositoryUrl(base: string = import.meta.env.BASE_URL, page: string = globalThis.location.href): string {
  return new URL(`${base}duckdb-ext`, page).href.replace(/\/$/, '');
}
