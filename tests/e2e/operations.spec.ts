// M10 operation status, cancellation and limits, end to end: the production App on the real engine
// (harness app view, runtime exposed) with the harness-only fault hooks (held statements, ignored
// cancel). Covers UX-005 (keyboard, announced once, old results never republish, limits labelled)
// and the PRD §5 rows for queued, running, cancelling, timed-out and refused work.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { AXE_TAGS, HARNESS } from './helpers';

const SHOTS = process.env.QV_SHOTS ?? '';
type Op = { id: string; kind: string; phase: string; label?: string; terminal?: { status: string; by?: string; stop?: string; reason?: string } };
type Rt = {
  session: { cancel(id: string): boolean; generation: number | null; state: { kind: string } };
  operations: { getSnapshot(): Op[] };
  queries: { run(s: string[], src: string): void; cancel(): void; getSnapshot(): { state: { status: string; message?: string } } };
  analyses: { analyze(sql: string, e: unknown[]): void; getSnapshot(): { status: string } };
  imports: { start(reqs: { file: File }[]): number; getSnapshot(): { items: { progress: { stage: string; message?: string } }[] }[] };
  reports: { getSnapshot(): { report: null | { status: string } } };
};
async function ready(page: Page, query = '') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${HARNESS}?view=app${query}`);
  await expect(page.getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
}
const strip = (page: Page) => page.locator('footer.status-strip');
const ops = (page: Page) => page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.operations.getSnapshot());
const queryStatus = (page: Page) => page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.queries.getSnapshot().state.status);
/** Runs a statement through Run SQL's store (as the editor does) without waiting. */
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
const statementCount = (page: Page) => page.evaluate(() => window.__qvHarness!.engine.statementLog.length);

async function axe(page: Page, label: string) {
  if (page.context().browser()?.browserType().name() === 'firefox') return; // P-083
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude('body > p').analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
const details = (page: Page) => page.getByRole('dialog', { name: 'Operation details' });

test.describe('operation status and cancellation (harness app view)', () => {
  test('UX-005: running and queued work in the strip and in Operation details; queued and active Cancel by keyboard; focus returns; announced once', async ({ page }) => {
    await ready(page);
    await hold(page, "'held'");
    await runSql(page, "SELECT 'held' AS v");
    await expect.poll(() => heldCount(page)).toBe(1);
    // Two more operations queue behind it.
    await page.evaluate(() => {
      const r = (window as unknown as { __qvApp: Rt }).__qvApp;
      r.analyses.analyze('SELECT 1', []);
      r.imports.start([{ file: new File(['a,b\n1,2\n'], 'later.csv', { type: 'text/csv' }) }]);
    });
    const line = strip(page).locator('.op-line');
    await expect(line.locator('.op-state')).toHaveText('Running SQL');
    await expect(line.locator('.op-label')).toHaveText('SELECT');
    await expect(line.locator('.op-time')).toHaveText(/^\d+ s elapsed$/);
    await expect(line.locator('.op-more')).toHaveText('+2 queued');
    await expect(page.getByRole('status')).not.toContainText(/elapsed/); // ticking time is never in the live region
    await axe(page, 'running with queue');

    // Operation details by keyboard.
    const opener = strip(page).getByRole('button', { name: 'Operation details' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const d = details(page);
    await expect(d).toBeVisible();
    await expect(d.getByRole('heading', { name: 'Operation details' })).toBeFocused(); // opens at the top
    const pending = d.getByRole('list', { name: 'Queued and running operations' }).getByRole('listitem');
    await expect(pending).toHaveCount(3);
    await expect(pending.nth(0)).toContainText('Running SQL');
    await expect(pending.nth(1)).toContainText('Queued');
    await expect(pending.nth(1)).toContainText('Waiting for the SQL run (SELECT) to finish. Operations run one at a time. It is not started if it waits longer than 30 s (limit).');
    await expect(pending.nth(2)).toContainText('later.csv');
    await expect(pending.nth(2)).toContainText('1 operation is ahead of it');
    await expect(d).not.toContainText(/%|remaining|estimated time|memory used/i);
    await axe(page, 'operation details');
    await shot(page, 'operation-details');

    // Cancel the queued import: it settles at once and never reaches the engine.
    const before = await statementCount(page);
    const cancelImport = d.getByRole('button', { name: 'Cancel operation: Importing (later.csv)' });
    await cancelImport.focus();
    await page.keyboard.press('Enter');
    await expect(pending).toHaveCount(2);
    // The focused Cancel disappeared: focus moved to the next Cancel, not the page.
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName)).toMatch(/^Cancel operation: |^H3$/);
    expect((await ops(page)).find((o) => o.label === 'later.csv')?.terminal).toMatchObject({ status: 'cancelled', by: 'user' });
    expect(await statementCount(page)).toBe(before);
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    await expect(opener).toBeFocused();

    // Cancel the running query from the strip by keyboard.
    const cancelRun = strip(page).getByRole('button', { name: 'Cancel operation: Running SQL (SELECT)' });
    await cancelRun.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => queryStatus(page)).toBe('cancelled');
    await hold(page, null);
    // Focus never falls to the page when the strip's Cancel goes away.
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await expect(page.getByRole('status')).not.toContainText(/elapsed/);
    // The queued analysis then ran; nothing is left pending.
    await expect.poll(async () => (await ops(page)).filter((o) => o.phase !== 'settled' && o.kind !== 'catalog').length, { timeout: 30_000 }).toBe(0);
    await expect(strip(page).locator('.op-line')).toHaveCount(0);
    const queryOp = (await ops(page)).filter((o) => o.kind === 'query').at(-1);
    expect(queryOp?.terminal).toMatchObject({ status: 'cancelled', by: 'user', stop: 'cooperative' });
  });

  test('repeated and concurrent Cancel settle once; Cancel after settlement does nothing; a cancelled run never appears successful', async ({ page }) => {
    await ready(page);
    await hold(page, "'held'");
    await runSql(page, "SELECT 'held' AS v");
    await expect.poll(() => heldCount(page)).toBe(1);
    const out = await page.evaluate(async () => {
      const r = (window as unknown as { __qvApp: Rt }).__qvApp;
      const op = r.operations.getSnapshot().find((o) => o.kind === 'query' && o.phase === 'active')!;
      const calls = [r.session.cancel(op.id), r.session.cancel(op.id)];
      r.queries.cancel();
      r.queries.cancel();
      for (let i = 0; i < 500 && r.operations.getSnapshot().find((o) => o.id === op.id)?.phase !== 'settled'; i++) await new Promise((x) => setTimeout(x, 10));
      const after = r.session.cancel(op.id);
      await new Promise((x) => setTimeout(x, 300));
      return { calls, after, entries: r.operations.getSnapshot().filter((o) => o.id === op.id).length, terminal: r.operations.getSnapshot().find((o) => o.id === op.id)?.terminal, status: r.queries.getSnapshot().state.status };
    });
    await hold(page, null);
    expect(out).toMatchObject({ calls: [true, true], after: false, entries: 1, terminal: { status: 'cancelled' }, status: 'cancelled' });
    await expect(page.locator('.result-summary')).toHaveCount(0); // no result panel claims success
  });

  test('a Cancel the engine does not honour: the engine is restarted, and the outcome and the recovery notice say so', async ({ page }) => {
    await ready(page);
    await exec(page, 'CREATE TABLE kept AS SELECT 1 AS k');
    await page.evaluate(() => {
      const f = window.__qvHarness!.engine.faults;
      f.hold = /'held'/;
      f.ignoreCancel = true;
    });
    await runSql(page, "SELECT 'held' AS v");
    await expect.poll(() => heldCount(page)).toBe(1);
    await strip(page).getByRole('button', { name: 'Cancel operation: Running SQL (SELECT)' }).click();
    await expect(strip(page).getByRole('button', { name: 'Cancelling: SQL run' })).toBeDisabled();
    await expect(strip(page).locator('.op-state')).toHaveText('Cancelling…');
    await shot(page, 'operation-cancelling');
    await expect(page.getByRole('region', { name: 'The engine was restarted' })).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => {
      const f = window.__qvHarness!.engine.faults;
      f.hold = null;
      f.ignoreCancel = false;
    });
    await expect(page.getByRole('region', { name: 'The engine was restarted' })).toContainText('An operation did not stop within its cancel time');
    await expect(page.getByRole('region', { name: 'The engine was restarted' })).toContainText('Tables created by SQL were lost and must be recreated: kept');
    expect((await ops(page)).filter((o) => o.kind === 'query').at(-1)?.terminal).toMatchObject({ status: 'cancelled', stop: 'terminated' });
    await strip(page).getByRole('button', { name: 'Operation details' }).click();
    await expect(details(page).getByRole('list', { name: 'Recent operations' }).getByRole('listitem').first()).toContainText('Cancelled; it did not stop in time, so the engine was restarted and its in-memory tables were lost');
    await page.keyboard.press('Escape');
    await expect(page.locator('.output-view')).toContainText('The statement did not stop, so the engine was restarted');
    await axe(page, 'recovered');
    await shot(page, 'recovery-notice');
  });

  test('time limits: work queued longer than its limit is not started; an analysis that runs out of time says so', async ({ page }) => {
    await ready(page, '&queueWaitMs=2000&verdictMs=2000');
    await hold(page, "'held'");
    await runSql(page, "SELECT 'held' AS v");
    await expect.poll(() => heldCount(page)).toBe(1);
    await page.evaluate(() => {
      const r = (window as unknown as { __qvApp: Rt }).__qvApp;
      (window as unknown as { __qvWorkspace: { setSql(s: string): void } }).__qvWorkspace.setSql('SELECT 1'); // the editor holds the analysed query
      r.imports.start([{ file: new File(['a\n1\n'], 'late.csv', { type: 'text/csv' }) }]);
      r.analyses.analyze('SELECT 1', []);
    });
    await expect.poll(async () => (await ops(page)).filter((o) => o.kind !== 'query' && o.kind !== 'catalog' && o.phase === 'settled').length, { timeout: 15_000 }).toBe(2);
    const settled = (await ops(page)).filter((o) => o.kind === 'import' || o.kind === 'verdict');
    expect(settled.find((o) => o.kind === 'import')?.terminal).toMatchObject({ status: 'refused' });
    await strip(page).getByRole('button', { name: 'Operation details' }).click();
    const recent = details(page).getByRole('list', { name: 'Recent operations' });
    await expect(recent).toContainText('Not started: it waited longer than 2 s (limit)');
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Verdict' }).first().click();
    // Its queue wait and its deadline are the same limit here; whichever ends it, the answer says why and nothing failed.
    await expect(page.locator('article.verdict .vd-answer-headline')).toHaveText(/^(The analysis waited longer than its limit for other work to finish, so it was not started\.|The analysis ran out of time, so nothing from this run is shown\.)$/);
    // The held query was never affected: Run SQL has no time limit.
    expect(await queryStatus(page)).toBe('running');
    await hold(page, null);
    await page.evaluate(() => window.__qvHarness!.engine.held.splice(0).forEach((h) => h.release()));
    await expect.poll(() => queryStatus(page), { timeout: 30_000 }).toBe('done');
  });

  test('transaction may be open: the hint opens an explanation; Analyze is refused with the reason; nothing is committed for the user', async ({ page }) => {
    await ready(page);
    await exec(page, 'CREATE TABLE a (k INTEGER)', 'CREATE TABLE b (k INTEGER)', 'BEGIN');
    const hint = strip(page).getByRole('button', { name: /^Transaction may be open/ });
    await expect(hint).toBeVisible();
    await hint.click();
    await expect(details(page)).toContainText('a transaction may be open. While it is, imports, removals and Analyze are refused');
    await expect(details(page)).toContainText('QueryVerdict never ends your transaction.');
    await page.keyboard.press('Escape');
    await expect(hint).toBeFocused().catch(() => undefined); // focus returns to Operation details (the dialog's opener)
    await page.evaluate(() => (window as unknown as { __qvWorkspace: { setSql(s: string): void } }).__qvWorkspace.setSql('SELECT * FROM a JOIN b ON a.k = b.k'));
    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.analyses.getSnapshot().status), { timeout: 30_000 }).toBe('settled');
    await expect(page.locator('article.verdict .vd-answer-headline')).toHaveText('A transaction is open, so Verdict could not read the data in one consistent state.');
    await expect(page.locator('article.verdict .vd-answer-next')).toContainText('Run COMMIT or ROLLBACK, then analyze again.');
    // The user's transaction is still open: a second BEGIN fails.
    await runSql(page, 'BEGIN');
    await expect.poll(() => queryStatus(page)).toBe('error');
    // That error aborted the transaction; ROLLBACK ends it (the user's choice, not QueryVerdict's).
    // ROLLBACK still runs in the aborted transaction (M10 correction), comments included — with
    // quote characters and nesting inside them (Codex re-review).
    await exec(page, "ROLLBACK /* client's note */ WORK");
    await expect(hint).toHaveCount(0);
    await exec(page, 'BEGIN');
    await runSql(page, "SELECT CAST('no' AS INTEGER)");
    await expect.poll(() => queryStatus(page)).toBe('error');
    await exec(page, 'ROLLBACK /* outer /* inner */ outer tail */ WORK');
    await expect(hint).toHaveCount(0);
  });

  test('Operation details shows the configured limits from the release profile, labelled as limits, and the measured import size with its source', async ({ page }) => {
    await ready(page, '&maxFileBytes=1048576');
    await strip(page).getByRole('button', { name: 'Operation details' }).click();
    const d = details(page);
    const row = (what: string) => d.getByRole('row', { name: new RegExp(what) });
    await expect(row('File size')).toContainText(/1(\.0)? MiB per file/); // the overridden profile value
    await expect(row('Rows shown')).toContainText('1,000 per result');
    await expect(row('Columns shown')).toContainText('200 per result');
    await expect(row('Characters per value')).toContainText('500');
    await expect(row('Characters shown in total')).toContainText('2,000,000');
    await expect(row('Result data collected')).toContainText('16 MiB (checked as each batch of rows arrives');
    await expect(d.getByRole('row', { name: /^Run SQL Time limit/ })).toContainText('None: a statement runs until it finishes or you cancel it');
    await expect(d.getByRole('row', { name: /^Analyze Time limit/ })).toContainText('30 s, including the wait in the queue');
    await expect(row('Row pairs built by checks')).toContainText('50,000,000');
    await expect(row('Stop request, then stop')).toContainText('Up to 2 s to request the stop, then up to 2 s for the work to stop; after that the engine is restarted');
    await expect(row('Wait before Run SQL')).toContainText('30 s (Analyze: its own time limit above includes the wait)');
    await expect(row('DuckDB memory setting')).toContainText('not a limit on the browser tab');
    await expect(d).toContainText('provisional development values, not tested capacity');
    await expect(d).toContainText('0 bytes of the 50 MiB combined limit (sum of the source file sizes on this engine)');
    await expect(d).toContainText('with its security settings verified');
    await expect(d).not.toContainText(/supports? (up to )?\d+ ?(GB|MB)|guarantee/i);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(strip(page).getByRole('button', { name: 'Operation details' })).toBeFocused();
  });

  test('narrow screens and 200% zoom: the strip wraps, Cancel and details stay reachable, no page-level horizontal scroll', async ({ page }) => {
    await ready(page);
    await hold(page, "'held'");
    await runSql(page, "SELECT 'held' AS v");
    await expect.poll(() => heldCount(page)).toBe(1);
    for (const [w, h] of [[375, 800], [720, 450]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await expect(strip(page).getByRole('button', { name: 'Cancel operation: Running SQL (SELECT)' })).toBeVisible();
      await expect(strip(page).getByRole('button', { name: 'Operation details' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      await axe(page, `narrow ${w}`);
    }
    await strip(page).getByRole('button', { name: 'Cancel operation: Running SQL (SELECT)' }).click();
    await expect.poll(() => queryStatus(page)).toBe('cancelled');
    await hold(page, null);
  });

  for (const control of ['status strip', 'Operation details', 'Cancel analysis'] as const) {
    test(`Codex M10: Cancel from the ${control} while the analysis finishes (final ROLLBACK) withholds the report; Recent operations says so`, async ({ page }) => {
      await ready(page);
      await exec(page, 'CREATE TABLE l (k INTEGER)', 'INSERT INTO l VALUES (1)', 'CREATE TABLE r (k INTEGER)', 'INSERT INTO r VALUES (1), (1)');
      await page.evaluate(() => (window as unknown as { __qvWorkspace: { setSql(s: string): void } }).__qvWorkspace.setSql('SELECT * FROM l JOIN r ON l.k = r.k'));
      await page.getByRole('tab', { name: 'Verdict' }).first().click();
      const form = page.locator('form.vd-form');
      await form.getByLabel('Rule').selectOption({ label: 'No fan-out' });
      await form.getByRole('radio', { name: 'Left input' }).check();
      await form.getByRole('button', { name: 'Add expectation' }).click();
      await hold(page, '^ROLLBACK');
      await page.getByRole('button', { name: 'Analyze', exact: true }).click();
      await expect.poll(() => heldCount(page)).toBe(1);
      if (control === 'status strip') await strip(page).getByRole('button', { name: 'Cancel operation: Analyzing (the query in the editor)' }).click();
      else if (control === 'Operation details') {
        await strip(page).getByRole('button', { name: 'Operation details' }).click();
        await details(page).getByRole('button', { name: 'Cancel operation: Analyzing (the query in the editor)' }).click();
        await page.keyboard.press('Escape');
      } else await page.getByRole('button', { name: 'Cancel analysis' }).click();
      await hold(page, null);
      await page.evaluate(() => window.__qvHarness!.engine.held.splice(0).forEach((h) => h.release()));
      await expect.poll(() => page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.analyses.getSnapshot().status), { timeout: 30_000 }).toBe('settled');
      const report = await page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.reports.getSnapshot().report);
      expect(report?.status).toBe('cancelled');
      await expect(page.locator('article.verdict .vd-outcome-badge')).toHaveText(['Unchecked']);
      await expect(page.locator('article.verdict [data-tone="violation"]')).toHaveCount(0);
      await strip(page).getByRole('button', { name: 'Operation details' }).click();
      await expect(details(page).getByRole('list', { name: 'Recent operations' }).getByRole('listitem').first()).toContainText(/Cancelled: its report was withheld|^.*Cancelled/);
      await expect(details(page).getByRole('list', { name: 'Recent operations' }).getByRole('listitem').first()).not.toContainText('Finished');
    });
  }

  test('Codex M10 re-review: Cancel while an import commits rolls it back completely; an import replaced during its catalog read never says Done', async ({ page }) => {
    await ready(page);
    await hold(page, '^COMMIT$');
    await page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.imports.start([{ file: new File(['a\n1\n'], 'commit_me.csv', { type: 'text/csv' }) }]));
    await expect.poll(() => heldCount(page)).toBe(1);
    await strip(page).getByRole('button', { name: 'Cancel operation: Importing (commit_me.csv)' }).click();
    await hold(page, null);
    await expect.poll(async () => (await ops(page)).find((o) => o.label === 'commit_me.csv')?.phase, { timeout: 20_000 }).toBe('settled');
    const reg = () => page.evaluate(() => (window as unknown as { __qvApp: { datasets: { registry: { getSnapshot(): { relation: string; origin: string; state: string }[] } } } }).__qvApp.datasets.registry.getSnapshot());
    await expect.poll(async () => (await reg()).some((e) => e.relation === 'commit_me')).toBe(false);
    // Engine replaced while the import's catalog read is held: the import is not reported Done.
    await hold(page, "^SELECT 'table'");
    await page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.imports.start([{ file: new File(['a\n1\n'], 'later_lost.csv', { type: 'text/csv' }) }]));
    await expect.poll(() => heldCount(page), { timeout: 20_000 }).toBe(1);
    await page.evaluate(() => (window as unknown as { __qvApp: { session: { restart(r: string): Promise<void> } } }).__qvApp.session.restart('test: replaced during catalog read'));
    await hold(page, null);
    const stage = await page.evaluate(async () => {
      const r = (window as unknown as { __qvApp: Rt }).__qvApp;
      for (let i = 0; i < 300; i++) {
        const it = r.imports.getSnapshot().flatMap((b) => b.items).find((x) => (x.progress as { fileName?: string }).fileName === 'later_lost.csv');
        if (it && !['queued', 'checking', 'reading', 'committing'].includes(it.progress.stage)) return it.progress;
        await new Promise((x) => setTimeout(x, 50));
      }
      return null;
    });
    expect(stage?.stage).not.toBe('done');
    const lost = (await reg()).find((e) => e.relation === 'later_lost');
    expect(lost?.state ?? 'absent').toMatch(/needs-reimport|absent/);
  });

  test('Codex M10 re-review: an analysis cut off by its time limit during its final ROLLBACK shows that in Recent operations, not "Finished"', async ({ page }) => {
    await ready(page, '&verdictMs=3000');
    await exec(page, 'CREATE TABLE l (k INTEGER)', 'INSERT INTO l VALUES (1)', 'CREATE TABLE r (k INTEGER)', 'INSERT INTO r VALUES (1)');
    await page.evaluate(() => (window as unknown as { __qvWorkspace: { setSql(s: string): void } }).__qvWorkspace.setSql('SELECT * FROM l JOIN r ON l.k = r.k'));
    await hold(page, '^ROLLBACK');
    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    await expect.poll(() => heldCount(page), { timeout: 20_000 }).toBe(1);
    await page.waitForTimeout(3_300);
    await hold(page, null);
    await page.evaluate(() => window.__qvHarness!.engine.held.splice(0).forEach((h) => h.release()));
    await expect.poll(() => page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.analyses.getSnapshot().status), { timeout: 30_000 }).toBe('settled');
    expect((await page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.reports.getSnapshot().report))?.status).toBe('budget-exhausted');
    await strip(page).getByRole('button', { name: 'Operation details' }).click();
    const first = details(page).getByRole('list', { name: 'Recent operations' }).getByRole('listitem').first();
    await expect(first).toContainText('Stopped at a limit: no authoritative report');
    await expect(first).not.toContainText('Finished');
  });

  test('Codex M10 re-review: runtime teardown records the final settlements before detaching the stores', async ({ page }) => {
    await ready(page);
    await hold(page, "'held'");
    await runSql(page, "SELECT 'held' AS v");
    await expect.poll(() => heldCount(page)).toBe(1);
    const left = await page.evaluate(() => {
      const r = (window as unknown as { __qvApp: Rt & { dispose(): void } }).__qvApp;
      r.dispose();
      return r.operations.getSnapshot().filter((o) => o.phase !== 'settled').length;
    });
    expect(left).toBe(0);
  });
});

test('Codex M10 re-review: a browser without WebAssembly is told what is missing and what to use; no Retry is offered', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { WebAssembly?: unknown }).WebAssembly;
  });
  await page.goto(`${HARNESS}?view=app`);
  const notice = page.getByRole('region', { name: 'This browser cannot run the QueryVerdict engine' });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText('The engine needs WebAssembly');
  await expect(notice).toContainText('Use a current version of Chrome, Edge, Firefox or Safari');
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run SQL' })).toBeDisabled();
});
