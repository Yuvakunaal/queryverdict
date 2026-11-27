// Report store (ARCHITECTURE §16; QV-ENG-010). Holds the latest published Verdict report and
// whether it is still CURRENT for the live session: the same engine generation, the same data
// epoch, the same query text (the editor, M09) and the same declared expectations (M09, P-100).
// Anything else makes it historical; a historical report never presents a current violation.
// Recomputed on every session change and every editor or declaration change.
import type { EngineSession } from '../core/engine/session';
import { createStore, type Store } from '../core/util/store';
import { currency } from '../core/verdict/report';
import type { ReportSink } from '../core/verdict/service';
import type { VerdictReport } from '../core/verdict/types';

export interface ReportView {
  readonly report: VerdictReport | null;
  readonly current: boolean;
  /**
   * Why the report is historical: engine restarted, data may have changed, query changed,
   * expectations changed, session ended, or analysis never reached the engine.
   */
  readonly historicalReason?: string;
}

export interface ReportStore extends Store<ReportView>, ReportSink {
  /** The live query's hash; undefined means "not compared". */
  setQueryHash(hash: string | undefined): void;
  /** The live editor text (compared exactly with the analysed text); undefined means "not compared". */
  setQueryText(sql: string | undefined): void;
  /** The live declared expectations, in order; undefined means "not compared". */
  setExpectations(declared: readonly unknown[] | undefined): void;
  dispose(): void;
}

export function createReportStore(session: EngineSession): ReportStore {
  const store = createStore<ReportView>({ report: null, current: false });
  let queryHash: string | undefined;
  let sqlText: string | undefined;
  let expectations: readonly unknown[] | undefined;
  const live = () => ({
    generation: session.generation,
    epoch: session.epoch,
    state: session.state,
    ...(queryHash !== undefined ? { queryHash } : {}),
    ...(sqlText !== undefined ? { sqlText } : {}),
    ...(expectations !== undefined ? { expectations } : {}),
  });
  const recompute = () => {
    const report = store.getSnapshot().report;
    if (!report) return;
    const c = currency(report, live());
    const prev = store.getSnapshot();
    if (prev.current === c.current && prev.historicalReason === c.reason) return;
    store.set({ report, current: c.current, ...(c.reason ? { historicalReason: c.reason } : {}) });
  };
  const off = session.subscribe((e) => {
    if (e.type === 'epoch' || e.type === 'state' || e.type === 'ready') recompute();
  });
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    publish(report) {
      const c = currency(report, live());
      store.set({ report, current: c.current, ...(c.reason ? { historicalReason: c.reason } : {}) });
    },
    setQueryHash(hash) {
      queryHash = hash;
      recompute();
    },
    setQueryText(sql) {
      sqlText = sql;
      recompute();
    },
    setExpectations(declared) {
      expectations = declared === undefined ? undefined : [...declared];
      recompute();
    },
    dispose: off,
  };
}
