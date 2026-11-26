// Operation list for status UI (docs/ARCHITECTURE.md §6.2). Holds ids, kinds and phases only:
// no SQL text, file names or results.
import type { EngineSession } from '../core/engine/session';
import type { OperationId, OperationKind, Terminal } from '../core/engine/types';
import { createStore, type Store } from './createStore';

export interface OperationEntry {
  readonly id: OperationId;
  readonly kind: OperationKind;
  readonly phase: 'queued' | 'active' | 'settled';
  readonly terminal?: Terminal;
}

const KEEP_SETTLED = 20;

export function createOperationStore(session: EngineSession): Store<readonly OperationEntry[]> & { dispose(): void } {
  const store = createStore<readonly OperationEntry[]>([]);
  const off = session.subscribe((e) => {
    if (e.type !== 'operation') return;
    const rest = store.getSnapshot().filter((o) => o.id !== e.id);
    const next: OperationEntry = e.terminal ? { id: e.id, kind: e.kind, phase: e.phase, terminal: e.terminal } : { id: e.id, kind: e.kind, phase: e.phase };
    const all = [...rest, next];
    const settled = all.filter((o) => o.phase === 'settled');
    const drop = new Set(settled.slice(0, Math.max(0, settled.length - KEEP_SETTLED)).map((o) => o.id));
    store.set(all.filter((o) => !drop.has(o.id)));
  });
  return { getSnapshot: store.getSnapshot, subscribe: store.subscribe, dispose: off };
}
