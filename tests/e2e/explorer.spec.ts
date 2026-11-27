// M04 dataset explorer, import dialog and inspector, end to end on the real engine.
// Production build (APP): keyboard-only import (UX-002), axe, privacy. Harness app view (the same
// App with its runtime exposed): engine restart, SQL-created/dropped/replaced tables, held imports
// and the driver's statement trace (to prove that no preview work starts without a Preview action).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP, AXE_TAGS, captureRequests, HARNESS } from './helpers';

const FIX = path.resolve('tests/fixtures/import');
const fx = (n: string) => path.join(FIX, n);
const APP_VIEW = `${HARNESS}?view=app`;

async function ready(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
}
/**
 * axe in Chromium and WebKit. In Playwright's Firefox 159 build, a full axe run crashes the page's
 * content process in some explorer states (deterministic; each rule alone passes; not caused by
 * the stylesheet). The functional assertions of every test still run in Firefox. See PROGRESS.
 */
async function axe(page: Page, what: string) {
  if (page.context().browser()?.browserType().name() === 'firefox') return;
  await page.waitForTimeout(200); // let 120 ms colour transitions settle before contrast checks
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude('body > p').analyze(); // the harness banner paragraph
  expect(r.violations.map((v) => `${what}: ${v.id} (${v.nodes.length})`)).toEqual([]);
}
/** Imports files through the dialog with the pointer (keyboard-only import has its own test). */
async function importFiles(page: Page, files: string[], names: Record<number, string> = {}) {
  await page.getByRole('button', { name: /^(\+ Import|Import CSV or Parquet)$/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Import data' });
  await dialog.getByLabel('Choose local files').setInputFiles(files);
  for (const [i, name] of Object.entries(names)) await dialog.getByRole('textbox').nth(Number(i)).fill(name);
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByText(/^Finished:/)).toBeVisible({ timeout: 20_000 });
  return dialog;
}
const done = async (page: Page) => page.getByRole('dialog', { name: 'Import data' }).getByRole('button', { name: 'Done' }).click();
/** The tree's select button for a dataset (accessible name starts with the relation). */
const item = (page: Page, relation: string) => page.getByRole('list', { name: 'Datasets' }).getByRole('button', { name: new RegExp(`^${relation} `) });
/** SQL as the M05 editor will run it: a statement, then the data epoch moves on (P-071). */
const sql = (page: Page, ...statements: string[]) => page.evaluate(async (statements) => {
  const H = window.__qvHarness!.engine;
  const rt = (window as unknown as { __qvApp: { session: InstanceType<typeof H.EngineSession> } }).__qvApp;
  for (const q of statements) {
    const r = await H.sql(rt.session, q);
    if (r.terminal.status !== 'ok') throw new Error(`${q}: ${JSON.stringify(r.terminal)}`);
  }
  rt.session.markDataChanged();
}, statements);
const restart = (page: Page) => page.evaluate(async () => {
  const rt = (window as unknown as { __qvApp: { session: { restart(r: string): Promise<void> } } }).__qvApp;
  await rt.session.restart('test: engine replaced');
});
const previewStatements = (page: Page) => page.evaluate(() => window.__qvHarness!.engine.statementLog.filter((s) => s.startsWith('SELECT left(')).length);

test.describe('dataset explorer (production build)', () => {
  test('UX-002 keyboard only, continuously: open, choose, import, follow focus through progress and Done, then select and inspect', async ({ page, browserName }) => {
    // Safari/WebKit moves Tab between text fields only by default; Option+Tab reaches buttons (as in shell.spec).
    const TAB = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    const focused = () => page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a ? `${a.tagName.toLowerCase()}:${(a.getAttribute('aria-label') ?? a.textContent ?? '').trim().slice(0, 40)}` : '';
    });
    const tabUntil = async (pred: (f: string) => boolean, max = 30) => {
      for (let i = 0; i < max; i++) {
        if (pred(await focused())) return;
        await page.keyboard.press(TAB);
      }
      throw new Error(`focus never reached the target; last: ${await focused()}`);
    };
    await ready(page, APP);
    await axe(page, 'empty workspace');
    await tabUntil((f) => f === 'button:Import CSV or Parquet');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Import data' });
    await expect(dialog.getByLabel('Choose local files')).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
    await expect(dialog.getByText('Choose at least one CSV or Parquet file.')).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Space');
    await (await chooser).setFiles([fx('people.csv'), fx('bigints.csv')]);
    await expect(dialog.getByRole('textbox', { name: 'Table name for people.csv' })).toHaveValue('people');
    await axe(page, 'import review');
    await tabUntil((f) => f === 'button:Import');
    await page.keyboard.press('Enter');
    // Focus follows the dialog into its progress phase (it is not dropped on the page).
    await expect(dialog.getByRole('heading', { name: 'Import progress' })).toBeFocused();
    await expect(dialog.getByText(/^Finished: 2 imported, 0 failed, 0 cancelled\.$/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('status')).toHaveText('Import finished: 2 imported.');
    await axe(page, 'import finished');
    await tabUntil((f) => f === 'button:Done');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    // The opener (the empty state) is gone: focus goes to "+ Import".
    await expect(page.getByRole('button', { name: '+ Import' })).toBeFocused();
    await tabUntil((f) => f.startsWith('button:bigints'));
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'people')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'people' })).toBeVisible();
    await expect(page.getByRole('table', { name: /Schema of people: 4 columns/ })).toBeVisible();
    await page.keyboard.press('ArrowRight'); // open the disclosure of the focused item
    await expect(page.getByRole('list', { name: 'Columns of people' })).toBeVisible();
    await axe(page, 'inspector schema');
  });

  test('drag and drop adds files to the review; nothing is imported until Import', async ({ page }) => {
    await ready(page, APP);
    await page.getByRole('button', { name: 'Import CSV or Parquet' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import data' });
    const data = readFileSync(fx('people.csv')).toString('base64');
    const dt = await page.evaluateHandle((b64) => {
      const d = new DataTransfer();
      const bin = atob(b64);
      d.items.add(new File([Uint8Array.from(bin, (c) => c.charCodeAt(0))], 'dropped people.csv', { type: 'text/csv' }));
      return d;
    }, data);
    // Dispatched through a CSS locator: in Playwright's Firefox build, resolving the drop zone by
    // its text inside the modal and then dispatching crashes the content process (see PROGRESS).
    await page.locator('dialog .drop-zone').dispatchEvent('drop', { dataTransfer: dt });
    await expect(dialog.getByRole('textbox', { name: 'Table name for dropped people.csv' })).toHaveValue('dropped_people');
    await expect(page.getByRole('list', { name: 'Datasets' })).toHaveCount(0);
  });

  test('privacy: import, preview and copy make no request outside the origin and store nothing durable', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const requests = captureRequests(context);
    await ready(page, APP);
    const before = requests.length;
    await importFiles(page, [fx('people.csv')]);
    await done(page);
    await item(page, 'people').click();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('table', { name: /Preview of people/ })).toBeVisible();
    await page.getByRole('button', { name: 'Copy table name' }).click();
    await expect(page.getByRole('status')).toHaveText(/Copied "people" to the clipboard\.|Could not copy to the clipboard\. The table name is "people"\./);
    if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('"people"');
    const during = requests.slice(before).map((r) => r.url());
    expect(during.filter((u) => !u.startsWith(new URL(APP).origin) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
    const stored = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, idb: (await indexedDB.databases?.())?.length ?? 0, url: location.href }));
    expect(stored).toEqual({ local: 0, session: 0, idb: 0, url: APP });
  });
});

test.describe('dataset explorer (harness: restart, SQL changes, held imports)', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      const f = window.__qvHarness?.engine.faults;
      if (f) f.hold = null;
    }).catch(() => undefined);
  });

  test('mixed outcomes: admission refusals at review, an invalid file failing at import, the rest imported', async ({ page }) => {
    await ready(page, `${APP_VIEW}&maxFileBytes=100&maxCombinedBytes=150`);
    await page.getByRole('button', { name: 'Import CSV or Parquet' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import data' });
    await dialog.getByLabel('Choose local files').setInputFiles([fx('people.csv'), fx('empty.csv'), fx('ragged.csv'), fx('bigints.csv'), fx('expected.json')]);
    await expect(dialog.getByText(/Not imported: The file is 105 bytes|Not imported: The file is 0\.0 MiB, above the configured limit/)).toBeVisible();
    await expect(dialog.getByText('Not imported: The file is empty.')).toBeVisible();
    await expect(dialog.getByText(/Not imported: Unsupported file type/)).toBeVisible();
    await expect(dialog.getByText('2 files ready to import.')).toBeVisible();
    await axe(page, 'review with refusals');
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByText('Finished: 1 imported, 1 failed, 0 cancelled.')).toBeVisible({ timeout: 20_000 });
    const failed = dialog.getByRole('listitem').filter({ hasText: 'ragged.csv' });
    await expect(failed).toContainText('Failed');
    await expect(failed).not.toContainText('/qv-local/');
    await failed.getByRole('button', { name: 'Review again ragged.csv' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Table name for ragged.csv' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(item(page, 'bigints')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Datasets' }).getByRole('button', { name: /^ragged/ })).toHaveCount(0); // no partial table
  });

  test('duplicate names: defaults get a number; a requested name that exists must be corrected; nothing is overwritten', async ({ page }) => {
    await ready(page, APP_VIEW);
    await importFiles(page, [fx('people.csv')]);
    await done(page);
    await page.getByRole('button', { name: '+ Import' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import data' });
    await dialog.getByLabel('Choose local files').setInputFiles([fx('people.csv'), fx('people.parquet')]);
    await expect(dialog.getByRole('textbox', { name: 'Table name for people.csv' })).toHaveValue('people_2');
    await expect(dialog.getByRole('textbox', { name: 'Table name for people.parquet' })).toHaveValue('people_3');
    await dialog.getByRole('textbox', { name: 'Table name for people.parquet' }).fill('people');
    await expect(dialog.getByText('A table or view named "people" already exists.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
    await expect(dialog.getByText('Correct the highlighted table names to continue.')).toBeVisible();
    await axe(page, 'name conflict');
    await dialog.getByRole('textbox', { name: 'Table name for people.parquet' }).fill('people_parquet');
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByText('Finished: 2 imported, 0 failed, 0 cancelled.')).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole('listitem').filter({ hasText: 'people.parquet' })).toContainText('as people_parquet');
    await done(page);
    for (const n of ['people', 'people_2', 'people_parquet']) await expect(item(page, n)).toBeVisible();
  });

  test('importing state and cancellation: after closing the dialog, Show import progress reopens it and Cancel import works', async ({ page }) => {
    await ready(page, APP_VIEW);
    await page.evaluate(() => { window.__qvHarness!.engine.faults.hold = /^CREATE TABLE/; });
    await page.getByRole('button', { name: 'Import CSV or Parquet' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import data' });
    await dialog.getByLabel('Choose local files').setInputFiles([fx('people.csv')]);
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByText('Reading the file')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click(); // imports continue in the background
    const importing = page.getByRole('region', { name: 'Imports in progress' });
    await expect(importing).toContainText('Importing');
    await axe(page, 'importing state');
    await importing.getByRole('button', { name: 'Show import progress' }).click();
    await expect(dialog.getByRole('heading', { name: 'Import progress' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel import' }).click();
    await expect(dialog.getByText(/^Finished: 0 imported, 0 failed, 1 cancelled\.$/)).toBeVisible();
    await expect(importing).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Import finished: 0 imported, 1 cancelled.');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('list', { name: 'Datasets' })).toHaveCount(0);
  });

  test('Cancel import in the dialog cancels the running import', async ({ page }) => {
    await ready(page, APP_VIEW);
    await page.evaluate(() => { window.__qvHarness!.engine.faults.hold = /^CREATE TABLE/; });
    await page.getByRole('button', { name: 'Import CSV or Parquet' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import data' });
    await dialog.getByLabel('Choose local files').setInputFiles([fx('people.csv'), fx('bigints.csv')]);
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByText('Reading the file')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel import' }).click();
    await expect(dialog.getByText('Finished: 0 imported, 0 failed, 2 cancelled.')).toBeVisible();
    await done(page);
    await expect(page.getByRole('list', { name: 'Datasets' })).toHaveCount(0);
  });

  test('selecting, expanding and switching tabs never starts preview work; Preview does, bounded, with NULL and empty strings distinct', async ({ page }) => {
    await ready(page, APP_VIEW);
    await importFiles(page, [fx('people.csv')]);
    await done(page);
    await item(page, 'people').click();
    await page.getByRole('button', { name: 'Show columns of people' }).click();
    await page.getByRole('tab', { name: 'Preview' }).click();
    await page.getByRole('tab', { name: 'Schema' }).click();
    await page.getByRole('tab', { name: 'Preview' }).click();
    await expect(page.getByText(/A preview shows up to 100 rows and 4 columns in the order the engine returns them \(unordered\)/)).toBeVisible();
    expect(await previewStatements(page)).toBe(0);
    await page.getByRole('button', { name: 'Preview first rows' }).click();
    const table = page.getByRole('table', { name: 'Preview of people: first 4 rows' });
    await expect(table).toBeVisible();
    expect(await previewStatements(page)).toBe(1);
    const stmt = await page.evaluate(() => window.__qvHarness!.engine.statementLog.find((s) => s.startsWith('SELECT left(')));
    expect(stmt).toMatch(/LIMIT 101$/);
    // Row headers are the row numbers; cells are id, name, city, note (tests/fixtures/import/expected.json).
    const cells = (r: number) => table.getByRole('row').nth(r).getByRole('cell');
    await expect(table.getByRole('rowheader')).toHaveText(['1', '2', '3', '4']);
    await expect(cells(2)).toHaveText(['2', 'empty string', 'Berlin', 'NULL (no value)']);
    await expect(cells(3)).toHaveText(['3', 'NULL (no value)', 'empty string', 'plain']);
    await expect(cells(4)).toHaveText(['4', "O'Neil", 'Rome', 'two\nlines']);
    await expect(cells(1)).toHaveText(['1', 'Ann', 'Paris, FR', 'She said "hi"']);
    await axe(page, 'preview');
    await page.emulateMedia({ colorScheme: 'dark' });
    await axe(page, 'preview dark');
  });

  test('exact large values, long names, wide schemas and cut cells', async ({ page }) => {
    await ready(page, APP_VIEW);
    const long = 'a_very_long_relation_name_that_keeps_going_and_going_beyond_sixty';
    await sql(page,
      `CREATE TABLE "${long}" ("column_with_a_long_name_${'x'.repeat(40)}" HUGEINT, big UBIGINT, txt VARCHAR, ${Array.from({ length: 60 }, (_, i) => `c${i} INTEGER`).join(', ')})`,
      `INSERT INTO "${long}" (1, big, txt) SELECT 170141183460469231731687303715884105727, 18446744073709551615, repeat('z', 600)`.replace('(1, big, txt)', `("column_with_a_long_name_${'x'.repeat(40)}", big, txt)`),
    );
    await expect(item(page, long)).toBeVisible();
    await item(page, long).click();
    await expect(page.getByRole('table', { name: /Schema of .*: 63 columns/ })).toBeVisible();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    const table = page.getByRole('table', { name: /Preview of / });
    await expect(table.getByRole('cell').nth(0)).toHaveText('170141183460469231731687303715884105727');
    await expect(table.getByRole('cell').nth(1)).toHaveText('18446744073709551615');
    await expect(table.getByRole('cell').nth(2)).toHaveText(`${'z'.repeat(500)}… (text cut)`);
    await expect(page.getByText('1 value was cut at 500 characters (marked …).')).toBeVisible();
    // Long names wrap instead of widening the sidebar.
    const overflow = await page.locator('#datasets-panel').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('every registry state renders with its text label: SQL-created, removed and replaced by SQL, needs re-import, failed', async ({ page }) => {
    await ready(page, APP_VIEW);
    await importFiles(page, [fx('people.csv'), fx('bigints.csv')]);
    await done(page);
    await sql(page, 'CREATE TABLE made_by_sql AS SELECT 1 AS k', 'CREATE VIEW v_people AS SELECT * FROM people');
    await expect(item(page, 'made_by_sql')).toContainText('Created by SQL');
    await expect(item(page, 'v_people')).toContainText('View');
    await item(page, 'v_people').click();
    await expect(page.getByText('Not a Verdict input: Views are not stable relations')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled();
    await sql(page, 'DROP VIEW v_people', 'DROP TABLE bigints', 'CREATE OR REPLACE TABLE people AS SELECT 1 AS x');
    await expect(item(page, 'bigints')).toContainText('Removed by SQL');
    await expect(item(page, 'people')).toContainText('Changed');
    await item(page, 'bigints').click();
    await expect(page.getByText('Removed by SQL.', { exact: false })).toBeVisible();
    await axe(page, 'removed by SQL');
    await item(page, 'people').click();
    await expect(page.locator('.state-note')).toContainText('Changed.');
    await axe(page, 'changed');
    await restart(page);
    await expect(page.getByText(/Tables created by SQL were lost and must be recreated: made_by_sql/)).toBeVisible();
    await expect(item(page, 'made_by_sql')).toHaveCount(0);
    await expect(item(page, 'people')).toContainText('Needs re-import');
    await item(page, 'people').click();
    await expect(page.getByRole('button', { name: 'Re-import', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose file again', exact: true })).toBeVisible();
    await axe(page, 'needs re-import');
    await sql(page, 'CREATE TABLE people AS SELECT 42 AS mine'); // the name is now taken: re-import cannot use it
    await page.getByRole('button', { name: 'Re-import', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(/Re-import of people did not complete: .*already exists/);
    const imported = page.getByRole('list', { name: 'Datasets' }).getByRole('button', { name: /^people Imported/ });
    await expect(imported).toContainText('Failed');
    await axe(page, 'failed');
  });

  test('engine restart: re-import succeeds; Choose file again imports the chosen file under the original name', async ({ page }) => {
    await ready(page, APP_VIEW);
    await importFiles(page, [fx('people.csv'), fx('bigints.csv')]);
    await done(page);
    await restart(page);
    await expect(item(page, 'people')).toContainText('Needs re-import');
    await item(page, 'people').click();
    await page.getByRole('button', { name: 'Re-import', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Re-imported people.');
    await expect(item(page, 'people')).not.toContainText('Needs re-import');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Preview of people: first 4 rows' })).toBeVisible();
    await item(page, 'bigints').click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose file again', exact: true }).click();
    await (await chooser).setFiles(fx('bigints.csv'));
    await expect(page.getByRole('status')).toHaveText(/Import finished: 1 imported\./, { timeout: 20_000 });
    await expect(item(page, 'bigints')).toContainText('Imported');
    await expect(item(page, 'bigints')).not.toContainText('Needs re-import');
  });

  test('removal asks for confirmation (Cancel first), returns focus, and leaves no stale preview', async ({ page }) => {
    await ready(page, APP_VIEW);
    await importFiles(page, [fx('people.csv')]);
    await done(page);
    await item(page, 'people').click();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('table', { name: /Preview of people/ })).toBeVisible();
    const remove = page.getByRole('button', { name: 'Remove', exact: true });
    await remove.click();
    const confirm = page.getByRole('dialog', { name: 'Remove "people"?' });
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await axe(page, 'remove confirmation');
    await page.keyboard.press('Escape');
    await expect(remove).toBeFocused();
    await expect(page.getByRole('table', { name: /Preview of people/ })).toBeVisible();
    await remove.click();
    await confirm.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('status')).toHaveText('Removed "people".');
    await expect(page.getByRole('list', { name: 'Datasets' })).toHaveCount(0);
    await expect(page.getByRole('table', { name: /Preview of people/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Datasets', level: 2 })).toBeFocused();
  });

  test('a preview becomes out of date when the data changes or the engine restarts, and never shows old rows', async ({ page }) => {
    await ready(page, APP_VIEW);
    await importFiles(page, [fx('people.csv')]);
    await done(page);
    await item(page, 'people').click();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('table', { name: /Preview of people/ })).toBeVisible();
    await sql(page, 'INSERT INTO people VALUES (5, \'Eve\', \'Oslo\', \'new\')');
    await expect(page.getByText('Preview out of date. The data may have changed since this preview.')).toBeVisible();
    await expect(page.getByRole('table', { name: /Preview of people/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Preview again' }).click();
    await expect(page.getByRole('table', { name: 'Preview of people: first 5 rows' })).toBeVisible();
    await restart(page);
    await expect(page.getByRole('table', { name: /Preview of people/ })).toHaveCount(0);
  });

  test('narrow screens: datasets move into a drawer; 320 px reflows without page scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await ready(page, APP_VIEW);
    await importFiles(page, [fx('people.csv')]);
    await done(page);
    const toggle = page.getByRole('button', { name: 'Datasets (1)' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#datasets-panel')).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await axe(page, 'narrow drawer');
    await item(page, 'people').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#datasets-panel')).toBeHidden(); // selecting closes the drawer…
    await expect(page.getByRole('heading', { level: 2, name: 'people' })).toBeFocused(); // …and focus continues in the inspector
    await page.setViewportSize({ width: 320, height: 640 });
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(scroll).toBeLessThanOrEqual(0);
    await axe(page, '320 px');
  });

  test('Codex: Remove drops exactly the selected table when two schemas share its name; copy is qualified', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await ready(page, APP_VIEW);
    await sql(page, 'CREATE SCHEMA aaa', 'CREATE SCHEMA bbb', 'CREATE TABLE aaa.same (a INTEGER)', 'CREATE TABLE bbb.same (b VARCHAR)');
    const bbb = page.getByRole('list', { name: 'Datasets' }).getByRole('button', { name: /^same Created by SQL · memory\.bbb/ });
    await bbb.click();
    await expect(page.getByRole('table', { name: /Schema of same/ }).getByRole('cell').nth(0)).toHaveText('b');
    await page.getByRole('button', { name: 'Copy table name' }).click();
    await expect(page.getByRole('status')).toHaveText('Copied "memory"."bbb"."same" to the clipboard.');
    if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('"memory"."bbb"."same"');
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('dialog', { name: 'Remove "memory"."bbb"."same"?' }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('status')).toHaveText('Removed "memory"."bbb"."same".');
    const left = await page.evaluate(async () => {
      const H = window.__qvHarness!.engine;
      const rt = (window as unknown as { __qvApp: { session: InstanceType<typeof H.EngineSession> } }).__qvApp;
      return (await H.sql(rt.session, "SELECT schema_name::VARCHAR FROM duckdb_tables() WHERE table_name = 'same' ORDER BY 1")).rows;
    });
    expect(left).toEqual([['aaa']]);
  });

  test('Codex: the combined limit holds across overlapping batches and for re-import', async ({ page }) => {
    await ready(page, `${APP_VIEW}&maxFileBytes=10&maxCombinedBytes=10`);
    const file = (name: string, body: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(body) });
    await page.evaluate(() => { window.__qvHarness!.engine.faults.hold = /^CREATE TABLE/; });
    await page.getByRole('button', { name: 'Import CSV or Parquet' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import data' });
    await dialog.getByLabel('Choose local files').setInputFiles([file('one.csv', 'a\n1\n2\n3\n')]); // 8 bytes
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByText('Reading the file')).toBeVisible();
    await dialog.getByRole('button', { name: 'Import more files' }).click();
    await dialog.getByLabel('Choose local files').setInputFiles([file('two.csv', 'b\n4\n5\n6\n')]); // 8 bytes; the first is not committed yet
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await page.evaluate(() => {
      const E = window.__qvHarness!.engine;
      E.faults.hold = null;
      for (const h of [...E.held]) h.release();
    });
    await expect(dialog.getByText(/^Finished: 1 imported, 1 failed, 0 cancelled\.$/)).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole('listitem').filter({ hasText: 'two.csv' })).toContainText(/combined limit/);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(item(page, 'one')).toBeVisible();
    await expect(item(page, 'two')).toHaveCount(0);
    // Re-import: after a restart, a resident 8-byte import plus re-importing the lost one would hold 16.
    await restart(page);
    await page.getByRole('button', { name: '+ Import' }).click();
    await dialog.getByLabel('Choose local files').setInputFiles([file('three.csv', 'c\n7\n8\n9\n')]);
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByText(/^Finished: 1 imported/)).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await item(page, 'one').click();
    await page.getByRole('button', { name: 'Re-import', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(/Re-import of one did not complete: .*combined limit/);
    await expect(item(page, 'one')).toContainText('Failed');
  });

  test('Codex: Preview enforces the Arrow byte budget (nothing is read when one row cannot fit); the driver refuses over-budget results', async ({ page }) => {
    await ready(page, `${APP_VIEW}&maxArrowBytes=32`);
    await sql(page, "CREATE TABLE wide AS SELECT 9007199254740993::BIGINT AS k, repeat('😀', 16) AS e");
    await item(page, 'wide').click();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByText(/The configured preview byte budget \(32 bytes\) is too small to show one row of this table\. Nothing was read\./)).toBeVisible();
    expect(await previewStatements(page)).toBe(0);
    const r = await page.evaluate(async () => {
      const H = window.__qvHarness!.engine;
      const rt = (window as unknown as { __qvApp: { session: InstanceType<typeof H.EngineSession> } }).__qvApp;
      const over = await H.sql(rt.session, "SELECT repeat('😀', 16) || '9007199254740993'", { maxRows: 10, maxBytes: 32 });
      const fits = await H.sql(rt.session, "SELECT 'ok'", { maxRows: 10, maxBytes: 4096 });
      return { over: over.terminal, fits: fits.rows };
    });
    expect(r.over).toMatchObject({ status: 'error', message: expect.stringMatching(/byte budget of 32 bytes/) });
    expect(r.fits).toEqual([['ok']]);
  });

  test('Codex: the schema shows nullability reported by DuckDB; a blank table name is an error, not a silent default', async ({ page }) => {
    await ready(page, APP_VIEW);
    await sql(page, 'CREATE TABLE constraints_test (mandatory INTEGER NOT NULL, optional INTEGER)');
    await item(page, 'constraints_test').click();
    const schema = page.getByRole('table', { name: /Schema of constraints_test/ });
    await expect(schema.getByRole('columnheader', { name: 'Nullable' })).toBeVisible();
    await expect(schema.getByRole('row').nth(1).getByRole('cell')).toHaveText(['mandatory', 'INTEGER', 'No']);
    await expect(schema.getByRole('row').nth(2).getByRole('cell')).toHaveText(['optional', 'INTEGER', 'Yes']);
    await page.getByRole('button', { name: '+ Import' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import data' });
    await dialog.getByLabel('Choose local files').setInputFiles([fx('people.csv')]);
    await dialog.getByRole('textbox', { name: 'Table name for people.csv' }).fill('   ');
    await expect(dialog.getByText('Enter a table name, or remove this file from the list.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  });
});
