// M06 results in the real UI. Production build (APP): UX-003 run states and errors by phase,
// zero rows, display order and truncation wording, the bounded detail viewer, windowed grid
// semantics, responsiveness at the P-020 bounds (T-ENG-009c; Chromium long tasks), axe, network
// isolation, narrow layout, historical labels and the transaction hint. Harness app view: tab
// switches never issue SQL, and Cancel while a statement runs.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { APP, APP_ORIGIN, AXE_TAGS, captureRequests, HARNESS } from './helpers';

const APP_VIEW = `${HARNESS}?view=app`;
const editor = (page: Page) => page.getByRole('textbox', { name: 'SQL editor' });

async function ready(page: Page, url = APP) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  await expect(page.getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
}
/** Replaces the editor text and runs it with Mod+Enter; waits until the run settles. */
async function runSql(page: Page, sql: string) {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(sql);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.output-body')).not.toContainText(/Queued|Running SQL…|Cancelling…/, { timeout: 30_000 });
}
async function axe(page: Page, what: string) {
  if (page.context().browser()?.browserType().name() === 'firefox') return; // P-083
  await page.waitForTimeout(200);
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(r.violations.map((v) => `${what}: ${v.id} (${v.nodes.length})`)).toEqual([]);
}

test.describe('results (production build)', () => {
  test('UX-003: Run SQL shows the result, keeps focus in the editor; NULL and empty are distinct; zero rows; errors by phase', async ({ page }) => {
    await ready(page);
    await runSql(page, "SELECT 1 AS a, NULL AS n, '' AS e, '  ' AS w");
    await expect(page.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
    await expect(editor(page)).toBeFocused();
    await expect(page.locator('.result-summary')).toContainText('SQL executed');
    await expect(page.locator('.result-summary')).toContainText('1 row · 4 columns');
    const cells = page.getByRole('table', { name: /Result of Run SQL/ }).getByRole('cell');
    await expect(cells.nth(0)).toHaveText('1');
    await expect(cells.nth(1)).toHaveText('NULL (no value)');
    await expect(cells.nth(2)).toHaveText('empty string');
    await expect(cells.nth(3)).toHaveText('  ');
    await expect(page.getByRole('status')).toHaveText('SQL executed · 1 row shown.');

    await runSql(page, 'SELECT 1 AS a WHERE false');
    await expect(page.locator('.output-body')).toContainText('SQL executed · 0 rows.');

    for (const [sql, label] of [['SELEC 1', 'Syntax error'], ['SELECT * FROM nosuch', 'Binding error'], ["SELECT 'a'::INTEGER", 'Runtime error']] as const) {
      await runSql(page, sql);
      await expect(page.locator('.result-error')).toContainText(label);
    }
    await expect(page.locator('.result-error-message')).toHaveText('Conversion Error: Could not convert string \'a\' to INT32');
  });

  test('P-097 (Snowflake-style): the statement at the cursor runs; a selection runs every statement in it and shows the last', async ({ page }) => {
    await ready(page);
    const set = async (sql: string) => {
      await editor(page).click();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.press('Delete');
      await page.keyboard.insertText(sql);
    };
    const settle = () => expect(page.locator('.output-body')).not.toContainText(/Queued|Running SQL…|Cancelling…/, { timeout: 30_000 });
    const header = () => page.locator('.result-table thead th[aria-colindex="2"] .col-name');

    await set('select 1 as first_col;\n\nselect 2 as second_col;');
    await page.keyboard.press('ControlOrMeta+Home'); // caret in statement 1
    await expect(page.locator('.cm-statement-line')).toHaveCount(1); // the gutter marks the statement that will run
    await page.keyboard.press('ControlOrMeta+Enter');
    await settle();
    await expect(header()).toHaveText('first_col');
    await page.keyboard.press('ControlOrMeta+End'); // caret after the last terminator
    await page.keyboard.press('ControlOrMeta+Enter');
    await settle();
    await expect(header()).toHaveText('second_col');

    await set('create table s1 as select 1 as x;\ninsert into s1 values (2);\nselect count(*) as n from s1;');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+Enter');
    await settle();
    await expect(page.locator('.result-summary')).toContainText('Ran 3 statements · showing the result of the last');
    await expect(page.locator('.result-table td[aria-colindex="2"]').first()).toHaveText('2');
    await expect(page.getByRole('list', { name: 'Datasets' })).toContainText('s1');

    await set('create table s2 (x integer);\ninsert into nosuch values (1);\nselect 1;');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+Enter');
    await settle();
    await expect(page.locator('.result-error-message')).toContainText('Statement 2 of 3: Catalog Error');
    await expect(page.locator('.result-error')).toContainText('1 of 3 statements completed before this error');
    await expect(page.getByRole('list', { name: 'Datasets' })).toContainText('s2');

    await set('create table s3 (x integer);\nselect 1;\nselec 2;');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+Enter');
    await settle();
    await expect(page.locator('.result-error')).toContainText('Syntax error');
    await expect(page.locator('.result-error-message')).toContainText('Statement 3 of 3');
    await expect(page.locator('.result-error')).toContainText('Nothing was run.');
    await expect(page.getByRole('list', { name: 'Datasets' })).not.toContainText('s3');
  });

  test('display order and truncation wording; DDL and DML outcomes; the editor text and undo survive runs', async ({ page }) => {
    await ready(page);
    await runSql(page, 'SELECT i FROM range(1500) t(i)');
    await expect(page.locator('.result-notes')).toContainText('1,000 rows shown in display order. The result has more rows; the row limit is 1,000.');
    await runSql(page, 'SELECT i FROM range(1500) t(i) ORDER BY i');
    await expect(page.locator('.result-notes')).toContainText('Showing the first 1,000 rows (ORDER BY).');
    await runSql(page, 'SELECT 3 AS x UNION ALL SELECT 4');
    await expect(page.locator('.result-bar')).toContainText('without ORDER BY the order is not guaranteed');
    await runSql(page, 'CREATE TABLE z AS SELECT * FROM range(4)');
    await expect(page.locator('.result-summary')).toContainText('Statement executed');
    await expect(page.locator('.result-summary')).toContainText('4 rows affected (reported by DuckDB)');
    await expect(page.getByRole('list', { name: 'Datasets' })).toContainText('z');
    await runSql(page, 'DROP TABLE z');
    await expect(page.locator('.result-summary')).toContainText('no result set');
    await editor(page).press('ControlOrMeta+z');
    await expect(page.locator('.cm-content')).not.toHaveText('DROP TABLE z'); // undo history kept across runs
  });

  test('the detail viewer shows the bounded value only, by keyboard, and returns focus', async ({ page, browserName }) => {
    await ready(page);
    await runSql(page, "SELECT repeat('ab', 1000) AS long");
    await expect(page.locator('.result-notes')).toContainText('1 value was cut at 500 characters');
    const open = page.getByRole('button', { name: 'Show value of long, row 1', exact: true });
    await open.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'long · row 1' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Only the first 500 characters of this value were kept');
    await expect(dialog.getByLabel('Value')).toHaveText('ab'.repeat(250));
    await axe(page, 'cell detail');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    if (browserName !== 'webkit') await expect(open).toBeFocused();
  });

  test('windowed grid: 1,000 rows are announced as 1,001 table rows, only a window is in the document, and scrolling reaches the last row', async ({ page }) => {
    await ready(page);
    await runSql(page, 'SELECT i, i * 2 AS j FROM range(1000) t(i) ORDER BY i');
    const table = page.getByRole('table', { name: /Result of Run SQL: 1,000 rows/ });
    await expect(table).toHaveAttribute('aria-rowcount', '1001');
    const rendered = await page.locator('.result-table tbody tr[data-row]').count();
    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(200);
    await page.locator('.result-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.locator('.result-table tr[aria-rowindex="1001"] th')).toHaveText('1000');
    await expect(page.locator('.result-table tr[aria-rowindex="1001"] td[aria-colindex]').first()).toHaveText('999');
    await axe(page, 'result grid');
  });

  test('column windowing: 200 columns keep the full width and every column in view is rendered at any scroll position', async ({ page }) => {
    await ready(page);
    const cols = Array.from({ length: 200 }, (_, k) => `lpad(CAST(i + ${k} AS VARCHAR), 10, '0') AS c${k}`).join(', ');
    await runSql(page, `SELECT ${cols} FROM range(1000) t(i)`);
    await expect(page.getByRole('table', { name: /200 columns/ })).toHaveAttribute('aria-colcount', '201');
    for (const f of [0, 0.25, 0.5, 1]) {
      await page.locator('.result-scroll').evaluate((el, f) => {
        el.scrollLeft = (el.scrollWidth - el.clientWidth) * f;
        el.scrollTop = (el.scrollHeight - el.clientHeight) * f;
      }, f);
      // WebKit delivers the scroll event for a programmatic scroll a little later: poll.
      const gaps = () =>
        page.locator('.result-scroll').evaluate((el) => {
          const ths = [...el.querySelectorAll('thead th[aria-colindex]')].filter((t) => !t.classList.contains('row-number'));
          const view = el.getBoundingClientRect();
          const number = el.querySelector('thead .row-number')!.getBoundingClientRect().right;
          const first = ths[0]!.getBoundingClientRect().left;
          const last = ths.at(-1)!.getBoundingClientRect().right;
          return { left: Math.max(0, first - number) <= 1, right: Math.max(0, view.right - 16 - last) <= 1, windowed: ths.length < 40 };
        });
      await expect.poll(gaps, { message: `gaps at ${f}`, timeout: 3000 }).toEqual({ left: true, right: true, windowed: true });
    }
    await expect(page.locator('.result-table thead th[aria-colindex="201"]')).toHaveText(/c199/);
  });

  test('T-ENG-009c: rendering 1,000 × 200 and 2,000,000 display characters has no long task over 200 ms (Chromium)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'the Long Tasks API is available in Chromium only; Firefox and WebKit are measured by frame gaps in R1');
    await page.addInitScript(() => {
      const w = window as unknown as { __lt: number[] };
      w.__lt = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__lt.push(e.duration);
      }).observe({ type: 'longtask', buffered: true });
    });
    await ready(page);
    const cols = (n: number, f: (k: number) => string) => Array.from({ length: n }, (_, k) => f(k)).join(', ');
    for (const sql of [
      `SELECT ${cols(200, (k) => `i + ${k} AS c${k}`)} FROM range(1000) t(i)`,
      `SELECT ${cols(4, (k) => `repeat(chr(${97 + k}), 600) AS c${k}`)} FROM range(1000) t(i)`,
      `SELECT ${cols(200, (k) => `lpad(CAST(i + ${k} AS VARCHAR), 10, '0') AS c${k}`)} FROM range(1000) t(i)`,
    ]) {
      await page.evaluate(() => {
        (window as unknown as { __lt: number[] }).__lt = [];
      });
      await runSql(page, sql);
      await expect(page.locator('.result-scroll')).toBeVisible();
      await page.waitForTimeout(500);
      const sc = page.locator('.result-scroll');
      for (let s = 1; s <= 10; s++) await sc.evaluate((el, s) => { el.scrollTop = (el.scrollHeight * s) / 10; el.scrollLeft = (el.scrollWidth * s) / 10; }, s);
      await page.waitForTimeout(300);
      const longest = await page.evaluate(() => Math.max(0, ...(window as unknown as { __lt: number[] }).__lt));
      expect(longest, sql.slice(0, 60)).toBeLessThan(200);
    }
  });

  test('axe in both themes; results stay inside their region; requests stay on the app origin', async ({ page, context }) => {
    const requests = captureRequests(context);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await ready(page);
      await runSql(page, "SELECT i, 'text ' || i AS t, NULL AS n, repeat('x', 120) AS wide, 170141183460469231731687303715884105727::HUGEINT AS h FROM range(50) t(i)");
      await axe(page, `results ${scheme}`);
      await runSql(page, 'SELECT * FROM nosuch');
      await axe(page, `error ${scheme}`);
      expect(await page.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight }))).toEqual({ x: 0, y: 0 });
    }
    expect(requests.map((r) => r.url()).filter((u) => !u.startsWith(`${APP_ORIGIN}/queryverdict/`) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
  });

  test('narrow screens: the outcome is shown beside the actions; the grid scrolls inside Results', async ({ page }) => {
    await page.goto(APP);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
    await runSql(page, 'SELECT i, repeat(\'w\', 60) AS wide FROM range(20) t(i)');
    await expect(page.locator('.inline-note')).toContainText('SQL executed · 20 rows');
    await expect(editor(page)).toBeFocused();
    await page.getByRole('tablist', { name: 'Workspace view' }).getByRole('tab', { name: 'Results' }).click();
    await expect(page.getByRole('table', { name: /Result of Run SQL/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  });

  test('a shown result becomes historical after an edit or a data change; BEGIN shows the transaction hint until COMMIT', async ({ page }) => {
    await ready(page);
    await runSql(page, 'SELECT 1 AS a');
    await editor(page).press('End');
    await page.keyboard.type(' ');
    await expect(page.locator('.result-historical')).toContainText('The SQL was edited after this run.');
    await runSql(page, 'BEGIN');
    await expect(page.getByRole('contentinfo')).toContainText('Transaction may be open');
    await runSql(page, 'COMMIT');
    await expect(page.getByRole('contentinfo')).not.toContainText('Transaction may be open');
  });
});

test.describe('results (harness app view)', () => {
  test('switching output tabs never issues SQL; Cancel stops a running statement and keeps the editor text', async ({ page }) => {
    await ready(page, APP_VIEW);
    await runSql(page, 'SELECT 1 AS a');
    const log = () => page.evaluate(() => window.__qvHarness!.engine.statementLog.length);
    const before = await log();
    for (const tab of ['Verdict', 'Dataset', 'Results']) await page.getByRole('tab', { name: tab }).click();
    expect(await log()).toBe(before);

    await page.evaluate(() => {
      window.__qvHarness!.engine.faults.hold = /__qv_result/;
    });
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('SELECT 42 AS answer');
    await page.keyboard.press('ControlOrMeta+Enter');
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeVisible();
    await expect(page.locator('.output-body')).toContainText('Running SQL…');
    await cancel.click();
    await expect(page.locator('.output-body')).toContainText('Cancelled.');
    await expect(cancel).toBeHidden();
    await page.evaluate(() => {
      window.__qvHarness!.engine.faults.hold = null;
    });
    await expect(page.locator('.cm-content')).toHaveText('SELECT 42 AS answer');
  });
});

test.describe('Codex M06 review regressions (harness app view)', () => {
  test('a partial batch says what ran; BEGIN then an error keeps the transaction hint', async ({ page }) => {
    await ready(page, APP_VIEW);
    await editor(page).click();
    await page.keyboard.insertText('create table pb (x integer);\ninsert into pb values (42);\nselect missing from pb;');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator('.result-error')).toContainText('2 of 3 statements completed before this error; their changes were applied.');
    await expect(page.locator('.result-error')).not.toContainText('Nothing was run');
    await runSql(page, 'select x from pb');
    await expect(page.locator('.result-table td[aria-colindex="2"]').first()).toHaveText('42');
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('BEGIN;\nSELECT missing FROM pb;');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator('.result-error')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toContainText('Transaction may be open');
    await runSql(page, 'ROLLBACK');
    await expect(page.getByRole('contentinfo')).not.toContainText('Transaction may be open');
  });

  test('a result whose data epoch changes before publication is shown as historical, not current', async ({ page }) => {
    await ready(page, APP_VIEW);
    await page.evaluate(() => {
      type S = { subscribe(f: (e: { type: string; phase?: string; kind?: string }) => void): () => void; markDataChanged(): void };
      const s = (window as unknown as { __qvApp: { session: S } }).__qvApp.session;
      let done = false;
      s.subscribe((e) => {
        if (!done && e.type === 'operation' && e.kind === 'query' && e.phase === 'settled') {
          done = true;
          s.markDataChanged(); // a change between settlement and publication
        }
      });
    });
    await runSql(page, 'SELECT 4242 AS v');
    await expect(page.locator('.result-historical')).toContainText('The data may have changed since this result.');
  });

  test('an active statement shows Running; Cancel by keyboard returns focus to Run SQL; a sent statement may have applied', async ({ page }) => {
    await ready(page, APP_VIEW);
    await runSql(page, 'CREATE TABLE cu (x INTEGER)');
    await runSql(page, 'INSERT INTO cu VALUES (1), (2), (3)');
    await page.evaluate(() => {
      window.__qvHarness!.engine.faults.hold = /^UPDATE/;
    });
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('UPDATE cu SET x = x + 10 RETURNING x');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator('.output-body')).toContainText('Running SQL…');
    await expect(page.locator('.output-body')).not.toContainText('Queued');
    // Cancel once the UPDATE has been sent (held at the engine); cancelling while DuckDB is still
    // classifying it correctly reports only "Cancelled." (nothing was sent).
    await expect.poll(() => page.evaluate(() => window.__qvHarness!.engine.held.length)).toBe(1);
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    await cancel.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.output-body')).toContainText('The statement had already been sent, so its changes may have been applied.');
    await expect(page.getByRole('button', { name: 'Run SQL' })).toBeFocused();
    await page.evaluate(() => {
      window.__qvHarness!.engine.faults.hold = null;
    });
  });

  test('a byte limit that withholds every row is not reported as zero rows', async ({ page }) => {
    await ready(page, `${APP_VIEW}&maxArrowBytes=28`);
    await runSql(page, "SELECT repeat('x', 100) AS greeting"); // one row of more than 28 bytes
    await expect(page.locator('.output-body')).not.toContainText('0 rows.');
    await expect(page.locator('.result-notes')).toContainText('Rows were withheld because the result data reached the transfer limit of 28 bytes.');
  });

  test('a focused detail button scrolled out of the window hands focus to the grid; axe passes with overflowing SQL', async ({ page }) => {
    await ready(page, APP_VIEW);
    await runSql(page, `SELECT i, repeat('ab', 300) AS long FROM range(1000) t(i) -- ${'x'.repeat(400)}`);
    const button = page.getByRole('button', { name: 'Show value of long, row 1', exact: true });
    await button.focus();
    await page.locator('.result-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.locator('.result-scroll')).toBeFocused();
    await axe(page, 'overflowing editor and grid');
  });
});
