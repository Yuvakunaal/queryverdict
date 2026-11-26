#!/usr/bin/env node
// Resolved dependency-boundary check (docs/ARCHITECTURE.md §3–§4). ESLint rules see one file at
// a time; this follows the actual import graph, including `export … from` re-exports and
// string-literal dynamic `import()` (non-literal dynamic imports are rejected by ESLint).
//
// Rules:
//  B1  Every relative import in src/ resolves to an existing file inside src/ (so production
//      code can never reach harness/, tests/, scripts/ or spikes/).
//  B2  Everything reachable from a src/core module stays inside src/core, and the only
//      packages it may reach are listed in CORE_ALLOWED_PACKAGES.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Packages src/core may depend on: only the engine (M02, P-016). */
export const CORE_ALLOWED_PACKAGES = /** @type {string[]} */ (['@duckdb/duckdb-wasm']);

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.css'];

/**
 * @param {string} dir
 * @returns {string[]}
 */
function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|mts)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * @param {string} fromFile
 * @param {string} spec relative specifier
 * @returns {string | null} resolved absolute path
 */
function resolveRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...['/index.ts', '/index.tsx'].map((e) => base + e)];
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** @param {string} spec */
const packageName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0] ?? spec);

/**
 * @param {string} file
 * @returns {string[]} module specifiers (imports, re-exports, literal dynamic imports, requires)
 */
function specifiers(file) {
  const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
  return info.importedFiles.map((f) => f.fileName);
}

/**
 * @param {string} rootDir project root containing src/
 * @returns {string[]} violations
 */
export function checkBoundaries(rootDir) {
  const root = resolve(rootDir);
  const src = join(root, 'src');
  const core = join(src, 'core');
  const rel = (/** @type {string} */ p) => relative(root, p).split(sep).join('/');
  const inside = (/** @type {string} */ p, /** @type {string} */ dir) => p === dir || p.startsWith(dir + sep);
  /** @type {string[]} */
  const errors = [];

  /** @type {Map<string, { local: string[], packages: string[] }>} */
  const graph = new Map();
  /** @param {string} file */
  const edges = (file) => {
    const cached = graph.get(file);
    if (cached) return cached;
    /** @type {{ local: string[], packages: string[] }} */
    const e = { local: [], packages: [] };
    graph.set(file, e);
    if (!/\.(ts|tsx|mts|js|mjs)$/.test(file)) return e; // stylesheets have no imports we follow
    for (const spec of specifiers(file)) {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = resolveRelative(file, spec);
        if (!target) errors.push(`${rel(file)}: cannot resolve import "${spec}"`);
        else e.local.push(target);
      } else {
        e.packages.push(packageName(spec));
      }
    }
    return e;
  };

  // B1
  for (const file of sourceFiles(src)) {
    for (const target of edges(file).local) {
      if (!inside(target, src)) errors.push(`${rel(file)}: imports ${rel(target)}, outside src/ (B1)`);
    }
  }

  // B2: transitive closure from every core module
  for (const start of sourceFiles(core)) {
    const seen = new Set([start]);
    /** @type {{ file: string, via: string[] }[]} */
    const stack = [{ file: start, via: [rel(start)] }];
    while (stack.length) {
      const { file, via } = /** @type {{ file: string, via: string[] }} */ (stack.pop());
      const e = edges(file);
      for (const pkg of e.packages) {
        if (!CORE_ALLOWED_PACKAGES.includes(pkg)) errors.push(`${via.join(' → ')}: reaches package "${pkg}", not allowed in src/core (B2)`);
      }
      for (const target of e.local) {
        if (!inside(target, core)) {
          errors.push(`${[...via, rel(target)].join(' → ')}: leaves src/core (B2)`);
          continue;
        }
        if (!seen.has(target)) {
          seen.add(target);
          stack.push({ file: target, via: [...via, rel(target)] });
        }
      }
    }
  }
  return [...new Set(errors)];
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const errors = checkBoundaries('.');
  if (errors.length) {
    console.error(`check-boundaries: ${errors.length} violation(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('check-boundaries: OK');
}
