/**
 * Process-wide JSON Schema validator shared by every per-request MCP Server.
 *
 * The MCP SDK's Server constructor otherwise builds a default
 * AjvJsonSchemaValidator when none is passed. The stateless `/mcp` handler
 * builds a Server per `/mcp` request, so a per-Server validator would not
 * share Ajv's compiled-schema cache across requests. (The v1 SDK built a new
 * Ajv instance plus ajv-formats on every construction — ~0.4ms of synchronous,
 * event-loop-blocking CPU each in local benchmarks, PERF-R04, measured under
 * the earlier per-SSE-connection model, where it produced the session-setup
 * latency tail. The v2 `AjvJsonSchemaValidator` builds its Ajv engines lazily,
 * on the first `getValidator()` call, so that construction cost is gone; the
 * cache-sharing rationale remains. Neither the ~0.4ms cost nor any speedup
 * figure has been re-measured on v2.)
 *
 * The validator only compiles and caches schemas on demand; it holds no
 * per-request state, so a single instance is safe to reuse across all requests.
 *
 * Cache-growth note (issue #4918, re-verified for the v2 package in issue
 * #13267 against the installed @modelcontextprotocol/server@2.4.0 `dist`,
 * which bundles ajv@8.18.0):
 * `AjvJsonSchemaValidator.getValidator(schema)` picks an engine for the
 * schema's declared `$schema` dialect (none or 2020-12 → `Ajv2020`; 2019-09 →
 * `Ajv2019`; draft-07/06 → classic `Ajv`; engines are created lazily, one
 * cache each), then calls `engine.getSchema(schema.$id) ?? engine.compile(schema)`
 * when `schema.$id` is a string, else unconditionally `engine.compile(schema)`.
 * Ajv's compile() path (`Ajv#_addSchema`) memoizes every schema object it is
 * ever given in a never-pruned `Map<schema object, CompiledSchema>`
 * (`this._cache`) keyed by object identity, not content — a distinct object
 * with identical content gets its own permanent entry, and nothing evicts an
 * old one automatically except an explicit `ajv.removeSchema()` call this
 * codebase never makes. A schema carrying a stable string `$id` sidesteps
 * this: after the first call, `getValidator()` resolves it via
 * `engine.getSchema($id)`, which looks up Ajv's separate `$id`-keyed registry
 * (a string key) instead of calling `compile()` again, so re-creating the
 * schema object per call is safe.
 *
 * This SDK's low-level `Server` — what every template here uses, see
 * src/index.ts — routes only one thing through the configured validator:
 * `elicitInput()` in form mode, which validates the client's response against
 * `requestedSchema`. Tool `inputSchema`/`outputSchema` validation in the
 * higher-level `McpServer` wrapper (unused by any template) goes through the
 * standard-schema path (`validateStandardSchema`), not this validator, unless a
 * caller wraps a raw JSON Schema with `fromJsonSchema(schema, validator)`.
 * `elicitInput()` is currently inert — no template calls it (a repo-wide grep
 * for `elicitInput` across every template's `src` directory returns nothing)
 * — but if one starts doing so with an inline, `$id`-less schema object
 * literal re-created per call, this shared instance's Ajv cache would grow by
 * one permanent entry per call for the process lifetime. Give any such schema
 * a stable `$id`, or hoist it to a module-level constant, before adding
 * `elicitInput()` calls.
 */
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

export const sharedSchemaValidator = new AjvJsonSchemaValidator();
