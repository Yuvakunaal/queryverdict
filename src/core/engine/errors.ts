import { EngineError, LeaseRevokedError, QueryVerdictError, RefusedError } from '../util/errors';
import { ShapeError } from './driver';
import type { Terminal } from './types';

/** DuckDB-WASM reports some errors as JSON ({exception_type, exception_message}); normalise them. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const j = JSON.parse(raw) as { exception_type?: string; exception_message?: string };
    if (j.exception_type && j.exception_message) return `${j.exception_type} Error: ${j.exception_message.split('\n')[0]}`;
  } catch {
    /* not JSON */
  }
  return raw.split('\n')[0] ?? 'Unknown error';
}

/** Maps any engine failure to a typed EngineError with the phase it happened in. */
export function toEngineError(e: unknown): QueryVerdictError {
  if (e instanceof QueryVerdictError) return e;
  if (e instanceof ShapeError) return new EngineError('engine', e.message, { cause: e });
  const text = errorText(e);
  const phase = /^Parser Error/i.test(text) ? 'parse' : /^(Binder|Catalog) Error/i.test(text) ? 'bind' : 'execute';
  return new EngineError(phase, text, { cause: e });
}

/** Terminal outcome for an operation body that threw. */
export function terminalFor(e: unknown): Terminal {
  if (e instanceof RefusedError) return { status: 'refused', reason: e.message };
  if (e instanceof LeaseRevokedError) return { status: 'stale', reason: 'generation-changed' };
  const err = toEngineError(e);
  if (err instanceof EngineError) return { status: 'error', phase: err.phase, message: err.message };
  return { status: 'error', phase: 'engine', message: err.message };
}
