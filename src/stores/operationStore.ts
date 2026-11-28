// Operation list for status UI (docs/ARCHITECTURE.md §6.2; M10). The single source of operation
// state for the status strip and operation details: ids, kinds, phases, terminals, a label the
// submitter chose (a statement kind, file or relation name — never SQL text or data), the
// operation's queue-wait bound, and times from this tab's own clock. Updated only from session
// events (no polling). Times are for "elapsed" display; they are never used to predict anything.
import type { EngineSession } from '../core/engine/session';
import type { OperationId, OperationKind, Terminal } from '../core/engine/types';
import { createStore, type Store } from './createStore';

export interface OperationEntry {
  readonly id: OperationId;
  readonly kind: OperationKind;
  readonly phase: 'queued' | 'active' | 'settled';
  readonly terminal?: Terminal;
  /** A cancel request arrived while the operation was already finishing (it did not change the outcome). */
  readonly cancelRequested?: boolean;
  /** Submission order (first seen), for queue position: timestamps can be equal. */
  readonly seq: number;
  readonly label?: string;
  readonly queueWaitMs?: number;
  /** Page-clock times (performance.now) of the session events. */
  readonly queuedAt: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
}

const KEEP_SETTLED = 20;

export function createOperationStore(session: EngineSession, now: () => number = () => performance.now()): Store<readonly OperationEntry[]> & { dispose(): void } {
  const store = createStore<readonly OperationEntry[]>([]);
  let nextSeq = 0;
  const off = session.subscribe((e) => {
    if (e.type !== 'operation') return;
    const list = store.getSnapshot();
    const prev = list.find((o) => o.id === e.id);
    if (prev?.phase === 'settled') return; // single settlement: nothing after it changes an entry
    const t = now();
    const label = e.label ?? prev?.label;
    const queueWaitMs = e.queueWaitMs ?? prev?.queueWaitMs;
    const next: OperationEntry = {
      id: e.id,
      kind: e.kind,
      phase: e.phase,
      seq: prev?.seq ?? ++nextSeq,
      queuedAt: prev?.queuedAt ?? t,
      ...(e.cancelRequested ? { cancelRequested: true } : {}),
      ...(label ? { label } : {}),
      ...(queueWaitMs !== undefined ? { queueWaitMs } : {}),
      ...(e.phase === 'active' ? { startedAt: t } : prev?.startedAt !== undefined ? { startedAt: prev.startedAt } : {}),
      ...(e.phase === 'settled' ? { settledAt: t } : {}),
      ...(e.terminal ? { terminal: e.terminal } : {}),
    };
    const all = [...list.filter((o) => o.id !== e.id), next];
    const settled = all.filter((o) => o.phase === 'settled');
    const drop = new Set(settled.slice(0, Math.max(0, settled.length - KEEP_SETTLED)).map((o) => o.id));
    store.set(all.filter((o) => !drop.has(o.id)));
  });
  return { getSnapshot: store.getSnapshot, subscribe: store.subscribe, dispose: off };
}
