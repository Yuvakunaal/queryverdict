// Diagnostic probes (ARCHITECTURE §14, P-029, P-033). Every statement of an analysis goes through
// ProbeRunner: the budget gate approves its cost first, the statement is tagged with its probe name
// (`/*qv:<probe>*/`, so traces show exactly which probes ran), it runs only through the operation's
// revocable lease, and the text it returns is counted against the transfer limit.
//
// SQL text built here uses only (a) identifiers from the verified catalog, double-quoted with
// quotes doubled, (b) integer literals validated as /^-?\d+$/ and cast to the verified key type,
// and (c) SQL rendered by the engine itself from the query's own parse tree. No file names, no
// user text and no unvalidated values are interpolated.
import type { Lease, QueryShape, Rows } from '../engine/types';
import type { BudgetGate, ProbeCost, ProbeName } from './budget';

export class BudgetRefusedError extends Error {
  constructor(readonly probe: ProbeName, readonly reason: string) {
    super(`${probe}: ${reason}`);
    this.name = 'BudgetRefusedError';
  }
}

export interface TraceEntry {
  readonly probe: ProbeName;
  readonly sql: string;
}

export class ProbeRunner {
  readonly trace: TraceEntry[] = [];
  constructor(
    private readonly lease: Lease,
    readonly gate: BudgetGate,
  ) {}

  async query(probe: ProbeName, cost: ProbeCost, sql: string, shape: QueryShape): Promise<Rows> {
    const approval = this.gate.approve(probe, cost);
    if (!approval.ok) throw new BudgetRefusedError(probe, approval.reason);
    const tagged = `/*qv:${probe}*/ ${sql}`;
    this.trace.push({ probe, sql: tagged });
    const rows = await this.lease.query(tagged, shape);
    let bytes = 0;
    for (const r of rows) for (const c of r) bytes += c === null ? 0 : c.length;
    const t = this.gate.recordTransfer(bytes);
    if (!t.ok) throw new BudgetRefusedError(probe, t.reason);
    return rows;
  }

  async one(probe: ProbeName, cost: ProbeCost, sql: string, columns: number): Promise<readonly (string | null)[]> {
    const rows = await this.query(probe, cost, sql, { columns, maxRows: 1, exactRows: 1 });
    return rows[0] as readonly (string | null)[];
  }
}

export const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`;
export const sqlText = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Integer key types qualified for P0 and their widths in bytes (P-031). */
export const INTEGER_WIDTH: Readonly<Record<string, number>> = {
  TINYINT: 1, UTINYINT: 1, SMALLINT: 2, USMALLINT: 2, INTEGER: 4, UINTEGER: 4, BIGINT: 8, UBIGINT: 8, HUGEINT: 16, UHUGEINT: 16,
};

/** An exact integer literal of a verified key type (refuses anything that is not an integer). */
export function keyLiteral(value: string, type: string): string {
  if (!/^-?\d+$/.test(value)) throw new TypeError(`not an integer key value: ${JSON.stringify(value)}`);
  if (!(type in INTEGER_WIDTH)) throw new TypeError(`not a qualified key type: ${type}`);
  return `CAST('${value}' AS ${type})`;
}

export interface SideSql {
  /** Fully qualified, quoted table reference from the verified catalog identity. */
  readonly table: string;
  /** Quoted key column names, in key order. */
  readonly keys: readonly string[];
  readonly types: readonly string[];
}

const aliasKeys = (s: SideSql) => s.keys.map((k, i) => `${k} AS k${i}`).join(', ');
const kList = (n: number, prefix = '') => Array.from({ length: n }, (_, i) => `${prefix}k${i}`).join(', ');

/** rows, NULL-key rows, sum(hash(keys)), bit_xor(hash(keys)): an order-independent key-multiset fingerprint. */
export function fingerprintSql(s: SideSql): string {
  const ks = kList(s.keys.length);
  const anyNull = s.keys.map((_, i) => `k${i} IS NULL`).join(' OR ');
  return `SELECT count(*)::VARCHAR, (count(*) FILTER (WHERE ${anyNull}))::VARCHAR, coalesce(sum(hash(${ks})), 0)::VARCHAR, coalesce(bit_xor(hash(${ks})), 0)::VARCHAR FROM (SELECT ${aliasKeys(s)} FROM ${s.table})`;
}

export function inputRowsSql(table: string, maxInputRows: bigint): string {
  return `SELECT count(*)::VARCHAR FROM (SELECT 1 FROM ${table} LIMIT ${maxInputRows + 1n})`;
}

/** Key frequencies of one side, NULL-key rows excluded, counts exact (HUGEINT). */
export function frequencySql(temp: string, s: SideSql): string {
  const notNull = s.keys.map((k) => `${k} IS NOT NULL`).join(' AND ');
  return `CREATE TEMP TABLE ${temp} AS SELECT ${aliasKeys(s)}, count(*)::HUGEINT AS c FROM ${s.table} WHERE ${notNull} GROUP BY ALL`;
}

/** One row per matched key, with L(k) and R(k) (`lc`, `rc`): the relation the statistics call `m`. */
export function matchedSelect(lf: string, rf: string, n: number): string {
  const on = Array.from({ length: n }, (_, i) => `${lf}.k${i} = ${rf}.k${i}`).join(' AND ');
  return `SELECT ${lf}.c AS lc, ${rf}.c AS rc FROM ${lf} JOIN ${rf} ON ${on}`;
}

/** The matched-key CTE the analyser's statistics statement reads. */
export function matchedCte(lf: string, rf: string, n: number): string {
  return `WITH m AS MATERIALIZED (${matchedSelect(lf, rf, n)})`;
}

/**
 * The 18 frequency-derived statistics as scalar subqueries, in STAT_FIELDS order after rows and
 * NULL-key rows (see stats.ts). Shared by the analyser and the replay bundle (M12), so a replayed
 * statistic is the same expression the analyser evaluated. `usesMatched` marks those reading the
 * matched-key relation (`m` in the analyser; a temporary table in the replay).
 */
export function statisticExpressions(lf: string, rf: string, matched = 'm'): readonly { readonly sql: string; readonly usesMatched: boolean }[] {
  const t = (sql: string) => ({ sql, usesMatched: false });
  const m = (sql: string) => ({ sql: sql.replace(/ FROM m\b/, ` FROM ${matched}`), usesMatched: true });
  return [
    t(`SELECT coalesce(sum(c), 0) FROM ${lf}`), t(`SELECT coalesce(sum(c), 0) FROM ${rf}`),
    t(`SELECT count(*) FROM ${lf}`), t(`SELECT count(*) FROM ${rf}`),
    t(`SELECT count(*) FROM ${lf} WHERE c > 1`), t(`SELECT count(*) FROM ${rf} WHERE c > 1`),
    t(`SELECT coalesce(max(c), 0) FROM ${lf}`), t(`SELECT coalesce(max(c), 0) FROM ${rf}`),
    m('SELECT coalesce(max(lc), 0) FROM m'), m('SELECT coalesce(max(rc), 0) FROM m'),
    m('SELECT count(*) FROM m'), m('SELECT coalesce(sum(lc * rc), 0) FROM m'),
    m('SELECT coalesce(sum(lc), 0) FROM m'), m('SELECT coalesce(sum(rc), 0) FROM m'),
    m('SELECT coalesce(sum(lc) FILTER (WHERE rc > 1), 0) FROM m'), m('SELECT coalesce(sum(lc * (rc - 1)) FILTER (WHERE rc > 1), 0) FROM m'),
    m('SELECT coalesce(sum(rc) FILTER (WHERE lc > 1), 0) FROM m'), m('SELECT coalesce(sum(rc * (lc - 1)) FILTER (WHERE lc > 1), 0) FROM m'),
  ];
}

/** The 18 frequency-derived statistics, in this order (see stats.ts). */
export function statisticsSql(lf: string, rf: string, n: number): string {
  return `${matchedCte(lf, rf, n)}
SELECT ${statisticExpressions(lf, rf).map((e) => `(${e.sql})::VARCHAR`).join(',\n  ')}`;
}

export const WITNESS_LIMIT = 5;

/**
 * Witness keys of one kind, at most five, in a deterministic order: fan-out keys (matched and
 * duplicated on either side) by output contribution, then key; unmatched keys by key. Each row:
 * key values…, L(k), R(k), all as exact text. Reads only the frequency tables.
 */
export function witnessSelectionSql(kind: 'fan-out' | 'unmatched-left' | 'unmatched-right', lf: string, rf: string, n: number): string {
  const on = Array.from({ length: n }, (_, i) => `${lf}.k${i} = ${rf}.k${i}`).join(' AND ');
  const keysOf = (t: string) => Array.from({ length: n }, (_, i) => `${t}.k${i}::VARCHAR`).join(', ');
  const orderOf = (t: string) => Array.from({ length: n }, (_, i) => `${t}.k${i}`).join(', ');
  const using = kList(n);
  if (kind === 'fan-out') return `SELECT ${keysOf(lf)}, ${lf}.c::VARCHAR, ${rf}.c::VARCHAR FROM ${lf} JOIN ${rf} ON ${on} WHERE ${lf}.c > 1 OR ${rf}.c > 1 ORDER BY ${lf}.c * ${rf}.c DESC, ${orderOf(lf)} LIMIT ${WITNESS_LIMIT}`;
  if (kind === 'unmatched-left') return `SELECT ${keysOf(lf)}, ${lf}.c::VARCHAR, '0' FROM ${lf} ANTI JOIN ${rf} USING (${using}) ORDER BY ${orderOf(lf)} LIMIT ${WITNESS_LIMIT}`;
  return `SELECT ${keysOf(rf)}, '0', ${rf}.c::VARCHAR FROM ${rf} ANTI JOIN ${lf} USING (${using}) ORDER BY ${orderOf(rf)} LIMIT ${WITNESS_LIMIT}`;
}

/** Re-counts each witness key on both inputs: one row per check (index, count). */
export function witnessInputsSql(left: SideSql, right: SideSql, keys: readonly (readonly string[])[]): string {
  const match = (s: SideSql, vals: readonly string[]) => s.keys.map((k, i) => `${k} = ${keyLiteral(vals[i] as string, s.types[i] as string)}`).join(' AND ');
  const parts: string[] = [];
  keys.forEach((vals, w) => {
    parts.push(`SELECT ${2 * w} AS i, (SELECT count(*) FROM ${left.table} WHERE ${match(left, vals)})::VARCHAR AS n`);
    parts.push(`SELECT ${2 * w + 1} AS i, (SELECT count(*) FROM ${right.table} WHERE ${match(right, vals)})::VARCHAR AS n`);
  });
  return `SELECT * FROM (${parts.join('\nUNION ALL ')}) ORDER BY i`;
}

/** Names the witness probes give the key-filtered inputs (the query's join node reads them). */
export const WITNESS_LEFT = '__qv_wl';
export const WITNESS_RIGHT = '__qv_wr';

/**
 * Prefix for a witness recount through the query's own join: each input is replaced by its rows
 * with exactly the witness key, so the join can produce at most L(k)·R(k) pairs (plus L(k)
 * preserved rows), whatever the optimiser does.
 */
export function witnessCtes(left: SideSql, right: SideSql, vals: readonly string[]): string {
  const filter = (s: SideSql) => s.keys.map((k, i) => `${k} = ${keyLiteral(vals[i] as string, s.types[i] as string)}`).join(' AND ');
  return `WITH ${WITNESS_LEFT} AS MATERIALIZED (SELECT * FROM ${left.table} WHERE ${filter(left)}), ${WITNESS_RIGHT} AS MATERIALIZED (SELECT * FROM ${right.table} WHERE ${filter(right)}) `;
}

export function identitySql(database: string, schema: string, table: string): string {
  return `SELECT table_oid::VARCHAR FROM duckdb_tables() WHERE database_name = ${sqlText(database)} AND schema_name = ${sqlText(schema)} AND table_name = ${sqlText(table)}`;
}
