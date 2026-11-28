// QueryRunner on the scripted engine (M06; T-ENG-010b, 013a, 013b; P-048, P-064): statement
// policy, the exact SQL sent, data-epoch rules (including failure and cancellation after the
// statement was sent), queued cancel, and stale-result rejection.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineSession } from '../../../src/core/engine/session';
import type { OperationResult } from '../../../src/core/engine/types';
import { DEFAULT_PROFILE } from '../../../src/core/profile/profile';
import { MULTIPLE_REFUSAL, runQuery, runStatements, type QueryRun } from '../../../src/core/query/runner';
import { FakeDriver, type FakeInstance } from '../engine/fake-driver';
import { batch, ints, utf8 } from '../results/arrow-fixtures';

const SELECT_JSON = '{"error":false,"statements":[{"node":{"type":"SELECT_NODE","modifiers":[]}}]}';
const ORDERED_JSON = '{"error":false,"statements":[{"node":{"type":"SELECT_NODE","modifiers":[{"type":"ORDER_MODIFIER"}]}}]}';
const NOT_SELECT = '{"error":true,"error_type":"not implemented","error_message":"Only SELECT statements can be serialized to json!"}';
const PARSE_ERR = '{"error":true,"error_type":"parser","error_message":"syntax error at or near \\"SELEC\\""}';

let driver: FakeDriver;
let session: EngineSession;
const engine = (): FakeInstance => driver.current;

/** Scripts json_serialize_sql answers by statement text. */
function script(json: (sql: string) => string, describe: string[][] = [['a', 'INTEGER']]) {
  engine().handler = (q) => {
    const calls = q.split('json_serialize_sql(').length - 1;
    if (calls === 1) return [[json(q)]];
    if (calls === 2) {
      const j = json(q);
      return [[j, j]];
    }
    if (q.startsWith('DESCRIBE ')) return describe;
    return undefined;
  };
}

async function settle(p: Promise<OperationResult<QueryRun>>) {
  let done: OperationResult<QueryRun> | undefined;
  void p.then((r) => (done = r));
  for (let i = 0; i < 2000 && !done; i++) await vi.advanceTimersByTimeAsync(10);
  if (!done) throw new Error('did not settle');
  return done;
}

beforeEach(async () => {
  vi.useFakeTimers();
  driver = new FakeDriver();
  session = new EngineSession({ driver, bootMs: 1_000, recoveryMs: 2_000, memoryLimit: '1GB', now: () => Date.now() });
  const p = session.start();
  await vi.advanceTimersByTimeAsync(0);
  await p;
});
afterEach(() => {
  vi.useRealTimers();
});

const streamed = () => engine().calls.filter((c) => c.startsWith('STREAM '));

describe('QueryRunner', () => {
  it('T-ENG-013a, 010b: a SELECT is read through a bounded projection; the epoch does not change', async () => {
    script(() => SELECT_JSON, [['id', 'BIGINT'], ['id', 'VARCHAR']]);
    engine().streamHandler = () => [[batch([['c1', utf8(['1'])], ['c2', utf8(['x'])]]), 64]];
    const before = session.epoch;
    const r = await settle(runQuery(session, 'SELECT 1 AS id, \'x\' AS id;', DEFAULT_PROFILE).result);
    expect(r.terminal.status).toBe('ok');
    expect(session.epoch).toBe(before);
    expect(r.value?.statement).toBe('select');
    expect(r.value?.result?.columns).toEqual([{ name: 'id', type: 'BIGINT' }, { name: 'id', type: 'VARCHAR' }]);
    const [sql] = streamed();
    expect(sql).toBe("STREAM SELECT left(CAST(c1 AS VARCHAR), 501), left(CAST(c2 AS VARCHAR), 501) FROM (\nSELECT 1 AS id, 'x' AS id\n) AS __qv_result(c1, c2) LIMIT 1001");
  });

  it('ORDER BY is detected from the parse tree', async () => {
    script(() => ORDERED_JSON);
    engine().streamHandler = () => [[batch([['c1', utf8(['1'])]]), 8]];
    const r = await settle(runQuery(session, 'SELECT a FROM t ORDER BY a', DEFAULT_PROFILE).result);
    expect(r.value?.ordered).toBe(true);
  });

  it('if the terminator cannot be removed safely, the original text runs unchanged and read-only', async () => {
    engine().handler = (q) => (q.split('json_serialize_sql(').length - 1 === 2 ? [[SELECT_JSON, ORDERED_JSON]] : [[SELECT_JSON]]);
    engine().streamHandler = () => [[batch([['x', utf8(['1'])]]), 8]];
    const before = session.epoch;
    const r = await settle(runQuery(session, 'SELECT 1;', DEFAULT_PROFILE).result);
    expect(r.terminal.status).toBe('ok');
    expect(streamed()).toEqual(['STREAM SELECT 1;']);
    expect(session.epoch).toBe(before);
    expect(r.value?.exactText).toBe(false);
  });

  it('T-ENG-013a, 010b: a possibly-mutating statement runs unchanged and advances the epoch; DuckDB\'s Count is reported as affected rows', async () => {
    script(() => NOT_SELECT);
    engine().streamHandler = () => [[batch([['Count', ints([3n])]]), 8]];
    const before = session.epoch;
    const r = await settle(runQuery(session, 'UPDATE t SET a = 1', DEFAULT_PROFILE).result);
    expect(r.terminal.status).toBe('ok');
    expect(streamed()).toEqual(['STREAM UPDATE t SET a = 1']);
    expect(session.epoch).toBe(before + 1);
    expect(r.value).toMatchObject({ statement: 'statement', affectedRows: '3', result: null, dataChanged: true });
  });

  it('T-ENG-010b: a statement that fails after it was sent still advances the epoch', async () => {
    script(() => NOT_SELECT);
    engine().streamHandler = () => new Error('Constraint Error: duplicate key');
    const before = session.epoch;
    const r = await settle(runQuery(session, 'INSERT INTO t VALUES (1)', DEFAULT_PROFILE).result);
    expect(r.terminal).toMatchObject({ status: 'error', phase: 'execute' });
    expect(session.epoch).toBe(before + 1);
  });

  it('T-ENG-013b: several statements are refused: nothing is sent and the epoch is unchanged (ES-12)', async () => {
    script(() => NOT_SELECT);
    const before = session.epoch;
    const r = await settle(runQuery(session, 'CREATE TABLE a (x INT); DROP TABLE a', DEFAULT_PROFILE).result);
    expect(r.terminal).toEqual({ status: 'refused', reason: MULTIPLE_REFUSAL });
    expect(streamed()).toEqual([]);
    expect(session.epoch).toBe(before);
  });

  it('a syntax error is reported from the parser, with nothing run', async () => {
    script(() => PARSE_ERR);
    engine().prepareCheck = () => Promise.reject(new Error('Parser Error: syntax error at or near "SELEC"'));
    const before = session.epoch;
    const r = await settle(runQuery(session, 'SELEC 1', DEFAULT_PROFILE).result);
    expect(r.terminal).toMatchObject({ status: 'error', phase: 'parse' });
    expect(streamed()).toEqual([]);
    expect(session.epoch).toBe(before);
  });

  it('a binding error from DESCRIBE is reported, with nothing run', async () => {
    engine().handler = (q) => {
      if (q.startsWith('DESCRIBE ')) return new Error('Catalog Error: Table with name nosuch does not exist!');
      const n = q.split('json_serialize_sql(').length - 1;
      return n === 2 ? [[SELECT_JSON, SELECT_JSON]] : [[SELECT_JSON]];
    };
    const r = await settle(runQuery(session, 'SELECT * FROM nosuch', DEFAULT_PROFILE).result);
    expect(r.terminal).toMatchObject({ status: 'error', phase: 'bind' });
    expect(streamed()).toEqual([]);
  });

  it('empty text is refused without engine work', async () => {
    const r = await settle(runQuery(session, '  \n ', DEFAULT_PROFILE).result);
    expect(r.terminal.status).toBe('refused');
    expect(engine().calls.some((c) => c.includes('json_serialize_sql'))).toBe(false);
  });

  it('cancelling while the result streams stops it; a sent statement still advances the epoch', async () => {
    script(() => NOT_SELECT);
    engine().streamHandler = () => 'stall';
    const before = session.epoch;
    const h = runQuery(session, 'DELETE FROM t', DEFAULT_PROFILE);
    for (let i = 0; i < 20 && streamed().length === 0; i++) await vi.advanceTimersByTimeAsync(5);
    expect(streamed()).toHaveLength(1);
    h.cancel();
    const r = await settle(h.result);
    expect(r.terminal).toMatchObject({ status: 'cancelled', by: 'user' });
    expect(r.value).toBeUndefined();
    expect(session.epoch).toBe(before + 1);
  });

  it('a queued run cancelled before it starts does no engine work', async () => {
    script(() => NOT_SELECT);
    engine().streamHandler = () => 'stall';
    const first = runQuery(session, 'DELETE FROM t', DEFAULT_PROFILE);
    for (let i = 0; i < 20 && streamed().length === 0; i++) await vi.advanceTimersByTimeAsync(5);
    const second = runQuery(session, 'DELETE FROM u', DEFAULT_PROFILE);
    second.cancel();
    const r2 = await settle(second.result);
    expect(r2.terminal.status).toBe('cancelled');
    first.cancel();
    await settle(first.result);
    expect(engine().calls.some((c) => c.includes('DELETE FROM u'))).toBe(false);
  });

  it('a result from a replaced engine is never published (stale)', async () => {
    script(() => SELECT_JSON);
    engine().streamHandler = () => 'stall';
    const h = runQuery(session, 'SELECT 1', DEFAULT_PROFILE);
    for (let i = 0; i < 20 && streamed().length === 0; i++) await vi.advanceTimersByTimeAsync(5);
    void session.restart('test');
    const r = await settle(h.result);
    expect(r.terminal.status).toBe('stale');
    expect(r.value).toBeUndefined();
  });

  it('P-097: several statements are all parse-checked before any runs; a syntax error anywhere runs nothing', async () => {
    script((q) => (q.includes('selec 2') ? PARSE_ERR : NOT_SELECT));
    engine().prepareCheck = (q) => (q.includes('selec 2') ? Promise.reject(new Error('Parser Error: syntax error at or near "selec"')) : Promise.resolve());
    const before = session.epoch;
    const r = await settle(runStatements(session, ['CREATE TABLE a (x INT)', 'selec 2'], DEFAULT_PROFILE).result);
    expect(r.terminal).toMatchObject({ status: 'error', phase: 'parse' });
    expect((r.terminal as { message: string }).message).toMatch(/^Statement 2 of 2: Parser Error/);
    expect(streamed()).toEqual([]);
    expect(session.epoch).toBe(before);
  });

  it('P-097: statements run in order and the first error stops the rest; the epoch advances for what ran', async () => {
    script(() => NOT_SELECT);
    engine().streamHandler = (q) => (q.startsWith('INSERT') ? new Error('Catalog Error: Table with name nosuch does not exist!') : []);
    const before = session.epoch;
    const r = await settle(runStatements(session, ['CREATE TABLE a (x INT)', 'INSERT INTO nosuch VALUES (1)', 'DROP TABLE a'], DEFAULT_PROFILE).result);
    expect(r.terminal).toMatchObject({ status: 'error', phase: 'bind' });
    expect((r.terminal as { message: string }).message).toMatch(/^Statement 2 of 3: Catalog Error/);
    expect(streamed()).toEqual(['STREAM CREATE TABLE a (x INT)', 'STREAM INSERT INTO nosuch VALUES (1)']);
    expect(session.epoch).toBe(before + 1);
  });

  it('P-097: a successful sequence returns the last result, the count, and the sequence-wide transaction hint', async () => {
    script((q) => (q.includes('SELECT 7') ? SELECT_JSON : NOT_SELECT), [['n', 'INTEGER']]);
    engine().streamHandler = (q) => (q.includes('__qv_result') ? [[batch([['c1', utf8(['7'])]]), 8]] : []);
    const r = await settle(runStatements(session, ['BEGIN', 'SELECT 7 AS n'], DEFAULT_PROFILE).result);
    expect(r.terminal.status).toBe('ok');
    expect(r.value).toMatchObject({ statements: 2, transactionHint: 'begin', dataChanged: true });
    expect(r.value?.result?.rows[0]?.[0]).toEqual({ kind: 'text', text: '7', truncated: false });
  });

  it('no statement at the cursor is refused without engine work', async () => {
    const r = await settle(runStatements(session, [], DEFAULT_PROFILE).result);
    expect(r.terminal.status).toBe('refused');
    expect(engine().calls.some((c) => c.includes('json_serialize_sql'))).toBe(false);
  });

  it('Codex M06: affected rows come from DuckDB\'s own Count value, before any display bound', async () => {
    script(() => NOT_SELECT);
    engine().streamHandler = () => [[batch([['Count', ints([15n])]]), 8]];
    const tiny = { ...DEFAULT_PROFILE, results: { ...DEFAULT_PROFILE.results, maxCellChars: 1 } };
    const r = await settle(runQuery(session, 'INSERT INTO t SELECT * FROM range(15)', tiny).result);
    expect(r.value?.affectedRows).toBe('15');
  });

  it('Codex M06: a Count result with more than one row is not reported as affected rows', async () => {
    script(() => NOT_SELECT);
    engine().streamHandler = () => [[batch([['Count', ints([1n, 2n])]]), 8]];
    const r = await settle(runQuery(session, 'INSERT INTO t VALUES (1)', DEFAULT_PROFILE).result);
    expect(r.value?.affectedRows).toBeUndefined();
  });

  it('Codex M06: a statement other than SELECT is never stopped early (it runs to its end)', async () => {
    script(() => NOT_SELECT);
    engine().stopBehaviour = 'reject';
    engine().streamHandler = () => Array.from({ length: 3 }, (_, k) => [batch([['x', utf8([String(k)])]]), 8] as const);
    const tiny = { ...DEFAULT_PROFILE, results: { ...DEFAULT_PROFILE.results, maxRows: 1 } };
    const r = await settle(runQuery(session, 'INSERT INTO t VALUES (1) RETURNING x', tiny).result);
    expect(r.terminal.status).toBe('ok');
    expect(engine().streamStops).toBe(0);
    expect(r.value?.result?.rows).toHaveLength(1);
    expect(r.value?.result?.truncation.rows).toBe(true);
  });

  for (const behaviour of ['reject', 'hang'] as const) {
    it(`Codex M06: an early stop the engine does not confirm (${behaviour}) restarts the engine`, async () => {
      script(() => SELECT_JSON);
      engine().stopBehaviour = behaviour;
      engine().streamHandler = () => [[batch([['c1', utf8(['1', '2', '3'])]]), 8]];
      const generation = session.generation;
      const tiny = { ...DEFAULT_PROFILE, results: { ...DEFAULT_PROFILE.results, maxRows: 1 } };
      const r = await settle(runQuery(session, 'SELECT 1', tiny).result);
      expect(r.terminal).toMatchObject({ status: 'error', phase: 'engine' });
      expect((r.terminal as { message: string }).message).toContain('did not confirm');
      for (let i = 0; i < 300 && session.generation === generation; i++) await vi.advanceTimersByTimeAsync(10);
      expect(session.generation).not.toBe(generation);
    });
  }

  it('Codex M06: a SELECT with effects (nextval) is evaluated in full: no column pruning and no row limit', async () => {
    const NEXTVAL_JSON = '{"error":false,"statements":[{"node":{"type":"SELECT_NODE","modifiers":[],"select_list":[{"class":"FUNCTION","function_name":"nextval"}]}}]}';
    script(() => NEXTVAL_JSON, [['i', 'BIGINT'], ['n', 'BIGINT']]);
    engine().streamHandler = () => [[batch([['c1', utf8(['0'])]]), 8]];
    const tiny = { ...DEFAULT_PROFILE, results: { ...DEFAULT_PROFILE.results, maxColumns: 1 } };
    const r = await settle(runQuery(session, "SELECT i, nextval('s') FROM range(3) t(i)", tiny).result);
    expect(r.value?.evaluatedInFull).toBe(true);
    const [sql] = streamed();
    expect(sql).toContain('left(CAST(c2 AS VARCHAR), 501)'); // the undisplayed column is still evaluated
    expect(sql).not.toContain('LIMIT');
  });

  it('Codex M06: progress says what reached the engine; the result carries its epoch', async () => {
    script(() => NOT_SELECT);
    engine().streamHandler = (q) => (q.startsWith('SELECT') ? new Error('Binder Error: missing') : []);
    const h = runStatements(session, ['CREATE TABLE p (x INT)', 'INSERT INTO p VALUES (42)', 'SELECT missing FROM p'], DEFAULT_PROFILE);
    const r = await settle(h.result);
    expect(r.terminal.status).toBe('error');
    expect(h.progress).toMatchObject({ total: 3, completed: 2, mutationSent: true, mutationInFlight: true });
    const before = session.epoch;
    const ok = await settle(runQuery(session, 'DELETE FROM p', DEFAULT_PROFILE).result);
    expect(ok.value?.epoch).toBe(before + 1);
    expect(session.epoch).toBe(before + 1);
  });
});

describe('ROLLBACK in an aborted transaction (M10 correction)', () => {
  const ABORTED = new Error('TransactionContext Error: Current transaction is aborted (please ROLLBACK)');
  const abortedEngine = () => {
    engine().handler = (q) => (q.includes('json_serialize_sql(') ? ABORTED : undefined);
    engine().streamHandler = (q) => (/\b(ROLLBACK|ABORT)\b/i.test(q) ? [] : ABORTED);
  };
  it('an exact ROLLBACK (or ABORT) still runs and ends the transaction', async () => {
    abortedEngine();
    for (const sql of ['ROLLBACK', 'rollback;', 'ABORT', 'ROLLBACK TRANSACTION', '-- end it\nROLLBACK WORK;', 'ROLLBACK /* recovery */ WORK', '/* a */ ROLLBACK /* b */ ;  -- c', "ROLLBACK /* client's note */ WORK", 'ROLLBACK /* outer /* inner */ outer tail */ WORK']) {
      const r = await settle(runStatements(session, [sql], DEFAULT_PROFILE).result);
      expect([sql, r.terminal.status, r.value?.transactionHint]).toEqual([sql, 'ok', 'end']);
    }
  });
  it('nothing else bypasses classification: other statements still fail with the engine’s message', async () => {
    abortedEngine();
    for (const sql of ['SELECT 1', 'COMMIT', 'ROLLBACK; DROP TABLE t', 'ROLLBACK TO SAVEPOINT s', 'DELETE FROM t', "ROLLBACK /* x */; SELECT 'y'", 'ROLLBACK WORK WORK', 'ROLLBACK /* unterminated', "ROLLBACK 'x'"]) {
      const r = await settle(runStatements(session, [sql], DEFAULT_PROFILE).result);
      expect([sql, r.terminal.status]).toEqual([sql, 'error']);
    }
  });
});
