// M05 accessibility of the workspace and editor on the production build: keyboard entry and exit
// (no trap), accessible names, the shortcut reference dialog, divider semantics, IME composition
// (Chromium, through the DevTools protocol), axe in both themes and at narrow widths, forced
// colours (Chromium emulation) and 200 % zoom (emulated as a half-size viewport).
// Screen readers (VoiceOver, NVDA) are manual checks recorded separately; they are not automated.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { APP, AXE_TAGS } from './helpers';

const editor = (page: Page) => page.getByRole('textbox', { name: 'SQL editor' });

async function ready(page: Page) {
  await page.goto(APP);
  await expect(page.getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
}
/** Safari/WebKit moves to buttons with Option+Tab (platform default; see shell.spec). */
const tabKey = (browserName: string, shift = false) => `${browserName === 'webkit' ? 'Alt+' : ''}${shift ? 'Shift+' : ''}Tab`;

/**
 * axe with WCAG A/AA tags. Firefox: see P-083 (Playwright's Firefox 159 build crashes the content
 * process on full axe runs in some app states); the functional assertions still run there.
 */
async function axe(page: Page, what: string) {
  if (page.context().browser()?.browserType().name() === 'firefox') return;
  await page.waitForTimeout(200);
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(r.violations.map((v) => `${what}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.describe('editor and workspace accessibility (production build)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('the editor is a labelled multi-line textbox described by its keyboard hint', async ({ page }) => {
    await ready(page);
    const e = editor(page);
    await expect(e).toHaveAttribute('aria-multiline', 'true');
    await expect(e).toHaveAccessibleDescription(/Tab leaves the editor/);
    await expect(page.getByText('DuckDB SQL', { exact: true })).toBeVisible();
  });

  test('keyboard: Tab enters the editor, Tab and Shift+Tab leave it without inserting text (no trap)', async ({ page, browserName }) => {
    await ready(page);
    await page.getByRole('button', { name: 'Run SQL' }).focus();
    await page.keyboard.press(tabKey(browserName));
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type('SELECT 1');
    await page.keyboard.press(tabKey(browserName));
    await expect(editor(page)).not.toBeFocused();
    await expect(page.getByRole('separator', { name: 'Query' })).toBeFocused();
    await page.keyboard.press(tabKey(browserName, true));
    await expect(editor(page)).toBeFocused();
    await page.keyboard.press(tabKey(browserName, true));
    await expect(page.getByRole('button', { name: 'Run SQL' })).toBeFocused();
    await expect(page.locator('.cm-content')).toHaveText('SELECT 1'); // Tab inserted nothing
  });

  test('logical focus order: header, datasets, dividers, editor actions, editor, output tabs', async ({ page, browserName }) => {
    await ready(page);
    const order: string[] = [];
    await page.keyboard.press(tabKey(browserName)); // skip link
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(tabKey(browserName));
      order.push(
        await page.evaluate(() => {
          const a = document.activeElement as HTMLElement;
          return a.getAttribute('aria-label') ?? a.getAttribute('role') ?? a.textContent?.trim() ?? a.tagName;
        }),
      );
    }
    expect(order).toEqual([
      'Shortcuts',
      'Settings',
      '+ Import',
      'separator', // Datasets divider (named by the Datasets heading)
      'Wrap lines',
      'Analyze',
      'Run SQL',
      'SQL editor',
      'separator', // Query divider
      'tab', // Results (the selected output tab is the only tab stop)
      'tabpanel', // the Results panel itself (APG Tabs)
      'Import CSV or Parquet', // the getting-started action inside the Results view
    ]);
  });

  test('shortcut reference: platform keys, only supported shortcuts, Escape closes, focus returns', async ({ page }) => {
    await ready(page);
    const apple = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
    const opener = page.getByRole('button', { name: 'Shortcuts' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    const rows = dialog.getByRole('rowheader');
    await expect(rows).toHaveText(['Run SQL', 'Analyze', 'Leave the editor', 'Undo', 'Redo', 'Resize panels', 'Smallest or largest panel', 'Switch tabs', 'Close dialog']);
    await expect(dialog.getByRole('row', { name: /^Run SQL/ })).toContainText(apple ? '⌘Return' : 'CtrlEnter');
    await expect(dialog.getByRole('row', { name: /^Redo/ })).toContainText(apple ? '⌘ShiftZ' : 'CtrlY');
    await axe(page, 'shortcuts dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('dividers follow the window splitter pattern and show a focus indicator', async ({ page }) => {
    await ready(page);
    for (const [name, orientation, heading] of [['Datasets', 'vertical', 'datasets-title'], ['Query', 'horizontal', 'editor-heading']] as const) {
      const sep = page.getByRole('separator', { name, exact: true });
      await expect(sep).toHaveAttribute('aria-labelledby', heading); // named by the visible heading of the pane it resizes
      await expect(page.locator(`#${heading}`)).toBeVisible();
      await expect(sep).toHaveAttribute('tabindex', '0');
      await expect(sep).toHaveAttribute('aria-orientation', orientation);
      const [now, min, max, controls] = await Promise.all(['aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-controls'].map((a) => sep.getAttribute(a)));
      expect(Number(min)).toBeLessThanOrEqual(Number(now));
      expect(Number(now)).toBeLessThanOrEqual(Number(max));
      expect(Number(max)).toBeLessThanOrEqual(100);
      expect(await page.locator(`#${controls}`).count()).toBe(1);
      await sep.focus();
      await page.keyboard.press(orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'); // keyboard use shows :focus-visible
      const outline = await sep.evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(outline).toBe('solid');
    }
  });

  test('IME composition commits text once and never triggers an action (Chromium, DevTools protocol)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'IME composition can only be driven through the Chromium DevTools protocol');
    await ready(page);
    await editor(page).click();
    const cdp = await page.context().newCDPSession(page);
    for (const s of ['に', 'にほ', 'にほん']) await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length });
    await cdp.send('Input.insertText', { text: '日本' });
    await page.keyboard.type(' AS t');
    await expect(page.locator('.cm-content')).toHaveText('日本 AS t');
    await expect(page.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.output-note')).toHaveCount(0); // no Run or Analyze happened
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe: workspace with text in the editor, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await ready(page);
      await editor(page).click();
      await page.keyboard.type("SELECT o.id, 'x' AS s, 1.5 AS n -- comment\nFROM orders AS o");
      await page.keyboard.press('ControlOrMeta+Enter');
      await axe(page, `workspace ${scheme}`);
      await page.getByRole('tab', { name: 'Verdict' }).click();
      await axe(page, `verdict view ${scheme}`);
    });
  }

  test('200 % zoom (half-size viewport) and 320 px: one column, every control reachable, no horizontal page scroll', async ({ page }) => {
    for (const [w, h] of [[720, 450], [320, 640]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      await expect(page.getByRole('tablist', { name: 'Workspace view' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Run SQL' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Analyze' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Datasets (0)' })).toBeVisible();
      await editor(page).click();
      await page.keyboard.type('SELECT 1');
      await axe(page, `${w} px`);
    }
  });

  test('forced colours (Chromium emulation): SQL text uses the system colour and focus stays visible', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'forced-colors emulation is Chromium-only in Playwright');
    await page.emulateMedia({ forcedColors: 'active' });
    await ready(page);
    await editor(page).click();
    await page.keyboard.type('SELECT 1');
    const [keyword, content] = await Promise.all([
      page.locator('.cm-content span', { hasText: 'SELECT' }).first().evaluate((el) => getComputedStyle(el).color),
      page.locator('.cm-content').evaluate((el) => getComputedStyle(el).color),
    ]);
    expect(keyword).toBe(content); // token colours give way to the system text colour
    const ring = await page.locator('.editor-host').evaluate((el) => {
      const a = getComputedStyle(el, '::after');
      return { style: a.borderTopStyle, width: a.borderLeftWidth, color: a.borderLeftColor };
    });
    expect(ring.style).toBe('solid');
    expect(ring.width).toBe('2px');
    expect(ring.color).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    await page.getByRole('separator', { name: 'Query' }).focus();
    await page.keyboard.press('ArrowDown');
    expect(await page.getByRole('separator', { name: 'Query' }).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  });
});
