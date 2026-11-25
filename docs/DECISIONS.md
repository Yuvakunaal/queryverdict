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
| P-013 | Runtime network policy: only same-origin static asset requests. No remote data reads or third-party extension fetches ([AGENTS.md §5](../AGENTS.md)). This puts D-004 into practice | Maintainer approval; whether optional, user-initiated remote URL imports should ever be allowed |

## Awaiting maintainer decision

- **Research recommendation** ([COMPETITOR_RESEARCH.md](COMPETITOR_RESEARCH.md)): CONDITIONAL GO for user discovery and a feasibility spike, and narrowing the MVP from a general SQL workspace to an evidence-first join/grain debugger. Not adopted. It would change the draft [PROJECT_VISION.md](PROJECT_VISION.md) and P-009.
- **Query-first vs relations-first MVP.** The research makes query parsing conditional. The engineering evaluation ([FEASIBILITY.md §2.1](FEASIBILITY.md)) argues it is the core differentiator and should be tested first (E5).
- **Order of work:** whether the technical spikes may run in parallel with the research's user-discovery gate.
- **Shareable query links:** whether they are ever in scope, given the risk of data leaving the device through crafted SQL ([FEASIBILITY.md §4.2](FEASIBILITY.md)).

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
