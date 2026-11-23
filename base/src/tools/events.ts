/**
 * Shared event tools for ezForge Ready templates (Ready Phase 4.2).
 *
 * `list_events` answers "who is playing Friday?": occurrences of the business's
 * events in a date window, weekly recurrences expanded. `get_event` answers "what
 * time are doors, how much is a ticket today?": one event with every price tier
 * plus the current tier of an occurrence. The base server and vertical templates
 * (restaurant) share this one implementation.
 *
 * Tools are listed through {@link eventToolsFor}, which gates on
 * `featureFlags.events`, so a config without events lists exactly the tools it
 * did before events existed. All calendar maths here is on plain
 * business-local dates and wall-clock times (never UTC offsets), so a DST change
 * cannot shift a cutoff; "now" comes from `resolveLocalNow` in `../temporal.ts`.
 */

import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { Tool } from '@modelcontextprotocol/server';
import type { EventPriceTierV3, EventV3, ReadyConfig } from '../config-loader.js';
import { OWNER_TEXT_LABEL, OWNER_TEXT_TOOL_NOTE } from '../owner-text.js';
import { InvalidTimeZoneError, resolveLocalNow } from '../temporal.js';

export type EventsToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

export const EVENTS_TOOL_NAMES = ['list_events', 'get_event'] as const;
export type EventsToolName = (typeof EVENTS_TOOL_NAMES)[number];

export function isEventsToolName(name: string): name is EventsToolName {
  return (EVENTS_TOOL_NAMES as readonly string[]).includes(name);
}

/** Days after the start of the default `list_events` window (today..today+30). */
const DEFAULT_WINDOW_DAYS = 30;
/** `list_events` result count when `limit` is omitted. */
const DEFAULT_LIMIT = 25;
/** Upper bound on `limit`; bounds the per-call expansion work. */
const MAX_LIMIT = 100;

// Typed as `Tool` so the two differently-shaped schemas do not infer a union with
// `prop?: undefined` members that the server's `tools/list` result type rejects.
export const EVENTS_TOOLS: Tool[] = [
  {
    name: 'list_events',
    description:
      'Lists upcoming events (live music, tastings, etc.), weekly recurrences expanded, sorted by date and start time. ' +
      'Returns { timezone, from, to, events: [{ eventId, date, title, performer?, doorsTime?, startTime, endTime?, status, currentPrice?, ticketUrl?, rsvpUrl?, facetId? }] }. ' +
      '`status` is "scheduled", "sold_out" or "cancelled"; an `endTime` earlier than `startTime` means the event ends after midnight. ' +
      '`currentPrice` is { label, priceCents, currency, until? }: the ticket tier on sale right now (e.g. advance vs door), ' +
      'and `until` is the local datetime that tier ends; it is omitted for sold-out and cancelled events and when no tier is on sale. ' +
      'Dates and times are in the business timezone. Defaults to today through 30 days ahead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'First date, YYYY-MM-DD; defaults to today (business timezone).' },
        to: { type: 'string', description: 'Last date, YYYY-MM-DD inclusive; defaults to 30 days after `from`.' },
        facetId: { type: 'string', description: 'Only events of this offering group (see list_facets).' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum occurrences to return (default ${String(DEFAULT_LIMIT)}).`,
        },
      },
      required: [],
    },
  },
  {
    name: 'get_event',
    description:
      'Returns one event with all of its ticket price tiers plus one occurrence and the tier on sale for it. ' +
      'Returns { timezone, event: { eventId, title, description?, performer?, facetId?, startDate, doorsTime?, startTime, endTime?, recurrence, recurrenceUntil?, excludedDates?, status, ticketUrl?, rsvpUrl?, priceTiers: [{ label, priceCents, currency, endsDaysBefore?, endsAtLocalTime? }] }, ' +
      'occurrence: { date, status, currentPrice? } | null }. ' +
      'The occurrence is the one on `date` when given, otherwise the next one from today; `occurrence` is null when none is left. ' +
      'An unknown `eventId`, or a `date` that is not an occurrence of the event, is an error. ' +
      OWNER_TEXT_TOOL_NOTE,
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'Event id from list_events.' },
        date: { type: 'string', description: 'Occurrence date, YYYY-MM-DD; defaults to the next occurrence.' },
      },
      required: ['eventId'],
    },
  },
];

/**
 * Tool definitions to list for this config: both event tools when
 * `featureFlags.events` is true, none otherwise.
 */
export function eventToolsFor(config: Pick<ReadyConfig, 'featureFlags'>): Tool[] {
  return config.featureFlags.events === true ? [...EVENTS_TOOLS] : [];
}

function jsonResult(value: unknown): EventsToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(message: string): EventsToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function invalidParams(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

// ── Calendar maths on business-local "YYYY-MM-DD" dates ──────────────────────

const MS_PER_DAY = 86_400_000;

/** Day number of a "YYYY-MM-DD" date. UTC is used only as a proleptic calendar; no zone is involved. */
function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

function dateFromDayNumber(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return dateFromDayNumber(dayNumber(date) + days);
}

/** True for a real calendar date written exactly "YYYY-MM-DD" (rejects "2026-02-30"). */
function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && dateFromDayNumber(dayNumber(value)) === value;
}

function parseDateArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value === 'string' && isCalendarDate(value)) return value;
  throw invalidParams(`Invalid ${key}: expected a date written YYYY-MM-DD`);
}

function parseLimitArg(args: Record<string, unknown> | undefined): number {
  const value = args?.['limit'];
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT) return value;
  throw invalidParams(`Invalid limit: expected an integer from 1 to ${String(MAX_LIMIT)}`);
}

function parseStringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw invalidParams(`Invalid ${key}: expected a string`);
}

// ── Occurrences ──────────────────────────────────────────────────────────────

/** True when `date` is an occurrence of `event` (recurrence rule applied, `excludedDates` skipped). */
function isOccurrence(event: EventV3, date: string): boolean {
  if (event.excludedDates?.includes(date)) return false;
  if (event.recurrence === 'none') return date === event.startDate;
  const offset = dayNumber(date) - dayNumber(event.startDate);
  return offset >= 0 && offset % 7 === 0 && (event.recurrenceUntil === undefined || date <= event.recurrenceUntil);
}

/**
 * Occurrence dates of `event` within [from, to], oldest first, at most `limit`.
 * Work is bounded by `limit` plus the event's own `excludedDates`, not by the
 * window length: a weekly event jumps straight to its first occurrence on or
 * after `from`.
 */
function occurrenceDates(event: EventV3, from: string, to: string, limit: number): string[] {
  const last = event.recurrence === 'weekly' && event.recurrenceUntil !== undefined && event.recurrenceUntil < to
    ? event.recurrenceUntil
    : to;
  const dates: string[] = [];
  if (event.recurrence === 'none') {
    if (event.startDate >= from && event.startDate <= last && isOccurrence(event, event.startDate)) {
      dates.push(event.startDate);
    }
    return dates;
  }
  const firstWeek = Math.max(0, Math.ceil((dayNumber(from) - dayNumber(event.startDate)) / 7));
  for (let week = firstWeek; dates.length < limit; week += 1) {
    const date = addDays(event.startDate, week * 7);
    if (date > last) break;
    if (isOccurrence(event, date)) dates.push(date);
  }
  return dates;
}

// ── Price tiers ──────────────────────────────────────────────────────────────

/** Local datetime "YYYY-MM-DDTHH:MM" at which a tier stops being on sale for the occurrence on `date`; undefined = never. */
function tierCutoff(tier: EventPriceTierV3, date: string): string | undefined {
  if (tier.endsDaysBefore === undefined || tier.endsAtLocalTime === undefined) return undefined;
  return `${addDays(date, -tier.endsDaysBefore)}T${tier.endsAtLocalTime}`;
}

function bySortOrder(a: EventPriceTierV3, b: EventPriceTierV3): number {
  return a.sortOrder - b.sortOrder;
}

/**
 * The tier on sale for the occurrence on `date`: the first tier in `sortOrder`
 * whose cutoff is after `nowLocal` ("YYYY-MM-DDTHH:MM", business-local); a tier
 * with no cutoff always qualifies. Both strings are fixed-width local
 * datetimes, so string comparison is chronological and DST-independent.
 */
function currentTier(
  tiers: readonly EventPriceTierV3[],
  date: string,
  nowLocal: string,
): { tier: EventPriceTierV3; until?: string } | undefined {
  for (const tier of [...tiers].sort(bySortOrder)) {
    const cutoff = tierCutoff(tier, date);
    if (cutoff === undefined || cutoff > nowLocal) {
      return { tier, ...(cutoff === undefined ? {} : { until: cutoff }) };
    }
  }
  return undefined;
}

function currentPrice(event: EventV3, date: string, nowLocal: string) {
  // No tickets are sold for a cancelled or sold-out event, so no price is quoted.
  if (event.status !== 'scheduled') return undefined;
  const current = currentTier(event.priceTiers, date, nowLocal);
  if (current === undefined) return undefined;
  return {
    label: current.tier.label,
    priceCents: current.tier.priceCents,
    currency: current.tier.currency,
    ...(current.until === undefined ? {} : { until: current.until }),
  };
}

function ownerText(text: string | undefined): string | undefined {
  return text ? `${OWNER_TEXT_LABEL}${text}` : undefined;
}

function occurrenceView(event: EventV3, date: string, nowLocal: string) {
  const price = currentPrice(event, date, nowLocal);
  return {
    eventId: event.id,
    date,
    title: event.title,
    ...(event.performer ? { performer: event.performer } : {}),
    ...(event.doorsTime ? { doorsTime: event.doorsTime } : {}),
    startTime: event.startTime,
    ...(event.endTime ? { endTime: event.endTime } : {}),
    status: event.status,
    ...(price ? { currentPrice: price } : {}),
    ...(event.ticketUrl ? { ticketUrl: event.ticketUrl } : {}),
    ...(event.rsvpUrl ? { rsvpUrl: event.rsvpUrl } : {}),
    ...(event.facetId ? { facetId: event.facetId } : {}),
  };
}

function compareOccurrences(
  a: { date: string; startTime: string; eventId: string },
  b: { date: string; startTime: string; eventId: string },
): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/**
 * Handles an event tool call. `timezone` is the business IANA zone (empty when
 * the config carries none, which makes every answer an error rather than a
 * guess); `clock` is the source of "now". Malformed arguments throw a
 * `ProtocolError` (InvalidParams), like the hours tools; an unknown event or a
 * non-occurrence date returns an `isError` result.
 */
export function handleEventsTool(
  name: EventsToolName,
  args: Record<string, unknown> | undefined,
  events: readonly EventV3[],
  timezone: string,
  clock: () => Date,
): EventsToolResult {
  // Validate arguments first so a malformed call fails the same way in any config.
  let from: string | undefined;
  let to: string | undefined;
  let facetId: string | undefined;
  let limit = DEFAULT_LIMIT;
  let eventId = '';
  let date: string | undefined;
  if (name === 'list_events') {
    from = parseDateArg(args, 'from');
    to = parseDateArg(args, 'to');
    facetId = parseStringArg(args, 'facetId');
    limit = parseLimitArg(args);
    if (from !== undefined && to !== undefined && to < from) {
      throw invalidParams('Invalid range: `to` must not be before `from`');
    }
  } else {
    const id = parseStringArg(args, 'eventId');
    if (id === undefined || id === '') throw invalidParams('Missing eventId');
    eventId = id;
    date = parseDateArg(args, 'date');
  }

  // Time-sensitive answers need a real IANA zone; never guess UTC or the host zone.
  if (timezone === '') {
    return errorResult(
      'This business has no timezone configured, so event dates and ticket prices cannot be evaluated.',
    );
  }
  let nowLocal: string;
  let today: string;
  try {
    const now = resolveLocalNow(clock(), timezone);
    today = now.localDate;
    nowLocal = `${now.localDate}T${now.localHHMM}`;
  } catch (err) {
    if (err instanceof InvalidTimeZoneError) {
      return errorResult(`The configured business timezone is invalid: ${timezone}`);
    }
    throw err;
  }

  if (name === 'list_events') {
    const windowStart = from ?? today;
    const windowEnd = to ?? addDays(windowStart, DEFAULT_WINDOW_DAYS);
    // Each event contributes at most `limit` occurrences: more could never reach the top `limit`.
    const occurrences = events
      .filter((event) => facetId === undefined || event.facetId === facetId)
      .flatMap((event) =>
        occurrenceDates(event, windowStart, windowEnd, limit).map((d) => occurrenceView(event, d, nowLocal)),
      )
      .sort(compareOccurrences)
      .slice(0, limit);
    return jsonResult({ timezone, from: windowStart, to: windowEnd, events: occurrences });
  }

  const event = events.find((e) => e.id === eventId);
  if (event === undefined) return errorResult(`Unknown event: ${eventId}`);

  let occurrenceDate: string | undefined;
  if (date !== undefined) {
    if (!isOccurrence(event, date)) {
      return errorResult(`${event.title} has no occurrence on ${date}`);
    }
    occurrenceDate = date;
  } else {
    // The next occurrence from today: bounded to the event's own rule, so search up to its end.
    const searchEnd = event.recurrence === 'weekly' && event.recurrenceUntil !== undefined
      ? event.recurrenceUntil
      : event.startDate;
    occurrenceDate = occurrenceDates(event, today, searchEnd < today ? today : searchEnd, 1)[0];
  }

  const tiers = [...event.priceTiers].sort(bySortOrder).map((tier) => ({
    label: tier.label,
    priceCents: tier.priceCents,
    currency: tier.currency,
    ...(tier.endsDaysBefore === undefined ? {} : { endsDaysBefore: tier.endsDaysBefore }),
    ...(tier.endsAtLocalTime === undefined ? {} : { endsAtLocalTime: tier.endsAtLocalTime }),
  }));
  const description = ownerText(event.description);
  const price = occurrenceDate === undefined ? undefined : currentPrice(event, occurrenceDate, nowLocal);

  return jsonResult({
    timezone,
    event: {
      eventId: event.id,
      title: event.title,
      ...(description ? { description } : {}),
      ...(event.performer ? { performer: event.performer } : {}),
      ...(event.facetId ? { facetId: event.facetId } : {}),
      startDate: event.startDate,
      ...(event.doorsTime ? { doorsTime: event.doorsTime } : {}),
      startTime: event.startTime,
      ...(event.endTime ? { endTime: event.endTime } : {}),
      recurrence: event.recurrence,
      ...(event.recurrenceUntil ? { recurrenceUntil: event.recurrenceUntil } : {}),
      ...(event.excludedDates?.length ? { excludedDates: event.excludedDates } : {}),
      status: event.status,
      ...(event.ticketUrl ? { ticketUrl: event.ticketUrl } : {}),
      ...(event.rsvpUrl ? { rsvpUrl: event.rsvpUrl } : {}),
      priceTiers: tiers,
    },
    occurrence:
      occurrenceDate === undefined
        ? null
        : { date: occurrenceDate, status: event.status, ...(price ? { currentPrice: price } : {}) },
  });
}
