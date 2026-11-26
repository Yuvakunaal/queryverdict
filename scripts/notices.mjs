#!/usr/bin/env node
// Third-party licence inventory (scaffold; completed in M15, docs/TESTING_STRATEGY.md §5.10).
// The production closure comes from package-lock.json: every installed location
// (node_modules/…, including nested node_modules/a/node_modules/b) that is not marked dev-only.
// Each location is checked separately, so two versions of one package are two entries.
// For each: the installed package.json must exist and match the lockfile version, the declared
// licence must be allowlisted (and agree with the lockfile), and a licence file must be present.
// Writes build/notices.json. Limitations: binaries vendored outside node_modules (DuckDB WASM,
// extensions; M02) are not covered yet, and a declared licence is not a substitute for reading
// the licence text in the release review.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
    const licence = typeof pkg.license === 'string' ? pkg.license : null;
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

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const { packages, errors } = inventory('.');
  const out = resolve('build/notices.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ generatedFrom: 'package-lock.json production locations', packages, errors }, null, 2) + '\n');
  for (const p of packages) console.log(`  ${p.location}  ${p.name}@${p.version}  ${p.licence}  [${p.files.join(', ') || 'no licence file'}]`);
  if (errors.length) {
    console.error(`notices: ${errors.length} problem(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`notices: ${packages.length} runtime package location(s) inventoried in build/notices.json`);
}
