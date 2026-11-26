// Verdict correctness against two independent sources (TESTING_STRATEGY §5.1; P-030; acceptance
// M08 field 17a): every case's report is compared field by field with the brute-force Python
// oracle (tests/oracle/oracle.py via tests/fixtures/verdict/cases.json) and its output row count
// with DuckDB's own count of the same query, run as ordinary SQL outside Verdict.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HARNESS } from './helpers';

interface Case {
  name: string;
  sql: string;
  tables: Record<string, { columns: [string, string][]; rows: (string | null)[][] }>;
  expectations: unknown[];
  expected: { status: string; authoritative: boolean; stats: Record<string, string>; derived: Record<string, string>; witnesses: unknown[]; findingCodes: string[]; expectationOutcomes: string[] };
}
const CASES = (JSON.parse(readFileSync(path.resolve('tests/fixtures/verdict/cases.json'), 'utf8')) as { cases: Case[] }).cases;
const CHUNK = 16;

async function open(page: Page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__qvHarness?.verdict !== undefined);
  await page.evaluate(() => window.__qvHarness!.verdict!.setup());
}

function runCases(page: Page, cases: Case[]) {
  return page.evaluate(async (cases) => {
    const V = window.__qvHarness!.verdict!;
    const problems: string[] = [];
    for (const c of cases) {
      for (const [name, t] of Object.entries(c.tables)) await V.table(name, t.columns, t.rows);
      const { report } = await V.analyze(c.sql, c.expectations);
      const e = c.expected;
      const bad = (what: string, got: unknown, want: unknown) => {
        if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${c.name}: ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      };
      bad('status', report.status, e.status);
      bad('authoritative', report.authoritative, e.authoritative);
      bad('stats', report.join?.stats, e.stats);
      bad('derived', report.join?.derived, e.derived);
      bad('witnesses', report.join?.witnesses, e.witnesses);
      bad('validation', report.join && [report.join.validation.invariants, report.join.validation.semiJoin, report.join.validation.executedCount, report.join.validation.witnesses, report.join.validation.snapshot], ['held', 'agreed', 'agreed', 'verified', 'verified']);
      bad('finding codes', report.findings.map((f) => f.code).sort(), [...e.findingCodes].sort());
      bad('expectation outcomes', report.expectations.map((o) => o.outcome), e.expectationOutcomes);
      bad('expectation identity', report.expectations.map((o) => o.index), c.expectations.map((_, i) => i));
      // DuckDB's own answer, through ordinary SQL (not Verdict).
      const direct = await V.sql(V.current().session, `SELECT count(*)::VARCHAR FROM (${c.sql})`);
      bad('DuckDB count(*)', direct.rows?.[0]?.[0], e.derived.outputRows);
    }
    return { problems, leftovers: await V.leftovers(), noTx: await V.noOpenTransaction() };
  }, cases);
}

test.describe('Verdict oracle sweep (oracle + DuckDB)', () => {
  test.setTimeout(120_000);
  for (let i = 0; i < CASES.length; i += CHUNK) {
    const chunk = CASES.slice(i, i + CHUNK);
    test(`cases ${i + 1}–${i + chunk.length} (${chunk[0]!.name} … ${chunk.at(-1)!.name})`, async ({ page }) => {
      await open(page);
      const r = await runCases(page, chunk);
      expect(r.problems).toEqual([]);
      expect(r.leftovers).toEqual([]);
      expect(r.noTx).toBe(true);
    });
  }
  test('the corpus covers the required shapes', () => {
    const names = CASES.map((c) => c.name);
    for (const required of ['one_to_one', 'one_to_many_legitimate', 'many_to_one', 'many_to_many', 'composite_partial_nulls', 'all_null_keys', 'empty_left_inner', 'empty_right_left', 'both_empty',
      'offsetting_fan_out_and_loss', 'skewed_key', 'bigint_beyond_2_53', 'hugeint_extremes', 'uhugeint_max', 'quoted_identifiers', 'using_join', 'self_join_aliases', 'row_count_boundaries']) {
      expect(names).toContain(required);
    }
    expect(CASES.length).toBeGreaterThanOrEqual(150);
  });
});
