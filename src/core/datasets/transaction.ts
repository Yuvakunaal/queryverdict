// The app's own explicit transaction for imports and removals (ARCHITECTURE §10.3, QV-ENG-013c).
//
// Correction found in M03 (DuckDB v1.5.4, see DECISIONS): a nested BEGIN does fail, but the
// failure also ABORTS the user's open transaction, and a later COMMIT then reports success while
// discarding the user's work. So "issue BEGIN and refuse if it fails" would destroy user data.
// Instead an open transaction is detected first without side effects: txid_current() returns the
// same id on consecutive statements only inside an explicit transaction (each auto-commit
// statement gets a new one) and errors inside an aborted transaction. Any doubt refuses.
import { RefusedError } from '../util/errors';
import type { Lease } from '../engine/types';

const TXID_SQL = 'SELECT txid_current()::VARCHAR';

export async function beginOwnTransaction(lease: Lease, action: string): Promise<void> {
  const refused = () => new RefusedError(`A transaction is open in this session. COMMIT or ROLLBACK it before ${action}.`);
  let first: string | null | undefined;
  let second: string | null | undefined;
  try {
    first = (await lease.query(TXID_SQL, { columns: 1, maxRows: 1, exactRows: 1 }))[0]?.[0];
    second = (await lease.query(TXID_SQL, { columns: 1, maxRows: 1, exactRows: 1 }))[0]?.[0];
  } catch (e) {
    if (/transaction is aborted/i.test(String((e as Error).message))) throw refused();
    throw e;
  }
  if (!first || !second || first === second) throw refused();
  try {
    await lease.query('BEGIN TRANSACTION', { maxRows: 1 });
  } catch (e) {
    // Second line of defence; not reached when the check above works.
    if (/within a transaction/i.test(String((e as Error).message))) throw refused();
    throw e;
  }
  // From here until the caller's COMMIT succeeds and it calls forgetCleanup('ROLLBACK'), the
  // session owns the rollback and replaces the engine if it cannot confirm it.
  lease.deferCleanup('ROLLBACK');
}
