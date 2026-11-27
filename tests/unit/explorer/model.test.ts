// Explorer helpers (M04 field 15: name-validation UI helpers; AM-007 state labels).
import { describe, expect, it } from 'vitest';
import type { DatasetEntry, DatasetState } from '../../../src/core/datasets/types';
import { DEFAULT_PROFILE } from '../../../src/core/profile/profile';
import { copyText, entryKey, formatBytes, friendlyReason, groupDigits, importedBytes, isPresent, ORIGIN, reviewFiles, rowCountText, STATE } from '../../../src/features/explorer/model';

const LIMITS = { ...DEFAULT_PROFILE.imports, maxFileBytes: 1_000, maxCombinedBytes: 1_500 };

describe('labels', () => {
  it('every registry state has the approved text label (AM-007, M04 field 6)', () => {
    const states: DatasetState[] = ['ready', 'importing', 'needs-reimport', 'missing', 'changed', 'failed'];
    expect(states.map((s) => STATE[s].label)).toEqual(['Ready', 'Importing', 'Needs re-import', 'Removed by SQL', 'Changed', 'Failed']);
    for (const s of states) expect(STATE[s].description.length).toBeGreaterThan(10);
    expect(ORIGIN).toEqual({ imported: 'Imported', sql: 'Created by SQL', demo: 'Demo' });
    expect(states.filter((s) => isPresent({ state: s }))).toEqual(['ready', 'changed']);
  });
});

describe('formatting', () => {
  it('groups exact counts without converting to Number', () => {
    expect(groupDigits('9007199254740993')).toBe('9,007,199,254,740,993');
    expect(groupDigits('170141183460469231731687303715884105727')).toBe('170,141,183,460,469,231,731,687,303,715,884,105,727');
    expect(groupDigits('-1000')).toBe('-1,000');
    expect(groupDigits('12')).toBe('12');
    expect(rowCountText('1')).toBe('1 row');
    expect(rowCountText('0')).toBe('0 rows');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50.0 MiB');
  });

  it('copies table names as quoted SQL identifiers (no injection through names)', () => {
    expect(copyText('orders')).toBe('"orders"');
    expect(copyText('my "t"; DROP TABLE x; --')).toBe('"my ""t""; DROP TABLE x; --"');
  });

  it('keys distinguish the same name across origins and schemas', () => {
    const e = (origin: 'imported' | 'sql', schema: string) => ({ relation: 'x', origin, identity: { database: 'memory', schema, oid: '1' } });
    expect(new Set([entryKey(e('imported', 'main')), entryKey(e('sql', 'main')), entryKey(e('sql', 'other'))]).size).toBe(3);
  });

  it('hides the engine-internal virtual path in import errors', () => {
    expect(friendlyReason("Invalid Input Error: No magic bytes found at end of file '/qv-local/52b6aacb-9413-4415-8e2c-7193bc07e13a.parquet'")).toBe('Invalid Input Error: No magic bytes found at end of the file');
    expect(friendlyReason("Could not read '/qv-local/0a-b.csv'")).toBe('Could not read the file');
    expect(friendlyReason(undefined)).toBe('The import did not complete.');
  });
});

describe('import review (previews the M03 rules; the importer decides)', () => {
  const f = (name: string, size = 10) => ({ name, size });
  it('proposes distinct names within a batch and against existing tables', () => {
    const r = reviewFiles([f('Orders.csv'), f('orders.parquet'), f('customers.csv')], [], new Set(['orders']), LIMITS, 0);
    expect(r.map((x) => [x.proposed, x.importable])).toEqual([['orders_2', true], ['orders_3', true], ['customers', true]]);
  });

  it('refuses unsupported, empty and oversized files with the configured limit, keeping the others', () => {
    const r = reviewFiles([f('a.json'), f('b.csv', 0), f('c.csv', 1_001), f('d.csv')], [], new Set(), LIMITS, 0);
    expect(r.map((x) => x.importable)).toEqual([false, false, false, true]);
    expect(r[2]?.refusal).toMatch(/configured limit/);
    expect(r[3]?.proposed).toBe('d');
  });

  it('counts earlier imports toward the combined limit', () => {
    expect(reviewFiles([f('a.csv', 600)], [], new Set(), LIMITS, 1_000)[0]?.refusal).toMatch(/combined limit/);
    expect(importedBytes([
      { relation: 'a', kind: 'table', origin: 'imported', state: 'ready', source: { fileName: 'a', bytes: 5, format: 'csv' }, verdictEligible: true },
      { relation: 'b', kind: 'table', origin: 'imported', state: 'needs-reimport', source: { fileName: 'b', bytes: 7, format: 'csv' }, verdictEligible: false },
      { relation: 'c', kind: 'table', origin: 'sql', state: 'ready', verdictEligible: true },
    ] as DatasetEntry[])).toBe(5);
  });

  it('a requested name is validated and never changed silently; a conflict blocks the file until corrected', () => {
    const r = reviewFiles([f('a.csv'), f('b.csv'), f('c.csv'), f('d.csv')], ['orders', 'Sales', 'bad name', 'x'], new Set(['orders']), LIMITS, 0);
    expect(r.map((x) => [x.requested, x.nameError === null, x.importable])).toEqual([['orders', false, false], ['Sales', true, true], ['bad name', false, false], ['x', true, true]]);
    expect(r[0]?.nameError).toMatch(/already exists/);
    expect(r[2]?.nameError).toMatch(/letters, digits/);
    // A requested name reserves itself for later files in the batch.
    const r2 = reviewFiles([f('a.csv'), f('sales.csv')], ['sales', undefined], new Set(), LIMITS, 0);
    expect(r2.map((x) => x.requested ?? x.proposed)).toEqual(['sales', 'sales_2']);
    // Typing exactly the proposed name is not a request.
    expect(reviewFiles([f('a.csv')], ['a'], new Set(), LIMITS, 0)[0]?.requested).toBeNull();
  });
});
