const formatters = new Map<string, Intl.RelativeTimeFormat>();

/** "hace 5 min" for the last week, the date after that — when something happened is read relative
 *  while it is recent and by its date once it is not. In the app's language. */
export function ago(seconds: number, locale: string, now = Date.now()): string {
  const delta = Math.round(seconds - now / 1000);
  const absolute = Math.abs(delta);
  if (absolute > 7 * 86400) return new Date(seconds * 1000).toLocaleDateString(locale, { day: "numeric", month: "short" });
  let formatter = formatters.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    formatters.set(locale, formatter);
  }
  for (const [unit, size] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ] as [Intl.RelativeTimeFormatUnit, number][]) {
    if (absolute >= size) return formatter.format(Math.round(delta / size), unit);
  }
  return formatter.format(0, "minute");
}
