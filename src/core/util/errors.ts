// Typed error foundation (docs/ARCHITECTURE.md §21). Later modules throw these so services can
// translate failures into accurately classified user states. Messages must never contain
// dataset contents.

export type ErrorCode =
  | 'policy'
  | 'lease-revoked'
  | 'deadline'
  | 'queue-wait'
  | 'stale-generation'
  | 'import'
  | 'engine'
  | 'refused'
  | 'configuration';

export class QueryVerdictError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

/** A mandatory security control is missing or not in effect (fail closed). */
export class PolicyError extends QueryVerdictError {
  constructor(message: string, options?: { cause?: unknown }) { super('policy', message, options); }
}
/** An operation used its lease after the session revoked it. */
export class LeaseRevokedError extends QueryVerdictError {
  constructor(message = 'The operation no longer owns the engine', options?: { cause?: unknown }) { super('lease-revoked', message, options); }
}
/** An operation exceeded its deadline. */
export class DeadlineError extends QueryVerdictError {
  constructor(message: string, options?: { cause?: unknown }) { super('deadline', message, options); }
}
/** An operation waited too long for the engine and never started. */
export class QueueWaitError extends QueryVerdictError {
  constructor(message: string, options?: { cause?: unknown }) { super('queue-wait', message, options); }
}
/** A result belongs to an engine generation that is no longer current. */
export class StaleGenerationError extends QueryVerdictError {
  constructor(message: string, options?: { cause?: unknown }) { super('stale-generation', message, options); }
}
/** A file import failed at a known stage. */
export class ImportError extends QueryVerdictError {
  readonly stage: string;
  constructor(stage: string, message: string, options?: { cause?: unknown }) { super('import', message, options); this.stage = stage; }
}
/** The engine reported an error; `phase` says where it happened. */
export class EngineError extends QueryVerdictError {
  readonly phase: 'parse' | 'bind' | 'execute' | 'engine';
  constructor(phase: 'parse' | 'bind' | 'execute' | 'engine', message: string, options?: { cause?: unknown }) { super('engine', message, options); this.phase = phase; }
}
/** The request was refused by policy before any work was done. */
export class RefusedError extends QueryVerdictError {
  constructor(message: string, options?: { cause?: unknown }) { super('refused', message, options); }
}
/** The application is misconfigured (for example an invalid release profile). */
export class ConfigurationError extends QueryVerdictError {
  constructor(message: string, options?: { cause?: unknown }) { super('configuration', message, options); }
}
