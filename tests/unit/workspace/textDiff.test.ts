import { describe, expect, it } from 'vitest';
import { minimalChange } from '../../../src/features/editor/textDiff';

const apply = (s: string, c: { from: number; to: number; insert: string }) => s.slice(0, c.from) + c.insert + s.slice(c.to);

describe('minimalChange (external text replacement, M05)', () => {
  it('keeps the common prefix and suffix', () => {
    expect(minimalChange('SELECT 1', 'SELECT 2 AS external')).toEqual({ from: 7, to: 8, insert: '2 AS external' });
    expect(minimalChange('SELECT a FROM t', 'SELECT b FROM t')).toEqual({ from: 7, to: 8, insert: 'b' });
  });

  it('handles identical, empty, prefix-only and suffix-only texts', () => {
    expect(minimalChange('abc', 'abc')).toEqual({ from: 3, to: 3, insert: '' });
    expect(minimalChange('', 'abc')).toEqual({ from: 0, to: 0, insert: 'abc' });
    expect(minimalChange('abc', '')).toEqual({ from: 0, to: 3, insert: '' });
    expect(minimalChange('aaa', 'aaaa')).toEqual({ from: 3, to: 3, insert: 'a' });
  });

  it('never splits a surrogate pair', () => {
    const c = minimalChange('x😀y', 'x😃y'); // same high surrogate, different low surrogate
    expect(c.from).toBe(1);
    expect(c.to).toBe(3);
    expect(apply('x😀y', c)).toBe('x😃y');
  });

  it('always reproduces the target text', () => {
    const cases: [string, string][] = [['SELECT 1;', 'SELECT 1; -- x'], ['abcabc', 'abc'], ['😀😀', '😀'], ['ab', 'ba'], ['\n\n', '\n']];
    for (const [a, b] of cases) expect(apply(a, minimalChange(a, b))).toBe(b);
  });
});
