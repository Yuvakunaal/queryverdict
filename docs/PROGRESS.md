# Progress

> Keep this file factual. Record only what has actually been done and verified.

## Current phase

**Planning, with a maintainer-approved feasibility spike.** No production application code exists. A throwaway prototype, with its own dependencies, tests and benchmarks, exists only under `spikes/browser-feasibility/` on branch `spike/browser-feasibility` (P-010). Nothing has been deployed.

Last updated: 2026-11-25

## Status summary

| Area | Status |
|---|---|
| Repository | Foundation commit `c59ca80` exists. Research drafted on `docs/competitor-research`. Origin set to `github.com/Yuvakunaal/queryverdict` |
| Agent rules (AGENTS.md, CLAUDE.md) | Drafted |
| Project vision | Drafted |
| Decisions log | Drafted (confirmed and provisional entries) |
| PRD | PENDING |
| Architecture | PENDING |
| Feasibility study | Spike run 2026-11-25 in **Chrome only**, then corrected after Codex review (Step 3.6): fail-closed lockdown, bounded results, session state machine, registration fixes, benchmark acceptance. Per experiment: E0, E2, E4 and E6 run; E1, E3, E7, E8 and E11 partly run; E5, E9 and E10 not run. See [FEASIBILITY.md §10](FEASIBILITY.md) |
| Competitor research | Research report drafted. CONDITIONAL GO recommendation pending maintainer review |
| Design system | PENDING |
| Testing strategy | PENDING |
| Implementation plan | PENDING |
| Licence | Not chosen; no LICENSE file |
| Application code | Not started (production). Throwaway spike in `spikes/browser-feasibility/` |
| Tests | Spike only, all passing on 2026-11-25: 41 Vitest, 5 Python unittest, 44 Playwright (Chrome 158) tests against the production and test-harness artifacts |
| CI | Not configured |
| GitHub Pages deployment | Not configured |
| Benchmarks | 23 Chrome runs, all headless. 19 historical (50 MB–1 GB tiers), classified `historical-unvalidated`. 4 new schema-v2 runs (tiny and 50 MB tiers only): 2 accepted, 2 correctly rejected. No general capacity claim. Proposed qualification target: 50 MB combined (P-024) |

## Log

### 2026-11-25: Project initialisation (Claude Code)

- Inspected the repository. It contained only empty placeholder files: `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `README.md`, and ten empty files in `docs/`.
- Populated `AGENTS.md`, `CLAUDE.md`, `README.md`, `.gitignore`, `docs/PROJECT_VISION.md`, `docs/PROGRESS.md`, `docs/DECISIONS.md`.
- Marked the remaining spec documents as PENDING.
- Not done (by instruction): no dependencies installed, no app scaffolding, no source code, no commits.
- Verification: documentation only; there is nothing to test.
- Known issue: `docs/FEASmdILITY.md` appears to be a misspelling of `FEASIBILITY.md`. Left unchanged pending maintainer confirmation.

### 2026-11-25: Initialisation completed against the full maintainer brief (Claude Code)

- Renamed `docs/FEASmdILITY.md` to `docs/FEASIBILITY.md` (untracked, no history), because the brief names `FEASIBILITY.md` as required. Updated the link in AGENTS.md.
- AGENTS.md: added the maintainer's approval role, the correctness-findings taxonomy (§8), the Git/branching/Conventional Commits workflow (§13), resource cleanup and failure-recovery rules, and a commit-message recommendation step.
- CLAUDE.md: added branch-workflow and findings-taxonomy responsibilities.
- PROJECT_VISION.md: added the contract-credibility and sustainability objectives, the findings categories, failure recovery, the launch strategy, and the schedule.
- DECISIONS.md: corrected D-009 to "MacBook Air", as stated in the brief. Added confirmed D-012 to D-016 and more open items (benchmark browsers, demo dataset licensing, SECURITY/CONTRIBUTING docs).
- `.gitignore`: added DuckDB database files, generated benchmark data, temporary files, and bundle-analysis output.
- README: links to the pending docs; contribution status.
- Inspected the local Git config and origin (`https://github.com/Yuvakunaal/queryverdict.git`) without changing them.
- Verification: documentation only. Checked that relative links resolve to existing files. No tests exist.

### 2026-11-25: Response to Codex foundation review (Claude Code)

Codex review verdict: CHANGES REQUIRED (4 confirmed findings, 1 optional). Resolutions:

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| 1 | HIGH: fan-out example equated measured multiplicity with a confirmed defect | Valid | AGENTS.md §8: measurements are evidence; fan-out with unknown intent is a suspicious pattern; a confirmed issue needs a known requirement (e.g. a declared grain). Categories unchanged (D-013); clarification logged as P-012. Confirmed-issue vs expectation-violation boundary left open for the PRD. |
| 2 | HIGH: engine validation omitted network isolation | Valid | Network isolation added as a condition for approving P-003. FEASIBILITY.md and TESTING_STRATEGY.md scopes now require it. AGENTS.md §5 restricts runtime requests to same-origin static assets (P-013). Codex's claim about DuckDB-WASM remote reads and extension fetching matches my understanding but was not re-checked against the cited page in this task. The spike must verify it. |
| 3 | MEDIUM: no approval path for pre-implementation spikes | Valid | CLAUDE.md: per-spike maintainer approval, `exp/` branch, isolated and throwaway, results in FEASIBILITY.md. The implementation gate is unchanged. Logged as P-010. |
| 4 | MEDIUM: credential, private-dataset, export and local-DB paths were not ignored | Partly valid | Added credential patterns, local DB patterns (`*.db`, `*.sqlite*`), `exports/`, `scratch/`, `datasets/private*`, and a documented convention for local-only folders. AGENTS.md §13 now requires a check of staged files. **Not adopted:** a blanket ignore of `.npmrc`, which commonly holds committed, non-secret package-manager config. Token leakage is handled by the staged-file check, and automated secret scanning is listed as an open item. |
| 5 | LOW: merge order implicit | Valid | AGENTS.md §13 now sets the order: implementer verification, Codex review, CI, maintainer merge. Logged as P-011. The specific CI checks are deferred to TESTING_STRATEGY. |

- Unresolved: Codex could not check the source of the "Maintainer brief" decisions because the brief exists only in the conversation, not the repository. The maintainer may want to confirm D-001 to D-016 during first-commit review.
- Verification: `git check-ignore` passed for 9 paths that must be ignored and 9 that must stay committable (including `.env.example`, `.npmrc`, and fixtures under `tests/` and `src/`). 43 relative Markdown links resolved, 0 broken. No application tests exist.

### 2026-11-25 — Competitor and feasibility research

- Replaced the [competitor research stub](COMPETITOR_RESEARCH.md) with a dated comparison of browser workspaces, SQL debuggers, and correctness tools, including public repository metrics, documented pain points, and a proposed MVP.
- Research recommendation is **CONDITIONAL GO** for user discovery and a separately approved feasibility spike. SQL Viewer and SQL Workbench already overlap with visual debugging. The proposed differentiation is reproducible, key-level evidence tied to declared result grain.
- Verification passed for the Markdown tables, 50 relative file links, and the Git whitespace check. An in-memory SQLite check reproduced the worked join example and 200 deterministic single-key cases. This checks the counting identities in the report, with DuckDB-WASM qualification still pending.
- Product and stack decisions remain pending. No application code, dependencies, browser tests, deployment, or benchmarks were added.

### 2026-11-25: Engineering evaluation of the research and feasibility experiment plan (Claude Code)

- Wrote [FEASIBILITY.md](FEASIBILITY.md): an engineering evaluation of the research, the smallest proof of concept, failure cases, dependencies to validate, and a prioritised plan of 12 experiments (E0–E11) with inputs, workloads, measurements, safeguards and proposed acceptance criteria. **Every experiment is NOT RUN.**
- Main challenges to the research: query parsing (E5) is the central differentiator and risk, not an optional extra. The two-second recovery target mixes three different measurements. Browser memory APIs that need cross-origin isolation won't be available on Pages. A `<meta>` CSP may not govern the engine's worker. Technical spikes need not wait for user discovery.
- [DECISIONS.md](DECISIONS.md): added P-014 (experiment plan) and P-015 (SQLite WASM fallback), extended the validation criteria for P-003, and added an "Awaiting maintainer decision" section. [COMPETITOR_RESEARCH.md](COMPETITOR_RESEARCH.md) was not modified.
- Not verified: I did not open the research's cited sources or re-check its metrics. Technical claims I could not verify are marked *(to verify)* and assigned to experiments.
- Verification: documentation only. Relative links checked. No code, dependencies, tests or benchmarks.

### 2026-11-25: Browser feasibility spike (Claude Code)

Approved by the maintainer as a scoped spike on `spike/browser-feasibility`. Throwaway code under `spikes/browser-feasibility/`.

- **Built:**
  - a React 19 / TypeScript 7 / Vite 8 prototype with DuckDB-WASM 1.33.1-dev57.0 (DuckDB v1.5.4), single-threaded and served from a `/queryverdict/` subpath;
  - engine lockdown, file registration (CSV/NDJSON/Parquet) as views or imported tables, streamed results capped at 1,000 rows / 8 MB, cancel/restart/recovery, and a minimal UI;
  - a seeded data generator, a benchmark runner with safety checks and OS memory sampling, a boot/asset-size script and a summariser.
- **Tests:** type check passes; 15 Vitest, 5 Python and 9 Playwright (Chrome 158) tests pass.
- **Measured (Chrome only):**
  - 50 MB, 200 MB, 500 MB and 1 GB in CSV and Parquet (NDJSON at 50/200 MB), as file views and imported tables;
  - all 703 workload checks matched known answers;
  - 0 main-thread long tasks;
  - 160/160 cancellations cooperative, each stopping within 264 ms;
  - no leak over 20 cancel cycles;
  - peak OS RSS of the Chrome process tree 1.9 GB;
  - a forced 256 MB memory limit produced recoverable `Out of Memory Error`s, not a crash.
- **Key findings:**
  - DuckDB-WASM fetches the Parquet/JSON extensions from `extensions.duckdb.org` by default;
  - a page `<meta>` CSP does not restrict the engine worker;
  - the engine lockdown blocked 19/21 escalation probes, and the other 2 (`INSTALL`) had no effect;
  - no request left the origin.
- **Not run:**
  - Safari and Firefox; a real GitHub Pages deployment;
  - E3 corpus, E5, E9, E10, 10,000-row rendering;
  - the memory-ceiling crash test (deliberately skipped for safety).
  - Also not collected: DuckDB third-party licence notices (missing from the npm package).
- **Process notes:**
  - The branch name differs from P-010's `exp/` convention; this is raised in DECISIONS.
  - The benchmark safety check uses macOS `kern.memorystatus_level` (≥ 25 %) instead of the planned swap-usage rule, because about 4 GB of old swap stayed in use while memory was otherwise available.
  - The 500 MB and 1 GB runs proceeded on the maintainer's re-sent brief, which required them with safeguards.
- Generated data (about 3 GB) is in `spikes/browser-feasibility/data/`. It is git-ignored and can be deleted (see the spike README).

### 2026-11-25: Codex review resolution, Step 3.6 (Claude Code)

Codex returned CONDITIONAL GO with 4 high- and 3 medium-severity findings. All 7 were reproduced on the unmodified build first.

- **1. Fail-closed startup — RESOLVED.**
  - Lockdown failures are fatal, and the effective state is verified before any SQL runs or file is accepted.
  - The candidate worker is terminated on failure; recovery uses the same path.
  - The `?lockdown=off` bypass is removed. Negative controls live in a test-only build (`dist-harness/`), checked absent from `dist/`.
- **2. Result budgets — PARTLY RESOLVED.**
  - Rows, columns, per-cell characters, display characters and Arrow bytes are bounded before conversion, and each truncation kind is reported separately.
  - Per-batch worker-to-page transfer (2,048 rows) cannot be bounded by the application. No hard memory guarantee.
- **3. Session lifecycle — RESOLVED for the prototype.**
  - State machine and FIFO queue; imports cancellable; rejected or timed-out cancels fall back to termination; failed registrations roll back; recovery marks tables `needs-reimport`.
  - Disposal wins over startup. This fix also caught a hang that my first rewrite introduced.
- **4. Registration collisions — RESOLVED.** Names reserved inside the serialized queue against datasets and the catalog; `CREATE` instead of `CREATE OR REPLACE`; removal by dataset ID.
- **5. Benchmark integrity — RESOLVED for new runs.**
  - Per-record verdicts; acceptance separate from completion; input SHA-256 checks; provenance; non-zero exit unless accepted.
  - The 703 historical records are reconciled: **517 assertions** (all passed), 160 exercised cancels, 14 cancels not exercised, 9 stress runs, 3 expected OOMs. **My earlier claim that all 703 were passing checks was wrong.**
- **6. Over-reaching claims — RESOLVED in the docs.** 84 records have no frame-gap sample; all runs were headless; physical sizes are now reported per format; no general 1 GB claim. Proposed qualification target: 50 MB combined, desktop Chrome, file-backed CSV/Parquet.
- **7. Safeguards and Git — RESOLVED.**
  - CLI: resolved-path and actual-size guards, `--maintainer-approval` above 250 MB, PID lock.
  - Page and manual entry point: manifest size and hash checks, confirmation above 50 MB, Web Locks.
  - `.gitignore` now covers data files everywhere except `fixtures/`, `.npmrc`, SQLite sidecars and `dist-harness/`.
- **Verification:** type check; 41 Vitest; 5 Python; 44 Playwright; both production builds; artifact scan; 4 small benchmarks (tiny CSV; 50 MB-tier Parquet ×2; 50 MB-tier CSV). No 500 MB/1 GB or memory-ceiling runs were repeated.
- **Not done:**
  - Safari, Firefox, a real Pages deployment and the `mvp` fallback;
  - runtime extension integrity;
  - full third-party notices (DuckDB-WASM's MIT text is missing from its npm package; Arrow's NOTICE must be shipped);
  - E3, E5, visible-window responsiveness and rendering.
  - No engine version change (the risk is documented).

## Next steps

1. Codex re-reviews the Step 3.6 corrections ([FEASIBILITY.md §10](FEASIBILITY.md)).
2. Close the gaps before confirming P-003/P-016–P-020: run in Safari and Firefox; test a real GitHub Pages deployment; collect DuckDB third-party notices.
3. Choose a licence.
4. Decide the open product questions (query-first vs relations-first; research recommendation), then run E5 (query parsing) and the E3 correctness corpus.
5. Write the PRD, architecture, testing strategy, design system and implementation plan.
