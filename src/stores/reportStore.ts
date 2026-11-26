// Report store (ARCHITECTURE §16; QV-ENG-010). Holds the latest published Verdict report and
// whether it is still CURRENT for the live session: the same engine generation, the same data
// epoch and (once the editor exists) the same query. Anything else makes it historical; a
// historical report never presents a current violation. Recomputed on every session change.
import type { EngineSession } from '../core/engine/session';
import { createStore, type Store } from '../core/util/store';
import { currency } from '../core/verdict/report';
import type { ReportSink } from '../core/verdict/service';
import type { VerdictReport } from '../core/verdict/types';

export interface ReportView {
  readonly report: VerdictReport | null;
  readonly current: boolean;
  /** Why the report is historical (engine restarted, data may have changed, query changed, session ended). */
  readonly historicalReason?: string;
}

export interface ReportStore extends Store<ReportView>, ReportSink {
  /** The live query's hash (set by the editor in a later module); undefined means "not compared". */
  setQueryHash(hash: string | undefined): void;
  dispose(): void;
}

export function createReportStore(session: EngineSession): ReportStore {
  const store = createStore<ReportView>({ report: null, current: false });
  let queryHash: string | undefined;
  const recompute = () => {
    const report = store.getSnapshot().report;
    if (!report) return;
    const c = currency(report, { generation: session.generation, epoch: session.epoch, state: session.state, ...(queryHash !== undefined ? { queryHash } : {}) });
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
      const c = currency(report, { generation: session.generation, epoch: session.epoch, state: session.state, ...(queryHash !== undefined ? { queryHash } : {}) });
      store.set({ report, current: c.current, ...(c.reason ? { historicalReason: c.reason } : {}) });
    },
    setQueryHash(hash) {
      queryHash = hash;
      recompute();
    },
    dispose: off,
  };
}
