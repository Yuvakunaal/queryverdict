// Downloads the official DuckDB-WASM extensions this spike needs (parquet, json)
// so the browser loads them from the app's own origin instead of extensions.duckdb.org.
// Runs at build time only. No user data is involved.
//
// Usage: node scripts/vendor-extensions.mjs            (download + verify against extensions.lock.json)
//        node scripts/vendor-extensions.mjs --update   (download + rewrite the lock file; review the diff)
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'extensions.lock.json');
const outRoot = join(root, 'public', 'duckdb-ext');
const DUCKDB_VERSION = 'v1.5.4'; // must match `select version()` of the pinned @duckdb/duckdb-wasm
const PLATFORMS = ['wasm_eh', 'wasm_mvp'];
const EXTENSIONS = ['parquet', 'json'];
const update = process.argv.includes('--update');

const lock = update ? {} : JSON.parse(await readFile(lockPath, 'utf8'));
const next = {};
for (const platform of PLATFORMS) {
  for (const ext of EXTENSIONS) {
    const rel = `${DUCKDB_VERSION}/${platform}/${ext}.duckdb_extension.wasm`;
    const dest = join(outRoot, rel);
    let bytes;
    try {
      bytes = await readFile(dest);
    } catch {
      const url = `https://extensions.duckdb.org/${rel}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!update && lock[rel]?.sha256 !== sha256) {
      throw new Error(`Hash mismatch for ${rel}: got ${sha256}, lock has ${lock[rel]?.sha256}. Delete the file and retry, or review and run --update.`);
    }
    next[rel] = { sha256, bytes: (await stat(dest)).size };
    console.log(`${rel}  ${next[rel].bytes} bytes  sha256=${sha256}`);
  }
}
if (update) await writeFile(lockPath, JSON.stringify(next, null, 2) + '\n');
