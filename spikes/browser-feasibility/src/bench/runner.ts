// In-page benchmark runner. Used by scripts/run-bench.mjs (Chrome, automated) and by the
// Benchmark panel in the UI (manual runs, e.g. Safari). Each workload is checked against the
// expected answers computed by scripts/generate_datasets.py.
import type { BoundedResult } from '../engine/bounded';
import { EngineSession, type AttachMode, type RunOutcome } from '../engine/session';
import { browserMemory, memoryApiAvailability, ResponsivenessMonitor } from './metrics';

export interface Manifest {
  size_label: string;
  seed: number;
  files: Record<string, { bytes: number; sha256: string }>;
  expected: Record<string, number | Record<string, number>>;
  params: Record<string, number>;
  [k: string]: unknown;
}

export interface BenchConfig {
  orders: File;
  customers: File;
  manifest: Manifest;
  mode: AttachMode;
  reps: number;
  confirmedLarge?: boolean;
  inputsHashedByCaller?: boolean;
  /** Repetitions for the cancel workloads (cycles for the leak check). */
  cancelReps: number;
  workloadTimeoutMs: number;
  cancelAfterMs: number;
  memoryLimit: string | null;
  only?: string[];
  /** Opt-in memory-heavy boundary workloads (characterisation only, no answer checks). */
  stress?: boolean;
  /** When set, `Out of Memory` errors from stress workloads are expected boundary failures. */
  expectBoundaryErrors?: boolean;
}

/**
 * Per-record verdicts (schema v2). Acceptance is computed from these by scripts/lib/acceptance.mjs;
 * a completed harness run is NOT by itself a successful experiment.
 */
export type Verdict =
  | 'pass' // answer check ran and matched the known value
  | 'fail' // answer check ran and did not match
  | 'cancel-exercised' // cancel fired, query stopped, follow-up query succeeded
  | 'cancel-not-exercised' // query finished before the cancel fired (no evidence about cancel)
  | 'cancel-recovery-failed' // cancel fired but the follow-up query failed
  | 'stress-completed' // boundary workload ran to completion (no answer check)
  | 'expected-boundary-error' // Out of Memory under an explicitly expected boundary run
  | 'unexpected-error'
  | 'aborted-timeout';

export interface WorkloadRecord {
  workload: string;
  kind: WorkloadKind;
  verdict: Verdict;
  rep: number;
  status: 'ok' | 'error' | 'cancelled' | 'stale' | 'aborted-timeout' | 'skipped';
  ms: number;
  firstBatchMs: number | null;
  rowsSeen: number | null;
  truncated: boolean | null;
  check: { pass: boolean; expected: unknown; actual: unknown } | null;
  error?: string;
  cancel?: unknown;
  responsiveness: ReturnType<ResponsivenessMonitor['stop']>;
  browserMemoryAfter: ReturnType<typeof browserMemory>;
  engineMemoryAfter: Awaited<ReturnType<EngineSession['engineMemory']>>;
}

type Check = (r: BoundedResult) => { pass: boolean; expected: unknown; actual: unknown };

export type WorkloadKind = 'check' | 'cancel' | 'stress';

interface Workload {
  name: string;
  kind: WorkloadKind;
  sql: string;
  maxRows?: number;
  check?: Check;
  cancelAfterMs?: number;
}

const num = (r: BoundedResult, row = 0, col = 0) => {
  const v = r.rows[row]?.[col];
  return v === undefined || v === 'NULL' ? null : Number(v);
};
const eq = (actual: unknown, expected: unknown) => ({ pass: JSON.stringify(actual) === JSON.stringify(expected), expected, actual });

export function stressWorkloads(): Workload[] {
  return [
    // One hash-table entry per order: as many groups as rows.
    { name: 'stress_groupby_every_row', kind: 'stress', sql: 'SELECT count(*) FROM (SELECT order_id, count(*) AS n FROM orders GROUP BY order_id)' },
    // Large build side: every order hashed; output is ~ rows x orders-per-customer pairs (counted, not returned).
    { name: 'stress_self_join_orders', kind: 'stress', sql: 'SELECT count(*) FROM orders a JOIN orders b ON a.customer_id = b.customer_id' },
    { name: 'stress_count_distinct_note', kind: 'stress', sql: 'SELECT count(DISTINCT note) FROM orders' },
  ];
}

export function workloads(m: Manifest, cancelAfterMs: number): Workload[] {
  const e = m.expected as Record<string, number> & { region_rows: Record<string, number> };
  return [
    {
      name: 'schema_orders', kind: 'check',
      sql: 'DESCRIBE orders',
      check: (r) => eq(r.rows.map((x) => x[0]), ['order_id', 'customer_id', 'order_ts', 'status', 'region', 'quantity', 'amount', 'note']),
    },
    { name: 'preview_100', kind: 'check', sql: 'SELECT * FROM orders LIMIT 100', maxRows: 100, check: (r) => eq(r.rows.length, 100) },
    { name: 'count_orders', kind: 'check', sql: 'SELECT count(*) FROM orders', check: (r) => eq(num(r), e.orders_rows) },
    { name: 'count_customers', kind: 'check', sql: 'SELECT count(*) FROM customers', check: (r) => eq(num(r), e.customers_rows) },
    { name: 'filter_count', kind: 'check', sql: "SELECT count(*) FROM orders WHERE status = 'shipped'", check: (r) => eq(num(r), e.orders_shipped_rows) },
    {
      name: 'aggregate_by_region', kind: 'check',
      sql: 'SELECT region, count(*)::BIGINT, sum(round(amount * 100))::HUGEINT FROM orders GROUP BY region ORDER BY region',
      check: (r) => {
        const actual = Object.fromEntries(r.rows.map((x) => [x[0], Number(x[1])]));
        const cents = r.rows.reduce((s, x) => s + BigInt(x[2] ?? '0'), 0n).toString();
        return eq({ regions: actual, cents }, { regions: Object.fromEntries(Object.entries(e.region_rows).sort()), cents: String(e.orders_amount_cents_sum) });
      },
    },
    { name: 'sort_topn_100', kind: 'check', sql: 'SELECT order_id, amount FROM orders ORDER BY amount DESC, order_id LIMIT 100', maxRows: 100, check: (r) => eq(r.rows.length, 100) },
    // Full sort: the engine must sort every row before the first batch; only 100 rows are kept.
    { name: 'sort_full_first_100', kind: 'check', sql: 'SELECT order_id, note FROM orders ORDER BY note DESC, order_id', maxRows: 100, check: (r) => eq(r.rows.length, 100) },
    {
      name: 'equi_join_count_sum', kind: 'check',
      sql: 'SELECT count(*)::BIGINT, sum(round(o.amount * 100))::HUGEINT FROM orders o JOIN customers c ON o.customer_id = c.customer_id',
      check: (r) => eq([num(r), r.rows[0]?.[1]], [e.inner_join_rows, String(e.inner_join_amount_cents_sum)]),
    },
    {
      name: 'fanout_key_multiplicity', kind: 'check',
      sql: 'SELECT count(*) FILTER (WHERE n > 1)::BIGINT, (sum(n) - count(*))::BIGINT FROM (SELECT customer_id, count(*) AS n FROM customers GROUP BY customer_id)',
      check: (r) => eq([num(r), num(r, 0, 1)], [e.customers_duplicated_keys, e.customers_excess_rows]),
    },
    {
      name: 'fanout_left_join_rows', kind: 'check',
      sql: 'SELECT count(*)::BIGINT FROM orders o LEFT JOIN customers c ON o.customer_id = c.customer_id',
      check: (r) => eq(num(r), e.left_join_rows),
    },
    {
      name: 'rowloss_unmatched_orders', kind: 'check',
      sql: 'SELECT count(*)::BIGINT FROM orders o WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.customer_id = o.customer_id)',
      check: (r) => eq(num(r), e.orders_unmatched_rows),
    },
    {
      // CPU-heavy, memory-light (build side is the small customers table): cancelled on purpose.
      name: 'cancel_heavy_join', kind: 'cancel',
      sql: 'SELECT sum(hash(o.note, c.name, r.range)) FROM orders o JOIN customers c ON o.customer_id = c.customer_id CROSS JOIN range(1000) r',
      cancelAfterMs,
    },
    {
      // Cancel while a blocking operator (full sort) is still building its result.
      name: 'cancel_during_full_sort', kind: 'cancel',
      sql: 'SELECT order_id, note FROM orders ORDER BY note DESC, order_id',
      maxRows: 100,
      cancelAfterMs: Math.max(50, Math.round(cancelAfterMs / 4)),
    },
  ];
}

export interface BenchProgress {
  schemaVersion: 2;
  phase: string;
  /** Every workload the run intends to execute, with repetitions; used to detect missing records. */
  planned: { name: string; kind: WorkloadKind; reps: number }[];
  records: WorkloadRecord[];
  registration: { file: string; ms: number; mode: AttachMode; bytes: number }[];
  done: boolean;
  error?: string;
}

export async function environment(session: EngineSession) {
  const uaData = (navigator as unknown as { userAgentData?: { getHighEntropyValues: (h: string[]) => Promise<unknown> } }).userAgentData;
  return {
    capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    userAgentData: uaData ? await uaData.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'model']).catch(() => null) : null,
    hardwareConcurrency: navigator.hardwareConcurrency,
    memoryApis: memoryApiAvailability(),
    location: `${location.origin}${location.pathname}`,
    engine: session.info,
  };
}

export async function runBenchmark(cfg: BenchConfig, progress: BenchProgress, onUpdate: () => void = () => {}) {
  const session = new EngineSession({ memoryLimit: cfg.memoryLimit, cancelDeadlineMs: 2000 });
  const set = (phase: string) => {
    progress.phase = phase;
    onUpdate();
  };
  try {
    set('engine-start');
    await session.start();
    const env = await environment(session);
    for (const [label, file] of [['orders', cfg.orders], ['customers', cfg.customers]] as const) {
      set(`register-${label}`);
      const { ms } = await session.registerFile(file, cfg.mode, label);
      progress.registration.push({ file: file.name, ms, mode: cfg.mode, bytes: file.size });
      onUpdate();
    }
    const list = [...workloads(cfg.manifest, cfg.cancelAfterMs), ...(cfg.stress ? stressWorkloads() : [])].filter((w) => !cfg.only || cfg.only.includes(w.name));
    const repsFor = (w: Workload) => (w.kind === 'cancel' ? cfg.cancelReps : cfg.reps);
    progress.planned = list.map((w) => ({ name: w.name, kind: w.kind, reps: repsFor(w) }));
    onUpdate();
    for (const w of list) {
      const reps = repsFor(w);
      for (let rep = 1; rep <= reps; rep++) {
        set(`${w.name}#${rep}`);
        progress.records.push(await runOne(session, w, rep, cfg.workloadTimeoutMs, cfg.expectBoundaryErrors === true));
        onUpdate();
      }
    }
    set('done');
    return { environment: env, config: { ...cfg, orders: cfg.orders.name, customers: cfg.customers.name }, progress };
  } finally {
    await session.dispose();
    progress.done = true;
    onUpdate();
  }
}

export function verdictFor(
  kind: WorkloadKind,
  status: WorkloadRecord['status'],
  check: WorkloadRecord['check'],
  followUpOk: boolean | null,
  error: string | undefined,
  expectBoundaryErrors: boolean,
): Verdict {
  if (status === 'aborted-timeout') return 'aborted-timeout';
  if (kind === 'check') {
    if (status === 'ok' && check) return check.pass ? 'pass' : 'fail';
    return 'unexpected-error';
  }
  if (kind === 'cancel') {
    if (status === 'cancelled') return followUpOk ? 'cancel-exercised' : 'cancel-recovery-failed';
    if (status === 'ok') return 'cancel-not-exercised';
    return 'unexpected-error';
  }
  if (status === 'ok') return 'stress-completed';
  if (status === 'error' && expectBoundaryErrors && /Out of Memory/i.test(error ?? '')) return 'expected-boundary-error';
  return 'unexpected-error';
}

async function runOne(session: EngineSession, w: Workload, rep: number, timeoutMs: number, expectBoundaryErrors: boolean): Promise<WorkloadRecord> {
  const mon = new ResponsivenessMonitor();
  mon.start();
  const t0 = performance.now();
  let cancelReport: unknown;
  let timedOut = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (w.cancelAfterMs !== undefined) {
    timers.push(setTimeout(() => void session.cancel().then((r) => (cancelReport = { requestedAfterMs: w.cancelAfterMs, ...r })), w.cancelAfterMs));
  }
  timers.push(
    setTimeout(() => {
      timedOut = true;
      void session.cancel().then((r) => (cancelReport = { reason: 'workload timeout', ...r }));
    }, timeoutMs),
  );
  const out: RunOutcome = await session.run(w.sql, { maxRows: w.maxRows ?? 1000 });
  timers.forEach(clearTimeout);
  // Let a cancel report that is still recovering the engine finish before measuring.
  for (let i = 0; i < 600 && out.status !== 'ok' && out.status !== 'error' && cancelReport === undefined; i++) await new Promise((r) => setTimeout(r, 50));
  const ms = performance.now() - t0;
  const responsiveness = mon.stop();
  let followUp: { status: string; ms: number } | undefined;
  if (w.kind === 'cancel') {
    // Recovery check: a normal query must work after the cancel.
    const f = await session.run('SELECT count(*) FROM customers', { maxRows: 1 });
    followUp = { status: f.status, ms: f.ms };
  }
  const status: WorkloadRecord['status'] = timedOut ? 'aborted-timeout' : out.status;
  const check = out.status === 'ok' && w.check ? w.check(out.result) : null;
  const rec: WorkloadRecord = {
    workload: w.name,
    kind: w.kind,
    verdict: verdictFor(w.kind, status, check, followUp ? followUp.status === 'ok' : null, out.status === 'error' ? out.error : undefined, expectBoundaryErrors),
    rep,
    status,
    ms,
    firstBatchMs: out.status === 'ok' ? out.result.firstBatchMs : null,
    rowsSeen: out.status === 'ok' ? out.result.rowsSeen : null,
    truncated: out.status === 'ok' ? out.result.truncated : null,
    check,
    responsiveness,
    browserMemoryAfter: browserMemory(),
    engineMemoryAfter: await session.engineMemory(),
    ...(out.status === 'error' ? { error: out.error } : {}),
    ...(cancelReport || followUp ? { cancel: { report: cancelReport, followUp } } : {}),
  };
  return rec;
}
