// Relation eligibility for Verdict (P-038; ARCHITECTURE §13 binding checks), decided inside the
// analysis transaction from the live catalog. Frontend metadata (the dataset registry) is used
// only to label the origin of an eligible table; it never makes a relation eligible.
//
// A name must resolve, case-insensitively and across every attached database and schema
// (including internal objects), to exactly one catalog object, which must be a table without
// generated columns, either temporary or in the current database and schema. Views, ambiguous
// names, tables elsewhere and replacement scans are refused.
import { FREE } from './budget';
import { ProbeRunner, quoteIdent, sqlText } from './probes';
import type { TableRefIR } from './recognise';
import type { DatasetIdentity } from './types';

export interface ResolvedRelation {
  readonly ref: TableRefIR;
  readonly identity: DatasetIdentity;
  /** `"db"."schema"."table"` for diagnostic statements. */
  readonly qualified: string;
}

export type RelationOutcome = { readonly ok: true; readonly relation: ResolvedRelation } | { readonly ok: false; readonly reason: string };

export type OriginLookup = (identity: { database: string; schema: string; oid: string }) => DatasetIdentity['origin'];

export async function resolveRelation(run: ProbeRunner, ref: TableRefIR, current: { database: string; schema: string }, origin: OriginLookup): Promise<RelationOutcome> {
  const rows = await run.query('relations', FREE,
    `SELECT 'table', database_name::VARCHAR, schema_name::VARCHAR, table_name::VARCHAR, table_oid::VARCHAR, temporary::VARCHAR, (coalesce(sql, '') ILIKE '%GENERATED%')::VARCHAR FROM duckdb_tables() WHERE lower(table_name) = lower(${sqlText(ref.name)})
UNION ALL SELECT 'view', database_name::VARCHAR, schema_name::VARCHAR, view_name::VARCHAR, view_oid::VARCHAR, temporary::VARCHAR, 'false' FROM duckdb_views() WHERE lower(view_name) = lower(${sqlText(ref.name)})`,
    { columns: 7, maxRows: 64 });
  if (rows.length === 0) return { ok: false, reason: `${ref.name} is not a table in the catalog (a file reference, replacement scan or missing table); only stable managed tables are analysed` };
  if (rows.length > 1) return { ok: false, reason: `the name ${ref.name} matches ${rows.length} catalog objects (${rows.map((r) => `${r[0]} ${r[1]}.${r[2]}`).join(', ')}), so which one the query reads is ambiguous` };
  const [kind, database, schema, table, oid, temporary, generated] = rows[0] as (string | null)[];
  if (!database || !schema || !table || !oid) return { ok: false, reason: `incomplete catalog entry for ${ref.name}` };
  if (kind === 'view') return { ok: false, reason: `${ref.name} is a view; views may be volatile or read files, so they are not stable relations for Verdict` };
  const isTemp = temporary === 'true';
  if (!isTemp && (database !== current.database || schema !== current.schema)) return { ok: false, reason: `${ref.name} is in ${database}.${schema}, outside the current schema ${current.database}.${current.schema}` };
  if (generated === 'true') return { ok: false, reason: `${ref.name} has generated columns, which may be volatile` };
  return {
    ok: true,
    relation: {
      ref,
      identity: { relation: table, database, schema, oid, temporary: isTemp, origin: origin({ database, schema, oid }) },
      qualified: `${quoteIdent(database)}.${quoteIdent(schema)}.${quoteIdent(table)}`,
    },
  };
}

/** Column names and DuckDB types of a resolved table, in table order. */
export async function columnsOf(run: ProbeRunner, r: ResolvedRelation): Promise<Map<string, { name: string; type: string }>> {
  const rows = await run.query('columns', FREE,
    `SELECT column_name::VARCHAR, data_type::VARCHAR FROM duckdb_columns() WHERE table_oid = ${sqlText(r.identity.oid)}::BIGINT ORDER BY column_index`,
    { columns: 2, maxRows: 10_000 });
  const m = new Map<string, { name: string; type: string }>();
  for (const [name, type] of rows) if (name && type) m.set(name.toLowerCase(), { name, type });
  return m;
}
