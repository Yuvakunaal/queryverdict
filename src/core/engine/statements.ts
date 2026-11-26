// Statement classification (docs/ARCHITECTURE.md §11.2, P-048). A UX and invalidation tool, not
// a security boundary: the locked engine configuration is what blocks remote access.
//
//  - DuckDB's own parser (json_serialize_sql, json extension) serialises only SELECT statements
//    (ARCHITECTURE §24 V5). One serialised statement => a read-only SELECT (the data epoch is
//    kept). Note a SELECT can still advance a sequence with nextval(); that changes no table.
//  - Otherwise prepare() is used to tell one non-SELECT statement from several statements without
//    executing anything (behaviour qualified by engine-semantics test ES-12).
//  - transactionHint is lexical and only a status hint (BEGIN … / COMMIT, ROLLBACK, ABORT, END).
import { sqlString } from './lockdown';
import type { Lease, StatementClass } from './types';

/** Removes leading whitespace and SQL comments. */
export function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (t.startsWith('--')) {
      const nl = t.indexOf('\n');
      s = nl < 0 ? '' : t.slice(nl + 1);
    } else if (t.startsWith('/*')) {
      const end = t.indexOf('*/');
      s = end < 0 ? '' : t.slice(end + 2);
    } else {
      return t;
    }
  }
}

export function transactionHint(sql: string): StatementClass['transactionHint'] {
  const head = stripLeadingComments(sql);
  if (/^(BEGIN|START\s+TRANSACTION)\b/i.test(head)) return 'begin';
  if (/^(COMMIT|ROLLBACK|ABORT|END)\b/i.test(head)) return 'end';
  return null;
}

/** Pattern of DuckDB's prepare() error for multi-statement text (ES-12). */
export const MULTIPLE_STATEMENTS = /multiple statements|more than one statement/i;

export async function classifyStatement(lease: Lease, sql: string): Promise<StatementClass> {
  const hint = transactionHint(sql);
  const [row] = await lease.query(`SELECT json_serialize_sql(${sqlString(sql)})::VARCHAR`, { columns: 1, maxRows: 1, exactRows: 1 });
  const parsed = JSON.parse(row?.[0] ?? '{}') as { error?: boolean; error_type?: string; error_message?: string; statements?: unknown[] };
  if (!parsed.error) {
    const n = parsed.statements?.length ?? 0;
    if (n === 1) return { kind: 'select', transactionHint: hint };
    if (n === 0) return { kind: 'unparseable', transactionHint: hint, detail: 'no statement' };
    return { kind: 'multiple', transactionHint: hint, detail: `${n} statements` };
  }
  const message = String(parsed.error_message ?? '');
  if (!/only select statements/i.test(message)) return { kind: 'unparseable', transactionHint: hint, detail: message };
  const prepared = await lease.prepareCheck(sql);
  if (prepared.ok) return { kind: 'possibly-mutating', transactionHint: hint };
  if (MULTIPLE_STATEMENTS.test(prepared.message)) return { kind: 'multiple', transactionHint: hint, detail: prepared.message };
  // prepare() can fail for a single statement too (for example a bind error); it is still one
  // statement that may change data if it runs.
  return { kind: 'possibly-mutating', transactionHint: hint, detail: prepared.message };
}
