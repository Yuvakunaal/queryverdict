// Regression tests for the Codex Step 4.4 review of the SQL analysis engine (H1–H4, M1–M3).
// Each test reproduces the reported scenario on small deterministic tables and checks the exact
// diagnostic category and evidence, comparing against direct DuckDB queries where relevant.
import { expect, test, type Page } from '@playwright/test';
import { openHarness } from './helpers';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function start(page: Page) {
  await openHarness(page);
  await page.evaluate(async () => {
    const H = window.__qvHarness!;
    const s = new H.EngineSession({ memoryLimit: '1GB', cancelDeadlineMs: 2000 });
    await s.start();
    (window as unknown as { __s: unknown }).__s = s;
  });
}

/** Runs setup SQL, then analyze(); returns the report plus direct DuckDB results for `direct` queries. */
async function analyse(page: Page, setup: string[], sql: string, opts: { scope?: string; expectations?: unknown[]; options?: Record<string, string | number>; direct?: string[]; deadlineMs?: number; inject?: string } = {}) {
  return page.evaluate(async ({ setup, sql, opts }) => {
    const H = window.__qvHarness!;
    const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
    for (const q of setup) {
      const r = await s.run(q);
      if (r.status !== 'ok') throw new Error(`setup ${q}: ${r.status === 'error' ? r.error : r.status}`);
    }
    // Optional fault injection: fail the first diagnostic statement matching a marker.
    let injected = false;
    const testHooks = opts.inject ? {
      beforeStatement: (q: string) => {
        if (!injected && q.includes(opts.inject!.split('|')[1]!)) {
          injected = true;
          throw opts.inject!.startsWith('budget') ? new H.BudgetExhaustedError('injected deadline') : new H.DiagnosticError('engine', 'injected diagnostic failure');
        }
      },
    } : undefined;
    const options: Record<string, unknown> = { scope: opts.scope ?? 'experimental', deadlineMs: opts.deadlineMs ?? 30_000, testHooks };
    for (const [k, v] of Object.entries(opts.options ?? {})) options[k] = typeof v === 'string' ? BigInt(v) : v;
    const report = await H.analyzeInSession(s, sql, (opts.expectations ?? []) as never, options);
    const direct: (string[][] | string)[] = [];
    for (const d of opts.direct ?? []) {
      const r = await s.run(d);
      direct.push(r.status === 'ok' ? r.result.rows : `ERR ${r.status === 'error' ? r.error : r.status}`);
    }
    const temps = await s.run("SELECT count(*)::VARCHAR FROM duckdb_tables() WHERE table_name LIKE '__qv_%'");
    const alive = await s.run('SELECT 1');
    return { report: JSON.parse(JSON.stringify(report)), direct, tempTablesLeft: temps.status === 'ok' ? temps.result.rows[0]![0] : 'ERR', sessionUsable: alive.status === 'ok', state: s.state };
  }, { setup, sql, opts });
}

const codes = (r: R) => r.findings.map((f: R) => f.code);
const noNegatives = (r: R) => JSON.stringify(r.joins).match(/"-\d/) === null;

// ---------------------------------------------------------------- H1 numeric precision

test('H1: BIGINT, HUGEINT and DECIMAL literals survive rewriting exactly; stages equal DuckDB', async ({ page }) => {
  await start(page);
  const setup = [
    'CREATE OR REPLACE TABLE h1a (k BIGINT)', 'INSERT INTO h1a VALUES (9007199254740992), (9007199254740992), (9007199254740993)',
    'CREATE OR REPLACE TABLE h1b (k BIGINT)', 'INSERT INTO h1b VALUES (9007199254740992), (9007199254740993)',
    'CREATE OR REPLACE TABLE h1h (k INTEGER, v HUGEINT)', 'INSERT INTO h1h VALUES (1, 170141183460469231731687303715884105727), (1, 170141183460469231731687303715884105726)',
    'CREATE OR REPLACE TABLE h1d (k INTEGER, m DECIMAL(38,10))', 'INSERT INTO h1d VALUES (1, 12345678901234567890.1234567891), (1, 12345678901234567890.1234567892)',
  ];
  const big = 'SELECT * FROM h1a JOIN h1b ON h1a.k = h1b.k WHERE h1a.k = 9007199254740993';
  const r1 = await analyse(page, setup, big, { direct: [`SELECT count(*)::VARCHAR FROM (${big})`, 'SELECT count(*)::VARCHAR FROM h1a JOIN h1b ON h1a.k = h1b.k WHERE h1a.k = 9007199254740992'] });
  const stage = (r: R, n: string) => r.stages.find((s: R) => s.stage === n)?.rows;
  expect(r1.direct).toEqual([[['1']], [['2']]]); // the wrong literal would give 2
  expect(stage(r1.report, 'after WHERE')).toBe('1');
  expect(stage(r1.report, 'final result')).toBe('1');
  const whereSql = r1.report.diagnosticSql.filter((q: string) => q.includes('9007199254740993') && q.startsWith('SELECT count(*)'));
  expect(whereSql.length).toBeGreaterThan(0);
  expect(r1.report.diagnosticSql.some((q: string) => q.startsWith('SELECT count(*)') && q.includes('= 9007199254740992'))).toBe(false);

  const hu = 'SELECT * FROM h1h a JOIN h1h b ON a.k = b.k WHERE a.v = 170141183460469231731687303715884105727';
  const r2 = await analyse(page, [], hu, { direct: [`SELECT count(*)::VARCHAR FROM (${hu})`] });
  expect(stage(r2.report, 'after WHERE')).toBe(r2.direct[0]![0]![0]);
  expect(stage(r2.report, 'after WHERE')).toBe('2');

  const dec = 'SELECT * FROM h1d a JOIN h1d b ON a.k = b.k WHERE a.m = 12345678901234567890.1234567891';
  const r3 = await analyse(page, [], dec, { direct: [`SELECT count(*)::VARCHAR FROM (${dec})`] , expectations: [{ kind: 'metric-preserved', column: 'a.m' }] });
  expect(stage(r3.report, 'after WHERE')).toBe(r3.direct[0]![0]![0]);
  const m = r3.report.expectations[0];
  expect(m.outcome).toBe('violated'); // joined rows double the filtered source row
  expect(m.evidence.sourceTotal).toBe('12345678901234567890.1234567891');
  expect(m.evidence.joinedTotal).toBe('24691357802469135780.2469135782');
});

test('H1: large BIGINT key values in MVP scope match DuckDB exactly', async ({ page }) => {
  await start(page);
  const r = await analyse(page, [
    'CREATE OR REPLACE TABLE bk1 (k BIGINT)', 'INSERT INTO bk1 VALUES (9223372036854775807), (9223372036854775806), (9007199254740993), (NULL)',
    'CREATE OR REPLACE TABLE bk2 (k BIGINT)', 'INSERT INTO bk2 VALUES (9223372036854775807), (9223372036854775807), (9007199254740992)',
  ], 'SELECT * FROM bk1 LEFT JOIN bk2 ON bk1.k = bk2.k', { scope: 'mvp', direct: ['SELECT count(*)::VARCHAR FROM bk1 LEFT JOIN bk2 ON bk1.k = bk2.k', 'SELECT count(*)::VARCHAR FROM bk1 SEMI JOIN bk2 ON bk1.k = bk2.k'] });
  expect(r.report.authoritative).toBe(true);
  expect(r.report.joins[0].derived.outputRows).toBe(r.direct[0]![0]![0]);
  expect(r.report.joins[0].stats.leftRowsMatched).toBe(r.direct[1]![0]![0]);
  expect(r.report.joins[0].samples.fanOutKeys[0][0]).toBe('9223372036854775807');
});

// ---------------------------------------------------------------- H2 collation / impossible statistics

test('H2: VARCHAR vs VARCHAR COLLATE NOCASE (Codex repro) is inconclusive with no impossible numbers; MVP refuses it', async ({ page }) => {
  await start(page);
  const setup = ['CREATE OR REPLACE TABLE h2a (k VARCHAR)', "INSERT INTO h2a VALUES ('A'), ('a')", 'CREATE OR REPLACE TABLE h2b (k VARCHAR COLLATE NOCASE)', "INSERT INTO h2b VALUES ('a')"];
  const sql = 'SELECT * FROM h2a JOIN h2b ON h2a.k = h2b.k';
  const r = await analyse(page, setup, sql, { direct: [`SELECT count(*)::VARCHAR FROM (${sql})`], expectations: [{ kind: 'relationship', join: 0, expected: 'one-to-one' }] });
  expect(r.direct[0]).toEqual([['2']]);
  expect(r.report.status).toBe('partially-analyzed');
  expect(codes(r.report).some((c: string) => c === 'invariant-violated' || c === 'semantic-mismatch')).toBe(true);
  expect(r.report.joins[0].stats).toBeNull();
  expect(r.report.joins[0].derived).toBeNull();
  expect(codes(r.report)).not.toContain('join-cardinality');
  expect(r.report.expectations[0].outcome).toBe('unchecked');
  expect(noNegatives(r.report)).toBe(true);
  expect(r.report.stages).toEqual([]);
  const mvp = await analyse(page, [], sql, { scope: 'mvp' });
  expect([mvp.report.status, mvp.report.authoritative]).toEqual(['unsupported', false]);
  expect(mvp.report.findings[0].evidence.construct).toBe('non-integer join key');
});

test('H2: both sides collated (duplicate keys under NOCASE) is inconclusive; plain VARCHAR keys are still validated, not refused', async ({ page }) => {
  await start(page);
  const r = await analyse(page, [
    'CREATE OR REPLACE TABLE h2c (k VARCHAR COLLATE NOCASE)', "INSERT INTO h2c VALUES ('A'), ('a'), ('b')",
    'CREATE OR REPLACE TABLE h2d (k VARCHAR COLLATE NOCASE)', "INSERT INTO h2d VALUES ('a'), ('A')",
  ], 'SELECT * FROM h2c JOIN h2d ON h2c.k = h2d.k', { direct: ['SELECT count(*)::VARCHAR FROM h2c JOIN h2d ON h2c.k = h2d.k'] });
  const j = r.report.joins[0];
  if (j.stats) {
    // If grouping happened to follow the collation, the numbers must equal DuckDB's.
    expect(j.derived.outputRows).toBe(r.direct[0]![0]![0]);
    expect(j.validation).toMatchObject({ invariants: 'held', semiJoin: 'agreed', executedCount: 'agreed' });
  } else {
    expect(codes(r.report).some((c: string) => c === 'invariant-violated' || c === 'semantic-mismatch')).toBe(true);
  }
  expect(noNegatives(r.report)).toBe(true);
  const plain = await analyse(page, ['CREATE OR REPLACE TABLE h2e (k VARCHAR)', "INSERT INTO h2e VALUES ('A'), ('a'), ('a')"], 'SELECT * FROM h2e x JOIN h2e y ON x.k = y.k', { direct: ['SELECT count(*)::VARCHAR FROM h2e x JOIN h2e y ON x.k = y.k'] });
  expect(plain.report.status).toBe('analyzed');
  expect(plain.report.joins[0].derived.outputRows).toBe(plain.direct[0]![0]![0]);
  expect(plain.report.joins[0].validation.semiJoin).toBe('agreed');
});

// ---------------------------------------------------------------- H3 fail-closed budgets

test('H3: unknown join estimate never triggers executed probes (Codex repro with budget 1)', async ({ page }) => {
  await start(page);
  const r = await analyse(page, ['CREATE OR REPLACE TABLE h3a AS SELECT range::INTEGER AS k FROM range(3)', 'CREATE OR REPLACE TABLE h3b AS SELECT range::BIGINT AS k FROM range(3)'],
    'SELECT * FROM h3a JOIN h3b ON h3a.k = h3b.k', { options: { executionBudgetRows: '1' }, expectations: [{ kind: 'row-count', max: 10 }] });
  expect(codes(r.report)).toContain('join-key-type-mismatch');
  expect(r.report.stages).toEqual([]);
  expect(r.report.diagnosticSql.some((q: string) => q.includes('FROM (SELECT * FROM h3a'))).toBe(false);
  expect(r.report.expectations[0].outcome).toBe('unchecked');
});

test('H3: over-budget join blocks later joins and all executed probes', async ({ page }) => {
  await start(page);
  const r = await analyse(page, ['CREATE OR REPLACE TABLE c1 AS SELECT (range % 2)::INTEGER AS k FROM range(6)', 'CREATE OR REPLACE TABLE c2 AS SELECT (range % 2)::INTEGER AS k FROM range(4)'],
    'SELECT * FROM c1 JOIN c2 ON c1.k = c2.k JOIN c2 AS c3 ON c2.k = c3.k WHERE c1.k = 1', { options: { executionBudgetRows: '5' } });
  expect(r.report.joins[0].stats).not.toBeNull(); // 12 rows: computed, executed count skipped
  expect(r.report.joins[0].validation.executedCount).toBe('not-run');
  expect(r.report.joins[1].stats).toBeNull();
  expect(codes(r.report)).toContain('depends-on-unknown');
  expect(r.report.stages.map((s: R) => s.method)).not.toContain('count-only-probe');
});

test('H3/H-B: input-row and grouping-state budgets fail closed before any grouping (no DISTINCT ... LIMIT pre-check)', async ({ page }) => {
  await start(page);
  const setup = ['CREATE OR REPLACE TABLE ib1 AS SELECT range::INTEGER AS k FROM range(5)', 'CREATE OR REPLACE TABLE ib2 AS SELECT range::INTEGER AS k FROM range(5)'];
  const grouping = (r: R) => r.report.diagnosticSql.filter((q: string) => /GROUP BY|DISTINCT/i.test(q));
  const a = await analyse(page, setup, 'SELECT * FROM ib1 JOIN ib2 ON ib1.k = ib2.k', { scope: 'mvp', options: { maxInputRows: '4' } });
  expect(codes(a.report)).toContain('input-too-large');
  expect(a.report.authoritative).toBe(false);
  expect(grouping(a)).toEqual([]);
  expect(a.report.resources.inputRows).toEqual({ ib1: 'over 4', ib2: 'over 4' });
  // 5 rows × (4 key bytes + 16 count bytes + 64 overhead) = 420 bytes per side > 100
  const b = await analyse(page, [], 'SELECT * FROM ib1 JOIN ib2 ON ib1.k = ib2.k', { scope: 'mvp', options: { maxGroupingStateBytes: '100' } });
  expect(codes(b.report)).toContain('grouping-state-over-budget');
  expect(grouping(b)).toEqual([]);
  expect(b.report.resources).toMatchObject({ keyColumns: 1, keyBytesPerRow: 4, estimatedGroupingBytes: { 'join 0 left': '420', 'join 0 right': '420' }, maxGroupingStateBytes: '100' });
  expect(b.report.resources.engineMemoryLimit).toMatch(/iB$/);
  expect(b.report.authoritative).toBe(false);
  const c = await analyse(page, [], 'SELECT * FROM ib1 JOIN ib2 ON ib1.k = ib2.k', { scope: 'mvp', options: { maxGroupingStateBytes: '420' } });
  expect([c.report.status, c.report.authoritative]).toEqual(['analyzed', true]);
});

test('H3/H-B: analysis deadline cancels the running diagnostic, reports budget-exhausted, and leaves a usable session', async ({ page }) => {
  await start(page);
  // Small, memory-light fixture: a hook replaces the first diagnostic statement with a CPU-bound
  // streaming aggregate over 30 million generated values (about 330 ms in Chrome on the M2; nothing
  // is materialised). Replaces the retired 400M-row view test.
  const r = await page.evaluate(async () => {
    const H = window.__qvHarness!;
    const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
    await s.run('CREATE OR REPLACE TABLE dl_a AS SELECT range::INTEGER AS k FROM range(10)');
    let swapped = false;
    const t = performance.now();
    const report = await H.analyzeInSession(s, 'SELECT * FROM dl_a JOIN dl_a AS b ON dl_a.k = b.k', [{ kind: 'no-fan-out', join: 0 }], {
      scope: 'mvp', deadlineMs: 100,
      testHooks: { beforeStatement: (q: string) => (!swapped && q.startsWith('SELECT json_serialize_sql') ? ((swapped = true), 'SELECT sum(hash(range))::VARCHAR FROM range(30000000)') : undefined) },
    });
    const ms = performance.now() - t;
    const temps = await s.run("SELECT count(*)::VARCHAR FROM duckdb_tables() WHERE table_name LIKE '__qv_%'");
    const alive = await s.run('SELECT 42');
    return { report: JSON.parse(JSON.stringify(report)), ms, swapped, temps: temps.status === 'ok' ? temps.result.rows[0]![0] : 'ERR', alive: alive.status, state: s.state };
  });
  expect(r.swapped).toBe(true);
  expect(r.report.status).toBe('budget-exhausted');
  expect(r.report.findings.map((f: R) => f.code)).toEqual(['budget-exhausted', 'expectation-unchecked']);
  expect(r.report.terminal.reason).toBe('deadline');
  expect(['cooperative', 'terminated']).toContain(r.report.terminal.cancellation);
  expect([r.report.authoritative, r.report.joins]).toEqual([false, []]);
  expect(r.report.expectations.map((o: R) => [o.index, o.outcome])).toEqual([[0, 'unchecked']]);
  expect(r.ms).toBeLessThan(100 + 2 * 2000 + 5000 + 1000);
  expect([r.alive, r.state, r.temps]).toEqual(['ok', 'ready', '0']);
});

test('H3: temp frequency tables are dropped after injected budget exhaustion and diagnostic failure', async ({ page }) => {
  await start(page);
  const setup = ['CREATE OR REPLACE TABLE t1 AS SELECT (range % 3)::INTEGER AS k FROM range(9)', 'CREATE OR REPLACE TABLE t2 AS SELECT range::INTEGER AS k FROM range(3)'];
  const a = await analyse(page, setup, 'SELECT * FROM t1 JOIN t2 ON t1.k = t2.k', { scope: 'mvp', inject: 'budget|WITH m AS MATERIALIZED' });
  expect(a.report.status).toBe('budget-exhausted');
  expect(a.report.diagnosticSql.some((q: string) => q.startsWith('CREATE TEMP TABLE'))).toBe(true);
  expect(a.tempTablesLeft).toBe('0');
  const b = await analyse(page, [], 'SELECT * FROM t1 JOIN t2 ON t1.k = t2.k', { scope: 'mvp', inject: 'diag|WITH m AS MATERIALIZED' });
  expect(b.report.status).toBe('diagnostic-failed');
  expect(b.report.findings.find((f: R) => f.category === 'diagnostic-failure').message).toContain("does not mean the user's query fails");
  expect(b.tempTablesLeft).toBe('0');
  const ok = await analyse(page, [], 'SELECT * FROM t1 JOIN t2 ON t1.k = t2.k', { scope: 'mvp' });
  expect([ok.report.status, ok.report.authoritative, ok.tempTablesLeft]).toEqual(['analyzed', true, '0']);
});

// ---------------------------------------------------------------- H4 NULL vs zero

test('H4: NULL totals are never equated with zero; tolerance applies to non-NULL totals only', async ({ page }) => {
  await start(page);
  const setup = [
    'CREATE OR REPLACE TABLE h4c (k INTEGER)', 'INSERT INTO h4c VALUES (1)',
    'CREATE OR REPLACE TABLE h4null (k INTEGER, m DECIMAL(9,2))', 'INSERT INTO h4null VALUES (1, NULL)',
    'CREATE OR REPLACE TABLE h4zero (k INTEGER, m DECIMAL(9,2))', 'INSERT INTO h4zero VALUES (2, 0.00)',
    'CREATE OR REPLACE TABLE h4empty (k INTEGER, m DECIMAL(9,2))',
    'CREATE OR REPLACE TABLE h4num (k INTEGER, m DECIMAL(9,2))', 'INSERT INTO h4num VALUES (1, 100.00)',
    'CREATE OR REPLACE TABLE h4dup (k INTEGER)', 'INSERT INTO h4dup VALUES (1), (1)',
  ];
  const metric = async (sql: string, e: object) => (await analyse(page, setup, sql, { expectations: [{ kind: 'metric-preserved', ...e }] })).report.expectations[0];
  // NULL vs NULL (no non-NULL values on either side): held, as NULL = NULL, not as 0 = 0.
  const nn = await metric('SELECT * FROM h4null JOIN h4c ON h4null.k = h4c.k', { column: 'h4null.m', tolerance: 0.01 });
  expect([nn.outcome, nn.evidence.sourceTotal, nn.evidence.joinedTotal]).toEqual(['held', 'NULL', 'NULL']);
  // 0 vs NULL (the zero-valued row is dropped by the INNER JOIN): violated, with and without tolerance.
  for (const tol of [undefined, 0.01]) {
    const z = await metric('SELECT * FROM h4zero JOIN h4c ON h4zero.k = h4c.k', { column: 'h4zero.m', ...(tol ? { tolerance: tol } : {}) });
    expect([z.outcome, z.evidence.sourceTotal, z.evidence.joinedTotal]).toEqual(['violated', '0.00', 'NULL']);
  }
  // Explicit policy: NULL as zero.
  expect((await metric('SELECT * FROM h4zero JOIN h4c ON h4zero.k = h4c.k', { column: 'h4zero.m', nullAsZero: true })).outcome).toBe('held');
  // Empty relation: both totals NULL.
  expect((await metric('SELECT * FROM h4empty JOIN h4c ON h4empty.k = h4c.k', { column: 'h4empty.m' })).outcome).toBe('held');
  // Non-zero tolerance on non-NULL totals: 200.00 vs 100.00.
  expect((await metric('SELECT * FROM h4num JOIN h4dup ON h4num.k = h4dup.k', { column: 'h4num.m', tolerance: 2 })).outcome).toBe('held');
  expect((await metric('SELECT * FROM h4num JOIN h4dup ON h4num.k = h4dup.k', { column: 'h4num.m', tolerance: 0.5 })).outcome).toBe('violated');
});

test('H4: invalid or nonexistent expectation targets are reported as unchecked, never ignored', async ({ page }) => {
  await start(page);
  const setup = ['CREATE OR REPLACE TABLE e1 (k INTEGER, s VARCHAR)', "INSERT INTO e1 VALUES (1, 'x')", 'CREATE OR REPLACE TABLE e2 (k INTEGER)', 'INSERT INTO e2 VALUES (1)'];
  const exps = [
    { kind: 'relationship', join: 5, expected: 'one-to-one' },
    { kind: 'no-fan-out', join: -1 },
    { kind: 'metric-preserved', column: 'nope.x' },
    { kind: 'metric-preserved', column: 'e1.s' },
    { kind: 'grain', columns: ['does_not_exist'] },
    { kind: 'relationship', join: 0, expected: 'one-to-one' },
  ];
  const r = await analyse(page, setup, 'SELECT * FROM e1 JOIN e2 ON e1.k = e2.k', { expectations: exps });
  expect(r.report.expectations.map((o: R) => o.outcome)).toEqual(['unchecked', 'unchecked', 'unchecked', 'unchecked', 'unchecked', 'held']);
  expect(r.report.findings.filter((f: R) => f.category === 'expectation-unchecked')).toHaveLength(5);
  expect(r.report.status).toBe('partially-analyzed');
  const mvp = await analyse(page, [], 'SELECT * FROM e1 JOIN e2 ON e1.k = e2.k', { scope: 'mvp', expectations: [{ kind: 'grain', columns: ['k'] }, { kind: 'metric-preserved', column: 'e1.k' }, { kind: 'row-count', min: 1, max: 1 }] });
  expect(mvp.report.expectations.map((o: R) => [o.outcome, o.reason ?? ''])).toEqual([
    ['unchecked', 'grain expectations are outside the MVP scope'], ['unchecked', 'metric-preserved expectations are outside the MVP scope'], ['held', ''],
  ]);
  expect(mvp.report.authoritative).toBe(false); // unchecked expectations make the report partial
});

// ---------------------------------------------------------------- M1 aggregate attribution

test('M1: no aggregate-inflation claims for WHERE-filtered, FILTERed or COUNT(expr) aggregates; recorded as not checked', async ({ page }) => {
  await start(page);
  const setup = ['CREATE OR REPLACE TABLE m1o AS SELECT * FROM (VALUES (1, 1, 10), (2, 2, 20)) t(oid, cid, amt)', "CREATE OR REPLACE TABLE m1c AS SELECT * FROM (VALUES (1, 'x'), (2, 'y'), (2, 'z')) t(cid, nm)"];
  for (const sql of [
    "SELECT sum(m1o.amt) FROM m1o JOIN m1c ON m1o.cid = m1c.cid WHERE m1c.nm <> 'z'",
    'SELECT sum(m1o.amt) FILTER (WHERE m1o.cid = 1) FROM m1o JOIN m1c ON m1o.cid = m1c.cid',
    'SELECT count(NULL), count(m1o.amt), count(DISTINCT m1o.oid) FROM m1o JOIN m1c ON m1o.cid = m1c.cid',
    'SELECT count(*) FROM m1o JOIN m1c ON m1o.cid = m1c.cid',
  ]) {
    const r = (await analyse(page, setup, sql)).report;
    expect(codes(r).filter((c: string) => /aggregate|count-over|average/.test(c))).toEqual([]);
    expect(r.coverage.notChecked.join(' ')).toContain('aggregate inflation');
    expect(codes(r)).toContain('join-expansion'); // the join-stage observation remains, labelled as such
    expect(r.findings.find((f: R) => f.code === 'join-expansion').message).toContain('join output');
  }
});

// ---------------------------------------------------------------- M2 outer-join explanations

test('M2: preserved-side filter is described as such, with no rewrite advice; counts equal DuckDB', async ({ page }) => {
  await start(page);
  const setup = ['CREATE OR REPLACE TABLE oc AS SELECT * FROM (VALUES (1), (2), (3)) t(cid)', 'CREATE OR REPLACE TABLE oo AS SELECT * FROM (VALUES (10, 1, 5), (11, 1, 7)) t(oid, cid, amt)'];
  const advice = /belongs in ON|INNER JOIN states|move .* ON|should be|rewrite/i;
  const pres = await analyse(page, setup, 'SELECT * FROM oc LEFT JOIN oo ON oc.cid = oo.cid WHERE oc.cid < 3', { direct: ['SELECT count(*)::VARCHAR FROM oc LEFT JOIN oo ON oc.cid = oo.cid WHERE oo.cid IS NULL', 'SELECT count(*)::VARCHAR FROM oc LEFT JOIN oo ON oc.cid = oo.cid WHERE oo.cid IS NULL AND oc.cid < 3'] });
  const f = pres.report.findings.find((x: R) => x.code.startsWith('where-'));
  expect([f.code, f.category]).toEqual(['where-filters-preserved-side', 'observed']);
  expect(f.message).not.toMatch(advice);
  expect(f.evidence.rowsForUnmatchedBeforeWhere).toBe(pres.direct[0]![0]![0]);
  expect(BigInt(f.evidence.removedByWhere)).toBe(BigInt(pres.direct[0]![0]![0]!) - BigInt(pres.direct[1]![0]![0]!));
  const nulls = await analyse(page, [], 'SELECT * FROM oc LEFT JOIN oo ON oc.cid = oo.cid WHERE oo.amt > 5');
  const g = nulls.report.findings.find((x: R) => x.code.startsWith('where-'));
  expect([g.code, g.category]).toEqual(['where-removes-null-extended-rows', 'suspicious']);
  expect(g.message).not.toMatch(advice);
  const mixed = await analyse(page, [], 'SELECT * FROM oc LEFT JOIN oo ON oc.cid = oo.cid WHERE oc.cid < 3 OR oo.amt > 5');
  expect(mixed.report.findings.find((x: R) => x.code.startsWith('where-'))?.code).toBe('where-removes-outer-join-rows');
});

test('M2: later joins — an INNER join is measured at the full FROM; a later RIGHT join is reported as not checked', async ({ page }) => {
  await start(page);
  const setup = ['CREATE OR REPLACE TABLE lc AS SELECT * FROM (VALUES (1), (2), (3)) t(cid)', 'CREATE OR REPLACE TABLE lo AS SELECT * FROM (VALUES (10, 1)) t(oid, cid)', 'CREATE OR REPLACE TABLE lx AS SELECT * FROM (VALUES (1), (2), (3)) t(cid)'];
  const inner = await analyse(page, setup, 'SELECT * FROM lc LEFT JOIN lo ON lc.cid = lo.cid JOIN lx ON lc.cid = lx.cid WHERE lc.cid < 3', { direct: ['SELECT count(*)::VARCHAR FROM lc LEFT JOIN lo ON lc.cid = lo.cid JOIN lx ON lc.cid = lx.cid WHERE lo.cid IS NULL'] });
  const f = inner.report.findings.find((x: R) => x.code.startsWith('where-'));
  expect(f.code).toBe('where-filters-preserved-side');
  expect(f.evidence.rowsForUnmatchedBeforeWhere).toBe(inner.direct[0]![0]![0]);
  const right = await analyse(page, [], 'SELECT * FROM lc LEFT JOIN lo ON lc.cid = lo.cid RIGHT JOIN lx ON lc.cid = lx.cid WHERE lc.cid < 3');
  expect(right.report.findings.some((x: R) => x.code.startsWith('where-'))).toBe(false);
  expect(right.report.coverage.notChecked.join(' ')).toContain('later RIGHT/FULL join');
});

// ---------------------------------------------------------------- M3 syntax scope and failure classification

test('M3: unsupported nested scopes and modifiers are refused; a SELECT alias in WHERE is unsupported, not a query failure', async ({ page }) => {
  await start(page);
  const setup = ['CREATE OR REPLACE TABLE s1 AS SELECT * FROM (VALUES (1, 10), (2, 20)) t(k, amt)', 'CREATE OR REPLACE TABLE s2 AS SELECT * FROM (VALUES (1), (2)) t(k)'];
  await analyse(page, setup, 'SELECT 1');
  const cases: [string, string][] = [
    ['ORDER BY subquery', 'SELECT * FROM s1 JOIN s2 ON s1.k = s2.k ORDER BY (SELECT 1)'],
    ['LIMIT subquery', 'SELECT * FROM s1 JOIN s2 ON s1.k = s2.k LIMIT (SELECT 1)'],
    ['alias in WHERE', 'SELECT s1.amt AS a FROM s1 JOIN s2 ON s1.k = s2.k WHERE a > 10'],
    ['alias in GROUP BY', 'SELECT s1.amt AS a, count(*) FROM s1 JOIN s2 ON s1.k = s2.k GROUP BY a'],
    ['nested WITH in CTE', 'WITH x AS (WITH y AS (SELECT * FROM s1) SELECT * FROM y) SELECT * FROM x JOIN s2 ON x.k = s2.k'],
    ['COLLATE expression', "SELECT * FROM s1 JOIN s2 ON s1.k = s2.k WHERE 'a' COLLATE NOCASE = 'A'"],
  ];
  for (const [name, sql] of cases) {
    for (const scope of ['experimental', 'mvp']) {
      const r = await analyse(page, [], sql, { scope, direct: [sql] });
      expect([name, scope, r.report.status]).toEqual([name, scope, 'unsupported']);
      expect(typeof r.direct[0]).not.toBe('string'); // DuckDB itself runs every one of these queries
    }
  }
});

test('M3: a query that fails at runtime is never reported as executed; count-only probes are labelled', async ({ page }) => {
  await start(page);
  const setup = ['CREATE OR REPLACE TABLE rf1 AS SELECT * FROM (VALUES (1), (2)) t(k)', 'CREATE OR REPLACE TABLE rf2 AS SELECT * FROM (VALUES (1), (2)) t(k)'];
  const sql = "SELECT 'abc'::INTEGER AS bad FROM rf1 JOIN rf2 ON rf1.k = rf2.k";
  const r = await analyse(page, setup, sql, { direct: [sql] });
  expect(String(r.direct[0])).toContain('Conversion Error');
  const final = r.report.stages.find((s: R) => s.stage === 'final result');
  expect(final.method).toBe('count-only-probe');
  expect(r.report.coverage.notChecked[0]).toContain('whether the original query executes');
  expect(r.report.disclaimer).toContain('does not show that the query executes');
  expect(r.report.findings.some((f: R) => /executed successfully|query runs|query succeeded/i.test(f.message))).toBe(false);
  const mvp = await analyse(page, [], sql, { scope: 'mvp' });
  expect(mvp.report.status).toBe('unsupported'); // MVP projection: plain columns only
});

test('M3: diagnostic failures are distinguished from user-query failures', async ({ page }) => {
  await start(page);
  const setup = ['CREATE OR REPLACE TABLE df1 AS SELECT * FROM (VALUES (1), (2)) t(k)', 'CREATE OR REPLACE TABLE df2 AS SELECT * FROM (VALUES (1)) t(k)'];
  const diag = await analyse(page, setup, 'SELECT * FROM df1 JOIN df2 ON df1.k = df2.k', { scope: 'mvp', inject: 'diag|json_deserialize_sql' });
  expect(diag.report.status).toBe('diagnostic-failed');
  expect(diag.report.findings.map((f: R) => f.category)).toEqual(['diagnostic-failure']);
  const user = await analyse(page, [], 'SELECT nope FROM df1 JOIN df2 ON df1.k = df2.k', { scope: 'mvp' });
  expect([user.report.status, user.report.findings[0].category]).toEqual(['query-failed', 'query-failure']);
});
