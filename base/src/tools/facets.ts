/**
 * Shared offering-group (facet) tools for ezForge Ready templates.
 *
 * `list_facets` answers "what does this place offer?" (kitchen, taproom, live
 * music): the business facets in `sortOrder`, each with its categories, plus an
 * `ungrouped` list of categories that belong to no facet. The base server and
 * vertical templates (restaurant) share this one implementation.
 *
 * Tools are listed through {@link facetToolsFor}, which gates on the config, so
 * a business with no facets lists exactly the tools it did before facets
 * existed. Later tools in this module join `facetToolsFor` and need no edits to
 * the template `tools/index.ts` files.
 */

import type { CatalogCategory, FacetV3, ReadyConfig } from '../config-loader.js';
import { OWNER_TEXT_LABEL, OWNER_TEXT_TOOL_NOTE } from '../owner-text.js';

export type FacetToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

export const FACET_TOOL_NAMES = ['list_facets'] as const;
export type FacetToolName = (typeof FACET_TOOL_NAMES)[number];

export function isFacetToolName(name: string): name is FacetToolName {
  return (FACET_TOOL_NAMES as readonly string[]).includes(name);
}

export const FACET_TOOLS = [
  {
    name: 'list_facets',
    description:
      'Lists what the business offers, grouped into offering groups (e.g. "Kitchen", "Taproom", "Live music"). ' +
      'Returns { facets: [{ id, name, description?, categories: [{ id, name }] }], ungrouped: [{ id, name }] } ' +
      'with facets and categories in display order; `ungrouped` holds categories that belong to no offering group. ' +
      OWNER_TEXT_TOOL_NOTE,
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

type FacetToolDefinition = (typeof FACET_TOOLS)[number];

/**
 * Tool definitions to list for this config. `list_facets` is offered only when
 * the config carries at least one facet; an empty or absent `facets` adds none.
 */
export function facetToolsFor(config: Pick<ReadyConfig, 'facets'>): FacetToolDefinition[] {
  return (config.facets?.length ?? 0) > 0 ? [...FACET_TOOLS] : [];
}

function jsonResult(value: unknown): FacetToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function bySortOrder<T extends { id: string; sortOrder: number }>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function categoryRef(category: CatalogCategory): { id: string; name: string } {
  return { id: category.id, name: category.name };
}

/**
 * Handles a facet tool call. Sorting is repeated here (not trusted from the
 * assembler) so the order contract holds for any config source. A facet's
 * owner-written `description` carries {@link OWNER_TEXT_LABEL} (issue #14202), and
 * an empty one is omitted, as for `get_business_info`. A category whose
 * `facetId` names no listed facet is reported as ungrouped rather than dropped.
 */
export function handleFacetTool(
  name: FacetToolName,
  _args: Record<string, unknown> | undefined,
  config: Pick<ReadyConfig, 'facets' | 'catalog'>,
): FacetToolResult {
  switch (name) {
    case 'list_facets': {
      const facets: FacetV3[] = [...(config.facets ?? [])].sort(bySortOrder);
      const categories = [...(config.catalog?.categories ?? [])].sort(bySortOrder);
      const facetIds = new Set(facets.map((facet) => facet.id));

      return jsonResult({
        facets: facets.map((facet) => ({
          id: facet.id,
          name: facet.name,
          ...(facet.description ? { description: `${OWNER_TEXT_LABEL}${facet.description}` } : {}),
          categories: categories.filter((c) => c.facetId === facet.id).map(categoryRef),
        })),
        ungrouped: categories
          .filter((c) => c.facetId === undefined || !facetIds.has(c.facetId))
          .map(categoryRef),
      });
    }
  }
}
