// M05 SQL workspace, end to end with the real editor (CodeMirror 6, P-052) and the real engine.
// Harness app view (the production App with its runtime and workspace store exposed): editing and
// store sync, Run SQL / Analyze actions and their isolation, splitters, responsive layout, explorer
// integration, session-only state. Production build (APP): network isolation and CSP.
// The editor fixture view checks the SqlEditor contract on its own.
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { APP, APP_ORIGIN, captureRequests, HARNESS } from './helpers';

const APP_VIEW = `${HARNESS}?view=app`;
const FIXTURE = `${HARNESS}?view=editor`;
const fx = (n: string) => path.resolve('tests/fixtures/import', n);

type Snap = { sql: string; wrap: boolean; output: string; layout: { sidebarPx: number; editorFraction: number }; lastRun: { seq: number; sql: string } | null; lastAnalyze: { seq: number; sql: string } | null };
const store = (page: Page) => page.evaluate(() => (window as unknown as { __qvWorkspace: { getSnapshot(): Snap } }).__qvWorkspace.getSnapshot());
const statements = (page: Page) => page.evaluate(() => window.__qvHarness!.engine.statementLog.length);
const editor = (page: Page) => page.getByRole('textbox', { name: 'SQL editor' });
const separator = (page: Page, name: string) => page.getByRole('separator', { name });
const valueNow = async (page: Page, name: string) => Number(await separator(page, name).getAttribute('aria-valuenow'));

async function ready(page: Page, url = APP_VIEW) {
  await page.goto(url);
  await expect(page.getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
}
/** Types into the editor (focuses it first). */
async function type(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.type(text);
}
/** Resolved colour of a CSS custom property, as the browser serialises colours. */
const tokenColor = (page: Page, token: string) =>
  page.evaluate((t) => {
    const el = document.createElement('span');
    el.style.color = `var(${t})`;
    document.body.append(el);
    const c = getComputedStyle(el).color;
    el.remove();
    return c;
  }, token);

test.describe('SQL workspace (harness app view)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('regions: header, datasets, editor with language label and line numbers, output tabs, status strip; no page scroll', async ({ page }) => {
    await ready(page, APP); // the production build (the harness page has a banner above the app)
    await expect(page.getByRole('banner')).toContainText('QueryVerdict');
    await expect(page.getByRole('button', { name: 'Shortcuts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: /Datasets/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Query' })).toContainText('DuckDB SQL');
    await expect(editor(page)).toBeVisible();
    await expect(page.locator('.cm-lineNumbers')).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Output' }).getByRole('tab')).toHaveText(['Results', 'Verdict', 'Dataset']);
    await expect(page.getByRole('contentinfo')).toContainText('Engine ready');
    const overflow = await page.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight }));
    expect(overflow).toEqual({ x: 0, y: 0 });
  });

  test('editing: typing reaches the store; multiline, undo and redo; highlighting uses the SQL tokens', async ({ page }) => {
    await ready(page);
    await type(page, 'SELECT 1 AS n, \'x\' AS s -- note');
    await page.keyboard.press('Enter');
    await page.keyboard.type('FROM t');
    expect((await store(page)).sql).toBe("SELECT 1 AS n, 'x' AS s -- note\nFROM t");
    await expect(page.locator('.cm-content .cm-line')).toHaveCount(2);
    // Syntax highlighting maps onto the design tokens.
    const color = (text: string) => page.locator('.cm-content span', { hasText: text }).first().evaluate((el) => getComputedStyle(el).color);
    expect(await color('SELECT')).toBe(await tokenColor(page, '--sql-keyword'));
    expect(await color("'x'")).toBe(await tokenColor(page, '--sql-string'));
    expect(await color('-- note')).toBe(await tokenColor(page, '--sql-comment'));
    // Undo and redo (CodeMirror history: Redo is Cmd+Shift+Z on Apple platforms, Ctrl+Y elsewhere).
    const apple = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await store(page)).sql).not.toContain('FROM t');
    await page.keyboard.press(apple ? 'Meta+Shift+z' : 'Control+y');
    await expect.poll(async () => (await store(page)).sql).toContain('FROM t');
  });

  test('wrap lines: toggle state; at a wrap point Left and Right visit both the end of the upper row and the start of the lower row', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 760 });
    await ready(page);
    await type(page, `SELECT ${Array.from({ length: 30 }, (_, i) => `col_${i}`).join(', ')} FROM t`);
    const wrap = page.getByRole('button', { name: 'Wrap lines' });
    await expect(wrap).toHaveAttribute('aria-pressed', 'false');
    await wrap.click();
    await expect(wrap).toHaveAttribute('aria-pressed', 'true');
    expect((await store(page)).wrap).toBe(true);
    await editor(page).click();
    // The drawn caret (one animation frame after each key) and the first character's position.
    const caret = async () => {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      return page.locator('.cm-cursor-primary').evaluate((el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top) }; });
    };
    const lineLeft = await page.locator('.cm-line').first().evaluate((el) => Math.round(el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft)));
    await page.keyboard.press('ControlOrMeta+Home');
    const start = await caret();
    await page.keyboard.press('End'); // end of the first visual row (not of the line)
    const end = await caret();
    expect(end.y).toBe(start.y);
    await page.keyboard.press('ArrowRight');
    const next = await caret();
    expect(next.y).toBeGreaterThan(end.y); // on the second row…
    expect(Math.abs(next.x - lineLeft)).toBeLessThanOrEqual(2); // …at its start, no character skipped
    await page.keyboard.press('ArrowRight');
    const after = await caret();
    expect(after.y).toBe(next.y);
    expect(after.x).toBeGreaterThan(next.x);
    await page.keyboard.press('ArrowLeft');
    expect(await caret()).toEqual(next); // back to the start of the lower row
    await page.keyboard.press('ArrowLeft');
    expect(await caret()).toEqual(end); // then the end of the upper row (maintainer report)
    await page.keyboard.press('ArrowLeft');
    const before = await caret();
    expect(before.y).toBe(end.y);
    expect(before.x).toBeLessThan(end.x); // then before the upper row's last character: never stuck
  });

  test('Run SQL (Mod+Enter) and Analyze (Mod+Shift+Enter): distinct and scoped to the editor; Run executes (M06), Analyze is not connected yet (M09)', async ({ page }) => {
    await ready(page);
    await type(page, 'SELECT 42');

    await page.keyboard.press('ControlOrMeta+Enter');
    let s = await store(page);
    expect(s.lastRun).toMatchObject({ seq: 1, sql: 'SELECT 42' });
    expect(s.lastAnalyze).toBeNull(); // Run never triggers Analyze
    expect(s.sql).toBe('SELECT 42'); // the binding did not insert a line
    await expect(editor(page)).toBeFocused(); // focus stays on the trigger
    await expect(page.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toContainText('SQL executed');
    await expect(page.getByRole('status')).toHaveText('SQL executed · 1 row shown.');
    const before = await statements(page);

    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    s = await store(page);
    expect(s.lastAnalyze).toMatchObject({ seq: 2, sql: 'SELECT 42' });
    expect(s.lastRun?.seq).toBe(1); // Analyze never triggers Run
    await expect(page.getByRole('tab', { name: 'Verdict' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toContainText('Analyze is not available in this version yet. Nothing was analyzed.');
    await expect(editor(page)).toBeFocused();

    // Outside the editor the shortcuts do nothing. (Focus on the page body: on a focused button,
    // Firefox activates the button itself for Cmd/Ctrl+Enter, which is native behaviour.)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('ControlOrMeta+Enter');
    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    s = await store(page);
    expect([s.lastRun?.seq, s.lastAnalyze?.seq]).toEqual([1, 2]);

    // Switching tabs never issues work either.
    await page.getByRole('tab', { name: 'Results' }).click();
    await page.getByRole('tab', { name: 'Verdict' }).click();
    expect(await statements(page)).toBe(before);
  });

  test('buttons match the shortcuts; an empty query is reported as empty', async ({ page }) => {
    await ready(page);
    await expect(page.getByRole('button', { name: 'Run SQL' })).toHaveAttribute('aria-keyshortcuts', /^(Meta|Control)\+Enter$/);
    await expect(page.getByRole('button', { name: 'Analyze' })).toHaveAttribute('aria-keyshortcuts', /^(Meta|Control)\+Shift\+Enter$/);
    await page.getByRole('button', { name: 'Run SQL' }).click();
    await expect(page.getByRole('tabpanel')).toContainText('Not run');
    await expect(page.getByRole('status')).toHaveText('Not run: The editor is empty. Write a query first.');
    await type(page, 'SELECT 1');
    await page.getByRole('button', { name: 'Analyze' }).click();
    expect((await store(page)).lastAnalyze?.sql).toBe('SELECT 1');
  });

  test('editor/output divider: keyboard steps, Shift for larger steps, Home/End bounds, double-click reset', async ({ page }) => {
    await ready(page);
    const name = 'Query';
    const sep = separator(page, name);
    await expect(sep).toHaveAttribute('aria-orientation', 'horizontal');
    await expect(sep).toHaveAttribute('aria-controls', 'ws-editor-panel');
    expect(await valueNow(page, name)).toBe(50);
    const editorHeight = () => page.locator('#ws-editor-panel').evaluate((el) => el.getBoundingClientRect().height);
    const h0 = await editorHeight();
    await sep.focus();
    await page.keyboard.press('ArrowDown');
    expect(await editorHeight()).toBeCloseTo(h0 + 16, 0);
    await page.keyboard.press('Shift+ArrowDown');
    expect(await editorHeight()).toBeCloseTo(h0 + 16 + 64, 0);
    await page.keyboard.press('ArrowUp');
    expect(await editorHeight()).toBeCloseTo(h0 + 64, 0);
    await page.keyboard.press('Home');
    expect(await editorHeight()).toBeCloseTo(160, 0); // minimum editor height
    expect(await valueNow(page, name)).toBe(Number(await sep.getAttribute('aria-valuemin')));
    await page.keyboard.press('End');
    const outputHeight = await page.locator('#ws-output-panel').evaluate((el) => el.getBoundingClientRect().height);
    expect(outputHeight).toBeCloseTo(160, 0); // minimum output height, below the divider's 1 px rule
    expect(await valueNow(page, name)).toBe(Number(await sep.getAttribute('aria-valuemax')));
    await sep.dblclick();
    expect(await valueNow(page, name)).toBe(50);
    await expect(sep).toBeFocused(); // the divider never traps or drops focus
    await page.keyboard.press('Tab');
    await expect(sep).not.toBeFocused();
  });

  test('datasets divider: pointer drag within 200–360 px, keyboard, reset; presets in Settings', async ({ page }) => {
    await ready(page);
    const sep = separator(page, 'Datasets');
    await expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    const width = () => page.locator('#ws-sidebar-pane').evaluate((el) => Math.round(el.getBoundingClientRect().width));
    expect(await width()).toBe(264);
    const box = (await sep.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 100, { steps: 4 });
    await page.mouse.up();
    expect(await width()).toBe(304);
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 600, box.y + 100, { steps: 4 }); // far beyond the maximum
    await page.mouse.up();
    expect(await width()).toBe(360);
    await sep.focus();
    await page.keyboard.press('Home');
    expect(await width()).toBe(200);
    await page.keyboard.press('ArrowRight');
    expect(await width()).toBe(216);
    await sep.dblclick();
    expect(await width()).toBe(264);

    // Presets are a single-pointer and keyboard alternative to dragging.
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'Larger editor' }).click();
    expect(await valueNow(page, 'Query')).toBe(70);
    await dialog.getByRole('button', { name: 'Larger output' }).click();
    expect(await valueNow(page, 'Query')).toBe(30);
    await dialog.getByRole('button', { name: 'Reset layout' }).click();
    expect(await valueNow(page, 'Query')).toBe(50);
    await page.keyboard.press('Escape');
  });

  test('900–1199 px: narrower sidebar (at most 280 px); below 900 px: one column, drawer and view tabs; the editor keeps its state', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await ready(page);
    const width = () => page.locator('#ws-sidebar-pane').evaluate((el) => Math.round(el.getBoundingClientRect().width));
    expect(await width()).toBe(224); // medium default at first paint…
    await separator(page, 'Datasets').focus();
    await page.keyboard.press('End');
    expect(await width()).toBe(280);
    await separator(page, 'Datasets').dblclick();
    expect(await width()).toBe(224); // …and after a reset (Codex M05)
    await page.keyboard.press('End');
    expect(await width()).toBe(280);
    await type(page, 'SELECT 1');
    await page.keyboard.press('Enter');
    await page.keyboard.type('FROM t');

    await page.setViewportSize({ width: 800, height: 700 });
    const views = page.getByRole('tablist', { name: 'Workspace view' });
    await expect(views.getByRole('tab')).toHaveText(['Editor', 'Results', 'Verdict', 'Dataset']);
    await expect(page.getByRole('separator')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Datasets (0)' })).toBeVisible();
    await expect(editor(page)).toBeVisible();
    await views.getByRole('tab', { name: 'Results' }).click();
    await expect(editor(page)).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
    await views.getByRole('tab', { name: 'Editor' }).click();
    await expect(page.locator('.cm-editor')).toHaveCount(1); // the same editor instance, never remounted
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+z'); // undo history survived the view switch
    await expect.poll(async () => (await store(page)).sql).not.toBe('SELECT 1\nFROM t');
    const undone = (await store(page)).sql;
    expect('SELECT 1\nFROM t'.startsWith(undone)).toBe(true);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('separator')).toHaveCount(2);
    await expect(page.locator('.cm-editor')).toHaveCount(1);
    expect((await store(page)).sql).toBe(undone);
  });

  test('explorer integration: import, selecting a dataset shows it in the Dataset view; preview still bounded and explicit', async ({ page }) => {
    await ready(page);
    await type(page, 'SELECT * FROM people');
    await page.getByRole('button', { name: '+ Import' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import data' });
    await dialog.getByLabel('Choose local files').setInputFiles([fx('people.csv')]);
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByText(/^Finished:/)).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();
    expect((await store(page)).sql).toBe('SELECT * FROM people'); // importing preserves editor text (UX-002)
    const before = await statements(page);
    await page.getByRole('list', { name: 'Datasets' }).getByRole('button', { name: /^people / }).click();
    await expect(page.getByRole('tab', { name: 'Dataset' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { level: 2, name: 'people' })).toBeVisible();
    await expect(page.getByRole('table', { name: /Schema of people/ })).toBeVisible();
    expect(await page.evaluate(() => window.__qvHarness!.engine.statementLog.filter((s) => s.startsWith('SELECT left(')).length)).toBe(0);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('table', { name: /Preview of people/ })).toBeVisible();
    expect(await statements(page)).toBeGreaterThan(before);
    await expect(page.locator('.cm-editor')).toHaveCount(1);
  });

  test('theme switch restyles the editor without losing text or focus', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await ready(page);
    await type(page, 'SELECT 1');
    const keyword = page.locator('.cm-content span', { hasText: 'SELECT' }).first();
    const light = await keyword.evaluate((el) => getComputedStyle(el).color);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'Dark' }).check();
    await page.keyboard.press('Escape');
    await expect.poll(() => keyword.evaluate((el) => getComputedStyle(el).color)).not.toBe(light);
    expect(await keyword.evaluate((el) => getComputedStyle(el).color)).toBe(await tokenColor(page, '--sql-keyword'));
    expect((await store(page)).sql).toBe('SELECT 1');
  });

  test('session only: no browser storage, cookies or URL state after editing, resizing and actions', async ({ page }) => {
    await ready(page);
    await type(page, "SELECT 'secret' AS s");
    await page.keyboard.press('ControlOrMeta+Enter');
    await separator(page, 'Query').focus();
    await page.keyboard.press('ArrowDown');
    const state = await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookie: document.cookie,
      url: location.href,
      idb: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
    }));
    expect(state).toEqual({ local: 0, session: 0, cookie: '', url: APP_VIEW, idb: 0 });
  });
});

test.describe('Codex M05 review regressions (harness app view)', () => {
  test('action chords on focused buttons never activate them; plain Enter still does (all browsers, Firefox case)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ready(page);
    await type(page, 'SELECT 1');
    const analyzeButton = page.getByRole('button', { name: 'Analyze' });
    const runButton = page.getByRole('button', { name: 'Run SQL' });
    for (const [button, chord] of [[analyzeButton, 'ControlOrMeta+Enter'], [analyzeButton, 'ControlOrMeta+Shift+Enter'], [runButton, 'ControlOrMeta+Enter'], [runButton, 'ControlOrMeta+Shift+Enter']] as const) {
      await button.focus();
      await page.keyboard.press(chord);
    }
    let s = await store(page);
    expect([s.lastRun, s.lastAnalyze]).toEqual([null, null]);
    await runButton.focus();
    await page.keyboard.press('Enter');
    await analyzeButton.focus();
    await page.keyboard.press(' ');
    s = await store(page);
    expect([s.lastRun?.sql, s.lastAnalyze?.sql]).toEqual(['SELECT 1', 'SELECT 1']);
  });

  test('crossing 900 px keeps the focused pane and focus, in both directions', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 760 });
    await ready(page);
    await page.getByRole('tab', { name: 'Dataset' }).click();
    await type(page, 'SELECT 98');
    await page.setViewportSize({ width: 800, height: 760 });
    await expect(page.getByRole('tab', { name: 'Editor' })).toHaveAttribute('aria-selected', 'true');
    await expect(editor(page)).toBeVisible();
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type(' AS n');
    expect((await store(page)).sql).toBe('SELECT 98 AS n');
    // Wide → narrow with focus on an output tab, then back.
    await page.setViewportSize({ width: 1000, height: 760 });
    await expect(editor(page)).toBeFocused();
    await page.getByRole('tablist', { name: 'Output' }).getByRole('tab', { name: 'Verdict' }).click();
    await page.setViewportSize({ width: 800, height: 760 });
    const narrowVerdict = page.getByRole('tablist', { name: 'Workspace view' }).getByRole('tab', { name: 'Verdict' });
    await expect(narrowVerdict).toHaveAttribute('aria-selected', 'true');
    await expect(narrowVerdict).toBeFocused();
    await page.setViewportSize({ width: 1000, height: 760 });
    await expect(page.getByRole('tablist', { name: 'Output' }).getByRole('tab', { name: 'Verdict' })).toBeFocused();
  });

  test('output tabs control their tab panel; Tab moves from a tab into a text-only panel', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ready(page);
    const verdict = page.getByRole('tablist', { name: 'Output' }).getByRole('tab', { name: 'Verdict' });
    await verdict.click();
    await verdict.focus();
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(page.getByRole('tabpanel', { name: 'Verdict' })).toBeFocused();
    await page.setViewportSize({ width: 800, height: 760 });
    for (const name of ['Editor', 'Results', 'Verdict', 'Dataset']) {
      const id = await page.getByRole('tablist', { name: 'Workspace view' }).getByRole('tab', { name }).getAttribute('aria-controls');
      expect(await page.locator(`#${id}`).getAttribute('role')).toBe('tabpanel');
    }
  });

  test('narrow screens: the action notice appears beside the actions and focus stays on the trigger', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await ready(page);
    await type(page, 'SELECT 1');
    const analyzeButton = page.getByRole('button', { name: 'Analyze' });
    await analyzeButton.focus();
    await page.keyboard.press('Enter');
    const note = page.locator('.inline-note');
    await expect(note).toContainText('Analyze is not available in this version yet');
    await expect(note).toBeInViewport();
    await expect(analyzeButton).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Editor' })).toHaveAttribute('aria-selected', 'true');
  });

  test('a second touch contact cannot take over a divider drag (Chromium touch emulation)', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'touch input is driven through the Chromium DevTools protocol');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
    const page = await context.newPage();
    await ready(page);
    const width = () => page.locator('#ws-sidebar-pane').evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const box = (await separator(page, 'Datasets').boundingBox())!;
    const x = box.x + 0.5;
    const cdp = await context.newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id: number }[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    // Both fingers on the datasets divider, far from where it meets the editor/output divider
    // (Chrome's touch adjustment would otherwise move a contact near the junction to that one).
    const editorSplit = () => valueNow(page, 'Query');
    const split0 = await editorSplit();
    await touch('touchStart', [{ x, y: 200, id: 1 }]);
    await touch('touchMove', [{ x: x - 30, y: 200, id: 1 }]);
    expect(await width()).toBe(234);
    // The second finger lands on the divider where it now is (moved 30 px by the first).
    await touch('touchStart', [{ x: x - 30, y: 200, id: 1 }, { x: x - 30, y: 760, id: 2 }]);
    await touch('touchMove', [{ x: x - 30, y: 200, id: 1 }, { x: x + 30, y: 760, id: 2 }]);
    expect(await width()).toBe(234); // the second finger is ignored
    expect(await editorSplit()).toBe(split0);
    await touch('touchEnd', []);
    expect(await width()).toBe(234);
    // A new single-finger drag works after both contacts lift. (Chrome's emulation does not
    // deliver a move for the first finger while a second one is down, so that case is not tested.)
    await touch('touchStart', [{ x: x - 30, y: 200, id: 3 }]);
    await touch('touchMove', [{ x: x - 10, y: 200, id: 3 }]);
    await touch('touchEnd', []);
    expect(await width()).toBe(254);
    await context.close();
  });
});

test.describe('SqlEditor contract (editor fixture)', () => {
  type Log = { changes: string[]; runs: number; analyzes: number; cursor?: { line: number; column: number } };
  const log = (page: Page) => page.evaluate(() => (window as unknown as { __qvEditorFixture: Log }).__qvEditorFixture);
  const fixtureEditor = (page: Page) => page.getByRole('textbox', { name: 'Fixture SQL editor' });

  test('external value keeps undo history; read-only blocks edits but keeps focus and selection; unmount disposes the editor', async ({ page }) => {
    await page.goto(FIXTURE);
    await fixtureEditor(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' -- typed');
    await expect(page.getByTestId('value')).toHaveText('SELECT 1; -- typed');
    await page.getByRole('button', { name: 'Set external value' }).click();
    await expect(page.locator('.cm-content')).toHaveText('SELECT 2 AS external;');
    expect((await log(page)).changes.at(-1)).toBe('SELECT 1; -- typed'); // the external value is not echoed back as an edit
    await fixtureEditor(page).click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.cm-content')).toHaveText('SELECT 1; -- typed');

    await page.getByRole('button', { name: 'Toggle read-only' }).click();
    await expect(fixtureEditor(page)).toHaveAttribute('aria-readonly', 'true');
    await fixtureEditor(page).click();
    await page.keyboard.type('xyz');
    await expect(page.locator('.cm-content')).toHaveText('SELECT 1; -- typed');
    await expect(fixtureEditor(page)).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Enter'); // actions still work on a read-only query
    expect((await log(page)).runs).toBe(1);
    await page.getByRole('button', { name: 'Toggle read-only' }).click();
    await expect(fixtureEditor(page)).not.toHaveAttribute('aria-readonly', 'true');

    await page.getByRole('button', { name: 'Toggle mounted' }).click();
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    const changes = (await log(page)).changes.length;
    await page.getByRole('button', { name: 'Toggle mounted' }).click();
    await expect(page.locator('.cm-editor')).toHaveCount(1); // StrictMode double mount leaves exactly one editor
    await expect(page.locator('.cm-content')).toHaveText('SELECT 1; -- typed');
    expect((await log(page)).changes.length).toBe(changes);
  });

  test('an external change keeps a caret that lies in unchanged text (Codex M05)', async ({ page }) => {
    await page.goto(FIXTURE);
    await fixtureEditor(page).click();
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight'); // after "SELECT "
    expect((await log(page)).cursor).toEqual({ line: 1, column: 8 });
    await page.getByRole('button', { name: 'Set external value' }).click();
    await expect(page.locator('.cm-content')).toHaveText('SELECT 2 AS external;');
    expect((await log(page)).cursor).toEqual({ line: 1, column: 8 }); // the editor's own selection, straight after the change
    await fixtureEditor(page).focus(); // focus without a click keeps the selection
    await page.keyboard.type('X');
    await expect(page.locator('.cm-content')).toHaveText('SELECT X2 AS external;');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.cm-content')).toHaveText('SELECT 2 AS external;');
    await page.keyboard.press('ControlOrMeta+z'); // the external change is its own undo step
    await expect(page.locator('.cm-content')).toHaveText('SELECT 1;');
  });

  test('a large paste (200 KB) is accepted and reported once', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(FIXTURE);
    await fixtureEditor(page).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.evaluate(() => navigator.clipboard.writeText("SELECT 1 AS a, 'x' AS b FROM t;\n".repeat(6400)));
    await page.keyboard.press('ControlOrMeta+v');
    await expect.poll(async () => (await log(page)).changes.at(-1)?.length).toBe(204_800);
    await expect(page.locator('.cm-editor')).toHaveCount(1);
  });
});

test.describe('workspace network isolation (production build)', () => {
  test('editor assets load from the app origin; editing and actions make no other request', async ({ page, context }) => {
    const requests = captureRequests(context);
    await page.goto(APP);
    await expect(page.getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
    await editor(page).click();
    await page.keyboard.type("SELECT 'not sent' AS s FROM people");
    await page.keyboard.press('ControlOrMeta+Enter');
    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await page.getByRole('button', { name: 'Shortcuts' }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const urls = requests.map((r) => r.url());
    expect(urls.filter((u) => !u.startsWith(`${APP_ORIGIN}/queryverdict/`) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
    expect(requests.every((r) => r.method() === 'GET')).toBe(true);
    expect(urls.some((u) => u.includes('not%20sent') || u.includes('not sent'))).toBe(false);
  });
});
