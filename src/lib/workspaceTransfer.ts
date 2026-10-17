import * as api from "./tauri/commands";
import type { NewProject, Project, Workspace } from "../types/domain";
import type { SidebarLayout } from "../state/sidebarLayoutStore";

/**
 * The workspace list as a file, to take to another machine: every workspace with its colour and
 * icon, every repository with where it lives, its remote and its host links, and how the projects
 * panel arranges them (pinned, groups). Never a credential — tokens and keys stay in this
 * machine's keychain.
 *
 * Importing **adds and never replaces**: a workspace is matched by name and created when missing; a
 * repository already on the list (same folder) is left as it is; one whose folder does not exist on
 * this machine is still added, and the panel shows it as missing with the way to remove it. That is
 * the honest answer for paths that differ between machines — the list says what was expected.
 */

export const TRANSFER_VERSION = 1;

interface ExportedProject {
  name: string;
  local_path: string;
  remote_url: string | null;
  color: string;
  icon: string;
  links: Pick<
    Project,
    | "ado_org"
    | "ado_project"
    | "ado_repo_id"
    | "github_owner"
    | "github_repo"
    | "github_host"
    | "gitlab_project"
    | "gitlab_host"
  >;
}

interface ExportedWorkspace {
  name: string;
  color: string;
  icon: string;
  projects: ExportedProject[];
  /** By folder rather than by id: ids are this machine's. */
  layout: { pinned: string[]; groups: { name: string; collapsed: boolean; paths: string[] }[] };
}

export interface WorkspaceExport {
  app: "codeflow";
  kind: "workspaces";
  version: number;
  exportedAt: string;
  workspaces: ExportedWorkspace[];
}

export function buildExport(
  workspaces: Workspace[],
  projectsOf: (workspaceId: string) => Project[],
  layoutOf: (workspaceId: string) => SidebarLayout,
): WorkspaceExport {
  return {
    app: "codeflow",
    kind: "workspaces",
    version: TRANSFER_VERSION,
    exportedAt: new Date().toISOString(),
    workspaces: workspaces.map((ws) => {
      const projects = projectsOf(ws.id);
      const pathOf = new Map(projects.map((p) => [p.id, p.local_path]));
      const layout = layoutOf(ws.id);
      return {
        name: ws.name,
        color: ws.color,
        icon: ws.icon,
        projects: projects.map((p) => ({
          name: p.name,
          local_path: p.local_path,
          remote_url: p.remote_url,
          color: p.color,
          icon: p.icon,
          links: {
            ado_org: p.ado_org,
            ado_project: p.ado_project,
            ado_repo_id: p.ado_repo_id,
            github_owner: p.github_owner,
            github_repo: p.github_repo,
            github_host: p.github_host,
            gitlab_project: p.gitlab_project,
            gitlab_host: p.gitlab_host,
          },
        })),
        layout: {
          pinned: layout.pinned.map((id) => pathOf.get(id)).filter((path): path is string => !!path),
          groups: layout.groups.map((g) => ({
            name: g.name,
            collapsed: g.collapsed,
            paths: Object.entries(layout.groupOf)
              .filter(([, groupId]) => groupId === g.id)
              .map(([id]) => pathOf.get(id))
              .filter((path): path is string => !!path),
          })),
        },
      };
    }),
  };
}

/** The file's workspaces, or an error naming what is wrong with it. */
export function parseExport(text: string): WorkspaceExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("not JSON");
  }
  const value = parsed as Partial<WorkspaceExport>;
  if (!value || value.app !== "codeflow" || value.kind !== "workspaces" || !Array.isArray(value.workspaces)) {
    throw new Error("not a CodeFlow workspace export");
  }
  if (typeof value.version !== "number" || value.version > TRANSFER_VERSION) {
    throw new Error(`made by a newer CodeFlow (format ${String(value.version)})`);
  }
  return value as WorkspaceExport;
}

/** Comparable folder paths: one separator, no trailing slash, case-folded on Windows. */
export function samePath(a: string, b: string): boolean {
  const norm = (path: string) => {
    const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-zA-Z]:\//.test(clean) ? clean.toLowerCase() : clean;
  };
  return norm(a) === norm(b);
}

export interface ImportOutcome {
  workspacesCreated: number;
  projectsAdded: number;
  projectsSkipped: number;
  /** Workspace id → the layout to merge, by the new project ids. */
  layouts: Map<string, { pinned: string[]; groups: { name: string; collapsed: boolean; ids: string[] }[] }>;
}

/**
 * Adds what the export has and this machine does not. `existing` is every project on every
 * workspace here (paths are global: the same folder is never added twice, whatever workspace).
 */
export async function applyImport(
  data: WorkspaceExport,
  workspaces: Workspace[],
  existing: Project[],
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { workspacesCreated: 0, projectsAdded: 0, projectsSkipped: 0, layouts: new Map() };
  const known = [...existing];
  for (const exported of data.workspaces) {
    let workspace = workspaces.find((ws) => ws.name.trim().toLowerCase() === exported.name.trim().toLowerCase());
    if (!workspace) {
      workspace = await api.createWorkspace(exported.name, exported.icon || "initials", exported.color);
      workspaces = [...workspaces, workspace];
      outcome.workspacesCreated++;
    }
    const idOfPath = new Map<string, string>();
    for (const project of exported.projects ?? []) {
      const already = known.find((p) => samePath(p.local_path, project.local_path));
      if (already) {
        outcome.projectsSkipped++;
        if (already.workspace_id === workspace.id) idOfPath.set(project.local_path, already.id);
        continue;
      }
      const input: NewProject = {
        workspace_id: workspace.id,
        name: project.name,
        local_path: project.local_path,
        remote_url: project.remote_url,
        color: project.color,
        icon: project.icon,
        ado_org: project.links?.ado_org ?? null,
        ado_project: project.links?.ado_project ?? null,
        ado_repo_id: project.links?.ado_repo_id ?? null,
        github_owner: project.links?.github_owner ?? null,
        github_repo: project.links?.github_repo ?? null,
        github_host: project.links?.github_host ?? null,
        gitlab_project: project.links?.gitlab_project ?? null,
        gitlab_host: project.links?.gitlab_host ?? null,
      };
      const created = await api.createProject(input);
      known.push(created);
      idOfPath.set(project.local_path, created.id);
      outcome.projectsAdded++;
    }
    const ids = (paths: string[]) => paths.map((path) => idOfPath.get(path)).filter((id): id is string => !!id);
    outcome.layouts.set(workspace.id, {
      pinned: ids(exported.layout?.pinned ?? []),
      groups: (exported.layout?.groups ?? []).map((g) => ({ name: g.name, collapsed: g.collapsed, ids: ids(g.paths ?? []) })),
    });
  }
  return outcome;
}
