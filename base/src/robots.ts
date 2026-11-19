/**
 * robots.txt for ezForge Ready MCP servers (spec §9.1).
 *
 * Ready subdomains (`*.ready.ezforge.ai`) serve the WebMCP landing page
 * (see `webmcp-landing.ts`), whose sole purpose is discovery by AI agents
 * and their web crawlers. No robots.txt existed for this route — an absent
 * robots.txt defaults to "crawling permitted," so nothing was previously
 * blocked, but there was also no explicit allow. This route makes that
 * permission explicit for the named AI crawlers a Ready server most needs
 * to be found by, alongside a wildcard allow for everything else.
 */

import type { Request, Response } from 'express';

const ROBOTS_TXT = `User-agent: ClaudeBot
Allow: /

User-agent: GPTBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: *
Allow: /
`;

/** Render the robots.txt body. Exported so unit tests can assert on it directly. */
export function renderRobotsTxt(): string {
  return ROBOTS_TXT;
}

/** Express request handler for GET /robots.txt. */
export function robotsHandler(_req: Request, res: Response): void {
  res.status(200).set('Content-Type', 'text/plain; charset=utf-8').send(renderRobotsTxt());
}
