// OAuth 2.1 Bearer token validation for ezForge Ready MCP servers.
//
// Templates run as separate Fly apps without DB access — token validation
// delegates to the control-plane introspection endpoint via a per-server
// service token (OAUTH_INTROSPECTION_TOKEN).
//
// Env vars consumed:
//   OAUTH_BASE_URL            — control-plane auth base URL. REQUIRED, no default.
//                               Injected per-machine by the platform (see
//                               packages/api/src/modules/lifecycle/index.ts). A missing
//                               or non-HTTPS value fails closed: every request is denied
//                               with 503 rather than silently pointing at a dead host.
//   OAUTH_INTROSPECTION_TOKEN — per-server service token issued at provisioning time
//   EZFORGE_MCP_PUBLIC_URL    — canonical public URL for this server (audience binding)
//   OAUTH_INTROSPECTION_CACHE_TTL_MS — how long a *valid* introspection result is
//                               cached, in milliseconds. Default 8000 (8s). Set to 0 to
//                               disable caching entirely. See "Introspection result
//                               cache" below for why this exists (issue #4799).
//   OAUTH_INTROSPECTION_STALE_TTL_MS — how much longer, past the fresh TTL, a cached
//                               result may still be served *stale* while a background
//                               refresh runs (stale-while-revalidate). Milliseconds.
//                               Default 60000 (60s). Has no effect when
//                               OAUTH_INTROSPECTION_CACHE_TTL_MS=0 — caching is
//                               disabled entirely in that mode, so no entry is ever
//                               cached for the stale path to serve. See
//                               "Stale-while-revalidate" below for why this exists
//                               (issue #4886).
//
// Spec references: RFC 6750, RFC 8707, RFC 9728, MCP Authorization spec §3.3

import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';

// ── Introspection result cache ─────────────────────────────────────────────────
//
// Every authenticated request previously made a fresh introspection call, with no
// caching. Under concurrent load, agents reusing the same token drove the
// introspection endpoint past the platform's per-IP rate limit; a 429 there was
// surfaced to the MCP client as a 503 (issue #4799). Caching *valid* results for a
// short TTL — well under real token lifetime — cuts the introspection call volume
// roughly in proportion to token reuse, without materially widening the window in
// which a revoked token is still accepted (bounded by INTROSPECTION_CACHE_TTL_MS).
//
// Invalid/expired results are deliberately NOT cached: they are cheap to keep
// fail-closed and re-checking on every request avoids any revocation-propagation
// tradeoff for the rejection path, which is not the path this fix targets.
//
// Scope: in-process, per machine — each Fly replica keeps its own cache. This is
// intentional; a shared cache would need its own availability story and is not
// needed to fix the observed defect.

const INTROSPECTION_CACHE_TTL_MS: number = (() => {
  const raw = process.env['OAUTH_INTROSPECTION_CACHE_TTL_MS'];
  // Treat an unset or empty-string value the same way (matches the Python
  // template's _parse_cache_ttl_ms, where float("") raises and falls back
  // to the default) — `Number('')` is 0, which would otherwise silently
  // disable caching instead of falling back to the default.
  if (!raw) return 8_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 8_000;
})();

// How long past INTROSPECTION_CACHE_TTL_MS a cached result may still be served
// while a background refresh runs. See "Stale-while-revalidate" below.
const INTROSPECTION_STALE_TTL_MS: number = (() => {
  const raw = process.env['OAUTH_INTROSPECTION_STALE_TTL_MS'];
  if (!raw) return 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
})();

// Bounds unbounded growth from a long-running machine seeing many distinct
// tokens. Eviction is oldest-inserted-first (Map preserves insertion order) —
// a simple, adequate policy at this scale, not a true LRU.
//
// `let`, not `const`, solely so tests can shrink it via
// __setIntrospectionCacheMaxEntriesForTests to exercise eviction without
// inserting 1000 real entries — never reassigned by generated server code.
let INTROSPECTION_CACHE_MAX_ENTRIES = 1_000;

/**
 * Introspection payload from the control plane. `clientId` / `clientName`
 * identify the OAuth client (the agent app, e.g. ChatGPT or Cursor) that holds
 * the token — app identifiers, not end-user data. Optional so an older control
 * plane that omits them still works.
 */
interface IntrospectionResult {
  valid: boolean;
  scopes?: string[];
  clientId?: string;
  clientName?: string;
  // RFC 7662 §2.2 `iss` claim: the issuer the token was minted under. `unknown`
  // because it arrives over the wire — validated by `issuerMatchesPlatform`.
  iss?: unknown;
}

/** What requireOAuth returns for an authenticated request. */
export interface OAuthContext {
  scopes: string[];
  clientId?: string;
  clientName?: string;
}

interface CachedIntrospection {
  scopes: string[];
  // Cached with the scopes so cache hits identify the client the same way a
  // fresh introspection does.
  clientId?: string;
  clientName?: string;
  // Fresh until this timestamp: served immediately as a cache hit.
  expiresAt: number;
  // Past expiresAt but before this timestamp: served stale once while a
  // background refresh runs (stale-while-revalidate). Past it: hard-expired.
  staleUntil: number;
}

const introspectionCache = new Map<string, CachedIntrospection>();

// Cumulative counters, logged on every cache check for post-deploy validation
// of the cache hit rate (issue #4799 acceptance criteria).
//
// introspectionCacheHits/introspectionCacheMisses are request-level: exactly
// one of them is incremented per requireOAuth call, so hits+misses always
// equals the number of requests that reached the cache check. A stale hit
// counts as a hit (the request itself never blocked), even though it also
// triggers a background refresh — that refresh is not a second request, so
// it must not also increment introspectionCacheMisses (issue #4906; before
// this fix it did, letting hits+misses exceed request count and skewing the
// #4799 cache-hit-rate acceptance metric). Background refreshes are tracked
// separately below.
let introspectionCacheHits = 0;
let introspectionCacheMisses = 0;
let introspectionBackgroundRefreshes = 0;

function introspectionCacheKey(token: string, audience: string): string {
  // Hash the token before joining with audience so the join point can't be
  // shifted by attacker-controlled token content (audience always contains
  // "://", so a naive `${token}:${audience}` join is not collision-safe).
  const tokenDigest = createHash('sha256').update(token).digest('hex');
  return createHash('sha256').update(`${tokenDigest}:${audience}`).digest('hex');
}

function getCachedIntrospection(key: string): (OAuthContext & { isStale: boolean }) | null {
  const entry = introspectionCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  const { scopes, clientId, clientName } = entry;
  if (now < entry.expiresAt) return { scopes, clientId, clientName, isStale: false };
  // Past the fresh TTL but still within the stale window: serve stale and let
  // the caller trigger a background refresh (stale-while-revalidate).
  if (now < entry.staleUntil) return { scopes, clientId, clientName, isStale: true };
  // Hard-expired: drop it and force a blocking re-fetch.
  introspectionCache.delete(key);
  return null;
}

function setCachedIntrospection(key: string, ctx: OAuthContext): void {
  if (INTROSPECTION_CACHE_TTL_MS <= 0) return;
  if (!introspectionCache.has(key) && introspectionCache.size >= INTROSPECTION_CACHE_MAX_ENTRIES) {
    const oldestKey = introspectionCache.keys().next().value;
    if (oldestKey !== undefined) introspectionCache.delete(oldestKey);
  }
  const now = Date.now();
  introspectionCache.set(key, {
    scopes: ctx.scopes,
    clientId: ctx.clientId,
    clientName: ctx.clientName,
    expiresAt: now + INTROSPECTION_CACHE_TTL_MS,
    staleUntil: now + INTROSPECTION_CACHE_TTL_MS + INTROSPECTION_STALE_TTL_MS,
  });
}

// ── In-flight introspection request coalescing ─────────────────────────────
//
// The cache above only helps a request that arrives once a key is already
// populated. It does nothing for the cold-cache case: many requests bearing
// the same token+audience arriving concurrently (a load test's fixed
// client-credentials token, or a burst of real sessions from the same
// client) each independently miss the cache and each fire their own
// introspection fetch — a thundering herd on the control plane every time a
// cache entry is empty or has just expired. This was the dominant
// contributor to SSE session-setup tail latency under concurrent load
// (issue #4886): p99 ~6.5s / worst-case 30s at 50 concurrent agents, even
// though the *median* setup time was fast (cache hits).
//
// `inFlightIntrospections` de-duplicates concurrent fetches for the same
// cache key: the first caller for a cold/expired key starts the fetch and
// registers its promise; every other caller for that same key awaits the
// identical promise instead of issuing a second network call. The entry is
// removed the instant the fetch settles (success or failure) so a single
// failed attempt never poisons the key beyond that one attempt.
const inFlightIntrospections = new Map<string, Promise<IntrospectionResult>>();

/** Thrown when the introspection endpoint responds with a non-2xx status. */
class IntrospectionHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Introspection endpoint returned HTTP ${status}`);
  }
}

async function fetchIntrospection(
  bearerToken: string,
  audience: string,
  introspectionToken: string,
): Promise<IntrospectionResult> {
  const response = await fetch(`${OAUTH_BASE_URL}/api/v1/internal/oauth/introspect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${introspectionToken}`,
    },
    body: JSON.stringify({ token: bearerToken, audience }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new IntrospectionHttpError(response.status);
  }

  const result = (await response.json()) as IntrospectionResult;
  // Applied here, at the single network edge, so every consumer — the foreground
  // path, coalesced callers, and the stale-while-revalidate background refresh —
  // sees an issuer-mismatched token as plain `{ valid: false }`. That also means
  // a mismatch is never cached, and a refresh that discovers one evicts the entry.
  if (result.valid && !issuerMatchesPlatform(result.iss)) {
    console.error('[auth] introspection result issuer does not match the platform issuer; rejecting token');
    return { valid: false };
  }
  return result;
}

/**
 * Issuer binding (RFC 9207 / RFC 7662 `iss`): a token is only acceptable here if it
 * was minted under this deployment's platform issuer, i.e. OAUTH_BASE_URL (the
 * normalized origin that is also advertised as `authorization_servers[0]` in the
 * RFC 9728 metadata and emitted as `iss` on authorization responses). Exact string
 * match, per RFC 9207 §2.4 — no trailing-slash or case folding.
 *
 * Fail-closed: an `iss` that is absent, not a string, or that differs is rejected.
 * The control-plane introspection endpoint emits `iss` on every valid-token
 * response, so absence means the result did not come from a current platform and
 * cannot be bound to this deployment's issuer.
 */
function issuerMatchesPlatform(iss: unknown): boolean {
  return typeof iss === 'string' && iss === OAUTH_BASE_URL;
}

/**
 * Fetch introspection for `cacheKey`, coalescing concurrent callers onto a
 * single in-flight request. See "In-flight introspection request
 * coalescing" above.
 */
function getOrFetchIntrospection(
  cacheKey: string,
  bearerToken: string,
  audience: string,
  introspectionToken: string,
  isBackgroundRefresh = false,
): Promise<IntrospectionResult> {
  const existing = inFlightIntrospections.get(cacheKey);
  if (existing) return existing;

  // Counts real network fetches, not per-request cache misses — N concurrent
  // requests coalescing onto this one fetch increment this exactly once.
  //
  // A background refresh (stale-while-revalidate) is not itself a request
  // that reached the cache check — the foreground request that triggered it
  // already counted as a hit. Attribute its fetch to
  // introspectionBackgroundRefreshes instead, so hits+misses stays
  // request-level (issue #4906).
  if (isBackgroundRefresh) {
    introspectionBackgroundRefreshes++;
  } else {
    introspectionCacheMisses++;
  }

  const promise = fetchIntrospection(bearerToken, audience, introspectionToken).finally(() => {
    inFlightIntrospections.delete(cacheKey);
  });
  inFlightIntrospections.set(cacheKey, promise);
  return promise;
}

// ── Stale-while-revalidate ──────────────────────────────────────────────────
//
// Coalescing (above) collapses a concurrent cold-cache burst onto a single
// fetch, but every caller in that burst still *blocks* on it. Under sustained
// load the control-plane introspection call can take seconds, so at each TTL
// boundary the whole burst stalls behind one slow refetch — the bimodal tail
// (fast p50 cache hits, multi-second p99 at every expiry) that dominated SSE
// session-setup latency (issue #4886).
//
// Stale-while-revalidate removes the block from the hot path: once an entry is
// past its fresh TTL but still within the stale window, requireOAuth returns
// the stale scopes immediately and kicks off a background refresh instead of
// awaiting one. Callers only ever block on a truly cold key (nothing cached)
// or a hard-expired one (past staleUntil). Revocation stays tightly bounded in
// the common case: the first request after expiry triggers the refresh, and a
// now-invalid token evicts the entry so the next request fails closed. The
// stale window only widens acceptance when the endpoint itself is unreachable —
// exactly when re-checking could not confirm a revocation anyway.
function revalidateIntrospectionInBackground(
  cacheKey: string,
  bearerToken: string,
  audience: string,
  introspectionToken: string,
): void {
  // A refresh for this key is already running (started by an earlier stale
  // hit); getOrFetchIntrospection would return that same promise, so avoid
  // attaching a redundant second handler to it.
  if (inFlightIntrospections.has(cacheKey)) return;

  getOrFetchIntrospection(cacheKey, bearerToken, audience, introspectionToken, true)
    .then((result) => {
      if (result.valid) {
        setCachedIntrospection(cacheKey, {
          scopes: result.scopes ?? [],
          clientId: result.clientId,
          clientName: result.clientName,
        });
      } else {
        // The token was revoked/expired since it was cached — drop the stale
        // entry so the next request fails closed instead of serving it again.
        introspectionCache.delete(cacheKey);
      }
    })
    .catch((err) => {
      // Refresh failed; keep serving the existing stale entry until staleUntil.
      // Never rethrow — this runs detached from any request's promise chain.
      if (err instanceof IntrospectionHttpError) {
        console.error(`[auth] background introspection refresh failed: HTTP ${err.status}`);
      } else {
        console.error('[auth] background introspection refresh failed:', err);
      }
    });
}

const DEFAULT_INTROSPECTION_CACHE_MAX_ENTRIES = 1_000;

/**
 * Test-only: clear the introspection cache and hit/miss counters, and restore
 * the max-entries cap to its default. Not called by generated server code —
 * exists so tests can isolate cache-behavior assertions from each other
 * without reimporting the module (which would also reset OAUTH_BASE_URL and
 * other module-load-time state most tests don't want to disturb).
 */
export function __resetIntrospectionCacheForTests(): void {
  introspectionCache.clear();
  inFlightIntrospections.clear();
  introspectionCacheHits = 0;
  introspectionCacheMisses = 0;
  introspectionBackgroundRefreshes = 0;
  INTROSPECTION_CACHE_MAX_ENTRIES = DEFAULT_INTROSPECTION_CACHE_MAX_ENTRIES;
}

/**
 * Test-only: read the current background-refresh counter. See
 * introspectionBackgroundRefreshes for what it tracks.
 */
export function __getIntrospectionBackgroundRefreshesForTests(): number {
  return introspectionBackgroundRefreshes;
}

/**
 * Test-only: shrink (or grow) the max-entries cap so eviction can be exercised
 * without inserting 1000 real entries. Mirrors the Python template's
 * `monkeypatch.setattr(auth, "_INTROSPECTION_CACHE_MAX_ENTRIES", n)` pattern.
 * Reset to the default by __resetIntrospectionCacheForTests().
 */
export function __setIntrospectionCacheMaxEntriesForTests(n: number): void {
  INTROSPECTION_CACHE_MAX_ENTRIES = n;
}

// Resolved control-plane auth base URL, or '' when unset/invalid. An empty value
// is treated as "not configured" and causes requireOAuth to fail closed with 503.
// There is deliberately no default host — a wrong-but-plausible default (e.g. an
// unresolvable domain) silently breaks introspection in a way that is hard to debug.
export const OAUTH_BASE_URL: string = (() => {
  const raw = process.env['OAUTH_BASE_URL'];
  if (!raw) {
    console.error('[auth] OAUTH_BASE_URL is not set; all MCP requests will be denied');
    return '';
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') throw new Error('OAUTH_BASE_URL must use HTTPS');
    return url.origin;
  } catch {
    console.error(`[auth] OAUTH_BASE_URL invalid (must be an HTTPS URL); all MCP requests will be denied: "${raw}"`);
    return '';
  }
})();

/**
 * Derive the canonical MCP server URL for use as the OAuth 2.1 audience
 * and in WWW-Authenticate / /.well-known/oauth-protected-resource responses.
 *
 * Production: EZFORGE_MCP_PUBLIC_URL is always injected by the platform.
 * Local dev:  falls back to the incoming request Host header (no audience guarantee).
 */
export function getServerUrl(req?: Request): string {
  const envUrl = process.env['EZFORGE_MCP_PUBLIC_URL'];
  if (envUrl) return envUrl.replace(/\/$/, '');
  if (req) {
    const host = req.get('host') ?? 'localhost';
    // Prefer X-Forwarded-Proto: behind Fly's TLS termination req.protocol is "http",
    // which yields a non-HTTPS audience that the introspection endpoint rejects with
    // 400 (issue #4195). The header carries the original client scheme; take the first
    // value if a proxy chain produced a comma-separated list.
    const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const scheme = forwardedProto || req.protocol;
    return `${scheme}://${host}`;
  }
  return '';
}

function buildWwwAuthenticate(serverUrl: string, error?: string): string {
  const parts: string[] = [];
  parts.push(`Bearer realm="${serverUrl || 'unknown'}"`);
  if (serverUrl) {
    parts.push(`resource_metadata="${serverUrl}/.well-known/oauth-protected-resource"`);
  }
  if (error) parts.push(`error="${error}"`);
  return parts.join(', ');
}

/**
 * Validate the Bearer token in the request Authorization header.
 *
 * Calls the control-plane introspection endpoint to validate the token.
 * Returns the granted scopes plus the OAuth client's public `clientId` and
 * `clientName` (the agent app) on success. On failure, writes a 401 or 503
 * response and returns null — callers must check for null and return early.
 *
 * @param req      - Incoming Express request
 * @param res      - Express response
 * @param audience - RFC 8707 resource indicator (canonical server URL)
 */
export async function requireOAuth(
  req: Request,
  res: Response,
  audience: string,
): Promise<OAuthContext | null> {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    res
      .status(401)
      .set('WWW-Authenticate', buildWwwAuthenticate(audience))
      .json({ error: 'unauthorized', error_description: 'Bearer token required' });
    return null;
  }

  const match = /^bearer\s+(\S+)$/i.exec(authHeader);
  if (!match || !match[1]) {
    res
      .status(401)
      .set('WWW-Authenticate', buildWwwAuthenticate(audience, 'invalid_token'))
      .json({ error: 'invalid_token', error_description: 'Malformed Authorization header' });
    return null;
  }

  const bearerToken = match[1];

  // Distinct, low-cardinality debug marker: fires whenever a syntactically valid
  // bearer token reaches this machine's own auth code path, independent of the
  // eventual valid/invalid verdict. The ordinary invalid-token rejection below
  // (result.valid === false) responds 401 with no console.error — silent by
  // design, since a bad token is not a server error. Without a log line here,
  // a machine that incorrectly serves a foreign subdomain's traffic (a fly-replay
  // fan-out regression) is indistinguishable from a machine that never received
  // the request at all, defeating scripts/verify-fly-replay-routing.sh's fan-out
  // detection (issue #4705). Never logs the token value itself.
  //
  // `audience` alone cannot disambiguate fan-out from this machine's own
  // legitimate traffic: getServerUrl() returns EZFORGE_MCP_PUBLIC_URL — a fixed
  // per-machine constant — whenever it is set, regardless of the request's
  // actual Host header. The request's own Host header is included so the
  // verification script can require it to equal the probed hostname before
  // counting a match as fan-out, rather than treating every auth-path hit on a
  // non-owner machine (including its own normal traffic) as a misroute.
  console.debug(`[auth] validating bearer token for audience=${audience} host=${req.headers['host'] ?? 'unknown'}`);

  const cacheKey = introspectionCacheKey(bearerToken, audience);
  const cached = getCachedIntrospection(cacheKey);
  if (cached && !cached.isStale) {
    introspectionCacheHits++;
    console.debug(
      `[auth] introspection cache hit (hits=${introspectionCacheHits} misses=${introspectionCacheMisses} size=${introspectionCache.size})`,
    );
    return { scopes: cached.scopes, clientId: cached.clientId, clientName: cached.clientName };
  }

  if (!OAUTH_BASE_URL) {
    console.error('[auth] OAUTH_BASE_URL is not configured; cannot reach introspection endpoint');
    res.status(503).json({
      error: 'service_unavailable',
      error_description: 'Authentication service not configured',
    });
    return null;
  }

  const introspectionToken = process.env['OAUTH_INTROSPECTION_TOKEN'];

  if (!introspectionToken) {
    console.error('[auth] OAUTH_INTROSPECTION_TOKEN is not set; all MCP requests will be denied');
    res.status(503).json({
      error: 'service_unavailable',
      error_description: 'Authentication service not configured',
    });
    return null;
  }

  // Stale-while-revalidate: a stale-but-usable entry exists. Serve it now and
  // refresh in the background so this request never blocks on introspection
  // (issue #4886). Reached only after the config checks above, so the
  // background refresh has everything it needs to run.
  if (cached?.isStale) {
    introspectionCacheHits++;
    revalidateIntrospectionInBackground(cacheKey, bearerToken, audience, introspectionToken);
    console.debug(
      `[auth] introspection stale hit — serving stale, revalidating in background (hits=${introspectionCacheHits} misses=${introspectionCacheMisses} refreshes=${introspectionBackgroundRefreshes} size=${introspectionCache.size})`,
    );
    return { scopes: cached.scopes, clientId: cached.clientId, clientName: cached.clientName };
  }

  let result: IntrospectionResult;
  try {
    result = await getOrFetchIntrospection(cacheKey, bearerToken, audience, introspectionToken);
  } catch (err) {
    if (err instanceof IntrospectionHttpError) {
      console.error(`[auth] Introspection endpoint returned HTTP ${err.status}`);
    } else {
      console.error('[auth] Token introspection failed:', err);
    }
    res.status(503).json({
      error: 'service_unavailable',
      error_description: 'Authentication service temporarily unavailable',
    });
    return null;
  }

  if (!result.valid) {
    res
      .status(401)
      .set('WWW-Authenticate', buildWwwAuthenticate(audience, 'invalid_token'))
      .json({
        error: 'invalid_token',
        error_description: 'Token is invalid, expired, or not bound to this server',
      });
    return null;
  }

  const ctx: OAuthContext = {
    scopes: result.scopes ?? [],
    clientId: result.clientId,
    clientName: result.clientName,
  };
  console.debug(
    `[auth] introspection cache miss — fetched fresh (hits=${introspectionCacheHits} misses=${introspectionCacheMisses} size=${introspectionCache.size})`,
  );
  setCachedIntrospection(cacheKey, ctx);
  return ctx;
}

/**
 * Return RFC 9728 Protected Resource Metadata for this MCP server (ezforge_managed mode).
 * jwksUri is omitted — ezforge-managed tokens are 256-bit opaque tokens, not JWTs.
 *
 * Returns null when OAUTH_BASE_URL is not configured — callers must respond 503
 * rather than advertise an empty authorization_servers entry (issue #4195).
 */
export function getProtectedResourceMetadata(serverUrl: string): {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
} | null {
  if (!OAUTH_BASE_URL) return null;
  return {
    resource: serverUrl,
    authorization_servers: [OAUTH_BASE_URL],
    scopes_supported: ['mcp:read', 'mcp:write', 'mcp:execute', 'offline_access'],
    bearer_methods_supported: ['header'],
  };
}
