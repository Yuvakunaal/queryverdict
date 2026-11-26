// The single execution-budget gate (docs/ARCHITECTURE.md §14.1; QV-ENG-001, QV-RES-002; corrects
// QV-SA-001). Every diagnostic statement of an analysis is approved here BEFORE it runs, with its
// cost priced from information already known (input row counts, key widths, key frequencies).
//
//  - pairRows: rows a pair-producing probe can produce through the join (the executed count and
//    every witness recount through the join). CUMULATIVE over the analysis, ≤ executionPairRows.
//  - groupingBytes: estimated hash/grouping state while the probe runs (rows × (key bytes + 16 +
//    64 assumed overhead)). State that stays resident (the key-frequency temp tables) is retained;
//    each probe must fit next to everything retained, ≤ groupingBytes.
//  - scansOfInputs: full scans of an input relation (reported; bounded by the input-row limit).
//  - transferred diagnostic bytes: text received from the engine, ≤ maxTransferBytes.
//
// Unknown, negative or malformed costs are refused (fail closed). A refusal is final for that
// probe; the caller reports the probe `not-run` and the report cannot be authoritative. These are
// application work budgets, not browser memory guarantees: DuckDB's memory_limit is the only
// engine-enforced memory control.

export type ProbeName =
  | 'transaction-check' | 'parse' | 'render' | 'bind' | 'relations' | 'columns' | 'memory-limit'
  | 'input-rows' | 'fingerprint-start' | 'frequencies-left' | 'frequencies-right' | 'statistics'
  | 'semi-join-left' | 'semi-join-right' | 'executed-count' | 'witness-selection' | 'witness-inputs'
  | 'witness-join' | 'fingerprint-end' | 'identity-end';

/** Probes that can produce join pairs (QV-SA-001). */
export const PAIR_PRODUCING: ReadonlySet<ProbeName> = new Set<ProbeName>(['executed-count', 'witness-join']);

export interface ProbeCost {
  readonly scansOfInputs: number;
  readonly pairRows: bigint;
  readonly groupingBytes: bigint;
  /** The grouping state stays allocated after the probe (temporary tables). */
  readonly retainsGrouping?: boolean;
}

export interface BudgetLimits {
  readonly executionPairRows: bigint;
  readonly groupingBytes: bigint;
  readonly maxInputRows: bigint;
  readonly maxTransferBytes: number;
}

export interface Spent {
  readonly scansOfInputs: number;
  readonly pairRows: bigint;
  /** Peak estimated grouping state (retained + the largest transient probe). */
  readonly groupingBytes: bigint;
  readonly transferredBytes: number;
}

export interface ProbeRecord {
  readonly probe: ProbeName;
  readonly cost: { readonly scansOfInputs: number; readonly pairRows: string; readonly groupingBytes: string };
  readonly decision: 'approved' | 'refused';
  readonly reason?: string;
}

export type Approval = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface BudgetGate {
  /** Approve or refuse a probe; approved costs are added to the cumulative totals. */
  approve(probe: ProbeName, cost: ProbeCost): Approval;
  /** Whether a set of probes would fit together, without spending anything. */
  check(costs: readonly ProbeCost[]): Approval;
  /** Records that a probe was not run because a plan it belongs to was refused (spends nothing). */
  deny(probe: ProbeName, cost: ProbeCost, reason: string): void;
  /** Accounts diagnostic text received from the engine; refuses once the limit is exceeded. */
  recordTransfer(bytes: number): Approval;
  readonly spent: Spent;
  readonly limits: BudgetLimits;
  readonly log: readonly ProbeRecord[];
}

/** Estimated grouping-state bytes for `rows` groups of `keyBytes` (P-032; an estimate, not a measurement). */
export const GROUP_ENTRY_OVERHEAD_BYTES = 64n;
export const COUNT_BYTES = 16n;
export function groupingEstimate(rows: bigint, keyBytes: bigint): bigint {
  return rows * (keyBytes + COUNT_BYTES + GROUP_ENTRY_OVERHEAD_BYTES);
}

/** Bytes of diagnostic text an analysis may receive (bounded probe outputs; not a profile setting). */
export const MAX_DIAGNOSTIC_TRANSFER_BYTES = 1_048_576;

function invalidCost(c: ProbeCost): string | null {
  if (typeof c !== 'object' || c === null) return 'cost missing';
  if (!Number.isSafeInteger(c.scansOfInputs) || c.scansOfInputs < 0) return 'scansOfInputs must be a non-negative integer';
  if (typeof c.pairRows !== 'bigint' || c.pairRows < 0n) return 'pairRows must be a known non-negative integer';
  if (typeof c.groupingBytes !== 'bigint' || c.groupingBytes < 0n) return 'groupingBytes must be a known non-negative integer';
  return null;
}

function invalidLimits(l: BudgetLimits): string | null {
  for (const k of ['executionPairRows', 'groupingBytes', 'maxInputRows'] as const) if (typeof l[k] !== 'bigint' || l[k] <= 0n) return `${k} must be a positive integer`;
  if (!Number.isSafeInteger(l.maxTransferBytes) || l.maxTransferBytes <= 0) return 'maxTransferBytes must be a positive integer';
  return null;
}

export function createBudgetGate(limits: BudgetLimits): BudgetGate {
  const bad = invalidLimits(limits);
  let scans = 0;
  let pairs = 0n;
  let retained = 0n;
  let peak = 0n;
  let transferred = 0;
  let exhausted: string | null = bad ? `invalid limits: ${bad}` : null;
  const log: ProbeRecord[] = [];

  const evaluate = (costs: readonly ProbeCost[]): Approval => {
    if (exhausted) return { ok: false, reason: exhausted };
    let p = pairs;
    let r = retained;
    for (const c of costs) {
      const invalid = invalidCost(c);
      if (invalid) return { ok: false, reason: `unknown or invalid cost: ${invalid}` };
      p += c.pairRows;
      if (p > limits.executionPairRows) return { ok: false, reason: `pair-producing work would reach ${p} rows, over the execution budget of ${limits.executionPairRows}` };
      if (r + c.groupingBytes > limits.groupingBytes) return { ok: false, reason: `estimated grouping state ${r + c.groupingBytes} bytes exceeds the budget of ${limits.groupingBytes}` };
      if (c.retainsGrouping) r += c.groupingBytes;
    }
    return { ok: true };
  };

  return {
    limits,
    get log() {
      return log;
    },
    get spent(): Spent {
      return { scansOfInputs: scans, pairRows: pairs, groupingBytes: peak, transferredBytes: transferred };
    },
    check: (costs) => evaluate(costs),
    approve(probe, cost) {
      const a = evaluate([cost]);
      const record = { scansOfInputs: Number.isSafeInteger(cost?.scansOfInputs) ? cost.scansOfInputs : -1, pairRows: String(cost?.pairRows), groupingBytes: String(cost?.groupingBytes) };
      if (!a.ok) {
        log.push({ probe, cost: record, decision: 'refused', reason: a.reason });
        return a;
      }
      scans += cost.scansOfInputs;
      pairs += cost.pairRows;
      const during = retained + cost.groupingBytes;
      if (during > peak) peak = during;
      if (cost.retainsGrouping) retained += cost.groupingBytes;
      log.push({ probe, cost: record, decision: 'approved' });
      return a;
    },
    deny(probe, cost, reason) {
      log.push({ probe, cost: { scansOfInputs: cost.scansOfInputs, pairRows: String(cost.pairRows), groupingBytes: String(cost.groupingBytes) }, decision: 'refused', reason });
    },
    recordTransfer(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        exhausted = 'invalid transfer size';
        return { ok: false, reason: exhausted };
      }
      transferred += bytes;
      if (transferred > limits.maxTransferBytes) {
        exhausted = `diagnostic responses reached ${transferred} bytes, over the limit of ${limits.maxTransferBytes}`;
        return { ok: false, reason: exhausted };
      }
      return { ok: true };
    },
  };
}

/** Free probes: catalog reads, parsing and binding (no input scans, no grouping, no pairs). */
export const FREE: ProbeCost = Object.freeze({ scansOfInputs: 0, pairRows: 0n, groupingBytes: 0n });
