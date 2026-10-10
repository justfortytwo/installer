// helpers/ollama.ts — a minimal fake Ollama HTTP server for tests.
//
// Serves GET /api/tags (the models it "has") and POST /api/pull (streams NDJSON
// progress, then success — or an error), and records every request so a test can
// assert WHICH endpoint init talked to.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeOllama {
  url: string;
  requests: { method: string; path: string; body: string }[];
  close: () => Promise<void>;
}

export async function startFakeOllama(opts: { models?: string[]; pullError?: string } = {}): Promise<FakeOllama> {
  const models = [...(opts.models ?? [])];
  const requests: FakeOllama['requests'] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', body });
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
      } else if (req.method === 'POST' && req.url === '/api/pull') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        if (opts.pullError) {
          res.end(JSON.stringify({ error: opts.pullError }) + '\n');
        } else {
          models.push((JSON.parse(body) as { model: string }).model);
          res.end(JSON.stringify({ status: 'success' }) + '\n');
        }
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
