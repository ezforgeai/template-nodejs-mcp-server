/**
 * Common MCP resources for the ezForge Ready base server.
 *
 * Registers two resources on the given MCP Server instance:
 *   - ready://business/profile  — business name, description, category
 *   - ready://business/hours    — hours of operation per day
 */

import { ProtocolError, ProtocolErrorCode, ResourceNotFoundError } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';
import type { ReadyConfig } from '../config-loader.js';

export const BUSINESS_PROFILE_URI = 'ready://business/profile';
export const BUSINESS_HOURS_URI = 'ready://business/hours';

// grantedScopes: null = no enforcement; string[] = enforce mcp:read for resource reads.
export function registerResources(
  server: Server,
  config: ReadyConfig,
  grantedScopes: string[] | null = null,
): void {
  server.setRequestHandler('resources/list', async () => ({
    resources: [
      {
        uri: BUSINESS_PROFILE_URI,
        name: 'Business Profile',
        description: 'Business name, description, and vertical category.',
        mimeType: 'application/json',
      },
      {
        uri: BUSINESS_HOURS_URI,
        name: 'Business Hours',
        description: 'Hours of operation for each day of the week.',
        mimeType: 'application/json',
      },
    ],
  }));

  server.setRequestHandler('resources/read', async (request) => {
    const { uri } = request.params;

    if (grantedScopes !== null && !grantedScopes.includes('mcp:read')) {
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Insufficient scope: mcp:read required');
    }

    if (uri === BUSINESS_PROFILE_URI) {
      return {
        contents: [
          {
            uri: BUSINESS_PROFILE_URI,
            mimeType: 'application/json',
            text: JSON.stringify(config.business),
          },
        ],
      };
    }

    if (uri === BUSINESS_HOURS_URI) {
      // Intentionally the raw v2.0-shaped `config.hours` record, NOT the
      // v3.0 HoursBlockV3 envelope that the `get_hours` tool (tools/index.ts)
      // returns via normalizeHoursToV3 — the two are known to diverge in
      // shape today (issue #8562 finding 2). Reconciling this resource (and
      // each vertical template's own `hours`/`get_hours` override) to v3.0
      // is RT-1.F (tool consumption), not this issue.
      return {
        contents: [
          {
            uri: BUSINESS_HOURS_URI,
            mimeType: 'application/json',
            text: JSON.stringify(config.hours),
          },
        ],
      };
    }

    throw new ResourceNotFoundError(uri, `Resource not found: ${uri}`);
  });
}
