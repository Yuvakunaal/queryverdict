// Findings 3 and 4: session lifecycle, cancellation, recovery and registration correctness.
// Lifecycle tests use the harness page (EngineSession constructor and fault injection);
// registration tests use the production artifact.
import { expect, test, type Page } from '@playwright/test';
import { openApp, openHarness, run } from './helpers';

const HEAVY = 'SELECT sum(hash(a.range, b.range)) FROM range(200000) a, range(200000) b';

async function workerCount(page: Page) {
  return page.workers().length;
}

// ---------------------------------------------------------------- disposal and late startup

for (const delay of [0, 20, 100, 300]) {
  test(`dispose during start() (after ${delay} ms) wins: no usable engine, worker terminated`, async ({ page }) => {
    await openHarness(page);
    const baseline = await workerCount(page);
    const out = await page.evaluate(async (delay) => {
      const H = window.__qvHarness!;
      const s = new H.EngineSession({ memoryLimit: null, cancelDeadlineMs: 1000 });
      const started = s.start().then(() => 'resolved', (e: unknown) => String(e));
      await new Promise((r) => setTimeout(r, delay));
      await s.dispose();
      const startResult = await started;
      const q = await s.run('SELECT 1');
      return { startResult, state: s.state, info: s.info, q: q.status === 'error' ? q.error : q.status };
    }, delay);
    expect(out.startResult).toMatch(/disposed/i);
    expect(out.state).toBe('disposed');
    expect(out.info).toBeNull();
    expect(out.q).toMatch(/disposed/i);
    await expect.poll(() => workerCount(page)).toBe(baseline);
  });
}

test('dispose during a running query and with queued operations rejects them and terminates the worker', async ({ page }) => {
  await openHarness(page);
  const baseline = await workerCount(page);
  const out = await page.evaluate(async (heavy) => {
    const H = window.__qvHarness!;
    const s = new H.EngineSession({ memoryLimit: null, cancelDeadlineMs: 1000 });
    await s.start();
    const running = s.run(heavy);
    const queued = s.run('SELECT 1');
    await new Promise((r) => setTimeout(r, 200));
    await s.dispose();
    return { running: await running, queued: await queued, state: s.state };
  }, HEAVY);
  expect(out.running.status).toBe('cancelled');
  expect(out.queued.status).toBe('error');
  expect(out.state).toBe('disposed');
  await expect.poll(() => workerCount(page)).toBe(baseline);
});

// ---------------------------------------------------------------- cancellation paths

test('Codex repro: a table import is busy and cancellable; cancelled import leaves no dataset behind', async ({ page }) => {
  await openHarness(page);
  const out = await page.evaluate(async () => {
    const H = window.__qvHarness!;
    const s = new H.EngineSession({ memoryLimit: null, cancelDeadlineMs: 2000 });
    await s.start();
    // ~3 M rows of CSV text, generated in the page (about 30 MB): long enough to cancel.
    const parts: string[] = ['a,b,c\n'];
    for (let i = 0; i < 3_000_000; i++) parts.push(`${i},${i % 97},x${i % 13}\n`);
    const file = new File(parts, 'big.csv');
    const reg = s.registerFile(file, 'table').then(() => 'registered', (e: unknown) => String(e));
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 100 && !s.busy; i++) await new Promise((r) => setTimeout(r, 10));
    const busy = s.busy;
    const state = s.state;
    const report = await s.cancel();
    const regResult = await reg;
    const after = await s.run("SELECT count(*) FROM information_schema.tables WHERE table_name = 'big'");
    return { busy, state, report, regResult, files: s.files.size, after: after.status === 'ok' ? after.result.rows : after.status };
  });
  expect(out.busy).toBe(true);
  expect(out.state).toBe('busy');
  expect(out.report.operation).toBe('register');
  expect(['cooperative', 'terminate']).toContain(out.report.method);
  expect(out.regResult).toMatch(/cancelled/i);
  expect(out.files).toBe(0);
  expect(out.after).toEqual([['0']]);
  test.info().annotations.push({ type: 'import-cancel', description: JSON.stringify(out.report) });
});

test('Codex repro: a rejected cancelSent() falls back to bounded termination and recovery', async ({ page }) => {
  await openHarness(page);
  const out = await page.evaluate(async (heavy) => {
    const H = window.__qvHarness!;
    const s = new H.EngineSession({ memoryLimit: null, cancelDeadlineMs: 500 });
    await s.start();
    const conn = (s as unknown as { engine: { conn: { cancelSent: () => Promise<boolean> } } }).engine.conn;
    conn.cancelSent = () => Promise.reject(new Error('injected cancelSent rejection'));
    const q = s.run(heavy);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = performance.now();
    const report = await s.cancel();
    const elapsed = performance.now() - t0;
    const r = await q;
    const after = await s.run('SELECT 42');
    return { report, elapsed, r: r.status, gen: s.generation, after: after.status === 'ok' ? after.result.rows : after.status, state: s.state };
  }, HEAVY);
  expect(out.report.cooperative).toBe('rejected');
  expect(out.report.method).toBe('terminate');
  expect(out.r).toBe('cancelled');
  expect(out.gen).toBe(2);
  expect(out.after).toEqual([['42']]);
  expect(out.state).toBe('ready');
  expect(out.elapsed).toBeLessThan(10_000);
});

test('a cancelSent() that never answers times out and falls back to termination', async ({ page }) => {
  await openHarness(page);
  const out = await page.evaluate(async (heavy) => {
    const H = window.__qvHarness!;
    const s = new H.EngineSession({ memoryLimit: null, cancelDeadlineMs: 400 });
    await s.start();
    const conn = (s as unknown as { engine: { conn: { cancelSent: () => Promise<boolean> } } }).engine.conn;
    conn.cancelSent = () => new Promise(() => undefined);
    const q = s.run(heavy);
    await new Promise((r) => setTimeout(r, 300));
    const report = await s.cancel();
    await q;
    const after = await s.run('SELECT 1');
    return { report, after: after.status };
  }, HEAVY);
  expect(out.report.cooperative).toBe('timeout');
  expect(out.report.method).toBe('terminate');
  expect(out.report.stopMs).toBeLessThan(1500);
  expect(out.after).toBe('ok');
});

test('cooperative cancel of a query keeps the same engine generation', async ({ page }) => {
  await openHarness(page);
  const out = await page.evaluate(async (heavy) => {
    const H = window.__qvHarness!;
    const s = new H.EngineSession({ memoryLimit: null, cancelDeadlineMs: 2000 });
    await s.start();
    const q = s.run(heavy);
    await new Promise((r) => setTimeout(r, 500));
    const report = await s.cancel();
    return { report, r: (await q).status, gen: s.generation, after: (await s.run('SELECT 1')).status };
  }, HEAVY);
  expect(out.report).toMatchObject({ method: 'cooperative', cooperative: 'accepted', operation: 'query' });
  expect(out.r).toBe('cancelled');
  expect(out.gen).toBe(1);
  expect(out.after).toBe('ok');
});

// ---------------------------------------------------------------- recovery and datasets

test('recovery re-attaches views, marks imported tables needs-reimport, and re-import works', async ({ page }) => {
  await openHarness(page);
  const out = await page.evaluate(async (heavy) => {
    const H = window.__qvHarness!;
    const s = new H.EngineSession({ memoryLimit: null, cancelDeadlineMs: 1000 });
    await s.start();
    const v = (await s.registerFile(new File(['k\n1\n2\n'], 'v.csv'), 'view')).file;
    const t = (await s.registerFile(new File(['k\n1\n2\n3\n'], 't.csv'), 'table')).file;
    const pending = s.run(heavy);
    await new Promise((r) => setTimeout(r, 300));
    await s.restart('test');
    const stale = await pending;
    const statuses = [...s.files.values()].map((f) => [f.relation, f.status]);
    const qv = await s.run('SELECT count(*) FROM v');
    const qt = await s.run('SELECT count(*) FROM t');
    await s.reimport(t.id);
    const qt2 = await s.run('SELECT count(*) FROM t');
    return { stale: stale.status, gen: s.generation, statuses, qv: qv.status === 'ok' ? qv.result.rows : qv.status, qt: qt.status, qt2: qt2.status === 'ok' ? qt2.result.rows : qt2.status, vId: v.id };
  }, HEAVY);
  expect(['cancelled', 'stale']).toContain(out.stale);
  expect(out.gen).toBe(2);
  expect(out.statuses).toEqual([['v', 'attached'], ['t', 'needs-reimport']]);
  expect(out.qv).toEqual([['2']]);
  expect(out.qt).toBe('error'); // not silently present
  expect(out.qt2).toEqual([['3']]);
});

test('failed relation creation rolls back the registered file and metadata', async ({ page }) => {
  await openHarness(page);
  const out = await page.evaluate(async () => {
    const H = window.__qvHarness!;
    const s = new H.EngineSession({ memoryLimit: null, cancelDeadlineMs: 1000 });
    await s.start();
    const db = (s as unknown as { engine: { db: { globFiles: (p: string) => Promise<{ fileName: string }[]> } } }).engine.db;
    const before = (await db.globFiles('/qv-local/*')).length;
    const err = await s.registerFile(new File(['not a parquet file'], 'broken.parquet')).then(() => 'registered', (e: unknown) => String(e));
    const errTable = await s.registerFile(new File(['not a parquet file'], 'broken2.parquet'), 'table').then(() => 'registered', (e: unknown) => String(e));
    const after = (await db.globFiles('/qv-local/*')).length;
    const tables = await s.run("SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'broken%'");
    return { err, errTable, before, after, files: s.files.size, tables: tables.status === 'ok' ? tables.result.rows : tables.status, state: s.state };
  });
  expect(out.err).not.toBe('registered');
  expect(out.errTable).not.toBe('registered');
  expect(out.after).toBe(out.before);
  expect(out.files).toBe(0);
  expect(out.tables).toEqual([['0']]);
  expect(out.state).toBe('ready');
});

// ---------------------------------------------------------------- registration correctness (production artifact)

test('Codex repro: concurrent same.csv registrations (11 and 22) stay independent and independently removable', async ({ page }) => {
  await openApp(page);
  const out = await page.evaluate(async () => {
    const qv = window.__qv!;
    const s = qv.session;
    const [a, b] = await Promise.all([qv.registerText('same.csv', 'v\n11\n'), qv.registerText('same.csv', 'v\n22\n')]);
    const q = async (rel: string) => {
      const r = await s.run(`SELECT v FROM "${rel}"`);
      return r.status === 'ok' ? r.result.rows : r.status === 'error' ? r.error : r.status;
    };
    const res: Record<string, unknown> = { relA: a.relation, relB: b.relation, qa: await q(a.relation), qb: await q(b.relation) };
    await s.dropFile(a.id);
    res.afterDropA = { listed: [...s.files.values()].map((f) => f.relation), qa: await q(a.relation), qb: await q(b.relation) };
    await s.dropFile(b.id);
    res.afterDropB = { listed: [...s.files.values()].map((f) => f.relation), qb: await q(b.relation) };
    return res;
  });
  expect(out.relA).toBe('same');
  expect(out.relB).toBe('same_2');
  expect(out.qa).toEqual([['11']]);
  expect(out.qb).toEqual([['22']]);
  expect(out.afterDropA).toMatchObject({ listed: ['same_2'], qb: [['22']] });
  expect(String((out.afterDropA as { qa: unknown }).qa)).toMatch(/does not exist/);
  expect(out.afterDropB).toMatchObject({ listed: [] });
  expect(String((out.afterDropB as { qb: unknown }).qb)).toMatch(/does not exist/);
});

test('registration never replaces an existing user table, and overlapping registration/removal stays consistent', async ({ page }) => {
  await openApp(page);
  const out = await page.evaluate(async () => {
    const qv = window.__qv!;
    const s = qv.session;
    await s.run('CREATE TABLE mine AS SELECT 99 AS v');
    const m = await qv.registerText('mine.csv', 'v\n1\n');
    const first = await qv.registerText('x.csv', 'v\n1\n');
    // Overlap: remove x while registering two more files named x.csv.
    const [, x2, x3] = await Promise.all([s.dropFile(first.id), qv.registerText('x.csv', 'v\n2\n'), qv.registerText('x.csv', 'v\n3\n')]);
    const val = async (rel: string) => {
      const r = await s.run(`SELECT v FROM "${rel}"`);
      return r.status === 'ok' ? r.result.rows[0]?.[0] : r.status;
    };
    const catalog = await s.run("SELECT table_name FROM information_schema.tables ORDER BY 1");
    return {
      mineRel: m.relation, mineUser: await val('mine'), mineFile: await val(m.relation),
      x2: [x2.relation, await val(x2.relation)], x3: [x3.relation, await val(x3.relation)],
      listed: [...s.files.values()].map((f) => f.relation).sort(),
      catalog: catalog.status === 'ok' ? catalog.result.rows.map((r) => r[0]) : catalog.status,
    };
  });
  expect(out.mineRel).toBe('mine_2');
  expect(out.mineUser).toBe('99');
  expect(out.mineFile).toBe('1');
  expect(out.x2[1]).toBe('2');
  expect(out.x3[1]).toBe('3');
  expect(out.x2[0]).not.toBe(out.x3[0]);
  expect(out.listed).toEqual([out.mineRel, out.x2[0], out.x3[0]].sort());
  expect(out.catalog).toEqual(['mine', out.mineRel, out.x2[0], out.x3[0]].sort());
});

test('concurrent queries are serialized and each returns its own result', async ({ page }) => {
  await openApp(page);
  const out = await page.evaluate(async () => {
    const s = window.__qv!.session;
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => s.run(`SELECT ${i} AS n`)));
    return rs.map((r) => (r.status === 'ok' ? r.result.rows[0]?.[0] : r.status));
  });
  expect(out).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
});

test('UI: Codex repro run through the file input (same.csv twice in one selection)', async ({ page }) => {
  await openApp(page);
  // Two different files that share a name, selected together.
  await page.getByTestId('file-input').setInputFiles([
    { name: 'same.csv', mimeType: 'text/csv', buffer: Buffer.from('v\n11\n') },
    { name: 'same.csv', mimeType: 'text/csv', buffer: Buffer.from('v\n22\n') },
  ]);
  await expect(page.getByTestId('file-list').locator('li')).toHaveCount(2);
  const vals = await page.evaluate(async () => {
    const s = window.__qv!.session;
    const out: string[] = [];
    for (const f of s.files.values()) {
      const r = await s.run(`SELECT v FROM "${f.relation}"`);
      out.push(r.status === 'ok' ? `${f.relation}=${r.result.rows[0]?.[0]}` : r.status);
    }
    return out.sort();
  });
  expect(vals).toEqual(['same=11', 'same_2=22']);
  expect((await run(page, 'SELECT 1')).status).toBe('ok');
});
