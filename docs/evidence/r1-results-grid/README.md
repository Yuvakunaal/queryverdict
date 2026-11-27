# R1 results-grid rendering: scripts and raw results

Evidence for [FEASIBILITY.md §16](../../FEASIBILITY.md) and DECISIONS P-096. Not built or linted.

- `r1.mjs`: the measurement (production build, real Run SQL path, fixtures F1–F4, 3 runs per
  fixture and browser). Run from the repository root after `npm run build`:
  `RUNS=3 node docs/evidence/r1-results-grid/r1.mjs` (it starts `vite preview` on port 4173 and
  writes `r1-results.json` next to itself).
- `ResultGrid.plain.tsx`: the plain, non-windowed grid measured as the baseline. Copy it over
  `src/features/results/ResultGrid.tsx`, build, and run `r1.mjs` to reproduce `r1-plain.json`.
- `r1-plain.json`, `r1-windowed.json`: the recorded runs (Chrome 158.0.8127.37, Playwright
  Firefox 159.0 and WebKit 27.2, Apple M2 MacBook Air, 8 GB). Headless; WebKit is not Safari.
