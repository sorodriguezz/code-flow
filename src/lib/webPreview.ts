import { browserOpen, browserShow } from "./tauri/browserCommands";
import { isMainWindow } from "./windowIdentity";
import { pushErrorToast } from "../state/toastStore";
import { useUiStore } from "../state/uiStore";
import { useWorkspaceStore } from "../state/workspaceStore";

/**
 * Where a page opens inside CodeFlow — one rule, for every way in (a link, the terminal, Services,
 * the command palette, an agent's `browser_open`):
 *
 * - **The user's own pages** — a dev server on `localhost`, a file of the repository served by
 *   `preview_server` — open as a tab of the editor, beside the code that draws them. An iframe is
 *   enough for those: nothing on this machine refuses to be framed.
 * - **The internet** opens in the «Navegador» window, a native webview of its own
 *   (`browser_window.rs`): most sites refuse to be framed, and a site is not part of the code.
 *
 * A window that has no editor — a satellite, or the main window with no repository open — sends its
 * own pages to «Navegador» too, which loads them just as well.
 */

/** `localhost`, `127.x`, `0.0.0.0`, `[::1]` — the machine itself. */
export function isLocalAddress(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host.startsWith("127.") || host === "0.0.0.0" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * What was typed in an address bar, as a URL: no scheme means `http` for this machine and `https`
 * for anything else. `null` for something that is not an http(s) address at all. Mirrors
 * `browser_window::parse_address`, which checks again.
 */
export function normalizeAddress(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(text);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${local ? "http" : "https"}://${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A short name for a page's tab: its host and path, without the scheme. */
export function addressLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : decodeURIComponent(parsed.pathname);
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

/** Opens `url` in the «Navegador» window. */
export function openInBrowserWindow(url: string): void {
  void browserOpen(url).catch((e: unknown) => pushErrorToast(String(e)));
}

/** «Navegador» with a new tab's address bar ready — the rail's button and its chord. */
export function showBrowser(): void {
  void browserShow().catch((e: unknown) => pushErrorToast(String(e)));
}

/** Opens `address` inside CodeFlow, by the rule in the module note. */
export function openInCodeFlow(address: string): void {
  const url = normalizeAddress(address);
  if (!url) {
    pushErrorToast(address);
    return;
  }
  const hasEditor = isMainWindow() && useWorkspaceStore.getState().activeProject() !== null;
  if (isLocalAddress(url) && hasEditor) {
    useUiStore.getState().openWebInEditor(url);
    return;
  }
  openInBrowserWindow(url);
}
