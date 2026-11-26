// Adversarial Verdict tests through the real service (TESTING_STRATEGY §5.4; acceptance M08 field
// 17b and 17e; T-ENG-007a/b, T-ENG-015): every refusal is unsupported, inconclusive or a query
// failure with a reason and no authoritative evidence; every early exit still returns exactly one
// outcome per expectation; nothing leaves the page.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { captureRequests, HARNESS } from './helpers';

const CASES = JSON.parse(readFileSync(path.resolve('tests/fixtures/verdict/parser-cases.json'), 'utf8')) as Record<'accept' | 'refuse' | 'failure', Record<string, string>>;

async function open(page: Page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__qvHarness?.verdict !== undefined);
  await page.evaluate(async () => {
    const V = window.__qvHarness!.verdict!;
    await V.setup();
    const cols = [['k', 'INTEGER'], ['k1', 'INTEGER'], ['k2', 'INTEGER'], ['s', 'VARCHAR']] as [string, string][];
    for (const t of ['a', 'b', 'c']) await V.table(t, cols, [[1, 1, 1, 'x'], [2, 1, 2, 'y']]);
  });
}
// Five declarations: three valid, two invalid (T-ENG-007a).
const FIVE = [{ kind: 'relationship', join: 0, expected: 'one-to-one' }, { kind: 'grain', columns: ['k'] }, { kind: 'no-row-loss', join: 0, side: 'left' }, null, { kind: 'row-count', min: 0, max: 10 }];

test.describe('Verdict adversarial (real engine)', () => {
  test('refusal corpus: every excluded construct is unsupported or a query failure, never authoritative, with no data probe run', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async ({ refuse, failure, FIVE }) => {
      const V = window.__qvHarness!.verdict!;
      const out: { name: string; status: string; authoritative: boolean; join: unknown; reason: string; outcomes: string[]; probes: number; identity: boolean }[] = [];
      for (const [name, sql] of [...Object.entries(refuse), ...Object.entries(failure)]) {
        const declared = FIVE.slice();
        const h = V.current().verdict.analyze(sql, declared);
        const from = V.statementLog.length;
        const res = await h.result;
        const rep = res.value!;
        out.push({
          name, status: rep.status, authoritative: rep.authoritative, join: rep.join,
          reason: rep.findings.find((f) => ['unsupported', 'query-failure', 'inconclusive', 'diagnostic-failure'].includes(f.category))?.message ?? '',
          outcomes: rep.expectations.map((o) => o.outcome), identity: rep.expectations.every((o, i) => o.index === i && o.expectation === declared[i]),
          probes: V.statementLog.slice(from).filter((s) => /qv:(input-rows|fingerprint-start|frequencies-left|frequencies-right|statistics|semi-join-left|semi-join-right|executed-count|witness-join)/.test(s)).length,
        });
      }
      return { out, left: await V.leftovers(), tx: await V.noOpenTransaction() };
    }, { refuse: CASES.refuse, failure: CASES.failure, FIVE });
    expect(r.out.length).toBe(Object.keys(CASES.refuse).length + Object.keys(CASES.failure).length);
    for (const c of r.out) {
      expect(['unsupported', 'query-failed'], c.name).toContain(c.status);
      expect(c.authoritative, c.name).toBe(false);
      expect(c.join, c.name).toBeNull();
      expect(c.reason.length, c.name).toBeGreaterThan(10);
      expect(c.outcomes, c.name).toEqual(['unchecked', 'unchecked', 'unchecked', 'unchecked', 'unchecked']);
      expect(c.identity, c.name).toBe(true);
      expect(c.probes, c.name).toBe(0);
    }
    expect(r.out.find((c) => c.name === 'syntax_error')?.status).toBe('query-failed');
    expect(r.out.find((c) => c.name === 'not_select')?.status).toBe('unsupported');
    expect([r.left, r.tx]).toEqual([[], true]);
  });

  test('accepted shapes reach analysis (not refused by the recogniser)', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      const qs = ['SELECT * FROM a JOIN b ON a.k = b.k', 'SELECT a.*, b.k FROM a LEFT OUTER JOIN b USING (k1, k2)', 'SELECT * FROM a JOIN b ON b.k = a.k AND a.k1 = b.k1;', 'FROM a JOIN b ON a.k = b.k SELECT *'];
      const out = [];
      for (const q of qs) out.push((await V.analyze(q)).report.status);
      return out;
    });
    expect(r).toEqual(['analyzed', 'analyzed', 'analyzed', 'analyzed']);
  });

  test('relation, key and binding refusals (catalog-level)', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async (FIVE) => {
      const V = window.__qvHarness!.verdict!;
      await V.exec('CREATE OR REPLACE VIEW v AS SELECT * FROM b', 'CREATE OR REPLACE TABLE big (k BIGINT)', 'CREATE OR REPLACE TABLE txt (s VARCHAR COLLATE NOCASE)', 'CREATE OR REPLACE TABLE txt2 (s VARCHAR)');
      const cases: [string, string][] = [
        ['view', 'SELECT * FROM a JOIN v ON a.k = v.k'],
        ['file reference', "SELECT * FROM a JOIN 'data.csv' f ON a.k = f.k"],
        ['missing table', 'SELECT * FROM a JOIN nope ON a.k = nope.k'],
        ['mixed integer types', 'SELECT * FROM a JOIN big ON a.k = big.k'],
        ['text keys', 'SELECT * FROM a JOIN b ON a.s = b.s'],
        ['collated text keys', 'SELECT * FROM txt2 JOIN txt ON txt2.s = txt.s'],
        ['same-side equality', 'SELECT * FROM a JOIN b ON a.k = a.k1'],
        ['ambiguous unqualified key', 'SELECT * FROM a JOIN b ON k = k1'],
        ['self-join without aliases', 'SELECT * FROM a JOIN a ON a.k = a.k'],
        ['unknown column', 'SELECT * FROM a JOIN b ON a.zzz = b.k'],
      ];
      const out: Record<string, { status: string; authoritative: boolean; message: string; outcomes: number; probes: number }> = {};
      for (const [name, q] of cases) {
        const x = await V.analyze(q, FIVE);
        out[name] = { status: x.report.status, authoritative: x.report.authoritative, message: x.report.findings[0]?.message ?? '', outcomes: x.report.expectations.length, probes: x.statements.filter((s) => /qv:(frequencies|executed-count|witness-join|statistics)/.test(s)).length };
      }
      return { out, left: await V.leftovers(), tx: await V.noOpenTransaction() };
    }, FIVE);
    const expectStatus: Record<string, [string, RegExp]> = {
      view: ['unsupported', /is a view/],
      'file reference': ['query-failed', /./],
      'missing table': ['query-failed', /cannot be bound/],
      'mixed integer types': ['unsupported', /key types differ/],
      'text keys': ['unsupported', /only same-type integer keys/],
      'collated text keys': ['unsupported', /only same-type integer keys/],
      'same-side equality': ['unsupported', /same input/],
      'ambiguous unqualified key': ['query-failed', /./],
      'self-join without aliases': ['query-failed', /./],
      'unknown column': ['query-failed', /./],
    };
    for (const [name, v] of Object.entries(r.out)) {
      const [status, msg] = expectStatus[name]!;
      expect([name, v.status], name).toEqual([name, status]);
      expect(v.message, name).toMatch(msg);
      expect(v.authoritative, name).toBe(false);
      expect([v.outcomes, v.probes], name).toEqual([5, 0]);
    }
    expect([r.left, r.tx]).toEqual([[], true]);
  });

  test('early exits after analysis started still give exactly one outcome per declaration, in order (T-ENG-007a/b)', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async (FIVE) => {
      const V = window.__qvHarness!.verdict!;
      const out: Record<string, { outcomes: string[]; identity: boolean; status: string }> = {};
      const record = (name: string, rep: { status: string; expectations: readonly { index: number; outcome: string; expectation: unknown }[] }, declared: unknown[]) => {
        out[name] = { status: rep.status, outcomes: rep.expectations.map((o) => o.outcome), identity: rep.expectations.length === declared.length && rep.expectations.every((o, i) => o.index === i && o.expectation === declared[i]) };
      };
      const go = async (name: string, prep: () => void | Promise<void>, q = 'SELECT * FROM a JOIN b ON a.k = b.k') => {
        await prep();
        const declared = FIVE.slice();
        const run = V.start(q, declared);
        if (name === 'cancelled') {
          await V.waitFor(() => V.held.length === 1);
          run.handle.cancel();
          V.faults.hold = null;
        }
        if (name === 'stale (restart)') {
          await V.waitFor(() => V.held.length === 1);
          V.faults.hold = null;
          await V.current().session.restart('test');
          await V.setup();
          for (const t of ['a', 'b']) await V.table(t, [['k', 'INTEGER']], [[1]]);
        }
        record(name, (await run.done).report, declared);
        V.faults.hold = null;
      };
      await go('complete analysis (invalid ones unchecked)', () => undefined);
      await go('cancelled', () => void (V.faults.hold = /qv:statistics/));
      await go('stale (restart)', () => void (V.faults.hold = /qv:statistics/));
      await go('snapshot inconsistent', () => void (V.faults.injectBefore = { match: /qv:fingerprint-end/, sql: 'INSERT INTO a (k) VALUES (9)' }));
      await go('diagnostic failure', () => void (V.faults.injectBefore = { match: /qv:statistics/, sql: 'SELECT * FROM table_that_does_not_exist' }));
      return out;
    }, FIVE);
    expect(r['complete analysis (invalid ones unchecked)']).toEqual({ status: 'partially-analyzed', outcomes: ['held', 'unchecked', 'held', 'unchecked', 'held'], identity: true });
    expect(r['diagnostic failure']?.status).toBe('diagnostic-failed');
    expect(r['snapshot inconsistent']?.status).toBe('inconclusive');
    expect(r.cancelled?.status).toBe('cancelled');
    expect(r['stale (restart)']?.status).toBe('stale');
    for (const [name, v] of Object.entries(r)) {
      expect(v.identity, name).toBe(true);
      expect(v.outcomes.length, name).toBe(5);
      if (name !== 'complete analysis (invalid ones unchecked)') expect(v.outcomes, name).toEqual(['unchecked', 'unchecked', 'unchecked', 'unchecked', 'unchecked']);
    }
  });

  test('hostile identifiers and values stay data: quoted names with dots, quotes, spaces and HTML; keys beyond 2^53', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      await V.table('<img src=x onerror=alert(1)>', [['k "1".x', 'UBIGINT']], [['18446744073709551615'], ['9007199254740993'], ['9007199254740992']]);
      await V.table('select', [['from', 'UBIGINT']], [['9007199254740993'], ['9007199254740993']]);
      return V.analyze('SELECT * FROM "<img src=x onerror=alert(1)>" AS "a.b c" LEFT JOIN "select" AS "w""x" ON "a.b c"."k ""1"".x" = "w""x"."from"');
    });
    expect(r.report).toMatchObject({ status: 'analyzed', authoritative: true });
    expect(r.report.identity.inputs.map((i) => i.relation)).toEqual(['<img src=x onerror=alert(1)>', 'select']);
    expect(r.report.join?.keys).toEqual([{ left: 'k "1".x', right: 'from', type: 'UBIGINT' }]);
    expect(r.report.join?.witnesses).toEqual([
      { kind: 'fan-out', key: ['9007199254740993'], leftRows: '1', rightRows: '2', outputRows: '2' },
      { kind: 'unmatched-left', key: ['9007199254740992'], leftRows: '1', rightRows: '0', outputRows: '1' },
      { kind: 'unmatched-left', key: ['18446744073709551615'], leftRows: '1', rightRows: '0', outputRows: '1' },
    ]);
  });

  test('Verdict makes no request outside the page origin and sends no data anywhere', async ({ page, context }) => {
    const requests = captureRequests(context);
    await open(page);
    const before = requests.length;
    const r = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      await V.table('canary_left', [['k', 'BIGINT']], [['424242424242'], ['424242424242']]);
      await V.table('canary_right', [['k', 'BIGINT']], [['424242424242']]);
      const a = await V.analyze('SELECT * FROM canary_left JOIN canary_right ON canary_left.k = canary_right.k');
      const s = V.start('SELECT * FROM canary_left JOIN canary_right ON canary_left.k = canary_right.k');
      s.handle.cancel();
      await s.done;
      await V.current().session.restart('test');
      return a.report.status;
    });
    expect(r).toBe('analyzed');
    const during = requests.slice(before).map((q) => q.url());
    const origin = new URL(HARNESS).origin;
    expect(during.filter((u) => !u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
    expect(during.filter((u) => /canary|424242/.test(u))).toEqual([]);
  });
});
