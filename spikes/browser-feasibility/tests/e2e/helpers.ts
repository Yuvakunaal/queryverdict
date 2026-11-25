import type { BrowserContext, Page, Request } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const APP = 'http://127.0.0.1:4173/queryverdict/';
export const HARNESS = 'http://127.0.0.1:4174/queryverdict/harness/';

/** Local-only listener standing in for an "external" server. Records every hit, headers and body. */
export async function startListener() {
  const hits: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, hits, close: () => new Promise((r) => server.close(r)) };
}

/** Records every request from the page and its workers; aborts anything not on 127.0.0.1. */
export async function captureRequests(context: BrowserContext) {
  const requests: Request[] = [];
  context.on('request', (r) => requests.push(r));
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
  return requests;
}

export async function openApp(page: Page) {
  await page.goto(APP);
  return page.evaluate(() => window.__qv!.ready);
}

export async function openHarness(page: Page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => document.body.dataset.harnessReady === 'true');
}

export const run = (page: Page, sql: string) => page.evaluate((s) => window.__qv!.session.run(s), sql);
