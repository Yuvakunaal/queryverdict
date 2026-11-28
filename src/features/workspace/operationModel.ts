// Operation presentation (M10; PRD §5 state matrix; UI_SPECIFICATION §6). Pure functions over the
// operation store's entries and the engine state: names, outcome sentences, the reason a queued
// operation waits, and elapsed time on this tab's clock. Nothing here predicts completion, measures
// memory or invents progress.
import type { OperationKind, SessionState, Terminal } from '../../core/engine/types';
import type { OperationEntry } from '../../stores/operationStore';

/** What the operation is doing while it runs (UI_SPECIFICATION §6 wording). */
export const ACTIVE_TEXT: Record<OperationKind, string> = {
  query: 'Running SQL',
  import: 'Importing',
  reimport: 'Re-importing',
  verdict: 'Analyzing',
  preview: 'Previewing',
  remove: 'Removing',
  catalog: 'Reading the dataset list',
};

/** The operation as a noun ("Cancel SQL run …"). */
export const NOUN: Record<OperationKind, string> = {
  query: 'SQL run',
  import: 'import',
  reimport: 're-import',
  verdict: 'Verdict analysis',
  preview: 'preview',
  remove: 'removal',
  catalog: 'dataset list read',
};

/** Kinds a user can cancel from the operation list (internal catalog reads and removals are short and not offered). */
export const CANCELLABLE: ReadonlySet<OperationKind> = new Set<OperationKind>(['query', 'import', 'reimport', 'verdict', 'preview']);

/** Kinds shown in the status strip (internal catalog reads would only flicker there). */
export const isUserFacing = (o: Pick<OperationEntry, 'kind'>) => o.kind !== 'catalog';

/** Elapsed time, labelled as such by callers. Whole seconds under a minute, then m:ss. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** A duration bound for display ("30 s", "2 min", "45 s"). */
export function limitText(ms: number): string {
  if (ms % 60_000 === 0 && ms >= 60_000) return `${ms / 60_000} min`;
  if (ms % 1000 === 0) return `${ms / 1000} s`;
  return `${ms.toLocaleString('en-US')} ms`;
}

/** The workspace-wide state for the strip: engine first, then the active operation. */
export type OverallState = 'Starting' | 'Ready' | 'Queued' | 'Cancelling' | 'Recovering' | 'Failed' | 'Stopped' | (typeof ACTIVE_TEXT)[OperationKind];

export function overallState(engine: SessionState, ops: readonly OperationEntry[]): OverallState {
  switch (engine.kind) {
    case 'idle':
    case 'starting':
      return ops.some((o) => o.phase === 'queued') ? 'Queued' : 'Starting';
    case 'recovering':
      return 'Recovering';
    case 'failed':
      return 'Failed';
    case 'disposed':
      return 'Stopped';
    case 'cancelling':
      return 'Cancelling';
    default: {
      const active = ops.find((o) => o.phase === 'active' && isUserFacing(o));
      if (active) return ACTIVE_TEXT[active.kind];
      return ops.some((o) => o.phase === 'queued' && isUserFacing(o)) ? 'Queued' : 'Ready';
    }
  }
}

/**
 * The outcome a user actually got from an analysis (its published report), which can differ from
 * the engine-level terminal: a run that finished at the engine can still have its report withheld
 * (cancelled while finishing, past its time limit, engine or data changed) — Codex M10.
 */
export function verdictOutcome(status: string): string {
  switch (status) {
    case 'analyzed':
    case 'partially-analyzed':
      return 'Finished: report published';
    case 'budget-exhausted':
      return 'Stopped at a limit: no authoritative report';
    case 'cancelled':
      return 'Cancelled: its report was withheld';
    case 'stale':
      return 'Ended: the engine or the data changed; its report was withheld';
    case 'unsupported':
    case 'query-failed':
      return 'Finished: Verdict could not analyze this query';
    default:
      return 'Ended: no report';
  }
}

/** The state of one operation, as shown in a list. */
export function entryState(o: OperationEntry, engine: SessionState, effective?: string): string {
  if (o.phase === 'settled' && effective) return effective;
  if (o.phase === 'queued') return 'Queued';
  if (o.phase === 'active') return engine.kind === 'cancelling' && engine.op === o.id ? 'Cancelling…' : ACTIVE_TEXT[o.kind];
  if (o.terminal?.status === 'ok' && o.cancelRequested) {
    // The cancel arrived while it was finishing: say what that means for this kind of work.
    return o.kind === 'verdict' ? 'Cancelled: its report was withheld (the cancel arrived while it was finishing)' : 'Finished before the cancel request could stop it; its effects were applied';
  }
  return outcomeText(o.terminal, o.queueWaitMs);
}

/** Why a queued operation waits, from the engine state and the operation ahead of it. */
export function queuedReason(o: OperationEntry, ops: readonly OperationEntry[], engine: SessionState): string {
  const limit = o.queueWaitMs ? ` It is not started if it waits longer than ${limitText(o.queueWaitMs)} (limit).` : '';
  if (engine.kind === 'idle' || engine.kind === 'starting') return `Waiting for the engine to start.${limit}`;
  if (engine.kind === 'recovering') return `Waiting for the engine to recover.${limit}`;
  const active = ops.find((x) => x.phase === 'active');
  const ahead = ops.filter((x) => x.phase === 'queued' && x.seq < o.seq).length; // FIFO order, not time
  const parts: string[] = [];
  if (active) parts.push(`Waiting for ${active.kind === 'catalog' ? 'the dataset list to be read' : `the ${NOUN[active.kind]}${active.label ? ` (${active.label})` : ''} to finish`}`);
  else parts.push('Waiting for the engine');
  if (ahead) parts.push(`${ahead} ${ahead === 1 ? 'operation is' : 'operations are'} ahead of it`);
  return `${parts.join('; ')}. Operations run one at a time.${limit}`;
}

/** How an operation ended, in words (never "successful" for anything but ok). */
export function outcomeText(t: Terminal | undefined, queueWaitMs?: number): string {
  if (!t) return 'Ended';
  switch (t.status) {
    case 'ok':
      return 'Finished';
    case 'error': {
      const m = t.message.split('\n')[0] ?? '';
      return `Failed: ${m.length > 140 ? `${m.slice(0, 140)}…` : m}`;
    }
    case 'cancelled': {
      const base = t.by === 'deadline' ? 'Stopped at its time limit' : 'Cancelled';
      return t.stop === 'terminated' ? `${base}; it did not stop in time, so the engine was restarted and its in-memory tables were lost` : base;
    }
    case 'stale':
      return t.reason === 'disposed' ? 'Ended: the session closed' : 'Ended: the engine was restarted while it ran';
    case 'refused':
      if (t.reason.startsWith('queue-wait')) return `Not started: it waited longer than ${queueWaitMs ? limitText(queueWaitMs) : 'its limit'} (limit)`;
      if (t.reason.startsWith('engine failed')) return 'Not run: the engine is unavailable';
      return `Not run: ${t.reason}`;
  }
}

/** Tone of an operation's state: settled failures are not successes; cancellation is neutral. */
export function entryTone(o: OperationEntry): 'neutral' | 'info' | 'success' | 'warning' | 'violation' {
  if (o.phase !== 'settled') return 'info';
  const t = o.terminal;
  if (!t) return 'neutral';
  if (t.status === 'ok') return o.cancelRequested ? 'neutral' : 'success';
  if (t.status === 'error') return 'violation';
  if (t.status === 'cancelled' && t.stop === 'terminated') return 'warning';
  return 'neutral';
}

/** Running time on this tab's clock, from the start (or queueing) to now or settlement. */
export function runningFor(o: OperationEntry, now: number): number {
  const from = o.phase === 'queued' ? o.queuedAt : (o.startedAt ?? o.queuedAt);
  return (o.settledAt ?? now) - from;
}
