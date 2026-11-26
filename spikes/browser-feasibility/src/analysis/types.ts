// Types for the experimental SQL correctness analysis engine (spike; docs/FEASIBILITY.md §11–§12).

/** Diagnostic categories. A report never contains an overall "pass". */
export type FindingCategory =
  | 'observed' // a measured property of this data snapshot (not a judgement)
  | 'suspicious' // a pattern that is often a mistake but may be intended
  | 'expectation-violation' // a user-declared expectation contradicted by complete evidence
  | 'expectation-unchecked' // a declared expectation that could not be evaluated (reason given)
  | 'unsupported' // a construct outside the analysed subset; no conclusion is drawn
  | 'inconclusive' // analysis attempted, but evidence is incomplete or contradictory
  | 'diagnostic-failure' // a diagnostic statement failed (the user's query may still be fine)
  | 'query-failure'; // the user's query itself cannot be parsed or bound

export interface Finding {
  category: FindingCategory;
  code: string;
  message: string;
  /** Join index (0-based, in FROM order) when the finding is about one join. */
  join?: number;
  /** Counts are exact decimal strings (may exceed 2^53). */
  evidence?: Record<string, unknown>;
}

export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
export type Relationship = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

/** Exact per-join statistics computed from key frequencies (BigInt). */
export interface JoinStats {
  leftRows: bigint;
  rightRows: bigint;
  leftNullKeyRows: bigint;
  rightNullKeyRows: bigint;
  /** Σ L(k) over non-NULL keys; must equal leftRows − leftNullKeyRows (invariant). */
  leftKeyedRows: bigint;
  rightKeyedRows: bigint;
  leftDistinctKeys: bigint;
  rightDistinctKeys: bigint;
  leftDuplicateKeys: bigint;
  rightDuplicateKeys: bigint;
  leftMaxMultiplicity: bigint;
  rightMaxMultiplicity: bigint;
  /** Largest L(k) / R(k) among keys present on both sides. */
  leftMaxMultiplicityMatched: bigint;
  rightMaxMultiplicityMatched: bigint;
  matchedKeys: bigint;
  matchedPairs: bigint;
  leftRowsMatched: bigint;
  rightRowsMatched: bigint;
  /** Left rows whose key matches more than one right row (each appears >1 time in the output). */
  leftRowsMultiplied: bigint;
  /** Extra output copies of left rows beyond one each: Σ L(k)·(R(k)−1) over R(k) > 1. */
  leftExcessCopies: bigint;
  rightRowsMultiplied: bigint;
  rightExcessCopies: bigint;
}

export interface JoinDerived {
  outputRows: bigint;
  leftUnmatchedRows: bigint;
  rightUnmatchedRows: bigint;
  /** Input rows absent from the output (unmatched rows on a non-preserved side). */
  leftRowsDropped: bigint;
  rightRowsDropped: bigint;
  /** Relationship from key uniqueness of each whole input (NULL keys excluded). */
  relationship: Relationship;
  /** Relationship among matched keys only (what actually multiplied rows in this join). */
  effectiveRelationship: Relationship | 'no-matches';
}

/** How a join's statistics were validated against the engine's own join semantics. */
export interface JoinValidation {
  invariants: 'held' | 'violated';
  invariantViolations: string[];
  /** Matched rows counted by SEMI JOIN with the query's own condition (engine semantics, no pair enumeration). */
  semiJoin: 'agreed' | 'disagreed' | 'not-run';
  /** count(*) of the join itself; only within the execution budget. */
  executedCount: 'agreed' | 'disagreed' | 'not-run';
  executedCountSkippedReason?: string;
  /**
   * Witness identity: every sampled key was re-counted through the query's own join node (and
   * the input relations) and produced exactly the rows the frequency tables claim.
   */
  witnesses: 'verified' | 'mismatch' | 'not-run';
  /** Key-multiset fingerprint of both inputs at the start equals the one at the end of the analysis. */
  snapshot: 'verified' | 'changed' | 'not-run';
}

export interface JoinReport {
  index: number;
  type: JoinType;
  left: string;
  right: string;
  keys: { left: string; right: string; type: string }[];
  /** How the left-side key frequencies were obtained. */
  method: 'base-relation-frequencies' | 'executed-intermediate-frequencies';
  /** Present only when the statistics passed validation; otherwise the join is inconclusive. */
  stats: Record<keyof JoinStats, string> | null;
  derived: (Omit<Record<keyof JoinDerived, string>, 'relationship' | 'effectiveRelationship'> & Pick<JoinDerived, 'relationship' | 'effectiveRelationship'>) | null;
  validation: JoinValidation;
  /**
   * Bounded witnesses (at most 5 each). fanOutKeys rows: key values, left count, right count.
   * unmatched rows: key values, row count on that side. All verified (validation.witnesses).
   */
  samples: { fanOutKeys: string[][]; unmatchedLeftKeys: string[][]; unmatchedRightKeys: string[][] } | null;
}

export interface Stage {
  stage: string;
  rows: string;
  /** count-only probes count rows of a rewritten statement; they do not evaluate the SELECT list and do not show that the query runs. */
  method: 'frequency-formula' | 'count-only-probe';
}

export type Expectation =
  | { kind: 'relationship'; join: number; expected: Relationship }
  | { kind: 'no-row-loss'; join: number; side: 'left' | 'right' }
  /** No input row of `side` (default: left) appears more than once in the join output. */
  | { kind: 'no-fan-out'; join: number; side?: 'left' | 'right' }
  /** EXPERIMENTAL: the query result has at most one row per these output columns. */
  | { kind: 'grain'; columns: string[] }
  /**
   * EXPERIMENTAL: SUM of a source column over the joined (and filtered) rows equals its source
   * total. NULL totals (no non-NULL values) are compared as NULL, never as zero, unless
   * nullAsZero is set explicitly. tolerance is relative and applies to non-NULL totals only.
   */
  | { kind: 'metric-preserved'; column: string; tolerance?: number; nullAsZero?: boolean }
  | { kind: 'row-count'; min?: number; max?: number };

export interface ExpectationOutcome {
  /** Position in the declared list; every declared expectation has exactly one outcome. */
  index: number;
  /** The declared expectation, unchanged. */
  expectation: Expectation;
  outcome: 'violated' | 'held' | 'unchecked';
  reason?: string;
  evidence?: Record<string, unknown>;
}

export type Scope = 'mvp' | 'experimental';

/** How each input relation was classified. Only verified base tables can support an authoritative report. */
export interface RelationInfo {
  ref: string;
  name: string;
  kind: 'base-table' | 'temporary-table' | 'view' | 'cte' | 'unresolved' | 'ambiguous';
  /** database.schema and table oid for tables; checked again at the end of the analysis. */
  identity?: { database: string; schema: string; oid: string };
  /** Why this relation cannot support an authoritative report (absent when it can). */
  refusal?: string;
}

/**
 * Resource qualification, reported separately (Codex second review H-B). These are the analyser's
 * own pre-checks and estimates; they are not guarantees about browser or WASM memory. The engine
 * memory limit is the control the engine itself enforces.
 */
export interface Resources {
  /** Bounded row counts per relation (LIMIT maxInputRows + 1 scan); "over" when above the limit. */
  inputRows: Record<string, string>;
  maxInputRows: string;
  keyColumns: number;
  maxKeyColumns: number;
  /** Fixed key bytes per row from the key types; null when a key type has no fixed width. */
  keyBytesPerRow: number | null;
  /** Estimated hash-grouping state per side, computed BEFORE any grouping runs. An estimate. */
  estimatedGroupingBytes: Record<string, string>;
  maxGroupingStateBytes: string;
  /** DuckDB memory_limit in effect (the engine-enforced control). */
  engineMemoryLimit: string | null;
  /** Diagnostic statements executed (each scans at most the inputs or the frequency tables). */
  statements: number;
}

export interface TerminalInfo {
  reason: 'deadline' | 'queue-wait' | 'cancelled' | 'stale' | 'terminated';
  /** How the running statement was stopped. */
  cancellation: 'not-needed' | 'pending' | 'cooperative' | 'terminated';
}

export interface AnalysisReport {
  scope: Scope;
  /**
   * True only for MVP-scope reports whose statistics and witnesses all passed validation on one
   * verified snapshot owned exclusively by the analysis (see nonAuthoritativeReasons).
   * Experimental reports are never authoritative.
   */
  authoritative: boolean;
  /** Every reason the report is not authoritative; empty exactly when authoritative is true. */
  nonAuthoritativeReasons: string[];
  status: 'analyzed' | 'partially-analyzed' | 'inconclusive' | 'unsupported' | 'query-failed' | 'diagnostic-failed' | 'budget-exhausted' | 'cancelled';
  /** Terminal event that ended the analysis early, if any. */
  terminal?: TerminalInfo;
  relations: RelationInfo[];
  resources: Resources | null;
  findings: Finding[];
  expectations: ExpectationOutcome[];
  joins: JoinReport[];
  stages: Stage[];
  ctes: { name: string; report: AnalysisReport }[];
  coverage: { checked: string[]; notChecked: string[] };
  /** Every diagnostic statement executed, for reproducibility. */
  diagnosticSql: string[];
  disclaimer: string;
}

export interface QueryShape {
  columns?: number;
  maxRows?: number;
  exactRows?: number;
}

/** Executes diagnostic SQL; returns exact text values; throws on failure, truncation or wrong shape. */
export interface Executor {
  query(sql: string, shape?: QueryShape): Promise<string[][]>;
  /** Runs a cleanup statement even after the analysis deadline (short timeout of its own). */
  cleanup?(sql: string): Promise<unknown>;
  /**
   * Present only when every statement runs in one exclusive session batch, inside one
   * transaction, on one engine generation (analyzeInSession). Without it no report is authoritative.
   */
  snapshot?: { isCurrent(): boolean };
}
