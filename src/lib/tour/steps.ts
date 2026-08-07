import type { TranslationKey } from "../i18n/translations";
import type { Chord } from "../keys";
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
  /** Which chapter the progress chip names. Steps are grouped so 22 of them read as five parts. */
  chapterKey: TranslationKey;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  /**
   * CSS selectors for the thing to spotlight, **in order of preference** — the first one on screen
   * wins.
   *
   * A list rather than one selector because several of these controls only exist under conditions
   * the tour can't manufacture: the pre-commit review button appears once there is something
   * uncommitted, and a user taking the tour on a clean checkout has nothing for it to point at. The
   * fallback is the tab that holds it, which always exists, so the step still lands somewhere real
   * instead of degrading to a floating card.
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
 * The tour, in the order it is walked.
 *
 * The order is the argument. It goes **outside in**: what a workspace is, then what goes in it,
 * then the panels around the work, then the AI that reads the work, then the workspace-wide tools,
 * and only at the end the settings — because settings is where you go once you know what you are
 * configuring, and a tour that opens with a preferences dialog has taught nothing yet.
 */
export const TOUR_STEPS: TourStep[] = [
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
    id: "projects",
    chapterKey: "tour.chapter.start",
    titleKey: "tour.projects.title",
    bodyKey: "tour.projects.body",
    anchors: ['[data-tour="projects-panel"]'],
  },
  {
    id: "addRepo",
    chapterKey: "tour.chapter.start",
    titleKey: "tour.addRepo.title",
    bodyKey: "tour.addRepo.body",
    anchors: ['[data-tour="projects-actions"]'],
    padding: 6,
  },
  {
    id: "sidebarToggle",
    chapterKey: "tour.chapter.workspace",
    titleKey: "tour.sidebarToggle.title",
    bodyKey: "tour.sidebarToggle.body",
    anchors: ['[data-tour="sidebar-toggle"]'],
    padding: 6,
  },
  {
    id: "repoTabs",
    chapterKey: "tour.chapter.workspace",
    titleKey: "tour.repoTabs.title",
    bodyKey: "tour.repoTabs.body",
    anchors: ['[data-tour="repo-tabs"]'],
  },
  {
    id: "precommit",
    chapterKey: "tour.chapter.workspace",
    titleKey: "tour.precommit.title",
    bodyKey: "tour.precommit.body",
    // The review button when there is something to review; the Changes tab that holds it otherwise.
    anchors: ['[data-tour="changes-analyze"]', '[data-tour="tab-changes"]'],
    padding: 6,
    stage: { view: "changes" },
  },
  // The editor closes the repository chapter, and gets four steps for the same reason Specs does:
  // it is not one screen but a workbench, and the two things people never find on their own — the
  // rail's five panels and the inline AI edit, which has no button at all — are inside it.
  {
    id: "editorOpen",
    chapterKey: "tour.chapter.workspace",
    titleKey: "tour.editorOpen.title",
    bodyKey: "tour.editorOpen.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: { view: "editor" },
  },
  {
    id: "editorRail",
    chapterKey: "tour.chapter.workspace",
    titleKey: "tour.editorRail.title",
    bodyKey: "tour.editorRail.body",
    // The rail only exists once a repository is open; the view itself is the fallback for a
    // workspace that has none yet.
    anchors: ['[data-tour="editor-rail"]', '[data-tour="main-content"]'],
    stage: { view: "editor" },
  },
  {
    id: "editorTree",
    chapterKey: "tour.chapter.workspace",
    titleKey: "tour.editorTree.title",
    bodyKey: "tour.editorTree.body",
    anchors: ['[data-tour="editor-tree"]', '[data-tour="main-content"]'],
    stage: { view: "editor" },
  },
  {
    id: "editorAi",
    chapterKey: "tour.chapter.workspace",
    titleKey: "tour.editorAi.title",
    bodyKey: "tour.editorAi.body",
    // Not rebindable, so the literal chord is the truth here — it is one of `EDITOR_RESERVED`,
    // which the settings screen refuses to let an app action take.
    chord: "Mod+I",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: { view: "editor" },
  },
  // Closes the chapter on the bar the next one starts from. Fetch/pull/push are the only repository
  // actions that talk to the network, and the only place in the app where "nothing happened" is
  // usually the right answer — so the card is mostly about how to read them.
  {
    id: "gitActions",
    chapterKey: "tour.chapter.workspace",
    titleKey: "tour.gitActions.title",
    bodyKey: "tour.gitActions.body",
    anchors: ['[data-tour="git-actions"]'],
    padding: 6,
  },
  {
    id: "aiToggle",
    chapterKey: "tour.chapter.ai",
    titleKey: "tour.aiToggle.title",
    bodyKey: "tour.aiToggle.body",
    anchors: ['[data-tour="toggle-ai-panel"]'],
    padding: 6,
  },
  {
    id: "aiPanel",
    chapterKey: "tour.chapter.ai",
    titleKey: "tour.aiPanel.title",
    bodyKey: "tour.aiPanel.body",
    anchors: ['[data-tour="ai-panel"]'],
    stage: { ai: true },
  },
  {
    id: "prLink",
    chapterKey: "tour.chapter.ai",
    titleKey: "tour.prLink.title",
    bodyKey: "tour.prLink.body",
    anchors: ['[data-tour="pr-link"]'],
    padding: 6,
  },
  {
    id: "terminal",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.terminal.title",
    bodyKey: "tour.terminal.body",
    anchors: ['[data-tour="terminal-dock"]', '[data-tour="toggle-terminal"]'],
    stage: { terminal: true },
  },
  {
    id: "notifications",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.notifications.title",
    bodyKey: "tour.notifications.body",
    anchors: ['[data-tour="notification-bell"]'],
    padding: 6,
  },
  {
    id: "workspaceMenu",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.workspaceMenu.title",
    bodyKey: "tour.workspaceMenu.body",
    anchors: ['[data-tour="workspace-menu"]'],
  },
  {
    id: "toolApi",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.toolApi.title",
    bodyKey: "tour.toolApi.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: { view: "api", apiWorkspace: "requests" },
  },
  // Straight after the API client rather than down in the settings chapter: sharing a collection
  // is something you decide about the collection you were just shown, and the screen it is
  // configured on is two levels into settings — which is exactly why it needs pointing at.
  {
    id: "collab",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.collab.title",
    bodyKey: "tour.collab.body",
    anchors: ['[data-tour="settings-panel"]'],
    placement: "inside",
    radius: 16,
    stage: { settings: "api", apiSettingsTab: "collab" },
  },
  {
    id: "toolDb",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.toolDb.title",
    bodyKey: "tour.toolDb.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: { view: "api", apiWorkspace: "database" },
  },
  {
    id: "toolAgents",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.toolAgents.title",
    bodyKey: "tour.toolAgents.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: { view: "agents" },
  },
  // Specs gets four steps where the other tools get one, because it is the only one of them that
  // is three tools: the strip first, so the three names are on screen before any of them is
  // explained, then one step per direction with that tab actually open behind it.
  {
    id: "toolStories",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.toolStories.title",
    bodyKey: "tour.toolStories.body",
    anchors: ['[data-tour="stories-modes"]', '[data-tour="main-content"]'],
    stage: { view: "stories", storiesMode: "batches" },
  },
  {
    id: "storiesWrite",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.storiesWrite.title",
    bodyKey: "tour.storiesWrite.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: { view: "stories", storiesMode: "batches" },
  },
  {
    id: "storiesReview",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.storiesReview.title",
    bodyKey: "tour.storiesReview.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: { view: "stories", storiesMode: "review" },
  },
  {
    id: "storiesWiki",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.storiesWiki.title",
    bodyKey: "tour.storiesWiki.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: { view: "stories", storiesMode: "wiki" },
  },
  {
    id: "toolRemote",
    chapterKey: "tour.chapter.tools",
    titleKey: "tour.toolRemote.title",
    bodyKey: "tour.toolRemote.body",
    anchors: ['[data-tour="main-content"]'],
    placement: "inside",
    stage: { view: "remote" },
  },
  {
    id: "settingsOpen",
    chapterKey: "tour.chapter.settings",
    titleKey: "tour.settingsOpen.title",
    bodyKey: "tour.settingsOpen.body",
    anchors: ['[data-tour="open-settings"]'],
    padding: 6,
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
