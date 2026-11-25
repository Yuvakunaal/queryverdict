# Decisions Log

Each decision is either **Confirmed** (approved; changing it needs maintainer approval and a new entry) or **Provisional** (proposed; must be validated before production code depends on it).

Do not edit a confirmed decision in place. Add a new entry that supersedes it.

## Confirmed

| ID | Decision | Date | Source |
|---|---|---|---|
| D-001 | Project name **QueryVerdict**, tagline "Your query passed. Did your data?" | 2026-11-25 | Maintainer brief |
| D-002 | Free and open source | 2026-11-25 | Maintainer brief |
| D-003 | Client-side only: no cloud backend, hosted database, paid APIs, or mandatory LLMs | 2026-11-25 | Maintainer brief |
| D-004 | User datasets never leave the user's device | 2026-11-25 | Maintainer brief |
| D-005 | No mandatory registration; website users install nothing | 2026-11-25 | Maintainer brief |
| D-006 | Zero mandatory recurring infrastructure costs | 2026-11-25 | Maintainer brief |
| D-007 | Deployment target: GitHub Pages (static hosting) | 2026-11-25 | Maintainer brief |
| D-008 | No fabricated benchmarks, correctness results, or status; no claim of unlimited dataset support | 2026-11-25 | Maintainer brief |
| D-009 | Benchmark reference hardware: Apple M2 MacBook Air, 8 GB RAM. Dataset sizes 50 MB, 200 MB, 500 MB, 1 GB | 2026-11-25 | Maintainer brief |
| D-010 | Agent roles: ChatGPT (research/architecture/planning/evaluation), Claude Code (implementation), Codex (review/verification). No concurrent edits | 2026-11-25 | Maintainer brief |
| D-011 | UI direction: professional developer workspace (VS Code / Linear / Snowsight inspired), dark and light themes, accessible, minimal gradients and animation | 2026-11-25 | Maintainer brief |
| D-012 | The primary product is a website that needs no installation | 2026-11-25 | Maintainer brief |
| D-013 | Findings are reported in four separate categories: confirmed issue, suspicious pattern, unsupported query, user-defined expectation violation. Successful execution is not treated as proof of correctness ([AGENTS.md §8](../AGENTS.md)) | 2026-11-25 | Maintainer brief |
| D-014 | Git workflow: `main` is reviewed and stable; purpose-named branches; one logical task at a time; Conventional Commits where practical; no force-push or history rewriting; no agent commits, pushes, merges, releases or deploys without explicit maintainer authorisation | 2026-11-25 | Maintainer brief |
| D-015 | Engineering standards: modular architecture, strict TypeScript, meaningful automated tests, reproducible benchmarks, CI/CD, security and privacy docs, accessible UI, contribution guidelines, minimal dependencies | 2026-11-25 | Maintainer brief |
| D-016 | Launch channels: GitHub, LinkedIn, dev.to, X. No dependence on Reddit | 2026-11-25 | Maintainer brief |

## Provisional

These must be validated for technical feasibility, compatibility, licensing, and bundle size before they are confirmed.

| ID | Proposal | Validation needed |
|---|---|---|
| P-001 | React + TypeScript | Confirm as UI framework |
| P-002 | Vite build tool | Static build output compatible with GitHub Pages sub-path hosting; WASM and worker asset handling |
| P-003 | DuckDB-WASM as the SQL engine | Licence; bundle size; behaviour without cross-origin isolation (GitHub Pages cannot set COOP/COEP headers); memory limits at the target dataset sizes; query cancellation; CSV/JSON/Parquet support; **network isolation (required to approve):** self-hosted engine and extension assets, no runtime third-party extension fetches, remote reads disabled or restricted, and a tested list of allowed requests; whether Parquet/JSON readers and the SQL parser (`json_serialize_sql`) are built in or need an extension fetch. Experiments E1–E7 and E11 in [FEASIBILITY.md](FEASIBILITY.md) |
| P-004 | Web Workers for off-main-thread execution | Data transfer costs between worker and UI; cancellation model |
| P-005 | Monaco Editor | Bundle size; worker configuration under Vite; offline/self-hosted loading (no CDN dependency); compare with CodeMirror 6 |
| P-006 | React Flow for visual SQL debugging | Licence (MIT core vs Pro features); performance with large plans |
| P-007 | TanStack Table + TanStack Virtual for results | Virtualisation with large, paged results from a worker |
| P-008 | IndexedDB for local persistence | Storage quotas; whether to persist datasets or only metadata/queries; compare with OPFS |
| P-009 | Proposed feature list in [PROJECT_VISION.md](PROJECT_VISION.md) | Scope and priority to be set in the PRD |
| P-010 | Feasibility spikes may install dependencies and write throwaway code before the implementation gate, but only with per-spike maintainer approval, on an `exp/` branch, never merged as production code ([CLAUDE.md](../CLAUDE.md)) | Maintainer approval of this process |
| P-011 | Merge order for `main`: implementer verification, then Codex review, then required CI, then maintainer merge ([AGENTS.md §13](../AGENTS.md)) | Maintainer approval; specific CI checks to be defined in TESTING_STRATEGY |
| P-012 | Clarified the finding definitions behind D-013. The four categories are unchanged. Measured fan-out or row loss is evidence. It is a suspicious pattern unless the conflicting requirement (e.g. a declared grain) is known, which makes it a confirmed issue ([AGENTS.md §8](../AGENTS.md)) | Maintainer approval; the confirmed-issue vs expectation-violation boundary to be settled in the PRD |
| P-014 | Feasibility experiment plan E0–E11, with proposed acceptance thresholds ([FEASIBILITY.md](FEASIBILITY.md)). All experiments NOT RUN | Maintainer approval of the plan, the thresholds and each spike's scope |
| P-015 | SQLite WASM as a fallback engine, used only if DuckDB-WASM fails E1 or E2 (proposed in [COMPETITOR_RESEARCH.md](COMPETITOR_RESEARCH.md)) | Only evaluated if the fallback is triggered |
| P-022 | Negative controls and fault injection live only in a separate **test-only build** (`harness/`, `vite.harness.config.ts`, output `dist-harness/`, never deployed). A test checks that the production artifact contains no harness markers | Approval. The fault-injection option on the session class can only cause startup to fail |
| P-023 | **Benchmark acceptance is separate from harness completion** (`scripts/lib/acceptance.mjs`). A run is accepted only with: validated inputs (SHA-256 vs manifest), recorded provenance, every planned workload present, no failed assertions/unexpected errors/timeouts, and every cancel workload actually exercised. Historical runs are `historical-unvalidated`. The CLI exits non-zero unless accepted | Approval |
| P-024 | **Proposed initial qualification target (not an established limit):** desktop Chrome; file-backed CSV and Parquet up to **50 MB combined** physical input; a small dimension-side equi-join; bounded previews and aggregates. Imported tables, larger inputs, NDJSON and other browsers stay experimental | Must be qualified at its ceiling (skew, wide cells, cancellation, recovery, visible-window responsiveness) before it is advertised. Accepted so far: 21.7 MB Parquet and 51.2 MB CSV (1.2 MB over the ceiling), headless |
| P-025 | Benchmark safeguards apply to every entry point. CLI: resolved paths inside `data/`, actual sizes (over 50 MB needs `--confirm-large`, over 250 MB also `--maintainer-approval`), input hashing, PID lock. Page/manual: sizes vs manifest, hashes up to 50 MB, confirmation above 50 MB, refusal above 1.1 GB, Web Locks single run. Data files are git-ignored everywhere except `fixtures/` | Approval |
| P-013 | Runtime network policy: only same-origin static asset requests. No remote data reads or third-party extension fetches ([AGENTS.md §5](../AGENTS.md)). This puts D-004 into practice | Maintainer approval; whether optional, user-initiated remote URL imports should ever be allowed |
| P-016 | Pin `@duckdb/duckdb-wasm` **1.33.1-dev57.0** (DuckDB v1.5.4, npm `latest` tag) exactly. Ship only the single-threaded `eh` + `mvp` bundles; exclude the threads (`coi`) bundle, which needs COOP/COEP. Use the `apache-arrow` version DuckDB-WASM requires (17.x) | Chrome-only spike evidence ([FEASIBILITY.md §9–§10](FEASIBILITY.md)). **Risk (§10.12):** a development-numbered build. The newest non-dev npm release is 1.32.0 (likely a different DuckDB core, unverified); GitHub v1.33.0 has no npm release. Switching needs a separately approved spike: re-vendor extensions, re-check lockdown settings, re-run all tests. Also needed: Safari/Firefox, a real Pages deployment, the `mvp` fallback, licence notices |
| P-017 | **Engine lockdown is mandatory, fail-closed and verified** (enforces P-013): self-hosted extension repository; auto-install/auto-load/community extensions off; `parquet`/`json` loaded explicitly; user files only under an allowed virtual directory; `enable_external_access = false`; `lock_configuration = true`. Startup and recovery succeed only after the **effective** settings, the loaded-extension set and the lock's rejection of changes are verified; otherwise the candidate worker is terminated. No runtime switch disables it. A page `<meta>` CSP is defence in depth for the page only (it does not restrict the worker) | Spike: 7 injected-fault tests, recovery re-verification, production-artifact request inspection, positive controls (Chrome). Still needed: Safari/Firefox probe runs; a decision on `INSTALL`, which returns without effect under lockdown |
| P-018 | Engine extensions (`parquet`, `json`) are downloaded at build time from `extensions.duckdb.org`, verified against SHA-256 hashes in a committed lock file, and served from the app's own origin. Binaries are not committed | Runtime signature verification by the engine not independently tested; notices for the extension binaries unresolved (§10.12) |
| P-019 | Local files are attached as **file-backed views** by default (read on demand from the browser `File`, no copy into JS memory). Importing into an engine table is an explicit option; after a worker restart, imported tables are marked `needs-reimport` and are never silently dropped or reported as present | Spike: views re-attach cheaply after a restart; imports are cancellable (cooperative, 155 ms in the test). Tables were 3–40× faster per query in the historical runs but cost up to 9 s to import (1 GB tier, historical) |
| P-020 | Query results always stream and are bounded **before** display conversion: rows (1,000), columns (200), characters per cell (500), total display characters (2,000,000), Arrow bytes accepted (16 MiB). Each truncation kind is reported separately | Spike defaults, needing approval. **Engine limitation (§10.2):** batches of up to 2,048 rows are transferred whole from the worker, so a single batch with huge cells is fully allocated before any check runs. No hard memory guarantee |
| P-021 | Dev/test tooling candidates: Vitest (unit, including `.mjs` scripts), Playwright driving the installed Chrome against **two artifacts** (production `dist/` and the test-only `dist-harness/`), a Python standard-library generator (`pyarrow` for Parquet). TypeScript 7.0.2 strict and Vite 8 worked | Approval; Chrome availability on CI runners; how to automate Safari and Firefox |

## Awaiting maintainer decision

- **Research recommendation** ([COMPETITOR_RESEARCH.md](COMPETITOR_RESEARCH.md)): CONDITIONAL GO for user discovery and a feasibility spike, and narrowing the MVP from a general SQL workspace to an evidence-first join/grain debugger. Not adopted. It would change the draft [PROJECT_VISION.md](PROJECT_VISION.md) and P-009.
- **Query-first vs relations-first MVP.** The research makes query parsing conditional. The engineering evaluation ([FEASIBILITY.md §2.1](FEASIBILITY.md)) argues it is the core differentiator and should be tested first (E5).
- **Order of work:** whether the technical spikes may run in parallel with the research's user-discovery gate.
- **Shareable query links:** whether they are ever in scope, given the risk of data leaving the device through crafted SQL ([FEASIBILITY.md §4.2](FEASIBILITY.md)).

- **Spike branch naming:** P-010 says spikes use `exp/` branches. The browser-feasibility spike used `spike/browser-feasibility` on the maintainer's instruction. Should P-010 be amended to allow `spike/`?
- **Spike results ([FEASIBILITY.md §9](FEASIBILITY.md)):** browser-only SQL on local files up to 1 GB (CSV size) worked correctly and responsively in Chrome on the reference machine. Does this evidence, with the remaining gaps (Safari, Firefox, real Pages, licence notices), justify moving P-001–P-004 towards confirmation?

- **Engine version:** keep `1.33.1-dev57.0` for the spike, or approve a spike evaluating `1.32.0` (the newest non-dev npm release)? See [FEASIBILITY.md §10.12](FEASIBILITY.md).
- **Approvals needed to close the browser gaps:** enabling Safari remote automation, installing Firefox, and a throwaway real GitHub Pages deployment.
- **Licence notices:** approve adding a build-time licence/notice extraction step and a `THIRD_PARTY_NOTICES` file before any public deployment.

## Open (no proposal yet)

- Project licence (e.g. MIT vs Apache-2.0). Must be compatible with the licences of the chosen dependencies
- Package manager (npm / pnpm)
- Test tooling (unit, component, end-to-end, benchmark harness)
- Supported browsers and minimum versions
- CI provider and configuration (GitHub Actions is the likely default)
- Benchmark browser(s) and versions on the reference hardware
- Automated secret and large-file scanning in CI or pre-commit (tool not chosen)
- Demonstration datasets: source and licence
- Security and privacy documentation (`SECURITY.md`, privacy statement) and contribution guidelines (`CONTRIBUTING.md`, code of conduct). Required by D-015, not yet written
