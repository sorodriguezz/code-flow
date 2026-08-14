import {
  Bot,
  ClipboardList,
  Database,
  MonitorSmartphone,
  NotebookPen,
  Send,
  type LucideIcon,
} from "lucide-react";
import type { TranslationKey } from "../i18n/translations";
import type { Chord } from "../keys";
import type { ApiWorkspace, MainView } from "../../state/uiStore";
import type { TourStage } from "./stage";

/** Where the card goes relative to whatever the step is pointing at. */
export type TourPlacement =
  /** Beside the anchor, on whichever side has room. The default, and right for anything small. */
  | "auto"
  /** In the middle of the window, with no spotlight. For the steps that aren't about a control. */
  | "center"
  /** *Inside* the anchor, near its bottom edge. For anchors big enough to be the point themselves —
   * a whole view, the settings dialog — where dimming everything but the anchor is the highlight
   * and the card just needs somewhere out of the way to sit. */
  | "inside";

export interface TourStep {
  id: string;
  /** Which chapter the progress chip names. Steps are grouped so a tour reads as a few parts. */
  chapterKey: TranslationKey;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  /**
   * CSS selectors for the thing to spotlight, **in order of preference** — the first one on screen
   * wins.
   *
   * A list rather than one selector because several of these controls only exist under conditions
   * the tour can't manufacture: the request builder appears once a request is open, the roster rail
   * once the workspace has an agent, and a user taking a tour on an empty workspace has nothing for
   * them to point at. The fallback is the view that holds them, which always exists, so the step
   * still lands somewhere real instead of degrading to a floating card.
   */
  anchors?: string[];
  placement?: TourPlacement;
  /**
   * A key combination the body names, substituted into it as `{key}`.
   *
   * Never spelled out in the copy, because the copy is one string and the two platforms write the
   * same chord differently — a sentence that says "⌘I, or Ctrl+I on Windows" makes every reader
   * work out which half is theirs, and half of it is always wrong for them. `chordLabel` renders
   * the local notation and nothing else.
   */
  chord?: Chord;
  /** Extra breathing room around the anchor, in px. Defaults to 8. */
  padding?: number;
  /** Corner radius of the spotlight. Defaults to 10. */
  radius?: number;
  stage?: TourStage;
}

/**
 * Which tour is being walked.
 *
 * **There is one tour for the main window and one per workspace app, rather than a single tour over
 * everything.** The single one covered all of it and was, by the only measure that counts, too
 * long: people skipped it, and skipping is all-or-nothing — the reader who bailed at step 20 also
 * lost the four settings steps they had not reached yet. Splitting it puts the length in the
 * reader's hands. The main tour is what the app opens with and is scoped to the window it opens on;
 * everything inside an app is behind that app's own launcher, taken when and if that app is the one
 * you are about to use.
 */
export type TourId = "main" | "api" | "db" | "agents" | "stories" | "remote" | "notes";

/**
 * The one-screen tour of the main window.
 *
 * The order goes **outside in**: what a workspace is, then the repositories in it, then the three
 * views onto one repository, then the panels around the work, then the workspace apps as a set, and
 * only at the end the settings — because settings is where you go once you know what you are
 * configuring, and a tour that opens with a preferences dialog has taught nothing yet.
 *
 * What is deliberately *not* here: anything that lives inside one of the six workspace apps. Those
 * are one step each at most, naming the app and saying it has a tour of its own.
 */
const MAIN_TOUR: TourStep[] = [
  {
    id: "welcome",
    chapterKey: "tour.chapter.start",
    titleKey: "tour.welcome.title",
    bodyKey: "tour.welcome.body",
    placement: "center",
  },
  {
    id: "workspaces",
    chapterKey: "tour.chapter.start",
    titleKey: "tour.workspaces.title",
    bodyKey: "tour.workspaces.body",
    anchors: ['[data-tour="workspace-switcher"]'],
  },
  {
    id: "addRepo",
    chapterKey: "tour.chapter.repos",
    titleKey: "tour.addRepo.title",
    bodyKey: "tour.addRepo.body",
    anchors: ['[data-tour="projects-actions"]'],
    padding: 6,
  },
  {
    id: "projects",
    chapterKey: "tour.chapter.repos",
    titleKey: "tour.projects.title",
    bodyKey: "tour.projects.body",
    anchors: ['[data-tour="projects-panel"]'],
  },
  // One card for the three tabs rather than one card each: the tabs are a set, and what a reader
  // needs at this point is which of the three to click, not a tour of any of them.
  {
    id: "repoTabs",
    chapterKey: "tour.chapter.workspace",
    titleKey: "tour.repoTabs.title",
    bodyKey: "tour.repoTabs.body",
    anchors: ['[data-tour="repo-tabs"]'],
  },
  // The editor is the one of the three that is a workbench rather than a screen, so it keeps a card
  // of its own — folded down from four to one, since the two things nobody finds unaided (the
  // rail's panels and the inline AI edit, which has no button at all) fit in a paragraph.
  {
    id: "editor",
    chapterKey: "tour.chapter.workspace",
    titleKey: "tour.editor.title",
    bodyKey: "tour.editor.body",
    chord: "Mod+I",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: { view: "editor" },
  },
  // The panel is opened behind the spotlight, but the spotlight stays on the button that opens it:
  // "what is in here" is answered by the card, and "how do I get it back" only by pointing.
  {
    id: "aiPanel",
    chapterKey: "tour.chapter.ai",
    titleKey: "tour.aiPanel.title",
    bodyKey: "tour.aiPanel.body",
    anchors: ['[data-tour="toggle-ai-panel"]', '[data-tour="ai-panel"]'],
    padding: 6,
    stage: { ai: true },
  },
  {
    id: "prReview",
    chapterKey: "tour.chapter.ai",
    titleKey: "tour.prReview.title",
    bodyKey: "tour.prReview.body",
    anchors: ['[data-tour="pr-link"]'],
    padding: 6,
  },
  {
    id: "terminal",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.terminal.title",
    bodyKey: "tour.terminal.body",
    anchors: ['[data-tour="toggle-terminal"]', '[data-tour="terminal-dock"]'],
    padding: 6,
    stage: { terminal: true },
  },
  // Also the handover, which is why it is staged on an app rather than left on the graph: the
  // spotlight takes in the menu *and* the graduation cap beside it, and the cap only exists while
  // one of the five is open. Two adjacent controls under one ring, because they are one sentence —
  // here are the apps, and here is how each one explains itself.
  {
    id: "workspaceApps",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.workspaceApps.title",
    bodyKey: "tour.workspaceApps.body",
    anchors: ['[data-tour="workspace-tools"]', '[data-tour="workspace-menu"]'],
    padding: 6,
    stage: { view: "api", apiWorkspace: "requests" },
  },
  {
    id: "settingsAi",
    chapterKey: "tour.chapter.settings",
    titleKey: "tour.settingsAi.title",
    bodyKey: "tour.settingsAi.body",
    anchors: ['[data-tour="settings-panel"]'],
    placement: "inside",
    radius: 16,
    stage: { settings: "claude" },
  },
  {
    id: "settingsIntegrations",
    chapterKey: "tour.chapter.settings",
    titleKey: "tour.settingsIntegrations.title",
    bodyKey: "tour.settingsIntegrations.body",
    anchors: ['[data-tour="settings-panel"]'],
    placement: "inside",
    radius: 16,
    stage: { settings: "azure" },
  },
  {
    id: "settingsProjects",
    chapterKey: "tour.chapter.settings",
    titleKey: "tour.settingsProjects.title",
    bodyKey: "tour.settingsProjects.body",
    anchors: ['[data-tour="settings-panel"]'],
    placement: "inside",
    radius: 16,
    stage: { settings: "projects" },
  },
  {
    id: "backup",
    chapterKey: "tour.chapter.settings",
    titleKey: "tour.backup.title",
    bodyKey: "tour.backup.body",
    anchors: ['[data-tour="settings-panel"]'],
    placement: "inside",
    radius: 16,
    stage: { settings: "backup" },
  },
  // Ends on the button that reopens it, rather than on a card in the middle of nothing. The last
  // thing a tour should leave behind is where to find it again — said while pointing at it, which
  // is the one place the sentence is impossible to misread.
  {
    id: "finish",
    chapterKey: "tour.chapter.done",
    titleKey: "tour.finish.title",
    bodyKey: "tour.finish.body",
    anchors: ['[data-tour="tour-launcher"]'],
    padding: 6,
  },
];

/**
 * Every app tour ends the same way: on its own launcher, having just said where the app is
 * configured.
 *
 * Both halves are the point. A reader who has just been walked through the API client is one click
 * from wanting it again, and the button that does that is a graduation cap they have seen exactly
 * once. And "where is this configured" is the question an app tour exists to answer — the settings
 * for four of the five are two levels into a dialog that is not on screen while you use them.
 */
function closingStep(
  id: TourId,
  chapterKey: TranslationKey,
  // Spelled out rather than built from `id`: a template literal would need a cast to
  // `TranslationKey`, and the cast is precisely what would stop the compiler noticing a body key
  // that was never added to the dictionary.
  titleKey: TranslationKey,
  bodyKey: TranslationKey,
  stage: TourStage,
): TourStep {
  return {
    id: `${id}.done`,
    chapterKey,
    titleKey,
    bodyKey,
    // The same launcher the main tour finishes on — there is one now, at the foot of the app rail,
    // and it is always rendered. The `workspace-menu` fallback that used to sit behind this went
    // with the condition that could hide the button.
    anchors: ['[data-tour="tour-launcher"]'],
    padding: 6,
    stage,
  };
}

/** The API client's own stage: this app, on the requests side of the tab it shares with databases. */
const API_STAGE: TourStage = { view: "api", apiWorkspace: "requests" };

const API_TOUR: TourStep[] = [
  {
    id: "api.intro",
    chapterKey: "tour.chapter.api",
    titleKey: "tour.api.intro.title",
    bodyKey: "tour.api.intro.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: API_STAGE,
  },
  {
    id: "api.sidebar",
    chapterKey: "tour.chapter.api",
    titleKey: "tour.api.sidebar.title",
    bodyKey: "tour.api.sidebar.body",
    anchors: ['[data-tour="api-sidebar"]', '[data-tour="main-content"]'],
    stage: API_STAGE,
  },
  {
    id: "api.actions",
    chapterKey: "tour.chapter.api",
    titleKey: "tour.api.actions.title",
    bodyKey: "tour.api.actions.body",
    anchors: ['[data-tour="api-sidebar-actions"]', '[data-tour="api-sidebar"]'],
    padding: 6,
    stage: API_STAGE,
  },
  {
    id: "api.builder",
    chapterKey: "tour.chapter.api",
    titleKey: "tour.api.builder.title",
    bodyKey: "tour.api.builder.body",
    // Only exists once a request is open; the view is the fallback for an empty workspace.
    anchors: ['[data-tour="api-builder"]', '[data-tour="main-content"]'],
    placement: "inside",
    stage: API_STAGE,
  },
  {
    id: "api.protocols",
    chapterKey: "tour.chapter.api",
    titleKey: "tour.api.protocols.title",
    bodyKey: "tour.api.protocols.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: API_STAGE,
  },
  {
    id: "api.response",
    chapterKey: "tour.chapter.api",
    titleKey: "tour.api.response.title",
    bodyKey: "tour.api.response.body",
    anchors: ['[data-tour="api-response"]', '[data-tour="main-content"]'],
    placement: "inside",
    stage: API_STAGE,
  },
  {
    id: "api.env",
    chapterKey: "tour.chapter.api",
    titleKey: "tour.api.env.title",
    bodyKey: "tour.api.env.body",
    anchors: ['[data-tour="api-env"]', '[data-tour="api-sidebar"]'],
    stage: API_STAGE,
  },
  {
    id: "api.snippet",
    chapterKey: "tour.chapter.api",
    titleKey: "tour.api.snippet.title",
    bodyKey: "tour.api.snippet.body",
    anchors: ['[data-tour="api-snippet"]', '[data-tour="main-content"]'],
    stage: API_STAGE,
  },
  {
    id: "api.settings",
    chapterKey: "tour.chapter.settings",
    titleKey: "tour.api.settings.title",
    bodyKey: "tour.api.settings.body",
    anchors: ['[data-tour="settings-panel"]'],
    placement: "inside",
    radius: 16,
    stage: { ...API_STAGE, settings: "api", apiSettingsTab: "network" },
  },
  {
    id: "api.collab",
    chapterKey: "tour.chapter.settings",
    titleKey: "tour.api.collab.title",
    bodyKey: "tour.api.collab.body",
    anchors: ['[data-tour="settings-panel"]'],
    placement: "inside",
    radius: 16,
    stage: { ...API_STAGE, settings: "api", apiSettingsTab: "collab" },
  },
  closingStep("api", "tour.chapter.api", "tour.api.done.title", "tour.api.done.body", API_STAGE),
];

/** The database client's stage: the other side of the same tab. */
const DB_STAGE: TourStage = { view: "api", apiWorkspace: "database" };

const DB_TOUR: TourStep[] = [
  {
    id: "db.intro",
    chapterKey: "tour.chapter.db",
    titleKey: "tour.db.intro.title",
    bodyKey: "tour.db.intro.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: DB_STAGE,
  },
  {
    id: "db.connect",
    chapterKey: "tour.chapter.db",
    titleKey: "tour.db.connect.title",
    bodyKey: "tour.db.connect.body",
    anchors: ['[data-tour="db-explorer-actions"]', '[data-tour="db-explorer"]'],
    padding: 6,
    stage: DB_STAGE,
  },
  // The dialog itself, not just the button that opens it. Everything a connection *is* — engine,
  // host, credentials, the SSH tunnel, the read-only guard — exists only in here, and it is the one
  // screen of that app a reader cannot stumble into from the tree.
  {
    id: "db.sources",
    chapterKey: "tour.chapter.db",
    titleKey: "tour.db.sources.title",
    bodyKey: "tour.db.sources.body",
    anchors: ['[data-tour="db-data-sources"]', '[data-tour="main-content"]'],
    placement: "inside",
    radius: 12,
    stage: { ...DB_STAGE, dbDataSources: true },
  },
  {
    id: "db.explorer",
    chapterKey: "tour.chapter.db",
    titleKey: "tour.db.explorer.title",
    bodyKey: "tour.db.explorer.body",
    anchors: ['[data-tour="db-explorer"]', '[data-tour="main-content"]'],
    stage: DB_STAGE,
  },
  {
    id: "db.console",
    chapterKey: "tour.chapter.db",
    titleKey: "tour.db.console.title",
    bodyKey: "tour.db.console.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: DB_STAGE,
  },
  // Straight after the console, because it is a control *in* the console and the step before it
  // has just said what a console is for. Anchored on the button rather than on the panel it opens:
  // the panel only exists once it is asked for, and a tour cannot type the question.
  {
    id: "db.ai",
    chapterKey: "tour.chapter.db",
    titleKey: "tour.db.ai.title",
    bodyKey: "tour.db.ai.body",
    anchors: ['[data-tour="db-ai"]', '[data-tour="main-content"]'],
    chord: "Mod+Alt+I",
    padding: 6,
    stage: DB_STAGE,
  },
  {
    id: "db.grid",
    chapterKey: "tour.chapter.db",
    titleKey: "tour.db.grid.title",
    bodyKey: "tour.db.grid.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: DB_STAGE,
  },
  {
    id: "db.tools",
    chapterKey: "tour.chapter.db",
    titleKey: "tour.db.tools.title",
    bodyKey: "tour.db.tools.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: DB_STAGE,
  },
  closingStep("db", "tour.chapter.db", "tour.db.done.title", "tour.db.done.body", DB_STAGE),
];

const AGENTS_STAGE: TourStage = { view: "agents" };

const AGENTS_TOUR: TourStep[] = [
  {
    id: "agents.intro",
    chapterKey: "tour.chapter.agents",
    titleKey: "tour.agents.intro.title",
    bodyKey: "tour.agents.intro.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: AGENTS_STAGE,
  },
  {
    id: "agents.tree",
    chapterKey: "tour.chapter.agents",
    titleKey: "tour.agents.tree.title",
    bodyKey: "tour.agents.tree.body",
    anchors: ['[data-tour="agents-tree"]', '[data-tour="main-content"]'],
    stage: AGENTS_STAGE,
  },
  {
    id: "agents.actions",
    chapterKey: "tour.chapter.agents",
    titleKey: "tour.agents.actions.title",
    bodyKey: "tour.agents.actions.body",
    anchors: ['[data-tour="agents-tree-actions"]', '[data-tour="agents-tree"]'],
    padding: 6,
    stage: AGENTS_STAGE,
  },
  {
    id: "agents.task",
    chapterKey: "tour.chapter.agents",
    titleKey: "tour.agents.task.title",
    bodyKey: "tour.agents.task.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: AGENTS_STAGE,
  },
  {
    id: "agents.chains",
    chapterKey: "tour.chapter.agents",
    titleKey: "tour.agents.chains.title",
    bodyKey: "tour.agents.chains.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: AGENTS_STAGE,
  },
  // Like the roster below it: a panel the app keeps closed, holding something nothing on the
  // default screen mentions. Worth its own step because the bench is easy to mistake for the
  // repository's terminal dock, and the difference — whose it is, and where it opens — is the
  // entire reason it exists separately.
  {
    id: "agents.bench",
    chapterKey: "tour.chapter.agents",
    titleKey: "tour.agents.bench.title",
    bodyKey: "tour.agents.bench.body",
    anchors: ['[data-tour="agents-bench"]', '[data-tour="main-content"]'],
    stage: { ...AGENTS_STAGE, agentsBench: true },
  },
  // The one step that needs a panel the app keeps closed by default, which is exactly why it is
  // worth a step: the roster is where an agent *is defined*, and nothing on the default screen
  // says so.
  {
    id: "agents.roster",
    chapterKey: "tour.chapter.agents",
    titleKey: "tour.agents.roster.title",
    bodyKey: "tour.agents.roster.body",
    anchors: ['[data-tour="agents-roster"]', '[data-tour="main-content"]'],
    stage: { ...AGENTS_STAGE, agentsRoster: true },
  },
  {
    id: "agents.settings",
    chapterKey: "tour.chapter.settings",
    titleKey: "tour.agents.settings.title",
    bodyKey: "tour.agents.settings.body",
    anchors: ['[data-tour="settings-panel"]'],
    placement: "inside",
    radius: 16,
    stage: { ...AGENTS_STAGE, settings: "claude" },
  },
  closingStep(
    "agents",
    "tour.chapter.agents",
    "tour.agents.done.title",
    "tour.agents.done.body",
    AGENTS_STAGE,
  ),
];

const STORIES_STAGE: TourStage = { view: "stories", storiesMode: "batches" };

const STORIES_TOUR: TourStep[] = [
  {
    id: "stories.intro",
    chapterKey: "tour.chapter.stories",
    titleKey: "tour.stories.intro.title",
    bodyKey: "tour.stories.intro.body",
    anchors: ['[data-tour="stories-modes"]', '[data-tour="main-content"]'],
    stage: STORIES_STAGE,
  },
  {
    id: "stories.write",
    chapterKey: "tour.chapter.stories",
    titleKey: "tour.stories.write.title",
    bodyKey: "tour.stories.write.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: STORIES_STAGE,
  },
  {
    id: "stories.list",
    chapterKey: "tour.chapter.stories",
    titleKey: "tour.stories.list.title",
    bodyKey: "tour.stories.list.body",
    anchors: ['[data-tour="stories-list"]', '[data-tour="main-content"]'],
    stage: STORIES_STAGE,
  },
  {
    id: "stories.publish",
    chapterKey: "tour.chapter.stories",
    titleKey: "tour.stories.publish.title",
    bodyKey: "tour.stories.publish.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: STORIES_STAGE,
  },
  {
    id: "stories.review",
    chapterKey: "tour.chapter.stories",
    titleKey: "tour.stories.review.title",
    bodyKey: "tour.stories.review.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: { view: "stories", storiesMode: "review" },
  },
  {
    id: "stories.wiki",
    chapterKey: "tour.chapter.stories",
    titleKey: "tour.stories.wiki.title",
    bodyKey: "tour.stories.wiki.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: { view: "stories", storiesMode: "wiki" },
  },
  {
    id: "stories.settings",
    chapterKey: "tour.chapter.settings",
    titleKey: "tour.stories.settings.title",
    bodyKey: "tour.stories.settings.body",
    anchors: ['[data-tour="settings-panel"]'],
    placement: "inside",
    radius: 16,
    stage: { ...STORIES_STAGE, settings: "azure" },
  },
  closingStep(
    "stories",
    "tour.chapter.stories",
    "tour.stories.done.title",
    "tour.stories.done.body",
    STORIES_STAGE,
  ),
];

const REMOTE_STAGE: TourStage = { view: "remote" };

const REMOTE_TOUR: TourStep[] = [
  {
    id: "remote.intro",
    chapterKey: "tour.chapter.remote",
    titleKey: "tour.remote.intro.title",
    bodyKey: "tour.remote.intro.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: REMOTE_STAGE,
  },
  {
    id: "remote.hosts",
    chapterKey: "tour.chapter.remote",
    titleKey: "tour.remote.hosts.title",
    bodyKey: "tour.remote.hosts.body",
    anchors: ['[data-tour="remote-hosts"]', '[data-tour="main-content"]'],
    stage: REMOTE_STAGE,
  },
  {
    id: "remote.connect",
    chapterKey: "tour.chapter.remote",
    titleKey: "tour.remote.connect.title",
    bodyKey: "tour.remote.connect.body",
    anchors: ['[data-tour="remote-connect"]', '[data-tour="main-content"]'],
    padding: 6,
    stage: REMOTE_STAGE,
  },
  {
    id: "remote.session",
    chapterKey: "tour.chapter.remote",
    titleKey: "tour.remote.session.title",
    bodyKey: "tour.remote.session.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: REMOTE_STAGE,
  },
  {
    id: "remote.files",
    chapterKey: "tour.chapter.remote",
    titleKey: "tour.remote.files.title",
    bodyKey: "tour.remote.files.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: REMOTE_STAGE,
  },
  // Anchored on the host list and not on a panel of its own, because that is the point being made:
  // a bucket and a storage account are rows in the same list as an SSH machine, saved the same way
  // and belonging to the same workspace. A step that pointed at a separate panel would be teaching
  // the opposite.
  {
    id: "remote.cloud",
    chapterKey: "tour.chapter.remote",
    titleKey: "tour.remote.cloud.title",
    bodyKey: "tour.remote.cloud.body",
    anchors: ['[data-tour="remote-hosts"]', '[data-tour="main-content"]'],
    stage: REMOTE_STAGE,
  },
  {
    id: "remote.forwards",
    chapterKey: "tour.chapter.remote",
    titleKey: "tour.remote.forwards.title",
    bodyKey: "tour.remote.forwards.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: REMOTE_STAGE,
  },
  {
    id: "remote.screen",
    chapterKey: "tour.chapter.remote",
    titleKey: "tour.remote.screen.title",
    bodyKey: "tour.remote.screen.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: REMOTE_STAGE,
  },
  closingStep(
    "remote",
    "tour.chapter.remote",
    "tour.remote.done.title",
    "tour.remote.done.body",
    REMOTE_STAGE,
  ),
];

const NOTES_STAGE: TourStage = { view: "notes" };

/**
 * The Notes tour.
 *
 * Shorter than the others on purpose. A notes app has almost no concepts to explain — you type and
 * it saves — so the tour's job is what is *not* obvious from looking at it: that filing is
 * drag-and-drop and deleting a folder keeps what is in it, that the search box reads bodies and not
 * just titles, that templates exist at all, and that the two icons at the end of the toolbar — the
 * sparkle and the reference — are how you get an engine to write a paragraph and how you link one
 * note to another, neither of which has an obvious keyboard shortcut to stumble onto.
 */
const NOTES_TOUR: TourStep[] = [
  {
    id: "notes.intro",
    chapterKey: "tour.chapter.notes",
    titleKey: "tour.notes.intro.title",
    bodyKey: "tour.notes.intro.body",
    anchors: ['[data-tour="notes-view"]', '[data-tour="main-content"]'],
    placement: "inside",
    stage: NOTES_STAGE,
  },
  {
    id: "notes.tree",
    chapterKey: "tour.chapter.notes",
    titleKey: "tour.notes.tree.title",
    bodyKey: "tour.notes.tree.body",
    anchors: ['[data-tour="notes-tree"]', '[data-tour="notes-view"]'],
    stage: NOTES_STAGE,
  },
  {
    id: "notes.search",
    chapterKey: "tour.chapter.notes",
    titleKey: "tour.notes.search.title",
    bodyKey: "tour.notes.search.body",
    anchors: ['[data-tour="notes-search"]', '[data-tour="notes-view"]'],
    padding: 6,
    stage: NOTES_STAGE,
  },
  {
    id: "notes.tags",
    chapterKey: "tour.chapter.notes",
    titleKey: "tour.notes.tags.title",
    bodyKey: "tour.notes.tags.body",
    anchors: ['[data-tour="notes-tags"]', '[data-tour="notes-view"]'],
    stage: NOTES_STAGE,
  },
  {
    id: "notes.editor",
    chapterKey: "tour.chapter.notes",
    titleKey: "tour.notes.editor.title",
    bodyKey: "tour.notes.editor.body",
    anchors: ['[data-tour="notes-view"]', '[data-tour="main-content"]'],
    placement: "inside",
    stage: NOTES_STAGE,
  },
  {
    id: "notes.ai",
    chapterKey: "tour.chapter.notes",
    titleKey: "tour.notes.ai.title",
    bodyKey: "tour.notes.ai.body",
    // Only on screen with a note open; a step taken from the gallery falls back to the view
    // itself, same as `notes.editor` above.
    anchors: ['[data-tour="notes-ai"]', '[data-tour="notes-view"]', '[data-tour="main-content"]'],
    padding: 6,
    stage: NOTES_STAGE,
  },
  {
    id: "notes.reference",
    chapterKey: "tour.chapter.notes",
    titleKey: "tour.notes.reference.title",
    bodyKey: "tour.notes.reference.body",
    anchors: ['[data-tour="notes-link"]', '[data-tour="notes-view"]', '[data-tour="main-content"]'],
    padding: 6,
    stage: NOTES_STAGE,
  },
  {
    id: "notes.templates",
    chapterKey: "tour.chapter.notes",
    titleKey: "tour.notes.templates.title",
    bodyKey: "tour.notes.templates.body",
    anchors: ['[data-tour="notes-templates"]', '[data-tour="notes-view"]'],
    padding: 6,
    stage: NOTES_STAGE,
  },
  closingStep(
    "notes",
    "tour.chapter.notes",
    "tour.notes.done.title",
    "tour.notes.done.body",
    NOTES_STAGE,
  ),
];

export const TOURS: Record<TourId, TourStep[]> = {
  main: MAIN_TOUR,
  api: API_TOUR,
  db: DB_TOUR,
  agents: AGENTS_TOUR,
  stories: STORIES_TOUR,
  remote: REMOTE_TOUR,
  notes: NOTES_TOUR,
};

/**
 * Which app tour belongs to the screen you are looking at.
 *
 * The launcher in the tab bar is one button that changes what it starts, rather than five buttons
 * bolted into five different panel headers. Those five headers are five different shapes — the API
 * client has no header row at all — and a control that moves and resizes depending on which app is
 * open is a control nobody learns the position of. Beside the workspace menu, which is what names
 * the app you are in, it is always in the same place and always about the thing that menu says.
 */
export interface AppTour {
  tour: TourId;
  view: MainView;
  /** For the tab that holds two apps; `undefined` when the view is the whole app. */
  workspace?: ApiWorkspace;
  /** The app's own name, for the button's tooltip — the tour is "of this app", not "of the app". */
  labelKey: TranslationKey;
  /** The same glyph the workspace menu gives the app, so a tour is recognisable as belonging to the
   * row that opens it. Carried here rather than looked up per caller: two lists of the five apps
   * drift, and the one in Settings is far from the one in the menu. */
  icon: LucideIcon;
}

/** The five, in the order the workspace menu lists them — Settings offers them in that order too,
 * because a reader who knows where an app sits in the menu should not have to re-find it here. */
export const APP_TOURS: AppTour[] = [
  { tour: "api", view: "api", workspace: "requests", labelKey: "tabbar.api", icon: Send },
  { tour: "db", view: "api", workspace: "database", labelKey: "tabbar.databases", icon: Database },
  { tour: "agents", view: "agents", labelKey: "tabbar.agents", icon: Bot },
  { tour: "stories", view: "stories", labelKey: "tabbar.stories", icon: ClipboardList },
  { tour: "remote", view: "remote", labelKey: "tabbar.remote", icon: MonitorSmartphone },
  { tour: "notes", view: "notes", labelKey: "tabbar.notes", icon: NotebookPen },
];

/** The app tour for the current view, or `null` on the three repository views — which are what the
 * main tour is about, and so have no second tour to offer. */
export function appTourFor(view: MainView, workspace: ApiWorkspace): AppTour | null {
  return (
    APP_TOURS.find((entry) => entry.view === view && (entry.workspace ?? workspace) === workspace) ??
    null
  );
}
