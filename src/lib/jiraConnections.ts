import { getSetting, setSetting } from "./tauri/commands";

/**
 * One connected Jira site.
 *
 * The API token is **not** here — it lives in the OS keychain, keyed `jira-token:{site}`. What is
 * here is the pair that is not secret: which site, and which account e-mail the token belongs to.
 * Jira Cloud authenticates `email:token` over HTTP Basic, so the address is half the credential and
 * still not a password; keeping it beside the site is what lets the list show *who* is connected
 * rather than just where.
 *
 * Mirrors `adoConnections` on purpose — same storage shape, same multi-account model — so a user
 * with a work Jira and a personal one is in the same position as one with two Azure organisations.
 */
export interface JiraConnection {
  /** As the user typed it. Normalised to an origin before any request; see `normalizeJiraSite`. */
  site: string;
  email: string;
}

const KEY = "jira_connections";

export async function loadJiraConnections(): Promise<JiraConnection[]> {
  const raw = await getSetting(KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is JiraConnection =>
        !!c && typeof (c as JiraConnection).site === "string" && (c as JiraConnection).site.trim() !== "",
    );
  } catch {
    // A blob that isn't JSON is a blob nobody can act on. Reported as "no connections" rather than
    // thrown: the settings screen's job at that point is to let the user save a good one over it.
    return [];
  }
}

export async function saveJiraConnections(connections: JiraConnection[]): Promise<void> {
  await setSetting(KEY, JSON.stringify(connections));
}

/**
 * Accepts whatever the user typed — `acme`, `acme.atlassian.net`, or a full URL with a path — and
 * reduces it to the origin every request hangs off.
 *
 * A deliberate twin of `normalize_site` in `boards/jira.rs`, and it has to stay one: this is what
 * decides whether the connection the user saved matches the site a story set is pointed at, and a
 * disagreement between the two sides shows up as "no connection saved" for a connection that is
 * plainly on screen. A bare word gains `.atlassian.net` because that is what a Cloud user means by
 * their site name; anything with a dot is taken as a hostname, which is what makes Server and Data
 * Center installs work without a second setting.
 */
export function normalizeJiraSite(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const withoutScheme = trimmed.replace(/^https?:\/\//i, "");
  const host = withoutScheme.split("/")[0];
  if (!host) return "";
  return host.includes(".") ? `https://${host}` : `https://${host}.atlassian.net`;
}
