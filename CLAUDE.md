# CLAUDE.md

Instructions for Claude Code on QueryVerdict.

**Read [AGENTS.md](AGENTS.md) first.** Its shared rules apply in full. This file only adds Claude-specific responsibilities and never overrides AGENTS.md.

## Role

Claude Code is the **primary implementation engineer**. ChatGPT owns research, requirements, architecture and planning. Codex owns independent review and verification.

## Responsibilities

- Implement approved specifications and plan items from [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) once it is approved.
- Write and maintain tests alongside the implementation.
- Validate provisional technical decisions (feasibility spikes, licence checks, compatibility checks) when asked, and report findings factually.
- Keep [docs/PROGRESS.md](docs/PROGRESS.md) accurate after every task.
- Prepare changes so Codex can review them: clear scope, a summary of what changed, and how it was verified.
- Work on a purpose-named branch (see AGENTS.md §13), one logical task at a time, and recommend a Conventional Commit message when done.
- Build correctness-detection features to the findings taxonomy in AGENTS.md §8. Never report an unanalysed or unsupported query as passing.

## Working rules

- **Current phase: planning.** Do not install dependencies, scaffold the app, or write application source code until the maintainer approves the move to implementation and PROGRESS.md says so.
- **Feasibility spikes** are the only exception, and each one needs its own explicit maintainer approval. The approval states the question, scope and allowed dependencies. Spikes run on an `exp/` branch in an isolated directory, and their code is throwaway: never merged into `main` as production code. Findings go in [docs/FEASIBILITY.md](docs/FEASIBILITY.md) with method and environment. An approved spike does not approve the move to implementation.
- Do not commit or push unless the maintainer explicitly asks.
- Do not edit files while another agent is working on the repository.
- If a spec is ambiguous, missing (marked PENDING), or conflicts with the constraints, stop and ask. Do not fill the gap with assumptions.
- When a provisional decision turns out to be wrong during implementation, report it. Do not quietly work around it.

## Scheduling note

Claude Max access runs until **2026-12-04**. Prefer complex engineering work (DuckDB-WASM worker integration, query cancellation, correctness-detection engines) during that period, but quality and correctness come before the date. After that, Claude Pro remains available.

## Task completion report

At the end of each task, report:

- Files created or modified
- Tests and checks run, with their actual results
- Limitations and anything not verified
- Risks
- Recommended next action
