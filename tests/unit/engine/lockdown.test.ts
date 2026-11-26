import { describe, expect, it } from 'vitest';
import { escalationProbes, lockdownStatements, REQUIRED_LOADED_EXTENSIONS, requiredSettings, sqlString, verifyLockdown } from '../../../src/core/engine/lockdown';
import type { Rows } from '../../../src/core/engine/types';
import { REPO } from './fake-driver';

function engine(overrides: { settings?: Record<string, string | null>; extensions?: string[]; lockRejects?: boolean } = {}) {
  const settings = { ...requiredSettings(REPO), ...overrides.settings };
  return async (sql: string): Promise<Rows> => {
    if (sql.includes('duckdb_settings()')) return Object.entries(settings).filter(([, v]) => v !== null).map(([k, v]) => [k, v]);
    if (sql.includes('duckdb_extensions()')) return (overrides.extensions ?? [...REQUIRED_LOADED_EXTENSIONS]).map((e) => [e]);
    if (sql === 'SET autoload_known_extensions = true') {
      if (overrides.lockRejects === false) return [];
      throw new Error('locked');
    }
    return [];
  };
}

describe('lockdown verification (fail closed)', () => {
  it('passes only when every effective control holds', async () => {
    expect((await verifyLockdown(engine(), REPO)).ok).toBe(true);
  });

  it.each([
    ['external access left on', { settings: { enable_external_access: 'true' } }, 'enable_external_access'],
    ['a setting missing from the engine', { settings: { lock_configuration: null } }, 'lock_configuration'],
    ['a different extension repository', { settings: { custom_extension_repository: 'https://extensions.duckdb.org' } }, 'custom_extension_repository'],
    ['an extra loaded extension', { extensions: ['core_functions', 'httpfs', 'json', 'parquet'] }, 'loaded extensions'],
    ['json not loaded (required by Verdict)', { extensions: ['core_functions', 'parquet'] }, 'loaded extensions'],
    ['a lock that accepts changes', { lockRejects: false }, 'lock_configuration did not reject'],
  ])('fails when %s', async (_n, o, needle) => {
    const v = await verifyLockdown(engine(o as never), REPO);
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toContain(needle);
  });

  it('locks the configuration last, after loading the required extensions from the given repository', () => {
    const s = lockdownStatements(REPO);
    expect(s.at(-1)).toBe('SET lock_configuration = true');
    expect(s.indexOf('LOAD json')).toBeLessThan(s.indexOf('SET enable_external_access = false'));
    expect(s[0]).toBe(`SET custom_extension_repository = ${sqlString(REPO)}`);
  });

  it('escalation probes target only the given origin', () => {
    const probes = escalationProbes('http://127.0.0.1:9');
    expect(probes.length).toBeGreaterThan(15);
    for (const p of probes) expect(p.sql).not.toMatch(/extensions\.duckdb\.org|https?:\/\/(?!127\.0\.0\.1:9)/);
  });

  it('quotes SQL string literals safely', () => {
    expect(sqlString("it's")).toBe("'it''s'");
  });
});
