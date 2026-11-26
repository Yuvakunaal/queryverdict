// Network isolation with the engine running (TESTING_STRATEGY §5.9): the production page boots
// DuckDB-WASM and loads only its own same-origin assets. A meta CSP does not govern the worker
// (ARCHITECTURE §24 V3); the engine lockdown is the control, and this capture plus a recording
// listener are the behavioural evidence.
import { expect, test } from '@playwright/test';
import { APP, HARNESS, captureRequests, startListener } from './helpers';

const ALLOWED = /^http:\/\/127\.0\.0\.1:417[34]\/queryverdict\/(?:|index\.html|\?[a-z=-]*|assets\/[A-Za-z0-9._-]+\.(?:js|css|wasm)|duckdb-ext\/v1\.5\.4\/wasm_(?:eh|mvp)\/(?:json|parquet)\.duckdb_extension\.wasm)$/;

test('production page: engine reaches ready with only same-origin static requests', async ({ page, context }) => {
  const requests = captureRequests(context);
  await page.goto(APP);
  await expect(page.getByRole('status')).toHaveText('Engine ready', { timeout: 30_000 });
  const urls = requests.map((r) => r.url());
  expect(urls.some((u) => u.includes('/assets/duckdb-'))).toBe(true);
  expect(urls.filter((u) => !ALLOWED.test(u))).toEqual([]);
  expect(requests.every((r) => r.method() === 'GET')).toBe(true);
});

test('boot, cancel, recovery and escalation attempts send nothing off-origin', async ({ page, context }) => {
  const listener = await startListener();
  const requests = captureRequests(context);
  try {
    await page.goto(HARNESS);
    await page.waitForFunction(() => window.__qvHarness?.engine !== undefined);
    await page.evaluate(async (target) => {
      const H = window.__qvHarness!.engine;
      const { session } = H.newSession();
      await session.start();
      const h = session.submit('query', (l) => l.query('SELECT sum(hash(range))::VARCHAR FROM range(30000000)', { maxRows: 1 }), H.BOUNDS);
      await new Promise((res) => setTimeout(res, 30));
      h.cancel();
      await h.result;
      await session.restart('network test');
      for (const p of H.escalationProbes(target)) await H.sql(session, p.sql);
      session.dispose();
    }, listener.url);
    expect(listener.hits).toEqual([]);
    expect(requests.map((r) => r.url()).filter((u) => !ALLOWED.test(u))).toEqual([]);
  } finally {
    await listener.close();
  }
});
