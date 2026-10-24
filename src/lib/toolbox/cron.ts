/**
 * Cron expressions: parsed, explained in words (Spanish or English) and run forward to list the
 * next times they fire.
 *
 * Five fields (`min hour day month weekday`, Vixie/crontab, GitHub Actions, Kubernetes) or six with
 * seconds first (Spring, Quartz without the year), plus the `@daily` family. When both day-of-month
 * and day-of-week are restricted the job runs when *either* matches — crontab's rule, and the one
 * people forget.
 */

export type Lang = "es" | "en";

interface FieldSpec {
  min: number;
  max: number;
  names?: string[];
}

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const FIELDS: Record<"second" | "minute" | "hour" | "dom" | "month" | "dow", FieldSpec> = {
  second: { min: 0, max: 59 },
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12, names: MONTH_NAMES },
  dow: { min: 0, max: 7, names: DAY_NAMES },
};

export interface CronField {
  /** The allowed values, sorted. */
  values: number[];
  /** Written as `*` (or `?`): every value. */
  any: boolean;
  /** The source text, for explaining it the way it was written. */
  source: string;
}

export interface ParsedCron {
  second: CronField;
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
  hasSeconds: boolean;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function parseValue(text: string, spec: FieldSpec, field: string): number {
  const upper = text.toUpperCase();
  const named = spec.names?.indexOf(upper.slice(0, 3)) ?? -1;
  if (named >= 0 && /^[A-Z]{3}$/.test(upper)) return named + (spec.names === MONTH_NAMES ? 1 : 0);
  if (!/^\d+$/.test(text)) throw new Error(`Invalid value "${text}" in the ${field} field`);
  const n = Number(text);
  if (n < spec.min || n > spec.max) throw new Error(`${n} is out of range for the ${field} field (${spec.min}–${spec.max})`);
  return n;
}

function parseField(text: string, spec: FieldSpec, field: string): CronField {
  // Names first (`WED` and `JUL` have a W and an L of their own).
  if (/[LW#]/.test(text.toUpperCase().replace(/[A-Z]{3}/g, ""))) {
    throw new Error(`"${text}": L, W and # are Quartz extensions this explainer does not read`);
  }
  const set = new Set<number>();
  const any = text === "*" || text === "?";
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step "${stepText}" in the ${field} field`);
    let lo: number;
    let hi: number;
    if (range === "*" || range === "?") {
      lo = spec.min;
      hi = field === "weekday" ? 6 : spec.max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = parseValue(a, spec, field);
      hi = parseValue(b, spec, field);
      if (hi < lo) throw new Error(`Range ${range} goes backwards in the ${field} field`);
    } else {
      lo = parseValue(range, spec, field);
      hi = stepText === undefined ? lo : field === "weekday" ? 6 : spec.max;
    }
    for (let v = lo; v <= hi; v += step) set.add(field === "weekday" && v === 7 ? 0 : v);
  }
  return { values: [...set].sort((a, b) => a - b), any, source: text };
}

export function parseCron(expression: string): ParsedCron {
  let text = expression.trim().replace(/\s+/g, " ");
  if (text.toLowerCase() === "@reboot") throw new Error("@reboot runs at startup, not on a schedule");
  text = MACROS[text.toLowerCase()] ?? text;
  const parts = text.split(" ");
  if (parts.length !== 5 && parts.length !== 6) throw new Error("A cron expression has 5 fields (or 6 with seconds first)");
  const hasSeconds = parts.length === 6;
  const [sec, min, hour, dom, month, dow] = hasSeconds ? parts : ["0", ...parts];
  return {
    second: parseField(sec, FIELDS.second, "second"),
    minute: parseField(min, FIELDS.minute, "minute"),
    hour: parseField(hour, FIELDS.hour, "hour"),
    dom: parseField(dom, FIELDS.dom, "day-of-month"),
    month: parseField(month, FIELDS.month, "month"),
    dow: parseField(dow, FIELDS.dow, "weekday"),
    hasSeconds,
  };
}

// ---------------------------------------------------------------------------------------------
// Next runs
// ---------------------------------------------------------------------------------------------

function dayMatches(c: ParsedCron, dom: number, dow: number): boolean {
  const domOk = c.dom.values.includes(dom);
  const dowOk = c.dow.values.includes(dow);
  if (c.dom.any && c.dow.any) return true;
  if (c.dom.any) return dowOk;
  if (c.dow.any) return domOk;
  return domOk || dowOk;
}

/**
 * The next `count` times after `from`. `utc` evaluates the fields in UTC (what GitHub Actions and
 * most clouds do); otherwise in the machine's zone.
 */
export function nextRuns(c: ParsedCron, from: Date, count: number, utc = false): Date[] {
  const get = utc
    ? (d: Date) => ({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() })
    : (d: Date) => ({ y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), dow: d.getDay(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() });
  const make = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
    utc ? new Date(Date.UTC(y, mo - 1, d, h, mi, s)) : new Date(y, mo - 1, d, h, mi, s);
  const out: Date[] = [];
  let t = new Date(Math.floor(from.getTime() / 1000) * 1000 + 1000);
  // Bounded: the rarest schedule cron can express (29 February on a Monday) recurs within 28 years.
  for (let guard = 0; out.length < count && guard < 200000; guard++) {
    const p = get(t);
    if (p.y > get(from).y + 30) break;
    if (!c.month.values.includes(p.mo)) {
      t = make(p.y, p.mo + 1, 1, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, p.d, p.dow)) {
      t = make(p.y, p.mo, p.d + 1, 0, 0, 0);
      continue;
    }
    if (!c.hour.values.includes(p.h)) {
      t = make(p.y, p.mo, p.d, p.h + 1, 0, 0);
      continue;
    }
    if (!c.minute.values.includes(p.mi)) {
      t = make(p.y, p.mo, p.d, p.h, p.mi + 1, 0);
      continue;
    }
    if (!c.second.values.includes(p.s)) {
      const next = c.second.values.find((s) => s > p.s);
      t = next === undefined ? make(p.y, p.mo, p.d, p.h, p.mi + 1, 0) : make(p.y, p.mo, p.d, p.h, p.mi, next);
      continue;
    }
    out.push(t);
    t = new Date(t.getTime() + 1000);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// In words
// ---------------------------------------------------------------------------------------------

const WORDS = {
  en: {
    months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    and: "and",
    through: "through",
    everySecond: "every second",
    everyMinute: "every minute",
    everyNSeconds: (n: number) => `every ${n} seconds`,
    everyNMinutes: (n: number) => `every ${n} minutes`,
    everyNHours: (n: number) => `every ${n} hours`,
    atSeconds: (l: string) => `at second ${l}`,
    atMinutes: (l: string) => `at minute ${l}`,
    pastHour: (l: string) => `of hour ${l}`,
    at: (l: string) => `at ${l}`,
    between: (a: string, b: string) => `between ${a} and ${b}`,
    onDom: (l: string) => `on day ${l} of the month`,
    everyNDays: (n: number) => `every ${n} days`,
    inMonths: (l: string) => `in ${l}`,
    onDow: (l: string) => `on ${l}`,
    or: "or",
    everyDay: "every day",
  },
  es: {
    months: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    days: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
    and: "y",
    through: "a",
    everySecond: "cada segundo",
    everyMinute: "cada minuto",
    everyNSeconds: (n: number) => `cada ${n} segundos`,
    everyNMinutes: (n: number) => `cada ${n} minutos`,
    everyNHours: (n: number) => `cada ${n} horas`,
    atSeconds: (l: string) => `en el segundo ${l}`,
    atMinutes: (l: string) => `en el minuto ${l}`,
    pastHour: (l: string) => `de la hora ${l}`,
    at: (l: string) => `a las ${l}`,
    between: (a: string, b: string) => `entre las ${a} y las ${b}`,
    onDom: (l: string) => `el día ${l} del mes`,
    everyNDays: (n: number) => `cada ${n} días`,
    inMonths: (l: string) => `en ${l}`,
    onDow: (l: string) => `los ${l}`,
    or: "o",
    everyDay: "todos los días",
  },
};

const pad = (n: number) => String(n).padStart(2, "0");

function list(items: string[], lang: Lang, joiner?: string): string {
  const and = joiner ?? WORDS[lang].and;
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;
}

/** `*\/n` written over the field's whole range. */
function stepOf(field: CronField): number | null {
  const m = /^(?:\*|\?|0)\/(\d+)$/.exec(field.source);
  return m ? Number(m[1]) : null;
}

/** A single contiguous range `a-b` (possibly from a list that happens to be contiguous). */
function rangeOf(field: CronField): [number, number] | null {
  const m = /^(\w+)-(\w+)$/.exec(field.source);
  if (!m || field.values.length < 2) return null;
  return [field.values[0], field.values[field.values.length - 1]];
}

export function describeCron(c: ParsedCron, lang: Lang): string {
  const w = WORDS[lang];
  const parts: string[] = [];
  const singleSecond = c.second.values.length === 1;
  const singleMinute = c.minute.values.length === 1 && !c.minute.any;
  const hourValues = c.hour.values;

  // Time of day.
  if (singleMinute && !c.hour.any && hourValues.length <= 6 && !stepOf(c.hour) && !rangeOf(c.hour) && singleSecond) {
    const sec = c.hasSeconds && c.second.values[0] !== 0 ? `:${pad(c.second.values[0])}` : "";
    parts.push(w.at(list(hourValues.map((h) => `${pad(h)}:${pad(c.minute.values[0])}${sec}`), lang)));
  } else {
    if (c.hasSeconds && !(singleSecond && c.second.values[0] === 0)) {
      const step = stepOf(c.second);
      parts.push(c.second.any ? w.everySecond : step ? w.everyNSeconds(step) : w.atSeconds(list(c.second.values.map(String), lang)));
    }
    const mStep = stepOf(c.minute);
    const mRange = rangeOf(c.minute);
    if (c.minute.any) {
      // "Every 10 seconds" already says it; "every minute" after it would be wrong.
      if (!(c.hasSeconds && !singleSecond)) parts.push(w.everyMinute);
    } else if (mStep) parts.push(w.everyNMinutes(mStep));
    else if (mRange) parts.push(`${w.atMinutes(`${mRange[0]}`)} ${w.through} ${mRange[1]}`);
    else parts.push(w.atMinutes(list(c.minute.values.map(String), lang)));

    const hStep = stepOf(c.hour);
    const hRange = rangeOf(c.hour);
    if (c.hour.any) {
      // Every hour: nothing to add.
    } else if (hStep) parts.push(w.everyNHours(hStep));
    else if (hRange) parts.push(w.between(`${pad(hRange[0])}:00`, `${pad(hRange[1])}:59`));
    else parts.push(w.pastHour(list(hourValues.map((h) => pad(h)), lang)));
  }

  // Days.
  const dayParts: string[] = [];
  if (!c.dom.any) {
    const step = /^(?:\*|1)\/(\d+)$/.exec(c.dom.source);
    const range = rangeOf(c.dom);
    dayParts.push(step ? w.everyNDays(Number(step[1])) : range ? w.onDom(`${range[0]} ${w.through} ${range[1]}`) : w.onDom(list(c.dom.values.map(String), lang)));
  }
  if (!c.dow.any) {
    const range = rangeOf(c.dow);
    const names = range && range[0] < range[1] ? `${w.days[range[0]]} ${w.through} ${w.days[range[1]]}` : list(c.dow.values.map((d) => w.days[d]), lang);
    dayParts.push(w.onDow(names));
  }
  if (dayParts.length) parts.push(dayParts.join(` ${w.or} `));
  if (!c.month.any) {
    const range = rangeOf(c.month);
    parts.push(
      w.inMonths(range ? `${w.months[range[0] - 1]} ${w.through} ${w.months[range[1] - 1]}` : list(c.month.values.map((m) => w.months[m - 1]), lang)),
    );
  }
  if (c.dom.any && c.dow.any && c.month.any && !c.hour.any && singleMinute) parts.push(w.everyDay);

  const text = parts.filter(Boolean).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
