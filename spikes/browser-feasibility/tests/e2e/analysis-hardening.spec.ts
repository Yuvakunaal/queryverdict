// Regression tests for the second Codex review of the analysis engine (Phase 4 hardening):
// H-A snapshot consistency and exclusive ownership, H-B terminal outcomes in the real session,
// M4 non-finite metrics, M5 quoted identifiers, M6 complete expectation outcomes.
// Small deterministic tables only; every interfering operation is triggered from a test hook at a
// known point of the analysis, so ordering is deterministic.
import { expect, test, type Page } from '@playwright/test';
import { openHarness } from './helpers';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const codes = (r: R) => r.findings.map((f: R) => f.code);
const INCONSISTENCY = ['witness-mismatch', 'snapshot-inconsistent', 'semantic-mismatch', 'invariant-violated'];

async function start(page: Page) {
  await openHarness(page);
  await page.evaluate(async () => {
    const H = window.__qvHarness!;
    const w = window as unknown as { __s: unknown; __events: string[]; __failBoot: boolean };
    w.__events = [];
    w.__failBoot = false;
    const s = new H.EngineSession({
      memoryLimit: '1GB', cancelDeadlineMs: 2000, bootTimeoutMs: 20_000,
      log: (e) => w.__events.push(`${e.kind}${e.detail ? ` ${e.detail}` : ''}`),
      // Test-only: lets a test make the NEXT boot (recovery) fail its lockdown.
      lockdownPlan: (repo) => (w.__failBoot ? ['SELECT error(\'injected lockdown failure\')'] : H.lockdownStatements(repo)),
    });
    await s.start();
    w.__s = s;
  });
}

async function sql(page: Page, statements: string[]) {
  return page.evaluate(async (statements) => {
    const s = (window as unknown as { __s: { run(q: string): Promise<R> } }).__s;
    const out: unknown[] = [];
    for (const q of statements) {
      const r = await s.run(q);
      out.push(r.status === 'ok' ? r.result.rows : `ERR ${r.status === 'error' ? r.error : r.status}`);
    }
    return out;
  }, statements);
}

// ---------------------------------------------------------------- H-A snapshot and ownership

test('H-A: concurrent UPDATE during analysis (Codex repro) waits for the analysis; report and witnesses describe one snapshot', async ({ page }) => {
  await start(page);
  await sql(page, ['CREATE TABLE ha_l (k INTEGER)', 'INSERT INTO ha_l VALUES (1)', 'CREATE TABLE ha_r (k INTEGER)', 'INSERT INTO ha_r VALUES (1), (1), (2), (2)']);
  const out = await page.evaluate(async () => {
    const H = window.__qvHarness!;
    const w = window as unknown as { __s: InstanceType<typeof H.EngineSession>; __events: string[] };
    const s = w.__s;
    w.__events.length = 0;
    const order: string[] = [];
    let update: Promise<unknown> | null = null;
    const report = await H.analyzeInSession(s, 'SELECT * FROM ha_l JOIN ha_r ON ha_l.k = ha_r.k', [{ kind: 'relationship', join: 0, expected: 'many-to-one' }], {
      scope: 'mvp',
      testHooks: {
        beforeStatement: (q: string) => {
          // After the left frequency table exists, "another SQL operation" changes the left key.
          if (!update && q.startsWith('CREATE TEMP TABLE') && q.includes('_rf')) update = s.run('UPDATE ha_l SET k = 2').then((r) => order.push(`update ${r.status}`));
        },
      },
    });
    order.push('analysis returned');
    await update;
    const events = w.__events.filter((e) => e.startsWith('state:busy'));
    const after = await s.run('SELECT ha_l.k::VARCHAR, ha_r.k::VARCHAR FROM ha_l JOIN ha_r ON ha_l.k = ha_r.k ORDER BY 1');
    const again = await H.analyzeInSession(s, 'SELECT * FROM ha_l JOIN ha_r ON ha_l.k = ha_r.k', [], { scope: 'mvp' });
    return { report: JSON.parse(JSON.stringify(report)), order, events, after: after.status === 'ok' ? after.result.rows : after.status, again: JSON.parse(JSON.stringify(again)) };
  });
  // The UPDATE was queued behind the analysis: it ran only after the analysis returned.
  expect(out.order).toEqual(['analysis returned', 'update ok']);
  expect(out.events).toEqual(['state:busy analysis', 'state:busy query']); // captured right after the UPDATE settled
  const j = out.report.joins[0];
  expect(out.report.authoritative).toBe(true);
  expect(j.validation).toMatchObject({ invariants: 'held', semiJoin: 'agreed', executedCount: 'agreed', witnesses: 'verified', snapshot: 'verified' });
  expect(j.derived.outputRows).toBe('2');
  expect(j.samples.fanOutKeys).toEqual([['1', '1', '2']]); // witness key 1 in the analysed snapshot
  expect(j.samples.unmatchedRightKeys).toEqual([['2', '2']]);
  // After the update, the join returns key 2 twice, and a new analysis reports witness 2.
  expect(out.after).toEqual([['2', '2'], ['2', '2']]);
  expect(out.again.authoritative).toBe(true);
  expect(out.again.joins[0].samples.fanOutKeys).toEqual([['2', '1', '2']]);
});

test('H-A: interference that bypasses the queue is detected by witness identity and snapshot fingerprints; never authoritative', async ({ page }) => {
  await start(page);
  await sql(page, ['CREATE TABLE hb_l (k INTEGER)', 'INSERT INTO hb_l VALUES (1)', 'CREATE TABLE hb_r (k INTEGER)', 'INSERT INTO hb_r VALUES (1), (1), (2), (2)']);
  const run = (trigger: 'after-left-frequencies' | 'before-final-fingerprint') => page.evaluate(async (trigger) => {
    const H = window.__qvHarness!;
    const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
    await s.run('UPDATE hb_l SET k = 1');
    let fp = 0;
    let done = false;
    const report = await H.analyzeInSession(s, 'SELECT * FROM hb_l JOIN hb_r ON hb_l.k = hb_r.k', [{ kind: 'no-fan-out', join: 0, side: 'left' }], {
      scope: 'mvp',
      testHooks: {
        beforeStatement: async (q: string, batch: { run(sql: string, l: object): Promise<unknown> }) => {
          if (q.startsWith('SELECT count(*)::VARCHAR, (count(*) FILTER')) fp++;
          const hit = trigger === 'after-left-frequencies' ? q.startsWith('CREATE TEMP TABLE') && q.includes('_rf') : fp === 3;
          // Simulated defect: a write inside the analysis batch itself (exclusive ownership cannot stop this).
          if (hit && !done) {
            done = true;
            await batch.run('UPDATE hb_l SET k = 2', { maxRows: 1 });
          }
        },
      },
    });
    return JSON.parse(JSON.stringify(report));
  }, trigger);
  // Codex's exact scenario: counts still agree (SEMI JOIN and executed count), the witness does not.
  const a = await run('after-left-frequencies');
  expect(codes(a)).toContain('witness-mismatch');
  expect(a.joins[0].validation).toMatchObject({ semiJoin: 'agreed', executedCount: 'agreed', witnesses: 'mismatch' });
  expect([a.authoritative, a.joins[0].stats, a.joins[0].samples]).toEqual([false, null, null]);
  expect(codes(a)).not.toContain('join-cardinality');
  expect(a.expectations[0].outcome).toBe('unchecked');
  // A change after all statistics and witnesses were collected: the end fingerprint differs.
  const b = await run('before-final-fingerprint');
  expect(codes(b)).toContain('snapshot-inconsistent');
  expect(b.status).toBe('inconclusive');
  expect(b.joins[0].validation.snapshot).toBe('changed');
  expect([b.authoritative, b.joins[0].stats, b.stages]).toEqual([false, null, []]);
  expect(b.findings.filter((f: R) => f.join !== undefined && ['observed', 'suspicious'].includes(f.category))).toEqual([]);
});

test('H-A: concurrent dataset removal and replacement wait for the analysis; the report describes the original data', async ({ page }) => {
  await start(page);
  const out = await page.evaluate(async () => {
    const H = window.__qvHarness!;
    const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
    const a = (await s.registerFile(new File(['k\n1\n1\n2\n'], 'rm_a.csv'), 'table')).file;
    await s.registerFile(new File(['k\n1\n3\n'], 'rm_b.csv'), 'table');
    const order: string[] = [];
    let ops: Promise<unknown> | null = null;
    const report = await H.analyzeInSession(s, 'SELECT * FROM rm_a JOIN rm_b ON rm_a.k = rm_b.k', [], {
      scope: 'mvp',
      testHooks: {
        beforeStatement: (q: string) => {
          if (!ops && q.startsWith('CREATE TEMP TABLE')) {
            ops = Promise.all([
              s.dropFile(a.id).then(() => order.push('dropped')),
              s.registerFile(new File(['k\n7\n'], 'rm_a.csv'), 'table', 'rm_a').then((r) => order.push(`replaced as ${r.file.relation}`)),
            ]);
          }
        },
      },
    });
    order.push('analysis returned');
    await ops;
    const now = await s.run('SELECT k::VARCHAR FROM rm_a');
    const rel = report.relations.map((r) => r.kind);
    return { report: JSON.parse(JSON.stringify(report)), order, now: now.status === 'ok' ? now.result.rows : now.status, rel };
  });
  expect(out.order).toEqual(['analysis returned', 'dropped', 'replaced as rm_a']);
  expect(out.rel).toEqual(['base-table', 'base-table']);
  expect(out.report.authoritative).toBe(true);
  expect(out.report.joins[0].stats).toMatchObject({ leftRows: '3', rightRows: '2', matchedPairs: '2' });
  expect(out.now).toEqual([['7']]);
});

test('H-A: simultaneous analyses are serialised; each is coherent with the data at its own turn', async ({ page }) => {
  await start(page);
  await sql(page, ['CREATE TABLE hm_l (k INTEGER)', 'INSERT INTO hm_l VALUES (1), (1)', 'CREATE TABLE hm_r (k INTEGER)', 'INSERT INTO hm_r VALUES (1), (2)']);
  const out = await page.evaluate(async () => {
    const H = window.__qvHarness!;
    const w = window as unknown as { __s: InstanceType<typeof H.EngineSession>; __events: string[] };
    w.__events.length = 0;
    const q = 'SELECT * FROM hm_l JOIN hm_r ON hm_l.k = hm_r.k';
    const [a, , b] = await Promise.all([
      H.analyzeInSession(w.__s, q, [], { scope: 'mvp' }),
      w.__s.run('INSERT INTO hm_l VALUES (2), (2), (2)'),
      H.analyzeInSession(w.__s, q, [], { scope: 'mvp' }),
    ]);
    return { a: JSON.parse(JSON.stringify(a)), b: JSON.parse(JSON.stringify(b)), events: w.__events.filter((e) => e.startsWith('state:busy')) };
  });
  expect(out.events).toEqual(['state:busy analysis', 'state:busy query', 'state:busy analysis']);
  expect([out.a.authoritative, out.a.joins[0].derived.outputRows]).toEqual([true, '2']);
  expect([out.b.authoritative, out.b.joins[0].derived.outputRows]).toEqual([true, '5']);
  expect(out.a.diagnosticSql.filter((s: string) => s === 'BEGIN TRANSACTION')).toHaveLength(1);
});

test('H-A: volatile nextval() views, volatile generated columns and arbitrary views are never authoritative', async ({ page }) => {
  await start(page);
  await sql(page, [
    'CREATE SEQUENCE hv_seq', 'CREATE VIEW hv_vol AS SELECT nextval(\'hv_seq\')::INTEGER AS k FROM range(3)',
    'CREATE TABLE hv_t AS SELECT range::INTEGER AS k FROM range(100)',
    'CREATE VIEW hv_plain AS SELECT k FROM hv_t',
    'CREATE SEQUENCE hv_seq2', "CREATE TABLE hv_gen (k INTEGER, g AS (nextval('hv_seq2')))", 'INSERT INTO hv_gen (k) VALUES (1), (2)',
  ]);
  const analyse = (q: string, scope: string) => page.evaluate(async ({ q, scope }) => {
    const H = window.__qvHarness!;
    return JSON.parse(JSON.stringify(await H.analyzeInSession((window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s, q, [{ kind: 'no-fan-out', join: 0 }], { scope: scope as 'mvp' })));
  }, { q, scope });
  for (const [q, kind, refusal] of [
    ['SELECT * FROM hv_vol JOIN hv_t ON hv_vol.k = hv_t.k', 'view', 'views are not verified'],
    ['SELECT * FROM hv_plain JOIN hv_t ON hv_plain.k = hv_t.k', 'view', 'views are not verified'],
    ['SELECT * FROM hv_gen JOIN hv_t ON hv_gen.k = hv_t.k', 'base-table', 'generated columns'],
  ] as const) {
    const m = await analyse(q, 'mvp');
    expect([q, m.status, m.authoritative, m.joins]).toEqual([q, 'unsupported', false, []]);
    expect(m.relations[0]).toMatchObject({ kind, refusal: expect.stringContaining(refusal) });
    expect(m.findings[0].code).toBe('unsupported-relation');
    expect(m.expectations.map((o: R) => o.outcome)).toEqual(['unchecked']);
  }
  // Experimental scope analyses the volatile view but can never be authoritative; the changing
  // input is detected (each scan of the view yields new keys).
  const v = await analyse('SELECT * FROM hv_vol JOIN hv_t ON hv_vol.k = hv_t.k', 'experimental');
  expect(v.authoritative).toBe(false);
  expect(codes(v).some((c: string) => INCONSISTENCY.includes(c))).toBe(true);
  expect(v.nonAuthoritativeReasons.join(' ')).toContain('views are not verified');
  const p = await analyse('SELECT * FROM hv_plain JOIN hv_t ON hv_plain.k = hv_t.k', 'experimental');
  expect([p.status, p.authoritative]).toEqual(['analyzed', false]);
  expect(p.joins[0].validation).toMatchObject({ witnesses: 'verified', snapshot: 'verified' });
});

test('H-A: ambiguous names, tables outside the current schema and file-backed views are refused in MVP scope', async ({ page }) => {
  await start(page);
  await sql(page, ['CREATE TABLE hn_a (k INTEGER)', 'INSERT INTO hn_a VALUES (1)', 'CREATE TABLE hn_b (k INTEGER)', 'INSERT INTO hn_b VALUES (1)', 'CREATE TEMP TABLE hn_a (k INTEGER)']);
  const out = await page.evaluate(async () => {
    const H = window.__qvHarness!;
    const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
    const go = async (q: string) => JSON.parse(JSON.stringify(await H.analyzeInSession(s, q, [], { scope: 'mvp' })));
    const ambiguous = await go('SELECT * FROM hn_a JOIN hn_b ON hn_a.k = hn_b.k');
    await s.run('ATTACH \':memory:\' AS hn_other');
    await s.run('CREATE TABLE hn_other.main.hn_c (k INTEGER)');
    await s.run('USE hn_other');
    await s.run('CREATE TABLE hn_d (k INTEGER)');
    const otherDb = await go('SELECT * FROM hn_d JOIN hn_c ON hn_d.k = hn_c.k'); // both in the attached db, which is now current
    await s.run('USE memory');
    const fileView = (await s.registerFile(new File(['k\n1\n'], 'hn_file.csv'), 'view')).file;
    const file = await go(`SELECT * FROM ${fileView.relation} JOIN hn_b ON ${fileView.relation}.k = hn_b.k`);
    return { ambiguous, otherDb, file };
  });
  expect(out.ambiguous.status).toBe('unsupported');
  expect(out.ambiguous.relations[0]).toMatchObject({ kind: 'ambiguous' });
  expect(out.otherDb.status).toBe('analyzed'); // current database after USE: resolution is unambiguous
  expect(out.otherDb.authoritative).toBe(true);
  expect(out.file.status).toBe('unsupported');
  expect(out.file.relations[0]).toMatchObject({ kind: 'view' });
});

test('H-A/H-B: cancellation during analysis ownership (between and during statements) ends as cancelled and releases ownership', async ({ page }) => {
  await start(page);
  await sql(page, ['CREATE TABLE hc_a AS SELECT (range % 3)::INTEGER AS k FROM range(9)']);
  const out = await page.evaluate(async () => {
    const H = window.__qvHarness!;
    const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
    const q = 'SELECT * FROM hc_a JOIN hc_a AS b ON hc_a.k = b.k';
    // between statements: the cancel is requested while no statement runs
    let c1: Promise<unknown> | null = null;
    const between = await H.analyzeInSession(s, q, [{ kind: 'no-fan-out', join: 0 }], { scope: 'mvp', testHooks: { beforeStatement: (x: string) => { if (!c1 && x.startsWith('CREATE TEMP TABLE')) c1 = s.cancel(); } } });
    const c1r = await c1;
    // during a running statement: a slow statement is swapped in and cancelled after 50 ms
    let swapped = false;
    let c2: Promise<unknown> | null = null;
    const during = await H.analyzeInSession(s, q, [], { scope: 'mvp', testHooks: { beforeStatement: (x: string) => {
      if (!swapped && x.startsWith('CREATE TEMP TABLE')) {
        swapped = true;
        c2 = new Promise((r) => setTimeout(() => r(s.cancel()), 50));
        return 'SELECT sum(hash(range))::VARCHAR FROM range(30000000)';
      }
    } } });
    const c2r = await c2;
    const temps = await s.run("SELECT count(*)::VARCHAR FROM duckdb_tables() WHERE table_name LIKE '__qv_%'");
    const after = await H.analyzeInSession(s, q, [], { scope: 'mvp' });
    return { between: JSON.parse(JSON.stringify(between)), during: JSON.parse(JSON.stringify(during)), c1r, c2r, temps: temps.status === 'ok' ? temps.result.rows[0]![0] : 'ERR', after: after.authoritative, state: s.state };
  });
  for (const r of [out.between, out.during]) {
    expect([r.status, r.authoritative, r.joins]).toEqual(['cancelled', false, []]);
    expect(r.terminal.reason).toBe('cancelled');
    expect(r.diagnosticSql.at(-1)).toBe('ROLLBACK');
  }
  expect(out.between.expectations.map((o: R) => o.outcome)).toEqual(['unchecked']);
  expect((out.c2r as unknown as R).method).toBe('cooperative');
  expect([out.temps, out.state, out.after]).toEqual(['0', 'ready', true]); // ownership released, nothing left behind
});

test('H-A/H-B: session replacement or disposal while an analysis is running or queued is never authoritative and never hangs', async ({ page }) => {
  await start(page);
  await sql(page, ['CREATE TABLE hr_a AS SELECT (range % 3)::INTEGER AS k FROM range(9)']);
  const out = await page.evaluate(async () => {
    const H = window.__qvHarness!;
    const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
    const q = 'SELECT * FROM hr_a JOIN hr_a AS b ON hr_a.k = b.k';
    let restart: Promise<unknown> | null = null;
    const running = await H.analyzeInSession(s, q, [{ kind: 'no-fan-out', join: 0 }], { scope: 'mvp', testHooks: { beforeStatement: (x: string) => { if (!restart && x.startsWith('CREATE TEMP TABLE')) restart = s.restart('test: replaced during analysis'); } } });
    await restart;
    const gen = s.info?.generation;
    // queued behind a slow user query, then the engine is replaced: tables are gone on the new engine
    await s.run('CREATE TABLE hr_b AS SELECT (range % 3)::INTEGER AS k FROM range(9)');
    const slow = s.run('SELECT sum(hash(range))::VARCHAR FROM range(30000000)');
    const queued = H.analyzeInSession(s, 'SELECT * FROM hr_b JOIN hr_b AS c ON hr_b.k = c.k', [], { scope: 'mvp' });
    await new Promise((r) => setTimeout(r, 30));
    await s.restart('test: replaced while queued');
    const [slowR, queuedR] = await Promise.all([slow, queued]);
    // disposed while running
    const d = new H.EngineSession({ memoryLimit: '1GB', cancelDeadlineMs: 2000 });
    await d.start();
    await d.run('CREATE TABLE hd AS SELECT range::INTEGER AS k FROM range(3)');
    const t = performance.now();
    const disposed = await H.analyzeInSession(d, 'SELECT * FROM hd JOIN hd AS e ON hd.k = e.k', [], { scope: 'mvp', testHooks: { beforeStatement: (x: string) => { if (x.startsWith('CREATE TEMP TABLE')) void d.dispose(); } } });
    return { running: JSON.parse(JSON.stringify(running)), gen, slow: slowR.status, queued: JSON.parse(JSON.stringify(queuedR)), disposed: JSON.parse(JSON.stringify(disposed)), disposedMs: performance.now() - t, state: s.state };
  });
  expect([out.running.status, out.running.authoritative]).toEqual(['diagnostic-failed', false]);
  expect(codes(out.running)).toContain('session-replaced');
  expect(out.running.expectations.map((o: R) => o.outcome)).toEqual(['unchecked']);
  expect(out.gen).toBe(2);
  expect(out.slow).not.toBe('ok');
  expect([out.queued.status, out.queued.authoritative]).toEqual(['query-failed', false]); // hr_b no longer exists on the new engine
  expect(['diagnostic-failed', 'cancelled']).toContain(out.disposed.status);
  expect(out.disposed.authoritative).toBe(false);
  expect(out.disposedMs).toBeLessThan(10_000);
  expect(out.state).toBe('ready');
});

test('H-B: failed worker recovery is fail-closed; successful recovery re-establishes the verified lockdown', async ({ page }) => {
  await start(page);
  await sql(page, ['CREATE TABLE hf_a AS SELECT (range % 3)::INTEGER AS k FROM range(9)']);
  const out = await page.evaluate(async () => {
    const H = window.__qvHarness!;
    const w = window as unknown as { __s: InstanceType<typeof H.EngineSession>; __failBoot: boolean };
    const s = w.__s;
    const q = 'SELECT * FROM hf_a JOIN hf_a AS b ON hf_a.k = b.k';
    const waitFor = async (states: string[]) => { for (let i = 0; i < 400 && !states.includes(s.state); i++) await new Promise((r) => setTimeout(r, 25)); return s.state; };
    // 1. invalidation with a recovery that succeeds
    let fired = false;
    const r1 = await H.analyzeInSession(s, q, [], { scope: 'mvp', testHooks: { beforeStatement: (x: string, batch: { invalidate(r: string): void }) => { if (!fired && x.startsWith('CREATE TEMP TABLE')) { fired = true; batch.invalidate('test: worker stalled'); } } } });
    const st1 = await waitFor(['ready', 'failed']);
    const lock = await s.run("SELECT current_setting('enable_external_access')::VARCHAR, current_setting('lock_configuration')::VARCHAR");
    const escalate = await s.run('SET enable_external_access = true');
    const info = { verified: s.info?.lockdownVerified, generation: s.info?.generation };
    // 2. invalidation with a recovery that fails its lockdown
    await s.run('CREATE TABLE hf_b AS SELECT (range % 3)::INTEGER AS k FROM range(9)');
    fired = false;
    const r2 = await H.analyzeInSession(s, 'SELECT * FROM hf_b JOIN hf_b AS c ON hf_b.k = c.k', [], { scope: 'mvp', testHooks: { beforeStatement: (x: string, batch: { invalidate(r: string): void }) => { if (!fired && x.startsWith('CREATE TEMP TABLE')) { fired = true; w.__failBoot = true; batch.invalidate('test: worker stalled'); } } } });
    const st2 = await waitFor(['failed', 'ready']);
    const refused = await s.run('SELECT 1');
    const r3 = await H.analyzeInSession(s, 'SELECT * FROM hf_b JOIN hf_b AS c ON hf_b.k = c.k', [{ kind: 'row-count', max: 1 }], { scope: 'mvp' });
    return { r1: JSON.parse(JSON.stringify(r1)), st1, lock: lock.status === 'ok' ? lock.result.rows : lock.status, escalate: escalate.status, info, r2: JSON.parse(JSON.stringify(r2)), st2, refused, r3: JSON.parse(JSON.stringify(r3)), info2: s.info };
  });
  expect([out.r1.status, out.r1.authoritative]).toEqual(['diagnostic-failed', false]);
  expect(out.st1).toBe('ready');
  expect(out.info).toEqual({ verified: true, generation: 2 });
  expect(out.lock).toEqual([['false', 'true']]);
  expect(out.escalate).toBe('error');
  expect([out.r2.status, out.r2.authoritative]).toEqual(['diagnostic-failed', false]);
  expect(out.st2).toBe('failed');
  expect(out.info2).toBeNull(); // no engine: no SQL until a successful start()
  expect((out.refused as R).status).toBe('error');
  expect((out.refused as R).error).toContain('not ready');
  expect([out.r3.status, codes(out.r3)[0]]).toEqual(['diagnostic-failed', 'session-unavailable']);
  expect(out.r3.expectations.map((o: R) => o.outcome)).toEqual(['unchecked']);
});

// ---------------------------------------------------------------- M4 non-finite metrics

test('M4: non-finite metric totals (+inf, -inf, NaN) are unchecked, never held; finite and NULL semantics unchanged', async ({ page }) => {
  await start(page);
  await sql(page, [
    'CREATE TABLE nf_c (k INTEGER)', 'INSERT INTO nf_c VALUES (2)',
    "CREATE TABLE nf_pos (k INTEGER, m DOUBLE)", "INSERT INTO nf_pos VALUES (1, 'inf'), (2, 1.0)",
    "CREATE TABLE nf_neg (k INTEGER, m DOUBLE)", "INSERT INTO nf_neg VALUES (1, '-inf'), (2, 1.0)",
    "CREATE TABLE nf_nan (k INTEGER, m DOUBLE)", "INSERT INTO nf_nan VALUES (1, 'nan'), (2, 1.0)",
    "CREATE TABLE nf_both (k INTEGER, m DOUBLE)", "INSERT INTO nf_both VALUES (2, 'inf')",
    'CREATE TABLE nf_fin (k INTEGER, m DOUBLE)', 'INSERT INTO nf_fin VALUES (2, 1.0), (2, 1.005)',
    'CREATE TABLE nf_big (k INTEGER, m DOUBLE)', 'INSERT INTO nf_big VALUES (2, 1e308)',
  ]);
  const metric = (t: string, e: object) => page.evaluate(async ({ t, e }) => {
    const H = window.__qvHarness!;
    const r = await H.analyzeInSession((window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s, `SELECT * FROM ${t} JOIN nf_c ON ${t}.k = nf_c.k`, [{ kind: 'metric-preserved', column: `${t}.m`, ...e } as never], { scope: 'experimental' });
    return JSON.parse(JSON.stringify(r.expectations[0]));
  }, { t, e });
  for (const t of ['nf_pos', 'nf_neg', 'nf_nan']) {
    for (const tol of [0.01, 0, 1]) {
      const o = await metric(t, { tolerance: tol });
      expect([t, tol, o.outcome]).toEqual([t, tol, 'unchecked']);
      expect(o.reason).toContain('not a finite number');
    }
  }
  expect((await metric('nf_pos', { tolerance: 0.01 })).evidence).toMatchObject({ sourceTotal: 'inf', joinedTotal: '1.0' }); // the Codex repro
  expect((await metric('nf_both', {})).outcome).toBe('unchecked'); // inf vs inf is not "equal"
  const big = await metric('nf_big', { tolerance: 2 }); // finite totals (1e308), bound 2 × 1e308 overflows
  expect([big.outcome, big.reason]).toEqual(['unchecked', expect.stringContaining('tolerance bound is not a finite number')]);
  // finite comparisons unchanged
  expect((await metric('nf_fin', {})).outcome).toBe('held');
  expect((await metric('nf_fin', { tolerance: 0.01 })).outcome).toBe('held');
  // invalid tolerances are reported as invalid expectations
  for (const tolerance of [-1, Number.NaN, Number.POSITIVE_INFINITY, '0.1']) {
    const o = await metric('nf_fin', { tolerance });
    expect([String(tolerance), o.outcome, o.reason]).toEqual([String(tolerance), 'unchecked', 'invalid expectation: tolerance must be a finite number >= 0']);
  }
});

// ---------------------------------------------------------------- M5 quoted identifiers

test('M5: quoted identifiers with dots, spaces, escaped quotes, reserved words and aliases keep their statistics', async ({ page }) => {
  await start(page);
  await sql(page, [
    'CREATE TABLE "q l" ("k.x" INTEGER, "my key" INTEGER, "we""ird" INTEGER, "select" INTEGER, "amount.usd" DECIMAL(9,2))',
    'INSERT INTO "q l" VALUES (1, 1, 1, 5, 1.00), (2, 2, 2, 6, 2.00), (3, 3, 3, 7, 3.00)',
    'CREATE TABLE "my rel" ("k.x" INTEGER, "my key" INTEGER, "we""ird" INTEGER, "select" INTEGER)',
    'INSERT INTO "my rel" VALUES (1, 1, 1, 0), (1, 1, 1, 9), (2, 2, 9, 1)',
  ]);
  const go = (q: string, scope: string, expectations: unknown[] = [], inject?: string) => page.evaluate(async ({ q, scope, expectations, inject }) => {
    const H = window.__qvHarness!;
    const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
    let hit = false;
    const testHooks = inject ? { beforeStatement: (x: string) => { if (!hit && x.includes(inject)) { hit = true; throw new H.DiagnosticError('engine', 'injected optional-probe failure'); } } } : undefined;
    const r = await H.analyzeInSession(s, q, expectations as never, { scope: scope as 'mvp', testHooks });
    const direct = await s.run(`SELECT count(*)::VARCHAR FROM (${q})`);
    return { r: JSON.parse(JSON.stringify(r)), direct: direct.status === 'ok' ? direct.result.rows[0]![0] : direct.status };
  }, { q, scope, expectations, inject });
  // Codex repro: r."k.x" in an experimental LEFT JOIN with a filtering probe
  const left = await go('SELECT * FROM "q l" AS l LEFT JOIN "my rel" AS r ON l."k.x" = r."k.x" WHERE r."select" > 0', 'experimental', [{ kind: 'metric-preserved', column: 'l."amount.usd"' }]);
  expect(left.r.joins[0].stats).not.toBeNull();
  expect(left.r.joins[0].keys).toEqual([{ left: 'l."k.x"', right: 'r."k.x"', type: 'INTEGER' }]);
  expect(codes(left.r)).not.toContain('optional-check-failed');
  const f = left.r.findings.find((x: R) => x.code.startsWith('where-'));
  expect(f.code).toBe('where-removes-null-extended-rows');
  expect(f.evidence.removedByWhere).toBe('1'); // key 3 has no match; WHERE on r removes it
  expect(left.r.stages.find((x: R) => x.stage === 'final result').rows).toBe(left.direct);
  expect(left.r.expectations[0].outcome).toBe('unchecked'); // WHERE references another relation
  // composite keys with spaces and escaped quotes, aliases with spaces, MVP scope
  const mvp = await go('SELECT * FROM "q l" AS "my alias" JOIN "my rel" ON "my alias"."my key" = "my rel"."my key" AND "my alias"."we""ird" = "my rel"."we""ird"', 'mvp');
  expect([mvp.r.status, mvp.r.authoritative]).toEqual(['analyzed', true]);
  expect(mvp.r.joins[0].derived.outputRows).toBe(mvp.direct);
  expect(mvp.r.joins[0].keys.map((k: R) => k.left)).toEqual(['"my alias"."my key"', '"my alias"."we""ird"']);
  // reserved word as key
  const reserved = await go('SELECT * FROM "q l" JOIN "my rel" USING ("select")', 'mvp');
  expect([reserved.r.status, reserved.r.joins[0].derived.outputRows]).toEqual(['analyzed', reserved.direct]);
  // an optional probe that fails keeps the validated join evidence but is never authoritative
  const failed = await go('SELECT * FROM "q l" AS l LEFT JOIN "my rel" AS r ON l."k.x" = r."k.x" WHERE r."select" > 0', 'experimental', [], 'OPERATOR_IS_NULL');
  expect(codes(failed.r)).toContain('optional-check-failed');
  expect(failed.r.joins[0].stats).toEqual(left.r.joins[0].stats);
  expect([failed.r.status, failed.r.authoritative]).toEqual(['partially-analyzed', false]);
});

// ---------------------------------------------------------------- M6 expectation outcomes

test('M6: every early-exit path returns exactly one outcome per declared expectation, with index and identity', async ({ page }) => {
  await start(page);
  await sql(page, ['CREATE TABLE ex_a (k INTEGER, s VARCHAR)', "INSERT INTO ex_a VALUES (1, 'x')", 'CREATE TABLE ex_b (k INTEGER, s VARCHAR)', "INSERT INTO ex_b VALUES (1, 'x')", 'CREATE VIEW ex_v AS SELECT * FROM ex_a']);
  const exps = [
    { kind: 'relationship', join: 0, expected: 'one-to-one' },
    { kind: 'no-row-loss', join: 0, side: 'left' },
    { kind: 'row-count', min: 1 },
    { kind: 'unknown-kind' },
    { kind: 'row-count', min: 3, max: 1 },
  ];
  const out = await page.evaluate(async (exps) => {
    const H = window.__qvHarness!;
    const s = (window as unknown as { __s: InstanceType<typeof H.EngineSession> }).__s;
    const cases: [string, string, Record<string, unknown>][] = [
      ['syntax error', 'SELECT * FROM', {}],
      ['not a SELECT', 'DELETE FROM ex_a', {}],
      ['unsupported construct', 'SELECT * FROM ex_a JOIN ex_b ON ex_a.k = ex_b.k ORDER BY 1', {}],
      ['bind failure', 'SELECT nope FROM ex_a JOIN ex_b ON ex_a.k = ex_b.k', {}],
      ['view refused', 'SELECT * FROM ex_v JOIN ex_b ON ex_v.k = ex_b.k', {}],
      ['non-integer key', 'SELECT * FROM ex_a JOIN ex_b ON ex_a.s = ex_b.s', {}],
      ['input budget', 'SELECT * FROM ex_a JOIN ex_b ON ex_a.k = ex_b.k', { maxInputRows: 0n }],
      ['deadline', 'SELECT * FROM ex_a JOIN ex_b ON ex_a.k = ex_b.k', { deadlineMs: 0 }],
      ['injected diagnostic failure', 'SELECT * FROM ex_a JOIN ex_b ON ex_a.k = ex_b.k', { testHooks: { beforeStatement: (x: string) => { if (x.startsWith('DESCRIBE SELECT *')) throw new H.DiagnosticError('shape', 'injected'); } } }],
      ['analysed', 'SELECT * FROM ex_a JOIN ex_b ON ex_a.k = ex_b.k', {}],
    ];
    const res: { name: string; status: string; outcomes: [number, string, string][]; identity: boolean }[] = [];
    for (const [name, q, o] of cases) {
      const r = await H.analyzeInSession(s, q, exps as never, { scope: 'mvp', ...o });
      res.push({ name, status: r.status, outcomes: r.expectations.map((x) => [x.index, x.outcome, x.reason ?? '']), identity: r.expectations.every((x, i) => x.expectation === exps[i]) });
    }
    // an open user transaction
    await s.run('BEGIN TRANSACTION');
    const tx = await H.analyzeInSession(s, 'SELECT * FROM ex_a JOIN ex_b ON ex_a.k = ex_b.k', exps as never, { scope: 'mvp' });
    await s.run('ROLLBACK');
    res.push({ name: 'open transaction', status: tx.status, outcomes: tx.expectations.map((x) => [x.index, x.outcome, x.reason ?? '']), identity: tx.expectations.every((x, i) => x.expectation === exps[i]) });
    return res;
  }, exps);
  const statuses = Object.fromEntries(out.map((r) => [r.name, r.status]));
  expect(statuses).toEqual({
    'syntax error': 'query-failed', 'not a SELECT': 'unsupported', 'unsupported construct': 'unsupported', 'bind failure': 'query-failed', 'view refused': 'unsupported',
    'non-integer key': 'unsupported', 'input budget': 'partially-analyzed', deadline: 'budget-exhausted', 'injected diagnostic failure': 'diagnostic-failed', analysed: 'partially-analyzed', 'open transaction': 'inconclusive',
  });
  for (const r of out) {
    expect([r.name, r.outcomes.map((o) => o[0])]).toEqual([r.name, [0, 1, 2, 3, 4]]);
    expect([r.name, r.identity]).toEqual([r.name, true]);
    // invalid shapes are reported as invalid on every path
    expect(r.outcomes[3]).toEqual([3, 'unchecked', 'invalid expectation: unknown expectation kind "unknown-kind"']);
    expect(r.outcomes[4]).toEqual([4, 'unchecked', 'invalid expectation: min is greater than max']);
    if (r.name !== 'analysed') expect([r.name, r.outcomes.slice(0, 3).every((o) => o[1] === 'unchecked' && o[2].length > 0)]).toEqual([r.name, true]);
  }
  // the analysed case evaluates the valid ones; the invalid ones keep the report partial
  expect(out.find((r) => r.name === 'analysed')!.outcomes.slice(0, 3).map((o) => o[1])).toEqual(['held', 'held', 'held']);
});
