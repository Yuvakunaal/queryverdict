// SQL correctness analysis engine: every number is checked three ways —
//   (1) the engine's frequency-formula result,
//   (2) an independent Python brute-force computation (scripts/make_analysis_fixtures.py),
//   (3) DuckDB's actual count(*) of the same joins.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openHarness } from './helpers';

type Table = { columns: [string, string][]; rows: (string | number | null)[][] };
interface Case {
  name: string;
  sql: string;
  tables: Record<string, Table>;
  expectations: unknown[];
  fromPrefixes: string[];
  mvpEligible: boolean;
  expected: {
    status: string;
    baseRows: number;
    joins: { index: number; type: string; stats: Record<string, number>; derived: Record<string, number | string> }[];
    joinCodes: string[][];
    afterWhere: number | null;
    final: number;
    outerRemoved: { join: number; side: string; before: number; removed: number }[];
    metric: { source: string | null; joined: string | null } | null;
    mustInclude: string[];
    mustExclude: string[];
  };
}
const FIX = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'analysis', 'cases.json'), 'utf8')) as { named: Case[]; random: Case[]; unsupported: { name: string; sql: string; tables: Record<string, Table> }[] };
const JOIN_CODES = ['join-cardinality', 'join-expansion', 'right-rows-repeated', 'unmatched-rows-dropped', 'null-join-keys', 'many-to-many-join'];
const OUTER_CODES = ['where-removes-null-extended-rows', 'where-filters-preserved-side', 'where-removes-outer-join-rows'];
/** Codes removed after Codex M1: aggregate attribution without measuring contributing rows. */
const FORBIDDEN_CODES = ['aggregate-over-fan-out', 'count-over-expanded-join', 'average-over-fan-out'];
const CATEGORIES = ['observed', 'suspicious', 'expectation-violation', 'expectation-unchecked', 'unsupported', 'inconclusive', 'diagnostic-failure', 'query-failure'];

function setupSql(tables: Record<string, Table>): string[] {
  const out: string[] = [];
  for (const [name, t] of Object.entries(tables)) {
    out.push(`DROP TABLE IF EXISTS "${name}"`, `CREATE TABLE "${name}" (${t.columns.map(([c, ty]) => `"${c}" ${ty}`).join(', ')})`);
    if (t.rows.length) {
      const lit = (v: unknown, ty: string) => (v === null ? 'NULL' : ty.startsWith('VARCHAR') ? `'${String(v).replaceAll("'", "''")}'` : String(v));
      out.push(`INSERT INTO "${name}" VALUES ${t.rows.map((r) => `(${r.map((v, i) => lit(v, t.columns[i]![1])).join(', ')})`).join(', ')}`);
    }
  }
  return out;
}

async function startSession(page: Page) {
  await openHarness(page);
  await page.evaluate(async () => {
    const H = window.__qvHarness!;
    const s = new H.EngineSession({ memoryLimit: null, cancelDeadlineMs: 5000 });
    await s.start();
    (window as unknown as { __s: unknown }).__s = s;
  });
}

async function runCase(page: Page, c: { sql: string; tables: Record<string, Table>; expectations?: unknown[]; fromPrefixes?: string[] }, scope: 'mvp' | 'experimental' = 'experimental', budget?: string) {
  return page.evaluate(async ({ setup, sql, expectations, prefixes, budget, scope }) => {
    const H = window.__qvHarness!;
    const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
    for (const q of setup) {
      const r = await s.run(q);
      if (r.status !== 'ok') throw new Error(`setup failed: ${q}: ${r.status === 'error' ? r.error : r.status}`);
    }
    const report = await H.analyzeInSession(s, sql, expectations as never, { scope, ...(budget ? { executionBudgetRows: BigInt(budget) } : {}) });
    const actual: string[] = [];
    for (const p of prefixes) {
      const r = await s.run(`SELECT count(*)::VARCHAR FROM ${p}`);
      actual.push(r.status === 'ok' ? r.result.rows[0]![0]! : `ERR ${r.status === 'error' ? r.error : r.status}`);
    }
    const fin = await s.run(`SELECT count(*)::VARCHAR FROM (${sql})`);
    return { report: JSON.parse(JSON.stringify(report)), actualIntermediates: actual, actualFinal: fin.status === 'ok' ? fin.result.rows[0]![0]! : null };
  }, { setup: setupSql(c.tables), sql: c.sql, expectations: c.expectations ?? [], prefixes: c.fromPrefixes ?? [], budget, scope });
}

function checkCase(c: Case, out: Awaited<ReturnType<typeof runCase>>): string[] {
  const errs: string[] = [];
  const r = out.report;
  const e = c.expected;
  if (r.status !== 'analyzed') errs.push(`status ${r.status} (${r.findings.filter((f: { category: string }) => f.category !== 'observed').map((f: { message: string }) => f.message).join(' | ')})`);
  // every join validated; no negative numbers anywhere; one outcome per expectation
  for (const j of r.joins) {
    if (j.validation.invariants !== 'held' || j.validation.semiJoin !== 'agreed' || j.validation.executedCount !== 'agreed') errs.push(`join ${j.index} validation ${JSON.stringify(j.validation)}`);
    for (const [k, v] of Object.entries({ ...(j.stats ?? {}), ...(j.derived ?? {}) })) if (/^-\d/.test(String(v))) errs.push(`join ${j.index} ${k} negative: ${v}`);
  }
  if (r.expectations.length !== c.expectations.length) errs.push(`expectation outcomes ${r.expectations.length} vs ${c.expectations.length}`);
  if (r.joins.length !== e.joins.length) errs.push(`join count ${r.joins.length} vs ${e.joins.length}`);
  e.joins.forEach((ej, i) => {
    const rj = r.joins[i];
    if (!rj) return;
    for (const [k, v] of Object.entries(ej.stats)) if (rj.stats[k] !== String(v)) errs.push(`join ${i} ${k}: engine ${rj.stats[k]} vs python ${v}`);
    for (const [k, v] of Object.entries(ej.derived)) if (String(rj.derived[k]) !== String(v)) errs.push(`join ${i} ${k}: engine ${rj.derived[k]} vs python ${v}`);
    // DuckDB actual count of the join prefix (when available)
    const act = out.actualIntermediates[i];
    if (act !== undefined && act !== String(ej.derived.outputRows)) errs.push(`join ${i} output: DuckDB ${act} vs python ${ej.derived.outputRows}`);
    const codes = new Set(r.findings.filter((f: { join?: number }) => f.join === i).map((f: { code: string }) => f.code).filter((x: string) => JOIN_CODES.includes(x)));
    const want = new Set(e.joinCodes[i]);
    if ([...codes].sort().join() !== [...want].sort().join()) errs.push(`join ${i} observed codes ${[...codes].sort()} vs expected ${[...want].sort()}`);
  });
  const stage = (name: string) => r.stages.find((s: { stage: string }) => s.stage === name)?.rows;
  if (e.afterWhere !== null && stage('after WHERE') !== String(e.afterWhere)) errs.push(`after WHERE ${stage('after WHERE')} vs ${e.afterWhere}`);
  if (stage('final result') !== String(e.final)) errs.push(`final ${stage('final result')} vs python ${e.final}`);
  if (out.actualFinal !== String(e.final)) errs.push(`final: DuckDB ${out.actualFinal} vs python ${e.final}`);
  for (const o of e.outerRemoved) {
    const f = r.findings.find((x: { code: string; join?: number; evidence?: { preservedSide?: string } }) => OUTER_CODES.includes(x.code) && x.join === o.join && x.evidence?.preservedSide === o.side);
    if (o.removed > 0 && (!f || f.evidence.removedByWhere !== String(o.removed))) errs.push(`outer/WHERE join ${o.join} ${o.side}: expected removed ${o.removed}, got ${f?.evidence?.removedByWhere ?? 'no finding'}`);
    if (o.removed === 0 && f) errs.push(`outer/WHERE join ${o.join} ${o.side}: unexpected finding`);
  }
  if (e.metric && c.expectations.some((x) => (x as { kind: string }).kind === 'metric-preserved')) {
    const v = r.findings.find((x: { code: string }) => x.code === 'metric-preserved-violated');
    const equal = e.metric.source === e.metric.joined || (e.metric.source !== null && e.metric.joined !== null && Number(e.metric.source) === Number(e.metric.joined));
    if (equal && v) errs.push(`metric: unexpected violation ${v.message}`);
    if (!equal) {
      if (!v) errs.push('metric: expected a violation');
      else if (Number(v.evidence.sourceTotal) !== Number(e.metric.source) || Number(v.evidence.joinedTotal) !== Number(e.metric.joined)) errs.push(`metric totals engine ${v.evidence.sourceTotal}/${v.evidence.joinedTotal} vs python ${e.metric.source}/${e.metric.joined}`);
    }
  }
  const codes = new Set(r.findings.map((f: { code: string }) => f.code));
  for (const m of e.mustInclude) if (!codes.has(m)) errs.push(`missing finding ${m}`);
  for (const m of e.mustExclude) if (codes.has(m)) errs.push(`unexpected finding ${m}`);
  if (r.findings.some((f: { category: string }) => !CATEGORIES.includes(f.category))) errs.push('unknown finding category');
  for (const fc of FORBIDDEN_CODES) if (codes.has(fc)) errs.push(`forbidden finding ${fc}`);
  if (r.authoritative) errs.push('experimental report marked authoritative');
  return errs;
}

test('named cases: engine = independent Python brute force = DuckDB actual counts', async ({ page }) => {
  test.setTimeout(300_000);
  await startSession(page);
  const failures: string[] = [];
  for (const c of FIX.named) {
    const errs = checkCase(c, await runCase(page, c));
    if (errs.length) failures.push(`${c.name}: ${errs.join('; ')}`);
  }
  expect(failures).toEqual([]);
  test.info().annotations.push({ type: 'cases', description: `${FIX.named.length} named cases` });
});

test('200 seeded random cases (1–3 tables, all join types, composite and NULL keys, WHERE): engine = Python = DuckDB', async ({ page }) => {
  test.setTimeout(600_000);
  await startSession(page);
  const failures: string[] = [];
  for (const c of FIX.random) {
    const errs = checkCase(c, await runCase(page, c));
    if (errs.length) failures.push(`${c.name} [${c.sql}]: ${errs.join('; ')}`);
  }
  expect(failures.slice(0, 10)).toEqual([]);
  test.info().annotations.push({ type: 'cases', description: `${FIX.random.length} random cases` });
});

test('unsupported constructs produce UNSUPPORTED and no data conclusions', async ({ page }) => {
  await startSession(page);
  const failures: string[] = [];
  for (const c of FIX.unsupported) {
    const { report } = await runCase(page, { sql: c.sql, tables: c.tables });
    if (report.status !== 'unsupported') failures.push(`${c.name}: status ${report.status}`);
    if (report.findings.some((f: { category: string }) => f.category !== 'unsupported')) failures.push(`${c.name}: non-unsupported findings`);
    if (report.joins.length || report.stages.length) failures.push(`${c.name}: produced data results`);
    if (!report.findings.length) failures.push(`${c.name}: no explanation`);
  }
  expect(failures).toEqual([]);
});

test('key type mismatch is inconclusive; user-query failures are reported as such', async ({ page }) => {
  await startSession(page);
  const tables = {
    a: { columns: [['k', 'INTEGER']], rows: [[1], [2]] },
    b: { columns: [['k', 'VARCHAR'], ['k64', 'BIGINT']], rows: [['1', 1], ['x', 2]] },
  } as unknown as Record<string, Table>;
  const mismatch = (await runCase(page, { sql: 'SELECT * FROM a JOIN b ON a.k = b.k64', tables })).report;
  expect(mismatch.status).toBe('partially-analyzed');
  expect(mismatch.findings.map((f: { code: string }) => f.code)).toContain('join-key-type-mismatch');
  expect(mismatch.joins.every((j: { stats: unknown }) => j.stats === null)).toBe(true);
  expect(mismatch.stages).toEqual([]);
  const missing = (await runCase(page, { sql: 'SELECT * FROM a JOIN nope ON a.k = nope.k', tables })).report;
  expect([missing.status, missing.findings[0].category, missing.findings[0].code]).toEqual(['query-failed', 'query-failure', 'bind-failed']);
  const syntax = (await runCase(page, { sql: 'SELEC * FROM a', tables })).report;
  expect([syntax.status, syntax.findings[0].category, syntax.findings[0].code]).toEqual(['query-failed', 'query-failure', 'syntax-error']);
});

test('unsupported constructs are also refused in MVP scope', async ({ page }) => {
  await startSession(page);
  for (const c of FIX.unsupported) {
    const { report } = await runCase(page, { sql: c.sql, tables: c.tables }, 'mvp');
    expect([c.name, report.status, report.authoritative]).toEqual([c.name, 'unsupported', false]);
  }
});

test('MVP scope: eligible cases are authoritative and match the oracle; everything else is refused', async ({ page }) => {
  test.setTimeout(600_000);
  await startSession(page);
  const failures: string[] = [];
  let eligible = 0;
  const MVP_KINDS = ['relationship', 'no-row-loss', 'no-fan-out', 'row-count'];
  const OUT_OF_SCOPE_CODES = ['grain-violated', 'metric-preserved-violated'];
  for (const c0 of [...FIX.named, ...FIX.random]) {
    // Out-of-scope expectation kinds are asserted to be 'unchecked' in analysis-review.spec.ts (H4).
    const c = { ...c0, expectations: c0.expectations.filter((x) => MVP_KINDS.includes((x as { kind: string }).kind)) };
    const out = await runCase(page, c, 'mvp');
    const r = out.report;
    if (c.mvpEligible) {
      eligible++;
      const expected = { ...c.expected, afterWhere: null, metric: null, mustInclude: c.expected.mustInclude.filter((m) => !OUT_OF_SCOPE_CODES.includes(m)) };
      const errs = checkCase({ ...c, expected }, out).filter((e) => !e.startsWith('experimental report marked authoritative'));
      if (!r.authoritative) errs.push(`not authoritative (status ${r.status})`);
      if (r.scope !== 'mvp') errs.push('scope');
      if (errs.length) failures.push(`${c.name}: ${errs.join('; ')}`);
    } else {
      if (r.status !== 'unsupported' || r.authoritative || r.joins.length || r.stages.length) failures.push(`${c.name} [${c.sql}]: expected unsupported in MVP scope, got ${r.status}`);
      // A refusal draws no data conclusion: only 'unsupported' findings, plus exactly one
      // 'unchecked' outcome (and its expectation-unchecked finding) per declared expectation.
      const cats = r.findings.map((f: { category: string }) => f.category);
      if (!cats.includes('unsupported') || cats.some((x: string) => x !== 'unsupported' && x !== 'expectation-unchecked')) failures.push(`${c.name}: findings other than unsupported in MVP refusal`);
      if (cats.filter((x: string) => x === 'expectation-unchecked').length !== c.expectations.length) failures.push(`${c.name}: expectation-unchecked findings do not match the declared expectations`);
      if (r.expectations.length !== c.expectations.length || r.expectations.some((o: { outcome: string; index: number }, i: number) => o.outcome !== 'unchecked' || o.index !== i)) failures.push(`${c.name}: refusal must give one unchecked outcome per expectation`);
    }
  }
  expect(failures.slice(0, 10)).toEqual([]);
  expect(eligible).toBe(70);
});
