/**
 * Time tools: Unix timestamps in any unit, a date in many time zones, the distance between two
 * dates, adding a duration, and ISO-8601 durations (`P1DT2H`).
 */

export type TimestampUnit = "s" | "ms" | "us" | "ns";

/** The unit a bare number most likely is, from how many digits it has (for dates near today). */
export function guessUnit(digits: string): TimestampUnit {
  const n = digits.replace(/^-/, "").replace(/\..*$/, "").length;
  if (n <= 11) return "s";
  if (n <= 14) return "ms";
  if (n <= 17) return "us";
  return "ns";
}

/** Milliseconds since the epoch for a timestamp in `unit` (BigInt-safe for µs and ns). */
export function timestampToMs(text: string, unit: TimestampUnit): number {
  const clean = text.trim().replace(/[_,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(clean)) throw new Error("Not a number");
  if (unit === "s") return Math.round(Number(clean) * 1000);
  if (unit === "ms") return Math.round(Number(clean));
  const int = BigInt(clean.split(".")[0]);
  return Number(unit === "us" ? int / 1000n : int / 1000000n);
}

/**
 * A date from what someone pasted: a Unix timestamp (unit guessed unless given), an ISO-8601 or
 * RFC 2822 string, or `now`.
 */
export function parseDateInput(text: string, unit: TimestampUnit | "auto" = "auto"): { date: Date; unit: TimestampUnit | null } {
  const t = text.trim();
  if (!t || /^now$|^ahora$/i.test(t)) return { date: new Date(), unit: null };
  if (/^-?[\d_,]+(\.\d+)?$/.test(t)) {
    const u = unit === "auto" ? guessUnit(t.replace(/[_,]/g, "")) : unit;
    const date = new Date(timestampToMs(t, u));
    if (Number.isNaN(date.getTime())) throw new Error("Out of range");
    return { date, unit: u };
  }
  const date = new Date(t);
  if (Number.isNaN(date.getTime())) throw new Error("Not a date or timestamp");
  return { date, unit: null };
}

/** `+03:00` style offset of `zone` at `date`, in minutes east of UTC. */
export function zoneOffsetMinutes(date: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** `2026-10-23 14:05:09 -03:00` in `zone`. */
export function formatInZone(date: Date, zone: string): string {
  const offset = zoneOffsetMinutes(date, zone);
  const shifted = new Date(date.getTime() + offset * 60000);
  return `${shifted.toISOString().slice(0, 19).replace("T", " ")} ${formatOffset(offset)}`;
}

/** ISO-8601 with the local offset rather than `Z`. */
export function toLocalIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const shifted = new Date(date.getTime() + offset * 60000);
  return `${shifted.toISOString().slice(0, 23)}${formatOffset(offset)}`;
}

export const COMMON_ZONES = [
  "UTC",
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "America/Lima",
  "America/Bogota",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

export function allZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.("timeZone");
    if (zones?.length) return Array.from(new Set(["UTC", ...zones]));
  } catch {
    // Older engines: the common list is still useful.
  }
  return COMMON_ZONES;
}

/** "in 3 hours" / "hace 2 días", the largest unit that is at least one. */
export function relativeTime(date: Date, language: string, now = Date.now()): string {
  const seconds = Math.round((date.getTime() - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size || unit === "second") return rtf.format(Math.round(seconds / size), unit);
  }
  return "";
}

// ---------------------------------------------------------------------------------------------
// Differences and durations
// ---------------------------------------------------------------------------------------------

export interface CalendarDiff {
  negative: boolean;
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  totalSeconds: number;
  totalDays: number;
  /** Weekdays (Mon–Fri) from the earlier date up to, not including, the later one. */
  businessDays: number;
}

/** `date` plus `months` calendar months, the day clamped to the target month (31 Jan + 1 = 29 Feb). */
function addMonthsClamped(date: Date, months: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), last));
  return target;
}

export function dateDiff(a: Date, b: Date): CalendarDiff {
  const negative = b.getTime() < a.getTime();
  const [from, to] = negative ? [b, a] : [a, b];
  // Whole months first (clamped, so a month from 31 January is the end of February), then what is
  // left as days and time — the way people count "1 month and 3 days".
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  while (months > 0 && addMonthsClamped(from, months) > to) months--;
  const anchor = addMonthsClamped(from, months);
  let rest = to.getTime() - anchor.getTime();
  const days = Math.floor(rest / 86400000);
  rest -= days * 86400000;
  const ms = rest;
  const years = Math.floor(months / 12);
  months %= 12;
  const totalSeconds = Math.floor((to.getTime() - from.getTime()) / 1000);
  let businessDays = 0;
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  // Bounded: a century of days is 36 525 iterations.
  for (let n = 0; cursor < end && n < 40000; n++) {
    const d = cursor.getDay();
    if (d !== 0 && d !== 6) businessDays++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return {
    negative,
    years,
    months,
    days,
    hours: Math.floor(ms / 3600000),
    minutes: Math.floor((ms % 3600000) / 60000),
    seconds: Math.floor((ms % 60000) / 1000),
    totalSeconds,
    totalDays: totalSeconds / 86400,
    businessDays,
  };
}

export interface DurationParts {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export const EMPTY_DURATION: DurationParts = { years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };

/** Calendar arithmetic: months are added as months (31 Jan + 1 month = 28/29 Feb's overflow, as JS does). */
export function addDuration(date: Date, d: DurationParts, sign: 1 | -1 = 1): Date {
  const out = new Date(date.getTime());
  out.setFullYear(out.getFullYear() + sign * d.years, out.getMonth() + sign * d.months, out.getDate() + sign * (d.days + d.weeks * 7));
  out.setTime(out.getTime() + sign * ((d.hours * 3600 + d.minutes * 60) * 1000 + Math.round(d.seconds * 1000)));
  return out;
}

export function parseIsoDuration(text: string): { parts: DurationParts; negative: boolean } {
  const m = /^([+-])?P(?:(\d+(?:[.,]\d+)?)Y)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)W)?(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/i.exec(
    text.trim(),
  );
  if (!m || text.trim().replace(/^[+-]/, "").toUpperCase() === "P" || /T$/i.test(text.trim())) {
    throw new Error("Not an ISO-8601 duration (e.g. P1Y2M10DT2H30M)");
  }
  const n = (v: string | undefined) => (v ? Number(v.replace(",", ".")) : 0);
  return {
    negative: m[1] === "-",
    parts: { years: n(m[2]), months: n(m[3]), weeks: n(m[4]), days: n(m[5]), hours: n(m[6]), minutes: n(m[7]), seconds: n(m[8]) },
  };
}

/** Nominal seconds: a year of 365 days and a month of 30, the convention when there is no anchor. */
export function durationSeconds(d: DurationParts): number {
  return (((d.years * 365 + d.months * 30 + d.weeks * 7 + d.days) * 24 + d.hours) * 60 + d.minutes) * 60 + d.seconds;
}

export function formatIsoDuration(d: DurationParts, negative = false): string {
  const date = [d.years && `${d.years}Y`, d.months && `${d.months}M`, d.weeks && `${d.weeks}W`, d.days && `${d.days}D`].filter(Boolean).join("");
  const time = [d.hours && `${d.hours}H`, d.minutes && `${d.minutes}M`, d.seconds && `${d.seconds}S`].filter(Boolean).join("");
  const body = `P${date}${time ? `T${time}` : ""}`;
  return `${negative ? "-" : ""}${body === "P" ? "PT0S" : body}`;
}

/** Seconds as days/hours/minutes/seconds — the inverse of `durationSeconds` for the time part. */
export function secondsToDuration(total: number): DurationParts {
  const s = Math.abs(total);
  return {
    ...EMPTY_DURATION,
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: Math.round((s % 60) * 1000) / 1000,
  };
}
