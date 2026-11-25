# Feasibility Study

> **Status: EXPERIMENT PLAN. NO EXPERIMENT HAS BEEN RUN.** Every experiment below is marked **NOT RUN**. This document contains no measurements, so nothing here is evidence of performance, capacity, privacy, or browser support.
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
| P0 | E0 | Fixture generator and harness | Prerequisite for all | NOT RUN |
| P0 | E1 | Static deployment and engine boot without isolation | P-002, P-003 (hosting) | NOT RUN |
| P0 | E2 | Network isolation and configuration lockdown | P-003, P-013, D-004 | NOT RUN |
| P0 | E3 | Join-audit correctness on DuckDB-WASM | Core algorithm, D-013/P-012 | NOT RUN |
| P0 | E4 | Cancellation and recovery | P-003, P-004 | NOT RUN |
| P1 | E5 | Query parsing for a single-join `SELECT` | Differentiation, MVP scope | NOT RUN |
| P1 | E6 | Ingestion paths and memory characterisation (50 MB–1 GB) | D-009 workloads, supported limits | NOT RUN |
| P1 | E7 | Browser matrix (Chromium, Firefox, Safari) | Supported browsers | NOT RUN |
| P1 | E11 | Licence and notice audit of the pinned artifacts | Licence choice, redistribution | NOT RUN |
| P2 | E8 | Result streaming and main-thread responsiveness | P-004, P-007 | NOT RUN |
| P2 | E9 | Editor comparison (Monaco vs CodeMirror 6) | P-005 | NOT RUN |
| P3 | E10 | OPFS spill and persistence | P-008 | NOT RUN (deferred) |

E0–E4 together are the proof of concept in §3. If E1 or E2 fails, stop and escalate before running anything else.

---

### E0. Fixture generator and measurement harness: NOT RUN

- **Goal:** reproducible inputs and a consistent way to record results.
- **Inputs:** a seeded generator producing paired `left` and `right` relations in CSV and Parquet. Parameters: rows, key cardinality, key skew (uniform; Zipf-like; one hot key), NULL-key rate, duplicate rate, orphan rate on each side, composite-key arity (1–2), measure type (INTEGER, DECIMAL(18,2), DOUBLE), and row width (narrow ~5 columns; wide ~50 columns).
- **Workload:** generate the small known-answer corpus (E3) and the size ladder (E6). Size is reported **per relation and in total**, on disk.
- **Measurements:** generation time, file sizes, checksums.
- **Safeguards:** output only to git-ignored paths. Generation runs outside the browser (a script) so it cannot affect browser measurements.
- **Acceptance (proposed):** the same seed produces identical checksums on two runs. Every fixture has a manifest with its parameters and expected answers (for corpus fixtures).

### E1. Static deployment and engine boot without isolation: NOT RUN

- **Question:** does a pinned single-thread DuckDB-WASM build load and run SQL from a static subpath with no COOP/COEP headers and no CDN?
- **Inputs:** the production-style static build served at `/<repo>/` by a local static server with default headers. `crossOriginIsolated` must be `false`.
- **Workload:** cold load (empty cache) and warm load, 10 each per browser. `SELECT 42`, then a 10k-row in-memory join.
- **Measurements:** which bundle is selected; compressed and uncompressed bytes transferred, per asset and in total; time to engine ready; time to first query result; MIME type served for `.wasm` and the worker; console errors.
- **Safeguards:** no external network (verified by E2 tooling). Throwaway code only.
- **Acceptance (proposed):** the engine boots and runs both queries in all three browser families with `crossOriginIsolated === false`; zero requests leave the origin; asset sizes are recorded (no size threshold until the maintainer sets a budget). **Failure:** escalate. Fallbacks: a different bundle, or SQLite WASM (CSV-only).

### E2. Network isolation and configuration lockdown: NOT RUN

- **Question:** can the engine be configured so that no SQL can reach the network or load extensions, and is any extension needed for CSV, Parquet or JSON fetched at runtime?
- **Inputs:** the E1 page with a candidate locked configuration *(candidates to verify in the pinned version: disable external access, disable extension auto-install and auto-load, lock the configuration)*. Canary values (unique random strings) planted in local data and in SQL text. A local-only logging listener on `127.0.0.1` used as the "external" target.
- **Workload:** run, against the listener URL, `read_csv`/`read_parquet` on an http(s) URL, `COPY … TO` an http(s) URL, `ATTACH` a remote database, `INSTALL`/`LOAD` an extension, any statement that tries to undo the lockdown, and functions that would trigger auto-loading (Parquet, JSON, and `json_serialize_sql` for E5). Repeat during startup, a normal audit, export, a forced error and cancellation. Separately test whether a `<meta>` CSP `connect-src 'self'` and a blob-URL worker restrict requests made by the worker.
- **Measurements:** every request from the page **and the worker** (method, URL, initiator), captured by browser automation and cross-checked with the listener's log; whether each statement errors or succeeds; which features are built in and which need an extension.
- **Safeguards:** the listener never forwards anything. No real external host is contacted.
- **Acceptance (proposed):** **zero** requests to anything but allowed same-origin assets; **zero** canary values seen by the listener; every escalation statement fails with an error the app can show; local file registration still works under the lock. CSV and Parquet must work without a runtime extension fetch, or with a same-origin, self-hosted extension that is checked against a recorded integrity hash. **Failure:** this blocks P-003 under P-013. Escalate to the maintainer.

### E3. Join-audit correctness on DuckDB-WASM: NOT RUN

- **Question:** do the research's probe queries give exact answers in the pinned DuckDB-WASM, matching a directly materialised join?
- **Inputs:** the E0 known-answer corpus, covering every case in the research's verification strategy: one-to-one; intended many-to-many; unwanted one-to-many; orphans on both sides; repeated NULL keys; composite keys with a partial NULL; empty relations; DECIMAL, DOUBLE and negative measures; fan-out with a net-zero sum; fan-out plus loss with unchanged row counts; LEFT JOIN with a NULL-rejecting WHERE; a nullable right value inside a real match; mismatched key types. Plus at least 500 seeded random fixtures (small: ≤ 1,000 rows each).
- **Workload:** for each fixture, the INNER and LEFT probes versus `COUNT(*)` and `SUM` over the materialised join. Run a differential check of the random fixtures against SQLite (Python standard library, no install) for single-key INNER and LEFT cases.
- **Measurements:** per-fixture match or mismatch for each metric; the classification produced (per AGENTS.md §8 and P-012), with and without a declared grain.
- **Safeguards:** fixtures are synthetic and tiny. The test runs in the browser and also in a headless runner if the spike approval allows one.
- **Acceptance (proposed):** **100 % agreement** on integer counts and integer/DECIMAL sums. DOUBLE sums agree within a documented tolerance. Mismatched key types are reported as unsupported, not analysed. With no declared grain, no fixture is labelled "confirmed issue". With a declared grain, every violating fixture is labelled "confirmed issue" and no compliant fixture is. **Any mismatch fails E3.**

### E4. Cancellation and recovery: NOT RUN

- **Question:** can a running audit be stopped quickly, and how long does it take to get back to a usable state?
- **Inputs:** a stress case designed to run for 30 seconds or more: one hot key on both sides (pathological fan-out), plus a 200 MB CSV import. Data is attached two ways: (a) imported into tables, (b) file-backed views.
- **Workload:** 20 cycles each of: start, cooperative cancel at 1 s / 5 s / 15 s; if the query has not stopped within a timeout (proposed 2 s), terminate the worker, re-create it and re-attach the data. Cancel during import, during the join and during result streaming.
- **Measurements, recorded separately:** (a) time from clicking Cancel to the UI acknowledging it; (b) whether the cooperative cancel worked and how long it took; (c) time until the engine is ready again; (d) time until the datasets are queryable again, for each attach mode; main-thread long tasks during the cycle; stale messages from a terminated worker reaching the UI; memory before and after 20 cycles (leaks).
- **Safeguards:** a watchdog closes the tab if a cycle exceeds 10 minutes. Stop after the first renderer crash.
- **Acceptance (proposed):** (a) ≤ 200 ms in every cycle. A cooperative cancel or the fallback ends the work within 2 s in every cycle. (c) is measured and reported, with no threshold until baseline numbers exist. The UI never shows stale results. Memory after 20 cycles is no more than 10 % above memory after cycle 1. (d) is reported for each attach mode to decide the attach strategy.

### E5. Query parsing for a single-join `SELECT`: NOT RUN

- **Question:** can the pinned engine's own parser (e.g. SQL-to-JSON serialisation, *availability in the WASM bundle to verify*) reliably extract the relations, aliases, join type, equi-join keys and the position of WHERE predicates from a simple query? Can it refuse everything else?
- **Inputs:** a corpus of at least 60 queries: at least 20 inside the supported subset (single INNER/LEFT equi-join, optional WHERE, GROUP BY with SUM/COUNT; aliases, quoted identifiers, composite keys) and at least 40 outside it (CTEs, subqueries, multiple joins, OR/non-equality conditions, USING/NATURAL, RIGHT/FULL, window functions, DISTINCT ON, unions, invalid SQL).
- **Workload:** parse each query, then classify it as supported (with extracted structure) or unsupported (with a reason).
- **Measurements:** classification and extracted structure compared with the hand-written expected outcome, plus parse time.
- **Safeguards:** no regex-based SQL splitting. Parsing runs under the E2 lockdown, which also shows whether the needed function requires a network extension.
- **Acceptance (proposed):** **zero queries wrongly accepted** (an unsupported query treated as supported); extraction is correct for at least 95 % of supported queries, with the rest refused rather than mis-analysed; the parser works under lockdown. **Failure:** the MVP falls back to the research's relations-first audit. That is a product decision for the maintainer (§2.1).

### E6. Ingestion paths and memory characterisation: NOT RUN

- **Question:** what workloads work on the reference machine, and how do they fail?
- **Inputs:** the E0 size ladder of 50, 200, 500 and 1,000 MB **per relation** (also record totals), in CSV and Parquet, narrow and wide, uniform and skewed keys.
- **Workload:** for each of three attach methods (file handle without a copy, if available; full buffer copy; import into a table): attach, then run a key profile (`GROUP BY key`), then the full E3 audit probes, then return 100 witness rows. Cold and warm runs, at least 5 repetitions per cell, moving up the size ladder.
- **Measurements:** time to first evidence; total audit time; browser renderer process memory at the OS level (peak, sampled); DuckDB's reported memory use; whether the outcome was success, a recoverable engine error or a renderer crash; and how the UI behaved.
- **Safeguards:** the machine-safety rules in §6.0, with the DuckDB memory limit set explicitly to below the observed browser ceiling so failures surface as recoverable errors where possible.
- **Acceptance (proposed):** 50 MB per relation, CSV and Parquet, uniform keys: audit succeeds in Chromium, Firefox and Safari with no renderer crash. Above 50 MB: **characterisation only.** Every result is published as measured, with no pass/fail claim, until the maintainer sets support targets from the data. The output is the first draft of a support matrix.

### E7. Browser matrix: NOT RUN

- **Inputs:** current stable desktop Chrome (or another Chromium browser), Firefox and Safari on the reference machine. Record the exact versions.
- **Workload:** E1, E2, E3 (corpus only), E4 (5 cycles) and E6 at 50 MB. File input with the standard `<input type=file>`, plus the enhanced file picker where the browser supports it.
- **Measurements:** pass or fail for each step in each browser, plus any browser-specific errors.
- **Acceptance (proposed):** all steps pass in all three. A browser that fails is listed as unsupported with the reason, never hidden.

### E8. Result streaming and main-thread responsiveness: NOT RUN

- **Inputs:** a 1M-row result from the E6 50 MB fixture.
- **Workload:** stream record batches and render the first 100 and first 10,000 rows in a plain HTML table, then scroll.
- **Measurements:** time to first rows; main-thread long tasks (> 50 ms) per second; memory growth.
- **Acceptance (proposed):** no long task over 200 ms while streaming the bounded result. A virtualised grid (P-007) is adopted only if the plain bounded table fails this.

### E9. Editor comparison: NOT RUN (only if the MVP includes a query editor)

- **Inputs:** a minimal page with Monaco and the same page with CodeMirror 6, both self-hosted.
- **Measurements:** compressed bundle cost; any requests leaving the origin (CDN default *to verify*); worker setup under the build tool; keyboard-only operation and screen-reader labelling; SQL highlighting and basic schema-name completion.
- **Acceptance (proposed):** zero requests leaving the origin; full keyboard operation. Between candidates that pass, choose the smaller bundle unless a required capability is missing.

### E10. OPFS spill and persistence: NOT RUN (deferred)

Deferred until after the MVP decision. If run: quota and eviction behaviour, explicit deletion, private-browsing failure, and exposure on a shared `github.io` origin (§4.2).

### E11. Licence and notice audit: NOT RUN

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
