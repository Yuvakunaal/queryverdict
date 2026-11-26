// Strict recogniser for the P0 Verdict boundary (ARCHITECTURE §13, PRD QV-VER-001, P-031).
//
// Accepts exactly: one SELECT whose projection is plain column references and/or `*` without
// modifiers, FROM one INNER or LEFT JOIN between two unqualified base-table references (aliases
// allowed, quoted identifiers allowed), ON an AND of column = column equalities, or USING (…).
// Nothing else: no WHERE, GROUP BY, HAVING, QUALIFY, ORDER BY, LIMIT, DISTINCT, CTEs, subqueries,
// set operations, table functions, samples, time travel, column aliases on tables, qualified names,
// casts or expressions. Every node is checked field by field against an allowlist with expected
// values; an unknown field (for example from another DuckDB version) is unsupported, never ignored.
import { isJsonObject, LosslessNumber, type JsonObject, type JsonValue } from '../util/lossless-json';
import type { JoinType } from './types';

export interface Unsupported {
  readonly construct: string;
  readonly detail: string;
}

export interface TableRefIR {
  /** Table name as written. */
  readonly name: string;
  /** Alias as written ('' when none). */
  readonly alias: string;
  /** How columns refer to it: the alias, else the name. */
  readonly ref: string;
}

export interface ColumnRefIR {
  /** [column] or [relation, column], exact identifier text (quotes already removed by the parser). */
  readonly parts: readonly string[];
}

export interface RecognisedJoin {
  readonly type: JoinType;
  readonly left: TableRefIR;
  readonly right: TableRefIR;
  readonly condition: { readonly kind: 'on'; readonly pairs: readonly (readonly [ColumnRefIR, ColumnRefIR])[] } | { readonly kind: 'using'; readonly columns: readonly string[] };
  /** The query's own JOIN node (lossless JSON), used to build engine-semantics probes. */
  readonly joinNode: JsonObject;
}

export type Recognition = { readonly ok: true; readonly join: RecognisedJoin } | { readonly ok: false; readonly unsupported: readonly Unsupported[] };

/** Prefix reserved for the analyser's own temporary objects and probe aliases. */
export const RESERVED_PREFIX = '__qv_';

type Spec = Record<string, (v: JsonValue) => boolean>;
const isLoc = (v: JsonValue) => v instanceof LosslessNumber && v.toBigInt() !== null;
const isStr = (v: JsonValue) => typeof v === 'string';
const isEmptyStr = (v: JsonValue) => v === '';
const isNull = (v: JsonValue) => v === null;
const isFalse = (v: JsonValue) => v === false;
const isEmptyArr = (v: JsonValue) => Array.isArray(v) && v.length === 0;
const isStrArr = (v: JsonValue) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const any = () => true;

const SELECT_NODE: Spec = {
  type: (v) => v === 'SELECT_NODE', modifiers: isEmptyArr, cte_map: (v) => isJsonObject(v) && Object.keys(v).length === 1 && isEmptyArr(v.map ?? null),
  select_list: any, from_table: any, where_clause: isNull, group_expressions: isEmptyArr, group_sets: isEmptyArr,
  aggregate_handling: (v) => v === 'STANDARD_HANDLING', having: isNull, sample: isNull, qualify: isNull,
};
const COLUMN_REF: Spec = { class: (v) => v === 'COLUMN_REF', type: (v) => v === 'COLUMN_REF', alias: isStr, query_location: isLoc, column_names: (v) => isStrArr(v) && (v as string[]).length >= 1 && (v as string[]).length <= 2 && (v as string[]).every((s) => s.length > 0) };
const STAR: Spec = {
  class: (v) => v === 'STAR', type: (v) => v === 'STAR', alias: isEmptyStr, query_location: isLoc, relation_name: isStr, exclude_list: isEmptyArr,
  replace_list: isEmptyArr, columns: isFalse, expr: isNull, qualified_exclude_list: isEmptyArr, rename_list: isEmptyArr,
};
const JOIN: Spec = {
  type: (v) => v === 'JOIN', alias: isEmptyStr, sample: isNull, query_location: isLoc, left: any, right: any, condition: any,
  join_type: any, ref_type: any, using_columns: isStrArr, delim_flipped: isFalse, duplicate_eliminated_columns: isEmptyArr,
};
const BASE_TABLE: Spec = {
  type: (v) => v === 'BASE_TABLE', alias: isStr, sample: isNull, query_location: isLoc, schema_name: isEmptyStr, table_name: (v) => typeof v === 'string' && v.length > 0,
  column_name_alias: isEmptyArr, catalog_name: isEmptyStr, at_clause: isNull,
};
const COMPARISON: Spec = { class: (v) => v === 'COMPARISON', type: (v) => v === 'COMPARE_EQUAL', alias: isEmptyStr, query_location: isLoc, left: any, right: any };
const CONJUNCTION: Spec = { class: (v) => v === 'CONJUNCTION', type: (v) => v === 'CONJUNCTION_AND', alias: isEmptyStr, query_location: isLoc, children: (v) => Array.isArray(v) && v.length >= 2 };

/** Fields that differ from the spec: unknown, missing, or with an unexpected value. */
function mismatches(o: JsonObject, spec: Spec): string[] {
  const out: string[] = [];
  for (const k of Object.keys(o)) if (!(k in spec)) out.push(`unknown field ${k}`);
  for (const [k, ok] of Object.entries(spec)) {
    if (!(k in o)) out.push(`missing field ${k}`);
    else if (!ok(o[k] as JsonValue)) out.push(`field ${k}`);
  }
  return out;
}

const describeFrom = (t: JsonValue): string => {
  if (!isJsonObject(t)) return 'FROM item';
  if (t.type === 'SUBQUERY') return 'derived table (subquery in FROM)';
  if (t.type === 'TABLE_FUNCTION') return 'table function';
  if (t.type === 'EMPTY') return 'query without FROM';
  if (t.type === 'JOIN') return 'join chain or nested join';
  if (t.type === 'EXPRESSION_LIST') return 'VALUES list';
  return `FROM item ${String(t.type)}`;
};

function describeNode(n: JsonObject): Unsupported[] {
  const out: Unsupported[] = [];
  const no = (construct: string, detail: string) => out.push({ construct, detail });
  if (Array.isArray(n.modifiers) && n.modifiers.length) {
    for (const m of n.modifiers) {
      const t = isJsonObject(m) ? m.type : null;
      no(t === 'DISTINCT_MODIFIER' ? 'DISTINCT' : t === 'ORDER_MODIFIER' ? 'ORDER BY' : t === 'LIMIT_MODIFIER' || t === 'LIMIT_PERCENT_MODIFIER' ? 'LIMIT / OFFSET' : 'result modifier', 'result modifiers are outside the P0 diagnostic scope');
    }
  }
  const cte = isJsonObject(n.cte_map) ? n.cte_map.map : null;
  if (Array.isArray(cte) && cte.length) no('WITH (CTE)', 'CTEs are outside the P0 diagnostic scope');
  if (n.where_clause !== null && n.where_clause !== undefined) no('WHERE', 'filters are outside the P0 diagnostic scope');
  if ((Array.isArray(n.group_expressions) && n.group_expressions.length) || (Array.isArray(n.group_sets) && n.group_sets.length)) no('GROUP BY', 'aggregation is outside the P0 diagnostic scope');
  if (n.aggregate_handling !== undefined && n.aggregate_handling !== 'STANDARD_HANDLING') no('GROUP BY ALL / aggregate handling', 'outside the P0 diagnostic scope');
  if (n.having !== null && n.having !== undefined) no('HAVING', 'outside the P0 diagnostic scope');
  if (n.qualify !== null && n.qualify !== undefined) no('QUALIFY', 'outside the P0 diagnostic scope');
  if (n.sample !== null && n.sample !== undefined) no('USING SAMPLE', 'outside the P0 diagnostic scope');
  return out;
}

function columnRef(e: JsonValue, out: Unsupported[], where: string): ColumnRefIR | null {
  if (!isJsonObject(e) || e.class !== 'COLUMN_REF') {
    const cls = isJsonObject(e) ? String(e.class) : typeof e;
    out.push({ construct: cls === 'CAST' ? 'cast in join key' : cls === 'CONSTANT' ? 'constant in join condition' : `expression (${cls}) in ${where}`, detail: 'join keys must be direct column references' });
    return null;
  }
  const bad = mismatches(e, COLUMN_REF);
  if (bad.length || e.alias !== '') {
    out.push({ construct: `column reference in ${where}`, detail: bad.join(', ') || 'aliased column reference' });
    return null;
  }
  return { parts: [...(e.column_names as string[])] };
}

function conditionPairs(c: JsonValue, out: Unsupported[]): (readonly [ColumnRefIR, ColumnRefIR])[] {
  const pairs: (readonly [ColumnRefIR, ColumnRefIR])[] = [];
  const visit = (x: JsonValue) => {
    if (isJsonObject(x) && x.class === 'CONJUNCTION' && x.type === 'CONJUNCTION_AND') {
      const bad = mismatches(x, CONJUNCTION);
      if (bad.length) out.push({ construct: 'AND in join condition', detail: bad.join(', ') });
      else for (const child of x.children as JsonValue[]) visit(child);
      return;
    }
    if (isJsonObject(x) && x.class === 'COMPARISON' && x.type === 'COMPARE_EQUAL') {
      const bad = mismatches(x, COMPARISON);
      if (bad.length) {
        out.push({ construct: 'equality in join condition', detail: bad.join(', ') });
        return;
      }
      const l = columnRef(x.left as JsonValue, out, 'join condition');
      const r = columnRef(x.right as JsonValue, out, 'join condition');
      if (l && r) pairs.push([l, r]);
      return;
    }
    const t = isJsonObject(x) ? x.type : null;
    out.push({
      construct: t === 'CONJUNCTION_OR' ? 'OR in join condition'
        : t === 'COMPARE_NOT_DISTINCT_FROM' ? 'IS NOT DISTINCT FROM join condition'
        : isJsonObject(x) && x.class === 'COMPARISON' ? 'non-equality join condition'
        : `join condition ${isJsonObject(x) ? String(x.class) : 'missing'}`,
      detail: 'only column = column equalities combined with AND are supported',
    });
  };
  visit(c);
  return pairs;
}

function tableRef(t: JsonValue, side: string, out: Unsupported[]): TableRefIR | null {
  if (!isJsonObject(t) || t.type !== 'BASE_TABLE') {
    out.push({ construct: `${side} input: ${describeFrom(t)}`, detail: 'both join inputs must be named tables' });
    return null;
  }
  const bad = mismatches(t, BASE_TABLE);
  if (bad.length) {
    const what = t.schema_name || t.catalog_name ? 'qualified table name' : t.sample ? 'TABLESAMPLE' : t.at_clause ? 'AT (time travel)' : Array.isArray(t.column_name_alias) && t.column_name_alias.length ? 'column aliases on a table' : 'table reference';
    out.push({ construct: what, detail: `${side} input: ${bad.join(', ')}` });
    return null;
  }
  const name = t.table_name as string;
  const alias = t.alias as string;
  if (name.toLowerCase().startsWith(RESERVED_PREFIX) || alias.toLowerCase().startsWith(RESERVED_PREFIX)) {
    out.push({ construct: 'reserved name', detail: `names starting with ${RESERVED_PREFIX} are reserved for the analyser` });
    return null;
  }
  return { name, alias, ref: alias || name };
}

export function recognise(doc: JsonObject): Recognition {
  const out: Unsupported[] = [];
  const fail = (construct: string, detail: string): Recognition => ({ ok: false, unsupported: [{ construct, detail }] });
  const top = mismatches(doc, { error: isFalse, statements: (v) => Array.isArray(v) });
  if (top.length) return fail('parser output', top.join(', '));
  const stmts = doc.statements as JsonValue[];
  if (stmts.length !== 1) return fail('multiple statements', `${stmts.length} statements; Verdict analyses exactly one SELECT`);
  const stmt = stmts[0] as JsonValue;
  if (!isJsonObject(stmt) || mismatches(stmt, { node: isJsonObject, named_param_map: isEmptyArr }).length) {
    return fail('statement', isJsonObject(stmt) && Array.isArray(stmt.named_param_map) && stmt.named_param_map.length ? 'prepared-statement parameters are not supported' : 'unexpected statement shape');
  }
  const n = stmt.node as JsonObject;
  if (n.type === 'SET_OPERATION_NODE') return fail('set operation (UNION / INTERSECT / EXCEPT)', 'outside the P0 diagnostic scope');
  if (n.type === 'RECURSIVE_CTE_NODE' || n.type === 'CTE_NODE') return fail('WITH (CTE)', 'CTEs are outside the P0 diagnostic scope');
  if (n.type !== 'SELECT_NODE') return fail(`query node ${String(n.type)}`, 'Verdict analyses one plain SELECT');
  out.push(...describeNode(n));
  // Anything the specific checks above did not explain (for example a field from another version).
  if (!out.length) for (const m of mismatches(n, SELECT_NODE)) out.push({ construct: 'query shape', detail: m });

  // Projection: plain column references and * only.
  const list = Array.isArray(n.select_list) ? n.select_list : [];
  if (!list.length) out.push({ construct: 'SELECT list', detail: 'empty or missing' });
  for (const e of list) {
    if (isJsonObject(e) && e.class === 'STAR') {
      const bad = mismatches(e, STAR);
      if (bad.length) out.push({ construct: 'SELECT * modifier (EXCLUDE / REPLACE / RENAME / COLUMNS)', detail: bad.join(', ') });
    } else if (isJsonObject(e) && e.class === 'COLUMN_REF') {
      const bad = mismatches(e, COLUMN_REF);
      if (bad.length) out.push({ construct: 'SELECT column reference', detail: bad.join(', ') });
    } else {
      const cls = isJsonObject(e) ? String(e.class) : typeof e;
      out.push({ construct: cls === 'FUNCTION' ? 'function or aggregate in SELECT' : cls === 'WINDOW' ? 'window function' : cls === 'SUBQUERY' ? 'subquery in SELECT' : `SELECT expression (${cls})`, detail: 'only plain column references and * are supported' });
    }
  }

  // FROM: exactly one join of two base tables.
  const j = n.from_table;
  if (!isJsonObject(j) || j.type !== 'JOIN') {
    out.push({ construct: isJsonObject(j) && j.type === 'BASE_TABLE' ? 'single relation (no join)' : describeFrom(j ?? null), detail: 'Verdict analyses exactly one join between two named tables' });
    return { ok: false, unsupported: dedupe(out) };
  }
  const jbad = mismatches(j, JOIN);
  if (jbad.length) out.push({ construct: 'join shape', detail: jbad.join(', ') });
  if (j.ref_type !== 'REGULAR') out.push({ construct: `${String(j.ref_type)} JOIN`, detail: j.ref_type === 'CROSS' ? 'CROSS and comma joins are outside the P0 diagnostic scope' : 'outside the P0 diagnostic scope' });
  if (j.join_type !== 'INNER' && j.join_type !== 'LEFT') out.push({ construct: `${String(j.join_type)} JOIN`, detail: 'only INNER and LEFT joins are supported' });
  const left = tableRef(j.left as JsonValue, 'left', out);
  const right = tableRef(j.right as JsonValue, 'right', out);
  let condition: RecognisedJoin['condition'] | null = null;
  const using = Array.isArray(j.using_columns) ? (j.using_columns as JsonValue[]) : [];
  if (using.length) {
    if (j.condition !== null) out.push({ construct: 'USING with condition', detail: 'unexpected parser shape' });
    else if (!using.every((c) => typeof c === 'string' && c.length > 0)) out.push({ construct: 'USING', detail: 'invalid column list' });
    else condition = { kind: 'using', columns: using as string[] };
  } else if (j.condition === null || j.condition === undefined) {
    out.push({ construct: 'join without condition', detail: 'outside the P0 diagnostic scope' });
  } else {
    const pairs = conditionPairs(j.condition as JsonValue, out);
    if (pairs.length) condition = { kind: 'on', pairs };
  }
  if (out.length || !left || !right || !condition) return { ok: false, unsupported: dedupe(out.length ? out : [{ construct: 'query', detail: 'not recognised' }]) };
  return { ok: true, join: { type: j.join_type as JoinType, left, right, condition, joinNode: j } };
}

function dedupe(xs: readonly Unsupported[]): Unsupported[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${x.construct}|${x.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Display form of an identifier: bare when it is a plain lower-case word, otherwise quoted. */
export function displayIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}
