import { describe, expect, it } from 'vitest';
import { splitStatements, statementAt } from '../../../src/core/query/sqlText';

const texts = (sql: string) => splitStatements(sql).map((s) => s.text);

describe('splitStatements (P-097)', () => {
  it('splits at top-level semicolons only', () => {
    expect(texts('select 1; select 2;')).toEqual(['select 1', 'select 2']);
    expect(texts("SELECT 'a;b'; SELECT \"c;d\" FROM t; SELECT $$e;f$$; SELECT E'g\\';h'")).toEqual(["SELECT 'a;b'", 'SELECT "c;d" FROM t', 'SELECT $$e;f$$', "SELECT E'g\\';h'"]);
    expect(texts('SELECT 1 -- a; b\n; /* c; /* d; */ e; */ SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('drops empty and comment-only pieces; keeps offsets', () => {
    const s = 'select *\nfrom t\nlimit 5;\n\n-- only a comment;\n;;\nselect 2;';
    expect(texts(s)).toEqual(['select *\nfrom t\nlimit 5', 'select 2']);
    const [a, b] = splitStatements(s);
    expect(s.slice(a!.start, a!.end)).toBe(a!.text);
    expect(s[a!.through - 1]).toBe(';');
    expect(s.slice(b!.start, b!.end)).toBe('select 2');
  });
  it('a final statement without terminator', () => {
    expect(splitStatements('select 1;\nselect 2')).toMatchObject([{ text: 'select 1' }, { text: 'select 2', through: 18 }]);
  });
});

describe('statementAt: Snowflake-style current statement', () => {
  const sql = 'select *\nfrom t\nlimit 5;\n\n-- second\nselect 2; -- tail\n';
  const at = (needle: string, delta = 0) => statementAt(sql, sql.indexOf(needle) + delta)?.text;
  it('the statement the caret is in, including its terminator', () => {
    expect(at('from')).toBe('select *\nfrom t\nlimit 5');
    expect(at('5;', 2)).toBe('select *\nfrom t\nlimit 5'); // just after the ;
    expect(at('select 2', 3)).toBe('select 2');
  });
  it('a leading comment or blank line belongs to the next statement', () => {
    expect(at('-- second', 3)).toBe('select 2');
    expect(statementAt(sql, sql.indexOf('\n\n') + 1)?.text).toBe('select 2');
  });
  it('after a terminator on the same line: the statement that just ended; after everything: the last', () => {
    expect(at('-- tail', 3)).toBe('select 2');
    expect(statementAt(sql, sql.length)?.text).toBe('select 2');
    expect(statementAt('  ', 1)).toBeNull();
  });
});
