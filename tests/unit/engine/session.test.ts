// EngineSession against a scripted stand-in engine (M02 field 15; TESTING_STRATEGY §3, §5.6, §5.7;
// T-ENG-003, 004, 008, 014). Fake timers make every bound deterministic; each test asserts the
// terminal outcome AND that it happened within the documented bound.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineSession, invalidBounds } from '../../../src/core/engine/session';
import type { Lease, OperationBounds, OperationResult } from '../../../src/core/engine/types';
import { LeaseRevokedError } from '../../../src/core/util/errors';
import { FakeDriver, never } from './fake-driver';

const BOUNDS: OperationBounds = { queueWaitMs: 1_000, runMs: 500, cancelGraceMs: 100, cleanupMs: 50 };

let driver: FakeDriver;
let session: EngineSession;

function make(opts: Partial<{ bootMs: number; recoveryMs: number }> = {}) {
  driver = new FakeDriver();
  session = new EngineSession({ driver, bootMs: opts.bootMs ?? 1_000, recoveryMs: opts.recoveryMs ?? 2_000, memoryLimit: '1GB', now: () => Date.now() });
  return session;
}

/** Awaits a result while advancing fake time; returns it with the elapsed fake milliseconds. */
async function settle<T>(p: Promise<OperationResult<T>>, maxMs = 10_000) {
  const t0 = Date.now();
  let done: OperationResult<T> | undefined;
  void p.then((r) => (done = r));
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < maxMs && !done; i += 10) await vi.advanceTimersByTimeAsync(10);
  if (!done) throw new Error(`did not settle within ${maxMs} ms`);
  return { r: done, ms: Date.now() - t0 };
}

async function started() {
  const s = make();
  const p = s.start();
  await vi.advanceTimersByTimeAsync(0);
  await p;
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  session?.dispose();
  vi.useRealTimers();
});

describe('fail-closed boot (T-ENG-008)', () => {
  it('becomes ready only after lockdown is applied and verified', async () => {
    const s = await started();
    expect(s.state.kind).toBe('ready');
    expect(s.generation).toBe(1);
    expect(s.info).toMatchObject({ verified: true, duckdb: 'v1.5.4', loadedExtensions: ['core_functions', 'json', 'parquet'] });
    const calls = driver.current.calls;
    expect(calls.indexOf('SET lock_configuration = true')).toBeLessThan(calls.findIndex((c) => c.startsWith('SELECT name::VARCHAR')));
  });

  it.each([
    ['a lockdown statement fails', (i: FakeInstanceLike) => { i.failStatements = /enable_external_access/; }, 'Mandatory security control failed'],
    ['a setting is not in effect', (i: FakeInstanceLike) => { i.wrongSetting = 'enable_external_access'; }, 'not in effect'],
    ['the lock does not reject changes', (i: FakeInstanceLike) => { i.lockRejects = false; }, 'lock_configuration did not reject'],
    ['the engine version is not qualified', (i: FakeInstanceLike) => { i.duckdbVersion = 'v1.6.0'; }, 'not qualified'],
  ])('refuses to start when %s, terminates the candidate, and accepts no work', async (_n, fault, message) => {
    const s = make();
    driver.configure = (i) => fault(i);
    await expect(s.start()).rejects.toThrow(message);
    expect(s.state.kind).toBe('failed');
    expect(driver.current.terminated).toBe(true);
    expect(s.generation).toBeNull();
    const body = vi.fn();
    const { r } = await settle(s.submit('query', body, BOUNDS).result);
    expect(r.terminal.status).toBe('refused');
    expect(body).not.toHaveBeenCalled();
  });

  it('a boot that never completes fails within bootMs and terminates the candidate', async () => {
    const s = make({ bootMs: 300 });
    driver.bootBehaviour = () => 'stall';
    const t0 = Date.now();
    const p = s.start().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toBeInstanceOf(Error);
    expect(Date.now() - t0).toBe(300);
    expect(s.state.kind).toBe('failed');
    expect(driver.current.terminated).toBe(true);
  });

  it('work submitted before ready waits, then runs on the verified engine', async () => {
    const s = make();
    const h = s.submit('query', async (l) => l.query('SELECT 1', { maxRows: 1 }), BOUNDS);
    const startP = s.start();
    const { r } = await settle(h.result);
    await startP;
    expect(r.terminal.status).toBe('ok');
    expect(r.generation).toBe(1);
  });
});

type FakeInstanceLike = { failStatements: RegExp | null; wrongSetting: string | null; lockRejects: boolean; duckdbVersion: string };

describe('queue', () => {
  it('runs operations one at a time in FIFO order', async () => {
    const s = await started();
    const order: string[] = [];
    const mk = (name: string) => s.submit('query', async (l) => { order.push(`${name}:start`); await l.query(`SELECT '${name}'`, { maxRows: 1 }); order.push(`${name}:end`); }, BOUNDS);
    const hs = ['a', 'b', 'c'].map(mk);
    for (const h of hs) await settle(h.result);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('cancelling a queued operation does no engine work (T-ENG-014)', async () => {
    const s = await started();
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    const first = s.submit('query', (l) => l.query('SELECT slow', { maxRows: 1 }), { ...BOUNDS, runMs: 5_000 });
    const body = vi.fn(async (l: Lease) => l.query('SELECT queued', { maxRows: 1 }));
    const queued = s.submit('query', body, BOUNDS);
    queued.cancel();
    const { r, ms } = await settle(queued.result);
    expect(r.terminal).toEqual({ status: 'cancelled', by: 'user', stop: 'cooperative' });
    expect(ms).toBe(0);
    expect(body).not.toHaveBeenCalled();
    expect(driver.current.calls).not.toContain('SELECT queued');
    first.cancel();
  });

  it('an operation that cannot start within queueWaitMs is refused, never left pending', async () => {
    const s = await started();
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    s.submit('query', (l) => l.query('SELECT slow', { maxRows: 1 }), { ...BOUNDS, runMs: 5_000 });
    const { r, ms } = await settle(s.submit('query', async () => 1, { ...BOUNDS, queueWaitMs: 200 }).result);
    expect(r.terminal.status).toBe('refused');
    expect(ms).toBe(200);
  });

  it('rejects invalid bounds synchronously', async () => {
    const s = await started();
    for (const b of [{ ...BOUNDS, runMs: 0 }, { ...BOUNDS, runMs: Number.POSITIVE_INFINITY }, { ...BOUNDS, cleanupMs: 2 ** 31 }]) {
      const { r } = await settle(s.submit('query', async () => 1, b).result);
      expect(r.terminal.status).toBe('refused');
    }
    expect(invalidBounds(BOUNDS)).toBeNull();
  });
});

describe('cancellation and deadlines', () => {
  it('cooperative cancel stops the running statement; the engine stays (no recovery)', async () => {
    const s = await started();
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    const h = s.submit('query', (l) => l.query('SELECT slow', { maxRows: 1 }), BOUNDS);
    await vi.advanceTimersByTimeAsync(10);
    h.cancel();
    const { r } = await settle(h.result);
    expect(r.terminal).toEqual({ status: 'cancelled', by: 'user', stop: 'cooperative' });
    expect(driver.instances).toHaveLength(1);
    expect(s.state.kind).toBe('ready');
    expect(s.generation).toBe(1);
  });

  it('deadline revokes the lease and cancels cooperatively', async () => {
    const s = await started();
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    const { r, ms } = await settle(s.submit('query', (l) => l.query('SELECT slow', { maxRows: 1 }), BOUNDS).result);
    expect(r.terminal).toEqual({ status: 'cancelled', by: 'deadline', stop: 'cooperative' });
    expect(ms).toBeLessThanOrEqual(BOUNDS.runMs + 2 * BOUNDS.cancelGraceMs);
  });

  it.each(['ignore', 'reject', 'hang'] as const)('cancel that %ss: worker terminated within the grace bound, recovery yields a new generation', async (behaviour) => {
    const s = await started();
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    driver.current.cancelBehaviour = behaviour;
    const first = driver.current;
    const h = s.submit('query', (l) => l.query('SELECT slow', { maxRows: 1 }), BOUNDS);
    const next = s.submit('query', (l) => l.query('SELECT 1', { maxRows: 1 }), { ...BOUNDS, queueWaitMs: 5_000 });
    await vi.advanceTimersByTimeAsync(10);
    h.cancel();
    const { r, ms } = await settle(h.result);
    expect(r.terminal).toEqual({ status: 'cancelled', by: 'user', stop: 'terminated' });
    expect(ms).toBeLessThanOrEqual(2 * BOUNDS.cancelGraceMs + 10);
    expect(first.terminated).toBe(true);
    const n = await settle(next.result);
    expect(n.r.terminal.status).toBe('ok');
    expect(n.r.generation).toBe(2);
    expect(s.epoch).toBe(1); // all tables were lost with the old worker
  });

  it('a body that never settles cannot hold the queue (QV-SA-005, T-ENG-004a)', async () => {
    const s = await started();
    const dead = s.submit('query', () => never<number>(), BOUNDS);
    const later = s.submit('query', (l) => l.query('SELECT 1', { maxRows: 1 }), { ...BOUNDS, queueWaitMs: 5_000 });
    const d = await settle(dead.result);
    expect(d.r.terminal).toEqual({ status: 'cancelled', by: 'deadline', stop: 'cooperative' });
    expect(d.ms).toBeLessThanOrEqual(BOUNDS.runMs + 2 * BOUNDS.cancelGraceMs);
    const l = await settle(later.result);
    expect(l.r.terminal.status).toBe('ok');
    expect(driver.instances).toHaveLength(1); // no engine call was in flight: no termination needed
  });

  it('a stalled non-cancellable call (registerFile) is terminated after one grace period', async () => {
    const s = await started();
    driver.current.registerBehaviour = 'stall';
    const h = s.submit('import', (l) => l.registerFile('/qv-local/x.csv', new File(['a'], 'x.csv')), BOUNDS);
    await vi.advanceTimersByTimeAsync(10);
    h.cancel();
    const { r, ms } = await settle(h.result);
    expect(r.terminal).toEqual({ status: 'cancelled', by: 'user', stop: 'terminated' });
    expect(ms).toBeLessThanOrEqual(BOUNDS.cancelGraceMs + 10);
  });

  it('nothing runs through a revoked lease, and late results are discarded (T-ENG-004b)', async () => {
    const s = await started();
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    driver.current.cancelBehaviour = 'ignore';
    let leaked: Lease | null = null;
    let lateError: unknown = null;
    const h = s.submit('query', async (l) => {
      leaked = l;
      try {
        return await l.query('SELECT slow', { maxRows: 1 });
      } catch (e) {
        lateError = e;
        throw e;
      }
    }, BOUNDS);
    await vi.advanceTimersByTimeAsync(10);
    h.cancel();
    const { r } = await settle(h.result);
    expect(r.value).toBeUndefined();
    driver.instances[0]?.answerLate([['late']]); // terminated worker: never delivered
    const before = driver.instances.map((i) => i.calls.length);
    await expect(leaked!.query('SELECT after', { maxRows: 1 })).rejects.toBeInstanceOf(LeaseRevokedError);
    expect(leaked!.signal.aborted).toBe(true);
    expect(driver.instances.map((i) => i.calls.length)).toEqual(before);
    expect(lateError === null || lateError instanceof LeaseRevokedError).toBe(true);
  });

  it('a late result after a cooperative revocation never reaches the caller', async () => {
    const s = await started();
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    driver.current.cancelBehaviour = 'ignore';
    const inst = driver.current;
    let seenByBody: unknown = 'nothing';
    const h = s.submit('query', async (l) => {
      try {
        seenByBody = await l.query('SELECT slow', { maxRows: 1 });
      } catch (e) {
        seenByBody = e;
      }
      return seenByBody;
    }, { ...BOUNDS, cancelGraceMs: 300 });
    await vi.advanceTimersByTimeAsync(10);
    h.cancel();
    await vi.advanceTimersByTimeAsync(50);
    inst.answerLate([['late']]); // arrives inside the grace period, after revocation
    const { r } = await settle(h.result);
    expect(r.terminal).toEqual({ status: 'cancelled', by: 'user', stop: 'cooperative' });
    expect(r.value).toBeUndefined();
    // The body itself never receives the late rows: the lease rejects them.
    expect(seenByBody).toBeInstanceOf(LeaseRevokedError);
  });

  it('handles settle exactly once; repeated cancel is a no-op', async () => {
    const s = await started();
    const h = s.submit('query', async () => 7, BOUNDS);
    const { r } = await settle(h.result);
    expect(r).toEqual({ terminal: { status: 'ok' }, value: 7, generation: 1 });
    h.cancel();
    h.cancel();
    expect(await h.result).toEqual(r);
  });
});

describe('cleanup (session-owned)', () => {
  it('runs deferred cleanups when an operation is cancelled', async () => {
    const s = await started();
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    const h = s.submit('verdict', async (l) => { await l.query('BEGIN TRANSACTION', { maxRows: 1 }); l.deferCleanup('ROLLBACK'); return l.query('SELECT slow', { maxRows: 1 }); }, BOUNDS);
    await vi.advanceTimersByTimeAsync(10);
    h.cancel();
    await settle(h.result);
    expect(driver.current.calls.slice(-1)).toEqual(['ROLLBACK']);
  });

  it('lease.cleanup() runs it now and removes it from the deferred list', async () => {
    const s = await started();
    const h = s.submit('verdict', async (l) => { l.deferCleanup('ROLLBACK'); return l.cleanup('ROLLBACK'); }, BOUNDS);
    const { r } = await settle(h.result);
    expect(r.value).toBe('ok');
    expect(driver.current.calls.filter((c) => c === 'ROLLBACK')).toHaveLength(1);
  });

  it('runs deferred cleanups newest first, including file unregistration (M03 import contract)', async () => {
    const s = await started();
    driver.current.handler = (sql) => (sql === 'CREATE TABLE slow' ? 'stall' : undefined);
    const h = s.submit('import', async (l) => {
      await l.registerFile('/qv-local/a.csv', new File(['a'], 'a.csv'));
      l.deferDropFile('/qv-local/a.csv');
      await l.query('BEGIN TRANSACTION', { maxRows: 1 });
      l.deferCleanup('ROLLBACK');
      return l.query('CREATE TABLE slow', { maxRows: 1 });
    }, BOUNDS);
    await vi.advanceTimersByTimeAsync(10);
    h.cancel();
    const { r } = await settle(h.result);
    expect(r.terminal).toEqual({ status: 'cancelled', by: 'user', stop: 'cooperative' });
    expect(driver.current.calls.slice(-2)).toEqual(['ROLLBACK', 'DROP FILE /qv-local/a.csv']);
  });

  it('forgetCleanup and an explicit dropFile remove deferred work; nothing runs twice', async () => {
    const s = await started();
    const h = s.submit('import', async (l) => {
      await l.registerFile('/qv-local/b.csv', new File(['b'], 'b.csv'));
      l.deferDropFile('/qv-local/b.csv');
      await l.query('BEGIN TRANSACTION', { maxRows: 1 });
      l.deferCleanup('ROLLBACK');
      await l.query('COMMIT', { maxRows: 1 });
      l.forgetCleanup('ROLLBACK');
      await l.dropFile('/qv-local/b.csv');
      return 'done';
    }, BOUNDS);
    const { r } = await settle(h.result);
    expect(r.value).toBe('done');
    const calls = driver.current.calls;
    expect(calls.filter((c) => c === 'ROLLBACK')).toEqual([]);
    expect(calls.filter((c) => c === 'DROP FILE /qv-local/b.csv')).toHaveLength(1);
  });

  it('a revoked lease cannot defer new cleanups', async () => {
    const s = await started();
    let leaked: Lease | null = null;
    await settle(s.submit('import', async (l) => { leaked = l; return 1; }, BOUNDS).result);
    expect(() => leaked!.deferDropFile('/qv-local/x')).toThrow(LeaseRevokedError);
  });

  it('a stalled cleanup invalidates the engine instead of continuing in an unknown state', async () => {
    const s = await started();
    driver.current.handler = (sql) => (sql === 'ROLLBACK' ? 'stall' : undefined);
    const first = driver.current;
    const { r, ms } = await settle(s.submit('verdict', async (l) => { l.deferCleanup('ROLLBACK'); throw new Error('boom'); }, BOUNDS).result);
    expect(r.terminal).toMatchObject({ status: 'error', phase: 'engine' });
    expect(ms).toBeLessThanOrEqual(BOUNDS.cleanupMs + 10);
    expect(first.terminated).toBe(true);
  });
});

describe('recovery (QV-SA-003, T-ENG-003)', () => {
  it('restart yields a new verified generation, reattaches nothing, and increments the epoch', async () => {
    const s = await started();
    const p = s.restart('test');
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(s.generation).toBe(2);
    expect(s.epoch).toBe(1);
    expect(driver.instances[1]?.calls.some((c) => c.startsWith('REGISTER') || c.startsWith('CREATE VIEW'))).toBe(false);
    expect(driver.instances[1]?.calls).toContain('SET lock_configuration = true');
  });

  it('a running operation becomes stale when the engine is replaced', async () => {
    const s = await started();
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    const h = s.submit('query', (l) => l.query('SELECT slow', { maxRows: 1 }), BOUNDS);
    await vi.advanceTimersByTimeAsync(10);
    void s.restart('replaced');
    const { r } = await settle(h.result);
    expect(r.terminal).toEqual({ status: 'stale', reason: 'generation-changed' });
  });

  it('a recovery whose lockdown fails leaves the session failed and refuses queued work', async () => {
    const s = await started();
    driver.configure = (i, n) => { if (n === 2) i.failStatements = /lock_configuration/; };
    const p = s.restart('test');
    expect(s.state.kind).toBe('recovering');
    const queued = s.submit('query', async () => 1, { ...BOUNDS, queueWaitMs: 5_000 });
    const { r } = await settle(queued.result);
    await p;
    expect(s.state.kind).toBe('failed');
    expect(r.terminal.status).toBe('refused');
    expect(s.generation).toBeNull();
    const after = await settle(s.submit('query', async () => 1, BOUNDS).result);
    expect(after.r.terminal.status).toBe('refused');
  });

  it('a recovery that never completes fails within recoveryMs; queued work settles', async () => {
    make({ bootMs: 10_000, recoveryMs: 400 });
    const p0 = session.start();
    await vi.advanceTimersByTimeAsync(0);
    await p0;
    driver.bootBehaviour = (n) => (n === 2 ? 'stall' : 'ok');
    const t0 = Date.now();
    void session.restart('test');
    expect(session.state.kind).toBe('recovering');
    const queued = session.submit('query', async () => 1, { ...BOUNDS, queueWaitMs: 10_000 });
    const { r } = await settle(queued.result);
    expect(r.terminal.status).toBe('refused');
    expect(Date.now() - t0).toBeLessThanOrEqual(400 + 10);
    expect(session.state.kind).toBe('failed');
    expect(driver.instances[1]?.terminated).toBe(true);
  });

  it('start() after a failed recovery can bring the engine back', async () => {
    const s = await started();
    driver.configure = (i, n) => { if (n === 2) i.lockRejects = false; };
    const p = s.restart('test');
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(s.state.kind).toBe('failed');
    const again = s.start();
    await vi.advanceTimersByTimeAsync(0);
    await again;
    expect(s.state.kind).toBe('ready');
    expect(s.generation).toBe(2);
  });
});

describe('disposal and epoch', () => {
  it('dispose settles every pending handle as stale synchronously and terminates the worker', async () => {
    const s = await started();
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    const active = s.submit('query', (l) => l.query('SELECT slow', { maxRows: 1 }), BOUNDS);
    const queued = s.submit('query', async () => 1, BOUNDS);
    await vi.advanceTimersByTimeAsync(10);
    s.dispose();
    expect((await active.result).terminal).toEqual({ status: 'stale', reason: 'disposed' });
    expect((await queued.result).terminal).toEqual({ status: 'stale', reason: 'disposed' });
    expect(driver.current.terminated).toBe(true);
    expect((await s.submit('query', async () => 1, BOUNDS).result).terminal.status).toBe('stale');
    await expect(s.start()).rejects.toThrow('disposed');
  });

  it('dispose during boot rejects start and terminates the candidate', async () => {
    const s = make();
    driver.bootBehaviour = () => 'stall';
    const p = s.start().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    s.dispose();
    expect(await p).toBeInstanceOf(Error);
    expect(driver.current.terminated).toBe(true);
    expect(s.state.kind).toBe('disposed');
  });

  it('markDataChanged increments the data epoch', async () => {
    const s = await started();
    expect(s.epoch).toBe(0);
    expect(s.markDataChanged()).toBe(1);
  });

  it('reconcile applies overdue deadlines immediately (throttled background timers)', async () => {
    let clock = 0;
    driver = new FakeDriver();
    session = new EngineSession({ driver, bootMs: 1_000, recoveryMs: 2_000, memoryLimit: '1GB', now: () => clock });
    const p = session.start();
    await vi.advanceTimersByTimeAsync(0);
    await p;
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    const h = session.submit('query', (l) => l.query('SELECT slow', { maxRows: 1 }), BOUNDS);
    await vi.advanceTimersByTimeAsync(10);
    clock += BOUNDS.runMs + 1; // the deadline passed but its timer has not fired
    session.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    const { r } = await settle(h.result);
    expect(r.terminal).toMatchObject({ status: 'cancelled', by: 'deadline' });
  });
});
