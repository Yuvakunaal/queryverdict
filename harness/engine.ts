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
  /**
   * Statements matching this pattern are held before reaching the real engine until cancel() is
   * called (then they fail with an interrupt, as a cooperatively cancelled statement does) or
   * release() runs. Everything before them really ran, so transaction state is genuine.
   */
  hold: RegExp | null;
  /**
   * Before the first statement matching `match` reaches the engine, run `sql` on the same
   * connection (a write slipped INSIDE an operation's lease: a simulated defect). One-shot.
   */
  injectBefore: { match: RegExp; sql: string } | null;
  /** After the first statement matching `match` completes (before its caller sees it), run `action`. One-shot. */
  after: { match: RegExp; action: () => unknown } | null;
}

export const faults: Faults = { boot: 'none', failStatement: null, skipStatement: null, ignoreCancel: false, stallRegister: false, hold: null, injectBefore: null, after: null };

/** Every statement sent to a harness engine, in order (the independent probe trace). */
export const statementLog: string[] = [];

/** Virtual files currently registered with any harness engine (registerFile minus dropFile). */
export const registeredFiles = new Set<string>();
/** Every virtual path ever registered, in order (tests probe them after cleanup). */
export const registrationLog: string[] = [];
/** Statements currently held by faults.hold, and a way to let them proceed. */
export const held: { sql: string; release: () => void }[] = [];

class FaultyInstance implements EngineInstance {
  constructor(private readonly inner: EngineInstance) {}
  get bundle() { return this.inner.bundle; }
  get duckdbVersion() { return this.inner.duckdbVersion; }
  run(sql: string, shape: QueryShape): Promise<Rows> {
    if (faults.failStatement === sql) return Promise.reject(new Error('Invalid Input Error: injected lockdown failure'));
    if (faults.skipStatement === sql) return Promise.resolve([]);
    statementLog.push(sql);
    const inject = faults.injectBefore;
    if (inject?.match.test(sql)) {
      faults.injectBefore = null;
      statementLog.push(`/*injected*/ ${inject.sql}`);
      return this.inner.run(inject.sql, { maxRows: 1_000 }).then(() => this.run2(sql, shape));
    }
    return this.run2(sql, shape);
  }
  private run2(sql: string, shape: QueryShape): Promise<Rows> {
    const after = faults.after;
    if (after?.match.test(sql)) {
      faults.after = null;
      return this.run3(sql, shape).then(async (rows) => {
        await after.action();
        return rows;
      });
    }
    return this.run3(sql, shape);
  }
  private run3(sql: string, shape: QueryShape): Promise<Rows> {
    if (faults.hold?.test(sql)) {
      return new Promise<Rows>((resolve, reject) => {
        const entry = {
          sql,
          release: () => {
            held.splice(held.indexOf(entry), 1);
            this.inner.run(sql, shape).then(resolve, reject);
          },
          interrupt: () => {
            held.splice(held.indexOf(entry), 1);
            reject(new Error('INTERRUPT Error: Interrupted!'));
          },
        };
        this.holding.push(entry);
        held.push(entry);
      });
    }
    return this.inner.run(sql, shape);
  }
  private holding: { interrupt: () => void }[] = [];
  cancel(): Promise<boolean> {
    if (faults.ignoreCancel) return Promise.resolve(true);
    const waiting = this.holding.splice(0);
    if (waiting.length) {
      for (const w of waiting) w.interrupt();
      return Promise.resolve(true);
    }
    return this.inner.cancel();
  }
  prepareCheck(sql: string) { return this.inner.prepareCheck(sql); }
  registerFile(name: string, file: File): Promise<void> {
    if (faults.stallRegister) return new Promise<void>(() => undefined);
    registrationLog.push(name);
    return this.inner.registerFile(name, file).then(() => void registeredFiles.add(name));
  }
  dropFile(name: string) {
    return this.inner.dropFile(name).then(() => void registeredFiles.delete(name));
  }
  terminate() {
    // The worker and everything registered with it are gone.
    for (const w of this.holding.splice(0)) w.interrupt();
    registeredFiles.clear();
    this.inner.terminate();
  }
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
  faults, held, registeredFiles, registrationLog, statementLog, newSession, sql, rawValueTypes, classifyStatement, escalationProbes, lockdownStatements, verifyLockdown,
  EngineSession, DuckDBDriver, FaultyDriver, createEngineRuntime, DEFAULT_PROFILE, BOUNDS,
};
export type EngineHarness = typeof engineHarness;

declare global {
  interface Window {
    __qvHarness?: { engine: EngineHarness; datasets?: import('./datasets').DatasetsHarness; verdict?: import('./verdict').VerdictHarness };
  }
}
window.__qvHarness = { engine: engineHarness };
