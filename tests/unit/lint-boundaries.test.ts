import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Proves the architecture boundaries in eslint.config.js are enforced (docs/ARCHITECTURE.md §3, §19).
const eslint = new ESLint();
const lint = async (filePath: string, code: string) => {
  const [r] = await eslint.lintText(code, { filePath });
  return (r?.messages ?? []).map((m) => m.ruleId);
};

describe('lint boundaries', () => {
  it('forbids React and UI-layer imports in src/core', async () => {
    expect(await lint('src/core/x.ts', "import { useState } from 'react';\nexport const a = useState;\n")).toContain('no-restricted-imports');
    expect(await lint('src/core/x.ts', "import { Button } from '../../ui/Button';\nexport const a = Button;\n")).toContain('no-restricted-imports');
    expect(await lint('src/core/x.ts', "import { createStore } from '../../stores/createStore';\nexport const a = createStore;\n")).toContain('no-restricted-imports');
  });

  it('allows framework-free core code', async () => {
    expect(await lint('src/core/x.ts', "import { DEFAULT_PROFILE } from './profile/profile';\nexport const a = DEFAULT_PROFILE;\n")).toEqual([]);
  });

  it('forbids importing the test harness from production code', async () => {
    expect(await lint('src/app/x.ts', "import '../../harness/main';\n")).toContain('no-restricted-imports');
  });

  it('forbids dangerouslySetInnerHTML anywhere', async () => {
    expect(await lint('src/app/x.tsx', 'export const A = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;\n')).toContain('no-restricted-syntax');
  });

  it('forbids explicit any', async () => {
    expect(await lint('src/app/x.ts', 'export const a: any = 1;\n')).toContain('@typescript-eslint/no-explicit-any');
  });

  it('forbids raw-HTML sinks reached indirectly (Codex 7.5)', async () => {
    const sink = 'no-restricted-syntax';
    expect(await lint('src/app/x.tsx', 'const p = { dangerouslySetInnerHTML: { __html: "x" } };\nexport const A = () => <div {...p} />;\n')).toContain(sink);
    expect(await lint('src/app/x.ts', "import { createElement } from 'react';\nexport const a = createElement('div', { dangerouslySetInnerHTML: { __html: 'x' } });\n")).toContain(sink);
    expect(await lint('src/app/x.ts', "export const a = { ['dangerouslySetInnerHTML']: 1 };\n")).toContain(sink);
    expect(await lint('src/app/x.ts', 'export function f(el: HTMLElement) { el.innerHTML = "x"; }\n')).toContain(sink);
    expect(await lint('src/app/x.ts', 'export function f(el: HTMLElement) { el["outerHTML"] = "x"; }\n')).toContain(sink);
    expect(await lint('src/app/x.ts', 'export function f(el: HTMLElement) { el.insertAdjacentHTML("beforeend", "x"); }\n')).toContain(sink);
    expect(await lint('src/app/x.ts', 'export function f() { document.write("x"); }\n')).toContain(sink);
    expect(await lint('src/app/x.tsx', 'export const A = () => <iframe srcDoc="x" />;\n')).toContain(sink);
  });

  it('forbids code evaluation and non-literal dynamic imports (Codex 7.5)', async () => {
    expect(await lint('src/app/x.ts', 'export const a = eval("1");\n')).toContain('no-eval');
    expect(await lint('src/app/x.ts', 'export const a = new Function("return 1");\n')).toContain('no-new-func');
    expect(await lint('src/app/x.ts', "const m = 're' + 'act';\nexport const a = import(m);\n")).toContain('no-restricted-syntax');
    expect(await lint('src/app/x.ts', 'export const a = import(`react`);\n')).toContain('no-restricted-syntax');
  });
});
