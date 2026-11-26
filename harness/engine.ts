// TEST-ONLY engine harness (P-022). Exposes the production engine modules plus a fault-injecting
// driver wrapper to browser tests. Never part of the production artifact.
import * as duckdb from '@duckdb/duckdb-wasm';
import { createEngineRuntime } from '../src/app/bootstrap';
import { BUNDLES } from '../src/core/engine/bundles';
import type { EngineDriver, EngineInstance } from '../src/core/engine/driver';
import { DUCKDB_OPEN_CONFIG, DuckDBDriver } from '../src/core/engine/duckdb-driver';
import { escalationProbes, lockdownStatements, verifyLockdown } from '../src/core/engine/lockdown';
import { EngineSession } from '../src/core/engine/session';
import { classifyStatement } from '../src/core/engine/statements';
import type { Lease, OperationBounds, QueryShape, Rows } from '../src/core/engine/types';
import { DEFAULT_PROFILE } from '../src/core/profile/profile';

/** Faults toggled by tests; read at the moment each call happens. */
export interface Faults {
  /** 'stall': the next boots never complete. */
  boot: 'none' | 'stall';
  /** A lockdown statement that fails at boot (exact SQL), or null. */
  failStatement: string | null;
  /** A lockdown statement silently skipped at boot (an ineffective control), or null. */
  skipStatement: string | null;
  /** cancel() reports success but does not stop the statement. */
  ignoreCancel: boolean;
  /** registerFile never completes. */
  stallRegister: boolean;
}

export const faults: Faults = { boot: 'none', failStatement: null, skipStatement: null, ignoreCancel: false, stallRegister: false };

class FaultyInstance implements EngineInstance {
  constructor(private readonly inner: EngineInstance) {}
  get bundle() { return this.inner.bundle; }
  get duckdbVersion() { return this.inner.duckdbVersion; }
  run(sql: string, shape: QueryShape): Promise<Rows> {
    if (faults.failStatement === sql) return Promise.reject(new Error('Invalid Input Error: injected lockdown failure'));
    if (faults.skipStatement === sql) return Promise.resolve([]);
    return this.inner.run(sql, shape);
  }
  cancel(): Promise<boolean> {
    return faults.ignoreCancel ? Promise.resolve(true) : this.inner.cancel();
  }
  prepareCheck(sql: string) { return this.inner.prepareCheck(sql); }
  registerFile(name: string, file: File): Promise<void> {
    return faults.stallRegister ? new Promise<void>(() => undefined) : this.inner.registerFile(name, file);
  }
  dropFile(name: string) { return this.inner.dropFile(name); }
  terminate() { this.inner.terminate(); }
}

export class FaultyDriver implements EngineDriver {
  private readonly inner = new DuckDBDriver();
  readonly extensionRepository = this.inner.extensionRepository;
  readonly packageVersion = this.inner.packageVersion;
  boots = 0;
  async boot(signal: AbortSignal): Promise<EngineInstance> {
    this.boots += 1;
    if (faults.boot === 'stall') {
      return new Promise<EngineInstance>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return new FaultyInstance(await this.inner.boot(signal));
  }
}

export const BOUNDS: OperationBounds = { queueWaitMs: 30_000, runMs: 30_000, cancelGraceMs: 2_000, cleanupMs: 5_000 };

export function newSession(opts: { faulty?: boolean; bootMs?: number; recoveryMs?: number } = {}) {
  const driver = opts.faulty ? new FaultyDriver() : new DuckDBDriver();
  const session = new EngineSession({ driver, bootMs: opts.bootMs ?? 30_000, recoveryMs: opts.recoveryMs ?? 45_000, memoryLimit: '1GB' });
  return { session, driver };
}

/** Runs one statement through its own operation; returns rows or the error text. */
export async function sql(session: EngineSession, text: string, shape: QueryShape = { maxRows: 1_000 }, bounds: Partial<OperationBounds> = {}) {
  const h = session.submit('query', (l: Lease) => l.query(text, shape), { ...BOUNDS, ...bounds });
  const r = await h.result;
  return { terminal: r.terminal, rows: r.value ?? null, generation: r.generation };
}

/** ES-09: value types as the browser receives them with the production open configuration. */
export async function rawValueTypes(query: string): Promise<{ name: string; type: string; value: string }[]> {
  const bundle = await duckdb.selectBundle(BUNDLES);
  const worker = new Worker(bundle.mainWorker!);
  try {
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    await db.open(DUCKDB_OPEN_CONFIG);
    const conn = await db.connect();
    const table = await conn.query(query);
    const row = table.get(0)?.toJSON() ?? {};
    return Object.entries(row).map(([name, v]) => ({
      name,
      type: v === null ? 'null' : typeof v === 'object' ? (v as object).constructor.name : typeof v,
      value: String(v),
    }));
  } finally {
    worker.terminate();
  }
}

export const engineHarness = {
  faults, newSession, sql, rawValueTypes, classifyStatement, escalationProbes, lockdownStatements, verifyLockdown,
  EngineSession, DuckDBDriver, FaultyDriver, createEngineRuntime, DEFAULT_PROFILE, BOUNDS,
};
export type EngineHarness = typeof engineHarness;

declare global {
  interface Window {
    __qvHarness?: { engine: EngineHarness };
  }
}
window.__qvHarness = { engine: engineHarness };
