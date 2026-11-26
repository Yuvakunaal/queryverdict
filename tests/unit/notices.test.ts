import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inventory } from '../../scripts/notices.mjs';

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
  it('lists the real runtime closure with allowlisted licences and licence files', () => {
    const { packages, errors } = inventory('.');
    expect(errors).toEqual([]);
    expect(packages.map((p) => p.name)).toEqual(['react', 'react-dom', 'scheduler']);
    for (const p of packages) expect(p.files.length).toBeGreaterThan(0);
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
