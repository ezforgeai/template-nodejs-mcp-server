/**
 * ezForge Ready — Base MCP Server
 *
 * Foundation server for all Ready vertical templates (restaurant, salon,
 * home services, etc.). Reads EZFORGE_READY_CONFIG at startup and exposes:
 *   - MCP tools:      get_business_info, get_hours, check_open_now, get_last_order, get_contact_info,
 *                     list_facets (only when the config has facets)
 *   - MCP resources:  business profile, business hours
 *   - HTTP endpoints: GET /, GET /robots.txt, GET /health, ALL /mcp
 *
 * Transport: a single stateless `/mcp` endpoint served by `createMcpHandler`
 * (`@modelcontextprotocol/server`) and mounted with `toNodeHandler`
 * (`@modelcontextprotocol/node`). The handler builds a fresh `Server` per HTTP
 * request, serves modern (2026-07-28) traffic, and — with `legacy: 'stateless'`
 * — also answers 2025-era POSTs that carry no session. The legacy
 * `GET /sse` + `POST /message?sessionId=` endpoints and their in-memory
 * session store were removed (issue #13038, split 1/3 of #4260).
 *
 * Vertical templates extend this OCI image and add vertical-specific tools
 * and resources on top of the common base.
 *
 * Docs: https://modelcontextprotocol.io/docs
 */

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import type {
  JSONRPCRequest,
  McpHttpHandler,
  McpRequestContext,
  Result,
  ServerContext,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { loadConfig } from './config-loader.js';
import { registerTools } from './tools/index.js';
import { registerResources } from './resources/index.js';
import { buildSessionStartedEvent, createReporter } from './analytics.js';
import type { AnalyticsReporter } from './analytics.js';
import type { ReadyConfig } from './config-loader.js';
import { flyReplayMiddleware } from './fly-replay.js';
import { machineIdHeaderMiddleware } from './machine-id-header.js';
import { createLandingPageHandler } from './webmcp-landing.js';
import { robotsHandler } from './robots.js';
import { requireOAuth, getProtectedResourceMetadata, getServerUrl } from './auth.js';
import { sharedSchemaValidator } from './mcp-validator.js';

const PORT = parseInt(process.env['PORT'] ?? '8080', 10);

// ── Config ────────────────────────────────────────────────────────────────────

// Exported for testing — tests can import and spy on these.
export let config: ReadyConfig;
export let analyticsReporter: AnalyticsReporter;

function initialize(): void {
  config = loadConfig();
  analyticsReporter = createReporter(config.analytics);
}

// Load config at startup unless we are in a test environment where the
// test itself calls initialize() after setting up the env.
if (process.env['NODE_ENV'] !== 'test') {
  try {
    initialize();
  } catch (err) {
    console.error('[startup] Failed to load EZFORGE_READY_CONFIG:', err);
    process.exit(1);
  }
}

export { initialize };

// ── MCP server factory ────────────────────────────────────────────────────────

/**
 * A `Server` that runs `onInitialize` after each JSON-RPC `initialize` request
 * it answers successfully. The stateless `/mcp` endpoint has no session, so the
 * `initialize` handshake (2025-era clients; 2026-07-28 clients send none) is the
 * only per-connection signal left. Hooks the protected `_wrapHandler` seam
 * rather than re-registering the `initialize` handler, so the SDK's own
 * negotiation (`_oninitialize`, a private method) stays untouched. `super()`
 * registers `initialize` before this class's fields exist, so the wrapper
 * reads `onInitialize` at call time.
 */
class ReadyServer extends Server {
  onInitialize?: () => void;

  protected override _wrapHandler(
    method: string,
    handler: (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>,
  ): (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result> {
    const wrapped = super._wrapHandler(method, handler);
    if (method !== 'initialize') return wrapped;
    return async (request, ctx) => {
      const result = await wrapped(request, ctx);
      this.onInitialize?.();
      return result;
    };
  }
}

/**
 * A fresh v2 `Server` carrying the base tools and resources.
 * `createMcpHandler` calls this once per HTTP request.
 *
 * Scope enforcement is fail-closed: the granted scopes come from the OAuth
 * context `requireMcpAuth` stamped on the request (`ctx.authInfo`). A request
 * that reaches the factory without one is given an empty scope list, which
 * denies every scope-guarded tool and resource.
 */
export function createMcpServer(ctx: McpRequestContext): Server {
  const grantedScopes = ctx.authInfo?.scopes ?? [];

  // Reuse one process-wide schema validator so Ajv's compiled-schema cache is
  // shared across per-request Servers. See mcp-validator.ts (PERF-R04).
  const server = new ReadyServer(
    { name: 'ezforge-ready-base', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} }, jsonSchemaValidator: sharedSchemaValidator },
  );

  registerTools(server, config, analyticsReporter, grantedScopes);
  registerResources(server, config, grantedScopes);

  // One `session_started` per `initialize`: the same event name and `data` shape
  // the pre-#13038 SSE session emitted (the Ready analytics dashboard counts it;
  // R35/R36), but per handshake rather than per session, and with no `sessionId`
  // because this endpoint has none. Fire-and-forget: the report never blocks or
  // fails the handshake. `tools/call` and every other method emit nothing here.
  server.onInitialize = () => {
    const requestHeaders = ctx.requestInfo?.headers;
    const clientName = ctx.authInfo?.extra?.['clientName'];
    analyticsReporter
      .report(
        buildSessionStartedEvent({
          serverId: config.serverId,
          headers: requestHeaders ? Object.fromEntries(requestHeaders.entries()) : {},
          clientId: ctx.authInfo?.clientId,
          clientName: typeof clientName === 'string' ? clientName : undefined,
        }),
      )
      .catch((err) => console.error('[analytics] session_started report failed:', err));
  };

  return server;
}

/**
 * The web-standard `{ fetch, close, … }` handler. `legacy: 'stateless'` (the
 * default, stated explicitly) also serves 2025-era POSTs without a session.
 */
export function createBaseMcpHandler(): McpHttpHandler {
  return createMcpHandler((ctx) => createMcpServer(ctx), {
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
 * `toNodeHandler` forwards to the handler as `authInfo` — the factory reads the
 * granted scopes from it. Exported so the gate can be unit-tested without
 * spinning up an HTTP server.
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
      ...(auth.clientName ? { extra: { clientName: auth.clientName } } : {}),
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

// WebMCP landing page — serves <meta name="mcp-server"> for agent web crawlers (spec §9.1)
app.get('/', createLandingPageHandler(() => config));

// robots.txt — explicit allow for AI crawlers (ClaudeBot, GPTBot, Google-Extended) + wildcard
app.get('/robots.txt', robotsHandler);

// Health check — platform polls this to verify the server is up (unauthenticated per spec §9.1)
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// RFC 9728 Protected Resource Metadata — tells agents which OAuth 2.1 AS governs this server
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
const mcpHandler = createBaseMcpHandler();
app.all(
  '/mcp',
  requireMcpAuth,
  toNodeHandler(mcpHandler, {
    onerror: (err) => console.error('[MCP /mcp] adapter error:', err),
  }) as unknown as express.RequestHandler,
);

// Guard listen so that importing this module in tests does not start a server.
if (process.env['NODE_ENV'] !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`ezForge Ready base MCP server listening on port ${PORT}`);
    console.log(`Business: ${config.business.name} (${config.business.category})`);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}
