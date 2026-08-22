import type { Project, VcsProvider } from "../types/domain";

/**
 * Which host a project is linked to, read from its own columns.
 *
 * This is a **mirror of `linked_repo` in `src-tauri/src/commands/ado_cmd.rs`**, and it has to
 * stay one. That function is the single dispatch point every provider-neutral command branches
 * on; if this disagreed with it, the Pipelines tab would offer one host and the request behind it
 * would go to another — silently, because both answers are individually plausible.
 *
 * So the precedence is the same hard order, **GitHub → GitLab → Azure**, and so are the guards,
 * including the asymmetry between them: GitHub is accepted on the two columns merely being
 * present, GitLab requires a non-blank path. That asymmetry exists in the Rust; copying it is the
 * point. (It is also why `unlink_project` clears all eight columns at once rather than the ones
 * for one provider — an orphaned column would still satisfy this order and route work to the
 * wrong host.)
 */
export function linkedProvider(project: Project | null | undefined): VcsProvider | null {
  if (!project) return null;
  if (project.github_owner && project.github_repo) return "github";
  if (project.gitlab_project && project.gitlab_project.trim() !== "") return "gitlab";
  if (project.ado_org && project.ado_project && project.ado_repo_id) return "azure";
  return null;
}

/**
 * The host or organization that provider would talk to — the thing a "not connected" message has
 * to name, since a user can have three GitHub connections and only one of them missing.
 *
 * Defaults match the Rust: a linked GitHub project with no `github_host` predates per-host
 * connections and means github.com; the same for GitLab.
 */
export function linkedHost(project: Project | null | undefined): string | null {
  if (!project) return null;
  switch (linkedProvider(project)) {
    case "github":
      return project.github_host ?? "github.com";
    case "gitlab":
      return project.gitlab_host ?? "gitlab.com";
    case "azure":
      return project.ado_org;
    default:
      return null;
  }
}
