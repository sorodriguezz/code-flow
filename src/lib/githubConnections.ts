import { getSetting, setSetting } from "./tauri/commands";
import type { GithubConnection } from "../types/domain";

// One list of GitHub connections (github.com and/or Enterprise hosts) persisted as a single
// app-setting JSON blob — the tokens themselves stay in the OS keychain, keyed per host. This
// is the allowlist the backend reads to know which hosts are safe to auto-detect as GitHub.
const KEY = "github_connections";

/** The canonical public GitHub host — the default a new connection is offered under. */
export const GITHUB_COM = "github.com";

export async function loadGithubConnections(): Promise<GithubConnection[]> {
  const raw = await getSetting(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is GithubConnection => c && typeof c.host === "string");
  } catch {
    return [];
  }
}

export async function saveGithubConnections(connections: GithubConnection[]): Promise<void> {
  await setSetting(KEY, JSON.stringify(connections));
}

/** Reduces a pasted host/URL (`https://github.acme.com/…`) to a bare lowercase hostname. */
export function normalizeGithubHost(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return GITHUB_COM;
  const match = trimmed.match(/^https?:\/\/([^/]+)/i);
  return (match ? match[1] : trimmed).toLowerCase();
}

/** A friendly label for a host — "GitHub.com" for the public host, the bare hostname otherwise. */
export function githubHostLabel(host: string): string {
  return host.toLowerCase() === GITHUB_COM ? "GitHub.com" : host;
}
