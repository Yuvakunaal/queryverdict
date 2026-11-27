// TEST-ONLY query harness (M06): the production QueryRunner on a harness session, with the
// result in a JSON-friendly form and profile limits overridable per call.
import { runQuery } from '../src/core/query/runner';
import { trimTerminator } from '../src/core/query/sqlText';
import type { EngineSession } from '../src/core/engine/session';
import { DEFAULT_PROFILE, type ReleaseProfile } from '../src/core/profile/profile';

export async function run(session: EngineSession, sql: string, results: Partial<ReleaseProfile['results']> = {}) {
  const profile: ReleaseProfile = { ...DEFAULT_PROFILE, results: { ...DEFAULT_PROFILE.results, ...results } };
  const before = session.epoch;
  const h = runQuery(session, sql, profile);
  const r = await h.result;
  const v = r.value;
  return {
    terminal: r.terminal,
    epochAdvanced: session.epoch !== before,
    run: v
      ? {
          statement: v.statement,
          ordered: v.ordered,
          exactText: v.exactText,
          dataChanged: v.dataChanged,
          affectedRows: v.affectedRows ?? null,
          transactionHint: v.transactionHint,
          result: v.result ? { columns: v.result.columns, rows: v.result.rows, truncation: v.result.truncation, limits: v.result.limits } : null,
        }
      : null,
  };
}

/** Starts a run and returns its handle (for cancellation tests). */
export function start(session: EngineSession, sql: string) {
  return runQuery(session, sql, DEFAULT_PROFILE);
}

export const queryHarness = { run, start, trimTerminator };
export type QueryHarness = typeof queryHarness;
window.__qvHarness!.query = queryHarness;
