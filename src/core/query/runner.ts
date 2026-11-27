// Run SQL (M06; ARCHITECTURE §11; P-048, P-064; AM-003/004/005). One user statement runs as one
// `query` operation through the session's queue and revocable lease; no other connection.
//
// Statement policy (in order, inside the lease):
//  1. Classification (src/core/engine/statements.ts): DuckDB's parser decides, nothing executes.
//     Text the parser cannot serialise is checked with prepare() (executes nothing): accepted →
//     one statement of another kind; "multiple statements" → several; otherwise its parse or
//     bind error is reported and nothing ran.
//  2. Several statements are refused (ES-12, AM-004): nothing runs.
//  3. One read-only SELECT is read exactly, as DuckDB's own text, through an outer projection:
//       SELECT left(CAST(c1 AS VARCHAR), cellChars + 1), … FROM (\n<statement>\n) AS __qv_result(c1, …) LIMIT maxRows + 1
//     Column names and types come from DESCRIBE (binds, does not execute). The statement's own
//     terminator is removed only when the parser gives the identical tree without it. The cast,
//     the cut and the row limit run in the engine, so long values and extra rows never cross to
//     the page. Row order is the statement's (the engine runs single-threaded and the projection
//     and LIMIT preserve it; verified in FEASIBILITY §16). The data epoch does not change.
//  4. Any other single statement runs unchanged and its result (if any) is streamed and bounded.
//     Once it has been sent to the engine, the data epoch advances when the operation settles,
//     whatever the outcome (P-048): registry, previews and Verdict reports see the change.
//
// A result is published only if the engine generation is unchanged at hand-off; otherwise it is
// stale and never shown. Run SQL has no deadline (ARCHITECTURE §12.1: the user cancels; AM-009).
import { classifyStatement, MULTIPLE_STATEMENTS } from '../engine/statements';
import { sqlString } from '../engine/lockdown';
import type { EngineSession } from '../engine/session';
import type { DataEpoch, Lease, OperationBounds, OperationHandle, OperationResult, StatementClass } from '../engine/types';
import { MAX_TIMER_MS, type ReleaseProfile } from '../profile/profile';
import { ArrowTypeId, type ArrowBatch } from '../results/arrow';
import { ResultCollector, type CollectLimits } from '../results/collect';
import type { BoundedResult, ResultColumn } from '../results/types';
import { EngineError, RefusedError } from '../util/errors';
import { leadingKeyword, trimTerminator } from './sqlText';

export interface QueryRun {
  readonly sql: string;
  /** select: one read-only SELECT (exact DuckDB text); statement: one statement of another kind. */
  readonly statement: 'select' | 'statement';
  /** The result set, or null when the statement returned none (DDL, transaction control …). */
  readonly result: BoundedResult | null;
  /** The SELECT has a top-level ORDER BY, so its row order is defined. */
  readonly ordered: boolean;
  /** Rows changed, as reported by DuckDB for INSERT, UPDATE, DELETE and CREATE TABLE … AS. */
  readonly affectedRows?: string;
  /** Values are DuckDB's own text (SELECT path) rather than read from the transferred data. */
  readonly exactText: boolean;
  /** The statement was sent to the engine and the data epoch advanced when it settled. */
  readonly dataChanged: boolean;
  readonly transactionHint: StatementClass['transactionHint'];
  /** Statements run in this action (the result is the last one's); 1 when absent. */
  readonly statements?: number;
  /** The SELECT had effects and was evaluated in full (no pruning, no early stop). */
  readonly evaluatedInFull?: boolean;
  /**
   * The data epoch this result belongs to: the epoch when the run started, advanced once if it
   * sent a statement that may change data. A different current epoch makes it historical.
   */
  readonly epoch?: number;
}

export const MULTIPLE_REFUSAL =
  'Run SQL runs one statement at a time. This text contains several statements; run them one by one. Nothing was run.';
export const PIVOT_NOTE =
  "DuckDB runs a PIVOT without a list of values as several statements (it first reads the distinct values). List the values to run it as one, for example PIVOT t ON b IN ('x', 'y') USING sum(a).";

const DECLARE_ROWS = 100_000;

function limitsOf(profile: ReleaseProfile): CollectLimits {
  const r = profile.results;
  return { maxRows: r.maxRows, maxColumns: r.maxColumns, maxCellChars: r.maxCellChars, maxDisplayChars: r.maxDisplayChars, maxArrowBytes: r.maxArrowBytes };
}

/** DuckDB's message for a statement prepare() rejected, as a typed error (nothing ran). */
function prepareFailure(message: string): EngineError {
  const phase = /^Parser Error/i.test(message) ? 'parse' : /^(Binder|Catalog) Error/i.test(message) ? 'bind' : 'execute';
  return new EngineError(phase, message);
}

async function describe(lease: Lease, text: string): Promise<ResultColumn[]> {
  const read = (sql: string) => lease.query(sql, { maxRows: DECLARE_ROWS });
  let rows;
  try {
    rows = await read(`DESCRIBE ${text}`);
  } catch (e) {
    // SHOW, DESCRIBE and SUMMARIZE cannot be described directly, but can as a subquery (whose
    // duplicate column names DuckDB disambiguates).
    if (!(e instanceof EngineError && e.phase === 'parse')) throw e;
    rows = await read(`DESCRIBE SELECT * FROM (\n${text}\n) AS __qv_describe`);
  }
  return rows.map((r) => ({ name: r[0] ?? '', type: r[1] ?? '' }));
}

/** Functions whose calls change state a later statement can observe (sequence values, the random seed). */
const EFFECTFUL_FUNCTIONS = new Set(['nextval', 'setseed']);

/** Every function name called in a parse tree (lower case). */
function calledFunctions(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const x of node) calledFunctions(x, out);
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o.function_name === 'string') out.add(o.function_name.toLowerCase());
    for (const v of Object.values(o)) calledFunctions(v, out);
  }
  return out;
}

/**
 * A SELECT whose evaluation has effects (nextval, setseed, or any user-defined macro, which may
 * call them) must be evaluated in full: an outer projection would prune undisplayed expressions
 * and a row limit would stop evaluation early, changing those effects.
 */
async function isEffectful(lease: Lease, tree: unknown): Promise<boolean> {
  const called = calledFunctions(tree);
  if (!called.size) return false;
  for (const f of called) if (EFFECTFUL_FUNCTIONS.has(f)) return true;
  const macros = await lease.query("SELECT lower(function_name)::VARCHAR FROM duckdb_functions() WHERE NOT internal AND function_type IN ('macro', 'table_macro')", { columns: 1, maxRows: 100_000 });
  return macros.some((r) => r[0] !== null && called.has(r[0] as string));
}

async function readSelect(lease: Lease, sql: string, profile: ReleaseProfile, epoch: () => DataEpoch, hint: StatementClass['transactionHint']): Promise<QueryRun> {
  const trimmed = trimTerminator(sql);
  const [row] = await lease.query(`SELECT json_serialize_sql(${sqlString(sql)})::VARCHAR, json_serialize_sql(${sqlString(trimmed)})::VARCHAR`, { columns: 2, maxRows: 1, exactRows: 1 });
  const original = row?.[0] ?? '';
  // The trimmed text is used only if DuckDB's parser gives the identical tree for it.
  const text = row?.[1] === original ? trimmed : null;
  if (text === null) return runStatement(lease, sql, profile, epoch, hint, { readOnly: true });
  let tree: unknown = null;
  try {
    tree = JSON.parse(original);
  } catch {
    tree = null;
  }
  const node = (tree as { statements?: { node?: { modifiers?: { type?: string }[] } }[] } | null)?.statements?.[0]?.node;
  const ordered = !!node?.modifiers?.some((m) => m.type === 'ORDER_MODIFIER');
  const effectful = tree === null || (await isEffectful(lease, tree));
  const columns = await describe(lease, text);
  const limits = limitsOf(profile);
  // An effectful SELECT keeps every column and every row in the engine (nothing pruned, no
  // early stop); only what is shown stays bounded on the page.
  const shown = effectful ? columns : columns.slice(0, limits.maxColumns);
  const alias = columns.map((_, i) => `c${i + 1}`).join(', ');
  const select = shown.map((_, i) => `left(CAST(c${i + 1} AS VARCHAR), ${limits.maxCellChars + 1})`).join(', ');
  const wrapped = `SELECT ${select} FROM (\n${text}\n) AS __qv_result(${alias})${effectful ? '' : ` LIMIT ${limits.maxRows + 1}`}`;
  const collector = new ResultCollector(limits, columns);
  const stamp = { generation: lease.generation, epoch: epoch() };
  await lease.stream(wrapped, effectful ? drain(collector) : (b, bytes) => collector.consume(b, bytes));
  return { sql, statement: 'select', result: collector.finish(stamp), ordered, exactText: true, dataChanged: false, transactionHint: hint, evaluatedInFull: effectful };
}

/** A consumer that keeps what the collector keeps but reads the result to its end. */
const drain = (collector: ResultCollector) => (b: unknown, bytes: number) => {
  collector.consume(b, bytes);
  return true;
};

const AFFECTS_ROWS = new Set(['INSERT', 'UPDATE', 'DELETE', 'CREATE']);

async function runStatement(
  lease: Lease,
  sql: string,
  profile: ReleaseProfile,
  epoch: () => DataEpoch,
  hint: StatementClass['transactionHint'],
  opts: { readOnly: boolean; onSent?: () => void },
): Promise<QueryRun> {
  const collector = new ResultCollector(limitsOf(profile));
  const stamp = { generation: lease.generation, epoch: epoch() };
  // DuckDB reports changed rows as one Int64 "Count" row. It is read from the engine's own value,
  // before any display bound applies, and only with its full provenance (one column, one row).
  let countShape: boolean | null = null;
  let countRows = 0;
  let countValue: string | null = null;
  opts.onSent?.();
  // A statement other than a SELECT is never stopped early: it runs to its end, so the reported
  // outcome is what the engine did (only what is shown is bounded).
  await lease.stream(sql, (b, bytes) => {
    const batch = b as ArrowBatch;
    if (countShape === null) {
      const f = batch.schema.fields;
      countShape = f.length === 1 && f[0]?.name === 'Count' && f[0].type.typeId === ArrowTypeId.Int && f[0].type.bitWidth === 64;
    }
    if (countShape) {
      countRows += batch.numRows;
      const d = batch.data.children[0];
      if (countValue === null && batch.numRows > 0 && d && d.offset === 0 && d.getValid(0)) countValue = String((d.values as ArrayLike<bigint>)[0]);
    }
    collector.consume(b, bytes);
    return true;
  });
  const result = collector.finish(stamp);
  const statement = opts.readOnly ? 'select' : 'statement';
  const base = { sql, statement, ordered: false, exactText: false, dataChanged: !opts.readOnly, transactionHint: hint } as const;
  const only = result.columns.length === 1 ? result.columns[0] : undefined;
  if (!opts.readOnly && only && !/\bRETURNING\b/i.test(sql)) {
    if (countShape && countRows === 1 && countValue !== null && /^\d+$/.test(countValue) && AFFECTS_ROWS.has(leadingKeyword(sql))) return { ...base, result: null, affectedRows: countValue };
    // DDL and transaction control return an empty Count or Success column: no result set.
    if ((only.name === 'Count' || only.name === 'Success') && result.rows.length === 0 && !result.truncation.bytes) return { ...base, result: null };
  }
  return { ...base, result };
}

/** Classifies one statement inside the lease (DuckDB's parser; nothing executes). */
async function classify(lease: Lease, sql: string): Promise<StatementClass> {
  const cls = await classifyStatement(lease, sql);
  if (cls.kind !== 'unparseable') return cls;
  const prepared = await lease.prepareCheck(sql);
  if (prepared.ok) return { kind: 'possibly-mutating', transactionHint: cls.transactionHint };
  if (MULTIPLE_STATEMENTS.test(prepared.message)) return { kind: 'multiple', transactionHint: cls.transactionHint };
  throw prepareFailure(prepared.message);
}

const multipleRefusal = (sql: string) => (leadingKeyword(sql) === 'PIVOT' || leadingKeyword(sql) === 'UNPIVOT' ? `${MULTIPLE_REFUSAL} ${PIVOT_NOTE}` : MULTIPLE_REFUSAL);

function execute(lease: Lease, sql: string, cls: StatementClass, profile: ReleaseProfile, session: EngineSession, onSent: () => void): Promise<QueryRun> {
  const epoch = () => session.epoch;
  if (cls.kind === 'select') return readSelect(lease, sql, profile, epoch, cls.transactionHint);
  return runStatement(lease, sql, profile, epoch, cls.transactionHint, { readOnly: false, onSent });
}

/** Prefixes an error with the statement it came from (several statements ran in one action). */
function inStatement(e: unknown, k: number, n: number): unknown {
  const where = `Statement ${k} of ${n}`;
  if (e instanceof EngineError) return new EngineError(e.phase, `${where}: ${e.message}`, { cause: e });
  if (e instanceof RefusedError) return new RefusedError(`${where}: ${e.message}`, { cause: e });
  return e;
}

/**
 * What a run did, kept current while it runs and final when it settles, so every outcome
 * (success, error, cancellation) can say exactly what reached the engine.
 */
export interface RunProgress {
  /** Statements in this action. */
  total: number;
  /** Statements that completed. */
  completed: number;
  /** A statement that may change data was sent to the engine. */
  mutationSent: boolean;
  /** A statement that may change data was sent and had not completed when the run ended. */
  mutationInFlight: boolean;
  /** Transaction hint over the statements that were sent (BEGIN … / COMMIT, ROLLBACK). */
  transactionHint: StatementClass['transactionHint'];
}

export interface QueryHandle extends OperationHandle<QueryRun> {
  readonly progress: Readonly<RunProgress>;
}

/** Wraps a submitted operation: epoch advance after a sent statement, stale-result rejection. */
function settle(session: EngineSession, inner: OperationHandle<QueryRun>, progress: RunProgress, start: { epoch: number | null }): QueryHandle {
  const result = inner.result.then((r): OperationResult<QueryRun> => {
    // A statement that reached the engine may have changed data, whatever its outcome.
    if (progress.mutationSent) session.markDataChanged();
    if (r.terminal.status !== 'ok' || !r.value) return r;
    const v = r.value;
    // Late or replaced-engine results are never published.
    if (r.generation !== session.generation || (v.result && v.result.stamp.generation !== session.generation)) {
      return { terminal: { status: 'stale', reason: 'generation-changed' }, generation: r.generation };
    }
    // The epoch this result belongs to: its start, plus this run's own advance. The publisher
    // compares it with the epoch at publication (a later change makes it historical).
    const epoch = (start.epoch ?? session.epoch) + (progress.mutationSent ? 1 : 0);
    return { ...r, value: { ...v, epoch } };
  });
  return { id: inner.id, kind: inner.kind, get generation() { return inner.generation; }, result, cancel: () => inner.cancel(), progress };
}

function boundsOf(profile: ReleaseProfile): OperationBounds {
  const b = profile.bounds;
  // Run SQL has no deadline by default (ARCHITECTURE §12.1): the largest timer the session accepts.
  return { queueWaitMs: b.queueWaitMs, runMs: MAX_TIMER_MS, cancelGraceMs: b.cancelRequestMs, cleanupMs: b.cleanupMs };
}

/**
 * Starts one Run SQL operation for one statement. The handle settles exactly once; the data epoch
 * advances after a possibly-mutating statement was sent, however it ended.
 */
export function runQuery(session: EngineSession, sql: string, profile: ReleaseProfile): QueryHandle {
  return runStatements(session, [sql], profile);
}

/**
 * One or several statements in one Run SQL action (the statement at the cursor, or a selection;
 * maintainer request, P-097), as one operation through the same lease. Before any of them runs,
 * DuckDB's parser must accept every statement as exactly one statement without a syntax error
 * (binding errors may be resolved by an earlier statement, so they are reported when that
 * statement runs). They then run in order; the first error stops the rest and names the
 * statement; the result shown is the last statement's. `progress` says what reached the engine.
 */
export function runStatements(session: EngineSession, statements: readonly string[], profile: ReleaseProfile): QueryHandle {
  const n = statements.length;
  const progress: RunProgress = { total: n, completed: 0, mutationSent: false, mutationInFlight: false, transactionHint: null };
  const start = { epoch: null as number | null };
  const inner = session.submit<QueryRun>(
    'query',
    async (lease) => {
      start.epoch = session.epoch;
      if (n === 0) throw new RefusedError('There is no statement to run here. Write a query, or place the cursor in one.');
      if (n === 1 && (statements[0] as string).trim() === '') throw new RefusedError('The editor is empty. Write a query first.');
      const classes: StatementClass[] = [];
      for (let k = 0; k < n; k++) {
        const sql = statements[k] as string;
        let cls: StatementClass;
        try {
          cls = await classify(lease, sql);
        } catch (e) {
          if (!(e instanceof EngineError) || n === 1) throw e;
          // A binding error in a later statement may be resolved by an earlier one: run and see.
          if (e.phase !== 'parse') cls = { kind: 'possibly-mutating', transactionHint: null };
          else throw new EngineError('parse', `Statement ${k + 1} of ${n}: ${e.message}`, { cause: e });
        }
        if (cls.kind === 'multiple') throw new RefusedError(n === 1 ? multipleRefusal(sql) : `Statement ${k + 1} of ${n} could not be separated from the next one safely. ${multipleRefusal(sql)}`);
        classes.push(cls);
      }
      let last: QueryRun | null = null;
      for (let k = 0; k < n; k++) {
        const cls = classes[k] as StatementClass;
        const onSent = () => {
          progress.mutationSent = true;
          progress.mutationInFlight = true;
          if (cls.transactionHint) progress.transactionHint = cls.transactionHint;
        };
        try {
          last = await execute(lease, statements[k] as string, cls, profile, session, onSent);
        } catch (e) {
          throw n === 1 ? e : inStatement(e, k + 1, n);
        }
        progress.mutationInFlight = false;
        progress.completed = k + 1;
      }
      return { ...(last as QueryRun), dataChanged: progress.mutationSent, statements: n, transactionHint: progress.transactionHint };
    },
    boundsOf(profile),
  );
  return settle(session, inner, progress, start);
}
