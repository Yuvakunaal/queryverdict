// The inspector's bounded preview (M04). One preview at a time; it starts only through `start`
// (an explicit user action). A shown preview becomes stale when the engine generation or the data
// epoch changes, or when the selected table's identity differs from the one previewed, and stale
// rows are never shown again.
import type { EngineSession } from '../core/engine/session';
import type { OperationHandle } from '../core/engine/types';
import type { ReleaseProfile } from '../core/profile/profile';
import { previewTable, type PreviewTarget } from '../core/results/preview';
import type { BoundedResult } from '../core/results/types';
import { createStore, type Store } from './createStore';

export type PreviewState =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly relation: string; readonly oid: string }
  | { readonly status: 'done'; readonly relation: string; readonly oid: string; readonly result: BoundedResult }
  | { readonly status: 'error' | 'cancelled' | 'stale'; readonly relation: string; readonly oid: string; readonly message: string };

export interface PreviewStore extends Store<PreviewState> {
  start(target: PreviewTarget): void;
  cancel(): void;
  /** Forgets the preview (for example when another dataset is selected). */
  clear(): void;
  dispose(): void;
}

export function createPreviewStore(session: EngineSession, profile: ReleaseProfile): PreviewStore {
  const store = createStore<PreviewState>({ status: 'idle' });
  let handle: OperationHandle<BoundedResult> | null = null;
  let token = 0;
  const markStale = (message: string) => {
    const s = store.getSnapshot();
    if (s.status === 'done') store.set({ status: 'stale', relation: s.relation, oid: s.oid, message });
  };
  const off = session.subscribe((e) => {
    if (e.type === 'epoch') markStale('The data may have changed since this preview.');
    if (e.type === 'ready' || (e.type === 'state' && (e.state.kind === 'recovering' || e.state.kind === 'failed' || e.state.kind === 'disposed'))) markStale('The engine restarted after this preview.');
  });
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    start(target) {
      handle?.cancel();
      const mine = ++token;
      store.set({ status: 'running', relation: target.relation, oid: target.identity.oid });
      const h = previewTable(session, target, profile);
      handle = h;
      void h.result.then((r) => {
        if (mine !== token) return; // superseded by a newer preview or cleared
        handle = null;
        const base = { relation: target.relation, oid: target.identity.oid };
        if (r.terminal.status === 'ok' && r.value) store.set({ status: 'done', ...base, result: r.value });
        else if (r.terminal.status === 'cancelled') store.set({ status: 'cancelled', ...base, message: r.terminal.by === 'deadline' ? 'The preview took too long and was stopped.' : 'Preview cancelled.' });
        else if (r.terminal.status === 'stale') store.set({ status: 'stale', ...base, message: 'The engine restarted while the preview was running.' });
        else store.set({ status: 'error', ...base, message: r.terminal.status === 'error' ? r.terminal.message : r.terminal.status === 'refused' ? r.terminal.reason : 'The preview did not complete.' });
      });
    },
    cancel() {
      handle?.cancel();
    },
    clear() {
      token++;
      handle?.cancel();
      handle = null;
      store.set({ status: 'idle' });
    },
    dispose: off,
  };
}
