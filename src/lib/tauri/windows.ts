import { invoke } from "@tauri-apps/api/core";
import type { DetachableKind, SatelliteKind } from "../windowIdentity";

/** One open satellite, as `windows.rs` reports it. Snake case because it crosses the IPC boundary
 *  as a serde struct and renaming on one side only is how those drift. */
export interface SatelliteInfo {
  label: string;
  kind: SatelliteKind;
  ref_id: string;
}

/**
 * Opens the window for one app or one repository — or focuses the one already showing it.
 *
 * Idempotent on `(kind, refId)` by design, which is the whole of "detaching moves, it never
 * duplicates": there is no way to ask for a second window on the same thing.
 *
 * `title` is what the OS calls the window (task bar, ⌘`, the window menu), so it is passed from
 * here: an app's name is a translated string and a repository's is user data, and neither belongs
 * on the Rust side.
 *
 * `workspaceId` is the workspace of the window doing the opening, and the new window opens on it.
 * A window that is already open keeps its own.
 *
 * `at` is where its top-left corner goes, in logical screen pixels — a tab dragged out of the
 * editor opens where it was let go. Without it the window cascades off the others.
 */
export const openSatellite = (
  kind: DetachableKind,
  refId: string,
  title: string,
  workspaceId: string | null,
  at?: { x: number; y: number },
) => invoke<string>("open_satellite", { kind, refId, title, workspaceId, x: at?.x ?? null, y: at?.y ?? null });

export const focusSatellite = (label: string) => invoke<void>("focus_satellite", { label });

export const listSatellites = () => invoke<SatelliteInfo[]>("list_satellites");

/**
 * Puts back the satellites the tray put away, and answers with how many came back.
 *
 * Called when the main window returns from the tray (`app:foreground`), and only then — a launch
 * restores nothing. Windows that were hidden because they held unsaved work are shown again; the
 * rest are reopened. A window whose repository has since been deleted simply does not come back.
 * See `restore_satellites` in `windows.rs`.
 */
export const restoreSatellites = () => invoke<number>("restore_satellites");

/** What a given window holds. The window itself reads its identity from its query string; this is
 *  for the restore path and for anything asking about a window that is not this one. */
export const satelliteSpec = (label: string) =>
  invoke<SatelliteInfo | null>("satellite_spec", { label });

/**
 * Puts the main window back on screen, asked from a window that is not it.
 *
 * Not the same thing as the `focus-main` bus message, which has the main window call `setFocus()`
 * on itself: that is enough for a satellite re-attaching, and does nothing at all when the main
 * window is **hidden to the tray** — which is the ask box's ordinary case, since the whole point of
 * the hotkey is that it works after the desk has been put away. See `show_main_window` in
 * `windows.rs` for the rest of what restoring actually involves.
 */
export const showMainWindow = () => invoke<void>("show_main_window");

/**
 * Puts the native backdrop of the see-through window on or off — for the window that calls it, and
 * only that one: every window's own `glassStore` asks for itself. `theme` is the stored light/dark
 * preference, which the backdrop is tinted by; see `apply_native` in `glass.rs`.
 */
export const setWindowGlass = (enabled: boolean, theme: "light" | "dark" | "system") =>
  invoke<void>("set_window_glass", { enabled, theme });

/**
 * Tells the backend whether this window holds unsaved work, so putting the app in the tray hides it
 * instead of closing it — see `set_window_unsaved` and `close_all` in `windows.rs`. The label comes
 * from the calling webview; the main window's answer is ignored there.
 */
export const setWindowUnsaved = (unsaved: boolean) => invoke<void>("set_window_unsaved", { unsaved });

/** Raises the hotkey ask box, building it if needed. */
export const quickAskOpen = () => invoke<string>("quick_ask_open");

/** The quick-ask hotkey as stored: the chord bound now (`null` when switched off), and this
 *  platform's default. */
export interface QuickAskShortcut {
  accelerator: string | null;
  defaultAccelerator: string;
}

export const getQuickAskShortcut = () => invoke<QuickAskShortcut>("get_quick_ask_shortcut");

/** Binds the system-wide chord. Rejects with a readable reason when the chord does not parse or
 *  another application owns it — the caller shows it and does not save the choice. */
export const registerQuickAskShortcut = (accelerator: string) =>
  invoke<void>("register_quick_ask_shortcut", { accelerator });

export const unregisterQuickAskShortcut = () => invoke<void>("unregister_quick_ask_shortcut");

/** The first-close notice's "keep it in the tray": records that it was seen, then hides the main
 *  window exactly as the close button does. See `tray::close_action`. */
export const hideMainToTray = () => invoke<void>("hide_main_to_tray");

/** Launch at login. `setAutostart` answers with what the system says afterwards. */
export const autostartEnabled = () => invoke<boolean>("autostart_enabled");
export const setAutostart = (enabled: boolean) => invoke<boolean>("set_autostart", { enabled });

/** Whether the login item will actually start CodeFlow — see `autostart.rs`. `problem`:
 *  `blocked` (macOS: off in Login Items), `translocated` (macOS: running from a temporary copy),
 *  `missing` (the registered program is gone), `taskManager` (Windows: off in Startup apps). */
export interface AutostartStatus {
  enabled: boolean;
  target: string | null;
  problem: "blocked" | "translocated" | "missing" | "taskManager" | null;
  /** When the login item last started CodeFlow, RFC 3339. */
  lastAutostart: string | null;
}
export const autostartStatus = () => invoke<AutostartStatus>("autostart_status");
/** The system's own list of what starts at login. */
export const autostartOpenSystemSettings = () => invoke<void>("autostart_open_system_settings");

/** «Evitar que el equipo se suspenda» — see `keep_awake.rs`. */
export type KeepAwakeMode = "off" | "busy" | "always";
export interface KeepAwakeStatus {
  mode: KeepAwakeMode;
  /** The system is being kept awake right now. */
  holding: boolean;
  supported: boolean;
  /** What is at work: AI runs, flow runs, armed flows, services. */
  reasons: { kind: "ai" | "flowRuns" | "flowsArmed" | "services"; count: number }[];
}
export const keepAwakeStatus = () => invoke<KeepAwakeStatus>("keep_awake_status");
export const setKeepAwake = (mode: KeepAwakeMode) => invoke<KeepAwakeStatus>("set_keep_awake", { mode });

/** The operating system's locale (`es-CL`, `en-US`…), or `null` when it cannot be read. */
export const systemLocale = () => invoke<string | null>("system_locale");
