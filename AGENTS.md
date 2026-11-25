# AGENTS.md — Shared Engineering Rules

These rules apply to **every** coding agent working on QueryVerdict (Claude Code, Codex, and any future agent) and to human contributors acting on agent output. Agent-specific files (e.g. [CLAUDE.md](CLAUDE.md)) add to these rules; they never relax them.

## 1. Project status

QueryVerdict is in the **planning stage**. No application code exists yet. Check [docs/PROGRESS.md](docs/PROGRESS.md) for the current state before assuming anything exists.

## 2. Roles

| Agent | Role |
|---|---|
| ChatGPT | Research, requirements, architecture, planning, independent evaluation |
| Claude Code | Primary implementation engineer |
| Codex | Independent code reviewer and verification engineer |

| Human project owner (maintainer) | Approves architecture decisions, implementation scope, commits, merges, pushes, deployments and public releases |

- Only one agent modifies the repository at a time. **Never modify files concurrently with another agent.** If you see uncommitted changes you did not make, stop and ask the maintainer before touching them.
- Reviewers report findings; they do not silently rewrite the implementer's work unless the maintainer asks them to.
- Agents propose; the maintainer approves. No agent commits, pushes, merges, tags, releases or deploys without the maintainer's explicit authorisation for that specific action.

## 3. Read before you build

Before starting implementation work, read:

1. [docs/PROGRESS.md](docs/PROGRESS.md): current status and open work.
2. [docs/DECISIONS.md](docs/DECISIONS.md): confirmed and provisional decisions.
3. [docs/PROJECT_VISION.md](docs/PROJECT_VISION.md): objectives and non-negotiable constraints.
4. Whichever of these apply to the task: [PRD](docs/PRD.md), [ARCHITECTURE](docs/ARCHITECTURE.md), [IMPLEMENTATION_PLAN](docs/IMPLEMENTATION_PLAN.md), [TESTING_STRATEGY](docs/TESTING_STRATEGY.md), [DESIGN_SYSTEM](docs/DESIGN_SYSTEM.md), [FEASIBILITY](docs/FEASIBILITY.md), [COMPETITOR_RESEARCH](docs/COMPETITOR_RESEARCH.md).

If a document you need is marked **PENDING**, do not invent its contents. Raise the gap with the maintainer.

## 4. Specifications are authoritative

- **Never silently change an approved specification.** If the implementation needs to depart from a spec, stop, explain why, and get approval. Then record the change in [docs/DECISIONS.md](docs/DECISIONS.md).
- Provisional decisions (marked as such in DECISIONS.md) must be validated before production code depends on them.

## 5. Non-negotiable constraints

Every change must respect these. A change that breaks one is rejected however useful it is.

- Zero mandatory recurring infrastructure costs.
- No cloud backend, hosted database, paid API, or mandatory LLM.
- No mandatory user registration.
- User datasets stay on the user's device. No telemetry or network call may send dataset contents, schemas, query text, or results off-device.
- At runtime the app may only make network requests for its own same-origin static assets. That includes the SQL engine: no remote file reads and no runtime extension downloads from third-party hosts. Any exception needs a recorded maintainer decision.
- Website users install nothing. The app is a static site deployable to GitHub Pages.
- The project is free and open source.

## 6. Verify assumptions

- Check library APIs, browser capabilities, and licence terms against primary sources (official docs, source code, licence files) before relying on them. Do not rely on memory alone.
- Check that a file, function, or config actually exists before you reference it.
- If you cannot verify something, say so explicitly. Do not present a guess as fact.

## 7. Honesty and disclosure

- **Never fabricate** benchmarks, test results, correctness results, performance figures, or implementation status.
- Performance claims must cite a reproducible benchmark: dataset, hardware, browser and version, commit, method.
- When you report work, disclose known limitations, skipped steps, failing tests, and untested paths.
- Do not mark a task complete if any part of it is unfinished or unverified.
- Do not claim unlimited dataset support. State tested limits only.

## 8. Correctness findings

Running a SQL query without errors does not prove its results are correct. Anything QueryVerdict reports to users, and any analysis agents write about it, must keep these categories separate and label each one:

| Category | Meaning | Example |
|---|---|---|
| **Confirmed issue** | Reproducible evidence shows the result conflicts with a **known** requirement, such as a result grain or key the user declared | The user declared one row per `order_id`, and the result has 3 rows for order 1042 because of a join. The rows and multiplicity are shown |
| **Suspicious pattern** | Often a mistake, but may be intended. Present it as a warning with its measured evidence, not as a bug | A join multiplies rows and changes `SUM(amount)` while the intended grain is unknown. Also: a `LEFT JOIN` followed by a `WHERE` filter on the right-hand table |
| **Unsupported query** | QueryVerdict cannot analyse this query, so no verdict is given | A construct the analysis engine does not handle. Say so instead of staying silent |
| **Expectation violation** | A result breaks an explicit business or metric rule the user defined | A user rule says "revenue ≥ 0" and a row is negative |

- Measurements (row multiplicity, row loss, duplicate and NULL counts, aggregate changes) are **evidence**, not verdicts. One-to-many and many-to-many joins are often intended, and a measured fan-out alone does not make a result wrong.
- Classify a finding as a confirmed issue only when the requirement it conflicts with is known. If the intent is unknown, report it as a suspicious pattern.
- Never present a suspicious pattern as a confirmed bug.
- The exact line between a confirmed issue (a declared grain or key) and an expectation violation (a business/metric rule) is still open for the PRD.
- Never treat "no findings" as proof that the results are correct. Say what was checked and what was not.
- Unsupported queries must be reported as unsupported, never as passed.

## 9. Testing

- Run the relevant tests, linters, and type checks before reporting a task complete, and report the actual results.
- New behaviour needs tests. Bug fixes need a regression test where practical.
- Correctness-detection features (fan-out, row loss, duplicates, NULLs, metric validation) need tests with known-answer fixtures, covering both positive and negative cases.
- Never weaken, skip, or delete a test to make a change pass without the maintainer's explicit approval.
- If tests cannot be run (e.g. none exist yet), say so.

## 10. Dependencies

- Avoid unnecessary dependencies. Prefer the platform and existing dependencies.
- Every new runtime dependency needs a justification covering: purpose, alternatives considered, licence (must be compatible with the project licence), bundle-size impact, and maintenance health. Record significant ones in DECISIONS.md.
- Do not add a dependency that phones home, needs an API key, or requires a paid tier.
- Commit lockfiles. Do not hand-edit them.

## 11. Performance and safety

- Keep the main thread responsive. Run heavy work (SQL execution, parsing, profiling) off the main thread.
- Avoid unnecessary dataset copies and full-result materialisation. Prefer streaming, pagination, and virtualisation.
- Long-running operations must be cancellable and subject to resource safeguards.
- Release resources (workers, buffers, registered files, object URLs) on cancellation, failure and teardown. Failures must leave the app usable.
- Document supported workloads and known memory limits. Never imply unlimited dataset support.

## 12. Code quality

- TypeScript in strict mode (once the stack is confirmed). Avoid `any` unless you justify it.
- Small, focused changes. Do not bundle unrelated refactors with feature work.
- Accessibility is a requirement: keyboard navigation, focus management, sufficient contrast, ARIA where needed.
- No secrets, credentials, `.env` files, or personal datasets in the repository.

## 13. Version control

- `main` is the reviewed, stable branch. Do not work directly on it once implementation starts.
- Use short-lived branches named by purpose: `feat/…`, `fix/…`, `docs/…`, `chore/…`, `test/…`, `perf/…`, `exp/…` (for experiments and spikes).
- One logical task per branch and per commit. Review the diff before proposing a commit.
- Before proposing a commit, list every file that will be staged (`git status --short`, and `git diff --cached --name-only` once staged). Check that none is a credential, private dataset, export, local database, or large generated file. A file not being git-ignored does not mean it is safe to commit.
- Merge order for `main`: the implementer reports verification, Codex completes an independent review, required CI checks pass (once CI exists; [TESTING_STRATEGY](docs/TESTING_STRATEGY.md) will define them), then the maintainer approves and merges.
- Use [Conventional Commits](https://www.conventionalcommits.org/) where practical, e.g. `feat(engine): cancel running query`. Messages say what changed and why.
- Agents recommend commit messages. They do not commit, push, merge, tag, release or deploy unless the maintainer explicitly asks for that action.
- Never force-push, and never rewrite shared or published history.
- Never commit credentials, `.env` files, private or personal datasets, large generated benchmark files, or confidential information. Benchmark datasets are generated locally by script and stay git-ignored.

## 14. After completing a task

1. Update [docs/PROGRESS.md](docs/PROGRESS.md) with what actually changed, its verification status, and known limitations.
2. Record any new or changed decisions in [docs/DECISIONS.md](docs/DECISIONS.md), marked confirmed or provisional.
3. Report to the maintainer: files changed, tests run with their results, limitations, risks, and the recommended next step.
4. Recommend a Conventional Commit message for the change. Do not commit it yourself unless asked.
