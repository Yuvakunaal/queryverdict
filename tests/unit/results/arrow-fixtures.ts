// Structural Arrow fixtures for unit tests (the shapes src/core/results/arrow.ts reads).
import type { ArrowBatch, ArrowData, ArrowType } from '../../../src/core/results/arrow';

const type = (typeId: number, name: string, extra: Partial<ArrowType> = {}): ArrowType => ({ typeId, ...extra, toString: () => name });
const enc = new TextEncoder();

export function utf8(values: readonly (string | null)[]): ArrowData {
  const parts = values.map((v) => enc.encode(v ?? ''));
  const offsets = new Int32Array(values.length + 1);
  let o = 0;
  parts.forEach((p, i) => {
    offsets[i] = o;
    o += p.length;
  });
  offsets[values.length] = o;
  const bytes = new Uint8Array(o);
  let k = 0;
  for (const p of parts) {
    bytes.set(p, k);
    k += p.length;
  }
  return { type: type(5, 'Utf8'), length: values.length, offset: 0, values: bytes, valueOffsets: offsets, children: [], getValid: (i) => values[i] !== null };
}

export function ints(values: readonly (bigint | null)[], name = 'Int64'): ArrowData {
  const arr = new BigInt64Array(values.map((v) => v ?? 0n));
  return { type: type(2, name, { bitWidth: 64 }), length: values.length, offset: 0, values: arr, children: [], getValid: (i) => values[i] !== null };
}

export function bools(values: readonly (boolean | null)[]): ArrowData {
  const bits = new Uint8Array(Math.ceil(values.length / 8));
  values.forEach((v, i) => {
    if (v) bits[i >> 3]! |= 1 << (i & 7);
  });
  return { type: type(6, 'Bool'), length: values.length, offset: 0, values: bits, children: [], getValid: (i) => values[i] !== null };
}

/** 128-bit decimals from bigint unscaled values. */
export function decimals(values: readonly bigint[], precision: number, scale: number): ArrowData {
  const words = new Uint32Array(values.length * 4);
  values.forEach((v, i) => {
    let u = BigInt.asUintN(128, v);
    for (let w = 0; w < 4; w++) {
      words[i * 4 + w] = Number(u & 0xffffffffn);
      u >>= 32n;
    }
  });
  return { type: type(7, `Decimal[${precision}e${scale}]`, { precision, scale, bitWidth: 128 }), length: values.length, offset: 0, values: words, children: [], getValid: () => true };
}

export function other(typeId: number, name: string, length = 1): ArrowData {
  return { type: type(typeId, name), length, offset: 0, values: new Float64Array(length), children: [], getValid: () => true };
}

export function batch(columns: readonly (readonly [string, ArrowData])[]): ArrowBatch {
  return {
    numRows: columns[0]?.[1].length ?? 0,
    schema: { fields: columns.map(([name, d]) => ({ name, type: d.type })) },
    data: { children: columns.map(([, d]) => d) },
  };
}
