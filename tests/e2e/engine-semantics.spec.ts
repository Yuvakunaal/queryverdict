// Engine-semantics qualification suite ES-01 … ES-12 (docs/TESTING_STRATEGY.md §5.3). Pins every
// DuckDB-WASM behaviour the architecture depends on, against the real engine (DuckDB v1.5.4,
// @duckdb/duckdb-wasm 1.33.1-dev57.0). Re-run on every engine or extension change.
import { expect, test, type Page } from '@playwright/test';
import { HARNESS, startListener } from './helpers';

type Out = { terminal: { status: string; message?: string }; rows: (string | null)[][] | null };

async function open(page: Page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__qvHarness?.engine !== undefined);
  await page.evaluate(async () => {
    const H = window.__qvHarness!.engine;
    const { session } = H.newSession();
    await session.start();
    (window as unknown as { __s: typeof session }).__s = session;
  });
}

/** Runs statements in order on the shared session; returns each outcome. */
function run(page: Page, statements: string[]): Promise<Out[]> {
  return page.evaluate(async (statements) => {
    const H = window.__qvHarness!.engine;
    const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
    const out = [];
    for (const q of statements) {
      const r = await H.sql(s, q);
      out.push({ terminal: r.terminal as Out['terminal'], rows: r.rows as Out['rows'] });
    }
    return out;
  }, statements);
}
const ok = (o: Out | undefined) => o?.terminal.status === 'ok';

test.describe('engine semantics (DuckDB v1.5.4)', () => {
  test.beforeEach(async ({ page }) => open(page));

  test('ES-01 lockdown is effective, locked and loads exactly core_functions, json, parquet', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const H = window.__qvHarness!.engine;
      const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
      const v = await s.submit('catalog', (l) => H.verifyLockdown((q) => l.query(q, { maxRows: 1_000 }), new H.DuckDBDriver().extensionRepository), H.BOUNDS).result;
      return { verification: v.value, info: s.info };
    });
    expect(r.verification?.ok).toBe(true);
    expect(r.verification?.loadedExtensions).toEqual(['core_functions', 'json', 'parquet']);
    expect(r.info).toMatchObject({ duckdb: 'v1.5.4', packageVersion: '1.33.1-dev57.0', verified: true });
    const [set] = await run(page, ['SET enable_external_access = true']);
    expect(set?.terminal.status).toBe('error');
  });

  test('ES-02 remote reads, remote ATTACH and remote extension installs are refused; nothing reaches the network', async ({ page }) => {
    const listener = await startListener();
    try {
      const r = await page.evaluate(async (target) => {
        const H = window.__qvHarness!.engine;
        const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
        const out = [];
        for (const p of H.escalationProbes(target)) {
          const res = await H.sql(s, p.sql);
          out.push({ name: p.name, status: res.terminal.status, mayReturn: p.mayReturnWithoutEffect === true });
        }
        const ext = await H.sql(s, 'SELECT extension_name::VARCHAR FROM duckdb_extensions() WHERE loaded ORDER BY 1');
        return { out, loaded: ext.rows };
      }, listener.url);
      for (const p of r.out) {
        if (!p.mayReturn) expect([p.name, p.status]).toEqual([p.name, 'error']);
      }
      expect(r.loaded).toEqual([['core_functions'], ['json'], ['parquet']]);
      expect(listener.hits).toEqual([]);
    } finally {
      await listener.close();
    }
  });

  test('ES-03 nested BEGIN fails; execution errors abort a transaction; binder errors do not; ROLLBACK recovers', async ({ page }) => {
    const r = await run(page, [
      'CREATE TABLE es3 (k INTEGER)', 'INSERT INTO es3 VALUES (1)',
      'BEGIN TRANSACTION', 'BEGIN TRANSACTION', 'ROLLBACK',
      'BEGIN TRANSACTION', "SELECT 'abc'::INTEGER", 'SELECT count(*)::VARCHAR FROM es3', 'ROLLBACK',
      'BEGIN TRANSACTION', 'SELECT nope FROM es3', 'SELECT count(*)::VARCHAR FROM es3', 'ROLLBACK',
      'SELECT count(*)::VARCHAR FROM es3',
    ]);
    expect(r.map((o) => o.terminal.status)).toEqual(['ok', 'ok', 'ok', 'error', 'ok', 'ok', 'error', 'error', 'ok', 'ok', 'error', 'ok', 'ok', 'ok']);
    expect(r[7]?.terminal.message).toMatch(/transaction is aborted/i);
    expect(r[11]?.rows).toEqual([['1']]);
  });

  test('ES-04 temporary tables and DDL roll back with the transaction', async ({ page }) => {
    const r = await run(page, ['BEGIN TRANSACTION', 'CREATE TEMP TABLE es4_t AS SELECT 1 AS x', 'CREATE TABLE es4_b (x INTEGER)', 'ROLLBACK', "SELECT count(*)::VARCHAR FROM duckdb_tables() WHERE table_name IN ('es4_t', 'es4_b')"]);
    expect(r.every(ok)).toBe(true);
    expect(r[4]?.rows).toEqual([['0']]);
  });

  test('ES-05 json_serialize_sql serialises one SELECT and returns an error object for other statements', async ({ page }) => {
    const r = await run(page, [
      "SELECT json_serialize_sql('SELECT a.k FROM a JOIN b ON a.k = b.k')::VARCHAR",
      "SELECT json_serialize_sql('UPDATE a SET k = 1')::VARCHAR",
      "SELECT json_serialize_sql('SELECT 1; SELECT 2')::VARCHAR",
    ]);
    const one = JSON.parse(r[0]?.rows?.[0]?.[0] ?? '{}');
    expect([one.error, one.statements.length, one.statements[0].node.type, one.statements[0].node.from_table.type]).toEqual([false, 1, 'SELECT_NODE', 'JOIN']);
    const upd = JSON.parse(r[1]?.rows?.[0]?.[0] ?? '{}');
    expect([upd.error, upd.error_message]).toEqual([true, 'Only SELECT statements can be serialized to json!']);
    expect(JSON.parse(r[2]?.rows?.[0]?.[0] ?? '{}').statements.length).toBe(2);
  });

  test('ES-06 catalog columns used for relation eligibility', async ({ page }) => {
    const r = await run(page, [
      'CREATE TABLE es6_t (k INTEGER)', 'CREATE TEMP TABLE es6_tt (k INTEGER)', 'CREATE SEQUENCE es6_s', "CREATE TABLE es6_g (k INTEGER, g AS (nextval('es6_s')))", 'CREATE VIEW es6_v AS SELECT 1 AS k',
      "SELECT table_name::VARCHAR, database_name::VARCHAR, schema_name::VARCHAR, (table_oid > 0)::VARCHAR, temporary::VARCHAR, (coalesce(sql, '') ILIKE '%GENERATED%')::VARCHAR FROM duckdb_tables() WHERE table_name LIKE 'es6%' ORDER BY 1",
      "SELECT view_name::VARCHAR, internal::VARCHAR FROM duckdb_views() WHERE view_name = 'es6_v'",
    ]);
    expect(r.slice(0, 5).every(ok)).toBe(true);
    expect(r[5]?.rows).toEqual([
      ['es6_g', 'memory', 'main', 'true', 'false', 'true'],
      ['es6_t', 'memory', 'main', 'true', 'false', 'false'],
      ['es6_tt', 'temp', 'main', 'true', 'true', 'false'],
    ]);
    expect(r[6]?.rows).toEqual([['es6_v', 'false']]);
  });

  test('ES-07 ATTACH :memory:, USE and search_path change name resolution under the lockdown', async ({ page }) => {
    const r = await run(page, ["ATTACH ':memory:' AS es7", 'USE es7', 'SELECT current_database()::VARCHAR', 'USE memory', "SET search_path = 'main'", "SELECT current_setting('search_path')::VARCHAR"]);
    expect(r.map((o) => o.terminal.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(r[2]?.rows).toEqual([['es7']]);
  });

  test('ES-08 CSV: default turns a quoted empty string into NULL; allow_quoted_nulls=false keeps it', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const H = window.__qvHarness!.engine;
      const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
      const h = s.submit('import', async (l) => {
        await l.registerFile('/qv-local/es8.csv', new File(['id,name\n1,""\n2,\n3,x\n'], 'es8.csv'));
        const q = (opts: string) => l.query(`SELECT id::VARCHAR, (name IS NULL)::VARCHAR, coalesce(length(name), -1)::VARCHAR FROM read_csv('/qv-local/es8.csv'${opts}) ORDER BY id`, { maxRows: 10 });
        const def = await q('');
        const strict = await q(', allow_quoted_nulls = false');
        await l.dropFile('/qv-local/es8.csv');
        return { def, strict };
      }, H.BOUNDS);
      return (await h.result).value;
    });
    expect(r?.def).toEqual([['1', 'true', '-1'], ['2', 'true', '-1'], ['3', 'false', '1']]);
    expect(r?.strict).toEqual([['1', 'false', '0'], ['2', 'true', '-1'], ['3', 'false', '1']]);
  });

  test('ES-09 castBigIntToDouble=false: BIGINT arrives as bigint; HUGEINT and DECIMAL never as lossy numbers', async ({ page }) => {
    const types = await page.evaluate(() => window.__qvHarness!.engine.rawValueTypes('SELECT 9007199254740993::BIGINT AS b, 170141183460469231731687303715884105727::HUGEINT AS h, 12345678901234567890.1234567891::DECIMAL(38,10) AS d'));
    const b = types.find((t) => t.name === 'b');
    expect([b?.type, b?.value]).toEqual(['bigint', '9007199254740993']);
    for (const name of ['h', 'd']) expect(types.find((t) => t.name === name)?.type).not.toBe('number');
    const r = await run(page, ['SELECT 170141183460469231731687303715884105727::HUGEINT::VARCHAR, 12345678901234567890.1234567891::DECIMAL(38,10)::VARCHAR']);
    expect(r[0]?.rows).toEqual([['170141183460469231731687303715884105727', '12345678901234567890.1234567891']]);
  });

  test('ES-10 cooperative cancel interrupts a streamed statement; terminate-and-reboot yields a clean engine', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const H = window.__qvHarness!.engine;
      const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
      const h = s.submit('query', (l) => l.query('SELECT sum(hash(range))::VARCHAR FROM range(30000000)', { maxRows: 1 }), H.BOUNDS);
      await new Promise((res) => setTimeout(res, 40));
      const t0 = performance.now();
      h.cancel();
      const c = await h.result;
      const cancelMs = performance.now() - t0;
      const after = await H.sql(s, 'SELECT 42::VARCHAR');
      await H.sql(s, 'CREATE TABLE es10 (k INTEGER)');
      await s.restart('ES-10');
      const fresh = await H.sql(s, "SELECT count(*)::VARCHAR FROM duckdb_tables() WHERE table_name = 'es10'");
      return { c: c.terminal, cancelMs, after: after.rows, gen: s.generation, fresh: fresh.rows };
    });
    expect(r.c).toEqual({ status: 'cancelled', by: 'user', stop: 'cooperative' });
    expect(r.cancelMs).toBeLessThan(2_000);
    expect(r.after).toEqual([['42']]);
    expect(r.gen).toBe(2);
    expect(r.fresh).toEqual([['0']]);
  });

  test('ES-11 DISTINCT … LIMIT runs a full HASH_GROUP_BY (why no such pre-check is used)', async ({ page }) => {
    const r = await run(page, ['CREATE TABLE es11 AS SELECT range::INTEGER AS k FROM range(10)', 'EXPLAIN SELECT DISTINCT k FROM es11 LIMIT 2']);
    const plan = (r[1]?.rows ?? []).map((row) => row.join('\n')).join('\n');
    expect(plan).toContain('HASH_GROUP_BY');
    expect(plan).toMatch(/LIMIT/);
  });

  test('ES-12 prepare() on multi-statement text and the resulting statement classification', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const H = window.__qvHarness!.engine;
      const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
      const texts = ['SELECT 1', 'SELECT 1; SELECT 2', 'CREATE TABLE es12 (x INTEGER)', 'CREATE TABLE es12a (x INTEGER); DROP TABLE es12a', 'SELECT 1; UPDATE es12 SET x = 1', 'INSERT INTO es12 VALUES (1)', 'BEGIN TRANSACTION', 'SELEC 1', 'UPDATE missing_table SET x = 1'];
      const out = [];
      for (const t of texts) {
        const h = s.submit('catalog', async (l) => ({ prepare: await l.prepareCheck(t), cls: await H.classifyStatement(l, t) }), H.BOUNDS);
        const v = (await h.result).value;
        out.push({ t, prepare: v?.prepare, kind: v?.cls.kind, hint: v?.cls.transactionHint });
      }
      const created = await H.sql(s, "SELECT count(*)::VARCHAR FROM duckdb_tables() WHERE table_name IN ('es12', 'es12a')");
      return { out, created: created.rows };
    });
    console.log('ES-12 observations:\n' + r.out.map((o) => `  ${JSON.stringify(o.t)} → prepare ${JSON.stringify(o.prepare)} → ${o.kind}${o.hint ? ` (${o.hint})` : ''}`).join('\n'));
    const kind = Object.fromEntries(r.out.map((o) => [o.t, o.kind]));
    expect(kind['SELECT 1']).toBe('select');
    expect(kind['SELECT 1; SELECT 2']).toBe('multiple');
    expect(kind['CREATE TABLE es12 (x INTEGER)']).toBe('possibly-mutating');
    expect(kind['CREATE TABLE es12a (x INTEGER); DROP TABLE es12a']).toBe('multiple');
    expect(kind['SELECT 1; UPDATE es12 SET x = 1']).toBe('multiple');
    expect(kind['INSERT INTO es12 VALUES (1)']).toBe('possibly-mutating');
    expect(kind['BEGIN TRANSACTION']).toBe('possibly-mutating');
    expect(kind['SELEC 1']).toBe('unparseable');
    expect(r.created).toEqual([['0']]); // classification never executes anything
  });
});
