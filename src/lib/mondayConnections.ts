import { getSetting, setSetting } from "./tauri/commands";

/**
 * One connected monday.com account.
 *
 * The API token is **not** here — it lives in the OS keychain, keyed `monday-token:{slug}`.
 *
 * The odd one of the three connection lists, and for a structural reason: Azure is keyed by the
 * organisation the user types and Jira by the site, but every monday customer is served from the
 * same API endpoint, so there is no address to key by. The token *is* the identity. So the slug is
 * read back **from monday** when the token is saved rather than typed, which is what stops two
 * accounts colliding under a name somebody invented — and it doubles as the subdomain every item
 * link is built from.
 */
export interface MondayConnection {
  /** The account subdomain — `acme` for `acme.monday.com`. Read from the host, never typed. */
  slug: string;
  /** The account's display name, for the list. Not an identifier. */
  name: string;
}

const KEY = "monday_connections";

export async function loadMondayConnections(): Promise<MondayConnection[]> {
  const raw = await getSetting(KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is MondayConnection =>
        !!c &&
        typeof (c as MondayConnection).slug === "string" &&
        (c as MondayConnection).slug.trim() !== "",
    );
  } catch {
    // A blob that isn't JSON is one nobody can act on. Reported as "no connections" rather than
    // thrown: the settings screen's job at that point is to let the user save a good one over it.
    return [];
  }
}

export async function saveMondayConnections(connections: MondayConnection[]): Promise<void> {
  await setSetting(KEY, JSON.stringify(connections));
}
