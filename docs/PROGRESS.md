# Progress

> Keep this file factual. Record only what has actually been done and verified.

## Current phase

**Planning. Phase 4 (experimental research) is conditionally complete**, subject to independent review of the checkpoint documentation ([SQL_ANALYSIS_FINDINGS.md](SQL_ANALYSIS_FINDINGS.md)). The next phase is Phase 5: product specifications and production architecture. No production application code exists. A throwaway prototype, with its own dependencies, tests and benchmarks, exists only under `spikes/browser-feasibility/`; the analysis-engine work is on branch `spike/sql-analysis` (P-010). Nothing has been deployed.

Last updated: 2026-11-27

## Status summary

| Area | Status |
|---|---|
| Repository | Foundation commit `c59ca80` exists. Research drafted on `docs/competitor-research`. Origin set to `github.com/Yuvakunaal/queryverdict` |
| Agent rules (AGENTS.md, CLAUDE.md) | Drafted |
| Project vision | Drafted |
| Decisions log | Drafted (confirmed and provisional entries) |
| PRD | Phase 5 production requirements drafted in [PRD.md](PRD.md). Maintainer approval pending |
| Architecture | Proposed production architecture drafted in [ARCHITECTURE.md](ARCHITECTURE.md) (2026-11-27). Maintainer approval and Codex review pending |
| Feasibility study | Spike run 2026-11-25 in **Chrome only**, then corrected after Codex review (Step 3.6): fail-closed lockdown, bounded results, session state machine, registration fixes, benchmark acceptance. Per experiment: E0, E2, E3 (supported subset), E4, E5 and E6 run; E1, E7, E8 and E11 partly run; E9 and E10 not run. The SQL analysis engine is described in §11–§14; the experimental checkpoint after independent review is §14 and [SQL_ANALYSIS_FINDINGS.md](SQL_ANALYSIS_FINDINGS.md) (5 open defects, QV-SA-001 to QV-SA-005). See [FEASIBILITY.md §10](FEASIBILITY.md) |
| Competitor research | Research report drafted. CONDITIONAL GO recommendation pending maintainer review |
| Design system | Proposed [design system](DESIGN_SYSTEM.md), [UI specification](UI_SPECIFICATION.md) and three static mockups. Design and architecture review pending |
| Testing strategy | Proposed in [TESTING_STRATEGY.md](TESTING_STRATEGY.md) (2026-11-27). Approval and review pending |
| Implementation plan | Proposed in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md): modules M01–M15 with task briefs (2026-11-27). Approval and review pending. Specification contradictions in [SPEC_AMENDMENTS.md](SPEC_AMENDMENTS.md) |
| Licence | Not chosen; no LICENSE file |
| Application code | Not started (production). Throwaway spike in `spikes/browser-feasibility/` |
| Tests | Spike only. Implementer runs (2026-11-25): 80 Vitest, 9 Python unittest, 79 Playwright (Chrome 158). Independent Codex runs (Step 4.4.4): type check and both builds passed; 80 Vitest; 9 Python; **59 selected** Chrome tests (full browser suite not independently run); 72 DuckDB comparisons without discrepancies |
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

### 2026-11-25: Experimental SQL correctness analysis engine (Claude Code)

Branch `spike/sql-analysis`. Spike code in `spikes/browser-feasibility/src/analysis/`, exposed only through the test-only harness. No UI work.

- **Parser:** DuckDB's own (`json_serialize_sql` / `json_deserialize_sql`). JS parsers were rejected for dialect mismatch; `sql-parser-cst` was excluded as GPL.
- **Supported subset:** a single `SELECT` with a left-deep chain of `INNER`/`LEFT`/`RIGHT`/`FULL` equi-joins (`ON` or `USING`, composite keys), non-recursive CTEs, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`. Everything else is reported `unsupported` with no conclusions.
- **Algorithms:**
  - exact join statistics from grouped key frequencies, without materialising the join;
  - output cardinality reported separately from multiplied and dropped input rows;
  - relationship classification (whole input and matched keys);
  - NULL-key handling, unmatched keys, stage counts, outer-join rows removed by `WHERE` (measured);
  - aggregate-inflation risk, CTE analysis;
  - user expectations: relationship, no fan-out, no row loss, grain, metric preserved, row count;
  - an execution budget.
- **Verification:**
  - 37 named and 200 seeded random cases match an independent Python nested-loop oracle **and** DuckDB's actual counts;
  - 21 unsupported constructs are rejected;
  - inconclusive and failure paths are tested;
  - an exact 10^16 output is computed without executing the join;
  - 3 deliberate mutations are all caught.
  - Totals: 48 Vitest, 9 Python and 49 Playwright tests pass. The fixtures regenerate byte-for-byte. The production `dist/` contains no analysis or harness code.
- **Performance:** analysis costs 4–13× the user query at 1–5 M rows (202 ms / 509 ms), because sample queries recompute the frequencies.
- **Not done:** Safari and Firefox; the analyser on file datasets; subqueries, `DISTINCT`, window functions and set operations; materialising the frequencies once; analysis-specific cancellation.
- **New provisional decisions:** P-026 to P-030. P-026 refines the presentation of the D-013 categories and needs approval.

### 2026-11-25: Codex Step 4.4 analysis-engine review resolved (Claude Code)

Codex verdict: NO-GO for public release; core frequency arithmetic verified within the tested subset. All 7 findings were reproduced on the unmodified analyser first.

- **H1 RESOLVED:** lossless JSON for parser output and rewritten SQL. Regression tests on `BIGINT`/`HUGEINT`/`DECIMAL` literals.
- **H2 RESOLVED by refusal and validation:** MVP scope accepts integer keys only. Invariants, a `SEMI JOIN` recount and an executed count are checked before anything is published. The collation reproduction is now inconclusive with no impossible numbers.
- **H3 RESOLVED for application budgets:**
  - unknown estimates block every dependent probe;
  - input-row and distinct-key pre-checks;
  - an analysis-wide deadline with cancellation;
  - shape-validated results;
  - temporary tables always dropped.
- **H4 RESOLVED:** explicit NULL semantics; every expectation gets an outcome (violated / held / unchecked).
- **M1 RESOLVED:** aggregate-inflation claims removed and listed as not checked.
- **M2 RESOLVED:** outer-join explanations based on which relations `WHERE` references; no rewrite advice.
- **M3 RESOLVED:**
  - MVP field-level allowlist;
  - experimental checks for `ORDER BY`/`LIMIT`/nested `WITH`/aliases/`COLLATE`;
  - `query-failure` separated from `diagnostic-failure`;
  - count-only probes labelled, and the original query is never claimed to execute.
- **New scope:** a strict MVP scope (P-031, authoritative) alongside the experimental scope (never authoritative).
- **Verification:** type check; 62 Vitest; 9 Python; 67 Playwright (17 new regression tests; 237 oracle cases in experimental scope; 70 MVP-eligible cases authoritative and matching; 188 refusals); 5 of 5 mutations caught; both builds; production artifact clean.
- **Performance:** MVP analysis takes 194 ms / 399 ms at 1 M / 5 M rows, against 18 / 68 ms for a plain join count.
- **Not run:** the 10^8-row-per-side test (retired; not rerun without approval), large-memory and browser-ceiling tests, Safari and Firefox, the analyser on file datasets.
- **Decisions:** P-026 to P-030 revised; P-031 to P-034 added. All provisional.

### 2026-11-25: Spike UI shows a stale startup error in dev mode (Claude Code)

React StrictMode (dev only) mounts the app twice. The first engine session, disposed during startup, rejected late and set `startError`, which locked SQL and file input although the second session was ready. `App.tsx` now ignores results from a disposed session and tags its log lines `[disposed session]`. Verified in Chrome against the dev server (`SELECT 42` runs). The production build never double-mounts, so the e2e suite did not cover this; no automated dev-server test was added.

### 2026-11-25: Second Codex analysis-engine review resolved, Phase 4 hardening (Claude Code)

> **Corrected 2026-11-26 after independent review (Step 4.4.4):** the "RESOLVED" statuses below were the implementer's claims. Corrected: H-A and H-B PARTIALLY RESOLVED; M4 and M5 RESOLVED within the tested scope; M6 RESOLVED for count and identity, with a stale-publication limitation. See the 2026-11-26 entry.

Codex verdict: NO-GO for public release (two high, three medium); 32 join scenarios verified against DuckDB. No diagnostic capability was added; the MVP scope is frozen ([FEASIBILITY.md §13](FEASIBILITY.md)).

- **H-A RESOLVED:**
  - exclusive session ownership for the whole analysis (`EngineSession.exclusive`);
  - one transaction, always rolled back (DuckDB transaction semantics verified in the browser);
  - only verified stable tables are eligible for authoritative reports: views, file-backed views, CTEs, generated columns and ambiguous names are refused;
  - start/end key-multiset fingerprints, table identities and witness identity checks;
  - generation binding.
- **H-B RESOLVED for application-level bounds:**
  - the `DISTINCT … LIMIT` pre-check was removed (it performed the full grouping);
  - input rows, key columns, key width, estimated grouping state and the engine memory limit are qualified separately before any grouping;
  - one deadline (including queue wait), batch-only cancellation, bounded grace, then worker termination and background recovery;
  - late results ignored; bounded cleanup and rollback; bounded boots; a failed recovery leaves the session `failed`.
- **M4 RESOLVED:** non-finite totals, differences or bounds give `unchecked`; tolerance is validated.
- **M5 RESOLVED:** structured keys; quote-aware column parsing; optional probes fail independently without discarding validated evidence.
- **M6 RESOLVED:** one outcome per declared expectation on every path, with index and identity; malformed expectations reported as invalid.
- **Verification:**
  - type check; 80 Vitest (18 new); 9 Python; 79 Playwright (12 new hardening tests); both builds; production artifact clean;
  - 10 of 10 new mutation checks caught.
- **Performance:** MVP analysis takes about 139 ms at 1 M and 600 ms at 5 M rows (40 statements), against 12 ms and 67 ms for a plain join count.
- **Not run:** the 400 M-row deadline test (replaced by a 30 M-value memory-light fixture), large-memory and browser-ceiling tests, Safari and Firefox, the analyser on file datasets.
- **Decisions:** P-031 to P-034 revised; P-035 to P-038 added. All provisional.

### 2026-11-26: Experimental checkpoint after independent review, Step 4.4.4 (Claude Code)

**Codex verdicts:**
- experimental implementation: CONDITIONAL GO for isolated research;
- commit readiness: NO until the documentation claims are corrected;
- Phase 5 readiness: YES WITH CONDITIONS;
- public release: NOT READY.

**Documentation only.** No analyser behaviour changed.

- **Corrected statuses** of the second-review findings:
  - snapshot consistency and execution safeguards: PARTIALLY RESOLVED;
  - non-finite metrics and quoted identifiers: RESOLVED within the tested scope;
  - expectation outcomes: RESOLVED for count and identity, with a stale-publication limitation.
- **Inline corrections** in FEASIBILITY.md §13, plus a new §14. The 2026-11-25 log entry is annotated.
- **Defect register** in the new [SQL_ANALYSIS_FINDINGS.md](SQL_ANALYSIS_FINDINGS.md):
  - **QV-SA-001 (HIGH):** witness verification bypasses the execution budget.
  - **QV-SA-002 (HIGH):** stale authoritative publication.
  - **QV-SA-003 (MEDIUM):** stalled recovery reattachment.
  - **QV-SA-004 (MEDIUM):** DOUBLE precision in metric tolerance.
  - **QV-SA-005 (MEDIUM):** stalled callback retains the session lease.
  - **Gating:** QV-SA-001 and QV-SA-002 block enabling the public analyser. QV-SA-003 and QV-SA-005 block production engine qualification. Metric preservation stays out of the public MVP.
- **Evidence** recorded separately for Codex and for the implementer:
  - **Codex:** type check, both builds, 80 Vitest, 9 Python, 59 selected Chrome tests, 72 DuckDB comparisons without discrepancies, artifact isolation, selected security tests, no external requests.
  - The full browser suite has not been independently reproduced.
- **Proposed public MVP boundary** recorded, including the implications of requiring DuckDB-managed tables: import memory overhead and table loss on worker termination.
- **Decisions:** P-031, P-033, P-034, P-036 and P-038 revised; P-039 added. All provisional.
- **Phase 4:** conditionally complete for experimental research, subject to independent review of this checkpoint's documentation.
- **Hygiene:**
  - no generated data, raw benchmarks, builds, vendored extensions, caches, binaries or credentials are in the proposed commits;
  - third-party notice obligations are still unresolved, so no build artifact may be published.

### 2026-11-26: Phase 5 production PRD drafted

- Defined the proposed public MVP, stable requirement IDs, feature acceptance criteria, supported workload qualification and release gates. Recorded P-040 and P-041 as provisional.
- The proposed data workflow imports CSV and Parquet as managed tables. It keeps file-backed attachments and advanced SQL diagnostics outside P0. The 50 MB combined target and browser coverage remain unverified for production.
- Documentation only. No production code, browser qualification or deployment was performed.

### 2026-11-26: Workspace design proposed

- Documented visual tokens, light/dark/system themes, workspace flows, accessibility, responsive layout and UI acceptance linked to the PRD.
- Added illustrative landing, SQL workspace and Visual Verdict PNG concepts. The sample uses one supported join. Profiling beyond join-key evidence and multi-stage visual debugging remain future work.
- The architecture remains pending. No product UI, engine integration or deployment was implemented or tested.

### 2026-11-27: Production architecture, testing strategy and implementation plan drafted (Claude Code)

Documentation only, at the maintainer's request (D-010 assigns these to ChatGPT; reassignment recorded as AM-017). No production code, dependencies, builds or deployments.

- **Actual state found:** ARCHITECTURE, IMPLEMENTATION_PLAN and TESTING_STRATEGY were still PENDING placeholders on `main` (the commit titled "finalize production requirements and architecture", `95ef88c`, changed only the PRD). The PRD (PR #4) and design (PR #5) are merged, but the PRD's status line still reads "Proposed" (AM-001). Findings from the 2026-11-26 PRD and design reviews were not incorporated in the merged documents. A pre-existing uncommitted `README.md` change is in the working tree (not made in this task; left untouched).
- **Created:** [ARCHITECTURE.md](ARCHITECTURE.md) (system, directory, module boundaries, dependencies, engine/session operation model with revocable lease, data epoch, managed-table ingestion, statement policy, Verdict pipeline with single budget gate and publication fence, security, deployment, QV-ENG-001…015 traceability, external verification record); [TESTING_STRATEGY.md](TESTING_STRATEGY.md); [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (module evaluation, order, 22-field specifications and task briefs for M01–M06, M08–M10, M12–M15; M07 and M11 split/deferred); [SPEC_AMENDMENTS.md](SPEC_AMENDMENTS.md) (AM-001…AM-022, not applied).
- **Decisions:** P-043…P-056 added (all provisional).
- **External verification:** 17 facts checked against primary sources by a research sub-agent (ARCHITECTURE §24); unverifiable items marked (dedicated-worker timer throttling, Safari practical WASM memory limit, Pages custom headers only observed absent).
- **Not done:** no QV-SA defect is resolved; designs for QV-SA-001/002/003/005 are proposals until production tests and independent review. No browser qualification, benchmark or deployment was performed.

## Next steps

1. Independent Codex review of [ARCHITECTURE.md](ARCHITECTURE.md), [TESTING_STRATEGY.md](TESTING_STRATEGY.md), [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) and [SPEC_AMENDMENTS.md](SPEC_AMENDMENTS.md).
2. Maintainer decisions: PRD approval (AM-001); amendments AM-002…AM-022; P-043…P-056; licence choice (gates any deployment).
3. Resolve the pre-existing uncommitted `README.md` change.
4. Record the move from planning to implementation in this file, then start M01 on `feat/application-foundation` using the M01 task brief.
5. Close the gaps before confirming P-003/P-016–P-020 (Safari, Firefox, real Pages, notices) through M02's walking skeleton and M15.
