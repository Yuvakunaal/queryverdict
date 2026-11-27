// M06 Run SQL on the real engine (DuckDB-WASM 1.33.1-dev57.0 / DuckDB v1.5.4) through the
// production QueryRunner, in the test harness. Known answers below are written by hand from
// DuckDB's documented text forms (and checked against the engine once, FEASIBILITY §16); they are
// not produced by the code under test.
// T-ENG-006b exact cells · 009a truncation causes · 010b epoch and historical evidence ·
// 013a classification · 013b multi-statement policy; lockdown and network isolation; cancellation
// while streaming; rapid re-runs; engine recovery.
import { expect, test, type Page } from '@playwright/test';
import { captureRequests, HARNESS } from './helpers';

type Cell = { kind: 'null' } | { kind: 'text'; text: string; truncated: boolean } | { kind: 'unsupported'; type: string; reason: string };
type Run = {
  terminal: { status: string; phase?: string; reason?: string; message?: string };
  epochAdvanced: boolean;
  run: null | {
    statement: string; ordered: boolean; exactText: boolean; dataChanged: boolean; affectedRows: string | null; transactionHint: string | null;
    result: null | { columns: { name: string; type: string }[]; rows: Cell[][]; truncation: { rows: boolean; columns: null | { shown: number; total: number }; cells: number; display: boolean; bytes: boolean } };
  };
};

async function boot(page: Page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__qvHarness?.query);
  await page.evaluate(async () => {
    const { session } = window.__qvHarness!.engine.newSession({ faulty: true });
    await session.start();
    (window as unknown as { __s: unknown }).__s = session;
  });
}
const run = (page: Page, sql: string, limits: Record<string, number> = {}) =>
  page.evaluate(([sql, limits]) => window.__qvHarness!.query!.run((window as unknown as { __s: never }).__s, sql, limits) as Promise<unknown>, [sql, limits] as const) as Promise<Run>;
const text = (c: Cell | undefined) => (c?.kind === 'text' ? c.text : c?.kind === 'null' ? null : `<${c?.kind}>`);
const row0 = (r: Run) => (r.run?.result?.rows[0] ?? []).map(text);

test.describe('Run SQL on the real engine (harness)', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('T-ENG-006b: exact text for wide integers, decimals, floats, temporal, binary and nested values', async ({ page }) => {
    const r = await run(page, `SELECT 170141183460469231731687303715884105727::HUGEINT AS h, (-170141183460469231731687303715884105728)::HUGEINT AS hmin,
      340282366920938463463374607431768211455::UHUGEINT AS u, 12345678901234567890123456789012345678::DECIMAL(38,0) AS d38,
      (-0.001)::DECIMAL(18,3) AS dneg, 1.5::DECIMAL(38,10) AS dscale, 9007199254740993::BIGINT AS big, 18446744073709551615::UBIGINT AS ubig,
      0.1::FLOAT AS f, 1.0::DOUBLE AS one, 'inf'::DOUBLE AS inf, '-inf'::FLOAT AS ninf, 'nan'::DOUBLE AS nan, true AS b`);
    expect(r.terminal.status).toBe('ok');
    expect(r.run?.exactText).toBe(true);
    expect(row0(r)).toEqual([
      '170141183460469231731687303715884105727', '-170141183460469231731687303715884105728', '340282366920938463463374607431768211455',
      '12345678901234567890123456789012345678', '-0.001', '1.5000000000', '9007199254740993', '18446744073709551615',
      '0.1', '1.0', 'inf', '-inf', 'nan', 'true',
    ]);
    expect(r.run?.result?.columns.map((c) => c.type)).toEqual(['HUGEINT', 'HUGEINT', 'UHUGEINT', 'DECIMAL(38,0)', 'DECIMAL(18,3)', 'DECIMAL(38,10)', 'BIGINT', 'UBIGINT', 'FLOAT', 'DOUBLE', 'DOUBLE', 'FLOAT', 'DOUBLE', 'BOOLEAN']);

    const t = await run(page, `SELECT DATE '2024-02-29' AS d, DATE '-0044-03-15' AS bc, TIME '13:45:30.123456' AS t, TIMETZ '13:45:30+02' AS ttz,
      TIMESTAMP '2024-01-02 03:04:05' AS ts0, TIMESTAMP '2024-01-02 03:04:05.1' AS ts1, TIMESTAMP_NS '2024-01-02 03:04:05.123456789' AS ns,
      TIMESTAMPTZ '2024-01-02 03:04:05.5+02' AS tz, 'infinity'::TIMESTAMP AS inf, INTERVAL '1 year 2 months 3 days 04:05:06.789' AS iv`);
    expect(row0(t)).toEqual(['2024-02-29', '0045-03-15 (BC)', '13:45:30.123456', '13:45:30+02', '2024-01-02 03:04:05', '2024-01-02 03:04:05.1', '2024-01-02 03:04:05.123456789', '2024-01-02 01:04:05.5+00', 'infinity', '1 year 2 months 3 days 04:05:06.789']);

    const v = await run(page, `SELECT NULL AS n, '' AS e, '   ' AS ws, '\\xAA\\x00A'::BLOB AS bl, '101'::BITSTRING AS bits, '12345678901234567890'::VARINT AS vi,
      '550e8400-e29b-41d4-a716-446655440000'::UUID AS id, [1, NULL] AS l, ['a', '', NULL] AS ls, {'a': 'x y', 'b': [1]} AS s, MAP {'k': 1} AS m, 'héllo 🌍' AS uni, 1 AS a, 2 AS a`);
    expect(row0(v)).toEqual([null, '', '   ', '\\xAA\\x00A', '101', '12345678901234567890', '550e8400-e29b-41d4-a716-446655440000', '[1, NULL]', "[a, '', NULL]", "{'a': x y, 'b': [1]}", '{k=1}', 'héllo 🌍', '1', '2']);
    expect(v.run?.result?.columns.slice(-2).map((c) => c.name)).toEqual(['a', 'a']); // duplicate names kept
  });

  test('T-ENG-009a: rows, columns, cells, display characters and bytes are each reported separately', async ({ page }) => {
    const rows = await run(page, 'SELECT i FROM range(5000) t(i) ORDER BY i DESC');
    expect(rows.run?.ordered).toBe(true);
    expect(rows.run?.result?.rows).toHaveLength(1000);
    expect(text(rows.run?.result?.rows[0]?.[0])).toBe('4999');
    expect(text(rows.run?.result?.rows[999]?.[0])).toBe('4000'); // order kept through the bounded projection
    expect(rows.run?.result?.truncation).toEqual({ rows: true, columns: null, cells: 0, display: false, bytes: false });

    const exact = await run(page, 'SELECT i FROM range(1000) t(i)');
    expect(exact.run?.result?.truncation.rows).toBe(false); // exactly the limit: nothing withheld

    const cols = await run(page, 'SELECT 1 AS a, 2 AS b, 3 AS c', { maxColumns: 2 });
    expect(cols.run?.result?.truncation).toEqual({ rows: false, columns: { shown: 2, total: 3 }, cells: 0, display: false, bytes: false });
    expect(cols.run?.result?.columns.map((c) => c.name)).toEqual(['a', 'b']);

    const cells = await run(page, "SELECT repeat('ab', 1000) AS long, '🌍' || repeat('x', 600) AS emoji");
    expect(cells.run?.result?.truncation).toEqual({ rows: false, columns: null, cells: 2, display: false, bytes: false });
    const c0 = cells.run?.result?.rows[0]?.[0];
    expect(c0).toEqual({ kind: 'text', text: 'ab'.repeat(250), truncated: true });
    expect(cells.run?.result?.rows[0]?.[1]).toEqual({ kind: 'text', text: '🌍' + 'x'.repeat(499), truncated: true });

    const display = await run(page, "SELECT i, repeat('x', 400) AS w FROM range(100) t(i)", { maxDisplayChars: 5000 });
    expect(display.run?.result?.rows).toHaveLength(12); // 12 × (1–2 + 400) ≤ 5,000
    expect(display.run?.result?.truncation).toMatchObject({ rows: false, display: true, bytes: false });

    const bytes = await run(page, "SELECT i, repeat('x', 400) AS w FROM range(5000) t(i)", { maxArrowBytes: 200_000 });
    expect(bytes.run?.result?.rows).toHaveLength(0);
    expect(bytes.run?.result?.truncation).toMatchObject({ rows: false, display: false, bytes: true });
  });

  test('T-ENG-013a/b: statement classification, multi-statement refusal and error phases', async ({ page }) => {
    const multi = await run(page, 'SELECT 1; SELECT 2');
    expect(multi.terminal.status).toBe('refused');
    expect(multi.epochAdvanced).toBe(false);
    const mixed = await run(page, 'CREATE TABLE es (x INTEGER); DROP TABLE es');
    expect(mixed.terminal.status).toBe('refused');
    expect((await run(page, "SELECT count(*) FROM duckdb_tables() WHERE table_name = 'es'")).run?.result?.rows[0]?.map(text)).toEqual(['0']); // nothing ran
    const pivot = await run(page, "PIVOT (SELECT 1 AS a, 'x' AS b) ON b USING sum(a)");
    expect(pivot.terminal.reason).toContain("ON b IN ('x', 'y')"); // the verified form (Codex M06)
    expect((await run(page, "SELECT * FROM (PIVOT (SELECT 1 AS a, 'x' AS b) ON b USING sum(a))")).terminal.status).toBe('refused'); // dynamic PIVOT, even wrapped
    expect((await run(page, "PIVOT (SELECT 1 AS a, 'x' AS b) ON b IN ('x') USING sum(a)")).terminal.status).toBe('ok');
    expect((await run(page, "SELECT * FROM (PIVOT (SELECT 1 AS a, 'x' AS b) ON b IN ('x') USING sum(a))")).terminal.status).toBe('ok');

    expect((await run(page, 'SELEC 1')).terminal).toMatchObject({ status: 'error', phase: 'parse' });
    expect((await run(page, 'SELECT * FROM nosuch')).terminal).toMatchObject({ status: 'error', phase: 'bind' });
    expect((await run(page, "SELECT 'a'::INTEGER")).terminal).toMatchObject({ status: 'error', phase: 'execute' });
    expect((await run(page, '')).terminal.status).toBe('refused');

    for (const sql of ['SHOW TABLES', 'SUMMARIZE (SELECT 1 AS a)', 'VALUES (1), (2)', 'FROM range(2)', 'SELECT 1 -- note ; \n;  -- end', "SELECT 'a;' AS x;"]) {
      const r = await run(page, sql);
      expect([sql, r.terminal.status, r.run?.statement, r.epochAdvanced]).toEqual([sql, 'ok', 'select', false]);
    }
  });

  test('DDL and DML: affected rows as reported by DuckDB; other statement results streamed with explicit unsupported values', async ({ page }) => {
    const ctas = await run(page, 'CREATE TABLE t AS SELECT i, i * 2 AS j FROM range(5) r(i)');
    expect(ctas.run).toMatchObject({ statement: 'statement', affectedRows: '5', result: null, dataChanged: true });
    expect(ctas.epochAdvanced).toBe(true);
    expect((await run(page, 'INSERT INTO t VALUES (10, 20), (11, 22)')).run?.affectedRows).toBe('2');
    expect((await run(page, 'UPDATE t SET j = 0 WHERE i > 9')).run?.affectedRows).toBe('2');
    expect((await run(page, 'DELETE FROM t WHERE i = 0')).run?.affectedRows).toBe('1');
    const alter = await run(page, 'ALTER TABLE t ADD COLUMN k INTEGER');
    expect(alter.run).toMatchObject({ result: null, affectedRows: null, dataChanged: true });
    const ret = await run(page, 'INSERT INTO t VALUES (99, 1, 7) RETURNING i, j, 1.5::DOUBLE AS d');
    expect(ret.run?.result?.rows[0]?.map(text)).toEqual(['99', '1', '<unsupported>']);
    expect(ret.run?.affectedRows).toBeNull();
    const pragma = await run(page, 'PRAGMA version');
    expect(text(pragma.run?.result?.rows[0]?.[0])).toBe('v1.5.4');
    expect((await run(page, 'DROP TABLE t')).run?.result).toBeNull();
  });

  test('lockdown still applies to Run SQL; no request leaves the page', async ({ page, context }) => {
    const requests = captureRequests(context);
    const n = requests.length;
    for (const sql of ["SELECT * FROM read_csv('https://example.com/x.csv')", "SELECT * FROM read_parquet('http://127.0.0.1:9/x.parquet')", "ATTACH 'https://example.com/db.duckdb' AS r", "COPY (SELECT 1) TO 'out.csv'", 'LOAD httpfs']) {
      const r = await run(page, sql);
      expect([sql, r.terminal.status]).toEqual([sql, 'error']);
    }
    expect((await run(page, 'SET threads = 4')).terminal.message).toContain('locked');
    await page.waitForTimeout(300);
    expect(requests.slice(n).map((r) => r.url())).toEqual([]);
  });

  test('Codex M06: exact text keeps a leading U+FEFF and ENUM values from RETURNING; booleans respect the cell limit', async ({ page }) => {
    expect(row0(await run(page, "SELECT chr(65279) || 'A' AS a, chr(65279) AS b"))).toEqual(['\uFEFFA', '\uFEFF']);
    await run(page, "CREATE TABLE en (x ENUM('red', 'blue'))");
    // DuckDB-WASM streams the RETURNING keys with an empty dictionary (FEASIBILITY §16.4): the
    // labels are not in the transferred data, so they are an explicit "not shown", never ''.
    const ret = await run(page, "INSERT INTO en VALUES ('red'), ('blue') RETURNING x");
    expect(ret.run?.result?.rows.map((r) => text(r[0]))).toEqual(['<unsupported>', '<unsupported>']);
    expect((await run(page, 'SELECT x FROM en')).run?.result?.rows.map((r) => text(r[0]))).toEqual(['red', 'blue']);
    await run(page, 'CREATE TABLE bo (x BOOLEAN)');
    const b = await run(page, 'INSERT INTO bo VALUES (false) RETURNING x', { maxCellChars: 1 });
    expect(b.run?.result?.rows[0]?.[0]).toEqual({ kind: 'text', text: 'f', truncated: true });
  });

  test('Codex M06: affected rows are DuckDB\'s own count, not the clipped display text', async ({ page }) => {
    await run(page, 'CREATE TABLE ar (x INTEGER)');
    const r = await run(page, 'INSERT INTO ar SELECT * FROM range(15)', { maxCellChars: 1 });
    expect(r.run?.affectedRows).toBe('15');
    expect(row0(await run(page, 'SELECT count(*) FROM ar'))).toEqual(['15']);
  });

  test('Codex M06: a SELECT with effects is evaluated in full (nextval is not pruned or cut short)', async ({ page }) => {
    await run(page, 'CREATE SEQUENCE s1');
    const r = await run(page, "SELECT i, nextval('s1') AS n FROM range(3000) t(i)", { maxColumns: 1 });
    expect(r.run?.result?.rows).toHaveLength(1000);
    expect(r.run?.result?.truncation).toMatchObject({ rows: true, columns: { shown: 1, total: 2 } });
    expect(row0(await run(page, "SELECT nextval('s1')"))).toEqual(['3001']);
  });

  for (const mode of ['reject', 'hang'] as const) {
    test(`Codex M06: an early stream stop the engine does not confirm (${mode}) restarts the engine; SQL works afterwards`, async ({ page }) => {
      const out = await page.evaluate(async (mode) => {
        const H = window.__qvHarness!;
        const s = (window as unknown as { __s: { generation: number | null } }).__s;
        const g = s.generation;
        H.engine.faults.streamStop = mode;
        const r = await H.query!.run(s as never, 'SELECT * FROM range(5000)', { maxRows: 1 });
        H.engine.faults.streamStop = 'ok';
        for (let i = 0; i < 600 && s.generation === g; i++) await new Promise((res) => setTimeout(res, 10));
        const after = await H.query!.run(s as never, 'SELECT 7');
        return { terminal: r.terminal, restarted: s.generation !== g, after: after.terminal.status };
      }, mode);
      expect(out.terminal).toMatchObject({ status: 'error', phase: 'engine' });
      expect(out).toMatchObject({ restarted: true, after: 'ok' });
    });
  }

  test('cancelling while the statement runs: a SELECT keeps the epoch, a sent DELETE advances it', async ({ page }) => {
    const out = await page.evaluate(async () => {
      const H = window.__qvHarness!;
      const s = (window as unknown as { __s: { epoch: number } }).__s;
      const wait = async (re: RegExp) => { for (let i = 0; i < 200 && !H.engine.held.some((h) => re.test(h.sql)); i++) await new Promise((r) => setTimeout(r, 10)); };
      await H.query!.run(s as never, 'CREATE TABLE c (x INTEGER)');
      H.engine.faults.hold = /__qv_result|^DELETE/;
      const e0 = s.epoch;
      const sel = H.query!.start(s as never, 'SELECT * FROM c');
      await wait(/__qv_result/);
      sel.cancel();
      const a = await sel.result;
      const e1 = s.epoch;
      const del = H.query!.start(s as never, 'DELETE FROM c');
      await wait(/^DELETE/);
      del.cancel();
      const b = await del.result;
      H.engine.faults.hold = null;
      return { a: a.terminal, b: b.terminal, selectKept: e1 === e0, deleteAdvanced: s.epoch === e1 + 1, aValue: a.value ?? null, bValue: b.value ?? null };
    });
    expect(out.a).toMatchObject({ status: 'cancelled', by: 'user' });
    expect(out.b).toMatchObject({ status: 'cancelled', by: 'user' });
    expect(out).toMatchObject({ selectKept: true, deleteAdvanced: true, aValue: null, bValue: null });
  });

  test('engine recovery while a query runs: the result is stale and never published', async ({ page }) => {
    const out = await page.evaluate(async () => {
      const H = window.__qvHarness!;
      const s = (window as unknown as { __s: { restart(r: string): Promise<void> } }).__s;
      H.engine.faults.hold = /__qv_result/;
      const h = H.query!.start(s as never, 'SELECT 42');
      for (let i = 0; i < 200 && !H.engine.held.length; i++) await new Promise((r) => setTimeout(r, 10));
      void s.restart('test recovery');
      const r = await h.result;
      H.engine.faults.hold = null;
      return { terminal: r.terminal, value: r.value ?? null };
    });
    expect(out).toEqual({ terminal: { status: 'stale', reason: 'generation-changed' }, value: null });
  });
});

test.describe('Run SQL in the app runtime: registry, Verdict evidence, rapid re-runs (harness app view)', () => {
  const APP_VIEW = `${HARNESS}?view=app`;

  test('T-ENG-010b: SQL changes reach the dataset registry and make a Verdict report historical; a SELECT does not', async ({ page }) => {
    await page.goto(APP_VIEW);
    await expect(page.getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
    const out = await page.evaluate(async () => {
      type Rt = { queries: { run(statements: string[], source: string): void; getSnapshot(): { state: { status: string } } }; reports: { getSnapshot(): { current: boolean; historicalReason?: string } }; verdict: { analyze(sql: string, e: unknown[]): { result: Promise<unknown> } }; datasets: { registry: { getSnapshot(): { relation: string; origin: string; state: string; columns?: unknown[] }[] } } };
      const rt = (window as unknown as { __qvApp: Rt }).__qvApp;
      const settle = async () => { for (let i = 0; i < 500; i++) { const s = rt.queries.getSnapshot().state.status; if (!['queued', 'running', 'cancelling'].includes(s)) return s; await new Promise((r) => setTimeout(r, 10)); } return 'timeout'; };
      const until = async (f: () => boolean) => { for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); return f(); };
      const entry = (n: string) => rt.datasets.registry.getSnapshot().find((e) => e.relation === n);
      rt.queries.run(['CREATE TABLE l AS SELECT i AS k FROM range(3) t(i)'], 'CREATE TABLE l AS SELECT i AS k FROM range(3) t(i)'); await settle();
      rt.queries.run(['CREATE TABLE r AS SELECT i AS k FROM range(3) t(i)'], 'CREATE TABLE r AS SELECT i AS k FROM range(3) t(i)'); await settle();
      const created = await until(() => entry('l')?.origin === 'sql' && entry('r')?.state === 'ready');
      await rt.verdict.analyze('SELECT * FROM l JOIN r ON l.k = r.k', []).result;
      const fresh = rt.reports.getSnapshot().current;
      rt.queries.run(['SELECT count(*) FROM l'], 'SELECT count(*) FROM l'); await settle();
      const afterSelect = rt.reports.getSnapshot().current;
      rt.queries.run(['INSERT INTO l VALUES (9)'], 'INSERT INTO l VALUES (9)'); await settle();
      const afterInsert = rt.reports.getSnapshot();
      rt.queries.run(['ALTER TABLE r ADD COLUMN extra VARCHAR'], 'ALTER TABLE r ADD COLUMN extra VARCHAR'); await settle();
      const altered = await until(() => entry('r')?.columns?.length === 2);
      rt.queries.run(['DROP TABLE l'], 'DROP TABLE l'); await settle();
      const dropped = await until(() => entry('l') === undefined || entry('l')?.state === 'missing');
      return { created, fresh, afterSelect, afterInsertCurrent: afterInsert.current, reason: afterInsert.historicalReason ?? null, altered, dropped };
    });
    expect(out).toMatchObject({ created: true, fresh: true, afterSelect: true, afterInsertCurrent: false, altered: true, dropped: true });
    expect(out.reason).toBeTruthy();
  });

  test('rapid re-runs: a newer run supersedes the older one, whose late result never replaces it', async ({ page }) => {
    await page.goto(APP_VIEW);
    await expect(page.getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
    const out = await page.evaluate(async () => {
      const H = window.__qvHarness!;
      type St = { status: string; sql?: string; run?: { result: { rows: { kind: string; text?: string }[][] } | null } };
      const rt = (window as unknown as { __qvApp: { queries: { run(statements: string[], source: string): void; getSnapshot(): { state: St } } } }).__qvApp;
      H.engine.faults.hold = /'first'/;
      rt.queries.run(["SELECT 'first' AS v"], "SELECT 'first' AS v");
      for (let i = 0; i < 200 && !H.engine.held.length; i++) await new Promise((r) => setTimeout(r, 10));
      H.engine.faults.hold = null;
      rt.queries.run(["SELECT 'second' AS v"], "SELECT 'second' AS v");
      const states: string[] = [];
      for (let i = 0; i < 500; i++) {
        const s = rt.queries.getSnapshot().state;
        states.push(`${s.status}:${s.sql ?? ''}`);
        if (s.status === 'done') break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const final = rt.queries.getSnapshot().state;
      // Let any late delivery of the first run happen; it must not replace the second.
      for (const h of [...H.engine.held]) h.release();
      await new Promise((r) => setTimeout(r, 300));
      const after = rt.queries.getSnapshot().state;
      return { final: final.sql, finalValue: final.run?.result?.rows[0]?.[0]?.text, after: after.sql, sawFirstDone: states.some((s) => s === "done:SELECT 'first' AS v") };
    });
    expect(out).toEqual({ final: "SELECT 'second' AS v", finalValue: 'second', after: "SELECT 'second' AS v", sawFirstDone: false });
  });
});
