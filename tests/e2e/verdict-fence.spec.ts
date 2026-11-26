// Publication fence at the real boundary (ARCHITECTURE §16; QV-ENG-002, QV-VER-005; acceptance
// M08 field 17d). Interruptions are injected at each hand-off after the last probe: during the
// final ROLLBACK, after ROLLBACK (before the operation settles and the lease is released), and
// after settlement (before the report-store hand-off). Every interrupted run must publish a
// non-authoritative report with no measurements and no held or violated outcome; an
// uninterrupted run is still authoritative.
import { expect, test, type Page } from '@playwright/test';
import { HARNESS } from './helpers';

async function open(page: Page, verdictMs?: number) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__qvHarness?.verdict !== undefined);
  await page.evaluate(async (verdictMs) => {
    const V = window.__qvHarness!.verdict!;
    await V.setup(verdictMs ? { verdictMs } : {});
    await V.table('l', [['k', 'INTEGER']], [[1], [1], [2]]);
    await V.table('r', [['k', 'INTEGER']], [[1], [3]]);
  }, verdictMs);
}
const Q = 'SELECT * FROM l LEFT JOIN r ON l.k = r.k';
// One held (a many-to-many allowance always holds) and one violated (the join produces 3 rows, more than 1).
const EXPECT = [{ kind: 'relationship', join: 0, expected: 'many-to-many' }, { kind: 'row-count', max: 1 }];

type Out = { report: { authoritative: boolean; status: string; join: unknown; findings: readonly { category: string }[]; expectations: readonly { index: number; outcome: string }[]; nonAuthoritativeReasons: readonly string[] }; store: { id: string | undefined; authoritative: boolean | undefined; current: boolean }; reportId: string; tx: boolean | null; left: string[] | null };

function scenario(page: Page, name: string): Promise<Out> {
  return page.evaluate(async ({ name, Q, EXPECT }) => {
    const V = window.__qvHarness!.verdict!;
    const { session, reports } = V.current();
    let stop: (() => void) | null = null;
    const onSettled = (action: () => unknown) => {
      stop = session.subscribe((e) => {
        if (e.type === 'operation' && e.kind === 'verdict' && e.phase === 'settled') {
          stop?.();
          action();
        }
      });
    };
    const run = V.start(Q, EXPECT);
    const h = run.handle;
    switch (name) {
      case 'cancel during the final ROLLBACK':
        V.faults.hold = /^ROLLBACK$/;
        await V.waitFor(() => V.held.length === 1);
        h.cancel();
        V.faults.hold = null;
        V.held[0]!.release();
        break;
      case 'ROLLBACK never completes (cleanup bound) and cancel':
        V.faults.hold = /^ROLLBACK$/;
        await V.waitFor(() => V.held.length === 1);
        h.cancel();
        V.faults.hold = null; // the held ROLLBACK is never released: the session's cleanup bound replaces the engine
        break;
      case 'dispose during the final ROLLBACK':
        V.faults.hold = /^ROLLBACK$/;
        await V.waitFor(() => V.held.length === 1);
        V.faults.hold = null;
        session.dispose();
        break;
      case 'restart after ROLLBACK, before the lease is released':
        V.faults.after = { match: /^ROLLBACK$/, action: () => void session.restart('injected after ROLLBACK') };
        break;
      case 'cancel after ROLLBACK, before the lease is released':
        V.faults.after = { match: /^ROLLBACK$/, action: () => h.cancel() };
        break;
      case 'engine replaced after settlement, before the store hand-off':
        onSettled(() => void session.restart('injected before publication'));
        break;
      case 'data changed after settlement, before the store hand-off':
        onSettled(() => session.markDataChanged());
        break;
      case 'cancel after settlement, before the store hand-off':
        onSettled(() => h.cancel());
        break;
      case 'dispose after settlement, before the store hand-off':
        onSettled(() => session.dispose());
        break;
      case 'uninterrupted':
        break;
    }
    const out = await run.done;
    V.faults.after = null;
    const view = reports.getSnapshot();
    const alive = session.state.kind !== 'disposed';
    if (alive) await V.waitFor(() => session.state.kind === 'ready');
    return {
      report: out.report, reportId: out.report.id,
      store: { id: view.report?.id, authoritative: view.report?.authoritative, current: view.current },
      tx: alive ? await V.noOpenTransaction() : null, left: alive ? await V.leftovers() : null,
    };
  }, { name, Q, EXPECT });
}

const INTERRUPTED = [
  ['cancel during the final ROLLBACK', 'cancelled'],
  ['ROLLBACK never completes (cleanup bound) and cancel', 'cancelled'],
  ['dispose during the final ROLLBACK', 'stale'],
  ['restart after ROLLBACK, before the lease is released', 'stale'],
  ['cancel after ROLLBACK, before the lease is released', 'cancelled'],
  ['engine replaced after settlement, before the store hand-off', 'stale'],
  ['data changed after settlement, before the store hand-off', 'stale'],
  ['cancel after settlement, before the store hand-off', 'cancelled'],
  ['dispose after settlement, before the store hand-off', 'stale'],
] as const;

test.describe('publication fence (real engine, injected at each hand-off)', () => {
  test('control: an uninterrupted run is authoritative and current, with held and violated outcomes', async ({ page }) => {
    await open(page);
    const r = await scenario(page, 'uninterrupted');
    expect(r.report).toMatchObject({ authoritative: true, status: 'analyzed' });
    expect(r.report.expectations.map((o) => o.outcome)).toEqual(['held', 'violated']);
    expect(r.store).toEqual({ id: r.reportId, authoritative: true, current: true });
    expect([r.tx, r.left]).toEqual([true, []]);
  });

  for (const [name, status] of INTERRUPTED) {
    test(`${name} → ${status}, not authoritative, nothing measured, no held/violated outcome`, async ({ page }) => {
      await open(page);
      const r = await scenario(page, name);
      expect(r.report.authoritative).toBe(false);
      expect(r.report.status).toBe(status);
      expect(r.report.join).toBeNull();
      expect(r.report.findings.some((f) => ['observed', 'suspicious', 'expectation-violation'].includes(f.category))).toBe(false);
      expect(r.report.expectations.map((o) => [o.index, o.outcome])).toEqual([[0, 'unchecked'], [1, 'unchecked']]);
      expect(r.report.nonAuthoritativeReasons.length).toBeGreaterThan(0);
      // The store received exactly this (non-authoritative) report and does not show it as current authority.
      expect(r.store.id).toBe(r.reportId);
      expect(r.store.authoritative).toBe(false);
      if (r.tx !== null) expect([r.tx, r.left]).toEqual([true, []]);
    });
  }

  test('late diagnostic response after the deadline: the result is discarded, the published report stays non-authoritative', async ({ page }) => {
    await open(page, 1_000);
    const r = await page.evaluate(async ({ Q, EXPECT }) => {
      const V = window.__qvHarness!.verdict!;
      const { session, reports } = V.current();
      V.faults.hold = /qv:executed-count/;
      V.faults.ignoreCancel = true; // the cancel request does not stop the statement: the worker is terminated
      const run = V.start(Q, EXPECT);
      const out = await run.done;
      const genAfter = session.generation;
      V.faults.ignoreCancel = false;
      V.faults.hold = null;
      for (const held of [...V.held]) held.release(); // the late answer arrives now
      await new Promise((res) => setTimeout(res, 300));
      await V.waitFor(() => session.state.kind === 'ready');
      return { report: out.report, store: reports.getSnapshot(), genAfter, gen: session.generation, tx: await V.noOpenTransaction(), left: await V.leftovers() };
    }, { Q, EXPECT });
    expect(r.report).toMatchObject({ authoritative: false, status: 'budget-exhausted', join: null });
    expect(r.report.expectations.map((o) => o.outcome)).toEqual(['unchecked', 'unchecked']);
    expect(r.store.report?.id).toBe(r.report.id);
    expect(r.store.report?.authoritative).toBe(false);
    expect(r.gen).toBe(2); // the statement could not be stopped, so the worker was replaced
    expect([r.tx, r.left]).toEqual([true, []]);
  });

  test('a published authoritative report becomes historical on data change and on engine restart', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async ({ Q }) => {
      const V = window.__qvHarness!.verdict!;
      const { session, reports } = V.current();
      await V.analyze(Q);
      const fresh = reports.getSnapshot();
      session.markDataChanged();
      const changed = reports.getSnapshot();
      await session.restart('test');
      const restarted = reports.getSnapshot();
      return { fresh: [fresh.current, fresh.report?.authoritative], changed: [changed.current, changed.historicalReason], restarted: [restarted.current, restarted.historicalReason] };
    }, { Q });
    expect(r).toEqual({ fresh: [true, true], changed: [false, 'data may have changed'], restarted: [false, 'engine restarted'] });
  });
});
