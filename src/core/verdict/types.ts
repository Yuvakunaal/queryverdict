// Verdict contracts (docs/ARCHITECTURE.md §14.3, IMPLEMENTATION_PLAN.md M08 field 10; P-026, P-034,
// P-037). Counts are exact: bigint inside the analyser, decimal strings in reports.
import type { DatasetOrigin } from '../datasets/types';
import type { DataEpoch, Generation, OperationHandle } from '../engine/types';
import type { ProbeRecord } from './budget';

export type JoinType = 'INNER' | 'LEFT';
export type Relationship = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
export const RELATIONSHIPS: readonly Relationship[] = ['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'];

/** The four P0 join-stage expectations. Anything else is unchecked (QV-ENG-015). */
export type Expectation =
  | { readonly kind: 'relationship'; readonly join: 0; readonly expected: Relationship }
  | { readonly kind: 'no-row-loss'; readonly join: 0; readonly side: 'left' | 'right' }
  | { readonly kind: 'no-fan-out'; readonly join: 0; readonly side: 'left' | 'right' }
  | { readonly kind: 'row-count'; readonly min?: number; readonly max?: number };

export interface ExpectationOutcome {
  readonly index: number;
  /** The declared value, unchanged (same object identity). */
  readonly expectation: unknown;
  readonly outcome: 'held' | 'violated' | 'unchecked';
  readonly reason?: string;
  readonly evidence?: Readonly<Record<string, string>>;
}

/** Exact key-frequency statistics of one join (see stats.ts for definitions). */
export interface JoinStats {
  readonly leftRows: bigint;
  readonly rightRows: bigint;
  readonly leftNullKeyRows: bigint;
  readonly rightNullKeyRows: bigint;
  readonly leftKeyedRows: bigint;
  readonly rightKeyedRows: bigint;
  readonly leftDistinctKeys: bigint;
  readonly rightDistinctKeys: bigint;
  readonly leftDuplicateKeys: bigint;
  readonly rightDuplicateKeys: bigint;
  readonly leftMaxMultiplicity: bigint;
  readonly rightMaxMultiplicity: bigint;
  readonly leftMaxMultiplicityMatched: bigint;
  readonly rightMaxMultiplicityMatched: bigint;
  readonly matchedKeys: bigint;
  readonly matchedPairs: bigint;
  readonly leftRowsMatched: bigint;
  readonly rightRowsMatched: bigint;
  readonly leftRowsMultiplied: bigint;
  readonly leftExcessCopies: bigint;
  readonly rightRowsMultiplied: bigint;
  readonly rightExcessCopies: bigint;
}

export interface JoinDerived {
  readonly outputRows: bigint;
  readonly leftUnmatchedRows: bigint;
  readonly rightUnmatchedRows: bigint;
  /** Unmatched rows of a side the join does not preserve (they contribute no output). */
  readonly leftRowsDropped: bigint;
  readonly rightRowsDropped: bigint;
  /** Unmatched rows kept with NULLs on the other side (LEFT join, left side). */
  readonly leftRowsPreserved: bigint;
  /** Whole-input relationship, from key uniqueness on each side. */
  readonly relationship: Relationship;
  /** Relationship among matched keys only. */
  readonly matchedRelationship: Relationship | 'no-matches';
}

export type Exact<T> = { readonly [K in keyof T]: T[K] extends bigint ? string : T[K] };

export type WitnessKind = 'fan-out' | 'unmatched-left' | 'unmatched-right';
export interface Witness {
  readonly kind: WitnessKind;
  /** Key values as exact decimal text, in key order. */
  readonly key: readonly string[];
  readonly leftRows: string;
  readonly rightRows: string;
  /** Rows this key contributes to the join output (L·R, or L for a preserved unmatched left key). */
  readonly outputRows: string;
}

export type Check = 'agreed' | 'disagreed' | 'not-run';
export interface JoinValidation {
  readonly invariants: 'held' | 'violated' | 'not-run';
  readonly invariantViolations: readonly string[];
  readonly semiJoin: Check;
  readonly executedCount: Check;
  readonly witnesses: 'verified' | 'mismatch' | 'not-run';
  readonly snapshot: 'verified' | 'changed' | 'not-run';
  /** Why a check did not run or did not agree. */
  readonly notes: readonly string[];
}

export interface RelationRef {
  /** The name as written in the query and its reference (alias, or the name). */
  readonly name: string;
  readonly ref: string;
}

export interface JoinEvidence {
  readonly type: JoinType;
  readonly left: RelationRef;
  readonly right: RelationRef;
  readonly keys: readonly { readonly left: string; readonly right: string; readonly type: string }[];
  /** Null when the evidence was withdrawn or never validated. */
  readonly stats: Exact<JoinStats> | null;
  readonly derived: Exact<JoinDerived> | null;
  /** At most five per kind, in a deterministic order. */
  readonly witnesses: readonly Witness[];
  readonly validation: JoinValidation;
}

export type FindingCategory = 'observed' | 'suspicious' | 'expectation-violation' | 'expectation-unchecked'
  | 'unsupported' | 'inconclusive' | 'diagnostic-failure' | 'query-failure';
export type DisplayLabel = 'Observation' | 'Suspicious pattern' | 'Expectation violation'
  | 'Unsupported' | 'Inconclusive' | 'Unchecked' | 'Diagnostic failure' | 'Query failure';
export type Severity = 'info' | 'warning' | 'error' | 'status' | 'operational-error';
/** Categorical confidence (PRD §4): validated, incomplete or unsupported. */
export type Confidence = 'validated' | 'incomplete' | 'unsupported';

export interface Finding {
  readonly category: FindingCategory;
  readonly label: DisplayLabel;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly code: string;
  readonly message: string;
  readonly evidence?: Readonly<Record<string, string>>;
}

export interface DatasetIdentity {
  readonly relation: string;
  readonly database: string;
  readonly schema: string;
  readonly oid: string;
  readonly temporary: boolean;
  /** From the dataset registry when known; the catalog decides eligibility, not this. */
  readonly origin: DatasetOrigin | 'unknown';
}

export interface ResourceReport {
  readonly limits: { readonly executionPairRows: string; readonly groupingBytes: string; readonly maxInputRows: string; readonly maxKeyColumns: number; readonly maxTransferBytes: number; readonly deadlineMs: number };
  readonly spent: { readonly scansOfInputs: number; readonly pairRows: string; readonly groupingBytes: string; readonly transferredBytes: number };
  readonly inputRows: Readonly<Record<string, string>>;
  readonly keyBytesPerRow: number | null;
  readonly estimatedGroupingBytes: Readonly<Record<string, string>>;
  readonly engineMemoryLimit: string | null;
  readonly probes: readonly ProbeRecord[];
  /** Diagnostic statements sent to the engine (never the user's query itself). */
  readonly statements: number;
}

/** One labelled statement of a replay bundle (ARCHITECTURE §18.2; M12, replay.ts). */
export interface ReplayStatement {
  /** What the statement measures, in words. */
  readonly label: string;
  readonly sql: string;
  /**
   * The value the report holds for this statement's result, as exact text. One row is its cells
   * joined by ", "; several rows are joined by "; "; "(no rows)" when the report holds none.
   * Absent for setup statements (they create the temporary frequency tables).
   */
  readonly expect?: string;
  /** Machine-readable source of `expect` in the report (for verification), e.g. "stats.leftRows". */
  readonly measures?: string;
}

export interface ReplayBundle {
  /** Engine the analysis ran on, from the session's boot information (never a constant). */
  readonly engine: { readonly duckdb: string; readonly package: string };
  /** Tables, columns and snapshot the statements need, in words. */
  readonly prerequisites: string;
  readonly statements: readonly ReplayStatement[];
  /** Temporary tables the script creates (it drops nothing and changes no other table). */
  readonly temporaryTables: readonly string[];
  /** What the bundle does not reproduce, and why. */
  readonly limitations: readonly string[];
}

export type ReportStatus = 'analyzed' | 'partially-analyzed' | 'inconclusive' | 'unsupported' | 'query-failed'
  | 'diagnostic-failed' | 'budget-exhausted' | 'cancelled' | 'stale';

export interface VerdictReport {
  readonly id: string;
  readonly identity: { readonly queryHash: string; readonly sqlText: string; readonly inputs: readonly DatasetIdentity[] };
  /** Generation and epoch the analysis ran on (null when it never reached the engine). */
  readonly stamp: { readonly generation: Generation | null; readonly epoch: DataEpoch; readonly finalisedAt: number };
  readonly authoritative: boolean;
  readonly nonAuthoritativeReasons: readonly string[];
  readonly status: ReportStatus;
  readonly join: JoinEvidence | null;
  readonly findings: readonly Finding[];
  /** Exactly one per declared expectation, in declaration order. */
  readonly expectations: readonly ExpectationOutcome[];
  readonly coverage: { readonly checked: readonly string[]; readonly notChecked: readonly string[] };
  readonly resources: ResourceReport | null;
  /** The curated diagnostic replay (M12): present only on an authoritative report. */
  readonly replay: ReplayBundle | null;
  /** Why `replay` is null, in words (M12). */
  readonly replayUnavailable?: string;
  readonly disclaimer: string;
}

export interface VerdictService {
  analyze(sql: string, expectations: readonly unknown[]): OperationHandle<VerdictReport>;
}
