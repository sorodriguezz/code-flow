import { emitTo } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { APPS, appByKey, appKey, openRailApp } from "../../railApps";
import { WINDOW } from "../../windowIdentity";
import { translate } from "../../../state/languageStore";
import { matchByName } from "../fuzzy";
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
 */
export function pickByName<T>(
  items: readonly T[],
  query: string,
  nameOf: (item: T) => string,
  what: string,
  prefer?: (item: T) => boolean,
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
  const known = items.map(nameOf);
  throw new CodiError(
    `no ${what} matches "${query}"${known.length ? `; there are: ${known.slice(0, 30).join(", ")}` : ""}`,
    say("codi.say.notFound", { name: query }),
  );
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

export { say, spokenList, spokenChoice };
