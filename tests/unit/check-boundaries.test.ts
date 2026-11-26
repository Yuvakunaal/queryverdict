import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBoundaries } from '../../scripts/check-boundaries.mjs';

const dirs: string[] = [];
function tree(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'qv-bounds-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('check-boundaries (resolved import graph, Codex 7.5)', () => {
  it('passes the real repository', () => {
    expect(checkBoundaries('.')).toEqual([]);
  });

  it('accepts core modules that only import other core modules', () => {
    expect(checkBoundaries(tree({ 'src/core/a.ts': "export * from './b';\n", 'src/core/b.ts': 'export const b = 1;\n' }))).toEqual([]);
  });

  it('catches React reached through a neutral core re-export', () => {
    const errors = checkBoundaries(tree({ 'src/core/a.ts': "export { x } from './neutral';\n", 'src/core/neutral.ts': "export { useState as x } from 'react';\n" }));
    expect(errors).toContain('src/core/a.ts → src/core/neutral.ts: reaches package "react", not allowed in src/core (B2)');
  });

  it('catches a literal dynamic import of React and leaving src/core', () => {
    expect(checkBoundaries(tree({ 'src/core/a.ts': "export const m = () => import('react');\n" }))).toContain('src/core/a.ts: reaches package "react", not allowed in src/core (B2)');
    expect(checkBoundaries(tree({ 'src/core/a.ts': "export * from '../stores/s';\n", 'src/stores/s.ts': 'export const s = 1;\n' }))).toContain('src/core/a.ts → src/stores/s.ts: leaves src/core (B2)');
  });

  it('catches production code reaching the harness, statically or dynamically, and unresolved imports', () => {
    const t = tree({ 'src/app/a.ts': "export const h = () => import('../../harness/main');\n", 'harness/main.ts': 'export {};\n' });
    expect(checkBoundaries(t)).toContain('src/app/a.ts: imports harness/main.ts, outside src/ (B1)');
    expect(checkBoundaries(tree({ 'src/app/a.ts': "export * from './missing';\n" }))).toContain('src/app/a.ts: cannot resolve import "./missing"');
  });
});
