// Pure catalog reconciliation (docs/ARCHITECTURE.md §10.4, QV-ENG-011). The dataset inventory is
// DERIVED from the engine catalog plus what the registry remembers about imports; frontend state
// is never authoritative. Unit-tested without an engine.
import type { DataEpoch, Generation } from '../engine/types';
import type { CatalogObject, CatalogSnapshot, ColumnInfo, DatasetEntry, TrackedImport } from './types';

/** Analyser scratch tables (M08) are never shown as datasets. */
const INTERNAL_PREFIX = '__qv_';

const lower = (s: string) => s.toLowerCase();

function eligibility(obj: CatalogObject, catalog: CatalogSnapshot, sameName: number): { eligible: boolean; reason?: string } {
  if (obj.kind === 'view') return { eligible: false, reason: 'Views are not stable relations; Verdict needs a table (P-038).' };
  if (sameName > 1) return { eligible: false, reason: 'Another table or view has the same name; the reference is ambiguous.' };
  if (!obj.temporary && (obj.database !== catalog.currentDatabase || obj.schema !== catalog.currentSchema)) {
    return { eligible: false, reason: `The table is in ${obj.database}.${obj.schema}, outside the current schema.` };
  }
  if (obj.generated) return { eligible: false, reason: 'The table has generated columns, which may be volatile.' };
  return { eligible: true };
}

function columnsOf(obj: CatalogObject, catalog: CatalogSnapshot): ColumnInfo[] {
  return catalog.columns
    .filter((c) => c.database === obj.database && c.schema === obj.schema && c.relation === obj.name)
    .map((c) => ({ name: c.name, type: c.type, nullable: c.nullable }));
}

export interface MergeInput {
  /** Null when the engine is not available (failed, recovering, disposed). */
  readonly catalog: CatalogSnapshot | null;
  readonly tracked: readonly TrackedImport[];
  /** Current engine generation (null when no verified engine is running). */
  readonly generation: Generation | null;
  readonly epoch: DataEpoch;
}

export function mergeCatalog({ catalog, tracked, generation, epoch }: MergeInput): DatasetEntry[] {
  const entries: DatasetEntry[] = [];
  const objects = (catalog?.objects ?? []).filter((o) => !lower(o.name).startsWith(INTERNAL_PREFIX));
  const byName = new Map<string, CatalogObject[]>();
  for (const o of objects) byName.set(lower(o.name), [...(byName.get(lower(o.name)) ?? []), o]);
  const claimed = new Set<CatalogObject>();

  for (const t of tracked) {
    const base = { relation: t.relation, origin: 'imported' as const, source: t.source, verdictEligible: false };
    if (generation === null || t.generation !== generation || !catalog) {
      entries.push({ ...base, kind: 'table', state: t.failure ? 'failed' : 'needs-reimport', identity: t.identity, reason: t.failure ?? 'The engine was restarted and its in-memory tables were lost. Re-import the file.', eligibilityReason: 'Not available until re-imported.' });
      continue;
    }
    const match = (byName.get(lower(t.relation)) ?? []).find((o) => o.kind === 'table' && o.database === t.identity.database && o.schema === t.identity.schema);
    if (!match) {
      entries.push({ ...base, kind: 'table', state: t.failure ? 'failed' : 'missing', identity: t.identity, reason: t.failure ?? 'The table was dropped or renamed by SQL.', eligibilityReason: 'Not available.' });
      continue;
    }
    claimed.add(match);
    const e = eligibility(match, catalog, byName.get(lower(match.name))?.length ?? 1);
    const identity = { database: match.database, schema: match.schema, oid: match.oid };
    if (match.oid !== t.identity.oid) {
      entries.push({ ...base, kind: 'table', state: 'changed', identity, columns: columnsOf(match, catalog), reason: 'A different table with the same name replaced the imported one (changed by SQL).', verdictEligible: e.eligible, ...(e.reason ? { eligibilityReason: e.reason } : {}) });
      continue;
    }
    entries.push({
      ...base, kind: 'table', state: 'ready', identity, columns: columnsOf(match, catalog),
      ...(t.rowCountEpoch === epoch ? { rowCount: t.rowCount } : {}),
      verdictEligible: e.eligible, ...(e.reason ? { eligibilityReason: e.reason } : {}),
    });
  }

  if (catalog) {
    for (const o of objects) {
      if (claimed.has(o)) continue;
      const e = eligibility(o, catalog, byName.get(lower(o.name))?.length ?? 1);
      entries.push({
        relation: o.name, kind: o.kind, origin: 'sql', state: 'ready',
        identity: { database: o.database, schema: o.schema, oid: o.oid }, columns: columnsOf(o, catalog),
        verdictEligible: e.eligible, ...(e.reason ? { eligibilityReason: e.reason } : {}),
      });
    }
  }
  const rank = (e: DatasetEntry) => (e.origin === 'imported' ? 0 : 1);
  return entries.sort((a, b) => rank(a) - rank(b) || a.relation.localeCompare(b.relation));
}
