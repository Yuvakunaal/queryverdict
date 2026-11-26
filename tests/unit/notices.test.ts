import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyExceptions, inventory } from '../../scripts/notices.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(lock: Record<string, Record<string, unknown>>, installed: Record<string, { version: string; license?: string; files?: string[] }>) {
  const dir = mkdtempSync(join(tmpdir(), 'qv-notices-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}');
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...lock } }));
  for (const [loc, p] of Object.entries(installed)) {
    mkdirSync(join(dir, loc), { recursive: true });
    writeFileSync(join(dir, loc, 'package.json'), JSON.stringify({ name: loc.split('node_modules/').pop(), version: p.version, license: p.license }));
    for (const f of p.files ?? ['LICENSE']) writeFileSync(join(dir, loc, f), 'licence text');
  }
  return dir;
}

describe('notices inventory', () => {
  it('real closure: every problem is a reviewed, release-blocking exception (M02 engine)', () => {
    const { packages, errors } = inventory('.');
    const names = packages.map((p) => p.name);
    for (const n of ['react', 'react-dom', 'scheduler', '@duckdb/duckdb-wasm', 'apache-arrow', 'json-bignum']) expect(names).toContain(n);
    const exceptions = JSON.parse(readFileSync('scripts/notices-exceptions.json', 'utf8'));
    const { tracked, untracked, stale } = applyExceptions(errors, exceptions);
    expect([untracked, stale]).toEqual([[], []]);
    expect(tracked.map((t) => t.error)).toEqual(['node_modules/@duckdb/duckdb-wasm (@duckdb/duckdb-wasm@1.33.1-dev57.0): no licence file in the package']);
    expect(tracked.every((t) => t.releaseBlocking)).toBe(true);
  });

  it('reads the deprecated licenses array (json-bignum declares MIT that way)', () => {
    expect(inventory('.').packages.find((p) => p.name === 'json-bignum')?.licence).toBe('MIT');
  });

  it('exceptions match only their exact problem; unknown problems and stale exceptions are reported', () => {
    const ex = { 'node_modules/x': { problem: 'no licence file in the package', resolution: 'r', releaseBlocking: true }, 'node_modules/gone': { problem: 'p', resolution: 'r', releaseBlocking: true } };
    const r = applyExceptions(['node_modules/x (x@1): no licence file in the package', 'node_modules/x (x@1): licence GPL-3.0 is not allowlisted'], ex);
    expect(r.tracked.map((t) => t.error)).toEqual(['node_modules/x (x@1): no licence file in the package']);
    expect(r.untracked).toEqual(['node_modules/x (x@1): licence GPL-3.0 is not allowlisted']);
    expect(r.stale).toEqual(['node_modules/gone: exception no longer matches any problem (remove it)']);
  });

  it('checks every installed location, including a nested second version (Codex 7.5)', () => {
    const dir = project(
      {
        'node_modules/a': { version: '1.0.0', license: 'MIT' },
        'node_modules/b': { version: '1.0.0', license: 'MIT' },
        'node_modules/b/node_modules/a': { version: '0.9.0', license: 'UNLICENSED' },
        'node_modules/devtool': { version: '1.0.0', license: 'GPL-3.0', dev: true },
      },
      {
        'node_modules/a': { version: '1.0.0', license: 'MIT' },
        'node_modules/b': { version: '1.0.0', license: 'MIT' },
        'node_modules/b/node_modules/a': { version: '0.9.0', license: 'UNLICENSED' },
        'node_modules/devtool': { version: '1.0.0', license: 'GPL-3.0' },
      },
    );
    const { packages, errors } = inventory(dir);
    expect(packages.map((p) => p.location)).toEqual(['node_modules/a', 'node_modules/b', 'node_modules/b/node_modules/a']);
    expect(errors).toEqual(['node_modules/b/node_modules/a (a@0.9.0): licence UNLICENSED is not allowlisted']);
  });

  it('reports missing licence files, version drift and lockfile/package licence disagreement', () => {
    const dir = project(
      { 'node_modules/a': { version: '1.0.0', license: 'MIT' } },
      { 'node_modules/a': { version: '1.0.1', license: 'ISC', files: [] } },
    );
    expect(inventory(dir).errors).toEqual([
      'node_modules/a (a@1.0.1): installed version differs from the lockfile (1.0.0)',
      'node_modules/a (a@1.0.1): licence ISC differs from the lockfile (MIT)',
      'node_modules/a (a@1.0.1): no licence file in the package',
    ]);
  });
});
