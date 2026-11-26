import { describe, expect, it } from 'vitest';
import { admit, detectFormat, isReadable } from '../../../src/core/datasets/admission';
import { invalidRequestedName, normaliseName, quoteIdent, resolveName } from '../../../src/core/datasets/naming';
import { DEFAULT_PROFILE } from '../../../src/core/profile/profile';

const LIMITS = { ...DEFAULT_PROFILE.imports, maxFileBytes: 100, maxCombinedBytes: 150 };

describe('admission (actual byte sizes, before any engine work)', () => {
  it('accepts .csv and .parquet only, case-insensitively', () => {
    expect([detectFormat('a.CSV'), detectFormat('b.parquet'), detectFormat('c.tsv'), detectFormat('d.json'), detectFormat('csv')]).toEqual(['csv', 'parquet', null, null, null]);
  });

  it('refuses unsupported, empty, oversized and combined-oversized files with reasons', () => {
    const r = admit([
      { name: 'a.json', size: 10 }, { name: 'b.csv', size: 0 }, { name: 'c.csv', size: 101 },
      { name: 'd.csv', size: 100 }, { name: 'e.parquet', size: 60 }, { name: 'f.csv', size: 50 },
    ], LIMITS, 0);
    expect(r.map((x) => x.ok)).toEqual([false, false, false, true, false, true]);
    expect(r[0]).toMatchObject({ reason: expect.stringContaining('Unsupported file type') });
    expect(r[1]).toMatchObject({ reason: 'The file is empty.' });
    expect(r[2]).toMatchObject({ reason: expect.stringContaining('per file') });
    expect(r[4]).toMatchObject({ reason: expect.stringContaining('combined limit') });
  });

  it('counts datasets already imported in the session toward the combined cap', () => {
    expect(admit([{ name: 'a.csv', size: 60 }], LIMITS, 100)[0]?.ok).toBe(false);
    expect(admit([{ name: 'a.csv', size: 50 }], LIMITS, 100)[0]?.ok).toBe(true);
  });

  it('detects an unreadable file', async () => {
    expect(await isReadable(new Blob(['x']))).toBe(true);
    const broken = { slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }) } as unknown as Blob;
    expect(await isReadable(broken)).toBe(false);
  });
});

describe('naming', () => {
  const reserved = new Set(['select', 'from', 'order']);

  it('normalises file names deterministically', () => {
    expect(normaliseName('Orders 2024 (Final).CSV')).toBe('orders_2024_final');
    expect(normaliseName('2024-sales.parquet')).toBe('t_2024_sales');
    expect(normaliseName('---.csv')).toBe('dataset');
    expect(normaliseName('café.csv')).toBe('cafe');
    expect(normaliseName('order.csv', reserved)).toBe('order_data');
    expect(normaliseName(`${'x'.repeat(80)}.csv`)).toHaveLength(63);
  });

  it('resolves collisions with suffixes and never reuses a taken name', () => {
    expect(resolveName('orders', new Set())).toBe('orders');
    expect(resolveName('orders', new Set(['orders', 'orders_2']))).toBe('orders_3');
    expect(resolveName('x'.repeat(63), new Set(['x'.repeat(63)]))).toBe(`${'x'.repeat(61)}_2`);
  });

  it('validates requested names without silently changing them', () => {
    expect(invalidRequestedName('orders', reserved)).toBeNull();
    expect(invalidRequestedName('Orders', reserved, new Set(['orders']))).toMatch(/already exists/);
    expect(invalidRequestedName('select', reserved)).toMatch(/reserved/);
    expect(invalidRequestedName('my table', reserved)).toMatch(/letters, digits/);
    expect(invalidRequestedName('1abc', reserved)).toMatch(/letters, digits/);
    expect(invalidRequestedName('x'.repeat(64), reserved)).toMatch(/at most 63/);
  });

  it('quotes identifiers so file names never reach SQL unquoted', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(quoteIdent('x; DROP TABLE y')).toBe('"x; DROP TABLE y"');
  });
});
