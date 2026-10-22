import type { WindowIdentity } from "../../windowIdentity";
import type { CodiAction } from "../registry";
import { navigationActions, dockActions } from "./navigation";
import { branchActions, repoActions, workspaceActions } from "./context";
import { islandActions, islandSatelliteActions } from "./islands";
import { textActions, textSatelliteActions } from "./text";
import { gitActions } from "./git";
import { serviceActions, terminalActions } from "./run";
import { notificationActions } from "./apps";
import { notesActions } from "./notes";
import { apiActions, dbActions } from "./data";
import { workspaceAppActions, workspaceAppActionsFor } from "./workspaceApps";
import { devopsActions } from "./devops";
import { uiActions } from "./ui";

/**
 * Which actions a window registers — the whole catalogue in the main window, and in an island only
 * what acts on the thing it holds plus the generic ones (`ui.*`, typing, the island verbs).
 *
 * The line is the one `SatelliteTitleBar` draws: does the action act on what this window holds, or
 * can it swap that out? A repository island fetches and checks out branches of *its* repository and
 * runs commands in it; it does not switch repository, open rail apps or reach Settings, which it does
 * not have. An app island switches its own workspace (its title bar has the picker) and runs its
 * app's actions — Notes takes notes there, Chat is asked there.
 */
export function catalogueFor(identity: WindowIdentity): CodiAction[] {
  if (identity.main) {
    return [
      ...uiActions(),
      ...navigationActions(),
      ...workspaceActions(),
      ...repoActions(),
      ...branchActions(),
      ...islandActions(),
      ...textActions(),
      ...gitActions(),
      ...serviceActions(),
      ...terminalActions(),
      ...notificationActions(),
      // The rail apps' own, each marked `where: "app:<key>"` — the bus hands one to the app's island
      // when the app is out in one.
      ...notesActions(),
      ...apiActions(),
      ...dbActions(),
      ...workspaceAppActions(),
      ...devopsActions(),
    ];
  }
  const spec = identity.satellite;
  if (!spec || spec.kind === "quick" || spec.kind === "codi") return [];
  const common = [...uiActions(), ...islandSatelliteActions(), ...textSatelliteActions(spec.kind, spec.refId)];
  if (spec.kind === "app") {
    return [...common, ...workspaceActions(), ...appActionsFor(spec.refId)];
  }
  if (spec.kind === "repo") {
    return [...common, ...branchActions(), ...gitActions(), ...terminalActions(), ...dockActions(["terminal"])];
  }
  return common;
}

/** What an island holding the rail app `key` adds: that app's own actions. */
function appActionsFor(key: string): CodiAction[] {
  if (key === "notes") return notesActions();
  if (key === "api:requests") return apiActions();
  if (key === "api:database") return dbActions();
  return workspaceAppActionsFor(key);
}
