// Report drafts and the publication fence (ARCHITECTURE §16; QV-ENG-002, QV-VER-005; corrects
// QV-SA-002).
//
// The analysis body only ever produces a DRAFT. A draft becomes a report in `publish`, which runs
// after the operation has settled: after the session ran the deferred ROLLBACK, after the lease
// was released, and in the same synchronous step as the hand-off to the report store. Authority
// is decided there, against the session as it is at that moment. Any cancellation request,
// deadline, engine replacement, data change, disposal or unsuccessful operation outcome makes the
// report non-authoritative; a cancelled or stale run publishes no measurements and no held or
// violated expectations.
import type { DataEpoch, Generation, SessionState, Terminal } from '../engine/types';
import { completeOutcomes, withdrawOutcomes } from './expectations';
import { finding, outcomeFindings } from './findings';
import type { DatasetIdentity, ExpectationOutcome, Finding, JoinEvidence, ReportStatus, ResourceReport, VerdictReport } from './types';

export const DISCLAIMER =
  'Verdict measures specific properties of one supported join on the analysed snapshot of the data. It does not show that the query ' +
  'expresses the intended business logic, and it never ran the query itself (it bound it and ran scoped diagnostic probes). ' +
  'No issues found in these checks is not proof that the query is correct.';

export interface DraftReport {
  readonly sqlText: string;
  readonly queryHash: string;
  readonly inputs: readonly DatasetIdentity[];
  /** Generation and epoch the analysis ran on, read inside the lease. */
  readonly stamp: { readonly generation: Generation; readonly epoch: DataEpoch };
  readonly status: ReportStatus;
  readonly nonAuthoritativeReasons: readonly string[];
  readonly join: JoinEvidence | null;
  readonly findings: readonly Finding[];
  readonly expectations: readonly ExpectationOutcome[];
  readonly coverage: { readonly checked: readonly string[]; readonly notChecked: readonly string[] };
  readonly resources: ResourceReport | null;
}

export interface FenceContext {
  readonly id: string;
  readonly sqlText: string;
  readonly queryHash: string;
  readonly declared: readonly unknown[];
  /** How the verdict operation settled (after ROLLBACK and lease release). */
  readonly terminal: Terminal;
  readonly resultGeneration: Generation | null;
  /** A cancellation was requested through the Verdict handle (at any time before publication). */
  readonly cancelled: boolean;
  /** The analysis-wide deadline (including queue wait) expired. */
  readonly deadlineMs: number | null;
  /** The live session at the moment of publication. */
  readonly session: { readonly generation: Generation | null; readonly epoch: DataEpoch; readonly state: SessionState };
  readonly now: number;
}

/** Decides authority and produces the report. Pure; the caller hands the result to the store immediately. */
export function publish(draft: DraftReport | null, ctx: FenceContext): VerdictReport {
  const fence: string[] = [];
  let status: ReportStatus | null = null;
  if (ctx.deadlineMs !== null) {
    fence.push(`the analysis deadline of ${ctx.deadlineMs} ms (including queue wait) was reached`);
    status = 'budget-exhausted';
  }
  if (ctx.cancelled || ctx.terminal.status === 'cancelled') {
    if (!status) {
      fence.push('cancelled before publication');
      status = ctx.terminal.status === 'cancelled' && ctx.terminal.by === 'deadline' ? 'budget-exhausted' : 'cancelled';
    }
  }
  if (ctx.terminal.status === 'stale') {
    fence.push(ctx.terminal.reason === 'disposed' ? 'the session was disposed during the analysis' : 'the engine was replaced during the analysis');
    status ??= 'stale';
  }
  if (ctx.session.state.kind === 'disposed') {
    fence.push('the session was disposed before publication');
    status ??= 'stale';
  } else if (ctx.session.state.kind === 'failed' || ctx.session.state.kind === 'recovering') {
    fence.push('the engine was unavailable at publication');
    status ??= 'stale';
  }
  if (draft) {
    if (ctx.resultGeneration !== draft.stamp.generation || ctx.session.generation !== draft.stamp.generation) {
      fence.push('the engine was replaced before publication');
      status ??= 'stale';
    }
    if (ctx.session.epoch !== draft.stamp.epoch) {
      fence.push('the data may have changed before publication');
      status ??= 'stale';
    }
  }
  if (ctx.terminal.status === 'error' || ctx.terminal.status === 'refused') {
    fence.push(ctx.terminal.status === 'error' ? `the analysis did not complete: ${ctx.terminal.message}` : `the analysis was refused: ${ctx.terminal.reason}`);
    status ??= 'diagnostic-failed';
  }
  if (ctx.terminal.status === 'ok' && !draft) {
    fence.push('the analysis produced no report');
    status ??= 'diagnostic-failed';
  }

  if (status || !draft) {
    // Interrupted, stale or failed: nothing measured in this run is published, and no expectation
    // is held or violated. Valid declarations stay unchecked with the reason; invalid ones stay invalid.
    const why = fence.join('; ') || 'the analysis did not complete';
    const st: ReportStatus = status ?? 'diagnostic-failed';
    const base = draft?.expectations ?? completeOutcomes(ctx.declared, null, why);
    const expectations = withdrawOutcomes(base, `not evaluated: ${why}`);
    const category = st === 'diagnostic-failed' ? 'diagnostic-failure' : 'inconclusive';
    const code = st === 'cancelled' ? 'analysis-cancelled' : st === 'budget-exhausted' ? 'deadline-reached' : st === 'stale' ? 'stale-analysis' : 'analysis-failed';
    const findings: Finding[] = [
      finding(category, code, `${st === 'cancelled' ? 'The analysis was cancelled' : st === 'stale' ? 'The analysis is stale' : st === 'budget-exhausted' ? 'The analysis ran out of time' : 'The analysis did not complete'}: ${why}. No measurements from this run are reported, and this says nothing about whether the query itself works.`),
      ...outcomeFindings(expectations),
    ];
    return {
      id: ctx.id,
      identity: { queryHash: ctx.queryHash, sqlText: ctx.sqlText, inputs: draft?.inputs ?? [] },
      stamp: { generation: draft?.stamp.generation ?? ctx.resultGeneration, epoch: draft?.stamp.epoch ?? ctx.session.epoch, finalisedAt: ctx.now },
      authoritative: false,
      nonAuthoritativeReasons: [...fence, ...(draft?.nonAuthoritativeReasons ?? [])],
      status: st,
      join: null,
      findings,
      expectations,
      coverage: { checked: [], notChecked: ['every check (the analysis was interrupted, stale or failed)'] },
      resources: draft?.resources ?? null,
      replay: null,
      disclaimer: DISCLAIMER,
    };
  }

  const reasons = [...draft.nonAuthoritativeReasons];
  return {
    id: ctx.id,
    identity: { queryHash: draft.queryHash, sqlText: draft.sqlText, inputs: draft.inputs },
    stamp: { generation: draft.stamp.generation, epoch: draft.stamp.epoch, finalisedAt: ctx.now },
    authoritative: reasons.length === 0 && draft.status === 'analyzed',
    nonAuthoritativeReasons: reasons.length === 0 && draft.status !== 'analyzed' ? [`analysis status is ${draft.status}`] : reasons,
    status: draft.status,
    join: draft.join,
    findings: draft.findings,
    expectations: draft.expectations,
    coverage: draft.coverage,
    resources: draft.resources,
    replay: null,
    disclaimer: DISCLAIMER,
  };
}

/** Historical vs current (ARCHITECTURE §16.2): a report is current only while its stamp and query match. */
export function currency(report: VerdictReport, live: { generation: Generation | null; epoch: DataEpoch; state: SessionState; queryHash?: string }): { current: boolean; reason?: string } {
  if (live.state.kind === 'disposed') return { current: false, reason: 'session ended' };
  if (report.stamp.generation === null || live.generation !== report.stamp.generation) return { current: false, reason: 'engine restarted' };
  if (live.epoch !== report.stamp.epoch) return { current: false, reason: 'data may have changed' };
  if (live.queryHash !== undefined && live.queryHash !== report.identity.queryHash) return { current: false, reason: 'query changed' };
  return { current: true };
}
