import { locale } from "./i18n";

/**
 * "hace 3 min", "ayer" — a timestamp as the thing a person actually wants to know.
 *
 * # Why not `toLocaleString()`
 *
 * That is what the commit sheet used, and on a phone it produces `23/8/2026, 19:04:11` in a column
 * 40 characters wide. The question somebody opens this app to ask is not *when* the agent committed,
 * it is *how long ago* — "did the thing I left running finish while I was at lunch". A relative time
 * answers that without arithmetic.
 *
 * `Intl.RelativeTimeFormat` is in every browser this client can run in and needs no table of its
 * own, so both languages come for free and stay correct for the plurals neither of us would get
 * right by hand.
 */
const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });

const MINUTE = 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;

/** A Unix timestamp in **seconds**, as git reports them. */
export function since(unixSeconds: number): string {
  const delta = Math.round(unixSeconds - Date.now() / 1000);
  const magnitude = Math.abs(delta);
  if (magnitude < MINUTE) return relative.format(Math.round(delta), "second");
  if (magnitude < HOUR) return relative.format(Math.round(delta / MINUTE), "minute");
  if (magnitude < DAY) return relative.format(Math.round(delta / HOUR), "hour");
  if (magnitude < DAY * 30) return relative.format(Math.round(delta / DAY), "day");
  // Past a month the relative form stops helping — "hace 7 meses" is not more useful than a date,
  // and it is less precise. The date is short-form on purpose: this sits in a 40-character row.
  return new Date(unixSeconds * 1000).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The same, for the ISO strings the database columns carry. Invalid input renders as nothing
 *  rather than as `Invalid Date`, which is a string no user should ever be shown. */
export function sinceIso(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : since(ms / 1000);
}

/** An absolute timestamp, for the one place that needs it: a commit's own detail screen, where the
 *  exact moment is part of what is being inspected. */
export function absolute(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
