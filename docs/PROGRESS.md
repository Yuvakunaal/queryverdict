# Progress

> Keep this file factual. Record only what has actually been done and verified.

## Current phase

**Implementation (Phase 7).** M01–M06 and M08–M10 are merged (PRs #7–#15). **M12 Evidence Copy and Replay Bundle is implemented on `feat/evidence-copy` and awaiting independent Codex review**; nothing of M12 is committed (the branch holds one earlier M10 follow-up commit, `3cc080c`). M11 and M13 are not started. Decisions for approval: P-115, P-116. Research spikes remain under `spikes/` and are excluded from the production build.

Last updated: 2026-11-28

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
| Application code | M01–M06 and M08 merged. M09 Visual Verdict implemented on `feat/visual-verdict` (uncommitted, awaiting Codex review): Analyze wiring, Verdict panel and full view, findings, expectations, witnesses, coverage, historical states, join-key profile |
| Tests | **Production (M06 branch after the Codex M06 review, local, 2026-11-27):** 404 Vitest unit tests, 7 Python oracle tests, and 559 Playwright tests passed with 8 skipped by design (Chrome 158.0.8127.37, Firefox 159.0, WebKit 27.2). Axe runs in Chromium and WebKit (Firefox skipped, P-083). Repo scan, typecheck, lint, boundary check, build, harness build, artifact check and notices clean |
| CI | `.github/workflows/ci.yml` (verify, build, browser jobs) added in M01; **not yet run on GitHub** (runs when the maintainer pushes the branch) |
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

### 2026-11-27: M01 Application Foundation implemented (Claude Code)

Branch `feat/application-foundation` (no commits). Scope as in IMPLEMENTATION_PLAN.md § M01. Reviewed by Codex in Step 7.5; see the corrections entry below.

- **Built:** root npm project with exact pins and lockfile; strict TypeScript (app config without Node types, tooling/test config); Vite production build under `/queryverdict/` with the production meta CSP (single source `scripts/csp.mjs`); separate test-only harness build (`dist-harness/`); ESLint flat config enforcing `src/core` boundaries (no React/UI/stores/app imports), no harness imports and no `dangerouslySetInnerHTML`; `scripts/check-artifact.mjs` (harness markers, external URLs, exact CSP, inline scripts, asset inventory); `scripts/notices.mjs` scaffold; `ReleaseProfile` defaults + validation; typed error classes; external store primitive; session-only theme store (System/Light/Dark, live OS changes); design tokens for both themes (System correct at first paint without script); accessible shell (skip link, landmarks, single status region "Engine not started", native-`<dialog>` settings with focus restore, error boundary); CI workflow (no deploy); `.gitignore` rules; README Development section (added on top of the maintainer's pre-existing README change, as instructed).
- **Deviations approved by the maintainer during M01:** TypeScript 6.0.3 instead of 7.0.2 (P-057: typescript-eslint incompatibility); Firefox and WebKit installed for Playwright. Vitest 5.1.2 instead of 5.1.1 under P-044's re-pin clause (P-058: npm resolver crash). Dependency register: P-059.
- **Verification (clean `npm ci`):** typecheck 0 errors; lint 0 problems; Vitest 33/33; build OK with `check-artifact` clean (3 files, 232,968 bytes; JS 226 KB, 70 KB gzip-9); harness build OK; notices: react, react-dom, scheduler (MIT); `npm audit` 0 vulnerabilities; Playwright 36/36 across Chrome, Firefox and WebKit (axe: 0 WCAG A/AA violations in both themes including the dialog; only same-origin GETs; no storage writes; exact CSP; 320 px reflow; harness marker absent from `dist/`).
- **Not done / limitations:** CI not yet run on GitHub; no manual screen-reader pass (M14); no formatter (open item); README status and "Pending" lines predate this work and are stale (not in M01 scope); WebKit tests reach the skip link with Option+Tab (Safari platform behaviour).

### 2026-11-27: M01 corrections after Codex Step 7.5 review (Claude Code)

Codex verdict: CHANGES REQUIRED (1 high, 5 medium); it reproduced 33 unit and 36 browser tests passing but found defects the suites missed. All six were reproduced by new tests before or with the fix.

- **HIGH, artifact gate accepted pages without an effective CSP:** the checker now parses HTML with `parse5` (P-060) and requires exactly one exact CSP meta element as a child of `<head>` before any resource element; rejects empty entry points, extra HTML files, inline scripts, event-handler attributes, `javascript:` URLs, `srcdoc`, missing module assets, and files outside the expected inventory. Browser tests now prove enforcement: on the production page an injected inline script does not run and a cross-origin image never reaches a recording listener; a negative control on the CSP-free harness page shows the same probe succeeding.
- **MEDIUM, URL and marker gaps:** HTML resource attributes are resolved as URLs (protocol-relative and entity-encoded forms caught); JS is unescaped before a case-insensitive scan; the inert-URL allowlist is exact and JS-only; markers are matched case-insensitively in every file. Network capture asserts an explicit static-asset allowlist.
- **MEDIUM, lint gaps:** resolved import-graph check (P-061) catches re-export indirection, literal dynamic imports and harness reachability; ESLint rejects non-literal dynamic imports, every listed raw-HTML sink and `eval`/`new Function`.
- **MEDIUM, profile validation:** required fields checked explicitly; deadlines limited to the `setTimeout` range (2,147,483,647 ms); memory limit parsed and required to be above zero and below the 4 GiB WebAssembly ceiling.
- **MEDIUM, focus:** the Settings dialog returns focus to an explicit trigger on every dismissal (WebKit does not focus buttons on click); the error boundary focuses its region after a successful retry (tested through a harness fixture).
- **MEDIUM, notices:** inventory now walks `package-lock.json` locations, so nested versions are checked separately (with version and licence cross-checks).
- **Also:** the repository hygiene scan assigned to M01 by TESTING_STRATEGY §5.10 was missing; added `scripts/check-repo.mjs` to CI (P-062). README status and documentation list reconciled.
- **Verification (clean `npm ci`, 213 packages):** check:repo, typecheck, lint (+ boundary check) all exit 0; Vitest **63/63**; build OK, `check-artifact` clean (3 files, 234,335 bytes); harness build OK; notices 3 MIT locations; `npm audit` 0 vulnerabilities; Playwright **48/48** (16 × Chrome 158.0.8127.37, Firefox 159.0, WebKit 27.2).
- **Still open (maintainer):** AM-001 and explicit approval of architecture, plan and testing strategy; confirmation of P-057…P-062; first remote CI run (pull request). Not done: manual screen-reader, real-zoom, forced-colours and real Safari checks (M14/M15).

### 2026-11-27: M02 Database Engine and Session implemented (Claude Code)

Branch `feat/engine-session` (no commits; awaiting Codex review). Scope as in IMPLEMENTATION_PLAN.md § M02.

- **Built:** `src/core/engine/` with a driver seam (`driver.ts`; real `duckdb-driver.ts`, same-origin `bundles.ts`); `lockdown.ts` (statements, effective-state verification, escalation probes); `session.ts` (state machine, cancellable FIFO queue, session-owned revocable leases released independently of the operation body, single-settlement handles, bounded cooperative cancel then worker termination, bounded boot and recovery with no reattachment, disposal, generation, data epoch, late-result rejection, visibility reconciliation); `statements.ts` (classification); typed engine errors; `core/operations` (ids, stamps); `engineStore`/`operationStore`; `app/bootstrap.ts` (one session per page, outside React); status region driven by engine state with Retry on failure; build-time extension vendoring with SHA-256 lock; artifact gate and notices extended for engine assets (P-065, P-066); harness-only fault-injecting driver.
- **Spike defects addressed by construction (not yet independently verified):** QV-SA-005 (a never-settling operation body cannot hold the queue: tested with stand-in and real engine); QV-SA-003 (recovery reattaches nothing and is bounded; failed recovery leaves `failed` and refuses queued work).
- **ES-01…ES-12:** all pass against the real engine in Chrome, Firefox and WebKit (Playwright builds; not real Safari). ES-12: `prepare()` rejects multi-statement text without executing anything, so multi-statement Run SQL can be refused (P-064).
- **Verification (clean `npm ci`, 259 packages, extensions re-downloaded and hash-verified):** check:repo, typecheck, lint + boundary check exit 0; Vitest 114/114; build OK, `check-artifact` clean (11 files, 87,087,936 bytes); harness build OK; notices: 50 production locations, 5 tracked release-blocking items; `npm audit` 0 vulnerabilities; Playwright 117/117; mutation checks 12/12 caught (one equivalent mutant replaced by a stronger one; one test gap found and closed: the operation body now provably never sees a late result).
- **Defect found and fixed during M02:** error class names were minified in builds (`LeaseRevokedError` arrived as `Il`); names are now explicit.
- **Not done:** walking-skeleton deployment (AM-022 not approved); real Safari, real Pages, background-tab timing (bounds are foreground-only; `reconcile()` applies overdue deadlines on return); no hard memory guarantee (the engine `memory_limit` is the only enforced control).
- **Decisions for approval:** P-063 (session contract incl. session-owned cleanup), P-064 (multi-statement refusal), P-065 (artifact gate for engine assets), P-066 (tracked redistribution obligations), P-067 (engine dependency).

### 2026-11-26: M03 File Ingestion and Dataset Registry implemented (Claude Code)

Branch `feat/file-ingestion` (fast-forwarded to `main` at PR #8; no commits; awaiting Codex review). Scope as in IMPLEMENTATION_PLAN.md § M03.

- **ES-08 first:** passes in Chrome, Firefox and WebKit; the NULL policy (P-047, AM-002) is satisfiable. Further CSV probes found silent misparse and rounding with DuckDB's defaults; the chosen option set (P-068) fails malformed and ragged files and never infers DOUBLE (decimals and integers beyond int64 stay exact text — needs approval).
- **Built:** `src/core/datasets/` — `admission.ts` (extension, empty file, per-file and running combined caps from actual `File.size`, readability); `naming.ts` (P-072); `transaction.ts` (P-069); `importer.ts` (one queued operation per file: check → register a random `/qv-local/` path → own transaction → `CREATE TABLE … AS SELECT * FROM read_*` → `COMMIT` → unregister; session-owned `ROLLBACK` and file drop on any failure, cancellation or deadline; results from a replaced engine are never published); `reconcile.ts` (pure catalog merge); `registry.ts` (catalog-reconciled inventory, removal, re-import from the retained `File`). Lease extension `deferDropFile`/`forgetCleanup`, newest-first cleanup (P-070). `datasetStore`, bootstrap wiring. Deterministic known-answer fixtures generated by `scripts/fixtures/make_import_fixtures.py` (expected values written by the generator, not read back from DuckDB).
- **Architecture correction found (P-069):** a failed nested `BEGIN` aborts the user's open transaction in DuckDB v1.5.4 and a later `COMMIT` silently discards the user's work, so the specified "BEGIN and refuse on failure" would destroy data. Replaced by a side-effect-free `txid_current()` check before `BEGIN`. ARCHITECTURE §10.3/§12.4 and the M08 plan need the same change (not edited; awaiting decision).
- **Defect found and fixed during M03:** the registry returned an imported entry built before the catalog was read (state `needs-reimport`, no row count); `record()` now reconciles first.
- **Verification:** check:repo, typecheck, lint + boundary check exit 0; Vitest 144/144; build OK, `check-artifact` clean (11 files, 87,102,111 bytes); harness build OK; notices unchanged (5 tracked release-blocking items); `npm audit` 0 vulnerabilities; Playwright 186/186 in three browsers. Not re-run from a clean `npm ci` (no dependency changes in M03).
- **Manual check (field 16), throwaway spec, not kept:** a 27.7 MB, 1,000,000-row CSV generated in the page, cancelled 150 ms into the `reading` stage with no fault injection: cooperative cancel in Chrome (11 ms), Firefox (642 ms) and WebKit (52 ms); no table, no readable `/qv-local/` file, no open transaction, same engine generation; the same file then imported fully (1,000,000 rows; 153 / 676 / 192 ms). Which statement the cancel interrupted was not instrumented.
- **Not done / not verified:** real Safari; real GitHub Pages; very large files and memory behaviour (no large-memory runs, by instruction); the kept automated cancel tests hold `CREATE` in a harness fault rather than cancelling a long-running statement; unreadable-File re-import in a real browser (stand-in engine only); background-tab timing.
- **Decisions for approval:** P-068 (CSV options; decimals as text), P-069 (transaction-detection correction), P-070 (lease extension), P-071 (registry contract), P-072 (naming).

### 2026-11-26: M08 Verdict Analysis Engine (headless) implemented (Claude Code)

Branch `feat/verdict-engine` (fast-forwarded onto `origin/feat/file-ingestion`, maintainer decision; no M08 commits; awaiting Codex review). Scope as in IMPLEMENTATION_PLAN.md § M08.

- **Built (`src/core/verdict/`):**
  - `parser-adapter.ts`: versioned for v1.5.4; lossless.
  - `recognise.ts`: strict per-field allowlist.
  - `relations.ts`: catalog eligibility inside the lease.
  - `qualify.ts`: keys, types, input rows and the grouping estimate, all before grouping.
  - `budget.ts`: the single gate.
  - `probes.ts`: tagged probes through the lease.
  - `stats.ts`: ported.
  - `expectations.ts`, `findings.ts`.
  - `report.ts`: the draft and the publication fence.
  - `service.ts`: one `verdict` operation; deadline including queue wait.
  - Also: `src/core/util/lossless-json.ts` (ported, hardened against duplicate and prototype keys); `src/stores/reportStore.ts` (current or historical); runtime wiring in `src/app/bootstrap.ts` (no UI); `harness/verdict.ts` with driver-level statement trace, inject-before and after-statement hooks.
- **Oracle and fixtures:**
  - `tests/oracle/` holds an independent nested-loop Python oracle that also derives witnesses, finding codes and expectation outcomes, with its own unit tests.
  - `scripts/fixtures/make_verdict_fixtures.py` generates 155 cases (35 named plus 120 seeded random, seed 20261125). They cover INNER and LEFT, composite keys, NULL components, empty sides, skew, keys beyond 2^53 up to UHUGEINT, quoted identifiers, USING, self-joins and invalid expectations.
  - The parser corpus has 17 accepted, 54 refused and 3 failure queries, recorded from the engine and re-verified in all three browsers.
- **Results:**
  - All 155 cases match the oracle and DuckDB's own `count(*)` exactly, in three browsers.
  - The QV-SA-001 and QV-SA-002 regressions pass, with evidence in SQL_ANALYSIS_FINDINGS §5.0 (fixed in production, pending independent review).
  - 24 of 24 Verdict mutants are caught. Seven first versions did not typecheck; they were rewritten and rerun and were never counted as caught.
- **Defects found and fixed during M08:**
  - the recogniser's shape check reported only the first mismatch (now all);
  - a refused witness plan could have recorded cheap witnesses as approved (`deny` added).
  - FROM-first syntax was reclassified as accepted, because the parse tree is identical.
- **Observations for the maintainer:**
  - **M02 latent hazard:** `Lease.cleanup(sql)` removes the deferred entry *before* running it, so a statement interrupted during an explicit `cleanup()` would not be retried by the session. No M02, M03 or M08 code path calls `cleanup()` (Verdict leaves `ROLLBACK` to the session), so nothing is affected today. Recommend a fix and regression test in a follow-up.
  - The unqualified-engine refusal in the parser adapter is unit-tested only, because M02 boot already refuses unqualified engines.
- **Not done / not verified:**
  - real Safari; real GitHub Pages;
  - performance at the qualification ceiling (no large workloads, by instruction);
  - the manual field-16 checks (reading three reports end to end against PRD §4 wording);
  - background-tab timing;
  - an independent review of the oracle.
- **Decisions for approval:** P-073 (architecture), P-074 (budget semantics), P-075 (witness probes), P-076 (findings and statuses), P-077 (recogniser boundary, self-joins, P-069 in Verdict), P-078 (expectation validation).

### 2026-11-27: M04 Dataset Explorer and Inspector implemented (Claude Code)

Branch `feat/dataset-explorer` (from `main` at PR #10; no commits; awaiting Codex review). Scope as in IMPLEMENTATION_PLAN.md § M04.

- **Built:**
  - `src/features/explorer/`: explorer layout and drawer, dataset tree, import dialog, inspector with the Schema and Preview tabs, dataset actions with remove confirmation, and pure `model.ts`.
  - `src/ui/`: Tree (disclosure list), Badge, FileInput (native picker plus drop zone), Table (NULL and empty-string tokens, cut-text markers, focusable scroll region), Tabs, and a wide Dialog variant.
  - `src/core/results/`: bounded result types, limit planning and the `preview` operation.
  - `src/stores/`: `importStore`, `previewStore`, `announcer`.
  - Runtime wiring in `bootstrap.ts`; App shell with the explorer; styles in `src/styles/explorer.css` (tokens only).
  - A harness `?view=app` view (real App, runtime exposed, optional import limits); test-only.
  - `OperationKind` gains `preview`. No new dependencies.
- **Behaviour:**
  - Every registry state has a text label: Ready, Importing (from the importer's progress), Needs re-import, Removed by SQL, Changed, Failed. Origins are Imported, Created by SQL, Demo.
  - Selection, disclosure and tab switches never start engine work; a preview starts only on **Preview** / **Preview first rows** (verified from the driver's statement trace). Previews are bounded by the engine and stale after any data, engine or identity change (P-080).
  - Import review previews the M03 admission and naming rules; the importer remains authoritative (P-081).
  - The single status region announces outcomes (P-082).
- **Verification:**
  - check:repo, typecheck, lint and boundary check exit 0;
  - Vitest 319/319; Python oracle OK;
  - build OK, `check-artifact` clean (11 files, 87,199,458 bytes; app JS 542 KB, 153 KB gzip; CSS 15.5 KB);
  - harness build OK; notices unchanged; `npm audit` 0 vulnerabilities;
  - Playwright 375/375 in three browsers.
  - UX-002 is demonstrated keyboard-only in the production build. Option+Tab in WebKit is a Safari platform default.
- **Defects found and fixed during M04:**
  - focus was not restored after removal in WebKit;
  - focus returned to a removed opener after the first import;
  - the layout did not fill the window;
  - the engine-internal virtual path appeared in import errors;
  - duplicated "file the file" wording.
- **Known issue (P-083):** Playwright's Firefox 159 build crashes the page's content process in some test-tool operations (axe in certain explorer states; a synthetic drop resolved by text inside the modal). Root cause not determined. Functional tests pass in Firefox; axe for the explorer runs in Chromium and WebKit.
- **Limitations:**
  - After a later import or any data change, earlier row counts show as "Not measured" (the M03 registry withholds counts from an older epoch, P-071).
  - Views cannot be previewed.
  - "Removal of a table referenced by the current query" and "editor text preserved" (UX-002) cannot be shown until the M05 editor exists.
  - 200 % zoom is covered by narrow-viewport emulation (800 px and 320 px), not by actual browser zoom.
- **Not verified:** VoiceOver and NVDA (not run; no assistive-technology session was available to the implementer), real Safari, real Firefox outside Playwright, forced-colours mode, real GitHub Pages.


### 2026-11-27: M04 corrections after the Codex review, and visual pass (Claude Code)

Codex review: CHANGES REQUIRED (3 HIGH, 3 MEDIUM, 1 LOW, all reproduced). All seven corrected (P-084), each with a regression test:

- **HIGH, Remove dropped the wrong table when two schemas shared a name.** Removal now carries the exact identity of the selected entry and re-checks it inside the operation; a bare ambiguous name is refused. Shared names are shown with `database.schema` and copied fully qualified. Real-engine test: `aaa.same` and `bbb.same`; selecting `bbb` drops only `bbb`.
- **HIGH, the combined import limit was bypassed by overlapping batches and by re-import.** It is now enforced inside each import operation, before registration, against what the engine holds (P-081). Stand-in tests (overlap, re-import after restart) and a real-engine UI test (10-byte limits, two 8-byte files, held first import, then a re-import) pass; removing the check makes the stand-in tests fail.
- **HIGH, Preview exceeded the Arrow byte budget.** The planner now counts the sentinel row and Arrow overhead, can plan zero rows, and reduces columns. The driver enforces `maxBytes` on Arrow buffers before conversion and on converted text (P-080). Real-engine test: a 32-byte budget reads nothing and explains why; the driver refuses an over-budget result.
- **MEDIUM, Cancel and outcomes were lost after closing the dialog.** Batches stay until dismissed, the dialog reopens on their progress, and the sidebar offers **Show import progress**; `File`s are released once imported. Tested through the UI.
- **MEDIUM, nullability was discarded.** The registry decodes DuckDB's BOOLEAN `is_nullable`; the schema shows Nullable Yes/No. Real-engine test.
- **MEDIUM, focus was lost.** Starting an import focuses **Import progress**; selecting in the narrow drawer focuses the inspector heading. The UX-002 test now walks the whole path by keyboard with no programmatic focus between steps (Option+Tab in WebKit, a Safari default).
- **LOW, a blank name silently fell back to the default.** It is now an error.
- **Wording:** "unordered preview" with the limits actually enforced; P-080 no longer claims no large value is materialised (CAST before `left()` is documented).

**Visual pass (existing tokens only; no dependencies, gradients or animation):**
- compact 30 px sidebar rows, with selection shown by a 2 px accent bar plus raised background (Codex measured the old selection at 1.12:1);
- a dataset count;
- an inspector title bar with one metadata line instead of a four-column fact grid;
- 28 px secondary actions, with Remove as a quiet destructive action set apart;
- one **Refresh** in the preview bar instead of repeated "Preview again" buttons;
- tables with sticky headers, row hover, and right-aligned tabular numerics;
- an import dialog with an integrated drop area, inline table-name fields and a footer bar.

**Second visual pass (maintainer feedback on the sidebar disclosure arrow):**
- the text arrow glyph is replaced by a 12 px stroked SVG chevron that rotates 90° when expanded, with a 120 ms transition only under `prefers-reduced-motion: no-preference`;
- 20 px toggle target with hover state; tree focus rings drawn inset so they are not clipped;
- expanded details indented under a guide line aligned with the chevron;
- fixed a 16 px horizontal page overflow at 390 px caused by screen-reader text inside NULL tokens (`.table-scroll` now contains it); verified with scrollWidth 390;
- numeric cells no longer wrap;
- the schema table has a hidden caption and no row numbers;
- the inspector metadata is spaced with gaps instead of "·" separators;
- at desktop sizes the sidebar and the inspector scroll independently.

Checked in light and dark themes from 2× screenshots.

Recommendations that would change the design system are recorded for M14 (P-085), not applied.

**Verification after both visual passes (same commands, rerun):**
- check:repo, typecheck, lint and boundary check exit 0;
- Vitest 326/326; Python oracle OK;
- build OK, `check-artifact` clean (11 files, 87,208,340 bytes; CSS 19.6 KB);
- harness build OK; notices unchanged; `npm audit` 0 vulnerabilities;
- Playwright 387/387 in three browsers (10.4 min).

**Verification after corrections (before the second visual pass):**
- check:repo, typecheck, lint and boundary check exit 0;
- Vitest 326/326; Python oracle OK;
- build OK, `check-artifact` clean (11 files, 87,207,359 bytes; app JS 546 KB, 155 KB gzip; CSS 18.8 KB);
- harness build OK; notices unchanged; `npm audit` 0 vulnerabilities;
- Playwright 387/387 in three browsers.

**UX-002 status:** the keyboard path from picker to inspector, invalid files, mixed outcomes, duplicate names, removal and post-restart re-import are verified in three Playwright browsers. Editor-text preservation, and removal of a table used by the current query, await M05. Full UX-002 therefore remains partially verified.

**Still not verified:** VoiceOver and NVDA, actual 200 % browser zoom (narrow-viewport emulation only), forced colours, standalone Firefox and Safari, live Pages. Arrow wire size and peak memory of a preview are bounded by construction and the driver check, not measured.

### 2026-11-27: M05 SQL Workspace and Editor implemented (Claude Code)

Branch `feat/sql-workspace` (from `main` at the M04 merge, PR #11), uncommitted, awaiting Codex review. Prerequisites M01–M04 and M08 are merged.

**E9 editor qualification (first step; FEASIBILITY §15, P-052):**
- CodeMirror 6 and Monaco 0.58 were measured with the production Vite configuration, base path and CSP. The harness and raw results are in `docs/evidence/e9-editor/`.
- Both passed the E9 criteria. Monaco escapes Tab only through its Ctrl+Shift+M toggle.
- **CodeMirror 6 was selected** under the smaller-bundle rule: +335 KB raw / +108 KB gzip, against Monaco's +3.55 MB / +934 KB.
- Monaco was never installed in the application.
- **P-052 awaits maintainer approval.**

**Workspace (P-086–P-089):**
- **Layout:** a header with Shortcuts and Settings, the datasets sidebar, the editor above the output panel (Results, Verdict, Dataset), and the status strip.
- **Explorer:** the M04 explorer is integrated through a `useExplorer` hook, with the registry still the only source of dataset state. The inspector is the Dataset view.
- **Dividers:** two keyboard- and pointer-operable dividers following the window splitter pattern, with layout presets in Settings.
- **Responsive:** responsive at ≥ 1200, 900–1199 and < 900 px (drawer and view tabs).
- **State:** a session-only `workspaceStore`.
- **Editor:** DuckDB SQL highlighting from the design tokens, line numbers, a wrap toggle, undo and redo, and no Tab capture.
- **Run SQL and Analyze** (Mod+Enter, Mod+Shift+Enter) are editor-scoped and distinct. They say plainly that nothing was sent to the engine (P-087); execution and Verdict UI belong to M06 and M09.
- **Shortcuts:** a dialog lists only the supported bindings.

**Maintainer feedback, fixed:**
- The focus border was hidden by the gutter.
- At soft-wrap points, Left and Right skipped a caret position. The caret is now drawn by CodeMirror, and wrap-aware arrows reach every position in both directions.
- The placeholder is now "Write a SQL query", and the Run icon was redrawn.
- The selection colour is derived from tokens and keeps every SQL colour at 4.55:1 or more; the active line is marked in the gutter only.

**Other defects found and fixed during M05:**
- Undo merged an external text change with the user's typing.
- Where the two dividers meet, the horizontal divider's hit area covered the vertical one.
- The narrow editor toolbar split its actions across lines.

**Tests:**
- New suites:
  - `tests/e2e/workspace.spec.ts` (20 tests after the Codex corrections);
  - `tests/e2e/editor-a11y.spec.ts` (10 tests, of which IME and forced colours run in Chromium only);
  - `tests/unit/workspace/` (9 tests);
  - a test-only `?view=editor` harness fixture for the `SqlEditor` contract.
- Updated tests: the skip link now targets the editor (UI_SPECIFICATION §4), and the narrow explorer test imports through the drawer.
- **Mutation checks** (each caught):
  - binding Tab (`indentWithTab`);
  - routing Analyze to Run;
  - removing the wrap-aware arrows.

**Verification (final code):**
- check:repo, typecheck, lint and boundary check exit 0.
- Vitest 335/335; Python oracle OK.
- Build OK and `check-artifact` clean: 11 files. App JS is 895.0 KB raw / 269.4 KB gzip (+348.4 / +114.7 KB against M04); CSS is 24.8 KB.
- Harness build OK. Notices: 64 package locations, 5 release-blocking items (unchanged). `npm audit` 0 vulnerabilities.
- **Playwright 455 passed, 4 skipped, 0 failed** in Chrome 158.0.8127.37, Firefox 159.0 and WebKit 27.2 (13.1 min). The skips are the two Chromium-only tests in Firefox and WebKit.

**Not verified:**
- VoiceOver and NVDA (manual, M05 field 16).
- IME outside Chromium's DevTools protocol, and IME with a real input method.
- Windows forced colours (Chromium emulation only).
- Real 200 % browser zoom (a half-size viewport was used).
- Live GitHub Pages.
- Axe in Firefox (P-083).

### 2026-11-27: M05 corrections after the Codex review (Claude Code)

Codex review: CHANGES REQUIRED, with six MEDIUM findings and one LOW, all reproduced. All seven corrected (P-091), each with a regression test and a mutation check. Codex verdict for E9: partially verified.

- **MEDIUM, action chords on focused buttons (Firefox).** A focused Analyze ran on Cmd+Enter. The chords are now blocked outside the editor; plain Enter and Space still activate. Tested on both buttons with both chords in all three browsers. Removing the guard fails the Firefox test.
- **MEDIUM, crossing 900 px hid the focused editor.** The narrow view now follows the focused pane, and focus moves to the visible equivalent of a control that disappears. Tested in both directions, from the editor and from an output tab.
- **MEDIUM, output tab semantics and narrow feedback.** Narrow tabs now reference the `tabpanel`, the panel is focusable, and the Run/Analyze notice appears beside the actions at 320 px while focus stays on the trigger.
- **MEDIUM, external text reset the caret.** Only the differing span is replaced (`src/features/editor/textDiff.ts`, unit-tested and surrogate-safe). The regression reads the editor's own cursor report. A first version of the test, which read the caret through typing, passed under the mutation and was strengthened.
- **MEDIUM, E9 timing method.** Re-run with:
  - fresh identical documents per trial, and an asserted caret offset;
  - exact typed text, and one validated real paste per trial (7 trials, 0 failures);
  - emitted and fetched assets reported separately;
  - the harness lockfile committed.

  FEASIBILITY §15 and P-052 were rewritten; status: partially verified.
- **MEDIUM, a second touch could take over a drag.** Drags now track their `pointerId`. The first version of the test passed under the mutation for two reasons:
  - Chrome's touch adjustment moved a contact near the divider junction onto the other divider;
  - the second finger missed the moved divider.

  Corrected; the mutation now fails the test (294 px against 234 px).
- **LOW, bounds and reset.** The output minimum now excludes the divider rule (exactly 160 px). The sidebar default is breakpoint-aware for the initial layout and every reset (224 px at 900–1199 px). Dividers are named by the pane headings (**Datasets**, **Query**).
- **Also:**
  - P-088's caret claim is scoped to the verified inputs; bidirectional text keeps CodeMirror's default traversal;
  - the header context label no longer wraps;
  - the trailing blank line in FEASIBILITY was removed.

**Verification after corrections (final code):**
- check:repo, typecheck, lint and boundary check exit 0; `git diff --check` clean.
- Vitest 339/339 (4 new `textDiff` tests); Python oracle OK.
- Build OK and `check-artifact` clean: 11 files, 87,564,333 bytes. App JS is 897.0 KB raw / 270.2 KB gzip (+350.4 / +115.4 KB against M04); CSS is 25.2 KB.
- Harness build OK. Notices: 64 package locations, 5 release-blocking items (unchanged). `npm audit` 0 vulnerabilities.
- **Playwright 471 passed, 6 skipped, 0 failed** in Chrome 158.0.8127.37, Firefox 159.0 and WebKit 27.2 (12.8 min). The skips are the Chromium-only IME, forced-colours and touch tests in Firefox and WebKit.
- **Mutation checks** (each caught by its test):
  - the chord guard;
  - pointer ownership;
  - the whole-document replacement;
  - breakpoint focus continuity;
  - the non-focusable tab panel.

  Earlier mutation checks (Tab binding, Analyze routed to Run, wrap-aware arrows) still apply.

### 2026-11-27: M05 CI fix (PR #12, Linux runner) (Claude Code)

The PR's `browser` job failed (run 45966025588); `verify` and `build` passed. Two causes, neither visible on macOS:

- **Header overflow (9 tests, all browsers).** At 320 px, the wider Linux fonts gave an 18 px horizontal scroll. The cause was the header row, which could not wrap after the context label was made non-wrapping. The header now wraps its actions onto their own line; locally no overflow was observed down to 280 px.
- **Shortcut labels (1 test, WebKit).** Playwright's WebKit on Linux reports a Mac user agent with a Linux `navigator.platform`. The labels followed the user agent and showed ⌘ while CodeMirror bound Ctrl. Platform detection now uses `navigator.platform`, the signal CodeMirror uses for its Mod key, falling back to the user agent only when the platform is empty. Unit test added.

Local rerun of the affected suites (editor-a11y, shell, explorer, workspace) in Chrome, Firefox and WebKit: 162 passed, 6 skipped by design. CI re-run pending.

### 2026-11-27: M06 Query Execution and Results implemented (Claude Code)

Branch `feat/query-results` (from `main` at the M05 merge, PR #12), uncommitted, awaiting Codex review. Prerequisites M01–M05 and M08 are merged.

**Execution (P-092):**
- `src/core/query/runner.ts` runs Run SQL as one `query` operation through the session's queue and revocable lease. There is no new connection, and no deadline (ARCHITECTURE §12.1).
- Classification uses DuckDB's parser, then `prepare()` (executes nothing).
- **A single SELECT** is read as DuckDB's own text through an outer projection with `CAST`/`left()` and `LIMIT maxRows + 1`. Names and types come from `DESCRIBE`. The terminator is removed only if the parse tree is identical without it. The epoch is unchanged.
- **Other statements** run unchanged, with their result streamed and bounded. The epoch advances once a statement was sent, even if it failed or was cancelled.
- Affected rows come from DuckDB's `Count` row.
- Errors are labelled Syntax, Binding, Runtime or Engine.
- The lockdown was re-verified through Run SQL: remote reads, `ATTACH`, `COPY`, `LOAD` and `SET` are refused, and no request left the page.

**Snowflake-style running (P-097, maintainer request; revises AM-004/P-064 for the editor):**
- Cmd+Enter and Run SQL run the statement at the cursor, or every statement in a selection, in one operation, and show the last result.
- Splitting uses a quote- and comment-aware lexer, and DuckDB's parser checks every piece before any runs.
- The first error stops the run and names its statement.
- The gutter marks the statement that will run.

**Exactness (P-093):**
- SELECT values are exact for every type (verified against hand-written known answers).
- Other statements' results show only types whose Arrow form is unambiguous; the rest are explicit "not shown" cells.
- The probe behind this is in FEASIBILITY §16.4.

**Bounds (P-094):**
- `ResultCollector` checks each batch's bytes before converting it, then applies the row, column, cell (code points; a bounded UTF-8 prefix only), display (whole rows) and byte bounds.
- Every cause is reported separately.
- The lease and driver gain `stream()`; Verdict's budgeted lease refuses it.
- The one-batch allocation limit is documented.

**UI (P-095, P-096):**
- **Query store:** a newer run supersedes the previous one, and late results never publish. Elapsed time is labelled as the page clock. Results are marked Historical after an edit, a data change or an engine restart, and a "Transaction may be open" hint appears after BEGIN.
- **Results panel:** summary, truncation notes, display-order wording, error and refusal states, zero rows, and Cancel next to Run SQL.
- **Grid and detail viewer:** a bounded cell-detail dialog, and a **row- and column-windowed grid**.

**R1 (FEASIBILITY §16, P-096):**
- The plain table failed the Chromium target, with long tasks up to 721 ms at 1,000 × 200.
- The final windowed grid's longest Chromium task was 113 ms, Firefox and WebKit stayed at or under 133 ms, and typing stayed at or under 61 ms (re-measured after the Codex M06 corrections).

**Defects found and fixed during M06:**
- Column windowing ignored each column's 1 px rule, leaving a band of about 200 px unrendered at the far right of 200 columns.
- Arrow's `get()` reports `inf`/`nan` as `null`, which is why the Arrow formatter was not used for SELECT results.
- R1's first long-task support check was wrong in Firefox and WebKit.
- R1's first 3-run sets overlapped other work on the machine. They were discarded and re-measured.

**Tests:**
- `tests/unit/query/{runner,sqlText,split}.test.ts`
- `tests/unit/results/{arrow,collect}.test.ts`
- `tests/e2e/query.spec.ts`: real engine, known answers, every bound, policy, lockdown, cancellation, recovery, registry, Verdict invalidation and rapid re-runs.
- `tests/e2e/results-render.spec.ts`: UX-003, Snowflake-style running, detail viewer, windowing and gaps, T-ENG-009c long tasks, axe, network, narrow layout, historical labels, transaction hint, Cancel.
- M05 tests updated where Run SQL now executes.

**Verification (final code, after the Codex corrections; quiet machine, load ≈ 5):**
- check:repo, typecheck, lint and boundary check exit 0; `git diff --check` clean.
- Vitest 404/404; Python oracle OK.
- Build OK and `check-artifact` clean: 11 files, 87,599,866 bytes. App JS is 929.0 KB raw / 280.7 KB gzip; CSS is 28.7 KB.
- Harness build OK. Notices: 64 package locations, 5 release-blocking items (unchanged). `npm audit` 0 vulnerabilities.
- **Playwright 559 passed, 8 skipped, 0 failed** in Chrome 158.0.8127.37, Firefox 159.0 and WebKit 27.2 (17.3 min). The skips are the four Chromium-only tests (IME, forced colours, touch, Long Tasks API), each in Firefox and WebKit.

**Not verified:**
- VoiceOver and NVDA on the grid (manual).
- Real Safari: WebKit timings are Playwright's, and headless.
- Real 200 % zoom.
- Windows High Contrast.
- Live GitHub Pages.
- Axe in Firefox (P-083).
- Engine memory during a query.

### 2026-11-27: M06 corrections after the Codex review (Claude Code)

Codex review: CHANGES REQUIRED, with six HIGH findings and three MEDIUM, all reproduced. All are corrected (P-098), each with a regression test.

- **HIGH, exact text changed silently.**
  - A leading U+FEFF was dropped by the WHATWG decoder default; it is now kept, in results and engine-internal reads.
  - ENUM values from `RETURNING` showed as empty strings. DuckDB-WASM streams them with an empty dictionary, so they are now an explicit "not shown" (verified in Chrome).
  - Missing or inconsistent buffers are never shown as empty text.
  - Booleans respect the cell limit.
- **HIGH, clipped affected-row counts.** The count is read from DuckDB's own Int64 value before display bounds, only with full provenance, and kept as integer text (15 rows reported as 15 with a 1-character cell limit).
- **HIGH, misleading outcomes for partial batches and cancellation.** Runs carry structured progress:
  - "Nothing was run" appears only when nothing was sent.
  - A partial batch says how many statements completed and that their changes were applied.
  - A cancelled, already-sent statement says its changes may have been applied.
  - BEGIN followed by an error keeps the transaction hint.
- **HIGH, current publication after a stale epoch.** Results carry their epoch; the store checks it and the generation at publication. A change injected between settlement and publication now shows the result as Historical.
- **HIGH, unconfirmed stream stops.** An early stop must be confirmed within the cancel grace, or the engine restarts. Rejected and hanging stops were tested in unit tests and against the real engine. Statements other than SELECT are never stopped early.
- **HIGH, effectful SELECTs.** SELECTs calling `nextval`, `setseed` or a user macro are evaluated in full, without pruning or a row limit. `nextval` after a 3,000-row SELECT shown with one column now returns 3001.
- **MEDIUM, results UI.**
  - Zero rows returned is distinguished from rows withheld; small limits show in bytes; the copy says what was kept.
  - A run that starts at once shows Running.
  - Focus moves to Run SQL when Cancel disappears, and to the grid when a focused detail button leaves the window.
  - The editor content carries `tabindex="0"` for axe.
- **MEDIUM, PIVOT and browser tests.**
  - The PIVOT note now suggests the verified `PIVOT … ON b IN (…)` form (a dynamic PIVOT is several statements even when wrapped).
  - Two browser tests used the old string API.

**Found while fixing:**
- WebKit's fixed table layout ignored `<col>` widths across spanning spacer cells, and columns drifted by thousands of pixels. The grid now uses one spacer column per hidden side and pixel widths.
- Two new tests raced the product: Cancel before the statement was sent, and a byte limit larger than the value. Both tests were corrected; the product behaviour was right.

**R1 re-measured on the final grid:** Chromium longest long task 113 ms (target 200 ms); Firefox and WebKit at or under 133 ms; typing at or under 61 ms.

### 2026-11-27: M09 Verdict Report and Visual Verdict implemented (Claude Code)

Branch `feat/visual-verdict` (from `main` at the M06 merge, PR #13), uncommitted, awaiting Codex review. Prerequisites M04, M05, M06 and M08 are merged. Started on the maintainer's M09 instruction of 2026-11-27.

**What was built (P-099):**
- Analyze is connected: the M05 button and Cmd/Ctrl+Shift+Enter submit the whole query buffer and the declared expectations, in order, to the M08 `VerdictService` as one `verdict` operation on the shared session queue. `src/stores/analysisStore.ts` tracks only that operation; a new Analyze supersedes the previous one, and a per-request sink lets only the latest request publish, inside the fence's synchronous hand-off. Cancel analysis sits next to Analyze (and in the full view); focus moves to Analyze when it disappears. Run SQL and Analyze stay independent.
- `src/features/verdict/`: `VerdictPanel` (fixed reading order), `JoinOverview` (Left and Right inputs → join with type, key condition, key type, matching key groups, whole-input and matched-key relationships → output rows and matched pairs; each input states matched rows, unmatched rows kept or dropped, and rows multiplied with excess copies; a row-accounting table by input in a disclosure), `Findings`, `ExpectationsEditor` (outcomes and authoring), `Witnesses` (≤ 5 per kind, ≤ 15 rendered, filter tabs, NULL-key totals separate, "No sample keys for this check" with the report's counts), `Coverage` (checked, outside coverage, authority, reasons, disclaimer, identity disclosure), `VerdictStates` (no analysis, queued, analyzing, cancelling, engine notices, historical strip, state notices), and `model.ts` (labels and grouping only).
- Full-width view (wide screens): the editor stays mounted; Back to SQL focuses the editor with its selection kept; Results are kept.
- Join-key profile: a "Join keys" tab in the M04 inspector (`src/features/explorer/JoinKeyProfile.tsx`), from the current report only, matched by catalog identity and side; it never runs SQL.
- Styles: `src/styles/verdict.css` (existing tokens only; container query stacks the join at narrow widths; forced-colour outlines).

**Currency (P-100):** the report store now also compares the editor text and the declared expectations; editing either makes the report historical, and a data change keeps it historical even if the SQL text is restored. A run that never reached the engine is labelled as such. This is an additive change to M08's `currency` and `reportStore`.

**Presentation (P-101, P-103):** M08's categories, labels and confidence are rendered unchanged; historical reports are entirely neutral and labelled historical; "No issues found in these checks" only for a current authoritative report without warnings or violations. Expectations are validated by the core's `invalidExpectation` before they are stored; field errors are announced at their controls.

**Contradictions reported, not resolved (P-102):** row loss alone is an observation in M08 but a warning in the mockup (AM-011a); Analyze uses the whole buffer per UI_SPECIFICATION §4 while Run SQL uses the statement at the cursor (P-097); View diagnostic SQL / Copy summary depend on M12 and are not shown.

**Verification (local, 2026-11-27, Apple M2 / 8 GB):**
- typecheck, lint (boundaries OK), check:repo OK; `git diff --check` clean.
- Vitest 453/453 (49 new in `tests/unit/verdict-ui/`: golden reports built with the real M08 functions and rendered with `react-dom/server`, presentation model, stores and currency). Python oracle 7/7 OK.
- Mutation checks, 8 of 8 caught: superseded analysis publishing, historical findings keeping their tone, editor text not compared, expectation edits not compared, healthy summary without authority, historical outcomes shown as current, witness bound removed, unchecked shown as held.
- Build: JS 979.6 KB raw / 295.0 KB gzip (M06: 929.0 / 280.7), CSS 42.1 KB; check-artifact OK (11 files, 87,663,829 bytes); harness build OK; notices 64 locations, 5 release-blocking (unchanged); npm audit 0 vulnerabilities.
- Playwright, full suite (Chrome 158, Firefox 159, WebKit 27.2): 602 passed, 8 skipped by design, 8 failed — all 8 in Firefox, all "Page crashed". Reproduced: the crash happens in Playwright's axe and `allInnerTexts` paths in its Firefox 159 build (P-083); with axe skipped in Firefox (as in M04–M06) and cell text read through the DOM, the page stays alive and every assertion passes. Re-run of the affected specs (verdict-ui, workspace, query, explorer, editor-a11y, verdict-fence) in all three browsers on the final code: 267 passed, 6 skipped, 0 failed.
- `tests/e2e/verdict-ui.spec.ts` (17 tests × 3 browsers): UX-004 with the illustrative fixture (every mockup count, both sides' loss), the golden flows, rapid analyses, T-ENG-010a/c, join-key profile, full view and Back to SQL, keyboard, expectation validation, narrow and 200 % zoom layouts, network isolation; axe in every report state in both themes (Chromium and WebKit).
- Not verified: VoiceOver, NVDA, real browser zoom, Windows forced colours, a real (non-Playwright) Firefox for the crash above.

### 2026-11-27: M09 corrections after the Codex review (Claude Code)

All six findings were reproduced and corrected (P-105); each has a regression test, and the three new presentation gates have mutation checks (3 of 3 caught).
- **HIGH:** a report that turns historical during the final hand-off is now announced as historical, and the narrow summary says Current or Historical.
- **HIGH:** violation, warning and held tones and wording appear only for a current AND authoritative report; a partial report reads "Violated · not authoritative" as limited evidence.
- **MEDIUM:** the Verdict view has its own Cancel analysis wherever the editor's is not on screen; focus goes to the Verdict heading after cancelling when Analyze is hidden.
- **MEDIUM:** measured row loss withholds "No issues found in these checks" and stays visible; the category is unchanged (P-076; AM-011/P-102 still open).
- **MEDIUM:** a field error is attached before focus moves, and every refused declaration is announced.
- **LOW:** an empty witness panel is reachable by Tab.

**Verification (local, 2026-11-27):** typecheck, lint, check:repo OK; Vitest 457/457; Python oracle 7/7; build OK, check-artifact OK; Playwright full suite in Chrome, Firefox and WebKit: **625 passed, 8 skipped, 0 failed** (17.8 min). Axe in Firefox stays skipped (P-083). Not verified: VoiceOver, NVDA, real 200 % zoom, Windows forced colours, real (non-Playwright) Firefox.

### 2026-11-27: Verdict answer rewrite and test datasets (Claude Code)

At the maintainer's request (P-106), every report now opens with an **answer** a non-expert can read in seconds: one headline, what it means for the user's result, and at most two next steps. Built only from the published report and the report store's currency; categories, authority and currency unchanged.
- **Unsupported queries:** one primary reason by priority (several statements > not a SELECT > no join > more than one join > input > join type > key > clause), named in plain words ("No join to analyze: this query reads a single table."; "Verdict cannot check the aggregation, but the join underneath it is where counts and sums get inflated."), with concrete next steps and an "Also outside the checks" list. No overview, witnesses or expectation editor when there is no join.
- **Complete analyses:** told from the FROM table ("The result has 33 rows from 30 orders rows: 2 orders rows appear more than once (3 extra rows); …"), a **row fate** table per input, **Why** with real sample keys and counts, what it means for totals, and conditional fixes (reduce the other table to one row per key; LEFT JOIN to keep rows). The answer tone follows the core's categories (violation, suspicious pattern, otherwise informational).
- Failures, incomplete, cancelled, partial and historical states each have their own headline; internal terms stay out of the main view; everything else is in one collapsed Details.
- **Page scroll fix:** screen-reader-only text inside the report was absolutely positioned without a positioned ancestor, so long reports extended the page and the workspace shifted when Analyze finished. The output view, the full view and the report now contain it; a browser test checks the page height is unchanged through seven analyses.
- **Row counts (P-107):** the sidebar showed a row count only for the last imported table, because every import advanced the data epoch. An import now carries forward counts that were exact just before it; SQL changes still hide them.
- **`test_datasets/`:** `customers.csv`, `orders.csv`, `payments.csv` (30 rows each, synthetic) and a README with 7 join scenarios, 7 rules and 9 unsupported or failing queries. The expected counts were computed by brute force from the CSV rows; a browser test imports the three files through the real dialog and checks every scenario's row fate against the engine.

### 2026-11-28: M10 Operation Status, Recovery UX and Release Profile implemented (Claude Code)

Branch `feat/operations-recovery-ux` (from `main` at the M09 merge, PR #14), uncommitted, awaiting Codex review. Started on the maintainer's M10 instruction. Decisions P-108 to P-112.

**Built:** labelled operations in the one operation store (P-108); one cancellation path, `session.cancel(id)` (P-109); status-strip operation line with elapsed time and Cancel, outside the live region; Operation details dialog (engine, queued and running operations with the reason they wait, recent outcomes, transaction explanation, configured limits from the release profile, background-tab note); RecoveryNotice with re-import per lost file, SQL tables to recreate and Retry (P-110); background-tab reconciliation announced once (P-111); Run SQL and Analyze disabled while the engine has failed or stopped.

**Defects found and corrected (P-112):** ROLLBACK could not run after an error inside a transaction (M06 runner; the user was stuck until a restart); a queued analysis that never reached the engine was labelled historical; a queue-wait refusal read as a failed check; disposal read as an engine restart.

**PRD §5 state matrix → tests:**

| Row | Test evidence |
|---|---|
| Starting or recovering | `recovery-ux` (recovery during Run SQL: editor text kept, nothing re-run); `engine-lifecycle` (fail-closed boot); unit `operations` (queued reason "Waiting for the engine to recover") |
| Importing, running or analyzing | `operations` UX-005 (action and identity labels, queued vs active, Cancel reachable by keyboard, nothing announced per second) |
| Invalid file, unsupported browser, boot or policy failure | `engine-lifecycle` (each failed control blocks ready; Retry), `imports`/`explorer` (invalid files, M03/M04), `recovery-ux` failed recovery |
| SQL syntax, binding or execution failure | `query` (M06 errors by phase), `verdict-ui`/`verdict-answer` (query failures; prior report historical) |
| Unsupported diagnostic, invalid expectation or cutoff | `verdict-answer`, `verdict-ui` (M09), `operations` time limits (queue wait, Verdict deadline) |
| User cancel, timeout, replacement or disposal | `operations` (queued and active cancel, repeated and concurrent cancel, ignored cancel → restart, time limits), `recovery-ux` (disposal; stalled RPC), unit `operations` (background-tab reconcile) |
| Recovery succeeds after termination | `recovery-ux` (stale run, historical report, discarded preview, re-import from the notice, SQL tables to recreate, re-import failure) |
| Recovery fails or resource ceiling is reached | `recovery-ux` failed recovery and fail-closed Retry; `verdict-budget`/`verdict-ui` budget refusal (M08/M09); `imports` admission limits (M03) |

**Verification (local, 2026-11-28):** typecheck, lint, check:repo OK; Vitest 510/510; Python oracle 7/7; build JS 1,026.3 KB raw / 308.5 KB gzip (M09: 982.0 / 295.7), CSS 47.3 KB; check-artifact OK (11 files, 87,715,820 bytes); harness build OK; notices 64 locations, 5 release-blocking (unchanged); npm audit 0 vulnerabilities. Full Playwright run (Chrome, Firefox, WebKit, 24.3 min): 684 passed, 8 skipped, 4 failed — all four were test expectations (a status pattern that did not match the new recovery wording, and an engine briefly `busy` reading the dataset list after Retry); corrected and re-run in all three browsers: 6 passed. Not verified: VoiceOver, NVDA, real 200 % zoom, Windows forced colours, a real background tab (covered by unit tests with an injected clock).

### 2026-11-28: M10 corrections after the Codex reviews (Claude Code)

Two Codex review rounds; every finding reproduced and corrected with a regression test (P-113, P-114). Highlights: Cancel through any control withholds a Verdict report even when it arrives during the final ROLLBACK; the queue refuses work whose wait limit passed (clock, not timer) and never dispatches re-entrantly; an import's cancellation boundary is its COMMIT and it never reports Done for a table recovery lost; recovery context survives failed Retries and says when its lost-table list may be incomplete; reconciliation reports only what it did; limits are shown as enforced (`cancelSettleMs` is not enforced: open); ROLLBACK after a failed transaction accepts any comments; focus never falls to the page after Cancel or Retry; a browser without WebAssembly or Web Workers is told what to use.

**Verification (local, 2026-11-28):** typecheck, lint, check:repo OK; Vitest 519/519; Python oracle 7/7; build JS 1,031.7 KB raw / 310.2 KB gzip, check-artifact OK (11 files, 87,721,148 bytes). Full Playwright run (Chrome, Firefox, WebKit, 22.7 min): 714 passed, 8 skipped, 1 failed — WebKit scrolled the test harness's own 48 px banner out of view in the dataset test (the page height check passed; the production page has no banner); the check now bounds the scroll by the harness overflow, re-run in all three browsers: 3 passed. Mutation check: the re-entrancy test fails on the previous pump. Open for the maintainer: `cancelSettleMs` (enforce or remove) and whether Run SQL/Analyze are disabled while the engine starts or recovers (PRD §5) or queue as now (P-110). Not verified: VoiceOver, NVDA, real 200 % zoom, Windows forced colours, real background-tab throttling, Safari.

### 2026-11-28: M12 Evidence Copy and Replay Bundle implemented (Claude Code)

Branch `feat/evidence-copy` (from `main` at the M10 merge, PR #15, plus the M10 follow-up commit `3cc080c`), uncommitted, awaiting Codex review. Started on the maintainer's M12 instruction. Decisions P-115 (replay bundle) and P-116 (summary and copy preview).

**Built:** `core/verdict/replay.ts`: the replay bundle and its script, built from each run's validated evidence, version-stamped from the session's boot information, attached by the fence only to authoritative reports (`replayUnavailable` says why otherwise). `features/verdict/summary.ts`: the allowlisted `buildSummary`. `features/verdict/CopyDialog.tsx`: exact preview, explicit Copy, failure handling, report changes while open. Header actions "Copy summary…" and "View diagnostic SQL"; a Reproduction row in Details. `statisticsSql` now shares its expressions with the bundle (`statisticExpressions`; the SQL text is unchanged).

**AM-019 verification:** the bundle has no fingerprints, catalog probes, transaction control, probe tags, random names or data changes (checked on every statement in the e2e sweep and in unit tests), and uses stable quoted temporary names with collision suffixes. In the harness, every authoritative case of the 155-case oracle corpus (154) was analysed, then its bundle was run statement by statement on the same tables: every labelled result equalled the report's value, the Python oracle's value (`cases.json`) and, for output rows, DuckDB's count of the query run as ordinary SQL. Covered: INNER and LEFT, composite keys, duplicates, NULL keys, unmatched rows, empty relations, fan-out, loss, keys above 2^53 (exact, including HUGEINT and UHUGEINT extremes), quoted identifiers, USING, self-joins, temp-name collisions (input names and aliases, case-insensitive), a user table sharing the replay name (shadowed, not overwritten), unmet prerequisites (an existing temporary table: CREATE fails and the table is unchanged; changed data: mismatches; a missing table: errors).

**Replay limitations (recorded in each bundle):** the script cannot check that it runs on the analysed snapshot (fingerprints use `hash()`, not stable across versions); the bind check, catalog lookups and the analyser's rolled-back transaction are not replayed; derived values are stated as arithmetic; the bundle drops nothing (temporary tables end with the session); witness-join recounts are omitted if an input or alias is named `__qv_wl`/`__qv_wr`; no bundle for non-authoritative reports, including partially analysed ones whose measurements were validated.

**Verification (local, 2026-11-28):** typecheck, lint (with boundary check), check:repo OK; Vitest 547/547 (28 new in `tests/unit/replay.test.ts`); Python oracle 7/7; build JS 1,056.6 KB raw / 317.5 KB gzip (M10: 1,031.7 / 310.2), CSS 48.9 KB; check-artifact OK (11 files, 87,747,664 bytes); no dependency changes. Full Playwright run (Chrome, Firefox, WebKit, 24.6 min): 787 passed, 8 skipped by design, 0 failed; `copy.spec.ts` 72 tests in all three browsers. Screenshots of the summary and diagnostic SQL dialogs in light and dark, per browser: `docs/evidence/m12-copy/`. **Not verified:** the manual paste into a DuckDB v1.5.4 CLI (field 16): no DuckDB CLI or Python module is installed on this machine; axe in Firefox (P-083); screen readers (VoiceOver, NVDA) announcing the in-dialog status region; real clipboard permission prompts (the tests replace `navigator.clipboard`).

### 2026-11-28: M12 corrections after the Codex review (Claude Code)

Codex M12 review: CHANGES REQUIRED (1 HIGH, 4 MEDIUM, 1 LOW). Every finding reproduced and corrected with a regression test (P-117): a copy pending when the dialog closed no longer leaves the next open stuck on "Copying…"; a write that settles after the preview changed says the earlier preview was copied; the opt-in SQL section and the footer say SQL as written can contain names and values, and "Show the newer report" resets the added sections; the summary claims binding only when the analysis bound the query; the replay computes the matched keys once into `qv_replay_matched` (previously a CTE repeated in 10 statements) and warns that an external client runs it without QueryVerdict's limits, and to stop at the first error; size policy for long SQL (summary SQL shortened past 20,000 characters, replay scripts over 1,000,000 characters not offered); focus returns to the opener on every close and moves to the updated preview after "Show the newer report". Found while testing, in the shared Dialog primitive: an Escape followed at once by opening a dialog could be undone by the stale close event (intermittent in Chromium); and, introduced by that fix and caught by the full Firefox run, a dismissed file picker's bubbling `cancel` closed the import dialog. Both are fixed; the second has a regression test shown to fail without the fix.

**Verification (local, 2026-11-28):** typecheck, lint (with boundary check), check:repo OK; Vitest 552/552; Python oracle 7/7; build JS 1,059.5 KB raw / 318.6 KB gzip, check-artifact OK (11 files, 87,750,583 bytes). Full Playwright run (Chrome, Firefox, WebKit, 24.7 min): 802 passed, 8 skipped by design, 0 failed. The new copy regressions were also repeated 10 times in each browser (120/120). One intermittent Chromium failure of the focus regression occurred once right after the first Dialog change and did not recur in 140 further runs; its cause is not established. Screenshots recaptured in `docs/evidence/m12-copy/`. Still not verified: DuckDB CLI paste (no CLI installed), axe in Firefox (P-083), screen readers, real clipboard permission prompts.

## Next steps

0. Codex review of M09 (`feat/visual-verdict`); maintainer decisions on P-099–P-104, in particular P-100 (expectation edits make a report historical) and the P-102 contradictions (row loss as observation vs mockup warning; whole-buffer Analyze vs statement at the cursor). M10 only on the maintainer's instruction.
1. (Done: M06 merged as PR #13.) Codex review of M06 (`feat/query-results`); maintainer approval of P-092–P-097 (P-097 revises AM-004/P-064 at the maintainer's request; P-096 records the measured windowing choice); then maintainer-approved commit, PR and merge.
2. Maintainer decisions: P-079…P-085 (P-083 also needs a decision on the Firefox axe gap); still open: P-063…P-078 and P-069; AM-001…AM-022; specification approvals; licence and AM-022.
3. Manual checks for M04 field 16: VoiceOver (Safari) and NVDA (Firefox or Chrome) over the tree and dialog; real browser zoom at 200 %.
4. Next module per the plan: **M09** (only on the maintainer's instruction).
