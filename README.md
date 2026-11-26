# QueryVerdict

**Your query passed. Did your data?**

> **Status: early implementation.** Only the application foundation exists (an empty shell with quality gates). There is no usable application yet: no SQL engine, datasets or diagnostics.

QueryVerdict is a planned free, open-source, browser-native SQL workspace for exploring datasets, running SQL, visually debugging queries, and detecting silent data-correctness problems such as join fan-out, unexpected row loss, duplicates, and NULLs. Your data will stay on your device: no backend, no account, no install.

## Documentation

- [Project vision](docs/PROJECT_VISION.md)
- [Progress](docs/PROGRESS.md)
- [Decisions](docs/DECISIONS.md)
- [Competitor research](docs/COMPETITOR_RESEARCH.md)
- [Proposed production requirements](docs/PRD.md)
- [Feasibility study](docs/FEASIBILITY.md)
- [Proposed architecture](docs/ARCHITECTURE.md) · [Implementation plan](docs/IMPLEMENTATION_PLAN.md) · [Testing strategy](docs/TESTING_STRATEGY.md)
- [Design system](docs/DESIGN_SYSTEM.md) · [UI specification](docs/UI_SPECIFICATION.md)
- [Agent and contributor rules](AGENTS.md)

## Development

The production application is at the repository root (the research spike in `spikes/` is separate and excluded). It currently contains only the application foundation (M01): an accessible shell, design tokens and quality gates. There is no SQL engine yet.

Requirements: Node.js 24 (see `.nvmrc`) and npm.

```bash
npm ci                    # install exact, locked dependencies
npm run dev               # development server: http://127.0.0.1:5173/queryverdict/
npm run typecheck         # strict TypeScript (app and tooling configs)
npm run lint              # ESLint + resolved import-boundary check
npm run check:repo        # forbidden files, oversized files, known credential formats
npm test                  # unit tests (Vitest)
npm run build             # type-check, production build to dist/, artifact check
npm run preview           # serve dist/ at http://127.0.0.1:4173/queryverdict/
npm run build:harness     # test-only harness build to dist-harness/ (never deployed)
npm run test:e2e          # browser tests (Playwright: Chromium, Firefox, WebKit)
npm run notices           # runtime licence inventory (from package-lock.json) to build/notices.json
```

Browser tests need Playwright's browsers: `npx playwright install chromium firefox webkit` (locally the Chromium project uses an installed Google Chrome instead; CI installs Playwright's Chromium).

## Contributing

The project is not ready for code contributions yet. Contribution guidelines will be published before the first release.

## Licence

Not yet chosen.
