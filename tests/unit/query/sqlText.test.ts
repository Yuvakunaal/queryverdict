import { describe, expect, it } from 'vitest';
import { leadingKeyword, trimTerminator } from '../../../src/core/query/sqlText';

describe('trimTerminator (one statement, terminator removed; M06)', () => {
  it.each([
    ['SELECT 1;', 'SELECT 1'],
    ['SELECT 1 ;  ', 'SELECT 1'],
    ['SELECT 1; -- end', 'SELECT 1'],
    ['SELECT 1 -- trailing ; comment\n;  -- end', 'SELECT 1'],
    ['SELECT 1 /* a ; /* nested */ b */ ;', 'SELECT 1'],
    ["SELECT 'a;' AS x;", "SELECT 'a;' AS x"],
    ["SELECT 'it''s;' ;", "SELECT 'it''s;'"],
    ["SELECT E'a\\';b';", "SELECT E'a\\';b'"],
    ['SELECT "col;" FROM t;', 'SELECT "col;" FROM t'],
    ['SELECT $$a;$$;', 'SELECT $$a;$$'],
    ['SELECT $q$x$$;y$q$ ;', 'SELECT $q$x$$;y$q$'],
    ['SELECT 1', 'SELECT 1'],
    ['  ', ''],
  ])('%j → %j', (input, expected) => {
    expect(trimTerminator(input)).toBe(expected);
  });
});

describe('leadingKeyword', () => {
  it('skips comments, whitespace and parentheses', () => {
    expect(leadingKeyword('-- c\n /* d */ (insert into t values (1))')).toBe('INSERT');
    expect(leadingKeyword('  pivot t on b')).toBe('PIVOT');
    expect(leadingKeyword('')).toBe('');
  });
});
