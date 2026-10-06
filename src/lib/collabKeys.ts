import { apiLoadSettings, apiSharedCollections } from "./tauri/apiCommands";
import { getSetting } from "./tauri/commands";
import { flowsShares } from "./tauri/flowsCommands";
import { sameProject } from "./api/projects";
import type { SupabaseProject } from "../types/api";

/**
 * Who else still needs a Supabase project's stored key.
 *
 * The API client and Flujos each keep **their own list** of projects — set up in their own
 * Collaboration panes — but the credential store files one anon key per project host
 * (`supabase::set_credentials`). Connect the same project in both and there is one key between
 * them, so removing the connection from one pane must not delete a key the other is still
 * authenticating with: that would leave every share on the other side failing with no row
 * anywhere saying why.
 *
 * Asked of every share, not only the hosted ones: a guest's key is the host's project key, filed
 * the same way when an invitation is accepted. When the question cannot be answered, the answer is
 * "yes" — a key kept by mistake costs nothing, a key deleted by mistake breaks sharing.
 */

/** The setting Flujos keeps its own projects in. */
export const FLOWS_PROJECTS_SETTING = "flows_collab_projects";

export function parseProjects(raw: string | null | undefined): SupabaseProject[] {
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter(
          (item): item is SupabaseProject =>
            typeof item === "object" && item !== null && typeof (item as SupabaseProject).url === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export async function keyNeededBy(other: "api" | "flows", url: string): Promise<boolean> {
  try {
    if (other === "flows") {
      const [projects, shares] = await Promise.all([getSetting(FLOWS_PROJECTS_SETTING), flowsShares()]);
      return (
        parseProjects(projects).some((project) => sameProject(project.url, url)) ||
        shares.some((share) => sameProject(share.projectUrl, url))
      );
    }
    const [raw, shares] = await Promise.all([apiLoadSettings(), apiSharedCollections()]);
    const settings = raw ? (JSON.parse(raw) as { supabaseProjects?: SupabaseProject[] }) : {};
    return (
      (settings.supabaseProjects ?? []).some((project) => sameProject(project.url, url)) ||
      shares.some((share) => sameProject(share.project_url, url))
    );
  } catch {
    return true;
  }
}
