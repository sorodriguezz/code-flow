import { invoke } from "@tauri-apps/api/core";
import type { SatelliteKind } from "../windowIdentity";

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
 */
export const openSatellite = (kind: SatelliteKind, refId: string, title: string) =>
  invoke<string>("open_satellite", { kind, refId, title });

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
