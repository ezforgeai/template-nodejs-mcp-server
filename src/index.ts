/**
 * ezForge MCP Server — Node.js / TypeScript template
 *
 * Implements the Model Context Protocol (MCP) over HTTP using the official SDK.
 * Exposes two sample tools:
 *   - echo: returns whatever you send it
 *   - add:  adds two numbers and returns the result
 *
 * Transport: a single stateless `/mcp` endpoint served by `createMcpHandler`
 * (`@modelcontextprotocol/server`) and mounted with `toNodeHandler`
 * (`@modelcontextprotocol/node`). The handler builds a fresh `Server` per HTTP
 * request, serves modern (2026-07-28) traffic, and — with `legacy: 'stateless'`
 * — also answers 2025-era POSTs that carry no session. The legacy
 * `GET /sse` + `POST /message?sessionId=` endpoints and their in-memory session
 * store were removed (issue #13040, split 3/3 of #4260).
 *
 * To add your own tools, follow the pattern below: add the descriptor to the
 * `TOOLS` list and a dispatch branch in `callTool()`.
 *
 * Docs: https://modelcontextprotocol.io/docs
 */

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createMcpHandler, ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import type { McpHttpHandler, McpRequestContext, Tool } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { flyReplayMiddleware } from 'ezforge-ready-base/src/fly-replay.js';
import { machineIdHeaderMiddleware } from 'ezforge-ready-base/src/machine-id-header.js';
import { requireOAuth, getProtectedResourceMetadata, getServerUrl } from 'ezforge-ready-base/src/auth.js';

const PORT = parseInt(process.env['PORT'] ?? '8080', 10);

// ── Scope constants ───────────────────────────────────────────────────────────

const TOOL_REQUIRED_SCOPE: Record<string, string> = {
  echo: 'mcp:read',
  add: 'mcp:read',
};

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'echo',
    description: 'Echoes back whatever message you provide.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to echo back.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Adds two numbers together.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number.' },
        b: { type: 'number', description: 'Second number.' },
      },
      required: ['a', 'b'],
    },
  },
];

// ── Tool handler ──────────────────────────────────────────────────────────────

// Exported for unit testing — isolated from MCP Server wiring.
export function callTool(
  name: string,
  args: unknown,
  grantedScopes: string[] | null,
): { content: Array<{ type: 'text'; text: string }> } {
  const requiredScope = TOOL_REQUIRED_SCOPE[name];
  if (grantedScopes !== null && requiredScope !== undefined && !grantedScopes.includes(requiredScope)) {
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `Insufficient scope: ${requiredScope} required`);
  }

  if (name === 'echo') {
    const { message } = args as { message: string };
    return { content: [{ type: 'text', text: message }] };
  }

  if (name === 'add') {
    const { a, b } = args as { a: number; b: number };
    return { content: [{ type: 'text', text: String(a + b) }] };
  }

  throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${name}`);
}

// ── MCP server factory ────────────────────────────────────────────────────────

// grantedScopes: null = no enforcement; string[] = enforce per TOOL_REQUIRED_SCOPE.
export function createMcpServer(grantedScopes: string[] | null = null): Server {
  const server = new Server(
    { name: 'my-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // List available tools
  server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }));

  // Handle tool calls
  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(name, args, grantedScopes);
  });

  return server;
}

/**
 * The web-standard `{ fetch, close, … }` handler. `createMcpHandler` calls the
 * factory once per HTTP request. Scope enforcement is fail-closed: the granted
 * scopes come from the OAuth context `requireMcpAuth` stamped on the request
 * (`ctx.authInfo`); a request that reaches the factory without one is given an
 * empty scope list, which denies every scope-guarded tool.
 * `legacy: 'stateless'` (the default, stated explicitly) also serves 2025-era
 * POSTs that carry no session.
 */
export function createNodeMcpHandler(): McpHttpHandler {
  return createMcpHandler((ctx: McpRequestContext) => createMcpServer(ctx.authInfo?.scopes ?? []), {
    legacy: 'stateless',
    onerror: (err) => {
      console.error('[MCP /mcp] handler error:', err);
    },
  });
}

// ── Auth gate ─────────────────────────────────────────────────────────────────

/**
 * OAuth 2.1 gate for `/mcp`. Validates the Bearer token (writing the 401/503
 * itself on failure) and, on success, stamps the result on `req.auth`, which
 * `toNodeHandler` forwards to the handler as `authInfo`. Exported so the gate
 * can be unit-tested without spinning up an HTTP server.
 */
export async function requireMcpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Must precede any await — Fly edge proxy buffers responses without these, causing 401/503 to never reach the client.
  res.set('Cache-Control', 'no-cache');
  res.set('X-Accel-Buffering', 'no');

  const auth = await requireOAuth(req, res, getServerUrl(req));
  if (!auth) return;

  const token = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] ?? '')?.[1] ?? '';
  Object.assign(req, {
    auth: {
      token,
      // `clientId` is required by `AuthInfo`; introspection may omit it.
      clientId: auth.clientId ?? '',
      scopes: auth.scopes,
    },
  });
  next();
}

// ── HTTP server ───────────────────────────────────────────────────────────────

export const app = express();

// fly-replay: route misrouted requests to the correct machine in the shared Fly app.
app.use(flyReplayMiddleware);

// Echo FLY_MACHINE_ID on every response so load tests can attribute responses
// to machines (issue #6660) — Fly does not itself expose a machine-id header.
app.use(machineIdHeaderMiddleware);

// Health check — primary path; /healthz kept as alias for CI and load-test probes.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// RFC 9728 Protected Resource Metadata — unauthenticated discovery endpoint
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const metadata = getProtectedResourceMetadata(getServerUrl(req));
  if (!metadata) {
    console.error('[metadata] OAUTH_BASE_URL is not configured; cannot serve protected-resource metadata');
    res.status(503).json({
      error: 'service_unavailable',
      error_description: 'Authentication service not configured',
    });
    return;
  }
  res.json(metadata);
});

// All MCP traffic goes through the v2 handler (OAuth 2.1 required). Stateless:
// a fresh Server per request, no session map. No `express.json()` here —
// `toNodeHandler` buffers the body itself (and enforces the 4 MiB cap), and the
// handler needs the raw stream to classify the request's era. `app.all` lets the
// handler answer GET/DELETE with its own 405 instead of Express's 404.
const mcpHandler = createNodeMcpHandler();
app.all(
  '/mcp',
  requireMcpAuth,
  toNodeHandler(mcpHandler, {
    onerror: (err) => console.error('[MCP /mcp] adapter error:', err),
  }) as unknown as express.RequestHandler,
);

// Guard listen so that importing this module in tests does not start a real
// HTTP server. Vitest sets NODE_ENV=test automatically.
if (process.env['NODE_ENV'] !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`MCP server listening on port ${PORT}`);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}
