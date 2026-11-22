import { invoke } from "./invoke";
import { listen } from "@tauri-apps/api/event";

/** One tab of the browser window — see `src-tauri/src/browser_window.rs`. */
export interface BrowserPageState {
  id: number;
  url: string;
  title: string;
  loading: boolean;
}

/** The browser window's tabs, in order, and the one on screen. */
export interface BrowserState {
  tabs: BrowserPageState[];
  active: number | null;
}

/** Opens an address in the «Navegador» window, building it if it is not open: in a tab of its own,
 *  or — `newTab: false`, the address bar — in the tab on screen. */
export const browserOpen = (url: string, newTab = true) => invoke<void>("browser_open", { url, newTab });

/** Brings «Navegador» forward (building it if needed) with its address bar ready for a new tab. */
export const browserShow = () => invoke<void>("browser_show");

/** `browser_show` asked the bar for a new tab's address. */
export const onBrowserNewTab = (handler: () => void) => listen("browser:new-tab", () => handler());

/** Keyboard focus to the bar's own webview, away from the page under it (`browser_focus_bar`). */
export const browserFocusBar = () => invoke<void>("browser_focus_bar");

/** The bar's +: a new, empty tab, put on screen. */
export const browserTabNew = () => invoke<void>("browser_tab_new");

export const browserTabSelect = (id: number) => invoke<void>("browser_tab_select", { id });

/** Closes a tab; the last one closes the window. */
export const browserTabClose = (id: number) => invoke<void>("browser_tab_close", { id });

export const browserGo = (action: "back" | "forward" | "reload" | "stop") => invoke<void>("browser_go", { action });

/** Where the bar ends, in CSS pixels from the top of the window: the page is laid under it. */
export const browserLayout = (top: number) => invoke<void>("browser_layout", { top });

export const browserState = () => invoke<BrowserState>("browser_state");

/** The editor showed a page — what an agent's `browser_current` answers. Empty `url` forgets it. */
export const browserSeen = (url: string, title: string) => invoke<void>("browser_seen", { url, title });

/** The URL the editor's previews load a repository file from (`preview_server.rs`). */
export const previewFileUrl = (root: string, path: string) => invoke<string>("preview_file_url", { root, path });

export const onBrowserState = (handler: (state: BrowserState) => void) =>
  listen<BrowserState>("browser:state", (e) => handler(e.payload));

/** An agent's `browser_open`: a page to put in front of the user. */
export const onBrowserShow = (handler: (show: { url: string }) => void) =>
  listen<{ url: string }>("browser:show", (e) => handler(e.payload));
