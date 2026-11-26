// Content-Security-Policy for the production page, delivered as a <meta> tag because GitHub
// Pages cannot send response headers (docs/ARCHITECTURE.md §19, §24 V2). A document's meta CSP
// does not govern a same-origin dedicated worker (§24 V3), so it is defence in depth for the
// page only; the engine lockdown (M02) is the primary network control.
// 'wasm-unsafe-eval' is required by DuckDB-WASM (M02).
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
];

export const CSP = CSP_DIRECTIVES.join('; ');

/** Project-site subpath on GitHub Pages (docs/ARCHITECTURE.md §20). */
export const BASE_PATH = '/queryverdict/';
