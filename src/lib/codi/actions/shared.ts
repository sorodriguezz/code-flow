import { emitTo } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useMissingProjectsStore } from "../../../state/missingProjectsStore";
import { openable } from "../../shortcuts";
import { APPS, appByKey, appKey, openRailApp } from "../../railApps";
import { WINDOW } from "../../windowIdentity";
import { translate, useLanguageStore } from "../../../state/languageStore";
import { closestByName, matchByName } from "../fuzzy";
import { getSetting, listProjects } from "../../tauri/commands";
import { codiTell, type CodiOffer } from "../../tauri/codiCommands";
import { useUiStore } from "../../../state/uiStore";
import { CodiError, type CodiAction, type CodiContext, type CodiOutcome, type ParamSchema } from "../registry";
import { say, spokenChoice, spokenList } from "../say";
import type { Project, Workspace } from "../../../types/domain";

/**
 * What the catalogue's areas share: schema shorthands, "the repository this window is on", picking a
 * thing by its spoken name, and handing a request to the window that should run it.
 */

/** Identity, for type inference at the declaration — the catalogue reads as a list of literals. */
export function defineAction(action: CodiAction): CodiAction {
  return action;
}

/** An object schema with these keys. Closed (`additionalProperties: false`): a model told the keys
 *  are exactly these invents fewer. */
export function params(properties: Record<string, ParamSchema> = {}, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

export const text = (description: string): ParamSchema => ({ type: "string", description, minLength: 1 });
export const optionalText = (description: string): ParamSchema => ({ type: "string", description });
export const flag = (description: string): ParamSchema => ({ type: "boolean", description });
export const oneOf = (values: readonly string[], description: string): ParamSchema => ({
  type: "string",
  enum: values,
  description,
});

/** Every rail app's key — the values `app` takes wherever an action names one. */
export const APP_KEYS: string[] = APPS.map(appKey);

/** An app's name as the rail shows it, in the app's language. */
export function appName(key: string): string {
  const app = appByKey(key);
  return app ? translate(app.labelKey) : key;
}

/** What this window is, as `ui.state` and the `where` of an action say it. */
export function windowKind(): string {
  const spec = WINDOW.satellite;
  if (!spec) return "main";
  if (spec.kind === "app") return `app:${spec.refId}`;
  return spec.kind;
}

/**
 * Puts a rail app on screen in this window before one of its actions runs. In the main window that
 * opens the app (an action reaching main for an app in an island was handed to the island by the
 * bus already); an island holding the app is showing it, so there is nothing to do.
 */
export function showAppHere(key: string): void {
  if (!WINDOW.main) return;
  const app = appByKey(key);
  if (app) openRailApp(app);
}

export function activeWorkspace(): Workspace | null {
  const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState();
  return workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
}

/** The repository this window is on, or a refusal Codi can say. */
export function requireProject(): Project {
  const project = useWorkspaceStore.getState().activeProject();
  if (!project) throw new CodiError("no repository is open in this window — switch to one first (repo.switch)", say("codi.say.noRepo"));
  return project;
}

export function requireWorkspace(): Workspace {
  const workspace = activeWorkspace();
  if (!workspace) throw new CodiError("no workspace is selected in this window", say("codi.say.noWorkspace"));
  return workspace;
}

/**
 * The one item a spoken name means, or a refusal that says what to try — see `fuzzy.matchByName`.
 * `what` names the kind of thing in the engine's error ("repository", "branch").
 *
 * With `suggest`, a name that matches nothing but is a slip away from one item («facturasion»)
 * is asked about — «¿Quisiste decir facturacion?» — and a yes runs what `suggest` makes of it.
 */
export function pickByName<T>(
  items: readonly T[],
  query: string,
  nameOf: (item: T) => string,
  what: string,
  prefer?: (item: T) => boolean,
  suggest?: (item: T) => CodiOffer,
): T {
  const found = matchByName(items, query, nameOf, prefer);
  if (found.kind === "match") return found.item;
  if (found.kind === "ambiguous") {
    const names = found.candidates.map(nameOf);
    throw new CodiError(
      `"${query}" matches several ${what}s: ${names.join(", ")} — ask which one, then call again with the exact name`,
      say("codi.say.whichOne", { list: spokenChoice(names) }),
    );
  }
  const near = suggest ? closestByName(items, query, nameOf) : null;
  if (near !== null && suggest) {
    throw new CodiError(
      `no ${what} matches "${query}"; the nearest is "${nameOf(near)}" — ask the user whether that one was meant`,
      say("codi.say.didYouMean", { name: query, guess: nameOf(near) }),
      suggest(near),
    );
  }
  const known = items.map(nameOf);
  throw new CodiError(
    `no ${what} matches "${query}"${known.length ? `; there are: ${known.slice(0, 30).join(", ")}` : ""}`,
    say("codi.say.notFound", { name: query }),
  );
}

/** Every workspace's repositories — the ones not loaded into the store read without touching it
 *  (loading them there would pick one as the open repository). */
export async function allProjects(): Promise<Project[]> {
  const ws = useWorkspaceStore.getState();
  const lists = await Promise.all(ws.workspaces.map(async (w) => ws.projectsByWorkspace[w.id] ?? (await listProjects(w.id).catch(() => []))));
  return lists.flat();
}

/** A workspace's name, by id. */
export function workspaceName(id: string): string {
  return useWorkspaceStore.getState().workspaces.find((w) => w.id === id)?.name ?? id;
}

/**
 * The repository a question is about, for an action that only reads (nothing on screen moves, so
 * nothing is asked first): the one named — in `workspace` when one is named, else this workspace's
 * first, then any other's — or, named nothing, the open one. With `suggest`, a name that is only a
 * slip away from one («No CLI» for noah-cli) is asked about, and a yes runs what `suggest` makes.
 */
export async function findProject(name: unknown, workspace: unknown, suggest?: (project: Project) => CodiOffer): Promise<Project> {
  const ws = useWorkspaceStore.getState();
  const named = typeof name === "string" && name.trim() ? name.trim() : null;
  const inWorkspace = typeof workspace === "string" && workspace.trim() ? pickByName(ws.workspaces, workspace, (w) => w.name, "workspace") : null;
  if (!named) {
    if (!inWorkspace || inWorkspace.id === ws.activeWorkspaceId) return requireProject();
    throw new CodiError(`which repository of ${inWorkspace.name}?`, say("codi.say.whichRepoIn", { workspace: inWorkspace.name }));
  }
  const everywhere = await allProjects();
  const pool = inWorkspace ? everywhere.filter((p) => p.workspace_id === inWorkspace.id) : everywhere;
  return pickByName(pool, named, (p) => p.name, "repository", (p) => p.workspace_id === ws.activeWorkspaceId, suggest);
}

/**
 * The repository an order that changes something is for, by name: this workspace's first. Never
 * acted on unasked when it is not where the user is — one found only in another workspace, or only
 * a slip away from a name («¿quisiste decir…?»), is asked about with `elsewhere`'s question, and a
 * yes runs `offerFor` (the same order, the repository and its workspace now named). Said where it
 * is (`workspace`), it is looked for there.
 */
export async function findRepoToAct(
  name: string,
  workspace: unknown,
  offerFor: (project: Project) => CodiOffer,
  elsewhere: (project: Project) => string,
): Promise<Project> {
  const ws = useWorkspaceStore.getState();
  if (typeof workspace === "string" && workspace.trim()) {
    const named = pickByName(ws.workspaces, workspace, (w) => w.name, "workspace");
    const list = (await allProjects()).filter((p) => p.workspace_id === named.id);
    return pickByName(list, name, (p) => p.name, "repository", undefined, offerFor);
  }
  const here = ws.activeWorkspaceId ? (ws.projectsByWorkspace[ws.activeWorkspaceId] ?? []) : [];
  if (matchByName(here, name, (p) => p.name).kind !== "none") return pickByName(here, name, (p) => p.name, "repository");
  // Not in this workspace (user, 2026-10-22: «no encontró esa app en el workspace actual, pero sí en
  // otro workspace, ¿quieres que lo abra?»).
  const found = pickByName(await allProjects(), name, (p) => p.name, "repository", (p) => p.workspace_id === ws.activeWorkspaceId, offerFor);
  if (found.workspace_id !== ws.activeWorkspaceId) {
    throw new CodiError(
      `${found.name} is not in this workspace but in ${workspaceName(found.workspace_id)} — ask the user before acting on it`,
      elsewhere(found),
      offerFor(found),
    );
  }
  return found;
}

/** Why a repository cannot be worked on from here, or `null` when it can. */
export function closedReason(project: Project): "missing" | "notARepo" | "island" | null {
  const { missing, notARepo } = useMissingProjectsStore.getState();
  if (missing.has(project.local_path)) return "missing";
  if (notARepo.has(project.local_path)) return "notARepo";
  if (!openable(project)) return "island";
  return null;
}

/**
 * Hands the request to the window that should run it — an island holding the app, usually. That
 * window answers under the same id; this one answers nothing (`forwarded`).
 *
 * The backend routes by `where` already, so this is the second line, for the case where it could
 * not know: the request reached the main window for an app that went out to an island since the
 * catalogue was registered, or for an island named in the params (`island.return {app}`).
 */
export async function forwardTo(label: string, ctx: CodiContext): Promise<CodiOutcome> {
  try {
    await emitTo(label, "codi:act", { ...ctx.request, window: label });
  } catch (error) {
    throw new CodiError(`could not reach the window ${label}: ${String(error)}`);
  }
  return { forwarded: true };
}

/**
 * Waits for `done` to hold, checking every `step` ms, up to `ms` — for an action whose work lands a
 * moment after the call returns (a request the view sends, a run the backend starts). Resolves to
 * whether it held. Kept well under the backend's ten-second answer timeout by every caller.
 */
export async function waitFor(done: () => boolean, ms = 6000, step = 60): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (done()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

/** Mirrors `CODI_KEYS.background`: «Trabajar en segundo plano» (Settings › Codi), on unless "off". */
const BACKGROUND_KEY = "codi_background";

/**
 * The `show` param of an action that can do its work out of sight: what the order said about seeing
 * it. The router fills it from «…y muéstramelo» / «sin abrir» (`codi::router::screen_hint`).
 */
export const showParam: ParamSchema = flag(
  "Put it on screen too: true only when the user asked to see it («ábrelo», «muéstramelo», «en pantalla»), false when they asked not to («sin abrir», «en segundo plano»). Leave it out otherwise: the user's setting decides.",
);

/**
 * Whether this order's work stays out of sight: what it said (`show`), else the user's «Trabajar en
 * segundo plano» — on unless turned off (user, 2026-10-22: «que Codi ocupe la app en segundo plano sin
 * abrir cosas»). Read when the order runs, so a change in Settings holds from the next one.
 */
export async function outOfSight(show: unknown): Promise<boolean> {
  if (show === true) return false;
  if (show === false) return true;
  try {
    return (await getSetting(BACKGROUND_KEY))?.trim() !== "off";
  } catch {
    return true;
  }
}

/** Whether the rail app `key` is what this window shows right now — an island holding it always is. */
export function appOnScreen(key: string): boolean {
  if (!WINDOW.main) return windowKind() === `app:${key}`;
  const app = appByKey(key);
  const ui = useUiStore.getState();
  if (!app || ui.settingsOpen) return false;
  return ui.activeView === app.id && (!app.workspace || ui.apiWorkspace === app.workspace);
}

/** How long an order waits for its work before answering «sigo…» — well under the backend's answer
 *  timeout (`codi::ui`). */
export const ANSWER_WITHIN_MS = 9000;

/** «Shall I show it?» — the offer that follows work done out of sight, when there is something to look at. */
export function showOffer(action: string, params: Record<string, unknown> = {}): CodiOffer & { question: string } {
  return { action, params: { ...params, show: true }, question: say("codi.say.showIt") };
}

/** What a finished piece of work is told as, after its turn has answered: its sentence, and its offer
 *  asked next. Failures carry their own sentence (`CodiError.say`) or `failed`'s. */
function tellOutcome(source: string, work: Promise<CodiOutcome>, failed: (error: unknown) => string): void {
  void work.then(
    (outcome) => {
      if (outcome.say) void codiTell(outcome.say, source, outcome.offer ?? null).catch(() => {});
    },
    (error) => {
      const text = error instanceof CodiError && error.say ? error.say : failed(error);
      const offer = error instanceof CodiError && error.offer ? { ...error.offer, question: error.offer.question ?? error.say } : null;
      if (text) void codiTell(text, source, offer).catch(() => {});
    },
  );
}

/**
 * `work`'s answer, if it comes within `ms`; otherwise `still` now, and the answer told when it lands —
 * with its offer asked after it. A pull, a request, a query, a command: whatever outlasts a turn.
 */
export async function answerOrTell(
  work: Promise<CodiOutcome>,
  opts: { source: string; still: CodiOutcome; failed: (error: unknown) => string; ms?: number },
): Promise<CodiOutcome> {
  const late = Symbol("late");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([work, new Promise<typeof late>((resolve) => (timer = setTimeout(() => resolve(late), opts.ms ?? ANSWER_WITHIN_MS)))]).finally(() =>
    clearTimeout(timer),
  );
  if (first !== late) return first;
  tellOutcome(opts.source, work, opts.failed);
  return opts.still;
}

/** Work that takes minutes (an agent's turn, a review): nothing waits for it — it is told when it ends. */
export function tellWhenDone(source: string, work: Promise<CodiOutcome | null>, failed: (error: unknown) => string): void {
  tellOutcome(source, work.then((outcome) => outcome ?? {}), failed);
}

/** The longest anything is watched for before Codi stops waiting to tell it. */
const WATCH_LIMIT_MS = 2 * 60 * 60 * 1000;

/**
 * The first value `pick` reads from `store` that is not `undefined` — now, or as the store changes —
 * or `null` once `ms` have passed. How out-of-sight work is followed to its end (a flow's run, an
 * agent's task, a review's job): through the store the app's own screens read.
 */
export function watchStore<S, T>(
  store: { getState: () => S; subscribe: (listener: (state: S) => void) => () => void },
  pick: (state: S) => T | undefined,
  ms = WATCH_LIMIT_MS,
): Promise<T | null> {
  return new Promise((resolve) => {
    const now = pick(store.getState());
    if (now !== undefined) {
      resolve(now);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = store.subscribe((state) => {
      const value = pick(state);
      if (value === undefined) return;
      stop();
      clearTimeout(timer);
      resolve(value);
    });
    timer = setTimeout(() => {
      stop();
      resolve(null);
    }, ms);
  });
}

/** A duration as it is said: «2,3 s», «4 min». */
export function spokenDuration(ms: number): string {
  const comma = useLanguageStore.getState().language === "es";
  if (ms < 60_000) {
    const secs = ms < 10_000 ? (Math.round(ms / 100) / 10).toString() : Math.round(ms / 1000).toString();
    return `${comma ? secs.replace(".", ",") : secs} s`;
  }
  return `${Math.round(ms / 60_000)} min`;
}

/** `spokenReason`, introduced — «: <reason>» — or nothing when there is none to say. */
export function afterColon(error: unknown): string {
  const reason = spokenReason(error);
  return reason ? `: ${reason}` : "";
}

/** The first line of an error worth saying, short enough to be said. */
export function spokenReason(error: unknown, max = 140): string {
  const text = (error instanceof Error ? error.message : String(error ?? "")).split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export { say, spokenList, spokenChoice };
