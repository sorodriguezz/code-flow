import { getSetting, setSetting } from "./tauri/commands";

/**
 * One connected Linear organisation. The API key is **not** here — it lives in the OS keychain,
 * keyed `linear-token:{key}`.
 *
 * Shaped like monday's list and for the same reason: one API host serves every organisation, so
 * the key *is* the identity, and the organisation's url key is read back from Linear when it is
 * saved rather than typed.
 */
export interface LinearConnection {
  /** The organisation's url key — `acme` for `linear.app/acme`. Read from Linear, never typed. */
  key: string;
  name: string;
}

const KEY = "linear_connections";

export async function loadLinearConnections(): Promise<LinearConnection[]> {
  const raw = await getSetting(KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is LinearConnection => !!c && typeof (c as LinearConnection).key === "string" && (c as LinearConnection).key.trim() !== "");
  } catch {
    return [];
  }
}

export async function saveLinearConnections(connections: LinearConnection[]): Promise<void> {
  await setSetting(KEY, JSON.stringify(connections));
}
