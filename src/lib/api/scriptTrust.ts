/**
 * The trust gate in front of the script sandbox.
 *
 * `sandbox.ts` runs a script in the webview's own realm, with everything the app's JavaScript can
 * reach — every Tauri command included. That is only acceptable for code the user chose to run, and
 * an import or a shared collection brings code nobody here chose. So before a send (or a runner
 * run) executes a single script, every script it *would* run is checked, and anything not already
 * trusted is shown to the user first.
 *
 * A script is trusted when its **exact text** is:
 *
 * - **authored** — typed into this app's own script editor. Instantly for the session (the editor
 *   reports every change it makes), and persisted a moment later so a restart doesn't ask about it;
 * - **approved** — accepted in the gate dialog, which showed the code;
 * - **migration** — already here when the gate shipped, outside collections linked to collaboration.
 *
 * Trust is keyed by a SHA-256 of the text and stored locally only (`api_script_trust`, see
 * `src-tauri/src/db/api_trust.rs`). Any change to the text is a new hash, so a collaborator's edit
 * to a script you approved asks again — which is the point.
 */

import {
  apiScriptTrustLookup,
  apiScriptTrustRecord,
  type ScriptTrustRow,
} from "../tauri/apiCommands";

export type ScriptPhase = "pre" | "post";
export type ScriptLevel = "collection" | "folder" | "request";

/** One script a send would run, and where it lives. */
export interface ScriptRef {
  level: ScriptLevel;
  phase: ScriptPhase;
  /** The collection, folder or request holding it — what the gate names it by. */
  owner: string;
  /** The collection it belongs to; `null` for a request not filed anywhere yet. */
  collectionId: string | null;
  code: string;
}

/** One distinct untrusted text, with every place it would run from. */
export interface UntrustedScript {
  hash: string;
  code: string;
  /** Where the row says it came from (`import:postman`, `shared`…), `null` when nothing is known. */
  origin: string | null;
  refs: ScriptRef[];
}

export type GateDecision = "trust" | "skip" | "cancel";

/** What a send may execute once the gate has answered. */
export interface GateResult {
  allows: (ref: ScriptRef) => boolean;
  /** The distinct texts that will not run ("send without scripts"). Empty when all may run. */
  skipped: UntrustedScript[];
}

export function isRunnable(code: string): boolean {
  return code.trim() !== "";
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

/**
 * SHA-256 of the UTF-8 text, lowercase hex — the same function as `api_trust::script_hash` in Rust
 * (both pinned to one test vector). No normalisation: trimming or folding line endings would let
 * two different programs share one approval.
 */
export async function scriptHash(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  let out = "";
  for (const byte of new Uint8Array(digest)) out += HEX[byte];
  return out;
}

// ---------------------------------------------------------------------------
// Authored in this app
// ---------------------------------------------------------------------------

/**
 * The latest text each script editor produced, keyed by its buffer.
 *
 * Monaco's `onChange` fires for the user's own edits only — typing, paste, undo, a snippet from
 * the rail — and not when the draft is replaced from outside (a collaborator's version arriving, a
 * history entry opened), so "the editor produced this text" is exactly "the user wrote this". One
 * text per buffer, not every keystroke, which keeps the map the size of the open editors.
 */
const authored = new Map<string, string>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** How long the editor has to sit still before its text is written down as trusted. */
const AUTHORED_PERSIST_MS = 800;

/** Called by the script editor on every change it makes. */
export function noteAuthoredScript(buffer: string, code: string): void {
  authored.set(buffer, code);
  const pending = persistTimers.get(buffer);
  if (pending !== undefined) clearTimeout(pending);
  if (!isRunnable(code)) {
    persistTimers.delete(buffer);
    return;
  }
  persistTimers.set(
    buffer,
    setTimeout(() => {
      persistTimers.delete(buffer);
      void trustScripts([code], "authored").catch(() => {
        // The session still trusts it; the worst a failed write costs is one question next launch.
      });
    }, AUTHORED_PERSIST_MS),
  );
}

/** Writes down whatever the editors produced that is still waiting on its debounce — on save. */
export async function flushAuthoredScripts(): Promise<void> {
  const codes: string[] = [];
  for (const [buffer, timer] of persistTimers) {
    clearTimeout(timer);
    const code = authored.get(buffer);
    if (code !== undefined) codes.push(code);
  }
  persistTimers.clear();
  if (codes.length > 0) await trustScripts(codes, "authored");
}

export function isAuthored(code: string): boolean {
  for (const text of authored.values()) if (text === code) return true;
  return false;
}

/** Test seam: the session's memory of authored text. */
export function forgetAuthoredScripts(): void {
  for (const timer of persistTimers.values()) clearTimeout(timer);
  persistTimers.clear();
  authored.clear();
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

type Lookup = (hashes: string[]) => Promise<ScriptTrustRow[]>;
type RecordTrust = (entries: ScriptTrustRow[]) => Promise<void>;

/**
 * The scripts among `refs` that may not run unasked, one entry per distinct text.
 *
 * Blank scripts never run, so they are never asked about; text authored in this session is trusted
 * without a lookup, so typing and sending never waits on a round trip for your own code.
 */
export async function findUntrusted(
  refs: ScriptRef[],
  lookup: Lookup = apiScriptTrustLookup,
): Promise<UntrustedScript[]> {
  const byCode = new Map<string, ScriptRef[]>();
  for (const ref of refs) {
    if (!isRunnable(ref.code) || isAuthored(ref.code)) continue;
    const list = byCode.get(ref.code);
    if (list) list.push(ref);
    else byCode.set(ref.code, [ref]);
  }
  if (byCode.size === 0) return [];

  const candidates = await Promise.all(
    [...byCode].map(async ([code, list]) => ({ code, refs: list, hash: await scriptHash(code) })),
  );
  // A lookup that fails can't vouch for anything, so everything unauthored is asked about: closed,
  // but never a dead end — the dialog still offers to trust and run.
  const found = await lookup(candidates.map((entry) => entry.hash)).catch((): ScriptTrustRow[] => []);
  const rows = new Map(found.map((row) => [row.hash, row]));

  return candidates
    .filter((entry) => rows.get(entry.hash)?.trusted !== true)
    .map((entry) => ({ ...entry, origin: rows.get(entry.hash)?.origin || null }));
}

/** Marks these texts trusted. `approved` from the gate, `authored` from the editor. */
export async function trustScripts(
  codes: string[],
  origin: "approved" | "authored",
  record: RecordTrust = apiScriptTrustRecord,
): Promise<void> {
  const distinct = [...new Set(codes.filter(isRunnable))];
  if (distinct.length === 0) return;
  const entries = await Promise.all(
    distinct.map(async (code) => ({ hash: await scriptHash(code), trusted: true, origin })),
  );
  await record(entries);
}

/**
 * Asks about whatever in `refs` isn't trusted, and says what may run.
 *
 * - nothing untrusted → everything runs, and `ask` is never called;
 * - **trust** → the texts are recorded as approved and everything runs;
 * - **skip** → everything runs *except* the texts listed (the user's own scripts still do);
 * - **cancel** → `null`, and the caller sends nothing.
 *
 * Skipping is by text, not by ref: the same untrusted code listed once stays out wherever else in
 * the run it appears.
 */
export async function gateScripts(
  refs: ScriptRef[],
  ask: (untrusted: UntrustedScript[]) => Promise<GateDecision>,
  deps: { lookup?: Lookup; record?: RecordTrust } = {},
): Promise<GateResult | null> {
  const untrusted = await findUntrusted(refs, deps.lookup);
  if (untrusted.length === 0) return { allows: () => true, skipped: [] };

  const decision = await ask(untrusted);
  if (decision === "cancel") return null;
  if (decision === "trust") {
    // The approval stands for this run even if writing it down fails; the cost of a failed write is
    // being asked once more next time, not a send that silently didn't happen.
    await trustScripts(
      untrusted.map((entry) => entry.code),
      "approved",
      deps.record,
    ).catch(() => {});
    return { allows: () => true, skipped: [] };
  }
  const blocked = new Set(untrusted.map((entry) => entry.code));
  return { allows: (ref) => !blocked.has(ref.code), skipped: untrusted };
}
