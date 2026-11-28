// Dataset contracts (docs/ARCHITECTURE.md §10.4, docs/IMPLEMENTATION_PLAN.md M03).
import type { Store } from '../util/store';
import type { DataEpoch, Generation, OperationHandle } from '../engine/types';

export type DatasetFormat = 'csv' | 'parquet';
export type DatasetOrigin = 'imported' | 'sql' | 'demo';
/**
 * ready: present and unchanged · needs-reimport: lost when the engine was replaced ·
 * missing: dropped or renamed by SQL · changed: same name, different table identity (replaced by
 * SQL) · failed: a re-import failed (see reason) · importing: reserved for progress (M04 UI).
 */
export type DatasetState = 'importing' | 'ready' | 'needs-reimport' | 'missing' | 'changed' | 'failed';

export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean | null;
}

export interface DatasetEntry {
  readonly relation: string;
  readonly kind: 'table' | 'view';
  readonly origin: DatasetOrigin;
  readonly state: DatasetState;
  readonly source?: { readonly fileName: string; readonly bytes: number; readonly format: DatasetFormat };
  readonly identity?: { readonly database: string; readonly schema: string; readonly oid: string };
  /** Exact row count, only when measured and the data epoch has not changed since. */
  readonly rowCount?: string;
  readonly columns?: readonly ColumnInfo[];
  /** Base or temporary table, current schema, unambiguous name, no generated columns (P-038). */
  readonly verdictEligible: boolean;
  readonly eligibilityReason?: string;
  /** Why the entry is missing, changed or failed. */
  readonly reason?: string;
}

export interface ImportRequest {
  readonly file: File;
  readonly requestedName?: string;
}

export type ImportStage = 'queued' | 'checking' | 'reading' | 'committing' | 'done' | 'failed' | 'cancelled';

export interface ImportProgress {
  readonly id: string;
  readonly fileName: string;
  readonly stage: ImportStage;
  readonly relation?: string;
  readonly reason?: string;
}

export interface Importer {
  import(reqs: readonly ImportRequest[]): { handles: readonly OperationHandle<DatasetEntry>[]; progress: Store<readonly ImportProgress[]> };
}

export interface DatasetRegistry extends Store<readonly DatasetEntry[]> {
  /** Re-reads the catalog and publishes entries (only if the engine state did not change meanwhile). */
  reconcile(): Promise<void>;
  /**
   * Removes one dataset. `target` names the exact entry (origin, database, schema, oid); without
   * it the name must be unambiguous. The object's identity is re-checked inside the operation, so
   * a table replaced after selection is refused, never dropped.
   */
  remove(relation: string, target?: { readonly origin: DatasetOrigin; readonly database: string; readonly schema: string; readonly oid: string }): OperationHandle<void>;
  reimport(relation: string): OperationHandle<DatasetEntry>;
  /** Sum of the source file sizes imported on the current engine (what the combined import limit counts). */
  importedBytes(): number;
}

/** Engine catalog as read in one operation (all attached databases and schemas). */
export interface CatalogSnapshot {
  readonly currentDatabase: string;
  readonly currentSchema: string;
  readonly objects: readonly CatalogObject[];
  readonly columns: readonly CatalogColumn[];
}

export interface CatalogObject {
  readonly kind: 'table' | 'view';
  readonly database: string;
  readonly schema: string;
  readonly name: string;
  readonly oid: string;
  readonly temporary: boolean;
  readonly generated: boolean;
}

export interface CatalogColumn {
  readonly database: string;
  readonly schema: string;
  readonly relation: string;
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean | null;
}

/** What the registry remembers about a completed import (the File is kept for re-import only). */
export interface TrackedImport {
  readonly relation: string;
  readonly identity: { readonly database: string; readonly schema: string; readonly oid: string };
  readonly source: { readonly fileName: string; readonly bytes: number; readonly format: DatasetFormat };
  readonly file: File;
  readonly generation: Generation;
  readonly rowCount: string;
  readonly rowCountEpoch: DataEpoch;
  /**
   * The data epoch just before this import's own change (read inside its exclusive lease). The
   * import only creates its new table, so other tables' counts measured at exactly this epoch are
   * still exact afterwards (registry.record carries them forward).
   */
  readonly epochBefore?: DataEpoch;
  /** Set when a re-import failed; cleared by a successful one. */
  readonly failure?: string;
}
