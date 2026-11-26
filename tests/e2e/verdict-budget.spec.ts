// Resource budgets (TESTING_STRATEGY §5.8; QV-ENG-001, QV-RES-002; acceptance M08 field 17c).
// Evidence comes from the statement trace recorded by the harness DRIVER (every statement the
// engine received), not from the report, so a probe that ran is visible even if the report lied.
import { expect, test, type Page } from '@playwright/test';
import { HARNESS } from './helpers';
import type { Overrides } from '../../harness/verdict';

async function open(page: Page, o: Overrides = {}) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__qvHarness?.verdict !== undefined);
  await page.evaluate((o) => window.__qvHarness!.verdict!.setup(o), o);
}
const PAIR = /\/\*qv:(executed-count|witness-join)\*\//;
const GROUPING = /\/\*qv:(frequencies-left|frequencies-right|statistics|semi-join-left|semi-join-right|fingerprint-start)\*\//;

/** Every statement after BEGIN that reads both inputs through the query's join node. */
const joinStatements = (statements: string[]) => statements.filter((s) => / JOIN /.test(s) && !/__qv_[0-9a-f]{16}_(lf|rf)/.test(s) && !/qv:(parse|render)\*\//.test(s));

test.describe('Verdict budget gate (real engine)', () => {
  test('QV-SA-001 regression: 3 × 4 same-key join, budget 1 → no pair-producing probe runs, witnesses not-run, not authoritative', async ({ page }) => {
    await open(page, { executionPairRows: '1' });
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      await V.table('l', [['k', 'INTEGER']], [[1], [1], [1]]);
      await V.table('r', [['k', 'INTEGER']], [[1], [1], [1], [1]]);
      return V.analyze('SELECT * FROM l JOIN r ON l.k = r.k', [{ kind: 'no-fan-out', join: 0, side: 'left' }]);
    });
    // Independent trace: no executed count and no witness recount through the join reached the engine.
    expect(r.statements.filter((s) => PAIR.test(s))).toEqual([]);
    // The only statements through the join node are the two SEMI JOIN recounts (no pairs) and the DESCRIBE (bind only).
    expect(joinStatements(r.statements).map((s) => /\/\*qv:([a-z-]+)\*\//.exec(s)?.[1])).toEqual(['bind', 'semi-join-left', 'semi-join-right']);
    expect(r.report).toMatchObject({ authoritative: false, status: 'budget-exhausted' });
    expect(r.report.join?.validation).toMatchObject({ executedCount: 'not-run', witnesses: 'not-run', semiJoin: 'agreed', invariants: 'held', snapshot: 'verified' });
    // The refusals were priced from the key frequencies before anything ran: 12 pairs each.
    const refused = r.report.resources!.probes.filter((p) => p.decision === 'refused');
    expect(refused.map((p) => [p.probe, p.cost.pairRows])).toEqual([['executed-count', '12'], ['witness-join', '12']]);
    expect(r.report.resources!.spent.pairRows).toBe('0');
    expect(r.report.join?.witnesses).toEqual([{ kind: 'fan-out', key: ['1'], leftRows: '3', rightRows: '4', outputRows: '12' }]);
    expect(r.report.expectations).toEqual([expect.objectContaining({ outcome: 'unchecked' })]);
    expect(r.report.findings.some((f) => f.category === 'expectation-violation')).toBe(false);
    expect(r.report.findings.filter((f) => f.category === 'observed').every((f) => f.confidence === 'incomplete')).toBe(true);
  });

  test('within budget (12) the same join is fully validated and authoritative', async ({ page }) => {
    await open(page, { executionPairRows: '12' });
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      await V.table('l', [['k', 'INTEGER']], [[1], [1], [1]]);
      await V.table('r', [['k', 'INTEGER']], [[1], [1], [1], [1]]);
      return V.analyze('SELECT * FROM l JOIN r ON l.k = r.k', [{ kind: 'no-fan-out', join: 0, side: 'left' }]);
    });
    expect(r.statements.filter((s) => PAIR.test(s)).length).toBe(1); // the executed count only: 12 pairs leaves no budget for the witness (12 more)
    expect(r.report).toMatchObject({ authoritative: false, status: 'budget-exhausted' });
    await open(page, { executionPairRows: '24' });
    const ok = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      await V.table('l', [['k', 'INTEGER']], [[1], [1], [1]]);
      await V.table('r', [['k', 'INTEGER']], [[1], [1], [1], [1]]);
      return V.analyze('SELECT * FROM l JOIN r ON l.k = r.k', [{ kind: 'no-fan-out', join: 0, side: 'left' }]);
    });
    expect(ok.statements.filter((s) => PAIR.test(s)).length).toBe(2);
    expect(ok.report).toMatchObject({ authoritative: true, status: 'analyzed' });
    expect(ok.report.join?.validation).toMatchObject({ executedCount: 'agreed', witnesses: 'verified' });
    expect(ok.report.resources!.spent.pairRows).toBe('24');
    expect(ok.report.expectations[0]).toMatchObject({ outcome: 'violated', evidence: { excessCopies: '9' } });
  });

  test('cumulative witness cost: each witness fits alone, the plan does not → no witness recount runs', async ({ page }) => {
    // keys 1 and 2, each 2 × 2 = 4 pairs; output 8. Budget 12: the count uses 8, leaving 4 < 4 + 4.
    await open(page, { executionPairRows: '12' });
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      await V.table('l', [['k', 'BIGINT']], [[1], [1], [2], [2]]);
      await V.table('r', [['k', 'BIGINT']], [[1], [1], [2], [2]]);
      return V.analyze('SELECT * FROM l JOIN r ON l.k = r.k');
    });
    expect(r.statements.filter((s) => /qv:witness-join/.test(s))).toEqual([]);
    expect(r.statements.filter((s) => /qv:executed-count/.test(s)).length).toBe(1);
    expect(r.report.resources!.probes.filter((p) => p.probe === 'witness-join').map((p) => [p.decision, p.cost.pairRows])).toEqual([['refused', '4'], ['refused', '4']]);
    expect(r.report).toMatchObject({ authoritative: false, status: 'budget-exhausted' });
  });

  test('over-limit inputs are refused before any grouping or fingerprint statement runs', async ({ page }) => {
    await open(page, { maxInputRows: '2' });
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      await V.table('l', [['k', 'INTEGER']], [[1], [2], [3]]);
      await V.table('r', [['k', 'INTEGER']], [[1]]);
      return V.analyze('SELECT * FROM l LEFT JOIN r ON l.k = r.k', [{ kind: 'row-count', min: 0 }]);
    });
    expect(r.statements.filter((s) => GROUPING.test(s) || PAIR.test(s))).toEqual([]);
    expect(r.report).toMatchObject({ authoritative: false, status: 'budget-exhausted', resources: { inputRows: { left: 'over 2', right: '1' } } });
    expect(r.report.findings[0]).toMatchObject({ code: 'input-too-large', category: 'inconclusive' });
    expect(r.report.expectations[0]?.outcome).toBe('unchecked');
  });

  test('an estimated grouping state over budget is refused before any grouping runs (no DISTINCT … LIMIT pre-check)', async ({ page }) => {
    await open(page, { groupingBytes: '1000' }); // 4 + 2 rows × 84 B + transient 168 B = 672 B fits; 10 + 10 rows does not
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      const rows = Array.from({ length: 10 }, (_, i) => [i]);
      await V.table('l', [['k', 'INTEGER']], rows);
      await V.table('r', [['k', 'INTEGER']], rows);
      return V.analyze('SELECT * FROM l JOIN r ON l.k = r.k');
    });
    expect(r.statements.filter((s) => GROUPING.test(s) || PAIR.test(s) || /DISTINCT/i.test(s))).toEqual([]);
    expect(r.report).toMatchObject({ status: 'budget-exhausted', authoritative: false, resources: { estimatedGroupingBytes: { left: '840', right: '840', transient: '840' } } });
    expect(r.report.findings[0]?.code).toBe('grouping-over-budget');
  });

  test('too many key columns are refused before any probe', async ({ page }) => {
    await open(page, { maxKeyColumns: 1 });
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      await V.table('l', [['a', 'INTEGER'], ['b', 'INTEGER']], [[1, 1]]);
      await V.table('r', [['a', 'INTEGER'], ['b', 'INTEGER']], [[1, 1]]);
      return V.analyze('SELECT * FROM l JOIN r USING (a, b)');
    });
    expect(r.statements.filter((s) => GROUPING.test(s) || PAIR.test(s) || /qv:input-rows/.test(s))).toEqual([]);
    expect(r.report).toMatchObject({ status: 'unsupported', authoritative: false });
    expect(r.report.findings[0]?.message).toMatch(/2 key columns exceed the limit of 1/);
  });

  test('truncated probe output is rejected, never used as evidence', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      // 65 tables named t (main plus 64 schemas): the relation probe declares at most 64 rows.
      await V.exec('CREATE OR REPLACE TABLE t (k INTEGER)');
      for (let i = 0; i < 64; i++) await V.exec(`CREATE SCHEMA IF NOT EXISTS s${i}`, `CREATE OR REPLACE TABLE s${i}.t (k INTEGER)`);
      await V.table('r', [['k', 'INTEGER']], [[1]]);
      return { a: await V.analyze('SELECT * FROM t JOIN r ON t.k = r.k'), left: await V.leftovers(), tx: await V.noOpenTransaction() };
    });
    expect(r.a.report).toMatchObject({ status: 'diagnostic-failed', authoritative: false, join: null });
    expect(r.a.report.findings[0]?.message).toMatch(/truncated results are not used|exceeds 64 rows/);
    expect(r.a.statements.filter((s) => GROUPING.test(s) || PAIR.test(s))).toEqual([]);
    expect([r.left, r.tx]).toEqual([[], true]);
  });

  test('the analysis deadline (including queue wait) stops the analysis and cleans up', async ({ page }) => {
    await open(page, { verdictMs: 800 });
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      await V.table('l', [['k', 'INTEGER']], [[1], [2]]);
      await V.table('r', [['k', 'INTEGER']], [[1]]);
      V.faults.hold = /qv:statistics/;
      const t0 = performance.now();
      const a = await V.analyze('SELECT * FROM l JOIN r ON l.k = r.k', [{ kind: 'row-count', min: 1 }]);
      V.faults.hold = null;
      return { a, ms: performance.now() - t0, left: await V.leftovers(), tx: await V.noOpenTransaction(), generation: V.current().session.generation };
    });
    expect(r.a.report).toMatchObject({ status: 'budget-exhausted', authoritative: false, join: null });
    expect(r.a.report.nonAuthoritativeReasons.join(' ')).toMatch(/deadline of 800 ms/);
    expect(r.a.report.expectations[0]?.outcome).toBe('unchecked');
    expect(r.ms).toBeLessThan(800 + 2_000 + 5_000); // deadline + cancel grace + cleanup bound
    expect([r.left, r.tx, r.generation]).toEqual([[], true, 1]);
  });

  test('the deadline counts queue wait: an analysis queued behind other work still ends at verdictMs from submission', async ({ page }) => {
    await open(page, { verdictMs: 1_500 });
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      await V.table('l', [['k', 'INTEGER']], [[1]]);
      await V.table('r', [['k', 'INTEGER']], [[1]]);
      const s = V.current().session;
      // Another operation holds the engine for 1 s before the analysis can start.
      const blocker = s.submit('query', () => new Promise((res) => setTimeout(res, 1_000)), V.BOUNDS);
      V.faults.hold = /qv:statistics/;
      const t0 = performance.now();
      const a = await V.analyze('SELECT * FROM l JOIN r ON l.k = r.k');
      const ms = performance.now() - t0;
      V.faults.hold = null;
      await blocker.result;
      return { status: a.report.status, reasons: a.report.nonAuthoritativeReasons, ms };
    });
    expect(r.status).toBe('budget-exhausted');
    expect(r.reasons.join(' ')).toMatch(/1500 ms \(including queue wait\)/);
    expect(r.ms).toBeLessThan(1_500 + 1_000); // not 1 s of queue wait + a full 1.5 s run
  });
});
