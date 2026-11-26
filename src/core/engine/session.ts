// EngineSession: owns the DuckDB worker, a cancellable FIFO queue and revocable leases
// (docs/ARCHITECTURE.md §8–§9, §12; P-045). Corrects the spike's defects by construction:
//  - QV-SA-005: the session, not the operation body, owns the queue slot. Revocation (cancel,
//    deadline, recovery, dispose) settles the handle and releases the slot on the session's own
//    timers, without waiting for the body; a revoked lease rejects every later call.
//  - QV-SA-003: recovery reattaches nothing and is bounded (bootMs per boot, recoveryMs overall);
//    a failed recovery leaves the session `failed`, and queued work is refused, never left pending.
// Every handle settles exactly once. Results that arrive after revocation are discarded.
import { LeaseRevokedError, PolicyError, RefusedError, StaleGenerationError } from '../util/errors';
import { TIMEOUT, within } from '../util/time';
import { MAX_TIMER_MS } from '../profile/profile';
import { newOperationId } from '../operations/ids';
import { QUALIFIED_DUCKDB_VERSION } from './bundles';
import type { EngineDriver, EngineInstance } from './driver';
import { errorText, terminalFor, toEngineError } from './errors';
import { lockdownStatements, verifyLockdown } from './lockdown';
import type {
  BootInfo, DataEpoch, Generation, Lease, OperationBounds, OperationHandle, OperationId, OperationKind,
  OperationResult, QueryShape, Rows, SessionEvent, SessionState, Terminal,
} from './types';

export interface SessionOptions {
  readonly driver: EngineDriver;
  /** Bound for one boot (start or recovery), covering every step including lockdown and verification. */
  readonly bootMs: number;
  /** Bound for a whole recovery; on expiry the session is `failed`. */
  readonly recoveryMs: number;
  /** DuckDB memory_limit, fixed at boot because lock_configuration rejects later changes. */
  readonly memoryLimit: string;
  /** Monotonic clock (tests may inject one). */
  readonly now?: () => number;
  /** Engine versions this build is qualified for (default: the pinned v1.5.4 only). */
  readonly qualifiedVersions?: readonly string[];
}

type Body<T> = (lease: Lease) => Promise<T>;

interface OpRecord {
  readonly id: OperationId;
  readonly kind: OperationKind;
  readonly body: Body<unknown>;
  readonly bounds: OperationBounds;
  phase: 'queued' | 'active' | 'settled';
  generation: Generation | null;
  queueDeadline: number;
  runDeadline: number;
  queueTimer?: ReturnType<typeof setTimeout>;
  runTimer?: ReturnType<typeof setTimeout>;
  lease?: LeaseImpl;
  ending: boolean;
  resolve: (r: OperationResult<unknown>) => void;
}

/** Reads the phase without TypeScript narrowing (it can change across an await). */
const isSettled = (rec: OpRecord): boolean => rec.phase === 'settled';

/** Validates operation bounds: every value a positive integer within the setTimeout range. */
export function invalidBounds(b: OperationBounds): string | null {
  for (const [k, v] of Object.entries(b)) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0 || v > MAX_TIMER_MS) return `${k} must be a positive integer ≤ ${MAX_TIMER_MS} ms (got ${String(v)})`;
  }
  return null;
}

class LeaseImpl implements Lease {
  private revoked = false;
  private readonly controller = new AbortController();
  /** The engine call in flight, if any, and whether cancelSent() can stop it. */
  inflight: { readonly settled: Promise<void>; readonly cancellable: boolean } | null = null;
  readonly deferred: string[] = [];

  constructor(
    readonly id: OperationId,
    readonly generation: Generation,
    private readonly instance: EngineInstance,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isRevoked(): boolean {
    return this.revoked;
  }

  revoke(reason: string): void {
    if (this.revoked) return;
    this.revoked = true;
    this.controller.abort(new LeaseRevokedError(reason));
  }

  private async call<T>(fn: (i: EngineInstance) => Promise<T>, cancellable: boolean): Promise<T> {
    if (this.revoked) throw new LeaseRevokedError('The operation no longer owns the engine');
    if (this.inflight) throw new RefusedError('A lease runs one engine call at a time');
    const p = fn(this.instance);
    this.inflight = { settled: p.then(() => undefined, () => undefined), cancellable };
    try {
      const value = await p;
      if (this.revoked) throw new LeaseRevokedError('A result arrived after the lease was revoked and was discarded');
      return value;
    } catch (e) {
      if (this.revoked) throw new LeaseRevokedError('The operation no longer owns the engine', { cause: e });
      throw toEngineError(e);
    } finally {
      this.inflight = null;
    }
  }

  query(sql: string, shape: QueryShape): Promise<Rows> {
    return this.call((i) => i.run(sql, shape), true);
  }

  prepareCheck(sql: string): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.call((i) => i.prepareCheck(sql).then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, message: errorText(e) })), false);
  }

  deferCleanup(sql: string): void {
    if (this.revoked) throw new LeaseRevokedError('The operation no longer owns the engine');
    this.deferred.push(sql);
  }

  async cleanup(sql: string): Promise<'ok' | 'failed'> {
    const i = this.deferred.indexOf(sql);
    if (i >= 0) this.deferred.splice(i, 1);
    try {
      await this.call((inst) => inst.run(sql, { maxRows: 1_000 }), true);
      return 'ok';
    } catch (e) {
      if (e instanceof LeaseRevokedError) throw e;
      return 'failed';
    }
  }

  registerFile(name: string, file: File): Promise<void> {
    return this.call((i) => i.registerFile(name, file), false);
  }

  dropFile(name: string): Promise<void> {
    return this.call((i) => i.dropFile(name), false);
  }
}

export class EngineSession {
  private instance: EngineInstance | null = null;
  private bootController: AbortController | null = null;
  private recovering: Promise<void> | null = null;
  private readonly queue: OpRecord[] = [];
  private active: OpRecord | null = null;
  private disposed = false;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private readonly now: () => number;
  private _state: SessionState = { kind: 'idle' };
  private _generation = 0;
  private _epoch = 0;
  private _info: BootInfo | null = null;

  constructor(private readonly opts: SessionOptions) {
    this.now = opts.now ?? (() => performance.now());
  }

  get state(): SessionState {
    return this._state;
  }
  /** Generation of the current verified engine, or null when none is running. */
  get generation(): Generation | null {
    return this.instance ? (this._generation as Generation) : null;
  }
  get epoch(): DataEpoch {
    return this._epoch as DataEpoch;
  }
  get info(): BootInfo | null {
    return this.instance ? this._info : null;
  }

  subscribe(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(e: SessionEvent) {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* a listener must never break the session */
      }
    }
  }

  private setState(s: SessionState) {
    if (this._state.kind === 'disposed') return;
    this._state = s;
    this.emit({ type: 'state', state: s });
  }

  // ------------------------------------------------------------------ boot (fail-closed)

  async start(): Promise<BootInfo> {
    if (this.disposed) throw new PolicyError('The session has been disposed');
    if (this._state.kind !== 'idle' && this._state.kind !== 'failed') throw new RefusedError(`start() is not allowed while ${this._state.kind}`);
    this.setState({ kind: 'starting' });
    try {
      const info = await this.bootVerified();
      this.setState({ kind: 'ready' });
      this.emit({ type: 'ready', info });
      this.pump();
      return info;
    } catch (e) {
      if (!this.disposed) {
        this.setState({ kind: 'failed', reason: errorText(e) });
        this.refuseQueued(`engine failed to start: ${errorText(e)}`);
      }
      throw e;
    }
  }

  /** Boots a candidate engine; installs it only if every mandatory control is verified in time. */
  private async bootVerified(): Promise<BootInfo> {
    const t0 = this.now();
    const controller = new AbortController();
    this.bootController = controller;
    const timer = setTimeout(() => controller.abort(new PolicyError(`Engine boot did not finish within ${this.opts.bootMs} ms`)), this.opts.bootMs);
    let candidate: EngineInstance | null = null;
    const step = async <T>(p: Promise<T>): Promise<T> => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        p.then((v) => { controller.signal.removeEventListener('abort', onAbort); resolve(v); }, (e: unknown) => { controller.signal.removeEventListener('abort', onAbort); reject(e); });
      });
    };
    try {
      candidate = await this.opts.driver.boot(controller.signal);
      const inst = candidate;
      const qualified = this.opts.qualifiedVersions ?? [QUALIFIED_DUCKDB_VERSION];
      if (!qualified.includes(inst.duckdbVersion)) throw new PolicyError(`Engine version ${inst.duckdbVersion} is not qualified (expected ${qualified.join(', ')})`);
      const run = (sql: string) => step(inst.run(sql, { maxRows: 1_000 }));
      await run('SET threads = 1');
      await run(`SET memory_limit = '${this.opts.memoryLimit.replaceAll("'", "''")}'`);
      const failures: string[] = [];
      for (const sql of lockdownStatements(this.opts.driver.extensionRepository)) {
        try {
          await run(sql);
        } catch (e) {
          if (controller.signal.aborted) throw controller.signal.reason;
          failures.push(`${sql}: ${errorText(e)}`);
        }
      }
      if (failures.length) throw new PolicyError(`Mandatory security control failed: ${failures.join('; ')}`);
      const verification = await step(verifyLockdown(run, this.opts.driver.extensionRepository));
      if (!verification.ok) throw new PolicyError(`Mandatory security controls not in effect: ${verification.failures.join('; ')}`);
      if (this.disposed || controller.signal.aborted) throw controller.signal.reason ?? new PolicyError('Session disposed during startup');
      this._generation += 1;
      this.instance = inst;
      this._info = {
        generation: this._generation as Generation, bundle: inst.bundle, duckdb: inst.duckdbVersion, packageVersion: this.opts.driver.packageVersion,
        verified: true, bootMs: this.now() - t0, loadedExtensions: verification.loadedExtensions,
      };
      this.emit({ type: 'log', message: `engine ready: generation ${this._generation}, ${inst.bundle}, ${inst.duckdbVersion}, lockdown verified` });
      return this._info;
    } catch (e) {
      candidate?.terminate();
      this.emit({ type: 'log', message: `engine rejected: ${errorText(e)}` });
      throw e;
    } finally {
      clearTimeout(timer);
      if (this.bootController === controller) this.bootController = null;
    }
  }

  // ------------------------------------------------------------------ queue

  submit<T>(kind: OperationKind, body: Body<T>, bounds: OperationBounds): OperationHandle<T> {
    let resolve!: (r: OperationResult<unknown>) => void;
    const result = new Promise<OperationResult<unknown>>((r) => (resolve = r));
    const t = this.now();
    const rec: OpRecord = {
      id: newOperationId(), kind, body: body as Body<unknown>, bounds, phase: 'queued', generation: null,
      queueDeadline: t + bounds.queueWaitMs, runDeadline: Number.POSITIVE_INFINITY, ending: false, resolve,
    };
    const handle: OperationHandle<T> = {
      id: rec.id,
      kind,
      get generation() {
        return rec.generation;
      },
      result: result as Promise<OperationResult<T>>,
      cancel: () => this.cancel(rec, 'user'),
    };
    this.emit({ type: 'operation', id: rec.id, kind, phase: 'queued' });
    const bad = invalidBounds(bounds);
    if (bad) {
      this.settle(rec, { status: 'refused', reason: `invalid bounds: ${bad}` });
    } else if (this.disposed) {
      this.settle(rec, { status: 'stale', reason: 'disposed' });
    } else if (this._state.kind === 'failed') {
      this.settle(rec, { status: 'refused', reason: `engine failed: ${this._state.reason}` });
    } else {
      rec.queueTimer = setTimeout(() => this.expireQueued(rec), bounds.queueWaitMs);
      this.queue.push(rec);
      this.pump();
    }
    return handle;
  }

  private expireQueued(rec: OpRecord) {
    if (rec.phase !== 'queued') return;
    this.removeQueued(rec);
    this.settle(rec, { status: 'refused', reason: `queue-wait: did not start within ${rec.bounds.queueWaitMs} ms` });
  }

  private removeQueued(rec: OpRecord) {
    const i = this.queue.indexOf(rec);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private refuseQueued(reason: string) {
    for (const rec of this.queue.splice(0)) this.settle(rec, { status: 'refused', reason });
  }

  private settle(rec: OpRecord, terminal: Terminal, value?: unknown) {
    if (rec.phase === 'settled') return;
    rec.phase = 'settled';
    clearTimeout(rec.queueTimer);
    clearTimeout(rec.runTimer);
    rec.resolve(value === undefined ? { terminal, generation: rec.generation } : { terminal, value, generation: rec.generation });
    this.emit({ type: 'operation', id: rec.id, kind: rec.kind, phase: 'settled', terminal });
  }

  private pump() {
    if (this.active || this._state.kind !== 'ready' || !this.instance || this.disposed) return;
    let rec: OpRecord | undefined;
    while ((rec = this.queue.shift()) && rec.phase !== 'queued');
    if (!rec) return;
    this.startOp(rec, this.instance);
  }

  private startOp(rec: OpRecord, instance: EngineInstance) {
    clearTimeout(rec.queueTimer);
    rec.phase = 'active';
    rec.generation = this._generation as Generation;
    rec.runDeadline = this.now() + rec.bounds.runMs;
    const lease = new LeaseImpl(rec.id, rec.generation, instance);
    rec.lease = lease;
    this.active = rec;
    this.setState({ kind: 'busy', op: rec.id });
    this.emit({ type: 'operation', id: rec.id, kind: rec.kind, phase: 'active' });
    rec.runTimer = setTimeout(() => this.cancel(rec, 'deadline'), rec.bounds.runMs);
    Promise.resolve()
      .then(() => rec.body(lease))
      .then(
        (value) => this.complete(rec, { status: 'ok' }, value),
        (e: unknown) => this.complete(rec, terminalFor(e)),
      );
  }

  /** The body settled on its own. Ignored if the operation was already revoked (late result). */
  private complete(rec: OpRecord, terminal: Terminal, value?: unknown) {
    if (rec.phase !== 'active' || rec.ending || this.active !== rec) return;
    void this.wrapUp(rec, terminal, value);
  }

  private cancel(rec: OpRecord, by: 'user' | 'deadline') {
    if (rec.phase === 'queued') {
      this.removeQueued(rec);
      this.settle(rec, { status: 'cancelled', by, stop: 'cooperative' });
      return;
    }
    if (rec.phase !== 'active' || rec.ending || this.active !== rec) return;
    rec.lease?.revoke(by === 'user' ? 'cancelled' : 'deadline reached');
    this.setState({ kind: 'cancelling', op: rec.id });
    void this.wrapUp(rec, { status: 'cancelled', by, stop: 'cooperative' });
  }

  /**
   * Ends the active operation within bounded time: stops any engine call in flight
   * (cooperatively, else by terminating the worker), runs deferred cleanups (bounded), settles the
   * handle and releases the slot. Never waits for the operation body.
   */
  private async wrapUp(rec: OpRecord, terminal: Terminal, value?: unknown) {
    rec.ending = true;
    clearTimeout(rec.runTimer);
    const lease = rec.lease;
    const instance = this.instance;
    lease?.revoke('operation ended');
    const stopped = lease && instance ? await this.stopInflight(lease, instance, rec.bounds.cancelGraceMs) : true;
    if (this.active !== rec || isSettled(rec)) return; // superseded by dispose or recovery
    if (!stopped) {
      this.settle(rec, terminal.status === 'cancelled' ? { ...terminal, stop: 'terminated' } : { status: 'error', phase: 'engine', message: 'an engine call did not stop; the engine was restarted' });
      this.active = null;
      this.invalidate('an operation could not be stopped within its cancel grace');
      return;
    }
    let cleanupFailed = false;
    if (lease && instance) {
      for (const sql of lease.deferred.splice(0)) {
        const r = await within(instance.run(sql, { maxRows: 1_000 }).then(() => 'ok' as const, () => 'failed' as const), rec.bounds.cleanupMs);
        if (r !== 'ok') {
          cleanupFailed = true;
          break;
        }
      }
    }
    if (this.active !== rec || isSettled(rec)) return;
    if (cleanupFailed) {
      this.settle(rec, terminal.status === 'cancelled' ? { ...terminal, stop: 'terminated' } : { status: 'error', phase: 'engine', message: 'cleanup could not be confirmed; the engine was restarted' });
      this.active = null;
      this.invalidate('cleanup could not be confirmed');
      return;
    }
    this.settle(rec, terminal, value);
    this.active = null;
    if (this._state.kind === 'busy' || this._state.kind === 'cancelling') this.setState({ kind: 'ready' });
    this.pump();
  }

  /** True when no engine call is left running; false when the worker must be terminated. */
  private async stopInflight(lease: LeaseImpl, instance: EngineInstance, graceMs: number): Promise<boolean> {
    const inflight = lease.inflight;
    if (!inflight) return true;
    if (inflight.cancellable) {
      const requested = await within(Promise.resolve().then(() => instance.cancel()).then(() => 'returned' as const, () => 'rejected' as const), graceMs);
      const settled = await within(inflight.settled.then(() => 'settled' as const), requested === TIMEOUT ? 0 : graceMs);
      return settled === 'settled';
    }
    // Not cooperatively cancellable (for example registerFile): allow it one grace period to finish.
    return (await within(inflight.settled.then(() => 'settled' as const), graceMs)) === 'settled';
  }

  // ------------------------------------------------------------------ recovery

  /**
   * Terminates the current worker synchronously and starts a bounded recovery (no reattachment).
   * The active operation, if any, is revoked and settles as stale. Queued operations wait for the
   * new engine within their own queue-wait bounds, or are refused if recovery fails.
   */
  private invalidate(reason: string) {
    if (this.disposed || this.recovering) return;
    const old = this.instance;
    this.instance = null;
    old?.terminate();
    const rec = this.active;
    if (rec && rec.phase === 'active') {
      rec.lease?.revoke('engine replaced');
      this.settle(rec, { status: 'stale', reason: 'generation-changed' });
    }
    this.active = null;
    this.setState({ kind: 'recovering', reason });
    this.emit({ type: 'log', message: `recovering: ${reason}` });
    const recovery = this.recover(reason);
    this.recovering = recovery;
    void recovery.finally(() => {
      if (this.recovering === recovery) this.recovering = null;
    });
  }

  private async recover(reason: string): Promise<void> {
    const attempt = this.bootVerified();
    const outcome = await within(attempt.then(() => 'ready' as const, (e: unknown) => e), this.opts.recoveryMs);
    if (this.disposed) return;
    if (outcome === 'ready') {
      this._epoch += 1; // every in-memory table was lost with the old worker
      this.emit({ type: 'epoch', epoch: this._epoch as DataEpoch });
      this.setState({ kind: 'ready' });
      if (this._info) this.emit({ type: 'ready', info: this._info });
      this.pump();
      return;
    }
    if (outcome === TIMEOUT) {
      this.bootController?.abort(new PolicyError(`Recovery did not finish within ${this.opts.recoveryMs} ms`));
      attempt.catch(() => undefined);
    }
    const why = outcome === TIMEOUT ? `recovery did not finish within ${this.opts.recoveryMs} ms` : errorText(outcome);
    this.setState({ kind: 'failed', reason: `recovery failed (${reason}): ${why}` });
    this.refuseQueued(`engine failed: ${why}`);
  }

  /** Terminates the worker and recovers; resolves when recovery has ended (ready or failed). */
  async restart(reason: string): Promise<void> {
    if (this.disposed) throw new PolicyError('The session has been disposed');
    this.invalidate(reason);
    await this.recovering;
  }

  /** Records that data visible to diagnostics may have changed (docs/ARCHITECTURE.md §9). */
  markDataChanged(): DataEpoch {
    this._epoch += 1;
    this.emit({ type: 'epoch', epoch: this._epoch as DataEpoch });
    return this._epoch as DataEpoch;
  }

  /**
   * Applies overdue deadlines immediately (for example after a background tab becomes visible
   * and its timers were throttled). Bounds are guaranteed in the foreground only.
   */
  reconcile(): void {
    const t = this.now();
    for (const rec of [...this.queue]) if (rec.phase === 'queued' && rec.queueDeadline <= t) this.expireQueued(rec);
    const rec = this.active;
    if (rec && rec.phase === 'active' && !rec.ending && rec.runDeadline <= t) this.cancel(rec, 'deadline');
  }

  /** Terminal: every pending handle settles as stale; workers (including a booting candidate) are terminated. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bootController?.abort(new PolicyError('Session disposed during startup'));
    const rec = this.active;
    this.active = null;
    if (rec) {
      rec.lease?.revoke('session disposed');
      this.settle(rec, { status: 'stale', reason: 'disposed' });
    }
    for (const q of this.queue.splice(0)) this.settle(q, { status: 'stale', reason: 'disposed' });
    this.instance?.terminate();
    this.instance = null;
    this._state = { kind: 'disposed' };
    this.emit({ type: 'state', state: this._state });
  }
}

/** Thrown when callers use a result from a generation that is no longer current. */
export { StaleGenerationError };
