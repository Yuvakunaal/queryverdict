import { describe, expect, it } from 'vitest';
import { arrowCell, cutText, decimalText } from '../../../src/core/results/arrow';
import { bools, decimals, ints, other, utf8 } from './arrow-fixtures';
import type { ArrowData } from '../../../src/core/results/arrow';

describe('arrowCell: exact text from transferred data (M06)', () => {
  it('UTF-8: NULL, empty and whitespace stay distinct; long values are cut by code point, never splitting a character', () => {
    const d = utf8([null, '', '   ', 'héllo 🌍', 'x'.repeat(600), '🌍'.repeat(10)]);
    expect(arrowCell(d, 0, 500)).toEqual({ kind: 'null' });
    expect(arrowCell(d, 1, 500)).toEqual({ kind: 'text', text: '', truncated: false });
    expect(arrowCell(d, 2, 500)).toEqual({ kind: 'text', text: '   ', truncated: false });
    expect(arrowCell(d, 3, 500)).toEqual({ kind: 'text', text: 'héllo 🌍', truncated: false });
    expect(arrowCell(d, 4, 500)).toEqual({ kind: 'text', text: 'x'.repeat(500), truncated: true });
    expect(arrowCell(d, 5, 3)).toEqual({ kind: 'text', text: '🌍🌍🌍', truncated: true });
  });

  it('decodes only a bounded prefix of a very long value', () => {
    const d = utf8(['a'.repeat(100_000)]);
    const c = arrowCell(d, 0, 10);
    expect(c).toEqual({ kind: 'text', text: 'a'.repeat(10), truncated: true });
  });

  it('booleans and 64-bit integers are exact (beyond 2^53)', () => {
    expect(arrowCell(bools([true, false, null]), 0, 500)).toEqual({ kind: 'text', text: 'true', truncated: false });
    expect(arrowCell(bools([true, false, null]), 1, 500)).toEqual({ kind: 'text', text: 'false', truncated: false });
    expect(arrowCell(bools([true, false, null]), 2, 500)).toEqual({ kind: 'null' });
    const big = ints([9007199254740993n, -9223372036854775808n]);
    expect(arrowCell(big, 0, 500)).toEqual({ kind: 'text', text: '9007199254740993', truncated: false });
    expect(arrowCell(big, 1, 500)).toEqual({ kind: 'text', text: '-9223372036854775808', truncated: false });
  });

  it('decimals with a scale are exact; Decimal(38,0) is not shown (HUGEINT and UHUGEINT arrive the same way)', () => {
    const d = decimals([12345n, -1n, 15000000000n], 18, 3);
    expect(arrowCell(d, 0, 500)).toEqual({ kind: 'text', text: '12.345', truncated: false });
    expect(arrowCell(d, 1, 500)).toEqual({ kind: 'text', text: '-0.001', truncated: false });
    expect(arrowCell(d, 2, 500)).toEqual({ kind: 'text', text: '15000000.000', truncated: false });
    expect(arrowCell(decimals([-1n], 38, 0), 0, 500).kind).toBe('unsupported');
  });

  it('types whose DuckDB text cannot be recovered exactly are marked, never guessed', () => {
    for (const [id, name] of [[3, 'Float64'], [4, 'Binary'], [9, 'Time64'], [10, 'Timestamp'], [12, 'List'], [13, 'Struct']] as const) {
      const c = arrowCell(other(id, name), 0, 500);
      expect(c.kind).toBe('unsupported');
      if (c.kind === 'unsupported') expect(c.type).toBe(name);
    }
  });

  it('a sliced vector (offset ≠ 0) is not interpreted', () => {
    const d = { ...utf8(['a', 'b']), offset: 1 };
    expect(arrowCell(d, 0, 500).kind).toBe('unsupported');
  });

  it('decimalText handles sign, padding and the 128-bit extremes', () => {
    const w = (v: bigint) => {
      let u = BigInt.asUintN(128, v);
      return Array.from({ length: 4 }, () => {
        const x = Number(u & 0xffffffffn);
        u >>= 32n;
        return x;
      });
    };
    expect(decimalText(w(170141183460469231731687303715884105727n), 0)).toBe('170141183460469231731687303715884105727');
    expect(decimalText(w(-170141183460469231731687303715884105728n), 0)).toBe('-170141183460469231731687303715884105728');
    expect(decimalText(w(15000000000n), 10)).toBe('1.5000000000');
    expect(decimalText(w(-5n), 4)).toBe('-0.0005');
  });

  it('cutText counts code points', () => {
    expect(cutText('ab', 2)).toEqual({ kind: 'text', text: 'ab', truncated: false });
    expect(cutText('a🌍b', 2)).toEqual({ kind: 'text', text: 'a🌍', truncated: true });
  });

  it('Codex M06: a leading U+FEFF is part of the value and is kept', () => {
    const d = utf8(['\uFEFFA', '\uFEFF']);
    expect(arrowCell(d, 0, 500)).toEqual({ kind: 'text', text: '\uFEFFA', truncated: false });
    expect(arrowCell(d, 1, 500)).toEqual({ kind: 'text', text: '\uFEFF', truncated: false });
  });

  it('Codex M06: missing or inconsistent UTF-8 buffers are never shown as an empty string', () => {
    const d = utf8(['abc']);
    expect(arrowCell({ ...d, values: undefined }, 0, 500).kind).toBe('unsupported');
    expect(arrowCell({ ...d, valueOffsets: new Int32Array([0, 99]) }, 0, 500).kind).toBe('unsupported');
  });

  it('Codex M06: a dictionary key is resolved across every dictionary chunk; a missing value is not shown', () => {
    const keys = { type: { typeId: -1, toString: () => 'Dictionary<Uint8, Utf8>' }, length: 2, offset: 0, values: new Uint8Array([0, 1]), children: [], getValid: () => true };
    const chunks = (data: ArrowData[]) => ({ ...keys, dictionary: { data } }) as ArrowData;
    const split = chunks([utf8([]), utf8(['red']), utf8(['blue'])]);
    expect(arrowCell(split, 0, 500)).toEqual({ kind: 'text', text: 'red', truncated: false });
    expect(arrowCell(split, 1, 500)).toEqual({ kind: 'text', text: 'blue', truncated: false });
    expect(arrowCell(chunks([utf8([])]), 0, 500).kind).toBe('unsupported');
    expect(arrowCell(chunks([{ ...utf8(['red']), values: undefined }]), 0, 500).kind).toBe('unsupported');
  });

  it('Codex M06: booleans respect the cell limit', () => {
    expect(arrowCell(bools([false]), 0, 1)).toEqual({ kind: 'text', text: 'f', truncated: true });
  });
});
