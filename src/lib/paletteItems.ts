import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bot,
  Braces,
  Briefcase,
  CirclePlay,
  ClipboardList,
  Cloud,
  Container,
  Database,
  Download,
  FolderGit2,
  FolderPlus,
  GitBranch,
  Glasses,
  History,
  KeyRound,
  MessageCircle,
  MessagesSquare,
  MonitorSmartphone,
  NotebookPen,
  Plus,
  RefreshCw,
  Rocket,
  Route,
  SaveAll,
  ShieldCheck,
  Network,
  SquareAsterisk,
  Sparkles,
  TerminalSquare,
  Waypoints,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";
import { TOOLS } from "./toolbox/catalog";
import { appByKey, openRailApp } from "./railApps";
import { canPasteJsonHere, pasteJsonInFocusedEditor } from "../components/editor/pasteJsonAsCode";
import { WORKSPACE_ICONS } from "../components/layout/WorkspaceGlyph";
import { fetchNow, pullNow, pushNow } from "./gitActions";
import { flowEntriesFor, runFlowEntry } from "../state/flowContextStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { usePreferencesStore } from "../state/preferencesStore";
import { useMissingProjectsStore } from "../state/missingProjectsStore";
import { useWindowStore } from "../state/windowStore";
import { useRepoStore } from "../state/repoStore";
import { useUiStore, type ApiWorkspace, type MainView, type PaletteScope } from "../state/uiStore";
import { SETTINGS_SECTIONS } from "./settingsCatalog";
import { useTerminalStore } from "../state/terminalStore";
import { useEditorCommandStore } from "../state/editorCommandStore";
import { ensureApiStoreLoaded, useApiStore } from "../state/apiStore";
import { useApiModalStore } from "../state/apiModalStore";
import { useQuickAskHotkeyStore } from "../state/quickAskHotkeyStore";
import type { Translate } from "../state/languageStore";
import type { TranslationKey } from "./i18n/translations";
import type { SatelliteInfo } from "./tauri/windows";
import type { BranchInfo, Project, Workspace } from "../types/domain";
import { quickAskOpen } from "./tauri/windows";
import { acceleratorKeycaps } from "./globalHotkey";
import { isMac } from "./platform";
import { pushErrorToast } from "../state/toastStore";

/**
 * Everything the command palette lists, and how a query narrows it.
 *
 * Out of `CommandPalette` (where it was built inline, inside one `useMemo`) because the palette is
 * no longer its only reader: «Codi» searches and runs palette entries by voice, and a second list of
 * "what the palette can do" would drift from the first the way the settings list once drifted from
 * the real nav (see `settingsCatalog`). The palette passes what it subscribed to; Codi passes the
 * stores as they are now ([`paletteSourcesNow`]). Same rows, same keys, same order either way.
 */

/** Folded for matching: case and accents both ignored, so "configuracion" finds "Configuración". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export type PaletteGroup = "workspaces" | "projects" | "branches" | "views" | "actions" | "api" | "tools" | "settings";

export interface PaletteItem {
  key: string;
  icon: typeof GitBranch;
  label: string;
  group: PaletteGroup;
  onSelect: () => void;
  /** Key caps drawn at the end of the row — for the one action whose chord is not an app chord. */
  keys?: string[];
  /** Extra words the row is found by but never shows — the toolbox's "jwt", "b64", "epoch". */
  keywords?: string;
}

/** A scoped opening (from the "switch repository" / "switch workspace" / "switch branch"
 * shortcuts) narrows the palette to one group, so it acts as a dedicated picker. */
export const SCOPE_GROUPS: Record<PaletteScope, PaletteGroup[]> = {
  all: ["workspaces", "projects", "branches", "views", "actions", "api", "tools", "settings"],
  workspaces: ["workspaces"],
  projects: ["projects"],
};

/**
 * Everywhere "go to…" can take you.
 *
 * Kept in step with the app rail on purpose: this list was missing Remote and Pipelines outright,
 * and folded the API tab's two workspaces into one row, so three of the eleven destinations could
 * only be reached with the mouse. `workspace` is how the two halves of the API tab get a row each —
 * the same field the rail uses, for the same reason.
 */
export const VIEW_ITEMS: {
  id: MainView;
  labelKey: TranslationKey;
  icon: typeof GitBranch;
  workspace?: ApiWorkspace;
}[] = [
  { id: "graph", labelKey: "tabbar.graph", icon: History },
  { id: "changes", labelKey: "tabbar.changes", icon: GitBranch },
  { id: "editor", labelKey: "tabbar.editor", icon: FolderGit2 },
  // Conditional in the tab bar — it exists only on a repository linked to a host with CI — but
  // unconditional here: the palette is how you find out a screen exists, and a row that vanishes
  // depending on which repository is selected is one nobody learns.
  { id: "pipelines", labelKey: "tabbar.pipelines", icon: Route },
  // Unlike Pipelines, listed only while switched on: the tab is opted into in Settings, and a row
  // here would only bounce off the guard in `App.tsx`. Settings › Revisor is found by the search.
  { id: "reviewer", labelKey: "tabbar.reviewer", icon: ShieldCheck },
  { id: "codemap", labelKey: "tabbar.codemap", icon: Network },
  { id: "env", labelKey: "tabbar.env", icon: SquareAsterisk },
  { id: "api", workspace: "requests", labelKey: "tabbar.api", icon: Zap },
  { id: "api", workspace: "database", labelKey: "tabbar.databases", icon: Database },
  { id: "agents", labelKey: "tabbar.agents", icon: Bot },
  { id: "stories", labelKey: "tabbar.stories", icon: ClipboardList },
  { id: "remote", labelKey: "tabbar.remote", icon: MonitorSmartphone },
  { id: "notes", labelKey: "tabbar.notes", icon: NotebookPen },
  { id: "diagrams", labelKey: "tabbar.diagrams", icon: Workflow },
  { id: "vault", labelKey: "tabbar.vault", icon: KeyRound },
  // The same glyph the rail uses, and deliberately not `MessageCircle` above — that one is already
  // spelled for the AI panel's repository chat in the actions group below, and two rows sharing an
  // icon in one palette is how you pick the wrong one.
  { id: "chat", labelKey: "tabbar.chat", icon: MessagesSquare },
  { id: "flows", labelKey: "tabbar.flows", icon: Waypoints },
  { id: "architecture", labelKey: "tabbar.architecture", icon: Network },
  { id: "toolbox", labelKey: "tabbar.toolbox", icon: Wrench },
];

export const GROUP_LABEL_KEY: Record<PaletteGroup, TranslationKey> = {
  workspaces: "sidebar.workspaces",
  projects: "sidebar.projects",
  branches: "sidebar.localBranches",
  views: "titlebar.goTo",
  actions: "titlebar.aiActions",
  api: "api.title",
  tools: "tabbar.toolbox",
  settings: "statusbar.settings",
};

/** What the rows are built from — the palette's subscriptions, or the stores as they are now. */
export interface PaletteSources {
  t: Translate;
  workspaces: Workspace[];
  /** The active workspace's repositories. */
  projects: Project[];
  missing: ReadonlySet<string>;
  notARepo: ReadonlySet<string>;
  satellites: SatelliteInfo[];
  branches: BranchInfo[];
  activeView: MainView;
  quickAskChord: string | null;
}

/** The sources as the stores hold them right now — for a caller that is not a component. */
export function paletteSourcesNow(t: Translate): PaletteSources {
  const workspace = useWorkspaceStore.getState();
  const { missing, notARepo } = useMissingProjectsStore.getState();
  return {
    t,
    workspaces: workspace.workspaces,
    projects: workspace.activeWorkspaceId ? (workspace.projectsByWorkspace[workspace.activeWorkspaceId] ?? []) : [],
    missing,
    notARepo,
    satellites: useWindowStore.getState().satellites,
    branches: useRepoStore.getState().branches,
    activeView: useUiStore.getState().activeView,
    quickAskChord: useQuickAskHotkeyStore.getState().accelerator,
  };
}

/** Every row the palette can show, in group order. */
export function buildPaletteItems({
  t,
  workspaces,
  projects,
  missing,
  notARepo,
  satellites,
  branches,
  activeView,
  quickAskChord,
}: PaletteSources): PaletteItem[] {
  // The stores' own actions — the same functions the palette used to select through its hooks.
  const { setActiveWorkspace, setActiveProject } = useWorkspaceStore.getState();
  const { checkoutBranch, checkoutRemoteBranch } = useRepoStore.getState();
  const {
    setActiveView,
    openSettings,
    openSettingsAt,
    openApiWorkspace,
    openPrLinkModal,
    openCloneModal,
    openProjectInit,
    toggleAiPanel,
  } = useUiStore.getState();
  const { togglePanel: toggleTerminalPanel, toggleDock } = useTerminalStore.getState();
  const { openApiModal } = useApiModalStore.getState();

  const workspaceItems: PaletteItem[] = workspaces.map((w) => ({
    key: `workspace:${w.id}`,
    icon: WORKSPACE_ICONS[w.icon] ?? Briefcase,
    label: w.name,
    group: "workspaces",
    onSelect: () => setActiveWorkspace(w.id),
  }));

  // Repositories that cannot be opened — the folder gone, or the folder no longer a repository —
  // are left out rather than listed and refused: every entry in this palette is something that
  // happens when you press Return on it, and the sidebar has already taken "open" off these —
  // see `missingProjectsStore`. They are still in the sidebar and in Settings, which is where the
  // row that says why, and the buttons that repair or remove it, live.
  const projectItems: PaletteItem[] = projects
    .filter(
      (p) =>
        !missing.has(p.local_path) &&
        !notARepo.has(p.local_path) &&
        !satellites.some((s) => s.kind === "repo" && s.ref_id === p.id),
    )
    .map((p) => ({
      key: `project:${p.id}`,
      icon: FolderGit2,
      label: p.name,
      group: "projects",
      onSelect: () => setActiveProject(p.id),
    }));

  const branchItems: PaletteItem[] = branches.map((b) => ({
    key: `branch:${b.name}`,
    icon: b.is_remote ? Cloud : GitBranch,
    label: b.name,
    group: "branches",
    onSelect: () => (b.is_remote ? checkoutRemoteBranch(b.name) : checkoutBranch(b.name)),
  }));

  const viewItems: PaletteItem[] = [
    ...VIEW_ITEMS.filter(({ id }) => id !== "reviewer" || usePreferencesStore.getState().reviewerEnabled).map(({ id, labelKey, icon, workspace }) => ({
      key: `view:${id}:${workspace ?? ""}`,
      icon,
      label: t(labelKey),
      group: "views" as const,
      onSelect: () => (workspace ? openApiWorkspace(workspace) : setActiveView(id)),
    })),
    {
      key: "view:ai-panel",
      icon: MessageCircle,
      label: t("assistant.title"),
      group: "views" as const,
      onSelect: () => toggleAiPanel(),
    },
    {
      key: "view:terminal",
      icon: TerminalSquare,
      label: t("tabbar.terminal"),
      group: "views" as const,
      onSelect: () => toggleTerminalPanel(),
    },
    // Its own entry since the dock split into two panels (2026-09-30), the same toggle as its
    // button at the foot of the projects panel.
    {
      key: "view:containers",
      icon: Container,
      label: t("containers.title"),
      group: "views" as const,
      onSelect: () => toggleDock("containers"),
    },
    {
      key: "view:services",
      icon: CirclePlay,
      label: t("services.title"),
      group: "views" as const,
      onSelect: () => toggleDock("services"),
    },
  ];

  /**
   * Things to *do*, as opposed to places to go.
   *
   * This group held exactly one entry for a long time — review a PR from its link — which made a
   * "command palette" a navigator with one command in it. These are the actions that are worth
   * reaching without knowing where their button is: the three git verbs everyone runs all day,
   * and the two ways a repository gets into the app in the first place.
   *
   * Deliberately no destructive verbs. Discard, delete and force-push are one fuzzy match and a
   * Return away from each other in a list like this, and none of them should ever be reachable
   * that fast.
   */
  const actionItems: PaletteItem[] = [
    // Needs nothing but the link — no project open, no repository picked.
    {
      key: "action:pr-from-link",
      icon: Glasses,
      label: t("prLink.menuItem"),
      group: "actions",
      onSelect: () => openPrLinkModal(),
    },
    {
      key: "action:fetch",
      icon: RefreshCw,
      label: t("statusbar.fetch"),
      group: "actions",
      onSelect: () => fetchNow(),
    },
    {
      key: "action:pull",
      icon: ArrowDownToLine,
      label: t("statusbar.pull"),
      group: "actions",
      onSelect: () => pullNow(),
    },
    {
      key: "action:push",
      icon: ArrowUpFromLine,
      label: t("statusbar.push"),
      group: "actions",
      onSelect: () => pushNow(),
    },
    {
      key: "action:clone",
      icon: Download,
      label: t("sidebar.cloneRepo"),
      group: "actions",
      onSelect: () => openCloneModal(),
    },
    // The third way a repository gets into the app: made from a framework template.
    {
      key: "action:new-project",
      icon: Rocket,
      label: t("scaffold.open"),
      group: "actions",
      onSelect: () => openProjectInit(),
    },
    // The hotkey ask box, reachable from here too — and the place its system-wide chord is
    // shown, which is otherwise only learnt from Settings.
    {
      key: "action:quick-ask",
      icon: Sparkles,
      label: t("quickAsk.paletteAction"),
      group: "actions",
      onSelect: () => void quickAskOpen().catch((e: unknown) => pushErrorToast(String(e))),
      keys: quickAskChord ? acceleratorKeycaps(quickAskChord, isMac()) : undefined,
    },
    // Flows that act on a folder («Menú contextual» on a folder), on the repository that is open —
    // the same run the file tree's right click on its root starts.
    ...(() => {
      const repo = projects.find((p) => p.id === useWorkspaceStore.getState().activeProjectId);
      if (!repo) return [];
      return flowEntriesFor("folder", repo.local_path).map((entry) => ({
        key: `action:flow:${entry.flowId}:${entry.nodeId}`,
        icon: Workflow,
        label: `${entry.label} · ${repo.name}`,
        group: "actions" as const,
        onSelect: () =>
          void runFlowEntry(entry, { place: "folder", path: repo.local_path, relativePath: "", name: repo.name, repoPath: repo.local_path, projectId: repo.id }),
      }));
    })(),
    // Where VS Code users look for it (⇧⌘P, "paste json"). Listed only with a file open in the
    // Editor — there is nothing to paste into anywhere else, and every row here has to do
    // something. Runs from this very click or Enter, which the clipboard read needs.
    ...(activeView === "editor" && canPasteJsonHere()
      ? [
          {
            key: "action:paste-json",
            icon: Braces,
            label: t("pasteJson.action"),
            group: "actions" as const,
            onSelect: pasteJsonInFocusedEditor,
          },
        ]
      : []),
    // Every unsaved tab of the project (`saveAll` in `EditorView`) — with the Editor on screen,
    // which is where there are tabs to save.
    ...(activeView === "editor"
      ? [
          {
            key: "action:save-all",
            icon: SaveAll,
            label: t("editor.saveAll"),
            group: "actions" as const,
            onSelect: () => useEditorCommandStore.getState().send("saveAll"),
          },
        ]
      : []),
  ];

  // The API client is app-global, so these work with no project open — but each one has to
  // switch to the view as well, because `ApiView` is what mounts the tab strip and the modals.
  const openApi = (then?: () => void) => {
    setActiveView("api");
    void ensureApiStoreLoaded().then(() => then?.());
  };

  const apiItems: PaletteItem[] = [
    {
      key: "api:new-request",
      icon: Plus,
      label: t("api.newRequest"),
      group: "api",
      onSelect: () => openApi(() => useApiStore.getState().openScratchTab()),
    },
    {
      key: "api:new-collection",
      icon: FolderPlus,
      label: t("api.newCollection"),
      group: "api",
      onSelect: () =>
        openApi(() => void useApiStore.getState().createCollection(t("api.untitledCollection"))),
    },
    {
      key: "api:import",
      icon: Download,
      label: t("api.import.title"),
      group: "api",
      onSelect: () => openApi(() => openApiModal({ kind: "import" })),
    },
  ];

  /**
   * Every settings destination, panes included, straight from the catalog.
   *
   * It used to be a hand-written list of eleven ids that had drifted three behind the real nav —
   * Terminal, Remote and Backup were unreachable from here — and it had never known about the
   * sub-tabs at all, so "proxy" or "snippets" matched nothing. Reading the catalog means adding a
   * pane makes it findable here without anybody remembering to.
   */
  const settingsItems: PaletteItem[] = SETTINGS_SECTIONS.flatMap((section) => [
    {
      key: `settings:${section.id}`,
      icon: section.icon,
      label: t(section.labelKey),
      group: "settings" as const,
      onSelect: () => openSettings(section.id),
    },
    ...(section.tabs ?? []).map((tab) => ({
      key: `settings:${section.id}:${tab.id}`,
      icon: tab.icon,
      // Named with its section, because half these panes share a word with another one —
      // there is a "General" in the API client's settings and a "General" at the top level.
      label: `${t(section.labelKey)} › ${t(tab.labelKey)}`,
      group: "settings" as const,
      onSelect: () => openSettingsAt(section.id, tab.id),
    })),
  ]);

  /**
   * Every tool of «Herramientas», so typing "jwt", "base64" or "uuid" opens that tool directly.
   * Found by their keywords as well as their names, and only listed once something is typed — 54
   * rows would bury the palette's own groups (see `filterPaletteItems`).
   */
  const toolItems: PaletteItem[] = TOOLS.map((tool) => ({
    key: `tool:${tool.id}`,
    icon: tool.icon,
    label: `${t("tabbar.toolbox")} › ${t(tool.titleKey)}`,
    group: "tools" as const,
    keywords: `${tool.id} ${tool.keywords}`,
    onSelect: () => {
      // Imported lazily: the store pulls in settings sync, which the palette's own tests stub.
      void import("../state/toolboxStore").then(({ useToolboxStore }) => {
        useToolboxStore.getState().open(tool.id);
        const app = appByKey("toolbox");
        if (app) openRailApp(app);
      });
    },
  }));

  return [
    ...workspaceItems,
    ...projectItems,
    ...branchItems,
    ...viewItems,
    ...actionItems,
    ...apiItems,
    ...toolItems,
    ...settingsItems,
  ];
}

/**
 * The rows a query leaves, laid out in group order — the order the rows are drawn in and the arrow
 * keys walk. Every word has to appear, in any order and without regard to case or accents.
 */
export function filterPaletteItems(items: PaletteItem[], groups: PaletteGroup[], query: string): PaletteItem[] {
  const words = fold(query.trim()).split(/\s+/).filter(Boolean);
  // The toolbox's rows wait for a query: with nothing typed they would only push the other groups
  // down the list.
  const inScope = items.filter((item) => groups.includes(item.group) && (words.length > 0 || item.group !== "tools"));
  const hits =
    words.length === 0
      ? inScope
      : inScope.filter((item) => {
          const haystack = fold(item.keywords ? `${item.label} ${item.keywords}` : item.label);
          return words.every((w) => haystack.includes(w));
        });
  return groups.flatMap((group) => hits.filter((item) => item.group === group));
}
