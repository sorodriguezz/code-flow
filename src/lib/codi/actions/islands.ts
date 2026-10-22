import { useWindowStore } from "../../../state/windowStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { broadcast } from "../../windowBus";
import { WINDOW } from "../../windowIdentity";
import { appByKey, sendRailAppOut, windowForApp } from "../../railApps";
import { returnThisIsland } from "../../islandReturn";
import { parseFileIslandRef } from "../../editorIslands";
import { matchByName } from "../fuzzy";
import { CodiError, type CodiAction, type CodiContext, type CodiOutcome } from "../registry";
import type { SatelliteInfo } from "../../tauri/windows";
import { appVocabulary } from "../vocabulary";
import { APP_KEYS, appName, defineAction, forwardTo, oneOf, optionalText, params, pickByName, say, spokenList } from "./shared";

/**
 * Islands — the satellite windows: list them, send an app or a repository out to one, bring one
 * forward, send one back.
 *
 * # Sending one back
 *
 * There is no backend command for it: an island goes back by closing itself after telling the main
 * window to come forward (`returnThisIsland`, the title bar's «Devolver»). So `island.return` runs
 * *in the island*. In an island it returns that window — after the answer is sent, since a window
 * that closes first never answers. In the main window it finds the island named in the params and
 * hands the request to it (`forwardTo`), which answers under the same id.
 */

/** The windows that count as islands — not the hotkey ask box, which is a satellite only mechanically. */
function islands(): SatelliteInfo[] {
  return useWindowStore.getState().satellites.filter((s) => s.kind === "app" || s.kind === "repo" || s.kind === "file");
}

/** A repository's name from its id, from any workspace this window has loaded. */
function repoName(projectId: string): string {
  for (const list of Object.values(useWorkspaceStore.getState().projectsByWorkspace)) {
    const found = list.find((p) => p.id === projectId);
    if (found) return found.name;
  }
  return projectId;
}

/** What an island holds, as said: the app's name, the repository's, or the file's. */
function islandName(island: Pick<SatelliteInfo, "kind" | "ref_id">): string {
  if (island.kind === "app") return appName(island.ref_id);
  if (island.kind === "repo") return repoName(island.ref_id);
  const path = parseFileIslandRef(island.ref_id)?.path ?? island.ref_id;
  const cut = path.lastIndexOf("/");
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/** The island `{app}` or `{repo}` names, or a refusal. Repository names are matched loosely. */
function islandFor(app: unknown, repo: unknown): SatelliteInfo {
  const all = islands();
  if (app) {
    const found = all.find((s) => s.kind === "app" && s.ref_id === app);
    if (!found) {
      throw new CodiError(
        `${appName(String(app))} is not in its own window`,
        say("codi.say.notAnIsland", { name: appName(String(app)) }),
      );
    }
    return found;
  }
  if (repo) {
    const repos = all.filter((s) => s.kind === "repo");
    return pickByName(repos, String(repo), (s) => repoName(s.ref_id), "repository island");
  }
  throw new CodiError("say which island: give app or repo");
}

const islandList = defineAction({
  id: "island.list",
  title: { en: "List the islands (apps and repositories open in windows of their own).", es: "Lista las islas (apps y repositorios abiertos en su propia ventana)." },
  aliases: { es: ["que islas hay", "que ventanas hay abiertas", "lista las islas", "ventanas abiertas"], en: ["which islands", "list the islands", "open windows", "which windows are open"] },
  params: params(),
  risk: "read",
  where: "any",
  run: async () => {
    const list = islands();
    const names = list.map(islandName);
    return {
      result: {
        islands: list.map((s) => ({
          label: s.label,
          ...(s.kind === "app" ? { app: s.ref_id } : s.kind === "repo" ? { repo: repoName(s.ref_id) } : { file: islandName(s) }),
        })),
      },
      say: names.length ? say("codi.say.islands", { n: names.length, list: spokenList(names) }) : say("codi.say.noIslands"),
    };
  },
});

const islandParams = params({
  app: oneOf(APP_KEYS, "The rail app the island holds."),
  repo: optionalText("Or: the repository the island holds, by name."),
});

const islandFocus = defineAction({
  id: "island.focus",
  title: {
    en: "Bring an island forward, by the app or repository it holds. With neither, brings the main window forward.",
    es: "Trae una isla al frente, por la app o el repositorio que tiene. Sin ninguno, trae al frente la ventana principal.",
  },
  aliases: { es: ["trae al frente", "enfoca la ventana", "muestra la ventana de", "ve a la ventana de", "trae la ventana de"], en: ["bring forward", "focus the window", "show the window of", "go to the window of"] },
  get vocabulary() {
    return { app: appVocabulary() };
  },
  params: islandParams,
  risk: "navigate",
  where: "any",
  run: async ({ app, repo }) => {
    if (!app && !repo) {
      if (WINDOW.main) return { result: { focused: "main" } };
      broadcast({ kind: "focus-main" });
      return { result: { focused: "main" }, say: say("codi.say.mainFocused") };
    }
    const island = islandFor(app, repo);
    await useWindowStore.getState().focus(island.label);
    return { result: { focused: island.label }, say: say("codi.say.islandFocused", { name: islandName(island) }) };
  },
});

/** `island.return`, as the window it runs in can do it. See the module note. */
async function returnIsland({ app, repo }: Record<string, unknown>, ctx: CodiContext): Promise<CodiOutcome> {
  const self = WINDOW.satellite;
  const named = Boolean(app || repo);
  let isSelf = false;
  if (self) {
    if (!named) isSelf = true;
    else if (app) isSelf = self.kind === "app" && self.refId === app;
    else isSelf = self.kind === "repo" && matchByName([self.refId], String(repo), repoName).kind === "match";
  }
  if (self && isSelf) {
    const name = islandName({ kind: self.kind, ref_id: self.refId });
    return { result: { returned: WINDOW.label }, say: say("codi.say.islandReturned", { name }), after: returnThisIsland };
  }
  if (!named) throw new CodiError("this is the main window — say which island to send back (app or repo)");
  const island = islandFor(app, repo);
  if (island.label === WINDOW.label) throw new CodiError("unreachable: this window is the island");
  return forwardTo(island.label, ctx);
}

const islandReturn = defineAction({
  id: "island.return",
  title: {
    en: "Send an island back to the main window («Devolver»), by the app or repository it holds. Run in an island with no params, sends that one back.",
    es: "Devuelve una isla a la ventana principal («Devolver»), por la app o el repositorio que tiene. En una isla y sin parámetros, devuelve esa.",
  },
  aliases: { es: ["devuelve", "devuelve la isla", "regresa la isla", "vuelve a la principal", "devuelvela", "acopla", "mete de vuelta"], en: ["return", "send back", "dock back", "put back", "reattach", "return the island"] },
  get vocabulary() {
    return { app: appVocabulary() };
  },
  params: islandParams,
  risk: "navigate",
  // In an app island, the island holding that app; in a repository or file island, that window; in
  // the main window, the main window — which hands the request on to the island it names.
  where: WINDOW.satellite?.kind === "app" ? `app:${WINDOW.satellite.refId}` : WINDOW.satellite ? "any" : "main",
  frequent: true,
  run: returnIsland,
});

const islandDetach = defineAction({
  id: "island.detach",
  title: {
    en: "Send a rail app or a repository out to a window of its own (an island). An app already out is brought forward.",
    es: "Saca una app del rail o un repositorio a su propia ventana (una isla). Si ya está fuera, la trae al frente.",
  },
  aliases: { es: ["saca", "saca a una ventana", "sacalo a una ventana", "abre en una ventana aparte", "abre en su propia ventana", "ventana aparte", "separa", "desacopla"], en: ["detach", "pop out", "open in its own window", "open in a new window", "undock"] },
  get vocabulary() {
    return { app: appVocabulary() };
  },
  params: islandParams,
  risk: "navigate",
  where: "main",
  frequent: true,
  run: async ({ app, repo }) => {
    if (app) {
      const entry = appByKey(String(app));
      if (!entry) throw new CodiError(`unknown app "${String(app)}"`);
      const name = appName(String(app));
      const already = windowForApp(entry);
      if (already) {
        void useWindowStore.getState().focus(already);
        return { result: { app, island: already, already: true }, say: say("codi.say.islandFocused", { name }) };
      }
      if (!(await sendRailAppOut(entry))) {
        throw new CodiError(`the window for ${name} was not opened (the island limit, or the backend refused)`, say("codi.say.detachFailed", { name }));
      }
      return { result: { app, detached: true }, say: say("codi.say.islandDetached", { name }) };
    }
    if (repo) {
      const ws = useWorkspaceStore.getState();
      const projects = ws.activeWorkspaceId ? (ws.projectsByWorkspace[ws.activeWorkspaceId] ?? []) : [];
      const project = pickByName(projects, String(repo), (p) => p.name, "repository");
      const already = useWindowStore.getState().detachedLabel("repo", project.id);
      if (already) {
        void useWindowStore.getState().focus(already);
        return { result: { repo: project.name, island: already, already: true }, say: say("codi.say.islandFocused", { name: project.name }) };
      }
      // The sidebar's own "open in a window": refused, the repository stays selected here.
      const moved = await useWindowStore.getState().detach("repo", project.id, project.name);
      if (!moved) throw new CodiError(`the window for ${project.name} was not opened`, say("codi.say.detachFailed", { name: project.name }));
      if (useWorkspaceStore.getState().activeProjectId === project.id) useWorkspaceStore.getState().setActiveProject("");
      return { result: { repo: project.name, detached: true }, say: say("codi.say.islandDetached", { name: project.name }) };
    }
    throw new CodiError("say what to send out: give app or repo");
  },
});

/** The main window's four. */
export function islandActions(): CodiAction[] {
  return [islandList, islandDetach, islandReturn, islandFocus];
}

/** An island's three: it can list, bring windows forward and send itself (or another) back. */
export function islandSatelliteActions(): CodiAction[] {
  return [islandList, islandReturn, islandFocus];
}
