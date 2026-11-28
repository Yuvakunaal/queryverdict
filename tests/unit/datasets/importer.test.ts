// Importer and registry against the scripted stand-in engine (M02 fake driver). Asserts the exact
// engine calls, so cleanup order, refusals and stale-result handling are visible.
import { afterEach, describe, expect, it } from 'vitest';
import { createDatasets } from '../../../src/core/datasets/registry';
import { EngineSession } from '../../../src/core/engine/session';
import { DEFAULT_PROFILE, type ReleaseProfile } from '../../../src/core/profile/profile';
import { FakeDriver, type FakeInstance } from '../engine/fake-driver';

const PROFILE: ReleaseProfile = { ...DEFAULT_PROFILE, imports: { ...DEFAULT_PROFILE.imports, maxFileBytes: 1_000, maxCombinedBytes: 1_500 } };
let session: EngineSession;
let driver: FakeDriver;

/** Catalog answers: an in-memory list of created tables, keyed by oid. */
function engine(inst: FakeInstance, opts: { failCreate?: boolean; stallCreate?: boolean; beginFails?: boolean; userTransaction?: boolean; aborted?: boolean } = {}) {
  const tables: { name: string; oid: string }[] = [];
  let pending: string | null = null;
  let txid = 0;
  inst.handler = (sql) => {
    if (sql === 'SELECT txid_current()::VARCHAR') {
      if (opts.aborted) return new Error('TransactionContext Error: Current transaction is aborted (please ROLLBACK)');
      return [[String(opts.userTransaction ? 7 : (txid += 2))]];
    }
    if (sql.includes('duckdb_keywords()')) return [['select'], ['order']];
    if (sql.startsWith('SELECT lower(name)')) return tables.map((t) => [t.name.toLowerCase()]);
    if (sql === 'BEGIN TRANSACTION') return opts.beginFails ? new Error('TransactionContext Error: cannot start a transaction within a transaction') : [];
    if (sql.startsWith('CREATE TABLE')) {
      if (opts.stallCreate) return 'stall';
      if (opts.failCreate) return new Error('Invalid Input Error: Error when sniffing file');
      pending = /^CREATE TABLE "((?:[^"]|"")+)"/.exec(sql)?.[1]?.replaceAll('""', '"') ?? null;
      return [];
    }
    if (sql === 'COMMIT') {
      // The catalog id is assigned at CREATE and kept by COMMIT (as in DuckDB).
      if (pending) tables.push({ name: pending, oid: String(100 + tables.length) });
      pending = null;
      return [];
    }
    if (sql === 'ROLLBACK') { pending = null; return []; }
    if (sql.includes('UNION ALL SELECT view_oid::VARCHAR FROM duckdb_views()')) {
      const name = /table_name = '((?:[^']|'')+)'/.exec(sql)?.[1]?.replaceAll("''", "'");
      const t = tables.find((x) => x.name === name);
      return t ? [[t.oid]] : [];
    }
    if (sql.includes('FROM duckdb_tables() WHERE table_name =')) {
      const name = /table_name = '((?:[^']|'')+)'/.exec(sql)?.[1]?.replaceAll("''", "'");
      const t = tables.find((x) => x.name === name);
      // Inside the import's own transaction its new table is visible to it, with its final id.
      if (!t && pending === name) return [['memory', 'main', String(100 + tables.length)]];
      return t ? [['memory', 'main', t.oid]] : [];
    }
    if (sql.startsWith('SELECT count(*)')) return [['3']];
    if (sql.startsWith('SELECT current_database()')) return [['memory', 'main']];
    if (sql.startsWith("SELECT 'table'")) return tables.map((t) => ['table', 'memory', 'main', t.name, t.oid, 'false', 'false']);
    if (sql.includes('duckdb_columns()')) return [];
    return undefined;
  };
  return tables;
}

async function setup(opts: Parameters<typeof engine>[1] = {}) {
  driver = new FakeDriver();
  session = new EngineSession({ driver, bootMs: 5_000, recoveryMs: 5_000, memoryLimit: '1GB' });
  await session.start();
  const tables = engine(driver.current, opts);
  return { ...createDatasets(session, PROFILE), tables };
}

const csv = (name: string, body = 'a\n1\n') => new File([body], name);
afterEach(() => session?.dispose());

describe('importer (stand-in engine)', () => {
  it('imports transactionally: register, BEGIN, CREATE, COMMIT, drop file; records the dataset and bumps the epoch', async () => {
    const { importer, registry } = await setup();
    const epoch = session.epoch;
    const { handles, progress } = importer.import([{ file: csv('Orders.csv') }]);
    const r = await handles[0]!.result;
    expect(r.terminal.status).toBe('ok');
    expect(r.value).toMatchObject({ relation: 'orders', origin: 'imported', state: 'ready', verdictEligible: true, rowCount: '3', source: { fileName: 'Orders.csv', format: 'csv' } });
    const calls = driver.current.calls.filter((c) => !c.startsWith('SELECT') && !/^(SET|INSTALL|LOAD) /.test(c));
    expect(calls.map((c) => c.replace(/\/qv-local\/[0-9a-f-]+/, '/qv-local/<id>').replace(/read_csv\(.*$/, 'read_csv(…)'))).toEqual([
      'REGISTER /qv-local/<id>.csv', 'BEGIN TRANSACTION', 'CREATE TABLE "orders" AS SELECT * FROM read_csv(…)', 'COMMIT', 'DROP FILE /qv-local/<id>.csv',
    ]);
    expect(driver.current.calls.find((c) => c.startsWith('CREATE TABLE'))).toContain('allow_quoted_nulls = false');
    expect(session.epoch).toBeGreaterThan(epoch);
    expect(progress.getSnapshot()[0]).toMatchObject({ stage: 'done', relation: 'orders' });
    await registry.reconcile();
    expect(registry.getSnapshot().map((e) => [e.relation, e.origin, e.state])).toEqual([['orders', 'imported', 'ready']]);
  });

  it('a failed CREATE leaves no table and no registered file: ROLLBACK then drop file, run by the session', async () => {
    const { importer, tables } = await setup({ failCreate: true });
    const r = await importer.import([{ file: csv('bad.csv') }]).handles[0]!.result;
    expect(r.terminal).toMatchObject({ status: 'error' });
    const tail = driver.current.calls.filter((c) => !c.startsWith('SELECT')).slice(-2).map((c) => c.replace(/\/qv-local\/[0-9a-f-]+/, '/qv-local/<id>'));
    expect(tail).toEqual(['ROLLBACK', 'DROP FILE /qv-local/<id>.csv']);
    expect(tables).toEqual([]);
  });

  it('cancelling an active import rolls back and unregisters the file', async () => {
    const { importer, tables } = await setup({ stallCreate: true });
    const { handles, progress } = importer.import([{ file: csv('slow.csv') }]);
    await new Promise((r) => setTimeout(r, 20));
    handles[0]!.cancel();
    const r = await handles[0]!.result;
    expect(r.terminal).toEqual({ status: 'cancelled', by: 'user', stop: 'cooperative' });
    expect(driver.current.calls.filter((c) => !c.startsWith('SELECT')).slice(-2).map((c) => c.replace(/\/qv-local\/[0-9a-f-]+/, '<f>'))).toEqual(['ROLLBACK', 'DROP FILE <f>.csv']);
    expect(tables).toEqual([]);
    expect(progress.getSnapshot()[0]?.stage).toBe('cancelled');
  });

  it('cancelling a queued import does no engine work', async () => {
    const { importer } = await setup({ stallCreate: true });
    const first = importer.import([{ file: csv('one.csv') }]).handles[0]!;
    const second = importer.import([{ file: csv('two.csv') }]).handles[0]!;
    second.cancel();
    expect((await second.result).terminal).toEqual({ status: 'cancelled', by: 'user', stop: 'cooperative' });
    first.cancel();
    await first.result;
    expect(driver.current.calls.some((c) => c.includes('"two"'))).toBe(false);
  });

  for (const [label, opts] of [
    ['open (same txid twice)', { userTransaction: true }],
    ['aborted (txid errors)', { aborted: true }],
    ['undetected, BEGIN fails', { beginFails: true }],
  ] as const) {
    it(`a user transaction that is ${label} refuses the import without touching it (QV-ENG-013c)`, async () => {
      const { importer } = await setup(opts);
      const r = await importer.import([{ file: csv('t.csv') }]).handles[0]!.result;
      expect(r.terminal).toMatchObject({ status: 'refused', reason: expect.stringContaining('transaction is open') });
      expect(driver.current.calls.some((c) => c === 'ROLLBACK')).toBe(false); // never ROLLBACK a transaction it does not own
      // A nested BEGIN aborts the user's transaction in DuckDB, so it must not be issued when one is detected.
      expect(driver.current.calls.includes('BEGIN TRANSACTION')).toBe(label.startsWith('undetected'));
      expect(driver.current.calls.filter((c) => !c.startsWith('SELECT')).at(-1)).toMatch(/^DROP FILE \/qv-local\//);
    });
  }

  it('refused admissions never reach the engine', async () => {
    const { importer } = await setup();
    const before = driver.current.calls.length;
    const { handles, progress } = importer.import([{ file: csv('a.json') }, { file: new File(['x'.repeat(1_001)], 'big.csv') }, { file: new File([], 'empty.csv') }]);
    for (const h of handles) expect((await h.result).terminal.status).toBe('refused');
    expect(driver.current.calls.length).toBe(before);
    expect(progress.getSnapshot().map((p) => p.stage)).toEqual(['failed', 'failed', 'failed']);
  });

  it('same file name twice, even concurrently, gives independent relations (Phase 3 registration defect)', async () => {
    const { importer } = await setup();
    const { handles } = importer.import([{ file: csv('orders.csv', 'a\n1\n') }, { file: csv('orders.csv', 'a\n2\n') }]);
    const third = importer.import([{ file: csv('ORDERS.csv') }]).handles[0]!;
    const names = [];
    for (const h of [...handles, third]) names.push((await h.result).value?.relation);
    expect(names).toEqual(['orders', 'orders_2', 'orders_3']);
  });

  it('reserved words and requested names: no silent overwrite or rename', async () => {
    const { importer } = await setup();
    expect((await importer.import([{ file: csv('order.csv') }]).handles[0]!.result).value?.relation).toBe('order_data');
    expect((await importer.import([{ file: csv('a.csv'), requestedName: 'sales' }]).handles[0]!.result).value?.relation).toBe('sales');
    const dup = await importer.import([{ file: csv('b.csv'), requestedName: 'sales' }]).handles[0]!.result;
    expect(dup.terminal).toMatchObject({ status: 'refused', reason: expect.stringContaining('already exists') });
    const bad = await importer.import([{ file: csv('c.csv'), requestedName: 'x; DROP TABLE sales' }]).handles[0]!.result;
    expect(bad.terminal.status).toBe('refused');
  });

  it('a result from a replaced engine is never published (stale)', async () => {
    const { importer, registry } = await setup({ stallCreate: true });
    const h = importer.import([{ file: csv('late.csv') }]).handles[0]!;
    await new Promise((r) => setTimeout(r, 20));
    await session.restart('test');
    const r = await h.result;
    expect(r.terminal).toEqual({ status: 'stale', reason: 'generation-changed' });
    expect(registry.getSnapshot()).toEqual([]);
  });
});

describe('registry (stand-in engine)', () => {
  it('after recovery an import needs re-import; re-import succeeds; removal drops it and bumps the epoch', async () => {
    const { importer, registry } = await setup();
    await importer.import([{ file: csv('orders.csv') }]).handles[0]!.result;
    await session.restart('test');
    engine(driver.current); // fresh engine: no tables
    await registry.reconcile();
    expect(registry.getSnapshot()[0]).toMatchObject({ relation: 'orders', state: 'needs-reimport' });
    const re = await registry.reimport('orders').result;
    expect(re.terminal.status).toBe('ok');
    await registry.reconcile();
    expect(registry.getSnapshot()[0]).toMatchObject({ relation: 'orders', state: 'ready' });
    const epoch = session.epoch;
    const rm = await registry.remove('orders').result;
    expect(rm.terminal.status).toBe('ok');
    expect(session.epoch).toBeGreaterThan(epoch);
    expect(driver.current.calls.some((c) => c === 'DROP TABLE "memory"."main"."orders"')).toBe(true);
    expect(registry.getSnapshot().find((e) => e.origin === 'imported')).toBeUndefined();
  });

  it('a re-import whose file can no longer be read is reported as failed and asks for the file again', async () => {
    const { importer, registry } = await setup();
    const file = csv('orders.csv');
    await importer.import([{ file }]).handles[0]!.result;
    await session.restart('test');
    engine(driver.current);
    (file as unknown as { slice: () => unknown }).slice = () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) });
    const r = await registry.reimport('orders').result;
    expect(r.terminal).toMatchObject({ status: 'error', message: expect.stringContaining('Choose the file again') });
    await registry.reconcile();
    expect(registry.getSnapshot()[0]).toMatchObject({ state: 'failed', reason: expect.stringContaining('Choose the file again') });
  });
});

describe('Codex M04 review regressions (stand-in engine)', () => {
  it('the combined limit holds across overlapping batches: the later file is refused inside its operation, before registration', async () => {
    const { importer } = await setup({ stallCreate: false });
    // 1,500 combined (PROFILE): 800 + 800 exceeds it. Both pass the early check (each batch alone fits).
    const a = importer.import([{ file: new File(['x'.repeat(800)], 'a.csv') }]).handles[0]!;
    const b = importer.import([{ file: new File(['y'.repeat(800)], 'b.csv') }]).handles[0]!;
    expect((await a.result).terminal.status).toBe('ok');
    const rb = await b.result;
    expect(rb.terminal).toMatchObject({ status: 'refused', reason: expect.stringMatching(/combined limit/) });
    expect(driver.current.calls.filter((c) => c.startsWith('REGISTER')).length).toBe(1);
  });

  it('re-import after a restart counts against the combined limit held by the new engine', async () => {
    const { importer, registry } = await setup();
    await importer.import([{ file: new File(['x'.repeat(800)], 'lost.csv') }]).handles[0]!.result;
    await session.restart('test');
    engine(driver.current);
    await importer.import([{ file: new File(['y'.repeat(800)], 'resident.csv') }]).handles[0]!.result;
    const r = await registry.reimport('lost').result;
    expect(r.terminal).toMatchObject({ status: 'refused', reason: expect.stringMatching(/combined limit/) });
    expect(driver.current.calls.filter((c) => c.startsWith('REGISTER')).length).toBe(1);
  });

  it('removal is refused when the selected table was replaced after selection (identity re-checked in the lease)', async () => {
    const { importer, registry, tables } = await setup();
    await importer.import([{ file: csv('orders.csv') }]).handles[0]!.result;
    await registry.reconcile();
    const e = registry.getSnapshot()[0]!;
    tables[0]!.oid = '999'; // replaced by SQL meanwhile
    const r = await registry.remove('orders', { origin: e.origin, database: e.identity!.database, schema: e.identity!.schema, oid: e.identity!.oid }).result;
    expect(r.terminal).toMatchObject({ status: 'refused', reason: expect.stringMatching(/replaced or removed after it was selected/) });
    expect(driver.current.calls.some((c) => c.startsWith('DROP TABLE'))).toBe(false);
  });

  it('a bare name that matches more than one dataset is refused rather than guessed', async () => {
    const { registry } = await setup();
    const reg = registry as unknown as { getSnapshot(): unknown[] };
    const twin = (schema: string, oid: string) => ({ relation: 'same', kind: 'table', origin: 'sql', state: 'ready', identity: { database: 'memory', schema, oid }, verdictEligible: false });
    reg.getSnapshot = () => [twin('aaa', '1'), twin('bbb', '2')];
    expect((await registry.remove('same').result).terminal).toMatchObject({ status: 'refused', reason: expect.stringMatching(/More than one dataset/) });
  });
});

