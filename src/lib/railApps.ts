import {
  Bot,
  ClipboardList,
  Database,
  KeyRound,
  MessagesSquare,
  MonitorSmartphone,
  Network,
  NotebookPen,
  Send,
  Waypoints,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useUiStore, type ApiWorkspace, type MainView } from "../state/uiStore";
import { useWindowStore } from "../state/windowStore";
import { translate } from "../state/languageStore";
import { flushBeforeIsland } from "./islandSync";
import type { TranslationKey } from "./i18n/translations";

/**
 * The rail's apps — which exist, what each is called, and the two things you can do to one: open it
 * and send it out to a window of its own.
 *
 * Out of `AppRail` (where the list and both gestures were born, and where the comments on each entry
 * still argue for the rail's order) because the rail stopped being the only thing that does them:
 * «Codi» opens and detaches apps by voice, and a second copy of "an app that is elsewhere is focused,
 * not reopened" or of "flush before the island boots" would be a second place for those rules to be
 * *nearly* right. A plain module rather than the component: Codi's catalogue runs outside React, and
 * importing the rail would drag the shell's chrome into it.
 */

export interface WorkspaceApp {
  id: MainView;
  /**
   * Which workspace *inside* that view, for a view that holds more than one.
   *
   * The API tab holds two — requests and databases — because both are workspace-scoped and neither
   * follows the selected repository. They are separate buttons here so each is one click;
   * `undefined` means the view has only one.
   */
  workspace?: ApiWorkspace;
  icon: LucideIcon;
  labelKey: TranslationKey;
  /** What the app holds, so the tooltip can say it — the rail itself has room for an icon and
   * nothing else. */
  descriptionKey: TranslationKey;
  /** Marks an app that is still settling, so the rail says so before it is opened rather than
   * after something behaves unexpectedly inside it — the word under the icon, a chip in the tooltip
   * and in the title row's crumb. No app wears one today: Flujos was beta until 2026-10-07. */
  stage?: "alpha" | "beta";
  /** What the stage means for this app, as the chip's tooltip in the title row. */
  stageHintKey?: TranslationKey;
  /**
   * Not scoped to the workspace: the same rows whichever one is active. The title row's crumb says
   * «Global» for it instead of naming a workspace it does not belong to.
   */
  global?: true;
}

/** Everything that belongs to the workspace rather than to the selected repository. Adding the
 * next one is a single entry here — the rail follows.
 *
 * This is the order the rail *starts* in, and the comments below are the argument for it. It is no
 * longer the order it necessarily stays in: an icon held down can be moved, and [`ordered`] lays
 * this list out against what the user chose. It remains the source of truth for which apps exist. */
export const APPS: WorkspaceApp[] = [
  {
    id: "api",
    workspace: "requests",
    icon: Send,
    labelKey: "tabbar.api",
    descriptionKey: "tabbar.apiDescription",
  },
  {
    id: "api",
    workspace: "database",
    icon: Database,
    labelKey: "tabbar.databases",
    descriptionKey: "tabbar.databasesDescription",
  },
  // No `workspace`: the agent console is a view of its own. It sits here rather than in the tab
  // bar for the same reason the other two do — the roster belongs to the workspace, and switching
  // repository doesn't change which agents exist.
  {
    id: "agents",
    icon: Bot,
    labelKey: "tabbar.agents",
    descriptionKey: "tabbar.agentsDescription",
  },
  // Below the agents, and workspace-scoped for the plainest reason of the three: a requirement is
  // written before the code that satisfies it, so this screen has to work in a workspace whose
  // repositories don't exist yet.
  {
    id: "stories",
    icon: ClipboardList,
    labelKey: "tabbar.stories",
    descriptionKey: "tabbar.storiesDescription",
  },
  // Last, and workspace-scoped for the same reason as the databases above it: a host is part of the
  // environment a workspace's repositories are deployed to, so switching repository must not change
  // which machines are listed.
  {
    id: "remote",
    icon: MonitorSmartphone,
    labelKey: "tabbar.remote",
    descriptionKey: "tabbar.remoteDescription",
  },
  // Under the machines, and among the least repository-bound of them: a note is the writing *around*
  // the work — the decision, the runbook, the meeting — and none of it changes meaning when you
  // click a different repo. It sits down here because it is one you come back to rather than one
  // you pass through.
  {
    id: "notes",
    icon: NotebookPen,
    labelKey: "tabbar.notes",
    descriptionKey: "tabbar.notesDescription",
  },
  // After the notes, because it is the same kind of thing one step further out: a diagram is the
  // drawing *around* the work the way a note is the writing around it, and neither changes meaning
  // when you click a different repo. Last because it is the newest, and because the rail's declared
  // order is only where it starts — see `ordered`.
  {
    id: "diagrams",
    icon: Workflow,
    labelKey: "tabbar.diagrams",
    descriptionKey: "tabbar.diagramsDescription",
  },
  // The first app here that is *not* scoped to the workspace: a password does not belong to the
  // workspace it was typed in, and losing one because a workspace was tidied up is not a trade
  // worth making. Its list narrows by workspace; the vault itself does not. See `vaultStore`'s
  // closing comment.
  {
    id: "vault",
    global: true,
    icon: KeyRound,
    labelKey: "tabbar.vault",
    descriptionKey: "tabbar.vaultDescription",
  },
  // Last, and the second app here that is not workspace-scoped — for a different reason than the
  // vault above it. The vault is global because a secret outlives the workspace it was typed in;
  // chat is global because the list was *designed* flat, the way ChatGPT's is, and a conversation
  // you started this morning has to still be one click away after you switch workspace to answer
  // something else. A `workspace_id` is still recorded on every conversation (backup groups by it,
  // and so does the run-isolation stamp) — the sidebar simply does not filter on it.
  //
  // It is also the only app on this rail that routinely has nothing to do with a repository, which
  // is what earns it a place in `WORKSPACE_VIEWS` rather than among the repository tabs.
  {
    id: "chat",
    global: true,
    icon: MessagesSquare,
    labelKey: "tabbar.chat",
    descriptionKey: "tabbar.chatDescription",
  },
  // Node-based automations — schedules, scripts, APIs and AI. Workspace-scoped like the API client
  // and the databases whose transports and connections its nodes reuse. Last because it is the
  // newest. It wore "beta" from 2026-10-06 until the user took it off on 2026-10-07.
  {
    id: "flows",
    icon: Waypoints,
    labelKey: "tabbar.flows",
    descriptionKey: "tabbar.flowsDescription",
  },
  // Architecture documents: the system as JSON, drawn, reviewed, simulated and discussed with AI.
  // Its documents live in the diagrams table, but it is its own app — the user asked for a door of
  // its own on the rail (2026-10-21).
  {
    id: "architecture",
    icon: Network,
    labelKey: "tabbar.architecture",
    descriptionKey: "tabbar.architectureDescription",
  },
  // The developer toolbox — encoders, JWT, formatters, generators — all local, nothing leaves the
  // machine. Newest, so last (user, 2026-10-23: «métele un montón de herramientas altiro»).
  {
    id: "toolbox",
    global: true,
    icon: Wrench,
    labelKey: "tabbar.toolbox",
    descriptionKey: "tabbar.toolboxDescription",
  },
];

/** Buttons are keyed by view *and* workspace, since two of them share a view. This key is also what
 * the stored order is written in, so it has to stay stable across releases — renaming one silently
 * drops that app to the bottom of a rail somebody had already arranged. */
export function appKey(app: WorkspaceApp): string {
  return app.workspace ? `${app.id}:${app.workspace}` : app.id;
}

/** The app a rail key names — `api:database`, `notes` — or `undefined` for a key that is not one. */
export function appByKey(key: string): WorkspaceApp | undefined {
  return APPS.find((app) => appKey(app) === key);
}

/** The label of the window this app is showing in, or `null` for one that is still in this one. */
export function windowForApp(app: WorkspaceApp): string | null {
  return (
    useWindowStore.getState().satellites.find((s) => s.kind === "app" && s.ref_id === appKey(app))?.label ?? null
  );
}

/**
 * Opens an app from the rail: on screen here, or — when it lives in an island — that island
 * brought forward. Answers which of the two happened.
 */
export function openRailApp(app: WorkspaceApp): "opened" | "focused" {
  // Detaching moves rather than duplicates, so the icon for an app that is elsewhere is a way
  // *to* that window, not a second copy of the app. Anything else would be two API clients on one
  // workspace's collections, which is the case this whole design exists to prevent.
  const label = windowForApp(app);
  if (label) {
    void useWindowStore.getState().focus(label);
    return "focused";
  }
  // A view with sub-workspaces needs both set at once, or the tab would open on whichever side
  // was last on screen rather than the one just picked.
  const ui = useUiStore.getState();
  if (app.workspace) ui.openApiWorkspace(app.workspace);
  else ui.setActiveView(app.id);
  return "opened";
}

/**
 * Sends the app out to a window of its own, and takes it off this one. Resolves to whether the
 * window was built — `false` when it was refused (the limit is reached, the backend said no).
 */
export async function sendRailAppOut(app: WorkspaceApp): Promise<boolean> {
  // Read as the press found it: whether the app is the one on screen is decided by where the user
  // was when they asked, not by wherever the view is once the window exists.
  const { activeView, apiWorkspace } = useUiStore.getState();
  // What this window still owes the database goes first, so the island boots onto it.
  await flushBeforeIsland(appKey(app));
  const moved = await useWindowStore.getState().detach("app", appKey(app), translate(app.labelKey));
  // Only once the window actually exists: refused (the limit is reached, the backend said no) the
  // app stays exactly where it was, rather than leaving this window on an empty view.
  if (!moved) return false;
  if (activeView === app.id && (app.workspace ?? apiWorkspace) === apiWorkspace) {
    useUiStore.getState().returnToRepo();
  }
  return true;
}
