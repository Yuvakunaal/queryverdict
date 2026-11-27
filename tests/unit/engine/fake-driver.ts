// Scripted stand-in engine for deterministic session tests (docs/TESTING_STRATEGY.md §3, §5.7).
import { ShapeError, StreamStopError, type EngineDriver, type EngineInstance } from '../../../src/core/engine/driver';
import { requiredSettings } from '../../../src/core/engine/lockdown';
import type { BatchConsumer, QueryShape, Rows } from '../../../src/core/engine/types';

export const REPO = 'http://127.0.0.1:4173/queryverdict/duckdb-ext';
export const never = <T>() => new Promise<T>(() => undefined);

export type CancelBehaviour = 'stop' | 'ignore' | 'reject' | 'hang';
/** Returns rows, throws, or returns 'stall' (never settles) for a statement. */
export type Handler = (sql: string) => Rows | Error | 'stall' | undefined;

interface Pending {
  sql: string;
  resolve: (r: Rows) => void;
  reject: (e: unknown) => void;
}

export class FakeInstance implements EngineInstance {
  readonly bundle = 'eh' as const;
  duckdbVersion = 'v1.5.4';
  readonly calls: string[] = [];
  readonly pending: Pending[] = [];
  terminated = false;
  cancelBehaviour: CancelBehaviour = 'stop';
  cancels = 0;
  handler: Handler = () => undefined;
  registerBehaviour: 'ok' | 'stall' = 'ok';
  /** Lockdown faults: statements that fail, settings that read wrong, lock that does not reject. */
  failStatements: RegExp | null = null;
  wrongSetting: string | null = null;
  lockRejects = true;

  constructor(private readonly repo = REPO) {}

  run(sql: string, _shape: QueryShape): Promise<Rows> {
    this.calls.push(sql);
    if (this.terminated) return never();
    const lockdown = this.lockdownAnswer(sql);
    if (lockdown !== undefined) return lockdown instanceof Error ? Promise.reject(lockdown) : Promise.resolve(lockdown);
    const r = this.handler(sql);
    if (r === 'stall') return new Promise<Rows>((resolve, reject) => this.pending.push({ sql, resolve, reject }));
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r ?? []);
  }

  /** Batches for stream(): a list of (batch, bytes) pairs per statement, or the same outcomes as run(). */
  streamHandler: (sql: string) => readonly (readonly [unknown, number])[] | Error | 'stall' | undefined = () => undefined;

  /** How an early stream stop behaves: confirmed, rejected or never answered. */
  stopBehaviour: 'ok' | 'reject' | 'hang' = 'ok';
  streamStops = 0;

  stream(sql: string, consume: BatchConsumer): Promise<void> {
    this.calls.push(`STREAM ${sql}`);
    if (this.terminated) return never();
    const r = this.streamHandler(sql);
    if (r === 'stall') return new Promise<void>((_resolve, reject) => this.pending.push({ sql, resolve: () => _resolve(), reject }));
    if (r instanceof Error) return Promise.reject(r);
    for (const [batch, bytes] of r ?? []) {
      if (!consume(batch, bytes)) {
        this.streamStops += 1;
        if (this.stopBehaviour === 'reject') return Promise.reject(new StreamStopError('stop rejected'));
        if (this.stopBehaviour === 'hang') return never();
        break;
      }
    }
    return Promise.resolve();
  }

  private lockdownAnswer(sql: string): Rows | Error | undefined {
    if (this.failStatements?.test(sql)) return new Error(`{"exception_type":"Invalid Input","exception_message":"injected failure"}`);
    if (sql.startsWith('SELECT name::VARCHAR, value::VARCHAR FROM duckdb_settings()')) {
      return Object.entries(requiredSettings(this.repo)).map(([k, v]) => [k, k === this.wrongSetting ? 'tampered' : v]);
    }
    if (sql.startsWith('SELECT extension_name::VARCHAR FROM duckdb_extensions()')) return [['core_functions'], ['json'], ['parquet']];
    if (sql === 'SET autoload_known_extensions = true') return this.lockRejects ? new Error('Invalid Input Error: Cannot change configuration option while locked') : [];
    if (/^(SET|INSTALL|LOAD) /.test(sql)) return [];
    return undefined;
  }

  cancel(): Promise<boolean> {
    this.cancels += 1;
    switch (this.cancelBehaviour) {
      case 'stop':
        for (const p of this.pending.splice(0)) p.reject(new Error('INTERRUPT Error: Interrupted!'));
        return Promise.resolve(true);
      case 'ignore':
        return Promise.resolve(true);
      case 'reject':
        return Promise.reject(new Error('cancel failed'));
      case 'hang':
        return never();
    }
  }

  /** Delivers a late result for the oldest stalled statement. */
  answerLate(rows: Rows) {
    this.pending.shift()?.resolve(rows);
  }

  prepareCheck(sql: string): Promise<void> {
    this.calls.push(`PREPARE ${sql}`);
    return sql.includes(';') && sql.trim().replace(/;$/, '').includes(';') ? Promise.reject(new Error('Invalid Input Error: Cannot prepare multiple statements at once!')) : Promise.resolve();
  }

  registerFile(name: string): Promise<void> {
    this.calls.push(`REGISTER ${name}`);
    return this.registerBehaviour === 'stall' ? never() : Promise.resolve();
  }

  dropFile(name: string): Promise<void> {
    this.calls.push(`DROP FILE ${name}`);
    return Promise.resolve();
  }

  terminate(): void {
    this.terminated = true;
    for (const p of this.pending.splice(0)) void p; // a terminated worker never answers
  }
}

export class FakeDriver implements EngineDriver {
  readonly extensionRepository = REPO;
  readonly packageVersion = 'test';
  readonly instances: FakeInstance[] = [];
  /** Per-boot configuration, by boot number (1-based). */
  configure: (instance: FakeInstance, bootNumber: number) => void = () => undefined;
  bootBehaviour: (bootNumber: number) => 'ok' | 'stall' | 'reject' = () => 'ok';

  boot(signal: AbortSignal): Promise<EngineInstance> {
    const n = this.instances.length + 1;
    const inst = new FakeInstance();
    this.instances.push(inst);
    this.configure(inst, n);
    const behaviour = this.bootBehaviour(n);
    if (behaviour === 'reject') return Promise.reject(new Error('worker failed to instantiate'));
    if (behaviour === 'stall') {
      return new Promise((_, reject) => signal.addEventListener('abort', () => { inst.terminate(); reject(signal.reason); }, { once: true }));
    }
    return Promise.resolve(inst);
  }

  get current(): FakeInstance {
    const i = this.instances[this.instances.length - 1];
    if (!i) throw new Error('no instance');
    return i;
  }
}

export { ShapeError };
