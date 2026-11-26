// Transactional CSV/Parquet import into DuckDB-managed tables (docs/ARCHITECTURE.md §10.2–§10.3,
// P-046, P-047). One engine operation per file, through the session queue and lease (M02):
//   checking  → admission already passed; file readable; name resolved against the live catalog
//   reading   → file registered under /qv-local/ (session drops it if the operation ends early),
//               own transaction (refused, untouched, when a user transaction is open), CREATE TABLE … AS SELECT * FROM read_*
//   committing→ COMMIT; the deferred ROLLBACK is forgotten; the file is unregistered
// Any failure or cancellation before COMMIT leaves no table (ROLLBACK) and no registered file.
// File names never reach SQL: the virtual path is a random id and the relation name is quoted.
import { ImportError, RefusedError } from '../util/errors';
import { beginOwnTransaction } from './transaction';
import { createStore, type Store } from '../util/store';
import type { EngineSession } from '../engine/session';
import type { DataEpoch, Generation, Lease, OperationBounds, OperationHandle, OperationResult } from '../engine/types';
import { LOCAL_FILE_DIR, sqlString } from '../engine/lockdown';
import type { ReleaseProfile } from '../profile/profile';
import { admit, isReadable } from './admission';
import { invalidRequestedName, normaliseName, quoteIdent, resolveName } from './naming';
import type { DatasetEntry, DatasetFormat, ImportProgress, ImportRequest, Importer, TrackedImport } from './types';

/**
 * CSV options (P-047, evidence in DECISIONS): explicit comma dialect with a header and no
 * auto-detected skipped rows (the sniffer otherwise skipped "inconsistent" leading rows and
 * silently misparsed a ragged file); strict parsing (malformed quotes and wrong column counts
 * fail instead of being repaired); "" stays an empty string while an empty field is NULL; and no
 * DOUBLE type candidate, so large integers and decimals are never silently rounded (they stay
 * exact VARCHAR text unless they fit BIGINT).
 */
export const CSV_OPTIONS =
  "header = true, delim = ',', quote = '\"', escape = '\"', skip = 0, allow_quoted_nulls = false, strict_mode = true, " +
  "null_padding = false, ignore_errors = false, auto_type_candidates = ['BOOLEAN', 'BIGINT', 'DATE', 'TIMESTAMP', 'TIME', 'VARCHAR']";

export function readerSql(format: DatasetFormat, path: string): string {
  return format === 'csv' ? `read_csv(${sqlString(path)}, ${CSV_OPTIONS})` : `read_parquet(${sqlString(path)})`;
}

/** What the importer needs from the registry. */
export interface ImportRecorder {
  importedBytes(): number;
  /** Called only for imports whose result is current (same engine generation). */
  record(t: TrackedImport): Promise<DatasetEntry>;
}

interface InternalResult {
  readonly tracked: TrackedImport;
}

const NAMES_SQL = `SELECT lower(name)::VARCHAR FROM (SELECT table_name AS name FROM duckdb_tables() UNION ALL SELECT view_name AS name FROM duckdb_views())`;
const RESERVED_SQL = `SELECT lower(keyword_name)::VARCHAR FROM duckdb_keywords() WHERE keyword_category = 'reserved'`;
const MAX_CATALOG_ROWS = 100_000;

/** A handle that is already settled (admission refusals never reach the engine). */
function settledHandle<T>(result: OperationResult<T>): OperationHandle<T> {
  return { id: `refused-${Math.random().toString(36).slice(2, 10)}` as OperationHandle<T>['id'], kind: 'import', generation: null, result: Promise.resolve(result), cancel: () => undefined };
}

export class FileImporter implements Importer {
  constructor(
    private readonly session: EngineSession,
    private readonly profile: ReleaseProfile,
    private readonly recorder: ImportRecorder,
  ) {}

  private bounds(): OperationBounds {
    const b = this.profile.bounds;
    return { queueWaitMs: b.queueWaitMs, runMs: b.importMs, cancelGraceMs: b.cancelRequestMs, cleanupMs: b.cleanupMs };
  }

  import(reqs: readonly ImportRequest[]): { handles: readonly OperationHandle<DatasetEntry>[]; progress: Store<readonly ImportProgress[]> } {
    const progress = createStore<readonly ImportProgress[]>([]);
    const admissions = admit(reqs.map((r) => ({ name: r.file.name, size: r.file.size })), this.profile.imports, this.recorder.importedBytes());
    const handles = reqs.map((req, i) => {
      const id = `import-${i}`;
      const set = (stage: ImportProgress['stage'], extra: { relation?: string; reason?: string } = {}) =>
        progress.set([...progress.getSnapshot().filter((p) => p.id !== id), { id, fileName: req.file.name, stage, ...extra }].sort((a, b) => a.id.localeCompare(b.id)));
      const admission = admissions[i];
      if (!admission || !admission.ok) {
        const reason = admission && !admission.ok ? admission.reason : 'not admitted';
        set('failed', { reason });
        return settledHandle<DatasetEntry>({ terminal: { status: 'refused', reason }, generation: null });
      }
      set('queued');
      return this.run(req.file, admission.format, req.requestedName, set);
    });
    return { handles, progress };
  }

  /** Imports one file (also used by re-import with the original relation name). */
  run(file: File, format: DatasetFormat, requestedName: string | undefined, set: (stage: ImportProgress['stage'], extra?: { relation?: string; reason?: string }) => void = () => undefined): OperationHandle<DatasetEntry> {
    const inner = this.session.submit('import', (lease) => this.body(lease, file, format, requestedName, set), this.bounds());
    const result = inner.result.then(async (r): Promise<OperationResult<DatasetEntry>> => {
      // Publish only results from the engine that is still current (stale results are dropped).
      if (r.terminal.status === 'ok' && r.value && r.generation !== null && r.generation === this.session.generation) {
        const entry = await this.recorder.record(r.value.tracked);
        set('done', { relation: entry.relation });
        return { terminal: r.terminal, value: entry, generation: r.generation };
      }
      const reason = r.terminal.status === 'error' ? r.terminal.message : r.terminal.status === 'refused' ? r.terminal.reason : r.terminal.status === 'ok' ? 'the engine was replaced before the import was published' : r.terminal.status;
      set(r.terminal.status === 'cancelled' ? 'cancelled' : 'failed', { reason });
      return r.terminal.status === 'ok' ? { terminal: { status: 'stale', reason: 'generation-changed' }, generation: r.generation } : { terminal: r.terminal, generation: r.generation };
    });
    return { id: inner.id, kind: inner.kind, get generation() { return inner.generation; }, result, cancel: () => inner.cancel() };
  }

  private async body(lease: Lease, file: File, format: DatasetFormat, requestedName: string | undefined, set: (stage: ImportProgress['stage'], extra?: { relation?: string; reason?: string }) => void): Promise<InternalResult> {
    set('checking');
    if (!(await isReadable(file))) throw new ImportError('checking', 'The browser can no longer read this file. Choose the file again.');
    const reserved = new Set((await lease.query(RESERVED_SQL, { columns: 1, maxRows: 1_000 })).map((r) => r[0] ?? ''));
    const taken = new Set((await lease.query(NAMES_SQL, { columns: 1, maxRows: MAX_CATALOG_ROWS })).map((r) => r[0] ?? ''));
    let relation: string;
    if (requestedName !== undefined) {
      const problem = invalidRequestedName(requestedName, reserved, taken);
      if (problem) throw new RefusedError(`Cannot use the name "${requestedName}": ${problem}`);
      relation = requestedName;
    } else {
      relation = resolveName(normaliseName(file.name, reserved), taken);
    }
    set('reading', { relation });
    const path = `${LOCAL_FILE_DIR}${crypto.randomUUID()}.${format}`;
    await lease.registerFile(path, file);
    lease.deferDropFile(path);
    // Refuses (without touching it) when a user transaction is open; from here until COMMIT the
    // session owns the ROLLBACK (then drops the file) and replaces the engine if it cannot confirm
    // it, so a failed import never leaves a transaction or table behind.
    await beginOwnTransaction(lease, 'importing');
    try {
      await lease.query(`CREATE TABLE ${quoteIdent(relation)} AS SELECT * FROM ${readerSql(format, path)}`, { maxRows: 10 });
      set('committing', { relation });
      await lease.query('COMMIT', { maxRows: 1 });
      lease.forgetCleanup('ROLLBACK');
    } finally {
      // Data visible to diagnostics may have changed (or a failed import was rolled back).
      this.session.markDataChanged();
    }
    await lease.dropFile(path);
    const [identity] = await lease.query(
      `SELECT database_name::VARCHAR, schema_name::VARCHAR, table_oid::VARCHAR FROM duckdb_tables() WHERE table_name = ${sqlString(relation)} AND database_name = current_database() AND schema_name = current_schema()`,
      { columns: 3, maxRows: 1, exactRows: 1 },
    );
    const [count] = await lease.query(`SELECT count(*)::VARCHAR FROM ${quoteIdent(relation)}`, { columns: 1, maxRows: 1, exactRows: 1 });
    const tracked: TrackedImport = {
      relation,
      identity: { database: identity?.[0] ?? '', schema: identity?.[1] ?? '', oid: identity?.[2] ?? '' },
      source: { fileName: file.name, bytes: file.size, format },
      file,
      generation: lease.generation as Generation,
      rowCount: count?.[0] ?? '0',
      rowCountEpoch: this.session.epoch as DataEpoch,
    };
    return { tracked };
  }
}
