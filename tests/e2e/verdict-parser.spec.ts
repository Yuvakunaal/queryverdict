// ES-05 (TESTING_STRATEGY §5.3): DuckDB's parser output for the Verdict corpus matches the recorded
// fixtures that the recogniser unit tests read (tests/fixtures/verdict/parser/v1.5.4.json). If the
// engine changes its JSON, this fails and the recogniser must be re-qualified. To re-record after a
// deliberate engine change: QV_RECORD_PARSER=1 npx playwright test verdict-parser --project=chromium
import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HARNESS } from './helpers';

const CASES = JSON.parse(readFileSync(path.resolve('tests/fixtures/verdict/parser-cases.json'), 'utf8')) as Record<string, Record<string, string>>;
const OUT = path.resolve('tests/fixtures/verdict/parser/v1.5.4.json');

test('ES-05 parser output for the Verdict corpus matches the recorded fixtures (DuckDB v1.5.4)', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__qvHarness?.verdict !== undefined);
  const all = Object.values(CASES).flatMap((group) => Object.entries(group));
  const live = await page.evaluate(async (all) => {
    const V = window.__qvHarness!.verdict!;
    await V.setup();
    const out: Record<string, string> = {};
    for (const [name, sql] of all) out[name] = await V.serialize(sql);
    return { engine: V.current().session.info?.duckdb, out };
  }, all);
  expect(live.engine).toBe('v1.5.4');
  if (process.env.QV_RECORD_PARSER) {
    writeFileSync(OUT, `${JSON.stringify({ engine: live.engine, recordedWith: 'tests/e2e/verdict-parser.spec.ts', outputs: live.out }, null, 1)}\n`);
    return;
  }
  const recorded = JSON.parse(readFileSync(OUT, 'utf8')) as { engine: string; outputs: Record<string, string> };
  expect(recorded.engine).toBe(live.engine);
  expect(live.out).toEqual(recorded.outputs);
});
