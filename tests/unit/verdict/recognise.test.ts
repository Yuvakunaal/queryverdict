// The strict recogniser against DuckDB v1.5.4's own parser output (recorded and re-verified in
// every browser by tests/e2e/verdict-parser.spec.ts).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloneLossless, isJsonObject, parseLossless, type JsonObject } from '../../../src/core/util/lossless-json';
import { parserQualified } from '../../../src/core/verdict/parser-adapter';
import { recognise } from '../../../src/core/verdict/recognise';

const cases = JSON.parse(readFileSync(path.resolve('tests/fixtures/verdict/parser-cases.json'), 'utf8')) as Record<'accept' | 'refuse' | 'failure', Record<string, string>>;
const recorded = JSON.parse(readFileSync(path.resolve('tests/fixtures/verdict/parser/v1.5.4.json'), 'utf8')) as { engine: string; outputs: Record<string, string> };
const doc = (name: string) => parseLossless(recorded.outputs[name] as string) as JsonObject;

describe('recogniser on recorded DuckDB v1.5.4 parser output', () => {
  it('has a recording for every corpus case', () => {
    for (const group of Object.values(cases)) for (const name of Object.keys(group)) expect(recorded.outputs[name], name).toBeTypeOf('string');
    expect(recorded.engine).toBe('v1.5.4');
  });

  it.each(Object.keys(cases.accept))('accepts %s', (name) => {
    const r = recognise(doc(name));
    expect(r.ok, JSON.stringify(r.ok ? null : r.unsupported)).toBe(true);
  });

  it.each(Object.keys(cases.refuse))('refuses %s with a named construct', (name) => {
    const d = doc(name);
    if (d.error === true) return; // the parser itself refused it (reported as unsupported or query failure by the service)
    const r = recognise(d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.unsupported.length).toBeGreaterThan(0);
      for (const u of r.unsupported) expect(u.construct.length).toBeGreaterThan(0);
    }
  });

  it('keeps the exact structure of accepted queries', () => {
    const ok = (name: string) => {
      const r = recognise(doc(name));
      if (!r.ok) throw new Error(name);
      return r.join;
    };
    expect(ok('left_alias')).toMatchObject({ type: 'LEFT', left: { name: 'orders', alias: 'o', ref: 'o' }, right: { name: 'customers', alias: 'c', ref: 'c' }, condition: { kind: 'on', pairs: [[{ parts: ['o', 'cid'] }, { parts: ['c', 'cid'] }]] } });
    expect(ok('quoted_identifiers')).toMatchObject({ left: { name: 'my tab', alias: 'x.y' }, right: { name: 'b"q' }, condition: { kind: 'on', pairs: [[{ parts: ['x.y', 'a"b'] }, { parts: ['b"q', 'k'] }]] } });
    expect(ok('using_composite').condition).toEqual({ kind: 'using', columns: ['k1', 'k2'] });
    const three = ok('three_key_and').condition;
    expect(three.kind === 'on' ? three.pairs.length : 0).toBe(3);
    expect(ok('self_join')).toMatchObject({ left: { name: 't', ref: 'a' }, right: { name: 't', ref: 'b' } });
  });

  it('refuses unknown fields and unexpected values anywhere instead of ignoring them (future parser output)', () => {
    const mutate = (edit: (d: JsonObject) => void) => {
      const d = cloneLossless(doc('inner_basic'));
      edit(d);
      return recognise(d).ok;
    };
    const node = (d: JsonObject) => ((d.statements as JsonObject[])[0] as JsonObject).node as JsonObject;
    const join = (d: JsonObject) => node(d).from_table as JsonObject;
    expect(mutate(() => undefined)).toBe(true);
    expect(mutate((d) => { node(d).new_field = null; })).toBe(false);
    expect(mutate((d) => { join(d).new_join_field = false; })).toBe(false);
    expect(mutate((d) => { (join(d).left as JsonObject).new_table_field = ''; })).toBe(false);
    expect(mutate((d) => { ((join(d).condition as JsonObject).left as JsonObject).collation = 'nocase'; })).toBe(false);
    expect(mutate((d) => { delete join(d).delim_flipped; })).toBe(false);
    expect(mutate((d) => { join(d).delim_flipped = true; })).toBe(false);
    expect(mutate((d) => { join(d).join_type = 'RIGHT'; })).toBe(false);
    expect(mutate((d) => { join(d).ref_type = 'NATURAL'; })).toBe(false);
    expect(mutate((d) => { (join(d).left as JsonObject).schema_name = 'main'; })).toBe(false);
    expect(mutate((d) => { (join(d).condition as JsonObject).type = 'COMPARE_NOTEQUAL'; })).toBe(false);
    expect(mutate((d) => { d.extra = true; })).toBe(false);
    expect(mutate((d) => { ((d.statements as JsonObject[])[0] as JsonObject).named_param_map = [null]; })).toBe(false);
    expect(mutate((d) => { node(d).aggregate_handling = 'FORCE_AGGREGATES'; })).toBe(false);
  });

  it('query_location values above 2^53 survive the lossless layer (they occur in real parser output)', () => {
    expect(recorded.outputs.multiple_statements).toContain('18446744073709551615');
    const d = doc('no_from');
    const from = ((d.statements as JsonObject[])[0] as JsonObject).node as JsonObject;
    expect(isJsonObject(from.from_table) && String(from.from_table.query_location)).toBe('18446744073709551615');
  });

  it('the parser failure cases are parser errors, not SELECTs', () => {
    for (const name of Object.keys(cases.failure)) expect(doc(name).error, name).toBe(true);
  });

  it('refuses unqualified engine versions', () => {
    expect(parserQualified('v1.5.4')).toBeNull();
    expect(parserQualified('v1.5.5')).toMatch(/not qualified/);
    expect(parserQualified(null)).toMatch(/not qualified/);
  });
});
