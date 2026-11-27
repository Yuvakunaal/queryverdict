// Run SQL state (M06; UI_SPECIFICATION §4, §6). One run at a time: a new Run cancels the previous
// one, and only the latest run can publish (an older result arriving late is ignored). Queued and
// running come from the session's own operation events; the elapsed time is the page clock from
// the Run action to settlement. A shown result keeps a historical label once the data or the
// engine changes, or the editor text differs from the SQL it ran.
import type { EngineSession } from '../core/engine/session';
import type { ReleaseProfile } from '../core/profile/profile';
import { runStatements, type QueryHandle, type QueryRun, type RunProgress } from '../core/query/runner';
import type { Announcer } from './announcer';
import { createStore, type Store } from './createStore';

type Base = { readonly seq: number; readonly sql: string };
export type QueryState =
  | { readonly status: 'idle' }
  | (Base & { readonly status: 'queued'; readonly startedAt: number })
  | (Base & { readonly status: 'running'; readonly startedAt: number })
  | (Base & { readonly status: 'cancelling'; readonly startedAt: number })
  | (Base & { readonly status: 'done'; readonly run: QueryRun; readonly elapsedMs: number; readonly historical: string | null })
  | (Base & { readonly status: 'error'; readonly phase: 'parse' | 'bind' | 'execute' | 'engine'; readonly message: string; readonly elapsedMs: number; readonly progress: Readonly<RunProgress> })
  | (Base & { readonly status: 'refused'; readonly message: string })
  | (Base & { readonly status: 'cancelled'; readonly message: string; readonly progress: Readonly<RunProgress> })
  | (Base & { readonly status: 'stale'; readonly message: string });

export interface QueryView {
  readonly state: QueryState;
  /** A BEGIN ran and no COMMIT, ROLLBACK or engine restart followed (a hint, ARCHITECTURE §11.2). */
  readonly transactionMayBeOpen: boolean;
}

export interface QueryStore extends Store<QueryView> {
  /**
   * Runs statements (the one at the cursor, or every one in a selection) taken from `source`, the
   * editor text at that moment; a result becomes historical once the editor text differs from it.
   */
  run(statements: readonly string[], source: string): void;
  cancel(): void;
  /** Marks a shown result historical when the editor text no longer matches its SQL. */
  noteEditorText(sql: string): void;
  dispose(): void;
}

export const isActive = (s: QueryState) => s.status === 'queued' || s.status === 'running' || s.status === 'cancelling';

export function createQueryStore(session: EngineSession, profile: ReleaseProfile, announcer: Announcer, now: () => number = () => performance.now()): QueryStore {
  const store = createStore<QueryView>({ state: { status: 'idle' }, transactionMayBeOpen: false });
  let handle: QueryHandle | null = null;
  let seq = 0;
  let editorSql: string | null = null;
  /** Editor text each run was taken from, by run number (only the latest few matter). */
  const sources = new Map<number, string>();
  const set = (state: QueryState, tx?: boolean) => store.set({ state, transactionMayBeOpen: tx ?? store.getSnapshot().transactionMayBeOpen });

  const historical = (reason: string) => {
    const s = store.getSnapshot().state;
    if (s.status === 'done' && !s.historical) set({ ...s, historical: reason });
  };

  const off = session.subscribe((e) => {
    const s = store.getSnapshot().state;
    if (e.type === 'operation' && handle && e.id === handle.id && e.phase === 'active' && s.status === 'queued') set({ ...s, status: 'running' });
    // The runner advances the epoch before its result is published, so any epoch change seen
    // while a result is shown is a later change (another statement, an import, a removal).
    if (e.type === 'epoch' && s.status === 'done') historical('The data may have changed since this result.');
    if (e.type === 'ready' || (e.type === 'state' && (e.state.kind === 'recovering' || e.state.kind === 'failed'))) {
      historical('The engine restarted after this result.');
      if (store.getSnapshot().transactionMayBeOpen) set(store.getSnapshot().state, false); // a new engine has no open transaction
    }
  });

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    run(statements, source) {
      handle?.cancel(); // a newer run supersedes the previous one
      const mine = ++seq;
      const startedAt = now();
      const sql = statements.join(';\n');
      sources.set(mine, source);
      set({ status: 'queued', seq: mine, sql, startedAt });
      const h = runStatements(session, statements, profile);
      handle = h;
      for (const k of sources.keys()) if (k < mine - 1) sources.delete(k);
      // The operation may already have started (the session starts it synchronously when idle).
      if (h.generation !== null) set({ status: 'running', seq: mine, sql, startedAt });
      void h.result.then((r) => {
        if (mine !== seq) return; // superseded: an older result never overwrites a newer run
        handle = null;
        const elapsedMs = Math.max(0, now() - startedAt);
        const t = r.terminal;
        const progress = { ...h.progress };
        // The transaction hint follows what was sent, whatever the outcome.
        const tx = progress.transactionHint === 'begin' ? true : progress.transactionHint === 'end' ? false : undefined;
        if (t.status === 'ok' && r.value) {
          const v = r.value;
          // Checked at publication: a newer engine or a later data change makes it historical.
          const stale = r.generation !== session.generation;
          const later = v.epoch !== undefined && v.epoch !== session.epoch;
          const edited = editorSql !== null && editorSql !== source;
          const historical = stale ? 'The engine restarted after this result.' : later ? 'The data may have changed since this result.' : edited ? 'The SQL was edited after this run.' : null;
          set({ status: 'done', seq: mine, sql, run: v, elapsedMs, historical }, tx);
          const rows = v.result ? `${v.result.rows.length.toLocaleString('en-US')} ${v.result.rows.length === 1 ? 'row' : 'rows'} shown` : v.affectedRows !== undefined ? `${v.affectedRows} ${v.affectedRows === '1' ? 'row' : 'rows'} affected` : 'no result set';
          announcer.announce(`${v.statement === 'select' ? 'SQL executed' : 'Statement executed'} · ${rows}.`);
        } else if (t.status === 'error') {
          set({ status: 'error', seq: mine, sql, phase: t.phase, message: t.message, elapsedMs, progress }, tx);
          announcer.announce(`Query failed: ${t.message}`);
        } else if (t.status === 'refused') {
          set({ status: 'refused', seq: mine, sql, message: t.reason }, tx);
          announcer.announce(`Not run: ${t.reason}`);
        } else if (t.status === 'cancelled') {
          const parts = ['Cancelled.'];
          if (t.stop === 'terminated') parts.push('The statement did not stop, so the engine was restarted; tables in memory were lost.');
          else if (progress.mutationInFlight) parts.push('The statement had already been sent, so its changes may have been applied.');
          if (progress.total > 1 && progress.completed > 0) parts.push(`${progress.completed} of ${progress.total} statements completed before the cancellation.`);
          const message = parts.join(' ');
          set({ status: 'cancelled', seq: mine, sql, message, progress }, tx);
          announcer.announce(message);
        } else {
          const message = 'The engine restarted while this query was running. No result is shown.';
          set({ status: 'stale', seq: mine, sql, message }, false);
          announcer.announce(message);
        }
      });
    },
    cancel() {
      const s = store.getSnapshot().state;
      if (!handle || !isActive(s)) return;
      if (s.status === 'queued' || s.status === 'running') set({ ...s, status: 'cancelling' });
      handle.cancel();
    },
    noteEditorText(text) {
      editorSql = text;
      const s = store.getSnapshot().state;
      if (s.status === 'done' && !s.historical && sources.get(s.seq) !== text) historical('The SQL was edited after this run.');
    },
    dispose: off,
  };
}
