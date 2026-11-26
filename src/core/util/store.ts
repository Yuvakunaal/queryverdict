// Framework-free external store primitive (docs/ARCHITECTURE.md §6.2); used by core and by React via
// useSyncExternalStore. Re-exported from src/stores/createStore.ts.
// Minimal external store for React's useSyncExternalStore (docs/ARCHITECTURE.md §6.2).
// Snapshots are replaced, never mutated; listeners run only when the snapshot changes.

export interface Store<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export interface WritableStore<T> extends Store<T> {
  set(next: T): void;
}

export function createStore<T>(initial: T): WritableStore<T> {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      if (Object.is(next, snapshot)) return;
      snapshot = next;
      for (const l of [...listeners]) l();
    },
  };
}
