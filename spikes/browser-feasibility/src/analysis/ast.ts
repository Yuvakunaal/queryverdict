// Recognises the supported SQL subset from DuckDB's own parser output (json_serialize_sql).
//
// The parser is the engine's own (same dialect as execution, no extra dependency). Its JSON
// format is internal to DuckDB and may change between versions; the pinned version is v1.5.4.
// Anything not explicitly recognised here is reported as UNSUPPORTED and never analysed.
import { stringifyLossless } from './json';
import type { JoinType } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface Unsupported {
  construct: string;
  detail: string;
}

export interface Rel {
  /** Table, view or CTE name. */
  name: string;
  /** Qualifier used in the query: the alias, or the name when there is no alias. */
  ref: string;
  isCte: boolean;
}

export interface JoinIR {
  index: number;
  type: JoinType;
  /** FROM subtree to the left of this join (a base table or the previous joins). */
  leftTree: Json;
  right: Rel;
  /** Relations available on the left side. */
  leftRels: Rel[];
  condition: { kind: 'on'; pairs: [Json, Json][] } | { kind: 'using'; columns: string[] };
}

export interface AggregateUse {
  fn: string;
  distinct: boolean;
  /** Column names of the argument when it is a single column reference; null for count(*). */
  arg: string[] | null;
}

export interface QueryIR {
  node: Json;
  cteMap: Json;
  ctes: { name: string; node: Json; precedingMap: Json }[];
  base: Rel;
  rels: Rel[];
  fromTree: Json;
  joins: JoinIR[];
  where: Json | null;
  hasGroupBy: boolean;
  hasHaving: boolean;
  hasLimit: boolean;
  aggregates: AggregateUse[];
}

const AGGREGATES = new Set(['sum', 'count', 'count_star', 'avg', 'mean', 'min', 'max', 'first', 'last', 'any_value', 'arbitrary', 'list', 'array_agg', 'string_agg', 'median', 'quantile', 'quantile_cont', 'quantile_disc', 'mode', 'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp', 'bool_and', 'bool_or', 'product', 'fsum', 'favg', 'sumkahan', 'kahan_sum', 'approx_count_distinct', 'bit_and', 'bit_or', 'bit_xor', 'arg_min', 'arg_max', 'min_by', 'max_by', 'histogram', 'entropy', 'kurtosis', 'skewness', 'corr', 'covar_pop', 'covar_samp', 'regr_slope']);

/** Walks an expression tree, calling visit on every node that has a `class`. */
export function walkExpr(e: Json, visit: (n: Json) => void) {
  if (!e || typeof e !== 'object') return;
  if (Array.isArray(e)) {
    e.forEach((x) => walkExpr(x, visit));
    return;
  }
  if (typeof e.class === 'string') visit(e);
  for (const [k, v] of Object.entries(e)) {
    if (k === 'subquery' || k === 'value') continue;
    if (v && typeof v === 'object') walkExpr(v, visit);
  }
}

function forbiddenInExpr(e: Json, where: string, out: Unsupported[]) {
  walkExpr(e, (n) => {
    if (n.class === 'SUBQUERY') out.push({ construct: 'subquery', detail: `subquery in ${where}` });
    if (n.class === 'WINDOW') out.push({ construct: 'window function', detail: `window function in ${where}` });
    if (n.class === 'LAMBDA') out.push({ construct: 'lambda', detail: `lambda expression in ${where}` });
    if (n.class === 'COLLATE') out.push({ construct: 'COLLATE', detail: `explicit collation in ${where}` });
  });
}

function aggregatesIn(e: Json, out: AggregateUse[]) {
  walkExpr(e, (n) => {
    if (n.class === 'FUNCTION' && AGGREGATES.has(String(n.function_name).toLowerCase())) {
      const child = n.children?.[0];
      out.push({ fn: String(n.function_name).toLowerCase(), distinct: n.distinct === true, arg: child?.class === 'COLUMN_REF' ? child.column_names : null });
    }
  });
}

function relOf(t: Json, cteNames: Set<string>, out: Unsupported[]): Rel | null {
  if (t.type !== 'BASE_TABLE') {
    const what = t.type === 'SUBQUERY' ? 'derived table (subquery in FROM)' : t.type === 'TABLE_FUNCTION' ? `table function ${t.function?.function_name ?? ''}`.trim() : t.type === 'EMPTY' ? 'query without FROM' : `FROM item ${t.type}`;
    out.push({ construct: what, detail: 'only named tables, views and CTEs are supported as join inputs' });
    return null;
  }
  if (t.schema_name || t.catalog_name) out.push({ construct: 'qualified table name', detail: `${[t.catalog_name, t.schema_name, t.table_name].filter(Boolean).join('.')}` });
  if (t.sample) out.push({ construct: 'TABLESAMPLE', detail: t.table_name });
  if (t.at_clause) out.push({ construct: 'AT clause (time travel)', detail: t.table_name });
  if (t.column_name_alias?.length) out.push({ construct: 'column aliases on a table reference', detail: t.table_name });
  return { name: t.table_name, ref: t.alias || t.table_name, isCte: cteNames.has(t.table_name) };
}

function equalityPairs(cond: Json, out: Unsupported[], index: number): [Json, Json][] {
  const pairs: [Json, Json][] = [];
  const visit = (c: Json) => {
    if (c?.class === 'CONJUNCTION' && c.type === 'CONJUNCTION_AND') return c.children.forEach(visit);
    if (c?.class === 'COMPARISON' && c.type === 'COMPARE_EQUAL' && c.left?.class === 'COLUMN_REF' && c.right?.class === 'COLUMN_REF') {
      pairs.push([c.left, c.right]);
      return;
    }
    const kind =
      c?.type === 'CONJUNCTION_OR' ? 'OR in join condition'
      : c?.type === 'COMPARE_NOT_DISTINCT_FROM' ? 'IS NOT DISTINCT FROM join condition'
      : c?.class === 'COMPARISON' && c.type !== 'COMPARE_EQUAL' ? 'non-equality join condition'
      : c?.class === 'COMPARISON' ? 'expression in equality join condition (only column = column is supported)'
      : `join condition ${c?.class ?? 'unknown'}`;
    out.push({ construct: kind, detail: `join ${index}` });
  };
  visit(cond);
  return pairs;
}

/** Validates the top-level statement JSON and returns the IR or the list of unsupported constructs. */
export function recognize(serialized: Json): { ok: true; ir: QueryIR } | { ok: false; unsupported: Unsupported[] } {
  const out: Unsupported[] = [];
  if (serialized?.error) return { ok: false, unsupported: [{ construct: 'statement', detail: String(serialized.error_message ?? 'not a SELECT statement') }] };
  const stmts = serialized?.statements ?? [];
  if (stmts.length !== 1) return { ok: false, unsupported: [{ construct: 'multiple statements', detail: `${stmts.length} statements` }] };
  const r = recognizeNode(stmts[0].node, { map: [] }, out);
  return r && out.length === 0 ? { ok: true, ir: r } : { ok: false, unsupported: dedupe(out) };
}

function dedupe(xs: Unsupported[]): Unsupported[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(`${x.construct}|${x.detail}`) ? false : (seen.add(`${x.construct}|${x.detail}`), true)));
}

export function recognizeNode(node: Json, outerCteMap: Json, out: Unsupported[]): QueryIR | null {
  if (node?.type === 'SET_OPERATION_NODE') {
    out.push({ construct: `set operation ${node.setop_type}`, detail: 'UNION/INTERSECT/EXCEPT are not supported' });
    return null;
  }
  if (node?.type !== 'SELECT_NODE') {
    out.push({ construct: `query node ${node?.type}`, detail: 'only SELECT is supported' });
    return null;
  }
  for (const m of node.modifiers ?? []) {
    if (m.type === 'DISTINCT_MODIFIER') out.push({ construct: 'DISTINCT / DISTINCT ON', detail: 'DISTINCT can mask fan-out; not supported' });
    else if (m.type === 'ORDER_MODIFIER') forbiddenInExpr((m.orders ?? []).map((o: Json) => o.expression), 'ORDER BY', out);
    else if (m.type === 'LIMIT_MODIFIER') {
      for (const part of ['limit', 'offset'] as const) {
        if (m[part] && m[part].class !== 'CONSTANT') out.push({ construct: `non-constant ${part.toUpperCase()}`, detail: `${part.toUpperCase()} must be a literal` });
      }
    } else out.push({ construct: m.type, detail: 'result modifier' });
  }
  // CTEs: each must itself be in the supported subset (recursive CTEs are not).
  const cteEntries: Json[] = node.cte_map?.map ?? [];
  const allNames = new Set<string>([...(outerCteMap?.map ?? []).map((m: Json) => m.key), ...cteEntries.map((m: Json) => m.key)]);
  const ctes: QueryIR['ctes'] = [];
  for (let i = 0; i < cteEntries.length; i++) {
    const m = cteEntries[i];
    const q = m.value?.query?.node;
    if (m.value?.aliases?.length) out.push({ construct: 'CTE column aliases', detail: m.key });
    if (q?.type === 'RECURSIVE_CTE_NODE') {
      out.push({ construct: 'recursive CTE', detail: m.key });
      continue;
    }
    if ((q?.cte_map?.map ?? []).length) out.push({ construct: 'nested WITH inside a CTE', detail: `CTE ${m.key} defines its own WITH clause; nested CTE scopes are not supported` });
    const preceding = { map: cteEntries.slice(0, i) };
    const inner: Unsupported[] = [];
    recognizeNode(q, preceding, inner);
    for (const u of inner) out.push({ construct: u.construct, detail: `in CTE ${m.key}: ${u.detail}` });
    ctes.push({ name: m.key, node: q, precedingMap: preceding });
  }
  // SELECT list, WHERE, HAVING
  forbiddenInExpr(node.select_list, 'SELECT list', out);
  forbiddenInExpr(node.where_clause, 'WHERE', out);
  forbiddenInExpr(node.having, 'HAVING', out);
  forbiddenInExpr(node.group_expressions, 'GROUP BY', out);
  if (node.qualify) out.push({ construct: 'QUALIFY', detail: 'not supported' });
  // SELECT-list aliases referenced in WHERE / GROUP BY / HAVING: DuckDB resolves them, but a
  // rewritten diagnostic statement would not. Refuse rather than change meaning (Codex M3).
  const aliases = new Set<string>((node.select_list ?? []).map((e: Json) => String(e.alias ?? '').toLowerCase()).filter(Boolean));
  if (aliases.size) {
    for (const [part, expr] of [['WHERE', node.where_clause], ['GROUP BY', node.group_expressions], ['HAVING', node.having]] as const) {
      walkExpr(expr, (n) => {
        if (n.class === 'COLUMN_REF' && n.column_names?.length === 1 && aliases.has(String(n.column_names[0]).toLowerCase())) {
          out.push({ construct: 'SELECT alias referenced in ' + part, detail: `${n.column_names[0]} may refer to a SELECT-list alias` });
        }
      });
    }
  }
  if (node.sample) out.push({ construct: 'USING SAMPLE', detail: 'not supported' });
  if ((node.group_sets ?? []).length > 1) out.push({ construct: 'GROUPING SETS / ROLLUP / CUBE', detail: 'not supported' });
  if (node.aggregate_handling && node.aggregate_handling !== 'STANDARD_HANDLING') out.push({ construct: `GROUP BY ${node.aggregate_handling}`, detail: 'not supported' });
  // FROM: a base relation followed by a left-deep chain of equi-joins.
  const from = node.from_table;
  if (!from || from.type === 'EMPTY') {
    out.push({ construct: 'query without FROM', detail: 'nothing to analyse' });
    return null;
  }
  const joins: JoinIR[] = [];
  const rels: Rel[] = [];
  const chain: Json[] = [];
  let t = from;
  while (t?.type === 'JOIN') {
    chain.unshift(t);
    if (t.right?.type === 'JOIN') {
      out.push({ construct: 'bushy or right-nested join tree', detail: 'only left-deep join chains are supported' });
      return null;
    }
    t = t.left;
  }
  const base = relOf(t, allNames, out);
  if (!base) return null;
  rels.push(base);
  chain.forEach((j, index) => {
    const leftRels = [...rels];
    if (j.ref_type !== 'REGULAR') out.push({ construct: `${j.ref_type} JOIN`, detail: j.ref_type === 'CROSS' ? `join ${index} (also implicit comma joins); write an explicit JOIN ... ON` : `join ${index}` });
    if (!['INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL'].includes(j.join_type)) out.push({ construct: `${j.join_type} JOIN`, detail: `join ${index}` });
    const right = relOf(j.right, allNames, out);
    if (!right) return;
    rels.push(right);
    const type: JoinType = j.join_type === 'OUTER' ? 'FULL' : j.join_type;
    let condition: JoinIR['condition'];
    if (j.using_columns?.length) condition = { kind: 'using', columns: j.using_columns };
    else if (j.condition) condition = { kind: 'on', pairs: equalityPairs(j.condition, out, index) };
    else {
      if (j.ref_type === 'REGULAR') out.push({ construct: 'join without condition', detail: `join ${index}` });
      return;
    }
    if (condition.kind === 'on' && condition.pairs.length === 0) return;
    joins.push({ index, type, leftTree: j.left, right, leftRels, condition });
  });
  const refs = rels.map((r) => r.ref);
  if (new Set(refs).size !== refs.length) out.push({ construct: 'duplicate relation reference', detail: `${refs.join(', ')} (use distinct aliases)` });
  const aggregates: AggregateUse[] = [];
  aggregatesIn(node.select_list, aggregates);
  aggregatesIn(node.having, aggregates);
  return {
    node, cteMap: { map: [...(outerCteMap?.map ?? []), ...cteEntries] }, ctes, base, rels, fromTree: from, joins,
    where: node.where_clause ?? null,
    hasGroupBy: (node.group_expressions ?? []).length > 0,
    hasHaving: !!node.having,
    hasLimit: (node.modifiers ?? []).some((m: Json) => m.type === 'LIMIT_MODIFIER'),
    aggregates,
  };
}

// ---------------------------------------------------------------- strict MVP allowlist

// `query_location` is source-position metadata from the parser; it has no semantic effect.
const MVP_NODE_FIELDS = new Set(['type', 'modifiers', 'cte_map', 'select_list', 'from_table', 'where_clause', 'group_expressions', 'group_sets', 'aggregate_handling', 'having', 'sample', 'qualify']);
const MVP_JOIN_FIELDS = new Set(['query_location', 'type', 'alias', 'sample', 'left', 'right', 'condition', 'join_type', 'ref_type', 'using_columns', 'delim_flipped', 'duplicate_eliminated_columns']);
const MVP_TABLE_FIELDS = new Set(['query_location', 'type', 'alias', 'sample', 'schema_name', 'table_name', 'column_name_alias', 'catalog_name', 'at_clause']);
const MVP_COLREF_FIELDS = new Set(['query_location', 'class', 'type', 'alias', 'column_names']);
const MVP_STAR_FIELDS = new Set(['query_location', 'class', 'type', 'alias', 'relation_name', 'exclude_list', 'replace_list', 'columns', 'expr', 'qualified_exclude_list', 'rename_list']);
const MVP_CMP_FIELDS = new Set(['query_location', 'class', 'type', 'alias', 'left', 'right']);
const MVP_CONJ_FIELDS = new Set(['query_location', 'class', 'type', 'alias', 'children']);

function unknownFields(o: Json, allowed: Set<string>): string[] {
  return Object.keys(o ?? {}).filter((k) => !allowed.has(k));
}

/**
 * MVP scope (P-031): exactly `SELECT <columns or *> FROM a [alias] [INNER|LEFT] JOIN b [alias]
 * ON a.x = b.y [AND ...] | USING (...)` with nothing else. Every field of the serialised statement
 * is checked against an allowlist; an unknown field (e.g. from a future DuckDB version) is
 * unsupported rather than ignored. Key types are checked later (same-type integers only).
 */
export function recognizeMvp(serialized: Json): { ok: true; ir: QueryIR } | { ok: false; unsupported: Unsupported[] } {
  const out: Unsupported[] = [];
  const no = (construct: string, detail: string) => out.push({ construct, detail });
  if (serialized?.error) return { ok: false, unsupported: [{ construct: 'statement', detail: String(serialized.error_message ?? 'not a SELECT statement') }] };
  const stmts = serialized?.statements ?? [];
  if (stmts.length !== 1) return { ok: false, unsupported: [{ construct: 'multiple statements', detail: `${stmts.length} statements` }] };
  const n = stmts[0].node;
  if (n?.type !== 'SELECT_NODE') return { ok: false, unsupported: [{ construct: `query node ${n?.type}`, detail: 'MVP scope accepts one plain SELECT' }] };
  for (const k of unknownFields(n, MVP_NODE_FIELDS)) no(`query field ${k}`, 'not recognised by the MVP analyser');
  if ((n.modifiers ?? []).length) no('ORDER BY / LIMIT / DISTINCT', 'result modifiers are outside the MVP scope');
  if ((n.cte_map?.map ?? []).length) no('WITH (CTE)', 'CTEs are outside the MVP scope');
  if (n.where_clause) no('WHERE', 'post-join filtering is outside the MVP scope');
  if ((n.group_expressions ?? []).length || (n.group_sets ?? []).length) no('GROUP BY', 'aggregation is outside the MVP scope');
  if (n.having) no('HAVING', 'outside the MVP scope');
  if (n.qualify) no('QUALIFY', 'outside the MVP scope');
  if (n.sample) no('USING SAMPLE', 'outside the MVP scope');
  if (n.aggregate_handling !== 'STANDARD_HANDLING') no(`GROUP BY ${n.aggregate_handling}`, 'outside the MVP scope');
  for (const e of n.select_list ?? []) {
    if (e?.class === 'COLUMN_REF' && e.type === 'COLUMN_REF') {
      if (unknownFields(e, MVP_COLREF_FIELDS).length || !(e.column_names?.length >= 1 && e.column_names.length <= 2)) no('SELECT expression', 'only plain column references');
    } else if (e?.class === 'STAR' && e.type === 'STAR') {
      if (unknownFields(e, MVP_STAR_FIELDS).length || e.exclude_list?.length || e.replace_list?.length || e.columns || e.expr || e.qualified_exclude_list?.length || e.rename_list?.length) no('SELECT * modifiers', 'EXCLUDE/REPLACE/COLUMNS are outside the MVP scope');
    } else no(`SELECT expression ${e?.class ?? '?'}`, 'only plain column references and * are in the MVP scope (no functions, aggregates, casts or constants)');
  }
  const j = n.from_table;
  if (j?.type !== 'JOIN') {
    no(j?.type === 'BASE_TABLE' ? 'single relation' : `FROM ${j?.type}`, 'the MVP scope analyses exactly one join between two named relations');
    return { ok: false, unsupported: dedupe(out) };
  }
  for (const k of unknownFields(j, MVP_JOIN_FIELDS)) no(`join field ${k}`, 'not recognised by the MVP analyser');
  if (j.ref_type !== 'REGULAR') no(`${j.ref_type} JOIN`, 'outside the MVP scope');
  if (j.join_type !== 'INNER' && j.join_type !== 'LEFT') no(`${j.join_type} JOIN`, 'only INNER and LEFT joins are in the MVP scope');
  if (j.sample || j.alias || j.delim_flipped || (j.duplicate_eliminated_columns ?? []).length) no('join modifiers', 'outside the MVP scope');
  for (const side of ['left', 'right'] as const) {
    const t = j[side];
    if (t?.type !== 'BASE_TABLE') {
      no(`${side} input ${t?.type}`, 'both join inputs must be named relations (no join chains, subqueries or table functions)');
      continue;
    }
    for (const k of unknownFields(t, MVP_TABLE_FIELDS)) no(`table field ${k}`, 'not recognised by the MVP analyser');
    if (t.schema_name || t.catalog_name) no('qualified table name', 'outside the MVP scope');
    if (t.sample || t.at_clause || (t.column_name_alias ?? []).length) no('table modifiers', 'TABLESAMPLE, time travel and column aliases are outside the MVP scope');
  }
  if ((j.using_columns ?? []).length) {
    if (j.condition) no('USING with condition', 'unexpected');
  } else {
    const visit = (c: Json) => {
      if (c?.class === 'CONJUNCTION' && c.type === 'CONJUNCTION_AND' && !unknownFields(c, MVP_CONJ_FIELDS).length) return c.children.forEach(visit);
      if (c?.class === 'COMPARISON' && c.type === 'COMPARE_EQUAL' && !unknownFields(c, MVP_CMP_FIELDS).length && c.left?.class === 'COLUMN_REF' && c.right?.class === 'COLUMN_REF'
        && !unknownFields(c.left, MVP_COLREF_FIELDS).length && !unknownFields(c.right, MVP_COLREF_FIELDS).length) return;
      no('join condition', 'only AND-ed column = column equalities are in the MVP scope');
    };
    if (!j.condition) no('join without condition', 'outside the MVP scope');
    else visit(j.condition);
  }
  if (out.length) return { ok: false, unsupported: dedupe(out) };
  const inner: Unsupported[] = [];
  const ir = recognizeNode(n, { map: [] }, inner);
  if (!ir || inner.length) return { ok: false, unsupported: dedupe(inner.length ? inner : [{ construct: 'query', detail: 'not recognised' }]) };
  return { ok: true, ir };
}

// ---------------------------------------------------------------- AST builders (for json_deserialize_sql)

export const colRef = (names: string[], alias = ''): Json => ({ class: 'COLUMN_REF', type: 'COLUMN_REF', alias, column_names: names });
export const constInt = (v: number): Json => ({ class: 'CONSTANT', type: 'VALUE_CONSTANT', alias: '', value: { type: { id: 'INTEGER', type_info: null }, is_null: false, value: v } });
export const isNull = (e: Json): Json => ({ class: 'OPERATOR', type: 'OPERATOR_IS_NULL', alias: '', children: [e] });
export const and = (a: Json, b: Json): Json => ({ class: 'CONJUNCTION', type: 'CONJUNCTION_AND', alias: '', children: [a, b] });

export function selectNode(opts: { select: Json[]; from: Json; where?: Json | null; cteMap?: Json }): Json {
  return {
    type: 'SELECT_NODE', modifiers: [], cte_map: opts.cteMap ?? { map: [] }, select_list: opts.select, from_table: opts.from,
    where_clause: opts.where ?? null, group_expressions: [], group_sets: [], aggregate_handling: 'STANDARD_HANDLING', having: null, sample: null, qualify: null,
  };
}

/** Serialises a statement losslessly: numeric literals keep their exact source text (Codex H1). */
export function statementJson(node: Json): string {
  return stringifyLossless({ error: false, statements: [{ node, named_param_map: [] }] });
}

export function baseTableNode(rel: Rel): Json {
  return { type: 'BASE_TABLE', alias: rel.ref === rel.name ? '' : rel.ref, sample: null, schema_name: '', table_name: rel.name, column_name_alias: [], catalog_name: '', at_clause: null };
}

// ---------------------------------------------------------------- identifiers (Codex second review M5)

/**
 * Parses a user-supplied column reference such as `r."k.x"`, `"my rel"."a""b"` or `amount` into
 * its parts. Dots inside double quotes are part of the identifier; `""` escapes a quote. Returns
 * null for malformed input (empty part, unterminated quote, more than two parts).
 */
export function parseColumnRef(text: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  const s = text.trim();
  while (i <= s.length) {
    let part = '';
    if (s[i] === '"') {
      i++;
      for (;;) {
        if (i >= s.length) return null;
        if (s[i] === '"') {
          if (s[i + 1] === '"') {
            part += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        part += s[i++];
      }
    } else {
      while (i < s.length && s[i] !== '.') {
        if (s[i] === '"') return null;
        part += s[i++];
      }
      part = part.trim();
    }
    if (!part) return null;
    parts.push(part);
    if (i >= s.length) break;
    if (s[i] !== '.') return null;
    i++;
    if (i >= s.length) return null;
  }
  return parts.length >= 1 && parts.length <= 2 ? parts : null;
}

/** Display form of an identifier: quoted (with "" escaping) unless it is a plain lower-case word. */
export function displayIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}
