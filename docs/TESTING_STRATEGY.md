# QueryVerdict testing strategy

> **Status · Proposed, 2026-11-27.** Drafted by Claude Code at the maintainer's request (see [SPEC_AMENDMENTS.md](SPEC_AMENDMENTS.md) AM-017). Requires maintainer approval and independent Codex review (P-055). No production tests exist yet. Spike tests (`spikes/browser-feasibility/tests/`) are research evidence and are not part of the production suite.
>
> Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md) · [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) · [PRD.md](PRD.md) · [SQL_ANALYSIS_FINDINGS.md](SQL_ANALYSIS_FINDINGS.md).

## 1. Principles

1. **Evidence labels.** Every statement about behaviour is one of: **Verified** (a passing test in this repository, with the run recorded), **Spike-observed** (seen in the research spike; must be re-proven in production code), or **Target** (a proposed acceptance threshold). Reports and documentation must keep these apart. No benchmark, capacity or browser-support claim is published without a recorded run (AGENTS.md §7).
2. **Correctness is proven against independent sources.** Verdict numbers are compared with (a) an independent brute-force oracle in another language and (b) DuckDB's own results (P-030).
3. **Every safety layer has a test that fails when the layer is removed** (mutation check), and every review finding or defect has a regression test asserting its exact outcome.
4. **Fail-closed paths are first-class tests:** refusal, cancellation, recovery and stale-result paths are tested as deliberately as success paths.
5. **No weakening.** A test is never skipped, loosened or deleted to make a change pass without maintainer approval (AGENTS.md §9).
6. **No dangerous workloads.** Tests and benchmarks never exceed the approved fixture tiers. Large-memory experiments, the 400 M-row and 10^8-row workloads are not rerun without explicit maintainer approval.

## 2. Test layers and tooling

| Layer | Tool (proposed, pins in M01) | Runs against | Scope |
|---|---|---|---|
| Static | `tsc --noEmit` (strict), ESLint (incl. import boundaries, no `dangerouslySetInnerHTML`, no React in `src/core`) | source | every commit |
| Unit | Vitest (Node) | `src/core`, `src/stores`, pure UI helpers | logic, contracts, stand-in engines, fault injection without a browser |
| Component | Vitest + jsdom for pure presentational components only where useful | `src/ui` | rendering contracts (labels, roles); not a substitute for browser tests |
| Browser integration | Playwright + **harness build** (`dist-harness/`) | real DuckDB-WASM | engine lifecycle, lockdown, imports, query bounds, Verdict oracle, interference, recovery, network capture |
| End-to-end | Playwright + **production build** (`dist/`) | user flows | UX-001…UX-007 (UI_SPECIFICATION §8), accessibility (axe), artifact checks |
| Oracle | Python 3 standard library (`pyarrow` only for Parquet fixtures) + `unittest` | fixtures | independent join arithmetic |
| Manual | checklists in `docs/qualification/` (created in M15) | deployed site | screen readers, real Safari, visible-window timing, memory sampling |

Two build artifacts, as proven in the spike (P-022): `dist/` (what ships) and `dist-harness/` (test-only fault injection and negative controls). `scripts/check-artifact.mjs` fails the build if any harness marker, test hook or external URL appears in `dist/`.

## 3. Unit tests (Vitest)

Required for every module; highlights:

- **Engine core with a stand-in DuckDB:** queue ordering; queued cancellation; lease revocation on deadline, cancel, dispose and recovery; a body that never settles cannot hold the queue (QV-ENG-004); late results dropped; generation and epoch arithmetic; recovery timeout → `failed`; every handle settles exactly once within its bound (time-asserted).
- **Lockdown verification:** missing, failed or ineffective controls each prevent `ready` (pure verification function with recorded setting tables).
- **Results:** bounded collection with synthetic Arrow batches (row, column, cell, display, byte truncation reported separately); exact formatting (DECIMAL words, HUGEINT, NULL vs empty string).
- **Datasets:** naming and collision resolution; admission caps; reconciliation diffing catalog snapshots → states `ready/missing/changed/sql/needs-reimport`.
- **Verdict core:** stats derivation and invariants (ported tests); lossless JSON; recogniser against **recorded parser JSON fixtures** for every accepted and refused shape; budget gate pricing (QV-ENG-001); expectation validation and complete outcomes (QV-ENG-007); publication fence decisions (QV-ENG-002); report invalidation rules (QV-ENG-010).
- **Mutation checks** (scripted, run before review): remove each safety layer in turn and confirm at least one test fails (list in §5.4).

## 4. Browser integration tests (Playwright + harness)

Run with real DuckDB-WASM. The harness exposes core services (no UI) and fault-injection points that exist only in `dist-harness/`.

- Engine boot and verified lockdown; recovery re-verifies; escalation probes (remote `read_csv`/`read_parquet`, `ATTACH` of remote files, `INSTALL`/`LOAD`, `SET` after lock) all refused.
- Imports: CSV and Parquet fixtures; null policy (`""` vs NULL, AM-002); quoted commas and escaped quotes; header-only CSV (spike-observed: two VARCHAR columns, zero rows); malformed file; same-name files; cancellation mid-import leaves no partial table; file unregistered after import (`read_csv('/qv-local/…')` fails afterwards).
- Query execution: bounded results and each truncation cause; statement classification and epoch changes; multi-statement policy; user transaction then import/Verdict refusal.
- Verdict: oracle sweep (§5.1), MVP refusals, interference (§5.5), budget gate (§5.8), publication fence under real cancellation and restart.

## 5. Specialised suites

### 5.1 Independent SQL correctness oracle

- `tests/oracle/` holds a Python brute-force nested-loop join that computes every reported statistic (rows, NULL-key rows, distinct and duplicate keys, matched and unmatched rows, matched pairs, multiplied rows, excess copies, relationship, output rows) for INNER and LEFT joins on single and composite keys.
- Each fixture case carries the oracle's expected values. The browser suite compares the production report with the oracle **and** with DuckDB's own `count(*)`/`SEMI JOIN` results for the same data.
- **Reuse:** the spike generator (`make_analysis_fixtures.py`, seed 20261125; 37 named + 200 random cases, 70 MVP-eligible) is ported and re-reviewed. Spike status: implementer-run sweep plus 72 independent Codex comparisons with no discrepancies (**spike-observed**).

### 5.2 Deterministic fixture generation

- All fixtures are synthetic, generated by committed scripts with fixed seeds, small enough to commit under `tests/fixtures/` (the `.gitignore` re-includes `fixtures/` data). Generated benchmark data stays git-ignored (`data/`).
- Regeneration must be byte-identical (checked in CI).
- The demo dataset (M13) is generated the same way and has its own known-answer test.

### 5.3 Engine-semantics qualification suite

Pins every DuckDB behaviour the architecture depends on. Runs in the harness on every engine or extension change and in the release qualification. Each item is **spike-observed** for DuckDB v1.5.4 in Chrome and must become **verified** in production:

| ID | Behaviour asserted |
|---|---|
| ES-01 | Lockdown settings are effective; `SET` after `lock_configuration` fails; autoload/autoinstall off; only `core_functions`, `json`, `parquet` loaded |
| ES-02 | Remote reads, remote `ATTACH`, extension install from a remote host are refused |
| ES-03 | Nested `BEGIN` fails; execution errors abort a transaction; binder errors do not; `ROLLBACK` works after abort |
| ES-04 | Temporary tables and DDL roll back with the transaction |
| ES-05 | `json_serialize_sql` serialises one SELECT, rejects non-SELECT with an error object, and its JSON shape matches the parser adapter's allowlist (recorded fixtures) |
| ES-06 | `duckdb_tables()` / `duckdb_views()` columns used for relation eligibility (oid, database, schema, temporary, `sql` containing `GENERATED`) |
| ES-07 | `ATTACH ':memory:'`, `USE`, `search_path` behaviour relied on by relation resolution |
| ES-08 | CSV defaults and the chosen options (`allow_quoted_nulls`) on `""` and empty fields |
| ES-09 | `castBigIntToDouble: false` keeps BIGINT/HUGEINT/DECIMAL exact through Arrow |
| ES-10 | Cooperative cancellation (`cancelSent`) interrupts a streamed statement; terminate-and-reboot yields a clean engine |
| ES-11 | `DISTINCT … LIMIT` plan is a full `HASH_GROUP_BY` (documents why no such pre-check is used) |
| ES-12 | `connection.prepare()` behaviour on multi-statement text (decides AM-004 detection) |

### 5.4 Adversarial diagnostic tests and mutation checks

- **Refusal corpus:** every construct excluded by PRD QV-VER-001 and §7 (casts, mixed types, non-equality, OR, IS NOT DISTINCT FROM, views, file-backed relations, CTEs, subqueries, WHERE/GROUP BY/ORDER BY/LIMIT/DISTINCT/QUALIFY, set operations, windows, RIGHT/FULL/CROSS/ASOF/NATURAL, table functions, qualified names, generated columns, ambiguous names, tables in another schema, text keys, collations, unknown parser fields) → `unsupported` or `inconclusive` with a reason and no authoritative evidence.
- **Hostile inputs:** quoted identifiers with dots, spaces, escaped quotes, reserved words; aliases with spaces; HTML-looking cell values and table names rendered as text; huge cells; wide rows; keys beyond 2^53; NULL components in composite keys; empty sides; skewed keys; offsetting fan-out and loss.
- **Mutation checks (must each fail ≥ 1 test):** budget gate bypassed for witnesses; publication fence removed; lease not revoked; queued cancel ignored; witness verification removed; end fingerprint ignored; views accepted as eligible; lossless JSON replaced by `JSON.parse`; BigInt replaced by Number; expectation outcomes dropped on early exit; truncated diagnostic accepted; lockdown verification skipped; harness marker allowed in `dist/`.

### 5.5 Snapshot consistency tests

Deterministic, triggered from harness hooks at known points of an analysis:

- user `UPDATE`, import, removal, re-import and a second analysis submitted mid-analysis are queued and run after it; the report describes one snapshot (spike-observed pattern, H-A);
- a write injected *inside* the lease (simulated defect) is caught by witness identity or end fingerprints → `inconclusive`, never authoritative;
- volatile view, generated column, temporary-table shadowing, attached database after `USE` → refused or non-authoritative;
- open user transaction → `transaction-unavailable`.

### 5.6 Cancellation and recovery tests

- Cancel queued (no engine work), cancel active (cooperative), cancel that hangs/rejects/does not stop (terminate + recover), cancel between statements of an analysis, cancel during import.
- Recovery success: generation increments, lockdown re-verified, datasets `needs-reimport`, reports historical, editor text intact.
- Recovery failure (injected lockdown failure on reboot): state `failed`, SQL/import/Verdict refused, retry available.
- Every path settles within its documented bound (asserted with timers; foreground only).

### 5.7 Worker lifecycle fault injection

Stand-in engines (unit) and harness hooks (browser) inject: stalled RPC; rejected RPC; cancel that returns without stopping; late responses after settlement; operation body that never settles (QV-SA-005); stalled cleanup/`ROLLBACK`; boot step that never completes; disposal during boot, during a queued operation and during an active one; StrictMode double mount (no second engine).

### 5.8 Resource-budget tests

- **QV-SA-001 regression:** 3 × 4 same-key join with execution budget 1 → zero pair-producing probes (asserted from the probe trace and frequency-derived costs), witnesses `not-run`, report not authoritative; within budget, witnesses verified.
- Cumulative witness cost across many fan-out keys; unknown estimates; over-budget inputs and grouping estimates refuse **before** any grouping statement runs; key-column limit; truncated probe output rejected.
- Result bounds (P-020) for each truncation cause; admission caps for imports.

### 5.9 Network isolation and privacy

- Playwright records every request from the page **and its workers** during boot, import, Run SQL, Verdict, cancellation and recovery, with a local listener as the "external" target. Assertion: only same-origin static GETs; no request carries canary values (file content, column names, SQL text, witness values).
- Positive controls (harness only) prove the capture sees worker traffic and that a disallowed request would be detected (spike-proven pattern).
- URL, `localStorage`, `sessionStorage`, IndexedDB, Cache Storage and cookies contain no private data after a session (QV-SEC-003).
- Meta CSP present in `dist/` (page-level defence only; it does not govern the worker, ARCHITECTURE §24 V3).

### 5.10 Dependency, licence and artifact checks

- `npm ci` from the lockfile; exact pins; no install scripts beyond the documented ones.
- `scripts/notices.mjs` inventories direct and transitive runtime dependencies, WASM bundles and extensions with their licence texts; the build fails on an unknown or disallowed licence (allowlist set with the project licence). DuckDB-WASM's MIT text is taken from the upstream repository because the npm package lacks it (ARCHITECTURE §24 V6); Arrow's NOTICE is included.
- Extension hashes match `extensions.lock.json`.
- `check-artifact.mjs`: no harness markers, no external URLs in shipped JS/HTML (allowlisted documentation links only in HTML anchors), asset inventory and sizes recorded.
- Secret and large-file scan on staged changes (tool chosen in M01; AGENTS.md §13).

### 5.11 Accessibility

- **Automated:** axe-core in Playwright on every P0 view and state (empty, demo, importing, running, results, Verdict variants, errors, recovery, dialogs), both themes. Zero violations of WCAG 2.2 A/AA rules axe can detect.
- **Keyboard:** scripted flows complete UX-001…UX-006 without a pointer; focus order, visible focus, editor Tab escape, splitter keyboard resizing, dialog focus containment and restoration.
- **Manual (per release):** VoiceOver (Safari, macOS) and NVDA (Firefox or Chrome, Windows) on the qualified matrix; 200 % zoom; 320 CSS px reflow for non-tabular UI (data tables are exempt from SC 1.4.10, ARCHITECTURE §24 V17); forced colours; reduced motion; contrast of resolved token pairs (the proposed tokens pass computed contrast, design review 2026-11-26).

### 5.12 Browser compatibility qualification

| Tier | Browsers | How |
|---|---|---|
| CI | Playwright Chromium, Firefox and WebKit on Linux | every PR (WebKit is not Safari) |
| Release | current desktop Chrome, Firefox, Safari on macOS (reference M2 MacBook Air 8 GB); Chrome or Firefox on Windows if available | manual + scripted against the deployed site |

A browser is listed as supported only after the full release checklist passes on it, with exact versions recorded. Only Chrome has spike evidence today.

### 5.13 GitHub Pages deployment verification

After every deployment (manual dispatch until releases are automated): load the real project URL in a clean profile; verify asset paths under the subpath, MIME types for `.wasm` and workers, first-load bytes and time, engine boot with verified lockdown, demo, import, Run SQL, Verdict, and the network capture of §5.9 on the deployed origin. Results recorded in `docs/qualification/`. **No deployment happens before the licence and notices gate (AM-022).**

## 6. End-to-end user flows

UI_SPECIFICATION §8 acceptance UX-001 … UX-007, automated where possible against `dist/`, each linked to PRD IDs. Every flow asserts that editor text survives, statuses are announced once (live region), and no hidden-panel update moves focus.

## 7. Reproducible performance benchmarks

**Verified/spike-observed today (Chrome only, headless, reference machine):** bounded results with 0 long tasks over 50 ms (rendering not tested); MVP analysis ≈ 140 ms at 1 M and ≈ 600 ms at 5 M in-memory rows with 40 statements; cooperative cancel acknowledgement in the hundreds of milliseconds; historical 50 MB–1 GB runs classified `historical-unvalidated` (FEASIBILITY §9, §13.12). None of these is a production claim.

**Targets (to be qualified, not advertised until passed):**

| Metric | Target | Method |
|---|---|---|
| Cancel acknowledgement visible | ≤ 200 ms | timestamp from activation to status text, visible window |
| Main-thread long tasks during bounded result render | none > 200 ms | Long Tasks API (Chromium); Performance panel traces (Firefox, Safari) |
| Import + Verdict at the candidate ceiling | 50 MB combined CSV/Parquet (P-041), pass/fail per browser | release harness with fixed fixtures |
| First load | budget set by AM-015 | DevTools network capture on the deployed site, cold cache |
| Peak memory | recorded, not a target | OS process sampling (`ps` RSS of the browser process tree, 250 ms) on the reference machine; engine `duckdb_memory()` separately |

**Rules:** fixed fixtures and seeds; recorded browser version, OS, commit, profile, cold/warm, visible window; each run produces a machine-readable record; acceptance logic is separate from harness completion (P-023). **No 1 GB support claim** is made; tiers above the qualified ceiling remain experimental and are not run without maintainer approval.

## 8. Continuous integration (GitHub Actions)

| Job | Trigger | Contents | Required to merge |
|---|---|---|---|
| `verify` | PR, push to `main` | `npm ci`, typecheck, lint, Vitest, Python oracle tests, fixture byte-identity | yes |
| `build` | PR | production + harness builds, `check-artifact`, notices inventory, extension hash check | yes |
| `browser` | PR | Playwright harness + production suites on Chromium, Firefox, WebKit (Linux) | yes (Chromium); Firefox/WebKit advisory until M02 qualifies them, then required |
| `a11y` | PR touching UI | axe suite | yes once M01 shell exists |
| `deploy` | manual dispatch (maintainer) | build + `actions/upload-pages-artifact` + `actions/deploy-pages` + post-deploy smoke | not a merge check; gated on AM-022 |

Standard GitHub-hosted runners are free for public repositories (ARCHITECTURE §24 V1). Merge order stays: implementer verification → Codex review → required CI → maintainer merge (P-011).

## 9. Release-blocking acceptance criteria

A public release requires **all** of:

1. Every QV-ENG requirement's tests pass (§10), including QV-SA-001/002 regressions (public Verdict enablement) and QV-SA-003/005 (engine qualification), confirmed by independent review.
2. Oracle and DuckDB comparisons pass on the full fixture corpus; mutation checks all caught.
3. Engine-semantics suite passes on the shipped engine version in every supported browser.
4. Network isolation and privacy suite passes on the **deployed** site in every supported browser.
5. Accessibility: zero automated violations; manual checklist complete with no release-blocking failures.
6. Release profile published with only passed workloads and measured values (method recorded).
7. Licence, `THIRD_PARTY_NOTICES`, demo data terms shipped; artifact inventory reviewed.
8. Maintainer approval of the release.

## 10. Engineering acceptance test catalogue

| Requirement | Tests (all must pass) |
|---|---|
| QV-ENG-001 budget gate | T-ENG-001a 3×4 join, budget 1: zero pair-producing probes, witnesses `not-run`, not authoritative · 001b within budget: witnesses verified · 001c cumulative witness cost refused past the limit · 001d mutation: gate bypass caught |
| QV-ENG-002 publication fence | T-ENG-002a–d cancel / restart / recovery / dispose injected after the last probe, after `ROLLBACK`, after lease release and before store hand-off → non-authoritative, no held/violated outcomes · 002e uninterrupted run authoritative · 002f mutation: fence removed caught |
| QV-ENG-003 bounded recovery | T-ENG-003a recovery success re-verifies lockdown and marks datasets `needs-reimport` · 003b boot never completes → `failed` within `recoveryTimeoutMs`; queued work settles · 003c no file is reattached after recovery |
| QV-ENG-004 revocable lease | T-ENG-004a body never settles: a later `run('SELECT 1')` completes within the outer bound · 004b no statement through a revoked lease reaches the engine · 004c dispose settles every handle `stale` · 004d mutation caught |
| QV-ENG-005 snapshot | T-ENG-005a–g: the §5.5 scenarios |
| QV-ENG-006 exact numerics | T-ENG-006a key values beyond 2^53 · 006b DECIMAL(38,·) and HUGEINT cells exact · 006c BigInt derivation with synthetic statistics beyond 2^53 · 006d mutation Number/JSON.parse caught |
| QV-ENG-007 outcomes | T-ENG-007a every early-exit path × 5 expectations incl. invalid ones: index, identity, reason · 007b stale/cancelled runs: all unchecked · 007c mutation caught |
| QV-ENG-008 fail-closed boot | T-ENG-008a each omitted/failed/ineffective control blocks `ready` and terminates the candidate · 008b recovery path identical · 008c no SQL/import/Verdict before `ready` · 008d escalation probes refused |
| QV-ENG-009 bounded results | T-ENG-009a each truncation cause reported separately · 009b truncated diagnostic rejected as evidence · 009c huge cell and wide row keep UI responsive (target §7) |
| QV-ENG-010 stamps | T-ENG-010a edit SQL → historical · 010b mutating statement → epoch change → historical; read-only SELECT → unchanged · 010c recovery → historical |
| QV-ENG-011 inventory | T-ENG-011a SQL-created table appears with origin `sql` · 011b user `DROP`/rename/replace → `missing`/`changed` |
| QV-ENG-012 CSV nulls | T-ENG-012 `""` vs empty field vs `NULL` text, per the approved policy |
| QV-ENG-013 statements | T-ENG-013a classification · 013b multi-statement policy · 013c open user transaction refuses import and Verdict |
| QV-ENG-014 queued cancel | T-ENG-014 cancel before start: no engine work, settles `cancelled` |
| QV-ENG-015 exclusions | T-ENG-015 metric/grain expectations and excluded constructs are unsupported/unchecked; no UI entry point |
