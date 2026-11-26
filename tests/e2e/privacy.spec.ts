import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CSP } from '../../scripts/csp.mjs';
import { APP, HARNESS, captureRequests, startListener } from './helpers';

/** The only requests the shell may make: the page and its hashed static assets (Codex 7.5). */
const STATIC_ASSET = /^http:\/\/127\.0\.0\.1:4173\/queryverdict\/(?:|index\.html|assets\/[A-Za-z0-9._-]+\.(?:js|css))$/;

/**
 * Tries an inline script and a cross-origin image request from the page. Returns whether the
 * script ran and whether CSP violations were reported.
 */
async function probeCsp(page: Page, crossOriginUrl: string) {
  return page.evaluate(async (url) => {
    const w = window as unknown as { __cspProbe?: number };
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
    const s = document.createElement('script');
    s.textContent = 'window.__cspProbe = 1';
    document.head.append(s);
    const img = new Image();
    await new Promise<void>((done) => {
      img.onload = img.onerror = () => done();
      img.src = url;
      setTimeout(done, 3000);
    });
    await new Promise((r) => setTimeout(r, 50));
    return { scriptRan: w.__cspProbe === 1, violations };
  }, crossOriginUrl);
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test.describe('privacy and isolation', () => {
  test('only same-origin requests during load and interaction', async ({ page, context }) => {
    const requests = captureRequests(context);
    await page.goto(APP);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'Dark' }).check();
    await page.keyboard.press('Escape');
    await page.waitForLoadState('networkidle');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.map((r) => r.url()).filter((u) => !STATIC_ASSET.test(u))).toEqual([]);
    expect(requests.every((r) => r.method() === 'GET')).toBe(true);
  });

  test('nothing is written to browser storage, cookies or caches', async ({ page }) => {
    await page.goto(APP);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'Light' }).check();
    await page.keyboard.press('Escape');
    const state = await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookie: document.cookie,
      idb: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
      caches: 'caches' in self ? (await caches.keys()).length : 0,
    }));
    expect(state).toEqual({ local: 0, session: 0, cookie: '', idb: 0, caches: 0 });
  });

  test('theme preference does not survive a reload (session only)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(APP);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'Dark' }).check();
    await page.keyboard.press('Escape');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('the served page carries the exact meta CSP and no URL state', async ({ page }) => {
    await page.goto(APP);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toBe(CSP);
    expect(new URL(page.url()).search).toBe('');
  });

  test('the harness build is separate: its marker exists there and never in dist/', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.locator('body')).toHaveAttribute('data-qv-harness', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-harness-ready', 'true');
    const shipped = files('dist').filter((f) => /\.(m?js|html|css)$/.test(f));
    expect(shipped.length).toBeGreaterThan(0);
    for (const f of shipped) expect(readFileSync(f, 'utf8')).not.toContain('qv-harness');
  });

  test('the CSP is effective in the browser: inline script and cross-origin request blocked (Codex 7.5)', async ({ page }) => {
    const listener = await startListener();
    try {
      await page.goto(APP);
      const r = await probeCsp(page, `${listener.url}/csp-probe-production.png`);
      expect(r.scriptRan).toBe(false);
      expect(r.violations.some((v) => v.startsWith('script-src'))).toBe(true);
      expect(r.violations.some((v) => v.startsWith('img-src'))).toBe(true);
      expect(listener.hits).toEqual([]);
    } finally {
      await listener.close();
    }
  });

  test('negative control: the same probe succeeds on a page without CSP, so the detector works', async ({ page }) => {
    const listener = await startListener();
    try {
      await page.goto(HARNESS);
      const r = await probeCsp(page, `${listener.url}/csp-probe-control.png`);
      expect(r.scriptRan).toBe(true);
      expect(r.violations).toEqual([]);
      expect(listener.hits).toEqual(['/csp-probe-control.png']);
    } finally {
      await listener.close();
    }
  });
});
