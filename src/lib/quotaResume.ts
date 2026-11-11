import { isBillingRefusal, parseClaudeError } from "./claudeError";
import { aiClassifyFailure } from "./tauri/commands";

const MILLIS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MILLIS_PER_MINUTE = SECONDS_PER_MINUTE * MILLIS_PER_SECOND;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;
const MILLIS_PER_HOUR = MINUTES_PER_HOUR * MILLIS_PER_MINUTE;
const MILLIS_PER_DAY = HOURS_PER_DAY * MILLIS_PER_HOUR;
const DAYS_PER_WEEK = 7;
const NOON_HOUR = 12;
const FIRST_MONTH_NUMBER = 1;
const PM_MERIDIEM = "p";
const CLOCK_LOCALE = "en-US";
const QUOTA_FAILURE_KIND = "quota";
const WEEKDAY_ABBREVIATION_LENGTH = 3;

export const RESUME_GRACE_MS = 2 * MILLIS_PER_MINUTE;
export const UNKNOWN_RESET_PROBE_MS = 30 * MILLIS_PER_MINUTE;
export const MIN_RESUME_DELAY_MS = MILLIS_PER_MINUTE;

const WEEKDAY_ABBREVIATIONS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_ABBREVIATIONS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const UNIT_MILLIS: Record<string, number> = {
  d: MILLIS_PER_DAY,
  h: MILLIS_PER_HOUR,
  m: MILLIS_PER_MINUTE,
  s: MILLIS_PER_SECOND,
};

const RESET_LEAD_SOURCE =
  "(?:resets?(?:\\s+at)?|try again (?:at|on|after)|available again (?:at|on)|reopens?(?:\\s+(?:at|on))?|retry (?:at|after))";
const WEEKDAY_SOURCE = "(?<weekday>sun|mon|tue|wed|thu|fri|sat)[a-z]*\\.?";
const MONTH_DAY_SOURCE =
  "(?<month>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+(?<monthDay>\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(?<year>\\d{4}))?";
const TOMORROW_SOURCE = "(?<tomorrow>tomorrow)";
const DAY_SPEC_SOURCE = `(?:${WEEKDAY_SOURCE}|${MONTH_DAY_SOURCE}|${TOMORROW_SOURCE})`;
const TIME_SOURCE = "(?<hour>\\d{1,2})(?::(?<minute>\\d{2}))?(?:\\s*(?<meridiem>[ap])\\.?m\\.?)?";
const ZONE_SOURCE = "(?:\\s*\\((?<zone>[^)]+)\\)|\\s+(?<zoneAbbreviation>UTC|GMT))?";

const RESET_CLOCK_PATTERN = new RegExp(
  `\\b${RESET_LEAD_SOURCE}\\s+(?:${DAY_SPEC_SOURCE}[,\\s]+(?:at\\s+)?)?${TIME_SOURCE}(?![\\d:])${ZONE_SOURCE}`,
  "i",
);
const RESET_DAY_ONLY_PATTERN = new RegExp(`\\b${RESET_LEAD_SOURCE}\\s+${DAY_SPEC_SOURCE}${ZONE_SOURCE}`, "i");
const ISO_INSTANT_PATTERN =
  /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i;
const DURATION_UNIT_SOURCE = "(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)(?![a-z])";
const DURATION_PATTERN = new RegExp(
  `\\b(?:in|after|within|wait|retry[_ ]?delay["']?\\s*:)\\s*["']?((?:\\d+(?:\\.\\d+)?\\s*${DURATION_UNIT_SOURCE}[\\s,]*(?:and\\s+)?)+)`,
  "i",
);
const DURATION_PART_PATTERN = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${DURATION_UNIT_SOURCE})`, "gi");
const RETRY_AFTER_SECONDS_PATTERN = /\bretry-after:?\s*(\d+)\b/i;

export interface QuotaRefusal {
  message: string;
  resetsAtSeconds: number | null;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  weekday: number;
  minutes: number;
}

function readWallClock(now: number, timeZone: string | undefined): WallClock | null {
  try {
    const formatter = new Intl.DateTimeFormat(CLOCK_LOCALE, {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const nowDate = new Date(now);
    const parts = formatter.formatToParts(nowDate);
    const partValue = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    const weekdayText = partValue("weekday").toLowerCase();
    const weekdayKey = weekdayText.slice(0, WEEKDAY_ABBREVIATION_LENGTH);
    const weekday = WEEKDAY_ABBREVIATIONS.indexOf(weekdayKey);
    const year = Number(partValue("year"));
    const month = Number(partValue("month"));
    const day = Number(partValue("day"));
    const hour = Number(partValue("hour"));
    const minute = Number(partValue("minute"));
    const numbers = [year, month, day, hour, minute];
    const allReadable = numbers.every(Number.isFinite) && weekday >= 0;
    if (!allReadable) return null;
    return { year, month, day, weekday, minutes: hour * MINUTES_PER_HOUR + minute };
  } catch {
    return null;
  }
}

function zonedWallClock(now: number, zone: string | undefined): WallClock | null {
  const trimmedZone = zone?.trim();
  const zoned = readWallClock(now, trimmedZone);
  return zoned ?? readWallClock(now, undefined);
}

function targetMinutesOfDay(hourText: string | undefined, minuteText: string | undefined, meridiem: string | undefined): number | null {
  if (hourText === undefined) return 0;
  const rawHour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  const hasMeridiem = meridiem !== undefined;
  const isPm = meridiem?.toLowerCase() === PM_MERIDIEM;
  const isMidnightHour = hasMeridiem && !isPm && rawHour === NOON_HOUR;
  const isAfternoonHour = isPm && rawHour < NOON_HOUR;
  const hour = isMidnightHour ? 0 : isAfternoonHour ? rawHour + NOON_HOUR : rawHour;
  const isValid = hour < HOURS_PER_DAY && minute < MINUTES_PER_HOUR;
  return isValid ? hour * MINUTES_PER_HOUR + minute : null;
}

function dayNumber(year: number, month: number, day: number): number {
  const monthIndex = month - FIRST_MONTH_NUMBER;
  const utcMidnight = Date.UTC(year, monthIndex, day);
  return Math.round(utcMidnight / MILLIS_PER_DAY);
}

function daysAheadFor(groups: Record<string, string | undefined>, clock: WallClock, targetMinutes: number): number {
  const timeAlreadyPassed = targetMinutes < clock.minutes;
  if (groups.tomorrow) return 1;
  if (groups.weekday) {
    const weekdayKey = groups.weekday.toLowerCase();
    const targetWeekday = WEEKDAY_ABBREVIATIONS.indexOf(weekdayKey);
    const ahead = (targetWeekday - clock.weekday + DAYS_PER_WEEK) % DAYS_PER_WEEK;
    const isLaterToday = ahead === 0 && !timeAlreadyPassed;
    return ahead === 0 && !isLaterToday ? DAYS_PER_WEEK : ahead;
  }
  if (groups.month && groups.monthDay) {
    const monthKey = groups.month.toLowerCase();
    const targetMonth = MONTH_ABBREVIATIONS.indexOf(monthKey) + FIRST_MONTH_NUMBER;
    const targetDay = Number(groups.monthDay);
    const statedYear = groups.year ? Number(groups.year) : null;
    const today = dayNumber(clock.year, clock.month, clock.day);
    const thisYearTarget = dayNumber(statedYear ?? clock.year, targetMonth, targetDay);
    const isPastWithoutYear = statedYear === null && thisYearTarget < today;
    const nextYearTarget = dayNumber(clock.year + 1, targetMonth, targetDay);
    const target = isPastWithoutYear ? nextYearTarget : thisYearTarget;
    return target - today;
  }
  return timeAlreadyPassed ? 1 : 0;
}

function resetFromClockMatch(match: RegExpMatchArray | null, now: number): number | null {
  const groups = match?.groups;
  if (!groups) return null;
  const targetMinutes = targetMinutesOfDay(groups.hour, groups.minute, groups.meridiem);
  if (targetMinutes === null) return null;
  const zone = groups.zone ?? groups.zoneAbbreviation;
  const clock = zonedWallClock(now, zone);
  if (!clock) return null;
  const daysAhead = daysAheadFor(groups, clock, targetMinutes);
  const minutesAhead = daysAhead * MINUTES_PER_DAY + targetMinutes - clock.minutes;
  const nowDate = new Date(now);
  const secondsIntoMinute = nowDate.getSeconds();
  const millisIntoSecond = nowDate.getMilliseconds();
  return now + minutesAhead * MILLIS_PER_MINUTE - secondsIntoMinute * MILLIS_PER_SECOND - millisIntoSecond;
}

function resetFromClock(message: string, now: number): number | null {
  const withTime = message.match(RESET_CLOCK_PATTERN);
  const fromTime = resetFromClockMatch(withTime, now);
  if (fromTime !== null) return fromTime;
  const dayOnly = message.match(RESET_DAY_ONLY_PATTERN);
  return resetFromClockMatch(dayOnly, now);
}

function resetFromIsoInstant(message: string): number | null {
  const instant = message.match(ISO_INSTANT_PATTERN)?.[1];
  if (!instant) return null;
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetFromDuration(message: string, now: number): number | null {
  const durationText = message.match(DURATION_PATTERN)?.[1];
  if (!durationText) return null;
  const partMatches = durationText.matchAll(DURATION_PART_PATTERN);
  const parts = [...partMatches];
  const totalMillis = parts.reduce((sum, part) => {
    const amount = Number(part[1]);
    const unitKey = part[2].charAt(0).toLowerCase();
    const unitMillis = UNIT_MILLIS[unitKey] ?? 0;
    return sum + amount * unitMillis;
  }, 0);
  return totalMillis > 0 ? now + totalMillis : null;
}

function resetFromRetryAfter(message: string, now: number): number | null {
  const secondsText = message.match(RETRY_AFTER_SECONDS_PATTERN)?.[1];
  if (!secondsText) return null;
  const seconds = Number(secondsText);
  return now + seconds * MILLIS_PER_SECOND;
}

export function resumeTimeForRefusal(refusal: QuotaRefusal, now: number): number {
  const { message, resetsAtSeconds } = refusal;
  const stamped = resetsAtSeconds === null ? null : resetsAtSeconds * MILLIS_PER_SECOND;
  const fromIsoInstant = resetFromIsoInstant(message);
  const fromClock = resetFromClock(message, now);
  const fromDuration = resetFromDuration(message, now);
  const fromRetryAfter = resetFromRetryAfter(message, now);
  const reset = stamped ?? fromIsoInstant ?? fromClock ?? fromDuration ?? fromRetryAfter;
  if (reset === null) return now + UNKNOWN_RESET_PROBE_MS;
  const withGrace = reset + RESUME_GRACE_MS;
  const earliest = now + MIN_RESUME_DELAY_MS;
  return Math.max(withGrace, earliest);
}

export function quotaResumeTime(rawError: string, now: number): number | null {
  const error = parseClaudeError(rawError);
  if (!error.isQuotaExceeded) return null;
  const isBilling = isBillingRefusal(error.message);
  if (isBilling) return null;
  const refusal: QuotaRefusal = { message: error.message, resetsAtSeconds: error.resetsAt };
  return resumeTimeForRefusal(refusal, now);
}

export async function resolveQuotaResumeTime(rawError: string, now: number): Promise<number | null> {
  const fromMarkedRefusal = quotaResumeTime(rawError, now);
  if (fromMarkedRefusal !== null) return fromMarkedRefusal;
  const classification = aiClassifyFailure(rawError);
  const failure = await classification.catch(() => null);
  const isQuota = failure?.kind === QUOTA_FAILURE_KIND;
  if (!failure || !isQuota) return null;
  const isBilling = isBillingRefusal(failure.message);
  if (isBilling) return null;
  const refusal: QuotaRefusal = { message: failure.message, resetsAtSeconds: failure.resets_at };
  return resumeTimeForRefusal(refusal, now);
}
