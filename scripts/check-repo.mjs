#!/usr/bin/env node
// Repository hygiene gate (AGENTS.md §13; docs/TESTING_STRATEGY.md §5.10): scans every tracked
// and untracked-but-not-ignored file for (1) files that must never be committed, (2) files over
// the size limit, and (3) common credential formats. A deliberately small, dependency-free check
// of known token shapes; it is not a complete secret scanner and does not replace reviewing the
// staged diff before every commit.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_FILE_BYTES = 1_000_000;

/** File names that must never be committed. */
export const FORBIDDEN_NAMES = [/(^|\/)\.env(\.|$)/, /\.(pem|key|p12|pfx)$/i, /(^|\/)id_(rsa|ed25519|ecdsa)$/, /\.(duckdb|sqlite3?|db)$/i];

/** Credential shapes (name, pattern). Patterns require realistic lengths to limit false positives. */
export const SECRET_PATTERNS = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI-style API key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
];

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|wasm|parquet|zip|gz)$/i;

/**
 * @param {string} rootDir
 * @param {string[]} [files] repository-relative paths; defaults to git's tracked + unignored files
 * @returns {string[]}
 */
export function checkRepo(rootDir, files) {
  const root = resolve(rootDir);
  const list = files ?? execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  /** @type {string[]} */
  const errors = [];
  for (const rel of list) {
    let size;
    try {
      size = statSync(join(root, rel)).size;
    } catch {
      continue; // deleted in the working tree
    }
    if (FORBIDDEN_NAMES.some((re) => re.test(rel))) errors.push(`${rel}: this kind of file must never be committed`);
    if (size > MAX_FILE_BYTES) errors.push(`${rel}: ${size} bytes exceeds the ${MAX_FILE_BYTES}-byte limit`);
    if (BINARY.test(rel) || size > 5 * MAX_FILE_BYTES) continue;
    const text = readFileSync(join(root, rel), 'utf8');
    for (const [name, re] of SECRET_PATTERNS) {
      if (/** @type {RegExp} */ (re).test(text)) errors.push(`${rel}: looks like it contains a ${name}`);
    }
  }
  return errors;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const errors = checkRepo('.');
  if (errors.length) {
    console.error(`check-repo: ${errors.length} problem(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('check-repo: OK (no forbidden files, oversized files or known credential formats)');
}
