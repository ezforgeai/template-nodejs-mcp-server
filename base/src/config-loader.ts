/**
 * Config loader for the ezForge Ready base MCP server.
 *
 * Reads and validates the ReadyConfig at startup: the gzip file the control plane
 * writes via Fly `config.files` (issue #10063) first, otherwise the
 * EZFORGE_READY_CONFIG environment variable (older machines, small configs).
 * The config must be a JSON-encoded ReadyConfig object, either the v2.0 or
 * the v3.0 schema (issue #8534 — RT-0.4c template loader back-compat shim).
 * A v3.0 blob's richer `hours` shape is down-converted to the v2.0-compatible
 * `BusinessHours` record so existing (v2-only) consumers keep working
 * unchanged; consuming the v3.0-only fields directly is RT-1.F, not this shim.
 *
 * Vertical templates extend this base and may add additional fields to their
 * own config schemas, but must always include the base fields defined here.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolveMenuSectionItem, type AvailabilityWindow, type MenuSourceV3 } from './temporal.js';

export interface DayHours {
  /** Opening time in HH:MM format, e.g. "09:00" */
  open: string;
  /** Closing time in HH:MM format, e.g. "17:00" */
  close: string;
  /** If true, the business is closed on this day (v1.0 compat — prefer the "closed" string form) */
  closed?: boolean;
}

/** A single hours entry: an open/close time pair or the literal string "closed". */
export type HoursEntry = DayHours | 'closed';

/**
 * Operating hours, keyed by day-of-week name (e.g. "monday"), "YYYY-MM-DD"
 * for a one-off special-hours override, or "MM-DD" (year-independent) for a
 * recurring annual special-hours entry (e.g. an annual holiday closure).
 * See the `HOURS_PRECEDENCE_RULE` constant in
 * packages/template-engine/src/config-schema.ts (ReadyConfig.hours) for the
 * precedence rule when both key forms match the same date.
 */
export type BusinessHours = Record<string, HoursEntry>;

/** Industry vertical — determines MCP tool set and catalog schema. */
export type TemplateType =
  | 'restaurant'
  | 'salon'
  | 'home_services'
  | 'retail'
  | 'professional_services'
  | 'custom';

/** Physical address (v2.0 — country is required). */
export interface AddressBlock {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

/** Contact information block (v2.0 — phone, email, and address are required). */
export interface ContactBlock {
  phone: string;
  email: string;
  website?: string;
  address: AddressBlock;
  coordinates?: { lat: number; lng: number };
}

/** Business identity block. */
export interface BusinessBlock {
  /** Publicly visible business name. */
  name: string;
  /** Short description of the business shown to end users. */
  description: string;
  /** Primary vertical category (e.g., "restaurant", "hair_salon"). */
  category: string;
}

/** Analytics configuration (v2.0 — enabled flag is required). */
export interface AnalyticsBlock {
  enabled: boolean;
  /** URL of the platform analytics API endpoint. */
  reportingEndpoint?: string;
}

/** Feature toggles (from `business_capabilities`). */
export interface FeatureFlags {
  appointmentBooking: boolean;
  onlineOrdering: boolean;
  quoteRequests: boolean;
  faq: boolean;
  menuBrowsing: boolean;
}

/** A single catalog category. */
export interface CatalogCategory {
  id: string;
  name: string;
  sortOrder: number;
  /** Offering group this category belongs to (v3.0 facets, Ready Phase 4.1); absent ⇒ ungrouped. */
  facetId?: string;
}

/** An offering group above categories, e.g. Kitchen / Taproom (v3.0, Ready Phase 4.1). */
export interface FacetV3 {
  id: string;
  name: string;
  description?: string;
  sortOrder: number;
}

/** A single catalog item — menu item, service, or product. */
export interface CatalogItem {
  id: string;
  name: string;
  description?: string;
  categoryId: string;
  priceCents?: number;
  /** "fixed", "starting_at", "free", "quote", etc. */
  priceType: string;
  isAvailable: boolean;
  /** Vertical-specific attributes. */
  metadata: Record<string, unknown>;
  /** Business-wide alternate names for agent matching (v3.0, spec §6.4). */
  aliases?: string[];
  /** Windows restricting when the item is available; absent ⇒ always (v3.0, spec §5.4). */
  availabilityWindows?: AvailabilityWindow[];
}

/** Catalog block. */
export interface CatalogBlock {
  categories: CatalogCategory[];
  items: CatalogItem[];
}

/** External integration credentials. Values are sensitive — never log. */
export interface IntegrationsBlock {
  calendar?: { provider: string; apiKey: string };
  crm?: { provider: string; apiKey: string };
  webhook?: { url: string; secret: string };
}

/** Loaded config shape (from a v2.0 or down-converted v3.0 blob) injected into Ready MCP machines as EZFORGE_READY_CONFIG. */
export interface ReadyConfig {
  /**
   * Schema version of the blob that was actually loaded — "2.0" or "3.0".
   * `hours` is always the v2.0-compatible `BusinessHours` shape regardless of
   * this value; a "3.0" source has had its `hours` down-converted (#8534).
   */
  version: '2.0' | '3.0';
  /** Platform server ID for traceability. */
  serverId: string;
  /** Industry vertical driving the MCP tool set. */
  templateType: TemplateType;
  /** Business identity. */
  business: BusinessBlock;
  /** Operating hours keyed by day-of-week (e.g., "monday") or date. */
  hours: BusinessHours;
  /**
   * The validated v3.0 hours block as loaded (timezone, split intervals,
   * special, closures). Present only when the source blob is v3.0; v2.0 blobs
   * carry no timezone, so consumers fall back to `normalizeHoursToV3(hours)`.
   */
  hoursV3?: HoursBlockV3;
  /** Contact information. */
  contact: ContactBlock;
  /** Feature toggles. */
  featureFlags: FeatureFlags;
  /** Catalog of items (optional — may be empty at initial deploy time). */
  catalog?: CatalogBlock;
  /** Active offering groups in `sortOrder` (v3.0); absent when the business has none. */
  facets?: FacetV3[];
  /**
   * Schedule-gated menus (v3.0, spec §5.5/§7). Absent on v2.0 blobs and menu-less v3.0 blobs.
   * Section items carry `itemId` plus override-only fields; resolve them against
   * `catalog.items[]` with `resolveMenus` (temporal.ts) before reading name/price.
   */
  menus?: MenuSourceV3[];
  /** External integrations (optional). */
  integrations?: IntegrationsBlock;
  /** Analytics configuration (optional). */
  analytics?: AnalyticsBlock;
}

// ─── Legacy type aliases ──────────────────────────────────────────────────────
// Callers that import the old v1.0 names continue to compile unchanged.
/** @deprecated Use AddressBlock */
export type BusinessAddress = AddressBlock;
/** @deprecated Use ContactBlock */
export type ContactInfo = ContactBlock;
/** @deprecated Use BusinessBlock */
export type BusinessInfo = BusinessBlock;
/** @deprecated Use AnalyticsBlock */
export type AnalyticsConfig = AnalyticsBlock;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ─── v3.0 types (mirrored locally — spec §7, issue #8534) ─────────────────────
// The template keeps its own copy of the config types rather than importing
// @ezforge/template-engine. This mirrors the v3.0 additive shape defined in
// packages/template-engine/src/config-schema.ts (issue #8532). Only `hours`
// is used by this shim today; the rest exist so a v3.0 blob's `hours` field
// can be validated in place. `menus` is validated and passed through for the
// restaurant menu tools (RT-1.F.4); consuming `aliases`/`availabilityWindows`/
// `special`/`closures` elsewhere is RT-1.F.

/** Day of week, used to key the v3.0 `hours.regular` block. */
export type Weekday =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday';

const WEEKDAYS: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

/** Which service the hours interval applies to (spec §7). */
export type HoursRole = 'service' | 'kitchen' | 'bar';

/** A single open/close interval for one {@link HoursRole}. */
export interface HoursInterval {
  open: string;
  close: string;
  role: HoursRole;
  lastOrder?: string;
}

/** A one-off or recurring-annual special-hours entry (holidays, etc.). */
export interface HoursSpecialEntry {
  /** "YYYY-MM-DD", or "MM-DD" when `recurringAnnually` is true. */
  date: string;
  label?: string;
  recurringAnnually?: boolean;
  /** Empty array means closed on this date. */
  intervals: HoursInterval[];
}

/** A multi-day closure (e.g. a seasonal shutdown), one-off or recurring-annual. */
export interface HoursClosure {
  startDate: string;
  endDate: string;
  label?: string;
  recurringAnnually?: boolean;
}

/** v3.0 operating hours block — structured, multi-interval, timezone-aware. */
export interface HoursBlockV3 {
  /** IANA timezone, e.g. "America/Detroit". */
  timezone: string;
  /** Regular weekly schedule; an empty array for a day means closed that day. */
  regular: Record<Weekday, HoursInterval[]>;
  special: HoursSpecialEntry[];
  closures: HoursClosure[];
}

function isWeekday(v: string): v is Weekday {
  return (WEEKDAYS as readonly string[]).includes(v);
}

function isHoursRole(v: unknown): v is HoursRole {
  return v === 'service' || v === 'kitchen' || v === 'bar';
}

function isHoursInterval(v: unknown): v is HoursInterval {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj['open'] !== 'string') return false;
  if (typeof obj['close'] !== 'string') return false;
  if (!isHoursRole(obj['role'])) return false;
  if ('lastOrder' in obj && typeof obj['lastOrder'] !== 'string') return false;
  return true;
}

function isHoursIntervalArray(v: unknown): v is HoursInterval[] {
  return Array.isArray(v) && v.every(isHoursInterval);
}

function isHoursSpecialEntry(v: unknown): v is HoursSpecialEntry {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj['date'] !== 'string') return false;
  if ('label' in obj && typeof obj['label'] !== 'string') return false;
  if ('recurringAnnually' in obj && typeof obj['recurringAnnually'] !== 'boolean') return false;
  return isHoursIntervalArray(obj['intervals']);
}

function isHoursClosure(v: unknown): v is HoursClosure {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj['startDate'] !== 'string') return false;
  if (typeof obj['endDate'] !== 'string') return false;
  if ('label' in obj && typeof obj['label'] !== 'string') return false;
  if ('recurringAnnually' in obj && typeof obj['recurringAnnually'] !== 'boolean') return false;
  return true;
}

function isHoursBlockV3(v: unknown): v is HoursBlockV3 {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj['timezone'] !== 'string') return false;

  const regular = obj['regular'];
  if (typeof regular !== 'object' || regular === null) return false;
  const regularObj = regular as Record<string, unknown>;
  for (const day of WEEKDAYS) {
    if (!isHoursIntervalArray(regularObj[day])) return false;
  }

  if (!Array.isArray(obj['special']) || !obj['special'].every(isHoursSpecialEntry)) return false;
  if (!Array.isArray(obj['closures']) || !obj['closures'].every(isHoursClosure)) return false;
  return true;
}

/**
 * Converts a single v2.0 `HoursEntry` into the v3.0-shaped interval list: an
 * open day becomes a single `service` interval, and `'closed'` (or the legacy
 * `{ closed: true }` form) becomes `[]`.
 */
function hoursEntryToIntervals(entry: HoursEntry): HoursInterval[] {
  if (entry === 'closed') return [];
  if (entry.closed) return [];
  return [{ open: entry.open, close: entry.close, role: 'service' }];
}

/**
 * Normalises hours (from either a v2.0 or an already-down-converted v3.0
 * source) into the v3.0-shaped internal structure (issue #8534 Task 1): each
 * open day becomes a single `service` interval, and `'closed'` becomes `[]`.
 * Non-weekday keys ("YYYY-MM-DD" / "MM-DD" special-hours overrides) become
 * `special` entries. v2.0 carries no timezone — `timezone` is left `''`
 * rather than inventing a default; nothing in this template reads it today.
 *
 * A weekday key **absent** from the v2.0 `hours` record is treated
 * identically to one explicitly set to `'closed'`: `regular[day]` is
 * initialized to `[]` for every {@link WEEKDAYS} entry before the input is
 * scanned, so "not mentioned" and "explicitly closed" both normalize to
 * "closed" (`[]`). There is no v3.0 representation for "unspecified".
 * This is intentional, not accidental (issue #8562 finding 1): the v2.0
 * contract never distinguished "absent" from "closed" either — every
 * existing v2.0-only reader (e.g. `check_availability` in the vertical
 * templates) already treats a missing weekday key as not-open by checking
 * for `undefined` before treating the entry as open, so no consumer relied
 * on "absent" carrying a meaning distinct from "closed".
 */
export function normalizeHoursToV3(hours: BusinessHours): HoursBlockV3 {
  const regular = {} as Record<Weekday, HoursInterval[]>;
  for (const day of WEEKDAYS) regular[day] = [];
  const special: HoursSpecialEntry[] = [];

  for (const [key, entry] of Object.entries(hours)) {
    const intervals = hoursEntryToIntervals(entry);
    if (isWeekday(key)) {
      regular[key] = intervals;
    } else {
      special.push(
        /^\d{2}-\d{2}$/.test(key)
          ? { date: key, recurringAnnually: true, intervals }
          : { date: key, intervals }
      );
    }
  }

  return { timezone: '', regular, special, closures: [] };
}

/** The first `service`-role interval, or the first interval of any role. */
function firstServiceEntry(intervals: HoursInterval[]): HoursEntry {
  const interval = intervals.find((i) => i.role === 'service') ?? intervals[0];
  if (!interval) return 'closed';
  return { open: interval.open, close: interval.close };
}

/**
 * Down-converts a v3.0 `HoursBlockV3` into a v2.0-compatible `BusinessHours`
 * record so existing (v2.0-only) consumers keep working unchanged when the
 * loaded config happens to be a v3.0 blob (issue #8534). Only the first
 * `service`-role interval (or, if none, the first interval of any role) per
 * day (and per `special` date) survives — extra intervals/roles, `closures`,
 * and `timezone` are dropped; tools that need them read `ReadyConfig.hoursV3`.
 */
export function denormalizeHoursV3ToV2(hoursV3: HoursBlockV3): BusinessHours {
  const result: Record<string, HoursEntry> = {};
  for (const day of WEEKDAYS) {
    result[day] = firstServiceEntry(hoursV3.regular[day]);
  }
  for (const entry of hoursV3.special) {
    result[entry.date] = firstServiceEntry(entry.intervals);
  }
  return result;
}

const VALID_TEMPLATE_TYPES: readonly TemplateType[] = [
  'restaurant',
  'salon',
  'home_services',
  'retail',
  'professional_services',
  'custom',
];

function isDayHours(v: unknown): v is DayHours {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj['open'] !== 'string') return false;
  if (typeof obj['close'] !== 'string') return false;
  if ('closed' in obj && typeof obj['closed'] !== 'boolean') return false;
  return true;
}

function isHoursEntry(v: unknown): v is HoursEntry {
  if (v === 'closed') return true;
  return isDayHours(v);
}

function isBusinessHours(v: unknown): v is BusinessHours {
  if (typeof v !== 'object' || v === null) return false;
  for (const entry of Object.values(v as Record<string, unknown>)) {
    if (!isHoursEntry(entry)) return false;
  }
  return true;
}

function isAddressBlock(v: unknown): v is AddressBlock {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj['line1'] === 'string' &&
    typeof obj['city'] === 'string' &&
    typeof obj['state'] === 'string' &&
    typeof obj['zip'] === 'string' &&
    typeof obj['country'] === 'string'
  );
}

function isContactBlock(v: unknown): v is ContactBlock {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj['phone'] === 'string' &&
    typeof obj['email'] === 'string' &&
    isAddressBlock(obj['address'])
  );
}

function isBusinessBlock(v: unknown): v is BusinessBlock {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj['name'] === 'string' &&
    typeof obj['description'] === 'string' &&
    typeof obj['category'] === 'string'
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFacetV3(v: unknown): v is FacetV3 {
  return (
    isRecord(v) &&
    typeof v['id'] === 'string' &&
    v['id'].length > 0 &&
    typeof v['name'] === 'string' &&
    typeof v['sortOrder'] === 'number' &&
    (v['description'] === undefined || typeof v['description'] === 'string')
  );
}

function isMenuSchedule(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (typeof v['start'] !== 'string' || typeof v['end'] !== 'string') return false;
  return v['dayOfWeek'] === undefined || (Number.isInteger(v['dayOfWeek']) && (v['dayOfWeek'] as number) >= 0 && (v['dayOfWeek'] as number) <= 6);
}

function isMenuSectionItem(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return (
    typeof v['itemId'] === 'string' &&
    (v['name'] === undefined || typeof v['name'] === 'string') &&
    (v['priceType'] === undefined || typeof v['priceType'] === 'string') &&
    typeof v['sortOrder'] === 'number' &&
    (v['description'] === undefined || typeof v['description'] === 'string') &&
    (v['priceCents'] === undefined || typeof v['priceCents'] === 'number')
  );
}

function isMenuSection(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return (
    typeof v['id'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['sortOrder'] === 'number' &&
    Array.isArray(v['items']) &&
    v['items'].every(isMenuSectionItem)
  );
}

function isMenuV3(v: unknown): v is MenuSourceV3 {
  if (!isRecord(v)) return false;
  return (
    typeof v['id'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['sortOrder'] === 'number' &&
    typeof v['isDefault'] === 'boolean' &&
    Array.isArray(v['schedule']) &&
    v['schedule'].every(isMenuSchedule) &&
    Array.isArray(v['sections']) &&
    v['sections'].every(isMenuSection)
  );
}

function isFeatureFlags(v: unknown): v is FeatureFlags {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj['appointmentBooking'] === 'boolean' &&
    typeof obj['onlineOrdering'] === 'boolean' &&
    typeof obj['quoteRequests'] === 'boolean' &&
    typeof obj['faq'] === 'boolean' &&
    typeof obj['menuBrowsing'] === 'boolean'
  );
}

/**
 * Guest path of the gzip-compressed config the control plane writes through Fly
 * Machines `config.files` (issue #10063). Must equal `READY_CONFIG_FILE_PATH` in
 * `packages/template-engine/src/injection.ts`; this template package does not
 * import that one.
 */
export const READY_CONFIG_FILE_PATH = '/etc/ezforge/ready-config.json.gz';

/**
 * Output cap (bytes) for gunzipping the config file, so a small gzip bomb cannot
 * exhaust server memory at startup. Must equal `READY_CONFIG_MAX_PLAINTEXT_BYTES`
 * in `packages/template-engine/src/injection.ts` (basis stated there: 4 MiB, 1.53x
 * the largest realistic measured config); the control plane refuses to deliver more.
 */
export const READY_CONFIG_MAX_PLAINTEXT_BYTES = 4_194_304;

/**
 * Returns the raw config JSON: the gunzipped file at `filePath` when it exists,
 * otherwise the inline EZFORGE_READY_CONFIG env var.
 *
 * The file wins whenever it is present, and a present-but-unreadable or corrupt
 * file is a ConfigError rather than a silent fall back to the env var: the control
 * plane drops the env var for configs too large for it, and keeps a copy only when
 * the config fits, so an env value found next to a broken file could be stale.
 * Only an absent file (ENOENT) selects the env var — that is every server on an
 * older machine config, and every config small enough for the env fallback that
 * has not been rewritten since.
 */
function readRawConfig(filePath: string): string {
  let compressed: Buffer | undefined;
  try {
    compressed = readFileSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError(`EZFORGE_READY_CONFIG file ${filePath} could not be read`);
    }
  }
  if (compressed !== undefined) {
    try {
      return gunzipSync(compressed, { maxOutputLength: READY_CONFIG_MAX_PLAINTEXT_BYTES }).toString('utf8');
    } catch (err) {
      // zlib throws ERR_BUFFER_TOO_LARGE when the output would pass maxOutputLength.
      if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ConfigError(
          `EZFORGE_READY_CONFIG file ${filePath} exceeds ${String(READY_CONFIG_MAX_PLAINTEXT_BYTES)} bytes uncompressed`,
        );
      }
      throw new ConfigError(`EZFORGE_READY_CONFIG file ${filePath} is not valid gzip`);
    }
  }

  const raw = process.env['EZFORGE_READY_CONFIG'];
  if (!raw) {
    throw new ConfigError('EZFORGE_READY_CONFIG environment variable is not set');
  }
  return raw;
}

/**
 * Reads and validates the ReadyConfig: the gzip file written via Fly
 * `config.files` first, falling back to the EZFORGE_READY_CONFIG environment
 * variable (see {@link readRawConfig}).
 *
 * Accepts both the v2.0 and v3.0 schemas (issue #8534). A v3.0 blob's `hours`
 * is validated against the v3.0 shape and then down-converted to the
 * v2.0-compatible `BusinessHours` record on the returned config — see
 * {@link denormalizeHoursV3ToV2}.
 *
 * @throws {ConfigError} if the env var is missing, not valid JSON, or does
 *   not conform to the ReadyConfig v2.0 or v3.0 schema.
 */
export function loadConfig(filePath: string = READY_CONFIG_FILE_PATH): ReadyConfig {
  const raw = readRawConfig(filePath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('EZFORGE_READY_CONFIG is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConfigError('EZFORGE_READY_CONFIG must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  const version = obj['version'];
  if (version !== '2.0' && version !== '3.0') {
    throw new ConfigError('EZFORGE_READY_CONFIG.version must be "2.0" or "3.0"');
  }

  if (typeof obj['serverId'] !== 'string' || obj['serverId'].length === 0) {
    throw new ConfigError('EZFORGE_READY_CONFIG.serverId must be a non-empty string');
  }

  if (!VALID_TEMPLATE_TYPES.includes(obj['templateType'] as TemplateType)) {
    throw new ConfigError(
      `EZFORGE_READY_CONFIG.templateType must be one of: ${VALID_TEMPLATE_TYPES.join(', ')}`,
    );
  }

  if (!isBusinessBlock(obj['business'])) {
    throw new ConfigError(
      'EZFORGE_READY_CONFIG.business must have name, description, and category (all strings)',
    );
  }

  let hours: BusinessHours;
  let hoursV3: HoursBlockV3 | undefined;
  if (version === '2.0') {
    if (!('hours' in obj) || !isBusinessHours(obj['hours'])) {
      throw new ConfigError('EZFORGE_READY_CONFIG.hours must be a valid hours object');
    }
    hours = obj['hours'] as BusinessHours;
  } else {
    if (!('hours' in obj) || !isHoursBlockV3(obj['hours'])) {
      throw new ConfigError(
        'EZFORGE_READY_CONFIG.hours must be a valid v3.0 hours object (timezone, regular, special, closures)',
      );
    }
    hoursV3 = obj['hours'] as HoursBlockV3;
    hours = denormalizeHoursV3ToV2(hoursV3);
  }

  if (!('contact' in obj) || !isContactBlock(obj['contact'])) {
    throw new ConfigError(
      'EZFORGE_READY_CONFIG.contact must have phone, email, and address (with line1, city, state, zip, country)',
    );
  }

  if (!isFeatureFlags(obj['featureFlags'])) {
    throw new ConfigError(
      'EZFORGE_READY_CONFIG.featureFlags must have appointmentBooking, onlineOrdering, quoteRequests, faq, and menuBrowsing (all booleans)',
    );
  }

  let facets: FacetV3[] | undefined;
  if (obj['facets'] !== undefined) {
    if (!Array.isArray(obj['facets']) || !obj['facets'].every(isFacetV3)) {
      throw new ConfigError(
        'EZFORGE_READY_CONFIG.facets must be an array of facets (id, name, sortOrder, optional description)',
      );
    }
    facets = obj['facets'] as FacetV3[];
  }

  let menus: MenuSourceV3[] | undefined;
  if (obj['menus'] !== undefined) {
    if (!Array.isArray(obj['menus']) || !obj['menus'].every(isMenuV3)) {
      throw new ConfigError(
        'EZFORGE_READY_CONFIG.menus must be an array of menus (id, name, sortOrder, isDefault, schedule, sections)',
      );
    }
    menus = obj['menus'] as MenuSourceV3[];

    // Every section item must resolve: inline name+priceType, or an itemId present in catalog.items.
    const catalogItems = (isRecord(obj['catalog']) && Array.isArray(obj['catalog']['items'])
      ? obj['catalog']['items']
      : []) as unknown[];
    const library = new Map(
      catalogItems.filter(isRecord).map((item) => [item['id'], item as unknown as CatalogItem]),
    );
    for (const menu of menus) {
      for (const section of menu.sections) {
        for (const item of section.items) {
          if (resolveMenuSectionItem(item, library.get(item.itemId)) === undefined) {
            throw new ConfigError(
              `EZFORGE_READY_CONFIG.menus["${menu.id}"].sections["${section.id}"] item "${item.itemId}" is not in catalog.items and has no inline name/priceType`,
            );
          }
        }
      }
    }
  }

  return {
    version,
    serverId: obj['serverId'] as string,
    templateType: obj['templateType'] as TemplateType,
    business: obj['business'] as BusinessBlock,
    hours,
    ...(hoursV3 ? { hoursV3 } : {}),
    contact: obj['contact'] as ContactBlock,
    featureFlags: obj['featureFlags'] as FeatureFlags,
    catalog: obj['catalog'] as CatalogBlock | undefined,
    ...(facets ? { facets } : {}),
    ...(menus ? { menus } : {}),
    integrations: obj['integrations'] as IntegrationsBlock | undefined,
    analytics: obj['analytics'] as AnalyticsBlock | undefined,
  };
}
