/**
 * Delivery of customer requests (reservations, orders, appointments, quotes,
 * consultations) from a Ready template server to the business owner.
 *
 * Templates run as separate servers and hold no SMTP or SMS credentials. A
 * request is POSTed to the platform (`POST /api/v1/ready-requests`), which
 * stores it against the business and emails the owner. This reuses the
 * template→platform route and bearer auth of analytics reporting
 * (ANALYTICS_INGEST_TOKEN).
 *
 * Unlike analytics, delivery is NOT fire-and-forget: a tool may report success
 * to the customer only when `deliverOwnerRequest` resolves `{ delivered: true }`.
 * Every other outcome (no endpoint, no token, timeout, network error, non-2xx)
 * is `{ delivered: false }` and the tool must return `ownerRequestFailureResult`.
 */

import { resolveAnalyticsEndpoint, resolveAnalyticsToken } from './analytics.js';

export type OwnerRequestKind = 'reservation' | 'order' | 'appointment' | 'quote' | 'consultation';

/** Path of the platform route that receives customer requests. */
export const OWNER_REQUESTS_PATH = '/api/v1/ready-requests';

/**
 * Per-request HTTP timeout when EZFORGE_REQUESTS_TIMEOUT_MS is unset. Basis:
 * Assumption, not measured — one DB insert plus one SMTP send on the platform
 * (the send is awaited so success means the owner was emailed); 8 s keeps the
 * agent's tool call bounded while leaving room for a slow SMTP handshake.
 */
export const DEFAULT_OWNER_REQUEST_TIMEOUT_MS = 8000;

/** Subset of ReadyConfig this module reads (structural, so tests need no full config). */
export interface OwnerRequestConfig {
  serverId: string;
  contact: { phone: string };
  analytics?: { reportingEndpoint?: string };
}

export type OwnerRequestOutcome = { delivered: true } | { delivered: false; reason: string };

/** Minimal MCP tool result shape shared by the templates. */
export interface OwnerRequestToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Resolves the platform requests endpoint: EZFORGE_REQUESTS_ENDPOINT when set,
 * otherwise the origin of the analytics endpoint (config or
 * EZFORGE_ANALYTICS_ENDPOINT) joined with OWNER_REQUESTS_PATH, so no new secret
 * has to be provisioned on customer machines. Undefined when neither exists.
 */
export function resolveOwnerRequestsEndpoint(config: OwnerRequestConfig): string | undefined {
  const explicit = process.env['EZFORGE_REQUESTS_ENDPOINT'];
  if (explicit) return explicit;
  const analytics = resolveAnalyticsEndpoint(config.analytics?.reportingEndpoint);
  if (!analytics) return undefined;
  try {
    return new URL(OWNER_REQUESTS_PATH, analytics).toString();
  } catch {
    return undefined;
  }
}

function resolveTimeoutMs(): number {
  const parsed = Number(process.env['EZFORGE_REQUESTS_TIMEOUT_MS']);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OWNER_REQUEST_TIMEOUT_MS;
}

/**
 * Sends one request to the platform. Never throws. Delivered only when the
 * platform answers 2xx, which it does after storing the request and emailing
 * the owner.
 */
export async function deliverOwnerRequest(
  config: OwnerRequestConfig,
  kind: OwnerRequestKind,
  fields: Record<string, unknown>,
): Promise<OwnerRequestOutcome> {
  const endpoint = resolveOwnerRequestsEndpoint(config);
  if (!endpoint) return { delivered: false, reason: 'no requests endpoint configured' };
  const token = resolveAnalyticsToken();
  if (!token) return { delivered: false, reason: 'no ingest token configured' };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        serverId: config.serverId,
        kind,
        timestamp: new Date().toISOString(),
        fields,
      }),
      signal: AbortSignal.timeout(resolveTimeoutMs()),
    });
    if (!response.ok) {
      console.error(`[owner-requests] HTTP ${response.status} delivering ${kind} request`);
      return { delivered: false, reason: `platform responded ${response.status}` };
    }
    return { delivered: true };
  } catch (err) {
    console.error(`[owner-requests] failed to deliver ${kind} request:`, err);
    return { delivered: false, reason: 'platform unreachable' };
  }
}

/**
 * The error result a tool returns when delivery failed: tells the agent the
 * request was NOT sent and gives the business phone number to call instead.
 */
export function ownerRequestFailureResult(config: OwnerRequestConfig): OwnerRequestToolResult {
  const phone = config.contact.phone;
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: `Could not send your request to the business; it was NOT submitted. Please call ${phone} instead.`,
        delivered: false,
        phone,
      }),
    }],
    isError: true,
  };
}
