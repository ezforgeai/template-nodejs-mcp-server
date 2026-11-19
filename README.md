# ezForge MCP Server — Node.js Template

A TypeScript/Node.js MCP server template for the ezForge platform. Each deployed instance
runs as a separate Fly.io machine in the shared `ezforge-mcp` app, handling tool calls
over HTTP with OAuth 2.1 Bearer token authentication.

## Quick start

```bash
npm install
npm run dev          # development (tsx, no compile)
npm run build        # compile TypeScript → dist/
npm run test         # run unit tests (vitest)
npm start            # run compiled output
```

## Fly.io multi-machine routing

### Why fly-replay is required

All customer MCP server machines share the same Fly app (`ezforge-mcp`). Fly's HTTP load
balancer round-robins inbound requests across all *running* machines in the app. A request
for `abc123.mcp.ezforge.ai` may land on any machine, not just the one whose
`SERVER_SUBDOMAIN` is `abc123.mcp.ezforge.ai`.

The `flyReplayMiddleware` (from `ezforge-ready-base`) detects these misrouted requests and
instructs Fly to forward the request to the correct machine:

```
Client → Fly edge → wrong machine
                         │
                         │ fly-replay: instance=<correct-machine-id>
                         ↓
              Fly edge → correct machine → response
```

### How the middleware works

1. **Match check** — Compare the incoming `Host` header directly against
   `SERVER_SUBDOMAIN` (which is already the full hostname, e.g. `abc123.mcp.ezforge.ai`).
   If they match, the request is on the right machine and the middleware calls `next()`.

2. **Health-check pass-through** — `/health` and `/healthz` always respond from the
   current machine regardless of the Host header (Fly polls each machine individually).

3. **Subdomain extraction** — Strip the `.<MCP_DOMAIN>` suffix from the Host header to
   get the requested base subdomain (e.g. `abc123` from `abc123.mcp.ezforge.ai`).

4. **Routing lookup** — On a cache miss, ask the platform which machine serves that one
   subdomain: `GET ${OAUTH_BASE_URL}/api/v1/internal/mcp-routing?subdomain=abc123`,
   authenticated with `EZFORGE_ROUTING_TOKEN`. `200` returns the machine ID, `404` means no
   machine claims the subdomain, and `400` (not one lowercase DNS label) is treated the same
   as `404`. A `404` is remembered for 5 s (at most 1024 subdomains) so repeated requests for
   the same unknown host reach the platform once. A timeout, network error, `401`, `429`, `5xx`,
   any other status, or a `200` without a `machineId` — or whose `machineId` does not match
   `^[A-Za-z0-9_-]{1,64}$` (it is placed in the `fly-replay` header, so it must be header-safe;
   the rejected value is not cached or logged) — is a transient failure (the request is
   bounced with `fly-replay: elsewhere=true`, capped by `FLY_REPLAY_MAX_BOUNCES`).
   If `EZFORGE_ROUTING_TOKEN` or `OAUTH_BASE_URL` is unset, a misrouted request gets a 503
   and no lookup is issued. No Fly API token is present on the machine (#12027).

5. **Replay** — Respond with `fly-replay: instance=<machine-id>` and HTTP 200. Fly's
   edge intercepts this header and replays the original request to the named machine.

6. **Fallthrough** — If no machine claims the subdomain, call `next()` and let the
   route handlers return 404.

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SERVER_SUBDOMAIN` | Yes (in Fly) | `` | Full subdomain for this machine, e.g. `abc123.mcp.ezforge.ai`. Set by the lifecycle module at provision time. Includes the domain suffix. |
| `MCP_DOMAIN` | No | `mcp.ezforge.ai` | Domain suffix for MCP servers. |
| `EZFORGE_ROUTING_TOKEN` | Yes (in Fly) | `` | Per-machine credential for the platform routing lookup. Issued by the platform at provision time and written to machine config.env. It authorizes only the per-subdomain lookup, not the Fly API. When unset, a misrouted request gets a 503. |
| `OAUTH_BASE_URL` | Yes (in Fly) | `` | Platform base URL (HTTPS). Already injected on every machine; the routing lookup endpoint is `${OAUTH_BASE_URL}/api/v1/internal/mcp-routing`. |
| `FLY_REPLAY_LOOKUP_TIMEOUT_MS` | No | `2000` | Lookup timeout in milliseconds. The platform is reached over public HTTPS, so the budget allows for DNS, TCP and TLS setup. A timeout bounces the request elsewhere. |

When `SERVER_SUBDOMAIN` is unset (local dev), the middleware is a no-op.

### Machine ID cache and convergence window

Resolved machine IDs are cached for **30 seconds** to avoid hammering the platform
routing endpoint. This means:

- During a rolling machine replacement, requests for the affected subdomain may replay
  to the old machine ID for up to 30 s before the cache refreshes and discovers the
  replacement machine.
- Fly returns its own 404 for replays that target a deleted machine ID. This is a
  transient condition — normal service resumes after the 30 s cache window expires.

This convergence window is acceptable for the MCP routing use case. If tighter
convergence is required in the future, reduce `CACHE_TTL_MS` in `fly-replay.ts`.

### Single-flight deduplication

If multiple requests for the same uncached subdomain arrive simultaneously, only **one**
lookup is issued. All concurrent waiters share the same in-flight promise, so the endpoint
is not stampeded during a cache miss. This is keyed per subdomain: a miss for a different
subdomain makes its own request, and a stale hit refreshes only that subdomain in the
background. No background refresh timer runs.

## Adding tools

Register new tools in `src/index.ts` following the existing `echo` / `add` pattern:

1. Add the tool to `TOOL_REQUIRED_SCOPE` with its required OAuth scope.
2. Add the tool descriptor to the `TOOLS` list (served by the `tools/list` handler).
3. Add the dispatch branch to `callTool()`.
4. Add unit tests to `src/index.test.ts`.

## Transport

All MCP traffic is served by one stateless endpoint, `ALL /mcp`, built with
`createMcpHandler` (`@modelcontextprotocol/server`) and mounted with `toNodeHandler`
(`@modelcontextprotocol/node`). Modern (2026-07-28) clients and 2025-era clients that
POST without a session use the same URL. A fresh `Server` is built for every HTTP
request, so there is no session state to track, evict or cap; any machine can answer
any request. The OAuth 2.1 Bearer check runs ahead of the handler, and the granted
scopes reach the per-request `Server` through `req.auth`.

The legacy `GET /sse` and `POST /message?sessionId=` endpoints (and the in-memory
session store behind them) were removed. Do not put `express.json()` ahead of `/mcp`:
the handler reads the raw body itself.
