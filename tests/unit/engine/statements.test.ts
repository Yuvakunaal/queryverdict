import { describe, expect, it } from 'vitest';
import { classifyStatement, stripLeadingComments, transactionHint } from '../../../src/core/engine/statements';
import type { Lease, Rows } from '../../../src/core/engine/types';

/** Minimal lease answering json_serialize_sql and prepareCheck like DuckDB v1.5.4 (ES-05, ES-12). */
function lease(serialized: object, prepare: { ok: true } | { ok: false; message: string } = { ok: true }): Lease {
  return {
    query: async (): Promise<Rows> => [[JSON.stringify(serialized)]],
    prepareCheck: async () => prepare,
  } as unknown as Lease;
}
const onlySelect = { error: true, error_type: 'not implemented', error_message: 'Only SELECT statements can be serialized to json!' };

describe('statement classification', () => {
  it('one serialised SELECT is read-only', async () => {
    expect(await classifyStatement(lease({ error: false, statements: [{}] }), 'SELECT 1')).toEqual({ kind: 'select', transactionHint: null });
  });

  it('several serialised SELECTs are multiple', async () => {
    expect((await classifyStatement(lease({ error: false, statements: [{}, {}] }), 'SELECT 1; SELECT 2')).kind).toBe('multiple');
  });

  it('a single non-SELECT is possibly mutating; prepare rejecting multiple statements is multiple', async () => {
    expect((await classifyStatement(lease(onlySelect), 'UPDATE t SET a = 1')).kind).toBe('possibly-mutating');
    expect((await classifyStatement(lease(onlySelect, { ok: false, message: 'Invalid Input Error: Cannot prepare multiple statements at once!' }), 'CREATE TABLE a(x INT); DROP TABLE a')).kind).toBe('multiple');
    expect((await classifyStatement(lease(onlySelect, { ok: false, message: 'Catalog Error: Table x does not exist' }), 'UPDATE x SET a=1')).kind).toBe('possibly-mutating');
  });

  it('parser errors are unparseable', async () => {
    expect((await classifyStatement(lease({ error: true, error_type: 'parser', error_message: 'Parser Error: syntax error at or near "SELEC"' }), 'SELEC 1')).kind).toBe('unparseable');
  });

  it('gives a lexical transaction hint, ignoring leading comments', () => {
    expect(transactionHint('  -- note\n/* x */ begin transaction')).toBe('begin');
    expect(transactionHint('START TRANSACTION')).toBe('begin');
    expect(transactionHint('commit')).toBe('end');
    expect(transactionHint('ROLLBACK')).toBe('end');
    expect(transactionHint('SELECT 1')).toBeNull();
    expect(stripLeadingComments('/* unterminated')).toBe('');
  });
});
