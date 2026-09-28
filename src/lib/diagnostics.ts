import { invoke } from "@tauri-apps/api/core";

/**
 * What the app knows about itself when something went wrong — and the way a webview's own errors
 * reach the app log.
 *
 * Until this existed a frontend error went to `console.error` and nowhere else: a render that threw
 * on somebody's machine left nothing in `codeflow.log`, which is the one file they can be asked for.
 * The backend owns the log, the scrubbing and the rate limit (`applog.rs`); this side only reports.
 */

/** Where "Report a problem" and "Documentation" go — the macOS menu's items use it too. */
export const REPO_URL = "https://github.com/sorodriguezz/code-flow";

/** Mirrors `AppDiagnostics` in `applog.rs`. */
export interface AppDiagnostics {
  version: string;
  os: string;
  osVersion: string;
  arch: string;
  locale: string | null;
  stateDir: string;
  logsDir: string;
}

export const appDiagnostics = () => invoke<AppDiagnostics>("app_diagnostics");

/** The text "Copy diagnostics" puts on the clipboard: build, system, and the log's last lines —
 *  scrubbed of secrets, with the home directory written as `~`. */
export const diagnosticsReport = () => invoke<string>("diagnostics_report");

/** `THIRD-PARTY-NOTICES.md` as compiled into this build — the copy the licences require to travel
 *  with the app, not with the source. */
export const thirdPartyNotices = () => invoke<string>("third_party_notices");

/** A new GitHub issue with `body` filled in. Only what the caller puts in the body travels — never
 *  the log, which is the user's to paste or not. */
export function newIssueUrl(body: string): string {
  return `${REPO_URL}/issues/new?body=${encodeURIComponent(body)}`;
}

/** A thrown value, as one line: an `Error`'s message, a string as it is, anything else as JSON. */
export function describeThrown(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The same message twice within this long is one report — a render loop throwing every frame
 *  would otherwise be one IPC call per frame. The backend budgets what reaches the file as well. */
const REPEAT_MS = 2000;
let last: { text: string; at: number } | null = null;

/** Sends one error to the app log. Never throws, never awaits anything a caller depends on. */
export function reportError(kind: string, error: unknown, detail?: string | null): void {
  const message = describeThrown(error);
  const now = Date.now();
  if (last && last.text === `${kind}:${message}` && now - last.at < REPEAT_MS) return;
  last = { text: `${kind}:${message}`, at: now };
  const stack = detail ?? (error instanceof Error ? error.stack : undefined) ?? null;
  void invoke<void>("log_frontend_error", { kind, message, detail: stack }).catch(() => {});
}

let installed = false;

/**
 * Routes this window's uncaught errors and unhandled promise rejections to the app log. Called once
 * from each entry (`main.tsx`, `satellite.tsx`); the console still gets them as before.
 */
export function installErrorReporting(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    const where = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : null;
    reportError("error", event.error ?? event.message, (event.error as Error | undefined)?.stack ?? where);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportError("unhandledrejection", event.reason);
  });
}
