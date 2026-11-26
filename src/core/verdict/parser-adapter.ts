// Versioned adapter for DuckDB's own parser (`json_serialize_sql` / `json_deserialize_sql`;
// ARCHITECTURE §13, P-027). The JSON format is internal to DuckDB, so the adapter declares the
// engine versions its recogniser was qualified against and refuses every other version. Parser
// output is read with the lossless JSON layer (numbers keep their exact text) and diagnostic SQL
// is rendered back by the engine, which quotes identifiers itself.
import { sqlString } from '../engine/lockdown';
import { cloneLossless, isJsonObject, parseLossless, stringifyLossless, type JsonObject, type JsonValue } from '../util/lossless-json';

/** DuckDB versions whose parser JSON was recorded and qualified (tests/fixtures/verdict/parser). */
export const QUALIFIED_ENGINE_VERSIONS: readonly string[] = ['v1.5.4'];

export function parserQualified(duckdbVersion: string | null | undefined): string | null {
  return duckdbVersion && QUALIFIED_ENGINE_VERSIONS.includes(duckdbVersion)
    ? null
    : `the SQL parser is not qualified for this engine version (${duckdbVersion ?? 'unknown'}; qualified: ${QUALIFIED_ENGINE_VERSIONS.join(', ')})`;
}

/** Runs one free (catalog-like) statement and returns its single text cell. */
export type ScalarRunner = (sql: string) => Promise<string | null>;

export type ParseOutcome =
  | { readonly ok: true; readonly doc: JsonObject }
  | { readonly ok: false; readonly kind: 'not-select' | 'syntax' | 'malformed'; readonly message: string };

export async function parseSql(scalar: ScalarRunner, sqlText: string): Promise<ParseOutcome> {
  const raw = await scalar(`SELECT json_serialize_sql(${sqlString(sqlText)})::VARCHAR`);
  if (raw === null) return { ok: false, kind: 'malformed', message: 'the parser returned nothing' };
  let doc: JsonValue;
  try {
    doc = parseLossless(raw);
  } catch (e) {
    return { ok: false, kind: 'malformed', message: `the parser output is not valid JSON (${(e as Error).message})` };
  }
  if (!isJsonObject(doc)) return { ok: false, kind: 'malformed', message: 'the parser output is not an object' };
  if (doc.error === true) {
    const message = typeof doc.error_message === 'string' ? doc.error_message : 'unknown parser error';
    return { ok: false, kind: /only select statements/i.test(message) ? 'not-select' : doc.error_type === 'parser' ? 'syntax' : 'malformed', message };
  }
  return { ok: true, doc };
}

/** Wraps one SELECT node as a statement document (the shape json_deserialize_sql accepts). */
export function statementDoc(node: JsonObject): JsonObject {
  const doc = Object.create(null) as JsonObject;
  const stmt = Object.create(null) as JsonObject;
  stmt.node = node;
  stmt.named_param_map = [];
  doc.error = false;
  doc.statements = [stmt];
  return doc;
}

/** Renders a statement document back to SQL text through the engine. */
export async function renderSql(scalar: ScalarRunner, doc: JsonObject): Promise<string> {
  const text = await scalar(`SELECT json_deserialize_sql(${sqlString(stringifyLossless(doc))})::VARCHAR`);
  if (!text || !/^SELECT\b/i.test(text)) throw new Error('json_deserialize_sql did not return a SELECT statement');
  return text;
}

/**
 * The SELECT node of `SELECT count(*) FROM <from>`, built from an engine-serialised template so its
 * shape is exactly what this engine version produces.
 */
export function countNode(template: JsonObject, from: JsonObject): JsonObject {
  const node = cloneLossless(template);
  node.from_table = cloneLossless(from);
  return node;
}

export const COUNT_TEMPLATE_SQL = 'SELECT count(*) FROM __qv_template';
