// Pure explorer helpers (M04): labels for every registry state and origin (AM-007), exact count
// and size formatting, and the per-file review shown before an import. The review only previews
// what the M03 importer will decide (admission, default names); the importer re-checks everything
// against the live catalog and its outcome is what the UI reports.
import { admit } from '../../core/datasets/admission';
import { invalidRequestedName, normaliseName, quoteIdent, resolveName } from '../../core/datasets/naming';
import type { DatasetEntry, DatasetFormat, DatasetOrigin, DatasetState, ImportStage } from '../../core/datasets/types';
import type { ReleaseProfile } from '../../core/profile/profile';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'violation';

export const STATE: Record<DatasetState, { readonly label: string; readonly tone: Tone; readonly description: string }> = {
  ready: { label: 'Ready', tone: 'success', description: 'The table is in this session and can be queried.' },
  importing: { label: 'Importing', tone: 'info', description: 'The file is being imported.' },
  'needs-reimport': { label: 'Needs re-import', tone: 'warning', description: 'The engine restarted and its in-memory tables were lost. Re-import the file to use this table again.' },
  missing: { label: 'Removed by SQL', tone: 'neutral', description: 'The imported table was dropped or renamed by SQL. It is no longer available.' },
  changed: { label: 'Changed', tone: 'warning', description: 'A different table with the same name replaced the imported one (changed by SQL).' },
  failed: { label: 'Failed', tone: 'violation', description: 'The last re-import did not complete.' },
};

export const ORIGIN: Record<DatasetOrigin, string> = { imported: 'Imported', sql: 'Created by SQL', demo: 'Demo' };

/** Whether the table exists in the engine now (only these can be previewed or queried). */
export const isPresent = (e: Pick<DatasetEntry, 'state'>) => e.state === 'ready' || e.state === 'changed';

/** Stable key for selection: origin, place and name (names can repeat across origins and schemas). */
export const entryKey = (e: Pick<DatasetEntry, 'origin' | 'relation' | 'identity'>) => `${e.origin}|${e.identity?.database ?? ''}|${e.identity?.schema ?? ''}|${e.relation}`;

/** Inserts thousands separators into an exact decimal string (never through Number). */
export function groupDigits(exact: string): string {
  if (!/^-?\d+$/.test(exact)) return exact;
  const neg = exact.startsWith('-');
  const digits = neg ? exact.slice(1) : exact;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${grouped}` : grouped;
}

export const rowCountText = (exact: string) => `${groupDigits(exact)} ${exact === '1' ? 'row' : 'rows'}`;

export function formatBytes(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * The engine-safe SQL identifier copied by "Copy table name": the quoted name, or the fully
 * qualified `"database"."schema"."name"` when the name alone does not identify the table.
 */
export function copyText(relation: string, location?: { readonly database: string; readonly schema: string }): string {
  return location ? `${quoteIdent(location.database)}.${quoteIdent(location.schema)}.${quoteIdent(relation)}` : quoteIdent(relation);
}

/** Whether a name is shared by more than one listed relation (then it is shown and copied qualified). */
export function isAmbiguous(entry: Pick<DatasetEntry, 'relation'>, entries: readonly Pick<DatasetEntry, 'relation'>[]): boolean {
  const key = entry.relation.toLowerCase();
  return entries.filter((e) => e.relation.toLowerCase() === key).length > 1;
}

export const STAGE: Record<ImportStage, string> = {
  queued: 'Queued', checking: 'Checking', reading: 'Reading the file', committing: 'Saving the table', done: 'Imported', failed: 'Failed', cancelled: 'Cancelled',
};

/** Bytes the registry counts against the combined import limit (same rule as the M03 registry). */
export function importedBytes(entries: readonly DatasetEntry[]): number {
  return entries.filter((e) => e.origin === 'imported' && (e.state === 'ready' || e.state === 'missing' || e.state === 'changed')).reduce((s, e) => s + (e.source?.bytes ?? 0), 0);
}

export interface FileReview {
  readonly fileName: string;
  readonly bytes: number;
  readonly format: DatasetFormat | null;
  /** Why the file will not be imported (admission), or null. */
  readonly refusal: string | null;
  /** Default name the importer is expected to use (it re-resolves against the live catalog). */
  readonly proposed: string;
  /** The user's name, when it differs from the proposal (sent to the importer, never changed silently). */
  readonly requested: string | null;
  readonly nameError: string | null;
  readonly importable: boolean;
}

/**
 * Reviews a selection before import: admission per file (sizes are the files' actual bytes) and
 * names. Defaults are resolved against every existing table and view name and the names earlier
 * files in the batch will take; an edited name must be valid and free, or the file cannot be
 * imported until it is corrected.
 */
export function reviewFiles(
  files: readonly { readonly name: string; readonly size: number }[],
  edits: readonly (string | undefined)[],
  taken: ReadonlySet<string>,
  limits: ReleaseProfile['imports'],
  alreadyImported: number,
): FileReview[] {
  const admissions = admit(files, limits, alreadyImported);
  const names = new Set([...taken].map((n) => n.toLowerCase()));
  return files.map((f, i) => {
    const a = admissions[i];
    const proposed = resolveName(normaliseName(f.name), names);
    const raw = edits[i];
    const edit = raw?.trim();
    const blank = raw !== undefined && edit === '';
    const requested = edit && edit !== proposed ? edit : null;
    const refusal = a && !a.ok ? a.reason : null;
    const nameError = blank ? 'Enter a table name, or remove this file from the list.' : requested ? invalidRequestedName(requested, new Set(), names) : null;
    const importable = !refusal && !nameError;
    if (importable) names.add((requested ?? proposed).toLowerCase());
    return { fileName: f.name, bytes: f.size, format: a?.ok ? a.format : null, refusal, proposed, requested, nameError, importable };
  });
}

/** Import errors name the engine's internal virtual path; show "the file" instead. */
export const friendlyReason = (reason: string | undefined) => (reason ?? 'The import did not complete.').replace(/(\bfile\s+)?'?\/qv-local\/[0-9a-f-]+\.(csv|parquet)'?/gi, 'the file');
