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
  AppWindow,
  Bell,
  Blocks,
  BookOpen,
  Bot,
  Braces,
  Briefcase,
  ChartColumn,
  Compass,
  Database,
  DatabaseBackup,
  Download,
  FileCode2,
  FolderGit2,
  Gauge,
  GitBranch,
  Globe,
  GraduationCap,
  HardDrive,
  History,
  Keyboard,
  KeyRound,
  Languages,
  LayoutGrid,
  ListChecks,
  Lock,
  MessageSquareText,
  Network,
  PackagePlus,
  Palette,
  PanelsTopLeft,
  QrCode,
  Rainbow,
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
  Smartphone,
  Sparkles,
  SquarePen,
  SunMoon,
  TerminalSquare,
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
  /** The one-line explanation shown above the pane. Optional only because three panes are
   *  self-evident enough that a line under their own name would repeat it. */
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
}

export interface SettingsSectionDef {
  id: SettingsSectionId;
  labelKey: TranslationKey;
  icon: LucideIcon;
  /** Global settings apply to the installation; workspace ones to whichever workspace is open. */
  group: "global" | "workspace";
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
  {
    id: "general",
    labelKey: "settings.general",
    icon: Globe,
    group: "global",
    // The grouping the user chose: the language beside the version (updates, the site, Ko-fi — all in
    // `UpdateSection`), the window limit on its own, the tours on their own, and the app's own files.
    tabs: [
      { id: "language", labelKey: "settings.tabLanguageUpdates", icon: Languages, searchKey: "settings.searchTermsLanguageUpdates" },
      { id: "windows", labelKey: "windows.limitLabel", hintKey: "windows.limitHint", icon: AppWindow, searchKey: "settings.searchTermsWindows" },
      { id: "tours", labelKey: "tour.settingsTitle", hintKey: "tour.settingsHint", icon: GraduationCap, searchKey: "settings.searchTermsTours" },
      { id: "data", labelKey: "settings.tabAppData", icon: HardDrive, searchKey: "settings.searchTermsAppData" },
    ],
  },
  {
    id: "appearance",
    labelKey: "settings.appearance",
    icon: Palette,
    group: "global",
    // The two small choices about the whole app's look share a pane; the schemes, a grid per mode,
    // are a visit of their own.
    tabs: [
      { id: "look", labelKey: "settings.tabModeColor", icon: SunMoon, searchKey: "settings.searchTermsModeColor" },
      { id: "themes", labelKey: "settings.editorThemes", hintKey: "settings.codeThemeHint", icon: Palette, searchKey: "settings.searchTermsThemes" },
    ],
  },
  {
    id: "keybindings",
    labelKey: "shortcuts.title",
    icon: Keyboard,
    group: "global",
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
    id: "editor",
    labelKey: "settings.editorSection",
    icon: FileCode2,
    group: "global",
    tabs: [
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
      {
        id: "icons",
        labelKey: "icons.title",
        hintKey: "icons.settingsHint",
        icon: Palette,
        searchKey: "settings.searchTermsIcons",
      },
      {
        id: "csv",
        labelKey: "csv.title",
        hintKey: "csv.settingsHint",
        icon: Rainbow,
        searchKey: "settings.searchTermsCsv",
      },
    ],
  },
  {
    id: "projects",
    labelKey: "settings.projects",
    icon: FolderGit2,
    group: "global",
    searchKey: "settings.searchTermsProjects",
  },
  {
    id: "git",
    labelKey: "settings.git",
    icon: GitBranch,
    group: "global",
    tabs: [
      { id: "identity", labelKey: "settings.tabGitIdentity", hintKey: "settings.gitIdentityHint", icon: UserRound, searchKey: "settings.searchTermsGitIdentity" },
      { id: "fetch", labelKey: "settings.tabAutoFetch", hintKey: "settings.autoFetchDescription", icon: RefreshCw, searchKey: "settings.searchTermsAutoFetch" },
      { id: "secrets", labelKey: "settings.tabSecretScan", hintKey: "settings.secretScanDescription", icon: ShieldAlert, searchKey: "settings.searchTermsSecretScan" },
      { id: "blame", labelKey: "settings.tabBlame", hintKey: "settings.blameDescription", icon: History, searchKey: "settings.searchTermsBlame" },
      { id: "locked", labelKey: "settings.tabLockedBranches", hintKey: "settings.lockedBranchesDescription", icon: Lock, searchKey: "settings.searchTermsLockedBranches" },
    ],
  },
  {
    id: "terminal",
    labelKey: "settings.terminal",
    icon: TerminalSquare,
    group: "global",
    tabs: [
      { id: "default", labelKey: "settings.terminalDefault", hintKey: "settings.terminalDefaultHint", icon: TerminalSquare },
      { id: "detected", labelKey: "settings.terminalDetected", hintKey: "settings.terminalDetectedHint", icon: ScanSearch },
      { id: "custom", labelKey: "settings.terminalCustom", icon: SquarePen },
    ],
    searchKey: "settings.searchTermsTerminal",
  },
  {
    id: "azure",
    labelKey: "settings.integrationsSection",
    icon: Blocks,
    group: "global",
    // The provider rail is built from `HOSTING_PROVIDERS`, whose labels are brand names and so are
    // never translated. They are listed here anyway so the search can reach them — deep-linking
    // already works through `openSettings`'s second argument.
    searchKey: "settings.searchTermsIntegrations",
  },
  {
    id: "claude",
    labelKey: "settings.aiSection",
    icon: Bot,
    group: "global",
    tabs: [
      {
        id: "providers",
        labelKey: "settings.providersTitle",
        hintKey: "settings.providersHint",
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
      // One pane, not the two it used to be. See `AiTasksSettings` for the argument: routing and
      // the prompt are two halves of the same row.
      {
        id: "tasks",
        labelKey: "settings.tasksTitle",
        hintKey: "settings.tasksHint",
        icon: SlidersHorizontal,
        searchKey: "settings.searchTermsTasks",
      },
      {
        id: "completion",
        labelKey: "localai.title",
        hintKey: "localai.hint",
        icon: Sparkles,
        searchKey: "settings.searchTermsCompletion",
      },
      {
        id: "limits",
        labelKey: "quota.title",
        hintKey: "quota.hint",
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
    id: "api",
    labelKey: "api.settings.title",
    icon: Wrench,
    group: "global",
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
    id: "remote",
    labelKey: "remote.title",
    icon: Smartphone,
    group: "global",
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
  {
    id: "vault",
    labelKey: "tabbar.vault",
    icon: KeyRound,
    group: "global",
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
    id: "pipelines",
    labelKey: "tabbar.pipelines",
    icon: Route,
    group: "global",
    // "Availability" is not padding to fill a rail. "Why is there no Pipelines tab on this
    // repository" is the question this section is actually opened with, and the answer was a
    // footnote under the one knob — which is the last place somebody looks for it.
    tabs: [
      {
        id: "polling",
        labelKey: "pipelines.pollLabel",
        hintKey: "pipelines.pollHint",
        icon: RefreshCw,
        searchKey: "settings.searchTermsPipelines",
      },
      { id: "availability", labelKey: "pipelines.availabilityTab", icon: Route },
    ],
    searchKey: "settings.searchTermsPipelines",
  },
  {
    id: "notifications",
    labelKey: "notifications.settingsTitle",
    // The bell, the same glyph as the status bar's notification centre these settings are about.
    icon: Bell,
    group: "global",
    // The two questions in the order they get asked: how loudly, and about what.
    tabs: [
      { id: "delivery", labelKey: "notifications.deliveryTitle", icon: Volume2 },
      {
        id: "sources",
        labelKey: "notifications.sourcesTitle",
        hintKey: "notifications.sourcesHint",
        icon: Bell,
      },
    ],
    searchKey: "settings.searchTermsNotifications",
  },
  {
    id: "backup",
    labelKey: "backup.title",
    icon: DatabaseBackup,
    group: "global",
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
  {
    id: "review",
    labelKey: "settings.review",
    icon: ShieldCheck,
    group: "workspace",
    tabs: [
      { id: "standard", labelKey: "settings.reviewTabStandard", icon: ShieldCheck },
      { id: "engine", labelKey: "settings.reviewTabEngine", icon: SlidersHorizontal },
      { id: "context", labelKey: "settings.reviewTabContext", icon: MessageSquareText },
      { id: "prDesc", labelKey: "settings.reviewTabPrDesc", icon: SquarePen },
      { id: "memories", labelKey: "settings.reviewTabMemories", icon: ShieldCheck },
    ],
    searchKey: "settings.searchTermsReview",
  },
  {
    id: "skills",
    labelKey: "settings.skills",
    icon: PackagePlus,
    group: "workspace",
    searchKey: "settings.searchTermsSkills",
  },
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
  "git",
  "terminal",
  "remote",
  "claude",
  "backup",
  "api",
  "editor",
  "vault",
  "pipelines",
  "notifications",
]);

/**
 * Sections with panes but deliberately *no* vertical rail.
 *
 * `ReviewSettings` uses the horizontal strip with an underline instead of the rail with a pill (see
 * the note in `ActivePill` on why those are two indicators and not one). There is no rail to pin, so
 * the whole column scrolling is the correct behaviour rather than an oversight.
 *
 * Listed rather than merely absent, so a section that grows panes has to make this choice on
 * purpose instead of falling into one.
 */
export const HORIZONTAL_TAB_SECTIONS = new Set<SettingsSectionId>(["review"]);

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
    if (section.group === "workspace" && !includeWorkspace) continue;
    consider(section);
    for (const tab of section.tabs ?? []) consider(section, tab);
  }

  scored.sort((a, b) => a.rank - b.rank);
  return scored.map((entry) => entry.hit);
}
