// The forge's HTTP surface: one server routing git smart HTTP, the REST v3
// API, GraphQL v4 and the MCP endpoint onto the shared store in forge.ts.
// main.ts owns the entry <-> env lifecycle; this file is the server it runs.
//
// Protocol rules that hold across surfaces:
//   - every route except GET /healthz requires the trial's bearer token;
//     a missing or wrong token is a 401 with a JSON body, never HTML;
//   - every /api/v3 reply is JSON and carries an X-GitHub-Request-Id header;
//   - a repository addressed under any owner but the learned viewer, or one
//     that does not exist, is a 404 — never a 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './forge.ts';
import { infoRefs, receivePack, uploadPack } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true; // local development without a trial token
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      try {
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': forge.requestId() });
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/<route>
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const [, owner, repoName, route] = gitMatch;
          const repo = forge.repoFor(owner, repoName);
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (route === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'Bad Request' });
              return;
            }
            const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
            const { contentType, body } = infoRefs(forge, repo, service, v2);
            res.writeHead(200, { 'content-type': contentType, 'content-length': body.length });
            res.end(body);
            return;
          }
          if (route === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const out = uploadPack(forge, repo, body);
            res.writeHead(200, {
              'content-type': 'application/x-git-upload-pack-result',
              'content-length': out.length,
            });
            res.end(out);
            return;
          }
          if (route === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            const out = receivePack(forge, repo, body);
            res.writeHead(200, {
              'content-type': 'application/x-git-receive-pack-result',
              'content-length': out.length,
            });
            res.end(out);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        if (path === '/api/graphql' && method === 'POST') {
          const body = await readBody(req);
          await handleGraphQL(forge, body, res, sendJson);
          return;
        }
        if (path === '/mcp' && method === 'POST') {
          const body = await readBody(req);
          await handleMCP(forge, body, res, sendJson);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const body = method === 'GET' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req);
          handleRest(forge, method, path, url.searchParams, body, res, sendJson, `http://${req.headers.host ?? 'entry'}`);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': forge.requestId() });
      } catch {
        // A malformed request must never take the server down with it.
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
