// Seam between the session and the engine implementation. The production implementation is
// DuckDBDriver (duckdb-driver.ts); unit tests use scripted stand-ins, and the test harness wraps
// the real driver to inject faults. The session never touches DuckDB-WASM directly.
import type { BatchConsumer, QueryShape, Rows } from './types';

export interface EngineInstance {
  readonly bundle: 'eh' | 'mvp';
  /** Engine version reported by the database (e.g. v1.5.4). */
  readonly duckdbVersion: string;
  /** Runs one statement through the streaming API (cancellable with cancel()). */
  run(sql: string, shape: QueryShape): Promise<Rows>;
  /**
   * Runs one statement through the streaming API and hands each Arrow batch, with its buffer
   * size, to `consume` before anything in it is converted. When `consume` returns false the rest
   * of the result is never requested and the statement is cancelled in the engine.
   */
  stream(sql: string, consume: BatchConsumer): Promise<void>;
  /** Cooperative cancel of the statement started by run() or stream(); resolves whether it was accepted. */
  cancel(): Promise<boolean>;
  /** Prepares and immediately closes a statement; rejects with the engine's message if it cannot. */
  prepareCheck(sql: string): Promise<void>;
  registerFile(name: string, file: File): Promise<void>;
  dropFile(name: string): Promise<void>;
  /** Terminates the worker synchronously. Pending calls never resolve afterwards. */
  terminate(): void;
}

export interface EngineDriver {
  /**
   * Creates a worker and an open, connected, single-threaded in-memory database, before any
   * lockdown. Must reject (and terminate what it created) if `signal` aborts.
   */
  boot(signal: AbortSignal): Promise<EngineInstance>;
  /** Same-origin URL of the vendored extension repository. */
  readonly extensionRepository: string;
  /** Version of the engine package, for the boot record. */
  readonly packageVersion: string;
}

/**
 * Thrown by EngineInstance.stream when the engine did not confirm that a stream stopped early
 * (its cancel request was rejected). The session then cannot trust the connection and restarts.
 */
export class StreamStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamStopError';
  }
}

/** Thrown by EngineInstance.run when a result violates its declared shape. */
export class ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeError';
  }
}
