/**
 * The `pm.*` scripting runtime for pre-request and post-response scripts.
 *
 * **This is not a security sandbox and does not try to be.** The scripts run in the webview's own
 * realm via `new Function`, with full access to everything the app's JavaScript can reach. That is
 * deliberate: these are the user's own scripts, typed into their own client, at exactly the trust
 * level of the terminal this app already embeds. "Sandbox" here means *the scoped set of globals a
 * Postman script expects to find*, nothing more. Anyone tempted to run someone else's collection
 * scripts unattended should reach for a Worker or the Rust side first.
 *
 * What it *does* guarantee is containment of failure: a script that throws, hangs on a bad
 * assertion, or dies inside a `pm.sendRequest` callback produces a `ScriptOutcome` with `error`
 * set and everything collected so far intact. A broken test script must never be the reason a
 * response can't be displayed.
 *
 * The `pm` surface is a faithful-but-honest subset of Postman's. Where something isn't
 * implemented it is *absent*, never a stub returning `undefined` — a script that silently does
 * nothing is worse than one that throws `pm.foo is not a function` on the first run.
 *
 * One deviation worth knowing about: `CryptoJS` is asynchronous here (see `CRYPTO` below),
 * because the digests come from WebCrypto rather than a bundled 200 KB crypto library.
 */

import { lookupVariable, resolve } from "./variables";
import type {
  ApiResponse,
  ApiVariable,
  ConsoleLine,
  HttpResponse,
  HttpSendRequest,
  NetworkOptions,
  ResolvedRequest,
  TestResult,
} from "../../types/api";
import { apiSendHttp } from "../tauri/apiCommands";

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/** The five variable scopes a script can read, in the layout `variables.ts` resolves against. */
export interface SandboxScopes {
  local: Record<string, string>;
  data: Record<string, string>;
  environment: ApiVariable[];
  collection: ApiVariable[];
  global: ApiVariable[];
}

export interface ScriptOutcome {
  /** A *copy* of the incoming scopes with the script's writes applied; the caller merges it back. */
  scopes: SandboxScopes;
  tests: TestResult[];
  console: ConsoleLine[];
  /** A thrown error, already formatted for display. `null` when the script completed. */
  error: string | null;
  /** `postman.setNextRequest(...)`, for the collection runner. */
  nextRequest: string | null;
  visualizer: { template: string; data: unknown } | null;
}

// ---------------------------------------------------------------------------
// Value formatting — shared by the assertion messages and the console
// ---------------------------------------------------------------------------

const INSPECT_LIMIT = 240;

function truncate(text: string): string {
  return text.length <= INSPECT_LIMIT ? text : `${text.slice(0, INSPECT_LIMIT)}…`;
}

/** Circular-safe `JSON.stringify` replacer; a cycle prints as `[Circular]` instead of throwing. */
function safeStringify(value: unknown, indent?: number): string {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    },
    indent,
  );
  return json === undefined ? String(value) : json;
}

/** Chai-style rendering of a value inside an assertion message. */
function inspect(value: unknown): string {
  if (typeof value === "string") return truncate(`'${value}'`);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return value.toString();
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return truncate(safeStringify(value));
}

/** Chai's type names: `null` and `array` are their own types, everything else is the `[[Class]]`. */
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const primitive = typeof value;
  if (primitive !== "object") return primitive;
  return Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeOf(value) === "object";
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // Object.is separates +0/-0, which `eql` should not.
  if (a === 0 && b === 0) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object") return false;

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]),
  );
}

function cloneDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneDeep(item)) as unknown as T;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = cloneDeep(item);
    return out as unknown as T;
  }
  return value;
}

/** `message` alone for assertions (the message *is* the report), plus one frame for real bugs. */
function formatError(error: unknown): string {
  if (error instanceof AssertionError) return error.message;
  if (error instanceof Error) {
    const head = `${error.name}: ${error.message}`;
    const frame = (error.stack ?? "")
      .split("\n")
      .slice(1)
      .find((line) => line.includes("at "));
    return frame === undefined ? head : `${head}\n${frame.trim()}`;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// Variable scopes
// ---------------------------------------------------------------------------

/** Every bag exposes the same five verbs, so the four `pm.*` scopes are interchangeable in docs. */
interface VariableBag {
  get(key: string): string | undefined;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  unset(key: string): void;
  toObject(): Record<string, string>;
  clear(): void;
}

function cloneScopes(scopes: SandboxScopes): SandboxScopes {
  return {
    local: { ...scopes.local },
    data: { ...scopes.data },
    environment: scopes.environment.map((variable) => ({ ...variable })),
    collection: scopes.collection.map((variable) => ({ ...variable })),
    global: scopes.global.map((variable) => ({ ...variable })),
  };
}

/**
 * Routes a single-list lookup through `variables.ts` so the `currentValue || initialValue` rule
 * can't drift between what a script reads and what interpolation substitutes.
 */
function listValue(key: string, list: ApiVariable[]): string | undefined {
  const found = lookupVariable(key, {
    local: {},
    data: {},
    environment: list,
    collection: [],
    global: [],
  });
  return found === null ? undefined : found.value;
}

function newVariableId(): string {
  return `var-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Scripts write `currentValue` — `initialValue` is the shared default that gets exported. */
function listBag(list: ApiVariable[]): VariableBag {
  const indexOf = (key: string) => list.findIndex((variable) => variable.key === key);

  return {
    get: (key) => listValue(key, list),
    set: (key, value) => {
      const text = toScalarString(value);
      const at = indexOf(key);
      if (at === -1) {
        list.push({
          id: newVariableId(),
          key,
          initialValue: "",
          currentValue: text,
          secret: false,
          enabled: true,
          description: "",
        });
        return;
      }
      list[at] = { ...list[at], currentValue: text, enabled: true };
    },
    has: (key) => listValue(key, list) !== undefined,
    unset: (key) => {
      const at = indexOf(key);
      if (at !== -1) list.splice(at, 1);
    },
    toObject: () => {
      const out: Record<string, string> = {};
      for (const variable of list) {
        if (!variable.enabled || variable.key === "") continue;
        out[variable.key] = listValue(variable.key, list) ?? "";
      }
      return out;
    },
    clear: () => {
      list.splice(0, list.length);
    },
  };
}

function recordBag(record: Record<string, string>): VariableBag {
  return {
    get: (key) => (Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined),
    set: (key, value) => {
      record[key] = toScalarString(value);
    },
    has: (key) => Object.prototype.hasOwnProperty.call(record, key),
    unset: (key) => {
      delete record[key];
    },
    toObject: () => ({ ...record }),
    clear: () => {
      for (const key of Object.keys(record)) delete record[key];
    },
  };
}

/**
 * Variables are strings on the wire, so a script setting an object gets it JSON-encoded rather
 * than `"[object Object]"` — `pm.environment.set('user', {id: 1})` then round-trips through
 * `JSON.parse(pm.environment.get('user'))`, which is what people actually write.
 */
function toScalarString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return safeStringify(value);
  return String(value);
}

/** `pm.variables` — reads through the whole precedence chain, writes to the run-local scope. */
function mergedBag(scopes: SandboxScopes): VariableBag & { replaceIn(template: string): string } {
  const local = recordBag(scopes.local);
  return {
    get: (key) => {
      const found = lookupVariable(key, scopes);
      return found === null ? undefined : found.value;
    },
    set: local.set,
    has: (key) => lookupVariable(key, scopes) !== null,
    // Only the local scope, because that's the only one `set` writes to; removing a variable from
    // an environment is `pm.environment.unset`.
    unset: local.unset,
    toObject: () => ({
      ...listBag(scopes.global).toObject(),
      ...listBag(scopes.collection).toObject(),
      ...listBag(scopes.environment).toObject(),
      ...scopes.data,
      ...scopes.local,
    }),
    clear: local.clear,
    replaceIn: (template) => resolve(String(template), scopes),
  };
}

// ---------------------------------------------------------------------------
// Mini Chai
// ---------------------------------------------------------------------------

/** Distinguished from a genuine bug so the reporter can drop the stack frame for these. */
class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/**
 * A hand-rolled slice of Chai's `expect`. Only the assertions Postman scripts actually use are
 * here, but their *messages* match Chai's wording as closely as possible: the message is the
 * failure line the user reads in the Test Results tab, so "expected 404 to equal 200" is the
 * feature, not the error handling around it.
 */
class Expectation {
  private readonly subject: unknown;
  private negated = false;
  private deepFlag = false;

  constructor(subject: unknown) {
    this.subject = subject;
  }

  // Language chain — no-ops that make assertions read like sentences.
  get to(): this {
    return this;
  }
  get be(): this {
    return this;
  }
  get been(): this {
    return this;
  }
  get is(): this {
    return this;
  }
  get that(): this {
    return this;
  }
  get which(): this {
    return this;
  }
  get and(): this {
    return this;
  }
  get has(): this {
    return this;
  }
  get have(): this {
    return this;
  }
  get with(): this {
    return this;
  }
  get of(): this {
    return this;
  }
  get same(): this {
    return this;
  }

  /** Sticky for the rest of the chain, as in Chai. */
  get not(): this {
    this.negated = !this.negated;
    return this;
  }

  /** Promotes `equal`/`include`/`property` to their structural comparison. */
  get deep(): this {
    this.deepFlag = true;
    return this;
  }

  private assert(passed: boolean, phrase: string): void {
    if (passed !== this.negated) return;
    throw new AssertionError(
      `expected ${inspect(this.subject)} to ${this.negated ? "not " : ""}${phrase}`,
    );
  }

  equal(expected: unknown): this {
    const passed = this.deepFlag ? deepEqual(this.subject, expected) : this.subject === expected;
    this.assert(passed, `equal ${inspect(expected)}`);
    return this;
  }

  equals(expected: unknown): this {
    return this.equal(expected);
  }

  eq(expected: unknown): this {
    return this.equal(expected);
  }

  eql(expected: unknown): this {
    this.assert(deepEqual(this.subject, expected), `deeply equal ${inspect(expected)}`);
    return this;
  }

  eqls(expected: unknown): this {
    return this.eql(expected);
  }

  a(type: string): this {
    const wanted = String(type).toLowerCase();
    this.assert(typeOf(this.subject) === wanted, `be a ${wanted}`);
    return this;
  }

  an(type: string): this {
    return this.a(type);
  }

  above(value: number): this {
    this.assert(Number(this.subject) > value, `be above ${value}`);
    return this;
  }

  gt(value: number): this {
    return this.above(value);
  }

  greaterThan(value: number): this {
    return this.above(value);
  }

  below(value: number): this {
    this.assert(Number(this.subject) < value, `be below ${value}`);
    return this;
  }

  lt(value: number): this {
    return this.below(value);
  }

  lessThan(value: number): this {
    return this.below(value);
  }

  least(value: number): this {
    this.assert(Number(this.subject) >= value, `be at least ${value}`);
    return this;
  }

  gte(value: number): this {
    return this.least(value);
  }

  most(value: number): this {
    this.assert(Number(this.subject) <= value, `be at most ${value}`);
    return this;
  }

  lte(value: number): this {
    return this.most(value);
  }

  include(expected: unknown): this {
    this.assert(this.containsValue(expected), `include ${inspect(expected)}`);
    return this;
  }

  includes(expected: unknown): this {
    return this.include(expected);
  }

  contain(expected: unknown): this {
    return this.include(expected);
  }

  contains(expected: unknown): this {
    return this.include(expected);
  }

  /** String → substring, array → membership, object → subset of own properties. */
  private containsValue(expected: unknown): boolean {
    const subject = this.subject;
    if (typeof subject === "string") return subject.includes(String(expected));
    const matches = (item: unknown) => (this.deepFlag ? deepEqual(item, expected) : item === expected);
    if (Array.isArray(subject)) return subject.some(matches);
    if (isPlainObject(subject) && isPlainObject(expected)) {
      return Object.entries(expected).every(([key, value]) => deepEqual(subject[key], value));
    }
    return false;
  }

  /** `rest` rather than an optional so `property('x', undefined)` still checks the value. */
  property(name: string, ...rest: unknown[]): this {
    const subject = this.subject;
    const exists =
      subject !== null &&
      subject !== undefined &&
      (typeof subject === "object" || typeof subject === "string") &&
      name in Object(subject);

    if (rest.length === 0) {
      this.assert(exists, `have property ${inspect(name)}`);
      return this;
    }

    const actual = exists ? (Object(subject) as Record<string, unknown>)[name] : undefined;
    const expected = rest[0];
    const passed = exists && (this.deepFlag ? deepEqual(actual, expected) : actual === expected);
    this.assert(
      passed,
      `have property ${inspect(name)} of ${inspect(expected)}, but got ${inspect(actual)}`,
    );
    return this;
  }

  lengthOf(expected: number): this {
    const actual = this.lengthValue();
    this.assert(actual === expected, `have a length of ${expected} but got ${inspect(actual)}`);
    return this;
  }

  length(expected: number): this {
    return this.lengthOf(expected);
  }

  private lengthValue(): number | undefined {
    const subject = this.subject;
    if (typeof subject === "string" || Array.isArray(subject)) return subject.length;
    if (subject instanceof Map || subject instanceof Set) return subject.size;
    if (isPlainObject(subject) && typeof subject.length === "number") return subject.length;
    return undefined;
  }

  match(pattern: RegExp): this {
    this.assert(pattern.test(String(this.subject)), `match ${String(pattern)}`);
    return this;
  }

  matches(pattern: RegExp): this {
    return this.match(pattern);
  }

  oneOf(list: unknown[]): this {
    const passed = Array.isArray(list) && list.some((item) => deepEqual(item, this.subject));
    this.assert(passed, `be one of ${inspect(list)}`);
    return this;
  }

  get exist(): this {
    this.assert(this.subject !== null && this.subject !== undefined, "exist");
    return this;
  }

  get empty(): this {
    const length = this.lengthValue();
    const passed =
      length !== undefined ? length === 0 : isPlainObject(this.subject) && Object.keys(this.subject).length === 0;
    this.assert(passed, "be empty");
    return this;
  }

  get ok(): this {
    this.assert(Boolean(this.subject), "be ok");
    return this;
  }

  get true(): this {
    this.assert(this.subject === true, "be true");
    return this;
  }

  get false(): this {
    this.assert(this.subject === false, "be false");
    return this;
  }

  get null(): this {
    this.assert(this.subject === null, "be null");
    return this;
  }

  get undefined(): this {
    this.assert(this.subject === undefined, "be undefined");
    return this;
  }
}

interface ExpectFn {
  (subject: unknown): Expectation;
  /** Chai's escape hatch, for a branch that should never be reached. */
  fail(message?: string): never;
}

const expect: ExpectFn = Object.assign((subject: unknown) => new Expectation(subject), {
  fail: (message?: string): never => {
    throw new AssertionError(message ?? "expected condition to be met");
  },
});

// ---------------------------------------------------------------------------
// Minimal JSON Schema (draft-07 subset)
// ---------------------------------------------------------------------------

/**
 * Enough of JSON Schema to be useful for response contracts, and no more: types, `required`,
 * `properties`, `items`, `enum`, numeric and length bounds, `pattern`, `additionalProperties`.
 * Composition (`$ref`, `allOf`/`anyOf`/`oneOf`) is **not** supported — a schema using them would
 * silently pass here, so `jsonSchema` rejects it up front rather than lying about the check.
 */
const UNSUPPORTED_KEYWORDS = ["$ref", "allOf", "anyOf", "oneOf", "not", "if", "definitions"];

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    case "string":
    case "boolean":
      return typeof value === type;
    default:
      return true;
  }
}

function validateSchema(value: unknown, schema: unknown, path: string): string[] {
  if (!isPlainObject(schema)) return [];
  const errors: string[] = [];
  const at = (message: string) => errors.push(`${path}: ${message}`);

  const { type } = schema;
  if (typeof type === "string" && !matchesType(value, type)) {
    at(`expected type ${type} but got ${typeOf(value)}`);
    return errors;
  }
  if (Array.isArray(type) && !type.some((one) => matchesType(value, String(one)))) {
    at(`expected type ${type.join(" | ")} but got ${typeOf(value)}`);
    return errors;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((one) => deepEqual(one, value))) {
    at(`expected one of ${inspect(schema.enum)} but got ${inspect(value)}`);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      at(`expected ${value} to be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      at(`expected ${value} to be at most ${schema.maximum}`);
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      at(`expected a string of at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      at(`expected a string of at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      at(`expected ${inspect(value)} to match /${schema.pattern}/`);
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, String(name))) {
          at(`missing required property ${inspect(String(name))}`);
        }
      }
    }
    for (const [name, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, name)) {
        errors.push(...validateSchema(value[name], child, `${path}.${name}`));
      }
    }
    const extra = schema.additionalProperties;
    if (extra === false || isPlainObject(extra)) {
      for (const name of Object.keys(value)) {
        if (Object.prototype.hasOwnProperty.call(properties, name)) continue;
        if (extra === false) at(`unexpected additional property ${inspect(name)}`);
        else errors.push(...validateSchema(value[name], extra, `${path}.${name}`));
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    const { items } = schema;
    value.forEach((item, index) => {
      const child = Array.isArray(items) ? items[index] : items;
      if (child !== undefined) errors.push(...validateSchema(item, child, `${path}[${index}]`));
    });
  }

  return errors;
}

function assertSchemaSupported(schema: unknown): void {
  if (!isPlainObject(schema)) throw new AssertionError("jsonSchema expects a schema object");
  const used = UNSUPPORTED_KEYWORDS.filter((keyword) =>
    Object.prototype.hasOwnProperty.call(schema, keyword),
  );
  if (used.length > 0) {
    throw new AssertionError(
      `this JSON Schema validator does not support ${used.join(", ")} — rewrite the schema without it`,
    );
  }
}

// ---------------------------------------------------------------------------
// Lodash-ish
// ---------------------------------------------------------------------------

function toPath(path: string | (string | number)[]): string[] {
  if (Array.isArray(path)) return path.map(String);
  return String(path)
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((part) => part !== "");
}

function pathGet(object: unknown, path: string | (string | number)[], fallback?: unknown): unknown {
  let cursor: unknown = object;
  for (const key of toPath(path)) {
    if (cursor === null || cursor === undefined) return fallback;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor === undefined ? fallback : cursor;
}

function pathSet<T>(object: T, path: string | (string | number)[], value: unknown): T {
  const parts = toPath(path);
  if (parts.length === 0 || object === null || typeof object !== "object") return object;

  let cursor = object as unknown as Record<string, unknown>;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const next = cursor[key];
    if (next === null || typeof next !== "object") {
      cursor[key] = /^\d+$/.test(parts[index + 1]) ? [] : {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  return object;
}

type Iteratee = string | Record<string, unknown> | ((item: unknown, index: number) => unknown);

/** lodash's shorthand forms: a property path, a partial object to match, or a real function. */
function toIteratee(iteratee: Iteratee): (item: unknown, index: number) => unknown {
  if (typeof iteratee === "function") return iteratee;
  if (typeof iteratee === "string") return (item) => pathGet(item, iteratee);
  return (item) =>
    isPlainObject(item) && Object.entries(iteratee).every(([key, value]) => deepEqual(item[key], value));
}

function toList(collection: unknown): unknown[] {
  if (Array.isArray(collection)) return collection;
  if (isPlainObject(collection)) return Object.values(collection);
  return [];
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) deepMerge(existing, value);
    else target[key] = value;
  }
}

const LODASH = {
  get: pathGet,
  set: pathSet,
  pick: (object: unknown, keys: string | string[]): Record<string, unknown> => {
    const wanted = Array.isArray(keys) ? keys : [keys];
    const source = isPlainObject(object) ? object : {};
    const out: Record<string, unknown> = {};
    for (const key of wanted) {
      if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
    }
    return out;
  },
  omit: (object: unknown, keys: string | string[]): Record<string, unknown> => {
    const removed = new Set(Array.isArray(keys) ? keys : [keys]);
    const source = isPlainObject(object) ? object : {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (!removed.has(key)) out[key] = value;
    }
    return out;
  },
  isEqual: deepEqual,
  cloneDeep,
  map: (collection: unknown, iteratee: Iteratee): unknown[] =>
    toList(collection).map(toIteratee(iteratee)),
  filter: (collection: unknown, iteratee: Iteratee): unknown[] => {
    const predicate = toIteratee(iteratee);
    return toList(collection).filter((item, index) => Boolean(predicate(item, index)));
  },
  find: (collection: unknown, iteratee: Iteratee): unknown => {
    const predicate = toIteratee(iteratee);
    return toList(collection).find((item, index) => Boolean(predicate(item, index)));
  },
  keys: (object: unknown): string[] => (object === null || typeof object !== "object" ? [] : Object.keys(object)),
  values: (object: unknown): unknown[] =>
    object === null || typeof object !== "object" ? [] : Object.values(object),
  merge: (target: unknown, ...sources: unknown[]): unknown => {
    if (!isPlainObject(target)) return target;
    for (const source of sources) {
      if (isPlainObject(source)) deepMerge(target, source);
    }
    return target;
  },
};

// ---------------------------------------------------------------------------
// CryptoJS-shaped helper
// ---------------------------------------------------------------------------

interface HashValue {
  toString(encoding?: string): string;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function hashValue(bytes: Uint8Array): HashValue {
  return {
    toString: (encoding?: string) =>
      encoding === "base64" ? bytesToBase64(bytes) : bytesToHex(bytes),
  };
}

/**
 * MD5 by hand because WebCrypto refuses to implement it, and legacy signing schemes still need
 * it. Straight RFC 1321, operating on bytes.
 */
function md5(input: Uint8Array): Uint8Array {
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const sines = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) sines[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const bitLength = input.length * 8;
  const padded = new Uint8Array((((input.length + 8) >> 6) + 1) << 6);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const block = new Uint32Array(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) block[i] = view.getUint32(offset + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let mixed: number;
      let index: number;
      if (i < 16) {
        mixed = (b & c) | (~b & d);
        index = i;
      } else if (i < 32) {
        mixed = (d & b) | (~d & c);
        index = (5 * i + 1) % 16;
      } else if (i < 48) {
        mixed = b ^ c ^ d;
        index = (3 * i + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        index = (7 * i) % 16;
      }
      const sum = (mixed + a + sines[i] + block[index]) >>> 0;
      const shift = shifts[i];
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const digest = new Uint8Array(16);
  const out = new DataView(digest.buffer);
  out.setUint32(0, a0, true);
  out.setUint32(4, b0, true);
  out.setUint32(8, c0, true);
  out.setUint32(12, d0, true);
  return digest;
}

/**
 * Every digest resolves to a `HashValue`, never to one directly — WebCrypto is async and there is
 * no way around that short of shipping a second implementation of SHA-2. Calling `.toString()` on
 * the promise (the CryptoJS habit) throws a message that names the fix instead of quietly
 * producing `"[object Promise]"` inside a signature.
 */
function asyncHash(name: string, work: () => Promise<Uint8Array>): Promise<HashValue> {
  const promise = work().then(hashValue);
  Object.defineProperty(promise, "toString", {
    value: () => {
      throw new Error(
        `CryptoJS.${name}() is asynchronous in CodeFlow — write \`(await CryptoJS.${name}(…)).toString()\``,
      );
    },
  });
  return promise;
}

interface CryptoShim {
  MD5(message: string): Promise<HashValue>;
  SHA1?(message: string): Promise<HashValue>;
  SHA256?(message: string): Promise<HashValue>;
  SHA384?(message: string): Promise<HashValue>;
  SHA512?(message: string): Promise<HashValue>;
  HmacSHA1?(message: string, key: string): Promise<HashValue>;
  HmacSHA256?(message: string, key: string): Promise<HashValue>;
  HmacSHA512?(message: string, key: string): Promise<HashValue>;
  Base64: { encode(text: string): string; decode(base64: string): string };
  enc: { Hex: string; Base64: string };
}

const subtle = typeof crypto === "undefined" ? undefined : crypto.subtle;

function digest(algorithm: string, message: string): () => Promise<Uint8Array> {
  return async () => {
    if (subtle === undefined) throw new Error("WebCrypto is unavailable in this webview");
    return new Uint8Array(await subtle.digest(algorithm, utf8(message)));
  };
}

function hmac(algorithm: string, message: string, key: string): () => Promise<Uint8Array> {
  return async () => {
    if (subtle === undefined) throw new Error("WebCrypto is unavailable in this webview");
    const imported = await subtle.importKey(
      "raw",
      utf8(key),
      { name: "HMAC", hash: algorithm },
      false,
      ["sign"],
    );
    return new Uint8Array(await subtle.sign("HMAC", imported, utf8(message)));
  };
}

const CRYPTO: CryptoShim = {
  MD5: (message) => asyncHash("MD5", async () => md5(utf8(String(message)))),
  Base64: {
    encode: (text) => bytesToBase64(utf8(String(text))),
    decode: (base64) => new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))),
  },
  // So `.toString(CryptoJS.enc.Base64)` reads the way it does in a Postman script.
  enc: { Hex: "hex", Base64: "base64" },
};

// The SHA family only exists when WebCrypto does, rather than existing and always failing.
if (subtle !== undefined) {
  CRYPTO.SHA1 = (message) => asyncHash("SHA1", digest("SHA-1", String(message)));
  CRYPTO.SHA256 = (message) => asyncHash("SHA256", digest("SHA-256", String(message)));
  CRYPTO.SHA384 = (message) => asyncHash("SHA384", digest("SHA-384", String(message)));
  CRYPTO.SHA512 = (message) => asyncHash("SHA512", digest("SHA-512", String(message)));
  CRYPTO.HmacSHA1 = (message, key) => asyncHash("HmacSHA1", hmac("SHA-1", String(message), String(key)));
  CRYPTO.HmacSHA256 = (message, key) =>
    asyncHash("HmacSHA256", hmac("SHA-256", String(message), String(key)));
  CRYPTO.HmacSHA512 = (message, key) =>
    asyncHash("HmacSHA512", hmac("SHA-512", String(message), String(key)));
}

// ---------------------------------------------------------------------------
// Request facade
// ---------------------------------------------------------------------------

type HeaderInput = string | { key: string; value: string };

function headerName(header: HeaderInput, value?: string): [string, string] {
  if (typeof header === "string") return [header, value ?? ""];
  return [String(header.key), String(header.value)];
}

function splitUrl(url: string): { base: string; query: string; hash: string } {
  const hashAt = url.indexOf("#");
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const withoutHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = withoutHash.indexOf("?");
  return {
    base: queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt),
    query: queryAt === -1 ? "" : withoutHash.slice(queryAt + 1),
    hash,
  };
}

/**
 * `pm.request`, backed by the caller's `ResolvedRequest` **in place**: a pre-request script that
 * adds a header or rewrites the URL has changed the object the caller is about to send. That is
 * the only channel for it — `ScriptOutcome` carries variables and diagnostics, not the request.
 */
function makeRequest(request: ResolvedRequest) {
  const params = () => new URLSearchParams(splitUrl(request.url).query);
  const writeQuery = (search: URLSearchParams) => {
    const { base, hash } = splitUrl(request.url);
    const text = search.toString();
    request.url = `${base}${text === "" ? "" : `?${text}`}${hash}`;
  };
  const findHeader = (name: string) => {
    const wanted = name.toLowerCase();
    return request.headers.findIndex(([key]) => key.toLowerCase() === wanted);
  };

  const headers = {
    add: (header: HeaderInput, value?: string) => {
      request.headers.push(headerName(header, value));
    },
    upsert: (header: HeaderInput, value?: string) => {
      const pair = headerName(header, value);
      const at = findHeader(pair[0]);
      if (at === -1) request.headers.push(pair);
      else request.headers[at] = pair;
    },
    remove: (name: string) => {
      const wanted = String(name).toLowerCase();
      request.headers = request.headers.filter(([key]) => key.toLowerCase() !== wanted);
    },
    get: (name: string) => {
      const at = findHeader(String(name));
      return at === -1 ? undefined : request.headers[at][1];
    },
    has: (name: string) => findHeader(String(name)) !== -1,
    toObject: () => Object.fromEntries(request.headers),
  };

  const url = {
    toString: () => request.url,
    query: {
      get: (key: string) => params().get(key) ?? undefined,
      has: (key: string) => params().has(key),
      add: (key: string, value: string) => {
        const search = params();
        search.append(key, value);
        writeQuery(search);
      },
      upsert: (key: string, value: string) => {
        const search = params();
        search.set(key, value);
        writeQuery(search);
      },
      remove: (key: string) => {
        const search = params();
        search.delete(key);
        writeQuery(search);
      },
      toObject: () => Object.fromEntries(params()),
    },
  };

  const body = {
    get mode(): string {
      return request.body.kind === "text" ? "raw" : request.body.kind;
    },
    /** `undefined` outside raw mode, because there is no raw text to hand back. */
    get raw(): string | undefined {
      return request.body.kind === "text" ? request.body.text : undefined;
    },
    set raw(text: string | undefined) {
      const value = text ?? "";
      // Keep the existing content type when there is one; otherwise guess from the payload, since
      // a script rewriting the body almost always means JSON and would be surprised by text/plain.
      const contentType =
        request.body.kind === "text" ? request.body.contentType : sniffContentType(value);
      request.body = { kind: "text", text: value, contentType };
    },
    toString: () => {
      const current = request.body;
      if (current.kind === "text") return current.text;
      if (current.kind === "urlencoded") return new URLSearchParams(current.pairs).toString();
      if (current.kind === "file") return current.path;
      return "";
    },
  };

  return {
    get method(): string {
      return request.method;
    },
    set method(value: string) {
      request.method = String(value);
    },
    get url() {
      return url;
    },
    set url(value: string | { toString(): string }) {
      request.url = String(value);
    },
    headers,
    body,
  };
}

function sniffContentType(text: string): string {
  const head = text.trimStart()[0];
  if (head === "{" || head === "[") return "application/json";
  if (head === "<") return "application/xml";
  return "text/plain";
}

// ---------------------------------------------------------------------------
// Response facade
// ---------------------------------------------------------------------------

function responseText(response: HttpResponse): string {
  if (response.body_text !== "") return response.body_text;
  // A binary payload arrives base64-encoded; decoding it is lossy but beats handing back "".
  if (response.body_base64 !== null && response.body_base64 !== "") {
    try {
      return atob(response.body_base64);
    } catch {
      return "";
    }
  }
  return "";
}

interface ResponseFacade {
  code: number;
  status: string;
  responseTime: number;
  responseSize: number;
  headers: { get(name: string): string | undefined; has(name: string): boolean; toObject(): Record<string, string> };
  text(): string;
  json(): unknown;
  reason(): string;
  to: ResponseChain;
}

interface ResponseChain {
  have: ResponseHave;
  has: ResponseHave;
  be: ResponseBe;
  not: { have: ResponseHave; has: ResponseHave; be: ResponseBe };
}

interface ResponseHave {
  status(expected: number | string): void;
  header(name: string, value?: string): void;
  body(expected?: string | RegExp): void;
  jsonBody(...args: unknown[]): void;
  jsonSchema(schema: unknown): void;
}

interface ResponseBe {
  readonly ok: void;
  readonly success: void;
  readonly error: void;
  readonly clientError: void;
  readonly serverError: void;
  readonly redirection: void;
  readonly badRequest: void;
  readonly unauthorized: void;
  readonly forbidden: void;
  readonly notFound: void;
  readonly rateLimited: void;
  readonly json: void;
  readonly withBody: void;
}

function makeResponse(response: HttpResponse): ResponseFacade {
  let parsed: { value: unknown } | null = null;

  const text = () => responseText(response);
  const json = () => {
    if (parsed === null) {
      try {
        parsed = { value: JSON.parse(text()) as unknown };
      } catch (error) {
        throw new Error(`response body is not valid JSON: ${(error as Error).message}`);
      }
    }
    return parsed.value;
  };

  const headerAt = (name: string) => {
    const wanted = String(name).toLowerCase();
    return response.headers.find(([key]) => key.toLowerCase() === wanted);
  };

  /** These messages describe the response, not a bare value, so they don't go through `inspect`. */
  const check = (negated: boolean) => (passed: boolean, message: string, negatedMessage: string) => {
    if (passed !== negated) return;
    throw new AssertionError(negated ? negatedMessage : message);
  };

  const have = (negated: boolean): ResponseHave => {
    const assert = check(negated);
    return {
      status: (expected) => {
        if (typeof expected === "string") {
          assert(
            response.status_text.toLowerCase() === expected.toLowerCase(),
            `expected response to have status reason '${expected}' but got '${response.status_text}'`,
            `expected response to not have status reason '${expected}'`,
          );
          return;
        }
        assert(
          response.status === expected,
          `expected response to have status code ${expected} but got ${response.status}`,
          `expected response to not have status code ${expected}`,
        );
      },
      header: (name, value) => {
        const found = headerAt(name);
        if (value === undefined) {
          assert(
            found !== undefined,
            `expected response to have header '${name}'`,
            `expected response to not have header '${name}'`,
          );
          return;
        }
        assert(
          found !== undefined && found[1] === value,
          `expected response header '${name}' to be '${value}' but got ${
            found === undefined ? "no such header" : `'${found[1]}'`
          }`,
          `expected response header '${name}' to not be '${value}'`,
        );
      },
      body: (expected) => {
        const actual = text();
        if (expected === undefined) {
          assert(
            actual !== "",
            "expected response to have a body",
            "expected response to not have a body",
          );
          return;
        }
        if (expected instanceof RegExp) {
          assert(
            expected.test(actual),
            `expected response body to match ${String(expected)}`,
            `expected response body to not match ${String(expected)}`,
          );
          return;
        }
        assert(
          actual.includes(expected),
          `expected response body to contain ${inspect(expected)}`,
          `expected response body to not contain ${inspect(expected)}`,
        );
      },
      // Postman's three forms: valid-JSON, whole-body equality, and value-at-path equality.
      jsonBody: (...args) => {
        const body = json();
        if (args.length === 0) {
          assert(
            body !== undefined,
            "expected response body to be valid JSON",
            "expected response body to not be valid JSON",
          );
          return;
        }
        if (args.length === 1 && typeof args[0] !== "string") {
          assert(
            deepEqual(body, args[0]),
            `expected response body to equal ${inspect(args[0])} but got ${inspect(body)}`,
            `expected response body to not equal ${inspect(args[0])}`,
          );
          return;
        }
        const path = String(args[0]);
        const actual = pathGet(body, path);
        if (args.length === 1) {
          assert(
            actual !== undefined,
            `expected response body to have a value at '${path}'`,
            `expected response body to not have a value at '${path}'`,
          );
          return;
        }
        assert(
          deepEqual(actual, args[1]),
          `expected response body '${path}' to equal ${inspect(args[1])} but got ${inspect(actual)}`,
          `expected response body '${path}' to not equal ${inspect(args[1])}`,
        );
      },
      jsonSchema: (schema) => {
        assertSchemaSupported(schema);
        const errors = validateSchema(json(), schema, "$");
        assert(
          errors.length === 0,
          `expected response body to match the JSON schema — ${errors.join("; ")}`,
          "expected response body to not match the JSON schema",
        );
      },
    };
  };

  const be = (negated: boolean): ResponseBe => {
    const assert = check(negated);
    const code = response.status;
    const inRange = (low: number, high: number, label: string) => {
      assert(
        code >= low && code <= high,
        `expected response to have a ${label} status code but got ${code}`,
        `expected response to not have a ${label} status code but got ${code}`,
      );
    };
    const exactly = (expected: number, label: string) => {
      assert(
        code === expected,
        `expected response to be ${label} (${expected}) but got ${code}`,
        `expected response to not be ${label} (${expected})`,
      );
    };

    // Each of these asserts on read — `pm.response.to.be.ok` is a getter, not a call.
    return {
      get ok(): void {
        return inRange(200, 299, "2xx");
      },
      get success(): void {
        return inRange(200, 299, "2xx");
      },
      get error(): void {
        return assert(
          code >= 400,
          `expected response to have an error status code but got ${code}`,
          `expected response to not have an error status code but got ${code}`,
        );
      },
      get clientError(): void {
        return inRange(400, 499, "4xx");
      },
      get serverError(): void {
        return inRange(500, 599, "5xx");
      },
      get redirection(): void {
        return inRange(300, 399, "3xx");
      },
      get badRequest(): void {
        return exactly(400, "a bad request");
      },
      get unauthorized(): void {
        return exactly(401, "unauthorized");
      },
      get forbidden(): void {
        return exactly(403, "forbidden");
      },
      get notFound(): void {
        return exactly(404, "not found");
      },
      get rateLimited(): void {
        return exactly(429, "rate limited");
      },
      get json(): void {
        const type = headerAt("content-type");
        return assert(
          type !== undefined && type[1].toLowerCase().includes("json"),
          `expected response to be JSON but Content-Type is ${type === undefined ? "absent" : `'${type[1]}'`}`,
          "expected response to not be JSON",
        );
      },
      get withBody(): void {
        return assert(
          text() !== "",
          "expected response to have a body",
          "expected response to not have a body",
        );
      },
    };
  };

  return {
    code: response.status,
    status: response.status_text,
    responseTime: response.duration_ms,
    responseSize: response.size_bytes,
    headers: {
      get: (name) => headerAt(name)?.[1],
      has: (name) => headerAt(name) !== undefined,
      toObject: () => Object.fromEntries(response.headers),
    },
    text,
    json,
    reason: () => response.status_text,
    to: {
      have: have(false),
      has: have(false),
      be: be(false),
      not: { have: have(true), has: have(true), be: be(true) },
    },
  };
}

// ---------------------------------------------------------------------------
// pm.sendRequest
// ---------------------------------------------------------------------------

type SendTarget =
  | string
  | {
      url: string;
      method?: string;
      header?: Record<string, string> | { key: string; value: string }[];
      body?: string | { mode?: string; raw?: string; urlencoded?: { key: string; value: string }[] };
    };

/** The auxiliary call inherits the main request's network settings but never its cookies — those
 * were matched against the main URL and have no business on a different host. */
function auxOptions(base: NetworkOptions): NetworkOptions {
  return { ...base, cookies: [] };
}

function buildAuxRequest(target: SendTarget, options: NetworkOptions): HttpSendRequest {
  const blank: HttpSendRequest = {
    method: "GET",
    url: "",
    headers: [],
    body_text: null,
    body_base64: null,
    body_file: null,
    form_data: null,
    urlencoded: null,
    auth: null,
    options: auxOptions(options),
  };

  if (typeof target === "string") return { ...blank, url: target };
  if (!isPlainObject(target) || typeof target.url !== "string") {
    throw new Error("pm.sendRequest expects a URL string or an object with a `url` property");
  }

  const headers: [string, string][] = [];
  if (Array.isArray(target.header)) {
    for (const item of target.header) headers.push([String(item.key), String(item.value)]);
  } else if (isPlainObject(target.header)) {
    for (const [key, value] of Object.entries(target.header)) headers.push([key, String(value)]);
  }

  const request: HttpSendRequest = {
    ...blank,
    method: (target.method ?? "GET").toUpperCase(),
    url: target.url,
    headers,
  };

  const { body } = target;
  if (typeof body === "string") return { ...request, body_text: body };
  if (isPlainObject(body)) {
    if (body.mode === "urlencoded" || Array.isArray(body.urlencoded)) {
      const pairs = (body.urlencoded ?? []).map(
        (item): [string, string] => [String(item.key), String(item.value)],
      );
      return { ...request, urlencoded: pairs };
    }
    if (typeof body.raw === "string") return { ...request, body_text: body.raw };
    throw new Error(
      `pm.sendRequest supports raw and urlencoded bodies only (got mode '${String(body.mode)}')`,
    );
  }
  return request;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

type ScriptFn = (
  pm: unknown,
  postman: unknown,
  consoleShim: unknown,
  lodash: unknown,
  cryptoShim: unknown,
) => Promise<unknown>;

/** Rounds spawned by callbacks that themselves spawn work; bounded so a recursive script can't
 * hold the response hostage forever. */
const DRAIN_ROUNDS = 5;

async function runScript(
  code: string,
  ctx: { request: ResolvedRequest; response?: ApiResponse; scopes: SandboxScopes },
): Promise<ScriptOutcome> {
  const scopes = cloneScopes(ctx.scopes);
  const tests: TestResult[] = [];
  const lines: ConsoleLine[] = [];
  let nextRequest: string | null = null;
  let visualizer: { template: string; data: unknown } | null = null;

  const finish = (error: string | null): ScriptOutcome => ({
    // Copied out so a straggling callback that lands after the drain can't rewrite the report.
    scopes: cloneScopes(scopes),
    tests: tests.map((test) => ({ ...test })),
    console: lines.map((line) => ({ ...line })),
    error,
    nextRequest,
    visualizer,
  });

  if (code.trim() === "") return finish(null);

  const log = (level: ConsoleLine["level"], args: unknown[]) => {
    const text = args
      .map((arg) =>
        typeof arg === "string"
          ? arg
          : arg instanceof Error
            ? `${arg.name}: ${arg.message}`
            : typeof arg === "object" && arg !== null
              ? safeStringify(arg, 2)
              : String(arg),
      )
      .join(" ");
    lines.push({ level, text, at: Date.now() });
  };

  const consoleShim = {
    log: (...args: unknown[]) => log("log", args),
    info: (...args: unknown[]) => log("info", args),
    warn: (...args: unknown[]) => log("warn", args),
    error: (...args: unknown[]) => log("error", args),
    debug: (...args: unknown[]) => log("log", args),
  };

  const pending = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>): Promise<T> => {
    const tracked = promise.finally(() => {
      pending.delete(tracked);
    });
    pending.add(tracked);
    return tracked;
  };

  const test = (name: string, fn: () => unknown): Promise<void> => {
    // The slot is reserved now so results keep source order even when an async test finishes late.
    const slot = tests.length;
    const label = String(name);
    tests.push({ name: label, passed: false, error: null, duration_ms: 0 });
    const startedAt = performance.now();

    const record = (error: unknown) => {
      tests[slot] = {
        name: label,
        passed: error === null,
        error: error === null ? null : formatError(error),
        duration_ms: Math.round(performance.now() - startedAt),
      };
    };

    return track(
      (async () => {
        try {
          await fn();
          record(null);
        } catch (error) {
          record(error);
        }
      })(),
    );
  };

  const sendRequest = (
    target: SendTarget,
    callback?: (error: Error | null, response?: ResponseFacade) => void,
  ): Promise<ResponseFacade | undefined> => {
    const call = (async (): Promise<ResponseFacade> => {
      const built = buildAuxRequest(target, ctx.request.options);
      try {
        return makeResponse(await apiSendHttp(built));
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    })();

    if (callback === undefined) return track(call);

    // With a callback the promise never rejects: a fire-and-forget `pm.sendRequest` must not turn
    // a network error into an unhandled rejection in the webview.
    return track(
      call.then(
        (response) => {
          runCallback(callback, null, response);
          return response;
        },
        (error: unknown) => {
          runCallback(callback, error instanceof Error ? error : new Error(String(error)), undefined);
          return undefined;
        },
      ),
    );
  };

  /** A throw inside the user's callback has nowhere to go, so it is reported rather than lost. */
  const runCallback = (
    callback: (error: Error | null, response?: ResponseFacade) => void,
    error: Error | null,
    response: ResponseFacade | undefined,
  ) => {
    try {
      callback(error, response);
    } catch (thrown) {
      log("error", [`pm.sendRequest callback threw: ${formatError(thrown)}`]);
    }
  };

  const setNextRequest = (name: string | null) => {
    // Postman's `setNextRequest(null)` ("stop the run") has no representation in ScriptOutcome,
    // so a null clears the override instead of pretending to halt anything.
    nextRequest = name === null || name === undefined ? null : String(name);
  };

  const pm = {
    environment: listBag(scopes.environment),
    collectionVariables: listBag(scopes.collection),
    globals: listBag(scopes.global),
    variables: mergedBag(scopes),
    iterationData: {
      get: (key: string) =>
        Object.prototype.hasOwnProperty.call(scopes.data, key) ? scopes.data[key] : undefined,
      has: (key: string) => Object.prototype.hasOwnProperty.call(scopes.data, key),
      toObject: () => ({ ...scopes.data }),
    },
    request: makeRequest(ctx.request),
    ...(ctx.response === undefined ? {} : { response: makeResponse(ctx.response) }),
    test,
    expect,
    sendRequest,
    visualizer: {
      set: (template: string, data: unknown) => {
        visualizer = { template: String(template), data };
      },
    },
    execution: { setNextRequest },
  };

  const postman = { setNextRequest };

  let outcomeError: string | null = null;
  try {
    // Wrapped in an async IIFE so top-level `await` works and a bare `return` still exits cleanly.
    const factory = new Function(
      "pm",
      "postman",
      "console",
      "_",
      "CryptoJS",
      `return (async () => {\n${code}\n})();`,
    ) as ScriptFn;
    await factory(pm, postman, consoleShim, LODASH, CRYPTO);
  } catch (error) {
    outcomeError = formatError(error);
  }

  for (let round = 0; round < DRAIN_ROUNDS && pending.size > 0; round += 1) {
    await Promise.allSettled([...pending]);
  }

  return finish(outcomeError);
}

/** Runs before the request goes out. Mutations to `ctx.request` are applied in place. */
export async function runPreRequestScript(
  code: string,
  ctx: { request: ResolvedRequest; scopes: SandboxScopes },
): Promise<ScriptOutcome> {
  return runScript(code, ctx);
}

/** Runs once the response is in. `pm.response` only exists here. */
export async function runPostResponseScript(
  code: string,
  ctx: { request: ResolvedRequest; response: ApiResponse; scopes: SandboxScopes },
): Promise<ScriptOutcome> {
  return runScript(code, ctx);
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

/**
 * The "Snippets" side-list in the script editor. Labels stay English on purpose: they name the
 * `pm.*` call they insert, and translating them would decouple the list from the code and from
 * every Postman tutorial the user is following.
 */
export const SCRIPT_SNIPPETS: { label: string; code: string }[] = [
  {
    label: "Status code is 200",
    code: `pm.test("Status code is 200", function () {\n    pm.response.to.have.status(200);\n});`,
  },
  {
    label: "Status code is successful (2xx)",
    code: `pm.test("Status code is successful", function () {\n    pm.response.to.be.ok;\n});`,
  },
  {
    label: "Status code is one of",
    code: `pm.test("Status code is 200, 201 or 204", function () {\n    pm.expect(pm.response.code).to.be.oneOf([200, 201, 204]);\n});`,
  },
  {
    label: "Response time is under 500ms",
    code: `pm.test("Response time is under 500ms", function () {\n    pm.expect(pm.response.responseTime).to.be.below(500);\n});`,
  },
  {
    label: "Response body contains string",
    code: `pm.test("Body contains 'success'", function () {\n    pm.expect(pm.response.text()).to.include("success");\n});`,
  },
  {
    label: "Response body is valid JSON",
    code: `pm.test("Body is valid JSON", function () {\n    pm.response.to.have.jsonBody();\n});`,
  },
  {
    label: "Check a JSON field",
    code: `pm.test("User id is 42", function () {\n    const body = pm.response.json();\n    pm.expect(body.user.id).to.equal(42);\n});`,
  },
  {
    label: "Response is a non-empty array",
    code: `pm.test("Returns at least one item", function () {\n    const body = pm.response.json();\n    pm.expect(body).to.be.an("array");\n    pm.expect(body.length).to.be.above(0);\n});`,
  },
  {
    label: "Content-Type is JSON",
    code: `pm.test("Content-Type is JSON", function () {\n    pm.response.to.have.header("Content-Type");\n    pm.expect(pm.response.headers.get("Content-Type")).to.include("application/json");\n});`,
  },
  {
    label: "Validate against a JSON schema",
    code: `const schema = {\n    type: "object",\n    required: ["id", "name"],\n    properties: {\n        id: { type: "integer", minimum: 1 },\n        name: { type: "string", minLength: 1 },\n        email: { type: "string", pattern: "^[^@]+@[^@]+$" }\n    }\n};\n\npm.test("Body matches the schema", function () {\n    pm.response.to.have.jsonSchema(schema);\n});`,
  },
  {
    label: "Save a JSON field into an environment variable",
    code: `const body = pm.response.json();\npm.environment.set("authToken", body.access_token);\nconsole.log("Token saved:", pm.environment.get("authToken"));`,
  },
  {
    label: "Set a collection / global variable",
    code: `pm.collectionVariables.set("userId", pm.response.json().id);\npm.globals.set("lastRunAt", new Date().toISOString());`,
  },
  {
    label: "Read a variable (full precedence)",
    code: `// local -> data -> environment -> collection -> global\nconst baseUrl = pm.variables.get("baseUrl");\nconsole.log("baseUrl:", baseUrl);\nconsole.log(pm.variables.replaceIn("{{baseUrl}}/health"));`,
  },
  {
    label: "Pre-request: fetch a token first",
    code: `const res = await pm.sendRequest({\n    url: pm.variables.get("authUrl") + "/oauth/token",\n    method: "POST",\n    header: { "Content-Type": "application/json" },\n    body: { mode: "raw", raw: JSON.stringify({ client_id: pm.environment.get("clientId"), client_secret: pm.environment.get("clientSecret"), grant_type: "client_credentials" }) }\n});\n\npm.environment.set("authToken", res.json().access_token);\npm.request.headers.upsert("Authorization", "Bearer " + pm.environment.get("authToken"));`,
  },
  {
    label: "pm.sendRequest (callback form)",
    code: `pm.sendRequest("https://postman-echo.com/get", function (err, res) {\n    if (err) {\n        console.error(err);\n        return;\n    }\n    console.log(res.code, res.json());\n});`,
  },
  {
    label: "Pre-request: add a timestamp header",
    code: `pm.request.headers.upsert("X-Request-Id", pm.variables.replaceIn("{{$guid}}"));\npm.request.headers.upsert("X-Timestamp", Math.floor(Date.now() / 1000).toString());`,
  },
  {
    label: "Pre-request: sign the body with HMAC-SHA256",
    code: `const payload = pm.request.body.raw || "";\nconst signature = (await CryptoJS.HmacSHA256(payload, pm.environment.get("apiSecret"))).toString();\npm.request.headers.upsert("X-Signature", signature);`,
  },
  {
    label: "Pre-request: add a query parameter",
    code: `pm.request.url.query.upsert("apiKey", pm.environment.get("apiKey"));\nconsole.log(pm.request.url.toString());`,
  },
  {
    label: "Runner: jump to another request",
    code: `if (pm.response.json().hasMore) {\n    postman.setNextRequest("Fetch next page");\n}`,
  },
  {
    label: "Visualize the response",
    code: `const template = '<table><tr><th>Id</th><th>Name</th></tr>{{#each rows}}<tr><td>{{id}}</td><td>{{name}}</td></tr>{{/each}}</table>';\npm.visualizer.set(template, { rows: pm.response.json() });`,
  },
];
