// M09 answer rewrite (P-106): what the Visual Verdict says, per state, on the real engine.
// Known answers are written by hand from the fixtures below.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { AXE_TAGS, HARNESS } from './helpers';

const SHOTS = process.env.QV_SHOTS ?? '';
type Rt = { queries: { run(s: string[], src: string): void; getSnapshot(): { state: { status: string; message?: string } } }; analyses: { getSnapshot(): { status: string } } };

async function ready(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${HARNESS}?view=app`);
  await expect(page.getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
}
async function exec(page: Page, ...statements: string[]) {
  const out = await page.evaluate(async (stmts) => {
    const rt = (window as unknown as { __qvApp: Rt }).__qvApp;
    for (const q of stmts) {
      rt.queries.run([q], q);
      for (let i = 0; i < 1000 && ['queued', 'running', 'cancelling'].includes(rt.queries.getSnapshot().state.status); i++) await new Promise((r) => setTimeout(r, 10));
      const st = rt.queries.getSnapshot().state;
      if (st.status !== 'done') return `${q}: ${st.status} ${st.message ?? ''}`;
    }
    return 'ok';
  }, statements);
  expect(out).toBe('ok');
}
async function analyzeSql(page: Page, sql: string) {
  await page.evaluate((s) => (window as unknown as { __qvWorkspace: { setSql(s: string): void } }).__qvWorkspace.setSql(s), sql);
  await page.getByRole('tab', { name: 'Verdict' }).first().click();
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.analyses.getSnapshot().status), { timeout: 30_000 }).toBe('settled');
}
const answer = (page: Page) => page.locator('article.verdict .vd-answer');
async function axe(page: Page, label: string) {
  if (page.context().browser()?.browserType().name() === 'firefox') return; // P-083
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude('body > p').analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.getByRole('button', { name: 'Open full view' }).click();
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  await page.getByRole('button', { name: 'Back to SQL' }).click();
}
/** Internal words that must never appear in the main view (outside Details). */
const JARGON = /\b(probe|epoch|generation|oid|fence|invariant|SEMI JOIN|P0|diagnostic scope)\b/i;
async function noJargon(page: Page) {
  const main = await page.locator('article.verdict').evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('.vd-all-details').forEach((d) => d.remove());
    return c.textContent ?? '';
  });
  expect(main).not.toMatch(JARGON);
}

const ILLUSTRATIVE = [
  'CREATE TABLE orders (order_id INTEGER, customer_id INTEGER)',
  'INSERT INTO orders VALUES (7001, 101), (7002, 102), (7003, 103), (7004, 104), (7005, 105), (7006, 106), (7007, 107), (7008, NULL)',
  'CREATE TABLE customers (customer_id INTEGER, region VARCHAR)',
  "INSERT INTO customers VALUES (101, 'North'), (102, 'West'), (102, 'Central'), (103, 'South'), (104, 'East'), (105, 'West'), (105, 'North'), (106, 'East'), (109, 'South')",
];

test.describe('Verdict answer per state (P-106)', () => {
  test('no join: single table with GROUP BY — headline, meaning, next steps, also-list; no overview, witnesses or editor', async ({ page }) => {
    await ready(page);
    await exec(page, "CREATE TABLE customer_batch1 (customer_id INTEGER, loyalty_tier VARCHAR)", "INSERT INTO customer_batch1 VALUES (1, 'GOLD'), (2, 'SILVER')");
    await analyzeSql(page, 'select loyalty_tier, count(customer_id) as cust_count from customer_batch1 group by loyalty_tier;');
    await expect(answer(page)).toHaveAttribute('data-kind', 'unsupported:no-join');
    await expect(answer(page).locator('.vd-answer-headline')).toHaveText('No join to analyze: this query reads a single table.');
    await expect(answer(page)).toContainText('your Run SQL result is unaffected');
    await expect(answer(page).locator('.vd-answer-next li')).toHaveCount(2);
    await expect(answer(page).locator('.vd-answer-also')).toHaveText('Also outside the checks: GROUP BY · Function or aggregate in SELECT');
    for (const name of ['Join overview', 'Findings', 'Witnesses']) await expect(page.getByRole('region', { name, exact: true })).toHaveCount(0);
    await expect(page.locator('form.vd-form')).toHaveCount(0);
    await expect(page.locator('article.verdict')).toContainText('Expectations apply when the query has a join');
    await expect(page.getByRole('status')).toHaveText('Verdict: No join to analyze: this query reads a single table.');
    await noJargon(page);
    await axe(page, 'no join');
    await shot(page, 'answer-no-join');
  });

  test('GROUP BY over a join: points at the join underneath', async ({ page }) => {
    await ready(page);
    await exec(page, ...ILLUSTRATIVE);
    await analyzeSql(page, 'SELECT c.region, count(*) FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.region');
    await expect(answer(page)).toHaveAttribute('data-kind', 'unsupported:aggregation');
    await expect(answer(page).locator('.vd-answer-headline')).toHaveText('Verdict cannot check the aggregation, but the join underneath it is where counts and sums get inflated.');
    await expect(answer(page).locator('.vd-answer-next')).toContainText('Analyze the join on its own first');
    await noJargon(page);
    await shot(page, 'answer-group-by-join');
  });

  test('key type mismatch and several statements name the problem', async ({ page }) => {
    await ready(page);
    await exec(page, 'CREATE TABLE a (k INTEGER)', 'CREATE TABLE b (k BIGINT)', 'INSERT INTO a VALUES (1)', 'INSERT INTO b VALUES (1)');
    await analyzeSql(page, 'SELECT * FROM a JOIN b ON a.k = b.k');
    await expect(answer(page)).toHaveAttribute('data-kind', 'unsupported:key-types');
    await expect(answer(page).locator('.vd-answer-headline')).toHaveText(/^The join keys have different types: .*INTEGER.* and .*BIGINT.*\.$/);
    await analyzeSql(page, 'SELECT 1; SELECT * FROM a JOIN b ON a.k = b.k');
    await expect(answer(page).locator('.vd-answer-headline')).toHaveText(/^(Analyze reads the whole editor, and it holds 2 statements\.|This is not a single SELECT query, so there is no join to analyze\.)$/);
    await noJargon(page);
  });

  test('clean join: every row matched once; no issues found in these checks', async ({ page }) => {
    await ready(page);
    await exec(page, 'CREATE TABLE p (id INTEGER)', 'INSERT INTO p VALUES (1), (2), (3)', 'CREATE TABLE q (id INTEGER, v VARCHAR)', "INSERT INTO q VALUES (1, 'a'), (2, 'b'), (3, 'c')");
    await analyzeSql(page, 'SELECT * FROM p JOIN q ON p.id = q.id');
    await expect(answer(page)).toHaveAttribute('data-kind', 'measured:clean');
    await expect(answer(page).locator('.vd-answer-headline')).toHaveText('Each row appears exactly once: 3 p rows and 3 q rows give 3 result rows.');
    await expect(answer(page).locator('.vd-healthy')).toContainText('No issues found in these checks.');
    await noJargon(page);
    await axe(page, 'clean');
    await shot(page, 'answer-clean');
  });

  test('legitimate one-to-many and lookup (many-to-one) joins are described, not flagged', async ({ page }) => {
    await ready(page);
    await exec(page, 'CREATE TABLE cust (cid INTEGER)', 'INSERT INTO cust VALUES (1), (2)', 'CREATE TABLE ord (oid INTEGER, cid INTEGER)', 'INSERT INTO ord VALUES (10, 1), (11, 1), (12, 2)');
    await analyzeSql(page, 'SELECT * FROM cust c JOIN ord o ON c.cid = o.cid');
    await expect(answer(page).locator('.vd-answer-headline')).toHaveText('The result has 3 rows from 2 cust rows: 1 cust row appears more than once (1 extra row).');
    await expect(answer(page)).toHaveAttribute('data-tone', 'info');
    await analyzeSql(page, 'SELECT * FROM ord o JOIN cust c ON o.cid = c.cid');
    await expect(answer(page).locator('.vd-answer-headline')).toHaveText('Each ord row appears exactly once in the result (3 result rows); 1 cust row is shared by several ord rows.');
    await shot(page, 'answer-fan-out');
  });

  test('loss and fan-out together (illustrative fixture): same row count, different rows; violated rule first', async ({ page }) => {
    await ready(page);
    await exec(page, ...ILLUSTRATIVE);
    await page.getByRole('tab', { name: 'Verdict' }).first().click();
    const form = page.locator('form.vd-form');
    await form.getByLabel('Rule').selectOption({ label: 'No fan-out' });
    await form.getByRole('radio', { name: 'Left input' }).check();
    await form.getByRole('button', { name: 'Add expectation' }).click();
    await analyzeSql(page, 'SELECT * FROM orders o JOIN customers c ON o.customer_id = c.customer_id');
    const a = answer(page);
    await expect(a).toHaveAttribute('data-tone', 'violation');
    await expect(a.locator('.vd-answer-headline')).toHaveText('The result has 8 rows from 8 orders rows: the same count, but different rows — 2 orders rows appear more than once (2 extra rows); 2 orders rows are missing (no matching customers row).');
    await expect(a.locator('.vd-answer-effects li')).toHaveText([
      'customers has several rows for customer_id 102 (2 rows) and 105 (2 rows), so the matching orders rows repeat.',
      '2 orders rows have no matching customers row (customer_id 107); 1 of them has an empty (NULL) key, which never matches.',
      '1 customers row has no matching orders row (customer_id 109) and is not in the result.',
    ]);
    await expect(a.locator('.vd-answer-meaning').first()).toHaveText('Your rule “No left fan-out” is broken: 2 orders rows appear more than once (2 extra copies).');
    await expect(page.locator('.vd-fate tbody tr').first().locator('td')).toHaveText(['8', '4', '2 (+2 extra)', '2']);
    await expect(page.locator('.vd-outcome-reason').first()).toHaveText('2 orders rows appear more than once (2 extra copies).');
    await expect(page.locator('.vd-finding[data-category="expectation-violation"]')).toContainText('Side: Left input (orders)');
    await noJargon(page);
    await axe(page, 'loss and fan-out');
    await shot(page, 'answer-loss-fan-out');
    // Historical after an edit: the headline says which, and keeps the earlier answer labelled.
    await page.evaluate(() => (window as unknown as { __qvWorkspace: { setSql(s: string): void } }).__qvWorkspace.setSql('SELECT * FROM orders o JOIN customers c ON o.customer_id = c.customer_id -- edited'));
    await expect(a.locator('.vd-answer-headline')).toHaveText('Historical: The SQL was edited after this analysis.');
    await expect(a).toContainText('Earlier result: The result has 8 rows from 8 orders rows: the same count, but different rows');
    await expect(a).toHaveAttribute('data-tone', 'neutral');
    await expect(page.locator('article.verdict [data-tone="violation"], article.verdict [data-tone="warning"]')).toHaveCount(0);
    await axe(page, 'historical');
    await shot(page, 'answer-historical');
  });

  test('LEFT JOIN: unmatched rows are kept, never called dropped', async ({ page }) => {
    await ready(page);
    await exec(page, 'CREATE TABLE l (k INTEGER)', 'INSERT INTO l VALUES (1), (2), (NULL)', 'CREATE TABLE r (k INTEGER)', 'INSERT INTO r VALUES (1)');
    await analyzeSql(page, 'SELECT * FROM l LEFT JOIN r ON l.k = r.k');
    await expect(answer(page).locator('.vd-answer-headline')).toHaveText('The result has 3 rows from 3 l rows: 2 l rows have no matching r row and are kept with empty r columns.');
    await expect(answer(page)).toContainText('2 l rows have no matching r row (k 2); 1 of them has an empty (NULL) key, which never matches.');
    await expect(answer(page)).not.toContainText(/dropped|missing/);
  });

  test('test_datasets (README): every scenario’s row fate matches the brute-force counts; the page never scrolls', async ({ page }) => {
    await ready(page);
    await page.getByRole('button', { name: /^(\+ Import|Import CSV or Parquet)$/ }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Import data' });
    await dialog.getByLabel('Choose local files').setInputFiles(['customers.csv', 'orders.csv', 'payments.csv'].map((f) => path.resolve('test_datasets', f)));
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByText(/^Finished:/)).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();
    // Every imported table keeps its measured row count in the sidebar (not only the last one).
    for (const t of ['customers', 'orders', 'payments']) await expect(page.getByRole('list', { name: 'Datasets' }).getByRole('button', { name: new RegExp(`^${t} `) })).toContainText('30 rows');
    // [sql, left fate, right fate]: rows, once, more than once (+extra), kept, not in result.
    const cases: [string, string[], string[]][] = [
      ['SELECT * FROM orders o JOIN orders o2 ON o.order_id = o2.order_id', ['30', '30', '0', '0'], ['30', '30', '0', '0']],
      ['SELECT * FROM orders o LEFT JOIN payments p ON o.order_id = p.order_id', ['30', '24', '2 (+3 extra)', '4', '0'], ['30', '29', '0', '0', '1']],
      ['SELECT * FROM orders o JOIN customers c ON o.customer_id = c.customer_id', ['30', '23', '3 (+3 extra)', '4'], ['30', '24', '2 (+3 extra)', '4']],
      ['SELECT * FROM orders o LEFT JOIN customers c ON o.customer_id = c.customer_id', ['30', '23', '3 (+3 extra)', '4', '0'], ['30', '24', '2 (+3 extra)', '0', '4']],
      ['SELECT * FROM orders o JOIN payments p ON o.order_id = p.order_id AND o.customer_id = p.customer_id', ['30', '22', '2 (+3 extra)', '6'], ['30', '27', '0', '3']],
      ['SELECT * FROM orders o JOIN payments p ON o.customer_id = p.customer_id', ['30', '19', '6 (+13 extra)', '5'], ['30', '22', '6 (+10 extra)', '2']],
      ['SELECT * FROM customers c JOIN payments p ON c.account_no = p.account_no', ['30', '20', '4 (+8 extra)', '6'], ['30', '22', '5 (+5 extra)', '3']],
    ];
    const baseline = await page.evaluate(() => document.documentElement.scrollHeight); // the harness banner sits above the app
    for (const [sql, l, r] of cases) {
      await analyzeSql(page, sql);
      const rows = page.locator('.vd-fate tbody tr');
      await expect(rows).toHaveCount(2);
      const cells = (i: number) => rows.nth(i).locator('td').evaluateAll((tds) => tds.map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim()));
      expect([sql, await cells(0)]).toEqual([sql, l]);
      expect([sql, await cells(1)]).toEqual([sql, r]);
      // The harness banner above the app is the only overflow on this page (WebKit may scroll it out
      // of view when a button is clicked); the window never scrolls further than that.
      expect(await page.evaluate((h) => window.scrollY <= h - innerHeight, baseline)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(baseline); // the report never extends the page
    }
    await analyzeSql(page, 'SELECT * FROM orders o LEFT JOIN payments p ON o.order_id = p.order_id');
    await expect(answer(page).locator('.vd-answer-headline')).toHaveText('The result has 33 rows from 30 orders rows: 2 orders rows appear more than once (3 extra rows); 4 orders rows have no matching payments row and are kept with empty payments columns.');
    await expect(answer(page).locator('.vd-answer-effects li').first()).toHaveText('payments has several rows for order_id 7008 (3 rows) and 7001 (2 rows), so the matching orders rows repeat.');
    await expect(answer(page)).toContainText('1 payments row has no matching orders row (order_id 7099) and is not in the result. That is how a LEFT JOIN from orders works.');
    await expect(answer(page).locator('.vd-answer-next li').first()).toHaveText('If you need one row per orders row: reduce payments to one row per order_id before joining (for example GROUP BY order_id with SUM or MAX), then join.');
    await axe(page, 'test datasets');
    await shot(page, 'answer-orders-payments');
  });
});
