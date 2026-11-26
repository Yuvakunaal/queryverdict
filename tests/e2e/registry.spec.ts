// M03 dataset registry against the real engine: the inventory is derived from the live catalog
// (QV-ENG-011); SQL-created, dropped, renamed and replaced relations are detected; views are never
// Verdict-eligible; removal; needs-reimport after engine replacement (never auto-restored);
// re-import success and failure; stale catalog snapshots are never published.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HARNESS } from './helpers';

const FIX = path.resolve('tests/fixtures/import');
const EXPECTED = JSON.parse(readFileSync(path.join(FIX, 'expected.json'), 'utf8')) as Record<string, { rows: (string | null)[][] }>;
const PEOPLE = readFileSync(path.join(FIX, 'people.csv')).toString('base64');

type Entry = { relation: string; kind: string; origin: string; state: string; verdictEligible: boolean; rowCount?: string; reason?: string; eligibilityReason?: string; columns?: { name: string; type: string }[] };

async function open(page: Page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__qvHarness?.datasets !== undefined);
  await page.evaluate(() => window.__qvHarness!.datasets!.setup());
}

/** Imports people.csv (as `people` unless the name is taken) and returns its relation. */
function importPeople(page: Page) {
  return page.evaluate(async (data) => {
    const D = window.__qvHarness!.datasets!;
    const r = await D.current().datasets.importer.import([{ file: D.file('people.csv', data) }]).handles[0]!.result;
    return r.value?.relation;
  }, PEOPLE);
}

/** Runs SQL as a user would, then reconciles (the SQL editor will mark data changed in M04). */
function sqlThenReconcile(page: Page, statements: string[]): Promise<Entry[]> {
  return page.evaluate(async (statements) => {
    const D = window.__qvHarness!.datasets!;
    const { session, datasets } = D.current();
    for (const q of statements) {
      const r = await D.sql(session, q);
      if (r.terminal.status !== 'ok') throw new Error(`${q}: ${JSON.stringify(r.terminal)}`);
    }
    session.markDataChanged();
    await datasets.registry.reconcile();
    return datasets.registry.getSnapshot() as unknown as Entry[];
  }, statements);
}
const by = (entries: Entry[], relation: string) => entries.find((e) => e.relation === relation);

test.describe('dataset registry (M03)', () => {
  test('imported and SQL-created relations with schema, row counts and eligibility; views are never eligible', async ({ page }) => {
    await open(page);
    expect(await importPeople(page)).toBe('people');
    const e = await sqlThenReconcile(page, ['CREATE TABLE t_sql AS SELECT 1::INTEGER AS a', 'CREATE VIEW v_people AS SELECT * FROM people', 'CREATE TEMP TABLE t_tmp AS SELECT 1 AS b']);
    expect(by(e, 'people')).toMatchObject({ origin: 'imported', state: 'ready', verdictEligible: true, columns: [{ name: 'id', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }, { name: 'city', type: 'VARCHAR' }, { name: 'note', type: 'VARCHAR' }] });
    expect(by(e, 't_sql')).toMatchObject({ origin: 'sql', kind: 'table', state: 'ready', verdictEligible: true, columns: [{ name: 'a', type: 'INTEGER' }] });
    expect(by(e, 't_tmp')).toMatchObject({ origin: 'sql', verdictEligible: true });
    expect(by(e, 'v_people')).toMatchObject({ origin: 'sql', kind: 'view', verdictEligible: false, eligibilityReason: expect.stringMatching(/Views/) });
    // The row count measured at import is withheld once data may have changed (epoch moved on).
    expect(by(e, 'people')?.rowCount).toBeUndefined();
  });

  test('the row count is reported while the data epoch is unchanged', async ({ page }) => {
    await open(page);
    await importPeople(page);
    const e = await page.evaluate(async () => {
      const { datasets } = window.__qvHarness!.datasets!.current();
      await datasets.registry.reconcile();
      return datasets.registry.getSnapshot() as unknown as Entry[];
    });
    expect(by(e, 'people')?.rowCount).toBe('4');
  });

  test('dropped by SQL → missing; renamed → missing plus a SQL table; replaced → changed', async ({ page }) => {
    await open(page);
    await importPeople(page);
    expect(by(await sqlThenReconcile(page, ['DROP TABLE people']), 'people')).toMatchObject({ origin: 'imported', state: 'missing', verdictEligible: false });
    expect(await importPeople(page)).toBe('people');
    const renamed = await sqlThenReconcile(page, ['ALTER TABLE people RENAME TO people_r']);
    expect(by(renamed, 'people')?.state).toBe('missing');
    expect(by(renamed, 'people_r')).toMatchObject({ origin: 'sql', state: 'ready' });
    await sqlThenReconcile(page, ['DROP TABLE people_r']);
    await page.evaluate(() => window.__qvHarness!.datasets!.current().datasets.registry.remove('people').result);
    expect(await importPeople(page)).toBe('people');
    const replaced = await sqlThenReconcile(page, ['CREATE OR REPLACE TABLE people AS SELECT 1 AS x']);
    expect(by(replaced, 'people')).toMatchObject({ origin: 'imported', state: 'changed', columns: [{ name: 'x', type: 'INTEGER' }] });
  });

  test('removal drops the relation, advances the epoch and forgets the import; views and SQL tables can be removed', async ({ page }) => {
    await open(page);
    await importPeople(page);
    await sqlThenReconcile(page, ['CREATE VIEW v AS SELECT 1 AS a']);
    const r = await page.evaluate(async () => {
      const D = window.__qvHarness!.datasets!;
      const { session, datasets } = D.current();
      const epoch = session.epoch;
      const a = (await datasets.registry.remove('people').result).terminal.status;
      const b = (await datasets.registry.remove('v').result).terminal.status;
      const c = (await datasets.registry.remove('nope').result).terminal.status;
      await datasets.registry.reconcile();
      return { a, b, c, epochAdvanced: session.epoch > epoch, tables: await D.tables(), entries: datasets.registry.getSnapshot().map((e) => e.relation), registered: D.registeredFiles.size };
    });
    expect(r).toEqual({ a: 'ok', b: 'ok', c: 'refused', epochAdvanced: true, tables: [], entries: [], registered: 0 });
  });

  test('removal is refused, without touching it, while a user transaction is open', async ({ page }) => {
    await open(page);
    await importPeople(page);
    const r = await page.evaluate(async () => {
      const D = window.__qvHarness!.datasets!;
      const { session, datasets } = D.current();
      await D.sql(session, 'BEGIN TRANSACTION');
      await D.sql(session, 'CREATE TABLE mine AS SELECT 1 AS v');
      const t = (await datasets.registry.remove('people').result).terminal;
      const inside = (await D.sql(session, 'SELECT count(*)::VARCHAR FROM people')).rows;
      await D.sql(session, 'COMMIT');
      return { t, inside, tables: await D.tables() };
    });
    expect(r).toMatchObject({ t: { status: 'refused', reason: expect.stringMatching(/transaction is open/) }, inside: [['4']], tables: ['mine', 'people'] });
  });

  test('after engine replacement imports need re-import (not restored); re-import restores exact values', async ({ page }) => {
    await open(page);
    await importPeople(page);
    await sqlThenReconcile(page, ['CREATE TABLE t_sql AS SELECT 1 AS a']);
    const after = await page.evaluate(async () => {
      const D = window.__qvHarness!.datasets!;
      const { session, datasets } = D.current();
      await session.restart('test: worker replaced');
      await datasets.registry.reconcile();
      return { generation: session.generation, tables: await D.tables(), entries: datasets.registry.getSnapshot() as unknown as Entry[] };
    });
    expect(after.generation).toBe(2);
    expect(after.tables).toEqual([]); // nothing restored automatically
    expect(after.entries).toEqual([expect.objectContaining({ relation: 'people', state: 'needs-reimport', verdictEligible: false })]); // the SQL table is simply gone
    const re = await page.evaluate(async () => {
      const { datasets } = window.__qvHarness!.datasets!.current();
      const t = (await datasets.registry.reimport('people').result).terminal.status;
      const again = (await datasets.registry.reimport('people').result).terminal;
      return { t, again, entry: datasets.registry.getSnapshot()[0] as unknown as Entry };
    });
    expect(re).toMatchObject({ t: 'ok', again: { status: 'refused' }, entry: { relation: 'people', state: 'ready', verdictEligible: true } });
    const d = await page.evaluate(() => window.__qvHarness!.datasets!.dump('people'));
    expect(d.rows).toEqual(EXPECTED['people.csv']!.rows);
  });

  test('a re-import that cannot use its name fails visibly, keeps the record and never overwrites', async ({ page }) => {
    await open(page);
    await importPeople(page);
    const r = await page.evaluate(async () => {
      const D = window.__qvHarness!.datasets!;
      const { session, datasets } = D.current();
      await session.restart('test');
      await D.sql(session, 'CREATE TABLE people AS SELECT 42 AS mine');
      const t = (await datasets.registry.reimport('people').result).terminal;
      session.markDataChanged();
      await datasets.registry.reconcile();
      const entries = datasets.registry.getSnapshot() as unknown as Entry[];
      return { t, entries, mine: (await D.sql(session, 'SELECT mine::VARCHAR FROM people')).rows };
    });
    expect(r.t).toMatchObject({ status: 'refused', reason: expect.stringMatching(/already exists/) });
    expect(r.mine).toEqual([['42']]);
    // The user's SQL table of the same name is shown as its own (sql) entry; the import is failed.
    expect(r.entries.find((e) => e.origin === 'imported')).toMatchObject({ relation: 'people', state: 'failed', reason: expect.stringMatching(/already exists/) });
    expect(r.entries.find((e) => e.origin === 'sql')).toMatchObject({ relation: 'people', state: 'ready' });
  });

  test('a catalog snapshot read on an engine that is then replaced is never published (stale)', async ({ page }) => {
    await open(page);
    await importPeople(page);
    const r = await page.evaluate(async () => {
      const D = window.__qvHarness!.datasets!;
      const { session, datasets } = D.current();
      D.faults.hold = /duckdb_columns\(\)/;
      const pending = datasets.registry.reconcile();
      await D.waitFor(() => D.held.length === 1);
      D.faults.hold = null;
      const generation = session.generation;
      await session.restart('test: replaced during catalog read');
      await pending;
      await datasets.registry.reconcile();
      return { from: generation, to: session.generation, entries: datasets.registry.getSnapshot() as unknown as Entry[] };
    });
    expect(r.to).toBe((r.from ?? 0) + 1);
    expect(r.entries).toEqual([expect.objectContaining({ relation: 'people', state: 'needs-reimport' })]);
  });
});
