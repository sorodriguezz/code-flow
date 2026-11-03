import { invoke, pendingInvokes } from "./tauri/invoke";

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

/**
 * Promises Monaco rejects and never catches itself, which say nothing went wrong:
 * - `Canceled` — a request superseded by the next keystroke or a disposed editor (VS Code's own
 *   error handler drops `isCancellationError` the same way).
 * - `Model not found` — the ⌘/Ctrl-hover preview of a definition in a file no editor has open:
 *   `goToDefinitionAtPosition` asks the model service for it, gets nothing, and the jump itself
 *   still works through `registerEditorOpener`. Matched by Monaco's frame, so the same message
 *   from anywhere else is still reported.
 * Each was ~one log line per hover or keystroke (user log, 2026-11-02).
 */
export function monacoNoise(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  if (reason.name === "Canceled" && reason.message === "Canceled") return true;
  return reason.message === "Model not found" && /monaco|_acquire|inMemoryTextModelService/.test(reason.stack ?? "");
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
    if (monacoNoise(event.reason)) {
      event.preventDefault();
      return;
    }
    reportError("unhandledrejection", event.reason);
  });
  watchLongTasks();
}

/** A task on the webview's thread this long is a freeze the user feels. */
const LONG_TASK_MS = 500;

/**
 * Writes each long task of this webview to the app log, with the commands still waiting for an
 * answer and the tabs on screen — so a freeze says whether the page itself was busy (a render, an
 * xterm) and what was going on around it. The backend side is `slow.rs` (the main thread and sync
 * commands). Chromium (WebView2) reports long tasks; WebKit does not, and this then does nothing.
 */
function watchLongTasks(): void {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < LONG_TASK_MS) continue;
        const tabs = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
          .map((tab) => tab.textContent?.trim())
          .filter(Boolean)
          .join(" › ");
        const pending = pendingInvokes(entry.startTime + entry.duration);
        reportError("slow", `long task ${Math.round(entry.duration)} ms`, `tabs: ${tabs || "—"} · waiting: ${pending.join(", ") || "nothing"}`);
      }
    }).observe({ type: "longtask", buffered: false });
  } catch {
    // An observer the webview refuses: nothing to watch with.
  }
}
