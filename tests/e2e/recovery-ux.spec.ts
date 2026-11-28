// M10 recovery UX, end to end: the production App on the real engine with harness-only faults.
// Engine replacement during SQL, preview, Verdict and import; what the recovery notice says and
// offers (re-import, recreate SQL tables, nothing re-run); failed recovery and fail-closed Retry;
// a stalled RPC that must be terminated; session disposal. PRD §5 recovery rows; UX-005.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { AXE_TAGS, HARNESS } from './helpers';

const SHOTS = process.env.QV_SHOTS ?? '';
type Op = { id: string; kind: string; phase: string; label?: string; terminal?: { status: string; stop?: string; reason?: string } };
type Rt = {
  session: { restart(r: string): Promise<void>; dispose(): void; generation: number | null; state: { kind: string } };
  operations: { getSnapshot(): Op[] };
  queries: { run(s: string[], src: string): void; getSnapshot(): { state: { status: string; message?: string; historical?: string | null } } };
  analyses: { analyze(sql: string, e: unknown[]): void; getSnapshot(): { status: string } };
  reports: { getSnapshot(): { report: null | { status: string }; current: boolean; historicalReason?: string } };
  preview: { getSnapshot(): { status: string; message?: string } };
  datasets: { registry: { getSnapshot(): { relation: string; state: string; origin: string }[] } };
};

async function ready(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${HARNESS}?view=app`);
  await expect(page.getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
}
/** Evaluates `f(runtime)` in the page (the function is sent as source; it must not close over test variables). */
const app = <T,>(page: Page, f: (r: Rt) => T) => page.evaluate(`(${f.toString()})(window.__qvApp)`) as Promise<T>;
const queryStatus = (page: Page) => page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.queries.getSnapshot().state.status);
const runSql = (page: Page, sql: string) => page.evaluate((q) => (window as unknown as { __qvApp: Rt }).__qvApp.queries.run([q], q), sql);
async function exec(page: Page, ...statements: string[]) {
  for (const q of statements) {
    await runSql(page, q);
    await expect.poll(() => queryStatus(page), { timeout: 30_000 }).toMatch(/^(done|error|refused|cancelled|stale)$/);
    expect([q, await queryStatus(page)]).toEqual([q, 'done']);
  }
}
const hold = (page: Page, re: string | null) => page.evaluate((r) => (window.__qvHarness!.engine.faults.hold = r === null ? null : new RegExp(r)), re);
const heldCount = (page: Page) => page.evaluate(() => window.__qvHarness!.engine.held.length);
const restart = (page: Page) => page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.session.restart('test: engine replaced'));
const notice = (page: Page, name: string) => page.getByRole('region', { name });
const setSql = (page: Page, sql: string) => page.evaluate((s) => (window as unknown as { __qvWorkspace: { setSql(s: string): void } }).__qvWorkspace.setSql(s), sql);
async function axe(page: Page, label: string) {
  if (page.context().browser()?.browserType().name() === 'firefox') return; // P-083
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude('body > p').analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
async function importFile(page: Page, file: string) {
  await page.getByRole('button', { name: /^(\+ Import|Import CSV or Parquet)$/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Import data' });
  await dialog.getByLabel('Choose local files').setInputFiles(path.resolve('tests/fixtures/import', file));
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByText(/^Finished:/)).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Done' }).click();
}

test.describe('recovery UX (harness app view)', () => {
  test('recovery during Run SQL: the run ends as stale; earlier results, preview and Verdict evidence are marked out of date; nothing is re-run; SQL text kept', async ({ page }) => {
    await ready(page);
    await exec(page, 'CREATE TABLE l (k INTEGER)', 'INSERT INTO l VALUES (1), (2)', 'CREATE TABLE r (k INTEGER)', 'INSERT INTO r VALUES (1)');
    // A current report and preview before the restart.
    const sql = 'SELECT * FROM l JOIN r ON l.k = r.k';
    await setSql(page, sql);
    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    await expect.poll(() => app(page, (r) => r.analyses.getSnapshot().status), { timeout: 30_000 }).toBe('settled');
    expect((await app(page, (r) => r.reports.getSnapshot())).current).toBe(true);
    await page.getByRole('list', { name: 'Datasets' }).getByRole('button', { name: /^l / }).click();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect.poll(() => app(page, (r) => r.preview.getSnapshot().status)).toBe('done');
    // A run in progress when the engine is replaced.
    await hold(page, "'held'");
    await runSql(page, "SELECT 'held' AS v");
    await expect.poll(() => heldCount(page)).toBe(1);
    const logBefore = await page.evaluate(() => window.__qvHarness!.engine.statementLog.length);
    await restart(page);
    await hold(page, null);
    await expect(notice(page, 'The engine was restarted')).toBeVisible();
    await expect.poll(() => queryStatus(page)).toBe('stale');
    expect(await app(page, (r) => r.queries.getSnapshot().state.message)).toBe('The engine restarted while this query was running. No result is shown.');
    expect(await app(page, (r) => r.reports.getSnapshot())).toMatchObject({ current: false, historicalReason: 'engine restarted' });
    // The previewed table was created by SQL, so it is gone: its preview is discarded (or marked out of date), never shown as current.
    expect(await app(page, (r) => r.preview.getSnapshot().status)).toMatch(/^(idle|stale)$/);
    await expect(page.getByRole('table', { name: /^Preview of l/ })).toHaveCount(0);
    // Nothing the user ran before was sent again: after the restart only boot and catalog statements.
    const after = await page.evaluate((n) => window.__qvHarness!.engine.statementLog.slice(n), logBefore);
    expect(after.filter((s) => /'held'|JOIN r ON|FROM "l"|__qv_/.test(s))).toEqual([]);
    expect((await page.evaluate(() => (window as unknown as { __qvWorkspace: { getSnapshot(): { sql: string } } }).__qvWorkspace.getSnapshot().sql))).toBe(sql);
    const n = notice(page, 'The engine was restarted');
    await expect(n).toContainText('Tables created by SQL were lost and must be recreated: l, r');
    await expect(n).toContainText('nothing was re-run');
    await page.getByRole('tab', { name: 'Verdict' }).first().click();
    await expect(page.locator('article.verdict .vd-answer-headline')).toHaveText(/^Historical: The engine restarted after this analysis/);
    await axe(page, 'recovered after SQL');
    await n.getByRole('button', { name: 'Dismiss' }).click();
    await expect(n).toHaveCount(0);
  });

  test('recovery during Verdict and during import: no authoritative report, no partial table; re-import from the notice is an explicit action', async ({ page }) => {
    await ready(page);
    await importFile(page, 'people.csv');
    await exec(page, 'CREATE TABLE p2 AS SELECT * FROM people');
    // Verdict in progress.
    await hold(page, 'qv:statistics');
    await setSql(page, 'SELECT * FROM people a JOIN p2 b ON a.id = b.id');
    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    await expect.poll(() => heldCount(page)).toBe(1);
    await restart(page);
    await hold(page, null);
    await expect.poll(() => app(page, (r) => r.analyses.getSnapshot().status), { timeout: 30_000 }).toBe('settled');
    const report = await app(page, (r) => r.reports.getSnapshot());
    expect(report.report?.status).toBe('stale');
    await page.getByRole('tab', { name: 'Verdict' }).first().click();
    await expect(page.locator('article.verdict .vd-answer-headline')).toHaveText('The engine or the data changed while Verdict was working, so no results from this run are shown.');
    // The imported table needs re-import; the notice offers it, nothing happens on its own.
    const n = notice(page, 'The engine was restarted');
    await expect(n).toContainText('Imported files to re-import');
    const states = await app(page, (r) => r.datasets.registry.getSnapshot().map((e) => `${e.relation}:${e.state}`));
    expect(states).toContain('people:needs-reimport');
    // Import in progress when the engine is replaced: no partial table appears.
    await hold(page, 'read_csv');
    await page.getByRole('button', { name: /^\+ Import$/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Import data' });
    await dialog.getByLabel('Choose local files').setInputFiles(path.resolve('tests/fixtures/import', 'bigints.csv'));
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect.poll(() => heldCount(page)).toBe(1);
    await restart(page);
    await hold(page, null);
    await expect(dialog.getByText(/^Finished:/)).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();
    expect(await app(page, (r) => r.datasets.registry.getSnapshot().some((e) => e.relation === 'bigints'))).toBe(false);
    // Re-import from the notice.
    await n.getByRole('button', { name: 'Re-import people' }).click();
    await expect(page.getByRole('status')).toHaveText('Re-imported people.');
    expect(await app(page, (r) => r.datasets.registry.getSnapshot().find((e) => e.relation === 'people')?.state)).toBe('ready');
    // A re-import that fails is reported in the notice, with the file kept for another try.
    await restart(page);
    await exec(page, 'CREATE TABLE people AS SELECT 42 AS mine');
    await notice(page, 'The engine was restarted').getByRole('button', { name: 'Re-import people' }).click();
    await expect(page.getByRole('status')).toHaveText('Re-import of people did not complete.');
  });

  test('failed recovery: SQL and Analyze refused; a failed Retry stays fail-closed; a successful Retry verifies the lockdown; repeated Retry is safe', async ({ page }) => {
    await ready(page);
    await page.evaluate(() => (window.__qvHarness!.engine.faults.failStatement = 'SET enable_external_access = false'));
    await restart(page);
    const failed = notice(page, 'Engine recovery failed');
    await expect(failed).toBeVisible();
    await expect(failed).toContainText('SQL, import and Analyze are unavailable until an engine starts with its security settings verified.');
    await expect(page.getByRole('status')).toContainText('Engine unavailable');
    await expect(page.locator('footer.status-strip .engine-glyph')).toHaveAttribute('data-tone', 'failed');
    await axe(page, 'recovery failed');
    await shot(page, 'engine-failed');
    // The actions are disabled; work submitted anyway (the editor shortcut) is refused, not queued forever.
    await expect(page.getByRole('button', { name: 'Run SQL' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Analyze', exact: true })).toBeDisabled();
    await runSql(page, 'SELECT 1');
    await expect.poll(() => queryStatus(page)).toBe('refused');
    // Retry while the fault persists: fails again, still closed.
    const gen = await app(page, (r) => r.session.generation);
    const retry = failed.getByRole('button', { name: 'Retry' });
    await retry.click();
    await expect(page.getByRole('region', { name: /could not start|Engine recovery failed/ })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => app(page, (r) => r.session.state.kind), { timeout: 20_000 }).toBe('failed');
    await runSql(page, 'SELECT 1');
    await expect.poll(() => queryStatus(page)).toBe('refused');
    // Fix the fault; Retry twice quickly: one start, then ready with lockdown verified.
    await page.evaluate(() => (window.__qvHarness!.engine.faults.failStatement = null));
    const again = page.getByRole('button', { name: 'Retry' });
    await again.click();
    await again.click({ timeout: 1000 }).catch(() => undefined); // disabled while starting
    await expect(page.getByRole('status')).toHaveText(/Engine ready|engine was restarted/, { timeout: 30_000 });
    expect(await app(page, (r) => r.session.state.kind)).toMatch(/^(ready|busy)$/); // busy: the dataset list is being read
    expect((await app(page, (r) => r.session.generation)) ?? 0).toBeGreaterThan(gen ?? 0);
    await exec(page, "SELECT current_setting('enable_external_access')::VARCHAR AS x");
    await expect(page.locator('.result-table tbody')).toContainText('false');
    await expect(page.getByRole('region', { name: /Engine recovery failed|could not start/ })).toHaveCount(0);
  });

  test('a stalled RPC during import: Cancel cannot stop it, so the engine is replaced within its bounds', async ({ page }) => {
    await ready(page);
    await page.evaluate(() => (window.__qvHarness!.engine.faults.stallRegister = true));
    await page.getByRole('button', { name: /^(\+ Import|Import CSV or Parquet)$/ }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Import data' });
    await dialog.getByLabel('Choose local files').setInputFiles(path.resolve('tests/fixtures/import', 'people.csv'));
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close' }).click().catch(() => page.keyboard.press('Escape'));
    const cancel = page.locator('footer.status-strip').getByRole('button', { name: 'Cancel operation: Importing (people.csv)' });
    await expect(cancel).toBeVisible();
    const t0 = Date.now();
    await cancel.click();
    await page.evaluate(() => (window.__qvHarness!.engine.faults.stallRegister = false));
    await expect(notice(page, 'The engine was restarted')).toBeVisible({ timeout: 20_000 });
    expect(Date.now() - t0).toBeLessThan(15_000); // cancel grace, then terminate and recover
    const op = (await app(page, (r) => r.operations.getSnapshot())).filter((o) => o.kind === 'import').at(-1);
    expect(op?.terminal?.status).toMatch(/cancelled|stale/);
    expect(await app(page, (r) => r.datasets.registry.getSnapshot().some((e) => e.relation === 'people'))).toBe(false);
  });

  test('session disposal: pending work settles, the strip says the engine stopped, nothing restarts on its own', async ({ page }) => {
    await ready(page);
    await hold(page, "'held'");
    await runSql(page, "SELECT 'held' AS v");
    await expect.poll(() => heldCount(page)).toBe(1);
    await page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.session.dispose());
    await expect.poll(() => queryStatus(page)).toBe('stale');
    await expect(page.locator('.output-view')).toContainText('The session ended while this query was running. No result is shown.');
    await expect(page.locator('footer.status-strip .op-line')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await app(page, (r) => r.session.state.kind)).toBe('disposed');
  });

  test('Codex M10: recovery context survives a failed Retry; a successful Retry names the lost SQL tables; focus never falls to the page', async ({ page }) => {
    await ready(page);
    await exec(page, 'CREATE TABLE lose_me AS SELECT 1 AS k');
    await page.evaluate(() => (window.__qvHarness!.engine.faults.failStatement = 'SET enable_external_access = false'));
    await restart(page);
    await expect(notice(page, 'Engine recovery failed')).toBeVisible();
    const retry = notice(page, 'Engine recovery failed').getByRole('button', { name: 'Retry' });
    await retry.focus();
    await page.keyboard.press('Enter'); // fails again (fault still on)
    await expect.poll(() => app(page, (r) => r.session.state.kind), { timeout: 20_000 }).toBe('failed');
    await expect(notice(page, 'Engine recovery failed')).toBeVisible();
    await page.evaluate(() => (window.__qvHarness!.engine.faults.failStatement = null));
    await notice(page, 'Engine recovery failed').getByRole('button', { name: 'Retry' }).focus();
    await page.keyboard.press('Enter');
    const recovered = notice(page, 'The engine was restarted');
    await expect(recovered).toBeVisible({ timeout: 30_000 });
    await expect(recovered).toContainText('Tables created by SQL were lost and must be recreated: lose_me');
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body || document.activeElement === null)).toBe(false);
    await expect(recovered.getByRole('heading', { name: 'The engine was restarted' })).toBeFocused();
    await exec(page, "SELECT current_setting('enable_external_access')::VARCHAR AS x");
  });

  test('Codex M10 re-review: when data changed after the table list was read, the notice says the list of lost SQL tables may be incomplete', async ({ page }) => {
    await ready(page);
    await exec(page, 'CREATE TABLE known_one AS SELECT 1 AS k');
    await hold(page, "^SELECT 'table'"); // the catalog read after the next statement does not finish
    await exec(page, 'CREATE TABLE unseen AS SELECT 2 AS k');
    await expect.poll(() => heldCount(page), { timeout: 20_000 }).toBe(1);
    await restart(page);
    await hold(page, null);
    const n = notice(page, 'The engine was restarted');
    await expect(n).toBeVisible();
    await expect(n).toContainText('Tables created by SQL were lost and must be recreated: known_one');
    await expect(n).toContainText('This list may be incomplete: data changed after the dataset list was last read');
  });
});
