// M10: session cancel by id and operation labels, the operation store's page-clock times,
// background-tab reconciliation (the overdue path a browser cannot be made to produce on demand),
// the recovery store, and the operation presentation model.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineSession } from '../../../src/core/engine/session';
import type { OperationBounds, OperationId, OperationResult } from '../../../src/core/engine/types';
import { createStore } from '../../../src/core/util/store';
import type { DatasetEntry } from '../../../src/core/datasets/types';
import { createAnnouncer } from '../../../src/stores/announcer';
import { createOperationStore, type OperationEntry } from '../../../src/stores/operationStore';
import { createRecoveryStore } from '../../../src/stores/recoveryStore';
import { followVisibility, reconcileVisible } from '../../../src/stores/visibility';
import { elapsed, entryState, limitText, outcomeText, overallState, queuedReason, verdictOutcome } from '../../../src/features/workspace/operationModel';
import { FakeDriver } from '../engine/fake-driver';

const BOUNDS: OperationBounds = { queueWaitMs: 30_000, runMs: 60_000, cancelGraceMs: 2_000, cleanupMs: 5_000 };
let driver: FakeDriver;
let session: EngineSession;
let clock = 0;

beforeEach(async () => {
  vi.useFakeTimers();
  clock = 0;
  driver = new FakeDriver();
  session = new EngineSession({ driver, bootMs: 1_000, recoveryMs: 2_000, memoryLimit: '1GB', now: () => clock });
  const p = session.start();
  await vi.advanceTimersByTimeAsync(0);
  await p;
});
afterEach(() => {
  vi.useRealTimers();
});

async function settled<T>(p: Promise<OperationResult<T>>) {
  let r: OperationResult<T> | undefined;
  void p.then((x) => (r = x));
  for (let i = 0; i < 1000 && !r; i++) await vi.advanceTimersByTimeAsync(10);
  if (!r) throw new Error('did not settle');
  return r;
}

describe('session.cancel(id) and operation labels', () => {
  it('cancels a queued operation at once, an active one through the same path as its handle; unknown or settled ids do nothing', async () => {
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    const store = createOperationStore(session, () => clock);
    const active = session.submit('query', (l) => l.query('SELECT slow', { maxRows: 1 }), BOUNDS, 'SELECT');
    const queued = session.submit('import', async () => 'x', BOUNDS, 'orders.csv');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().map((o) => [o.kind, o.phase, o.label, o.queueWaitMs])).toEqual([['query', 'active', 'SELECT', 30_000], ['import', 'queued', 'orders.csv', 30_000]]);
    expect(session.cancel(queued.id)).toBe(true);
    expect((await settled(queued.result)).terminal).toMatchObject({ status: 'cancelled', by: 'user' });
    expect(session.cancel('nope' as OperationId)).toBe(false);
    expect(session.cancel(active.id)).toBe(true);
    expect(session.state).toMatchObject({ kind: 'cancelling', op: active.id });
    expect((await settled(active.result)).terminal).toMatchObject({ status: 'cancelled' });
    expect(session.cancel(active.id)).toBe(false);
    expect(store.getSnapshot().filter((o) => o.id === active.id)).toHaveLength(1);
  });

  it('records page-clock times for queued, started and settled; nothing changes after settlement', async () => {
    const store = createOperationStore(session, () => clock);
    clock = 100;
    const h = session.submit('query', async () => 1, BOUNDS, 'SELECT');
    await settled(h.result);
    const e = store.getSnapshot()[0] as OperationEntry;
    expect(e).toMatchObject({ phase: 'settled', queuedAt: 100, startedAt: 100, settledAt: 100, label: 'SELECT', terminal: { status: 'ok' } });
  });
});

describe('background tabs: reconcile on return (ARCHITECTURE §12.5)', () => {
  it('applies overdue limits at once and reports what they stopped, once; nothing when nothing was overdue', async () => {
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    const ops = createOperationStore(session, () => clock);
    expect(reconcileVisible(session)).toBeNull();
    void ops;
    const active = session.submit('query', (l) => l.query('SELECT slow', { maxRows: 1 }), BOUNDS, 'SELECT');
    const queued = session.submit('verdict', async () => 'x', { ...BOUNDS, queueWaitMs: 1_000 }, 'the query');
    await vi.advanceTimersByTimeAsync(0);
    clock += BOUNDS.runMs + 1; // both limits passed while timers were throttled (they have not fired)
    const message = reconcileVisible(session);
    expect(message).toBe('Back in this tab: 1 queued operation was not started because its wait limit passed while the tab was in the background; the running operation reached its time limit while the tab was in the background, so a stop was requested. Time limits apply while the tab is visible.');
    expect((await settled(queued.result)).terminal).toMatchObject({ status: 'refused' });
    expect((await settled(active.result)).terminal).toMatchObject({ status: 'cancelled', by: 'deadline' });
    expect(reconcileVisible(session)).toBeNull(); // reported once
  });
});

describe('recovery store', () => {
  const entry = (relation: string, origin: DatasetEntry['origin'], state: DatasetEntry['state'] = 'ready') => ({ relation, origin, state, kind: 'table', verdictEligible: true }) as DatasetEntry;
  it('remembers tables created by SQL before the registry clears them; reports recovery, failure, retry', async () => {
    const registry = createStore<readonly DatasetEntry[]>([entry('made', 'sql'), entry('people', 'imported')]);
    const announcer = createAnnouncer();
    const rec = createRecoveryStore(session, registry, announcer);
    registry.set([entry('made', 'sql'), entry('people', 'imported'), entry('more', 'sql')]);
    const restart = session.restart('test: replaced');
    registry.set([]); // what the registry does when recovery starts
    expect(rec.getSnapshot()).toMatchObject({ phase: 'recovering', reason: 'test: replaced', lostSqlTables: ['made', 'more'] });
    await vi.advanceTimersByTimeAsync(0);
    await restart;
    await vi.advanceTimersByTimeAsync(0);
    expect(rec.getSnapshot()).toMatchObject({ phase: 'recovered', lostSqlTables: ['made', 'more'] });
    expect(announcer.getSnapshot()?.message).toBe('The engine was restarted and its in-memory tables were lost. 2 tables created by SQL must be recreated. Imported files can be re-imported.');
    rec.dismiss();
    expect(rec.getSnapshot().phase).toBe('none');
    // A recovery that fails, then a retry that succeeds.
    const bootsSoFar = driver.instances.length;
    driver.bootBehaviour = (n) => (n === bootsSoFar + 1 ? 'reject' : 'ok');
    const again = session.restart('test: again').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    await again;
    expect(rec.getSnapshot().phase).toBe('recovery-failed');
    const retry = session.start();
    await vi.advanceTimersByTimeAsync(0);
    await retry;
    await vi.advanceTimersByTimeAsync(0);
    expect(rec.getSnapshot().phase).toBe('recovered');
    rec.dispose();
  });
});

describe('operation presentation', () => {
  const op = (o: Partial<OperationEntry>): OperationEntry => ({ id: 'a' as OperationId, kind: 'query', phase: 'active', queuedAt: 0, seq: 1, ...o });
  it('the strip state follows the engine first, then the active operation (PRD §5 names)', () => {
    expect(overallState({ kind: 'ready' }, [])).toBe('Ready');
    expect(overallState({ kind: 'busy', op: 'a' as OperationId }, [op({})])).toBe('Running SQL');
    expect(overallState({ kind: 'busy', op: 'a' as OperationId }, [op({ kind: 'import' })])).toBe('Importing');
    expect(overallState({ kind: 'busy', op: 'a' as OperationId }, [op({ kind: 'verdict' })])).toBe('Analyzing');
    expect(overallState({ kind: 'ready' }, [op({ phase: 'queued' })])).toBe('Queued');
    expect(overallState({ kind: 'cancelling', op: 'a' as OperationId }, [op({})])).toBe('Cancelling');
    expect(overallState({ kind: 'recovering', reason: 'x' }, [])).toBe('Recovering');
    expect(overallState({ kind: 'failed', reason: 'x' }, [])).toBe('Failed');
    expect(entryState(op({}), { kind: 'cancelling', op: 'a' as OperationId })).toBe('Cancelling…');
  });
  it('queued reasons come from the engine state and the operation ahead; the limit is labelled', () => {
    const active = op({ id: 'x' as OperationId, label: 'SELECT' });
    const q = op({ id: 'q' as OperationId, kind: 'verdict', phase: 'queued', queuedAt: 5, seq: 2, queueWaitMs: 30_000 });
    expect(queuedReason(q, [active, q], { kind: 'busy', op: 'x' as OperationId })).toBe('Waiting for the SQL run (SELECT) to finish. Operations run one at a time. It is not started if it waits longer than 30 s (limit).');
    expect(queuedReason(q, [q], { kind: 'recovering', reason: 'r' })).toBe('Waiting for the engine to recover. It is not started if it waits longer than 30 s (limit).');
  });
  it('outcomes never call a cancelled, refused or stale operation successful', () => {
    expect(outcomeText({ status: 'ok' })).toBe('Finished');
    expect(outcomeText({ status: 'cancelled', by: 'user', stop: 'cooperative' })).toBe('Cancelled');
    expect(outcomeText({ status: 'cancelled', by: 'deadline', stop: 'terminated' })).toBe('Stopped at its time limit; it did not stop in time, so the engine was restarted and its in-memory tables were lost');
    expect(outcomeText({ status: 'refused', reason: 'queue-wait: did not start within 2000 ms' }, 2_000)).toBe('Not started: it waited longer than 2 s (limit)');
    expect(outcomeText({ status: 'stale', reason: 'generation-changed' })).toBe('Ended: the engine was restarted while it ran');
    expect(outcomeText({ status: 'stale', reason: 'disposed' })).toBe('Ended: the session closed');
    expect(limitText(120_000)).toBe('2 min');
    expect(limitText(1_500)).toBe('1,500 ms');
    expect(elapsed(61_400)).toBe('1 min 01 s');
  });
});

describe('Codex M10 regressions', () => {
  it('HIGH: an operation whose queue wait passed is refused at dispatch, even if its timer was delayed; its body never runs', async () => {
    let started = false;
    let release!: () => void;
    const first = session.submit('query', () => new Promise<void>((r) => (release = r)), BOUNDS);
    const late = session.submit('query', async () => { started = true; }, { ...BOUNDS, queueWaitMs: 2_000 });
    await vi.advanceTimersByTimeAsync(0);
    clock += 2_500; // the limit passed; its timer has not fired (fake timers not advanced)
    release();
    expect((await settled(late.result)).terminal).toMatchObject({ status: 'refused', reason: expect.stringMatching(/^queue-wait/) });
    expect(started).toBe(false);
    expect((await settled(first.result)).terminal.status).toBe('ok');
  });

  it('HIGH: a body that finishes after its run deadline is flagged; a cancel that arrives while it finishes is reported', async () => {
    let release!: () => void;
    const h = session.submit('verdict', () => new Promise<string>((r) => (release = () => r('done'))), { ...BOUNDS, runMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    clock += 5_000; // past the deadline, timer delayed
    release();
    const r = await settled(h.result);
    expect(r).toMatchObject({ terminal: { status: 'ok' }, pastDeadline: true });
    // A cancel requested during clean-up (the final ROLLBACK) cannot change the outcome, but is reported.
    driver.current.handler = (sql) => (sql === 'ROLLBACK' ? 'stall' : undefined);
    const g = session.submit('verdict', async (l) => { l.deferCleanup('ROLLBACK'); return 'x'; }, BOUNDS);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.cancel(g.id)).toBe(true);
    // Release the ROLLBACK within its clean-up limit: the operation finishes normally.
    await vi.advanceTimersByTimeAsync(10);
    driver.current.pending.find((p) => p.sql === 'ROLLBACK')?.resolve([]);
    const r2 = await settled(g.result);
    expect(r2).toMatchObject({ terminal: { status: 'ok' }, cancelRequested: true });
  });

  it('HIGH: recovery context (lost SQL tables) survives failed retries until dismissed', async () => {
    const entry = (relation: string) => ({ relation, origin: 'sql', state: 'ready', kind: 'table', verdictEligible: true }) as DatasetEntry;
    const registry = createStore<readonly DatasetEntry[]>([entry('lose_me')]);
    const rec = createRecoveryStore(session, registry);
    const boots = driver.instances.length;
    driver.bootBehaviour = (n) => (n <= boots + 2 ? 'reject' : 'ok'); // recovery and the first retry fail
    const r1 = session.restart('test').catch(() => undefined);
    registry.set([]);
    await vi.advanceTimersByTimeAsync(5_000);
    await r1;
    expect(rec.getSnapshot()).toMatchObject({ phase: 'recovery-failed', lostSqlTables: ['lose_me'] });
    await session.start().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(rec.getSnapshot()).toMatchObject({ phase: 'recovery-failed', lostSqlTables: ['lose_me'] });
    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(rec.getSnapshot()).toMatchObject({ phase: 'recovered', lostSqlTables: ['lose_me'] });
    rec.dismiss();
    expect(rec.getSnapshot()).toMatchObject({ phase: 'none', lostSqlTables: [] });
  });

  it('MEDIUM: reconciliation reports only what it did: a manual Cancel in progress is not reported as a background stop', async () => {
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    driver.current.cancelBehaviour = 'ignore';
    const h = session.submit('query', (l) => l.query('SELECT slow', { maxRows: 1 }), BOUNDS);
    await vi.advanceTimersByTimeAsync(0);
    session.cancel(h.id);
    clock += BOUNDS.runMs + 1;
    expect(reconcileVisible(session)).toBeNull();
    await settled(h.result);
  });

  it('MEDIUM: queue position follows submission order even when timestamps are equal', async () => {
    driver.current.handler = (sql) => (sql === 'SELECT slow' ? 'stall' : undefined);
    const store = createOperationStore(session, () => 42); // a frozen clock
    session.submit('query', (l) => l.query('SELECT slow', { maxRows: 1 }), BOUNDS, 'SELECT');
    session.submit('verdict', async () => 1, BOUNDS, 'the query');
    session.submit('import', async () => 1, BOUNDS, 'b.csv');
    await vi.advanceTimersByTimeAsync(0);
    const all = store.getSnapshot();
    const imp = all.find((o) => o.kind === 'import')!;
    expect(queuedReason(imp, all, session.state)).toContain('1 operation is ahead of it');
  });

  it('LOW: the visibility listener is removed on teardown, and a disposed session is never reconciled', () => {
    const listeners = new Set<() => void>();
    const doc = { visibilityState: 'visible', addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f) } as unknown as Document;
    const spy = vi.spyOn(session, 'reconcile');
    const stop = followVisibility(doc, session, createAnnouncer());
    for (const f of listeners) f();
    expect(spy).toHaveBeenCalledTimes(1);
    stop();
    expect(listeners.size).toBe(0);
    session.dispose();
    expect(reconcileVisible(session)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('Codex M10 re-review regressions', () => {
  it('HIGH: dispatch is not re-entrant: a subscriber that submits while an expired operation settles never creates a second active lease; every handle settles once', async () => {
    const active = new Set<string>();
    let maxActive = 0;
    const settledCount = new Map<string, number>();
    const body = (id: () => string) => async () => {
      active.add(id());
      maxActive = Math.max(maxActive, active.size);
      await new Promise((r) => setTimeout(r, 50));
      active.delete(id());
      return 'x';
    };
    let release!: () => void;
    const first = session.submit('query', () => new Promise<void>((r) => (release = r)), BOUNDS);
    const expiring = session.submit('query', async () => 'never', { ...BOUNDS, queueWaitMs: 1_000 });
    let a = '';
    let b = '';
    const h2 = session.submit('query', body(() => a), BOUNDS);
    a = h2.id;
    let extra: ReturnType<typeof session.submit> | null = null;
    const off = session.subscribe((e) => {
      if (e.type === 'operation' && e.phase === 'settled') settledCount.set(e.id, (settledCount.get(e.id) ?? 0) + 1);
      if (e.type === 'operation' && e.phase === 'settled' && e.id === expiring.id && !extra) {
        extra = session.submit('query', body(() => b), BOUNDS); // synchronous submission during the expiry settlement
        b = extra.id;
      }
    });
    await vi.advanceTimersByTimeAsync(0);
    clock += 2_000; // the second operation's wait limit passed; its timer has not fired
    release();
    for (const h of [first, expiring, h2] as { result: Promise<OperationResult<unknown>> }[]) await settled(h.result);
    await settled(extra!.result);
    off();
    expect(maxActive).toBe(1);
    expect((await expiring.result).terminal).toMatchObject({ status: 'refused' });
    for (const n of settledCount.values()) expect(n).toBe(1);
  });

  it('MEDIUM: the recovery notice says its SQL table list may be incomplete when data changed after the list was read', async () => {
    const entry = (relation: string) => ({ relation, origin: 'sql', state: 'ready', kind: 'table', verdictEligible: true }) as DatasetEntry;
    const registry = createStore<readonly DatasetEntry[]>([entry('known')]);
    const rec = createRecoveryStore(session, registry);
    registry.set([entry('known')]); // list read at the current epoch
    session.markDataChanged(); // a CREATE TABLE whose catalog read did not finish
    const r = session.restart('test');
    await vi.advanceTimersByTimeAsync(0);
    await r;
    expect(rec.getSnapshot()).toMatchObject({ phase: 'recovered', lostSqlTables: ['known'], lostSqlIncomplete: true });
  });

  it('MEDIUM: the latest analysis shows the outcome the user got, not the engine-level "Finished"', () => {
    const o: OperationEntry = { id: 'v' as OperationId, kind: 'verdict', phase: 'settled', seq: 1, queuedAt: 0, terminal: { status: 'ok' } };
    expect(entryState(o, { kind: 'ready' })).toBe('Finished');
    expect(entryState(o, { kind: 'ready' }, verdictOutcome('budget-exhausted'))).toBe('Stopped at a limit: no authoritative report');
    expect(verdictOutcome('cancelled')).toBe('Cancelled: its report was withheld');
    expect(verdictOutcome('analyzed')).toBe('Finished: report published');
  });
});
