// Functional checks of the PRODUCTION artifact served from the GitHub Pages-style subpath
// (/queryverdict/) with no COOP/COEP or CSP headers. Security: security.spec.ts.
// Lifecycle/registration: lifecycle.spec.ts. Result budgets: bounded.spec.ts.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP, captureRequests, openApp, run } from './helpers';

const ROOT = join(import.meta.dirname, '..', '..');
const TINY = join(ROOT, 'data', 'tiny');
const manifest = () => JSON.parse(readFileSync(join(TINY, 'manifest.json'), 'utf8')) as { expected: Record<string, number> };

test('boots from the Pages subpath without cross-origin isolation, verified lockdown, assets same-origin only', async ({ page, context }) => {
  const requests = await captureRequests(context);
  const info = await openApp(page);
  expect(info.crossOriginIsolated).toBe(false);
  expect(info.bundle).toBe('eh');
  expect(info.duckdbVersion).toBe('v1.5.4');
  expect(info.lockdownVerified).toBe(true);
  expect(info.verification.ok).toBe(true);
  expect(info.verification.loadedExtensions).toEqual(['core_functions', 'json', 'parquet']);
  const urls = requests.map((r) => r.url());
  expect(urls.every((u) => u.startsWith(APP))).toBe(true);
  expect(urls.some((u) => /duckdb-eh-.*\.wasm$/.test(u))).toBe(true);
  await expect(page.getByTestId('session-state')).toContainText('ready');
  const r = await run(page, 'SELECT 41 + 1 AS answer');
  expect(r.status === 'ok' && r.result.rows).toEqual([['42']]);
  // The engine's own SQL parser (needed later for query analysis, E5) works under lockdown.
  const ast = await run(page, "SELECT json_serialize_sql('SELECT o.id FROM o JOIN c ON o.k = c.k')::VARCHAR");
  expect(ast.status === 'ok' && ast.result.rows[0]?.[0]).toContain('JOIN');
});

test('registers CSV, NDJSON and Parquet through the file input; schema, preview and counts are correct', async ({ page }) => {
  await openApp(page);
  const e = manifest().expected;
  await page.getByTestId('file-input').setInputFiles([join(TINY, 'orders.csv'), join(TINY, 'orders.ndjson'), join(TINY, 'orders.parquet'), join(TINY, 'customers.parquet')]);
  await expect(page.getByTestId('file-list').locator('li')).toHaveCount(4);
  const byFormat = await page.evaluate(() => Object.fromEntries([...window.__qv!.session.files.values()].map((f) => [f.name, f.relation])));
  expect(Object.keys(byFormat).sort()).toEqual(['customers.parquet', 'orders.csv', 'orders.ndjson', 'orders.parquet']);
  expect(new Set(Object.values(byFormat)).size).toBe(4);
  for (const name of ['orders.csv', 'orders.ndjson', 'orders.parquet']) {
    const rel = byFormat[name]!;
    const d = await page.evaluate((r) => window.__qv!.session.describe(r), rel);
    expect(d.status).toBe('ok');
    if (d.status === 'ok') expect(d.result.rows.map((x) => x[0])).toEqual(['order_id', 'customer_id', 'order_ts', 'status', 'region', 'quantity', 'amount', 'note']);
    const c = await run(page, `SELECT count(*), sum(round(amount * 100))::HUGEINT FROM "${rel}"`);
    expect(c.status === 'ok' && c.result.rows[0]).toEqual([String(e.orders_rows), String(e.orders_amount_cents_sum)]);
  }
  const pq = await page.evaluate((r) => window.__qv!.session.describe(r), byFormat['orders.parquet']!);
  expect(pq.status === 'ok' && pq.result.rows.find((r) => r[0] === 'amount')?.[1]).toBe('DECIMAL(7,2)');
  const j = await run(page, `SELECT count(*) FROM "${byFormat['orders.csv']}" o JOIN "${byFormat['customers.parquet']}" c ON o.customer_id = c.customer_id`);
  expect(j.status === 'ok' && j.result.rows[0]?.[0]).toBe(String(e.inner_join_rows));
});

test('errors are reported and the engine stays usable', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('sql').fill('SELEC nonsense');
  await page.getByTestId('run').click();
  await expect(page.getByTestId('result-error')).toContainText('Parser Error');
  const missing = await run(page, 'SELECT * FROM no_such_table');
  expect(missing.status === 'error' && missing.error).toContain('no_such_table');
  const bad = await page.evaluate(() => window.__qv!.registerText('notes.xlsx', 'x').then(() => 'ok', (e: unknown) => String(e)));
  expect(bad).toContain('Unsupported file type');
  const broken = await page.evaluate(() => window.__qv!.registerText('broken.parquet', 'not a parquet file').then(() => 'registered', (e: unknown) => String(e)));
  expect(broken).not.toBe('registered');
  expect(await page.evaluate(() => window.__qv!.session.files.size)).toBe(0);
  expect((await run(page, 'SELECT 1')).status).toBe('ok');
});

test('cancellation from the UI stops a long query and the engine stays usable', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('sql').fill('SELECT sum(hash(a.range, b.range)) FROM range(200000) a, range(200000) b');
  await page.getByTestId('run').click();
  await expect(page.getByRole('status')).toContainText('Running');
  await page.waitForTimeout(500);
  await page.getByTestId('cancel').click();
  await expect(page.getByTestId('result-status')).toContainText('cancelled');
  expect((await run(page, 'SELECT 1')).status).toBe('ok');
});

test('removing a dataset releases the relation and the registered file', async ({ page }) => {
  await openApp(page);
  const rf = await page.evaluate(() => window.__qv!.registerText('gone.csv', 'k\n1\n'));
  await page.evaluate((id) => window.__qv!.session.dropFile(id), rf.id);
  const q = await run(page, 'SELECT * FROM gone');
  expect(q.status).toBe('error');
  expect(await page.evaluate(() => window.__qv!.session.files.size)).toBe(0);
});
