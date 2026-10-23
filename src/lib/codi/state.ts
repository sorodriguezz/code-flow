import { useUiStore, type MainView } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useRepoStore } from "../../state/repoStore";
import { useTerminalStore } from "../../state/terminalStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useWindowStore } from "../../state/windowStore";
import { useNotificationStore } from "../../state/notificationStore";
import { useEditorStatusStore } from "../../state/editorStatusStore";
import { tourLength, useTourStore } from "../../state/tourStore";
import { deriveRunning, useServicesStore } from "../../state/servicesStore";
import { translate } from "../../state/languageStore";
import { SETTINGS_SECTIONS, tabsFor } from "../settingsCatalog";
import { APPS, appKey } from "../railApps";
import { collectUnsaved } from "../unsavedWork";
import { WINDOW } from "../windowIdentity";
import { accessibleName, isPrivateControl, isTextField } from "./dom";
import { aiPanelTab, DOCK_LABEL, viewName } from "./actions/navigation";
import { appName, defineAction, params, windowKind } from "./actions/shared";
import { tourName } from "./actions/tours";
import type { CodiAction } from "./registry";

/**
 * `ui.state` — what this window is showing, compact enough to ride on every prompt.
 *
 * The backend puts it at the **end** of each prompt, after the system text and the tools, so the
 * prefix stays cached and only this changes from turn to turn. That sets two rules:
 *
 * - **Small.** Names, not objects; counts, not lists, past a handful; a field left out rather than
 *   `null`-ed where its absence already says it. The plan budgets ~40 tokens for the gist.
 * - **Stable in order.** The JSON keys and the summary's parts come in one fixed order, so two
 *   snapshots of the same screen are the same text — and a model comparing two turns sees only what
 *   moved.
 *
 * `summary` is the gist in the app's language, one or two lines: where (window, workspace ›
 * repository, branch, view), then what is open around it. It is what a small local model reads; the
 * JSON beside it is for the engines that can use more.
 *
 * Nothing private: a focused password field is reported as private and unnamed, and no field's value
 * is ever part of it.
 */

export interface UiStateSnapshot {
  window: { label: string; kind: string };
  workspace: { name: string; others: string[] } | null;
  repo: { name: string; others: string[] } | null;
  branch: { name: string; ahead?: number; behind?: number; detached?: true; changes?: number } | null;
  /** The repository tab or the rail app (`graph`, `api:database`, `notes`); absent in a repository
   *  island, whose tab this store does not hold. */
  view?: string;
  settings?: { section: string; tab: string | null };
  aiPanel?: { tab: string };
  dock?: string;
  sidebarCollapsed?: true;
  modals?: string[];
  /** A guided tour is up: which, the step on screen (1-based) of how many, and whether Codi is
   *  explaining it. */
  tour?: { id: string; step: number; of: number; narrated?: true };
  editor?: { path: string; line: number };
  unsaved?: number;
  focus?: { label: string; ai?: true; editor?: true; private?: true };
  islands?: string[];
  services?: number;
  unread?: number;
  summary: string;
}

/** How many sibling names a snapshot carries before it stops listing them. */
const OTHERS_SHOWN = 8;

/** The rail app or repository tab on screen, as a key: `api:requests` rather than `api`. */
export function activeViewKey(): string {
  const { activeView, apiWorkspace } = useUiStore.getState();
  if (activeView === "api") return `api:${apiWorkspace}`;
  return activeView;
}

/** A view key as the UI names it. */
function viewLabel(key: string): string {
  if (APPS.some((app) => appKey(app) === key)) return appName(key);
  return viewName(key as MainView);
}

/** What has the caret, if anything worth saying does. */
function focusInfo(): UiStateSnapshot["focus"] {
  if (typeof document === "undefined") return undefined;
  const el = document.activeElement;
  if (!el || el === document.body) return undefined;
  if (el.closest(".monaco-editor")) {
    const path = useEditorStatusStore.getState().status?.path;
    return { label: path ?? "editor", editor: true };
  }
  if (!isTextField(el)) return undefined;
  if (isPrivateControl(el)) return { label: "", private: true };
  return { label: accessibleName(el) || el.tagName.toLowerCase(), ...(el.closest("[data-ai-input]") ? { ai: true as const } : {}) };
}

/** The open modal dialogs, by the names they announce — or, with no DOM, the ones `uiStore` opens. */
function openModals(): string[] {
  if (typeof document !== "undefined") {
    return [...document.querySelectorAll("[role='dialog'][aria-modal='true'], dialog[open]")]
      // The tour's own card is said as the tour (`tour`), not as a dialog.
      .filter((dialog) => dialog.getClientRects().length > 0 && dialog.getAttribute("aria-labelledby") !== "cf-tour-title")
      .map((dialog) => accessibleName(dialog) || "dialog")
      .slice(0, 3);
  }
  const ui = useUiStore.getState();
  return [
    ui.commandPaletteOpen && "palette",
    ui.branchSwitcherOpen && "branches",
    ui.shortcutsModalOpen && "shortcuts",
    ui.prLinkModalOpen && "prLink",
    ui.cloneModalOpen && "clone",
    ui.projectInitOpen && "newProject",
  ].filter((name): name is string => Boolean(name));
}

function islandNames(): string[] {
  const projects = Object.values(useWorkspaceStore.getState().projectsByWorkspace).flat();
  return useWindowStore
    .getState()
    .satellites.filter((s) => s.kind === "app" || s.kind === "repo" || s.kind === "file")
    .map((s) => {
      if (s.kind === "app") return s.ref_id;
      if (s.kind === "repo") return `repo:${projects.find((p) => p.id === s.ref_id)?.name ?? s.ref_id}`;
      const path = s.ref_id.slice(s.ref_id.indexOf(":") + 1);
      return `file:${path.slice(path.lastIndexOf("/") + 1)}`;
    });
}

/** The snapshot minus its summary — every field read from this window's own stores. */
export function readUiState(): Omit<UiStateSnapshot, "summary"> {
  const ws = useWorkspaceStore.getState();
  const ui = useUiStore.getState();
  const kind = windowKind();
  const workspace = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId) ?? null;
  const projects = ws.activeWorkspaceId ? (ws.projectsByWorkspace[ws.activeWorkspaceId] ?? []) : [];
  const project = ws.activeProject();

  const repo = useRepoStore.getState();
  const head = repo.branches.find((b) => b.is_head) ?? null;
  const status = repo.status;
  const changes = status ? status.staged.length + status.unstaged.length + status.untracked.length : 0;
  const branchName = status?.current_branch ?? head?.name ?? null;

  const snapshot: Omit<UiStateSnapshot, "summary"> = {
    window: { label: WINDOW.label, kind },
    workspace: workspace
      ? { name: workspace.name, others: ws.workspaces.filter((w) => w.id !== workspace.id).map((w) => w.name).slice(0, OTHERS_SHOWN) }
      : null,
    repo: project
      ? { name: project.name, others: projects.filter((p) => p.id !== project.id).map((p) => p.name).slice(0, OTHERS_SHOWN) }
      : null,
    branch:
      project && (branchName || status?.is_detached)
        ? {
            name: branchName ?? "HEAD",
            ...(head?.ahead ? { ahead: head.ahead } : {}),
            ...(head?.behind ? { behind: head.behind } : {}),
            ...(status?.is_detached ? { detached: true as const } : {}),
            ...(changes ? { changes } : {}),
          }
        : null,
  };

  // A repository island's tab is the window's own React state, not `uiStore` — so it is not said
  // rather than said wrong.
  if (kind !== "repo") snapshot.view = kind === "file" ? "editor" : activeViewKey();
  if (WINDOW.main && ui.settingsOpen) snapshot.settings = { section: ui.settingsSection, tab: ui.settingsTab };
  const tab = WINDOW.main ? aiPanelTab() : null;
  if (tab) snapshot.aiPanel = { tab };
  const terminal = useTerminalStore.getState();
  if (terminal.panelOpen) snapshot.dock = terminal.dockView;
  if (WINDOW.main && useLayoutStore.getState().flags.sidebarCollapsed) snapshot.sidebarCollapsed = true;
  const modals = openModals();
  if (modals.length) snapshot.modals = modals;
  const tour = useTourStore.getState();
  if (WINDOW.main && tour.active) {
    snapshot.tour = { id: tour.tourId, step: tour.index + 1, of: tourLength(tour.tourId), ...(tour.narrated ? { narrated: true as const } : {}) };
  }
  const caret = useEditorStatusStore.getState().status;
  if (caret && (ui.activeView === "editor" || kind === "file")) snapshot.editor = { path: caret.path, line: caret.line };
  const unsaved = collectUnsaved().length;
  if (unsaved) snapshot.unsaved = unsaved;
  const focus = focusInfo();
  if (focus) snapshot.focus = focus;
  const islands = islandNames();
  if (islands.length) snapshot.islands = islands;
  if (WINDOW.main) {
    const running = deriveRunning(useServicesStore.getState().runtime, ws.activeWorkspaceId).length;
    if (running) snapshot.services = running;
    const unread = useNotificationStore.getState().items.filter((n) => !n.seen).length;
    if (unread) snapshot.unread = unread;
  }
  return snapshot;
}

/** An island's name for the summary: the app's or repository's as the UI shows it. */
function islandLabel(island: string): string {
  if (island.startsWith("repo:") || island.startsWith("file:")) return island.slice(island.indexOf(":") + 1);
  return appName(island);
}

/**
 * The snapshot's gist in the app's language — see the module note. Line one says where; line two,
 * present only when something is, says what is open around it.
 */
export function summarize(state: Omit<UiStateSnapshot, "summary">): string {
  const where: string[] = [];
  const kind = state.window.kind;
  where.push(
    kind === "main"
      ? translate("codi.state.main")
      : translate("codi.state.island", {
          name: kind.startsWith("app:") ? appName(kind.slice(4)) : kind === "file" ? (state.editor?.path ?? "editor") : (state.repo?.name ?? kind),
        }),
  );
  const workspace = state.workspace?.name ?? translate("codi.state.noWorkspace");
  where.push(state.repo ? `${workspace} › ${state.repo.name}` : `${workspace} › ${translate("codi.state.noRepo")}`);
  if (state.branch) {
    const marks = [state.branch.ahead ? `↑${state.branch.ahead}` : "", state.branch.behind ? `↓${state.branch.behind}` : ""]
      .filter(Boolean)
      .join(" ");
    const name = state.branch.detached ? translate("codi.state.detached") : translate("codi.state.branch", { name: state.branch.name });
    where.push(marks ? `${name} ${marks}` : name);
  }
  if (state.view) where.push(viewLabel(state.view));

  const around: string[] = [];
  if (state.settings) {
    const section = SETTINGS_SECTIONS.find((s) => s.id === state.settings?.section);
    const pane = state.settings.tab ? tabsFor(section?.id ?? "general").find((t) => t.id === state.settings?.tab) : undefined;
    const name = [section ? translate(section.labelKey) : state.settings.section, pane ? translate(pane.labelKey) : null]
      .filter(Boolean)
      .join(" › ");
    around.push(translate("codi.state.settings", { name }));
  }
  if (state.tour) around.push(translate("codi.state.tour", { name: tourName(state.tour.id as Parameters<typeof tourName>[0]), n: state.tour.step, total: state.tour.of }));
  if (state.modals?.length) around.push(translate("codi.state.modal", { name: state.modals[0] }));
  if (state.aiPanel) around.push(translate("codi.state.aiPanel", { tab: state.aiPanel.tab }));
  if (state.dock) around.push(translate("codi.state.dock", { name: translate(DOCK_LABEL[state.dock as keyof typeof DOCK_LABEL] ?? "tabbar.terminal") }));
  if (state.sidebarCollapsed) around.push(translate("codi.state.sidebar"));
  if (state.editor) {
    const file = state.editor.path.slice(state.editor.path.lastIndexOf("/") + 1);
    around.push(translate("codi.state.editing", { name: file, line: state.editor.line }));
  }
  if (state.unsaved) around.push(translate("codi.state.unsaved", { n: state.unsaved }));
  if (state.focus && !state.focus.editor) {
    around.push(state.focus.private ? translate("codi.state.typingPrivate") : translate("codi.state.typing", { name: state.focus.label }));
  }
  if (state.islands?.length) {
    const names = state.islands.slice(0, 4).map(islandLabel);
    const more = state.islands.length - names.length;
    around.push(translate("codi.state.islands", { list: more > 0 ? `${names.join(", ")} +${more}` : names.join(", ") }));
  }
  if (state.services) around.push(translate("codi.state.services", { n: state.services }));
  if (state.unread) around.push(translate("codi.state.unread", { n: state.unread }));

  return around.length ? `${where.join(" · ")}\n${around.join(" · ")}` : where.join(" · ");
}

/** The whole snapshot, summary included. */
export function snapshotUiState(): UiStateSnapshot {
  const state = readUiState();
  return { ...state, summary: summarize(state) };
}

export const uiStateAction: CodiAction = defineAction({
  id: "ui.state",
  title: {
    en: "What this window shows right now: workspace, repository, branch, view, open panels and dialogs, the focused field, islands — plus a one-line summary.",
    es: "Lo que muestra esta ventana ahora: workspace, repositorio, rama, vista, paneles y diálogos abiertos, el campo enfocado, islas, y un resumen de una línea.",
  },
  aliases: { es: ["donde estoy", "que hay en pantalla", "que estoy viendo", "estado", "en que estoy"], en: ["where am i", "what is on screen", "what am i looking at", "status"] },
  params: params(),
  risk: "read",
  where: "any",
  frequent: true,
  run: async () => ({ result: snapshotUiState() }),
});
