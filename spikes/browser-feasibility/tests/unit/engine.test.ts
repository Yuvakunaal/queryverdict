import { describe, expect, it } from 'vitest';
import { Field, Int32, List, Struct, Table, Utf8, makeData, makeVector, tableFromArrays, vectorFromArray, Decimal } from 'apache-arrow';
import { batchBytes, collectBounded, limits } from '../../src/engine/bounded';
import { decimalWordsToString, formatValue } from '../../src/engine/format';
import { escalationProbes, lockdownStatements, requiredSettings, sqlIdent, sqlString, verifyLockdown } from '../../src/engine/lockdown';
import { detectFormat, errorText, relationName } from '../../src/engine/session';

async function* batches(table: Table) {
  for (const b of table.batches) yield b;
}

function tableOf(rows: number, batchSize: number): Table {
  const parts: Table[] = [];
  for (let start = 0; start < rows; start += batchSize) {
    const n = Math.min(batchSize, rows - start);
    parts.push(tableFromArrays({ id: Int32Array.from({ length: n }, (_, i) => start + i), name: Array.from({ length: n }, (_, i) => `row-${start + i}`) }));
  }
  return parts.reduce((a, b) => a.concat(b));
}

const utf8Table = (cols: Record<string, string[]>) =>
  new Table(Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, vectorFromArray(v, new Utf8())])));

describe('collectBounded: row budget', () => {
  it('returns everything when under the limits', async () => {
    const r = await collectBounded(batches(tableOf(50, 20)), limits({ maxRows: 100 }));
    expect(r.rows).toHaveLength(50);
    expect(r.truncated).toBe(false);
    expect(r.columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(r.rows[49]).toEqual(['49', 'row-49']);
  });

  it('stops at maxRows, reports row truncation only, and stops pulling batches', async () => {
    let pulled = 0;
    async function* counting() {
      for await (const b of batches(tableOf(10_000, 1000))) {
        pulled++;
        yield b;
      }
    }
    const r = await collectBounded(counting(), limits({ maxRows: 1500 }));
    expect(r.rows).toHaveLength(1500);
    expect(r.truncation).toMatchObject({ rows: true, arrowBytes: false, displayChars: false, columns: false, cellsShortened: 0 });
    expect(pulled).toBe(2);
  });

  it('does not report truncation when the result exactly fills the limit', async () => {
    const r = await collectBounded(batches(tableOf(100, 50)), limits({ maxRows: 100 }));
    expect(r.truncated).toBe(false);
    expect(r.rows).toHaveLength(100);
  });
});

describe('collectBounded: byte, display, column and cell budgets', () => {
  it('Codex repro: one 2 MiB cell under a 1 KiB budget is not converted in full', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const r = await collectBounded(batches(utf8Table({ v: [big] })), limits({ maxArrowBytes: 1024, maxCellChars: 500 }));
    expect(r.rows[0]![0]!.length).toBeLessThanOrEqual(500);
    expect(r.truncation.cellsShortened).toBe(1);
    expect(r.truncation.arrowBytes).toBe(true); // the batch itself was larger than the byte budget
    expect(r.truncation.rows).toBe(false); // distinguished from row truncation
    expect(r.arrowBytesSeen).toBeGreaterThan(2 * 1024 * 1024);
  });

  it('shortens multiple large cells independently and bounds total display size', async () => {
    const cols = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}`, ['y'.repeat(100_000)]]));
    const r = await collectBounded(batches(utf8Table(cols)), limits({ maxCellChars: 200 }));
    expect(r.rows[0]!.every((c) => c.length <= 200)).toBe(true);
    expect(r.truncation.cellsShortened).toBe(10);
    expect(r.displayChars).toBeLessThanOrEqual(10 * 200);
  });

  it('stops converting rows at maxDisplayChars and reports display truncation, not row truncation', async () => {
    const t = utf8Table({ v: Array.from({ length: 200 }, () => 'z'.repeat(400)) });
    const r = await collectBounded(batches(t), limits({ maxDisplayChars: 10_000, maxCellChars: 500 }));
    expect(r.rows.length).toBe(25);
    expect(r.truncation.displayChars).toBe(true);
    expect(r.truncation.rows).toBe(false);
  });

  it('converts at most maxColumns columns of a wide row', async () => {
    const cols = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`col${i}`, Int32Array.from([i])]));
    const r = await collectBounded(batches(tableFromArrays(cols)), limits({ maxColumns: 50 }));
    expect(r.totalColumns).toBe(500);
    expect(r.columns).toHaveLength(50);
    expect(r.rows[0]).toHaveLength(50);
    expect(r.truncation.columns).toBe(true);
  });

  it('bounds nested lists without expanding every item', () => {
    const list = vectorFromArray([Array.from({ length: 100_000 }, (_, i) => i)], new List(new Field('item', new Int32(), true)));
    return collectBounded(batches(new Table({ l: list })), limits({ maxCellChars: 120 })).then((r) => {
      const cell = r.rows[0]![0]!;
      expect(cell.length).toBeLessThanOrEqual(120);
      expect(cell.startsWith('[0, 1, 2')).toBe(true);
      expect(r.truncation.cellsShortened).toBe(1);
    });
  });

  it('bounds structs containing oversized strings', async () => {
    const type = new Struct([new Field('a', new Utf8(), true), new Field('b', new Int32(), true)]);
    const v = vectorFromArray([{ a: 'q'.repeat(1_000_000), b: 7 }], type);
    const r = await collectBounded(batches(new Table({ s: v })), limits({ maxCellChars: 100 }));
    expect(r.rows[0]![0]!.length).toBeLessThanOrEqual(100);
    expect(r.rows[0]![0]!.startsWith('{a: qqq')).toBe(true);
    expect(r.truncation.cellsShortened).toBe(1);
  });

  it('formats dictionary-encoded strings through the dictionary', async () => {
    const r = await collectBounded(batches(tableOf(3, 3)), limits());
    expect(r.rows.map((x) => x[1])).toEqual(['row-0', 'row-1', 'row-2']);
  });

  it('counts dictionary-encoded string values in the byte budget', () => {
    const b = tableOf(500, 500).batches[0]!;
    expect(batchBytes(b)).toBeGreaterThan(2000 + 2000 + 500 * 5);
  });
});

describe('format', () => {
  it('formats decimals exactly from Arrow words', () => {
    expect(decimalWordsToString(Uint32Array.from([123456, 0, 0, 0]), 2)).toBe('1234.56');
    expect(decimalWordsToString(Uint32Array.from([5, 0, 0, 0]), 2)).toBe('0.05');
    expect(decimalWordsToString(Uint32Array.from([0xfffe1dc0, 0xffffffff, 0xffffffff, 0xffffffff]), 2)).toBe('-1234.56');
    expect(decimalWordsToString(Uint32Array.from([0, 1, 0, 0]), 0)).toBe('4294967296');
  });

  it('formats a real Arrow decimal vector', () => {
    const type = new Decimal(2, 7, 128);
    const data = makeData({ type, length: 1, data: Uint32Array.from([123456, 0, 0, 0]) });
    expect(formatValue(makeVector(data).get(0), new Field('amount', type))).toBe('1234.56');
  });

  it('formats NULL, bigint and strings', () => {
    expect(formatValue(null, new Field('x', new Utf8()))).toBe('NULL');
    expect(formatValue(9007199254740993n, new Field('x', new Int32()))).toBe('9007199254740993');
    expect(formatValue('a', new Field('x', new Utf8()))).toBe('a');
  });
});

describe('lockdown statements', () => {
  const stmts = lockdownStatements('http://127.0.0.1:4173/queryverdict/duckdb-ext');
  const idx = (re: RegExp) => stmts.findIndex((s) => re.test(s));

  it('loads required extensions before disabling external access, and locks last', () => {
    expect(idx(/^LOAD parquet/)).toBeLessThan(idx(/enable_external_access = false/));
    expect(idx(/^LOAD json/)).toBeLessThan(idx(/enable_external_access = false/));
    expect(idx(/autoload_known_extensions = false/)).toBeLessThan(idx(/^LOAD parquet/));
    expect(stmts.at(-1)).toBe('SET lock_configuration = true');
  });

  it('builds probes with unique names', () => {
    const probes = escalationProbes('http://127.0.0.1:9');
    expect(probes.length).toBeGreaterThanOrEqual(15);
    expect(new Set(probes.map((p) => p.name)).size).toBe(probes.length);
  });

  it('quotes strings and identifiers', () => {
    expect(sqlString("it's")).toBe("'it''s'");
    expect(sqlIdent('a"b')).toBe('"a""b"');
  });
});

describe('verifyLockdown (fail-closed verification, injected states)', () => {
  const repo = 'http://127.0.0.1:4173/queryverdict/duckdb-ext';
  function fakeEngine(over: { settings?: Record<string, string | null>; extensions?: string[]; lockRejects?: boolean } = {}) {
    const settings: Record<string, string | null> = { ...requiredSettings(repo), ...(over.settings ?? {}) };
    const extensions = over.extensions ?? ['core_functions', 'json', 'parquet'];
    const rows = (xs: Record<string, unknown>[]) => ({ toArray: () => xs.map((x) => ({ toJSON: () => x })) });
    return async (sql: string) => {
      if (sql.includes('duckdb_settings()')) return rows(Object.entries(settings).filter(([, v]) => v !== null).map(([name, value]) => ({ name, value })));
      if (sql.includes('duckdb_extensions()')) return rows(extensions.map((extension_name) => ({ extension_name })));
      if (sql.startsWith('SET ')) {
        if (over.lockRejects === false) return rows([]);
        throw new Error('Cannot change configuration option: the configuration has been locked');
      }
      throw new Error(`unexpected ${sql}`);
    };
  }

  it('accepts the fully locked state', async () => {
    const v = await verifyLockdown(fakeEngine(), repo);
    expect(v).toMatchObject({ ok: true, failures: [] });
  });

  it.each([
    ['lock_configuration', 'false'],
    ['enable_external_access', 'true'],
    ['autoload_known_extensions', 'true'],
    ['autoinstall_known_extensions', 'true'],
    ['allow_community_extensions', 'true'],
    ['allow_unsigned_extensions', 'true'],
    ['allowed_directories', '[/]'],
    ['custom_extension_repository', 'https://extensions.duckdb.org'],
    ['autoinstall_extension_repository', ''],
    ['enable_external_access', null],
  ])('rejects %s = %s', async (name, value) => {
    const v = await verifyLockdown(fakeEngine({ settings: { [name]: value } }), repo);
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toContain(name);
  });

  it('rejects unexpected or missing loaded extensions', async () => {
    expect((await verifyLockdown(fakeEngine({ extensions: ['core_functions', 'httpfs', 'json', 'parquet'] }), repo)).ok).toBe(false);
    expect((await verifyLockdown(fakeEngine({ extensions: ['core_functions', 'parquet'] }), repo)).ok).toBe(false);
  });

  it('rejects a lock that does not actually reject changes', async () => {
    const v = await verifyLockdown(fakeEngine({ lockRejects: false }), repo);
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toContain('did not reject');
  });
});

describe('file naming and errors', () => {
  it('detects supported formats', () => {
    expect(detectFormat('A.CSV')).toBe('csv');
    expect(detectFormat('x.ndjson')).toBe('json');
    expect(detectFormat('x.parquet')).toBe('parquet');
    expect(detectFormat('x.xlsx')).toBeNull();
  });

  it('derives safe, unique relation names', () => {
    expect(relationName('orders.csv', new Set(['orders']))).toBe('orders_2');
    expect(relationName('2024 Sales (final).csv', new Set())).toBe('t_2024_sales_final');
    expect(relationName('"; DROP TABLE x; --.csv', new Set())).toBe('drop_table_x');
    expect(relationName('.csv', new Set())).toBe('dataset');
  });

  it('normalises DuckDB JSON errors', () => {
    expect(errorText(new Error('{"exception_type":"Parser","exception_message":"syntax error at or near \\"SELEC\\"\\n\\nLINE 1"}'))).toBe('Parser Error: syntax error at or near "SELEC"');
    expect(errorText(new Error('Catalog Error: x\nmore'))).toBe('Catalog Error: x');
  });
});
