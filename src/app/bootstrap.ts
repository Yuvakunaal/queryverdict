// Creates the page's single engine session, outside React, so StrictMode's double mount can
// never start two engines (docs/ARCHITECTURE.md §6.2; spike lesson, PROGRESS 2026-11-25).
import { createDatasets, type Datasets } from '../core/datasets/registry';
import { DuckDBDriver } from '../core/engine/duckdb-driver';
import type { EngineDriver } from '../core/engine/driver';
import { EngineSession } from '../core/engine/session';
import type { ReleaseProfile } from '../core/profile/profile';
import { createVerdict } from '../core/verdict/service';
import type { VerdictService } from '../core/verdict/types';
import { createEngineStore, statusText, type EngineSnapshot } from '../stores/engineStore';
import { createOperationStore, type OperationEntry } from '../stores/operationStore';
import type { Store } from '../stores/createStore';
import { createReportStore, type ReportStore } from '../stores/reportStore';
import { createAnnouncer, followEngine, type Announcer } from '../stores/announcer';
import { createImportStore, type ImportStore } from '../stores/importStore';
import { createPreviewStore, type PreviewStore } from '../stores/previewStore';
import { createQueryStore, type QueryStore } from '../stores/queryStore';
import { createAnalysisStore, type AnalysisStore } from '../stores/analysisStore';
import { announcementFor } from '../features/verdict/answer';
import { createExpectationStore, type ExpectationStore } from '../stores/expectationStore';

export interface EngineRuntime {
  readonly session: EngineSession;
  readonly engine: Store<EngineSnapshot>;
  readonly operations: Store<readonly OperationEntry[]>;
  /** File importer and catalog-reconciled dataset registry (M03; UI in M04). */
  readonly datasets: Datasets;
  /** Headless Verdict analysis (M08) and its published reports (UI in M09). */
  readonly verdict: VerdictService;
  readonly reports: ReportStore;
  /** Explorer (M04): import batches over the importer, the inspector's bounded preview, and status announcements. */
  readonly imports: ImportStore;
  readonly preview: PreviewStore;
  readonly announcer: Announcer;
  /** Run SQL (M06): the latest query run and its bounded result. */
  readonly queries: QueryStore;
  /** Analyze (M09): the latest analysis operation (its report is in `reports`) and the declared expectations. */
  readonly analyses: AnalysisStore;
  readonly expectations: ExpectationStore;
  readonly profile: ReleaseProfile;
  /** Starts (or retries) the engine; failures are reflected in the engine store, never thrown. */
  start(): void;
}

export function createEngineRuntime(profile: ReleaseProfile, driver: EngineDriver = new DuckDBDriver()): EngineRuntime {
  const session = new EngineSession({ driver, bootMs: profile.bounds.bootMs, recoveryMs: profile.bounds.recoveryMs, memoryLimit: profile.engine.memoryLimit });
  const engine = createEngineStore(session);
  const operations = createOperationStore(session);
  const datasets = createDatasets(session, profile);
  const reports = createReportStore(session);
  // The registry only labels the origin of an input; eligibility is decided from the catalog.
  const origin = (id: { oid: string }) => datasets.registry.getSnapshot().find((e) => e.identity?.oid === id.oid)?.origin ?? 'unknown';
  const verdict = createVerdict({ session, profile, sink: reports, origin });
  const announcer = createAnnouncer(statusText(engine.getSnapshot()));
  followEngine(announcer, engine);
  const imports = createImportStore(datasets.importer, (batch) => {
    const n = (stage: string) => batch.items.filter((i) => i.progress.stage === stage).length;
    const parts = [`${n('done')} imported`, n('failed') ? `${n('failed')} failed` : '', n('cancelled') ? `${n('cancelled')} cancelled` : ''].filter(Boolean);
    announcer.announce(`Import finished: ${parts.join(', ')}.`);
  });
  const preview = createPreviewStore(session, profile);
  const queries = createQueryStore(session, profile, announcer);
  // Analyze from the workspace: the same M08 service on the same session queue, with a sink that
  // lets only the latest request publish (analysisStore.ts).
  const analyses = createAnalysisStore({ session, reports, announcer, describe: announcementFor, service: (sink) => createVerdict({ session, profile, sink, origin }) });
  const expectations = createExpectationStore();
  if (typeof document !== 'undefined') {
    // Timers are throttled in background tabs; apply overdue deadlines when the tab is visible again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') session.reconcile();
    });
  }
  return {
    session,
    engine,
    operations,
    datasets,
    verdict,
    reports,
    imports,
    preview,
    announcer,
    queries,
    analyses,
    expectations,
    profile,
    start() {
      const kind = session.state.kind;
      if (kind === 'idle' || kind === 'failed') session.start().catch(() => undefined);
    },
  };
}
