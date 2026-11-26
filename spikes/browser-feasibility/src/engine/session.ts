// Engine session for the feasibility spike: a small explicit state machine around one
// DuckDB-WASM worker.
//
//   idle ──start()──▶ starting ──verified──▶ ready ◀───────────────┐
//                       │ any failure            │ enqueue(op)       │ op settles
//                       ▼                        ▼                   │
//                     failed ◀─recovery fails── busy ──cancel()──▶ cancelling
//                                                                    │ cooperative stop ──▶ ready
//                                                                    │ rejected / timeout / not stopped
//                                                                    ▼
//                                     recovering (terminate worker, boot + verify a new one,
//                                                 re-attach file views) ──▶ ready | failed
//   any state ──dispose()──▶ disposed (terminal; wins over pending start/recovery/queued ops)
//
// Guarantees implemented here (tests: tests/e2e/lifecycle.spec.ts, tests/e2e/security.spec.ts):
// - FAIL-CLOSED: no SQL and no file registration until every lockdown statement succeeded AND
//   the effective settings were verified (lockdown.ts). Otherwise the candidate worker is
//   terminated and start() rejects. Recovery uses the same path.
// - One operation at a time: queries, registrations, removals and re-imports run through a FIFO
//   queue; cancel() and dispose() act on the active operation directly.
// - Imports (CREATE TABLE AS) run through the streaming API so they can be cancelled.
// - A cancel that is rejected, times out, or does not stop the operation within the deadline
//   terminates the worker and recovers (bounded by cancelDeadlineMs + recovery time).
// - Registration reserves a unique relation name inside the queue, uses CREATE (never
//   CREATE OR REPLACE) and rolls back the registered file if relation creation fails.
// - Recovery re-attaches file-backed views; imported tables are marked `needs-reimport`
//   (never silently dropped or reported as present).
// - Exclusive batches (exclusive()): one queue slot owns the engine for a whole multi-statement
//   operation (the SQL analyser). User SQL, registrations, removals, re-imports and other batches
//   queue behind it. A batch is bound to one engine generation: after recovery, replacement or
//   dispose its statements return `stale`. cancel() during a batch cancels the whole batch, also
//   between statements. invalidate() terminates the worker at once and recovers in the
//   background (a fresh, verified engine), so a caller never waits on a stalled worker.
// - Startup and recovery boots are bounded (bootTimeoutMs); a boot that does not finish is
//   abandoned and the session is `failed` (no SQL) until start() succeeds again.
import * as duckdb from '@duckdb/duckdb-wasm';
import { BUNDLES, bundleName, extensionRepositoryUrl } from './bundles';
import { collectBounded, limits as mkLimits, streamLeftUnread, type BoundedResult, type Limits } from './bounded';
import { escalationProbes, LOCAL_FILE_DIR, lockdownStatements, sqlIdent, sqlString, verifyLockdown, type LockdownVerification } from './lockdown';

export type FileFormat = 'csv' | 'json' | 'parquet';
export type AttachMode = 'view' | 'table';
export type SessionState = 'idle' | 'starting' | 'ready' | 'busy' | 'cancelling' | 'recovering' | 'failed' | 'disposed';
export type OpKind = 'query' | 'register' | 'drop' | 'reimport' | 'analysis';
export type DatasetStatus = 'attached' | 'needs-reimport' | 'failed';

export interface RegisteredFile {
  id: string;
  name: string;
  format: FileFormat;
  bytes: number;
  vfsName: string;
  relation: string;
  mode: AttachMode;
  status: DatasetStatus;
  error?: string;
  file: File;
}

export interface EngineEvent {
  t: number;
  kind: string;
  detail?: string;
}

export interface StartInfo {
  generation: number;
  bundle: string;
  duckdbVersion: string;
  packageVersion: string;
  crossOriginIsolated: boolean;
  /** Always true for a session that reached `ready`: lockdown is mandatory and verified. */
  lockdownVerified: true;
  verification: LockdownVerification;
  bootMs: number;
}

export type CancelMethod = 'cooperative' | 'terminate' | 'none' | 'disposed';

export type RunOutcome =
  | { status: 'ok'; result: BoundedResult; ms: number }
  | { status: 'error'; error: string; ms: number }
  | { status: 'cancelled'; ms: number; method: CancelMethod }
  | { status: 'stale'; ms: number };

export interface CancelReport {
  method: CancelMethod;
  /** What happened to the cooperative request. */
  cooperative: 'accepted' | 'not-accepted' | 'rejected' | 'timeout' | 'not-attempted';
  operation: OpKind | null;
  /** Time from cancel request until the operation settled or the worker was killed. */
  stopMs: number;
  /** Time until a fresh, verified engine was ready (terminate path only). */
  engineReadyMs: number | null;
  /** Time until file-backed views were re-attached (terminate path only). */
  reattachMs: number | null;
}

export interface SessionOptions {
  memoryLimit: string | null;
  cancelDeadlineMs: number;
  log?: (e: EngineEvent) => void;
  /** Upper bound for one engine boot (start or recovery). Default 30 s. */
  bootTimeoutMs?: number;
  /**
   * TEST-ONLY fault injection: replaces the lockdown statements. It can only make startup FAIL:
   * the effective-state verification is independent of the statements. Used by the harness build.
   */
  lockdownPlan?: (extensionRepository: string) => string[];
}

export class SessionDisposedError extends Error {
  constructor(msg = 'Session has been disposed') {
    super(msg);
    this.name = 'SessionDisposedError';
  }
}

export class LockdownError extends Error {
  constructor(message: string, readonly failures: string[]) {
    super(`${message}: ${failures.join('; ')}`);
    this.name = 'LockdownError';
  }
}

export class OperationCancelledError extends Error {
  constructor(readonly method: CancelMethod) {
    super(`Operation cancelled (${method})`);
    this.name = 'OperationCancelledError';
  }
}

interface Engine {
  worker: Worker;
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
  generation: number;
  info: StartInfo;
}

interface ActiveOp {
  id: number;
  kind: OpKind;
  generation: number;
  /** Whether the current phase can be cancelled cooperatively (streamed statement in flight). */
  cancellable: boolean;
  done: Promise<void>;
  abort: (m: CancelMethod) => void;
}

const sleep = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));

/** A multi-statement operation that owns the engine exclusively (see exclusive()). */
export interface ExclusiveBatch {
  /** Engine generation the batch is bound to. */
  readonly generation: number;
  /**
   * Runs one statement on the batch's engine; `stale` once the engine was replaced or the batch
   * ended, `cancelled` once the batch was cancelled. Cleanup statements (`{ cleanup: true }`, e.g.
   * ROLLBACK) still run after a cancel, but never on a replaced engine.
   */
  run(sql: string, lim?: Partial<Limits>, opts?: { cleanup?: boolean }): Promise<RunOutcome>;
  /** Cancels this batch (its active statement and every later one). Bounded by cancelDeadlineMs. */
  cancel(): Promise<CancelReport>;
  /** Terminates the worker now and recovers in the background. Never waits on the worker. */
  invalidate(reason: string): void;
  /** True while the batch owns the session and its engine is still the current one. */
  isCurrent(): boolean;
}

interface BatchHolder {
  cancelRequested: boolean;
}

export function detectFormat(fileName: string): FileFormat | null {
  const n = fileName.toLowerCase();
  if (n.endsWith('.csv') || n.endsWith('.tsv')) return 'csv';
  if (n.endsWith('.parquet')) return 'parquet';
  if (n.endsWith('.json') || n.endsWith('.ndjson') || n.endsWith('.jsonl')) return 'json';
  return null;
}

export function relationName(fileName: string, taken: Set<string>): string {
  const base = fileName.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
  const start = /^[a-z_]/.test(base) ? base : `t_${base}`;
  let name = start;
  for (let i = 2; taken.has(name); i++) name = `${start}_${i}`;
  return name;
}

function readerSql(f: Pick<RegisteredFile, 'format' | 'vfsName'>): string {
  const p = sqlString(f.vfsName);
  switch (f.format) {
    case 'csv':
      return `read_csv(${p})`;
    case 'parquet':
      return `read_parquet(${p})`;
    case 'json':
      return `read_json(${p})`;
  }
}

export class EngineSession {
  private engine: Engine | null = null;
  private candidateWorker: Worker | null = null;
  private bootToken = 0;
  private queueTail: Promise<unknown> = Promise.resolve();
  private recovery: Promise<void> | null = null;
  private active: ActiveOp | null = null;
  private holder: BatchHolder | null = null;
  private opSeq = 0;
  private disposed = false;
  state: SessionState = 'idle';
  stateDetail = '';
  generation = 0;
  readonly files = new Map<string, RegisteredFile>();
  /**
   * Rejects when dispose() is called. Every startup step races against it: a worker terminated
   * mid-call never answers, so without this a pending start() or recovery would hang forever.
   */
  private readonly disposal: Promise<never>;
  private rejectDisposal!: (e: Error) => void;

  constructor(private readonly opts: SessionOptions) {
    this.disposal = new Promise<never>((_, reject) => (this.rejectDisposal = reject));
    this.disposal.catch(() => undefined);
  }

  get info(): StartInfo | null {
    return this.engine?.info ?? null;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  private log(kind: string, detail?: string) {
    this.opts.log?.({ t: performance.now(), kind, ...(detail === undefined ? {} : { detail }) });
  }

  private setState(s: SessionState, detail = '') {
    if (this.state === 'disposed') return; // terminal
    this.state = s;
    this.stateDetail = detail;
    this.log(`state:${s}`, detail || undefined);
  }

  // ---------------------------------------------------------------- startup (fail-closed)

  async start(): Promise<StartInfo> {
    if (this.disposed) throw new SessionDisposedError();
    if (this.state !== 'idle' && this.state !== 'failed') throw new Error(`start() is not allowed in state ${this.state}`);
    this.setState('starting');
    try {
      const engine = await this.bootEngine();
      this.engine = engine;
      this.setState('ready');
      return engine.info;
    } catch (e) {
      if (!this.disposed) this.setState('failed', errorText(e));
      throw e;
    }
  }

  /** Boots a candidate engine and returns it only if every mandatory control is verified. */
  private async bootEngine(): Promise<Engine> {
    const token = ++this.bootToken;
    const t0 = performance.now();
    let worker: Worker | null = null;
    const abandon = () => {
      worker?.terminate();
      if (this.candidateWorker === worker) this.candidateWorker = null;
    };
    const stillWanted = () => {
      if (this.disposed || token !== this.bootToken) throw new SessionDisposedError('Session disposed during startup');
    };
    const bootMs = this.opts.bootTimeoutMs ?? 30_000;
    let bootTimer: ReturnType<typeof setTimeout> | undefined;
    const bootDeadline = new Promise<never>((_, reject) => (bootTimer = setTimeout(() => reject(new Error(`Engine boot did not finish within ${bootMs} ms`)), bootMs)));
    bootDeadline.catch(() => undefined);
    const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, this.disposal, bootDeadline]);
    try {
      const bundle = await guard(duckdb.selectBundle(BUNDLES));
      stillWanted();
      if (!bundle.mainWorker) throw new Error('Selected DuckDB bundle has no worker');
      worker = new Worker(bundle.mainWorker);
      this.candidateWorker = worker;
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await guard(db.instantiate(bundle.mainModule, bundle.pthreadWorker));
      stillWanted();
      await guard(db.open({ path: ':memory:', query: { castBigIntToDouble: false }, allowUnsignedExtensions: false }));
      stillWanted();
      const conn = await guard(db.connect());
      stillWanted();
      await guard(conn.query('SET threads = 1'));
      if (this.opts.memoryLimit) await guard(conn.query(`SET memory_limit = ${sqlString(this.opts.memoryLimit)}`));
      const repo = extensionRepositoryUrl();
      const failures: string[] = [];
      for (const stmt of (this.opts.lockdownPlan ?? lockdownStatements)(repo)) {
        try {
          await guard(conn.query(stmt));
        } catch (e) {
          if (e instanceof SessionDisposedError) throw e;
          failures.push(`${stmt}: ${errorText(e)}`);
        }
        stillWanted();
      }
      if (failures.length) throw new LockdownError('Mandatory security control failed', failures);
      const verification = await guard(verifyLockdown((sql) => guard(conn.query(sql)), repo));
      stillWanted();
      if (!verification.ok) throw new LockdownError('Mandatory security controls not in effect', verification.failures);
      const duckdbVersion = await guard(db.getVersion());
      stillWanted();
      const generation = ++this.generation;
      const info: StartInfo = {
        generation,
        bundle: bundleName(bundle.mainModule),
        duckdbVersion,
        packageVersion: __DUCKDB_WASM_VERSION__,
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        lockdownVerified: true,
        verification,
        bootMs: performance.now() - t0,
      };
      this.candidateWorker = null;
      clearTimeout(bootTimer);
      this.log('engine-ready', `gen ${generation}, ${info.bundle}, ${info.duckdbVersion}, verified, ${Math.round(info.bootMs)} ms`);
      return { worker, db, conn, generation, info };
    } catch (e) {
      clearTimeout(bootTimer);
      abandon();
      this.log('engine-rejected', errorText(e));
      throw e;
    }
  }

  // ---------------------------------------------------------------- operation queue

  private enqueue<T>(kind: OpKind, fn: (engine: Engine) => Promise<T>): Promise<T> {
    const run = async () => {
      if (this.recovery) await this.recovery.catch(() => undefined);
      if (this.disposed) throw new SessionDisposedError();
      const engine = this.engine;
      if (!engine || this.state !== 'ready') throw new Error(`Engine is not ready (state: ${this.state}${this.stateDetail ? `, ${this.stateDetail}` : ''})`);
      this.setState('busy', kind);
      try {
        return await fn(engine);
      } finally {
        this.active = null;
        const now = this.state as SessionState; // may have changed while awaiting (cancel, recovery, dispose)
        if (now === 'busy' || now === 'cancelling') this.setState('ready');
      }
    };
    const p = this.queueTail.then(run, run);
    this.queueTail = p.catch(() => undefined);
    return p;
  }

  /** Runs a statement through the streaming API so it can be cancelled; the result is bounded. */
  private async streamed(engine: Engine, kind: OpKind, sql: string, lim: Limits, id = ++this.opSeq): Promise<RunOutcome> {
    const t0 = performance.now();
    let abort!: (m: CancelMethod) => void;
    const aborted = new Promise<{ aborted: CancelMethod }>((r) => (abort = (m) => r({ aborted: m })));
    const work = (async () => {
      const reader = await engine.conn.send(sql, true);
      const res = await collectBounded(reader, lim);
      if (streamLeftUnread(res)) await engine.conn.cancelSent().catch(() => false);
      return res;
    })();
    this.active = { id, kind, generation: engine.generation, cancellable: true, done: work.then(() => undefined, () => undefined), abort };
    try {
      const r = await Promise.race([work, aborted]);
      const ms = performance.now() - t0;
      if ('aborted' in r) return { status: 'cancelled', ms, method: r.aborted };
      if (engine.generation !== this.generation) return { status: 'stale', ms };
      return { status: 'ok', result: r, ms };
    } catch (e) {
      const ms = performance.now() - t0;
      if (engine.generation !== this.generation || this.disposed) return { status: 'stale', ms };
      const msg = errorText(e);
      if (/interrupt|cancel/i.test(msg)) return { status: 'cancelled', ms, method: 'cooperative' };
      return { status: 'error', error: msg, ms };
    } finally {
      this.active = null;
    }
  }

  /** A short non-streamed engine call (file registration, view creation). Not cooperatively cancellable. */
  private async uncancellable<T>(engine: Engine, kind: OpKind, fn: () => Promise<T>): Promise<T> {
    let abort!: (m: CancelMethod) => void;
    const aborted = new Promise<never>((_, rej) => (abort = (m) => rej(new OperationCancelledError(m))));
    const work = fn();
    this.active = { id: ++this.opSeq, kind, generation: engine.generation, cancellable: false, done: work.then(() => undefined, () => undefined), abort };
    try {
      return await Promise.race([work, aborted]);
    } finally {
      this.active = null;
    }
  }

  // ---------------------------------------------------------------- public operations

  /** Executes SQL (queued) and keeps at most `limits` of the result. */
  run(sql: string, lim: Partial<Limits> = {}): Promise<RunOutcome> {
    return this.enqueue('query', (engine) => this.streamed(engine, 'query', sql, mkLimits(lim))).catch((e: unknown): RunOutcome => ({ status: 'error', error: errorText(e), ms: 0 }));
  }

  /**
   * Runs `fn` with exclusive ownership of the engine: it occupies one queue slot for its whole
   * duration, so no other operation (user SQL, registration, removal, re-import, another batch)
   * can run in between. Ownership is released when `fn` settles, on every path.
   */
  exclusive<T>(fn: (batch: ExclusiveBatch) => Promise<T>): Promise<T> {
    return this.enqueue('analysis', async (engine) => {
      const holder: BatchHolder = { cancelRequested: false };
      let open = true;
      let current: number | null = null;
      this.holder = holder;
      const isCurrent = () => open && !this.disposed && this.engine === engine && engine.generation === this.generation;
      const batch: ExclusiveBatch = {
        generation: engine.generation,
        isCurrent,
        run: async (sql, lim = {}, opts = {}) => {
          if (holder.cancelRequested && !opts.cleanup) return { status: 'cancelled', ms: 0, method: 'cooperative' };
          if (!isCurrent()) return { status: 'stale', ms: 0 };
          const id = ++this.opSeq;
          current = id;
          try {
            return await this.streamed(engine, 'analysis', sql, mkLimits(lim), id);
          } finally {
            current = null;
          }
        },
        cancel: async () => {
          holder.cancelRequested = true;
          const op = this.active;
          if (current === null || !op || op.id !== current) return { method: 'none', cooperative: 'not-attempted', operation: 'analysis', stopMs: 0, engineReadyMs: null, reattachMs: null };
          return this.cancelOp(op, true);
        },
        invalidate: (reason) => {
          holder.cancelRequested = true;
          if (this.engine === engine && !this.disposed) this.invalidateEngine(reason);
        },
      };
      try {
        return await fn(batch);
      } finally {
        open = false;
        if (this.holder === holder) this.holder = null;
      }
    });
  }

  async describe(relation: string): Promise<RunOutcome> {
    return this.run(`DESCRIBE ${sqlIdent(relation)}`, { maxRows: 500 });
  }

  async preview(relation: string, rows = 100): Promise<RunOutcome> {
    const n = Math.max(1, Math.min(rows, 1000));
    return this.run(`SELECT * FROM ${sqlIdent(relation)} LIMIT ${n}`, { maxRows: n });
  }

  /** Runs the escalation probes. Every probe is expected to fail. */
  async probeEscalations(target: string): Promise<{ name: string; blocked: boolean; mayReturnWithoutEffect: boolean; message: string }[]> {
    const out = [];
    for (const p of escalationProbes(target)) {
      const r = await this.run(p.sql, { maxRows: 10 });
      out.push({ name: p.name, blocked: r.status === 'error', mayReturnWithoutEffect: p.mayReturnWithoutEffect === true, message: r.status === 'error' ? r.error : r.status });
    }
    return out;
  }

  registerFile(file: File, mode: AttachMode = 'view', relation?: string): Promise<{ file: RegisteredFile; ms: number }> {
    const format = detectFormat(file.name);
    if (!format) return Promise.reject(new Error(`Unsupported file type: ${file.name} (expected .csv, .json/.ndjson/.jsonl or .parquet)`));
    return this.enqueue('register', async (engine) => {
      const t0 = performance.now();
      // Reserved inside the serialized queue: no other registration can observe the same state.
      const taken = new Set([...this.files.values()].map((f) => f.relation));
      const existing = await this.uncancellable(engine, 'register', () => engine.conn.query('SELECT table_name FROM information_schema.tables'));
      for (const r of existing.toArray()) taken.add(String(r.toJSON().table_name));
      const id = crypto.randomUUID();
      const rf: RegisteredFile = {
        id, name: file.name, format, bytes: file.size, vfsName: `${LOCAL_FILE_DIR}${id}.${format}`,
        relation: relation && !taken.has(relation) ? relation : relationName(file.name, taken),
        mode, status: 'attached', file,
      };
      await this.attach(engine, rf);
      this.files.set(id, rf);
      const ms = performance.now() - t0;
      this.log('file-registered', `${rf.name} as ${rf.relation} (${rf.format}, ${rf.mode}, ${rf.bytes} bytes) in ${Math.round(ms)} ms`);
      return { file: rf, ms };
    });
  }

  /** Registers the file handle and creates the relation; rolls both back on failure. */
  private async attach(engine: Engine, rf: RegisteredFile): Promise<void> {
    let registered = false;
    try {
      // directIO=true: the worker reads byte ranges from the File on demand (no full copy).
      await this.uncancellable(engine, 'register', () => engine.db.registerFileHandle(rf.vfsName, rf.file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true));
      registered = true;
      const create = `CREATE ${rf.mode === 'table' ? 'TABLE' : 'VIEW'} ${sqlIdent(rf.relation)} AS SELECT * FROM ${readerSql(rf)}`;
      if (rf.mode === 'table') {
        // Import through the streaming API so cancel() can stop it.
        const r = await this.streamed(engine, 'register', create, mkLimits({ maxRows: 1 }));
        if (r.status === 'cancelled') throw new OperationCancelledError(r.method);
        if (r.status !== 'ok') throw new Error(r.status === 'error' ? r.error : `import ${r.status}`);
      } else {
        await this.uncancellable(engine, 'register', () => engine.conn.query(create));
      }
    } catch (e) {
      // Roll back only on the engine that is still current; a terminated engine has no state left.
      if (registered && engine === this.engine && !this.disposed) {
        await engine.conn.query(`DROP ${rf.mode === 'table' ? 'TABLE' : 'VIEW'} IF EXISTS ${sqlIdent(rf.relation)}`).catch(() => undefined);
        await engine.db.dropFile(rf.vfsName).catch(() => undefined);
      }
      this.log('register-rolled-back', `${rf.name}: ${errorText(e)}`);
      throw e;
    }
  }

  dropFile(id: string): Promise<void> {
    return this.enqueue('drop', async (engine) => {
      const rf = this.files.get(id);
      if (!rf) return;
      if (rf.status === 'attached') {
        await engine.conn.query(`DROP ${rf.mode === 'table' ? 'TABLE' : 'VIEW'} IF EXISTS ${sqlIdent(rf.relation)}`);
      }
      await engine.db.dropFile(rf.vfsName).catch(() => undefined);
      this.files.delete(id);
      this.log('file-dropped', `${rf.name} (${rf.relation})`);
    });
  }

  /** Re-imports a table-mode dataset that recovery marked `needs-reimport`. */
  reimport(id: string): Promise<RegisteredFile> {
    return this.enqueue('reimport', async (engine) => {
      const rf = this.files.get(id);
      if (!rf) throw new Error('Unknown dataset');
      if (rf.status === 'attached') return rf;
      await this.attach(engine, rf);
      rf.status = 'attached';
      delete rf.error;
      return rf;
    });
  }

  // ---------------------------------------------------------------- cancellation and recovery

  /**
   * Cancels the active operation. A cooperative cancel is tried when the operation is a
   * streamed statement; if it is rejected, times out, or the operation has not stopped within
   * cancelDeadlineMs, the worker is terminated and the engine recovered.
   */
  async cancel(): Promise<CancelReport> {
    // During an exclusive batch, cancel applies to the whole batch (also between statements).
    if (this.holder) this.holder.cancelRequested = true;
    const op = this.active;
    if (!op || !this.engine || this.disposed) return { method: 'none', cooperative: 'not-attempted', operation: this.holder ? 'analysis' : null, stopMs: 0, engineReadyMs: null, reattachMs: null };
    return this.cancelOp(op, false);
  }

  /**
   * Cancels one operation. Cooperative first; if that is rejected, times out or does not stop the
   * operation within cancelDeadlineMs, the worker is terminated and the engine recovered. With
   * `background`, recovery is started but not awaited (the caller is bounded by the deadline).
   */
  private async cancelOp(op: ActiveOp, background: boolean): Promise<CancelReport> {
    const engine = this.engine;
    const t0 = performance.now();
    if (!engine || this.disposed || this.active !== op) return { method: 'none', cooperative: 'not-attempted', operation: op.kind, stopMs: 0, engineReadyMs: null, reattachMs: null };
    this.setState('cancelling', op.kind);
    const deadline = this.opts.cancelDeadlineMs;
    let cooperative: CancelReport['cooperative'] = 'not-attempted';
    if (op.cancellable) {
      try {
        const r = await Promise.race([engine.conn.cancelSent(), sleep(deadline)]);
        cooperative = r === 'timeout' ? 'timeout' : r ? 'accepted' : 'not-accepted';
      } catch {
        cooperative = 'rejected';
      }
    }
    if (cooperative === 'accepted' || cooperative === 'not-accepted' || cooperative === 'not-attempted') {
      const remaining = Math.max(0, deadline - (performance.now() - t0));
      const settled = await Promise.race([op.done.then(() => 'settled' as const), sleep(remaining)]);
      if (settled === 'settled') {
        op.abort(cooperative === 'not-attempted' ? 'none' : 'cooperative');
        const stopMs = performance.now() - t0;
        this.log('cancel-settled', `${cooperative}, ${Math.round(stopMs)} ms`);
        return { method: cooperative === 'not-attempted' ? 'none' : 'cooperative', cooperative, operation: op.kind, stopMs, engineReadyMs: null, reattachMs: null };
      }
    }
    const stopMs = performance.now() - t0;
    const reason = `cancel: ${cooperative}, operation did not stop within ${deadline} ms`;
    if (background) {
      if (this.engine === engine && !this.disposed) this.invalidateEngine(reason, op);
      return { method: 'terminate', cooperative, operation: op.kind, stopMs, engineReadyMs: null, reattachMs: null };
    }
    try {
      const r = await this.recoverNow(reason, op);
      return { method: 'terminate', cooperative, operation: op.kind, stopMs, engineReadyMs: r.engineReadyMs, reattachMs: r.reattachMs };
    } catch (e) {
      // The worker was terminated either way; report how the session ended up.
      this.log('cancel-recovery-failed', errorText(e));
      return { method: this.disposed ? 'disposed' : 'terminate', cooperative, operation: op.kind, stopMs, engineReadyMs: null, reattachMs: null };
    }
  }

  /**
   * Terminates the current worker synchronously and starts recovery without awaiting it. Until
   * recovery has booted and verified a new engine, the session accepts no SQL; if recovery fails
   * the session is `failed`.
   */
  private invalidateEngine(reason: string, op: ActiveOp | null = this.active): void {
    this.recoverNow(reason, op).catch((e: unknown) => this.log('invalidate-recovery-failed', errorText(e)));
  }

  /** Forced recovery (also used by tests): terminate the worker, boot and verify a new engine. */
  async restart(reason: string): Promise<{ engineReadyMs: number; reattachMs: number }> {
    return this.recoverNow(reason, this.active);
  }

  private async recoverNow(reason: string, op: ActiveOp | null): Promise<{ engineReadyMs: number; reattachMs: number }> {
    if (this.disposed) throw new SessionDisposedError();
    if (this.recovery) {
      await this.recovery;
      return { engineReadyMs: 0, reattachMs: 0 };
    }
    const t0 = performance.now();
    let engineReadyMs = 0;
    let reattachMs = 0;
    const recovery = (async () => {
      this.setState('recovering', reason);
      this.engine?.worker.terminate();
      this.engine = null;
      op?.abort('terminate');
      let engine: Engine;
      try {
        engine = await this.bootEngine();
      } catch (e) {
        if (!this.disposed) this.setState('failed', `recovery failed: ${errorText(e)}`);
        throw e;
      }
      this.engine = engine;
      engineReadyMs = performance.now() - t0;
      for (const rf of this.files.values()) {
        if (rf.mode === 'table') {
          rf.status = 'needs-reimport';
          rf.error = 'Imported table was lost when the engine was restarted; re-import it.';
          continue;
        }
        try {
          await engine.db.registerFileHandle(rf.vfsName, rf.file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
          await engine.conn.query(`CREATE VIEW ${sqlIdent(rf.relation)} AS SELECT * FROM ${readerSql(rf)}`);
          rf.status = 'attached';
          delete rf.error;
        } catch (e) {
          rf.status = 'failed';
          rf.error = `Re-attach after restart failed: ${errorText(e)}`;
        }
      }
      reattachMs = performance.now() - t0 - engineReadyMs;
      this.setState('ready');
      this.log('recovered', `engine ${Math.round(engineReadyMs)} ms, views ${Math.round(reattachMs)} ms`);
    })();
    this.recovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.recovery === recovery) this.recovery = null;
    }
    return { engineReadyMs, reattachMs };
  }

  /** Terminal. Wins over pending startup, recovery and queued operations. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.bootToken++;
    this.rejectDisposal(new SessionDisposedError('Session disposed during startup'));
    this.active?.abort('disposed');
    this.active = null;
    this.candidateWorker?.terminate();
    this.candidateWorker = null;
    this.engine?.worker.terminate();
    this.engine = null;
    this.files.clear();
    this.state = 'disposed';
    this.log('state:disposed');
  }

  /** Engine-reported memory (DuckDB buffer manager), not browser or OS memory. */
  async engineMemory(): Promise<{ memoryUsageBytes: number; tempStorageBytes: number; memoryLimit: string } | null> {
    const r = await this.run(
      "SELECT sum(memory_usage_bytes)::BIGINT AS m, sum(temporary_storage_bytes)::BIGINT AS t, current_setting('memory_limit') AS l FROM duckdb_memory()",
      { maxRows: 1 },
    );
    if (r.status !== 'ok') return null;
    const row = r.result.rows[0];
    return row ? { memoryUsageBytes: Number(row[0]), tempStorageBytes: Number(row[1]), memoryLimit: row[2] ?? '' } : null;
  }
}

/** DuckDB-WASM reports some errors as JSON ({exception_type, exception_message}); normalise them. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const j = JSON.parse(raw) as { exception_type?: string; exception_message?: string };
    if (j.exception_type && j.exception_message) return `${j.exception_type} Error: ${j.exception_message.split('\n')[0]}`;
  } catch {
    /* not JSON */
  }
  return raw.split('\n')[0] ?? 'Unknown error';
}
