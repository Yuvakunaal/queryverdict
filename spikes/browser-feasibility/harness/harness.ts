// TEST-ONLY entry point (built by vite.harness.config.ts into dist-harness/, never into dist/).
// Provides:
// - the production EngineSession class, for lifecycle tests and fault injection (lockdownPlan);
// - an UNLOCKED raw DuckDB-WASM engine, used only as the negative control that proves the
//   request-capture method sees worker traffic;
// - a page-level fetch, used as the positive control for page traffic and to observe the meta CSP.
import * as duckdb from '@duckdb/duckdb-wasm';
import { BUNDLES } from '../src/engine/bundles';
import { EngineSession } from '../src/engine/session';
import { lockdownStatements, requiredSettings, LOCAL_FILE_DIR } from '../src/engine/lockdown';

async function rawUnlockedQuery(sql: string): Promise<{ ok: boolean; message: string }> {
  const bundle = await duckdb.selectBundle(BUNDLES);
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    await db.open({ path: ':memory:' });
    const conn = await db.connect();
    try {
      await conn.query(sql);
      return { ok: true, message: 'ok' };
    } catch (e) {
      return { ok: false, message: String(e).split('\n')[0] ?? '' };
    }
  } finally {
    worker.terminate();
  }
}

async function pageFetch(url: string): Promise<{ ok: boolean; status: number | null; message: string }> {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return { ok: r.ok, status: r.status, message: 'fetched' };
  } catch (e) {
    return { ok: false, status: null, message: String(e) };
  }
}

declare global {
  interface Window {
    __qvHarness?: {
      EngineSession: typeof EngineSession;
      lockdownStatements: typeof lockdownStatements;
      requiredSettings: typeof requiredSettings;
      LOCAL_FILE_DIR: string;
      rawUnlockedQuery: typeof rawUnlockedQuery;
      pageFetch: typeof pageFetch;
    };
  }
}

window.__qvHarness = { EngineSession, lockdownStatements, requiredSettings, LOCAL_FILE_DIR, rawUnlockedQuery, pageFetch };
document.body.dataset.harnessReady = 'true';
