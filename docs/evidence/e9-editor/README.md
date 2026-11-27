# E9 editor qualification: measurement harness and raw results

Evidence for [FEASIBILITY.md §15](../../FEASIBILITY.md) and DECISIONS P-052. Not part of the
application: nothing here is built, linted or installed by the repository, and Monaco is not a
dependency of QueryVerdict.

To reproduce (Apple Silicon macOS, installed Google Chrome, Playwright browsers installed):

```sh
mkdir /path/outside/repo/e9 && cp -R docs/evidence/e9-editor/. /path/outside/repo/e9 && cd /path/outside/repo/e9
# vite.config.mjs imports ../../../scripts/csp.mjs: adjust that path to this repository.
npm ci --ignore-scripts                     # exact versions from package-lock.json
npm install --no-save --ignore-scripts @playwright/test@1.65.1 @axe-core/playwright@4.14.1
for n in baseline cm monaco monaco-full; do E9_ENTRY=$n npx vite build; done
node sizes.mjs            # bundle sizes (raw, gzip -9, brotli q11) → sizes.txt
RUNS=7 node measure.mjs   # browser measurements → results.json
```

- `baseline` is the same React page with a plain `<textarea>`, so the editor's incremental cost is
  the difference from it.
- `monaco` is Monaco's minimal ESM API plus the contributions needed for parity (clipboard, Tab
  focus toggle, comment toggling, icon CSS) and its editor worker; `monaco-full` is Monaco's
  default entry, built for size only.
- Method (revised after the Codex M05 review): every trial is a fresh context with the identical
  document; the caret is placed at the document end through each editor's own API and its offset
  asserted before typing and before the paste; typed text is checked exactly; each trial makes one
  real clipboard paste whose length and content are validated. Keyboard checks run once per
  candidate in a separate context. Startup fetches are recorded separately from emitted files.
- `results.json` and `sizes.txt` are the recorded results of the run reported in FEASIBILITY §15;
  `package-lock.json` is the harness's own lockfile.
