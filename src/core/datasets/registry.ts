// Catalog-reconciled dataset registry (docs/ARCHITECTURE.md §10.4, QV-ENG-011). The inventory is
// recomputed from the live engine catalog after every data-epoch change and engine recovery; the
// registry only remembers which tables it imported (and their File, for re-import). Nothing is
// persisted and lost tables are never restored automatically.
import { createStore } from '../util/store';
import type { EngineSession } from '../engine/session';
import type { OperationBounds, OperationHandle, OperationResult } from '../engine/types';
import type { ReleaseProfile } from '../profile/profile';
import { detectFormat } from './admission';
import { FileImporter, type ImportRecorder } from './importer';
import { quoteIdent } from './naming';
import { mergeCatalog } from './reconcile';
import { beginOwnTransaction } from './transaction';
import type { CatalogColumn, CatalogObject, CatalogSnapshot, DatasetEntry, DatasetRegistry, TrackedImport } from './types';

const OBJECTS_SQL = `SELECT 'table'::VARCHAR, database_name::VARCHAR, schema_name::VARCHAR, table_name::VARCHAR, table_oid::VARCHAR, temporary::VARCHAR, (coalesce(sql, '') ILIKE '%GENERATED%')::VARCHAR FROM duckdb_tables() WHERE NOT internal
UNION ALL SELECT 'view', database_name::VARCHAR, schema_name::VARCHAR, view_name::VARCHAR, view_oid::VARCHAR, temporary::VARCHAR, 'false' FROM duckdb_views() WHERE NOT internal`;
const COLUMNS_SQL = `SELECT database_name::VARCHAR, schema_name::VARCHAR, table_name::VARCHAR, column_name::VARCHAR, data_type::VARCHAR, is_nullable::VARCHAR FROM duckdb_columns() WHERE NOT internal ORDER BY database_name, schema_name, table_name, column_index`;
const CURRENT_SQL = 'SELECT current_database()::VARCHAR, current_schema()::VARCHAR';
const MAX_OBJECTS = 10_000;
const MAX_COLUMNS = 100_000;

export interface Datasets {
  readonly importer: FileImporter;
  readonly registry: DatasetRegistry & { dispose(): void };
}

class Registry implements DatasetRegistry, ImportRecorder {
  private readonly store = createStore<readonly DatasetEntry[]>([]);
  private readonly tracked = new Map<string, TrackedImport>();
  private catalog: CatalogSnapshot | null = null;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private readonly off: () => void;
  importer!: FileImporter;

  constructor(
    private readonly session: EngineSession,
    private readonly profile: ReleaseProfile,
  ) {
    this.off = session.subscribe((e) => {
      if (e.type === 'epoch' || e.type === 'ready') void this.reconcile();
      if (e.type === 'state' && (e.state.kind === 'failed' || e.state.kind === 'recovering')) this.publish(null);
    });
  }

  getSnapshot = () => this.store.getSnapshot();
  subscribe = (l: () => void) => this.store.subscribe(l);

  dispose() {
    this.off();
  }

  private bounds(): OperationBounds {
    const b = this.profile.bounds;
    return { queueWaitMs: b.queueWaitMs, runMs: b.queueWaitMs, cancelGraceMs: b.cancelRequestMs, cleanupMs: b.cleanupMs };
  }

  /** Recomputes entries from a catalog snapshot (null: engine unavailable) and the tracked imports. */
  private publish(catalog: CatalogSnapshot | null) {
    this.catalog = catalog;
    this.store.set(mergeCatalog({ catalog, tracked: [...this.tracked.values()], generation: this.session.generation, epoch: this.session.epoch }));
  }

  importedBytes(): number {
    let n = 0;
    for (const t of this.tracked.values()) if (t.generation === this.session.generation && !t.failure) n += t.source.bytes;
    return n;
  }

  /** Records a committed import, then reads the catalog so the returned entry reflects it. */
  async record(t: TrackedImport): Promise<DatasetEntry> {
    this.tracked.set(t.relation.toLowerCase(), t);
    await this.reconcile();
    // If the catalog could not be read (engine replaced meanwhile), report what was imported
    // without claiming eligibility; the next reconcile corrects the inventory.
    return this.getSnapshot().find((e) => e.origin === 'imported' && e.relation === t.relation) ?? {
      relation: t.relation, kind: 'table', origin: 'imported', state: 'ready', source: t.source, identity: t.identity, rowCount: t.rowCount, verdictEligible: false,
    };
  }

  /** One reconcile at a time; requests during a run are coalesced into one follow-up run. */
  reconcile(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    const run = this.readCatalog().finally(() => {
      this.inFlight = null;
      if (this.again) {
        this.again = false;
        void this.reconcile();
      }
    });
    this.inFlight = run;
    return run;
  }

  private async readCatalog(): Promise<void> {
    const kind = this.session.state.kind;
    if (kind === 'failed' || kind === 'disposed') {
      this.publish(null);
      return;
    }
    const epochAtStart = this.session.epoch;
    const h = this.session.submit('catalog', async (l) => {
      const [current] = await l.query(CURRENT_SQL, { columns: 2, maxRows: 1, exactRows: 1 });
      const objects = await l.query(OBJECTS_SQL, { columns: 7, maxRows: MAX_OBJECTS });
      const columns = await l.query(COLUMNS_SQL, { columns: 6, maxRows: MAX_COLUMNS });
      const snapshot: CatalogSnapshot = {
        currentDatabase: current?.[0] ?? '',
        currentSchema: current?.[1] ?? '',
        objects: objects.map((r): CatalogObject => ({ kind: r[0] === 'view' ? 'view' : 'table', database: r[1] ?? '', schema: r[2] ?? '', name: r[3] ?? '', oid: r[4] ?? '', temporary: r[5] === 'true', generated: r[6] === 'true' })),
        columns: columns.map((r): CatalogColumn => ({ database: r[0] ?? '', schema: r[1] ?? '', relation: r[2] ?? '', name: r[3] ?? '', type: r[4] ?? '', nullable: r[5] === 'YES' ? true : r[5] === 'NO' ? false : null })),
      };
      return snapshot;
    }, this.bounds());
    const r = await h.result;
    // A snapshot taken on a replaced engine, or before data changed again, is never published.
    if (r.terminal.status !== 'ok' || !r.value || r.generation !== this.session.generation || this.session.epoch !== epochAtStart) {
      const now = this.session.state.kind as string; // may have changed while the operation ran
      if (now === 'failed' || now === 'disposed') this.publish(null);
      else if (r.terminal.status === 'ok') this.again = true;
      return;
    }
    this.publish(r.value);
  }

  remove(relation: string): OperationHandle<void> {
    const key = relation.toLowerCase();
    const entry = this.getSnapshot().find((e) => e.relation.toLowerCase() === key);
    if (!entry) return settled({ terminal: { status: 'refused', reason: `No dataset named "${relation}".` }, generation: null });
    if (entry.state !== 'ready' && entry.state !== 'changed') {
      // Nothing exists in the engine: forget the record (and its File) only.
      this.tracked.delete(key);
      this.publish(this.catalog);
      return settled({ terminal: { status: 'ok' }, generation: this.session.generation });
    }
    const h = this.session.submit('remove', async (l) => {
      await beginOwnTransaction(l, 'removing a dataset');
      try {
        await l.query(`DROP ${entry.kind === 'view' ? 'VIEW' : 'TABLE'} ${quoteIdent(entry.identity?.database ?? '')}.${quoteIdent(entry.identity?.schema ?? '')}.${quoteIdent(entry.relation)}`, { maxRows: 1 });
        await l.query('COMMIT', { maxRows: 1 });
        l.forgetCleanup('ROLLBACK');
      } finally {
        this.session.markDataChanged();
      }
    }, this.bounds());
    const result = h.result.then((r) => {
      if (r.terminal.status === 'ok' && r.generation === this.session.generation) {
        this.tracked.delete(key);
        this.publish(this.catalog);
      }
      return r;
    });
    return { id: h.id, kind: h.kind, get generation() { return h.generation; }, result, cancel: () => h.cancel() };
  }

  reimport(relation: string): OperationHandle<DatasetEntry> {
    const key = relation.toLowerCase();
    const t = this.tracked.get(key);
    const entry = this.getSnapshot().find((e) => e.relation.toLowerCase() === key);
    if (!t || !entry || entry.origin !== 'imported') return settled({ terminal: { status: 'refused', reason: `"${relation}" was not imported from a file.` }, generation: null });
    if (entry.state === 'ready') return settled({ terminal: { status: 'refused', reason: `"${relation}" is already available.` }, generation: null });
    const format = detectFormat(t.file.name) ?? t.source.format;
    const h = this.importer.run(t.file, format, t.relation);
    const result = h.result.then((r) => {
      if (r.terminal.status !== 'ok') {
        const reason = r.terminal.status === 'error' ? r.terminal.message : r.terminal.status === 'refused' ? r.terminal.reason : `re-import ${r.terminal.status}`;
        // Keep the record (and File) so the user can retry or choose the file again.
        const current = this.tracked.get(key);
        if (current) this.tracked.set(key, { ...current, failure: reason });
        this.publish(this.catalog);
      }
      return r;
    });
    return { id: h.id, kind: h.kind, get generation() { return h.generation; }, result, cancel: () => h.cancel() };
  }
}

function settled<T>(result: OperationResult<T>): OperationHandle<T> {
  return { id: `local-${Math.random().toString(36).slice(2, 10)}` as OperationHandle<T>['id'], kind: 'catalog', generation: null, result: Promise.resolve(result), cancel: () => undefined };
}

/** Creates the importer and registry for one session. */
export function createDatasets(session: EngineSession, profile: ReleaseProfile): Datasets {
  const registry = new Registry(session, profile);
  const importer = new FileImporter(session, profile, registry);
  registry.importer = importer;
  return { importer, registry };
}
