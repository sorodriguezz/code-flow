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
 */
export const openSatellite = (kind: DetachableKind, refId: string, title: string, workspaceId: string | null) =>
  invoke<string>("open_satellite", { kind, refId, title, workspaceId });

export const focusSatellite = (label: string) => invoke<void>("focus_satellite", { label });

export const listSatellites = () => invoke<SatelliteInfo[]>("list_satellites");

/**
 * Reopens the satellites the last session ended with, and answers with how many came back.
 *
 * Called from the main window's boot, not from Rust's `setup`: the main window having booted is
 * this app's own evidence that the database migrated and the session is worth restoring. A window
 * whose repository has since been deleted simply does not come back.
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
