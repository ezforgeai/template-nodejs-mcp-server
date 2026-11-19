/**
 * WebMCP landing page for ezForge Ready MCP servers (spec §9.1).
 *
 * Serves a minimal HTML page at GET / that includes the WebMCP discovery
 * meta tag (`<meta name="mcp-server" content="...">`) so that AI web
 * crawlers (Claude, ChatGPT, Gemini) can auto-discover the MCP server URL
 * by crawling the business's internet-accessible landing page.
 *
 * The MCP server URL is determined (in priority order) from:
 *   1. EZFORGE_MCP_PUBLIC_URL environment variable (set by the platform at deploy time)
 *   2. The incoming request's Host header + protocol (fallback for local dev)
 *
 * Security: all user-supplied strings (business name, description) are HTML-escaped
 * before insertion into the response to prevent XSS.
 */

import type { Request, Response } from 'express';
import type { ReadyConfig } from './config-loader.js';

/** Escape characters that are unsafe in HTML text content and attribute values. */
function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Derive the public MCP server URL for the WebMCP meta tag.
 *
 * Preference: explicit EZFORGE_MCP_PUBLIC_URL env var (injected by the
 * platform at deploy time). Falls back to constructing the URL from the
 * incoming request so local development still works without configuration.
 */
function resolveMcpServerUrl(req: Request): string {
  const envUrl = process.env['EZFORGE_MCP_PUBLIC_URL'];
  if (envUrl) return envUrl.replace(/\/$/, '');
  // Derive from request — req.protocol is 'http' or 'https'.
  const host = req.get('host') ?? 'localhost';
  return `${req.protocol}://${host}`;
}

/**
 * Render the WebMCP landing page HTML for the given business config.
 * Exported separately so unit tests can assert the generated markup
 * without spinning up an HTTP server.
 */
export function renderLandingPage(mcpServerUrl: string, cfg: ReadyConfig): string {
  const name = escHtml(cfg.business.name);
  const description = escHtml(cfg.business.description);
  const category = escHtml(cfg.business.category);
  const city = escHtml(cfg.contact.address.city);
  const state = escHtml(cfg.contact.address.state);
  const urlEsc = escHtml(mcpServerUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="mcp-server" content="${urlEsc}">
  <title>${name} — AI Agent Access</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1   { font-size: 1.75rem; margin-bottom: 0.25rem; }
    .meta { color: #555; margin-bottom: 1.5rem; }
    .info { background: #f4f4f4; border-radius: 6px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
    code { background: #e8e8e8; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.875em; }
    a    { color: #2563eb; }
  </style>
</head>
<body>
  <h1>${name}</h1>
  <p class="meta">${category} · ${city}, ${state}</p>
  <p>${description}</p>

  <div class="info">
    <strong>AI-Agent Ready</strong><br>
    This business is connected via the
    <a href="https://modelcontextprotocol.io" rel="noopener">Model Context Protocol (MCP)</a>.
    AI assistants like Claude, ChatGPT, and Gemini can interact with this business
    programmatically — checking hours, browsing offerings, and more.
  </div>

  <p><strong>MCP Server URL:</strong> <code>${urlEsc}</code></p>
  <p>
    Powered by <a href="https://ezforge.ai/ready" rel="noopener">ezForge Ready</a>.
  </p>
</body>
</html>`;
}

/**
 * Express request handler for GET /.
 * Register with: app.get('/', createLandingPageHandler(() => config))
 *
 * Takes a config getter rather than the config value directly so the route
 * can be registered before initialize() runs in test environments.
 */
export function createLandingPageHandler(
  getConfig: () => ReadyConfig,
): (req: Request, res: Response) => void {
  return (req: Request, res: Response): void => {
    const mcpServerUrl = resolveMcpServerUrl(req);
    const html = renderLandingPage(mcpServerUrl, getConfig());
    res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(html);
  };
}
