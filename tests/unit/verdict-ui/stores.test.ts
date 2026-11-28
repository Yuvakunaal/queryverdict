// M09 stores: Analyze supersession and publication gating, declared expectations, and the report
// store's currency against the editor text and the declarations (T-ENG-010a; P-100).
import { describe, expect, it } from 'vitest';
import type { EngineSession } from '../../../src/core/engine/session';
import type { OperationHandle, OperationId, OperationResult, SessionEvent } from '../../../src/core/engine/types';
import { currency, declarationKey } from '../../../src/core/verdict/report';
import type { ReportSink } from '../../../src/core/verdict/service';
import type { VerdictReport, VerdictService } from '../../../src/core/verdict/types';
import { createAnalysisStore, settledAnnouncement } from '../../../src/stores/analysisStore';
import { createAnnouncer } from '../../../src/stores/announcer';
import { createExpectationStore } from '../../../src/stores/expectationStore';
import { createReportStore } from '../../../src/stores/reportStore';
import { analyzedDraft, E, G, ILLUSTRATIVE, NO_LEFT_FAN_OUT, report } from './fixtures';

function fakeSession(init: { generation?: number | null; epoch?: number } = {}) {
  const listeners = new Set<(e: SessionEvent) => void>();
  const s = {
    generation: G(init.generation ?? 1) as number | null,
    epoch: E(init.epoch ?? 4) as number,
    state: { kind: 'ready' } as { kind: string },
    subscribe(f: (e: SessionEvent) => void) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    emit(e: SessionEvent) {
      for (const f of listeners) f(e);
    },
  };
  return s;
}

/** A Verdict service whose analyses settle when the test says so. */
function fakeService() {
  const pending: { sql: string; sink: ReportSink; settle(r: VerdictReport): void; cancelled: boolean; id: OperationId }[] = [];
  let n = 0;
  const factory = (sink: ReportSink): VerdictService => ({
    analyze(sql) {
      let resolve!: (r: OperationResult<VerdictReport>) => void;
      const result = new Promise<OperationResult<VerdictReport>>((r) => (resolve = r));
      const entry = {
        sql, sink, cancelled: false, id: `op-${++n}` as OperationId,
        settle(r: VerdictReport) {
          sink.publish(r); // the fence hands off synchronously, before the handle settles
          resolve({ terminal: { status: 'ok' }, value: r, generation: G(1) });
        },
      };
      pending.push(entry);
      const h: OperationHandle<VerdictReport> = { id: entry.id, kind: 'verdict', generation: null, result, cancel: () => (entry.cancelled = true) };
      return h;
    },
  });
  return { pending, factory };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('analysis store', () => {
  it('a newer Analyze supersedes the previous one: the old one is cancelled and can never publish', async () => {
    const session = fakeSession();
    const published: string[] = [];
    const svc = fakeService();
    const store = createAnalysisStore({ session: session as unknown as EngineSession, service: svc.factory, reports: { publish: (r) => published.push(r.identity.sqlText), getSnapshot: () => ({ report: null, current: false }) }, announcer: createAnnouncer() });
    store.analyze('A', []);
    expect(store.getSnapshot()).toMatchObject({ status: 'queued', sql: 'A' });
    store.analyze('B', [NO_LEFT_FAN_OUT]);
    expect(svc.pending[0]!.cancelled).toBe(true);
    const rA = { ...report(analyzedDraft('INNER', ILLUSTRATIVE, [])), identity: { queryHash: 'a', sqlText: 'A', inputs: [] } };
    const rB = { ...report(analyzedDraft('INNER', ILLUSTRATIVE, [])), identity: { queryHash: 'b', sqlText: 'B', inputs: [] } };
    svc.pending[1]!.settle(rB); // the newer one settles first …
    svc.pending[0]!.settle(rA); // … and the superseded one late
    await tick();
    expect(published).toEqual(['B']);
    expect(store.getSnapshot()).toMatchObject({ status: 'settled', sql: 'B', expectations: 1, reportId: rB.id });
  });

  it('repeating Analyze for the same query and declarations while it runs is ignored (no duplicate request)', () => {
    const session = fakeSession();
    const svc = fakeService();
    const announcer = createAnnouncer();
    const store = createAnalysisStore({ session: session as unknown as EngineSession, service: svc.factory, reports: { publish: () => undefined, getSnapshot: () => ({ report: null, current: false }) }, announcer });
    store.analyze('A', [NO_LEFT_FAN_OUT]);
    store.analyze('A', [{ side: 'left', join: 0, kind: 'no-fan-out' }]);
    expect(svc.pending).toHaveLength(1);
    expect(svc.pending[0]!.cancelled).toBe(false);
    expect(announcer.getSnapshot()?.message).toBe('Already analyzing this query.');
    store.analyze('A', []); // different declarations: a new request supersedes
    expect(svc.pending).toHaveLength(2);
    expect(svc.pending[0]!.cancelled).toBe(true);
  });

  it('queued → analyzing from the session’s operation event; cancel → cancelling', () => {
    const session = fakeSession();
    const svc = fakeService();
    const store = createAnalysisStore({ session: session as unknown as EngineSession, service: svc.factory, reports: { publish: () => undefined, getSnapshot: () => ({ report: null, current: false }) }, announcer: createAnnouncer() });
    store.analyze('A', []);
    session.emit({ type: 'operation', id: svc.pending[0]!.id, kind: 'verdict', phase: 'active' });
    expect(store.getSnapshot().status).toBe('analyzing');
    store.cancel();
    expect(store.getSnapshot().status).toBe('cancelling');
    expect(svc.pending[0]!.cancelled).toBe(true);
  });

  it('announces once, following the report store’s currency and the report’s authority (Codex M09)', () => {
    const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT]));
    expect(settledAnnouncement(r, { report: r, current: true })).toBe('Verdict ready: 1 expectation violated, 1 warning.');
    expect(settledAnnouncement(r, { report: r, current: false, historicalReason: 'query changed' })).toBe('Analysis finished, but its report is already historical (query changed). Analyze again for current evidence.');
    const partial = report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT, { kind: 'row-count', min: -1 }]));
    expect(settledAnnouncement(partial, { report: partial, current: true })).toBe('Verdict finished with limited evidence: the report is not authoritative. See the Verdict tab.');
    const c = report(analyzedDraft('INNER', ILLUSTRATIVE, []), { cancelled: true });
    expect(settledAnnouncement(c, { report: c, current: true })).toBe('Analysis cancelled.');
  });

  it('the settle announcement reads the store at settlement: an edit during the final hand-off is announced as historical', async () => {
    const session = fakeSession();
    const svc = fakeService();
    const announcer = createAnnouncer();
    const reports = createReportStore(session as unknown as EngineSession);
    const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT]));
    reports.setQueryText(r.identity.sqlText);
    reports.setExpectations([NO_LEFT_FAN_OUT]);
    const store = createAnalysisStore({ session: session as unknown as EngineSession, service: svc.factory, reports, announcer });
    store.analyze(r.identity.sqlText, [NO_LEFT_FAN_OUT]);
    reports.setQueryText(r.identity.sqlText + ' -- edited'); // edited before the hand-off
    svc.pending[0]!.settle(r);
    await tick();
    expect(reports.getSnapshot()).toMatchObject({ current: false, historicalReason: 'query changed' });
    expect(announcer.getSnapshot()?.message).toMatch(/^Analysis finished, but its report is already historical/);
  });
});

describe('expectation store', () => {
  it('stores only valid declarations, keeps ids and order on update, removes by id', () => {
    const s = createExpectationStore();
    expect(s.add({ kind: 'row-count' } as never)).toEqual({ ok: false, error: 'row-count needs min, max or both' });
    expect(s.getSnapshot()).toEqual([]);
    const a = s.add({ kind: 'no-fan-out', join: 0, side: 'left' });
    const b = s.add({ kind: 'row-count', min: 1 });
    expect(a.ok && b.ok).toBe(true);
    const ids = s.getSnapshot().map((e) => e.id);
    expect(s.update(ids[0]!, { kind: 'no-fan-out', join: 0, side: 'right' })).toEqual({ ok: true });
    expect(s.update(ids[1]!, { kind: 'row-count', min: 5, max: 1 })).toEqual({ ok: false, error: 'min is greater than max' });
    expect(s.getSnapshot().map((e) => [e.id, e.value])).toEqual([[ids[0], { kind: 'no-fan-out', join: 0, side: 'right' }], [ids[1], { kind: 'row-count', min: 1 }]]);
    s.remove(ids[0]!);
    expect(s.values()).toEqual([{ kind: 'row-count', min: 1 }]);
  });
});

describe('report currency (T-ENG-010a; P-100)', () => {
  const r = report(analyzedDraft('INNER', ILLUSTRATIVE, [NO_LEFT_FAN_OUT]));
  const live = { generation: G(1), epoch: E(4), state: { kind: 'ready' as const } };
  it('compares the editor text exactly and the declarations structurally', () => {
    expect(currency(r, { ...live, sqlText: r.identity.sqlText, expectations: [{ side: 'left', join: 0, kind: 'no-fan-out' }] })).toEqual({ current: true });
    expect(currency(r, { ...live, sqlText: r.identity.sqlText + ' ' }).reason).toBe('query changed');
    expect(currency(r, { ...live, expectations: [] }).reason).toBe('expectations changed');
    expect(currency(r, { ...live, expectations: [{ kind: 'no-fan-out', join: 0, side: 'right' }] }).reason).toBe('expectations changed');
    expect(declarationKey([{ b: 1, a: 2 }])).toBe(declarationKey([{ a: 2, b: 1 }]));
  });
  it('a report that never reached the engine carries no snapshot: only its query and declarations decide currency (M10)', () => {
    const queued = { ...r, stamp: { ...r.stamp, generation: null }, join: null };
    expect(currency(queued, { ...live, generation: G(7), epoch: E(9) })).toEqual({ current: true });
    expect(currency(queued, { ...live, sqlText: 'other' }).reason).toBe('query changed');
  });

  it('report store: editor edits, declaration edits, epoch and generation changes make the report historical; returning to the same text after a data change does not make it current', () => {
    const session = fakeSession();
    const store = createReportStore(session as unknown as EngineSession);
    store.setQueryText(r.identity.sqlText);
    store.setExpectations([NO_LEFT_FAN_OUT]);
    store.publish(r);
    expect(store.getSnapshot()).toMatchObject({ current: true });
    store.setQueryText('SELECT 1');
    expect(store.getSnapshot()).toMatchObject({ current: false, historicalReason: 'query changed' });
    store.setQueryText(r.identity.sqlText);
    expect(store.getSnapshot().current).toBe(true);
    store.setExpectations([]);
    expect(store.getSnapshot()).toMatchObject({ current: false, historicalReason: 'expectations changed' });
    store.setExpectations([NO_LEFT_FAN_OUT]);
    expect(store.getSnapshot().current).toBe(true);
    session.epoch = E(5);
    session.emit({ type: 'epoch', epoch: E(5) });
    expect(store.getSnapshot()).toMatchObject({ current: false, historicalReason: 'data may have changed' });
    store.setQueryText('x');
    store.setQueryText(r.identity.sqlText);
    expect(store.getSnapshot()).toMatchObject({ current: false, historicalReason: 'data may have changed' });
    session.generation = G(2);
    session.emit({ type: 'state', state: { kind: 'ready' } });
    expect(store.getSnapshot()).toMatchObject({ current: false, historicalReason: 'engine restarted' });
  });
});
