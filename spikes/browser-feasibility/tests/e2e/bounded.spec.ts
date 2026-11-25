// Finding 2: result budgets enforced before display conversion, on real DuckDB-WASM results.
import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers';

type Lim = Partial<{ maxRows: number; maxArrowBytes: number; maxDisplayChars: number; maxColumns: number; maxCellChars: number }>;

const runL = (page: Page, sql: string, lim: Lim) => page.evaluate(([s, l]) => window.__qv!.session.run(s as string, l as Lim), [sql, lim] as const);

test('Codex repro: a 2 MiB cell under a 1 KiB byte budget is shortened, and byte truncation is reported separately', async ({ page }) => {
  await openApp(page);
  const r = await runL(page, "SELECT repeat('x', 2*1024*1024) AS v", { maxArrowBytes: 1024, maxCellChars: 500 });
  expect(r.status).toBe('ok');
  if (r.status !== 'ok') return;
  expect(r.result.rows[0]![0]!.length).toBeLessThanOrEqual(500);
  expect(r.result.truncation).toMatchObject({ rows: false, arrowBytes: true, cellsShortened: 1 });
  expect(r.result.arrowBytesSeen).toBeGreaterThan(2 * 1024 * 1024); // the batch itself still arrived (engine-level limitation)
});

test('row truncation is reported without byte truncation', async ({ page }) => {
  await openApp(page);
  const r = await runL(page, 'SELECT range FROM range(100000)', { maxRows: 1000 });
  expect(r.status === 'ok' && r.result.truncation).toMatchObject({ rows: true, arrowBytes: false, displayChars: false });
  expect(r.status === 'ok' && r.result.rows.length).toBe(1000);
});

test('multiple large cells in one row are each shortened; display size stays bounded', async ({ page }) => {
  await openApp(page);
  const cols = Array.from({ length: 8 }, (_, i) => `repeat('${String.fromCharCode(97 + i)}', 300000) AS c${i}`).join(', ');
  const r = await runL(page, `SELECT ${cols}`, { maxCellChars: 200 });
  expect(r.status).toBe('ok');
  if (r.status !== 'ok') return;
  expect(r.result.rows[0]!.every((c) => c.length <= 200)).toBe(true);
  expect(r.result.truncation.cellsShortened).toBe(8);
  expect(r.result.displayChars).toBeLessThanOrEqual(8 * 200);
});

test('wide rows: only maxColumns columns are converted', async ({ page }) => {
  await openApp(page);
  const cols = Array.from({ length: 400 }, (_, i) => `${i} AS c${i}`).join(', ');
  const r = await runL(page, `SELECT ${cols} FROM range(3)`, { maxColumns: 100 });
  expect(r.status).toBe('ok');
  if (r.status !== 'ok') return;
  expect(r.result.totalColumns).toBe(400);
  expect(r.result.columns).toHaveLength(100);
  expect(r.result.rows.every((row) => row.length === 100)).toBe(true);
  expect(r.result.truncation.columns).toBe(true);
});

test('display budget stops conversion before the row limit and is reported as display truncation', async ({ page }) => {
  await openApp(page);
  // 800 rows: under the row limit, so only the display budget can truncate.
  const r = await runL(page, "SELECT repeat('z', 400) AS v FROM range(800)", { maxRows: 1000, maxDisplayChars: 20_000, maxCellChars: 500 });
  expect(r.status).toBe('ok');
  if (r.status !== 'ok') return;
  expect(r.result.rows.length).toBe(50);
  expect(r.result.truncation.displayChars).toBe(true);
  expect(r.result.truncation.rows).toBe(false);
});

test('nested values: large lists, structs with large strings and maps are bounded', async ({ page }) => {
  await openApp(page);
  const r = await runL(
    page,
    "SELECT range(200000) AS l, {'a': repeat('q', 1000000), 'b': 7} AS s, map(range(5000), range(5000)) AS m, [repeat('w', 100000), repeat('v', 100000)] AS ls",
    { maxCellChars: 150 },
  );
  expect(r.status).toBe('ok');
  if (r.status !== 'ok') return;
  const [l, s, m, ls] = r.result.rows[0]!;
  for (const cell of [l, s, m, ls]) expect(cell!.length).toBeLessThanOrEqual(150);
  expect(l!.startsWith('[0, 1, 2')).toBe(true);
  expect(s!.startsWith('{a: qqq')).toBe(true);
  expect(m!.startsWith('[')).toBe(true);
  expect(ls!.startsWith('[www')).toBe(true);
  expect(r.result.truncation.cellsShortened).toBe(4);
});

test('the UI shows which limit truncated the result', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('sql').fill("SELECT range AS n, repeat('x', 50) AS pad FROM range(2000000)");
  await page.getByTestId('run').click();
  await expect(page.getByTestId('result-meta')).toContainText('1000 rows shown');
  await expect(page.getByTestId('result-meta')).toContainText('row limit reached');
  await expect(page.getByTestId('result').locator('tbody tr')).toHaveCount(1000);
  await page.getByTestId('sql').fill("SELECT repeat('x', 100000) AS big");
  await page.getByTestId('run').click();
  await expect(page.getByTestId('result-meta')).toContainText('1 cells shortened');
  await expect(page.getByTestId('result-meta')).not.toContainText('row limit');
});
