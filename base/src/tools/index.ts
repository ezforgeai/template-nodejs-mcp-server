/**
 * Common MCP tools for the ezForge Ready base server.
 *
 * Registers these tools on the given MCP Server instance:
 *   - get_business_info  — business name, description, category
 *   - get_hours          — structured v3.0 hours of operation plus a summary
 *   - check_open_now     — open/closed now (optionally per role) with next open/close
 *   - get_last_order     — today's last-order times per role and window state
 *   - get_contact_info   — phone, email, website, address
 *   - list_facets        — offering groups with their categories (only when the config has facets)
 *   - list_events        — event occurrences with the current price tier (only when featureFlags.events)
 *   - get_event          — one event with all price tiers (only when featureFlags.events)
 *
 * All time logic lives in `../temporal.ts`; handlers only shape its results.
 */

import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';
import { normalizeHoursToV3 } from '../config-loader.js';
import type { HoursBlockV3, HoursInterval, ReadyConfig } from '../config-loader.js';
import type { AnalyticsReporter } from '../analytics.js';
import { OWNER_TEXT_TOOL_NOTE, labelOwnerText } from '../owner-text.js';
import { HOURS_TOOLS, handleHoursTool, isHoursToolName } from './hours.js';
import { facetToolsFor, handleFacetTool, isFacetToolName } from './facets.js';
import { eventToolsFor, handleEventsTool, isEventsToolName } from './events.js';

const TOOL_REQUIRED_SCOPE: Record<string, string> = {
  list_facets: 'mcp:read',
  list_areas: 'mcp:read',
  list_events: 'mcp:read',
  get_event: 'mcp:read',
  get_business_info: 'mcp:read',
  get_hours: 'mcp:read',
  check_open_now: 'mcp:read',
  get_last_order: 'mcp:read',
  get_contact_info: 'mcp:read',
};

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export { OWNER_TEXT_LABEL } from '../owner-text.js';

/** "17:30" → "5:30 PM". Presentation only — no date math. */
function formatClock(hhmm: string): string {
  const [h, m] = hhmm.split(':');
  const hour = Number(h);
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${hour % 12 === 0 ? 12 : hour % 12}:${m} ${suffix}`;
}

function formatInterval(interval: HoursInterval): string {
  const role = interval.role === 'service' ? '' : ` (${interval.role})`;
  const lastOrder = interval.lastOrder === undefined ? '' : `, last order ${formatClock(interval.lastOrder)}`;
  return `${formatClock(interval.open)}–${formatClock(interval.close)}${role}${lastOrder}`;
}

function formatIntervals(intervals: readonly HoursInterval[]): string {
  return intervals.length === 0 ? 'closed' : intervals.map(formatInterval).join('; ');
}

const WEEKDAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function summarizeHours(hours: HoursBlockV3): string {
  const parts: string[] = [];
  parts.push(hours.timezone ? `Times are in ${hours.timezone}.` : 'Timezone is not configured.');
  parts.push(
    'Regular hours: ' +
      WEEKDAY_ORDER.map((day) => `${capitalize(day)} ${formatIntervals(hours.regular[day])}`).join('; ') +
      '.',
  );
  if (hours.special.length > 0) {
    parts.push(
      'Special hours: ' +
        hours.special
          .map((entry) => {
            const label = entry.label ? ` (${entry.label})` : '';
            const annual = entry.recurringAnnually ? ', every year' : '';
            return `${entry.date}${label} ${formatIntervals(entry.intervals)}${annual}`;
          })
          .join('; ') +
        '.',
    );
  }
  if (hours.closures.length > 0) {
    parts.push(
      'Closures: ' +
        hours.closures
          .map((closure) => {
            const label = closure.label ? ` (${closure.label})` : '';
            const annual = closure.recurringAnnually ? ', every year' : '';
            return `${closure.startDate} to ${closure.endDate}${label}${annual}`;
          })
          .join('; ') +
        '.',
    );
  }
  return parts.join(' ');
}

// grantedScopes: scopes from the OAuth token for this session.
// null = scope enforcement not active (pre-auth or legacy callers).
// string[] = enforce; empty array denies all scope-guarded tools.
// clock: source of "now" for time-sensitive tools; injectable for tests.
export function registerTools(
  server: Server,
  config: ReadyConfig,
  reporter?: AnalyticsReporter,
  grantedScopes: string[] | null = null,
  clock: () => Date = () => new Date(),
): void {
  // v3.0 sources keep their full block (timezone, split intervals, special,
  // closures); a v2.0 source is normalised and carries no timezone.
  const hours: HoursBlockV3 = config.hoursV3 ?? normalizeHoursToV3(config.hours);

  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'get_business_info',
        description:
          `Returns general information about the business (name, description, category). ${OWNER_TEXT_TOOL_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'get_hours',
        // Vertical templates (restaurant/salon/retail/home-services/
        // professional-services) still override this tool with the v2.0
        // `config.hours` record; reconciling the vertical overrides is a separate
        // RT-1.F task (see issue #8562 finding 2), not part of RT-1.F.3.
        description:
          'Returns the business hours of operation as a structured block plus a human-readable summary: ' +
          '{ timezone, regular: { <weekday>: [{ open, close, role, lastOrder?, areaId? }] }, special: [...], closures: [...], summary }. ' +
          'An empty `regular[<weekday>]` array means closed that day. `timezone` is empty only for legacy configs that do not carry one.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      ...HOURS_TOOLS,
      ...facetToolsFor(config),
      ...eventToolsFor(config),
      {
        name: 'get_contact_info',
        description: 'Returns contact information for the business (phone, email, website, address).',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ],
  }));

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;

    const requiredScope = TOOL_REQUIRED_SCOPE[name];
    if (grantedScopes !== null && requiredScope !== undefined && !grantedScopes.includes(requiredScope)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `Insufficient scope: ${requiredScope} required`);
    }

    let result: ToolResult;

    if (name === 'get_business_info') {
      result = jsonResult(labelOwnerText(config.business));
    } else if (name === 'get_hours') {
      // v3.0-shaped regardless of source version (issue #8534): a v2.0 open
      // day is one `service` interval, `'closed'` is `[]`, and timezone is ''.
      result = jsonResult({ ...hours, summary: summarizeHours(hours) });
    } else if (isHoursToolName(name)) {
      result = handleHoursTool(name, args, hours, clock) as ToolResult;
    } else if (isFacetToolName(name) && facetToolsFor(config).some((tool) => tool.name === name)) {
      result = handleFacetTool(name, args, config) as ToolResult;
    } else if (isEventsToolName(name) && eventToolsFor(config).some((tool) => tool.name === name)) {
      result = handleEventsTool(name, args, config.events ?? [], hours.timezone, clock, config.areas ?? []) as ToolResult;
    } else if (name === 'get_contact_info') {
      result = {
        content: [{ type: 'text', text: JSON.stringify(config.contact) }],
      };
    } else {
      throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    // Fire-and-forget: report tool_called event — never blocks the response
    if (reporter && !result.isError) {
      reporter.report({
        type: 'tool_called',
        timestamp: new Date().toISOString(),
        businessId: config.serverId,
        data: { tool: name },
      }).catch((err) => console.error('[analytics] tool_called report failed:', err));
    }

    return result;
  });
}
