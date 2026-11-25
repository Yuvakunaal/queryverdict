import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Tiny synthetic fixtures (about 200 KB) in csv, ndjson and parquet, written to data/tiny (git-ignored).
export default function globalSetup() {
  const root = join(import.meta.dirname, '..', '..');
  if (existsSync(join(root, 'data', 'tiny', 'manifest.json')) && existsSync(join(root, 'data', 'tiny', 'orders.parquet'))) return;
  execFileSync('python3', [join(root, 'scripts', 'generate_datasets.py'), '--size', 'tiny', '--formats', 'csv,parquet,json'], { stdio: 'inherit' });
}
