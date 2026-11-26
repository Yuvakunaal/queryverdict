// Engine and session contracts (docs/ARCHITECTURE.md §8–§9, docs/IMPLEMENTATION_PLAN.md M02).

export type Generation = number & { readonly __brand: 'Generation' };
export type DataEpoch = number & { readonly __brand: 'DataEpoch' };
export type OperationId = string & { readonly __brand: 'OperationId' };

export type OperationKind = 'query' | 'import' | 'remove' | 'reimport' | 'verdict' | 'catalog';

export type SessionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'busy'; readonly op: OperationId }
  | { readonly kind: 'cancelling'; readonly op: OperationId }
  | { readonly kind: 'recovering'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'disposed' };

/** How an operation ended. Every handle settles exactly once with one of these. */
export type Terminal =
  | { readonly status: 'ok' }
  | { readonly status: 'error'; readonly message: string; readonly phase: 'parse' | 'bind' | 'execute' | 'engine' }
  | { readonly status: 'cancelled'; readonly by: 'user' | 'deadline'; readonly stop: 'cooperative' | 'terminated' }
  | { readonly status: 'stale'; readonly reason: 'generation-changed' | 'disposed' }
  | { readonly status: 'refused'; readonly reason: string };

export interface OperationResult<T> {
  readonly terminal: Terminal;
  readonly value?: T;
  /** Engine generation the operation ran on (null if it never started). */
  readonly generation: Generation | null;
}

export interface OperationHandle<T> {
  readonly id: OperationId;
  readonly kind: OperationKind;
  /** Assigned when the operation starts; null while queued or if it never started. */
  readonly generation: Generation | null;
  /** Always settles, exactly once, within the operation's bounds. Never rejects. */
  readonly result: Promise<OperationResult<T>>;
  /** Cancels a queued operation (no engine work) or revokes an active one. Idempotent. */
  cancel(): void;
}

export interface OperationBounds {
  /** Time allowed before the operation starts. */
  readonly queueWaitMs: number;
  /** Deadline once started; the lease is revoked when it expires. */
  readonly runMs: number;
  /** Bound for the cooperative cancel request, and separately for the statement to stop. */
  readonly cancelGraceMs: number;
  /** Bound for each session-run cleanup statement. */
  readonly cleanupMs: number;
}

/** Expected shape of an engine-internal statement result (values must be text or NULL). */
export interface QueryShape {
  readonly columns?: number;
  readonly maxRows: number;
  readonly exactRows?: number;
}

export type Cell = string | null;
export type Rows = readonly (readonly Cell[])[];

/** Capability passed to an operation body. Every method rejects after revocation. */
export interface Lease {
  readonly id: OperationId;
  readonly generation: Generation;
  /** Aborted on cancel, deadline, revocation, recovery or dispose. */
  readonly signal: AbortSignal;
  /** Runs one statement (cooperatively cancellable) and returns text rows of the declared shape. */
  query(sql: string, shape: QueryShape): Promise<Rows>;
  /** Checks whether `sql` can be prepared as a single statement without executing it. */
  prepareCheck(sql: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /**
   * Registers a cleanup statement the session runs (bounded) if the operation ends without
   * running it itself. Deferred cleanups run newest first (like unwinding a stack).
   */
  deferCleanup(sql: string): void;
  /** Registers unregistration of a file the session performs (bounded) if the operation does not. */
  deferDropFile(name: string): void;
  /** Removes a deferred cleanup without running it (for example ROLLBACK after a successful COMMIT). */
  forgetCleanup(sql: string): void;
  /** Runs a cleanup statement now and removes it from the deferred list. */
  cleanup(sql: string): Promise<'ok' | 'failed'>;
  registerFile(name: string, file: File): Promise<void>;
  dropFile(name: string): Promise<void>;
}

export interface BootInfo {
  readonly generation: Generation;
  readonly bundle: 'eh' | 'mvp';
  readonly duckdb: string;
  readonly packageVersion: string;
  readonly verified: true;
  readonly bootMs: number;
  readonly loadedExtensions: readonly string[];
}

export type SessionEvent =
  | { readonly type: 'state'; readonly state: SessionState }
  | { readonly type: 'ready'; readonly info: BootInfo }
  | { readonly type: 'epoch'; readonly epoch: DataEpoch }
  | { readonly type: 'operation'; readonly id: OperationId; readonly kind: OperationKind; readonly phase: 'queued' | 'active' | 'settled'; readonly terminal?: Terminal }
  | { readonly type: 'log'; readonly message: string };

export interface StatementClass {
  /** select: exactly one read-only SELECT; possibly-mutating: one statement of another kind. */
  readonly kind: 'select' | 'possibly-mutating' | 'multiple' | 'unparseable';
  readonly transactionHint: 'begin' | 'end' | null;
  readonly detail?: string;
}
