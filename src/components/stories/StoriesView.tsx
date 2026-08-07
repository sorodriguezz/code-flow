import { useEffect, useState } from "react";
import { BookText, CircleHelp, ClipboardList, ScanSearch } from "lucide-react";
import { StoryBatchList } from "./StoryBatchList";
import { StoryBatchDetail } from "./StoryBatchDetail";
import { StoryTargetPanel } from "./StoryTargetPanel";
import { NewStoryBatchModal } from "./NewStoryBatchModal";
import { WorkItemReviewView } from "./WorkItemReviewView";
import { WikiView } from "./WikiView";
import { ActivePill } from "../common/ActivePill";
import { StoriesHelpModal } from "./StoriesHelpModal";
import { CARD } from "../api/panelChrome";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { useLayoutStore } from "../../state/layoutStore";
import { useStoriesStore } from "../../state/storiesStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";

/**
 * The three directions this section runs in.
 *
 * Peers, not a screen and two detours. **Redactar** derives a backlog from documentation.
 * **Revisar** takes a work item that already exists and asks what it is missing. **Wiki** runs the
 * other way round again — it reads the code and writes the documentation the first two assume
 * somebody wrote. They share the workspace, the Azure connection and the repositories, and a team
 * moves between them inside one session, which is what makes them tabs rather than three places to
 * navigate to.
 */
const MODES = [
  { id: "batches" as const, labelKey: "stories.tabBatches" as const, icon: ClipboardList },
  { id: "review" as const, labelKey: "stories.tabReview" as const, icon: ScanSearch },
  { id: "wiki" as const, labelKey: "stories.tabWiki" as const, icon: BookText },
];

const LIST_MIN = 240;
const LIST_MAX = 460;
const RAIL_MIN = 280;
const RAIL_MAX = 460;

/**
 * The user-stories workspace: documentation in, a reviewed backlog out, Azure Boards at the end.
 *
 * Three flush columns, the same shape as the agent console and the API client — the batches on the
 * left, the open batch's stories in the middle, and the Azure Boards target as a rail on the right.
 *
 * The rail is a rail and not a modal because its four fields are *dependent* (project → work item
 * type → area → iteration, each list fetched from the one above) and because they are read while
 * the stories are being reviewed, not once at the end: seeing "User Story · Fabrikam\Web · Sprint
 * 14" while editing a criterion is what stops a batch being published into the wrong team's board.
 *
 * Scoped to the workspace, not to a repository: a requirement is written before the code that
 * satisfies it, so this screen has to work in a workspace with no project open at all.
 */
export function StoriesView() {
  const t = useT();
  const activeView = useUiStore((s) => s.activeView);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const selectedId = useStoriesStore((s) => s.selectedId);
  const targetOpen = useStoriesStore((s) => s.targetOpen);
  const listWidth = useLayoutStore((s) => s.sizes.storiesListWidth);
  const railWidth = useLayoutStore((s) => s.sizes.storiesRailWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const [composing, setComposing] = useState(false);
  // In `uiStore` rather than here, so a notification can open the tab its run belongs to.
  const mode = useUiStore((s) => s.storiesMode);
  const setMode = useUiStore((s) => s.setStoriesMode);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    void useStoriesStore.getState().setWorkspace(workspaceId);
  }, [workspaceId]);

  // Scoped to the view: it stays mounted once opened, so an unscoped ⌘N would open the new-batch
  // dialog while the user is looking at a diff.
  useEffect(() => {
    if (activeView !== "stories" || mode !== "batches") return;
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      // Lower-cased: with caps lock on, `key` is "N" and a bare comparison silently misses.
      if (e.key.toLowerCase() !== "n") return;
      if (composing || useUiStore.getState().settingsOpen) return;
      e.preventDefault();
      setComposing(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeView, composing, mode]);

  if (!workspaceId) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-bg)]">
        <EmptyState
          icon={ClipboardList}
          title={t("stories.noWorkspace")}
          subtitle={t("stories.noWorkspaceHint")}
        />
      </div>
    );
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-bg)]">
        {/* A segmented control rather than a strip of underlined words.

            These two are the top-level choice of the whole section — which direction you are
            working in — and as 12px muted text under a hairline they read as a breadcrumb: present,
            but not something you press. Given a track, a filled pill and real weight, the choice
            looks like a choice. Every tab stays mounted as a button so the pill has something to
            slide between (see `ActivePill`); the panes below do not, because each keeps its own
            store and switching away and back has to find the work still there. */}
        {/* On the surface, not the window background. All three panes below are `--cf-surface`, so
            a strip that fell through to `--cf-bg` drew a grey band across the top of an otherwise
            white column — read as a gap between two things rather than as the top of one. The
            hairline under it is what separates the tabs from what they switch. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1.5">
          <div
            data-tour="stories-modes"
            className="flex items-center gap-0.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-bg)] p-0.5"
          >
            {MODES.map(({ id, labelKey, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                aria-pressed={mode === id}
                className={`relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  mode === id ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                }`}
              >
                {mode === id && <ActivePill layoutId="cf-stories-mode-pill" />}
                <span className="relative flex items-center gap-1.5">
                  <Icon size={14} />
                  {t(labelKey)}
                </span>
              </button>
            ))}
          </div>
          {/* At the end of the strip rather than inside either tab: the manual covers both
              directions, and the limits that matter most — the review never writes to Azure, the
              session is not saved — belong to the workspace, not to whichever half is on screen. */}
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            title={t("stories.helpHint")}
            aria-label={t("stories.help")}
            className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
          >
            <CircleHelp size={13} />
            {t("stories.help")}
          </button>
        </div>

        {mode === "wiki" ? (
          <WikiView />
        ) : mode === "review" ? (
          <WorkItemReviewView />
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <StoryBatchList width={listWidth} onNewBatch={() => setComposing(true)} />
            <ResizeHandle
              axis="x"
              value={listWidth}
              min={LIST_MIN}
              max={LIST_MAX}
              onChange={(value) => setSize("storiesListWidth", value)}
              onCommit={(value) => commitSize("storiesListWidth", value)}
            />

            {/* Keyed on the batch: every bit of local state in the detail pane — which card is open,
                which criterion is being edited — belongs to one batch and must not survive a switch. */}
            <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${CARD}`}>
              {selectedId ? (
                <StoryBatchDetail key={selectedId} batchId={selectedId} />
              ) : (
                <EmptyState
                  icon={ClipboardList}
                  title={t("stories.selectBatch")}
                  subtitle={t("stories.selectBatchHint")}
                />
              )}
            </div>

            {targetOpen && selectedId && (
              <>
                <ResizeHandle
                  axis="x"
                  value={railWidth}
                  min={RAIL_MIN}
                  max={RAIL_MAX}
                  invert
                  onChange={(value) => setSize("storiesRailWidth", value)}
                  onCommit={(value) => commitSize("storiesRailWidth", value)}
                />
                <StoryTargetPanel key={selectedId} batchId={selectedId} width={railWidth} />
              </>
            )}
          </div>
        )}
      </div>

      {composing && <NewStoryBatchModal onClose={() => setComposing(false)} />}
      {helpOpen && <StoriesHelpModal onClose={() => setHelpOpen(false)} />}
    </>
  );
}
