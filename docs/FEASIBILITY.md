# Feasibility Study

> **Status: PENDING.** Not yet written. Do not treat this document as a specification, and do not infer its contents.
>
> Owner: ChatGPT (research), with Claude Code spikes if needed; maintainer approval. Each spike needs its own scoped maintainer approval ([CLAUDE.md](../CLAUDE.md), working rules).

## Intended scope

Validation of the provisional stack in [DECISIONS.md](DECISIONS.md): DuckDB-WASM on GitHub Pages (no COOP/COEP headers), memory limits on the reference hardware, licence compatibility, and bundle size.

Required to approve the engine: **network isolation.** DuckDB-WASM can read remote URLs and fetch extensions at runtime. The study must show that the engine can be configured to make no third-party requests (self-hosted assets, remote reads and extension autoloading disabled or restricted). It must also list every request the app is allowed to make.
