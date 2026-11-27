// The preview operation on the scripted stand-in engine: exact SQL shape (bounded, quoted,
// cast to text), identity re-check, and stale-result rejection.
import { afterEach, describe, expect, it } from 'vitest';
import { EngineSession } from '../../../src/core/engine/session';
import { DEFAULT_PROFILE } from '../../../src/core/profile/profile';
import { previewTable } from '../../../src/core/results/preview';
import { createPreviewStore } from '../../../src/stores/previewStore';
import { FakeDriver } from '../engine/fake-driver';

let session: EngineSession;
let driver: FakeDriver;
const target = { relation: 'my "t"', identity: { database: 'memory', schema: 'main', oid: '42' } };

async function setup(opts: { oid?: string; stall?: boolean } = {}) {
  driver = new FakeDriver();
  session = new EngineSession({ driver, bootMs: 5_000, recoveryMs: 5_000, memoryLimit: '1GB' });
  await session.start();
  driver.current.handler = (sql) => {
    if (sql.includes('FROM duckdb_tables()')) return [[opts.oid ?? '42']];
    if (sql.includes('FROM duckdb_columns()')) return [['id', 'BIGINT'], ['na"me', 'VARCHAR']];
    if (sql.startsWith('SELECT left(')) return opts.stall ? 'stall' : [['9007199254740993', ''], ['1', null], ['2', 'x'.repeat(501)]];
    return undefined;
  };
}
afterEach(() => session?.dispose());

describe('previewTable', () => {
  it('reads at most rows + 1, every value cast to text and cut by the engine, identifiers quoted', async () => {
    await setup();
    const r = await previewTable(session, target, DEFAULT_PROFILE).result;
    expect(r.terminal.status).toBe('ok');
    const read = driver.current.calls.find((c) => c.startsWith('SELECT left('));
    expect(read).toBe(`SELECT left(CAST("id" AS VARCHAR), 501), left(CAST("na""me" AS VARCHAR), 501) FROM "memory"."main"."my ""t""" LIMIT 101`);
    expect(r.value?.rows).toEqual([
      [{ kind: 'text', text: '9007199254740993', truncated: false }, { kind: 'text', text: '', truncated: false }],
      [{ kind: 'text', text: '1', truncated: false }, { kind: 'null' }],
      [{ kind: 'text', text: '2', truncated: false }, { kind: 'text', text: 'x'.repeat(500), truncated: true }],
    ]);
    expect(r.value?.truncation).toEqual({ rows: false, columns: null, cells: 1, display: false, bytes: false });
  });

  it('Codex reproduction: with a 32-byte budget nothing is read and the preview is refused with the reason', async () => {
    await setup();
    const r = await previewTable(session, target, { ...DEFAULT_PROFILE, results: { ...DEFAULT_PROFILE.results, maxArrowBytes: 32 } }).result;
    expect(r.terminal).toMatchObject({ status: 'refused', reason: expect.stringMatching(/byte budget \(32 bytes\) is too small/) });
    expect(driver.current.calls.some((c) => c.startsWith('SELECT left('))).toBe(false);
  });

  it('refuses when the table is no longer the one that was selected (removed or replaced)', async () => {
    await setup({ oid: '99' });
    const r = await previewTable(session, target, DEFAULT_PROFILE).result;
    expect(r.terminal).toMatchObject({ status: 'refused', reason: expect.stringMatching(/no longer the table/) });
    expect(driver.current.calls.some((c) => c.startsWith('SELECT left('))).toBe(false);
  });

  it('a result from before a data change or engine restart is never delivered', async () => {
    await setup({ stall: true });
    const h = previewTable(session, target, DEFAULT_PROFILE);
    await new Promise((res) => setTimeout(res, 10));
    session.markDataChanged();
    driver.current.pending[0]?.resolve([['1', 'a']]);
    expect((await h.result).terminal).toMatchObject({ status: 'refused', reason: expect.stringMatching(/data changed/) });
    const h2 = previewTable(session, target, DEFAULT_PROFILE);
    await new Promise((res) => setTimeout(res, 10));
    await session.restart('test');
    expect((await h2.result).terminal.status).toBe('stale');
  });
});

describe('preview store', () => {
  it('starts only on request; a shown preview turns stale on a data change and never shows rows again', async () => {
    await setup();
    const p = createPreviewStore(session, DEFAULT_PROFILE);
    expect(p.getSnapshot()).toEqual({ status: 'idle' });
    expect(driver.current.calls.some((c) => c.startsWith('SELECT left('))).toBe(false);
    p.start(target);
    expect(p.getSnapshot().status).toBe('running');
    await new Promise((res) => setTimeout(res, 20));
    expect(p.getSnapshot().status).toBe('done');
    session.markDataChanged();
    expect(p.getSnapshot()).toMatchObject({ status: 'stale', message: expect.stringMatching(/may have changed/) });
    p.clear();
    expect(p.getSnapshot()).toEqual({ status: 'idle' });
    p.dispose();
  });

  it('cancel stops a running preview', async () => {
    await setup({ stall: true });
    const p = createPreviewStore(session, DEFAULT_PROFILE);
    p.start(target);
    await new Promise((res) => setTimeout(res, 10));
    p.cancel();
    await new Promise((res) => setTimeout(res, 20));
    expect(p.getSnapshot()).toMatchObject({ status: 'cancelled', message: 'Preview cancelled.' });
  });
});
