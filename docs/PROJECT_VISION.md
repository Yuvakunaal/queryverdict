# Project Vision

> Status: **Draft**, initial vision captured during project initialisation (2026-11-25). Changes require maintainer approval.

## Name and tagline

**QueryVerdict**: *Your query passed. Did your data?*

## Summary

QueryVerdict is a free, open-source, browser-native SQL workspace. Users can explore datasets, run SQL queries, visually debug SQL operations, and detect silent data-correctness problems, all without their data leaving their device.

## Problem

A SQL query can run without error and still give wrong results. Joins fan out and inflate aggregates. Filters and inner joins silently drop rows. Duplicates and NULLs distort metrics. These failures are silent: the query "passed". QueryVerdict aims to surface them.

Successful execution does not prove correctness. QueryVerdict will keep four kinds of finding separate: **confirmed issues**, **suspicious patterns**, **unsupported queries**, and **user-defined expectation violations** (defined in [AGENTS.md §8](../AGENTS.md)). It will never present "no findings" as proof of correctness.

## Objectives

- Build a professional developer tool that is genuinely useful in real work.
- Earn organic GitHub stars, adoption, and outside contributions.
- Establish credible open-source engineering practice.
- Maintain production-quality architecture, testing, documentation, and performance.
- Establish engineering credibility that supports future open-source contract work.
- Keep the project sustainable for one maintainer over the long term.

## Non-negotiable constraints

- Zero mandatory recurring infrastructure costs.
- No cloud backend.
- No hosted database.
- No paid APIs or mandatory LLMs.
- No mandatory user registration.
- User datasets stay on the user's device.
- Website users install nothing.
- Completely free and open source.
- Deployed through GitHub Pages.
- Never fabricate benchmarks, correctness results, or implementation status.

## Proposed functionality

*Proposed, not yet specified or prioritised. The scope will be settled in the [PRD](PRD.md).*

**Data ingestion and exploration**
- CSV, JSON, and Parquet ingestion
- Dataset explorer and schema detection
- Data previews and profiling
- Built-in demonstration datasets

**SQL workspace**
- SQL editor with autocomplete and syntax highlighting
- Browser-native SQL execution (DuckDB-WASM proposed)
- Query cancellation and resource safeguards
- Exportable results and diagnostics

**Correctness and debugging**
- Join fan-out detection
- Unexpected row-loss detection
- Duplicate and NULL analysis
- Visual SQL debugging
- Intermediate query inspection
- User-defined business-metric validation

## Performance goals

- Keep the browser responsive. Avoid unnecessary dataset copies and full-result materialisation.
- Support query cancellation, resource cleanup, and failure recovery.
- Document supported workloads and memory limits.
- Benchmark plan: 50 MB, 200 MB, 500 MB, and 1 GB datasets on an Apple M2 MacBook Air with 8 GB RAM. The browser, versions, and method will be defined in the [Testing Strategy](TESTING_STRATEGY.md).
- No guarantee of unlimited dataset size. Supported limits will be published only after real benchmarks.

## UI/UX direction

- A professional developer workspace, inspired by VS Code, Linear, and Snowflake Snowsight.
- Dark and light themes, compact layouts, resizable panels, keyboard shortcuts.
- Accessibility and clear diagnostics are first-class.
- Avoid excessive gradients, heavy animation, and generic AI-generated dashboard aesthetics.

## Launch strategy

- Channels: GitHub, LinkedIn, dev.to and X. The launch will not depend on Reddit publicity or karma.
- Priorities: an instant, no-install demo (built-in datasets), frictionless first use, useful technical writing, and genuine community engagement.
- Public claims about performance or detection must link to reproducible evidence.

## Schedule

- Claude Max is available until **2026-12-04**. Use that period for the hardest engineering: feasibility spikes, DuckDB-WASM worker integration, cancellation, and the correctness-analysis algorithms.
- After that date, development continues with Claude Pro and ChatGPT Plus.
- Quality is never traded for the deadline.

## Out of scope (by constraint)

- Server-side query execution or data storage
- Accounts, sync, or collaboration features that need a backend
- Required AI/LLM features
