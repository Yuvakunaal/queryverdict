# SQL Analysis Engine: Phase 4 Findings and Phase 5 Handoff

**Status:** Phase 4 (experimental research) is **conditionally complete**, subject to an independent review of this checkpoint's documentation. This document is the canonical defect register and handoff for the experimental SQL correctness analysis engine. The detailed experiment record is in [FEASIBILITY.md §11–§14](FEASIBILITY.md); decisions are in [DECISIONS.md](DECISIONS.md) (P-026 to P-039, all provisional).

**Readiness (latest independent Codex review, Step 4.4.4):**

| Question | Verdict |
|---|---|
| Experimental implementation | CONDITIONAL GO, for isolated research only |
| Commit readiness | NO until documentation claims are corrected (addressed by this checkpoint; needs review) |
| Phase 5 readiness (product specification and production architecture) | YES WITH CONDITIONS (§7) |
| Public release readiness | **NOT READY** |

The analyser is a throwaway spike (`spikes/browser-feasibility/src/analysis/`), built only into the test harness. It is **not production code** and must not be merged into production as-is (CLAUDE.md).

## 1. Status of the second-review findings (corrected)

These statuses replace the "RESOLVED" claims made in [FEASIBILITY.md §13.1](FEASIBILITY.md) before the independent review.

| Finding | Corrected status | Remaining defect |
|---|---|---|
| H-A Snapshot consistency and exclusive ownership | **PARTIALLY RESOLVED** | QV-SA-002 (stale publication), QV-SA-005 (lease retention) |
| H-B Execution budgets and terminal outcomes | **PARTIALLY RESOLVED** | QV-SA-001 (witness verification bypasses the execution budget), QV-SA-003 (recovery liveness), QV-SA-005 |
| M4 Non-finite metric comparisons | **RESOLVED within the tested scope** | QV-SA-004 (precision of finite tolerance comparisons; separate defect) |
| M5 Quoted identifier handling | **RESOLVED within the tested scope** | none known |
| M6 Expectation outcome completeness | **RESOLVED for count and identity**: exactly one outcome per expectation, with index and object identity | stale-publication limitation (QV-SA-002): outcomes of a report published after cancellation or replacement can be stale |

## 2. Evidence

### 2.1 Independent Codex verification (Step 4.4.4)

| Check | Result |
|---|---|
| TypeScript type check | passed |
| Production build and harness build | both passed |
| Vitest | 80 passed |
| Python unittest | 9 passed |
| Chrome (Playwright) | **59 selected tests passed.** The full browser suite was not run by Codex |
| Independent DuckDB comparisons | 72 comparisons; no output-cardinality or matched-row discrepancies |
| Production artifact | the normal build excluded the experimental analyser and the harness |
| Security | selected security tests passed |
| Network | the independent Chrome matrix observed no external requests |

### 2.2 Claude Code's own verification (not independently reproduced)

Reported in [FEASIBILITY.md §13.12](FEASIBILITY.md) (2026-11-25):
- Playwright: 79 tests passed in one full local run.
- Mutation checks: 10 of 10 planted defects caught.
- A 237-case oracle sweep and a 70-case MVP sweep.
- A one-off performance probe.

These are the implementer's results. Codex reproduced the subset listed in §2.1 only; in particular, the full 79-test browser run has **not** been independently reproduced.

### 2.3 Not verified by anyone

- Safari and Firefox.
- An actual GitHub Pages deployment (MIME types, compression, caching, headers).
- Background-tab timer throttling and its effect on deadlines and cancel grace periods.
- Production-scale memory behaviour: the browser and WASM ceiling, and `memory_limit` near the 4 GB WASM address space.
- The analyser on file datasets at the P-024 ceiling (50 MB combined).
- The 400 M-row and 10^8-row experiments, which were retired and not rerun by maintainer instruction.

## 3. Verified algorithms (reusable knowledge)

These algorithms agree with an independent Python brute-force oracle and with DuckDB itself. They were verified on 237 fixture cases (implementer) and 72 independent comparisons (Codex).

**Join statistics from key frequencies.**
- Each side is grouped once by its join key, excluding NULL keys: L(k) and R(k) rows per key, exact `HUGEINT`/`BigInt`.
- Over the matched keys:
  - matched pairs = Σ L(k)·R(k);
  - left rows matched = Σ L(k);
  - left excess copies = Σ L(k)·(R(k) − 1) for R(k) > 1, and symmetrically for the right side.
- Output rows:
  - INNER: matched pairs;
  - LEFT: matched pairs + unmatched left rows;
  - RIGHT and FULL: symmetric, adding unmatched right rows (FULL adds both).
- Unmatched rows = rows − matched rows (NULL-key rows are always unmatched). Dropped rows are the unmatched rows of a non-preserved side.
- Relationship (one/many on each side) is reported both for the whole inputs and for matched keys only.

**Validation before publication** (P-033):
- **Mathematical invariants** ([FEASIBILITY.md §12.10](FEASIBILITY.md)), including matched pairs = matched rows + excess copies.
- **`SEMI JOIN` recount** using the query's own join node: engine matching semantics, without enumerating pairs.
- **Executed `count(*)`** of the join, within the execution budget.
- **Witness identity:** every sampled key is re-counted on both inputs and through the join (subject to QV-SA-001).

A disagreement makes the join `inconclusive` and suppresses everything that depends on it. In practice this catches collations, volatile inputs and mid-analysis changes.

**Snapshot evidence.**
- A key-multiset fingerprint of each side (rows, NULL-key rows, `sum(hash(keys))`, `bit_xor(hash(keys))`) is taken at the start and at the end.
- Table OIDs are checked again at the end.
- This is a detection layer, not a guarantee: the hash is 64-bit and not cryptographic.

**Exact numerics.** DuckDB's own parser (`json_serialize_sql` / `json_deserialize_sql`) is read and written through a lossless JSON layer, so numeric literals are never converted to JavaScript doubles. All counts travel as decimal text into `BigInt`.

**Engine semantics verified in the browser** (DuckDB v1.5.4; [FEASIBILITY.md §13.2](FEASIBILITY.md)):
- An execution error aborts the open transaction; a binder error does not.
- A nested `BEGIN` fails.
- Temporary tables roll back with the transaction.
- Volatile generated columns are accepted and are visible only in `duckdb_tables().sql`.
- `ATTACH`, `USE` and `search_path` work under the lockdown.
- `DISTINCT … LIMIT` performs the full `HASH_GROUP_BY` below the limit.

## 4. Experimental implementation limitations

- **Spike quality.** One large module (`analyze.ts`). Internal DuckDB parser JSON is checked by a field allowlist and pinned to v1.5.4. Test-only hooks live in the same code path. Not designed for production maintenance.
- **Resource estimates are heuristics.** The grouping-state estimate is rows × (key bytes + 16 + 64 assumed overhead). It is not a measurement, and there is no hard browser or WASM memory guarantee; DuckDB's `memory_limit` is the only engine-enforced control.
- **Exclusive ownership blocks the session.** User SQL waits behind an analysis, up to its deadline.
- **Aborted transactions.** After one execution error, later optional probes are skipped (DuckDB aborts the transaction).
- **Open user transactions.** An open user transaction blocks analysis (`transaction-unavailable`).
- **Recovery loses data.** In-memory tables are lost on recovery: imported datasets become `needs-reimport`, and tables created by SQL are lost.
- **Collation.** Collation is not detectable from the catalog, so text keys are outside MVP scope.
- **Chrome only.** Tested in Chrome 158 on the reference machine only.

## 5. Defect register

Identifiers are stable. A defect is closed only by a regression test meeting its acceptance criteria and an independent review.

**About the reproductions:** each defect was reported by the independent Codex review (Step 4.4.4). The Codex scripts are not in this repository. Where a reproduction gives concrete numbers (QV-SA-001), they come from the Codex report. Otherwise the concrete scenario and the affected code locations are the implementer's reconstruction from the source, and must be confirmed when the regression test is written.

| ID | Severity | Title | Blocks |
|---|---|---|---|
| QV-SA-001 | HIGH | Witness verification bypasses the join execution budget | Enabling the public Verdict analyser |
| QV-SA-002 | HIGH | Authoritative report can survive cancellation or engine replacement before publication | Enabling the public Verdict analyser |
| QV-SA-003 | MEDIUM | Stalled dataset reattachment during recovery leaves later SQL pending | Production engine qualification |
| QV-SA-004 | MEDIUM | Metric tolerance comparison loses precision by converting to DOUBLE | Any metric-preservation feature (excluded from the public MVP) |
| QV-SA-005 | MEDIUM | Stalled batch callback retains the FIFO session lease | Production engine qualification |

### QV-SA-001 — HIGH — Witness verification bypasses the join execution budget

- **Reproduction:** a 3 × 4 join on one key (12 output rows) with `executionBudgetRows = 1`.
- **Expected:** no statement materialises more join rows than the execution budget allows. The executed `count(*)` is correctly skipped (`executedCount: not-run`).
- **Actual:** witness verification still re-counts the sampled fan-out key through the join, producing all 12 rows despite the budget of 1.
- **Affected implementation:** `spikes/browser-feasibility/src/analysis/analyze.ts`. In `analyseJoin`, the budget gate covers only the executed count. `verifyWitnesses` (join-node re-counts, `count(*) FROM (<join>) WHERE <key> = …`) runs unconditionally afterwards.
- **Recommended correction:**
  - Every join-producing diagnostic must pass one budget gate.
  - Before running witness re-counts through the join, compute their expected output from the frequency tables (Σ L(k)·R(k) for fan-out witnesses; L(k) or R(k) for preserved unmatched witnesses) and require it to fit within the remaining execution budget.
  - Otherwise run only the input-side re-counts and mark witness identity `not-run`.
  - A report whose witnesses are not verified is never authoritative.
- **Regression acceptance criteria:**
  - The Codex reproduction runs no statement that joins more than the budget, asserted from `diagnosticSql` and the frequency-derived row counts of each join statement.
  - Witness identity is reported `not-run`, with the reason.
  - The report is non-authoritative.
  - Within budget, witnesses are still verified, and the existing interference test still detects the Codex snapshot reproduction.
- **Required resolution stage:** before the Verdict analyser is enabled for any user (production analyser implementation, Phase 6 or later). Blocks public enablement.

### QV-SA-002 — HIGH — Authoritative report survives cancellation or engine replacement before publication

- **Reproduction:** cancel the session, or replace or recover its engine, after the last diagnostic statement has completed but before the caller receives the report.
- **Expected:** a report is published as authoritative only if, at the moment of publication:
  - no cancellation was requested for that analysis;
  - the engine generation is unchanged;
  - the session is not disposed.
- **Actual:** the report remains `authoritative: true`.
- **Affected implementation:**
  - `analyze.ts`, `analyzeInSession`: the final check only consults `batch.isCurrent()`, which stays true while the batch still owns its slot, and does not consult the batch's cancel request.
  - Nothing is re-checked after the batch settles and before the value is returned.
  - `session.ts`, `exclusive()`: the cancel request is not exposed to the publisher.
- **Recommended correction:**
  - Add an explicit publication fence. The analysis carries a token: session identity, engine generation and a cancellation flag.
  - The report is finalised, its `authoritative` flag computed, at the last point before it is handed to the caller, after the lease is released.
  - Any cancellation, replacement, recovery or disposal observed at or before that point downgrades the report: non-authoritative, `cancelled` or `session-replaced`, with every expectation `unchecked` or marked stale.
  - Reports should carry the generation and a publication timestamp, so the UI can reject reports older than the current engine.
- **Regression acceptance criteria:**
  - Deterministic tests inject cancel, `restart()`, invalidation and `dispose()` at every point after the last statement: before `ROLLBACK`, after `ROLLBACK`, after lease release and before return.
  - Each one yields a non-authoritative report with an accurate status and no `held` outcome derived from that run.
  - A run without interference is still authoritative.
- **Required resolution stage:** before the Verdict analyser is enabled for any user. Blocks public enablement.

### QV-SA-003 — MEDIUM — Stalled dataset reattachment during recovery leaves later SQL pending

- **Reproduction:** worker recovery where re-registering a file handle or re-creating a file-backed view does not complete. For example, a `File` whose underlying data became unreadable, or a stalled RPC on the new worker.
- **Expected:**
  - Recovery finishes within a bound: ready, with the affected datasets marked `failed`, or the session `failed`.
  - Queued and later SQL calls settle with an error rather than waiting indefinitely.
- **Actual:** the reattach loop has no timeout. The recovery promise never settles, and every later operation waits on it (`if (this.recovery) await this.recovery` in the queue), so calls stay pending.
- **Affected implementation:** `spikes/browser-feasibility/src/engine/session.ts`, `recoverNow()` reattach loop (`registerFileHandle`, `CREATE VIEW`) and `enqueue()`.
- **Recommended correction:**
  - Bound each reattach step and the whole recovery (separate from `bootTimeoutMs`).
  - On a per-dataset timeout, terminate and re-boot, or mark the dataset `failed` and continue.
  - On a whole-recovery timeout, terminate the worker and set the session to `failed`.
  - Queue waits on recovery must themselves be bounded.
- **Regression acceptance criteria:**
  - A stand-in or fault-injected worker whose reattach never answers results in a `failed` dataset or `failed` session within the documented bound.
  - Every queued and later call settles (error or result) within that bound.
  - The lockdown is still verified before any SQL is accepted after recovery.
- **Required resolution stage:** production engine qualification (production engine and session layer, Phase 6 or later). Blocks qualification of the production engine.

### QV-SA-004 — MEDIUM — Metric tolerance comparison loses exact precision

- **Reproduction:** `metric-preserved` with a non-zero tolerance on large `DECIMAL(38,·)` or `HUGEINT` totals whose difference is below DOUBLE resolution. For example, totals around 10^20 that differ in the last digits.
- **Expected:** a comparison that is exact for exact numeric types, or an explicit `unchecked` when it cannot be exact.
- **Actual:** both totals and the bound are cast to `DOUBLE` (`abs(j::DOUBLE − s::DOUBLE) <= tol × greatest(abs(s::DOUBLE), 1)`), so distinct exact totals can compare as within tolerance, or the reverse. Tolerance 0 uses exact equality and is not affected.
- **Affected implementation:** `analyze.ts`, `evaluateExpectation` (metric-preserved).
- **Recommended correction:**
  - For exact numeric types, compare exactly: tolerance as a decimal rational, using `DECIMAL` arithmetic with sufficient scale or `BigInt` rational arithmetic on the exact text totals.
  - Use DOUBLE only for `FLOAT`/`DOUBLE` columns, and say so in the evidence.
  - Return `unchecked` when an exact comparison is impossible.
- **Regression acceptance criteria:**
  - Large `DECIMAL(38,10)` and `HUGEINT` totals just inside and just outside a tolerance give the mathematically correct outcome.
  - The existing NULL, non-finite and exact-equality tests still pass.
- **Required resolution stage:** before any metric-preservation feature is qualified. Metric preservation is **excluded from the public MVP** (P-031) and remains experimental.

### QV-SA-005 — MEDIUM — Stalled batch callback retains the FIFO session lease

- **Reproduction:** an analysis whose batch callback never settles. In the spike this is a test-only `beforeStatement` hook that never returns; in principle it is any await inside the batch that is not a bounded statement.
- **Expected:** `analyzeInSession` returns at its outer bound (it does), **and** the session lease is revoked so later operations can run.
- **Actual:**
  - The caller gets `budget-exhausted` and the engine is invalidated.
  - But `exclusive()` releases its queue slot only when the callback settles, so every later operation stays queued indefinitely.
- **Affected implementation:**
  - `session.ts`, `exclusive()` / `enqueue()`: the lease lifetime equals the callback's lifetime.
  - `analyze.ts`, `analyzeInSession`: the outer-bound path invalidates but cannot release the lease.
- **Recommended correction:**
  - Make the lease revocable.
  - The session owns lease release: on invalidation, deadline revocation or dispose it releases the slot, and later calls through the revoked batch return `stale`, independently of whether the callback ever settles.
  - Test hooks must not exist in production builds.
- **Regression acceptance criteria:**
  - With a callback that never settles, a later `session.run('SELECT 1')` completes (or fails with an explicit error) within the documented outer bound.
  - No statement from the revoked batch executes after revocation.
- **Required resolution stage:** production engine qualification. Blocks qualification of the production engine.

## 6. Proposed public MVP diagnostic boundary (P-031, provisional)

**In scope (qualifiable for public release once the gates in §8 pass):**
- **Inputs:** two stable DuckDB-managed tables. These are base or temporary tables in the current database and schema, resolving unambiguously, without generated columns: datasets imported as tables, or tables created by SQL.
- **Join:** one INNER or LEFT JOIN on explicit same-type integer key equalities, single or composite (`ON … AND …` or `USING`).
- **Statistics:** join cardinality; duplicate and NULL key counts; matched and unmatched input rows; excess-copy counts; relationship classification.
- **Witnesses:** bounded, snapshot-consistent witnesses (at most 5 per kind), identity-verified within budget (QV-SA-001).
- **Expectations:** explicit, fully checked join-stage expectations: relationship, no-row-loss, no-fan-out, row-count.

**Outside the qualified public diagnostic scope (experimental only, never authoritative):**
- file-backed views and arbitrary views;
- CTEs, nested queries, join chains;
- RIGHT and FULL joins;
- collated or coerced keys;
- advanced filter attribution (post-join `WHERE`, outer-join classification);
- metric preservation and grain expectations.

**Never provided:** aggregate-inflation attribution and automatic SQL rewrites.

These restrictions apply to **Verdict diagnostics only**. Ordinary SQL execution in the workspace is unaffected: users can query views, files, CTEs and anything else DuckDB supports.

### 6.1 Implications of requiring DuckDB-managed tables

- **Import memory overhead.** "Attach as view" reads the user's file lazily on each scan and keeps no copy. A DuckDB-managed table copies the data into the engine's in-memory database inside the WASM heap, which is bounded by `memory_limit` and the 4 GB WASM address space; no spilling was configured. A dataset must therefore be imported before it can be diagnosed:
  - **memory:** roughly the dataset's decoded columnar size stays resident while the table exists;
  - **time:** there is an import cost (measured for CSV and Parquet tiers in [FEASIBILITY.md §9–§10](FEASIBILITY.md));
  - **headroom:** less memory remains for queries and diagnostics.

  On the 8 GB reference machine this narrows the dataset sizes the analyser can serve. The qualification ceiling (P-024, 50 MB combined) must be re-measured with import plus analysis, not analysis alone.
- **Recovery after worker termination.** Termination (cancel fallback, invalidation, crash) destroys the in-memory database:
  - imported datasets become `needs-reimport`;
  - tables created by SQL are lost;
  - any report about them becomes stale (see QV-SA-002).

  The product must specify re-import (the session keeps the `File` handle, but browser file access may lapse), what users are told, and that no report survives a generation change.
- **UX consequence.** The product must make the distinction between "attached as view" and "imported as table" visible, and explain why Verdict diagnostics need an import.

## 7. Production architecture requirements (Phase 5 inputs)

1. **Session lease:** revocable, with session-owned release, bounded queue waits and a publication fence (QV-SA-002, QV-SA-005).
2. **Bounded recovery:** every reattach step and the whole recovery are bounded, with an explicit `failed` state (QV-SA-003). Lockdown is re-verified before SQL is accepted, as today.
3. **Single budget gate:** every diagnostic that executes a join or produces rows goes through one budget gate (QV-SA-001). Output limits are kept separate from work limits.
4. **No test hooks in production:** fault injection lives behind a build-time seam that is absent from the production artifact, and this is verified.
5. **Parser seam:** isolate DuckDB's internal parser JSON behind a versioned adapter with the strict field allowlist. An engine upgrade must fail closed to `unsupported` and must re-run the engine-semantics checks (§3) as an automated qualification test.
6. **Engine-semantics qualification suite:** transaction abort and nested-`BEGIN` behaviour, temporary-table rollback, generated-column visibility, `DISTINCT … LIMIT` plan, lockdown settings and `ATTACH`/`USE` behaviour, run on every engine upgrade.
7. **Report contract:** `authoritative`, `nonAuthoritativeReasons`, eight finding categories, one outcome per expectation, generation and publication metadata. Nothing implies a "pass".
8. **Worker main-thread isolation:** analysis results are tiny. Keep Arrow decoding bounded and on paths already validated.
9. **Licensing:** a build-time third-party notice extraction step before any public artifact (P-016, P-018; [FEASIBILITY.md §10.12](FEASIBILITY.md)).

## 8. Mandatory acceptance criteria and release gates

**Before enabling the public Verdict analyser:**
- QV-SA-001 and QV-SA-002 closed, with their regression criteria passing under independent review.
- Oracle-backed correctness suite (independent brute-force oracle plus DuckDB comparison) passing in the production codebase.
- Mutation checks for each safety layer.
- Report-contract tests.

**Before production engine qualification:**
- QV-SA-003 and QV-SA-005 closed.
- Recovery and queue liveness tested with stalled workers.
- Lockdown re-verification after every recovery.

**Before public release:**
- Safari and Firefox runs.
- An actual GitHub Pages deployment check.
- Background-tab timing behaviour measured, including deadline and grace semantics when timers are throttled.
- Production-scale memory behaviour characterised: import plus analysis at the qualification ceiling, and `memory_limit` behaviour; no claims beyond measured evidence.
- Third-party notices collected and shipped.
- Licence chosen.
- Maintainer approval of P-026 and P-031 to P-039.

**Metric preservation:** QV-SA-004 must be closed, with a separate specification, before it can enter any public scope.

## 9. Recommended implementation sequencing (after Phase 5 approval)

1. Write the product specification and production architecture for the workspace and the Verdict surface, including the dataset import model (§6.1) and the report contract.
2. **Production engine and session layer:** revocable lease, bounded recovery, publication fence, no test hooks. Close QV-SA-003 and QV-SA-005, then QV-SA-002's session part.
3. **Engine-semantics qualification suite** (§7 item 6) and the parser adapter.
4. **MVP analyser** in production code, reimplemented from the verified algorithms, with the single budget gate (QV-SA-001) and the publication fence (QV-SA-002). Port the oracle and fixtures first, test-first.
5. Cross-browser, deployment, memory and background-tab qualification. Only then enable the public analyser.
6. Experimental capabilities, each behind a separate specification and qualification. Metric preservation requires QV-SA-004 first.

## 10. Reuse assessment

**Potentially suitable for reuse** (after review and tests in the production codebase):
- `scripts/make_analysis_fixtures.py` and `tests/fixtures/analysis/cases.json`: the independent brute-force oracle and deterministic fixtures.
- `src/analysis/stats.ts`: exact `BigInt` derivation, invariants, expectation evaluation for join-stage expectations.
- `src/analysis/json.ts`: lossless JSON for parser output.
- The frequency, `SEMI JOIN`, executed-count and witness SQL patterns, and the fingerprint approach.
- The MVP field allowlist concept in `ast.ts` (`recognizeMvp`) and `parseColumnRef`.
- The test designs: Codex regression tests, stand-in terminal-outcome tests, interference tests, mutation-check method.
- The engine lockdown and verification (`src/engine/lockdown.ts`), which was already reviewed in Step 3.6.

**Requiring redesign:**
- `src/engine/session.ts`: lease lifetime, recovery bounds and publication fence (QV-SA-002/003/005); the state machine should be specified, not grown.
- `src/analysis/analyze.ts`: a monolithic pipeline mixing scopes, test hooks and reporting. Split it into a scope recogniser, a planner with one budget gate, executors and a report finaliser with a publication fence.
- `src/analysis/executor.ts`: keep its bounded-outcome semantics, but rebuild it around the revocable lease.
- The experimental-scope code paths (chains, CTEs, outer-join `WHERE` probes, metric/grain): not to be carried into production without separate specifications.
