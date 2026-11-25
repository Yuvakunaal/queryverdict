# Testing Strategy

> **Status: PENDING.** Not yet written. Do not treat this document as a specification, and do not infer its contents.
>
> Owner: ChatGPT (planning), Codex (verification); maintainer approval

## Intended scope

Unit, component, and end-to-end testing; known-answer correctness fixtures; the benchmark methodology for the 50 MB–1 GB datasets on the reference hardware; CI gates and the checks required before merging to `main`.

Must include **privacy and network-isolation tests**: across import, SQL execution, diagnostics, export, and failure and cancellation paths, assert that the only network requests are allowed same-origin static assets, and that no dataset contents, schemas, SQL text, or results leave the device.
