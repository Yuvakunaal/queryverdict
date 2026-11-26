#!/usr/bin/env node
// Build-time vendoring of the DuckDB-WASM extensions the app needs (P-018): parquet and json
// (json is required by Verdict's json_serialize_sql). They are downloaded from the official
// repository at BUILD time only, verified against SHA-256 hashes committed in
// scripts/extensions.lock.json, and written to public/duckdb-ext/ (git-ignored) so the browser
// loads them from the app's own origin. At runtime the engine lockdown forbids any other source.
// Binaries are never committed; redistribution notices are tracked in scripts/notices.mjs.
//
// Usage: node scripts/vendor-extensions.mjs            verify (download if missing)
//        node scripts/vendor-extensions.mjs --update   download and rewrite the lock (review the diff)
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'scripts', 'extensions.lock.json');
const outRoot = join(root, 'public', 'duckdb-ext');
/** Must match `SELECT version()` of the pinned @duckdb/duckdb-wasm (checked by the session at boot). */
export const DUCKDB_VERSION = 'v1.5.4';
export const PLATFORMS = ['wasm_eh', 'wasm_mvp'];
export const EXTENSIONS = ['parquet', 'json'];

/** @param {Buffer} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const update = process.argv.includes('--update');
  /** @type {Record<string, { sha256: string, bytes: number }>} */
  const lock = update ? {} : JSON.parse(await readFile(lockPath, 'utf8'));
  /** @type {Record<string, { sha256: string, bytes: number }>} */
  const next = {};
  for (const platform of PLATFORMS) {
    for (const ext of EXTENSIONS) {
      const rel = `${DUCKDB_VERSION}/${platform}/${ext}.duckdb_extension.wasm`;
      const dest = join(outRoot, rel);
      /** @type {Buffer} */
      let bytes;
      try {
        bytes = await readFile(dest);
      } catch {
        const url = `https://extensions.duckdb.org/${rel}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        bytes = Buffer.from(await res.arrayBuffer());
        if (!update && lock[rel]?.sha256 !== sha256(bytes)) throw new Error(`Downloaded ${rel} does not match the lock (${sha256(bytes)}); not written.`);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
      }
      const hash = sha256(bytes);
      if (!update && lock[rel]?.sha256 !== hash) {
        throw new Error(`Hash mismatch for ${rel}: got ${hash}, lock has ${lock[rel]?.sha256}. Delete public/duckdb-ext and retry, or review and run --update.`);
      }
      next[rel] = { sha256: hash, bytes: bytes.length };
      console.log(`${rel}  ${bytes.length} bytes  sha256=${hash}`);
    }
  }
  if (update) await writeFile(lockPath, JSON.stringify(next, null, 2) + '\n');
}

const isCli = process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await main();
