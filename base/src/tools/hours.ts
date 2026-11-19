/**
 * Shared open-now / last-order tools for ezForge Ready templates.
 *
 * Both the base server and vertical templates (restaurant) expose
 * `check_open_now` and `get_last_order`; they share this one implementation so
 * the answers cannot drift. All time logic lives in `../temporal.ts`.
 */

import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { HoursBlockV3, HoursRole } from '../config-loader.js';
import {
  InvalidTimeZoneError,
  resolveOpenStatus,
  resolveTodayWindows,
  type IntervalEvalInput,
  type LocalMoment,
} from '../temporal.js';

export type HoursToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

export const HOURS_ROLES: readonly HoursRole[] = ['service', 'kitchen', 'bar'];

export const HOURS_TOOL_NAMES = ['check_open_now', 'get_last_order'] as const;
export type HoursToolName = (typeof HOURS_TOOL_NAMES)[number];

export function isHoursToolName(name: string): name is HoursToolName {
  return (HOURS_TOOL_NAMES as readonly string[]).includes(name);
}

export const HOURS_TOOLS = [
  {
    name: 'check_open_now',
    description:
      'Tells whether the business is open right now, evaluated in the business timezone and honouring closures, special hours and split intervals. ' +
      'Returns { open, role?, currentInterval, nextOpen, nextClose }: `currentInterval` is the open interval or null; ' +
      '`nextClose` is when it ends (null when closed); `nextOpen` is the next opening after now (null if none). ' +
      'Optionally pass `role` (e.g. "kitchen") to ask about that service only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        role: {
          type: 'string',
          enum: [...HOURS_ROLES],
          description: 'Service to check; defaults to the business as a whole ("service").',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_last_order',
    description:
      "Returns today's windows with their last-order times and whether each window is open right now, in the business timezone: " +
      '{ date, timezone, windows: [{ role, open, close, lastOrder, windowOpen }] }; `lastOrder` is null when the config has none. ' +
      'An empty `windows` array means closed all day. Optionally pass `role`; omit for all roles.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        role: {
          type: 'string',
          enum: [...HOURS_ROLES],
          description: 'Restrict to one role; omit for all roles.',
        },
      },
      required: [],
    },
  },
];

function jsonResult(value: unknown): HoursToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(message: string): HoursToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function parseRoleArg(args: Record<string, unknown> | undefined): HoursRole | undefined {
  const role = args?.['role'];
  if (role === undefined) return undefined;
  if (typeof role === 'string' && (HOURS_ROLES as readonly string[]).includes(role)) {
    return role as HoursRole;
  }
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid role: expected one of ${HOURS_ROLES.join(', ')}`);
}

function momentOrNull(moment: LocalMoment | undefined): LocalMoment | null {
  return moment ?? null;
}

export function handleHoursTool(
  name: HoursToolName,
  args: Record<string, unknown> | undefined,
  hours: HoursBlockV3,
  clock: () => Date,
): HoursToolResult {
  const role = parseRoleArg(args);

  // Time-sensitive answers need a real IANA zone; never guess UTC or the host
  // zone, because "open now" would then be silently wrong for the business.
  if (hours.timezone === '') {
    return errorResult(
      'This business has no timezone configured (hours config is v2.0), so open-now and last-order cannot be evaluated. Use get_hours for the listed hours.',
    );
  }

  const evalInput: IntervalEvalInput = {
    now: clock(),
    timezone: hours.timezone,
    regular: hours.regular,
    special: hours.special,
    closures: hours.closures,
  };

  try {
    if (name === 'check_open_now') {
      const status = resolveOpenStatus(evalInput, role);
      return jsonResult({
        open: status.open,
        ...(role === undefined ? {} : { role }),
        currentInterval: status.matchedInterval ?? null,
        nextOpen: momentOrNull(status.nextOpen),
        nextClose: momentOrNull(status.nextClose),
      });
    }
    const today = resolveTodayWindows(evalInput, role);
    return jsonResult({
      date: today.localDate,
      timezone: hours.timezone,
      windows: today.windows.map((w) => ({
        role: w.interval.role,
        open: w.interval.open,
        close: w.interval.close,
        lastOrder: w.lastOrder ?? null,
        windowOpen: w.windowOpen,
      })),
    });
  } catch (err) {
    if (err instanceof InvalidTimeZoneError) {
      return errorResult(`The configured business timezone is invalid: ${hours.timezone}`);
    }
    throw err;
  }
}
