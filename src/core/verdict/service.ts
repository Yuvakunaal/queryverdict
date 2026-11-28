// VerdictService (ARCHITECTURE §14–§16; IMPLEMENTATION_PLAN M08). One analysis is ONE `verdict`
// operation on the M02 session: it waits in the same FIFO queue as user SQL and imports, owns the
// engine exclusively through a revocable lease while it runs (nothing can interleave), runs every
// probe inside one transaction of its own that the session always rolls back, and produces a
// draft. The draft is published through the fence (report.ts) after the operation settled, in the
// same synchronous step as the hand-off to the report sink.
//
// Pipeline: expectations validated → own transaction (refused, untouched, when the user has one
// open) → parse (versioned adapter, lossless) → strict recognition → bind (the engine-rendered
// query is DESCRIBEd, never executed) → relation eligibility from the catalog → keys and types →
// bounded input sizes and grouping estimate (before any grouping) → start fingerprints → key
// frequencies → statistics → invariants → SEMI JOIN recount → executed count (budgeted) →
// witnesses → witness recounts on the inputs and through the join (budgeted, cumulative) → end
// fingerprints and table identities → draft.
import type { EngineSession } from '../engine/session';
import type { Lease, OperationBounds, OperationHandle, OperationResult } from '../engine/types';
import type { ReleaseProfile } from '../profile/profile';
import { LeaseRevokedError, RefusedError } from '../util/errors';
import { cloneLossless, isJsonObject, type JsonObject } from '../util/lossless-json';
import { beginOwnTransaction } from '../datasets/transaction';
import { createBudgetGate, FREE, MAX_DIAGNOSTIC_TRANSFER_BYTES, type BudgetGate, type ProbeCost } from './budget';
import { completeOutcomes } from './expectations';
import { finding, joinFindings, outcomeFindings } from './findings';
import { COUNT_TEMPLATE_SQL, countNode, parserQualified, parseSql, renderSql, statementDoc, type ScalarRunner } from './parser-adapter';
import {
  BudgetRefusedError, fingerprintSql, frequencySql, identitySql, inputRowsSql, ProbeRunner, statisticsSql, WITNESS_LEFT, WITNESS_RIGHT,
  witnessCtes, witnessInputsSql, witnessSelectionSql, type SideSql,
} from './probes';
import { keyBytes, qualifyGrouping, quotedKeys, resolveKeys, type KeyPair } from './qualify';
import { recognise, type RecognisedJoin } from './recognise';
import { columnsOf, resolveRelation, type OriginLookup, type ResolvedRelation } from './relations';
import { buildReplay, type ReplayOutcome } from './replay';
import { publish, type DraftReport } from './report';
import { checkDerived, checkInvariants, derive, exactDerived, exactStats, parseCount, STAT_FIELDS } from './stats';
import type { DatasetIdentity, Finding, JoinEvidence, JoinStats, JoinValidation, ReportStatus, ResourceReport, VerdictReport, VerdictService, Witness, WitnessKind } from './types';

/** Receives published reports (the report store). Called synchronously by the fence. */
export interface ReportSink {
  publish(report: VerdictReport): void;
}

export interface VerdictDeps {
  readonly session: EngineSession;
  readonly profile: ReleaseProfile;
  readonly sink?: ReportSink;
  /** Labels eligible inputs with their dataset origin (registry); never decides eligibility. */
  readonly origin?: OriginLookup;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'unknown error';

export class Verdict implements VerdictService {
  constructor(private readonly deps: VerdictDeps) {}

  analyze(sql: string, expectations: readonly unknown[]): OperationHandle<VerdictReport> {
    const { session, profile, sink } = this.deps;
    const declared = [...expectations];
    const id = crypto.randomUUID();
    const deadlineMs = profile.bounds.verdictMs;
    const bounds: OperationBounds = { queueWaitMs: deadlineMs, runMs: deadlineMs, cancelGraceMs: profile.bounds.cancelRequestMs, cleanupMs: profile.bounds.cleanupMs };
    const hash = sha256(sql);
    let cancelled = false;
    let deadlineReached = false;
    const submittedAt = performance.now();
    const inner = session.submit<DraftReport>('verdict', async (lease) => this.body(lease, sql, await hash, declared), bounds, 'the query in the editor');
    // One analysis-wide deadline that includes the time spent waiting in the queue.
    const timer = setTimeout(() => {
      deadlineReached = true;
      inner.cancel();
    }, deadlineMs);
    const result = (async (): Promise<OperationResult<VerdictReport>> => {
      const queryHash = await hash;
      const r = await inner.result;
      clearTimeout(timer);
      // The deadline timer may have been delayed (background tab): the clock decides.
      if (r.pastDeadline || performance.now() - submittedAt >= deadlineMs) deadlineReached = true;
      // ---- publication fence: no await between this check and the hand-off ----
      const report = publish(r.value ?? null, {
        id, sqlText: sql, queryHash, declared, terminal: r.terminal, resultGeneration: r.generation,
        // A cancel requested through any control (this handle, or the session by id) counts, even
        // one that arrived while the operation was already finishing (Codex M10).
        cancelled: cancelled || r.cancelRequested === true,
        deadlineMs: deadlineReached ? deadlineMs : null,
        session: { generation: session.generation, epoch: session.epoch, state: session.state }, now: Date.now(),
      });
      sink?.publish(report);
      return { terminal: r.terminal, value: report, generation: r.generation };
    })();
    return {
      id: inner.id, kind: 'verdict', get generation() { return inner.generation; }, result,
      cancel: () => {
        cancelled = true;
        inner.cancel();
      },
    };
  }

  private async body(lease: Lease, sqlText: string, queryHash: string, declared: readonly unknown[]): Promise<DraftReport> {
    const { session, profile } = this.deps;
    const v = profile.verdict;
    const gate = createBudgetGate({ executionPairRows: v.executionPairRows, groupingBytes: v.groupingBytes, maxInputRows: v.maxInputRows, maxTransferBytes: MAX_DIAGNOSTIC_TRANSFER_BYTES });
    const run = new ProbeRunner(lease, gate);
    const a = new Analysis(run, gate, lease, session, profile, sqlText, queryHash, declared, this.deps.origin ?? (() => 'unknown'));
    try {
      return await a.execute();
    } catch (e) {
      if (e instanceof LeaseRevokedError || lease.signal.aborted) throw e; // the session reports the terminal outcome
      if (e instanceof BudgetRefusedError) return a.draft('budget-exhausted', [finding('inconclusive', 'budget-exhausted', `Analysis stopped: ${e.message}. No conclusions are drawn from the incomplete analysis.`)], e.message);
      return a.draft('diagnostic-failed', [finding('diagnostic-failure', 'diagnostic-failed', `A diagnostic statement failed: ${message(e)}. This does not mean the query itself fails.`)], 'a diagnostic statement failed');
    }
  }
}

/** One analysis inside the lease. */
class Analysis {
  private readonly checked: string[] = [];
  private readonly notChecked: string[] = [
    'whether the query expresses the intended business logic',
    'whether the query executes (it was bound, not run; probes count rows and never evaluate the SELECT list)',
    'aggregate inflation, metric preservation and grain (outside the P0 diagnostic scope)',
  ];
  private readonly reasons: string[] = [];
  private inputs: DatasetIdentity[] = [];
  private join: JoinEvidence | null = null;
  private resources: { inputRows?: Record<string, string>; keyBytesPerRow?: number; estimatedGroupingBytes?: Record<string, string>; engineMemoryLimit?: string | null } = {};
  private readonly stamp;

  constructor(
    private readonly run: ProbeRunner,
    private readonly gate: BudgetGate,
    private readonly lease: Lease,
    private readonly session: EngineSession,
    private readonly profile: ReleaseProfile,
    private readonly sqlText: string,
    private readonly queryHash: string,
    private readonly declared: readonly unknown[],
    private readonly origin: OriginLookup,
  ) {
    this.stamp = { generation: lease.generation, epoch: session.epoch };
  }

  private scalar(probe: 'parse' | 'render' | 'memory-limit'): ScalarRunner {
    return async (sql) => (await this.run.one(probe, FREE, sql, 1))[0] ?? null;
  }

  private resourceReport(): ResourceReport {
    const v = this.profile.verdict;
    const s = this.gate.spent;
    return {
      limits: { executionPairRows: String(v.executionPairRows), groupingBytes: String(v.groupingBytes), maxInputRows: String(v.maxInputRows), maxKeyColumns: v.maxKeyColumns, maxTransferBytes: this.gate.limits.maxTransferBytes, deadlineMs: this.profile.bounds.verdictMs },
      spent: { scansOfInputs: s.scansOfInputs, pairRows: String(s.pairRows), groupingBytes: String(s.groupingBytes), transferredBytes: s.transferredBytes },
      inputRows: this.resources.inputRows ?? {},
      keyBytesPerRow: this.resources.keyBytesPerRow ?? null,
      estimatedGroupingBytes: this.resources.estimatedGroupingBytes ?? {},
      engineMemoryLimit: this.resources.engineMemoryLimit ?? null,
      probes: [...this.gate.log],
      statements: this.run.trace.length,
    };
  }

  /** A draft for an outcome without complete validated evidence: every valid expectation unchecked. */
  draft(status: ReportStatus, findings: Finding[], uncheckedReason: string): DraftReport {
    const expectations = completeOutcomes(this.declared, null, uncheckedReason);
    return {
      sqlText: this.sqlText, queryHash: this.queryHash, inputs: this.inputs, stamp: this.stamp, status,
      nonAuthoritativeReasons: [...this.reasons, `analysis status is ${status}`, ...(status === 'budget-exhausted' || status === 'inconclusive' || status === 'diagnostic-failed' ? [uncheckedReason] : [])],
      join: this.join, findings: [...findings, ...outcomeFindings(expectations)], expectations,
      coverage: { checked: this.checked, notChecked: [...this.notChecked, `join statistics and expectations (${uncheckedReason})`] },
      resources: this.resourceReport(),
    };
  }

  async execute(): Promise<DraftReport> {
    // 0. The parser JSON is only qualified for specific engine versions.
    const engineProblem = parserQualified(this.session.info?.duckdb);
    if (engineProblem) return this.draft('unsupported', [finding('unsupported', 'parser-not-qualified', `Verdict is unavailable: ${engineProblem}.`)], engineProblem);

    // 1. Own transaction; an open user transaction is refused without being touched (P-069).
    try {
      await beginOwnTransaction(this.probeLease(), 'running Verdict');
    } catch (e) {
      if (e instanceof RefusedError) return this.draft('inconclusive', [finding('inconclusive', 'transaction-unavailable', `${e.message} Verdict needs its own transaction so that every probe reads one snapshot.`)], 'a user transaction is open');
      throw e;
    }

    // 2. Parse (lossless) and recognise the P0 shape.
    const parsed = await parseSql(this.scalar('parse'), this.sqlText);
    if (!parsed.ok) {
      if (parsed.kind === 'syntax') return this.draft('query-failed', [finding('query-failure', 'syntax-error', `The query cannot be parsed: ${parsed.message}`)], 'the query cannot be parsed');
      if (parsed.kind === 'not-select') return this.draft('unsupported', [finding('unsupported', 'not-a-select', `Only one SELECT statement can be analysed (${parsed.message}).`, { construct: 'statement' })], 'the statement is not a SELECT');
      return this.draft('diagnostic-failed', [finding('diagnostic-failure', 'parser-output', `The parser output could not be read: ${parsed.message}.`)], 'the parser output could not be read');
    }
    const rec = recognise(parsed.doc);
    if (!rec.ok) {
      return this.draft('unsupported', rec.unsupported.map((u) => finding('unsupported', 'unsupported-construct', `${u.construct} is outside the Verdict diagnostic scope (${u.detail}). No data conclusions are drawn.`, { construct: u.construct, detail: u.detail })), 'the query is outside the supported diagnostic scope');
    }
    const join = rec.join;
    this.checked.push('query shape (one INNER or LEFT join of two named tables on column equalities)');

    // 3. Bind the engine-rendered query (DESCRIBE binds, it does not execute).
    const rendered = await renderSql(this.scalar('render'), statementDoc(cloneLossless((parsed.doc.statements as JsonObject[])[0]!.node as JsonObject)));
    try {
      await this.run.query('bind', FREE, `DESCRIBE ${rendered}`, { columns: 6, maxRows: 20_000 });
    } catch (e) {
      if (e instanceof LeaseRevokedError || e instanceof BudgetRefusedError) throw e;
      return this.draft('query-failed', [finding('query-failure', 'bind-failed', `The query cannot be bound (it would fail before running): ${message(e)}`)], 'the query cannot be bound');
    }
    this.checked.push('the query binds (it was not executed)');

    // 4. Relations: eligibility from the live catalog.
    const [db, schema] = await this.run.one('relations', FREE, 'SELECT current_database()::VARCHAR, current_schema()::VARCHAR', 2);
    const current = { database: db ?? '', schema: schema ?? '' };
    const resolved: ResolvedRelation[] = [];
    const refusals: string[] = [];
    for (const ref of [join.left, join.right]) {
      const r = await resolveRelation(this.run, ref, current, this.origin);
      if (r.ok) resolved.push(r.relation);
      else refusals.push(`${ref.ref}: ${r.reason}`);
    }
    if (refusals.length) {
      return this.draft('unsupported', refusals.map((r) => finding('unsupported', 'unsupported-relation', `${r}. No data conclusions are drawn.`)), 'an input is not a stable managed table');
    }
    const [left, right] = resolved as [ResolvedRelation, ResolvedRelation];
    this.inputs = [left.identity, right.identity];
    this.checked.push('both inputs are stable managed tables (current schema or temporary, unambiguous, no generated columns)');

    // 5. Keys.
    const keys = resolveKeys(join, left, right, await columnsOf(this.run, left), await columnsOf(this.run, right), this.profile.verdict.maxKeyColumns);
    if (!keys.ok) {
      return keys.kind === 'query-failed'
        ? this.draft('query-failed', [finding('query-failure', 'key-resolution', `The join keys cannot be resolved: ${keys.reason}.`)], 'the join keys cannot be resolved')
        : this.draft('unsupported', [finding('unsupported', 'unsupported-key', `${keys.reason}. No data conclusions are drawn.`)], 'the join keys are outside the supported scope');
    }
    const pairs = keys.pairs;
    this.resources.keyBytesPerRow = Number(keyBytes(pairs));
    this.checked.push(`join keys: ${pairs.length} same-type integer column pair(s)`);
    return this.analyseJoin(join, left, right, pairs);
  }

  /** A Lease view whose queries go through the probe runner (traced, budgeted). */
  private probeLease(): Lease {
    const l = this.lease;
    return {
      id: l.id, generation: l.generation, signal: l.signal,
      query: (sql, shape) => this.run.query('transaction-check', FREE, sql, shape),
      // Every Verdict statement goes through the budgeted probe runner; nothing streams around it.
      stream: () => Promise.reject(new RefusedError('Verdict probes do not stream results')),
      prepareCheck: (sql) => l.prepareCheck(sql), deferCleanup: (sql) => l.deferCleanup(sql), deferDropFile: (n) => l.deferDropFile(n),
      forgetCleanup: (sql) => l.forgetCleanup(sql), cleanup: (sql) => l.cleanup(sql), registerFile: (n, f) => l.registerFile(n, f), dropFile: (n) => l.dropFile(n),
    };
  }

  private async analyseJoin(join: RecognisedJoin, left: ResolvedRelation, right: ResolvedRelation, pairs: readonly KeyPair[]): Promise<DraftReport> {
    const v = this.profile.verdict;
    const n = pairs.length;
    const L: SideSql = { table: left.qualified, keys: quotedKeys(pairs, 'left'), types: pairs.map((p) => p.left.type) };
    const R: SideSql = { table: right.qualified, keys: quotedKeys(pairs, 'right'), types: pairs.map((p) => p.right.type) };
    const notes: string[] = [];
    const validation: { -readonly [K in keyof JoinValidation]: JoinValidation[K] } = { invariants: 'not-run', invariantViolations: [], semiJoin: 'not-run', executedCount: 'not-run', witnesses: 'not-run', snapshot: 'not-run', notes };
    const evidence = (stats: JoinEvidence['stats'], derived: JoinEvidence['derived'], witnesses: readonly Witness[]): JoinEvidence => ({
      type: join.type, left: { name: join.left.name, ref: join.left.ref }, right: { name: join.right.name, ref: join.right.ref },
      keys: pairs.map((p) => ({ left: p.left.column, right: p.right.column, type: p.left.type })), stats, derived, witnesses, validation,
    });
    this.join = evidence(null, null, []);

    // 6. Resource qualification before any grouping.
    this.resources.engineMemoryLimit = await this.scalar('memory-limit')("SELECT current_setting('memory_limit')::VARCHAR");
    const rowsOf = async (s: SideSql) => parseCount((await this.run.one('input-rows', { scansOfInputs: 1, pairRows: 0n, groupingBytes: 0n }, inputRowsSql(s.table, v.maxInputRows), 1))[0]);
    const leftRows = await rowsOf(L);
    const rightRows = await rowsOf(R);
    const over = (x: bigint) => (x > v.maxInputRows ? `over ${v.maxInputRows}` : String(x));
    this.resources.inputRows = { left: over(leftRows), right: over(rightRows) };
    if (leftRows > v.maxInputRows || rightRows > v.maxInputRows) {
      return this.draft('budget-exhausted', [finding('inconclusive', 'input-too-large', `An input has more than ${v.maxInputRows} rows (bounded check), over the analysis input limit. No grouping or join probe was run.`, { maxInputRows: String(v.maxInputRows) })], 'an input exceeds the row limit');
    }
    const q = qualifyGrouping(leftRows, rightRows, pairs, v.groupingBytes);
    this.resources.estimatedGroupingBytes = { left: String(q.perSide.left), right: String(q.perSide.right), transient: String(q.transient) };
    if (!q.ok) return this.draft('budget-exhausted', [finding('inconclusive', 'grouping-over-budget', `${q.reason}.`, { estimate: 'upper-bound estimate, not a measurement' })], 'the estimated grouping state exceeds the budget');
    this.checked.push(`input sizes (${leftRows} and ${rightRows} rows) and estimated grouping state, before any grouping`);

    // 7. Start fingerprints, then key frequencies (resident) and statistics.
    const scan1: ProbeCost = { scansOfInputs: 1, pairRows: 0n, groupingBytes: 0n };
    const fpStartL = await this.run.one('fingerprint-start', scan1, fingerprintSql(L), 4);
    const fpStartR = await this.run.one('fingerprint-start', scan1, fingerprintSql(R), 4);
    const token = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    const lf = `__qv_${token}_lf`;
    const rf = `__qv_${token}_rf`;
    // The temporary tables live inside the analysis transaction; the session's ROLLBACK removes them on every path.
    await this.run.query('frequencies-left', { scansOfInputs: 1, pairRows: 0n, groupingBytes: q.perSide.left, retainsGrouping: true }, frequencySql(lf, L), { maxRows: 1 });
    await this.run.query('frequencies-right', { scansOfInputs: 1, pairRows: 0n, groupingBytes: q.perSide.right, retainsGrouping: true }, frequencySql(rf, R), { maxRows: 1 });
    const f = (await this.run.one('statistics', { scansOfInputs: 0, pairRows: 0n, groupingBytes: q.transient }, statisticsSql(lf, rf, n), 18)).map((x) => parseCount(x));
    const [lRows, lNull] = [parseCount(fpStartL[0]), parseCount(fpStartL[1])];
    const [rRows, rNull] = [parseCount(fpStartR[0]), parseCount(fpStartR[1])];
    const names = STAT_FIELDS.slice(4); // the 18 fields after rows and NULL-key rows, in statisticsSql order
    const stats = Object.fromEntries([['leftRows', lRows], ['rightRows', rRows], ['leftNullKeyRows', lNull], ['rightNullKeyRows', rNull], ...names.map((k, i) => [k, f[i] as bigint])]) as unknown as JoinStats;
    const derived = derive(join.type, stats);
    this.checked.push('key frequencies of both inputs (exact counts)');

    // 8. Invariants, independent of the engine's join.
    const violations = [...checkInvariants(stats), ...checkDerived(join.type, stats, derived), ...(lRows === leftRows && rRows === rightRows ? [] : ['input row counts changed between probes'])];
    validation.invariants = violations.length ? 'violated' : 'held';
    validation.invariantViolations = violations;
    if (violations.length) {
      return this.inconclusive('invariant-violated', `The key-frequency statistics violate ${violations.length} mathematical invariant(s), so they do not describe this join. All measurements are withheld.`, { violations: violations.slice(0, 5).join('; ') });
    }
    this.checked.push('mathematical invariants of the statistics');

    // 9. SEMI JOIN recount with the query's own join node (engine matching semantics, no pairs).
    const template = await parseSql(this.scalar('parse'), COUNT_TEMPLATE_SQL);
    if (!template.ok) throw new Error(`count template: ${template.message}`);
    const templateNode = (template.doc.statements as JsonObject[])[0]!.node as JsonObject;
    const countSql = async (from: JsonObject) => renderSql(this.scalar('render'), statementDoc(countNode(templateNode, from)));
    const node = join.joinNode;
    const semi = (l: JsonObject, r: JsonObject) => {
      const x = cloneLossless(node);
      x.left = cloneLossless(l);
      x.right = cloneLossless(r);
      x.join_type = 'SEMI';
      return x;
    };
    const semiCost: ProbeCost = { scansOfInputs: 2, pairRows: 0n, groupingBytes: q.transient };
    // The engine-rendered statements are kept, untagged, for the replay bundle (M12).
    const semiLeftSql = await countSql(semi(node.left as JsonObject, node.right as JsonObject));
    const semiRightSql = await countSql(semi(node.right as JsonObject, node.left as JsonObject));
    const leftSemi = parseCount((await this.run.one('semi-join-left', semiCost, semiLeftSql, 1))[0]);
    const rightSemi = parseCount((await this.run.one('semi-join-right', semiCost, semiRightSql, 1))[0]);
    if (leftSemi !== stats.leftRowsMatched || rightSemi !== stats.rightRowsMatched) {
      validation.semiJoin = 'disagreed';
      return this.inconclusive('semantic-mismatch', `Grouping by key does not reproduce the join's own matching (SEMI JOIN matched ${leftSemi} left / ${rightSemi} right rows; key frequencies say ${stats.leftRowsMatched} / ${stats.rightRowsMatched}). All measurements are withheld.`, { semiLeft: String(leftSemi), semiRight: String(rightSemi), frequencyLeft: String(stats.leftRowsMatched), frequencyRight: String(stats.rightRowsMatched) });
    }
    validation.semiJoin = 'agreed';
    this.checked.push('matched rows recounted with the query\'s own join condition (SEMI JOIN)');

    // 10. Executed count of the join, only within the pair budget.
    let budgetNotes = 0;
    const executedCost: ProbeCost = { scansOfInputs: 2, pairRows: derived.outputRows, groupingBytes: q.transient };
    const ok = this.gate.check([executedCost]);
    let executedSql: string | null = null;
    if (ok.ok) {
      executedSql = await countSql(node);
      const actual = parseCount((await this.run.one('executed-count', executedCost, executedSql, 1))[0]);
      if (actual !== derived.outputRows) {
        validation.executedCount = 'disagreed';
        return this.inconclusive('semantic-mismatch', `The computed output (${derived.outputRows} rows) differs from the executed count (${actual}). All measurements are withheld.`, { computed: String(derived.outputRows), executed: String(actual) });
      }
      validation.executedCount = 'agreed';
      this.checked.push('output rows confirmed by an executed count of the join');
    } else {
      this.gate.deny('executed-count', executedCost, ok.reason);
      notes.push(`executed count not run: ${ok.reason}`);
      budgetNotes++;
    }

    // 11. Witnesses (from the frequency tables only).
    const witnesses: Witness[] = [];
    for (const kind of ['fan-out', 'unmatched-left', 'unmatched-right'] as WitnessKind[]) {
      const rows = await this.run.query('witness-selection', FREE, witnessSelectionSql(kind, lf, rf, n), { columns: n + 2, maxRows: 5 });
      for (const r of rows) {
        const key = r.slice(0, n).map((x) => {
          if (x === null || !/^-?\d+$/.test(x)) throw new TypeError('witness key is not an exact integer');
          return x;
        });
        const lc = parseCount(r[n]);
        const rc = parseCount(r[n + 1]);
        const out = kind === 'fan-out' ? lc * rc : kind === 'unmatched-left' && join.type === 'LEFT' ? lc : 0n;
        witnesses.push({ kind, key, leftRows: String(lc), rightRows: String(rc), outputRows: String(out) });
      }
    }

    // 12. Witness identity: every key re-counted on both inputs, then through the join (budgeted).
    let witnessState: JoinValidation['witnesses'] = 'verified';
    let witnessJoinSql: string | null = null;
    if (witnesses.length) {
      const inputCounts = await this.run.query('witness-inputs', { scansOfInputs: 2 * witnesses.length, pairRows: 0n, groupingBytes: 0n }, witnessInputsSql(L, R, witnesses.map((w) => w.key)), { columns: 2, maxRows: 2 * witnesses.length, exactRows: 2 * witnesses.length });
      const mismatches: string[] = [];
      witnesses.forEach((w, i) => {
        const gotL = inputCounts[2 * i]?.[1];
        const gotR = inputCounts[2 * i + 1]?.[1];
        if (gotL !== w.leftRows || gotR !== w.rightRows) mismatches.push(`${w.kind} key (${w.key.join(', ')}): expected ${w.leftRows}/${w.rightRows} input rows, found ${String(gotL)}/${String(gotR)}`);
      });
      const costs = witnesses.map((w): ProbeCost => ({ scansOfInputs: 2, pairRows: BigInt(w.outputRows), groupingBytes: 0n }));
      const plan = this.gate.check(costs);
      if (!mismatches.length && plan.ok) {
        const renamed = cloneLossless(node);
        for (const [sideKey, cte, ref] of [['left', WITNESS_LEFT, join.left], ['right', WITNESS_RIGHT, join.right]] as const) {
          const t = renamed[sideKey];
          if (!isJsonObject(t)) throw new Error('join input is not a table node');
          t.table_name = cte;
          t.alias = ref.ref;
        }
        const joinCount = await countSql(renamed);
        witnessJoinSql = joinCount;
        for (const [i, w] of witnesses.entries()) {
          const got = parseCount((await this.run.one('witness-join', costs[i] as ProbeCost, witnessCtes(L, R, w.key) + joinCount, 1))[0]);
          if (String(got) !== w.outputRows) mismatches.push(`${w.kind} key (${w.key.join(', ')}): expected ${w.outputRows} join rows, found ${got}`);
        }
      } else if (!plan.ok) {
        for (const c of costs) this.gate.deny('witness-join', c, plan.reason); // the whole plan is refused; nothing runs
        notes.push(`witness recounts through the join not run: ${plan.reason}`);
        witnessState = 'not-run';
        budgetNotes++;
      }
      if (mismatches.length) {
        validation.witnesses = 'mismatch';
        return this.inconclusive('witness-mismatch', `${mismatches.length} witness check(s) disagree with the key frequencies (${mismatches.slice(0, 3).join('; ')}). All measurements are withheld.`, { mismatches: mismatches.slice(0, 5).join('; ') });
      }
    }
    validation.witnesses = witnessState;
    if (witnessState === 'verified') this.checked.push(`${witnesses.length} witness key(s) re-counted on both inputs and through the join`);

    // 13. Snapshot: inputs and table identities at the end must equal those at the start.
    const changed: string[] = [];
    if ((await this.run.one('fingerprint-end', scan1, fingerprintSql(L), 4)).join('|') !== fpStartL.join('|')) changed.push('left input');
    if ((await this.run.one('fingerprint-end', scan1, fingerprintSql(R), 4)).join('|') !== fpStartR.join('|')) changed.push('right input');
    for (const r of [left, right]) {
      const ids = await this.run.query('identity-end', FREE, identitySql(r.identity.database, r.identity.schema, r.identity.relation), { columns: 1, maxRows: 2 });
      if (ids.length !== 1 || ids[0]?.[0] !== r.identity.oid) changed.push(`identity of ${r.ref.ref}`);
    }
    if (changed.length) {
      validation.snapshot = 'changed';
      return this.inconclusive('snapshot-inconsistent', `The input data changed during the analysis (${changed.join('; ')}). All measurements are withdrawn; evidence from different snapshots is never combined.`, { changed: changed.join('; ') });
    }
    validation.snapshot = 'verified';
    this.checked.push('the same input snapshot at the start and the end (key-multiset fingerprints and table identities)');

    // 14. Draft.
    const complete = budgetNotes === 0;
    this.join = evidence(exactStats(stats), exactDerived(derived), witnesses);
    const findings = joinFindings(join.type, stats, derived, complete ? 'validated' : 'incomplete');
    if (!complete) {
      const why = notes.join('; ');
      this.reasons.push(why);
      const d = this.draft('budget-exhausted', [...findings, finding('inconclusive', 'budget-exhausted', `Some validation probes were not run because they exceed the execution budget (${why}). The measurements above are limited evidence and expectations are not evaluated.`)], `validation incomplete: ${why}`);
      return d;
    }
    const expectations = completeOutcomes(this.declared, { type: join.type, stats, derived }, 'not evaluated');
    const unchecked = expectations.filter((o) => o.outcome === 'unchecked');
    const status: ReportStatus = unchecked.length ? 'partially-analyzed' : 'analyzed';
    // 15. Replay bundle (M12) from this run's validated evidence and the engine it ran on. The
    // fence keeps it only if the report is authoritative.
    const info = this.session.info;
    const replay: ReplayOutcome = buildReplay({
      engine: info && info.generation === this.lease.generation ? { duckdb: info.duckdb, package: info.packageVersion } : null,
      join: this.join,
      left: { relation: left.identity.relation, ref: join.left.ref, temporary: left.identity.temporary },
      right: { relation: right.identity.relation, ref: join.right.ref, temporary: right.identity.temporary },
      rendered: { semiLeft: semiLeftSql, semiRight: semiRightSql, executed: executedSql, witnessJoin: witnessJoinSql },
    });
    if (unchecked.length) this.reasons.push(`${unchecked.length} expectation(s) unchecked`);
    if (this.declared.length) this.checked.push(`${this.declared.length - unchecked.length} of ${this.declared.length} expectation(s) evaluated`);
    return {
      sqlText: this.sqlText, queryHash: this.queryHash, inputs: this.inputs, stamp: this.stamp, status,
      nonAuthoritativeReasons: status === 'analyzed' ? [...this.reasons] : [...this.reasons, `analysis status is ${status}`],
      join: this.join, findings: [...findings, ...outcomeFindings(expectations)], expectations,
      coverage: { checked: this.checked, notChecked: this.notChecked }, resources: this.resourceReport(), replay,
    };
  }

  private inconclusive(code: string, text: string, ev: Record<string, string>): DraftReport {
    // Withdraw every measurement; keep only the validation record that explains why.
    const v = this.join?.validation;
    if (this.join && v) this.join = { ...this.join, stats: null, derived: null, witnesses: [] };
    return this.draft('inconclusive', [finding('inconclusive', code, text, ev)], 'the join evidence could not be validated');
  }
}

/** Creates the service for a session. */
export function createVerdict(deps: VerdictDeps): VerdictService {
  return new Verdict(deps);
}
