import type { BrowserContext, Request } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const APP_ORIGIN = 'http://127.0.0.1:4173';
export const APP = `${APP_ORIGIN}/queryverdict/`;
export const HARNESS = 'http://127.0.0.1:4174/queryverdict/';

/** Records every request the page (and any worker) makes in this context. */
export function captureRequests(context: BrowserContext): Request[] {
  const requests: Request[] = [];
  context.on('request', (r) => requests.push(r));
  return requests;
}

/** WCAG 2.0/2.1/2.2 A and AA rule tags checked by axe (docs/TESTING_STRATEGY.md §5.11). */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * A loopback HTTP listener standing in for a foreign origin. It records every request that
 * actually reaches it, which is the evidence that a request left the page (a browser may report
 * a request event for a request its CSP then blocks).
 */
export async function startListener() {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}
