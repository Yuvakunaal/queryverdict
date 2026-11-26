// Snapshot consistency (TESTING_STRATEGY §5.5; QV-ENG-005; acceptance M08 field 17f). Work submitted
// during an analysis must wait for it (exclusive lease), so the report describes one snapshot; a
// write slipped INSIDE the lease (simulated defect) must be detected and withdraw the evidence.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HARNESS } from './helpers';

const PEOPLE = readFileSync(path.resolve('tests/fixtures/import/people.csv')).toString('base64');

async function open(page: Page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__qvHarness?.verdict !== undefined);
  await page.evaluate(() => window.__qvHarness!.verdict!.setup());
}
/** Codex snapshot reproduction data: left key 1; right keys 1, 1, 2, 2. */
const seed = (page: Page) => page.evaluate(async () => {
  const V = window.__qvHarness!.verdict!;
  await V.table('l', [['id', 'INTEGER'], ['k', 'INTEGER']], [[1, 1]]);
  await V.table('r', [['k', 'INTEGER']], [[1], [1], [2], [2]]);
});
const Q = 'SELECT * FROM l JOIN r ON l.k = r.k';

test.describe('snapshot consistency (real engine)', () => {
  test('Codex reproduction: a concurrent UPDATE waits for the analysis; the report describes key 1 coherently', async ({ page }) => {
    await open(page);
    await seed(page);
    const r = await page.evaluate(async (Q) => {
      const V = window.__qvHarness!.verdict!;
      V.faults.hold = /qv:witness-selection/; // pause between diagnostic probes
      const run = V.start(Q, [{ kind: 'relationship', join: 0, expected: 'one-to-many' }]);
      await V.waitFor(() => V.held.length === 1);
      const update = V.sql(V.current().session, 'UPDATE l SET k = 2'); // the user's UPDATE, mid-analysis
      V.faults.hold = null;
      V.held[0]!.release();
      const a = await run.done;
      const u = await update;
      const second = await V.analyze(Q);
      return { a, u: u.terminal.status, second, log: V.statementLog.slice() };
    }, Q);
    expect(r.u).toBe('ok');
    // The UPDATE reached the engine only after the analysis rolled back.
    const upd = r.log.indexOf('UPDATE l SET k = 2');
    const lastRollback = r.log.lastIndexOf('ROLLBACK', upd);
    expect(upd).toBeGreaterThan(lastRollback);
    expect(r.log.slice(r.log.indexOf(r.a.statements[0]!), upd).some((s) => s.startsWith('UPDATE'))).toBe(false);
    expect(r.a.report).toMatchObject({ authoritative: true, status: 'analyzed' });
    expect(r.a.report.join?.derived?.outputRows).toBe('2');
    expect(r.a.report.join?.witnesses).toEqual([
      { kind: 'fan-out', key: ['1'], leftRows: '1', rightRows: '2', outputRows: '2' },
      { kind: 'unmatched-right', key: ['2'], leftRows: '0', rightRows: '2', outputRows: '0' },
    ]);
    // The next analysis sees the updated data, also coherently.
    expect(r.second.report.join?.witnesses.map((w) => [w.kind, w.key[0]])).toEqual([['fan-out', '2'], ['unmatched-right', '1']]);
    expect(r.second.report.authoritative).toBe(true);
  });

  test('import, removal, re-import and a second analysis submitted mid-analysis all wait; the report is coherent', async ({ page }) => {
    await open(page);
    await seed(page);
    const r = await page.evaluate(async ({ Q, data }) => {
      const V = window.__qvHarness!.verdict!;
      const D = window.__qvHarness!.datasets!; // only for File construction
      const { datasets, verdict, session } = V.current();
      const before = await datasets.importer.import([{ file: D.file('people.csv', data) }]).handles[0]!.result;
      await session.restart('make people need re-import');
      await V.table('l', [['id', 'INTEGER'], ['k', 'INTEGER']], [[1, 1]]);
      await V.table('r', [['k', 'INTEGER']], [[1], [1], [2], [2]]);
      await datasets.registry.reconcile(); // the registry learns about the SQL-created tables
      V.faults.hold = /qv:statistics/;
      const run = V.start(Q);
      await V.waitFor(() => V.held.length === 1);
      const order: string[] = [];
      const imp = datasets.importer.import([{ file: D.file('extra.csv', data) }]).handles[0]!.result.then((x) => (order.push('import'), x.terminal.status));
      const rem = datasets.registry.remove('r').result.then((x) => (order.push('remove'), x.terminal.status));
      const re = datasets.registry.reimport('people').result.then((x) => (order.push('reimport'), x.terminal.status));
      const other = verdict.analyze(Q, []).result.then((x) => (order.push('second-verdict'), x.value!.status));
      V.faults.hold = null;
      V.held[0]!.release();
      const a = await run.done.then((x) => (order.unshift('first-verdict'), x));
      return { before: before.terminal.status, a, imp: await imp, rem: await rem, re: await re, other: await other, order };
    }, { Q, data: PEOPLE });
    expect(r.before).toBe('ok');
    expect(r.a.report).toMatchObject({ authoritative: true, status: 'analyzed' });
    expect(r.a.report.join?.derived?.outputRows).toBe('2');
    expect([r.imp, r.rem, r.re]).toEqual(['ok', 'ok', 'ok']);
    expect(r.order[0]).toBe('first-verdict');
    // The second analysis ran after the removal of r, so it fails to bind (r no longer exists).
    expect(r.other).toBe('query-failed');
  });

  test('a write INSIDE the lease (simulated defect) is detected: evidence withdrawn, not authoritative', async ({ page }) => {
    await open(page);
    await seed(page);
    const r = await page.evaluate(async (Q) => {
      const V = window.__qvHarness!.verdict!;
      const out: Record<string, unknown> = {};
      for (const [name, match] of [['before witness selection', /qv:witness-selection/], ['before the end fingerprint', /qv:fingerprint-end/], ['before the SEMI JOIN', /qv:semi-join-left/]] as const) {
        await V.exec('UPDATE l SET k = 1');
        V.faults.injectBefore = { match, sql: 'UPDATE l SET k = 2' };
        const a = await V.analyze(Q, [{ kind: 'no-fan-out', join: 0, side: 'left' }]);
        out[name] = { status: a.report.status, authoritative: a.report.authoritative, stats: a.report.join?.stats ?? null, witnesses: a.report.join?.witnesses ?? [], codes: a.report.findings.map((f) => f.code), outcomes: a.report.expectations.map((o) => o.outcome), validation: a.report.join?.validation };
      }
      // ROLLBACK undid the injected write too.
      const k = await V.sql(V.current().session, 'SELECT k::VARCHAR FROM l');
      return { out, k: k.rows, left: await V.leftovers(), tx: await V.noOpenTransaction() };
    }, Q);
    for (const v of Object.values(r.out) as { status: string; authoritative: boolean; stats: unknown; witnesses: unknown[]; codes: string[]; outcomes: string[] }[]) {
      expect(v).toMatchObject({ status: 'inconclusive', authoritative: false, stats: null, witnesses: [], outcomes: ['unchecked'] });
      expect(v.codes.some((c) => ['snapshot-inconsistent', 'witness-mismatch', 'semantic-mismatch'].includes(c))).toBe(true);
      expect(v.codes).not.toContain('join-cardinality');
    }
    expect((r.out['before the end fingerprint'] as { validation: { snapshot: string } }).validation.snapshot).toBe('changed');
    // Moving the left key from 1 to 2 keeps every count the SEMI JOIN and the executed count see
    // (1 left row, 2 right rows matched either way); only witness identity notices it.
    expect((r.out['before the SEMI JOIN'] as { validation: Record<string, string> }).validation).toMatchObject({ semiJoin: 'agreed', executedCount: 'agreed', witnesses: 'mismatch' });
    expect(r.k).toEqual([['1']]);
    expect([r.left, r.tx]).toEqual([[], true]);
  });

  test('count agreement alone is not identity: a write that keeps every total but changes a witness key is caught', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      await V.table('l', [['k', 'INTEGER']], [[1], [3]]);
      await V.table('r', [['k', 'INTEGER']], [[1], [5]]);
      // Unmatched left key 3 becomes 4 between witness selection and the witness recount: rows,
      // matched rows and output are unchanged; only the identity of the unmatched key differs.
      V.faults.injectBefore = { match: /qv:witness-inputs/, sql: 'UPDATE l SET k = 4 WHERE k = 3' };
      return V.analyze('SELECT * FROM l LEFT JOIN r ON l.k = r.k');
    });
    expect(r.report).toMatchObject({ status: 'inconclusive', authoritative: false });
    expect(r.report.findings[0]).toMatchObject({ code: 'witness-mismatch' });
    expect(r.report.findings[0]?.message).toMatch(/unmatched-left key \(3\)/);
  });

  test('volatile view, generated column, temporary-table shadowing and an attached database are refused or coherent', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      await V.table('base', [['k', 'INTEGER']], [[1], [2]]);
      await V.table('r', [['k', 'INTEGER']], [[1]]);
      await V.exec('CREATE OR REPLACE VIEW vv AS SELECT (random() * 2)::INTEGER AS k FROM base');
      await V.exec('CREATE OR REPLACE TABLE g (k INTEGER, v DOUBLE GENERATED ALWAYS AS (random()))', 'INSERT INTO g (k) VALUES (1)');
      await V.exec('CREATE TEMP TABLE base (k INTEGER)');
      const view = await V.analyze('SELECT * FROM vv JOIN r ON vv.k = r.k');
      const gen = await V.analyze('SELECT * FROM g JOIN r ON g.k = r.k');
      const shadow = await V.analyze('SELECT * FROM base JOIN r ON base.k = r.k');
      await V.exec("ATTACH ':memory:' AS other", 'CREATE TABLE other.main.r (k INTEGER)', 'USE other');
      const attached = await V.analyze('SELECT * FROM g JOIN r ON g.k = r.k');
      await V.exec('USE memory');
      return { view: view.report, gen: gen.report, shadow: shadow.report, attached: attached.report };
    });
    for (const [name, rep] of Object.entries(r)) {
      expect(rep.authoritative, name).toBe(false);
      expect(rep.join, name).toBeNull();
    }
    expect(r.view.findings[0]?.message).toMatch(/is a view/);
    expect(r.gen.findings[0]?.message).toMatch(/generated columns/);
    expect(r.shadow.findings[0]?.message).toMatch(/matches 2 catalog objects/);
    expect(['unsupported', 'query-failed']).toContain(r.attached.status);
  });

  test('an open user transaction refuses the analysis and leaves the transaction untouched (transaction-unavailable)', async ({ page }) => {
    await open(page);
    await seed(page);
    const r = await page.evaluate(async (Q) => {
      const V = window.__qvHarness!.verdict!;
      const s = V.current().session;
      await V.sql(s, 'BEGIN TRANSACTION');
      await V.sql(s, 'INSERT INTO l VALUES (2, 2)');
      const a = await V.analyze(Q, [{ kind: 'row-count', min: 0 }]);
      const inside = await V.sql(s, 'SELECT count(*)::VARCHAR FROM l');
      const commit = await V.sql(s, 'COMMIT');
      return { a, inside: inside.rows, commit: commit.terminal.status, after: (await V.sql(s, 'SELECT count(*)::VARCHAR FROM l')).rows };
    }, Q);
    expect(r.a.report).toMatchObject({ status: 'inconclusive', authoritative: false, join: null });
    expect(r.a.report.findings[0]).toMatchObject({ code: 'transaction-unavailable' });
    expect(r.a.statements.some((s) => s.includes('BEGIN'))).toBe(false);
    expect(r.a.statements.some((s) => s === 'ROLLBACK')).toBe(false);
    expect([r.inside, r.commit, r.after]).toEqual([[['2']], 'ok', [['2']]]);
  });

  // Each validation layer is the FIRST to see a particular injected change (so removing that layer is detectable).
  const layer = (page: Page, match: RegExp, sql: string) => page.evaluate(async ({ source, sql }) => {
    const V = window.__qvHarness!.verdict!;
    await V.table('l', [['k', 'INTEGER']], [[1], [2], [3]]);
    await V.table('r', [['k', 'INTEGER']], [[1], [2], [2]]);
    V.faults.injectBefore = { match: new RegExp(source), sql };
    const a = await V.analyze('SELECT * FROM l LEFT JOIN r ON l.k = r.k');
    return { status: a.report.status, authoritative: a.report.authoritative, code: a.report.findings[0]?.code, message: a.report.findings[0]?.message ?? '', validation: a.report.join?.validation, stats: a.report.join?.stats ?? null };
  }, { source: match.source, sql });

  test('layer: invariants catch a write between the two frequency tables', async ({ page }) => {
    await open(page);
    const r = await layer(page, /qv:frequencies-right/, 'INSERT INTO r VALUES (7)');
    expect(r).toMatchObject({ status: 'inconclusive', authoritative: false, code: 'invariant-violated', stats: null, validation: { invariants: 'violated' } });
  });

  test('layer: the SEMI JOIN recount catches a write after the statistics', async ({ page }) => {
    await open(page);
    const r = await layer(page, /qv:semi-join-left/, 'DELETE FROM l WHERE k = 1');
    expect(r).toMatchObject({ status: 'inconclusive', code: 'semantic-mismatch', stats: null, validation: { semiJoin: 'disagreed', executedCount: 'not-run' } });
  });

  test('layer: the executed count catches a write after the SEMI JOIN recounts', async ({ page }) => {
    await open(page);
    const r = await layer(page, /qv:executed-count/, 'INSERT INTO r VALUES (2)');
    expect(r).toMatchObject({ status: 'inconclusive', code: 'semantic-mismatch', stats: null, validation: { semiJoin: 'agreed', executedCount: 'disagreed' } });
  });

  test('layer: the table identity check catches a replaced table with identical data', async ({ page }) => {
    await open(page);
    const r = await layer(page, /qv:fingerprint-end/, 'CREATE OR REPLACE TABLE r AS SELECT * FROM r');
    expect(r).toMatchObject({ status: 'inconclusive', code: 'snapshot-inconsistent', stats: null, validation: { snapshot: 'changed' } });
    expect(r.message).toMatch(/identity of r/);
    expect(r.message).not.toMatch(/right input/); // the key multiset is unchanged: only identity sees it
  });
});
