#!/usr/bin/env node
// Static gate for the production build directory (docs/TESTING_STRATEGY.md §5.10, P-022).
//
// HTML is parsed with parse5 (WHATWG-conformant), so comments, text and attribute entities are
// interpreted exactly as a browser would. The gate fails when:
//  - the file set differs from the expected build inventory (one HTML entry point, index.html;
//    every other file under assets/ with an allowed extension);
//  - index.html has no effective CSP: exactly one <meta http-equiv="Content-Security-Policy"> in
//    <head>, with the exact policy, before any element that loads or applies resources;
//  - index.html loads no module script, or references an asset that does not exist;
//  - any HTML contains an inline script, an event-handler attribute, a javascript: URL, or a
//    resource attribute that resolves to another origin (absolute, protocol-relative or
//    entity-encoded);
//  - any file contains a test-harness marker (all files, any extension, case-insensitive);
//  - shipped JS/CSS contains an external URL after unescaping, other than exact inert identifier
//    strings in JS (XML namespace URIs, React's error-documentation prefix).
// Static scanning cannot establish what arbitrary JavaScript does at runtime: the browser
// network-capture and CSP-enforcement tests are the behavioural checks (tests/e2e/privacy.spec.ts).
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { BASE_PATH, CSP } from './csp.mjs';

export const HARNESS_MARKERS = ['qv-harness', '__qvharness', 'testhooks', 'harnessready'];

/**
 * Inert identifier strings allowed in shipped JavaScript only (never in HTML resource
 * attributes or CSS). Exact namespace URIs, and one documentation prefix used in error text.
 */
export const JS_INERT_URLS = {
  exact: [
    'http://www.w3.org/1999/xhtml',
    'http://www.w3.org/2000/svg',
    'http://www.w3.org/1998/Math/MathML',
    'http://www.w3.org/1999/xlink',
    'http://www.w3.org/XML/1998/namespace',
    'http://www.w3.org/2000/xmlns/',
  ],
  prefixes: ['https://react.dev/errors/'],
};

/** Files allowed in the build. Later modules extend this list explicitly (for example .wasm). */
export const ALLOWED_ASSET = /^assets\/[A-Za-z0-9._-]+\.(js|css)$/;

const RESOURCE_ATTRS = new Set(['src', 'href', 'srcset', 'action', 'formaction', 'poster', 'data', 'xlink:href', 'background', 'manifest', 'ping', 'cite', 'longdesc', 'imagesrcset']);
const ORIGIN = 'https://qv-artifact-check.invalid';
const SITE = new URL(BASE_PATH, ORIGIN);

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * @typedef {{ nodeName: string, tagName?: string, attrs?: { name: string, value: string }[], childNodes?: Node[], content?: Node, value?: string, parentNode?: Node | null }} Node
 */

/**
 * Depth-first element walk in document order (template contents included).
 * @param {Node} node
 * @param {(el: Node) => void} visit
 */
function eachElement(node, visit) {
  for (const child of node.childNodes ?? []) {
    if (child.tagName) {
      visit(child);
      if (child.content) eachElement(child.content, visit);
    }
    eachElement(child, visit);
  }
}

/** @param {Node} el @param {string} name */
const attr = (el, name) => el.attrs?.find((a) => a.name === name)?.value;

/** @param {Node} el */
function textOf(el) {
  return (el.childNodes ?? []).map((c) => (c.nodeName === '#text' ? c.value ?? '' : '')).join('');
}

/**
 * Resolves a resource attribute value against the deployed page URL.
 * @param {string} value
 * @returns {URL | null}
 */
function resolveUrl(value) {
  try {
    return new URL(value.trim(), SITE);
  } catch {
    return null;
  }
}

/**
 * Checks one parsed HTML document.
 * @param {string} rel path relative to the build root
 * @param {string} html
 * @param {boolean} isEntry whether this is index.html
 * @param {(assetPath: string) => boolean} assetExists
 * @returns {string[]}
 */
function checkHtml(rel, html, isEntry, assetExists) {
  /** @type {string[]} */
  const errors = [];
  const doc = /** @type {Node} */ (/** @type {unknown} */ (parse(html)));
  /** @type {Node[]} */
  const elements = [];
  eachElement(doc, (el) => elements.push(el));

  for (const el of elements) {
    for (const a of el.attrs ?? []) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on')) errors.push(`${rel}: <${el.tagName}> has event-handler attribute ${name}`);
      if (name === 'srcdoc') errors.push(`${rel}: <${el.tagName}> has a srcdoc attribute`);
      if (!RESOURCE_ATTRS.has(name)) continue;
      const values = name.endsWith('srcset') ? a.value.split(',').map((c) => c.trim().split(/\s+/)[0] ?? '') : [a.value];
      for (const v of values) {
        if (!v) continue;
        const url = resolveUrl(v);
        if (!url) errors.push(`${rel}: <${el.tagName} ${name}> is not a valid URL: ${v}`);
        else if (url.protocol === 'javascript:') errors.push(`${rel}: <${el.tagName} ${name}> uses a javascript: URL`);
        else if (url.protocol !== 'data:' && url.protocol !== 'blob:' && url.origin !== ORIGIN) errors.push(`${rel}: <${el.tagName} ${name}> refers to another origin: ${url.href}`);
      }
    }
    if (el.tagName === 'script') {
      if (attr(el, 'src') === undefined) errors.push(`${rel}: inline <script> (forbidden by the CSP)`);
      else if (textOf(el).trim()) errors.push(`${rel}: <script src> with inline content`);
    }
  }

  if (!isEntry) return errors;

  const html_ = elements.find((e) => e.tagName === 'html');
  const head = html_?.childNodes?.find((c) => c.tagName === 'head');
  const cspMetas = elements.filter((e) => e.tagName === 'meta' && (attr(e, 'http-equiv') ?? '').toLowerCase() === 'content-security-policy');
  if (cspMetas.length === 0) errors.push(`${rel}: no Content-Security-Policy meta element`);
  else if (cspMetas.length > 1) errors.push(`${rel}: ${cspMetas.length} Content-Security-Policy meta elements (exactly one expected)`);
  const csp = cspMetas[0];
  if (csp) {
    if (csp.parentNode !== head) errors.push(`${rel}: the Content-Security-Policy meta element is not a child of <head> (browsers ignore it elsewhere)`);
    if (attr(csp, 'content') !== CSP) errors.push(`${rel}: CSP differs from scripts/csp.mjs: ${attr(csp, 'content') ?? '(no content)'}`);
    // A meta CSP applies only to resources processed after it: it must precede them all.
    const cspIndex = elements.indexOf(csp);
    const loaders = elements.filter((e) => ['script', 'link', 'style', 'base', 'img', 'iframe', 'object', 'embed', 'video', 'audio', 'source'].includes(e.tagName ?? ''));
    for (const l of loaders) {
      if (elements.indexOf(l) < cspIndex) errors.push(`${rel}: <${l.tagName}> appears before the Content-Security-Policy meta element`);
    }
  }

  const modules = elements.filter((e) => e.tagName === 'script' && attr(e, 'type') === 'module' && attr(e, 'src'));
  if (modules.length === 0) errors.push(`${rel}: no module script entry point (empty or broken page)`);
  for (const el of elements) {
    const ref = el.tagName === 'script' ? attr(el, 'src') : el.tagName === 'link' ? attr(el, 'href') : undefined;
    if (ref === undefined) continue;
    const url = resolveUrl(ref);
    if (!url || url.origin !== ORIGIN) continue; // reported above
    if (!url.pathname.startsWith(BASE_PATH)) {
      errors.push(`${rel}: <${el.tagName}> refers outside the base path ${BASE_PATH}: ${url.pathname}`);
      continue;
    }
    const asset = decodeURIComponent(url.pathname.slice(BASE_PATH.length));
    if (!assetExists(asset)) errors.push(`${rel}: <${el.tagName}> refers to a missing file: ${asset}`);
  }
  return errors;
}

/**
 * Normalises common JavaScript string escapes so escaped URLs are visible to the scan.
 * @param {string} text
 */
function unescapeJs(text) {
  return text
    .replace(/\\u\{([0-9a-f]+)\}/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/');
}

/** @param {string} url */
const isJsInert = (url) => JS_INERT_URLS.exact.includes(url) || JS_INERT_URLS.prefixes.some((p) => url.startsWith(p));

/**
 * @param {string} dir build output directory
 * @returns {{ errors: string[], inventory: { file: string, bytes: number }[] }}
 */
export function checkArtifact(dir) {
  /** @type {string[]} */
  const errors = [];
  const root = resolve(dir);
  /** @type {string[]} */
  let files;
  try {
    files = walk(root);
  } catch {
    return { errors: [`build directory not found: ${root}`], inventory: [] };
  }
  const rels = files.map((f) => relative(root, f).split(sep).join('/'));
  const inventory = files.map((f, i) => ({ file: rels[i] ?? '', bytes: statSync(f).size })).sort((a, b) => b.bytes - a.bytes);
  const present = new Set(rels);

  if (!present.has('index.html')) errors.push('index.html is missing');
  for (const rel of rels) {
    if (rel !== 'index.html' && !ALLOWED_ASSET.test(rel)) errors.push(`${rel}: unexpected file in the build (not index.html or an allowed asset)`);
  }

  files.forEach((f, i) => {
    const rel = rels[i] ?? '';
    const bytes = readFileSync(f);
    const lower = bytes.toString('latin1').toLowerCase();
    for (const marker of HARNESS_MARKERS) {
      if (lower.includes(marker)) errors.push(`${rel}: contains test-harness marker "${marker}"`);
    }
    if (/\.(x?html?|xht)$/i.test(rel)) {
      errors.push(...checkHtml(rel, bytes.toString('utf8'), rel === 'index.html', (a) => present.has(a)));
    } else if (/\.(m?js|css)$/i.test(rel)) {
      const text = unescapeJs(bytes.toString('utf8'));
      const isJs = /\.m?js$/i.test(rel);
      for (const m of text.matchAll(/\b(?:https?|wss?|ftp):\/\/[^\s"'`)<>\\]*/gi)) {
        const url = m[0];
        if (isJs && isJsInert(url)) continue;
        errors.push(`${rel}: contains external URL ${url}`);
      }
      if (!isJs && /url\(\s*['"]?\s*\/\//i.test(text)) errors.push(`${rel}: CSS refers to a protocol-relative URL`);
    }
  });
  return { errors, inventory };
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const dir = process.argv[2] ?? 'dist';
  const { errors, inventory } = checkArtifact(dir);
  const total = inventory.reduce((s, f) => s + f.bytes, 0);
  const out = resolve('build/artifact-inventory.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ dir, totalBytes: total, files: inventory }, null, 2) + '\n');
  if (errors.length) {
    console.error(`check-artifact: ${errors.length} violation(s) in ${dir}`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`check-artifact: ${dir} OK (${inventory.length} files, ${total} bytes; inventory in build/artifact-inventory.json)`);
}
