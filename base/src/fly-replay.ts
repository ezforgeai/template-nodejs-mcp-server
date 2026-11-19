/**
 * fly-replay middleware — routes misrouted requests to the correct Fly machine.
 *
 * In the shared ezforge-mcp Fly app, many machines (one per tenant MCP server)
 * share the same Fly app name. Fly's HTTP load balancer round-robins inbound
 * requests across all running machines. When a request for
 * abc123.mcp.ezforge.ai lands on the wrong machine, this middleware detects
 * the Host-header mismatch, looks up the correct machine ID by asking the
 * platform about that one subdomain, and responds with a `fly-replay` header so
 * the Fly proxy can forward the request to the right machine. No Fly API token
 * is present on the machine (#12027).
 *
 * Vanity hosts (issue #13447):
 *   `servers.subdomain` stores a server's full host, which is usually
 *   `<base>.<MCP_DOMAIN>` but can be a vanity host such as `hub-mcp.ezforge.ai`.
 *   A host under `.MCP_DOMAIN` is looked up by its base subdomain
 *   (`?subdomain=<base>`). Any other host is looked up by its full lowercased name
 *   (`?host=<full host>`) through the same cache, single-flight and bounce path, and
 *   is replayed on a machine id; it falls through to next() only on a definitive 404
 *   (or a 400, below), exactly as an unknown MCP-domain host does. Before this, a
 *   non-MCP-domain host was passed through unconditionally, so it was answered by
 *   whichever machine Fly's load balancer picked (the Hub's `hub-mcp.ezforge.ai`
 *   landed on unrelated load-test machines).
 *   - Cache keys for full-host lookups carry a `host:` prefix so they never equal a
 *     base-subdomain key (`foo.example.com` the vanity host vs `foo.example.com.<MCP_DOMAIN>`
 *     whose base subdomain is also `foo.example.com`).
 *   - Version skew: a route that predates `host=` answers 400 (no `subdomain`), which
 *     is treated as "no machine" (next()), not FETCH_ERROR: a vanity host is then
 *     served as it was before this change (by whichever machine answers), and no
 *     host that used to pass through starts failing. Only a platform that knows
 *     `host=` makes vanity hosts replay. An old middleware calling the new route is
 *     unaffected: `?subdomain=` answers are unchanged.
 *   - Cost: a distinct unknown host is one lookup and one 404-cache entry, like an
 *     unknown MCP-domain label; the 404 cache is bounded (see "Negative cache").
 *     `/health` and `/healthz` still pass through before any lookup, so `/healthz`
 *     does not prove which machine answered.
 *
 * Hosts that are never looked up (no lookup, no cache entry, next() as before): the
 * Fly platform's own traffic and local probes address a machine by these names, and
 * none can be a server's public DNS name. Excluded: IP literals (dotted IPv4, any host
 * whose last label is all digits, bracketed IPv6), `localhost` and `*.localhost`,
 * `*.fly.dev` (the deploy check), `*.flycast` (Fly private networking) and
 * `*.internal` (6PN private DNS). A host that is not a valid DNS name (a label that is
 * empty, over 63 characters or has characters outside [a-z0-9-], over 253 characters,
 * or one label only) is also skipped locally, because the route would answer 400.
 *
 * Reference: https://fly.io/docs/networking/dynamic-request-routing/#the-fly-replay-response-header
 *
 * Environment variables:
 *   SERVER_SUBDOMAIN  — This machine's full subdomain (e.g. "abc123.mcp.ezforge.ai"),
 *                       set by the lifecycle module at provision time. Includes
 *                       the domain suffix.
 *   MCP_DOMAIN        — Domain suffix for MCP servers (default: "mcp.ezforge.ai").
 *   EZFORGE_ROUTING_TOKEN — Per-machine routing credential issued by the
 *                       platform at provision time (#12033). Required for every
 *                       lookup (see "Lookup"); when unset the lookup is a
 *                       CONFIG_ERROR. It authorizes only the per-subdomain
 *                       lookup — not the Fly API.
 *   OAUTH_BASE_URL    — Platform base URL, already injected on every machine for
 *                       token introspection and read through auth.ts (HTTPS
 *                       only). The lookup endpoint is
 *                       `${OAUTH_BASE_URL}/api/v1/internal/mcp-routing`. No new
 *                       env var is needed for the URL.
 *   FLY_REPLAY_LOOKUP_TIMEOUT_MS — Lookup timeout in milliseconds (default 2000,
 *                       see "Lookup timeout").
 *   FLY_REPLAY_STALE_TTL_MS — How much longer, past CACHE_TTL_MS, a cached
 *                       machine ID may still be served *stale* while a
 *                       background refresh runs (stale-while-revalidate).
 *                       Milliseconds (default: 30000).
 *   FLY_REPLAY_MAX_BOUNCES — Maximum number of `fly-replay: elsewhere=true`
 *                       hops a single client request may accumulate before
 *                       this middleware gives up and returns 503 instead of
 *                       bouncing again (default: 3). See "Fail-open bounce
 *                       on transient failure" below.
 *   FLY_REPLAY_CACHE_TTL_SECS — TTL, in seconds, advertised to the Fly proxy
 *                       via `fly-replay-cache-ttl-secs` on the positive
 *                       (`instance=`) replay branch only (default: 60).
 *                       Values below Fly's documented 10 s minimum are
 *                       clamped to 10 and logged once as a configuration
 *                       error rather than silently accepted. See "Replay
 *                       caching" below.
 *
 * Lookup (off-machine lookup, issue #12035, parent #12027; design
 * docs/mcp-machine-token-exposure.md §3.3 option 1):
 *   On a cache miss, ask the platform about the one requested subdomain —
 *   GET ${OAUTH_BASE_URL}/api/v1/internal/mcp-routing?subdomain=<base> (or
 *   `?host=<full host>` for a host outside MCP_DOMAIN, see "Vanity hosts") with
 *   `Authorization: Bearer <EZFORGE_ROUTING_TOKEN>`. 200 `{ machineId }` is the
 *   machine; 404 is `null` (falls through to next(), exactly as before); 400
 *   (a malformed name, or an old route that does not know host=; see "Vanity
 *   hosts") is also `null`; a timeout, network error, 401, 429, 5xx, any other status, or a
 *   200 whose body has no machineId, or one that does not match
 *   ^[A-Za-z0-9_-]{1,64}$ (never cached, never echoed), is FETCH_ERROR. An unset
 *   EZFORGE_ROUTING_TOKEN or a missing/invalid OAUTH_BASE_URL is CONFIG_ERROR,
 *   with no request issued. The credential, the full request path and the
 *   response body are never logged.
 *
 * Negative cache:
 *   A 404 is remembered per lookup key (base subdomain, or `host:`-prefixed full
 *   host) for 5 s and answered `null` without a lookup, so repeated requests for
 *   the same unknown Host do not each spend one of this machine's
 *   routing-credential lookups (capped per credential by RATE_LIMITS.routing). It
 *   is bounded at 1024 entries (oldest evicted first) and is cleared by a later
 *   200. A 400 and every failure are never cached. It does not bound a flood of
 *   *distinct* unknown names: each is a miss.
 *
 * Cache and convergence window:
 *   Resolved machine IDs are fresh for CACHE_TTL_MS (30 s), then servable
 *   *stale* for a further FLY_REPLAY_STALE_TTL_MS (30 s default) while a
 *   background refresh runs, then hard-expire. If a machine is replaced
 *   mid-cache-window (e.g. during a rolling restart), requests will replay to
 *   the old instance ID and Fly will return 404 for that subdomain until the
 *   entry is refreshed with the replacement. An entry is refreshed only when it
 *   is requested after CACHE_TTL_MS (there is no background refresh loop), so
 *   the window is up to CACHE_TTL_MS for a hot subdomain. The
 *   documented worst case — if the lookup is unreachable for an extended
 *   period — is CACHE_TTL_MS + FLY_REPLAY_STALE_TTL_MS (60 s by default)
 *   before a subdomain falls back to a blocking cold lookup. This is
 *   acceptable for the MCP routing use case — see README for details. A 404
 *   from a platform refresh drops that lookup key's cached entry.
 *
 * No background refresh:
 *   A lookup is per subdomain and only on demand, so lookups scale with
 *   distinct misrouted subdomains rather than with time. No timer runs.
 *
 * Single-flight:
 *   Concurrent requests for an uncached subdomain are coalesced into a single
 *   upstream call to avoid stampeding the endpoint. It is keyed per subdomain:
 *   a lookup answers one subdomain, so two misses for the same subdomain share
 *   one request and a miss for a different subdomain runs its own. A
 *   stale-cache hit refreshes only that subdomain, in the background through
 *   the same slot, so a burst of stale hits for one subdomain produces one
 *   request.
 *
 * Lookup timeout:
 *   The lookup is bounded by LOOKUP_TIMEOUT_MS (override via
 *   FLY_REPLAY_LOOKUP_TIMEOUT_MS). A lookup that has not returned within the
 *   budget is treated the same as any other lookup failure — FETCH_ERROR —
 *   rather than waiting further. Default 2000 ms. The platform is reached over
 *   public HTTPS, so a lookup can include DNS, TCP and TLS setup (about 3
 *   round trips on a cold connection) before the endpoint's two indexed reads
 *   and one rate-limit call (~10 ms of database time, per the R26 row in
 *   executive/governance/scaling_model.md). The actual latency from an MCP
 *   machine is Unknown and has not been measured; 2000 ms is an Assumption
 *   chosen to sit between a 750 ms in-datacenter budget (the removed Machines
 *   API lookup's), which would likely
 *   bounce healthy cold-connection lookups, and the 3000 ms budget PERF-R04
 *   (issue #6662) removed. A timeout only costs a capped fail-open bounce, so
 *   the budget errs short of 3000 ms. Revisit once real latency is measured;
 *   FLY_REPLAY_LOOKUP_TIMEOUT_MS overrides it per machine.
 *
 * Fail-open bounce on transient failure (PERF-R04 step 3/5, issue #6664,
 * Member-approved with binding conditions):
 *   The lookup can fail for two structurally different reasons, and this
 *   middleware treats them differently:
 *     - CONFIG_ERROR — this machine cannot authenticate to the lookup:
 *       EZFORGE_ROUTING_TOKEN or a valid OAUTH_BASE_URL is unset. That is a
 *       broken deployment, not a transient blip, and must stay loud. Responds
 *       503 (see #4286).
 *     - FETCH_ERROR — the lookup timed out or returned an error. This is
 *       transient. Instead of 503, the middleware responds
 *       `fly-replay: elsewhere=true`, which tells the Fly proxy to
 *       re-balance the request to a different machine, excluding this one
 *       (https://fly.io/docs/networking/dynamic-request-routing/). The
 *       bounced request carries an incrementing hop count in the `state`
 *       field, read back from the `fly-replay-src` header Fly sets on the
 *       replayed request. Once the hop count exceeds FLY_REPLAY_MAX_BOUNCES
 *       (default 3), the middleware gives up and returns 503 instead of
 *       bouncing again — an uncapped bounce loop under a persistent lookup
 *       outage would otherwise walk machines indefinitely. A distinct
 *       log line is emitted on every bounce and on every cap trip, so the
 *       bounce rate is observable from logs without a new metric — see
 *       issue #4082, whose measured ~25% proxy-edge timeout rate for
 *       cross-subdomain replay motivates keeping this rate visible and
 *       capped rather than assumed safe.
 *   The `null` outcome (the lookup succeeded; no machine currently
 *   claims this subdomain) is unaffected by any of the above — it still
 *   falls through to `next()` so route handlers 404 naturally. Bouncing a
 *   genuinely nonexistent subdomain would walk every machine in the app for
 *   no reason.
 *
 * Replay caching (PERF-R04 step 4/5, issue #6665):
 *   Fly's proxy can remember a replay decision and apply it to subsequent
 *   requests for the same host, so they never reach a wrong machine at all
 *   (https://fly.io/docs/networking/dynamic-request-routing/#replay-caching).
 *   This middleware requests that caching by adding `fly-replay-cache:
 *   <hostname>/*` and `fly-replay-cache-ttl-secs: <CACHE_TTL_SECS>` — but
 *   only alongside the positive `instance=` replay, never alongside
 *   `elsewhere=true`, the 503 branches, or the `next()` fallthrough. Per the
 *   docs, caching is "an optimization, not a guarantee" — Fly may consult
 *   the origin at any moment — so this middleware remains fully correct with
 *   the cache ignored entirely; caching can only ever reduce how often a
 *   misroute happens, never something the middleware depends on.
 *   The docs also forbid combining a cacheable replay with `state`,
 *   `timeout`, or `fallback`. `state` is exactly what the fail-open bounce
 *   above uses to carry its hop counter — but that value is only ever
 *   emitted on the `elsewhere=true` branch, never on the `instance=`
 *   branch that carries the cache headers, so the two are structurally
 *   disjoint and never appear on the same response.
 */

import type { Request, Response, NextFunction } from 'express';
import { OAUTH_BASE_URL } from './auth.js';

const SERVER_SUBDOMAIN = process.env['SERVER_SUBDOMAIN'] ?? '';
const MCP_DOMAIN = process.env['MCP_DOMAIN'] ?? 'mcp.ezforge.ai';
const EZFORGE_ROUTING_TOKEN = process.env['EZFORGE_ROUTING_TOKEN'] ?? '';

const MCP_ROUTING_PATH = '/api/v1/internal/mcp-routing';
const CACHE_TTL_MS = 30 * 1000; // 30 seconds

// Default lookup budget. See "Lookup timeout" above for its basis.
const DEFAULT_LOOKUP_TIMEOUT_MS = 2000;

// How long to wait for the lookup before aborting and failing via FETCH_ERROR.
// See "Lookup timeout" above.
const LOOKUP_TIMEOUT_MS: number = (() => {
  const raw = process.env['FLY_REPLAY_LOOKUP_TIMEOUT_MS'];
  if (!raw) return DEFAULT_LOOKUP_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LOOKUP_TIMEOUT_MS;
})();

// How much longer, past CACHE_TTL_MS, a cached entry may still be served
// stale while a background refresh runs. See "Cache and convergence window"
// above.
const STALE_TTL_MS: number = (() => {
  const raw = process.env['FLY_REPLAY_STALE_TTL_MS'];
  if (!raw) return 30_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000;
})();

// Matches the Python mirror's `int(raw)` semantics: only a (possibly signed)
// run of digits is a valid integer literal. Python's int() raises ValueError
// on "3.5" or "1e2"; Number() would silently accept both as finite values,
// so MAX_BOUNCES below checks this pattern first to stay aligned with the
// Python template's parsing behavior for the same env var.
const INTEGER_LITERAL_RE = /^\s*[+-]?\d+\s*$/;

// Maximum number of elsewhere=true bounces a single client request may
// accumulate before this middleware fails closed with a 503. See "Fail-open
// bounce on transient failure" above.
const MAX_BOUNCES: number = (() => {
  const raw = process.env['FLY_REPLAY_MAX_BOUNCES'];
  if (!raw || !INTEGER_LITERAL_RE.test(raw)) return 3;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
})();

// Fly's documented minimum TTL for a cacheable replay. See "Replay caching"
// above.
const CACHE_MIN_TTL_SECS = 10;
const CACHE_DEFAULT_TTL_SECS = 60;

// TTL, in seconds, advertised via fly-replay-cache-ttl-secs on the positive
// replay branch. A value below the documented minimum is a configuration
// error — clamp it and log once, rather than either silently accepting an
// out-of-spec TTL or letting Fly reject the response. Malformed or unset
// input falls back to the default, mirroring the other numeric env vars
// above.
const CACHE_TTL_SECS: number = (() => {
  const raw = process.env['FLY_REPLAY_CACHE_TTL_SECS'];
  if (!raw) return CACHE_DEFAULT_TTL_SECS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return CACHE_DEFAULT_TTL_SECS;
  if (parsed < CACHE_MIN_TTL_SECS) {
    console.error(
      `[fly-replay] FLY_REPLAY_CACHE_TTL_SECS=${raw} is below Fly's documented ${String(CACHE_MIN_TTL_SECS)}s minimum — clamping to ${String(CACHE_MIN_TTL_SECS)}s`,
    );
    return CACHE_MIN_TTL_SECS;
  }
  return Math.trunc(parsed);
})();

// Exposed for tests only — never read by production code.
export const __LOOKUP_TIMEOUT_MS_FOR_TESTS = LOOKUP_TIMEOUT_MS;
export const __STALE_TTL_MS_FOR_TESTS = STALE_TTL_MS;
export const __MAX_BOUNCES_FOR_TESTS = MAX_BOUNCES;
export const __CACHE_TTL_SECS_FOR_TESTS = CACHE_TTL_SECS;

// Sentinel returned when this machine cannot authenticate to the lookup at
// all (no routing credential, or no usable platform base URL). A broken
// deployment, not a transient blip — the middleware fails closed with a 503 so
// it stays detectable (#4286) rather than being silently bounced away.
const CONFIG_ERROR = Symbol('CONFIG_ERROR');

// Sentinel returned when the lookup itself failed (timed out, network error,
// or a non-ok response) despite valid configuration. Distinct
// from null ("no machine owns this subdomain", a legitimate fallthrough) and
// from CONFIG_ERROR (fails closed). FETCH_ERROR is transient, so the
// middleware responds with a capped `fly-replay: elsewhere=true` bounce
// instead of a 503 — see "Fail-open bounce on transient failure" above.
const FETCH_ERROR = Symbol('FETCH_ERROR');

// Header-safe machine ID from the platform lookup (issue #12127): no CR/LF,
// comma, semicolon or whitespace can reach the `fly-replay` header. Real Fly
// machine IDs are 14 lowercase hex characters; this is deliberately looser.
const MACHINE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Cache resolved machine IDs to avoid hammering the routing lookup.
// Key: base subdomain extracted from Host header (e.g. "abc123").
// Fresh until expiresAt; served stale (while a background refresh runs) until
// staleUntil; hard-expired past it. Mirrors the shape and naming of
// CachedIntrospection in auth.ts.
const resolveCache = new Map<string, { machineId: string; expiresAt: number; staleUntil: number }>();

type SubdomainLookup = string | null | typeof CONFIG_ERROR | typeof FETCH_ERROR;

// Negative cache: base subdomain -> time until which a 404 from
// the platform is reused instead of asking again. Without it, every request
// for an unknown subdomain would spend one of this machine's routing-credential
// lookups (see "Negative cache" in the module docstring). Only 404s are stored,
// so every key is a name the endpoint accepted: a base subdomain (one DNS label, at
// most 63 characters) or a prefixed full host (at most 5 + 253 characters, the
// length isLookupableVanityHost admits).
const notFoundUntil = new Map<string, number>();

// Negative cache bounds. TTL: a subdomain that is created right
// after a 404 is served 404 for at most this long, inside the 30 s positive
// CACHE_TTL_MS and the 5-10 s range the review of #12124 asked for. Cap: at most
// 1024 keys of <= 258 characters plus a number each, about 270 KB at the worst case
// (1024 x ~266 bytes, calculated from the key bound above, not measured; the
// pre-#13447 bound was about 100 KB for 63-character labels).
const NOT_FOUND_TTL_MS = 5 * 1000;
const NOT_FOUND_MAX_ENTRIES = 1024;

/** Record a platform 404 for a subdomain, evicting the oldest entries at the cap. */
function rememberNotFound(subdomain: string): void {
  // Re-insert so Map order is expiry order: the first key is always the oldest.
  notFoundUntil.delete(subdomain);
  while (notFoundUntil.size >= NOT_FOUND_MAX_ENTRIES) {
    const oldest = notFoundUntil.keys().next();
    if (oldest.done) break;
    notFoundUntil.delete(oldest.value);
  }
  notFoundUntil.set(subdomain, Date.now() + NOT_FOUND_TTL_MS);
}

/** True while a recent platform 404 for this subdomain is still reusable. */
function isRecentlyNotFound(subdomain: string): boolean {
  const until = notFoundUntil.get(subdomain);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  notFoundUntil.delete(subdomain);
  return false;
}

// Single-flight table, keyed by base subdomain: a lookup answers
// one subdomain, so only same-subdomain callers coalesce. Entries are removed
// when their request settles, so the table holds at most one entry per
// subdomain with a request in flight.
const subdomainFetchInFlight = new Map<string, Promise<SubdomainLookup>>();

/**
 * Ask the platform which machine serves one base subdomain and cache the
 * answer. Returns the machine ID on 200, null on 404 (no machine claims it —
 * a cached entry for it is dropped), CONFIG_ERROR when EZFORGE_ROUTING_TOKEN is
 * unset or OAUTH_BASE_URL is not a usable HTTPS origin, or FETCH_ERROR on a timeout, network error, or any
 * other status (401, 429, 5xx, ...) or malformed 200 body. On failure,
 * existing cache entries are left untouched. Never rejects, and never logs the
 * credential, the request path or the response body.
 */
async function fetchAndPopulateOne(subdomain: string): Promise<SubdomainLookup> {
  if (!EZFORGE_ROUTING_TOKEN) {
    console.error(
      '[fly-replay] EZFORGE_ROUTING_TOKEN not configured — refusing to serve misrouted request',
    );
    return CONFIG_ERROR;
  }

  if (!OAUTH_BASE_URL) {
    console.error(
      '[fly-replay] OAUTH_BASE_URL not configured — cannot look up misrouted request',
    );
    return CONFIG_ERROR;
  }

  try {
    const url = `${OAUTH_BASE_URL}${MCP_ROUTING_PATH}?${lookupQuery(subdomain)}`;
    // redirect: 'error' — never follow a redirect with the bearer credential.
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${EZFORGE_ROUTING_TOKEN}` },
      redirect: 'error',
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });

    if (res.status === 404) {
      resolveCache.delete(subdomain);
      rememberNotFound(subdomain);
      return null;
    }

    // 400: the endpoint rejects the name as malformed, so no machine can own it. Same
    // outcome as 404 (fall through, no bounce), but not cached: a malformed name is
    // never a legitimate subdomain. For a `host=` lookup, an OLD route also answers
    // 400 (it does not know the parameter); that too falls through, which is today's
    // behavior for such a host, so version skew never adds a failure. See "Vanity
    // hosts" in the module docstring.
    if (res.status === 400) {
      resolveCache.delete(subdomain);
      return null;
    }

    if (!res.ok) {
      console.error(
        `[fly-replay] routing lookup returned ${String(res.status)} for ${subdomain} — cannot resolve machine`,
      );
      return FETCH_ERROR;
    }

    const body = (await res.json()) as { machineId?: unknown } | null;
    const machineId = body?.machineId;
    if (typeof machineId !== 'string' || machineId === '') {
      console.error(
        `[fly-replay] routing lookup for ${subdomain} returned a response without a machineId`,
      );
      return FETCH_ERROR;
    }

    // The value is interpolated into the `fly-replay` response header, so it must
    // be header-safe. Never echo it: a rejected value is attacker-shaped input.
    if (!MACHINE_ID_RE.test(machineId)) {
      console.error(
        `[fly-replay] routing lookup for ${subdomain} returned a response without a machineId in the expected format`,
      );
      return FETCH_ERROR;
    }

    const now = Date.now();
    resolveCache.set(subdomain, {
      machineId,
      expiresAt: now + CACHE_TTL_MS,
      staleUntil: now + CACHE_TTL_MS + STALE_TTL_MS,
    });
    notFoundUntil.delete(subdomain);
    return machineId;
  } catch (err) {
    // Log the error name only: a fetch error message can echo the URL.
    console.error(
      `[fly-replay] routing lookup failed for ${subdomain}:`,
      err instanceof Error ? err.name : 'unknown error',
    );
    return FETCH_ERROR;
  }
}

/** Read a cache entry, distinguishing a fresh hit from a stale-but-servable one. */
function getCachedEntry(subdomain: string): { machineId: string; isStale: boolean } | null {
  const entry = resolveCache.get(subdomain);
  if (!entry) return null;
  const now = Date.now();
  if (now < entry.expiresAt) return { machineId: entry.machineId, isStale: false };
  if (now < entry.staleUntil) return { machineId: entry.machineId, isStale: true };
  // Hard-expired: drop it and force a blocking re-fetch.
  resolveCache.delete(subdomain);
  return null;
}

/**
 * Start (or join) a lookup for one subdomain, registering it in the
 * per-subdomain single-flight table so concurrent callers for that subdomain
 * coalesce onto the same request. Callers for other subdomains do not.
 */
function startSubdomainFetch(subdomain: string): Promise<SubdomainLookup> {
  const inFlight = subdomainFetchInFlight.get(subdomain);
  if (inFlight) return inFlight;
  const promise = fetchAndPopulateOne(subdomain).finally(() => {
    subdomainFetchInFlight.delete(subdomain);
  });
  subdomainFetchInFlight.set(subdomain, promise);
  return promise;
}

/**
 * Look up the Fly machine ID for a base subdomain using the cache, with
 * single-flight deduplication for concurrent uncached lookups (per
 * subdomain). A stale hit returns immediately and triggers a detached
 * background refresh of only that subdomain, never awaited — it must not block
 * the response; a cold miss blocks on a lookup.
 */
async function resolveSubdomain(subdomain: string): Promise<SubdomainLookup> {
  const cached = getCachedEntry(subdomain);
  if (cached) {
    if (cached.isStale) {
      void startSubdomainFetch(subdomain);
    }
    return cached.machineId;
  }

  if (isRecentlyNotFound(subdomain)) return null;
  return startSubdomainFetch(subdomain);
}

/**
 * Extract the hostname from the Host header, stripping any port suffix. A bracketed
 * IPv6 literal (`[fdaa::1]:8080`) is returned with its brackets so it is recognizable
 * as an IP literal; splitting on the first ':' would leave a bare `[`.
 */
function getHostname(req: Request): string | null {
  const host = req.headers['host'];
  if (!host) return null;
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(0, close + 1);
  }
  return host.split(':')[0] ?? null;
}

// Hosts that can never be a `servers.subdomain` and therefore never cost a lookup. Each
// has a reason: the Fly platform's own traffic (health checks, the deploy check, private
// networking) addresses a machine by these names and must keep today's behavior, and a
// server's `subdomain` is a public DNS name, which none of these is.
//   - IP literals (IPv4 dotted, any all-numeric last label, bracketed IPv6): Fly checks
//     and direct-IP access use the machine's address as the Host.
//   - `localhost` and `*.localhost` (RFC 6761): local and in-VM probes.
//   - `*.fly.dev`: the app's own public name, used by the deploy check.
//   - `*.flycast`: Fly private (Flycast) networking between apps.
//   - `*.internal`: Fly 6PN private DNS (`<app>.internal`, `<id>.vm.<app>.internal`).
const NEVER_SERVER_HOST_SUFFIXES = ['.localhost', '.fly.dev', '.flycast', '.internal'];

// One DNS label: lowercase letters, digits, hyphens, no leading or trailing hyphen, 1-63
// characters. The same shape the routing route accepts for `host=` (route.ts), so a host
// that fails here would be a 400 there: checking locally spends no lookup on it.
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Cache/single-flight/negative-cache keys for a full-host lookup carry this prefix, so
// they can never equal a base-subdomain key. Without it, the vanity host `foo.example.com`
// and the MCP-domain host `foo.example.com.<MCP_DOMAIN>` (base subdomain `foo.example.com`,
// which the route rejects as 400) would share a key, and a cached machine for the first
// would be replayed for the second. A Host header never contains ':' after getHostname
// strips the port, so no base subdomain can start with the prefix.
const HOST_KEY_PREFIX = 'host:';

/** True when a lowercased hostname outside MCP_DOMAIN may be a server's vanity host. */
function isLookupableVanityHost(host: string): boolean {
  if (host.length > 253) return false;
  if (host === 'localhost') return false;
  if (host.startsWith('[')) return false; // IPv6 literal
  if (NEVER_SERVER_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false; // single-label names: `localhost`, bare `internal`
  if (!labels.every((label) => HOST_LABEL_RE.test(label))) return false;
  // An all-numeric last label is never a real TLD: dotted IPv4 and the other numeric forms.
  return !/^[0-9]+$/.test(labels[labels.length - 1] ?? '');
}

/** Query string naming the lookup key: `host=<full host>` for a prefixed key, else `subdomain=<base>`. */
function lookupQuery(key: string): string {
  return key.startsWith(HOST_KEY_PREFIX)
    ? `host=${encodeURIComponent(key.slice(HOST_KEY_PREFIX.length))}`
    : `subdomain=${encodeURIComponent(key)}`;
}

/**
 * Read the hop count this request has already accumulated across prior
 * elsewhere=true bounces, from the `state` field of the inbound
 * `fly-replay-src` header (which Fly sets on a replayed request, echoing the
 * `state` value this middleware set on its own `fly-replay` response
 * header). Missing, malformed, or negative values are treated as 0 — a
 * request's first bounce.
 */
function getBounceHopCount(req: Request): number {
  const header = req.headers['fly-replay-src'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return 0;
  const match = /(?:^|;)\s*state\s*=\s*(\d+)\s*(?:;|$)/.exec(value);
  if (!match?.[1]) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Respond to a transient routing-lookup failure (FETCH_ERROR) with a capped
 * `fly-replay: elsewhere=true` bounce, or a 503 once the request has already
 * accumulated FLY_REPLAY_MAX_BOUNCES hops. See "Fail-open bounce on
 * transient failure" in the module docstring.
 */
function respondBounce(req: Request, res: Response, subdomain: string): void {
  const hopCount = getBounceHopCount(req);
  const nextHop = hopCount + 1;
  if (nextHop > MAX_BOUNCES) {
    console.error(
      `[fly-replay] bounce cap (${String(MAX_BOUNCES)}) exceeded for ${subdomain} after ${String(hopCount)} hop(s) — returning 503`,
    );
    res.status(503).end();
    return;
  }
  console.warn(
    `[fly-replay] transient lookup failure for ${subdomain} — bouncing elsewhere (hop ${String(nextHop)}/${String(MAX_BOUNCES)})`,
  );
  res.set('fly-replay', `elsewhere=true;state=${String(nextHop)}`);
  res.status(200).end();
}

/**
 * Express middleware that detects misrouted requests in the shared Fly app
 * and responds with a fly-replay header to redirect to the correct machine.
 *
 * Must be registered before any route handlers.
 */
export function flyReplayMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Pass through when SERVER_SUBDOMAIN is not set (local dev or any runtime
  // not deployed in the shared Fly app).
  if (!SERVER_SUBDOMAIN) {
    next();
    return;
  }

  const hostname = getHostname(req);
  if (!hostname) {
    next();
    return;
  }

  // Request is for this machine's own subdomain — no replay needed.
  // Compared case-insensitively: the vanity lookup below lowercases the host, so a
  // mixed-case Host for this machine must not skip this shortcut and replay to itself.
  if (hostname.toLowerCase() === SERVER_SUBDOMAIN.toLowerCase()) {
    next();
    return;
  }

  // Health probes always respond from the current machine regardless of which subdomain
  // the request targets. All ezforge-mcp machines serve /health and /healthz, so routing
  // to the "correct" machine via fly-replay adds latency without improving accuracy.
  // Cross-subdomain fly-replay for health checks caused ~25% proxy-layer timeouts at
  // the Fly edge (PERF-R04-C #4082); direct pass-through eliminates that failure mode.
  if (req.path === '/health' || req.path === '/healthz') {
    next();
    return;
  }

  // A host under the MCP domain is looked up by its base subdomain (one DNS label). Any
  // other host may still be a server's vanity host (`servers.subdomain` stores the full
  // host, issue #13447), so it is looked up by full host — unless it can never be a
  // server (see "Hosts that are never looked up"), in which case it passes through to
  // route logic as before.
  let requestedSubdomain: string;
  if (hostname.endsWith(`.${MCP_DOMAIN}`)) {
    // Extract the base subdomain by stripping the domain suffix.
    requestedSubdomain = hostname.slice(0, -(MCP_DOMAIN.length + 1));
  } else {
    const vanityHost = hostname.toLowerCase();
    if (!isLookupableVanityHost(vanityHost)) {
      next();
      return;
    }
    requestedSubdomain = `${HOST_KEY_PREFIX}${vanityHost}`;
  }

  resolveSubdomain(requestedSubdomain)
    .then((machineId) => {
      if (machineId === CONFIG_ERROR) {
        // This machine cannot authenticate to the routing lookup at all — a
        // broken deployment, not a transient blip. Fail closed so it stays
        // detectable rather than being silently bounced away (#4286).
        console.error(
          `[fly-replay] configuration error for ${requestedSubdomain} — returning 503 to prevent cross-machine fan-out`,
        );
        res.status(503).end();
      } else if (machineId === FETCH_ERROR) {
        // Transient routing-lookup failure (timeout, network error, non-ok
        // response). Bounce to another machine instead of failing the
        // client's otherwise-valid request — see "Fail-open bounce on
        // transient failure" in the module docstring.
        respondBounce(req, res, requestedSubdomain);
      } else if (machineId) {
        // Log at debug level only — avoid logging the full path, which could
        // carry tokens in querystrings.
        console.debug(`[fly-replay] routing ${req.method} to machine ${machineId}`);
        res.set('fly-replay', `instance=${machineId}`);
        // Ask the Fly proxy to cache this replay decision for the requested
        // host, so subsequent requests for it skip this middleware entirely
        // until the TTL expires. Only ever set alongside the positive
        // instance= replay — never alongside elsewhere=true, state, timeout,
        // or fallback. See "Replay caching" in the module docstring.
        res.set('fly-replay-cache', `${hostname}/*`);
        res.set('fly-replay-cache-ttl-secs', String(CACHE_TTL_SECS));
        res.status(200).end();
      } else {
        // No machine claims this subdomain — let the request fall through.
        // Route handlers will return 404 naturally.
        next();
      }
    })
    .catch((err: unknown) => {
      console.error('[fly-replay] Unexpected error:', err);
      res.status(503).end();
    });
}
