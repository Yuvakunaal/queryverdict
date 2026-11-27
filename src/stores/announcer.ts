// Announcements for the single persistent status region (DESIGN_SYSTEM §5): each meaningful event
// (import finished, table removed, name copied …) replaces the region's text once. The App merges
// these with engine status changes; whichever happened last is shown.
import { createStore, type Store } from './createStore';
import { statusText, type EngineSnapshot } from './engineStore';

export interface Announcement {
  readonly message: string;
  /** Increases with every announcement, so repeating the same text is still a change. */
  readonly seq: number;
}

export interface Announcer extends Store<Announcement | null> {
  announce(message: string): void;
}

export function createAnnouncer(initial: string | null = null): Announcer {
  let seq = 0;
  const store = createStore<Announcement | null>(initial === null ? null : { message: initial, seq: 0 });
  return { getSnapshot: store.getSnapshot, subscribe: store.subscribe, announce: (message) => store.set({ message, seq: ++seq }) };
}

/**
 * Feeds engine status transitions into the announcer, so the single status region shows the most
 * recent of engine changes and other announcements. Brief busy periods (every query, import or
 * catalog read) are not announced: they would replace a meaningful message with noise.
 */
export function followEngine(announcer: Announcer, engine: Store<EngineSnapshot>): () => void {
  const text = (s: EngineSnapshot) => statusText(s.state.kind === 'busy' ? { ...s, state: { kind: 'ready' } } : s);
  let last = text(engine.getSnapshot());
  return engine.subscribe(() => {
    const t = text(engine.getSnapshot());
    if (t !== last) {
      last = t;
      announcer.announce(t);
    }
  });
}
