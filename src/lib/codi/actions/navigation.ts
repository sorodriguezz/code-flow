import { REPO_VIEWS, useUiStore, type MainView, type PaletteScope, type SettingsSectionId } from "../../../state/uiStore";
import { useLayoutStore } from "../../../state/layoutStore";
import { useTerminalStore, type DockView } from "../../../state/terminalStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { usePreferencesStore } from "../../../state/preferencesStore";
import { pipelinesAvailable, useVcsConnectionsStore } from "../../../state/vcsConnectionsStore";
import { useAiPanelStore, INBOX_KEY, NO_WORKSPACE } from "../../../state/aiPanelStore";
import { translate } from "../../../state/languageStore";
import { SHORTCUT_BY_ID, SHORTCUT_COMMANDS, goHistory, type ShortcutId } from "../../shortcuts";
import { SETTINGS_SECTIONS, tabsFor } from "../../settingsCatalog";
import { appByKey, openRailApp } from "../../railApps";
import type { TranslationKey } from "../../i18n/translations";
import { CodiError, type CodiAction } from "../registry";
import {
  appVocabulary,
  dockVocabulary,
  literal,
  sectionVocabulary,
  shortcutVocabulary,
  tabVocabulary,
  viewVocabulary,
} from "../vocabulary";
import { APP_KEYS, appName, defineAction, oneOf, params, requireProject, requireWorkspace, say, text } from "./shared";

/**
 * Going places: rail apps, the repository's tabs, Settings, the AI panel, the dock, the sidebar, the
 * palette, back and forward — and any command of the shortcut registry.
 *
 * Wherever a keyboard shortcut already does the thing, its `run` is what runs: one implementation of
 * "open the Revisor, or its settings while it is off", not a second one that drifts.
 *
 * Every enum param carries its spoken names (`vocabulary`, see `../vocabulary`) as a **getter**: the
 * spec is copied at registration, and a getter reads the UI's labels then — in whichever languages
 * are loaded by that time — rather than once, at import, before the Spanish dictionary has arrived.
 */

/** The panel's verbs, as said. */
const PANEL_STATES = literal({
  open: { es: ["abre", "abrir", "muestra", "enciende", "despliega"], en: ["open", "show"] },
  close: { es: ["cierra", "cerrar", "oculta", "esconde", "quita"], en: ["close", "hide"] },
  toggle: { es: ["alterna", "cambia"], en: ["toggle"] },
});

const PANEL_TABS = {
  inbox: { es: ["bandeja", "bandeja de entrada", "inbox", "actividad", "pendientes"], en: ["inbox", "activity"] },
  chat: { es: ["chat", "chat del repo", "chat del repositorio"], en: ["chat", "repo chat", "repository chat"] },
  workspace: {
    es: ["chat del workspace", "chat de todos los repos", "chat con todos los repositorios"],
    en: ["workspace chat", "chat with every repo", "chat with all repositories"],
  },
};

const SIDEBAR_STATES = literal({
  collapse: { es: ["pliega", "oculta", "esconde", "cierra", "colapsa", "minimiza"], en: ["collapse", "hide", "fold", "close", "minimize"] },
  expand: { es: ["despliega", "muestra", "abre", "expande"], en: ["expand", "show", "unfold", "open"] },
});

const PALETTE_SCOPES = {
  all: { es: ["todo", "comandos"], en: ["everything", "commands"] },
  workspaces: { es: ["workspaces", "espacios de trabajo"], en: ["workspaces"] },
  projects: { es: ["repos", "repositorios", "proyectos"], en: ["repos", "repositories", "projects"] },
};

/** A shortcut's `run`, by id — the registry's, so a rebinding or a fix there reaches Codi too. */
function runShortcut(id: ShortcutId): void {
  const run = SHORTCUT_BY_ID.get(id)?.run;
  if (!run) throw new CodiError(`the shortcut ${id} has nothing to run outside the editor`);
  run();
}

/** The repository tabs, by the label the tab bar gives them. */
const VIEW_LABEL: Record<string, TranslationKey> = {
  graph: "tabbar.graph",
  changes: "tabbar.changes",
  editor: "tabbar.editor",
  pipelines: "tabbar.pipelines",
  reviewer: "tabbar.reviewer",
  codemap: "tabbar.codemap",
};

export function viewName(view: MainView): string {
  const key = VIEW_LABEL[view];
  return key ? translate(key) : view;
}

/** The dock's panels, by the name their buttons carry. */
export const DOCK_LABEL: Record<DockView, TranslationKey> = {
  terminal: "tabbar.terminal",
  containers: "containers.title",
  services: "services.title",
};

/**
 * Shortcut commands `shortcut.run` will not run: the ones with a typed action that asks first
 * (`git.push`), and the one that deletes a file by keystroke. Everything else in the registry is a
 * keypress the user could have made themselves.
 */
const SHORTCUTS_KEPT_BACK = new Set<ShortcutId>(["git.push", "editor.deletePath"]);

const RUNNABLE_SHORTCUTS = SHORTCUT_COMMANDS.filter((c) => c.run && !SHORTCUTS_KEPT_BACK.has(c.id)).map((c) => c.id);

const SETTINGS_SECTION_IDS = SETTINGS_SECTIONS.map((s) => s.id);
const SETTINGS_TAB_IDS = [...new Set(SETTINGS_SECTIONS.flatMap((s) => (s.tabs ?? []).map((tab) => tab.id)))];

/** Every action of this area, for the main window. */
export function navigationActions(): CodiAction[] {
  return [
    defineAction({
      id: "app.open",
      title: {
        en: "Open one of the rail's apps. When the app is in its own window (an island), that window is brought forward instead.",
        es: "Abre una de las apps del rail. Si la app está en su propia ventana (una isla), trae esa ventana al frente.",
      },
      aliases: { es: ["abre", "abrir", "abreme", "muestra", "muestrame", "ve a", "vamos a", "llevame a", "entra a", "entra en", "pasa a", "cambia a"], en: ["open", "show", "show me", "go to", "take me to", "switch to", "bring up", "launch"] },
      get vocabulary() {
        return { app: appVocabulary() };
      },
      params: params({ app: oneOf(APP_KEYS, "The rail app's key.") }, ["app"]),
      risk: "navigate",
      where: "main",
      frequent: true,
      run: async ({ app }) => {
        const entry = appByKey(String(app));
        if (!entry) throw new CodiError(`unknown app "${String(app)}"`);
        const how = openRailApp(entry);
        const name = appName(String(app));
        return {
          result: { app, [how]: true },
          say: say(how === "focused" ? "codi.say.appFocused" : "codi.say.appOpened", { name }),
        };
      },
    }),

    defineAction({
      id: "view.open",
      title: {
        en: "Show one of the open repository's tabs: graph, changes, editor, pipelines, reviewer or codemap. Rail apps open with app.open.",
        es: "Muestra una pestaña del repositorio abierto: grafo, cambios, editor, pipelines, revisor o mapa. Las apps del rail se abren con app.open.",
      },
      aliases: { es: ["muestra", "muestrame", "abre", "ve a", "ve al", "cambia a", "pasa a", "llevame a"], en: ["show", "open", "go to", "switch to", "take me to"] },
      get vocabulary() {
        return { view: viewVocabulary(REPO_VIEWS) };
      },
      params: params({ view: oneOf(REPO_VIEWS, "The repository tab.") }, ["view"]),
      risk: "navigate",
      where: "main",
      frequent: true,
      run: async ({ view }) => {
        const project = requireProject();
        const target = view as MainView;
        if (target === "pipelines" && !pipelinesAvailable(project, useVcsConnectionsStore.getState())) {
          throw new CodiError(
            "this repository has no Pipelines tab: it is not linked to a connected host with CI",
            say("codi.say.noPipelines", { name: project.name }),
          );
        }
        if (target === "reviewer" && !usePreferencesStore.getState().reviewerEnabled) {
          runShortcut("view.reviewer");
          return { result: { view, reviewerOff: true, openedSettings: "reviewer" }, say: say("codi.say.reviewerOff") };
        }
        runShortcut(`view.${target}` as ShortcutId);
        return { result: { view }, say: say("codi.say.viewOpened", { name: viewName(target) }) };
      },
    }),

    defineAction({
      id: "settings.open",
      title: {
        en: "Open Settings on a section, and optionally on one of its panes (tab).",
        es: "Abre Ajustes en una sección y, si se indica, en uno de sus paneles (tab).",
      },
      aliases: { es: ["abre ajustes", "abre los ajustes", "abre la configuracion", "abre configuracion", "configuracion de", "ajustes de", "ve a ajustes", "ve a configuracion", "abre preferencias", "preferencias de"], en: ["open settings", "settings for", "go to settings", "open preferences", "preferences for"] },
      get vocabulary() {
        return { section: sectionVocabulary(), tab: tabVocabulary() };
      },
      params: params(
        {
          section: oneOf(SETTINGS_SECTION_IDS, "The Settings section."),
          tab: oneOf(SETTINGS_TAB_IDS, "A pane of that section; each section has its own."),
        },
        ["section"],
      ),
      risk: "navigate",
      where: "main",
      frequent: true,
      run: async ({ section, tab }) => {
        const id = section as SettingsSectionId;
        const def = SETTINGS_SECTIONS.find((s) => s.id === id);
        if (!def) throw new CodiError(`unknown section "${id}"`);
        const ui = useUiStore.getState();
        let name = translate(def.labelKey);
        if (tab) {
          const pane = tabsFor(id).find((candidate) => candidate.id === tab);
          if (!pane) {
            const valid = tabsFor(id).map((candidate) => candidate.id);
            throw new CodiError(
              valid.length
                ? `"${String(tab)}" is not a pane of ${id}; its panes are: ${valid.join(", ")}`
                : `${id} has no panes; leave tab out`,
            );
          }
          ui.openSettingsAt(id, pane.id);
          name = `${name} › ${translate(pane.labelKey)}`;
        } else {
          ui.openSettings(id);
        }
        return { result: { section: id, tab: tab ?? null }, say: say("codi.say.settingsOpened", { name }) };
      },
    }),

    defineAction({
      id: "settings.close",
      title: { en: "Close Settings.", es: "Cierra Ajustes." },
      aliases: { es: ["cierra ajustes", "cierra los ajustes", "cierra la configuracion", "cierra configuracion", "sal de ajustes", "sal de la configuracion"], en: ["close settings", "close preferences", "exit settings"] },
      params: params(),
      risk: "navigate",
      where: "main",
      run: async () => {
        const open = useUiStore.getState().settingsOpen;
        useUiStore.getState().closeSettings();
        return { result: { wasOpen: open }, say: say("codi.say.settingsClosed") };
      },
    }),

    defineAction({
      id: "panel.ai",
      title: {
        en: "Open, close or toggle the assistant panel. tab picks what it shows: the inbox, the repository's chat, or the chat with every repository of the workspace.",
        es: "Abre, cierra o alterna el panel del asistente. tab elige qué muestra: la bandeja, el chat del repositorio o el chat con todos los repositorios del workspace.",
      },
      // «el panel de chat» is what the user calls it (2026-10-21) — the rail's «Chat» app is `app.open`.
      aliases: {
        es: ["panel de ia", "panel del asistente", "panel de chat", "panel del chat", "asistente", "abre el asistente", "cierra el asistente", "muestra el asistente", "oculta el asistente"],
        en: ["ai panel", "assistant panel", "chat panel", "assistant", "open the assistant", "close the assistant", "hide the assistant"],
      },
      get vocabulary() {
        return { state: PANEL_STATES, tab: literal(PANEL_TABS) };
      },
      params: params(
        {
          state: oneOf(["open", "close", "toggle"], "What to do with the panel; open when left out."),
          tab: oneOf(["inbox", "chat", "workspace"], "When opening: which tab to show."),
        },
        [],
      ),
      risk: "navigate",
      where: "main",
      frequent: true,
      // «Ahora el panel de chat»: named with no verb, it is to be seen.
      run: async ({ state = "open", tab }) => {
        const ui = useUiStore.getState();
        const wasOpen = ui.aiPanelOpen;
        if (state === "close" || (state === "toggle" && wasOpen)) {
          if (wasOpen) ui.toggleAiPanel();
          return { result: { open: false }, say: say("codi.say.aiPanelClosed") };
        }
        if (tab === "inbox") {
          useAiPanelStore.getState().open({ kind: "inbox" });
        } else if (tab === "chat") {
          const project = requireProject();
          const panel = useAiPanelStore.getState();
          const ws = useWorkspaceStore.getState().workspaceOfProject(project.id) ?? useWorkspaceStore.getState().activeWorkspaceId;
          const chats = (ws ? (panel.tabsByWorkspace[ws] ?? []) : []).filter(
            (t): t is Extract<typeof t, { kind: "chat" }> => t.kind === "chat" && t.projectId === project.id,
          );
          const reuse = chats.find((t) => t.key === (ws ? panel.activeByWorkspace[ws] : undefined)) ?? chats[chats.length - 1];
          panel.open({ kind: "chat", projectId: project.id, conversationId: reuse?.conversationId ?? null });
        } else if (tab === "workspace") {
          const workspace = requireWorkspace();
          const { openWorkspaceChat } = await import("../../aiPanelNav");
          openWorkspaceChat(workspace.id);
        } else {
          ui.openAiPanel();
        }
        return { result: { open: true, tab: tab ?? null }, say: say("codi.say.aiPanelOpened") };
      },
    }),

    ...dockActions(["terminal", "containers", "services"]),

    defineAction({
      id: "sidebar.toggle",
      title: {
        en: "Fold the projects sidebar to icons, or unfold it. state forces one; left out, it toggles.",
        es: "Pliega la barra de proyectos a iconos o la despliega. state fuerza uno; sin él, alterna.",
      },
      aliases: { es: ["barra lateral", "la barra lateral", "pliega la barra", "despliega la barra", "oculta la barra lateral", "muestra la barra lateral", "esconde la barra"], en: ["sidebar", "toggle the sidebar", "hide the sidebar", "show the sidebar", "collapse the sidebar", "expand the sidebar"] },
      get vocabulary() {
        return { state: SIDEBAR_STATES };
      },
      params: params({ state: oneOf(["collapse", "expand"], "Force collapsed or expanded.") }),
      risk: "navigate",
      where: "main",
      run: async ({ state }) => {
        const collapsed = useLayoutStore.getState().flags.sidebarCollapsed;
        const want = state === "collapse" ? true : state === "expand" ? false : !collapsed;
        if (want !== collapsed) runShortcut("panel.sidebar");
        return {
          result: { collapsed: want },
          say: say(want ? "codi.say.sidebarCollapsed" : "codi.say.sidebarExpanded"),
        };
      },
    }),

    defineAction({
      id: "palette.open",
      title: {
        en: "Open the command palette, optionally narrowed to workspaces or repositories.",
        es: "Abre la paleta de comandos, opcionalmente solo con workspaces o repositorios.",
      },
      aliases: { es: ["abre la paleta", "paleta de comandos", "abre la paleta de comandos", "muestra la paleta"], en: ["open the palette", "command palette", "open the command palette"] },
      get vocabulary() {
        return { scope: literal(PALETTE_SCOPES) };
      },
      params: params({ scope: oneOf(["all", "workspaces", "projects"], "What the palette lists.") }),
      risk: "navigate",
      where: "main",
      run: async ({ scope }) => {
        useUiStore.getState().openCommandPalette((scope as PaletteScope | undefined) ?? "all");
        return { result: { open: true }, say: say("codi.say.paletteOpened") };
      },
    }),

    defineAction({
      id: "palette.search",
      title: {
        en: "Search the command palette's entries (workspaces, repositories, branches, views, actions, settings panes). Returns keys for palette.run.",
        es: "Busca en las entradas de la paleta (workspaces, repositorios, ramas, vistas, acciones, paneles de ajustes). Devuelve claves para palette.run.",
      },
      aliases: { es: ["busca en la paleta", "busca el comando"], en: ["search the palette", "find the command"] },
      params: params({ query: text("Words to look for, in any order.") }, ["query"]),
      risk: "read",
      where: "main",
      run: async ({ query }) => {
        const palette = await import("../../paletteItems");
        const { ensureFlowContextEntries } = await import("../../../state/flowContextStore");
        ensureFlowContextEntries();
        const items = palette.buildPaletteItems(palette.paletteSourcesNow(translate));
        const hits = palette.filterPaletteItems(items, palette.SCOPE_GROUPS.all, String(query));
        return {
          result: {
            items: hits.slice(0, 15).map((item) => ({ key: item.key, label: item.label, group: item.group })),
            total: hits.length,
          },
        };
      },
    }),

    defineAction({
      id: "palette.run",
      title: {
        en: "Run a command palette entry by its key (from palette.search) — as if picked in the palette.",
        es: "Ejecuta una entrada de la paleta por su clave (de palette.search), como si se eligiera en la paleta.",
      },
      aliases: { es: ["ejecuta el comando de la paleta"], en: ["run the palette command"] },
      params: params({ key: text("The entry's key, e.g. action:fetch or settings:voice:devices.") }, ["key"]),
      risk: "write",
      where: "main",
      run: async ({ key }) => {
        // Push has a typed action that asks first; the palette's row would run it on the spot.
        if (key === "action:push") throw new CodiError("pushing goes through git.push, which asks the user first");
        const palette = await import("../../paletteItems");
        const item = palette.buildPaletteItems(palette.paletteSourcesNow(translate)).find((candidate) => candidate.key === key);
        if (!item) throw new CodiError(`no palette entry "${String(key)}" right now — search again with palette.search`);
        item.onSelect();
        return { result: { ran: item.key, label: item.label }, say: say("codi.say.ranEntry", { name: item.label }) };
      },
    }),

    defineAction({
      id: "nav.back",
      title: { en: "Go back to where this window was before (⌥←).", es: "Vuelve a donde estaba esta ventana antes (⌥←)." },
      aliases: { es: ["atras", "vuelve atras", "volver atras", "regresa", "ve atras", "anterior", "vuelve"], en: ["back", "go back", "previous"] },
      params: params(),
      risk: "navigate",
      where: "main",
      frequent: true,
      run: async () => {
        goHistory("back");
        return { result: { view: useUiStore.getState().activeView }, say: say("codi.say.wentBack") };
      },
    }),

    defineAction({
      id: "nav.forward",
      title: { en: "Go forward again after going back (⌥→).", es: "Avanza de nuevo después de volver (⌥→)." },
      aliases: { es: ["adelante", "avanza", "ve adelante", "siguiente"], en: ["forward", "go forward", "next"] },
      params: params(),
      risk: "navigate",
      where: "main",
      run: async () => {
        goHistory("forward");
        return { result: { view: useUiStore.getState().activeView }, say: say("codi.say.wentForward") };
      },
    }),

    defineAction({
      id: "shortcut.run",
      title: {
        en: "Run any command of the keyboard-shortcut registry by its id, as if its chord were pressed.",
        es: "Ejecuta cualquier comando del registro de atajos por su id, como si se pulsara su combinación.",
      },
      aliases: { es: ["ejecuta el atajo", "usa el atajo", "atajo"], en: ["run the shortcut", "shortcut"] },
      get vocabulary() {
        return { id: shortcutVocabulary(RUNNABLE_SHORTCUTS) };
      },
      params: params({ id: oneOf(RUNNABLE_SHORTCUTS, "The shortcut command's id.") }, ["id"]),
      risk: "write",
      where: "main",
      run: async ({ id }) => {
        const command = SHORTCUT_BY_ID.get(id as ShortcutId);
        if (!command?.run) throw new CodiError(`the shortcut ${String(id)} has nothing to run`);
        command.run();
        const name = translate(command.labelKey);
        return { result: { ran: id }, say: say("codi.say.ranEntry", { name }) };
      },
    }),
  ];
}

/** The dock's two, for the views a window's dock has — all three in the main window, the terminal
 *  alone in a repository island. */
export function dockActions(views: DockView[]): CodiAction[] {
  return [
    defineAction({
      id: "dock.show",
      title: {
        en: "Show a panel of the bottom dock: the terminals, the containers or the services.",
        es: "Muestra un panel del dock inferior: las terminales, los contenedores o los servicios.",
      },
      aliases: { es: ["abre", "muestra", "abre la", "muestra la", "abre los", "muestra los"], en: ["open", "show", "open the", "show the"] },
      get vocabulary() {
        return { view: dockVocabulary(views) };
      },
      params: params({ view: oneOf(views, "Which panel.") }, ["view"]),
      risk: "navigate",
      where: views.length > 1 ? "main" : "any",
      frequent: true,
      run: async ({ view }) => {
        useTerminalStore.getState().showDock(view as DockView);
        return { result: { dock: view }, say: say("codi.say.dockShown", { name: translate(DOCK_LABEL[view as DockView]) }) };
      },
    }),
    defineAction({
      id: "dock.hide",
      title: { en: "Hide the bottom dock, whichever panel it shows.", es: "Oculta el dock inferior, muestre el panel que muestre." },
      aliases: { es: ["cierra el dock", "oculta el dock", "esconde el dock", "cierra la terminal", "oculta la terminal", "cierra el panel de abajo", "oculta el panel inferior"], en: ["close the dock", "hide the dock", "close the terminal", "hide the terminal", "hide the bottom panel"] },
      params: params(),
      risk: "navigate",
      where: views.length > 1 ? "main" : "any",
      run: async () => {
        useTerminalStore.getState().hidePanel();
        return { result: { dock: null }, say: say("codi.say.dockHidden") };
      },
    }),
  ];
}

/** The AI panel's tab as `ui.state` reports it: the kind of the tab on screen, or null when closed. */
export function aiPanelTab(): string | null {
  if (!useUiStore.getState().aiPanelOpen) return null;
  const ws = useWorkspaceStore.getState().activeWorkspaceId ?? NO_WORKSPACE;
  const panel = useAiPanelStore.getState();
  const key = panel.activeByWorkspace[ws] ?? INBOX_KEY;
  if (key === INBOX_KEY) return "inbox";
  return (panel.tabsByWorkspace[ws] ?? []).find((t) => t.key === key)?.kind ?? "inbox";
}
