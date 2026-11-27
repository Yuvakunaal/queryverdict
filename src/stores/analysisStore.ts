// Analyze state (M09; UI_SPECIFICATION §4–§6; ARCHITECTURE §14–§16). Tracks only the OPERATION of
// the latest Analyze request: queued, analyzing, cancelling, settled. The report itself is never
// held here: the Verdict service publishes it through its fence to the report store, which stays
// the single source of truth for evidence and its currency.
//
// One analysis at a time from the workspace: a new Analyze cancels the previous one, and only the
// latest request may publish. Repeating Analyze while the same query with the same declarations
// is still queued or running is ignored (PRD §5: no duplicate requests from repeated activation). Each request gets its own sink that forwards to the report store
// only while the request is still the latest, in the fence's synchronous hand-off, so a superseded
// analysis can never publish over a newer one (whatever order the session settles them in).
// Every analysis is one `verdict` operation on the shared session queue; nothing else is queued.
import type { EngineSession } from '../core/engine/session';
import type { OperationId, Terminal } from '../core/engine/types';
import { declarationKey } from '../core/verdict/report';
import type { ReportSink } from '../core/verdict/service';
import type { VerdictReport, VerdictService } from '../core/verdict/types';
import type { Announcer } from './announcer';
import type { ReportView } from './reportStore';
import { createStore, type Store } from './createStore';

type Base = { readonly seq: number; readonly sql: string; readonly expectations: number };
export type AnalysisState =
  | { readonly status: 'idle' }
  | (Base & { readonly status: 'queued' })
  | (Base & { readonly status: 'analyzing' })
  | (Base & { readonly status: 'cancelling' })
  | (Base & { readonly status: 'settled'; readonly terminal: Terminal; readonly reportId: string | null });

export interface AnalysisStore extends Store<AnalysisState> {
  /** Analyzes `sql` with the declared expectations (in order). */
  analyze(sql: string, expectations: readonly unknown[]): void;
  cancel(): void;
  dispose(): void;
}

export const isAnalysisActive = (s: AnalysisState) => s.status === 'queued' || s.status === 'analyzing' || s.status === 'cancelling';

/**
 * One sentence for the status region when an analysis settles (announced once). It follows the
 * report store's view (Codex M09): a report that is already historical at publication is
 * announced as historical, and only a current, authoritative report announces violations or
 * warnings as results.
 */
export function settledAnnouncement(report: VerdictReport | null, view?: ReportView): string {
  if (!report) return 'Analysis finished without a report.';
  const shown = view?.report?.id === report.id ? view : undefined;
  if (shown && !shown.current) return `Analysis finished, but its report is already historical (${shown.historicalReason ?? 'the workspace changed'}). Analyze again for current evidence.`;
  if (!shown) return 'Analysis finished; its report is not the one shown.';
  if (!report.authoritative && (report.status === 'analyzed' || report.status === 'partially-analyzed')) {
    return 'Verdict finished with limited evidence: the report is not authoritative. See the Verdict tab.';
  }
  const violated = report.expectations.filter((o) => o.outcome === 'violated').length;
  const suspicious = report.findings.filter((f) => f.category === 'suspicious').length;
  switch (report.status) {
    case 'analyzed':
    case 'partially-analyzed': {
      const parts = [
        violated ? `${violated} ${violated === 1 ? 'expectation' : 'expectations'} violated` : '',
        suspicious ? `${suspicious} ${suspicious === 1 ? 'warning' : 'warnings'}` : '',
      ].filter(Boolean);
      return `Verdict ready${parts.length ? ': ' + parts.join(', ') : ''}.`;
    }
    case 'unsupported':
      return 'Verdict unavailable for this query: it is outside the supported scope.';
    case 'query-failed':
      return 'Verdict could not analyze the query: it does not parse or bind.';
    case 'inconclusive':
    case 'budget-exhausted':
      return 'Analysis incomplete. See the Verdict tab for the reason.';
    case 'diagnostic-failed':
      return 'A diagnostic step failed. See the Verdict tab.';
    case 'cancelled':
      return 'Analysis cancelled.';
    case 'stale':
      return 'Analysis stale: the engine or the data changed while it ran.';
  }
}

export function createAnalysisStore(deps: {
  session: EngineSession;
  /** Creates a service publishing to `sink` (the session, profile and registry are bound by the caller). */
  service(sink: ReportSink): VerdictService;
  /** The report store: receives the published report and gives its currency for announcements. */
  reports: ReportSink & { getSnapshot(): ReportView };
  announcer: Announcer;
  /** The sentence announced when an analysis settles (the Verdict answer headline, P-106); defaults to settledAnnouncement. */
  describe?(report: VerdictReport, view: ReportView): string;
}): AnalysisStore {
  const store = createStore<AnalysisState>({ status: 'idle' });
  let seq = 0;
  let handle: { id: OperationId; cancel(): void } | null = null;
  let activeKey = '';

  const off = deps.session.subscribe((e) => {
    const s = store.getSnapshot();
    if (e.type === 'operation' && handle && e.id === handle.id && e.phase === 'active' && s.status === 'queued') store.set({ ...s, status: 'analyzing' });
  });

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    analyze(sql, expectations) {
      const key = declarationKey(expectations);
      const cur = store.getSnapshot();
      if (handle && (cur.status === 'queued' || cur.status === 'analyzing') && cur.sql === sql && activeKey === key) {
        deps.announcer.announce('Already analyzing this query.');
        return;
      }
      handle?.cancel(); // a newer Analyze supersedes the previous one
      activeKey = key;
      const mine = ++seq;
      const base = { seq: mine, sql, expectations: expectations.length };
      // Only the latest request reaches the report store, inside the fence's synchronous hand-off.
      const sink: ReportSink = { publish: (r) => (mine === seq ? deps.reports.publish(r) : undefined) };
      store.set({ ...base, status: 'queued' });
      const h = deps.service(sink).analyze(sql, expectations);
      handle = h;
      if (h.generation !== null) store.set({ ...base, status: 'analyzing' });
      void h.result.then((r) => {
        if (mine !== seq) return;
        handle = null;
        store.set({ ...base, status: 'settled', terminal: r.terminal, reportId: r.value?.id ?? null });
        const view = deps.reports.getSnapshot();
        deps.announcer.announce(r.value && deps.describe ? deps.describe(r.value, view) : settledAnnouncement(r.value ?? null, view));
      });
    },
    cancel() {
      const s = store.getSnapshot();
      if (!handle || (s.status !== 'queued' && s.status !== 'analyzing')) return;
      store.set({ ...s, status: 'cancelling' });
      handle.cancel();
    },
    dispose: off,
  };
}
