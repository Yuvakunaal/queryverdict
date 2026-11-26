import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, MAX_TIMER_MS, parseMemoryLimit, validateProfile, type ReleaseProfile } from '../../src/core/profile/profile';

const withPatch = (patch: (p: ReleaseProfile) => ReleaseProfile) => validateProfile(patch(DEFAULT_PROFILE));

describe('ReleaseProfile', () => {
  it('ships valid, finite defaults', () => {
    expect(validateProfile(DEFAULT_PROFILE)).toEqual([]);
  });

  it('uses the documented result bounds (P-020) and single-threaded engine', () => {
    expect(DEFAULT_PROFILE.results).toEqual({ maxRows: 1000, maxColumns: 200, maxCellChars: 500, maxDisplayChars: 2_000_000, maxArrowBytes: 16 * 1024 * 1024 });
    expect(DEFAULT_PROFILE.engine.threads).toBe(1);
  });

  it('is immutable at runtime', () => {
    expect(Object.isFrozen(DEFAULT_PROFILE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PROFILE.bounds)).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('rejects result bound %s', (v) => {
    expect(withPatch((p) => ({ ...p, results: { ...p.results, maxRows: v } }))).toContain(`results.maxRows must be a positive safe integer (got ${String(v)})`);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('rejects deadline %s', (v) => {
    expect(withPatch((p) => ({ ...p, bounds: { ...p.bounds, verdictMs: v } })).length).toBe(1);
  });

  it('rejects non-positive bigint budgets', () => {
    expect(withPatch((p) => ({ ...p, verdict: { ...p.verdict, executionPairRows: 0n } }))).toEqual(['verdict.executionPairRows must be a positive bigint (got 0)']);
  });

  it('rejects inconsistent import caps, empty formats, bad memory limits and threads', () => {
    expect(withPatch((p) => ({ ...p, imports: { ...p.imports, maxFileBytes: p.imports.maxCombinedBytes + 1 } }))).toContain('imports.maxFileBytes must not exceed imports.maxCombinedBytes');
    expect(withPatch((p) => ({ ...p, imports: { ...p.imports, formats: [] } }))).toContain('imports.formats must be a non-empty subset of csv, parquet');
    expect(withPatch((p) => ({ ...p, engine: { ...p.engine, memoryLimit: 'lots' } })).length).toBe(1);
    expect(withPatch((p) => ({ ...p, engine: { ...p.engine, threads: 4 as unknown as 1 } }))).toContain('engine.threads must be 1 (no cross-origin isolation on GitHub Pages)');
  });

  it('rejects missing required fields instead of skipping them (Codex 7.5)', () => {
    const { bootMs: _drop, ...bounds } = DEFAULT_PROFILE.bounds;
    expect(withPatch((p) => ({ ...p, bounds: bounds as ReleaseProfile['bounds'] }))).toEqual(['bounds.bootMs is missing']);
    expect(withPatch((p) => ({ ...p, engine: undefined as unknown as ReleaseProfile['engine'] }))).toEqual(['engine is missing']);
  });

  it('rejects deadlines beyond the setTimeout range (Codex 7.5)', () => {
    expect(withPatch((p) => ({ ...p, bounds: { ...p.bounds, recoveryMs: MAX_TIMER_MS + 1 } }))).toEqual([`bounds.recoveryMs must not exceed ${MAX_TIMER_MS} (got ${MAX_TIMER_MS + 1})`]);
    expect(withPatch((p) => ({ ...p, bounds: { ...p.bounds, recoveryMs: MAX_TIMER_MS } }))).toEqual([]);
  });

  it('rejects zero, malformed and over-ceiling memory limits (Codex 7.5)', () => {
    expect(withPatch((p) => ({ ...p, engine: { ...p.engine, memoryLimit: '0GB' } }))).toEqual(['engine.memoryLimit must be greater than zero (got 0GB)']);
    expect(withPatch((p) => ({ ...p, engine: { ...p.engine, memoryLimit: '4GiB' } }))).toEqual(['engine.memoryLimit must be below the 4 GiB WebAssembly ceiling (got 4GiB)']);
    expect(parseMemoryLimit('512 MiB')).toBe(512 * 1024 ** 2);
    expect(parseMemoryLimit('2GB')).toBe(2e9);
    expect(parseMemoryLimit('2 TB')).toBeNull();
  });
});

describe('typed errors', () => {
  it('carry explicit names and codes that survive minification', async () => {
    const { LeaseRevokedError, PolicyError, EngineError } = await import('../../src/core/util/errors');
    expect([new LeaseRevokedError().name, new LeaseRevokedError().code]).toEqual(['LeaseRevokedError', 'lease-revoked']);
    expect(new PolicyError('x').name).toBe('PolicyError');
    expect([new EngineError('bind', 'x').name, new EngineError('bind', 'x').phase]).toEqual(['EngineError', 'bind']);
  });
});
