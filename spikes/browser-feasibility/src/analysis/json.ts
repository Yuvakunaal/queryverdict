// Lossless JSON for DuckDB's serialised SQL (fixes Codex H1).
//
// JSON.parse converts every number to a JavaScript double, so a BIGINT literal such as
// 9007199254740993 silently becomes 9007199254740992 and a rewritten diagnostic query changes
// meaning. This parser keeps every numeric token as its exact source text (LosslessNumber) and
// the serialiser writes that text back unchanged.

export class LosslessNumber {
  constructor(readonly text: string) {}
  toString(): string {
    return this.text;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export function parseLossless(src: string): Json {
  let i = 0;
  const err = (m: string): never => {
    throw new SyntaxError(`${m} at ${i}`);
  };
  const ws = () => {
    while (i < src.length && (src[i] === ' ' || src[i] === '\n' || src[i] === '\r' || src[i] === '\t')) i++;
  };
  const value = (): Json => {
    ws();
    const c = src[i];
    if (c === '{') {
      i++;
      const o: Record<string, Json> = {};
      ws();
      if (src[i] === '}') return i++, o;
      for (;;) {
        ws();
        if (src[i] !== '"') err('expected key');
        const k = str();
        ws();
        if (src[i++] !== ':') err('expected :');
        o[k] = value();
        ws();
        if (src[i] === ',') {
          i++;
          continue;
        }
        if (src[i] === '}') return i++, o;
        err('expected , or }');
      }
    }
    if (c === '[') {
      i++;
      const a: Json[] = [];
      ws();
      if (src[i] === ']') return i++, a;
      for (;;) {
        a.push(value());
        ws();
        if (src[i] === ',') {
          i++;
          continue;
        }
        if (src[i] === ']') return i++, a;
        err('expected , or ]');
      }
    }
    if (c === '"') return str();
    if (src.startsWith('true', i)) return (i += 4), true;
    if (src.startsWith('false', i)) return (i += 5), false;
    if (src.startsWith('null', i)) return (i += 4), null;
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 400));
    if (!m) err('unexpected token');
    i += m![0].length;
    return new LosslessNumber(m![0]);
  };
  const str = (): string => {
    // Find the closing quote, honouring escapes, and let JSON.parse decode the string itself.
    const start = i++;
    while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
    if (src[i] !== '"') err('unterminated string');
    i++;
    return JSON.parse(src.slice(start, i)) as string;
  };
  const v = value();
  ws();
  if (i !== src.length) err('trailing data');
  return v;
}

export function stringifyLossless(v: Json): string {
  if (v instanceof LosslessNumber) return v.text;
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) && Number.isInteger(v)) throw new Error(`Refusing to serialise unsafe integer ${v}`);
    return JSON.stringify(v);
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stringifyLossless).join(',')}]`;
  return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}:${stringifyLossless(x)}`).join(',')}}`;
}
