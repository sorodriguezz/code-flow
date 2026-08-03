import { useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import { StoryBatchList } from "./StoryBatchList";
import { StoryBatchDetail } from "./StoryBatchDetail";
import { StoryTargetPanel } from "./StoryTargetPanel";
import { NewStoryBatchModal } from "./NewStoryBatchModal";
import { WorkItemReviewView } from "./WorkItemReviewView";
import { CARD } from "../api/panelChrome";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { useLayoutStore } from "../../state/layoutStore";
import { useStoriesStore } from "../../state/storiesStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";

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
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    void useStoriesStore.getState().setWorkspace(workspaceId);
  }, [workspaceId]);

  // Scoped to the view: it stays mounted once opened, so an unscoped ⌘N would open the new-batch
  // dialog while the user is looking at a diff.
  useEffect(() => {
    if (activeView !== "stories") return;
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
  }, [activeView, composing]);

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

  // Takes over the whole view rather than opening beside the columns: reviewing one story is its
  // own sitting, and the batch list, the batch detail and the Boards target all belong to the other
  // direction of travel. The session itself lives in its own store, so leaving and coming back finds
  // the story still loaded.
  if (reviewing) return <WorkItemReviewView onClose={() => setReviewing(false)} />;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-bg)]">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <StoryBatchList
            width={listWidth}
            onNewBatch={() => setComposing(true)}
            onReview={() => setReviewing(true)}
          />
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
      </div>

      {composing && <NewStoryBatchModal onClose={() => setComposing(false)} />}
    </>
  );
}
