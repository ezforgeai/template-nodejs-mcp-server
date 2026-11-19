/**
 * Analytics event reporting for ezForge Ready.
 *
 * Sends structured events to the platform analytics API. The endpoint is
 * resolved from EZFORGE_READY_CONFIG.analytics.reportingEndpoint or the
 * EZFORGE_ANALYTICS_ENDPOINT environment variable.
 *
 * An explicit EZFORGE_READY_CONFIG.analytics.enabled === false disables
 * analytics unconditionally, even when EZFORGE_ANALYTICS_ENDPOINT is injected
 * as a platform secret. If no endpoint is configured a no-op reporter is used
 * so the server starts cleanly without analytics infrastructure. Each report
 * is bounded by a timeout so a slow or rate-limited endpoint cannot pile up
 * in-flight fetches on the event loop.
 */

export interface AnalyticsEvent {
  /** Event type identifier, e.g. "session_started", "tool_called" */
  type: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Business ID for event attribution */
  businessId?: string;
  /** Session ID for grouping related events */
  sessionId?: string;
  /** Arbitrary event payload */
  data?: Record<string, unknown>;
}

export interface AnalyticsReporter {
  report(event: AnalyticsEvent): Promise<void>;
}

/**
 * Max stored length of the Signature-Agent header value. Basis: Assumption,
 * not measured — the value is a structured-field dictionary of one or a few
 * HTTPS URLs; 512 bounds the stored JSON while leaving room for several URLs.
 */
export const SIGNATURE_AGENT_MAX_LEN = 512;

/**
 * Unverified Web Bot Auth signals read from request headers. A `type` alias,
 * not an `interface`: only an alias is assignable to `AnalyticsEvent.data`
 * (`Record<string, unknown>`); an interface has no implicit index signature.
 */
export type AgentSignals = {
  /** Raw Signature-Agent value, truncated to SIGNATURE_AGENT_MAX_LEN. Absent when not sent. */
  signatureAgent?: string;
  /** True when both Signature and Signature-Input headers are present. */
  signed: boolean;
  /**
   * True when a DPoP request header is present or the Authorization scheme is
   * `DPoP` (RFC 9449). Presence only: the proof and token are never read into
   * the result or verified.
   */
  dpop: boolean;
};

function headerValue(value: string | string[] | undefined): string | undefined {
  const joined = Array.isArray(value) ? value.join(', ') : value;
  return joined === undefined || joined === '' ? undefined : joined;
}

/**
 * Extracts Web Bot Auth (draft-ietf-webbotauth-httpsig-protocol) and DPoP
 * (RFC 9449) presence signals for the session_started event (built by
 * `buildSessionStartedEvent`, emitted once per `initialize` on the stateless
 * `/mcp` endpoint, #13166) and by the vertical templates. Observation only:
 * nothing is verified. Only the
 * Signature-Agent value is returned; the Signature value, DPoP proof,
 * Authorization and every other header are never read into the result. Of
 * Authorization only the scheme is inspected, to set the `dpop` boolean.
 */
export function extractAgentSignals(
  headers: Record<string, string | string[] | undefined>,
): AgentSignals {
  const signatureAgent = headerValue(headers['signature-agent']);
  const signed =
    headerValue(headers['signature']) !== undefined &&
    headerValue(headers['signature-input']) !== undefined;
  const dpop =
    headerValue(headers['dpop']) !== undefined ||
    /^dpop(\s|$)/i.test(headerValue(headers['authorization']) ?? '');
  return signatureAgent === undefined
    ? { signed, dpop }
    : { signatureAgent: signatureAgent.slice(0, SIGNATURE_AGENT_MAX_LEN), signed, dpop };
}

/** Inputs for {@link buildSessionStartedEvent}. */
export interface SessionStartedInput {
  /** Server id, attributed as the event's `businessId`. */
  serverId: string;
  /** Lower-cased request headers of the `initialize` POST (web-standard `Headers` fold to this shape). */
  headers: Record<string, string | string[] | undefined>;
  /** OAuth client id from token introspection; empty/absent is omitted. */
  clientId?: string | undefined;
  /** OAuth client display name from token introspection; empty/absent is omitted. */
  clientName?: string | undefined;
  /** Clock override for tests; defaults to now. */
  now?: Date;
}

/**
 * Builds the `session_started` event for one JSON-RPC `initialize` request.
 * The `data` shape is the one the vertical templates and the Ready analytics
 * dashboard (`apps/web/.../ready/analytics/route.ts`) read: `extractAgentSignals`
 * (#12659, #12669) plus the OAuth client's public id and registered name
 * (#12667, scaling_model.md R35/R36). The stateless `/mcp` endpoint has no
 * session id, so `sessionId` is not set.
 */
export function buildSessionStartedEvent(input: SessionStartedInput): AnalyticsEvent {
  return {
    type: 'session_started',
    timestamp: (input.now ?? new Date()).toISOString(),
    businessId: input.serverId,
    data: {
      ...extractAgentSignals(input.headers),
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.clientName ? { clientName: input.clientName } : {}),
    },
  };
}

/** No-op reporter used when no analytics endpoint is configured. */
function createNoOpReporter(): AnalyticsReporter {
  return {
    async report(_event: AnalyticsEvent): Promise<void> {
      // analytics not configured — silently discard
    },
  };
}

/**
 * HTTP reporter that POSTs events to the given endpoint as JSON.
 * Includes Authorization: Bearer header when ANALYTICS_INGEST_TOKEN is set.
 * Each POST is bounded by an AbortSignal timeout so a slow or rate-limited
 * (429) endpoint cannot pile up unbounded in-flight fetches on the event loop.
 * Network errors (including timeouts) are logged but never thrown so callers
 * are not disrupted.
 */
export function createHttpReporter(
  endpoint: string,
  token?: string,
  timeoutMs: number = resolveAnalyticsTimeoutMs(),
): AnalyticsReporter {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return {
    async report(event: AnalyticsEvent): Promise<void> {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          console.error(`[analytics] HTTP ${response.status} reporting event to ${endpoint}`);
        }
      } catch (err) {
        console.error('[analytics] Failed to report event:', err);
      }
    },
  };
}

/**
 * Resolves the analytics endpoint from config or environment variable.
 * Config value takes precedence over the environment variable.
 */
export function resolveAnalyticsEndpoint(configEndpoint?: string): string | undefined {
  return configEndpoint ?? process.env['EZFORGE_ANALYTICS_ENDPOINT'];
}

/**
 * Resolves the analytics ingest token from the environment variable.
 * Uses ANALYTICS_INGEST_TOKEN — the canonical name matching the platform-side
 * /api/v1/analytics/ingest route expectation (route.ts:31).
 */
export function resolveAnalyticsToken(): string | undefined {
  return process.env['ANALYTICS_INGEST_TOKEN'];
}

/** Default per-report HTTP timeout (ms) when EZFORGE_ANALYTICS_TIMEOUT_MS is unset. */
const DEFAULT_ANALYTICS_TIMEOUT_MS = 2000;

/**
 * Resolves the per-report HTTP timeout from EZFORGE_ANALYTICS_TIMEOUT_MS,
 * falling back to DEFAULT_ANALYTICS_TIMEOUT_MS when unset or invalid.
 */
export function resolveAnalyticsTimeoutMs(): number {
  const raw = process.env['EZFORGE_ANALYTICS_TIMEOUT_MS'];
  if (raw === undefined) return DEFAULT_ANALYTICS_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ANALYTICS_TIMEOUT_MS;
}

/**
 * Settings that drive reporter selection — a subset of the config analytics
 * block (config-loader AnalyticsBlock) plus environment fallbacks.
 */
export interface AnalyticsSettings {
  /** Explicit on/off toggle. When false, analytics is disabled unconditionally. */
  enabled?: boolean;
  /** Config-supplied endpoint; takes precedence over EZFORGE_ANALYTICS_ENDPOINT. */
  reportingEndpoint?: string;
}

/**
 * Creates the appropriate analytics reporter based on configuration.
 *
 * An explicit `enabled: false` disables analytics unconditionally — even when
 * EZFORGE_ANALYTICS_ENDPOINT is injected as a platform secret. Otherwise the
 * endpoint is resolved from config or the environment; a missing endpoint
 * yields a no-op reporter so the server starts cleanly.
 */
export function createReporter(analytics?: AnalyticsSettings): AnalyticsReporter {
  if (analytics?.enabled === false) return createNoOpReporter();
  const endpoint = resolveAnalyticsEndpoint(analytics?.reportingEndpoint);
  if (!endpoint) return createNoOpReporter();
  const token = resolveAnalyticsToken();
  return createHttpReporter(endpoint, token);
}
