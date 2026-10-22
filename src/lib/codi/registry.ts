import type { CodiActionSpec, CodiActRequest, CodiActResult } from "../tauri/codiCommands";
import { foldName } from "./fuzzy";

/**
 * The catalogue of what «Codi» can do in this window, and the one place a request is checked and run.
 *
 * # One list, three doors
 *
 * Every action is declared once, here, as the spec the backend turns into tools (`cf ui`, the app's
 * MCP server, the local model's typed tools) plus the function that does it. Nothing about an
 * action is written down a second time on the Rust side — which is what keeps the three doors
 * agreeing about what exists, what each takes, and how much it can change.
 *
 * # Checked before it runs
 *
 * The caller is a model, often a small local one, and models get parameters wrong in a handful of
 * repeatable ways: a key missing, a number sent as `"12"`, an enum value in the wrong case
 * (`"Flows"`), a value that is not in the enum at all. [`validateParams`] repairs the first two kinds
 * of slip that have exactly one reading (`"12"` → `12`, `"flows"` for `"Flows"`), and refuses the
 * rest with an error that names what was expected — so the model's next try can be right. A handler
 * therefore never sees a parameter its schema does not allow, and does not re-check types.
 *
 * Unknown keys are dropped rather than refused: the backend may add its own (`confirmed`), and a
 * typo of a required key is caught anyway, as the key it failed to provide.
 *
 * # Never throws past the bus
 *
 * [`runRequest`] turns everything — an unknown id, bad params, a handler that throws or rejects —
 * into `{ ok: false, error }`. A handler that has a sentence worth *saying* about the failure ("which
 * one: api-pagos or api-users?") throws a [`CodiError`] carrying it.
 */

/** What a handler is told besides its params. */
export interface CodiContext {
  /** The label of the window running it. */
  window: string;
  /** The request being answered — what an action that belongs to another window hands on. */
  request: CodiActRequest;
}

/** What a handler answers. All optional: a navigation that worked may have nothing to report. */
export interface CodiOutcome {
  /** Short JSON for the engine: what changed, or the data asked for. */
  result?: unknown;
  /** The sentence Codi says, in the app's language, when this action alone answers the order. */
  say?: string;
  /**
   * Runs once the answer has been sent. For an action that ends this window — sending an island
   * back closes it, and a window that closes first never answers.
   */
  after?: () => void;
  /** The request was handed to the window that should run it, which answers it; this one must not. */
  forwarded?: boolean;
}

export type CodiAction = CodiActionSpec & {
  run(params: Record<string, unknown>, ctx: CodiContext): Promise<CodiOutcome>;
};

/** A failure with something worth saying about it. `message` is for the engine, `say` for the user. */
export class CodiError extends Error {
  readonly say?: string;
  constructor(message: string, say?: string) {
    super(message);
    this.name = "CodiError";
    this.say = say;
  }
}

/** The subset of JSON Schema the catalogue uses — and therefore the subset the validator knows. */
export interface ParamSchema {
  type?: "string" | "number" | "integer" | "boolean" | "object" | "array";
  description?: string;
  enum?: readonly (string | number | boolean)[];
  properties?: Record<string, ParamSchema>;
  required?: readonly string[];
  items?: ParamSchema;
  minLength?: number;
  minimum?: number;
  maximum?: number;
}

/** The keys the backend may add to any request, kept through validation. */
const RESERVED_KEYS: Record<string, ParamSchema> = {
  confirmed: { type: "boolean" },
};

/** How many enum values an error lists before it gives up and says how many more there are. */
const ENUM_SHOWN = 24;

function describeEnum(values: readonly unknown[]): string {
  const shown = values.slice(0, ENUM_SHOWN).map((v) => String(v));
  const more = values.length - shown.length;
  return `one of: ${shown.join(", ")}${more > 0 ? `, … (${more} more)` : ""}`;
}

function kindOf(schema: ParamSchema): string {
  return schema.enum ? describeEnum(schema.enum) : (schema.type ?? "any");
}

function describeKey(key: string, schema: ParamSchema, required: boolean): string {
  return `${key}${required ? "" : "?"}: ${kindOf(schema)}`;
}

/** The value as `schema` wants it, or `undefined` with the reason when it cannot be had. */
function coerce(value: unknown, schema: ParamSchema): { value: unknown } | { error: string } {
  let v = value;
  switch (schema.type) {
    case "string":
      if (typeof v === "number" || typeof v === "boolean") v = String(v);
      if (typeof v !== "string") return { error: "must be a string" };
      if (schema.minLength !== undefined && v.trim().length < schema.minLength) return { error: "must not be empty" };
      break;
    case "number":
    case "integer":
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) v = Number(v);
      if (typeof v !== "number" || !Number.isFinite(v)) return { error: `must be a ${schema.type}` };
      if (schema.type === "integer" && !Number.isInteger(v)) return { error: "must be a whole number" };
      if (schema.minimum !== undefined && v < schema.minimum) return { error: `must be at least ${schema.minimum}` };
      if (schema.maximum !== undefined && v > schema.maximum) return { error: `must be at most ${schema.maximum}` };
      break;
    case "boolean":
      if (v === "true" || v === "yes" || v === 1) v = true;
      else if (v === "false" || v === "no" || v === 0) v = false;
      if (typeof v !== "boolean") return { error: "must be true or false" };
      break;
    case "array":
      if (!Array.isArray(v)) return { error: "must be an array" };
      if (schema.items) {
        const out: unknown[] = [];
        for (const [index, entry] of v.entries()) {
          const one = coerce(entry, schema.items);
          if ("error" in one) return { error: `item ${index} ${one.error}` };
          out.push(one.value);
        }
        v = out;
      }
      break;
    case "object":
      if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "must be an object" };
      break;
  }
  if (schema.enum) {
    if (!schema.enum.includes(v as string)) {
      // The one repair that is not a type: `"Flows"` for `"flows"`, `"api requests"` for
      // `"api:requests"` — taken only when the folded spelling names exactly one value.
      const folded = typeof v === "string" ? foldName(v) : null;
      const same = folded ? schema.enum.filter((option) => foldName(String(option)) === folded) : [];
      if (same.length !== 1) return { error: `must be ${describeEnum(schema.enum)}` };
      v = same[0];
    }
  }
  return { value: v };
}

export type Validated = { ok: true; params: Record<string, unknown> } | { ok: false; error: string };

/**
 * `params` checked against an action's object schema — required keys, types, enum membership —
 * and repaired where the repair has exactly one reading. See the module note.
 */
export function validateParams(schema: ParamSchema, params: unknown): Validated {
  const given: Record<string, unknown> =
    params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  if (params !== undefined && params !== null && given !== params) {
    return { ok: false, error: "params must be an object" };
  }
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const problems: string[] = [];
  const out: Record<string, unknown> = {};

  for (const [key, keySchema] of Object.entries({ ...properties, ...RESERVED_KEYS })) {
    const raw = given[key];
    // Absent, null, and an empty string for an optional string key are all "not given" — a model
    // that sends `"tab": ""` meant to leave the tab out. A required one keeps its "", which its
    // `minLength` then refuses (or, for `ui.fill`'s text, accepts: clearing a field is a real ask).
    const absent = raw === undefined || raw === null || (keySchema.type === "string" && raw === "" && !required.has(key));
    if (absent) {
      if (required.has(key)) problems.push(`missing "${key}" (${kindOf(keySchema)})`);
      continue;
    }
    const one = coerce(raw, keySchema);
    if ("error" in one) problems.push(`"${key}" ${one.error}`);
    else out[key] = one.value;
  }

  if (problems.length === 0) return { ok: true, params: out };
  const expected = Object.entries(properties)
    .map(([key, keySchema]) => describeKey(key, keySchema, required.has(key)))
    .join("; ");
  return { ok: false, error: `${problems.join("; ")}. Expected {${expected}}` };
}

const actions = new Map<string, CodiAction>();

/** Adds an action to this window's catalogue. Registering an id again replaces it. */
export function registerAction(action: CodiAction): void {
  actions.set(action.id, action);
}

export function registerActions(list: readonly CodiAction[]): void {
  for (const action of list) registerAction(action);
}

export function getAction(id: string): CodiAction | undefined {
  return actions.get(id);
}

export function listActions(): CodiAction[] {
  return [...actions.values()];
}

/** The specs as the backend wants them — the action minus its function. */
export function actionSpecs(): CodiActionSpec[] {
  return listActions().map(({ run: _run, ...spec }) => spec);
}

/** Tests only. */
export function clearActionsForTests(): void {
  actions.clear();
  undoStack.length = 0;
}

/** What [`runRequest`] hands the bus: the answer to send (none when forwarded) and what runs after. */
export interface RunOutcome {
  answer: CodiActResult | null;
  after?: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
}

/**
 * Where the window was before Codi moved it — what `nav.undo` ("Codi, vuelve") puts back.
 *
 * Kept here, around the run, rather than in each navigation: every `navigate` action that succeeds
 * records the screen it found, whichever area it belongs to, so a navigation added next month is
 * undoable without anybody remembering to make it so. What a "screen" is (view, workspace,
 * repository…) is the history's business — `codi/history.ts` installs it — so this layer stays
 * ignorant of every store. Nothing is recorded when the action changed nothing ("you're already
 * there"), and the undo itself is not recorded, or two undos would bounce between two screens.
 */
export interface ScreenHistory<T = unknown> {
  capture(): T;
  restore(screen: T): Promise<void>;
}

/** How many screens back `nav.undo` can go. */
const UNDO_DEPTH = 10;

let screenHistory: ScreenHistory | null = null;
const undoStack: unknown[] = [];

export function installScreenHistory(history: ScreenHistory | null): void {
  screenHistory = history;
  undoStack.length = 0;
}

/** Puts back the screen before the last navigation Codi ran; `false` when there is none. */
export async function undoNavigation(): Promise<boolean> {
  const screen = undoStack.pop();
  if (screen === undefined || !screenHistory) return false;
  await screenHistory.restore(screen);
  return true;
}

/** How many navigations can be undone — for the tests and `ui.state`'s callers. */
export function undoDepth(): number {
  return undoStack.length;
}

function remember(before: unknown): void {
  if (!screenHistory || before === undefined) return;
  if (JSON.stringify(screenHistory.capture()) === JSON.stringify(before)) return;
  undoStack.push(before);
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
}

/** Looks the action up, checks its params, runs it — and never throws. See the module note. */
export async function runRequest(request: CodiActRequest, window: string): Promise<RunOutcome> {
  const action = actions.get(request.action);
  if (!action) return { answer: { id: request.id, ok: false, error: "unknown action" } };
  const checked = validateParams(action.params as ParamSchema, request.params);
  if (!checked.ok) return { answer: { id: request.id, ok: false, error: `${action.id}: ${checked.error}` } };
  const recorded = action.risk === "navigate" && action.id !== "nav.undo";
  const before = recorded && screenHistory ? screenHistory.capture() : undefined;
  try {
    const outcome = await action.run(checked.params, { window, request: { ...request, params: checked.params } });
    if (outcome.forwarded) return { answer: null };
    if (recorded) remember(before);
    return {
      answer: {
        id: request.id,
        ok: true,
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        ...(outcome.say ? { say: outcome.say } : {}),
      },
      after: outcome.after,
    };
  } catch (error) {
    return {
      answer: {
        id: request.id,
        ok: false,
        error: messageOf(error),
        ...(error instanceof CodiError && error.say ? { say: error.say } : {}),
      },
    };
  }
}
