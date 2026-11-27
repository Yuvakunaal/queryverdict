// Declared join-stage expectations (M09; PRD QV-VER-003; UI_SPECIFICATION §5 "Expectations").
// The four P0 rule types only, in declaration order, each with a stable id for the editor. Session
// only: nothing is persisted. An entry is added or changed only through an explicit action, and
// only once it passes the core's own validation (`invalidExpectation`), so nothing malformed is
// stored silently. Analyze passes the values, in order, to VerdictService.analyze.
import type { Expectation } from '../core/verdict/types';
import { invalidExpectation } from '../core/verdict/expectations';
import { createStore, type Store } from './createStore';

export interface DeclaredExpectation {
  readonly id: number;
  readonly value: Expectation;
}

export interface ExpectationStore extends Store<readonly DeclaredExpectation[]> {
  /** Adds a declaration at the end; returns its id, or the validation error and stores nothing. */
  add(value: Expectation): { ok: true; id: number } | { ok: false; error: string };
  /** Replaces a declaration in place (same id and position). */
  update(id: number, value: Expectation): { ok: true } | { ok: false; error: string };
  remove(id: number): void;
  /** The declared values, in order (what Analyze submits). */
  values(): readonly Expectation[];
}

export function createExpectationStore(initial: readonly Expectation[] = []): ExpectationStore {
  let next = 0;
  const store = createStore<readonly DeclaredExpectation[]>(initial.filter((v) => !invalidExpectation(v)).map((value) => ({ id: ++next, value })));
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    add(value) {
      const error = invalidExpectation(value);
      if (error) return { ok: false, error };
      const id = ++next;
      store.set([...store.getSnapshot(), { id, value }]);
      return { ok: true, id };
    },
    update(id, value) {
      const error = invalidExpectation(value);
      if (error) return { ok: false, error };
      const list = store.getSnapshot();
      if (!list.some((e) => e.id === id)) return { ok: false, error: 'this expectation no longer exists' };
      store.set(list.map((e) => (e.id === id ? { id, value } : e)));
      return { ok: true };
    },
    remove(id) {
      const list = store.getSnapshot();
      if (list.some((e) => e.id === id)) store.set(list.filter((e) => e.id !== id));
    },
    values: () => store.getSnapshot().map((e) => e.value),
  };
}
