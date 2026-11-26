import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { APP, AXE_TAGS } from './helpers';

const canvas = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const LIGHT_CANVAS = 'rgb(245, 245, 240)';
const DARK_CANVAS = 'rgb(16, 20, 29)';

test.describe('application shell', () => {
  test('loads under the GitHub Pages project subpath with landmarks and status', async ({ page }) => {
    await page.goto(APP);
    await expect(page).toHaveTitle('QueryVerdict');
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Workspace' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Engine not started');
    expect(await page.locator('[role="status"]').count()).toBe(1);
  });

  test('skip link is the first tab stop and moves focus to the workspace', async ({ page, browserName }) => {
    await page.goto(APP);
    // Safari/WebKit skip links on Tab by default; Option+Tab reaches them (platform behaviour).
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    const skip = page.getByRole('link', { name: 'Skip to workspace' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
  });

  test('settings dialog: keyboard theme change, Escape closes, focus returns', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(APP);
    const settings = page.getByRole('button', { name: 'Settings' });
    await settings.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'System' })).toBeFocused();
    await page.keyboard.press('ArrowDown'); // Light
    await page.keyboard.press('ArrowDown'); // Dark
    await expect(dialog.getByRole('radio', { name: 'Dark' })).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await canvas(page)).toBe(DARK_CANVAS);
    await expect(dialog.getByRole('radio', { name: 'Dark' })).toBeFocused(); // focus preserved across the theme change
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(settings).toBeFocused();
  });

  test('System theme follows the OS preference at first paint and live', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(APP);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await canvas(page)).toBe(DARK_CANVAS);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await canvas(page)).toBe(LIGHT_CANVAS);
  });

  test('settings dialog: pointer open and Close return focus to Settings in every engine (Codex 7.5)', async ({ page }) => {
    await page.goto(APP);
    const settings = page.getByRole('button', { name: 'Settings' });
    await settings.click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.getByRole('radio', { name: 'System' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await expect(settings).toBeFocused();
    await settings.click();
    await page.keyboard.press('Escape');
    await expect(settings).toBeFocused();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe: no WCAG A/AA violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(APP);
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
      await page.getByRole('button', { name: 'Settings' }).click();
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
      const dialogResults = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(dialogResults.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }

  test('reflows at 320 CSS px without horizontal scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(APP);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeInViewport();
  });
});
