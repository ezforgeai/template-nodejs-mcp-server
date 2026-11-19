/**
 * Request-body handling on `/mcp` — the v2 successor of the issue #4857
 * regression test (real SDK body-read path, no mocking of the SDK).
 *
 * Issue #4857: `express.json()` fully consumes the body stream before the route
 * handler runs, and the v1 `SSEServerTransport` then failed with "stream is not
 * readable" unless it was handed the pre-parsed body. The v2 shape has the same
 * hazard in a different spot: `toNodeHandler` buffers the Node stream itself
 * (and enforces a 4 MiB cap), and `createMcpHandler` needs the raw body to
 * classify the request's era — so `/mcp` must be mounted WITHOUT a body parser
 * ahead of it. These tests drive the real `app` over loopback HTTP and pin both
 * halves: the production wiring works, and the wiring #4857 warned about does
 * not.
 *
 * Only the outbound edge is stubbed (the global `fetch` `auth.ts` uses for
 * token introspection) plus the Fly-replay middleware, which needs a Fly runtime.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';

const realFetch = globalThis.fetch;
let baseUrl = '';
vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init); // loopback test servers
  return Promise.resolve({ ok: true, json: async () => ({ valid: true, scopes: ['mcp:read'], iss: 'https://auth.example.com' }) });
});

vi.hoisted(() => {
  process.env['OAUTH_BASE_URL'] = 'https://auth.example.com';
});

vi.mock('ezforge-ready-base/src/fly-replay.js', () => ({
  flyReplayMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { app, createNodeMcpHandler } from './index.js';
import { __resetIntrospectionCacheForTests } from 'ezforge-ready-base/src/auth.js';

const MODERN_VERSION = '2026-07-28';

const toolsListBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
  params: {
    _meta: {
      [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION,
      [CLIENT_INFO_META_KEY]: { name: 'body-test', version: '0.0.0' },
      [CLIENT_CAPABILITIES_META_KEY]: {},
    },
  },
});

const MCP_HEADERS = {
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
  Authorization: 'Bearer test-bearer-token',
  'MCP-Protocol-Version': MODERN_VERSION,
  'Mcp-Method': 'tools/list',
};

const servers: HttpServer[] = [];

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  baseUrl = await listen(app);
});

beforeEach(() => {
  process.env['OAUTH_INTROSPECTION_TOKEN'] = 'test-introspection-token';
  process.env['EZFORGE_MCP_PUBLIC_URL'] = 'https://test.mcp.ezforge.ai';
});

afterEach(() => {
  __resetIntrospectionCacheForTests();
  delete process.env['OAUTH_INTROSPECTION_TOKEN'];
  delete process.env['EZFORGE_MCP_PUBLIC_URL'];
});

afterAll(async () => {
  await Promise.all(
    servers.map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe('POST /mcp body parsing (issue #4857 successor, real SDK)', () => {
  it('reads the raw JSON body itself and answers the request (production wiring)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: toolsListBody });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('"echo"');
    expect(text.toLowerCase()).not.toContain('not readable');
  });

  it('fails when a body parser consumes the stream first (the wiring #4857 warned about)', async () => {
    // Same handler, but with `express.json()` ahead of it: the stream is drained
    // and `toNodeHandler` (whose third argument is Express's `next`, ignored)
    // has nothing left to read. This is why src/index.ts mounts /mcp bare.
    const miswired = express();
    miswired.all(
      '/mcp',
      express.json(),
      (req, _res, next) => {
        Object.assign(req, { auth: { token: 't', clientId: 'c', scopes: ['mcp:read'] } });
        next();
      },
      toNodeHandler(createNodeMcpHandler()) as unknown as express.RequestHandler,
    );
    const miswiredUrl = await listen(miswired);

    const res = await fetch(`${miswiredUrl}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: toolsListBody });
    const text = await res.text();

    expect(text).not.toContain('"echo"');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('denies scope-guarded tools when no OAuth context reaches the handler (fail-closed ?? [])', async () => {
    // Bare express app: the real handler with NO auth stamping, so `ctx.authInfo`
    // is undefined and `createNodeMcpHandler` must fall back to an empty scope list.
    const unauthenticated = express();
    unauthenticated.all('/mcp', toNodeHandler(createNodeMcpHandler()) as unknown as express.RequestHandler);
    const bareUrl = await listen(unauthenticated);

    const res = await fetch(`${bareUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'add' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { ...JSON.parse(toolsListBody).params, name: 'add', arguments: { a: 2, b: 5 } },
      }),
    });
    const text = await res.text();

    expect(text).toContain('Insufficient scope: mcp:read required');
    expect(text).not.toContain('"text":"7"');
  });

  it('rejects malformed JSON with a 4xx and no tool list', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: '{"jsonrpc":' });
    const text = await res.text();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(text).not.toContain('"echo"');
  });

  it('answers a body over the 4 MiB adapter cap with 413 without invoking a tool', async () => {
    const oversized = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { pad: 'x'.repeat(4 * 1024 * 1024 + 1) },
    });
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: oversized });

    expect(res.status).toBe(413);
  });
});
