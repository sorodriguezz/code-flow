import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useRepoStore } from "../../../state/repoStore";
import { useWindowStore } from "../../../state/windowStore";
import { REPO_VIEWS, useUiStore } from "../../../state/uiStore";
import { CodiError, type CodiAction } from "../registry";
import type { BranchInfo } from "../../../types/domain";
import {
  closedReason,
  defineAction,
  findRepoToAct,
  optionalText,
  params,
  pickByName,
  requireProject,
  say,
  spokenList,
  text,
  workspaceName,
} from "./shared";

/**
 * Where the window is: its workspace, its repository, its branch.
 *
 * Names are matched loosely (see `fuzzy`) and never guessed at: "api pagos" finds `api-pagos`, and a
 * name that fits two repositories is asked back rather than picked.
 */

/** The island a repository is showing in, if it is in one. */
function repoIsland(projectId: string): string | null {
  return useWindowStore.getState().detachedLabel("repo", projectId);
}

/** Workspace list and switch — for the main window and app islands, which each hold their own. */
export function workspaceActions(): CodiAction[] {
  return [
    defineAction({
      id: "workspace.list",
      title: { en: "List the workspaces, and which one this window is on.", es: "Lista los workspaces y en cuál está esta ventana." },
      aliases: { es: ["que workspaces hay", "que workspaces tengo", "lista los workspaces", "mis workspaces", "cuales son mis workspaces"], en: ["which workspaces", "list the workspaces", "my workspaces", "what workspaces do i have"] },
      params: params(),
      risk: "read",
      where: "any",
      run: async () => {
        const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState();
        const names = workspaces.map((w) => w.name);
        return {
          result: { workspaces: workspaces.map((w) => ({ name: w.name, active: w.id === activeWorkspaceId || undefined })) },
          say: say("codi.say.workspaces", { list: spokenList(names) }),
        };
      },
    }),
    defineAction({
      id: "workspace.switch",
      title: {
        en: "Switch this window to another workspace, by name (loose match: case, accents and dashes do not matter).",
        es: "Cambia esta ventana a otro workspace, por nombre (coincidencia flexible: mayúsculas, tildes y guiones dan igual).",
      },
      aliases: { es: ["cambia al workspace", "cambia de workspace", "ve al workspace", "pasa al workspace", "abre el workspace", "cambia al espacio de trabajo", "workspace"], en: ["switch to workspace", "switch workspace", "go to workspace", "open workspace", "change workspace"] },
      params: params({ name: text("The workspace's name, as said.") }, ["name"]),
      risk: "navigate",
      where: "any",
      frequent: true,
      run: async ({ name }) => {
        const { workspaces, activeWorkspaceId, setActiveWorkspace } = useWorkspaceStore.getState();
        const target = pickByName(workspaces, String(name), (w) => w.name, "workspace", undefined, (w) => ({ action: "workspace.switch", params: { name: w.name } }));
        if (target.id === activeWorkspaceId) {
          return { result: { workspace: target.name, already: true }, say: say("codi.say.alreadyInWorkspace", { name: target.name }) };
        }
        setActiveWorkspace(target.id);
        return { result: { workspace: target.name }, say: say("codi.say.workspaceSwitched", { name: target.name }) };
      },
    }),
  ];
}

/** Repository list and switch — the main window's; an island holds one repository and keeps it. */
export function repoActions(): CodiAction[] {
  return [
    defineAction({
      id: "repo.list",
      title: {
        en: "List the repositories of this window's workspace, which one is open, and which are in islands or unavailable.",
        es: "Lista los repositorios del workspace de esta ventana, cuál está abierto y cuáles están en islas o no disponibles.",
      },
      aliases: { es: ["que repos hay", "que repositorios hay", "lista los repos", "lista los repositorios", "mis repos", "mis repositorios"], en: ["which repos", "list the repos", "list the repositories", "my repos", "my repositories"] },
      params: params(),
      risk: "read",
      where: "main",
      run: async () => {
        const ws = useWorkspaceStore.getState();
        const workspace = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId) ?? null;
        const projects = ws.activeWorkspaceId ? (ws.projectsByWorkspace[ws.activeWorkspaceId] ?? []) : [];
        const names = projects.map((p) => p.name);
        return {
          result: {
            workspace: workspace?.name ?? null,
            repos: projects.map((p) => {
              const closed = closedReason(p);
              return { name: p.name, active: p.id === ws.activeProjectId || undefined, ...(closed ? { [closed]: true } : {}) };
            }),
          },
          say: names.length ? say("codi.say.repos", { list: spokenList(names) }) : say("codi.say.noRepos"),
        };
      },
    }),
    defineAction({
      id: "repo.switch",
      title: {
        en: "Open another repository in this window, by name (loose match: \"api pagos\" finds api-pagos). Looks in this workspace; one found only in another workspace is asked about first, unless `workspace` names where it is. A repository in an island brings that island forward. «The X app» is often a repository.",
        es: "Abre otro repositorio en esta ventana, por nombre (coincidencia flexible: «api pagos» encuentra api-pagos). Busca en este workspace; si solo está en otro, pregunta antes, salvo que `workspace` diga dónde está. Si está en una isla, la trae al frente. «La app X» suele ser un repositorio.",
      },
      aliases: { es: ["cambia al repositorio", "cambia al repo", "cambia de repo", "cambia de repositorio", "ve al repo", "ve al repositorio", "abre el repo", "abre el repositorio", "pasa al repo", "repo", "repositorio"], en: ["switch to repo", "switch to repository", "switch repo", "go to repo", "open repo", "open the repository", "change repo"] },
      params: params({ name: text("The repository's name, as said."), workspace: optionalText("The workspace it is in, when the user said it (or said yes to it).") }, ["name"]),
      risk: "navigate",
      where: "main",
      frequent: true,
      run: async ({ name, workspace }) => {
        const ws = useWorkspaceStore.getState();
        // Found only in another workspace, it is asked about rather than gone to: the window would
        // change workspace under the user.
        const target = await findRepoToAct(
          String(name),
          workspace,
          (p) => ({ action: "repo.switch", params: { name: p.name, workspace: workspaceName(p.workspace_id) } }),
          (p) => say("codi.say.repoElsewhere", { name: p.name, workspace: workspaceName(p.workspace_id) }),
        );
        const island = repoIsland(target.id);
        if (island) {
          void useWindowStore.getState().focus(island);
          return { result: { repo: target.name, island }, say: say("codi.say.repoFocused", { name: target.name }) };
        }
        const closed = closedReason(target);
        if (closed === "missing" || closed === "notARepo") {
          throw new CodiError(
            `${target.name} cannot be opened: ${closed === "missing" ? "its folder is gone" : "its folder is no longer a git repository"}`,
            say("codi.say.repoUnavailable", { name: target.name }),
          );
        }
        if (target.id === ws.activeProjectId) {
          return { result: { repo: target.name, already: true }, say: say("codi.say.alreadyInRepo", { name: target.name }) };
        }
        await useWorkspaceStore.getState().focusProject(target.workspace_id, target.id);
        // Asked for from an app, "switch to api-pagos" means "show me api-pagos" — back to its tabs,
        // on the one it was left on.
        if (!REPO_VIEWS.includes(useUiStore.getState().activeView)) useUiStore.getState().returnToRepo();
        return { result: { repo: target.name }, say: say("codi.say.repoSwitched", { name: target.name }) };
      },
    }),
  ];
}

/** The branches a name can mean: local ones first, then remote ones with no local twin. */
function branchCandidates(branches: BranchInfo[]): BranchInfo[] {
  const local = branches.filter((b) => !b.is_remote);
  const localNames = new Set(local.map((b) => b.name));
  const remote = branches.filter((b) => b.is_remote && !localNames.has(b.name.replace(/^[^/]+\//, "")));
  return [...local, ...remote];
}

/** Branch list and checkout — anywhere a repository is on screen: the main window and repo islands. */
export function branchActions(): CodiAction[] {
  return [
    defineAction({
      id: "branch.list",
      title: {
        en: "List this window's repository branches — the current one, how far ahead/behind it is, and the others (filtered by query).",
        es: "Lista las ramas del repositorio de esta ventana: la actual, cuánto va adelante/atrás, y las demás (filtradas por query).",
      },
      aliases: { es: ["que ramas hay", "lista las ramas", "en que rama estoy", "cual es la rama", "mis ramas"], en: ["which branches", "list the branches", "what branch am i on", "current branch"] },
      params: params({ query: optionalText("Only branches whose name matches these words.") }),
      risk: "read",
      where: "any",
      run: async ({ query }) => {
        requireProject();
        const { branches, status } = useRepoStore.getState();
        const head = branches.find((b) => b.is_head) ?? null;
        let list = branchCandidates(branches);
        if (query) {
          const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
          list = list.filter((b) => words.every((w) => b.name.toLowerCase().includes(w)));
        }
        const current = status?.current_branch ?? head?.name ?? null;
        return {
          result: {
            current,
            detached: status?.is_detached || undefined,
            ahead: head?.ahead || undefined,
            behind: head?.behind || undefined,
            branches: list.slice(0, 30).map((b) => (b.is_remote ? `${b.name} (remote)` : b.name)),
            total: list.length,
          },
          say: current ? say("codi.say.currentBranch", { name: current }) : undefined,
        };
      },
    }),
    defineAction({
      id: "branch.checkout",
      title: {
        en: "Check out a branch by name (loose match). A remote-only branch is brought down as a local one, which asks the user first.",
        es: "Cambia a una rama por nombre (coincidencia flexible). Una rama solo remota se trae como local, lo que pide confirmación.",
      },
      aliases: { es: ["cambia a la rama", "cambia de rama", "ve a la rama", "pasate a la rama", "checkout", "haz checkout de", "rama"], en: ["checkout", "check out", "switch to branch", "switch branch", "go to branch"] },
      params: params({ name: text("The branch name, as said.") }, ["name"]),
      risk: "write",
      where: "any",
      frequent: true,
      run: async ({ name }) => {
        requireProject();
        const repo = useRepoStore.getState();
        const target = pickByName(branchCandidates(repo.branches), String(name), (b) => b.name, "branch", (b) => !b.is_remote);
        if (target.is_head) return { result: { branch: target.name, already: true }, say: say("codi.say.alreadyOnBranch", { name: target.name }) };
        if (target.is_remote) await repo.checkoutRemoteBranch(target.name);
        else await repo.checkoutBranch(target.name);
        const now = useRepoStore.getState().status?.current_branch ?? null;
        const expected = target.is_remote ? target.name.replace(/^[^/]+\//, "") : target.name;
        if (now !== expected) {
          const error = useRepoStore.getState().error;
          throw new CodiError(
            `the checkout of ${target.name} did not happen${error ? `: ${error}` : " (refused or cancelled)"}`,
            say("codi.say.checkoutFailed", { name: target.name }),
          );
        }
        return { result: { branch: now }, say: say("codi.say.branchCheckedOut", { name: now }) };
      },
    }),
  ];
}
