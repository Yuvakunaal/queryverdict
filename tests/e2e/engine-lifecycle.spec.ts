// Real-engine lifecycle with harness-only fault injection (M02 field 15; TESTING_STRATEGY §5.6,
// §5.7; T-ENG-003, 004, 008, 014). Workloads are tiny or CPU-bound and memory-light.
import { expect, test, type Page } from '@playwright/test';
import { HARNESS } from './helpers';

const SLOW = 'SELECT sum(hash(range))::VARCHAR FROM range(30000000)'; // ≈0.3 s in Chrome on the M2, streams, no materialisation

async function open(page: Page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__qvHarness?.engine !== undefined);
}

test.describe('engine lifecycle (real DuckDB-WASM)', () => {
  test.beforeEach(async ({ page }) => open(page));

  test('fail-closed boot: each failed, skipped or ineffective control blocks ready and terminates the candidate (T-ENG-008)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const H = window.__qvHarness!.engine;
      const cases = [
        { name: 'statement fails', failStatement: 'SET lock_configuration = true', skipStatement: null },
        { name: 'external access left on (skipped)', failStatement: null, skipStatement: 'SET enable_external_access = false' },
        { name: 'lock skipped', failStatement: null, skipStatement: 'SET lock_configuration = true' },
        { name: 'json not loaded (skipped)', failStatement: null, skipStatement: 'LOAD json' },
      ];
      const out = [];
      for (const c of cases) {
        H.faults.failStatement = c.failStatement;
        H.faults.skipStatement = c.skipStatement;
        const { session } = H.newSession({ faulty: true });
        const err = await session.start().then(() => null, (e: unknown) => String(e));
        const refused = await H.sql(session, 'SELECT 1::VARCHAR');
        out.push({ name: c.name, err, state: session.state.kind, gen: session.generation, refused: refused.terminal.status });
        session.dispose();
      }
      H.faults.failStatement = null;
      H.faults.skipStatement = null;
      return out;
    });
    for (const c of r) {
      expect([c.name, c.state, c.gen, c.refused]).toEqual([c.name, 'failed', null, 'refused']);
      expect(c.err).toMatch(/Mandatory security control/);
    }
  });

  test('a boot that never completes fails within bootMs', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const H = window.__qvHarness!.engine;
      H.faults.boot = 'stall';
      const { session } = H.newSession({ faulty: true, bootMs: 500 });
      const t0 = performance.now();
      const err = await session.start().then(() => null, (e: unknown) => String(e));
      H.faults.boot = 'none';
      return { err, ms: performance.now() - t0, state: session.state.kind };
    });
    expect(r.err).toMatch(/did not finish within 500 ms/);
    expect(r.ms).toBeLessThan(1_500);
    expect(r.state).toBe('failed');
  });

  test('cooperative cancel and deadline stop a running statement; the engine stays on the same generation', async ({ page }) => {
    const r = await page.evaluate(async (SLOW) => {
      const H = window.__qvHarness!.engine;
      const { session } = H.newSession();
      await session.start();
      const h = session.submit('query', (l) => l.query(SLOW, { maxRows: 1 }), H.BOUNDS);
      await new Promise((res) => setTimeout(res, 40));
      h.cancel();
      const user = (await h.result).terminal;
      const deadline = (await session.submit('query', (l) => l.query(SLOW, { maxRows: 1 }), { ...H.BOUNDS, runMs: 60 }).result).terminal;
      const after = await H.sql(session, 'SELECT 42::VARCHAR');
      return { user, deadline, after: after.rows, gen: session.generation };
    }, SLOW);
    expect(r.user).toEqual({ status: 'cancelled', by: 'user', stop: 'cooperative' });
    expect(r.deadline).toEqual({ status: 'cancelled', by: 'deadline', stop: 'cooperative' });
    expect([r.after, r.gen]).toEqual([[['42']], 1]);
  });

  test('a cancel that does not stop the statement terminates the worker within the grace bound and recovers with verified lockdown', async ({ page }) => {
    const r = await page.evaluate(async (SLOW) => {
      const H = window.__qvHarness!.engine;
      H.faults.ignoreCancel = true;
      const { session } = H.newSession({ faulty: true });
      await session.start();
      const long = `SELECT sum(hash(range))::VARCHAR FROM range(3000000000)`; // stopped by termination long before completion
      const h = session.submit('query', (l) => l.query(long, { maxRows: 1 }), { ...H.BOUNDS, cancelGraceMs: 300 });
      const queued = session.submit('query', (l) => l.query(SLOW.replace('30000000', '10'), { maxRows: 1 }), H.BOUNDS);
      await new Promise((res) => setTimeout(res, 40));
      const t0 = performance.now();
      h.cancel();
      const c = await h.result;
      const ms = performance.now() - t0;
      H.faults.ignoreCancel = false;
      const q = await queued.result;
      const lock = await H.sql(session, "SELECT current_setting('enable_external_access')::VARCHAR, current_setting('lock_configuration')::VARCHAR");
      const escalate = await H.sql(session, 'SET enable_external_access = true');
      return { c: c.terminal, ms, queued: q.terminal, queuedGen: q.generation, gen: session.generation, epoch: session.epoch, lock: lock.rows, escalate: escalate.terminal.status, verified: session.info?.verified };
    }, SLOW);
    expect(r.c).toEqual({ status: 'cancelled', by: 'user', stop: 'terminated' });
    expect(r.ms).toBeLessThan(2 * 300 + 500);
    expect([r.queued.status, r.queuedGen, r.gen, r.epoch]).toEqual(['ok', 2, 2, 1]);
    expect(r.lock).toEqual([['false', 'true']]);
    expect([r.escalate, r.verified]).toEqual(['error', true]);
  });

  test('a recovery whose lockdown fails leaves the session failed; queued and later work is refused (fail closed)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const H = window.__qvHarness!.engine;
      const { session } = H.newSession({ faulty: true });
      await session.start();
      H.faults.failStatement = 'SET enable_external_access = false';
      const p = session.restart('test');
      const queued = session.submit('query', (l) => l.query('SELECT 1::VARCHAR', { maxRows: 1 }), H.BOUNDS);
      await p;
      const q = await queued.result;
      const later = await H.sql(session, 'SELECT 1::VARCHAR');
      H.faults.failStatement = null;
      const retried = await session.start().then(() => session.state.kind, (e: unknown) => String(e));
      return { state: q.terminal.status, later: later.terminal.status, retried };
    });
    expect([r.state, r.later, r.retried]).toEqual(['refused', 'refused', 'ready']);
  });

  test('a body that never settles cannot hold the queue; a revoked lease reaches nothing (QV-SA-005)', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const H = window.__qvHarness!.engine;
      const { session } = H.newSession();
      await session.start();
      let leaked: Parameters<Parameters<typeof session.submit>[1]>[0] | null = null;
      const dead = session.submit('query', (l) => { leaked = l; return new Promise(() => undefined); }, { ...H.BOUNDS, runMs: 200 });
      const later = session.submit('query', (l) => l.query('SELECT 7::VARCHAR', { maxRows: 1 }), H.BOUNDS);
      const t0 = performance.now();
      const d = await dead.result;
      const l = await later.result;
      const ms = performance.now() - t0;
      const use = await leaked!.query('SELECT 1', { maxRows: 1 }).then(() => 'ran', (e: unknown) => `${(e as Error).name}/${(e as { code?: string }).code}`);
      return { d: d.terminal, l: l.value, ms, use };
    });
    expect(r.d).toEqual({ status: 'cancelled', by: 'deadline', stop: 'cooperative' });
    expect(r.l).toEqual([['7']]);
    expect(r.ms).toBeLessThan(200 + 2 * 2_000);
    expect(r.use).toBe('LeaseRevokedError/lease-revoked');
  });

  test('queued cancel does no engine work (T-ENG-014); stalled registerFile is terminated', async ({ page }) => {
    const r = await page.evaluate(async (SLOW) => {
      const H = window.__qvHarness!.engine;
      const { session } = H.newSession({ faulty: true });
      await session.start();
      const running = session.submit('query', (l) => l.query(SLOW, { maxRows: 1 }), H.BOUNDS);
      let ran = false;
      const queued = session.submit('catalog', async (l) => { ran = true; return l.query('CREATE TABLE should_not_exist (x INTEGER)', { maxRows: 1 }); }, H.BOUNDS);
      queued.cancel();
      const q = await queued.result;
      await running.result;
      const exists = await H.sql(session, "SELECT count(*)::VARCHAR FROM duckdb_tables() WHERE table_name = 'should_not_exist'");
      H.faults.stallRegister = true;
      const reg = session.submit('import', (l) => l.registerFile('/qv-local/x.csv', new File(['a'], 'x.csv')), { ...H.BOUNDS, cancelGraceMs: 200 });
      await new Promise((res) => setTimeout(res, 20));
      reg.cancel();
      const g = await reg.result;
      H.faults.stallRegister = false;
      return { q: q.terminal, ran, exists: exists.rows, reg: g.terminal };
    }, SLOW);
    expect(r.q).toEqual({ status: 'cancelled', by: 'user', stop: 'cooperative' });
    expect([r.ran, r.exists]).toEqual([false, [['0']]]);
    expect(r.reg).toEqual({ status: 'cancelled', by: 'user', stop: 'terminated' });
  });

  test('dispose during boot and during an operation settles everything and never hangs', async ({ page }) => {
    const r = await page.evaluate(async (SLOW) => {
      const H = window.__qvHarness!.engine;
      const a = H.newSession();
      const p = a.session.start().then(() => 'started', (e: unknown) => String(e));
      await new Promise((res) => setTimeout(res, 5));
      a.session.dispose();
      const boot = await p;
      const b = H.newSession();
      await b.session.start();
      const h = b.session.submit('query', (l) => l.query(SLOW, { maxRows: 1 }), H.BOUNDS);
      const queued = b.session.submit('query', async () => 1, H.BOUNDS);
      await new Promise((res) => setTimeout(res, 20));
      b.session.dispose();
      return { boot, bootState: a.session.state.kind, active: (await h.result).terminal, queued: (await queued.result).terminal };
    }, SLOW);
    expect(r.boot).toMatch(/disposed/i);
    expect(r.bootState).toBe('disposed');
    expect(r.active).toEqual({ status: 'stale', reason: 'disposed' });
    expect(r.queued).toEqual({ status: 'stale', reason: 'disposed' });
  });

  test('the app shows a failed engine with Retry, and Retry brings it to ready with lockdown verified', async ({ page }) => {
    await page.goto(`${HARNESS}?view=app-faulty`);
    const status = page.getByRole('status');
    await expect(status).toContainText('Engine unavailable', { timeout: 30_000 });
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    await page.evaluate(() => { window.__qvHarness!.engine.faults.failStatement = null; });
    await retry.click();
    await expect(status).toHaveText('Engine ready', { timeout: 30_000 });
    await expect(retry).toBeHidden();
  });
});
