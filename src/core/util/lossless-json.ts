// Lossless JSON for DuckDB's serialised SQL (QV-ENG-006; ported from the spike's json.ts, which
// fixed Codex H1, and hardened).
//
// JSON.parse turns every number into a JavaScript double, so 9007199254740993 silently becomes
// 9007199254740992. DuckDB's parser output contains such values (for example
// `query_location: 18446744073709551615` and BIGINT literals), so a diagnostic statement rebuilt
// from JSON.parse output could change meaning. Here every numeric token stays its exact source text
// (LosslessNumber) and is written back unchanged. Objects have no prototype and duplicate keys are
// rejected, so parser output cannot smuggle `__proto__` or shadowed fields past the recogniser.

export class LosslessNumber {
  constructor(readonly text: string) {
    if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) throw new SyntaxError(`not a JSON number: ${text}`);
  }
  toString(): string {
    return this.text;
  }
  /** The exact integer, or null when the token is not an integer literal. */
  toBigInt(): bigint | null {
    return /^-?(0|[1-9]\d*)$/.test(this.text) ? BigInt(this.text) : null;
  }
}

export type JsonValue = null | boolean | string | LosslessNumber | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

const MAX_DEPTH = 256;

export function parseLossless(src: string): JsonValue {
  let i = 0;
  const err = (m: string): never => {
    throw new SyntaxError(`${m} at offset ${i}`);
  };
  const ws = () => {
    while (i < src.length && (src[i] === ' ' || src[i] === '\n' || src[i] === '\r' || src[i] === '\t')) i++;
  };
  const str = (): string => {
    const start = i++;
    while (i < src.length && src[i] !== '"') {
      if (src.charCodeAt(i) < 0x20) err('control character in string');
      i += src[i] === '\\' ? 2 : 1;
    }
    if (src[i] !== '"') err('unterminated string');
    i++;
    // The string token is valid JSON on its own; JSON.parse decodes its escapes exactly.
    return JSON.parse(src.slice(start, i)) as string;
  };
  const value = (depth: number): JsonValue => {
    if (depth > MAX_DEPTH) err('nesting too deep');
    ws();
    const c = src[i];
    if (c === '{') {
      i++;
      const o = Object.create(null) as JsonObject;
      ws();
      if (src[i] === '}') {
        i++;
        return o;
      }
      for (;;) {
        ws();
        if (src[i] !== '"') err('expected a key');
        const k = str();
        if (Object.prototype.hasOwnProperty.call(o, k)) err(`duplicate key ${JSON.stringify(k)}`);
        ws();
        if (src[i++] !== ':') err('expected :');
        o[k] = value(depth + 1);
        ws();
        if (src[i] === ',') {
          i++;
          continue;
        }
        if (src[i] === '}') {
          i++;
          return o;
        }
        err('expected , or }');
      }
    }
    if (c === '[') {
      i++;
      const a: JsonValue[] = [];
      ws();
      if (src[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(value(depth + 1));
        ws();
        if (src[i] === ',') {
          i++;
          continue;
        }
        if (src[i] === ']') {
          i++;
          return a;
        }
        err('expected , or ]');
      }
    }
    if (c === '"') return str();
    if (src.startsWith('true', i)) return (i += 4), true;
    if (src.startsWith('false', i)) return (i += 5), false;
    if (src.startsWith('null', i)) return (i += 4), null;
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 512));
    if (!m) return err('unexpected token');
    i += m[0].length;
    return new LosslessNumber(m[0]);
  };
  const v = value(0);
  ws();
  if (i !== src.length) err('trailing data');
  return v;
}

/** Serialises a lossless value. Plain JavaScript numbers are refused: they may already be inexact. */
export function stringifyLossless(v: JsonValue): string {
  if (v instanceof LosslessNumber) return v.text;
  if (v === null) return 'null';
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stringifyLossless).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).map((k) => `${JSON.stringify(k)}:${stringifyLossless(v[k] as JsonValue)}`).join(',')}}`;
  throw new TypeError(`cannot serialise ${typeof v} losslessly`);
}

/** Deep copy (parser trees are edited only on copies). */
export function cloneLossless<T extends JsonValue>(v: T): T {
  return parseLossless(stringifyLossless(v)) as T;
}

export const isJsonObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof LosslessNumber);
