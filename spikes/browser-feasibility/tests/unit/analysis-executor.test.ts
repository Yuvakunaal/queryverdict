// Terminal outcomes under stalled execution and cancellation (Codex second review H-B), with
// controlled stand-ins for the session batch. Every test asserts an upper bound on wall time.
import { describe, expect, it } from 'vitest';
import { analyzeInSession, invalidExpectation, type ExclusiveSession } from '../../src/analysis/analyze';
import { parseColumnRef } from '../../src/analysis/ast';
import { batchExecutor, BudgetExhaustedError, DiagnosticError, type BatchLike, type RunLike } from '../../src/analysis/executor';
import type { Expectation } from '../../src/analysis/types';

const never = <T>() => new Promise<T>(() => undefined);
const ok = (rows: string[][] = [['1']]): RunLike => ({ status: 'ok', result: { rows, columns: rows[0]?.map(() => ({})) ?? [], truncated: false } });

interface Fake extends BatchLike {
  calls: string[];
  invalidated: string[];
  cancels: number;
}

function fake(opts: { run?: (sql: string, cleanup: boolean) => Promise<RunLike>; cancel?: () => Promise<unknown>; current?: () => boolean } = {}): Fake {
  const f: Fake = {
    calls: [], invalidated: [], cancels: 0,
    run(sql, _limits, o) {
      f.calls.push(sql);
      return opts.run ? opts.run(sql, o?.cleanup === true) : Promise.resolve(ok());
    },
    cancel() {
      f.cancels++;
      return opts.cancel ? opts.cancel() : Promise.resolve(true);
    },
    invalidate(reason) {
      f.invalidated.push(reason);
    },
    isCurrent: () => (opts.current ? opts.current() : f.invalidated.length === 0),
  };
  return f;
}

async function timed<T>(p: Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const t = performance.now();
  try {
    const value = await p;
    return { ms: performance.now() - t, value };
  } catch (error) {
    return { ms: performance.now() - t, error };
  }
}

describe('batchExecutor: bounded terminal outcomes', () => {
  it('stalled RPC with ineffective cancellation (Codex repro): terminates the worker and returns within deadline + grace', async () => {
    const b = fake({ run: () => never(), cancel: () => Promise.resolve(true) });
    const ex = batchExecutor(b, { deadlineMs: 5, cancelGraceMs: 20 });
    const r = await timed(ex.query('SELECT 1'));
    expect(r.error).toBeInstanceOf(BudgetExhaustedError);
    expect(r.ms).toBeLessThan(5 + 2 * 20 + 40);
    expect(b.cancels).toBe(1);
    expect(b.invalidated).toHaveLength(1);
    expect(ex.terminal()).toEqual({ reason: 'deadline', cancellation: 'terminated' });
    // dead afterwards: no further statement reaches the batch
    const calls = b.calls.length;
    await expect(ex.query('SELECT 2')).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(b.calls.length).toBe(calls);
  });

  it('cancellation that rejects: terminates and returns within the bound', async () => {
    const b = fake({ run: () => never(), cancel: () => Promise.reject(new Error('cancel failed')) });
    const r = await timed(batchExecutor(b, { deadlineMs: 5, cancelGraceMs: 20 }).query('SELECT 1'));
    expect(r.error).toBeInstanceOf(BudgetExhaustedError);
    expect(r.ms).toBeLessThan(5 + 2 * 20 + 40);
    expect(b.invalidated[0]).toContain('rejected');
  });

  it('cancellation that never returns: terminates after one grace period', async () => {
    const b = fake({ run: () => never(), cancel: () => never() });
    const r = await timed(batchExecutor(b, { deadlineMs: 5, cancelGraceMs: 20 }).query('SELECT 1'));
    expect(r.error).toBeInstanceOf(BudgetExhaustedError);
    expect(r.ms).toBeLessThan(5 + 20 + 40);
    expect(b.invalidated[0]).toContain('did not return');
  });

  it('cooperative cancellation that stops the statement: no termination', async () => {
    let stop!: (r: RunLike) => void;
    const b = fake({ run: () => new Promise<RunLike>((r) => (stop = r)), cancel: async () => (stop({ status: 'cancelled' }), true) });
    const ex = batchExecutor(b, { deadlineMs: 5, cancelGraceMs: 20 });
    await expect(ex.query('SELECT 1')).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(b.invalidated).toEqual([]);
    expect(ex.terminal()).toEqual({ reason: 'deadline', cancellation: 'cooperative' });
  });

  it('late response after the deadline is never used, and nothing runs afterwards', async () => {
    let late!: (r: RunLike) => void;
    const b = fake({ run: () => new Promise<RunLike>((r) => (late = r)), cancel: async () => true });
    const ex = batchExecutor(b, { deadlineMs: 5, cancelGraceMs: 10 });
    const first = ex.query('SELECT 1');
    await expect(first).rejects.toBeInstanceOf(BudgetExhaustedError);
    late(ok([['LATE']])); // the response arrives after the executor gave up
    await new Promise((r) => setTimeout(r, 5));
    await expect(ex.query('SELECT 2')).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(b.calls).toEqual(['SELECT 1']);
  });

  it('result from a replaced engine is rejected as stale', async () => {
    let current = true;
    const b = fake({ run: async () => ((current = false), ok()), current: () => current });
    const ex = batchExecutor(b, { deadlineMs: 1000 });
    const e = await ex.query('SELECT 1').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DiagnosticError);
    expect((e as DiagnosticError).kind).toBe('stale');
    await expect(ex.query('SELECT 2')).rejects.toMatchObject({ kind: 'stale' });
  });

  it('a cancelled statement ends the analysis as cancelled (not as an engine error)', async () => {
    const ex = batchExecutor(fake({ run: async () => ({ status: 'cancelled' }) }), { deadlineMs: 1000 });
    await expect(ex.query('SELECT 1')).rejects.toMatchObject({ kind: 'cancelled' });
    expect(ex.terminal()?.reason).toBe('cancelled');
  });

  it('truncated and wrongly shaped results are rejected', async () => {
    const t = batchExecutor(fake({ run: async () => ({ status: 'ok', result: { rows: [['1']], columns: [{}], truncated: true } }) }));
    await expect(t.query('SELECT 1')).rejects.toMatchObject({ kind: 'truncated' });
    const s = batchExecutor(fake({ run: async () => ok([['1', '2']]) }));
    await expect(s.query('SELECT 1', { columns: 1 })).rejects.toMatchObject({ kind: 'shape' });
  });

  it('a rejected RPC becomes an engine error, not an unhandled rejection', async () => {
    const ex = batchExecutor(fake({ run: () => Promise.reject(new Error('worker crashed')) }));
    await expect(ex.query('SELECT 1')).rejects.toMatchObject({ kind: 'engine', message: 'worker crashed' });
  });

  it('stalled cleanup is bounded and invalidates the session', async () => {
    const b = fake({ run: (sql) => (sql === 'ROLLBACK' ? never() : Promise.resolve(ok())), cancel: async () => true });
    const r = await timed(batchExecutor(b, { cleanupMs: 15, cancelGraceMs: 10 }).cleanup('ROLLBACK'));
    expect(r.value).toBe('failed');
    expect(r.ms).toBeLessThan(15 + 2 * 10 + 40);
    expect(b.invalidated.length).toBeGreaterThan(0);
  });

  it('cleanup still runs after a cancel, but not on a replaced engine', async () => {
    const cleanups: boolean[] = [];
    const b = fake({ run: async (_sql, cleanup) => (cleanups.push(cleanup), ok()) });
    expect(await batchExecutor(b).cleanup('ROLLBACK')).toBe('ok');
    expect(cleanups).toEqual([true]);
    const gone = fake({ current: () => false });
    expect(await batchExecutor(gone).cleanup('ROLLBACK')).toBe('skipped');
    expect(gone.calls).toEqual([]);
  });
});

describe('analyzeInSession with stand-in sessions', () => {
  const exps: Expectation[] = [{ kind: 'no-fan-out', join: 0 }, { kind: 'row-count', max: 3 }];

  it('stalled queue (exclusive ownership never granted): budget-exhausted at the deadline, every expectation unchecked', async () => {
    let granted: ((b: BatchLike) => Promise<unknown>) | null = null;
    const session: ExclusiveSession = { exclusive: (fn) => ((granted = fn as never), never()) };
    const r = await timed(analyzeInSession(session, 'SELECT 1', exps, { deadlineMs: 20 }));
    expect(r.ms).toBeLessThan(20 + 40);
    expect(r.value).toMatchObject({ status: 'budget-exhausted', authoritative: false, terminal: { reason: 'queue-wait' } });
    expect(r.value!.expectations.map((o) => [o.index, o.outcome])).toEqual([[0, 'unchecked'], [1, 'unchecked']]);
    expect(r.value!.expectations[0]!.expectation).toBe(exps[0]); // identity preserved
    // when ownership is granted later, the abandoned analysis runs nothing
    const b = fake();
    expect(await granted!(b)).toBeNull();
    expect(b.calls).toEqual([]);
  });

  it('stalled worker during the batch: terminated, rolled back or invalidated, and returns within the bound', async () => {
    const b = fake({ run: (sql) => (sql === 'BEGIN TRANSACTION' ? Promise.resolve(ok([])) : never()), cancel: async () => true });
    const session: ExclusiveSession = { exclusive: (fn) => fn(b) };
    const r = await timed(analyzeInSession(session, 'SELECT 1', exps, { deadlineMs: 10, cancelGraceMs: 10, cleanupMs: 10 }));
    expect(r.ms).toBeLessThan(10 + 2 * 10 + 10 + 1000);
    expect(r.value).toMatchObject({ status: 'budget-exhausted', authoritative: false, terminal: { reason: 'deadline', cancellation: 'terminated' } });
    expect(b.invalidated.length).toBeGreaterThan(0);
    expect(r.value!.expectations).toHaveLength(2);
  });

  it('a batch that hangs outside any statement is abandoned and invalidated at the outer bound', async () => {
    const b = fake();
    // The hook never returns, so the batch never reaches the executor's per-statement bounds.
    const r = await timed(analyzeInSession({ exclusive: (fn) => fn(b) }, 'SELECT 1', exps, { deadlineMs: 10, cancelGraceMs: 10, cleanupMs: 10, testHooks: { beforeStatement: () => never() } }));
    expect(r.ms).toBeGreaterThanOrEqual(10 + 2 * 10 + 10 + 1000 - 5);
    expect(r.ms).toBeLessThan(10 + 2 * 10 + 10 + 1000 + 100);
    expect(r.value).toMatchObject({ status: 'budget-exhausted', authoritative: false, terminal: { reason: 'terminated' } });
    expect(b.invalidated).toEqual(['the analysis did not reach a terminal state within its bound']);
    expect(r.value!.expectations).toHaveLength(2);
  });

  it('an open user transaction: inconclusive, nothing analysed, every expectation unchecked', async () => {
    const b = fake({ run: async (sql) => (sql === 'BEGIN TRANSACTION' ? { status: 'error', error: 'TransactionContext Error: cannot start a transaction within a transaction' } : ok()) });
    const r = await analyzeInSession({ exclusive: (fn) => fn(b) }, 'SELECT 1', exps);
    expect(r).toMatchObject({ status: 'inconclusive', authoritative: false });
    expect(r.findings[0]!.code).toBe('transaction-unavailable');
    expect(r.expectations.map((o) => o.outcome)).toEqual(['unchecked', 'unchecked']);
    expect(b.calls).toEqual(['BEGIN TRANSACTION']); // no ROLLBACK of a transaction it does not own
  });

  it('session not available (failed or disposed): session-unavailable with every expectation unchecked', async () => {
    const r = await analyzeInSession({ exclusive: () => Promise.reject(new Error('Engine is not ready (state: failed)')) }, 'SELECT 1', exps);
    expect(r).toMatchObject({ status: 'diagnostic-failed', authoritative: false });
    expect(r.findings[0]!.code).toBe('session-unavailable');
    expect(r.expectations).toHaveLength(2);
  });
});

describe('identifiers and expectation validation (M5, M6)', () => {
  it('parses quoted identifiers without splitting at quoted dots', () => {
    expect(parseColumnRef('r."k.x"')).toEqual(['r', 'k.x']);
    expect(parseColumnRef('"my rel"."a""b"')).toEqual(['my rel', 'a"b']);
    expect(parseColumnRef('"select"')).toEqual(['select']);
    expect(parseColumnRef(' amount ')).toEqual(['amount']);
    for (const bad of ['', 'a.', '.a', '"unterminated', 'a.b.c', 'a"b', '""']) expect(parseColumnRef(bad)).toBeNull();
  });

  it('rejects invalid expectation shapes with a reason', () => {
    const bad: unknown[] = [
      null, 'x', { kind: 'nope' }, { kind: 'relationship', join: 0, expected: 'one-to-few' }, { kind: 'relationship', join: '0', expected: 'one-to-one' },
      { kind: 'no-row-loss', join: 0 }, { kind: 'no-fan-out', join: 0, side: 'up' }, { kind: 'grain', columns: [] },
      { kind: 'metric-preserved', column: 'a.b.c' }, { kind: 'metric-preserved', column: 'a', tolerance: -1 }, { kind: 'metric-preserved', column: 'a', tolerance: Number.NaN },
      { kind: 'metric-preserved', column: 'a', tolerance: Number.POSITIVE_INFINITY }, { kind: 'metric-preserved', column: 'a', tolerance: '0.1' }, { kind: 'metric-preserved', column: 'a', nullAsZero: 'yes' },
      { kind: 'row-count' }, { kind: 'row-count', min: 3, max: 2 }, { kind: 'row-count', min: -1 }, { kind: 'row-count', max: 1.5 },
    ];
    for (const e of bad) expect(invalidExpectation(e), JSON.stringify(e)).not.toBeNull();
    for (const e of [{ kind: 'relationship', join: 0, expected: 'one-to-one' }, { kind: 'no-fan-out', join: 0 }, { kind: 'metric-preserved', column: 'r."k.x"', tolerance: 0.01 }, { kind: 'row-count', min: 0 }]) expect(invalidExpectation(e)).toBeNull();
  });
});
