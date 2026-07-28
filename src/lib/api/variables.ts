/**
 * `{{variable}}` interpolation for the API client.
 *
 * Two rules drive everything here:
 *
 * 1. **Precedence is `VARIABLE_SCOPE_ORDER`** (local → data → environment → collection → global),
 *    so a script write or a runner data column always beats the environment it was seeded from.
 * 2. **An unresolved token is left exactly as typed.** Blanking `{{baseUrl}}` because of a typo
 *    turns a misconfiguration into a 404 against a URL nobody can see; leaving it in place puts
 *    the literal `{{baseUrl}}` in the console, the snippet and the error, and `findUnresolved`
 *    lets the editor paint it red before Send is ever pressed.
 */

import { VARIABLE_SCOPE_ORDER } from "../../types/api";
import type { ApiVariable, KeyValue, VariableScope } from "../../types/api";

export interface VariableContext {
  /** Written by pre-request/test scripts during this run; discarded when the run ends. */
  local: Record<string, string>;
  /** The runner's current data row. */
  data: Record<string, string>;
  environment: ApiVariable[];
  collection: ApiVariable[];
  global: ApiVariable[];
  /** Which collection the `collection` scope came from. Carried here rather than passed alongside
   * so that any field already receiving a context can write a collection variable back (the
   * editor in the quick-look popover) without every call site having to thread an extra prop. */
  collectionId?: string | null;
}

export function emptyVariableContext(): VariableContext {
  return { local: {}, data: {}, environment: [], collection: [], global: [] };
}

/** Inner group is the raw name; `[^{}]*` keeps the match from spanning two adjacent tokens. */
const VARIABLE_PATTERN = /\{\{([^{}]*)\}\}/g;

/**
 * How many substitution passes a single string gets. Values that reference other variables are
 * the point (`{{host}}` inside `{{baseUrl}}`), but two variables referencing each other would
 * otherwise spin forever on the UI thread — every keystroke in the URL bar runs this.
 */
const MAX_RESOLVE_DEPTH = 10;

/** `currentValue` is what a script or the environment editor last set; `initialValue` is the
 * shared default it falls back to. An empty current value means "not overridden", not "empty". */
function valueOf(variable: ApiVariable): string {
  return variable.currentValue !== "" ? variable.currentValue : variable.initialValue;
}

function lookupInList(name: string, list: ApiVariable[]): string | null {
  for (const variable of list) {
    if (variable.enabled && variable.key === name) return valueOf(variable);
  }
  return null;
}

function lookupInScope(name: string, scope: VariableScope, ctx: VariableContext): string | null {
  switch (scope) {
    case "local":
      return Object.prototype.hasOwnProperty.call(ctx.local, name) ? ctx.local[name] : null;
    case "data":
      return Object.prototype.hasOwnProperty.call(ctx.data, name) ? ctx.data[name] : null;
    case "environment":
      return lookupInList(name, ctx.environment);
    case "collection":
      return lookupInList(name, ctx.collection);
    case "global":
      return lookupInList(name, ctx.global);
  }
}

/** The winning definition of `name`, or `null` when nothing enabled defines it. The scope comes
 * back with the value because the quick-look popover shows where a value came from. */
export function lookupVariable(
  name: string,
  ctx: VariableContext,
): { value: string; scope: VariableScope } | null {
  for (const scope of VARIABLE_SCOPE_ORDER) {
    const value = lookupInScope(name, scope, ctx);
    if (value !== null) return { value, scope };
  }
  return null;
}

/**
 * Every variable the context defines, in resolution order and de-duplicated — so the entry listed
 * for a name is the one that would actually win, and a shadowed definition never shows up twice.
 * Disabled variables are left out: they resolve to nothing, so offering them would suggest a token
 * that paints red the moment it's inserted.
 *
 * This is the `{{` autocomplete's catalogue.
 */
export function listVariables(ctx: VariableContext): { name: string; value: string; scope: VariableScope }[] {
  const seen = new Set<string>();
  const out: { name: string; value: string; scope: VariableScope }[] = [];
  const add = (name: string, value: string, scope: VariableScope) => {
    if (name === "" || seen.has(name)) return;
    seen.add(name);
    out.push({ name, value, scope });
  };

  for (const scope of VARIABLE_SCOPE_ORDER) {
    if (scope === "local" || scope === "data") {
      for (const [name, value] of Object.entries(scope === "local" ? ctx.local : ctx.data)) {
        add(name, value, scope);
      }
      continue;
    }
    const list = scope === "environment" ? ctx.environment : scope === "collection" ? ctx.collection : ctx.global;
    for (const variable of list) {
      if (variable.enabled) add(variable.key, valueOf(variable), scope);
    }
  }
  return out;
}

/** Substitutes every `{{name}}` and `{{$dynamic}}` it can, leaving the rest untouched. */
export function resolve(text: string, ctx: VariableContext): string {
  if (!text.includes("{{")) return text;

  let out = text;
  for (let pass = 0; pass < MAX_RESOLVE_DEPTH; pass++) {
    let substituted = false;
    out = out.replace(VARIABLE_PATTERN, (token, rawName: string) => {
      const name = rawName.trim();
      if (name === "") return token;

      // Dynamic variables win over a user variable of the same name, as they do in Postman, and
      // are evaluated per occurrence — two `{{$guid}}` in one body are meant to differ.
      const dynamic = evalDynamic(name);
      if (dynamic !== null) {
        substituted = true;
        return dynamic;
      }

      const found = lookupVariable(name, ctx);
      if (found === null) return token;
      substituted = true;
      return found.value;
    });
    if (!substituted) break;
  }
  return out;
}

/**
 * Resolves `key`, `value` and the file `src` of every row, disabled ones included — filtering is
 * the caller's job, and a row that is toggled back on shouldn't need a second resolve pass.
 * `description` is UI-only and left verbatim.
 */
export function resolveKeyValues(rows: KeyValue[], ctx: VariableContext): KeyValue[] {
  return rows.map((row) => ({
    ...row,
    key: resolve(row.key, ctx),
    value: resolve(row.value, ctx),
    ...(row.src === undefined ? {} : { src: resolve(row.src, ctx) }),
  }));
}

/**
 * Names still unresolved once `text` has been fully expanded, in first-appearance order and
 * de-duplicated. Runs the real resolution rather than a shallow scan so a variable whose *value*
 * references a missing one is reported too.
 */
export function findUnresolved(text: string, ctx: VariableContext): string[] {
  if (!text.includes("{{")) return [];

  const names: string[] = [];
  for (const match of resolve(text, ctx).matchAll(VARIABLE_PATTERN)) {
    const name = match[1].trim();
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Dynamic variables
// ---------------------------------------------------------------------------

/**
 * Word lists are deliberately tiny and hand-rolled: faker is ~5 MB and this app ships nothing at
 * runtime it doesn't need. The output only has to be plausible filler for a request body.
 */
const FIRST_NAMES = [
  "Ada", "Bruno", "Camila", "Diego", "Elena", "Felipe", "Greta", "Hugo", "Irene", "Javier",
  "Karla", "Lucas", "Marta", "Nicolas", "Olivia", "Pablo", "Quinn", "Rosa", "Sergio", "Tomas",
  "Ursula", "Valeria", "Walter", "Ximena", "Yolanda", "Zoe",
];

const LAST_NAMES = [
  "Alvarez", "Brenner", "Castillo", "Duarte", "Escobar", "Ferrari", "Gallardo", "Herrera",
  "Ibarra", "Jimenez", "Klein", "Larsen", "Molina", "Novak", "Ortega", "Pereira", "Quiroga",
  "Rivas", "Salazar", "Tovar", "Ulloa", "Vega", "Wagner", "Zamora",
];

const WORDS = [
  "alpha", "anchor", "beacon", "bridge", "canvas", "cipher", "cluster", "compass", "delta",
  "engine", "fabric", "forge", "gateway", "harbor", "index", "kernel", "lattice", "ledger",
  "marble", "matrix", "nimbus", "orbit", "parcel", "pixel", "quartz", "ridge", "signal",
  "socket", "spindle", "summit", "tensor", "thread", "vector", "vertex", "willow", "zenith",
];

const CITIES = [
  "Santiago", "Lisbon", "Osaka", "Toronto", "Nairobi", "Helsinki", "Bogota", "Auckland",
  "Krakow", "Seville", "Montreal", "Busan", "Porto", "Adelaide", "Bergen", "Valencia",
];

const COUNTRIES = [
  "Chile", "Portugal", "Japan", "Canada", "Kenya", "Finland", "Colombia", "New Zealand",
  "Poland", "Spain", "Norway", "Australia", "Iceland", "Uruguay", "Ireland", "Peru",
];

const COLORS = [
  "red", "green", "blue", "cyan", "magenta", "yellow", "orange", "purple", "teal", "indigo",
  "olive", "maroon", "navy", "silver", "gold", "salmon",
];

const COMPANY_HEADS = [
  "Northwind", "Blue Harbor", "Ironwood", "Silverpine", "Redshift", "Lumen", "Cascade",
  "Meridian", "Kestrel", "Solstice", "Granite", "Halcyon",
];

const COMPANY_TAILS = ["Labs", "Systems", "Group", "Industries", "Partners", "Technologies", "Works", "Digital"];

const JOB_TITLES = [
  "Backend Engineer", "Product Manager", "Data Analyst", "QA Lead", "Site Reliability Engineer",
  "Solutions Architect", "UX Designer", "Engineering Manager", "Security Analyst",
  "Database Administrator", "Technical Writer", "Platform Engineer",
];

const CURRENCY_CODES = ["USD", "EUR", "GBP", "JPY", "CLP", "BRL", "CAD", "AUD", "CHF", "MXN", "SEK", "NOK"];

const MIME_TYPES = [
  "application/json", "application/xml", "application/pdf", "application/zip", "text/plain",
  "text/html", "text/csv", "image/png", "image/jpeg", "image/svg+xml", "audio/mpeg", "video/mp4",
];

const TLDS = ["com", "io", "dev", "net", "org", "app", "cl", "co"];

const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PASSWORD_CHARS = `${ALPHANUMERIC}!@#$%^&*-_=+`;

/** Inclusive on both ends. Math.random is fine everywhere in this file: these values are request
 * fixtures, never credentials — `$randomPassword` fills a signup form in a test, it doesn't
 * protect anything. */
function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pick<T>(list: readonly T[]): T {
  return list[randInt(0, list.length - 1)];
}

function randomChars(count: number, alphabet: string): string {
  let out = "";
  for (let i = 0; i < count; i++) out += alphabet[randInt(0, alphabet.length - 1)];
  return out;
}

function hex(count: number): string {
  return randomChars(count, "0123456789abcdef");
}

/** `crypto.randomUUID` needs a secure context, which a packaged webview doesn't always report as
 * one, so fall back to a v4 assembled from `getRandomValues` and finally to `Math.random`. */
function uuid(): string {
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    if (typeof crypto.getRandomValues === "function") {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
  }
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[randInt(0, 3)]}${hex(3)}-${hex(12)}`;
}

function domainName(): string {
  return `${pick(WORDS)}${pick(WORDS)}.${pick(TLDS)}`;
}

function sentence(): string {
  const words = Array.from({ length: randInt(6, 12) }, () => pick(WORDS));
  return `${words[0][0].toUpperCase()}${words[0].slice(1)} ${words.slice(1).join(" ")}.`;
}

function offsetDate(minDays: number, maxDays: number): string {
  const days = randInt(minDays, maxDays);
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** Every generator, keyed by the name that appears inside `{{ }}`. */
const GENERATORS: Record<string, () => string> = {
  $guid: uuid,
  $uuid: uuid,
  $randomUUID: uuid,
  $timestamp: () => Math.floor(Date.now() / 1000).toString(),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => randInt(0, 1000).toString(),
  $randomAlphaNumeric: () => randomChars(1, ALPHANUMERIC),
  $randomBoolean: () => (Math.random() < 0.5 ? "true" : "false"),
  $randomEmail: () =>
    `${pick(FIRST_NAMES).toLowerCase()}.${pick(LAST_NAMES).toLowerCase()}@${domainName()}`,
  $randomFirstName: () => pick(FIRST_NAMES),
  $randomLastName: () => pick(LAST_NAMES),
  $randomFullName: () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
  $randomUserName: () => `${pick(FIRST_NAMES).toLowerCase()}_${pick(WORDS)}${randInt(1, 99)}`,
  $randomPassword: () => randomChars(12, PASSWORD_CHARS),
  $randomPhoneNumber: () => `${randInt(200, 989)}-${randInt(200, 989)}-${randInt(1000, 9999)}`,
  $randomUrl: () => `https://${domainName()}/${pick(WORDS)}`,
  $randomDomainName: domainName,
  $randomIP: () => `${randInt(1, 254)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`,
  $randomIPV6: () => Array.from({ length: 8 }, () => hex(4)).join(":"),
  $randomWord: () => pick(WORDS),
  $randomWords: () => Array.from({ length: randInt(3, 5) }, () => pick(WORDS)).join(" "),
  $randomLoremSentence: sentence,
  $randomLoremParagraph: () => Array.from({ length: randInt(3, 5) }, sentence).join(" "),
  $randomCity: () => pick(CITIES),
  $randomCountry: () => pick(COUNTRIES),
  $randomColor: () => pick(COLORS),
  $randomHexColor: () => `#${hex(6)}`,
  $randomMACAddress: () => Array.from({ length: 6 }, () => hex(2)).join(":"),
  $randomDatePast: () => offsetDate(-3650, -1),
  $randomDateFuture: () => offsetDate(1, 3650),
  $randomCompanyName: () => `${pick(COMPANY_HEADS)} ${pick(COMPANY_TAILS)}`,
  $randomJobTitle: () => pick(JOB_TITLES),
  $randomPrice: () => (randInt(10_000, 100_000) / 100).toFixed(2),
  $randomBankAccount: () => randomChars(8, "0123456789"),
  $randomCurrencyCode: () => pick(CURRENCY_CODES),
  $randomMimeType: () => pick(MIME_TYPES),
};

/** Evaluates `$name` fresh, or returns `null` when the name isn't a known dynamic variable — an
 * unknown `{{$typo}}` then falls through to the normal lookup and ends up flagged, not blanked. */
export function evalDynamic(name: string): string | null {
  const generator = GENERATORS[name];
  return generator === undefined ? null : generator();
}

/**
 * The autocomplete catalogue. Examples are frozen strings rather than live calls so the picker
 * doesn't reshuffle every time it opens; descriptions are English-only because they name the
 * generator, not UI chrome.
 */
export const DYNAMIC_VARIABLES: { name: string; description: string; example: string }[] = [
  { name: "$guid", description: "UUID v4", example: "6b1f8a2c-9d3e-4f1a-8c77-2b4d5e6f7a80" },
  { name: "$uuid", description: "UUID v4 (alias of $guid)", example: "0f3a1c92-5b7d-4e6f-9a10-3c8d2e4f6b51" },
  { name: "$randomUUID", description: "UUID v4 (alias of $guid)", example: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f" },
  { name: "$timestamp", description: "Current Unix time in seconds", example: "1753574400" },
  { name: "$isoTimestamp", description: "Current UTC time, ISO 8601", example: "2026-07-27T12:00:00.000Z" },
  { name: "$randomInt", description: "Integer between 0 and 1000", example: "742" },
  { name: "$randomAlphaNumeric", description: "One alphanumeric character", example: "k" },
  { name: "$randomBoolean", description: "true or false", example: "true" },
  { name: "$randomEmail", description: "Email address", example: "camila.herrera@orbitledger.io" },
  { name: "$randomFirstName", description: "First name", example: "Elena" },
  { name: "$randomLastName", description: "Last name", example: "Salazar" },
  { name: "$randomFullName", description: "First and last name", example: "Hugo Molina" },
  { name: "$randomUserName", description: "Username", example: "diego_vector41" },
  { name: "$randomPassword", description: "12-character password (test fixture, not secure)", example: "kQ7#pLm2*xZa" },
  { name: "$randomPhoneNumber", description: "Phone number", example: "415-772-3908" },
  { name: "$randomUrl", description: "HTTPS URL", example: "https://beaconpixel.dev/kernel" },
  { name: "$randomDomainName", description: "Domain name", example: "quartzsummit.app" },
  { name: "$randomIP", description: "IPv4 address", example: "192.51.100.24" },
  { name: "$randomIPV6", description: "IPv6 address", example: "2001:0db8:85a3:0000:0000:8a2e:0370:7334" },
  { name: "$randomWord", description: "Single word", example: "lattice" },
  { name: "$randomWords", description: "Three to five words", example: "signal harbor vertex" },
  { name: "$randomLoremSentence", description: "One sentence of filler text", example: "Marble engine ridge socket thread orbit." },
  { name: "$randomLoremParagraph", description: "Three to five sentences of filler text", example: "Cipher bridge canvas delta index. Nimbus parcel quartz forge summit." },
  { name: "$randomCity", description: "City name", example: "Helsinki" },
  { name: "$randomCountry", description: "Country name", example: "Portugal" },
  { name: "$randomColor", description: "Color name", example: "indigo" },
  { name: "$randomHexColor", description: "Hex color", example: "#3f8ac2" },
  { name: "$randomMACAddress", description: "MAC address", example: "a4:5e:60:1b:c7:d2" },
  { name: "$randomDatePast", description: "ISO date within the last 10 years", example: "2021-03-14T08:22:05.117Z" },
  { name: "$randomDateFuture", description: "ISO date within the next 10 years", example: "2031-11-02T19:40:51.884Z" },
  { name: "$randomCompanyName", description: "Company name", example: "Northwind Systems" },
  { name: "$randomJobTitle", description: "Job title", example: "Solutions Architect" },
  { name: "$randomPrice", description: "Price between 100.00 and 1000.00", example: "348.90" },
  { name: "$randomBankAccount", description: "8-digit account number", example: "40318725" },
  { name: "$randomCurrencyCode", description: "ISO 4217 currency code", example: "EUR" },
  { name: "$randomMimeType", description: "MIME type", example: "application/json" },
];
