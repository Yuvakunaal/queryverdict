// Finding 7: the manual/page benchmark entry point applies the same input guards as the CLI.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApp } from './helpers';

const TINY = join(import.meta.dirname, '..', '..', 'data', 'tiny');
const manifest = () => JSON.parse(readFileSync(join(TINY, 'manifest.json'), 'utf8'));
const opts = (m: unknown, extra: Record<string, unknown> = {}) => ({ manifest: m, mode: 'view', reps: 1, cancelReps: 1, workloadTimeoutMs: 60_000, cancelAfterMs: 1000, memoryLimit: '2GB', ...extra });

async function startAndWait(page: Page, o: unknown) {
  await page.evaluate((o) => window.__qvBench!.start(o as never), o);
  await page.waitForFunction(() => window.__qvBench?.progress?.done === true, null, { timeout: 90_000 });
  return page.evaluate(() => ({ progress: window.__qvBench!.progress!, guard: window.__qvBench!.guard }));
}

test('valid tiny inputs: sizes and SHA-256 verified against the manifest, run completes', async ({ page }) => {
  await openApp(page);
  await page.locator('#bench-orders').setInputFiles(join(TINY, 'orders.csv'));
  await page.locator('#bench-customers').setInputFiles(join(TINY, 'customers.csv'));
  const r = await startAndWait(page, opts(manifest()));
  expect(r.guard?.ok).toBe(true);
  expect(r.guard?.files.map((f) => f.hashVerified)).toEqual([true, true]);
  expect(r.progress.error).toBeUndefined();
  expect(r.progress.planned.length).toBeGreaterThan(10);
  expect(r.progress.records.every((x) => x.verdict !== 'fail' && x.verdict !== 'unexpected-error')).toBe(true);
});

test('a tampered input with the right name is refused (size or hash mismatch)', async ({ page }) => {
  await openApp(page);
  const m = manifest();
  const original = readFileSync(join(TINY, 'orders.csv'));
  const tampered = Buffer.from(original);
  tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x31 ? 0x32 : 0x31; // same size, different bytes
  await page.locator('#bench-orders').setInputFiles({ name: 'orders.csv', mimeType: 'text/csv', buffer: tampered });
  await page.locator('#bench-customers').setInputFiles(join(TINY, 'customers.csv'));
  const r = await startAndWait(page, opts(m));
  expect(r.progress.phase).toBe('refused');
  expect(r.progress.error).toContain('SHA-256 does not match');
  expect(r.progress.records).toEqual([]);
});

test('inputs above 50 MB combined are refused without explicit confirmation; unknown files are refused', async ({ page }) => {
  await openApp(page);
  const big = Buffer.alloc(51_000_000, 0x61);
  const m = { ...manifest(), files: { ...manifest().files, 'orders.csv': { bytes: big.length, sha256: 'x' } } };
  await page.locator('#bench-orders').setInputFiles({ name: 'orders.csv', mimeType: 'text/csv', buffer: big });
  await page.locator('#bench-customers').setInputFiles({ name: 'unlisted.csv', mimeType: 'text/csv', buffer: Buffer.from('a\n1\n') });
  const r = await startAndWait(page, opts(m));
  expect(r.progress.phase).toBe('refused');
  expect(r.progress.error).toContain('not explicitly confirmed');
  expect(r.progress.error).toContain('unlisted.csv is not listed');
});

test('a second benchmark cannot start while one is running', async ({ page }) => {
  await openApp(page);
  await page.locator('#bench-orders').setInputFiles(join(TINY, 'orders.csv'));
  await page.locator('#bench-customers').setInputFiles(join(TINY, 'customers.csv'));
  const second = await page.evaluate(async (o) => {
    window.__qvBench!.start(o as never);
    await new Promise((r) => setTimeout(r, 300)); // first run is past its guard checks
    const first = window.__qvBench!.progress!;
    window.__qvBench!.start(o as never);
    const p = window.__qvBench!.progress!;
    for (let i = 0; i < 100 && !p.done; i++) await new Promise((r) => setTimeout(r, 20));
    return { firstDone: first.done, second: { phase: p.phase, error: p.error } };
  }, opts(manifest()));
  expect(second.second.phase).toBe('refused');
  expect(second.second.error).toMatch(/already running|another tab/);
});
