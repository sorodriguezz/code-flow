/**
 * A remote's clone URL read as the web page of its repository, and the page of one commit there —
 * the graph's «Abrir en el navegador». Works from the URL alone, so it needs no linked project and
 * no connection: GitHub, GitLab (self-hosted too), Bitbucket and Azure DevOps (both its hosts and
 * its SSH form). Anything else is assumed to lay its pages out like GitHub, which Gitea, Forgejo
 * and most self-hosted forges do.
 */

export type RemoteHost = "github" | "gitlab" | "bitbucket" | "azure" | "other";

export interface RemoteWeb {
  host: RemoteHost;
  /** `https://host/owner/repo`, no trailing slash, no `.git`. */
  base: string;
}

export function remoteWeb(url: string): RemoteWeb | null {
  const raw = url.trim();
  if (!raw) return null;
  let host: string;
  let path: string;
  // scp-like: `git@host:owner/repo.git`.
  const scp = /^[\w.-]+@([^:/]+):(?!\/)(.+)$/.exec(raw);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) return null;
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!host || !path) return null;

  // Azure DevOps over SSH: `ssh.dev.azure.com:v3/org/project/repo`.
  if (/^(ssh\.)?dev\.azure\.com$/i.test(host) || /\.visualstudio\.com$/i.test(host) || /^vs-ssh\.visualstudio\.com$/i.test(host)) {
    const parts = path.split("/");
    if (parts[0] === "v3" && parts.length >= 4) {
      return { host: "azure", base: `https://dev.azure.com/${parts[1]}/${parts[2]}/_git/${parts[3]}` };
    }
    if (/\.visualstudio\.com$/i.test(host) && !/^vs-ssh\./i.test(host)) {
      return { host: "azure", base: `https://${host}/${path}` };
    }
    return { host: "azure", base: `https://dev.azure.com/${path}` };
  }
  const kind: RemoteHost = /(^|\.)github\.com$/i.test(host)
    ? "github"
    : /gitlab/i.test(host)
      ? "gitlab"
      : /(^|\.)bitbucket\.org$/i.test(host)
        ? "bitbucket"
        : "other";
  return { host: kind, base: `https://${host}/${path}` };
}

/** The web page of `sha` on that remote. */
export function commitWebUrl(url: string, sha: string): string | null {
  const web = remoteWeb(url);
  if (!web) return null;
  switch (web.host) {
    case "gitlab":
      return `${web.base}/-/commit/${sha}`;
    case "bitbucket":
      return `${web.base}/commits/${sha}`;
    case "azure":
      return `${web.base}/commit/${sha}`;
    default:
      return `${web.base}/commit/${sha}`;
  }
}

/** The remote to link to: `origin` when there is one, else the first. */
export function preferredRemoteUrl(remotes: { name: string; url: string }[]): string | null {
  return (remotes.find((r) => r.name === "origin") ?? remotes[0])?.url ?? null;
}
