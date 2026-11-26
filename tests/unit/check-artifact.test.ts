import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkArtifact } from '../../scripts/check-artifact.mjs';
import { CSP } from '../../scripts/csp.mjs';

const dirs: string[] = [];
const escape = (s: string) => s.replaceAll("'", '&#39;');
const META = `<meta http-equiv="Content-Security-Policy" content="${escape(CSP)}">`;
const SCRIPT = '<script type="module" crossorigin src="/queryverdict/assets/index.js"></script>';
const CSS = '<link rel="stylesheet" crossorigin href="/queryverdict/assets/index.css">';
const page = (head: string, body = '<div id="root"></div>') => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
const goodIndex = page(`${META}<meta charset="UTF-8"><title>QueryVerdict</title>${SCRIPT}${CSS}`);
const clean = {
  'index.html': goodIndex,
  'assets/index.js': 'const ns="http://www.w3.org/2000/svg";const e="https://react.dev/errors/418";',
  'assets/index.css': 'body{color:red}',
};

function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'qv-artifact-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}
const check = (files: Record<string, string>) => checkArtifact(fixture(files)).errors;
const withIndex = (html: string) => check({ ...clean, 'index.html': html });

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('check-artifact: accepted build', () => {
  it('accepts a clean build, including the exact inert identifier URLs in JS', () => {
    const r = checkArtifact(fixture(clean));
    expect(r.errors).toEqual([]);
    expect(r.inventory.map((f) => f.file).sort()).toEqual(['assets/index.css', 'assets/index.js', 'index.html']);
  });
});

describe('check-artifact: effective CSP (Codex 7.5 HIGH)', () => {
  it('rejects an empty entry point', () => {
    expect(withIndex('')).toEqual(expect.arrayContaining(['index.html: no Content-Security-Policy meta element', 'index.html: no module script entry point (empty or broken page)']));
  });

  it('rejects the exact CSP inside a comment', () => {
    expect(withIndex(page(`<!-- ${META} -->${SCRIPT}`))).toContain('index.html: no Content-Security-Policy meta element');
  });

  it('rejects the exact CSP in the body (ignored by browsers)', () => {
    expect(withIndex(page(SCRIPT, META))).toContain('index.html: the Content-Security-Policy meta element is not a child of <head> (browsers ignore it elsewhere)');
  });

  it('rejects a CSP placed after a resource it should govern', () => {
    expect(withIndex(page(`${SCRIPT}${META}`))).toContain('index.html: <script> appears before the Content-Security-Policy meta element');
  });

  it('rejects duplicate, altered and missing CSP content', () => {
    expect(withIndex(page(`${META}${META}${SCRIPT}`))).toContain('index.html: 2 Content-Security-Policy meta elements (exactly one expected)');
    expect(withIndex(page(`${META.replace('connect-src &#39;self&#39;', 'connect-src *')}${SCRIPT}`))[0]).toMatch(/^index\.html: CSP differs/);
    expect(withIndex(page(`<meta http-equiv="content-security-policy">${SCRIPT}`))[0]).toMatch(/^index\.html: CSP differs/);
  });

  it('rejects a second HTML entry point and inline scripts in any HTML file', () => {
    const errors = check({ ...clean, 'other.html': page('', '<script>alert(1)</script>') });
    expect(errors).toEqual(expect.arrayContaining(['other.html: unexpected file in the build (not index.html or an allowed asset)', 'other.html: inline <script> (forbidden by the CSP)']));
    expect(withIndex(page(`${META}${SCRIPT}`, '<script>alert(1)</script>'))).toContain('index.html: inline <script> (forbidden by the CSP)');
  });

  it('rejects event-handler attributes, javascript: URLs and srcdoc', () => {
    expect(withIndex(page(`${META}${SCRIPT}`, '<img src="x.png" onerror="alert(1)">'))).toContain('index.html: <img> has event-handler attribute onerror');
    expect(withIndex(page(`${META}${SCRIPT}`, '<a href="javascript:alert(1)">x</a>'))).toContain('index.html: <a href> uses a javascript: URL');
    expect(withIndex(page(`${META}${SCRIPT}`, '<iframe srcdoc="x"></iframe>'))).toContain('index.html: <iframe> has a srcdoc attribute');
  });

  it('rejects a module script that points to a missing asset', () => {
    expect(withIndex(page(`${META}<script type="module" src="/queryverdict/assets/missing.js"></script>`))).toContain('index.html: <script> refers to a missing file: assets/missing.js');
  });
});

describe('check-artifact: URLs and markers (Codex 7.5 MEDIUM)', () => {
  it('rejects protocol-relative and entity-encoded cross-origin resource URLs in HTML', () => {
    expect(withIndex(page(`${META}${SCRIPT}`, '<img src="//evil.example/x.png">'))).toContain('index.html: <img src> refers to another origin: https://evil.example/x.png');
    expect(withIndex(page(`${META}${SCRIPT}`, '<img src="&#104;ttps://evil.example/x.png">'))).toContain('index.html: <img src> refers to another origin: https://evil.example/x.png');
  });

  it('never applies the JavaScript inert-string allowlist to HTML resources', () => {
    expect(withIndex(page(`${META}${SCRIPT}`, '<img src="https://react.dev/errors/1">'))).toContain('index.html: <img src> refers to another origin: https://react.dev/errors/1');
  });

  it('rejects uppercase and escaped URLs in JavaScript, and URLs in CSS', () => {
    expect(check({ ...clean, 'assets/a.js': 'fetch("HTTPS://EVIL.EXAMPLE/x")' })).toContain('assets/a.js: contains external URL HTTPS://EVIL.EXAMPLE/x');
    expect(check({ ...clean, 'assets/a.js': 'fetch("https:\\/\\/evil.example\\/x")' })).toContain('assets/a.js: contains external URL https://evil.example/x');
    expect(check({ ...clean, 'assets/a.js': 'fetch("\\u0068ttps://evil.example/x")' })).toContain('assets/a.js: contains external URL https://evil.example/x');
    expect(check({ ...clean, 'assets/a.css': 'a{background:url(https://react.dev/errors/1)}' })).toContain('assets/a.css: contains external URL https://react.dev/errors/1');
    expect(check({ ...clean, 'assets/a.css': 'a{background:url(//evil.example/x.png)}' })).toContain('assets/a.css: CSS refers to a protocol-relative URL');
  });

  it('allows only the exact namespace URIs, not other w3.org addresses', () => {
    expect(check({ ...clean, 'assets/a.js': 'fetch("http://www.w3.org/2000/svg-extra")' })).toContain('assets/a.js: contains external URL http://www.w3.org/2000/svg-extra');
  });

  it.each(['qv-harness', '__qvHarness', 'testHooks', 'harnessReady', 'QV-HARNESS'])('rejects harness marker %s in any file and extension', (marker) => {
    expect(check({ ...clean, 'assets/extra.js': `window["${marker}"]=1` })).toContain(`assets/extra.js: contains test-harness marker "${marker.toLowerCase()}"`);
    expect(check({ ...clean, 'page.htm': `<p>${marker}</p>` })).toEqual(expect.arrayContaining(['page.htm: unexpected file in the build (not index.html or an allowed asset)', `page.htm: contains test-harness marker "${marker.toLowerCase()}"`]));
  });

  it('rejects files outside the expected build inventory and a missing build', () => {
    expect(check({ ...clean, 'assets/index.js.map': '{}' })).toContain('assets/index.js.map: unexpected file in the build (not index.html or an allowed asset)');
    expect(check({ ...clean, 'robots.txt': 'x' })).toContain('robots.txt: unexpected file in the build (not index.html or an allowed asset)');
    expect(checkArtifact(join(tmpdir(), 'qv-does-not-exist')).errors[0]).toMatch(/^build directory not found/);
  });
});
