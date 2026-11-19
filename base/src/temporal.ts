/**
 * Data-plane temporal evaluator for the ezForge Ready base MCP template
 * (issue #9148, RT-1.F.1, split of #5068; spec §5, §8, §12).
 *
 * Mirrors the control-plane evaluators in
 * `packages/api/src/modules/ready/temporal/` (`local-now.ts`, `precedence.ts`,
 * `intervals.ts`, `availability.ts`, `menus.ts`) function-for-function so both
 * planes answer identically for the same inputs. Parity is enforced by running
 * the shared vector corpus (`.../temporal/vectors/temporal-vectors.json`)
 * through this module — see `__tests__/temporal-corpus.test.ts`.
 *
 * Hard architectural invariant: templates are pure config consumers. Every
 * export here is a pure function of its arguments — no DB, no network, no file
 * or environment access, no wall-clock read (callers pass `now`). The template
 * is installed standalone, so it cannot import `@ezforge/api`/`@ezforge/shared`;
 * the few helpers needed (IANA validation, error class) are local.
 *
 * All times are evaluated in the business's IANA timezone, never host/UTC.
 */

import type { HoursBlockV3, HoursInterval, HoursRole, Weekday } from './config-loader.js';

// ─── Types (mirrors of packages/template-engine/src/config-schema.ts) ─────────

/** A recurring or date-bounded window restricting when a catalog item is available. */
export interface AvailabilityWindow {
  dayOfWeek?: number;
  start?: string;
  end?: string;
  startDate?: string;
  endDate?: string;
  recurringAnnually?: boolean;
}

/** A recurring weekly window during which a menu is active. */
export interface MenuSchedule {
  dayOfWeek?: number;
  start: string;
  end: string;
}

/**
 * A menu-section item as it appears in the config blob: `itemId` plus only the
 * fields a menu override changes. Absent fields inherit from `catalog.items[]`
 * (see {@link resolveMenus}). A legacy blob may carry fully resolved inline text.
 */
export interface MenuSectionItemSource {
  itemId: string;
  name?: string;
  description?: string;
  priceCents?: number;
  priceType?: string;
  sortOrder: number;
}

/** A section within a menu, as it appears in the config blob. */
export interface MenuSectionSource {
  id: string;
  name: string;
  sortOrder: number;
  items: MenuSectionItemSource[];
}

/** A schedule-gated menu as it appears in the config blob. An empty `schedule` means always active. */
export interface MenuSourceV3 {
  id: string;
  name: string;
  sortOrder: number;
  isDefault: boolean;
  schedule: MenuSchedule[];
  sections: MenuSectionSource[];
}

/** A resolved menu-section item (name/priceType always present). */
export interface MenuSectionItem {
  itemId: string;
  name: string;
  description?: string;
  priceCents?: number;
  priceType: string;
  sortOrder: number;
}

/** A section within a resolved menu. */
export interface MenuSection {
  id: string;
  name: string;
  sortOrder: number;
  items: MenuSectionItem[];
}

/** A resolved schedule-gated menu. An empty `schedule` means always active. */
export interface MenuV3 {
  id: string;
  name: string;
  sortOrder: number;
  isDefault: boolean;
  schedule: MenuSchedule[];
  sections: MenuSection[];
}

/** The catalog fields a menu section item can inherit. */
export interface MenuLibraryItem {
  id: string;
  name: string;
  description?: string;
  priceCents?: number;
  priceType: string;
}

/**
 * Resolve one section item: each field is `item value ?? catalog value`, so an
 * item with full inline text (legacy shape) resolves to itself. Returns
 * `undefined` when `name` or `priceType` is neither inline nor inherited
 * (i.e. the `itemId` is not in the catalog and the item is not self-contained).
 */
export function resolveMenuSectionItem(
  item: MenuSectionItemSource,
  library: MenuLibraryItem | undefined,
): MenuSectionItem | undefined {
  const name = item.name ?? library?.name;
  const priceType = item.priceType ?? library?.priceType;
  if (name === undefined || priceType === undefined) {
    return undefined;
  }
  const description = item.description ?? library?.description;
  const priceCents = item.priceCents ?? library?.priceCents;
  return {
    itemId: item.itemId,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(priceCents !== undefined ? { priceCents } : {}),
    priceType,
    sortOrder: item.sortOrder,
  };
}

/**
 * Resolve every menu's section items against `catalog` (by `itemId`). Items that
 * cannot be resolved are dropped; `loadConfig` rejects such blobs up front.
 */
export function resolveMenus(menus: readonly MenuSourceV3[], catalog: readonly MenuLibraryItem[]): MenuV3[] {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  return menus.map((menu) => ({
    ...menu,
    sections: menu.sections.map((section) => ({
      ...section,
      items: section.items.flatMap((item) => {
        const resolved = resolveMenuSectionItem(item, byId.get(item.itemId));
        return resolved ? [resolved] : [];
      }),
    })),
  }));
}

// ─── §5.1 now-resolution ──────────────────────────────────────────────────────

export interface LocalNow {
  /** 0-6, 0 = Sunday. */
  localDay: number;
  /** 24-hour "HH:MM", zero-padded. */
  localHHMM: string;
  /** "YYYY-MM-DD" in the business's local calendar. */
  localDate: string;
}

/** Thrown for a timezone that is not a real IANA identifier. Never falls back to UTC. */
export class InvalidTimeZoneError extends Error {
  constructor(timeZone: string) {
    super(`Invalid IANA time zone: ${timeZone}`);
    this.name = 'InvalidTimeZoneError';
  }
}

const WEEKDAY_ABBREV_TO_DAY: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

let cachedZones: ReadonlySet<string> | null = null;

/** ICU's canonical zone list omits the bare "UTC" alias, which ECMA-402 treats as always valid. */
function isValidIanaTimezone(value: string): boolean {
  if (!value) return false;
  cachedZones ??= new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
  return cachedZones.has(value);
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const part = parts.find((p) => p.type === type);
  if (!part) {
    throw new Error(`Intl.DateTimeFormat did not produce a "${type}" part`);
  }
  return part.value;
}

/**
 * Resolves `now` to the business-local day/time/date for `timeZone`,
 * DST-correct. `hourCycle: 'h23'` is explicit so midnight formats as "00",
 * never "24".
 */
export function resolveLocalNow(now: Date, timeZone: string): LocalNow {
  if (!isValidIanaTimezone(timeZone)) {
    throw new InvalidTimeZoneError(timeZone);
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);

  const weekday = partValue(parts, 'weekday');
  const localDay = WEEKDAY_ABBREV_TO_DAY[weekday];
  if (localDay === undefined) {
    throw new Error(`Unrecognized weekday abbreviation from Intl.DateTimeFormat: ${weekday}`);
  }

  return {
    localDay,
    localHHMM: `${partValue(parts, 'hour')}:${partValue(parts, 'minute')}`,
    localDate: `${partValue(parts, 'year')}-${partValue(parts, 'month')}-${partValue(parts, 'day')}`,
  };
}

// ─── §5.2 precedence: closure > special > regular ─────────────────────────────

const WEEKDAY_BY_LOCAL_DAY: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export interface EffectiveHoursInput {
  /** "YYYY-MM-DD" business-local calendar date being evaluated. */
  localDate: string;
  /** 0-6, 0 = Sunday — must correspond to `localDate`'s weekday. */
  localDay: number;
  regular: HoursBlockV3['regular'];
  special: HoursBlockV3['special'];
  closures: HoursBlockV3['closures'];
}

/** "MM-DD" suffix of either a "YYYY-MM-DD" or a bare "MM-DD" string. */
function monthDay(date: string): string {
  return date.slice(-5);
}

/** `localDate` within `[startDate, endDate]` inclusive, year-aware. */
export function matchesExactRange(localDate: string, startDate: string, endDate: string): boolean {
  return startDate <= localDate && localDate <= endDate;
}

/**
 * `localDate`'s month/day within the annual-recurring `[startDate, endDate]`
 * range, wrapping across the year boundary when start > end (Dec 24 → Jan 2).
 * A "02-29" boundary never matches in a non-leap year.
 */
export function matchesRecurringRange(localDate: string, startDate: string, endDate: string): boolean {
  const nowMD = monthDay(localDate);
  const startMD = monthDay(startDate);
  const endMD = monthDay(endDate);
  if (startMD <= endMD) {
    return nowMD >= startMD && nowMD <= endMD;
  }
  return nowMD >= startMD || nowMD <= endMD;
}

function isClosureActive(localDate: string, closure: HoursBlockV3['closures'][number]): boolean {
  return closure.recurringAnnually
    ? matchesRecurringRange(localDate, closure.startDate, closure.endDate)
    : matchesExactRange(localDate, closure.startDate, closure.endDate);
}

function matchesSpecial(localDate: string, entry: HoursBlockV3['special'][number]): boolean {
  return entry.recurringAnnually ? monthDay(entry.date) === monthDay(localDate) : entry.date === localDate;
}

/**
 * Effective interval set for one business-local date: closure > special >
 * regular. An exact-date special beats an annual-recurring one for the same
 * date. Empty means closed.
 */
export function resolveEffectiveHours(input: EffectiveHoursInput): readonly HoursInterval[] {
  const { localDate, localDay, regular, special, closures } = input;

  if (closures.some((closure) => isClosureActive(localDate, closure))) {
    return [];
  }

  const matchingSpecial = special.filter((entry) => matchesSpecial(localDate, entry));
  const [firstMatch] = matchingSpecial;
  if (firstMatch !== undefined) {
    const exact = matchingSpecial.find((entry) => !entry.recurringAnnually);
    return (exact ?? firstMatch).intervals;
  }

  const weekday = WEEKDAY_BY_LOCAL_DAY[localDay];
  if (weekday === undefined) {
    throw new Error(`Invalid localDay: ${String(localDay)} (expected 0-6)`);
  }
  return regular[weekday];
}

// ─── §5.3 interval sets & roles ───────────────────────────────────────────────

export interface IntervalEvalInput {
  /** Instant to evaluate "now" at. */
  now: Date;
  /** IANA business timezone (`hours.timezone`). */
  timezone: string;
  regular: HoursBlockV3['regular'];
  special: HoursBlockV3['special'];
  closures: HoursBlockV3['closures'];
}

export interface OpenNowResult {
  open: boolean;
  /** The role actually evaluated — echoes the request, even on fallback. */
  role: HoursRole;
  /** The interval that made this `open`, when `open` is true. */
  matchedInterval?: HoursInterval;
}

const MINUTES_PER_DAY = 24 * 60;

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

function minutesToTime(minutes: number): string {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/** A `close` of "00:00" is end-of-day, never an overnight span. */
function isOvernightRange(start: string, end: string): boolean {
  return end !== '00:00' && start > end;
}

function isOvernightInterval(interval: HoursInterval): boolean {
  return isOvernightRange(interval.open, interval.close);
}

/**
 * `nowHHMM` within `[open, close)`; an overnight span (`open > close`) is a
 * circular within-day window and a `close` of "00:00" means end of day.
 * Interval evaluators use `isIntervalActiveAt`, which matches only an overnight
 * span's head; this circular form serves availability/menu windows.
 */
export function isTimeInRange(open: string, close: string, nowHHMM: string): boolean {
  if (close === '00:00') {
    return nowHHMM >= open;
  }
  if (open <= close) {
    return nowHHMM >= open && nowHHMM < close;
  }
  return nowHHMM >= open || nowHHMM < close;
}

/**
 * Is `interval`, taken from THIS day's set, active at `nowHHMM`. An overnight
 * span belongs to the day it starts on, so only its head (`nowHHMM >= open`)
 * counts here; its tail is matched against the prior day's set by
 * {@link isCarryForwardActiveAt}.
 */
function isIntervalActiveAt(interval: HoursInterval, nowHHMM: string): boolean {
  if (isOvernightInterval(interval)) {
    return nowHHMM >= interval.open;
  }
  return isTimeInRange(interval.open, interval.close, nowHHMM);
}

function isCarryForwardActiveAt(interval: HoursInterval, nowHHMM: string): boolean {
  return isOvernightInterval(interval) && nowHHMM < interval.close;
}

/**
 * Filters `intervals` to `role`. Only the default `service` role falls back to
 * the full set when no `service` interval exists (spec §5.3); an explicit
 * `kitchen`/`bar` query never silently answers from another role's hours.
 */
function selectRoleCandidates(intervals: readonly HoursInterval[], role: HoursRole): HoursInterval[] {
  const matching = intervals.filter((interval) => interval.role === role);
  if (matching.length > 0) return matching;
  if (role === 'service') return [...intervals];
  return [];
}

/** Calendar-only shift of a "YYYY-MM-DD" string by `deltaDays`. */
function shiftLocalDate(localDate: string, deltaDays: number): { date: string; day: number } {
  const [y, m, d] = localDate.split('-');
  const utc = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  utc.setUTCDate(utc.getUTCDate() + deltaDays);
  return { date: utc.toISOString().slice(0, 10), day: utc.getUTCDay() };
}

/** Calendar-only "yesterday" of a "YYYY-MM-DD" string. */
function previousLocalDate(localDate: string): { date: string; day: number } {
  return shiftLocalDate(localDate, -1);
}

function effectiveHoursFor(input: Pick<IntervalEvalInput, 'regular' | 'special' | 'closures'>, localDate: string, localDay: number): readonly HoursInterval[] {
  return resolveEffectiveHours({
    localDate,
    localDay,
    regular: input.regular,
    special: input.special,
    closures: input.closures,
  });
}

/**
 * "Is this business open now", optionally scoped to a role (`service`
 * default). Today's effective interval set (an overnight span matches only
 * from its opening time) OR yesterday's effective set carrying an overnight
 * tail into today's early morning. Yesterday goes through the same precedence
 * chain, so a closure/special on yesterday's date suppresses or alters the
 * carry-forward.
 */
export function resolveOpenNow(input: IntervalEvalInput, role: HoursRole = 'service'): OpenNowResult {
  return resolveOpenAtLocal(input, resolveLocalNow(input.now, input.timezone), role);
}

/**
 * {@link resolveOpenNow} for an already-resolved business-local moment (e.g. a
 * requested reservation date/time given as local wall-clock values). Needs no
 * timezone: `localNow` is already local.
 */
export function resolveOpenAtLocal(
  input: Pick<IntervalEvalInput, 'regular' | 'special' | 'closures'>,
  localNow: LocalNow,
  role: HoursRole = 'service',
): OpenNowResult {
  const today = effectiveHoursFor(input, localNow.localDate, localNow.localDay);

  const todayMatch = selectRoleCandidates(today, role).find((interval) =>
    isIntervalActiveAt(interval, localNow.localHHMM),
  );
  if (todayMatch) {
    return { open: true, role, matchedInterval: todayMatch };
  }

  const prev = previousLocalDate(localNow.localDate);
  const yesterday = effectiveHoursFor(input, prev.date, prev.day);
  const carryForwardMatch = selectRoleCandidates(yesterday, role).find((interval) =>
    isCarryForwardActiveAt(interval, localNow.localHHMM),
  );
  if (carryForwardMatch) {
    return { open: true, role, matchedInterval: carryForwardMatch };
  }

  return { open: false, role };
}

/**
 * `lastOrder = close − offset`. Honours a precomputed `interval.lastOrder`
 * (set at config-generation time) when present; otherwise computes it from
 * `offsetMinutes`, wrapping across midnight.
 */
export function resolveLastOrder(interval: HoursInterval, offsetMinutes?: number): string | undefined {
  if (interval.lastOrder !== undefined) {
    return interval.lastOrder;
  }
  if (offsetMinutes === undefined) {
    return undefined;
  }
  const closeMinutes = interval.close === '00:00' ? MINUTES_PER_DAY : timeToMinutes(interval.close);
  return minutesToTime(closeMinutes - offsetMinutes);
}

export interface LastOrderResult {
  /** The current (if open) or next upcoming interval for `role` today, if any. */
  interval?: HoursInterval;
  /** `true` when `interval` is the currently-active one; `false` when upcoming. */
  isCurrent: boolean;
  lastOrder?: string;
}

function toLastOrderResult(interval: HoursInterval, isCurrent: boolean, offsetMinutes?: number): LastOrderResult {
  const lastOrder = resolveLastOrder(interval, offsetMinutes);
  return lastOrder === undefined ? { interval, isCurrent } : { interval, isCurrent, lastOrder };
}

/**
 * Last-order for the current-or-next interval of `role`. The current interval
 * is resolved as {@link resolveOpenNow} does (today's head, else yesterday's
 * overnight tail) so the two never disagree; the upcoming interval comes from
 * TODAY's effective set only.
 */
export function resolveCurrentOrNextLastOrder(
  input: IntervalEvalInput,
  role: HoursRole = 'service',
  offsetMinutes?: number,
): LastOrderResult {
  const localNow = resolveLocalNow(input.now, input.timezone);
  const today = effectiveHoursFor(input, localNow.localDate, localNow.localDay);
  const candidates = selectRoleCandidates(today, role);

  const current = candidates.find((interval) => isIntervalActiveAt(interval, localNow.localHHMM));
  if (current) {
    return toLastOrderResult(current, true, offsetMinutes);
  }

  const prev = previousLocalDate(localNow.localDate);
  const carry = selectRoleCandidates(effectiveHoursFor(input, prev.date, prev.day), role).find((interval) =>
    isCarryForwardActiveAt(interval, localNow.localHHMM),
  );
  if (carry) {
    return toLastOrderResult(carry, true, offsetMinutes);
  }

  const upcoming = candidates
    .filter((interval) => interval.open > localNow.localHHMM)
    .sort((a, b) => (a.open < b.open ? -1 : a.open > b.open ? 1 : 0))[0];
  if (upcoming) {
    return toLastOrderResult(upcoming, false, offsetMinutes);
  }

  return { isCurrent: false };
}

// ─── §8 base hours tools: open status and today's windows ─────────────────────

/** A business-local calendar date and 24-hour "HH:MM" time. */
export interface LocalMoment {
  /** "YYYY-MM-DD" */
  date: string;
  /** "HH:MM" */
  time: string;
}

export interface OpenStatusResult extends OpenNowResult {
  /** First `role` interval opening strictly after now, within {@link NEXT_OPEN_HORIZON_DAYS}. */
  nextOpen?: LocalMoment;
  /** When the interval that makes the business open now closes. Only set when `open`. */
  nextClose?: LocalMoment;
}

/** Look-ahead for `nextOpen`; long enough to see past a multi-month seasonal closure. */
const NEXT_OPEN_HORIZON_DAYS = 366;

function closeMoment(interval: HoursInterval, localNow: LocalNow): LocalMoment {
  const endsTomorrow =
    interval.close === '00:00' || (isOvernightInterval(interval) && localNow.localHHMM >= interval.open);
  const date = endsTomorrow ? shiftLocalDate(localNow.localDate, 1).date : localNow.localDate;
  return { date, time: interval.close };
}

function findNextOpen(input: IntervalEvalInput, role: HoursRole, localNow: LocalNow): LocalMoment | undefined {
  for (let offset = 0; offset <= NEXT_OPEN_HORIZON_DAYS; offset++) {
    const { date, day } = shiftLocalDate(localNow.localDate, offset);
    const opens = selectRoleCandidates(effectiveHoursFor(input, date, day), role)
      .map((interval) => interval.open)
      .filter((open) => offset > 0 || open > localNow.localHHMM)
      .sort();
    const [earliest] = opens;
    if (earliest !== undefined) {
      return { date, time: earliest };
    }
  }
  return undefined;
}

/**
 * {@link resolveOpenNow} plus the surrounding transitions: when open, the close
 * time of the matched interval; always, the next opening after now. Split
 * intervals are reported as separate windows — an interval ending exactly where
 * the next begins is not merged.
 */
export function resolveOpenStatus(input: IntervalEvalInput, role: HoursRole = 'service'): OpenStatusResult {
  const localNow = resolveLocalNow(input.now, input.timezone);
  const base = resolveOpenNow(input, role);
  const nextOpen = findNextOpen(input, role, localNow);
  return {
    ...base,
    ...(base.matchedInterval ? { nextClose: closeMoment(base.matchedInterval, localNow) } : {}),
    ...(nextOpen ? { nextOpen } : {}),
  };
}

export interface TodayWindow {
  interval: HoursInterval;
  /** `interval.lastOrder` when the config precomputed one. */
  lastOrder?: string;
  /** `true` when now is inside this window. */
  windowOpen: boolean;
}

export interface TodayWindowsResult {
  /** "YYYY-MM-DD" business-local date the windows belong to. */
  localDate: string;
  /** Today's effective windows sorted by `open` then `role`; empty when closed all day. */
  windows: TodayWindow[];
}

/**
 * Today's effective windows (closure > special > regular) with last-order and
 * open-now state. `role` omitted = every role; given = {@link selectRoleCandidates}
 * semantics. Only today's rows are listed, but a row identical to one of
 * yesterday's overnight spans still carrying into this morning reports
 * `windowOpen: true`, agreeing with {@link resolveOpenNow}.
 */
export function resolveTodayWindows(input: IntervalEvalInput, role?: HoursRole): TodayWindowsResult {
  const localNow = resolveLocalNow(input.now, input.timezone);
  const today = effectiveHoursFor(input, localNow.localDate, localNow.localDay);
  const selected = role === undefined ? [...today] : selectRoleCandidates(today, role);

  const prev = previousLocalDate(localNow.localDate);
  const carrying = effectiveHoursFor(input, prev.date, prev.day).filter((interval) =>
    isCarryForwardActiveAt(interval, localNow.localHHMM),
  );

  const windows = selected
    .sort((a, b) => (a.open < b.open ? -1 : a.open > b.open ? 1 : a.role < b.role ? -1 : a.role > b.role ? 1 : 0))
    .map((interval): TodayWindow => {
      const windowOpen =
        isIntervalActiveAt(interval, localNow.localHHMM) ||
        carrying.some((c) => c.role === interval.role && c.open === interval.open && c.close === interval.close);
      const lastOrder = resolveLastOrder(interval);
      return lastOrder === undefined ? { interval, windowOpen } : { interval, lastOrder, windowOpen };
    });

  return { localDate: localNow.localDate, windows };
}

// ─── §5.4 item availability ───────────────────────────────────────────────────

function matchesTimeRange(window: AvailabilityWindow, localHHMM: string): boolean {
  if (window.start === undefined || window.end === undefined) {
    return true;
  }
  return isTimeInRange(window.start, window.end, localHHMM);
}

function matchesDateRange(window: AvailabilityWindow, localDate: string): boolean {
  if (window.startDate === undefined || window.endDate === undefined) {
    return true;
  }
  return window.recurringAnnually
    ? matchesRecurringRange(localDate, window.startDate, window.endDate)
    : matchesExactRange(localDate, window.startDate, window.endDate);
}

/**
 * An overnight window (`start > end`) belongs to the day it starts on: its head
 * is checked against today's day/date, its tail against yesterday's — so
 * Friday 22:00-02:00 matches Saturday 01:00, not Friday 01:00.
 */
function matchesWindow(window: AvailabilityWindow, localNow: LocalNow): boolean {
  const { start, end } = window;
  if (start !== undefined && end !== undefined && isOvernightRange(start, end)) {
    const head =
      (window.dayOfWeek === undefined || window.dayOfWeek === localNow.localDay) &&
      localNow.localHHMM >= start &&
      matchesDateRange(window, localNow.localDate);
    const previous = previousLocalDate(localNow.localDate);
    const tail =
      (window.dayOfWeek === undefined || window.dayOfWeek === previous.day) &&
      localNow.localHHMM < end &&
      matchesDateRange(window, previous.date);
    return head || tail;
  }
  return (
    (window.dayOfWeek === undefined || window.dayOfWeek === localNow.localDay) &&
    matchesTimeRange(window, localNow.localHHMM) &&
    matchesDateRange(window, localNow.localDate)
  );
}

/**
 * `isAvailable` AND (no windows OR at least one window matches `localNow`).
 * `isAvailable=false` is a manual 86 that overrides every matching window.
 */
export function resolveItemAvailableNow(
  isAvailable: boolean,
  windows: readonly AvailabilityWindow[],
  localNow: LocalNow,
): boolean {
  if (!isAvailable) {
    return false;
  }
  if (windows.length === 0) {
    return true;
  }
  return windows.some((window) => matchesWindow(window, localNow));
}

// ─── §5.5 menu resolution ─────────────────────────────────────────────────────

/**
 * A day-scoped overnight row (`start > end`) belongs to the day it starts on:
 * its head matches that day, its tail the following day — never the same
 * day's early morning.
 */
function matchesSchedule(schedule: MenuSchedule, localNow: LocalNow): boolean {
  const { dayOfWeek, start, end } = schedule;
  if (dayOfWeek === undefined) {
    return isTimeInRange(start, end, localNow.localHHMM);
  }
  if (!isOvernightRange(start, end)) {
    return dayOfWeek === localNow.localDay && isTimeInRange(start, end, localNow.localHHMM);
  }
  const previousDay = (localNow.localDay + 6) % 7;
  return (
    (dayOfWeek === localNow.localDay && localNow.localHHMM >= start) ||
    (dayOfWeek === previousDay && localNow.localHHMM < end)
  );
}

/** A menu is active when it has no schedule rows (always-on) or any row matches `localNow`. */
export function resolveMenuActiveNow(menu: MenuV3, localNow: LocalNow): boolean {
  if (menu.schedule.length === 0) {
    return true;
  }
  return menu.schedule.some((schedule) => matchesSchedule(schedule, localNow));
}

/** All menus active at `localNow` (overlaps allowed), ordered by `sortOrder` ascending. */
export function resolveActiveMenus(menus: readonly MenuV3[], localNow: LocalNow): MenuV3[] {
  return menus.filter((menu) => resolveMenuActiveNow(menu, localNow)).sort((a, b) => a.sortOrder - b.sortOrder);
}

export interface PriceNowResult {
  /** The active menu that won the price-now answer for this item. */
  menu: MenuV3;
  /** The section item as it appears on `menu`. */
  item: MenuSectionItem;
}

/**
 * "Price now" for `itemId`: the item as listed on the lowest-`sortOrder`
 * currently-active menu that contains it, or `undefined` if none does.
 */
export function resolvePriceNow(
  itemId: string,
  menus: readonly MenuV3[],
  localNow: LocalNow,
): PriceNowResult | undefined {
  for (const menu of resolveActiveMenus(menus, localNow)) {
    for (const section of menu.sections) {
      const item = section.items.find((sectionItem) => sectionItem.itemId === itemId);
      if (item) {
        return { menu, item };
      }
    }
  }
  return undefined;
}
