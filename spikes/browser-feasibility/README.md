# Browser feasibility spike

**Throwaway prototype, not production code** (see [P-010](../../docs/DECISIONS.md) and [FEASIBILITY.md](../../docs/FEASIBILITY.md)).
It answers one question: can QueryVerdict load local datasets and run SQL entirely in the browser, safely and responsively, on static hosting with no backend?

Results are in [docs/FEASIBILITY.md §9](../../docs/FEASIBILITY.md#9-spike-results-2026-11-25) (original record) and **§10** (Codex review corrections, current evidence and qualification boundary).

## What it contains

| Path | Purpose |
|---|---|
| `src/engine/bundles.ts` | Engine assets (`.wasm`, worker) imported as same-origin URLs. The threads build is excluded (needs COOP/COEP) |
| `src/engine/lockdown.ts` | Engine lockdown statements, the independent effective-state verifier, and the escalation probes that must fail |
| `src/engine/session.ts` | Session state machine: fail-closed startup, FIFO operation queue, registration with rollback, streamed queries and imports, cancel → bounded recovery, disposal |
| `src/engine/bounded.ts`, `format.ts` | Result budgets enforced before display conversion (rows, columns, cell characters, display characters, Arrow bytes) |
| `src/bench/` | In-page benchmark runner (per-record verdicts), browser-side metrics, input guards (`guards.ts`) |
| `harness/`, `vite.harness.config.ts` | **Test-only** build (`dist-harness/`): unlocked negative-control engine and fault injection. Never deployed |
| `scripts/lib/acceptance.mjs` | Record classification and run acceptance (completion ≠ acceptance) |
| `src/App.tsx` | Minimal UI: file input, schema, preview, SQL, run/cancel, event log, manual benchmark panel |
| `scripts/vendor-extensions.mjs` | Downloads the official `parquet`/`json` engine extensions and checks them against `extensions.lock.json` |
| `scripts/generate_datasets.py` | Seeded synthetic data generator (CSV, NDJSON, Parquet) with known answers |
| `scripts/run-bench.mjs` | Automated benchmark in the installed Google Chrome, with safety checks and OS memory sampling |
| `scripts/measure-boot.mjs` | Cold/warm engine boot time and asset sizes |
| `scripts/summarize-bench.mjs` | Builds the result tables and `results/summary.json` |
| `tests/unit/` | Vitest (TypeScript) and unittest (generator) |
| `tests/e2e/` | Playwright tests: `security` (fail-closed, artifact scan, network isolation), `lifecycle` (disposal, cancellation, recovery, registration), `bounded` (result budgets), `bench-guard`, `spike` (functional) |

## Requirements

- Node 20.19+ or 22.12+ (tested with 24.2.0), npm.
- Python 3.10+ (tested with 3.13.5). `pyarrow` only for Parquet output (tested with 21.0.0).
- Google Chrome for the automated tests and benchmarks (Playwright uses the installed browser; nothing is downloaded).
- Network access once, to install npm packages and fetch the two engine extensions from `extensions.duckdb.org`. The running app makes no third-party requests.

## Run it

```sh
cd spikes/browser-feasibility
npm ci
npm run build          # vendors extensions (hash-checked), type-checks, builds dist/
npm run preview        # http://127.0.0.1:4173/queryverdict/
```

`npm run dev` also works, but the meta CSP is only added to production builds.
The engine lockdown cannot be disabled in this app: startup fails closed if any control is not verified. The unlocked negative-control engine exists only in the test-only harness build (`npm run build:harness`, `npm run preview:harness` → `http://127.0.0.1:4174/queryverdict/harness/`). Never load real data there.

## Tests

```sh
npm run test:unit      # Vitest + Python generator tests
npm run test:e2e       # builds dist/ and dist-harness/, serves both, runs Playwright in Chrome
```

## Benchmarks

Safety rules (enforced by the scripts):

- The generator refuses to run without free disk of at least 3× the target size plus 2 GB, and needs `--confirm-large` for 500 MB and 1 GB.
- `run-bench.mjs` checks the **resolved files** (inside `data/`, regular files) and their **actual combined size**: above 50 MB needs `--confirm-large`; above 250 MB also needs `--maintainer-approval "<who, when>"`. Inputs are SHA-256-checked against the manifest. Only one benchmark runs at a time (`results/.bench.lock`).
- **Exit code 0 only when the run is accepted**: harness completed, inputs validated, provenance recorded, every planned workload present, no failed assertions, unexpected errors or timeouts, and every cancel workload actually exercised. Use `--expect-boundary-errors` for deliberate out-of-memory runs.
- `run-bench.mjs` refuses to start when the macOS memory-free level (`kern.memorystatus_level`) is below 25 % or disk is below 2 GB, and aborts if the level falls below 10 % during a run. A renderer crash ends the run and is recorded.
- Each workload has a timeout (default 300 s) that cancels it. Each run has a 45-minute limit.
- The engine runs single-threaded with `memory_limit` 2 GB by default, so most overloads become recoverable errors.
- Run smaller sizes first. Close other heavy applications. Generated data stays in `data/` (git-ignored).

```sh
python3 scripts/generate_datasets.py --size 50MB --formats csv,parquet,json
node scripts/run-bench.mjs --size 50MB --format csv     --mode view  --reps 3 --cancel-reps 20
node scripts/run-bench.mjs --size 50MB --format parquet --mode view
node scripts/run-bench.mjs --size 50MB --format json    --mode view
node scripts/run-bench.mjs --size 50MB --format csv     --mode table

python3 scripts/generate_datasets.py --size 200MB --formats csv,parquet,json
# ... same four runs with --size 200MB

python3 scripts/generate_datasets.py --size 500MB --formats csv,parquet --confirm-large
node scripts/run-bench.mjs --size 500MB --format csv --mode view --confirm-large   # and parquet view, csv table

python3 scripts/generate_datasets.py --size 1GB --formats csv,parquet --confirm-large
node scripts/run-bench.mjs --size 1GB --format csv --mode view --confirm-large     # and parquet view, csv table

# boundary characterisation (opt-in, memory-heavy; historical commands, need --maintainer-approval now)
node scripts/run-bench.mjs --size 1GB --format parquet --stress --only stress_groupby_every_row,stress_self_join_orders,stress_count_distinct_note --reps 1 --confirm-large
node scripts/run-bench.mjs --size 1GB --format parquet --stress --only stress_groupby_every_row,stress_self_join_orders,stress_count_distinct_note,count_customers --reps 1 --memory-limit 256MB --expect-boundary-errors --confirm-large

node scripts/measure-boot.mjs --runs 5 > results/raw/boot.json
node scripts/summarize-bench.mjs        # categories + acceptance per run, writes results/summary.json
```

Sizes are decimal MB of the **orders CSV file**. Parquet and NDJSON files hold the same rows, so they are smaller (Parquet) or larger (NDJSON, about 2.2×) on disk. The manifest records the exact bytes of every file.

**Manual runs (Safari, Firefox):** open the preview URL and use the *Benchmark* panel. Pick `orders.*`, `customers.*` and `manifest.json` from `data/<size>/`, run it, then download the JSON.
- Sizes are always checked against the manifest; SHA-256 is checked for inputs up to 50 MB combined.
- Above 50 MB combined you must tick the confirmation box *and* confirm a dialog. Above 1.1 GB the run is refused.
- One benchmark at a time, enforced with Web Locks across tabs.
- The browser cannot measure host memory pressure, so close other heavy applications first.
- These runs lack the OS memory sampling, provenance and acceptance evaluation that `run-bench.mjs` adds.

**Do not repeat the 500 MB / 1 GB runs or memory-ceiling experiments without maintainer approval** (FEASIBILITY.md §10).

### What each memory number means

| Label | Source | Covers |
|---|---|---|
| OS RSS (actual) | `ps` RSS of the Chrome process tree, sampled every 250 ms | All Chrome processes. RSS counts shared pages in every process (the total over-counts) and excludes compressed/swapped pages |
| Engine-reported | `duckdb_memory()` | DuckDB buffer-manager memory only, not the whole WASM heap |
| Browser API (actual, partial) | `performance.memory` (Chromium only, non-standard) | Main-thread JS heap only. The engine worker is not included |
| Not available | `performance.measureUserAgentSpecificMemory()` | Needs cross-origin isolation, which GitHub Pages cannot provide |

## Cleanup

```sh
rm -rf data results/raw dist dist-harness public/duckdb-ext node_modules
```
