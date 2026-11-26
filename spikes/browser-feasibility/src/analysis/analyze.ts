// SQL correctness analysis engine (spike). Deterministic, no LLM, DuckDB SQL subset.
//
// Principle: never silently misrepresent SQL semantics. An unsupported or inconclusive result is
// preferred to an incorrect one. Two scopes:
//   - 'mvp' (default; P-031): exactly two app-controlled base tables, one INNER or LEFT
//     equi-join on same-type integer keys, plain projection. Only MVP reports can be authoritative.
//   - 'experimental': join chains, RIGHT/FULL, CTEs, views, WHERE/GROUP BY, non-integer keys
//     (validated against the engine's own join), grain/metric expectations. Never authoritative.
//
// Entry points:
//   - analyzeInSession(session, ...): the only path that can produce an authoritative report. It
//     owns the session exclusively for the whole analysis (EngineSession.exclusive), runs every
//     diagnostic inside one transaction on one engine generation, and always rolls back.
//   - analyze(executor, ...): the analysis itself, over any executor (stand-ins in tests). Without
//     the executor's snapshot capability no report is authoritative.
//
// Pipeline:
//   1. parse with DuckDB's parser; keep numeric literals exact (lossless JSON, Codex H1)
//   2. recognise the scope's subset; anything else → UNSUPPORTED (no conclusions)
//   3. bind the user's query (DESCRIBE) → QUERY FAILURE if it cannot bind
//   4. classify every input relation from the catalog; MVP accepts only stable base tables
//   5. resource qualification BEFORE any grouping: bounded input rows, key columns and widths,
//      estimated grouping state (fail-closed; estimates, not guarantees)
//   6. per join: key frequencies materialised once (temp tables), exact statistics, invariants,
//      SEMI JOIN validation with the query's own condition, executed count within budget,
//      bounded witnesses re-verified through the query's own join (identity, not only counts)
//   7. snapshot verification: key-multiset fingerprints and table identities at the end must equal
//      those at the start; otherwise every join statistic is withdrawn (inconclusive)
//   8. experimental only: optional count-only probes (WHERE, final, outer-join rows); a failing
//      optional probe is inconclusive and does not discard validated evidence
//   9. every declared expectation gets exactly one outcome: violated, held or unchecked
import { and, baseTableNode, colRef, constInt, displayIdent, isNull, parseColumnRef, recognize, recognizeMvp, selectNode, statementJson, walkExpr, type Json, type QueryIR, type Rel } from './ast';
import { batchExecutor, BudgetExhaustedError, DiagnosticError, isTerminal, TIMEOUT, within, type BatchLike, type ExecutorOptions } from './executor';
import { parseLossless } from './json';
import { checkInvariants, derive, evaluateJoinExpectation, joinFindings, parseBig, STAT_FIELDS, violationFinding } from './stats';
import type { AnalysisReport, Executor, Expectation, ExpectationOutcome, Finding, JoinReport, JoinStats, QueryShape, RelationInfo, Relationship, Resources, Scope, Stage, TerminalInfo } from './types';

export const DISCLAIMER =
  'This analysis measures specific properties of a supported SQL subset on the loaded data snapshot. ' +
  'It does not prove that the query or its business results are correct, and it does not show that the query executes; ' +
  'absence of findings is not a pass.';

export interface AnalyzeOptions {
  scope?: Scope;
  /** Executed probes run only when every relevant computed row count is known and at most this. */
  executionBudgetRows?: bigint;
  /** Each relation is checked (bounded scan) to have at most this many rows before analysis. */
  maxInputRows?: bigint;
  /** At most this many key columns per join. */
  maxKeyColumns?: number;
  /** Estimated hash-grouping state per join side, checked before any grouping runs. */
  maxGroupingStateBytes?: bigint;
  depth?: number;
}

export const DEFAULTS = { executionBudgetRows: 50_000_000n, maxInputRows: 50_000_000n, maxKeyColumns: 8, maxGroupingStateBytes: 512n * 1024n * 1024n };
/**
 * Assumed bytes per group in the grouping-state estimate in addition to the key bytes and the
 * 16-byte HUGEINT count (hash entry, pointers, alignment). An estimate, not a measurement of
 * DuckDB's allocator; DuckDB's memory_limit is the enforced control.
 */
export const GROUP_ENTRY_OVERHEAD_BYTES = 64n;
/** Nominal width used for keys without a fixed width (experimental scope only). */
const NOMINAL_VARIABLE_KEY_BYTES = 32n;
const INTEGER_WIDTH: Record<string, number> = { TINYINT: 1, UTINYINT: 1, SMALLINT: 2, USMALLINT: 2, INTEGER: 4, UINTEGER: 4, BIGINT: 8, UBIGINT: 8, HUGEINT: 16, UHUGEINT: 16 };
const RELATIONSHIPS = new Set<Relationship>(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']);
const STAR: Json = { class: 'STAR', type: 'STAR', alias: '', relation_name: '', exclude_list: [], replace_list: [], columns: false, expr: null, qualified_exclude_list: [], rename_list: [] };
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'unknown error';

interface ResolvedCol {
  rel: Rel;
  column: string;
  type: string;
}
type Pair = [ResolvedCol, ResolvedCol];
type Fingerprint = string[]; // rows, NULL-key rows, sum(hash(keys)), bit_xor(hash(keys))

class Ctx {
  readonly sql: string[] = [];
  readonly temps: string[] = [];
  /** Set when a statement failed inside the analysis transaction (DuckDB then aborts it). */
  abortedBy: string | null = null;
  constructor(readonly exec: Executor) {}
  async run(sql: string, shape: QueryShape): Promise<string[][]> {
    if (this.abortedBy) throw new DiagnosticError('engine', `not run: an earlier diagnostic failed inside the analysis transaction (${this.abortedBy})`);
    this.sql.push(sql);
    try {
      return await this.exec.query(sql, shape);
    } catch (e) {
      if (this.exec.snapshot && e instanceof DiagnosticError && e.kind === 'engine') this.abortedBy = msg(e);
      throw e;
    }
  }
  async one(sql: string, columns: number): Promise<string[]> {
    return (await this.run(sql, { columns, maxRows: 1, exactRows: 1 }))[0]!;
  }
  async toSql(node: Json): Promise<string> {
    const s = (await this.one(`SELECT json_deserialize_sql(${q(statementJson(node))})`, 1))[0];
    if (!s) throw new DiagnosticError('shape', 'json_deserialize_sql returned nothing');
    return s;
  }
  async count(sqlFrom: string): Promise<bigint> {
    return parseBig((await this.one(`SELECT count(*)::VARCHAR FROM (${sqlFrom})`, 1))[0]);
  }
  async cleanup() {
    for (const t of this.temps.splice(0)) {
      const sql = `DROP TABLE IF EXISTS ${t}`;
      this.sql.push(sql);
      await (this.exec.cleanup ? this.exec.cleanup(sql) : this.exec.query(sql, { maxRows: 1 })).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------- expectations (Codex second review M6)

/** Returns why an expectation is malformed, or null when its shape is valid. */
export function invalidExpectation(e: unknown): string | null {
  if (!e || typeof e !== 'object') return 'not an object';
  const x = e as Record<string, unknown>;
  const joinOk = () => (Number.isSafeInteger(x.join) ? null : 'join must be an integer index');
  switch (x.kind) {
    case 'relationship':
      return joinOk() ?? (RELATIONSHIPS.has(x.expected as Relationship) ? null : `expected must be one of ${[...RELATIONSHIPS].join(', ')}`);
    case 'no-row-loss':
      return joinOk() ?? (x.side === 'left' || x.side === 'right' ? null : "side must be 'left' or 'right'");
    case 'no-fan-out':
      return joinOk() ?? (x.side === undefined || x.side === 'left' || x.side === 'right' ? null : "side must be 'left' or 'right'");
    case 'grain':
      return Array.isArray(x.columns) && x.columns.length > 0 && x.columns.every((c) => typeof c === 'string' && c.length > 0) ? null : 'columns must be a non-empty list of column names';
    case 'metric-preserved':
      if (typeof x.column !== 'string' || !parseColumnRef(x.column)) return 'column must be a column reference such as amount, o.amount or o."amount.usd"';
      if (x.tolerance !== undefined && !(typeof x.tolerance === 'number' && Number.isFinite(x.tolerance) && x.tolerance >= 0)) return 'tolerance must be a finite number >= 0';
      if (x.nullAsZero !== undefined && typeof x.nullAsZero !== 'boolean') return 'nullAsZero must be true or false';
      return null;
    case 'row-count': {
      const ok = (v: unknown) => v === undefined || (Number.isSafeInteger(v) && (v as number) >= 0);
      if (!ok(x.min) || !ok(x.max)) return 'min and max must be non-negative integers';
      if (x.min === undefined && x.max === undefined) return 'row-count needs min or max';
      if (x.min !== undefined && x.max !== undefined && (x.min as number) > (x.max as number)) return 'min is greater than max';
      return null;
    }
    default:
      return `unknown expectation kind ${JSON.stringify(x.kind)}`;
  }
}

/** One outcome per declared expectation, in order; anything not evaluated is unchecked with `reason`. */
function completeOutcomes(expectations: Expectation[], evaluated: Map<number, ExpectationOutcome>, reason: string): ExpectationOutcome[] {
  return expectations.map((e, index) => {
    const bad = invalidExpectation(e);
    if (bad) return { index, expectation: e, outcome: 'unchecked', reason: `invalid expectation: ${bad}` };
    return evaluated.get(index) ?? { index, expectation: e, outcome: 'unchecked', reason };
  });
}

function outcomeFindings(outcomes: ExpectationOutcome[]): Finding[] {
  const out: Finding[] = [];
  for (const o of outcomes) {
    const e = o.expectation;
    if (o.outcome === 'violated') {
      out.push(typeof e === 'object' && e && 'join' in e ? violationFinding(e.join, o) : { category: 'expectation-violation', code: `${e.kind}-violated`, message: o.reason ?? `Expectation ${e.kind} violated.`, evidence: o.evidence });
    } else if (o.outcome === 'unchecked') {
      out.push({ category: 'expectation-unchecked', code: 'expectation-unchecked', message: `Expectation ${o.index} (${(e as { kind?: unknown })?.kind ?? '?'}) was not checked: ${o.reason}`, evidence: { index: o.index, expectation: e } });
    }
  }
  return out;
}

// ---------------------------------------------------------------- reports

interface ReportParts {
  scope: Scope;
  status: AnalysisReport['status'];
  findings: Finding[];
  expectations: Expectation[];
  evaluated?: Map<number, ExpectationOutcome>;
  uncheckedReason: string;
  ctx: Ctx;
  relations?: RelationInfo[];
  resources?: Resources | null;
  joins?: JoinReport[];
  stages?: Stage[];
  ctes?: AnalysisReport['ctes'];
  checked?: string[];
  notChecked?: string[];
  terminal?: TerminalInfo;
  extraReasons?: string[];
}

function finish(p: ReportParts): AnalysisReport {
  const outcomes = completeOutcomes(p.expectations, p.evaluated ?? new Map(), p.uncheckedReason);
  const findings = [...p.findings, ...outcomeFindings(outcomes)];
  let status = p.status;
  if (status === 'analyzed' && outcomes.some((o) => o.outcome === 'unchecked')) status = 'partially-analyzed';
  const joins = p.joins ?? [];
  const relations = p.relations ?? [];
  const reasons: string[] = [];
  if (p.scope !== 'mvp') reasons.push('experimental-scope reports are never authoritative');
  if (status !== 'analyzed') reasons.push(`analysis status is ${status}`);
  if (!p.ctx.exec.snapshot) reasons.push('diagnostics did not run in an exclusive, transactional session batch (analyzeInSession)');
  else if (!p.ctx.exec.snapshot.isCurrent()) reasons.push('the engine was replaced, restarted or disposed during the analysis');
  for (const r of relations) if (r.refusal) reasons.push(`relation ${r.ref}: ${r.refusal}`);
  if (!joins.length) reasons.push('no join was analysed');
  for (const j of joins) {
    if (!j.stats) reasons.push(`join ${j.index} has no validated statistics`);
    else if (j.validation.snapshot !== 'verified') reasons.push(`join ${j.index}: input snapshot not verified (${j.validation.snapshot})`);
    else if (j.validation.witnesses !== 'verified') reasons.push(`join ${j.index}: witnesses not verified (${j.validation.witnesses})`);
  }
  reasons.push(...(p.extraReasons ?? []));
  const authoritative = reasons.length === 0;
  return {
    scope: p.scope, authoritative, nonAuthoritativeReasons: reasons, status, ...(p.terminal ? { terminal: p.terminal } : {}),
    relations, resources: p.resources ?? null, findings, expectations: outcomes, joins, stages: p.stages ?? [], ctes: p.ctes ?? [],
    coverage: { checked: p.checked ?? [], notChecked: p.notChecked ?? ['all data checks (query not analysed)'] },
    diagnosticSql: p.ctx.sql, disclaimer: DISCLAIMER,
  };
}

function failure(scope: Scope, e: unknown, ctx: Ctx, expectations: Expectation[]): AnalysisReport {
  const base = { scope, ctx, expectations };
  if (e instanceof BudgetExhaustedError) {
    return finish({ ...base, status: 'budget-exhausted', terminal: e.terminal, uncheckedReason: 'the analysis budget was exhausted before it could be evaluated', notChecked: ['all checks (analysis budget exhausted)'],
      findings: [{ category: 'inconclusive', code: 'budget-exhausted', message: `Analysis stopped: ${e.message}. No conclusions are drawn from the incomplete analysis.`, evidence: { ...e.terminal } }] });
  }
  if (e instanceof DiagnosticError && e.kind === 'cancelled') {
    return finish({ ...base, status: 'cancelled', terminal: { reason: 'cancelled', cancellation: 'cooperative' }, uncheckedReason: 'the analysis was cancelled', notChecked: ['all checks (analysis cancelled)'],
      findings: [{ category: 'inconclusive', code: 'analysis-cancelled', message: 'The analysis was cancelled. No conclusions are drawn from the incomplete analysis.' }] });
  }
  if (e instanceof DiagnosticError && (e.kind === 'stale' || e.kind === 'terminated')) {
    return finish({ ...base, status: 'diagnostic-failed', terminal: { reason: e.kind, cancellation: 'not-needed' }, uncheckedReason: 'the engine was replaced or terminated during the analysis', notChecked: ['all checks (engine replaced or terminated)'],
      findings: [{ category: 'diagnostic-failure', code: 'session-replaced', message: `The analysis ended because ${e.message}. No conclusions are drawn; this does not mean the user's query fails.` }] });
  }
  return finish({ ...base, status: 'diagnostic-failed', uncheckedReason: 'a diagnostic statement failed before it could be evaluated',
    findings: [{ category: 'diagnostic-failure', code: 'diagnostic-failed', message: `A diagnostic statement failed: ${msg(e)}. This does not mean the user's query fails.` }] });
}

export async function analyze(exec: Executor, userSql: string, expectations: Expectation[] = [], options: AnalyzeOptions = {}): Promise<AnalysisReport> {
  const scope: Scope = options.scope ?? 'mvp';
  const ctx = new Ctx(exec);
  try {
    return await analyzeInner(ctx, userSql, expectations, { ...options, scope });
  } catch (e) {
    return failure(scope, e, ctx, expectations);
  } finally {
    await ctx.cleanup();
  }
}

// ---------------------------------------------------------------- relations (Codex second review H-A)

async function classifyRelations(ctx: Ctx, ir: QueryIR, scope: Scope): Promise<RelationInfo[]> {
  const [db, schema] = await ctx.one('SELECT current_database()::VARCHAR, current_schema()::VARCHAR', 2);
  const out: RelationInfo[] = [];
  for (const rel of ir.rels) {
    if (rel.isCte) {
      out.push({ ref: rel.ref, name: rel.name, kind: 'cte', refusal: 'CTEs are not verified stable relations (experimental scope)' });
      continue;
    }
    // Every catalog object with this name, in every attached database and schema (case-insensitive,
    // like DuckDB's binder). Only a single, unambiguous base table in the current schema (or a
    // temporary table) is accepted for an authoritative report.
    const rows = await ctx.run(
      `SELECT 'table', database_name, schema_name, table_oid::VARCHAR, temporary::VARCHAR, (coalesce(sql, '') ILIKE '%GENERATED%')::VARCHAR FROM duckdb_tables() WHERE lower(table_name) = lower(${q(rel.name)})
UNION ALL SELECT 'view', database_name, schema_name, view_oid::VARCHAR, temporary::VARCHAR, 'false' FROM duckdb_views() WHERE lower(view_name) = lower(${q(rel.name)})`,
      { columns: 6, maxRows: 64 },
    );
    const info: RelationInfo = { ref: rel.ref, name: rel.name, kind: 'unresolved' };
    if (rows.length === 0) info.refusal = 'not a catalog table (replacement scan, file reference or table function); only app-controlled tables are verified';
    else if (rows.length > 1) {
      info.kind = 'ambiguous';
      info.refusal = `the name matches ${rows.length} catalog objects (${rows.map((r) => `${r[0]} ${r[1]}.${r[2]}`).join(', ')}); resolution is not verified`;
    } else {
      const [kind, database, sch, oid, temporary, generated] = rows[0]!;
      info.identity = { database: database!, schema: sch!, oid: oid! };
      if (kind === 'view') {
        info.kind = 'view';
        info.refusal = 'views are not verified stable relations (they may be volatile, file-backed or read other relations)';
      } else {
        info.kind = temporary === 'true' ? 'temporary-table' : 'base-table';
        if (temporary !== 'true' && (database !== db || sch !== schema)) info.refusal = `table ${database}.${sch} is outside the current schema ${db}.${schema}`;
        else if (generated === 'true') info.refusal = 'the table has generated columns, which may be volatile';
      }
    }
    if (scope === 'mvp' || info.refusal || info.identity) out.push(info);
  }
  return out;
}

async function relationIdentities(ctx: Ctx, rels: RelationInfo[]): Promise<string[]> {
  const changed: string[] = [];
  for (const r of rels) {
    if (!r.identity || r.kind === 'view') continue;
    const rows = await ctx.run(`SELECT table_oid::VARCHAR FROM duckdb_tables() WHERE database_name = ${q(r.identity.database)} AND schema_name = ${q(r.identity.schema)} AND lower(table_name) = lower(${q(r.name)})`, { columns: 1, maxRows: 2 });
    if (rows.length !== 1 || rows[0]![0] !== r.identity.oid) changed.push(r.ref);
  }
  return changed;
}

// ---------------------------------------------------------------- main pipeline

async function analyzeInner(ctx: Ctx, userSql: string, expectations: Expectation[], o: AnalyzeOptions & { scope: Scope }): Promise<AnalysisReport> {
  const { scope } = o;
  const budget = o.executionBudgetRows ?? DEFAULTS.executionBudgetRows;
  const maxInput = o.maxInputRows ?? DEFAULTS.maxInputRows;
  const maxKeyColumns = o.maxKeyColumns ?? DEFAULTS.maxKeyColumns;
  const maxGrouping = o.maxGroupingStateBytes ?? DEFAULTS.maxGroupingStateBytes;
  const sqlText = userSql.trim().replace(/;\s*$/, '');
  const early = (status: AnalysisReport['status'], findings: Finding[], uncheckedReason: string, extra: Omit<ReportParts, 'scope' | 'status' | 'findings' | 'expectations' | 'ctx' | 'uncheckedReason'> = {}) =>
    finish({ scope, status, findings, expectations, ctx, uncheckedReason, ...extra });

  // 1. parse (lossless)
  const serialized = parseLossless((await ctx.one(`SELECT json_serialize_sql(${q(sqlText)})::VARCHAR`, 1))[0] ?? '{}');
  if (serialized.error) {
    const m = String(serialized.error_message ?? '');
    if (/only select statements/i.test(m)) return early('unsupported', [{ category: 'unsupported', code: 'unsupported-construct', message: `Only SELECT statements are analysed (${m}).`, evidence: { construct: 'statement', detail: m } }], 'the statement is not analysed (not a SELECT)');
    return early('query-failed', [{ category: 'query-failure', code: 'syntax-error', message: `The query cannot be parsed: ${m}` }], 'the query cannot be parsed');
  }

  // 2. supported subset
  const rec = scope === 'mvp' ? recognizeMvp(serialized) : recognize(serialized);
  if (!rec.ok) {
    return early('unsupported', rec.unsupported.map((u) => ({
      category: 'unsupported' as const, code: 'unsupported-construct',
      message: `${u.construct} is not supported by the ${scope === 'mvp' ? 'MVP' : 'experimental'} analyser (${u.detail}). No data conclusions are drawn for this query.`,
      evidence: { ...u },
    })), `the query is outside the ${scope === 'mvp' ? 'MVP' : 'experimental'} analyser's supported subset`);
  }
  const ir = rec.ir;

  // 3. bind the user's query (binding only; it is never executed by the analyser)
  try {
    await ctx.run(`DESCRIBE ${sqlText}`, { columns: 6, maxRows: 4096 });
  } catch (e) {
    if (isTerminal(e) || (e instanceof DiagnosticError && e.kind !== 'engine')) throw e;
    return early('query-failed', [{ category: 'query-failure', code: 'bind-failed', message: `The query cannot be bound (it would fail before running): ${msg(e)}` }], 'the query cannot be bound');
  }

  // 4. relations
  const relations = await classifyRelations(ctx, ir, scope);
  if (scope === 'mvp') {
    const refused = relations.filter((r) => r.refusal);
    if (refused.length) {
      return early('unsupported', refused.map((r) => ({ category: 'unsupported' as const, code: 'unsupported-relation', message: `${r.ref} (${r.name}) cannot be analysed in the MVP scope: ${r.refusal}. No data conclusions are drawn.`, evidence: { construct: `relation kind ${r.kind}`, relation: r.name, detail: r.refusal } })),
        'an input relation is not a verified stable table', { relations });
    }
  }

  const findings: Finding[] = [];
  const evaluated = new Map<number, ExpectationOutcome>();
  const checked: string[] = [];
  const notChecked: string[] = [
    'whether the original query executes (the analyser binds it but never runs it; count-only probes do not evaluate the SELECT list)',
    'whether the query expresses the intended business logic',
    'aggregate inflation (not attributed: it would require measuring the rows that actually contribute to each aggregate)',
  ];
  const inconclusive = (code: string, message: string, extra: Omit<Finding, 'category' | 'code' | 'message'> = {}) => findings.push({ category: 'inconclusive', code, message, ...extra });

  // relation columns
  const columns = new Map<string, Map<string, string>>();
  for (const rel of ir.rels) {
    const rows = await ctx.run(`DESCRIBE ${await ctx.toSql(selectNode({ select: [STAR], from: baseTableNode(rel), cteMap: ir.cteMap }))}`, { columns: 6, maxRows: 4096 });
    columns.set(rel.ref.toLowerCase(), new Map(rows.map((r) => [String(r[0]).toLowerCase(), String(r[1])])));
  }
  const resolve = (names: string[], candidates: Rel[]): ResolvedCol | string => {
    if (names.length === 2) {
      const rel = candidates.find((r) => r.ref.toLowerCase() === names[0]!.toLowerCase());
      if (!rel) return `${names.map(displayIdent).join('.')} does not refer to ${candidates.map((r) => r.ref).join('/')}`;
      const type = columns.get(rel.ref.toLowerCase())?.get(names[1]!.toLowerCase());
      return type ? { rel, column: names[1]!, type } : `column ${names.map(displayIdent).join('.')} not found`;
    }
    if (names.length === 1) {
      const hits = candidates.filter((r) => columns.get(r.ref.toLowerCase())?.has(names[0]!.toLowerCase()));
      if (hits.length === 1) return { rel: hits[0]!, column: names[0]!, type: columns.get(hits[0]!.ref.toLowerCase())!.get(names[0]!.toLowerCase())! };
      return hits.length ? `column ${displayIdent(names[0]!)} is ambiguous (${hits.map((h) => h.ref).join(', ')})` : `column ${displayIdent(names[0]!)} not found in ${candidates.map((r) => r.ref).join(', ')}`;
    }
    return `unsupported column reference ${names.map(displayIdent).join('.')}`;
  };

  // 5. resource qualification: bounded input sizes (fail-closed), before any grouping
  const inputRows = new Map<string, bigint | null>();
  const resources: Resources = {
    inputRows: {}, maxInputRows: String(maxInput), keyColumns: 0, maxKeyColumns, keyBytesPerRow: 0, estimatedGroupingBytes: {},
    maxGroupingStateBytes: String(maxGrouping), engineMemoryLimit: null, statements: 0,
  };
  resources.engineMemoryLimit = (await ctx.one("SELECT current_setting('memory_limit')::VARCHAR", 1))[0] ?? null;
  let inputsKnown = true;
  for (const rel of ir.rels) {
    const n = await ctx.count(`SELECT 1 FROM (${await ctx.toSql(selectNode({ select: [constInt(1)], from: baseTableNode(rel), cteMap: ir.cteMap }))}) LIMIT ${maxInput + 1n}`);
    inputRows.set(rel.ref, n > maxInput ? null : n);
    resources.inputRows[rel.ref] = n > maxInput ? `over ${maxInput}` : String(n);
    if (n > maxInput) {
      inputsKnown = false;
      inconclusive('input-too-large', `${rel.ref} has more than ${maxInput} rows (bounded check), which exceeds the analysis input budget. No join is analysed.`, { evidence: { relation: rel.ref, maxInputRows: String(maxInput) } });
    }
  }
  checked.push(`input sizes (bounded at ${maxInput} rows per relation; for views and CTEs the bound applies to rows returned, not to the work needed to produce them)`);

  // 6. joins
  const joinReports: JoinReport[] = [];
  const validated: (JoinStats | null)[] = [];
  const pairsByJoin = new Map<number, Pair[]>();
  const fingerprints: { join: number; keys: string[]; lSql: string; rSql: string; left: Fingerprint; right: Fingerprint }[] = [];
  let upstreamKnown = inputsKnown; // false once any join's output is unknown, invalid or over budget
  for (const j of ir.joins) {
    const report: JoinReport = {
      index: j.index, type: j.type, left: j.leftRels.map((r) => r.ref).join(' ⋈ '), right: j.right.ref, keys: [],
      method: j.index === 0 ? 'base-relation-frequencies' : 'executed-intermediate-frequencies',
      stats: null, derived: null, samples: null,
      validation: { invariants: 'held', invariantViolations: [], semiJoin: 'not-run', executedCount: 'not-run', witnesses: 'not-run', snapshot: 'not-run' },
    };
    joinReports.push(report);
    validated.push(null);
    if (!upstreamKnown) {
      inconclusive('depends-on-unknown', `Join ${j.index}: not analysed, because its input size is unknown, invalid or over budget (fail-closed).`, { join: j.index });
      continue;
    }
    // keys (structured: relation and column stay separate, Codex second review M5)
    const pairs: Pair[] = [];
    let problem: string | null = null;
    if (j.condition.kind === 'using') {
      for (const c of j.condition.columns) {
        const l = resolve([c], j.leftRels);
        const r = resolve([j.right.ref, c], [j.right]);
        if (typeof l === 'string' || typeof r === 'string') problem = typeof l === 'string' ? `USING ${displayIdent(c)}: ${l}` : r as string;
        else pairs.push([l, r]);
      }
    } else {
      for (const [a, b] of j.condition.pairs) {
        const la = resolve(a.column_names, j.leftRels), rb = resolve(b.column_names, [j.right]);
        const lb = resolve(b.column_names, j.leftRels), ra = resolve(a.column_names, [j.right]);
        if (typeof la !== 'string' && typeof rb !== 'string') pairs.push([la, rb]);
        else if (typeof lb !== 'string' && typeof ra !== 'string') pairs.push([lb, ra]);
        else problem = `join condition ${a.column_names.map(displayIdent).join('.')} = ${b.column_names.map(displayIdent).join('.')} does not compare a left-side column with a column of ${j.right.ref}`;
      }
    }
    pairsByJoin.set(j.index, pairs);
    const show = (c: ResolvedCol) => `${displayIdent(c.rel.ref)}.${displayIdent(c.column)}`;
    report.keys = pairs.map(([l, r]) => ({ left: show(l), right: show(r), type: l.type === r.type ? l.type : `${l.type} vs ${r.type}` }));
    if (problem) {
      inconclusive('join-key-unresolved', `Join ${j.index}: ${problem}.`, { join: j.index });
      upstreamKnown = false;
      continue;
    }
    const mismatch = pairs.filter(([l, r]) => l.type !== r.type);
    if (mismatch.length) {
      inconclusive('join-key-type-mismatch', `Join ${j.index}: key types differ (${mismatch.map(([l, r]) => `${show(l)} ${l.type} vs ${show(r)} ${r.type}`).join('; ')}). Implicit casts change matching semantics, so the join is not analysed.`, { join: j.index });
      upstreamKnown = false;
      continue;
    }
    const nonInteger = pairs.filter(([l]) => !(l.type in INTEGER_WIDTH));
    if (scope === 'mvp' && nonInteger.length) {
      // Text keys may carry collations that DESCRIBE does not show (Codex H2); outside the MVP scope.
      return early('unsupported', [{ category: 'unsupported', code: 'unsupported-construct', message: `Join keys of type ${[...new Set(nonInteger.map(([l]) => l.type))].join(', ')} are not supported by the MVP analyser (only same-type integer keys; text keys may use collations that change equality). No data conclusions are drawn.`, evidence: { construct: 'non-integer join key', detail: nonInteger.map(([l, r]) => `${show(l)} = ${show(r)} (${l.type})`).join(', ') } }],
        'the join keys are outside the MVP scope', { relations });
    }
    // Grouping work is bounded by the input rows, the key width and the number of groups; a
    // DISTINCT ... LIMIT pre-check would itself run the full grouping, so none is used (H-B).
    resources.keyColumns = Math.max(resources.keyColumns, pairs.length);
    if (pairs.length > maxKeyColumns) {
      inconclusive('too-many-key-columns', `Join ${j.index}: ${pairs.length} key columns exceed the limit of ${maxKeyColumns}.`, { join: j.index });
      upstreamKnown = false;
      continue;
    }
    const fixed = pairs.every(([l]) => l.type in INTEGER_WIDTH);
    const keyBytes = pairs.reduce((s, [l]) => s + (l.type in INTEGER_WIDTH ? BigInt(INTEGER_WIDTH[l.type]!) : NOMINAL_VARIABLE_KEY_BYTES), 0n);
    resources.keyBytesPerRow = fixed && resources.keyBytesPerRow !== null ? Math.max(resources.keyBytesPerRow, Number(keyBytes)) : null;
    const prev = j.index > 0 ? joinReports[j.index - 1]?.derived : null;
    const leftRows = j.index === 0 ? inputRows.get(ir.base.ref) : prev ? BigInt(prev.outputRows) : null;
    const rightRows = inputRows.get(j.right.ref);
    if (leftRows == null || rightRows == null) {
      inconclusive('depends-on-unknown', `Join ${j.index}: input sizes are unknown (fail-closed).`, { join: j.index });
      upstreamKnown = false;
      continue;
    }
    const perGroup = keyBytes + 16n + GROUP_ENTRY_OVERHEAD_BYTES;
    const est = { left: leftRows * perGroup, right: rightRows * perGroup };
    resources.estimatedGroupingBytes[`join ${j.index} left`] = String(est.left);
    resources.estimatedGroupingBytes[`join ${j.index} right`] = String(est.right);
    if (est.left > maxGrouping || est.right > maxGrouping) {
      inconclusive('grouping-state-over-budget', `Join ${j.index}: the estimated grouping state (${est.left > est.right ? est.left : est.right} bytes, from ${leftRows > rightRows ? leftRows : rightRows} rows × ${perGroup} bytes per possible group) exceeds the budget of ${maxGrouping} bytes. The join is not analysed; no grouping was run.`, { join: j.index, evidence: { leftRows: String(leftRows), rightRows: String(rightRows), bytesPerGroup: String(perGroup), maxGroupingStateBytes: String(maxGrouping), estimate: 'upper-bound estimate, not a measurement' } });
      upstreamKnown = false;
      continue;
    }
    try {
      const outcome = await analyseJoin(ctx, ir, j, pairs, budget);
      Object.assign(report, outcome.report);
      if (outcome.inconclusive) {
        inconclusive(outcome.inconclusive.code, outcome.inconclusive.message, { join: j.index, evidence: outcome.inconclusive.evidence });
        upstreamKnown = false;
        continue;
      }
      const s = outcome.stats!;
      const d = derive(j.type, s);
      validated[validated.length - 1] = s;
      fingerprints.push({ join: j.index, ...outcome.fingerprint! });
      findings.push(...joinFindings(j.index, j.type, s, d));
      checked.push(`join ${j.index} (${j.type}): cardinality, duplicates, unmatched and NULL keys from key frequencies, validated by invariants, SEMI JOIN${report.validation.executedCount === 'agreed' ? ', an executed count' : ''} and verified witnesses`);
      if (d.outputRows > budget) upstreamKnown = false;
    } catch (e) {
      if (isTerminal(e)) throw e;
      findings.push({ category: 'diagnostic-failure', code: 'join-statistics-failed', join: j.index, message: `Join ${j.index}: a diagnostic statement failed (${msg(e)}). The join is not analysed; this does not mean the user's query fails.` });
      upstreamKnown = false;
    }
  }

  // 7. snapshot verification: inputs at the end must equal inputs at the start (H-A)
  let snapshotChanged: string[] = [];
  if (fingerprints.length && !ctx.abortedBy) {
    try {
      for (const f of fingerprints) {
        const l = await ctx.one(fingerprintSql(f.lSql, f.keys), 4);
        const r = await ctx.one(fingerprintSql(f.rSql, f.keys), 4);
        if (l.join('|') !== f.left.join('|')) snapshotChanged.push(`join ${f.join} left input`);
        if (r.join('|') !== f.right.join('|')) snapshotChanged.push(`join ${f.join} right input`);
      }
      snapshotChanged.push(...(await relationIdentities(ctx, relations)).map((ref) => `relation ${ref} identity`));
    } catch (e) {
      if (isTerminal(e)) throw e;
      snapshotChanged = [`verification failed: ${msg(e)}`];
    }
    if (!snapshotChanged.length) for (const f of fingerprints) joinReports[f.join]!.validation.snapshot = 'verified';
  }
  if (snapshotChanged.length) {
    // Withdraw every join statistic: evidence from different snapshots must not be combined.
    for (let i = findings.length - 1; i >= 0; i--) if (findings[i]!.join !== undefined && findings[i]!.category !== 'inconclusive' && findings[i]!.category !== 'diagnostic-failure') findings.splice(i, 1);
    for (const jr of joinReports) {
      if (jr.stats) jr.validation.snapshot = 'changed';
      jr.stats = null;
      jr.derived = null;
      jr.samples = null;
    }
    validated.fill(null);
    inconclusive('snapshot-inconsistent', `The input data changed during the analysis (${snapshotChanged.join('; ')}). All join statistics are withdrawn; no conclusions are drawn.`, { evidence: { changed: snapshotChanged } });
    resources.statements = ctx.sql.length;
    return finish({ scope, status: 'inconclusive', findings, expectations, evaluated, ctx, uncheckedReason: 'the input snapshot could not be verified', relations, resources, joins: joinReports, checked, notChecked });
  }

  // 8. stages
  const stages: Stage[] = [];
  if (joinReports[0]?.stats) stages.push({ stage: `FROM ${ir.base.ref}`, rows: joinReports[0].stats.leftRows, method: 'frequency-formula' });
  for (const jr of joinReports) if (jr.derived) stages.push({ stage: `after join ${jr.index} (${jr.type} ${jr.right})`, rows: jr.derived.outputRows, method: 'frequency-formula' });
  for (let i = 0; i + 1 < joinReports.length; i++) {
    const a = joinReports[i]!, b = joinReports[i + 1]!;
    if (a.derived && b.stats && a.derived.outputRows !== b.stats.leftRows) {
      inconclusive('internal-inconsistency', `Computed output of join ${a.index} (${a.derived.outputRows}) differs from the executed input of join ${b.index} (${b.stats.leftRows}). Findings for these joins are not trustworthy.`);
    }
  }
  const allJoinsValid = validated.every((s) => s !== null) && validated.length === ir.joins.length;
  const maxOut = joinReports.reduce((m, r) => (r.derived && BigInt(r.derived.outputRows) > m ? BigInt(r.derived.outputRows) : m), 0n);
  const canExecute = allJoinsValid && upstreamKnown && maxOut <= budget;
  if (!canExecute && scope === 'experimental') {
    notChecked.push('count-only probes (WHERE and final counts), outer-join/WHERE check, grain and metric expectations: every join must be validated and within the execution budget (fail-closed)');
  }
  /** Optional checks: a failure is inconclusive for that check only; validated evidence is kept (M5). */
  const optional = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (ctx.abortedBy) {
      notChecked.push(`${name} (not run: an earlier diagnostic failed inside the analysis transaction)`);
      return undefined;
    }
    try {
      return await fn();
    } catch (e) {
      if (isTerminal(e)) throw e;
      inconclusive('optional-check-failed', `${name}: a diagnostic statement failed (${msg(e)}). This check is inconclusive; other validated evidence is unaffected.`);
      notChecked.push(`${name} (diagnostic failed)`);
      return undefined;
    }
  };

  let finalRows: bigint | null = null;
  if (scope === 'mvp' && allJoinsValid && joinReports[0]?.derived) {
    finalRows = BigInt(joinReports[0].derived.outputRows); // MVP: projection only, result rows = join rows
    stages.push({ stage: 'final result', rows: String(finalRows), method: 'frequency-formula' });
  }
  if (scope === 'experimental' && canExecute) {
    if (ir.where) {
      await optional('rows remaining after WHERE', async () => {
        stages.push({ stage: 'after WHERE', rows: String(await ctx.count(await ctx.toSql(selectNode({ select: [constInt(1)], from: ir.fromTree, where: ir.where, cteMap: ir.cteMap })))), method: 'count-only-probe' });
        checked.push('rows remaining after WHERE (count-only probe)');
      });
    }
    await optional('final result row count', async () => {
      finalRows = await ctx.count(sqlText);
      stages.push({ stage: 'final result', rows: String(finalRows), method: 'count-only-probe' });
      checked.push('final result row count (count-only probe; does not evaluate the SELECT list)');
    });
    await outerJoinWhere(ctx, ir, joinReports, pairsByJoin, resolve, findings, checked, notChecked, optional);
  }

  // 9. expectations: every expectation gets exactly one outcome
  for (const [index, e] of expectations.entries()) {
    if (invalidExpectation(e)) continue; // reported as invalid by completeOutcomes
    const out = await optional(`expectation ${index} (${e.kind})`, () => evaluateExpectation(ctx, ir, scope, e, joinReports, validated, finalRows, canExecute, sqlText, resolve));
    if (out) evaluated.set(index, { ...out, index });
  }

  // 10. CTEs (experimental)
  const ctes: AnalysisReport['ctes'] = [];
  if (scope === 'experimental' && (o.depth ?? 0) < 3) {
    for (const c of ir.ctes) {
      const cteSql = await ctx.toSql({ ...c.node, cte_map: c.precedingMap });
      ctes.push({ name: c.name, report: await analyze(ctx.exec, cteSql, [], { ...o, depth: (o.depth ?? 0) + 1 }) });
      checked.push(`CTE ${c.name} analysed as its own query`);
    }
  }

  const has = (c: Finding['category']) => findings.some((f) => f.category === c);
  const status: AnalysisReport['status'] = has('diagnostic-failure') ? 'diagnostic-failed'
    : has('inconclusive') || ctes.some((c) => c.report.status !== 'analyzed') ? 'partially-analyzed' : 'analyzed';
  resources.statements = ctx.sql.length;
  return finish({
    scope, status, findings, expectations, evaluated, ctx, relations, resources, joins: joinReports, stages, ctes, checked, notChecked,
    uncheckedReason: 'it could not be evaluated (see findings)',
  });
}

/**
 * rows, NULL-key rows, sum(hash(keys)) and bit_xor(hash(keys)) of one join side: an
 * order-independent fingerprint of the key multiset (not cryptographic; it detects changes, it
 * cannot prove their absence on its own; exclusive ownership and the transaction do that).
 */
function fingerprintSql(src: string, keys: string[]): string {
  const anyNull = keys.map((k) => `${k} IS NULL`).join(' OR ');
  return `SELECT count(*)::VARCHAR, (count(*) FILTER (WHERE ${anyNull}))::VARCHAR, coalesce(sum(hash(${keys.join(', ')})), 0)::VARCHAR, coalesce(bit_xor(hash(${keys.join(', ')})), 0)::VARCHAR FROM (${src})`;
}

/** Frequencies once (temp tables), statistics, invariants, SEMI JOIN, executed count and witness verification. */
async function analyseJoin(
  ctx: Ctx, ir: QueryIR, j: QueryIR['joins'][number], pairs: Pair[], budget: bigint,
): Promise<{ report: Partial<JoinReport>; stats?: JoinStats; fingerprint?: { keys: string[]; lSql: string; rSql: string; left: Fingerprint; right: Fingerprint }; inconclusive?: { code: string; message: string; evidence?: Record<string, unknown> } }> {
  const n = pairs.length;
  const ks = Array.from({ length: n }, (_, i) => `k${i}`);
  const notNull = ks.map((k) => `${k} IS NOT NULL`).join(' AND ');
  const lSql = await ctx.toSql(selectNode({ select: pairs.map(([l], i) => colRef([l.rel.ref, l.column], `k${i}`)), from: j.leftTree, cteMap: ir.cteMap }));
  const rSql = await ctx.toSql(selectNode({ select: pairs.map(([, r], i) => colRef([r.rel.ref, r.column], `k${i}`)), from: baseTableNode(j.right), cteMap: ir.cteMap }));

  // totals and the start fingerprint of each side's key multiset
  const leftFp = await ctx.one(fingerprintSql(lSql, ks), 4);
  const rightFp = await ctx.one(fingerprintSql(rSql, ks), 4);
  const [leftRows, leftNullKeyRows] = leftFp.slice(0, 2).map(parseBig);
  const [rightRows, rightNullKeyRows] = rightFp.slice(0, 2).map(parseBig);
  const token = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const lf = `__qv_${token}_lf`, rf = `__qv_${token}_rf`;
  ctx.temps.push(lf, rf);
  await ctx.run(`CREATE TEMP TABLE ${lf} AS SELECT ${ks.join(', ')}, count(*)::HUGEINT AS c FROM (${lSql}) WHERE ${notNull} GROUP BY ${ks.join(', ')}`, { maxRows: 1 });
  await ctx.run(`CREATE TEMP TABLE ${rf} AS SELECT ${ks.join(', ')}, count(*)::HUGEINT AS c FROM (${rSql}) WHERE ${notNull} GROUP BY ${ks.join(', ')}`, { maxRows: 1 });
  const on = ks.map((k) => `${lf}.${k} = ${rf}.${k}`).join(' AND ');
  const v = (e: string) => `(${e})::VARCHAR`;
  const fields = await ctx.one(`WITH m AS MATERIALIZED (SELECT ${lf}.c AS lc, ${rf}.c AS rc FROM ${lf} JOIN ${rf} ON ${on})
SELECT ${[
    v(`SELECT coalesce(sum(c), 0) FROM ${lf}`), v(`SELECT coalesce(sum(c), 0) FROM ${rf}`),
    v(`SELECT count(*) FROM ${lf}`), v(`SELECT count(*) FROM ${rf}`),
    v(`SELECT count(*) FROM ${lf} WHERE c > 1`), v(`SELECT count(*) FROM ${rf} WHERE c > 1`),
    v(`SELECT coalesce(max(c), 0) FROM ${lf}`), v(`SELECT coalesce(max(c), 0) FROM ${rf}`),
    v('SELECT coalesce(max(lc), 0) FROM m'), v('SELECT coalesce(max(rc), 0) FROM m'),
    v('SELECT count(*) FROM m'), v('SELECT coalesce(sum(lc * rc), 0) FROM m'),
    v('SELECT coalesce(sum(lc), 0) FROM m'), v('SELECT coalesce(sum(rc), 0) FROM m'),
    v('SELECT coalesce(sum(lc) FILTER (WHERE rc > 1), 0) FROM m'), v('SELECT coalesce(sum(lc * (rc - 1)) FILTER (WHERE rc > 1), 0) FROM m'),
    v('SELECT coalesce(sum(rc) FILTER (WHERE lc > 1), 0) FROM m'), v('SELECT coalesce(sum(rc * (lc - 1)) FILTER (WHERE lc > 1), 0) FROM m'),
  ].join(',\n  ')}`, 18);
  const [leftKeyedRows, rightKeyedRows, leftDistinctKeys, rightDistinctKeys, leftDuplicateKeys, rightDuplicateKeys, leftMaxMultiplicity, rightMaxMultiplicity,
    leftMaxMultiplicityMatched, rightMaxMultiplicityMatched, matchedKeys, matchedPairs, leftRowsMatched, rightRowsMatched,
    leftRowsMultiplied, leftExcessCopies, rightRowsMultiplied, rightExcessCopies] = fields.map(parseBig);
  const stats: JoinStats = {
    leftRows: leftRows!, rightRows: rightRows!, leftNullKeyRows: leftNullKeyRows!, rightNullKeyRows: rightNullKeyRows!,
    leftKeyedRows: leftKeyedRows!, rightKeyedRows: rightKeyedRows!, leftDistinctKeys: leftDistinctKeys!, rightDistinctKeys: rightDistinctKeys!,
    leftDuplicateKeys: leftDuplicateKeys!, rightDuplicateKeys: rightDuplicateKeys!, leftMaxMultiplicity: leftMaxMultiplicity!, rightMaxMultiplicity: rightMaxMultiplicity!,
    leftMaxMultiplicityMatched: leftMaxMultiplicityMatched!, rightMaxMultiplicityMatched: rightMaxMultiplicityMatched!, matchedKeys: matchedKeys!, matchedPairs: matchedPairs!,
    leftRowsMatched: leftRowsMatched!, rightRowsMatched: rightRowsMatched!, leftRowsMultiplied: leftRowsMultiplied!, leftExcessCopies: leftExcessCopies!,
    rightRowsMultiplied: rightRowsMultiplied!, rightExcessCopies: rightExcessCopies!,
  };
  const validation: JoinReport['validation'] = { invariants: 'held', invariantViolations: [], semiJoin: 'not-run', executedCount: 'not-run', witnesses: 'not-run', snapshot: 'not-run' };
  const fail = (code: string, message: string, evidence: Record<string, unknown>) => ({ report: { validation }, inconclusive: { code, message, evidence } });

  // invariants
  const violations = checkInvariants(stats);
  if (violations.length) {
    validation.invariants = 'violated';
    validation.invariantViolations = violations;
    return fail('invariant-violated', `Join ${j.index}: the key-frequency statistics violate ${violations.length} mathematical invariant(s), so the frequency model does not match this join's semantics. All findings for this join are suppressed.`, { violations });
  }
  // SEMI JOIN with the query's own join node: engine semantics, no pair enumeration.
  const joinNode = findJoinNode(ir.fromTree, j.index);
  const semi = (left: Json, right: Json) => selectNode({ select: [constInt(1)], from: { ...joinNode, left, right, join_type: 'SEMI' }, cteMap: ir.cteMap });
  const leftSemi = await ctx.count(await ctx.toSql(semi(j.leftTree, joinNode.right)));
  const rightSemi = await ctx.count(await ctx.toSql(semi(joinNode.right, j.leftTree)));
  if (leftSemi !== stats.leftRowsMatched || rightSemi !== stats.rightRowsMatched) {
    validation.semiJoin = 'disagreed';
    return fail('semantic-mismatch', `Join ${j.index}: grouping by key does not reproduce the join's matching (SEMI JOIN matched ${leftSemi} left / ${rightSemi} right rows; key frequencies ${stats.leftRowsMatched} / ${stats.rightRowsMatched}). This happens with collations, volatile inputs or other comparison semantics. All findings for this join are suppressed.`, { semiJoinLeftRowsMatched: String(leftSemi), semiJoinRightRowsMatched: String(rightSemi), frequencyLeftRowsMatched: String(stats.leftRowsMatched), frequencyRightRowsMatched: String(stats.rightRowsMatched) });
  }
  validation.semiJoin = 'agreed';
  // executed count of the join itself, only within budget
  const d = derive(j.type, stats);
  if (d.outputRows <= budget) {
    const actual = await ctx.count(await ctx.toSql(selectNode({ select: [constInt(1)], from: joinNode, cteMap: ir.cteMap })));
    if (actual !== d.outputRows) {
      validation.executedCount = 'disagreed';
      return fail('semantic-mismatch', `Join ${j.index}: the computed output (${d.outputRows} rows) differs from the executed count (${actual}). All findings for this join are suppressed.`, { computed: String(d.outputRows), executed: String(actual) });
    }
    validation.executedCount = 'agreed';
  } else {
    validation.executedCountSkippedReason = `computed output ${d.outputRows} exceeds the execution budget ${budget}`;
  }
  // bounded witnesses (at most 5 of each kind)
  const kv = (t: string) => ks.map((k) => `${t}.${k}::VARCHAR`).join(', ');
  const order = (t: string) => ks.map((k) => `${t}.${k}`).join(', ');
  const samples = {
    fanOutKeys: await ctx.run(`SELECT ${kv(lf)}, ${lf}.c::VARCHAR, ${rf}.c::VARCHAR FROM ${lf} JOIN ${rf} ON ${on} WHERE ${rf}.c > 1 OR ${lf}.c > 1 ORDER BY ${lf}.c * ${rf}.c DESC, ${order(lf)} LIMIT 5`, { columns: n + 2, maxRows: 5 }),
    unmatchedLeftKeys: await ctx.run(`SELECT ${kv(lf)}, ${lf}.c::VARCHAR FROM ${lf} ANTI JOIN ${rf} USING (${ks.join(', ')}) ORDER BY ${order(lf)} LIMIT 5`, { columns: n + 1, maxRows: 5 }),
    unmatchedRightKeys: await ctx.run(`SELECT ${kv(rf)}, ${rf}.c::VARCHAR FROM ${rf} ANTI JOIN ${lf} USING (${ks.join(', ')}) ORDER BY ${order(rf)} LIMIT 5`, { columns: n + 1, maxRows: 5 }),
  };
  // Witness identity: each sampled key, re-counted on the inputs and through the query's own join
  // node, must produce exactly the rows the frequency tables claim (not only matching totals).
  const mismatch = await verifyWitnesses(ctx, ir, j, joinNode, pairs, lSql, rSql, samples);
  if (mismatch.length) {
    validation.witnesses = 'mismatch';
    return fail('witness-mismatch', `Join ${j.index}: ${mismatch.length} witness check(s) disagree with the key frequencies (${mismatch.slice(0, 3).join('; ')}). All findings for this join are suppressed.`, { mismatches: mismatch });
  }
  validation.witnesses = 'verified';
  return {
    stats,
    fingerprint: { keys: ks, lSql, rSql, left: leftFp, right: rightFp },
    report: {
      validation, samples,
      stats: Object.fromEntries(STAT_FIELDS.map((k) => [k, String(stats[k])])) as JoinReport['stats'],
      derived: {
        outputRows: String(d.outputRows), leftUnmatchedRows: String(d.leftUnmatchedRows), rightUnmatchedRows: String(d.rightUnmatchedRows),
        leftRowsDropped: String(d.leftRowsDropped), rightRowsDropped: String(d.rightRowsDropped), relationship: d.relationship, effectiveRelationship: d.effectiveRelationship,
      },
    },
  };
}

/** Re-counts every witness key on the inputs and through the join; returns the disagreements. */
async function verifyWitnesses(
  ctx: Ctx, ir: QueryIR, j: QueryIR['joins'][number], joinNode: Json, pairs: Pair[], lSql: string, rSql: string,
  samples: { fanOutKeys: string[][]; unmatchedLeftKeys: string[][]; unmatchedRightKeys: string[][] },
): Promise<string[]> {
  const n = pairs.length;
  const total = samples.fanOutKeys.length + samples.unmatchedLeftKeys.length + samples.unmatchedRightKeys.length;
  if (!total) return [];
  const jSql = await ctx.toSql(selectNode({
    select: [...pairs.map(([l], i) => colRef([l.rel.ref, l.column], `__l${i}`)), ...pairs.map(([, r], i) => colRef([r.rel.ref, r.column], `__r${i}`))],
    from: joinNode, cteMap: ir.cteMap,
  }));
  const lit = (vals: string[], i: number) => `CAST(${q(vals[i]!)} AS ${pairs[i]![0].type})`;
  const match = (prefix: string, vals: string[]) => Array.from({ length: n }, (_, i) => `${prefix}${i} = ${lit(vals, i)}`).join(' AND ');
  const keysMatch = (vals: string[]) => Array.from({ length: n }, (_, i) => `k${i} = ${lit(vals, i)}`).join(' AND ');
  const preservesLeft = j.type === 'LEFT' || j.type === 'FULL';
  const preservesRight = j.type === 'RIGHT' || j.type === 'FULL';
  const checks: { label: string; sql: string; expected: bigint }[] = [];
  for (const r of samples.fanOutKeys) {
    const vals = r.slice(0, n), lc = BigInt(r[n]!), rc = BigInt(r[n + 1]!);
    checks.push({ label: `fan-out key (${vals.join(', ')}) join rows`, sql: `SELECT count(*) FROM (${jSql}) WHERE ${match('__l', vals)}`, expected: lc * rc });
    checks.push({ label: `fan-out key (${vals.join(', ')}) left rows`, sql: `SELECT count(*) FROM (${lSql}) WHERE ${keysMatch(vals)}`, expected: lc });
    checks.push({ label: `fan-out key (${vals.join(', ')}) right rows`, sql: `SELECT count(*) FROM (${rSql}) WHERE ${keysMatch(vals)}`, expected: rc });
  }
  for (const r of samples.unmatchedLeftKeys) {
    const vals = r.slice(0, n), c = BigInt(r[n]!);
    checks.push({ label: `unmatched left key (${vals.join(', ')}) left rows`, sql: `SELECT count(*) FROM (${lSql}) WHERE ${keysMatch(vals)}`, expected: c });
    checks.push({ label: `unmatched left key (${vals.join(', ')}) right rows`, sql: `SELECT count(*) FROM (${rSql}) WHERE ${keysMatch(vals)}`, expected: 0n });
    checks.push({ label: `unmatched left key (${vals.join(', ')}) join rows`, sql: `SELECT count(*) FROM (${jSql}) WHERE ${match('__l', vals)}`, expected: preservesLeft ? c : 0n });
  }
  for (const r of samples.unmatchedRightKeys) {
    const vals = r.slice(0, n), c = BigInt(r[n]!);
    checks.push({ label: `unmatched right key (${vals.join(', ')}) right rows`, sql: `SELECT count(*) FROM (${rSql}) WHERE ${keysMatch(vals)}`, expected: c });
    checks.push({ label: `unmatched right key (${vals.join(', ')}) left rows`, sql: `SELECT count(*) FROM (${lSql}) WHERE ${keysMatch(vals)}`, expected: 0n });
    checks.push({ label: `unmatched right key (${vals.join(', ')}) join rows`, sql: `SELECT count(*) FROM (${jSql}) WHERE ${match('__r', vals)}`, expected: preservesRight ? c : 0n });
  }
  const rows = await ctx.run(checks.map((c, i) => `SELECT ${i} AS i, (${c.sql})::VARCHAR AS n`).join('\nUNION ALL '), { columns: 2, maxRows: checks.length, exactRows: checks.length });
  const got = new Map(rows.map((r) => [Number(r[0]), parseBig(r[1])]));
  return checks.flatMap((c, i) => (got.get(i) === c.expected ? [] : [`${c.label}: expected ${c.expected}, found ${got.get(i) ?? 'nothing'}`]));
}

/** The JOIN node for join `index` in a left-deep FROM tree. */
function findJoinNode(from: Json, index: number): Json {
  const chain: Json[] = [];
  for (let t = from; t?.type === 'JOIN'; t = t.left) chain.unshift(t);
  const node = chain[index];
  if (!node) throw new DiagnosticError('shape', `join ${index} not found in FROM`);
  return node;
}

/** Experimental: rows produced for unmatched rows of an outer join and then removed by WHERE (measured). */
async function outerJoinWhere(
  ctx: Ctx, ir: QueryIR, joinReports: JoinReport[], pairsByJoin: Map<number, Pair[]>, resolve: (n: string[], c: Rel[]) => ResolvedCol | string,
  findings: Finding[], checked: string[], notChecked: string[], optional: <T>(name: string, fn: () => Promise<T>) => Promise<T | undefined>,
) {
  if (!ir.where) return;
  // Which relations does WHERE reference? Structural, from resolved column references.
  const whereRels = new Set<string>();
  let whereUnresolved = false;
  walkExpr(ir.where, (n) => {
    if (n.class === 'COLUMN_REF') {
      const r = resolve(n.column_names, ir.rels);
      if (typeof r === 'string') whereUnresolved = true;
      else whereRels.add(r.rel.ref);
    }
  });
  for (const j of ir.joins) {
    const jr = joinReports[j.index];
    const pairs = pairsByJoin.get(j.index);
    if (!jr?.derived || !pairs?.length || j.type === 'INNER') continue;
    if (ir.joins.some((x) => x.index > j.index && (x.type === 'RIGHT' || x.type === 'FULL'))) {
      notChecked.push(`join ${j.index}: rows removed by WHERE (a later RIGHT/FULL join makes NULL-extension ambiguous)`);
      continue;
    }
    for (const preserved of j.type === 'LEFT' ? ['left'] as const : j.type === 'RIGHT' ? ['right'] as const : ['left', 'right'] as const) {
      await optional(`join ${j.index}: rows kept for unmatched ${preserved}-side rows and then removed by WHERE`, async () => {
        // A row produced for an unmatched preserved-side row has NULL in the other side's join key
        // (keys never match NULL), so the key is an exact marker for these rows. The key is the
        // structured (relation, column) pair: identifiers are never split from text (M5).
        const [lk, rk] = pairs[0]!;
        const markerKey = preserved === 'left' ? rk : lk;
        const marker = isNull(colRef([markerKey.rel.ref, markerKey.column]));
        const before = await ctx.count(await ctx.toSql(selectNode({ select: [constInt(1)], from: ir.fromTree, where: marker, cteMap: ir.cteMap })));
        const after = await ctx.count(await ctx.toSql(selectNode({ select: [constInt(1)], from: ir.fromTree, where: and(ir.where, marker), cteMap: ir.cteMap })));
        checked.push(`join ${j.index}: rows kept for unmatched ${preserved}-side rows and then removed by WHERE (count-only probes)`);
        if (before <= after) return;
        const preservedRels = new Set((preserved === 'left' ? j.leftRels : [j.right]).map((r) => r.ref));
        const nullSide = new Set((preserved === 'left' ? [j.right] : j.leftRels).map((r) => r.ref));
        const refs = [...whereRels];
        const evidence = { preservedSide: preserved, rowsForUnmatchedBeforeWhere: String(before), removedByWhere: String(before - after), whereReferences: refs, whereHasUnresolvedReferences: whereUnresolved };
        const base = `The ${j.type} JOIN (join ${j.index}) produced ${before} row(s) for unmatched ${preserved}-side rows; WHERE removed ${before - after} of them`;
        if (!whereUnresolved && refs.length && refs.every((r) => nullSide.has(r))) {
          findings.push({ category: 'suspicious', code: 'where-removes-null-extended-rows', join: j.index, message: `${base}. WHERE references only columns of ${refs.join(', ')}, which are NULL in all of those rows.`, evidence });
        } else if (!whereUnresolved && refs.length && refs.every((r) => preservedRels.has(r))) {
          findings.push({ category: 'observed', code: 'where-filters-preserved-side', join: j.index, message: `${base}. WHERE references only columns of the preserved side (${refs.join(', ')}), so it filters those rows on their own values.`, evidence });
        } else {
          findings.push({ category: 'observed', code: 'where-removes-outer-join-rows', join: j.index, message: `${base}.`, evidence });
        }
      });
    }
  }
}

async function evaluateExpectation(
  ctx: Ctx, ir: QueryIR, scope: Scope, e: Expectation, joinReports: JoinReport[], validated: (JoinStats | null)[],
  finalRows: bigint | null, canExecute: boolean, sqlText: string, resolve: (n: string[], c: Rel[]) => ResolvedCol | string,
): Promise<Omit<ExpectationOutcome, 'index'>> {
  const unchecked = (reason: string, evidence?: Record<string, unknown>): Omit<ExpectationOutcome, 'index'> => ({ expectation: e, outcome: 'unchecked', reason, ...(evidence ? { evidence } : {}) });
  if (e.kind === 'relationship' || e.kind === 'no-row-loss' || e.kind === 'no-fan-out') {
    if (e.join < 0 || e.join >= ir.joins.length) return unchecked(`join ${e.join} does not exist (the query has ${ir.joins.length} join(s))`);
    const s = validated[e.join];
    const jr = joinReports[e.join];
    if (!s || !jr) return unchecked(`join ${e.join} has no validated statistics`);
    return evaluateJoinExpectation(jr.type, s, derive(jr.type, s), e);
  }
  if (e.kind === 'row-count') {
    if (finalRows === null) return unchecked('the result row count is not known (fail-closed)');
    const ok = (e.min === undefined || finalRows >= BigInt(e.min)) && (e.max === undefined || finalRows <= BigInt(e.max));
    return { expectation: e, outcome: ok ? 'held' : 'violated', reason: ok ? undefined : `Expected between ${e.min ?? '−∞'} and ${e.max ?? '∞'} result rows; the query returns ${finalRows}.`, evidence: { rows: String(finalRows), min: e.min ?? null, max: e.max ?? null } };
  }
  if (scope === 'mvp') return unchecked(`${e.kind} expectations are outside the MVP scope`);
  if (!canExecute) return unchecked('requires executing the query, which is not allowed: every join must be validated and within the execution budget');
  if (e.kind === 'grain') {
    const out = await ctx.run(`DESCRIBE ${sqlText}`, { columns: 6, maxRows: 4096 });
    const names = new Set(out.map((r) => String(r[0]).toLowerCase()));
    const missing = e.columns.filter((c) => !names.has(c.toLowerCase()));
    if (missing.length) return unchecked(`grain columns not in the result: ${missing.join(', ')}`);
    const cols = e.columns.map(ident).join(', ');
    const r = await ctx.one(`SELECT count(*)::VARCHAR, coalesce(sum(n), 0)::VARCHAR FROM (SELECT ${cols}, count(*) AS n FROM (${sqlText}) GROUP BY ${cols} HAVING count(*) > 1)`, 2);
    const dup = parseBig(r[0]);
    return { expectation: e, outcome: dup > 0n ? 'violated' : 'held', reason: dup > 0n ? `Expected one row per (${e.columns.join(', ')}), but ${r[0]} value(s) occur more than once (${r[1]} rows).` : undefined, evidence: { duplicatedGroups: r[0], rowsInDuplicatedGroups: r[1], method: 'executed (evaluates the grouping columns)' } };
  }
  // metric-preserved (experimental). NULL semantics are explicit and separate from tolerance (H4);
  // non-finite totals are never compared (second review M4).
  const ref = parseColumnRef(e.column)!;
  const col = resolve(ref, ir.rels);
  if (typeof col === 'string') return unchecked(`column ${e.column}: ${col}`);
  if (!/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|DECIMAL.*|FLOAT|DOUBLE)$/.test(col.type)) return unchecked(`column ${e.column} is ${col.type}, not numeric`);
  let whereOnlyThisRel = true;
  if (ir.where) walkExpr(ir.where, (n) => {
    if (n.class === 'COLUMN_REF') {
      const r = resolve(n.column_names, ir.rels);
      if (typeof r === 'string' || r.rel.ref !== col.rel.ref) whereOnlyThisRel = false;
    }
  });
  if (!whereOnlyThisRel) return unchecked(`WHERE references other relations, so the source total of ${e.column} is ambiguous`);
  const m = colRef([col.rel.ref, col.column], '__m');
  const sourceSql = await ctx.toSql(selectNode({ select: [m], from: baseTableNode(col.rel), where: ir.where, cteMap: ir.cteMap }));
  const joinedSql = await ctx.toSql(selectNode({ select: [m], from: ir.fromTree, where: ir.where, cteMap: ir.cteMap }));
  const tol = e.tolerance ?? 0;
  const nz = (x: string) => (e.nullAsZero ? `coalesce(${x}, 0)` : x);
  const bound = `(${tol} * greatest(abs(${nz('s')}::DOUBLE), 1))`;
  const cmp = tol > 0 ? `abs(${nz('j')}::DOUBLE - ${nz('s')}::DOUBLE) <= ${bound}` : `${nz('j')} = ${nz('s')}`;
  const finite = (x: string) => `(${x} IS NULL OR isfinite((${x})::DOUBLE))`;
  const r = await ctx.one(`SELECT s::VARCHAR, j::VARCHAR, (j - s)::VARCHAR, (s IS NULL)::VARCHAR, (j IS NULL)::VARCHAR, (${cmp})::VARCHAR,
  (${finite('s')} AND ${finite('j')})::VARCHAR, (${finite('j - s')} AND ${tol > 0 ? finite(bound) : 'true'})::VARCHAR
FROM (SELECT (SELECT sum(__m) FROM (${sourceSql})) AS s, (SELECT sum(__m) FROM (${joinedSql})) AS j)`, 8);
  const [s, jv, diff, sNull, jNull, equal, totalsFinite, arithmeticFinite] = r;
  const evidence = { sourceTotal: s, joinedTotal: jv, difference: diff, tolerance: tol, nullAsZero: e.nullAsZero === true, nullSemantics: e.nullAsZero ? 'NULL totals treated as 0 (declared)' : 'NULL total means no non-NULL values; NULL equals only NULL' };
  if (totalsFinite !== 'true') return unchecked(`a total is not a finite number (source ${s}, joined ${jv}); non-finite totals are not compared`, evidence);
  if (arithmeticFinite !== 'true') return unchecked(`the difference or tolerance bound is not a finite number (difference ${diff}); the comparison is not evaluated`, evidence);
  let held: boolean;
  if (!e.nullAsZero && (sNull === 'true' || jNull === 'true')) held = sNull === 'true' && jNull === 'true';
  else held = equal === 'true';
  return {
    expectation: e, outcome: held ? 'held' : 'violated', evidence,
    reason: held ? undefined : `Expected SUM(${displayIdent(col.rel.ref)}.${displayIdent(col.column)}) after the joins (${jv}) to equal its source total (${s})${tol ? ` within a relative tolerance of ${tol}` : ''}.`,
  };
}

// ---------------------------------------------------------------- exclusive session analysis (H-A, H-B)

/** What analyzeInSession needs from EngineSession (or a stand-in). */
export interface ExclusiveSession {
  exclusive<T>(fn: (batch: BatchLike) => Promise<T>): Promise<T>;
}

export interface SessionAnalysisOptions extends AnalyzeOptions, Pick<ExecutorOptions, 'cancelGraceMs' | 'cleanupMs' | 'testHooks'> {
  /** Analysis-wide deadline, including the wait for exclusive ownership. Default 30 s. */
  deadlineMs?: number;
}

/**
 * Runs the analysis with exclusive ownership of the session, inside one transaction on one engine
 * generation, and always rolls back (the analyser's temp tables go with the transaction).
 * Returns within deadlineMs + 2 × cancelGraceMs + cleanupMs + 1 s on every path; when the engine
 * cannot be stopped in time the worker is terminated and the session recovers in the background.
 */
export async function analyzeInSession(session: ExclusiveSession, userSql: string, expectations: Expectation[] = [], options: SessionAnalysisOptions = {}): Promise<AnalysisReport> {
  const scope: Scope = options.scope ?? 'mvp';
  const deadlineMs = options.deadlineMs ?? 30_000;
  const grace = options.cancelGraceMs ?? 2_000;
  const cleanupMs = options.cleanupMs ?? 5_000;
  const deadlineAt = performance.now() + deadlineMs;
  const outer = new Ctx({ query: () => Promise.reject(new Error('unused')) });
  let abandoned = false;
  let live: BatchLike | null = null;
  let markStarted!: () => void;
  const started = new Promise<'started'>((r) => (markStarted = () => r('started')));

  const work = session.exclusive(async (batch): Promise<AnalysisReport | null> => {
    if (abandoned) return null; // the caller already returned (queue wait exceeded the deadline)
    live = batch;
    markStarted();
    const exec = batchExecutor(batch, { deadlineAt, cancelGraceMs: grace, cleanupMs, testHooks: options.testHooks });
    const ctx = new Ctx(exec);
    try {
      await ctx.run('BEGIN TRANSACTION', { maxRows: 1 });
    } catch (e) {
      if (isTerminal(e)) return failure(scope, e, ctx, expectations);
      return finish({ scope, status: 'inconclusive', ctx, expectations, uncheckedReason: 'the analysis could not open its own transaction',
        findings: [{ category: 'inconclusive', code: 'transaction-unavailable', message: `The analysis needs its own transaction to establish one stable snapshot, but could not open it (${msg(e)}). If a transaction is open in this session, commit or roll it back first. No conclusions are drawn.` }] });
    }
    let report: AnalysisReport;
    let rollback: unknown = 'ok';
    try {
      report = await analyze({ query: exec.query, cleanup: exec.cleanup, snapshot: { isCurrent: () => batch.isCurrent() } }, userSql, expectations, options);
    } finally {
      rollback = await exec.cleanup('ROLLBACK');
    }
    report.diagnosticSql.unshift('BEGIN TRANSACTION');
    report.diagnosticSql.push('ROLLBACK');
    if (rollback === 'failed') {
      // The session might still be inside the analysis transaction: do not reuse it.
      if (batch.isCurrent()) batch.invalidate('ROLLBACK of the analysis transaction failed');
      report.findings.push({ category: 'diagnostic-failure', code: 'cleanup-failed', message: 'The analysis transaction could not be rolled back; the engine was restarted. The evidence above is kept for reference but the report is not authoritative.' });
      report.authoritative = false;
      report.nonAuthoritativeReasons.push('cleanup (ROLLBACK) failed; the engine was restarted');
    }
    if (report.authoritative && !batch.isCurrent()) {
      report.authoritative = false;
      report.nonAuthoritativeReasons.push('the engine was replaced before the analysis completed');
    }
    return report;
  });
  const settled = work.then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
  const giveUp = (reason: TerminalInfo['reason'], message: string): AnalysisReport =>
    failure(scope, new BudgetExhaustedError(message, { reason, cancellation: reason === 'queue-wait' ? 'not-needed' : 'terminated' }), outer, expectations);

  // 1. waiting for exclusive ownership counts against the deadline
  const first = await within(Promise.race([settled.then(() => 'done' as const), started]), deadlineAt - performance.now());
  if (first === TIMEOUT) {
    abandoned = true;
    return giveUp('queue-wait', 'the deadline was reached while waiting for exclusive access to the session (another operation was running)');
  }
  // 2. the batch runs; the executor bounds every statement, this bounds the whole batch
  const bound = deadlineAt + 2 * grace + cleanupMs + 1_000 - performance.now();
  const r = await within(settled, bound);
  if (r === TIMEOUT) {
    abandoned = true;
    (live as BatchLike | null)?.invalidate('the analysis did not reach a terminal state within its bound');
    return giveUp('terminated', 'the analysis did not reach a terminal state within its bound; the engine was terminated and is recovering');
  }
  if (!r.ok) {
    return finish({ scope, status: 'diagnostic-failed', ctx: outer, expectations, uncheckedReason: 'the session was not available for analysis',
      findings: [{ category: 'diagnostic-failure', code: 'session-unavailable', message: `The session could not run the analysis: ${msg(r.e)}. No conclusions are drawn.` }] });
  }
  return r.r ?? giveUp('queue-wait', 'the analysis was abandoned');
}
