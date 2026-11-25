// Finding 5: harness completion must not be mistaken for experiment acceptance.
import { describe, expect, it } from 'vitest';
import { CANCEL_WORKLOADS, MAIN_CHECK_WORKLOADS, evaluateRun } from '../../scripts/lib/acceptance.mjs';

const rec = (workload, kind, verdict, extra = {}) => ({ workload, kind, verdict, status: 'ok', responsiveness: { maxFrameGapMs: 16, frames: 3 }, ...extra });

function v2Run({ records, planned, outcome = 'completed', inputOk = true, gitHead = 'abc', args = {} }) {
  return {
    outcome: { status: outcome },
    args,
    inputValidation: { ok: inputOk },
    provenance: { gitHead },
    page: { progress: { schemaVersion: 2, planned, records } },
  };
}

const plannedMain = [...MAIN_CHECK_WORKLOADS.map((name) => ({ name, kind: 'check', reps: 1 })), ...CANCEL_WORKLOADS.map((name) => ({ name, kind: 'cancel', reps: 1 }))];
const goodRecords = () => [...MAIN_CHECK_WORKLOADS.map((w) => rec(w, 'check', 'pass')), ...CANCEL_WORKLOADS.map((w) => rec(w, 'cancel', 'cancel-exercised', { status: 'cancelled' }))];

describe('evaluateRun', () => {
  it('accepts a complete, validated, passing run', () => {
    const e = evaluateRun(v2Run({ records: goodRecords(), planned: plannedMain }));
    expect(e.acceptance).toBe('accepted');
    expect(e.counts).toMatchObject({ records: 14, assertions: 12, passed: 12, failed: 0, cancelExercised: 2 });
  });

  it('rejects a completed harness run with a failed assertion', () => {
    const records = goodRecords();
    records[0] = rec(MAIN_CHECK_WORKLOADS[0], 'check', 'fail');
    const e = evaluateRun(v2Run({ records, planned: plannedMain }));
    expect(e.harness).toBe('completed');
    expect(e.acceptance).toBe('rejected');
    expect(e.reasons.join(' ')).toContain('failed answer checks');
  });

  it('rejects missing workloads', () => {
    const e = evaluateRun(v2Run({ records: goodRecords().slice(3), planned: plannedMain }));
    expect(e.acceptance).toBe('rejected');
    expect(e.missing.length).toBe(3);
  });

  it('rejects when a cancel workload never exercised a cancellation', () => {
    const records = goodRecords().map((r) => (r.kind === 'cancel' ? { ...r, verdict: 'cancel-not-exercised', status: 'ok' } : r));
    const e = evaluateRun(v2Run({ records, planned: plannedMain }));
    expect(e.acceptance).toBe('rejected');
    expect(e.reasons.join(' ')).toContain('cancel never exercised');
  });

  it('rejects unexpected errors, unvalidated inputs, missing provenance and incomplete harness runs', () => {
    const records = goodRecords();
    records[1] = rec(MAIN_CHECK_WORKLOADS[1], 'check', 'unexpected-error', { status: 'error' });
    expect(evaluateRun(v2Run({ records, planned: plannedMain })).acceptance).toBe('rejected');
    expect(evaluateRun(v2Run({ records: goodRecords(), planned: plannedMain, inputOk: false })).acceptance).toBe('rejected');
    expect(evaluateRun(v2Run({ records: goodRecords(), planned: plannedMain, gitHead: null })).acceptance).toBe('rejected');
    expect(evaluateRun(v2Run({ records: goodRecords(), planned: plannedMain, outcome: 'renderer-crash' })).acceptance).toBe('rejected');
  });

  it('allows OOM only in runs that declared expected boundary errors', () => {
    const planned = [{ name: 'stress_self_join_orders', kind: 'stress', reps: 1 }];
    const records = [rec('stress_self_join_orders', 'stress', 'expected-boundary-error', { status: 'error' })];
    expect(evaluateRun(v2Run({ records, planned, args: { 'expect-boundary-errors': true } })).acceptance).toBe('accepted');
    expect(evaluateRun(v2Run({ records, planned, args: {} })).acceptance).toBe('rejected');
  });

  it('counts records without a frame-gap sample', () => {
    const records = goodRecords();
    records[2] = { ...records[2], responsiveness: { maxFrameGapMs: null, frames: 0 } };
    expect(evaluateRun(v2Run({ records, planned: plannedMain })).counts.frameGapMissing).toBe(1);
  });

  it('never accepts a historical (v1) run and derives its verdicts', () => {
    const v1 = {
      outcome: { status: 'completed' },
      args: { reps: '1', 'cancel-reps': '1' },
      page: { progress: { records: [
        ...MAIN_CHECK_WORKLOADS.map((w) => ({ workload: w, status: 'ok', check: { pass: true }, responsiveness: { maxFrameGapMs: 1, frames: 1 } })),
        ...CANCEL_WORKLOADS.map((w) => ({ workload: w, status: 'cancelled', cancel: { followUp: { status: 'ok' } }, responsiveness: { maxFrameGapMs: 1, frames: 1 } })),
      ] } },
    };
    const e = evaluateRun(v1);
    expect(e.acceptance).toBe('historical-unvalidated');
    expect(e.derivedVerdicts).toBe(true);
    expect(e.counts.passed).toBe(12);
  });
});
