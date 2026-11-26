// Executor for diagnostic SQL with bounded terminal outcomes (Codex H3, second review H-B).
//
// - Every diagnostic declares its expected shape (columns, maximum rows). A truncated, oversized
//   or differently shaped result is rejected; it is never used as partial evidence.
// - Exact values: diagnostic SQL casts every number to VARCHAR (no JavaScript Number conversion).
// - One analysis-wide deadline. When it expires while a statement runs, that statement (and only
//   the batch's own statement) is cancelled. The caller never waits on the worker without a
//   bound: cancellation gets `cancelGraceMs`, the statement then gets `cancelGraceMs` to settle,
//   and otherwise the worker is terminated (`invalidate`) and the session recovers in the
//   background. A cancel that hangs, is rejected or returns without stopping execution ends the
//   same way.
// - After any terminal event the executor is dead: late responses are ignored and every further
//   statement is refused, so a timed-out statement can never contribute evidence.
// - A result from an engine that is no longer current (recovered, replaced, disposed) is
//   rejected as `stale`.
// - Cleanup statements (DROP, ROLLBACK) are bounded by `cleanupMs`; a cleanup that does not
//   finish invalidates the session (it could otherwise remain inside the analysis transaction).
import type { Executor, QueryShape, TerminalInfo } from './types';

export class BudgetExhaustedError extends Error {
  constructor(message: string, readonly terminal?: TerminalInfo) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

export type DiagnosticErrorKind = 'engine' | 'truncated' | 'shape' | 'cancelled' | 'stale' | 'terminated';

export class DiagnosticError extends Error {
  constructor(readonly kind: DiagnosticErrorKind, message: string) {
    super(message);
    this.name = 'DiagnosticError';
  }
}

/** Errors after which no further diagnostic may run. */
export function isTerminal(e: unknown): boolean {
  return e instanceof BudgetExhaustedError || (e instanceof DiagnosticError && (e.kind === 'cancelled' || e.kind === 'stale' || e.kind === 'terminated'));
}

export interface RunLike {
  status: string;
  error?: string;
  result?: { rows: string[][]; columns: unknown[]; truncated: boolean };
}

/** What the executor needs from an exclusive session batch (EngineSession.exclusive) or a stand-in. */
export interface BatchLike {
  /** `cleanup` statements (ROLLBACK, DROP) must still run after a cancel, on the same engine only. */
  run(sql: string, limits: Record<string, number>, opts?: { cleanup?: boolean }): Promise<RunLike>;
  /** Cancels the batch's active statement. May hang, reject or return without stopping it. */
  cancel(): Promise<unknown>;
  /** Terminates the worker now and recovers in the background. Must not wait on the worker. */
  invalidate(reason: string): void;
  /** False once the engine was replaced, the session disposed or the batch ended. */
  isCurrent(): boolean;
}

export interface ExecutorOptions {
  /** Analysis-wide deadline relative to now (default 30 s); ignored when deadlineAt is given. */
  deadlineMs?: number;
  /** Absolute deadline (performance.now() clock), shared with the caller. */
  deadlineAt?: number;
  /** Bound for the cancel request and, separately, for the cancelled statement to settle. Default 2 s. */
  cancelGraceMs?: number;
  /** Bound for each cleanup statement. Default 5 s. */
  cleanupMs?: number;
  /**
   * TEST-ONLY hooks (harness build). beforeStatement runs before each diagnostic statement and
   * may return replacement SQL; it receives the batch so tests can simulate interference.
   */
  testHooks?: { beforeStatement?: (sql: string, batch: BatchLike) => string | void | Promise<string | void> };
}

export const TIMEOUT = Symbol('timeout');
/** Resolves with the promise's value, or TIMEOUT after `ms` (the promise keeps running). */
export function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<typeof TIMEOUT>((r) => (timer = setTimeout(() => r(TIMEOUT), Math.max(0, ms))))]).finally(() => clearTimeout(timer));
}

const LIMITS = { maxColumns: 64, maxCellChars: 4_000_000, maxDisplayChars: 8_000_000, maxArrowBytes: 8 * 1024 * 1024 };

export interface BatchExecutor extends Executor {
  /** Set once a terminal event happened (deadline, cancellation, termination, stale engine). */
  terminal(): TerminalInfo | null;
  cleanup(sql: string): Promise<'ok' | 'failed' | 'skipped'>;
}

export function batchExecutor(batch: BatchLike, opts: ExecutorOptions = {}): BatchExecutor {
  const deadlineAt = opts.deadlineAt ?? performance.now() + (opts.deadlineMs ?? 30_000);
  const grace = opts.cancelGraceMs ?? 2_000;
  const cleanupMs = opts.cleanupMs ?? 5_000;
  let terminal: TerminalInfo | null = null;

  /** Starts a statement; a rejected RPC becomes an error outcome (never an unhandled rejection). */
  const start = (sql: string, limits: Record<string, number>, cleanup = false): Promise<RunLike> =>
    Promise.resolve()
      .then(() => batch.run(sql, limits, cleanup ? { cleanup: true } : undefined))
      .catch((e: unknown) => ({ status: 'error', error: e instanceof Error ? e.message : String(e) }));

  /** Stops a running statement within bounded time; terminates the worker when it cannot. */
  async function stop(running: Promise<RunLike>, why: string): Promise<TerminalInfo['cancellation']> {
    const cancelled = await within(Promise.resolve().then(() => batch.cancel()).then(() => 'returned' as const, () => 'rejected' as const), grace);
    const settled = await within(running.then(() => 'settled' as const), cancelled === TIMEOUT ? 0 : grace);
    if (settled === 'settled' && cancelled === 'returned' && batch.isCurrent()) return 'cooperative';
    if (settled === 'settled' && !batch.isCurrent()) return 'terminated'; // the session already terminated and is recovering
    batch.invalidate(`${why}; cancellation ${cancelled === TIMEOUT ? 'did not return' : cancelled}${settled === TIMEOUT ? ', statement did not stop' : ''}`);
    return 'terminated';
  }

  function dead(): never {
    if (terminal?.reason === 'deadline' || terminal?.reason === 'queue-wait') throw new BudgetExhaustedError('analysis deadline already reached; no further diagnostics run', terminal);
    throw new DiagnosticError(terminal?.reason === 'stale' ? 'stale' : terminal?.reason === 'cancelled' ? 'cancelled' : 'terminated', `analysis already ended (${terminal?.reason}); no further diagnostics run`);
  }

  return {
    terminal: () => terminal,
    async query(sql: string, shape: QueryShape = {}): Promise<string[][]> {
      if (terminal) dead();
      const hooked = await opts.testHooks?.beforeStatement?.(sql, batch);
      if (typeof hooked === 'string') sql = hooked;
      const remaining = deadlineAt - performance.now();
      if (remaining <= 0) {
        terminal = { reason: 'deadline', cancellation: 'not-needed' };
        throw new BudgetExhaustedError('analysis deadline reached before this diagnostic could run', terminal);
      }
      const maxRows = shape.maxRows ?? 1;
      const running = start(sql, { maxRows, ...LIMITS });
      const r = await within(running, remaining);
      if (r === TIMEOUT) {
        terminal = { reason: 'deadline', cancellation: 'pending' };
        terminal.cancellation = await stop(running, 'analysis deadline reached');
        throw new BudgetExhaustedError(`analysis deadline reached; the running diagnostic was stopped (${terminal.cancellation})`, terminal);
      }
      if (!batch.isCurrent()) {
        terminal = { reason: 'stale', cancellation: 'not-needed' };
        throw new DiagnosticError('stale', 'the engine was replaced, restarted or disposed during the analysis; results from it are not used');
      }
      if (r.status === 'cancelled') {
        terminal = { reason: 'cancelled', cancellation: 'cooperative' };
        throw new DiagnosticError('cancelled', 'the analysis was cancelled');
      }
      if (r.status === 'stale') {
        terminal = { reason: 'stale', cancellation: 'not-needed' };
        throw new DiagnosticError('stale', 'the engine was replaced, restarted or disposed during the analysis; results from it are not used');
      }
      if (r.status !== 'ok' || !r.result) throw new DiagnosticError('engine', r.error ?? `diagnostic ${r.status}`);
      if (r.result.truncated) throw new DiagnosticError('truncated', 'diagnostic result was truncated; it is not used as evidence');
      if (shape.columns !== undefined && r.result.columns.length !== shape.columns) {
        throw new DiagnosticError('shape', `diagnostic returned ${r.result.columns.length} columns, expected ${shape.columns}`);
      }
      if (shape.exactRows !== undefined && r.result.rows.length !== shape.exactRows) {
        throw new DiagnosticError('shape', `diagnostic returned ${r.result.rows.length} rows, expected ${shape.exactRows}`);
      }
      return r.result.rows;
    },
    /** Runs a cleanup statement, also after a deadline; bounded. Returns how it ended. */
    async cleanup(sql: string): Promise<'ok' | 'failed' | 'skipped'> {
      if (!batch.isCurrent()) return 'skipped'; // the engine (and its transaction and temp tables) is gone
      const running = start(sql, { maxRows: 1, ...LIMITS }, true);
      const r = await within(running, cleanupMs);
      if (r === TIMEOUT) {
        terminal ??= { reason: 'terminated', cancellation: 'pending' };
        await stop(running, `cleanup did not finish within ${cleanupMs} ms`);
        if (batch.isCurrent()) batch.invalidate('cleanup could not be confirmed');
        return 'failed';
      }
      return r.status === 'ok' ? 'ok' : 'failed';
    },
  };
}
