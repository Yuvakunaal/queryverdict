#!/usr/bin/env node
// Third-party licence inventory (scaffold; completed in M15, docs/TESTING_STRATEGY.md §5.10).
// The production closure comes from package-lock.json: every installed location
// (node_modules/…, including nested node_modules/a/node_modules/b) that is not marked dev-only.
// Each location is checked separately, so two versions of one package are two entries.
// For each: the installed package.json must exist and match the lockfile version, the declared
// licence must be allowlisted (and agree with the lockfile), and a licence file must be present.
// Writes build/notices.json.
//
// Known, reviewed problems can be listed in scripts/notices-exceptions.json with a resolution
// plan. They are reported but do not fail an ordinary run; `--release` fails on any exception,
// because an unresolved obligation blocks distribution. Unknown problems and stale exceptions
// always fail. Vendored binaries outside node_modules (DuckDB extensions, scripts/extensions.lock.json)
// are listed as unresolved until their notices are collected (M15). A declared licence is not a
// substitute for reading the licence text in the release review.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const EXCEPTIONS_PATH = fileURLToPath(new URL('./notices-exceptions.json', import.meta.url));
const EXTENSION_LOCK_PATH = fileURLToPath(new URL('./extensions.lock.json', import.meta.url));
import { fileURLToPath } from 'node:url';

/** Provisional allowlist; to be finalised with the project licence (M15). */
export const ALLOWED_LICENCES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'];

/**
 * @param {string} p
 * @returns {any}
 */
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** @param {string} location e.g. node_modules/a/node_modules/@scope/b */
function nameFromLocation(location) {
  const parts = location.split('node_modules/');
  return (parts[parts.length - 1] ?? location).replace(/\/$/, '');
}

/**
 * @param {string} rootDir project root containing package-lock.json and node_modules
 * @returns {{ packages: { location: string, name: string, version: string, licence: string | null, files: string[] }[], errors: string[] }}
 */
export function inventory(rootDir) {
  const root = resolve(rootDir);
  /** @type {string[]} */
  const errors = [];
  const lockPath = join(root, 'package-lock.json');
  if (!existsSync(lockPath)) return { packages: [], errors: ['package-lock.json not found'] };
  const lock = readJson(lockPath);
  const entries = Object.entries(lock.packages ?? {}).filter(([loc, meta]) => loc.startsWith('node_modules/') && !meta.dev && !meta.devOptional && !meta.link);
  /** @type {{ location: string, name: string, version: string, licence: string | null, files: string[] }[]} */
  const packages = [];
  for (const [location, meta] of entries) {
    const name = nameFromLocation(location);
    const dir = join(root, location);
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) {
      if (!meta.optional) errors.push(`${location}: not installed`);
      continue;
    }
    const pkg = readJson(pkgPath);
    // npm's deprecated `licenses` array is still used by some packages (for example json-bignum).
    const legacy = Array.isArray(pkg.licenses) ? pkg.licenses.map((/** @type {{ type?: string }} */ l) => l?.type).filter(Boolean) : [];
    const licence = typeof pkg.license === 'string' ? pkg.license : legacy.length === 1 ? String(legacy[0]) : null;
    const files = readdirSync(dir).filter((f) => /^(licen[cs]e|notice|copying)/i.test(f));
    packages.push({ location, name, version: pkg.version, licence, files });
    const id = `${location} (${name}@${pkg.version})`;
    if (meta.version && meta.version !== pkg.version) errors.push(`${id}: installed version differs from the lockfile (${meta.version})`);
    if (!licence) errors.push(`${id}: no declared licence`);
    else if (!ALLOWED_LICENCES.includes(licence)) errors.push(`${id}: licence ${licence} is not allowlisted`);
    if (licence && meta.license && meta.license !== licence) errors.push(`${id}: licence ${licence} differs from the lockfile (${meta.license})`);
    if (files.length === 0) errors.push(`${id}: no licence file in the package`);
  }
  packages.sort((a, b) => a.location.localeCompare(b.location));
  return { packages, errors };
}

/**
 * Splits problems into tracked (reviewed exceptions) and untracked, and reports stale exceptions.
 * @param {string[]} errors
 * @param {Record<string, { problem: string, resolution: string, releaseBlocking: boolean }>} exceptions
 */
export function applyExceptions(errors, exceptions) {
  const tracked = [];
  const untracked = [];
  const used = new Set();
  for (const e of errors) {
    const key = Object.keys(exceptions).find((k) => e.startsWith(`${k} (`) && e.endsWith(`: ${exceptions[k]?.problem}`));
    if (key) {
      tracked.push({ error: e, ...exceptions[key] });
      used.add(key);
    } else untracked.push(e);
  }
  const stale = Object.keys(exceptions).filter((k) => !used.has(k)).map((k) => `${k}: exception no longer matches any problem (remove it)`);
  return { tracked, untracked, stale };
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const release = process.argv.includes('--release');
  const { packages, errors } = inventory('.');
  const exceptions = existsSync(EXCEPTIONS_PATH) ? JSON.parse(readFileSync(EXCEPTIONS_PATH, 'utf8')) : {};
  const { tracked, untracked, stale } = applyExceptions(errors, exceptions);
  const vendored = existsSync(EXTENSION_LOCK_PATH)
    ? Object.keys(JSON.parse(readFileSync(EXTENSION_LOCK_PATH, 'utf8'))).map((p) => ({ path: `duckdb-ext/${p}`, status: 'notices unresolved (DuckDB core third-party components; FEASIBILITY §10.12)', releaseBlocking: true }))
    : [];
  const out = resolve('build/notices.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ generatedFrom: 'package-lock.json production locations', packages, tracked, untracked, stale, vendored }, null, 2) + '\n');
  for (const p of packages) console.log(`  ${p.location}  ${p.name}@${p.version}  ${p.licence}  [${p.files.join(', ') || 'no licence file'}]`);
  for (const t of tracked) console.warn(`  tracked (release-blocking): ${t.error}; resolution: ${t.resolution}`);
  for (const v of vendored) console.warn(`  vendored binary (release-blocking): ${v.path}: ${v.status}`);
  const failures = [...untracked, ...stale, ...(release ? [...tracked.map((t) => `unresolved: ${t.error}`), ...vendored.map((v) => `unresolved: ${v.path}`)] : [])];
  if (failures.length) {
    console.error(`notices: ${failures.length} problem(s)${release ? ' (release mode)' : ''}`);
    for (const e of failures) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`notices: ${packages.length} runtime package location(s) inventoried; ${tracked.length + vendored.length} release-blocking item(s) tracked (build/notices.json)`);
}
