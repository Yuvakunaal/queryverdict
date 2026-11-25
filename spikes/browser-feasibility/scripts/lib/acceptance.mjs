// Benchmark record classification and experiment acceptance.
//
// Harness completion is NOT acceptance. A run is `accepted` only when the harness completed, the
// inputs were validated against the manifest, provenance was recorded, every planned workload
// produced every planned repetition, no answer check failed, nothing errored unexpectedly or
// timed out, and every cancel workload actually exercised a cancellation.
//
// Historical (schema v1) runs predate verdicts, input hashing and provenance. Their verdicts are
// DERIVED here from status and check fields, and they can never be `accepted`; they are reported
// as `historical-unvalidated`.

export const MAIN_CHECK_WORKLOADS = [
  'schema_orders', 'preview_100', 'count_orders', 'count_customers', 'filter_count', 'aggregate_by_region',
  'sort_topn_100', 'sort_full_first_100', 'equi_join_count_sum', 'fanout_key_multiplicity',
  'fanout_left_join_rows', 'rowloss_unmatched_orders',
];
export const CANCEL_WORKLOADS = ['cancel_heavy_join', 'cancel_during_full_sort'];
export const STRESS_WORKLOADS = ['stress_groupby_every_row', 'stress_self_join_orders', 'stress_count_distinct_note'];

export function kindOf(name) {
  if (CANCEL_WORKLOADS.includes(name)) return 'cancel';
  if (STRESS_WORKLOADS.includes(name)) return 'stress';
  return 'check';
}

/** Planned workloads for a run: recorded by schema v2 runs, reconstructed from CLI args for v1. */
export function plannedFor(run) {
  const prog = run.page?.progress ?? run.page?.partialProgress;
  if (prog?.planned?.length) return { planned: prog.planned, derived: false };
  const a = run.args ?? {};
  const reps = Number(a.reps ?? 3);
  const cancelReps = Number(a['cancel-reps'] ?? 5);
  let names = [...MAIN_CHECK_WORKLOADS, ...CANCEL_WORKLOADS, ...(a.stress ? STRESS_WORKLOADS : [])];
  if (a.only) names = names.filter((n) => a.only.split(',').includes(n));
  return { planned: names.map((name) => ({ name, kind: kindOf(name), reps: kindOf(name) === 'cancel' ? cancelReps : reps })), derived: true };
}

/** Verdict for one record: the recorded one (v2) or one derived from status/check (v1). */
export function verdictOf(rec, run) {
  if (rec.verdict) return { verdict: rec.verdict, derived: false };
  const kind = kindOf(rec.workload);
  const expectBoundary = run.args?.['expect-boundary-errors'] === true || run.args?.['memory-limit'] === '256MB';
  let verdict;
  if (rec.status === 'aborted-timeout') verdict = 'aborted-timeout';
  else if (kind === 'check') verdict = rec.status === 'ok' && rec.check ? (rec.check.pass ? 'pass' : 'fail') : 'unexpected-error';
  else if (kind === 'cancel') {
    if (rec.status === 'cancelled') verdict = rec.cancel?.followUp?.status === 'ok' ? 'cancel-exercised' : 'cancel-recovery-failed';
    else if (rec.status === 'ok') verdict = 'cancel-not-exercised';
    else verdict = 'unexpected-error';
  } else if (rec.status === 'ok') verdict = 'stress-completed';
  else if (rec.status === 'error' && expectBoundary && /Out of Memory/i.test(rec.error ?? '')) verdict = 'expected-boundary-error';
  else verdict = 'unexpected-error';
  return { verdict, derived: true };
}

export function evaluateRun(run) {
  const schema = run.page?.progress?.schemaVersion === 2 || run.page?.partialProgress?.schemaVersion === 2 ? 'v2' : 'v1-historical';
  const prog = run.page?.progress ?? run.page?.partialProgress ?? { records: [] };
  const records = prog.records ?? [];
  const counts = {
    records: records.length,
    assertions: 0, passed: 0, failed: 0,
    cancelTests: 0, cancelExercised: 0, cancelNotExercised: 0, cancelRecoveryFailed: 0,
    stressCompleted: 0, expectedBoundaryFailures: 0, unexpectedErrors: 0, timeouts: 0,
    frameGapMissing: 0,
  };
  let derivedVerdicts = false;
  for (const rec of records) {
    const { verdict, derived } = verdictOf(rec, run);
    derivedVerdicts ||= derived;
    if (rec.responsiveness?.maxFrameGapMs === null || rec.responsiveness?.maxFrameGapMs === undefined || rec.responsiveness?.frames === 0) counts.frameGapMissing++;
    switch (verdict) {
      case 'pass': counts.assertions++; counts.passed++; break;
      case 'fail': counts.assertions++; counts.failed++; break;
      case 'cancel-exercised': counts.cancelTests++; counts.cancelExercised++; break;
      case 'cancel-not-exercised': counts.cancelTests++; counts.cancelNotExercised++; break;
      case 'cancel-recovery-failed': counts.cancelTests++; counts.cancelRecoveryFailed++; break;
      case 'stress-completed': counts.stressCompleted++; break;
      case 'expected-boundary-error': counts.expectedBoundaryFailures++; break;
      case 'aborted-timeout': counts.timeouts++; break;
      default: counts.unexpectedErrors++;
    }
  }
  const { planned, derived: plannedDerived } = plannedFor(run);
  const missing = [];
  for (const p of planned) {
    const got = records.filter((r) => r.workload === p.name).length;
    if (got < p.reps) missing.push({ workload: p.name, expected: p.reps, got });
  }
  const cancelNotExercisedAtAll = planned
    .filter((p) => p.kind === 'cancel')
    .filter((p) => !records.some((r) => r.workload === p.name && verdictOf(r, run).verdict === 'cancel-exercised'))
    .map((p) => p.workload ?? p.name);

  const harness = run.outcome?.status === 'completed' ? 'completed' : run.outcome?.status ?? 'unknown';
  const reasons = [];
  if (harness !== 'completed') reasons.push(`harness ${harness}${run.outcome?.reason ? `: ${run.outcome.reason}` : ''}`);
  if (missing.length) reasons.push(`missing workload records: ${missing.map((m) => `${m.workload} ${m.got}/${m.expected}`).join(', ')}`);
  if (counts.failed) reasons.push(`${counts.failed} failed answer checks`);
  if (counts.unexpectedErrors) reasons.push(`${counts.unexpectedErrors} unexpected errors`);
  if (counts.timeouts) reasons.push(`${counts.timeouts} timeouts`);
  if (counts.cancelRecoveryFailed) reasons.push(`${counts.cancelRecoveryFailed} cancellations not followed by a working engine`);
  if (cancelNotExercisedAtAll.length) reasons.push(`cancel never exercised for: ${cancelNotExercisedAtAll.join(', ')}`);
  if (counts.expectedBoundaryFailures && !(run.args?.['expect-boundary-errors'] || schema === 'v1-historical')) reasons.push('boundary errors occurred in a run that did not expect them');

  let acceptance;
  if (schema === 'v1-historical') {
    acceptance = 'historical-unvalidated';
    reasons.push('historical run: no input hash validation, no source revision, verdicts derived after the fact');
  } else {
    if (run.inputValidation?.ok !== true) reasons.push('inputs not validated against the manifest');
    if (!run.provenance?.gitHead) reasons.push('source provenance not recorded');
    acceptance = reasons.length ? 'rejected' : 'accepted';
  }
  return { schema, harness, acceptance, reasons, counts, planned, plannedDerived, derivedVerdicts, missing };
}
