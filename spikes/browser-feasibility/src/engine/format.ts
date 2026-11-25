// Converts Arrow cells into bounded display strings.
//
// Budgets are applied BEFORE expensive conversion where Arrow allows it:
// - strings and binaries are measured from their offsets; only a bounded prefix is decoded;
// - lists/maps are measured from their offsets; only the first few items are formatted;
// - structs are formatted field by field against the same character budget.
// The Arrow batch itself has already been received from the engine worker by the time this
// code runs (see bounded.ts for what can and cannot be bounded).
import { DataType, type Data, type Field, type Type } from 'apache-arrow';

export type DisplayRow = string[];

export interface CellText {
  text: string;
  /** True when the cell was shortened to fit the per-cell budget. */
  shortened: boolean;
}

const MAX_NESTED_ITEMS = 20;
const decoder = new TextDecoder('utf-8', { fatal: false });

/** Arrow decimals arrive as little-endian 32-bit words (two's complement). */
export function decimalWordsToString(words: Uint32Array, scale: number): string {
  let v = 0n;
  for (let i = words.length - 1; i >= 0; i--) v = (v << 32n) | BigInt(words[i] ?? 0);
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

/** Formats a small scalar value already obtained from Arrow. */
export function formatValue(value: unknown, field: Field): string {
  if (value === null || value === undefined) return 'NULL';
  const type = field.type as DataType<Type>;
  if (DataType.isDecimal(type) && value instanceof Uint32Array) return decimalWordsToString(value, type.scale);
  if (typeof value === 'bigint') return value.toString();
  if ((DataType.isTimestamp(type) || DataType.isDate(type)) && typeof value === 'number') {
    return new Date(value).toISOString().replace('T', ' ').replace('.000Z', '').replace('Z', '');
  }
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  if (typeof value === 'object') return String(value);
  return String(value);
}

function clip(s: string, max: number): CellText {
  return s.length <= max ? { text: s, shortened: false } : { text: `${s.slice(0, Math.max(0, max - 1))}…`, shortened: true };
}

type AnyData = Data<DataType>;

function offsetsOf(data: AnyData, index: number): [number, number] | null {
  const o = data.valueOffsets as unknown as ArrayLike<number | bigint> | undefined;
  if (!o || index + 1 >= o.length) return null;
  return [Number(o[index]), Number(o[index + 1])];
}

const vectorCache = new WeakMap<object, { get(i: number): unknown }>();

function scalarAt(data: AnyData, index: number, makeVector: (d: AnyData) => { get(i: number): unknown }): unknown {
  let v = vectorCache.get(data);
  if (!v) {
    v = makeVector(data);
    vectorCache.set(data, v);
  }
  return v.get(index);
}

/**
 * Formats one cell of `data` at `index` using at most about `maxChars` characters of output.
 * `makeVector` is apache-arrow's makeVector (passed in to keep this module side-effect free).
 */
export function formatCell(
  data: AnyData,
  index: number,
  field: Field,
  maxChars: number,
  makeVector: (d: AnyData) => { get(i: number): unknown },
): CellText {
  if (!data.getValid(index)) return { text: 'NULL', shortened: false };
  const type = data.type as DataType<Type>;

  if (DataType.isUtf8(type) || DataType.isLargeUtf8(type)) {
    const span = offsetsOf(data, index);
    if (!span) return { text: '', shortened: false };
    const [start, end] = span;
    const byteLen = end - start;
    // Each UTF-16 code unit needs at least one UTF-8 byte, so maxChars*4 bytes is enough for maxChars chars.
    const take = Math.min(byteLen, maxChars * 4);
    const text = decoder.decode((data.values as Uint8Array).subarray(start, start + take));
    if (take < byteLen) return { text: `${text.slice(0, Math.max(0, maxChars - 1))}…`, shortened: true };
    return clip(text, maxChars);
  }
  if (DataType.isBinary(type) || DataType.isLargeBinary(type)) {
    const span = offsetsOf(data, index);
    return { text: `<${span ? span[1] - span[0] : 0} bytes>`, shortened: false };
  }
  if (DataType.isDictionary(type)) {
    const key = Number((data.values as ArrayLike<number | bigint>)[index]);
    const dict = data.dictionary?.data[0] as AnyData | undefined;
    if (!dict || key < 0) return { text: 'NULL', shortened: false };
    return formatCell(dict, key, field, maxChars, makeVector);
  }
  if (DataType.isList(type) || DataType.isMap(type) || DataType.isFixedSizeList(type)) {
    let start: number;
    let end: number;
    if (DataType.isFixedSizeList(type)) {
      start = index * type.listSize;
      end = start + type.listSize;
    } else {
      const span = offsetsOf(data, index);
      if (!span) return { text: '[]', shortened: false };
      [start, end] = span;
    }
    const child = data.children[0] as AnyData | undefined;
    const total = end - start;
    if (!child) return { text: `<list of ${total} items>`, shortened: false };
    const parts: string[] = [];
    let used = 2;
    let shortened = false;
    for (let i = start; i < end && parts.length < MAX_NESTED_ITEMS; i++) {
      const c = formatCell(child, i, field, Math.max(1, maxChars - used), makeVector);
      shortened ||= c.shortened;
      used += c.text.length + 2;
      parts.push(c.text);
      if (used >= maxChars) break;
    }
    const more = total - parts.length;
    const text = `[${parts.join(', ')}${more > 0 ? `, … ${more} more` : ''}]`;
    const r = clip(text, maxChars);
    return { text: r.text, shortened: r.shortened || shortened || more > 0 };
  }
  if (DataType.isStruct(type)) {
    const parts: string[] = [];
    let used = 2;
    let shortened = false;
    for (let f = 0; f < type.children.length; f++) {
      const childField = type.children[f]!;
      const child = data.children[f] as AnyData | undefined;
      if (!child) continue;
      const c = formatCell(child, index, childField, Math.max(1, maxChars - used - childField.name.length - 2), makeVector);
      shortened ||= c.shortened;
      parts.push(`${childField.name}: ${c.text}`);
      used += childField.name.length + c.text.length + 4;
      if (used >= maxChars) {
        shortened ||= f < type.children.length - 1;
        break;
      }
    }
    const r = clip(`{${parts.join(', ')}}`, maxChars);
    return { text: r.text, shortened: r.shortened || shortened };
  }
  // Fixed-width scalars (numbers, booleans, dates, decimals, intervals): small by construction.
  return clip(formatValue(scalarAt(data, index, makeVector), field), maxChars);
}
