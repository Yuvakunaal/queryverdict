// Reading cells of a streamed Arrow result as exact text, without converting what is not shown
// (M06; ARCHITECTURE §11.1; P-020). Structurally typed so src/core does not depend on the Arrow
// library: the type ids below are the Arrow format's own (Schema.fbs `Type`, dictionary = -1).
//
// Two kinds of result reach this code:
//  - Query results of a SELECT, which the engine has already turned into DuckDB's own text
//    (CAST … AS VARCHAR, cut by left()): only Utf8 and Null columns.
//  - Results of other statements (EXPLAIN, PRAGMA, RETURNING …), streamed as the engine returns
//    them. Only types whose Arrow form identifies the DuckDB value exactly are shown; for the
//    rest the cell says so (DuckDB-WASM sends HUGEINT and UHUGEINT both as Decimal(38,0), BLOB,
//    BIT and VARINT all as Binary, TIME and TIMETZ both as Time64, and floats need DuckDB's own
//    rendering). See FEASIBILITY §16 for the probe behind this list.
import type { CellText } from './types';

export const ArrowTypeId = {
  Dictionary: -1,
  Null: 1,
  Int: 2,
  Float: 3,
  Binary: 4,
  Utf8: 5,
  Bool: 6,
  Decimal: 7,
  Date: 8,
  Time: 9,
  Timestamp: 10,
  Interval: 11,
  List: 12,
  Struct: 13,
  Union: 14,
  FixedSizeBinary: 15,
  FixedSizeList: 16,
  Map: 17,
  Duration: 18,
  LargeBinary: 19,
  LargeUtf8: 20,
} as const;

export interface ArrowType {
  readonly typeId: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly bitWidth?: number;
  /** Dictionary: the type of the dictionary values. */
  readonly dictionary?: ArrowType;
  toString(): string;
}

export interface ArrowField {
  readonly name: string;
  readonly type: ArrowType;
}

export interface ArrowData {
  readonly type: ArrowType;
  readonly length: number;
  readonly offset: number;
  /** The value buffer (a typed array whose element type depends on the Arrow type). */
  readonly values?: unknown;
  readonly valueOffsets?: ArrayLike<number | bigint>;
  readonly children: readonly ArrowData[];
  readonly dictionary?: { readonly data: readonly ArrowData[] };
  getValid(index: number): boolean;
}

export interface ArrowBatch {
  readonly numRows: number;
  readonly schema: { readonly fields: readonly ArrowField[] };
  readonly data: { readonly children: readonly ArrowData[] };
}

// ignoreBOM: keep a leading U+FEFF; it is part of the value (the WHATWG default drops it).
const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/** The full text of one UTF-8 cell, or null if its buffers are missing (for engine-internal reads). */
export function utf8Text(data: ArrowData, index: number): string | null {
  const offs = data.valueOffsets;
  const bytes = data.values as Uint8Array | undefined;
  if (!offs || !(bytes instanceof Uint8Array) || index + 1 >= offs.length) return null;
  return decoder.decode(bytes.subarray(Number(offs[index]), Number(offs[index + 1])));
}

/** Cuts text to `cellChars` code points (never splitting a character); reports whether it cut. */
export function cutText(text: string, cellChars: number): CellText {
  // Fast path: UTF-16 length bounds the code-point count from above.
  if (text.length <= cellChars) return { kind: 'text', text, truncated: false };
  const chars = Array.from(text);
  if (chars.length <= cellChars) return { kind: 'text', text, truncated: false };
  return { kind: 'text', text: chars.slice(0, cellChars).join(''), truncated: true };
}

/**
 * A UTF-8 cell, decoding at most enough bytes for `cellChars + 1` code points (4 bytes each), so a
 * very long value is never decoded in full.
 */
function utf8Cell(data: ArrowData, index: number, cellChars: number): CellText {
  const offs = data.valueOffsets;
  const bytes = data.values as Uint8Array | undefined;
  // Missing or inconsistent buffers are never shown as an empty string.
  if (!offs || !(bytes instanceof Uint8Array) || index < 0 || index + 1 >= offs.length) return unsupported(data.type, MISSING);
  const start = Number(offs[index]);
  const end = Number(offs[index + 1]);
  if (!(start >= 0 && end >= start && end <= bytes.length)) return unsupported(data.type, MISSING);
  const take = Math.min(end - start, (cellChars + 1) * 4);
  const text = decoder.decode(bytes.subarray(start, start + take));
  const cell = cutText(text, cellChars);
  // Bytes left undecoded mean the value is longer than what was decoded, hence cut.
  return take < end - start && cell.kind === 'text' && !cell.truncated ? { kind: 'text', text: Array.from(text).slice(0, cellChars).join(''), truncated: true } : cell;
}

/** Arrow 32-bit words of a two's-complement decimal (least significant first) as exact text. */
export function decimalText(words: ArrayLike<number>, scale: number): string {
  let v = 0n;
  for (let i = words.length - 1; i >= 0; i--) v = (v << 32n) | BigInt((words[i] ?? 0) >>> 0);
  const bits = BigInt(words.length * 32);
  if (v >> (bits - 1n)) v -= 1n << bits;
  const neg = v < 0n;
  let digits = (neg ? -v : v).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  return neg ? `-${digits}` : digits;
}

function unsupported(type: ArrowType, why: string): CellText {
  return { kind: 'unsupported', type: String(type), reason: why };
}
const MISSING = 'This value did not arrive complete, so it is not shown. Run the statement again, or as a SELECT.';
const NOT_EXACT = 'This statement returned a value whose exact DuckDB text cannot be recovered from the transferred data. Run it as a SELECT (for example SELECT * FROM (...)) to see exact values.';

/**
 * The exact text of one cell of `data` (or an explicit "not shown"), at most `cellChars` code
 * points. Data with a non-zero offset (a sliced vector) is not interpreted.
 */
export function arrowCell(data: ArrowData, index: number, cellChars: number): CellText {
  if (data.offset !== 0) return unsupported(data.type, 'The result arrived in a layout this version does not read.');
  if (!data.getValid(index)) return { kind: 'null' };
  const t = data.type;
  switch (t.typeId) {
    case ArrowTypeId.Null:
      return { kind: 'null' };
    case ArrowTypeId.Utf8:
    case ArrowTypeId.LargeUtf8:
      return utf8Cell(data, index, cellChars);
    case ArrowTypeId.Bool: {
      const bits = data.values as ArrayLike<number>;
      return cutText(((bits[index >> 3] ?? 0) >> (index & 7)) & 1 ? 'true' : 'false', cellChars);
    }
    case ArrowTypeId.Int: {
      const v = (data.values as ArrayLike<number | bigint>)[index];
      return cutText(String(v), cellChars);
    }
    case ArrowTypeId.Decimal: {
      const width = (t.bitWidth ?? 128) / 32;
      // Decimal(38,0) is also how HUGEINT and UHUGEINT arrive: the sign cannot be told apart.
      if (t.precision === 38 && (t.scale ?? 0) === 0) return unsupported(t, NOT_EXACT);
      const words = data.values as ArrayLike<number>;
      const slice = Array.from({ length: width }, (_, k) => Number(words[index * width + k] ?? 0));
      return cutText(decimalText(slice, t.scale ?? 0), cellChars);
    }
    case ArrowTypeId.Dictionary: {
      // A streamed dictionary can arrive in several chunks (the first possibly empty): the key
      // indexes their concatenation. A key outside every chunk is not shown.
      const chunks = data.dictionary?.data ?? [];
      let key = Number((data.values as ArrayLike<number | bigint>)[index]);
      if (!Number.isSafeInteger(key) || key < 0) return unsupported(t, MISSING);
      for (const chunk of chunks) {
        if (key < chunk.length) {
          if (chunk.type.typeId !== ArrowTypeId.Utf8 && chunk.type.typeId !== ArrowTypeId.LargeUtf8) return unsupported(t, NOT_EXACT);
          if (chunk.offset !== 0) return unsupported(t, MISSING);
          return chunk.getValid(key) ? utf8Cell(chunk, key, cellChars) : { kind: 'null' };
        }
        key -= chunk.length;
      }
      return unsupported(t, MISSING);
    }
    default:
      return unsupported(t, NOT_EXACT);
  }
}
