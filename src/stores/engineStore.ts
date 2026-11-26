// Bridges EngineSession events to React (docs/ARCHITECTURE.md §6.2). Read-only view; the
// session remains the single owner of engine state.
import type { EngineSession } from '../core/engine/session';
import type { BootInfo, DataEpoch, Generation, SessionState } from '../core/engine/types';
import { createStore, type Store } from './createStore';

export interface EngineSnapshot {
  readonly state: SessionState;
  readonly generation: Generation | null;
  readonly epoch: DataEpoch;
  readonly info: BootInfo | null;
}

export function createEngineStore(session: EngineSession): Store<EngineSnapshot> & { dispose(): void } {
  const read = (): EngineSnapshot => ({ state: session.state, generation: session.generation, epoch: session.epoch, info: session.info });
  const store = createStore<EngineSnapshot>(read());
  const off = session.subscribe((e) => {
    if (e.type === 'state' || e.type === 'ready' || e.type === 'epoch') store.set(read());
  });
  return { getSnapshot: store.getSnapshot, subscribe: store.subscribe, dispose: off };
}

/** Plain-language status for the status region (no capacity or timing claims). */
export function statusText(s: EngineSnapshot): string {
  switch (s.state.kind) {
    case 'idle':
      return 'Engine not started';
    case 'starting':
      return 'Starting engine…';
    case 'ready':
      return 'Engine ready';
    case 'busy':
      return 'Engine busy';
    case 'cancelling':
      return 'Cancelling…';
    case 'recovering':
      return 'Recovering engine…';
    case 'failed':
      return 'Engine unavailable. SQL is disabled until the engine starts with its security controls verified.';
    case 'disposed':
      return 'Engine stopped';
  }
}
