// M09 Visual Verdict, end to end: the production App on the real engine (harness app view, with
// its runtime and workspace store exposed), the real M08 VerdictService behind Analyze, and the
// report store's currency. Known answers are written by hand from the UI specification's
// illustrative fixture (UI_SPECIFICATION §5) and from the fixtures below; they are not produced by
// the code under test.
// UX-004 · golden report flows (natural fan-out, declared violation, missing evidence, unsupported,
// SQL error, probe failure, cancellation) · T-ENG-010a/c · historical rules · join-key profile ·
// full-width view and Back to SQL · expectation authoring · axe in every report state.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { AXE_TAGS, captureRequests, HARNESS } from './helpers';

const APP_VIEW = `${HARNESS}?view=app`;
const SHOTS = process.env.QV_SHOTS ?? '';

const ILLUSTRATIVE_SQL = 'SELECT o.order_id, o.customer_id, c.region\nFROM orders AS o\nINNER JOIN customers AS c\n  ON o.customer_id = c.customer_id';
/** UI_SPECIFICATION §5 "Illustrative fixture used in all three mockups". */
const ILLUSTRATIVE_TABLES = [
  'CREATE TABLE orders (order_id INTEGER, customer_id INTEGER)',
  'INSERT INTO orders VALUES (7001, 101), (7002, 102), (7003, 103), (7004, 104), (7005, 105), (7006, 106), (7007, 107), (7008, NULL)',
  'CREATE TABLE customers (customer_id INTEGER, region VARCHAR)',
  "INSERT INTO customers VALUES (101, 'North'), (102, 'West'), (102, 'Central'), (103, 'South'), (104, 'East'), (105, 'West'), (105, 'North'), (106, 'East'), (109, 'South')",
];

type Rt = {
  queries: { run(statements: string[], source: string): void; getSnapshot(): { state: { status: string; message?: string } } };
  analyses: { getSnapshot(): { status: string; reportId?: string | null } };
  reports: { getSnapshot(): { report: null | { id: string; status: string; authoritative: boolean; identity: { sqlText: string } }; current: boolean; historicalReason?: string } };
  session: { restart(reason: string): Promise<void>; generation: number | null };
};

async function ready(page: Page, query = '') {
  await page.setViewportSize({ width: 1440, height: 900 });
  // No colour transitions, so contrast is measured on settled colours after a theme change.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${APP_VIEW}${query}`);
  await expect(page.getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
}

/** Runs statements as Run SQL does (each settles before the next); throws on failure. */
async function exec(page: Page, ...statements: string[]) {
  const out = await page.evaluate(async (stmts) => {
    const rt = (window as unknown as { __qvApp: Rt }).__qvApp;
    for (const q of stmts) {
      rt.queries.run([q], q);
      for (let i = 0; i < 1000; i++) {
        const s = rt.queries.getSnapshot().state.status;
        if (!['queued', 'running', 'cancelling'].includes(s)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const st = rt.queries.getSnapshot().state;
      if (st.status !== 'done') return `${q}: ${st.status} ${st.message ?? ''}`;
    }
    return 'ok';
  }, statements);
  expect(out).toBe('ok');
}

const setSql = (page: Page, sql: string) => page.evaluate((s) => (window as unknown as { __qvWorkspace: { setSql(s: string): void } }).__qvWorkspace.setSql(s), sql);
const analysisStatus = (page: Page) => page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.analyses.getSnapshot().status);
const reportView = (page: Page) => page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.reports.getSnapshot());
const verdict = (page: Page) => page.locator('article.verdict');
const section = (page: Page, name: string) => verdict(page).getByRole('region', { name, exact: true });

/** Clicks Analyze and waits until the analysis has settled. */
async function analyze(page: Page) {
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect.poll(() => analysisStatus(page), { timeout: 30_000 }).toBe('settled');
}

/** Declares an expectation through the editor form. */
async function declare(page: Page, rule: string, opts: { side?: 'Left input' | 'Right input'; relationship?: string; min?: string; max?: string } = {}) {
  const form = verdict(page).locator('form.vd-form');
  await form.getByLabel('Rule').selectOption({ label: rule });
  if (opts.side) await form.getByRole('radio', { name: opts.side }).check();
  if (opts.relationship) await form.getByLabel('Maximum allowed relationship').selectOption({ label: opts.relationship });
  if (opts.min !== undefined) await form.getByLabel('Minimum output rows').fill(opts.min);
  if (opts.max !== undefined) await form.getByLabel('Maximum output rows').fill(opts.max);
  await form.getByRole('button', { name: /Add expectation|Save changes/ }).click();
}

async function illustrative(page: Page) {
  await exec(page, ...ILLUSTRATIVE_TABLES);
  await setSql(page, ILLUSTRATIVE_SQL);
  await page.getByRole('tab', { name: 'Verdict' }).first().click();
}

/**
 * axe in Chromium and WebKit. In Playwright's Firefox 159 build a full axe run crashes the page's
 * content process (P-083, reproduced for the Verdict views); every functional assertion still runs.
 */
async function axe(page: Page, label: string) {
  if (page.context().browser()?.browserType().name() === 'firefox') return;
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude('body > p').analyze(); // the harness banner paragraph
  expect(r.violations.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

async function shot(page: Page, name: string, target?: Locator) {
  if (!SHOTS) return;
  await (target ?? page).screenshot({ path: `${SHOTS}/${name}.png`, ...(target ? {} : { fullPage: false }) });
}

/** Cell texts of one row (DOM textContent; Playwright's allInnerTexts crashes Firefox 159's content process here, P-083). */
const cells = (row: Locator) => row.evaluate((r) => [...r.querySelectorAll('th, td')].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()));

test.describe('Visual Verdict (harness app view)', () => {
  test('UX-004: the illustrative fixture reproduces the mockup counts; one declared violation and one warning render distinctly', async ({ page, browserName }) => {
    await ready(page);
    await illustrative(page);
    await declare(page, 'No fan-out', { side: 'Left input' });
    await analyze(page);
    const v = verdict(page);

    // Identity, currency and authority.
    await expect(v.locator('.vd-identity')).toHaveText('orders AS o × customers AS c · INNER JOIN');
    await expect(v.locator('.vd-tags .badge')).toHaveText(['Current', 'Validated evidence']);

    // Join overview: UI_SPECIFICATION §5 counts.
    const overview = section(page, 'Join overview');
    await expect(overview.locator('.join-node[data-side="left"]')).toContainText('orders AS o');
    await expect(overview.locator('.join-node[data-side="left"] .node-meta:not(.node-flow)')).toHaveText(/8 rows\s*1 NULL-key row\s*0 duplicate key groups/);
    await expect(overview.locator('.join-node[data-side="right"] .node-meta:not(.node-flow)')).toHaveText(/9 rows\s*0 NULL-key rows\s*2 duplicate key groups/);
    await expect(overview.locator('.join-node[data-kind="join"]')).toContainText('INNER JOIN');
    await expect(overview.locator('.node-keys')).toHaveText('o.customer_id = c.customer_id');
    await expect(overview.locator('.node-rel')).toHaveText(/Whole inputs\s*One-to-many\s*Matched keys\s*One-to-many/);
    await expect(overview.locator('.join-node[data-kind="output"]')).toContainText('8 rows');
    await expect(overview.locator('.join-node[data-kind="output"]')).toContainText('8 matched pairs');
    await expect(overview.locator('.join-node[data-side="left"] .node-flow')).toHaveText(/6 matched\s*2 unmatched, dropped\s*2 multiplied \(\+2 copies\)/);
    await expect(overview.locator('.join-node[data-side="right"] .node-flow')).toHaveText(/8 matched\s*1 unmatched, dropped\s*0 multiplied \(\+0 copies\)/);
    await overview.locator('.vd-accounting > summary').click();
    const acc = overview.locator('table.accounting tbody tr');
    const expected: [string, string, string][] = [
      ['Input rows', '8', '9'],
      ['Rows with a NULL key', '1', '0'],
      ['Distinct non-NULL keys', '7', '7'],
      ['Duplicate key groups', '0', '2'],
      ['Matched input rows', '6', '8'], // "six represented left rows, eight represented right rows"
      ['Rows multiplied', '2', '0'], // "two multiplied left rows"
      ['Excess copies', '2', '0'], // "two excess copies"
      ['Unmatched rows', '2', '1'],
      ['· kept, with NULL right columns', '–', '–'],
      ['· dropped, no output', '2', '1'], // "two dropped left rows, one dropped right row" (AM-011a: both sides)
    ];
    for (const [i, [label, l, r]] of expected.entries()) {
      const c = await cells(acc.nth(i));
      expect([c[0]!.split('\n')[0]!.replace(/never match.*|appear more.*|copies past.*/, '').trim(), c[1]!.replace('not applicable', '').trim(), c[2]!.replace('not applicable', '').trim()]).toEqual([label, l, r]);
    }

    // Findings: the declared violation and the warning are separate, labelled and toned differently.
    const findings = section(page, 'Findings');
    const violation = findings.locator('.vd-finding[data-category="expectation-violation"]');
    const warning = findings.locator('.vd-finding[data-category="suspicious"]');
    await expect(violation).toHaveCount(1);
    await expect(warning).toHaveCount(1);
    await expect(violation).toHaveAttribute('data-tone', 'violation');
    await expect(warning).toHaveAttribute('data-tone', 'warning');
    await expect(violation.locator('.vd-finding-head')).toHaveText(/Expectation violation\s*·?\s*Expectation violated/);
    await expect(violation).toContainText('Expectation 1 · No left fan-out. 2 orders rows appear more than once (2 extra copies).');
    await expect(violation).toContainText('Side: Left input (orders)');
    await expect(violation).toContainText('Stage: Join 1 · INNER JOIN');
    await expect(warning.locator('.vd-finding-head')).toHaveText(/Suspicious pattern\s*·?\s*Row loss and fan-out together/);
    await expect(warning).toContainText('In orders, 2 rows are dropped while other rows gain 2 extra copies. The row count alone hides both.');
    // Natural fan-out and row loss are observations, not errors (P-076).
    // Measured loss stays visible (not folded into Observations) and withholds the healthy summary.
    await expect(v.locator('.vd-answer')).toContainText('2 orders rows have no matching customers row (customer_id 107); 1 of them has an empty (NULL) key, which never matches.');
    await expect(v.locator('.vd-answer')).toContainText('1 customers row has no matching orders row (customer_id 109) and is not in the result.');
    await expect(findings.locator(':scope > .vd-findings .vd-finding[data-category="observed"]')).toContainText('2 orders rows and 1 customers row have no match and are not in the result.');
    await findings.locator('.vd-observations > summary').click();
    await expect(findings.locator('.vd-observations .vd-finding[data-category="observed"]')).toHaveCount(3);
    await expect(v.locator('.vd-healthy')).toHaveCount(0);

    // Expectation outcome.
    const exp = section(page, 'Expectations');
    await expect(exp.locator('.vd-outcome')).toHaveCount(1);
    await expect(exp.locator('.vd-outcome-badge')).toHaveText('Violated');
    await expect(exp.locator('.vd-outcome')).toContainText('Target: Join 1 · left input');

    // Witnesses: exact keys and counts in report order; NULL keys separate.
    const wit = section(page, 'Witnesses');
    const rows = wit.locator('table tbody tr');
    await expect(rows).toHaveCount(4);
    expect(await cells(rows.nth(0))).toEqual(['Fan-out', '102', '1', '2', '2']);
    expect(await cells(rows.nth(1))).toEqual(['Fan-out', '105', '1', '2', '2']);
    expect(await cells(rows.nth(2))).toEqual(['Unmatched left key', '107', '1', '0', '0']);
    expect(await cells(rows.nth(3))).toEqual(['Unmatched right key', '109', '0', '1', '0']);
    await expect(wit).toContainText('NULL-key rows are counted separately and are never sample keys: 1 left, 0 right.');
    await expect(wit.locator('thead th')).toHaveText(['Evidence', 'customer_id', 'Left rows', 'Right rows', 'Join output']);

    // Coverage and authority.
    const cov = page.locator('article.verdict .vd-all-details');
    await cov.locator(':scope > summary').click();
    await expect(cov).toContainText('Authority: this report is authoritative within the supported join-stage checks');
    await expect(cov).toContainText('whether the query expresses the intended business logic');
    await expect(cov).toContainText('No issues found in these checks is not proof that the query is correct.');

    // No pass mark or score anywhere.
    await expect(v).not.toContainText(/\bpass(ed)?\b|score|confidence \d|%/i);

    await axe(page, 'violation report, light');
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await axe(page, 'violation report, dark');
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await findings.locator('.vd-observations > summary').click(); // collapse again for the overview shots
    await page.locator('.output-body').evaluate((el) => (el.scrollTop = 0));
    await shot(page, `workspace-verdict-tab-${browserName}`);
    await v.getByRole('button', { name: 'Open full view' }).click();
    await expect(page.locator('.workspace-detail')).toBeVisible();
    await shot(page, `verdict-violation-light-${browserName}`);
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await shot(page, `verdict-violation-dark-${browserName}`);
    await axe(page, 'violation report, full view, dark');
  });

  test('golden: legitimate one-to-many LEFT JOIN expansion — unmatched left rows kept, not dropped; declared relationship held; no issues in these checks', async ({ page }) => {
    await ready(page);
    await exec(
      page,
      'CREATE TABLE cust (cid INTEGER, name VARCHAR)',
      "INSERT INTO cust VALUES (1, 'a'), (2, 'b'), (3, 'c')",
      'CREATE TABLE ord (oid INTEGER, cid INTEGER)',
      'INSERT INTO ord VALUES (100, 1), (101, 2), (102, 2)',
    );
    await setSql(page, 'SELECT * FROM cust c LEFT JOIN ord o ON c.cid = o.cid');
    await page.getByRole('tab', { name: 'Verdict' }).first().click();
    await declare(page, 'Relationship', { relationship: 'One-to-many (unique on the left)' });
    await analyze(page);
    const v = verdict(page);
    await expect(v.locator('.vd-tags .badge')).toHaveText(['Current', 'Validated evidence']);
    const overview = section(page, 'Join overview');
    await expect(overview.locator('.join-node[data-side="left"] .node-flow')).toHaveText(/2 matched\s*1 unmatched, kept\s*1 multiplied \(\+1 copies\)/);
    await expect(overview.locator('.join-node[data-kind="output"]')).toContainText('4 rows');
    await expect(overview.locator('.join-node[data-kind="output"]')).toContainText('3 matched pairs');
    await expect(overview.locator('.join-node[data-kind="output"]')).toContainText('1 unmatched left row kept');
    await expect(overview).toContainText('they are preserved, not dropped');
    await overview.locator('.vd-accounting > summary').click();
    const acc = overview.locator('table.accounting tbody tr');
    expect((await cells(acc.nth(8)))[1]).toBe('1'); // kept
    expect((await cells(acc.nth(9))).slice(1)).toEqual(['0', '0']); // dropped: none on either side
    const findings = section(page, 'Findings');
    await expect(v.locator('.vd-healthy')).toHaveText(/No issues found in these checks\./);
    await expect(findings.locator('.vd-finding[data-category="suspicious"], .vd-finding[data-category="expectation-violation"]')).toHaveCount(0);
    await findings.locator('.vd-observations > summary').click();
    await expect(findings.locator('.vd-observations')).toContainText('1 cust row matches several ord rows and appears more than once (1 extra copies).');
    await expect(findings.locator('.vd-observations .vd-finding').first()).toHaveAttribute('data-tone', 'info'); // expansion is an observation
    const exp = section(page, 'Expectations');
    await expect(exp.locator('.vd-outcome-badge')).toHaveText('Held');
    await expect(exp.locator('.vd-outcome')).toHaveAttribute('data-tone', 'success');
    await expect(exp).toContainText('Held on the analysed snapshot, for this rule only.');
    const rows = section(page, 'Witnesses').locator('table tbody tr');
    expect(await cells(rows.nth(0))).toEqual(['Fan-out', '2', '1', '2', '2']);
    expect(await cells(rows.nth(1))).toEqual(['Unmatched left key', '3', '1', '0', '1 kept']);
    await expect(section(page, 'Witnesses')).toContainText('Unmatched right key: No sample keys for this check. Unmatched right rows: 0, of which 0 have a NULL key');
    await axe(page, 'healthy LEFT report');
    await findings.locator('.vd-observations > summary').click();
    await v.getByRole('button', { name: 'Open full view' }).click();
    await shot(page, 'verdict-fanout-healthy-full');
    await page.locator('.workspace-detail').evaluate((el) => (el.scrollTop = 520));
    await shot(page, 'verdict-fanout-healthy-full-lower');
  });

  test('golden: composite keys, integers above 2^53 shown exactly, NULL key components counted separately, many-to-many is a warning', async ({ page }) => {
    await ready(page);
    await exec(
      page,
      'CREATE TABLE a (k1 BIGINT, k2 BIGINT)',
      'INSERT INTO a VALUES (9007199254740993, 1), (9007199254740993, 1), (NULL, 2)',
      'CREATE TABLE b (k1 BIGINT, k2 BIGINT)',
      'INSERT INTO b VALUES (9007199254740993, 1), (9007199254740993, 1), (9223372036854775807, NULL), (9223372036854775806, 3)',
    );
    await setSql(page, 'SELECT * FROM a JOIN b ON a.k1 = b.k1 AND a.k2 = b.k2');
    await page.getByRole('tab', { name: 'Verdict' }).first().click();
    await analyze(page);
    await expect(section(page, 'Join overview').locator('.node-keys')).toHaveText(/a\.k1 = b\.k1\s*AND a\.k2 = b\.k2/);
    const wit = section(page, 'Witnesses');
    await expect(wit.locator('thead th')).toHaveText(['Evidence', 'k1', 'k2', 'Left rows', 'Right rows', 'Join output']);
    const rows = wit.locator('table tbody tr');
    await expect(rows).toHaveCount(2);
    expect(await cells(rows.nth(0))).toEqual(['Fan-out', '9007199254740993', '1', '2', '2', '4']);
    expect(await cells(rows.nth(1))).toEqual(['Unmatched right key', '9223372036854775806', '3', '0', '1', '0']);
    await expect(wit).toContainText('Unmatched left key: No sample keys for this check. Unmatched left rows: 1, of which 1 have a NULL key');
    await expect(wit).toContainText('NULL-key rows are counted separately and are never sample keys: 1 left, 1 right.');
    const findings = section(page, 'Findings');
    // Many-to-many, and loss with fan-out on each side (the NULL-key rows are lost while others multiply).
    await expect(findings.locator('.vd-finding[data-category="suspicious"] .vd-finding-title')).toHaveText(['Many-to-many match', 'Row loss and fan-out together', 'Row loss and fan-out together']);
    await expect(section(page, 'Join overview').locator('.node-rel')).toHaveText(/Whole inputs\s*Many-to-many\s*Matched keys\s*Many-to-many/);
    // The witness filter changes the view only.
    const before = await page.evaluate(() => window.__qvHarness!.engine.statementLog.length);
    await wit.getByRole('tab', { name: 'Unmatched left (0)' }).click();
    await expect(wit.locator('table')).toHaveCount(0);
    await page.keyboard.press('Tab'); // Codex M09: an empty panel is still reached by Tab
    await expect(wit.getByRole('tabpanel')).toBeFocused();
    await wit.getByRole('tab', { name: 'Unmatched left (0)' }).focus();
    await expect(wit.locator('.vd-empty-kinds')).toContainText('No sample keys for this check');
    await wit.getByRole('tab', { name: 'Unmatched left (0)' }).press('ArrowLeft');
    await expect(wit.getByRole('tab', { name: 'Fan-out (1)' })).toBeFocused();
    await expect(wit.locator('table tbody tr')).toHaveCount(1);
    expect(await page.evaluate(() => window.__qvHarness!.engine.statementLog.length)).toBe(before);
  });

  test('golden: unsupported query — named construct, no evidence, every expectation unchecked; ordinary Run SQL still runs it', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    await setSql(page, "SELECT * FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE c.region = 'North'");
    await declare(page, 'No fan-out', { side: 'Left input' });
    await declare(page, 'Output row count', { min: '0', max: '100' });
    await analyze(page);
    const v = verdict(page);
    await expect(v.locator('.vd-tags .badge')).toHaveText(['Current', 'Unsupported']);
    await expect(v.locator('.vd-answer-headline')).toHaveText('Verdict analyzes the join itself, before any WHERE filter, and this query has one.');
    await expect(section(page, 'Findings')).toHaveCount(0); // no measurements: the analyzer's reasons are under Details
    await v.locator('.vd-all-details > summary').click();
    await expect(v.locator('.vd-status-findings')).toContainText('Unsupported: WHERE filter. WHERE is outside the Verdict diagnostic scope');
    await expect(v.locator('.vd-answer')).toContainText('this is a limit of Verdict, not an error in your SQL.');
    await expect(section(page, 'Join overview')).toHaveCount(0);
    await expect(section(page, 'Witnesses')).toHaveCount(0);
    const outcomes = section(page, 'Expectations').locator('.vd-outcome-badge');
    await expect(outcomes).toHaveText(['Unchecked', 'Unchecked']);
    await expect(section(page, 'Expectations')).toContainText('Not checked: Verdict could not analyze this query.');
    await expect(v.locator('form.vd-form')).toHaveCount(0); // no join recognised: no editor
    await expect(v.locator('.vd-healthy')).toHaveCount(0);
    await v.getByRole('button', { name: 'Open full view' }).click();
    await shot(page, 'verdict-unsupported');
    await page.getByRole('button', { name: 'Back to SQL' }).click();
    await axe(page, 'unsupported report');
    // Ordinary SQL works on the same query.
    await page.getByRole('button', { name: 'Run SQL' }).click();
    await page.getByRole('tab', { name: 'Results' }).first().click();
    await expect(page.locator('.result-summary')).toContainText('SQL executed');
  });

  test('golden: SQL error — a binding error and a syntax error are query failures, not data findings', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    await setSql(page, 'SELECT * FROM orders o JOIN customers c ON o.customer_idx = c.customer_id');
    await analyze(page);
    const v = verdict(page);
    await expect(v.locator('.vd-tags .badge')).toHaveText(['Current', 'Query failure']);
    await expect(v.locator('.vd-answer-headline')).toHaveText('Verdict cannot read this query: a table, column or type in it is not valid.');
    await expect(v.locator('.vd-answer')).toContainText('Verdict did not run the query.');
    await v.locator('.vd-all-details > summary').click();
    await expect(v.locator('.vd-status-findings')).toContainText('Query failure: Binding error.');
    await setSql(page, 'SELEC * FROM orders');
    await analyze(page);
    await expect(v.locator('.vd-answer-headline')).toHaveText('Verdict cannot read this query: it has a syntax error.');
    await axe(page, 'query failure report');
  });

  test('golden: diagnostic probe failure — reported as a diagnostic failure that says nothing about the query', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    await declare(page, 'No fan-out', { side: 'Left input' });
    await page.evaluate(() => {
      window.__qvHarness!.engine.faults.after = { match: /qv:statistics/, action: () => { throw new Error('injected probe failure'); } };
    });
    await analyze(page);
    const v = verdict(page);
    await expect(v.locator('.vd-tags .badge')).toHaveText(['Current', 'Diagnostic failure']);
    await expect(v.locator('.vd-answer')).toContainText('A failed check says nothing about whether your query works');
    await v.locator('.vd-all-details > summary').click();
    await expect(v.locator('.vd-status-findings')).toContainText('injected probe failure');
    await expect(section(page, 'Expectations').locator('.vd-outcome-badge')).toHaveText(['Unchecked']);
    await expect(section(page, 'Witnesses')).toHaveCount(0); // no measurements: no evidence sections
    await expect(section(page, 'Join overview')).toHaveCount(0);
    await expect(v.locator('.vd-healthy')).toHaveCount(0);
    await expect(v.locator('.vd-outcome-badge')).not.toHaveText(/Violated|Held/);
    await axe(page, 'diagnostic failure report');
  });

  test('golden: budget refusal (QV-RES-002) — missing witness evidence is limited evidence; expectations unchecked; no violation shown', async ({ page }) => {
    await ready(page, '&executionPairRows=1');
    await illustrative(page);
    await declare(page, 'No fan-out', { side: 'Left input' });
    await analyze(page);
    const v = verdict(page);
    await expect(v.locator('.vd-tags .badge')).toHaveText(['Current', 'Limited evidence']);
    await expect(v.locator('.vd-answer')).toContainText('Limited evidence: some checks were skipped because of the analysis limits');
    await expect(v.locator('.vd-answer')).toContainText('The limits stay in place.');
    await expect(v.locator('.vd-answer')).not.toContainText(/disable|raise the limit|increase/i);
    await expect(section(page, 'Expectations').locator('.vd-outcome-badge')).toHaveText(['Unchecked']);
    await expect(section(page, 'Findings').locator('.vd-finding[data-category="expectation-violation"]')).toHaveCount(0);
    await expect(section(page, 'Findings').locator('.vd-finding').first()).toContainText('Incomplete evidence');
    await expect(section(page, 'Witnesses')).toContainText('not re-counted through the join');
    await expect(v.locator('.vd-healthy')).toHaveCount(0);
    await v.locator('.vd-all-details > summary').click();
    await expect(v.locator('.vd-all-details')).toContainText('Authority: this report is not authoritative.');
    await axe(page, 'budget-limited report');
  });

  test('golden: cancellation — Cancel analysis next to Analyze; terminal cancelled state with no evidence or held/violated outcome; focus returns to Analyze', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    await declare(page, 'No fan-out', { side: 'Left input' });
    await page.evaluate(() => (window.__qvHarness!.engine.faults.hold = /qv:statistics/));
    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__qvHarness!.engine.held.length)).toBe(1);
    const v = verdict(page);
    await expect(v.locator('.vd-progress')).toContainText('Analyzing…');
    await expect(v.locator('.vd-progress')).not.toContainText(/%|remaining|ETA/);
    await axe(page, 'analyzing');
    const cancel = page.getByRole('button', { name: 'Cancel analysis' });
    await cancel.focus();
    await cancel.press('Enter');
    await expect.poll(() => analysisStatus(page)).toBe('settled');
    await page.evaluate(() => (window.__qvHarness!.engine.faults.hold = null));
    await expect(v.locator('.vd-tags .badge')).toHaveText(['Current', 'Cancelled']);
    await expect(v.locator('.vd-answer-headline')).toHaveText('Analysis cancelled. No results from this run are shown.');
    await expect(section(page, 'Join overview')).toHaveCount(0);
    await expect(section(page, 'Expectations').locator('.vd-outcome-badge')).toHaveText(['Unchecked']);
    await expect(v.locator('.vd-healthy')).toHaveCount(0);
    await expect(v.locator('.vd-outcome-badge')).not.toHaveText(/Violated|Held/);
    await expect(page.getByRole('button', { name: 'Analyze', exact: true })).toBeFocused();
    await axe(page, 'cancelled report');
    // The engine is still usable.
    await analyze(page);
    await expect(v.locator('.vd-tags .badge')).toHaveText(['Current', 'Validated evidence']);
  });

  test('rapid analyses: a superseded analysis never publishes; the report is the latest request', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    await page.evaluate(() => {
      const w = window as unknown as { __qvApp: Rt & { reports: { subscribe(f: () => void): () => void } }; __published: string[] };
      w.__published = [];
      const seen = new Set<string>();
      w.__qvApp.reports.subscribe(() => {
        const r = w.__qvApp.reports.getSnapshot().report;
        if (r && !seen.has(r.id)) {
          seen.add(r.id);
          w.__published.push(r.identity.sqlText);
        }
      });
      window.__qvHarness!.engine.faults.hold = /qv:statistics/;
    });
    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__qvHarness!.engine.held.length)).toBe(1);
    await page.evaluate(() => (window.__qvHarness!.engine.faults.hold = null));
    const second = ILLUSTRATIVE_SQL.replace('INNER JOIN', 'LEFT JOIN');
    await setSql(page, second);
    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    await expect.poll(() => analysisStatus(page), { timeout: 30_000 }).toBe('settled');
    const published = await page.evaluate(() => (window as unknown as { __published: string[] }).__published);
    expect(published).toEqual([second]);
    expect((await reportView(page)).report?.identity.sqlText).toBe(second);
    await expect(verdict(page).locator('.vd-identity')).toContainText('LEFT JOIN');
  });

  test('T-ENG-010a and historical rules: SQL edits, data changes and expectation edits make the report historical; a historical violation is never current', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    await declare(page, 'No fan-out', { side: 'Left input' });
    await analyze(page);
    const v = verdict(page);
    await expect(v.locator('.vd-finding[data-category="expectation-violation"]')).toHaveAttribute('data-tone', 'violation');

    // Edit the SQL: historical.
    await setSql(page, ILLUSTRATIVE_SQL + ' ');
    await expect(v.locator('.vd-tags .badge')).toHaveText(['Historical', 'Validated evidence']);
    await expect(v.locator('.vd-answer-headline')).toHaveText('Historical: The SQL was edited after this analysis.');
    const violation = v.locator('.vd-finding[data-category="expectation-violation"]');
    await expect(violation).toHaveAttribute('data-tone', 'neutral');
    await expect(violation.locator('.vd-finding-head')).toHaveText(/Expectation violation · historical\s*·?\s*Expectation was violated/);
    await expect(section(page, 'Expectations').locator('.vd-outcome-badge')).toHaveText('Violated · historical');
    await expect(v.locator('[data-tone="violation"], [data-tone="warning"]')).toHaveCount(0);
    await v.getByRole('button', { name: 'Open full view' }).click();
    await shot(page, 'verdict-historical');
    await page.locator('.workspace-detail').evaluate((el) => (el.scrollTop = 600));
    await shot(page, 'verdict-historical-lower');
    await page.getByRole('button', { name: 'Back to SQL' }).click();
    await axe(page, 'historical report');

    // The same text again, nothing else changed: the same snapshot, so current again.
    await setSql(page, ILLUSTRATIVE_SQL);
    await expect(v.locator('.vd-tags .badge').first()).toHaveText('Current');

    // A data change, then the same SQL: stays historical.
    await exec(page, 'INSERT INTO orders VALUES (7009, 101)');
    await setSql(page, ILLUSTRATIVE_SQL);
    await expect(v.locator('.vd-tags .badge').first()).toHaveText('Historical');
    await expect(v.locator('.vd-answer-headline')).toContainText('Historical: Inputs may have changed since this analysis');
    expect((await reportView(page)).historicalReason).toBe('data may have changed');

    // Re-analyze, then edit the declarations: historical with that reason; outcomes are not shown as evaluated.
    await page.getByRole('tab', { name: 'Verdict' }).first().click();
    await analyze(page);
    await expect(v.locator('.vd-tags .badge').first()).toHaveText('Current');
    await expect(v.locator('.vd-editor')).toContainText('These declarations are the ones evaluated in the current report.');
    await v.getByRole('button', { name: /^Edit expectation 1/ }).click();
    await v.locator('form.vd-form').getByRole('radio', { name: 'Right input' }).check();
    await v.locator('form.vd-form').getByRole('button', { name: 'Save changes' }).click();
    await expect(v.locator('.vd-tags .badge').first()).toHaveText('Historical');
    await expect(v.locator('.vd-answer-headline')).toContainText('Historical: The declared expectations changed after this analysis');
    await expect(v.locator('.vd-editor')).toContainText('Analyze to evaluate these declarations against the current query and data.');
    await expect(section(page, 'Expectations').locator('.vd-outcome-badge')).toHaveText('Violated · historical');
  });

  test('T-ENG-010c: an engine restart makes the report historical and hides the join-key profile', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    await analyze(page);
    await page.getByRole('list', { name: 'Datasets' }).getByRole('button', { name: /^orders Created by SQL/ }).click();
    await page.getByRole('tab', { name: 'Join keys' }).click();
    await expect(page.locator('.key-profile')).toContainText('Left input');
    await page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.session.restart('test: engine replaced'));
    await expect(page.getByRole('status')).toHaveText(/Engine ready|engine (was )?restarted/i, { timeout: 30_000 });
    await expect.poll(async () => (await reportView(page)).historicalReason).toBe('engine restarted');
    await page.getByRole('tab', { name: 'Verdict' }).first().click();
    await expect(verdict(page).locator('.vd-answer-headline')).toContainText('Historical: The engine restarted after this analysis');
    await expect(verdict(page).locator('[data-tone="violation"], [data-tone="warning"]')).toHaveCount(0);
  });

  test('join-key profile: current validated evidence for the selected table and side only; invalidated by a data change; never runs SQL', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    const tree = page.getByRole('list', { name: 'Datasets' });
    await tree.getByRole('button', { name: /^orders Created by SQL/ }).click();
    await page.getByRole('tab', { name: 'Join keys' }).click();
    await expect(page.locator('.tab-panel')).toContainText('Analyze a supported join to inspect its keys.');
    await analyze(page);
    await page.getByRole('tab', { name: 'Dataset' }).first().click();
    await page.getByRole('tab', { name: 'Join keys' }).click();
    const before = await page.evaluate(() => window.__qvHarness!.engine.statementLog.length);
    const profile = page.locator('.key-profile');
    await expect(profile.locator('.key-profile-head')).toHaveText(/Left input · key customer_id INTEGER/);
    const rows = profile.locator('tbody tr');
    expect(await rows.allInnerTexts()).toEqual(['Input rows\t8', 'Distinct non-NULL key groups\t7', 'Duplicate key groups\t0', 'Most rows for one key\t1', 'NULL-key input rows\t1', 'Matched input rows\t6', 'Unmatched input rows\t2']);
    await expect(profile).toContainText('not a sample');
    await axe(page, 'join-key profile');
    await tree.getByRole('button', { name: /^customers Created by SQL/ }).click();
    await page.getByRole('tab', { name: 'Join keys' }).click();
    await expect(profile.locator('.key-profile-head')).toHaveText(/Right input · key customer_id INTEGER/);
    expect(await profile.locator('tbody tr').nth(2).innerText()).toBe('Duplicate key groups\t2');
    expect(await page.evaluate(() => window.__qvHarness!.engine.statementLog.length)).toBe(before); // nothing ran
    await exec(page, 'CREATE TABLE other (x INTEGER)');
    await expect(page.locator('.tab-panel')).toContainText('No current key profile');
    await tree.getByRole('button', { name: /^other Created by SQL/ }).click();
    await page.getByRole('tab', { name: 'Join keys' }).click();
    await expect(page.locator('.tab-panel')).toContainText('This table is not an input of the latest Verdict report.');
  });

  test('full-width view: opens from the Verdict tab, Back to SQL restores the editor with its selection, and Results are kept', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    await page.getByRole('button', { name: 'Run SQL' }).click();
    await expect(page.locator('.result-summary')).toContainText('SQL executed');
    const editor = page.getByRole('textbox', { name: 'SQL editor' });
    await editor.click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(page.locator('.cursor-pos')).toHaveText('Ln 2, Col 3 (1 selected)');
    await page.keyboard.press('ControlOrMeta+Shift+Enter'); // Analyze from the editor
    await expect.poll(() => analysisStatus(page), { timeout: 30_000 }).toBe('settled');
    await expect(editor).toBeFocused(); // focus stays on the trigger
    await expect(page.getByRole('tab', { name: 'Verdict', selected: true })).toBeVisible();
    await verdict(page).getByRole('button', { name: 'Open full view' }).click();
    await expect(page.locator('.workspace-detail').getByRole('heading', { name: 'Visual Verdict' })).toBeFocused();
    await expect(editor).toBeHidden();
    await axe(page, 'full view');
    await page.getByRole('button', { name: 'Back to SQL' }).click();
    await expect(editor).toBeFocused();
    await expect(page.locator('.cursor-pos')).toHaveText('Ln 2, Col 3 (1 selected)');
    expect((await page.evaluate(() => (window as unknown as { __qvWorkspace: { getSnapshot(): { sql: string } } }).__qvWorkspace.getSnapshot().sql))).toBe(ILLUSTRATIVE_SQL);
    await page.getByRole('tab', { name: 'Results' }).first().click();
    await expect(page.locator('.result-summary')).toContainText('SQL executed');
    await expect(page.locator('.result-table tbody tr[data-row]')).toHaveCount(8);
  });

  test('keyboard: Analyze shortcut is editor-scoped; output tabs switch views without running SQL or analysis', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    await analyze(page);
    const log = () => page.evaluate(() => window.__qvHarness!.engine.statementLog.length);
    const before = await log();
    const tab = page.getByRole('tab', { name: 'Verdict' }).first();
    await tab.focus();
    await tab.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'Results', selected: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Verdict', selected: true })).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Shift+Enter'); // outside the editor: nothing happens
    expect(await log()).toBe(before);
    expect(await analysisStatus(page)).toBe('settled');
    // Witness details and evidence disclosures are reachable by keyboard.
    await page.keyboard.press('Tab'); // into the output view
    const summary = verdict(page).locator('.vd-evidence > summary').first();
    await summary.focus();
    await summary.press('Enter');
    await expect(verdict(page).locator('.vd-evidence').first()).toHaveAttribute('open', '');
  });

  test('expectation authoring: field-level validation, nothing malformed is stored, edit keeps identity and order, remove', async ({ page }) => {
    await ready(page);
    await page.getByRole('tab', { name: 'Verdict' }).first().click();
    const v = verdict(page);
    const form = v.locator('form.vd-form');
    await expect(v.locator('.vd-empty')).toContainText('No analysis yet');
    await axe(page, 'no analysis');
    await form.getByLabel('Rule').selectOption({ label: 'Output row count' });
    await form.getByLabel('Minimum output rows').fill('abc');
    await form.getByRole('button', { name: 'Add expectation' }).click();
    const min = form.getByLabel('Minimum output rows');
    await expect(min).toBeFocused();
    await expect(min).toHaveAttribute('aria-invalid', 'true');
    await expect(min).toHaveAccessibleDescription('Enter a whole number of 0 or more, digits only.');
    await axe(page, 'invalid expectation');
    await min.fill('10');
    await form.getByLabel('Maximum output rows').fill('5');
    await form.getByRole('button', { name: 'Add expectation' }).click();
    await expect(form.getByLabel('Maximum output rows')).toHaveAccessibleDescription('The maximum must be at least the minimum.');
    await min.fill('');
    await form.getByLabel('Maximum output rows').fill('');
    await form.getByRole('button', { name: 'Add expectation' }).click();
    await expect(form.locator('.vd-error')).toHaveText('Enter a minimum, a maximum or both.');
    await form.getByLabel('Minimum output rows').fill('99999999999999999999');
    await form.getByRole('button', { name: 'Add expectation' }).click();
    await expect(min).toHaveAccessibleDescription(/no larger than 9,007,199,254,740,991/);
    await expect(v.locator('.vd-declared li')).toHaveCount(0); // nothing malformed was stored

    await declare(page, 'Output row count', { min: '1', max: '10' });
    await declare(page, 'No row loss', { side: 'Right input' });
    await declare(page, 'Relationship', { relationship: 'Many-to-one (unique on the right)' });
    await expect(v.locator('.vd-declared li .vd-declared-text')).toHaveText([
      /1\. Output rows between 1 and 10 \(inclusive\)/,
      /2\. No row loss on the right/,
      /3\. Relationship at most many-to-one/,
    ]);
    await v.getByRole('button', { name: /^Edit expectation 2/ }).click();
    await form.getByRole('radio', { name: 'Left input' }).check();
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(v.locator('.vd-declared li .vd-declared-text').nth(1)).toHaveText(/2\. No row loss on the left/);
    const ids = await page.evaluate(() => (window as unknown as { __qvApp: { expectations: { getSnapshot(): { id: number; value: { kind: string } }[] } } }).__qvApp.expectations.getSnapshot().map((e) => `${e.id}:${e.value.kind}`));
    expect(ids).toEqual(['1:row-count', '2:no-row-loss', '3:relationship']);
    await v.getByRole('button', { name: /^Remove expectation 1/ }).click();
    await expect(v.locator('.vd-declared li')).toHaveCount(2);
    await expect(form.getByLabel('Rule')).toBeFocused();
  });

  test('responsive and zoom: narrow layout and 200% zoom keep the report readable without page-level horizontal scrolling', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    await declare(page, 'No fan-out', { side: 'Left input' });
    await analyze(page);
    for (const [w, h] of [[800, 900], [720, 450]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.getByRole('tab', { name: 'Verdict' }).first().click();
      const v = verdict(page);
      await expect(v).toBeVisible();
      await expect(v.getByRole('button', { name: 'Open full view' })).toHaveCount(0); // narrow screens are already one view
      const flow = await v.locator('.join-flow > li').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
      if (w === 720) expect(new Set(flow).size).toBe(1); // 200% zoom: stacked in reading order
      else expect(flow).toEqual([...flow].sort((a, b) => a - b)); // side by side, still in reading order
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow).toBe(0);
      await axe(page, `narrow ${w}x${h}`);
    }
  });

  test('privacy: Analyze, rendering and the join-key profile make no request beyond the app’s own static assets', async ({ page, context }) => {
    const requests = captureRequests(context);
    await ready(page);
    await illustrative(page);
    await analyze(page);
    await page.getByRole('list', { name: 'Datasets' }).getByRole('button', { name: /^orders Created by SQL/ }).click();
    await page.getByRole('tab', { name: 'Join keys' }).click();
    await expect(page.locator('.key-profile')).toBeVisible();
    const foreign = requests.filter((r) => !r.url().startsWith('http://127.0.0.1:4174/'));
    expect(foreign.map((r) => r.url())).toEqual([]);
    expect(requests.filter((r) => /customer_id|orders|7001/.test(r.url()))).toEqual([]);
  });

  test('Codex M09: an edit during the final hand-off is announced as historical, in the panel, the status region and the narrow summary', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    await declare(page, 'No fan-out', { side: 'Left input' });
    await page.setViewportSize({ width: 375, height: 800 });
    for (const edit of ['sql', 'expectations'] as const) {
      await page.getByRole('tab', { name: 'Editor' }).click();
      await page.evaluate(() => (window.__qvHarness!.engine.faults.hold = /^ROLLBACK/));
      await page.getByRole('button', { name: 'Analyze', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__qvHarness!.engine.held.length)).toBe(1);
      if (edit === 'sql') await setSql(page, ILLUSTRATIVE_SQL + '\n-- edited while finishing');
      else await page.evaluate(() => (window as unknown as { __qvApp: { expectations: { add(e: unknown): unknown } } }).__qvApp.expectations.add({ kind: 'row-count', min: 1 }));
      await page.evaluate(() => {
        const H = window.__qvHarness!.engine;
        H.faults.hold = null;
        H.held.splice(0).forEach((h) => h.release());
      });
      await expect.poll(() => analysisStatus(page), { timeout: 30_000 }).toBe('settled');
      await expect(page.getByRole('status')).toHaveText(/^Analysis finished, but its report is already historical \((query|expectations) changed\)/);
      await expect(page.locator('.inline-note')).toContainText('Verdict: Historical:');
      await page.getByRole('tab', { name: 'Verdict' }).click();
      await expect(verdict(page).locator('.vd-tags .badge').first()).toHaveText('Historical');
      await expect(verdict(page).locator('[data-tone="violation"], [data-tone="warning"], [data-tone="success"]')).toHaveCount(0);
      if (edit === 'sql') await setSql(page, ILLUSTRATIVE_SQL);
    }
  });

  test('Codex M09: a current but non-authoritative partial report shows no current violation', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    const declared = [{ kind: 'no-row-loss', join: 0, side: 'left' }, { kind: 'row-count', min: -1 }];
    await page.evaluate((d) => {
      const rt = (window as unknown as { __qvApp: { analyses: { analyze(s: string, e: unknown[]): void }; reports: { setExpectations(e: unknown[]): void } } }).__qvApp;
      rt.analyses.analyze((window as unknown as { __qvWorkspace: { getSnapshot(): { sql: string } } }).__qvWorkspace.getSnapshot().sql, d);
      rt.reports.setExpectations(d); // the live declarations equal the analysed ones: the report is current
    }, declared);
    await expect.poll(() => analysisStatus(page), { timeout: 30_000 }).toBe('settled');
    const v = verdict(page);
    expect(await reportView(page)).toMatchObject({ current: true, report: { status: 'partially-analyzed', authoritative: false } });
    await expect(v.locator('.vd-tags .badge')).toHaveText(['Current', 'Partially analyzed']);
    await expect(section(page, 'Expectations').locator('.vd-outcome-badge')).toHaveText(['Violated · not authoritative', 'Unchecked']);
    await expect(v.locator('.vd-finding[data-category="expectation-violation"]')).toHaveAttribute('data-tone', 'neutral');
    await expect(v.locator('[data-tone="violation"], [data-tone="warning"], [data-tone="success"]')).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText(/^Verdict: .* Limited evidence: not authoritative\.$/);
    await axe(page, 'partial report');
  });

  test('Codex M09: on a narrow screen the Verdict view has its own Cancel; focus goes to the Verdict heading after cancelling', async ({ page }) => {
    await ready(page);
    await illustrative(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.getByRole('tab', { name: 'Editor' }).click();
    await page.evaluate(() => (window.__qvHarness!.engine.faults.hold = /qv:statistics/));
    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__qvHarness!.engine.held.length)).toBe(1);
    await page.getByRole('tab', { name: 'Verdict' }).click();
    const cancel = verdict(page).getByRole('button', { name: 'Cancel analysis' });
    await expect(cancel).toBeVisible();
    await cancel.focus();
    await cancel.press('Enter');
    await expect.poll(() => analysisStatus(page)).toBe('settled');
    await page.evaluate(() => (window.__qvHarness!.engine.faults.hold = null));
    await expect(verdict(page).locator('.vd-answer-headline')).toHaveText('Analysis cancelled. No results from this run are shown.');
    await expect(verdict(page).getByRole('heading', { name: 'Visual Verdict' })).toBeFocused();
  });

  test('Codex M09: row loss alone withholds the healthy summary and stays visible', async ({ page }) => {
    await ready(page);
    await exec(page, 'CREATE TABLE l (k INTEGER)', 'INSERT INTO l VALUES (1), (2), (2)', 'CREATE TABLE r (k INTEGER)', 'INSERT INTO r VALUES (1), (3)');
    await setSql(page, 'SELECT * FROM l JOIN r ON l.k = r.k');
    await page.getByRole('tab', { name: 'Verdict' }).first().click();
    await analyze(page);
    const findings = section(page, 'Findings');
    await expect(verdict(page).locator('.vd-tags .badge')).toHaveText(['Current', 'Validated evidence']);
    await expect(verdict(page).locator('.vd-healthy')).toHaveCount(0);
    await expect(verdict(page).locator('.vd-answer-headline')).toHaveText('The result has 1 row from 3 l rows: 2 l rows are missing (no matching r row).');
    await expect(findings.locator(':scope > .vd-findings')).toContainText('Unmatched rows dropped');
  });

  test('Codex M09: a refused expectation has its error attached before focus moves, and is announced', async ({ page }) => {
    await ready(page);
    await page.getByRole('tab', { name: 'Verdict' }).first().click();
    const form = verdict(page).locator('form.vd-form');
    await form.getByLabel('Rule').selectOption({ label: 'Output row count' });
    const min = form.getByLabel('Minimum output rows');
    await min.evaluate((el) => {
      el.addEventListener('focus', () => {
        (window as unknown as { __atFocus: unknown }).__atFocus = { invalid: el.getAttribute('aria-invalid'), described: el.getAttribute('aria-describedby') && document.getElementById(el.getAttribute('aria-describedby')!)?.textContent };
      });
    });
    await min.fill('1e3');
    await form.getByRole('button', { name: 'Add expectation' }).click();
    await expect(min).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { __atFocus: unknown }).__atFocus)).toEqual({ invalid: 'true', described: 'Enter a whole number of 0 or more, digits only.' });
    await expect(page.getByRole('status')).toHaveText('Expectation not saved: Enter a whole number of 0 or more, digits only.');
    // Submitting again with focus already on the field still announces.
    await page.evaluate(() => (window as unknown as { __qvApp: { announcer: { announce(m: string): void } } }).__qvApp.announcer.announce('…'));
    await min.press('Enter');
    await expect(page.getByRole('status')).toHaveText('Expectation not saved: Enter a whole number of 0 or more, digits only.');
  });
});
