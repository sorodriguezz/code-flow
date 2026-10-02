import type { AiFailure } from "./tauri/commands";

/**
 * The three reasons a chain parks on its **engine** rather than on its plan — out of quota, signed
 * out, no CLI. Written by `queries::chain_pause_reason`; a wire vocabulary, so it must match.
 *
 * What they share, and what sets them apart from every other `paused`: nothing about the step was
 * wrong, the attempt was handed back, and what the user fixes outside the app (the window reopening,
 * a sign-in, an install) is exactly what "Resume" then continues from.
 */
export const ENGINE_PAUSE_REASONS = [
  "chain.pausedQuota",
  "chain.pausedAuth",
  "chain.pausedCliMissing",
  // A hybrid run whose local model server is not answering — see `hybrid::execute`.
  "chain.pausedLocalModel",
] as const;

export function isEnginePause(reason: string): boolean {
  return (ENGINE_PAUSE_REASONS as readonly string[]).includes(reason.trim());
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When the provider said its window reopens, as an instant (ms since the epoch) — or `null` when
 * that cannot be known for sure, in which case no automatic resume is offered at all.
 *
 * The exact instant wins when there is one (`resets_at`, the older Claude wording). Otherwise the
 * provider's own phrase is read, and only in the shapes it is actually written in:
 *
 * - relative — "in 3 hours", "in 45 minutes", "in 2 hours 30 minutes";
 * - a clock time, optionally after a weekday or a date and before an IANA zone in parentheses —
 *   "12am (America/Santiago)", "Mon 9am", "Oct 6, 9:30pm (Europe/Madrid)", "17:00".
 *
 * A clock time is the *next* occurrence of it in that zone (the machine's own when none is named),
 * which is what "resets 12am" means at 11pm. A phrase this cannot read is `null`, never a guess: an
 * automatic resume at the wrong hour would be an engine started against a working copy when nobody
 * expected one.
 */
export function resumeInstant(failure: Pick<AiFailure, "resets" | "resets_at">, now: number): number | null {
  if (failure.resets_at && failure.resets_at > 0) return failure.resets_at * 1000;
  const phrase = (failure.resets ?? "").trim();
  if (!phrase) return null;
  return relativeInstant(phrase, now) ?? clockInstant(phrase, now);
}

function relativeInstant(phrase: string, now: number): number | null {
  const lower = phrase.toLowerCase();
  if (!/^in\s/.test(lower)) return null;
  let total = 0;
  let found = false;
  for (const match of lower.matchAll(/(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b/g)) {
    const amount = Number(match[1]);
    const unit = match[2][0];
    total += amount * (unit === "d" ? DAY : unit === "h" ? HOUR : unit === "m" ? MINUTE : 1000);
    found = true;
  }
  return found && total > 0 ? now + total : null;
}

function clockInstant(phrase: string, now: number): number | null {
  const zoneMatch = phrase.match(/\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|UTC)\)/);
  const zone = zoneMatch ? zoneMatch[1] : localZone();
  if (!isZone(zone)) return null;
  const text = phrase.replace(/\([^)]*\)/g, " ").toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();

  // The first token written as a time — with minutes or a meridiem. A bare number is not one: in
  // "Oct 6, 9am" the 6 is the day of the month.
  const clock = [...text.matchAll(/(?:^|\s)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?=\s|$)/g)].find(
    (match) => match[2] !== undefined || match[3] !== undefined,
  );
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = clock[2] ? Number(clock[2]) : 0;
  const meridiem = clock[3];
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;

  const before = text.slice(0, clock.index ?? 0);
  const weekday = WEEKDAYS.findIndex((day) => new RegExp(`\\b${day}`).test(before));
  const monthAt = MONTHS.findIndex((month) => new RegExp(`\\b${month}`).test(before));
  const dayOfMonth = monthAt >= 0 ? Number(before.match(/\b(\d{1,2})\b/)?.[1] ?? NaN) : NaN;

  const today = wallDate(now, zone);
  if (monthAt >= 0 && Number.isFinite(dayOfMonth)) {
    // A stated date: this year's, or next year's when this year's has already gone by.
    for (const year of [today.year, today.year + 1]) {
      const at = zonedInstant(year, monthAt, dayOfMonth, hour, minute, zone);
      if (at > now) return at;
    }
    return null;
  }
  for (let ahead = 0; ahead < 8; ahead++) {
    const candidate = zonedInstant(today.year, today.month, today.day + ahead, hour, minute, zone);
    if (candidate <= now) continue;
    if (weekday >= 0 && wallDate(candidate, zone).weekday !== weekday) continue;
    return candidate;
  }
  return null;
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date and clock an instant shows in one zone. */
function wallDate(instant: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")) - 1,
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS.indexOf(get("weekday").slice(0, 3).toLowerCase()),
  };
}

/** How far a zone's clock is ahead of UTC at one instant, in ms. */
function zoneOffset(instant: number, zone: string): number {
  const wall = wallDate(instant, zone);
  const asUtc = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time falls on in a zone. `Date.UTC` normalises an overflowing day, so
 * `day + 1` on the 31st is the 1st of the next month. Iterated because the offset depends on the
 * instant being solved for — twice settles it everywhere except inside a DST gap, where the clock
 * time does not exist and the nearest instant after it is as good an answer as any.
 */
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const next = wall - zoneOffset(guess, zone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}
