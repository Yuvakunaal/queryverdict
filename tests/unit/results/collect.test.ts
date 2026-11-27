import { describe, expect, it } from 'vitest';
import { ResultCollector, type CollectLimits } from '../../../src/core/results/collect';
import type { DataEpoch, Generation } from '../../../src/core/engine/types';
import { batch, utf8 } from './arrow-fixtures';

const stamp = { generation: 1 as Generation, epoch: 0 as DataEpoch };
const L = (o: Partial<CollectLimits> = {}): CollectLimits => ({ maxRows: 1000, maxColumns: 200, maxCellChars: 500, maxDisplayChars: 2_000_000, maxArrowBytes: 16 * 1024 * 1024, ...o });
const rowsOf = (n: number, text = 'v') => utf8(Array.from({ length: n }, (_, i) => `${text}${i}`));

describe('ResultCollector: every bound, every cause separately (M06; P-020; T-ENG-009a)', () => {
  it('keeps everything within bounds and reports no truncation', () => {
    const c = new ResultCollector(L());
    expect(c.consume(batch([['a', rowsOf(3)]]), 100)).toBe(true);
    const r = c.finish(stamp);
    expect(r.rows.map((x) => x[0])).toEqual([0, 1, 2].map((i) => ({ kind: 'text', text: `v${i}`, truncated: false })));
    expect(r.truncation).toEqual({ rows: false, columns: null, cells: 0, display: false, bytes: false });
    expect(r.limits.rowsBoundBy).toBe('query');
  });

  it('row limit: the sentinel row proves more rows exist and stops the stream', () => {
    const c = new ResultCollector(L({ maxRows: 2 }));
    expect(c.consume(batch([['a', rowsOf(3)]]), 100)).toBe(false);
    const r = c.finish(stamp);
    expect(r.rows).toHaveLength(2);
    expect(r.truncation.rows).toBe(true);
    // Exactly maxRows rows and no more: not truncated.
    const d = new ResultCollector(L({ maxRows: 3 }));
    d.consume(batch([['a', rowsOf(3)]]), 100);
    expect(d.finish(stamp).truncation.rows).toBe(false);
  });

  it('column limit converts only the first columns and reports shown of total', () => {
    const c = new ResultCollector(L({ maxColumns: 1 }));
    c.consume(batch([['a', rowsOf(1)], ['b', rowsOf(1)]]), 100);
    const r = c.finish(stamp);
    expect(r.columns.map((x) => x.name)).toEqual(['a']);
    expect(r.rows[0]).toHaveLength(1);
    expect(r.truncation.columns).toEqual({ shown: 1, total: 2 });
  });

  it('declared columns (DESCRIBE) give names, types and the total', () => {
    const c = new ResultCollector(L({ maxColumns: 1 }), [{ name: 'x', type: 'HUGEINT' }, { name: 'x', type: 'VARCHAR' }]);
    c.consume(batch([['c1', rowsOf(1)]]), 10);
    const r = c.finish(stamp);
    expect(r.columns).toEqual([{ name: 'x', type: 'HUGEINT' }]);
    expect(r.truncation.columns).toEqual({ shown: 1, total: 2 });
  });

  it('cell limit counts cut cells', () => {
    const c = new ResultCollector(L({ maxCellChars: 3 }));
    c.consume(batch([['a', utf8(['abcd', 'ab', 'abcdef'])]]), 100);
    const r = c.finish(stamp);
    expect(r.truncation.cells).toBe(2);
    expect(r.rows[0]?.[0]).toEqual({ kind: 'text', text: 'abc', truncated: true });
  });

  it('display limit withholds whole rows, never part of one', () => {
    const c = new ResultCollector(L({ maxDisplayChars: 5 }));
    expect(c.consume(batch([['a', utf8(['aa', 'bb', 'cc'])]]), 100)).toBe(false);
    const r = c.finish(stamp);
    expect(r.rows).toHaveLength(2);
    expect(r.truncation.display).toBe(true);
    expect(r.truncation.rows).toBe(false);
  });

  it('byte limit: a batch that would exceed it is not converted at all', () => {
    const c = new ResultCollector(L({ maxArrowBytes: 150 }));
    expect(c.consume(batch([['a', rowsOf(2)]]), 100)).toBe(true);
    expect(c.consume(batch([['a', rowsOf(2, 'w')]]), 100)).toBe(false);
    const r = c.finish(stamp);
    expect(r.rows).toHaveLength(2);
    expect(r.truncation.bytes).toBe(true);
    // A first batch over the limit: no rows, columns still known.
    const d = new ResultCollector(L({ maxArrowBytes: 10 }));
    d.consume(batch([['a', rowsOf(2)]]), 100);
    const e = d.finish(stamp);
    expect(e.rows).toHaveLength(0);
    expect(e.columns.map((x) => x.name)).toEqual(['a']);
    expect(e.truncation.bytes).toBe(true);
  });

  it('batch boundaries do not lose or duplicate rows', () => {
    const c = new ResultCollector(L({ maxRows: 5 }));
    c.consume(batch([['a', utf8(['0', '1', '2'])]]), 10);
    c.consume(batch([['a', utf8(['3', '4', '5'])]]), 10);
    const r = c.finish(stamp);
    expect(r.rows.map((x) => (x[0]?.kind === 'text' ? x[0].text : null))).toEqual(['0', '1', '2', '3', '4']);
    expect(r.truncation.rows).toBe(true);
  });

  it('a statement with no result batches has no columns and no rows', () => {
    const r = new ResultCollector(L()).finish(stamp);
    expect(r.columns).toEqual([]);
    expect(r.rows).toEqual([]);
  });

  it('once stopped, later batches of a drained stream add nothing but still prove more rows exist', () => {
    const c = new ResultCollector(L({ maxRows: 2 }));
    expect(c.consume(batch([['a', rowsOf(2)]]), 10)).toBe(true);
    expect(c.consume(batch([['a', rowsOf(1, 'x')]]), 10)).toBe(false);
    expect(c.consume(batch([['a', rowsOf(5, 'y')]]), 10)).toBe(false);
    const r = c.finish(stamp);
    expect(r.rows).toHaveLength(2);
    expect(r.truncation.rows).toBe(true);
  });
});
