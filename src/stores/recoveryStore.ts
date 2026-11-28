// Engine recovery and boot-failure state for the RecoveryNotice (M10; UI_SPECIFICATION §6;
// ARCHITECTURE §12.4). Derived only from session events and the dataset registry: why the engine
// is recovering (the session's own reason), whether recovery or a start failed, and which tables
// were lost with the old worker. Imported tables are listed live from the registry
// (`needs-reimport`); tables created by SQL are not tracked across a restart, so their names are
// remembered while the engine is healthy. Once a recovery has started, its context (reason, lost
// SQL tables) is kept through any number of failed retries and cleared only when the user
// dismisses the recovered notice (Codex M10). Nothing is re-imported or re-run.
import type { DatasetEntry } from '../core/datasets/types';
import type { EngineSession } from '../core/engine/session';
import type { Generation } from '../core/engine/types';
import type { Announcer } from './announcer';
import { createStore, type Store } from './createStore';

export type RecoveryPhase = 'none' | 'recovering' | 'recovered' | 'recovery-failed' | 'start-failed';

export interface RecoveryView {
  readonly phase: RecoveryPhase;
  /** The session's reason for recovering (kept across retries). */
  readonly reason?: string;
  /** The latest failure reason, while the engine is failed. */
  readonly failure?: string;
  /** Tables created by SQL that existed before the restart (they were lost). */
  readonly lostSqlTables: readonly string[];
  /** Data changed after the table list was last read: other SQL tables may also have been lost. */
  readonly lostSqlIncomplete?: boolean;
  readonly fromGeneration?: Generation | null;
  readonly toGeneration?: Generation | null;
}

export interface RecoveryStore extends Store<RecoveryView> {
  /** Hides a finished recovery notice and forgets its context (a failure stays until the engine is ready). */
  dismiss(): void;
  dispose(): void;
}

interface Context {
  readonly reason: string;
  readonly lostSqlTables: readonly string[];
  readonly incomplete: boolean;
  readonly fromGeneration: Generation | null;
}

export function createRecoveryStore(session: EngineSession, registry: Store<readonly DatasetEntry[]>, announcer?: Announcer): RecoveryStore {
  const store = createStore<RecoveryView>({ phase: 'none', lostSqlTables: [] });
  let lastReadyGeneration: Generation | null = session.generation;
  /** The recovery in progress or awaiting dismissal; survives failed retries. */
  let context: Context | null = null;
  const say = (m: string) => queueMicrotask(() => announcer?.announce(m)); // after the engine status text
  // The registry clears its list as soon as recovery starts, so remember the tables created by SQL
  // while the engine is healthy, and use that record when it goes away.
  const sqlTablesNow = () => registry.getSnapshot().filter((d) => d.origin === 'sql' && d.kind === 'table' && (d.state === 'ready' || d.state === 'changed')).map((d) => d.relation);
  let knownSql: string[] = sqlTablesNow();
  // The data epoch the list was read at: a later change (for example a CREATE TABLE whose catalog
  // read had not finished) means the list may be incomplete when the engine is lost (Codex M10).
  let knownEpoch = session.epoch;
  const offRegistry = registry.subscribe(() => {
    const k = session.state.kind;
    if (k !== 'recovering' && k !== 'failed' && k !== 'disposed' && k !== 'starting') {
      knownSql = sqlTablesNow();
      knownEpoch = session.epoch;
    }
  });
  const view = (phase: RecoveryPhase, extra: Partial<RecoveryView> = {}): RecoveryView => ({
    phase,
    lostSqlTables: context?.lostSqlTables ?? [],
    ...(context ? { reason: context.reason, fromGeneration: context.fromGeneration, ...(context.incomplete ? { lostSqlIncomplete: true } : {}) } : {}),
    ...extra,
  });

  const off = session.subscribe((e) => {
    if (e.type === 'state') {
      const k = e.state.kind;
      if (k === 'recovering') {
        // A new recovery: lost tables accumulate if an earlier recovery was not yet dismissed.
        const lost = [...new Set([...(context?.lostSqlTables ?? []), ...knownSql])];
        const incomplete = (context?.incomplete ?? false) || session.epoch !== knownEpoch;
        context = { reason: e.state.reason, lostSqlTables: lost, incomplete, fromGeneration: context?.fromGeneration ?? lastReadyGeneration };
        knownSql = [];
        store.set(view('recovering'));
      } else if (k === 'failed') {
        // With a recovery context this is a failed recovery or a failed retry of one; without, a failed first start.
        store.set(view(context ? 'recovery-failed' : 'start-failed', { failure: e.state.reason }));
      }
    }
    if (e.type === 'ready') {
      lastReadyGeneration = session.generation;
      if (context) {
        store.set(view('recovered', { toGeneration: session.generation }));
        const n = context.lostSqlTables.length;
        say(`The engine was restarted and its in-memory tables were lost.${n ? ` ${n} ${n === 1 ? 'table' : 'tables'} created by SQL must be recreated.` : ''} Imported files can be re-imported.`);
      } else if (store.getSnapshot().phase === 'start-failed') {
        store.set({ phase: 'none', lostSqlTables: [] });
      }
    }
  });
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    dismiss() {
      if (store.getSnapshot().phase !== 'recovered') return;
      context = null;
      store.set({ phase: 'none', lostSqlTables: [] });
    },
    dispose() {
      off();
      offRegistry();
    },
  };
}
