// M12 Evidence copy and replay bundle (PRD QV-UI-003; ARCHITECTURE §18.2; AM-019).
//
// Part 1 (harness, real engine): every replay bundle is RUN statement by statement on the same
// deterministic tables the analysis read, and every labelled result is compared with three
// independent answers: the value in the report (`expect`), the brute-force Python oracle's value
// for the case (tests/fixtures/verdict/cases.json, written by tests/oracle/oracle.py, not by the
// code under test) and, for the output rows, DuckDB's own count of the query run as ordinary SQL.
// It also checks what a bundle must never contain, stable names and collisions, and that unmet
// prerequisites show up as failures or mismatches instead of passing.
//
// Part 2 (production App in the harness app view): the copy preview dialogs — nothing is copied
// without the Copy button, the copied text equals the preview, privacy defaults, clipboard
// failures, report changes while open, focus, axe in both themes, network and storage isolation.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AXE_TAGS, captureRequests, HARNESS } from './helpers';

interface Case {
  name: string;
  sql: string;
  tables: Record<string, { columns: [string, string][]; rows: (string | null)[][] }>;
  expectations: unknown[];
  expected: { status: string; authoritative: boolean; stats: Record<string, string>; derived: Record<string, string>; witnesses: { kind: string; key: string[]; leftRows: string; rightRows: string; outputRows: string }[] };
}
const CASES = (JSON.parse(readFileSync(path.resolve('tests/fixtures/verdict/cases.json'), 'utf8')) as { cases: Case[] }).cases;
const CHUNK = 16;
const SHOTS = process.env.QV_SHOTS ?? '';

/** Statements a replay bundle must never contain (AM-019). */
const FORBIDDEN: readonly [string, string][] = [
  ['fingerprint', String.raw`\bhash\s*\(|bit_xor`],
  ['catalog probe', String.raw`duckdb_(tables|columns|views|settings|databases)|information_schema|current_setting|current_database|current_schema|txid_current`],
  ['transaction control', String.raw`^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|ABORT|END)\b`],
  ['probe tag', String.raw`/\*qv:`],
  ['random analyser name', String.raw`__qv_[0-9a-f]{16}`],
  ['parser or bind statement', String.raw`\bDESCRIBE\b|json_serialize_sql|json_deserialize_sql`],
  ['data change', String.raw`\b(DROP|INSERT|UPDATE|DELETE|ALTER|TRUNCATE|COPY|ATTACH)\b|OR\s+REPLACE`],
];

async function open(page: Page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__qvHarness?.verdict !== undefined);
  await page.evaluate(() => window.__qvHarness!.verdict!.setup());
}

/**
 * In the page: creates each case's tables, analyses it, runs its replay bundle and compares every
 * labelled result with the report, the oracle and DuckDB. Returns problems (must be none).
 */
function sweep(page: Page, cases: Case[]) {
  return page.evaluate(async ({ cases, forbidden }) => {
    const V = window.__qvHarness!.verdict!;
    const s = () => V.current().session;
    const problems: string[] = [];
    let replayed = 0;
    let statements = 0;
    const res = (rows: readonly (readonly (string | null)[])[] | null) => (rows && rows.length ? rows.map((r) => r.map((c) => c ?? 'NULL').join(', ')).join('; ') : '(no rows)');
    for (const c of cases) {
      for (const [name, t] of Object.entries(c.tables)) await V.table(name, t.columns, t.rows);
      const { report } = await V.analyze(c.sql, c.expectations);
      const bad = (what: string) => problems.push(`${c.name}: ${what}`);
      if (!report.authoritative) {
        if (report.replay !== null) bad('a non-authoritative report carries a replay bundle');
        if (!report.replayUnavailable) bad('a report without a replay says nothing about why');
        continue;
      }
      const b = report.replay;
      if (!b) {
        bad(`authoritative report without a replay: ${report.replayUnavailable}`);
        continue;
      }
      replayed++;
      const info = s().info!;
      if (b.engine.duckdb !== info.duckdb || b.engine.package !== info.packageVersion) bad(`engine stamp ${JSON.stringify(b.engine)} is not the session's ${info.duckdb} / ${info.packageVersion}`);
      for (const st of b.statements) for (const [what, re] of forbidden) if (new RegExp(re, 'i').test(st.sql)) bad(`statement "${st.label}" contains a ${what}`);
      const oracle = (m: string): string | undefined => {
        const e = c.expected;
        if (m.startsWith('stats.')) return e.stats[m.slice(6)];
        if (m.startsWith('derived.')) return e.derived[m.slice(8)];
        const kind = /^witnesses\.(.+)$/.exec(m);
        if (kind) {
          const ws = e.witnesses.filter((w) => w.kind === kind[1]);
          return ws.length ? ws.map((w) => [...w.key, w.leftRows, w.rightRows].join(', ')).join('; ') : '(no rows)';
        }
        const one = /^witnesses\[(\d+)\]\.(leftRows|rightRows|outputRows)$/.exec(m);
        if (one) return e.witnesses[Number(one[1])]?.[one[2] as 'leftRows'];
        return undefined;
      };
      for (const st of b.statements) {
        statements++;
        const r = await V.sql(s(), st.sql, { maxRows: 100 });
        if (r.terminal.status !== 'ok') {
          bad(`statement "${st.label}" failed: ${JSON.stringify(r.terminal)}`);
          continue;
        }
        if (st.expect === undefined) continue;
        const got = res(r.rows);
        if (got !== st.expect) bad(`"${st.label}": replay gave ${got}, the report says ${st.expect}`);
        if (!st.measures) bad(`"${st.label}" has an expected value without its source`);
        else {
          const want = oracle(st.measures);
          if (want === undefined) bad(`"${st.label}": no oracle value for ${st.measures}`);
          else if (got !== want) bad(`"${st.label}": replay gave ${got}, the oracle says ${want}`);
        }
        if (st.measures === 'derived.outputRows') {
          const direct = await V.sql(s(), `SELECT count(*)::VARCHAR FROM (${c.sql})`);
          if (direct.rows?.[0]?.[0] !== got) bad(`output rows: replay gave ${got}, DuckDB's count of the query is ${direct.rows?.[0]?.[0]}`);
        }
      }
      // Test clean-up only (the bundle itself drops nothing).
      for (const t of b.temporaryTables) await V.exec(`DROP TABLE temp.main."${t.replaceAll('"', '""')}"`);
    }
    return { problems, replayed, statements, leftovers: await V.leftovers() };
  }, { cases, forbidden: FORBIDDEN });
}

test.describe('Replay bundle reproduces every labelled count (harness, real engine)', () => {
  test.setTimeout(180_000);
  for (let i = 0; i < CASES.length; i += CHUNK) {
    const chunk = CASES.slice(i, i + CHUNK);
    test(`cases ${i + 1}–${i + chunk.length} (${chunk[0]!.name} … ${chunk.at(-1)!.name})`, async ({ page }) => {
      await open(page);
      const r = await sweep(page, chunk);
      expect(r.problems).toEqual([]);
      expect(r.leftovers).toEqual([]);
      expect(r.replayed).toBe(chunk.filter((c) => c.expected.authoritative).length);
      expect(r.statements).toBeGreaterThan(0);
    });
  }

  test('the replayed corpus covers the required shapes', () => {
    const names = CASES.filter((c) => c.expected.authoritative).map((c) => c.name);
    for (const required of ['one_to_one', 'one_to_many_legitimate', 'many_to_many', 'composite_partial_nulls', 'all_null_keys', 'empty_left_inner', 'empty_right_left', 'both_empty',
      'offsetting_fan_out_and_loss', 'bigint_beyond_2_53', 'hugeint_extremes', 'uhugeint_max', 'quoted_identifiers', 'using_join', 'self_join_aliases']) {
      expect(names).toContain(required);
    }
    const types = new Set(CASES.filter((c) => c.expected.authoritative).map((c) => /\bLEFT\b/i.test(c.sql) ? 'LEFT' : 'INNER'));
    expect([...types].sort()).toEqual(['INNER', 'LEFT']);
  });
});

/** Tables for the targeted harness tests: fan-out, loss, NULL keys, a key above 2^53, a composite key. */
const BIG = '9007199254740993'; // 2^53 + 1: not representable as a JavaScript number
async function fixture(page: Page, left = 'a', right = 'b') {
  await page.evaluate(async ({ left, right, BIG }) => {
    const V = window.__qvHarness!.verdict!;
    await V.table(left, [['k', 'BIGINT'], ['j', 'INTEGER']], [[BIG, '1'], [BIG, '1'], ['2', '1'], ['3', '1'], [null, '1'], ['5', null]]);
    await V.table(right, [['k', 'BIGINT'], ['j', 'INTEGER']], [[BIG, '1'], [BIG, '1'], ['2', '1'], ['4', '1'], [null, null]]);
  }, { left, right, BIG });
}

/** Runs a bundle in the page and returns each statement's outcome. */
function replay(page: Page, bundle: unknown) {
  return page.evaluate(async (b) => {
    const V = window.__qvHarness!.verdict!;
    const out: { label: string; expect?: string; got?: string; error?: string }[] = [];
    for (const st of (b as { statements: { label: string; sql: string; expect?: string }[] }).statements) {
      const r = await V.sql(V.current().session, st.sql, { maxRows: 100 });
      const got = r.rows && r.rows.length ? r.rows.map((x) => x.map((c) => c ?? 'NULL').join(', ')).join('; ') : '(no rows)';
      out.push({ label: st.label, ...(st.expect !== undefined ? { expect: st.expect } : {}), ...(r.terminal.status === 'ok' ? { got } : { error: JSON.stringify(r.terminal) }) });
    }
    return out;
  }, bundle);
}

const analyzeIn = (page: Page, sql: string, expectations: unknown[] = []) =>
  page.evaluate(async ({ sql, expectations }) => (await window.__qvHarness!.verdict!.analyze(sql, expectations)).report, { sql, expectations });

test.describe('Replay bundle: names, collisions and prerequisites (harness)', () => {
  test('composite key with fan-out, loss, NULL keys and a key above 2^53: every labelled value reproduces exactly', async ({ page }) => {
    await open(page);
    await fixture(page);
    for (const type of ['INNER', 'LEFT']) {
      const report = await analyzeIn(page, `SELECT * FROM a ${type} JOIN b ON a.k = b.k AND a.j = b.j`);
      expect(report.authoritative).toBe(true);
      const b = report.replay!;
      expect(b.temporaryTables).toEqual(['qv_replay_left_freq', 'qv_replay_right_freq', 'qv_replay_matched']);
      const out = await replay(page, b);
      expect(out.filter((o) => o.error)).toEqual([]);
      expect(out.filter((o) => o.expect !== undefined && o.got !== o.expect)).toEqual([]);
      // The fan-out witness key is the exact 2^53 + 1 value, not a rounded double.
      expect(b.statements.find((s) => s.measures === 'witnesses.fan-out')!.expect).toBe(`${BIG}, 1, 2, 2`);
      expect(b.statements.find((s) => s.measures === 'derived.outputRows')!.expect).toBe(type === 'INNER' ? '5' : '8');
      await page.evaluate(() => window.__qvHarness!.verdict!.exec('DROP TABLE temp.main.qv_replay_left_freq', 'DROP TABLE temp.main.qv_replay_right_freq', 'DROP TABLE temp.main.qv_replay_matched'));
    }
  });

  test('temporary names never equal an input table or alias (case-insensitive), and the bundle still reproduces', async ({ page }) => {
    await open(page);
    await fixture(page, 'qv_replay_left_freq', 'QV_REPLAY_RIGHT_FREQ');
    const report = await analyzeIn(page, 'SELECT * FROM qv_replay_left_freq AS qv_replay_left_freq_2 JOIN "QV_REPLAY_RIGHT_FREQ" AS r ON qv_replay_left_freq_2.k = r.k');
    const b = report.replay!;
    expect(b.temporaryTables).toEqual(['qv_replay_left_freq_3', 'qv_replay_right_freq_2', 'qv_replay_matched']);
    const out = await replay(page, b);
    expect(out.filter((o) => o.error)).toEqual([]);
    expect(out.filter((o) => o.expect !== undefined && o.got !== o.expect)).toEqual([]);
  });

  test('a user table that shares a replay name is never overwritten: the temporary table shadows it and the counts still reproduce', async ({ page }) => {
    await open(page);
    await fixture(page);
    await page.evaluate(() => window.__qvHarness!.verdict!.table('qv_replay_left_freq', [['note', 'VARCHAR']], [['user data']]));
    const report = await analyzeIn(page, 'SELECT * FROM a JOIN b ON a.k = b.k');
    const out = await replay(page, report.replay!);
    expect(out.filter((o) => o.error)).toEqual([]);
    expect(out.filter((o) => o.expect !== undefined && o.got !== o.expect)).toEqual([]);
    const user = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      return (await V.sql(V.current().session, 'SELECT note FROM memory.main.qv_replay_left_freq')).rows;
    });
    expect(user).toEqual([['user data']]);
  });

  test('unmet prerequisites are visible: changed data mismatches, a missing table fails, an existing temporary table is not overwritten', async ({ page }) => {
    await open(page);
    await fixture(page);
    const report = await analyzeIn(page, 'SELECT * FROM a LEFT JOIN b ON a.k = b.k');
    const b = report.replay!;
    const dropReplay = () => page.evaluate(() => window.__qvHarness!.verdict!.exec('DROP TABLE IF EXISTS temp.main.qv_replay_left_freq', 'DROP TABLE IF EXISTS temp.main.qv_replay_right_freq', 'DROP TABLE IF EXISTS temp.main.qv_replay_matched'));
    // 1. A temporary table of the same name already exists: CREATE fails and that table is unchanged.
    await page.evaluate(() => window.__qvHarness!.verdict!.exec('CREATE TEMP TABLE qv_replay_left_freq AS SELECT 42 AS answer'));
    let out = await replay(page, b);
    expect(out.find((o) => o.label.startsWith('Setup: key frequencies of the left table'))!.error).toMatch(/already exists/i);
    const kept = await page.evaluate(async () => {
      const V = window.__qvHarness!.verdict!;
      return (await V.sql(V.current().session, 'SELECT answer::VARCHAR FROM temp.main.qv_replay_left_freq')).rows;
    });
    expect(kept).toEqual([['42']]);
    await dropReplay();
    // 2. Different data: the row count and the output rows disagree with the report.
    await page.evaluate(() => window.__qvHarness!.verdict!.exec('INSERT INTO a VALUES (2, 1)'));
    out = await replay(page, b);
    const mismatched = out.filter((o) => o.expect !== undefined && o.got !== undefined && o.got !== o.expect).map((o) => o.label);
    expect(mismatched).toContain('Rows in the left table');
    expect(mismatched.some((l) => l.startsWith('Output rows'))).toBe(true);
    await dropReplay();
    // 3. A missing input table: the statements that read it fail.
    await page.evaluate(() => window.__qvHarness!.verdict!.exec('DROP TABLE b'));
    out = await replay(page, b);
    expect(out.find((o) => o.label === 'Rows in the right table')!.error).toBeTruthy();
    expect(out.find((o) => o.label.startsWith('Output rows'))!.error).toBeTruthy();
    expect(out.filter((o) => o.error === undefined && o.expect !== undefined && o.got === o.expect && /right/i.test(o.label) && !/^Left|left table/.test(o.label))).toEqual([]);
  });

  test('no replay for a report that is not authoritative: unsupported, partially analysed, budget-limited', async ({ page }) => {
    await open(page);
    await fixture(page);
    const unsupported = await analyzeIn(page, 'SELECT * FROM a JOIN b ON a.k + 1 = b.k');
    expect(unsupported.authoritative).toBe(false);
    expect(unsupported.replay).toBeNull();
    expect(unsupported.replayUnavailable).toMatch(/only for an authoritative report/);
    const partial = await analyzeIn(page, 'SELECT * FROM a JOIN b ON a.k = b.k', [{ kind: 'metric-preserved', column: 'k' }]);
    expect(partial.status).toBe('partially-analyzed');
    expect(partial.replay).toBeNull();
    await page.evaluate(() => window.__qvHarness!.verdict!.setup({ executionPairRows: '1' }));
    await fixture(page);
    const limited = await analyzeIn(page, 'SELECT * FROM a JOIN b ON a.k = b.k');
    expect(limited.authoritative).toBe(false);
    expect(limited.join?.stats).not.toBeNull(); // measurements shown as limited evidence…
    expect(limited.replay).toBeNull(); // …are never promoted into a reproducible replay
  });
});

// ---------------------------------------------------------------------------------------------
// Part 2: the copy preview in the production App.

const APP_VIEW = `${HARNESS}?view=app`;
const SENTINEL = { table: 'zq_secret_orders', other: 'zq_secret_customers', column: 'zq_secret_cust', alias: 'zq_alias', comment: 'zq_secret_comment', key: '987654321987654321' };
const PRIVATE_SQL = `SELECT ${SENTINEL.alias}_o.* /* ${SENTINEL.comment} */\nFROM ${SENTINEL.table} AS ${SENTINEL.alias}_o\nLEFT JOIN ${SENTINEL.other} AS c ON ${SENTINEL.alias}_o.${SENTINEL.column} = c.${SENTINEL.column}`;

type Rt = {
  queries: { run(statements: string[], source: string): void; getSnapshot(): { state: { status: string; message?: string } } };
  analyses: { getSnapshot(): { status: string } };
  reports: { getSnapshot(): { report: null | { id: string; status: string; authoritative: boolean; identity: { queryHash: string; sqlText: string; inputs: { oid: string }[] } }; current: boolean } };
};

async function ready(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(APP_VIEW);
  await expect(page.locator('footer.status-strip').getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
}

async function exec(page: Page, ...statements: string[]) {
  const out = await page.evaluate(async (stmts) => {
    const rt = (window as unknown as { __qvApp: Rt }).__qvApp;
    for (const q of stmts) {
      rt.queries.run([q], q);
      for (let i = 0; i < 1000; i++) {
        if (!['queued', 'running', 'cancelling'].includes(rt.queries.getSnapshot().state.status)) break;
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
const verdict = (page: Page) => page.locator('article.verdict');
const dialog = (page: Page) => page.getByRole('dialog');
const preview = (page: Page) => dialog(page).locator('pre.copy-text');

async function analyze(page: Page) {
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.analyses.getSnapshot().status), { timeout: 30_000 }).toBe('settled');
}

/** A private dataset: sentinel names, a sentinel key value (a witness) and a sentinel comment in the SQL. */
async function privateReport(page: Page) {
  await exec(page,
    `CREATE TABLE ${SENTINEL.table} (id INTEGER, ${SENTINEL.column} BIGINT)`,
    `INSERT INTO ${SENTINEL.table} VALUES (1, ${SENTINEL.key}), (2, ${SENTINEL.key}), (3, 11), (4, NULL), (5, 12)`,
    `CREATE TABLE ${SENTINEL.other} (${SENTINEL.column} BIGINT, region VARCHAR)`,
    `INSERT INTO ${SENTINEL.other} VALUES (${SENTINEL.key}, 'n'), (${SENTINEL.key}, 's'), (11, 'e'), (13, 'w')`,
  );
  await setSql(page, PRIVATE_SQL);
  await page.getByRole('tab', { name: 'Verdict' }).first().click();
  await analyze(page);
  const view = await page.evaluate(() => (window as unknown as { __qvApp: Rt }).__qvApp.reports.getSnapshot());
  expect(view.report && [view.report.authoritative, view.report.status, (view.report as unknown as { nonAuthoritativeReasons: string[] }).nonAuthoritativeReasons]).toEqual([true, "analyzed", []]);
  return view.report!;
}

/** Replaces the clipboard with a recorder (or a failing / missing one). Returns nothing. */
async function stubClipboard(page: Page, mode: 'record' | 'deny' | 'reject' | 'missing' | 'hold') {
  await page.evaluate((mode) => {
    const w = window as unknown as { __copied: string[]; __held: { resolve(): void; reject(e: unknown): void }[] };
    w.__copied = [];
    w.__held = [];
    const writeText = (t: string) => {
      if (mode === 'hold') {
        // Pending until the test settles it: the text counts as written only on success.
        return new Promise<void>((resolve, reject) => w.__held.push({ resolve: () => (w.__copied.push(t), resolve()), reject }));
      }
      if (mode === 'deny') return Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
      if (mode === 'reject') return Promise.reject(new Error('clipboard busy'));
      w.__copied.push(t);
      return Promise.resolve();
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => (mode === 'missing' ? undefined : { writeText }) });
  }, mode);
}
const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

async function axe(page: Page, label: string) {
  if (page.context().browser()?.browserType().name() === 'firefox') return; // P-083
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude('body > p').analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.describe('Copy preview in the workspace', () => {
  test.setTimeout(90_000);

  test('summary: private values are left out by default; options add them; the copied text equals the preview; nothing is copied without Copy', async ({ page, context, browserName }) => {
    const requests = captureRequests(context);
    await ready(page);
    const report = await privateReport(page);
    await stubClipboard(page, 'record');
    const opener = verdict(page).getByRole('button', { name: 'Copy summary…' });
    await opener.click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole('heading', { name: 'Copy summary' })).toBeFocused();
    const text = (await preview(page).textContent())!;
    // Default: no SQL, no table/column/alias names, no witness values, no ids or hashes.
    for (const s of [...Object.values(SENTINEL), report.id, report.identity.queryHash, report.identity.queryHash.slice(0, 16), ...report.identity.inputs.map((i) => `catalog id ${i.oid}`), 'SELECT']) {
      expect(text, `default summary leaks ${s}`).not.toContain(s);
    }
    expect(text).not.toMatch(/anonym/i);
    expect(text).toContain('Report: current.');
    expect(text).toContain('LEFT JOIN of the left table and the right table on 1 key column (BIGINT).');
    expect(text).toContain('- Output rows: 7.');
    expect(text).toContain('Left out of this summary: the analysed SQL; table, alias and column names in the Join and Measured lines; the witness keys section.');
    await shot(page, `m12-summary-light-${browserName}`);
    // Toggles change the preview at once and copy nothing.
    await dialog(page).getByRole('checkbox', { name: 'SQL text' }).check();
    await expect(preview(page)).toContainText(SENTINEL.comment);
    await dialog(page).getByRole('checkbox', { name: 'Table and column names' }).check();
    await expect(preview(page)).toContainText(`"${SENTINEL.table}" AS "${SENTINEL.alias}_o"`);
    await dialog(page).getByRole('checkbox', { name: 'Witness key values' }).check();
    await expect(preview(page)).toContainText(`fan-out key (${SENTINEL.key})`);
    expect(await copied(page)).toEqual([]);
    // Copy writes exactly the preview, announces in the dialog's status region and keeps focus.
    const copyBtn = dialog(page).getByRole('button', { name: 'Copy summary' });
    await copyBtn.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page).getByRole('status')).toHaveText(/^Summary copied to the clipboard: \d+ lines, exactly as shown\.$/);
    await expect(copyBtn).toBeFocused();
    expect(await copied(page)).toEqual([await preview(page).textContent()]);
    // Escape closes, focus returns to the opener; options are not kept.
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(dialog(page).getByRole('checkbox', { name: 'SQL text' })).not.toBeChecked();
    expect(await preview(page).textContent()).toBe(text);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    expect(await copied(page)).toHaveLength(1);
    // Nothing left the page and nothing was stored.
    const state = await page.evaluate(async () => ({
      local: localStorage.length, session: sessionStorage.length, cookie: document.cookie,
      idb: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
      caches: 'caches' in self ? (await caches.keys()).length : 0, url: location.search + location.hash,
    }));
    expect(state).toEqual({ local: 0, session: 0, cookie: '', idb: 0, caches: 0, url: '?view=app' });
    const origin = new URL(HARNESS).origin;
    expect(requests.map((r) => r.url()).filter((u) => !u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
    expect(requests.some((r) => r.url().includes(SENTINEL.table) || r.url().includes(SENTINEL.key))).toBe(false);
  });

  test('diagnostic SQL: the preview is the version-stamped script; Copy writes exactly it; it is never run', async ({ page, browserName }) => {
    await ready(page);
    await privateReport(page);
    await stubClipboard(page, 'record');
    const engine = await page.evaluate(() => (window as unknown as { __qvApp: { session: { info: { duckdb: string; packageVersion: string } } } }).__qvApp.session.info);
    const before = await page.evaluate(() => (window as unknown as { __qvApp: { session: { epoch: number } } }).__qvApp.session.epoch);
    const opener = verdict(page).getByRole('button', { name: 'View diagnostic SQL' });
    await opener.click();
    const text = (await preview(page).textContent())!;
    expect(text).toContain(`-- Engine: DuckDB ${engine.duckdb} · duckdb-wasm ${engine.packageVersion}`);
    expect(text).toMatch(/-- Current report, finalised at \d\d:\d\d:\d\d\./);
    expect(text).toContain('-- Prerequisites:');
    expect(text).toContain(`Left table "${SENTINEL.table}", referenced as "${SENTINEL.alias}_o"`);
    expect(text).toMatch(/-- \[\d+\] Output rows of the LEFT JOIN[^\n]*\n-- expect: 7\n/);
    // The statements (comment lines removed) contain no fingerprint, catalog probe, transaction control or probe tag.
    expect(text.split('\n').filter((l) => !l.startsWith('--')).join('\n')).not.toMatch(/\bhash\s*\(|duckdb_tables|ROLLBACK|BEGIN|\/\*qv:/);
    await shot(page, `m12-replay-light-${browserName}`);
    // Keyboard can scroll the preview region.
    const region = dialog(page).getByRole('region', { name: /Diagnostic SQL preview/ });
    await region.focus();
    await page.keyboard.press('PageDown');
    await expect.poll(() => region.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await axe(page, 'diagnostic SQL dialog, light');
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await axe(page, 'diagnostic SQL dialog, dark');
    await shot(page, `m12-replay-dark-${browserName}`);
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    expect(await copied(page)).toEqual([]);
    await dialog(page).getByRole('button', { name: 'Copy diagnostic SQL' }).click();
    await expect(dialog(page).getByRole('status')).toHaveText(/^Diagnostic SQL copied to the clipboard/);
    expect(await copied(page)).toEqual([text]);
    // Nothing ran: the data epoch is unchanged and no replay table exists.
    const after = await page.evaluate(async () => {
      const app = (window as unknown as { __qvApp: { session: { epoch: number } } }).__qvApp;
      return app.session.epoch;
    });
    expect(after).toBe(before);
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();
  });

  test('summary dialog: axe in both themes, and screenshots', async ({ page, browserName }) => {
    await ready(page);
    await privateReport(page);
    await verdict(page).getByRole('button', { name: 'Copy summary…' }).click();
    await axe(page, 'summary dialog, light');
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await axe(page, 'summary dialog, dark');
    await shot(page, `m12-summary-dark-${browserName}`);
  });

  for (const mode of ['deny', 'reject', 'missing'] as const) {
    test(`clipboard ${mode}: the failure is announced, nothing is claimed copied, focus stays`, async ({ page }) => {
      await ready(page);
      await privateReport(page);
      await stubClipboard(page, mode);
      await verdict(page).getByRole('button', { name: 'Copy summary…' }).click();
      const btn = dialog(page).getByRole('button', { name: 'Copy summary' });
      await btn.focus(); // keyboard activation: a pointer click does not focus buttons in WebKit
      await page.keyboard.press('Enter');
      const msg = mode === 'deny' ? /denied clipboard permission/ : mode === 'reject' ? /could not write to the clipboard/ : /does not offer clipboard access/;
      await expect(dialog(page).getByRole('status')).toHaveText(msg);
      await expect(dialog(page).getByRole('status')).toContainText('was not copied');
      await expect(dialog(page).getByRole('status')).not.toContainText('copied to the clipboard');
      await expect(btn).toBeFocused();
      await expect(dialog(page)).toBeVisible();
    });
  }

  test('report changes while open: a state change relabels the preview; a newer report is announced and only shown on request; nothing is copied meanwhile', async ({ page }) => {
    await ready(page);
    await privateReport(page);
    await stubClipboard(page, 'record');
    await verdict(page).getByRole('button', { name: 'View diagnostic SQL' }).click();
    await expect(preview(page)).toContainText('-- Current report');
    // Data changes (a user statement while the dialog is open): the report becomes historical.
    await exec(page, `INSERT INTO ${SENTINEL.other} VALUES (99, 'x')`);
    await expect(dialog(page).locator('.copy-notice[data-kind="changed"]')).toContainText('now historical: the data may have changed');
    await expect(preview(page)).toContainText('-- HISTORICAL REPORT (the data may have changed)');
    await expect(dialog(page).getByText('Historical', { exact: true })).toBeVisible();
    // A newer analysis publishes a newer report: the preview keeps the opened one, labelled historical.
    const opened = (await preview(page).textContent())!;
    expect(opened).toContain('-- [3] Rows in the right table\n-- expect: 4\n');
    await page.evaluate((sql) => (window as unknown as { __qvApp: { analyses: { analyze(s: string, e: unknown[]): void } } }).__qvApp.analyses.analyze(sql, []), PRIVATE_SQL);
    await expect(dialog(page).locator('.copy-notice[data-kind="newer"]')).toContainText('A newer Verdict report arrived');
    await expect(preview(page)).toContainText('-- HISTORICAL REPORT (a newer analysis replaced it)');
    expect((await preview(page).textContent())!.split('\n').slice(3)).toEqual(opened.split('\n').slice(3)); // same statements
    expect(await copied(page)).toEqual([]);
    await dialog(page).getByRole('button', { name: 'Show the newer report' }).click();
    await expect(dialog(page).locator('.copy-notice')).toHaveCount(0);
    await expect(preview(page)).toContainText('-- Current report');
    // The newer snapshot has one more right row (unmatched, so the LEFT JOIN output is unchanged).
    expect(await preview(page).textContent()).toContain('-- [3] Rows in the right table\n-- expect: 5\n');
    expect(await copied(page)).toEqual([]);
  });

  test('a report that is not authoritative: diagnostic SQL is unavailable with its reason; the summary says not authoritative', async ({ page }) => {
    await ready(page);
    await exec(page, 'CREATE TABLE a (k INTEGER)', 'INSERT INTO a VALUES (1), (2)', 'CREATE TABLE b (k INTEGER)', 'INSERT INTO b VALUES (1)');
    await setSql(page, 'SELECT * FROM a JOIN b ON a.k + 1 = b.k');
    await page.getByRole('tab', { name: 'Verdict' }).first().click();
    await analyze(page);
    await stubClipboard(page, 'record');
    await verdict(page).getByRole('button', { name: 'View diagnostic SQL' }).click();
    await expect(dialog(page).locator('.copy-unavailable')).toContainText('only for an authoritative report');
    await expect(dialog(page).getByRole('button', { name: 'Copy diagnostic SQL' })).toHaveCount(0);
    await axe(page, 'diagnostic SQL unavailable');
    await page.keyboard.press('Escape');
    await verdict(page).getByRole('button', { name: 'Copy summary…' }).click();
    await expect(preview(page)).toContainText('Authority: not authoritative.');
    await expect(preview(page)).toContainText('Unsupported: the query uses a construct outside the diagnostic scope.');
    await expect(preview(page)).not.toContainText('a.k');
  });

  // ---- Corrections after the Codex M12 review ----
  const settle = (page: Page, how: 'resolve' | 'reject') =>
    page.evaluate((how) => {
      const h = (window as unknown as { __held: { resolve(): void; reject(e: unknown): void }[] }).__held.shift()!;
      if (how === 'resolve') h.resolve();
      else h.reject(new DOMException('denied', 'NotAllowedError'));
    }, how);

  for (const how of ['resolve', 'reject'] as const) {
    test(`closing while a copy is pending (${how}) never leaves the next open stuck or relabelled`, async ({ page }) => {
      await ready(page);
      await privateReport(page);
      await stubClipboard(page, 'hold');
      const opener = verdict(page).getByRole('button', { name: 'Copy summary…' });
      await opener.click();
      const btn = dialog(page).getByRole('button', { name: /^(Copy summary|Copying…)$/ });
      await btn.focus();
      await page.keyboard.press('Enter');
      await expect(btn).toHaveText('Copying…');
      await expect(btn).toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeHidden();
      await opener.click();
      // A fresh open: Copy is available and nothing is announced.
      await expect(btn).toHaveText('Copy summary');
      await expect(btn).toHaveAttribute('aria-disabled', 'false');
      await expect(dialog(page).getByRole('status')).toHaveText('');
      await settle(page, how); // the earlier write settles now
      await page.waitForTimeout(100);
      await expect(dialog(page).getByRole('status')).toHaveText('');
      await expect(btn).toHaveText('Copy summary');
      // This open's own copy still works.
      await btn.focus();
      await page.keyboard.press('Enter');
      await settle(page, 'resolve');
      await expect(dialog(page).getByRole('status')).toHaveText(/^Summary copied to the clipboard: \d+ lines, exactly as shown\.$/);
      expect((await copied(page)).at(-1)).toBe(await preview(page).textContent());
    });
  }

  test('a write that settles after the preview changed says the earlier preview was copied, not what is shown', async ({ page }) => {
    await ready(page);
    await privateReport(page);
    await stubClipboard(page, 'hold');
    await verdict(page).getByRole('button', { name: 'Copy summary…' }).click();
    await dialog(page).getByRole('checkbox', { name: 'SQL text' }).check();
    const withSql = (await preview(page).textContent())!;
    await dialog(page).getByRole('button', { name: 'Copy summary' }).click();
    await dialog(page).getByRole('checkbox', { name: 'SQL text' }).uncheck();
    await expect(preview(page)).not.toContainText(SENTINEL.comment);
    await settle(page, 'resolve');
    await expect(dialog(page).getByRole('status')).toHaveText(/^Summary copied as the preview was when you chose Copy \(\d+ lines\)\. The preview has changed since then, so the clipboard does not hold what is shown now\. Choose Copy again to copy it\.$/);
    expect(await copied(page)).toEqual([withSql]); // exactly what was authorised at the click
    // A report change during a pending write is described the same way.
    await dialog(page).getByRole('button', { name: 'Copy summary' }).click();
    await exec(page, `INSERT INTO ${SENTINEL.other} VALUES (98, 'y')`);
    await expect(preview(page)).toContainText('Report: historical');
    await settle(page, 'resolve');
    await expect(dialog(page).getByRole('status')).toContainText('copied as the preview was when you chose Copy');
  });

  test('focus: Close and Escape both return to the control that opened the dialog; Show the newer report focuses the updated preview and resets the added sections', async ({ page }) => {
    await ready(page);
    await privateReport(page);
    const replayBtn = verdict(page).getByRole('button', { name: 'View diagnostic SQL' });
    await replayBtn.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    const close = dialog(page).getByRole('button', { name: 'Close' });
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeHidden();
    await expect(replayBtn).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog(page).getByRole('heading', { name: 'Diagnostic SQL' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(replayBtn).toBeFocused();
    const summaryBtn = verdict(page).getByRole('button', { name: 'Copy summary…' });
    await summaryBtn.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page).getByRole('heading', { name: 'Copy summary' })).toBeFocused();
    await dialog(page).getByRole('checkbox', { name: 'Witness key values' }).check();
    await page.evaluate((sql) => (window as unknown as { __qvApp: { analyses: { analyze(s: string, e: unknown[]): void } } }).__qvApp.analyses.analyze(sql, []), PRIVATE_SQL);
    const show = dialog(page).getByRole('button', { name: 'Show the newer report' });
    await show.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page).getByRole('region', { name: /Summary preview/ })).toBeFocused();
    await expect(dialog(page).getByRole('checkbox', { name: 'Witness key values' })).not.toBeChecked();
    await expect(preview(page)).not.toContainText(SENTINEL.key);
    await expect(dialog(page).getByRole('status')).toHaveText('Showing the newer report. The added sections were reset to off.');
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(summaryBtn).toBeFocused();
  });

  test('Dialog primitive: a cancelled file picker inside a dialog does not close it; Escape still does', async ({ page }) => {
    await ready(page);
    const opener = page.getByRole('button', { name: /Import/ }).first();
    await opener.click();
    const d = page.getByRole('dialog', { name: 'Import data' });
    await expect(d).toBeVisible();
    // A dismissed file picker fires a bubbling `cancel` at the input (HTML); it must not dismiss the dialog.
    await d.locator('input[type="file"]').evaluate((el) => el.dispatchEvent(new Event('cancel', { bubbles: true })));
    await page.waitForTimeout(100);
    await expect(d).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
  });
});

