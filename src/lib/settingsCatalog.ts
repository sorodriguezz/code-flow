/**
 * Every destination inside the Settings window, in one list.
 *
 * There are fifteen sections and twenty-odd panes behind them, and until this file existed that
 * map was written down four separate times: the nav in `SettingsView`, the `TABS` array inside each
 * section that has a sub-rail, and the `SETTINGS_ITEMS` list in the command palette. They drifted,
 * exactly as duplicated lists do — the palette was missing Terminal, Remote and Backup, and no
 * search could have been written against any of them because none of them knew about the sub-tabs.
 *
 * So: one catalog, three readers.
 *
 * 1. `SettingsView` draws its nav from `SETTINGS_SECTIONS`.
 * 2. Each section with a sub-rail reads its own tabs back out of here (`tabsFor`), so the labels
 *    and icons in the rail and in the search results are the same objects.
 * 3. The command palette and the settings search both call `searchSettings`, so a pane is
 *    reachable by name from either without being listed a second time.
 *
 * **Adding a pane is one entry here.** That is the whole point of the file.
 */

import {
  AlignLeft,
  AppWindow,
  AudioLines,
  AudioWaveform,
  Bell,
  Blocks,
  BookOpen,
  Bot,
  Braces,
  BrainCircuit,
  Briefcase,
  ChartColumn,
  Cloud,
  Compass,
  Cpu,
  Mic,
  Database,
  DatabaseBackup,
  Download,
  FileCode2,
  FolderGit2,
  Gauge,
  GitBranch,
  Globe,
  Workflow,
  NotebookPen,
  GitPullRequest,
  Speaker,
  Layers,
  Files,
  GraduationCap,
  HardDrive,
  History,
  Info,
  Keyboard,
  KeyRound,
  Languages,
  LayoutGrid,
  ListChecks,
  Lock,
  MessageSquareText,
  MonitorDot,
  Network,
  PackagePlus,
  Plug,
  Palette,
  PanelsTopLeft,
  Power,
  QrCode,
  RefreshCw,
  Route,
  ScanSearch,
  Scissors,
  Server,
  Settings2,
  Share2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Smartphone,
  SquarePen,
  SunMoon,
  TerminalSquare,
  TextWrap,
  type LucideIcon,
  Upload,
  UserRound,
  UsersRound,
  Volume2,
  Waypoints,
  Wrench,
} from "lucide-react";
import type { TranslationKey } from "./i18n/translations";
import type { SettingsSectionId } from "../state/uiStore";

/** One pane inside a section that has a sub-rail. */
export interface SettingsTabDef {
  id: string;
  labelKey: TranslationKey;
  icon: LucideIcon;
  /** The one-line explanation shown above the pane. Optional because a few panes are self-evident
   *  enough that a line under their own name would repeat it. */
  hintKey?: TranslationKey;
  /**
   * Extra words this pane should answer to in the search, as a translated comma-separated list.
   *
   * Necessary because a pane is almost never looked for by its own name: nobody types "Language
   * servers", they type "LSP" or "autocomplete". Keeping the synonyms in the dictionary rather than
   * here means they can differ per language, which matters — "atajos" and "shortcuts" have
   * different neighbours.
   */
  searchKey?: TranslationKey;
  /** A small heading the rail prints above this pane — where a long rail falls into parts
   *  (Motores · Consumo, Cuentas · Comportamiento). */
  headingKey?: TranslationKey;
}

export interface SettingsSectionDef {
  id: SettingsSectionId;
  labelKey: TranslationKey;
  icon: LucideIcon;
  /** Which of the nav's four groups lists it: the app itself, code, AI, or one of the apps. */
  group: "app" | "code" | "ai" | "apps";
  /**
   * `workspace`: every setting in it belongs to the open workspace (PR review). The nav used to
   * have a group for these; now the section says it in its header, and a row that may differ per
   * workspace says it on the row — see «Workspaces y proyectos › Este workspace».
   */
  scope?: "workspace";
  tabs?: SettingsTabDef[];
  searchKey?: TranslationKey;
}

/**
 * The sections, in the order the nav lists them.
 *
 * The order is an argument, not an accident, and it is the one the nav has always made: the things
 * you set once and forget (General, Appearance) first, the things you touch while working in the
 * middle, and the two you visit twice — once to set up, once on the day something went wrong —
 * last.
 */
export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  // ------------------------------------------------------------------ the app itself
  {
    id: "general",
    labelKey: "settings.general",
    icon: Globe,
    group: "app",
    // The grouping the user chose: the language beside the version (updates, the site, Ko-fi — all in
    // `UpdateSection`), the window limit on its own, the tours on their own, and the app's own files.
    tabs: [
      { id: "language", labelKey: "settings.tabLanguageUpdates", icon: Languages, searchKey: "settings.searchTermsLanguageUpdates" },
      { id: "windows", labelKey: "windows.limitLabel", hintKey: "windows.limitHint", icon: AppWindow, searchKey: "settings.searchTermsWindows" },
      { id: "tours", labelKey: "tour.settingsTitle", hintKey: "tour.settingsHint", icon: GraduationCap, searchKey: "settings.searchTermsTours" },
      { id: "data", labelKey: "settings.tabAppData", icon: HardDrive, searchKey: "settings.searchTermsAppData" },
      // The version, the log folder and the way to report a problem — which were only ever in the
      // macOS Help menu, so Windows and Linux had none of them.
      { id: "about", labelKey: "settings.tabAbout", icon: Info, searchKey: "settings.searchTermsAbout" },
    ],
  },
  {
    id: "appearance",
    labelKey: "settings.appearance",
    icon: Palette,
    group: "app",
    // The two small choices about the whole app's look share a pane; the schemes, a grid per mode,
    // are a visit of their own. The thinking mark came here from the AI section (2026-10-09): it is
    // how something looks, and its voice is in «Voz y sonido».
    tabs: [
      { id: "look", labelKey: "settings.tabModeColor", icon: SunMoon, searchKey: "settings.searchTermsModeColor" },
      { id: "themes", labelKey: "settings.editorThemes", icon: Palette, searchKey: "settings.searchTermsThemes" },
      // No line under the title: the user asked for it gone (2026-10-08) — the tiles running above
      // the state picker say what this is better than a sentence did.
      { id: "thinking", labelKey: "settings.thinkingTitle", icon: BrainCircuit, searchKey: "settings.searchTermsThinking" },
    ],
  },
  {
    id: "keybindings",
    labelKey: "shortcuts.title",
    icon: Keyboard,
    group: "app",
    // One pane per group of commands, in the order the list used to run — a list that took six
    // screens to scroll through. Ids are `ShortcutGroup`s and the labels the groups' own
    // (`SHORTCUT_GROUP_LABELS`); a test holds the two lists to each other.
    tabs: [
      { id: "general", labelKey: "shortcuts.groupGeneral", hintKey: "shortcuts.recordHint", icon: Keyboard },
      { id: "panels", labelKey: "shortcuts.groupPanels", hintKey: "shortcuts.recordHint", icon: PanelsTopLeft },
      { id: "views", labelKey: "shortcuts.groupViews", hintKey: "shortcuts.recordHint", icon: LayoutGrid },
      { id: "editor", labelKey: "shortcuts.groupEditor", hintKey: "shortcuts.recordHint", icon: FileCode2 },
      { id: "database", labelKey: "shortcuts.groupDatabase", hintKey: "shortcuts.recordHint", icon: Database },
      { id: "navigation", labelKey: "shortcuts.navigation", hintKey: "shortcuts.recordHint", icon: Compass },
      { id: "workspace", labelKey: "shortcuts.groupWorkspace", hintKey: "shortcuts.recordHint", icon: Briefcase },
      { id: "git", labelKey: "shortcuts.groupGit", hintKey: "shortcuts.recordHint", icon: GitBranch },
      // The three the old hand-written group list never had — so ⌘⏎, ⌘L, ⌘⇧H and ⌘⇧K could not be
      // rebound at all. The pane list is this one now, which is what keeps a new group from being
      // left out again.
      { id: "api", labelKey: "api.title", hintKey: "shortcuts.recordHint", icon: Wrench },
      { id: "vault", labelKey: "tabbar.vault", hintKey: "shortcuts.recordHint", icon: KeyRound },
      { id: "chat", labelKey: "tabbar.chat", hintKey: "shortcuts.recordHint", icon: MessageSquareText },
    ],
    searchKey: "settings.searchTermsKeys",
  },
  {
    id: "notifications",
    labelKey: "notifications.settingsTitle",
    // The bell, the same glyph as the status bar's notification centre these settings are about.
    icon: Bell,
    group: "app",
    // The questions in the order they get asked: what it sounds like, whether it reaches me when I
    // am not looking, and about what — and, per source, whether it shows, sounds or is said aloud.
    // The synonyms are per pane rather than on the section — a section-level list answers for every
    // pane at once, so "sonido" used to list all of them.
    tabs: [
      {
        id: "sound",
        labelKey: "notifications.soundTitle",
        hintKey: "notifications.soundPaneHint",
        icon: Volume2,
        searchKey: "settings.searchTermsSound",
      },
      {
        id: "delivery",
        labelKey: "notifications.deliveryTitle",
        icon: MonitorDot,
        searchKey: "settings.searchTermsNotifications",
      },
      {
        id: "sources",
        labelKey: "notifications.sourcesTitle",
        hintKey: "notifications.sourcesHint",
        icon: Bell,
        searchKey: "settings.searchTermsSources",
      },
    ],
  },
  {
    // What listens and what speaks, out of the AI section where three of its panes used to sit
    // (2026-10-09): the devices first, then what is downloaded for them, then the three features.
    id: "voice",
    labelKey: "voice.sectionTitle",
    icon: AudioWaveform,
    group: "app",
    tabs: [
      { id: "devices", labelKey: "voice.devices", hintKey: "voice.devicesHint", icon: Speaker, searchKey: "settings.searchTermsDevices" },
      { id: "models", labelKey: "voice.modelsTab", hintKey: "voice.hint", icon: Download, searchKey: "settings.searchTermsVoice" },
      { id: "dictation", labelKey: "dictation.title", hintKey: "dictation.hint", icon: Mic, searchKey: "settings.searchTermsDictation" },
      { id: "meetings", labelKey: "meetings.settings.title", hintKey: "meetings.settings.hint", icon: AudioLines, searchKey: "meetings.settings.searchTerms" },
      { id: "reading", labelKey: "speech.title", hintKey: "speech.hint", icon: Volume2, searchKey: "settings.searchTermsReading" },
    ],
  },
  {
    id: "backup",
    labelKey: "backup.title",
    icon: DatabaseBackup,
    group: "app",
    tabs: [
      {
        id: "content",
        labelKey: "backup.tabContent",
        hintKey: "backup.tabContentHint",
        icon: ListChecks,
        searchKey: "settings.searchTermsBackupContent",
      },
      { id: "password", labelKey: "backup.tabPassword", hintKey: "backup.tabPasswordHint", icon: KeyRound },
      { id: "backup", labelKey: "backup.tabBackup", icon: Upload },
      { id: "restore", labelKey: "backup.tabRestore", icon: Download, searchKey: "settings.searchTermsRestore" },
      { id: "guides", labelKey: "backup.tabGuides", hintKey: "backup.tabGuidesHint", icon: BookOpen },
    ],
  },

  // ------------------------------------------------------------------ code
  {
    id: "projects",
    labelKey: "settings.projects",
    icon: FolderGit2,
    group: "code",
    // The second pane is what replaced the nav's «Workspace» group: everything the open workspace
    // does differently, together, each row a way to the pane that sets it.
    tabs: [
      { id: "list", labelKey: "settings.tabWorkspaces", icon: Briefcase, searchKey: "settings.searchTermsProjects" },
      { id: "current", labelKey: "settings.tabThisWorkspace", hintKey: "settings.thisWorkspaceHint", icon: Layers, searchKey: "settings.searchTermsThisWorkspace" },
    ],
  },
  {
    id: "editor",
    labelKey: "settings.editorSection",
    icon: FileCode2,
    group: "code",
    // Most used first: how the text looks, whether a save formats it, how each kind of file opens —
    // then the three lists you maintain.
    tabs: [
      // How the text is laid out on screen — size, word wrap and inlay hints. Beside Formatting and
      // not inside it: formatting rewrites the file, this never touches it.
      {
        id: "display",
        labelKey: "editor.display",
        hintKey: "editor.displayHint",
        icon: TextWrap,
        searchKey: "settings.searchTermsEditorDisplay",
      },
      // Formatting: the repository's Prettier, and whether a save formats first.
      {
        id: "format",
        labelKey: "editor.formatting",
        hintKey: "editor.formattingHint",
        icon: AlignLeft,
        searchKey: "settings.searchTermsFormatting",
      },
      // How each kind of file opens: the language a suffix opens as, the explorer's nesting, CSV's
      // colours — the first two only reachable from the editor itself until now.
      {
        id: "files",
        labelKey: "editor.files",
        hintKey: "editor.filesHint",
        icon: Files,
        searchKey: "settings.searchTermsEditorFiles",
      },
      {
        id: "icons",
        labelKey: "icons.title",
        hintKey: "icons.settingsHint",
        icon: Palette,
        searchKey: "settings.searchTermsIcons",
      },
      {
        id: "snippets",
        labelKey: "snippets.title",
        hintKey: "snippets.hint",
        icon: Scissors,
        searchKey: "settings.searchTermsSnippets",
      },
      {
        id: "languageServers",
        labelKey: "settings.lspTitle",
        hintKey: "settings.lspHint",
        icon: Braces,
        searchKey: "settings.searchTermsLsp",
      },
    ],
  },
  {
    id: "terminal",
    labelKey: "settings.terminal",
    icon: TerminalSquare,
    group: "code",
    tabs: [
      { id: "default", labelKey: "settings.terminalDefault", hintKey: "settings.terminalDefaultHint", icon: TerminalSquare },
      { id: "detected", labelKey: "settings.terminalDetected", hintKey: "settings.terminalDetectedHint", icon: ScanSearch },
      { id: "custom", labelKey: "settings.terminalCustom", icon: SquarePen },
    ],
    searchKey: "settings.searchTermsTerminal",
  },
  {
    id: "git",
    labelKey: "settings.git",
    icon: GitBranch,
    group: "code",
    tabs: [
      { id: "identity", labelKey: "settings.tabGitIdentity", hintKey: "settings.gitIdentityHint", icon: UserRound, searchKey: "settings.searchTermsGitIdentity" },
      { id: "fetch", labelKey: "settings.tabAutoFetch", hintKey: "settings.autoFetchDescription", icon: RefreshCw, searchKey: "settings.searchTermsAutoFetch" },
      { id: "secrets", labelKey: "settings.tabSecretScan", hintKey: "settings.secretScanDescription", icon: ShieldAlert, searchKey: "settings.searchTermsSecretScan" },
      { id: "blame", labelKey: "settings.tabBlame", hintKey: "settings.blameDescription", icon: History, searchKey: "settings.searchTermsBlame" },
      { id: "locked", labelKey: "settings.tabLockedBranches", hintKey: "settings.lockedBranchesDescription", icon: Lock, searchKey: "settings.searchTermsLockedBranches" },
    ],
  },
  {
    id: "azure",
    labelKey: "settings.integrationsSection",
    icon: Blocks,
    group: "code",
    // The accounts, by their brand names (`HOSTING_PROVIDERS` — `GitHostingSettings` draws them with
    // their marks), then what the app does with them. Pipelines' one setting came here from a
    // section of its own (2026-10-09): it only means anything once a host is connected above it.
    // The ids are the providers', so `openSettings("azure", provider)` and a search hit agree.
    tabs: [
      { id: "azure", labelKey: "integrations.azure", headingKey: "settings.railAccounts", icon: Cloud, searchKey: "settings.searchTermsIntegrations" },
      { id: "github", labelKey: "integrations.github", icon: GitBranch, searchKey: "settings.searchTermsIntegrations" },
      { id: "gitlab", labelKey: "integrations.gitlab", icon: GitBranch, searchKey: "settings.searchTermsIntegrations" },
      { id: "bitbucket", labelKey: "integrations.bitbucket", icon: FolderGit2, searchKey: "settings.searchTermsIntegrations" },
      { id: "jira", labelKey: "integrations.jira", icon: Blocks, searchKey: "settings.searchTermsIntegrations" },
      { id: "monday", labelKey: "integrations.monday", icon: LayoutGrid, searchKey: "settings.searchTermsIntegrations" },
      // "Availability" is folded in: "why is there no Pipelines tab on this repository" is the
      // question this pane is opened with, and the answer sits under the one knob.
      { id: "pipelines", labelKey: "tabbar.pipelines", headingKey: "settings.railBehaviour", hintKey: "pipelines.pollHint", icon: Route, searchKey: "settings.searchTermsPipelines" },
    ],
  },

  // ------------------------------------------------------------------ AI
  {
    id: "claude",
    labelKey: "settings.aiSection",
    icon: Bot,
    group: "ai",
    // The engines and what they cost. Voice, dictation and meetings went to «Voz y sonido», the
    // thinking mark to Appearance and the tasks to a section of their own (2026-10-09) — thirteen
    // panes was a section nobody could hold in their head.
    tabs: [
      {
        id: "providers",
        labelKey: "settings.providersTitle",
        hintKey: "settings.providersHint",
        headingKey: "settings.railEngines",
        icon: Server,
        searchKey: "settings.searchTermsProviders",
      },
      // Right after the providers: which engines exist, then which logins each one has.
      {
        id: "accounts",
        labelKey: "accounts.title",
        hintKey: "accounts.hint",
        icon: UsersRound,
        searchKey: "settings.searchTermsAccounts",
      },
      // The hybrid task's executor: the model that runs on this machine. Plain icon, like the rest
      // of the rail — a settings row is a place, not a model at work.
      {
        id: "localModel",
        labelKey: "localexec.title",
        hintKey: "localexec.hint",
        icon: Cpu,
        searchKey: "settings.searchTermsLocalModel",
      },
      {
        id: "completion",
        labelKey: "localai.title",
        hintKey: "localai.hint",
        // Plain, like the rest of the rail: a settings row is a place, not a model at work (the
        // user, 2026-10-01 — the AI gradient "no tiene nada que ver" outside one).
        icon: Sparkles,
        searchKey: "settings.searchTermsCompletion",
      },
      // The two that configure nothing; they read back the consequences of the ones above.
      {
        id: "limits",
        labelKey: "quota.title",
        hintKey: "quota.hint",
        headingKey: "settings.railUsage",
        icon: Gauge,
        searchKey: "settings.searchTermsLimits",
      },
      {
        id: "usage",
        labelKey: "usage.statsTitle",
        hintKey: "usage.statsHint",
        icon: ChartColumn,
        searchKey: "settings.searchTermsUsage",
      },
    ],
  },
  {
    // A section of its own since 2026-10-09, one pane per area of the app — it used to be one list
    // of twenty-five rows inside the AI section. The search box in every pane still searches all.
    id: "tasks",
    labelKey: "settings.tasksTitle",
    icon: SlidersHorizontal,
    group: "ai",
    tabs: [
      { id: "git", labelKey: "task.areaGit", icon: GitBranch, searchKey: "settings.searchTermsTasksGit" },
      { id: "review", labelKey: "task.areaReview", icon: ShieldCheck, searchKey: "settings.searchTermsTasksReview" },
      { id: "stories", labelKey: "task.areaStories", icon: BookOpen, searchKey: "settings.searchTermsTasksStories" },
      { id: "docs", labelKey: "task.areaDocs", icon: NotebookPen, searchKey: "settings.searchTermsTasksDocs" },
      { id: "code", labelKey: "task.areaCode", icon: FileCode2, searchKey: "settings.searchTermsTasksCode" },
      { id: "data", labelKey: "task.areaData", icon: Database, searchKey: "settings.searchTermsTasksData" },
      { id: "chat", labelKey: "task.areaChat", icon: MessageSquareText, searchKey: "settings.searchTermsTasksChat" },
      { id: "other", labelKey: "task.areaOther", icon: Workflow, searchKey: "settings.searchTermsTasksOther" },
    ],
    searchKey: "settings.searchTermsTasks",
  },
  {
    id: "review",
    labelKey: "settings.review",
    icon: GitPullRequest,
    group: "ai",
    scope: "workspace",
    // Its two prompts (the standard, the PR description) are edited in «Tareas y prompts» only —
    // they used to be editable from both places.
    tabs: [
      { id: "engine", labelKey: "settings.reviewTabEngine", icon: SlidersHorizontal, searchKey: "settings.searchTermsReviewEngine" },
      { id: "context", labelKey: "settings.reviewTabContext", icon: MessageSquareText },
      { id: "memories", labelKey: "settings.reviewTabMemories", icon: History },
    ],
    searchKey: "settings.searchTermsReview",
  },
  {
    // What a model may use beside reading and writing code. Both used to sit in the nav's
    // «Workspace» group although each row picks its own scope.
    id: "tools",
    labelKey: "settings.toolsTitle",
    icon: Plug,
    group: "ai",
    tabs: [
      { id: "skills", labelKey: "settings.skills", icon: PackagePlus, searchKey: "settings.searchTermsSkills" },
      { id: "mcp", labelKey: "settings.mcp", icon: Plug, searchKey: "settings.searchTermsMcp" },
    ],
  },

  // ------------------------------------------------------------------ the apps
  {
    id: "api",
    labelKey: "api.settings.title",
    icon: Wrench,
    group: "apps",
    tabs: [
      { id: "network", labelKey: "api.settings.network", icon: Network, searchKey: "settings.searchTermsNetwork" },
      { id: "proxy", labelKey: "api.settings.proxy", icon: Waypoints, searchKey: "settings.searchTermsProxy" },
      {
        id: "certificates",
        labelKey: "api.settings.certificates",
        icon: ShieldCheck,
        searchKey: "settings.searchTermsCertificates",
      },
      { id: "general", labelKey: "settings.general", icon: Settings2 },
      { id: "collab", labelKey: "api.collab.title", icon: Share2, searchKey: "settings.searchTermsCollab" },
    ],
  },
  {
    // The drivers every connection uses, which until 2026-10-09 lived only inside the data sources
    // dialog — a global setting reachable from one modal.
    id: "databases",
    labelKey: "settings.databasesTitle",
    icon: Database,
    group: "apps",
    tabs: [{ id: "drivers", labelKey: "settings.driversTitle", hintKey: "settings.driversHint", icon: Database, searchKey: "settings.searchTermsDrivers" }],
  },
  {
    id: "vault",
    labelKey: "tabbar.vault",
    icon: KeyRound,
    group: "apps",
    // Two panes because they are two different errands, not because the pane was long: one is
    // configuration you set and forget, the other is a report you come back to read.
    tabs: [
      { id: "settings", labelKey: "vault.settings", icon: Settings2 },
      {
        id: "health",
        labelKey: "vault.healthTitle",
        hintKey: "vault.healthHint",
        icon: ShieldCheck,
        searchKey: "settings.searchTermsVaultHealth",
      },
    ],
    searchKey: "settings.searchTermsVault",
  },
  {
    // The Revisor tab's own settings — named with SonarQube in the nav because «Revisor» beside
    // «Revisión de PR» read as the same thing twice.
    id: "reviewer",
    labelKey: "settings.reviewerSection",
    icon: ShieldCheck,
    group: "apps",
    tabs: [
      { id: "general", labelKey: "reviewer.paneGeneral", hintKey: "reviewer.paneGeneralHint", icon: Power, searchKey: "settings.searchTermsReviewerGeneral" },
      { id: "sonarqube", labelKey: "reviewer.paneSonar", hintKey: "reviewer.paneSonarHint", icon: Server, searchKey: "settings.searchTermsReviewerSonar" },
      { id: "rules", labelKey: "reviewer.paneRules", hintKey: "reviewer.paneRulesHint", icon: ListChecks, searchKey: "settings.searchTermsReviewerRules" },
      { id: "servers", labelKey: "reviewer.paneServers", hintKey: "reviewer.paneServersHint", icon: Cloud, searchKey: "settings.searchTermsReviewerServers" },
    ],
  },
  {
    id: "remote",
    labelKey: "remote.title",
    icon: Smartphone,
    group: "apps",
    // The groups the one long panel was built from, each now its own pane — in the order they are
    // needed: switch the server on, pair a phone, then look after what is paired and what it may do.
    tabs: [
      { id: "server", labelKey: "remote.groupServer", icon: Server },
      { id: "pairing", labelKey: "remote.groupPairing", icon: QrCode },
      { id: "devices", labelKey: "remote.devices", icon: Smartphone },
      { id: "terminal", labelKey: "remote.groupTerminal", icon: TerminalSquare },
      { id: "access", labelKey: "remote.groupAccess", icon: ShieldCheck },
    ],
    searchKey: "settings.searchTermsRemote",
  },
];

/** The nav's four groups, in order — what a section's `group` names. */
export const SETTINGS_GROUPS: { id: SettingsSectionDef["group"]; labelKey: TranslationKey }[] = [
  { id: "app", labelKey: "settings.groupApp" },
  { id: "code", labelKey: "settings.groupCode" },
  { id: "ai", labelKey: "settings.groupAi" },
  { id: "apps", labelKey: "settings.groupApps" },
];

/**
 * Sections that carry a **vertical** sub-rail and scroll the pane beside it rather than the whole
 * column, so their heading and rail stay put while you read down a long list.
 *
 * It lives here rather than in `SettingsView` because it is a fact about a section, and this file is
 * where the other three live. That move is not tidiness: the set is the second half of building a
 * rail, and when it was somewhere else the first half could be written without it — which is exactly
 * what happened. A pane with a rail and no entry here gets no definite height to divide, so its own
 * `overflow-y` never engages and the rail scrolls away with the content it was meant to stay above.
 * The test beside this file makes that omission impossible to ship.
 */
export const SELF_SCROLLING_SECTIONS = new Set<SettingsSectionId>([
  "general",
  "appearance",
  "keybindings",
  "notifications",
  "voice",
  "backup",
  "projects",
  "editor",
  "terminal",
  "git",
  "azure",
  "claude",
  "tasks",
  "review",
  "tools",
  "api",
  "databases",
  "vault",
  "reviewer",
  "remote",
]);

/**
 * Sections with panes but deliberately *no* vertical rail — a horizontal strip with an underline
 * instead (see the note in `ActivePill` on why those are two indicators and not one).
 *
 * Empty since PR review moved onto a rail like every other section (2026-10-09). Kept, so a section
 * that grows panes still has to make this choice on purpose instead of falling into one.
 */
export const HORIZONTAL_TAB_SECTIONS = new Set<SettingsSectionId>([]);

/** The tabs of one section, or an empty array for a section that has none. */
export function tabsFor(id: SettingsSectionId): SettingsTabDef[] {
  return SETTINGS_SECTIONS.find((section) => section.id === id)?.tabs ?? [];
}

export function sectionFor(id: SettingsSectionId): SettingsSectionDef | undefined {
  return SETTINGS_SECTIONS.find((section) => section.id === id);
}

/** One place the search can send you: a section, and optionally a pane inside it. */
export interface SettingsHit {
  section: SettingsSectionDef;
  tab?: SettingsTabDef;
  /** The section's name, always — a result reading only "Proxy" doesn't say where it lives. */
  breadcrumb: string;
  label: string;
}

/**
 * Folds away accents and case so "revision" finds "Revisión".
 *
 * The app is bilingual and half its section names carry a diacritic; requiring the user to type
 * one is requiring them to know which word they are looking for before they look for it.
 */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Every pane whose name — or whose synonyms — match the query.
 *
 * Ranking is deliberately crude and deliberately stable: a name that *starts* with the query beats
 * one that merely contains it, which beats one matched only through its synonym list. Anything
 * cleverer (fuzzy subsequences, typo distance) reorders results as you type, and a list that
 * reorders under the cursor is one you cannot arrow through.
 */
export function searchSettings(
  query: string,
  t: (key: TranslationKey) => string,
  options: { includeWorkspace?: boolean } = {},
): SettingsHit[] {
  const wanted = fold(query);
  if (!wanted) return [];
  const { includeWorkspace = true } = options;

  const scored: { hit: SettingsHit; rank: number }[] = [];

  const consider = (section: SettingsSectionDef, tab?: SettingsTabDef) => {
    const label = t(tab?.labelKey ?? section.labelKey);
    const sectionLabel = t(section.labelKey);
    const folded = fold(label);
    // The section's own name counts towards its panes: typing "backup" should surface its five
    // tabs, not just the section row that leads to them.
    const foldedSection = fold(sectionLabel);
    const synonyms = fold([tab?.searchKey, section.searchKey].filter(Boolean).map((k) => t(k!)).join(","));

    let rank: number;
    if (folded.startsWith(wanted)) rank = 0;
    else if (folded.includes(wanted)) rank = 1;
    else if (tab && foldedSection.includes(wanted)) rank = 2;
    else if (synonyms.includes(wanted)) rank = 3;
    else return;

    scored.push({
      hit: { section, tab, breadcrumb: sectionLabel, label },
      rank,
    });
  };

  for (const section of SETTINGS_SECTIONS) {
    if (section.scope === "workspace" && !includeWorkspace) continue;
    consider(section);
    for (const tab of section.tabs ?? []) consider(section, tab);
  }

  scored.sort((a, b) => a.rank - b.rank);
  return scored.map((entry) => entry.hit);
}
