import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRepo, MAX_FILE_BYTES } from '../../scripts/check-repo.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'qv-repo-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return { dir, files: Object.keys(files) };
}
// Fake credentials are assembled at runtime so this source file never contains one.
const fake = (prefix: string, n: number, alphabet = 'A1b2C3d4E5') => prefix + alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);

describe('check-repo', () => {
  it('passes the real working tree', () => {
    expect(checkRepo('.')).toEqual([]);
  });

  it('accepts ordinary files', () => {
    const r = repo({ 'src/a.ts': 'export const a = 1;\n', 'docs/x.md': 'sk-short is fine' });
    expect(checkRepo(r.dir, r.files)).toEqual([]);
  });

  it('rejects forbidden file kinds and oversized files', () => {
    const r = repo({ '.env': 'X=1', 'certs/server.pem': 'x', 'data/local.duckdb': 'x', 'big.json': 'x'.repeat(MAX_FILE_BYTES + 1) });
    expect(checkRepo(r.dir, r.files)).toEqual([
      '.env: this kind of file must never be committed',
      'certs/server.pem: this kind of file must never be committed',
      'data/local.duckdb: this kind of file must never be committed',
      `big.json: ${MAX_FILE_BYTES + 1} bytes exceeds the ${MAX_FILE_BYTES}-byte limit`,
    ]);
  });

  it.each([
    ['GitHub token', () => fake('ghp' + '_', 36)],
    ['AWS access key id', () => fake('AKI' + 'A', 16, 'ABCDEFGH23')],
    ['Anthropic API key', () => fake('sk-' + 'ant-', 30)],
    ['private key block', () => '-----BEGIN ' + 'PRIVATE KEY-----'],
  ])('rejects a %s', (name, make) => {
    const r = repo({ 'src/config.ts': `export const k = "${make()}";\n` });
    expect(checkRepo(r.dir, r.files)).toContain(`src/config.ts: looks like it contains a ${name}`);
  });
});
