import { useEffect, useMemo, useState } from "react";
import { ResizeHandle } from "../common/ResizeHandle";
import { AssistantInbox } from "./AssistantInbox";
import { AnalysisDocument } from "./AnalysisDocument";
import { CheckpointsModal } from "./CheckpointsModal";
import { PanelChat } from "./PanelChat";
import { PanelTabStrip } from "./PanelTabStrip";
import { PrDocument } from "./PrDocument";
import { useChatStore } from "../../state/chatStore";
import { EMPTY_TABS, INBOX_KEY, NO_WORKSPACE, useAiPanelStore, type PanelTab } from "../../state/aiPanelStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

const PANEL_MIN = 300;

/**
 * How many tab bodies stay mounted (hidden) besides the one on screen.
 *
 * The three most recently visited — which is what makes switching between them instant and
 * lossless for everything that lives in a component rather than a store: a comment thread list that
 * took a round trip to load, a discard being composed, the exact scroll offset. Tabs further back
 * rebuild from their view state (`aiPanelStore.view`), which keeps what matters: segment, open
 * cards, selection, the run being read.
 */
const KEEP_ALIVE = 3;

/**
 * How wide the panel is allowed to get: half the window, and no more.
 *
 * Past half it stops being a panel — the view it is docked beside becomes the smaller of the two,
 * and the thing the user came to look at is the one that gets squeezed. The floor keeps the ceiling
 * above `PANEL_MIN` on a window too narrow for both.
 */
const maxPanelWidth = () => Math.max(PANEL_MIN, Math.round(window.innerWidth / 2));

/** That ceiling, kept current as the window is resized. The clamp is applied to what is rendered,
 * never written back: plug the large display in again and the width chosen there comes back. */
function useMaxPanelWidth(): number {
  const [max, setMax] = useState(maxPanelWidth);
  useEffect(() => {
    const onResize = () => setMax(maxPanelWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return max;
}

/**
 * The assistant — a rail beside whatever view is showing, holding the Inbox and one tab per open
 * conversation, pull request review or change analysis.
 *
 * What is on screen is exactly `aiPanelStore`'s active tab for this workspace. There is no longer a
 * precedence between a link review, a selected PR, an analysis flag and the chat — which was how a
 * click could change a store and nothing on screen — and no body is torn down just because another
 * one is being looked at.
 *
 * Rendered by App.tsx inside an `AnimatePresence`, so mount/unmount slides the panel in and out.
 */
export function AiPanel() {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId) ?? NO_WORKSPACE;
  const tabs = useAiPanelStore((s) => s.tabsByWorkspace[workspaceId] ?? EMPTY_TABS);
  const activeKey = useAiPanelStore((s) => s.activeByWorkspace[workspaceId] ?? INBOX_KEY);
  const tabsByWorkspace = useAiPanelStore((s) => s.tabsByWorkspace);
  const wide = useAiPanelStore((s) => s.wide);
  const load = useAiPanelStore((s) => s.load);
  const activeProject = useWorkspaceStore((s) => s.activeProject());

  useEffect(() => {
    void load(workspaceId);
  }, [workspaceId, load]);

  // Conversations shown in a tab — in any workspace — are never collapsed out of memory: the tab
  // would go blank under the user. See `chatStore.setPinned`.
  useEffect(() => {
    const ids = Object.values(tabsByWorkspace)
      .flat()
      .flatMap((tab) => (tab.kind === "chat" ? [tab.conversationId] : []));
    useChatStore.getState().setPinned(ids);
  }, [tabsByWorkspace]);

  // The bodies kept mounted: the one on screen plus the most recently visited, as long as their tab
  // is still open. Per workspace, since each has its own strip.
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    setRecent((previous) => [`${workspaceId}|${activeKey}`, ...previous.filter((key) => key !== `${workspaceId}|${activeKey}`)].slice(0, KEEP_ALIVE + 1));
  }, [workspaceId, activeKey]);
  const open = useMemo(() => new Set([INBOX_KEY, ...tabs.map((tab) => tab.key)]), [tabs]);
  const mounted = useMemo(() => {
    const keys = recent
      .filter((entry) => entry.startsWith(`${workspaceId}|`))
      .map((entry) => entry.slice(workspaceId.length + 1))
      .filter((key) => open.has(key));
    return keys.includes(activeKey) ? keys : [activeKey, ...keys];
  }, [recent, workspaceId, open, activeKey]);

  const storedWidth = useLayoutStore((s) => s.sizes.aiPanelWidth);
  const maxWidth = useMaxPanelWidth();
  // Wide is half the window — the most a panel may take. Otherwise what was chosen, clamped only
  // while the window is too small to honour it.
  const width = wide ? maxWidth : Math.min(storedWidth, maxWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  // The easing that opens and closes the panel is off while dragging, or the edge would swim after
  // the pointer instead of tracking it.
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);

  return (
    // A sheet beside the rail. It appears at its width and its contents fade in: the width tween it
    // used to open with relaid out the whole window on every frame.
    <div className="cf-panel-in flex shrink-0 overflow-hidden pb-1.5 pr-1.5">
      <ResizeHandle
        axis="x"
        value={width}
        min={PANEL_MIN}
        max={maxWidth}
        invert
        onChange={(w) => {
          // Dragging is choosing a width: it takes the panel out of wide mode.
          if (useAiPanelStore.getState().wide) useAiPanelStore.getState().toggleWide();
          setSize("aiPanelWidth", w);
        }}
        onCommit={(w) => commitSize("aiPanelWidth", w)}
        seamless
      />
      <aside
        style={{ width }}
        data-tour="ai-panel"
        // No `border-l`: the handle to its left is already the seam.
        className="cf-sheet ml-1.5 flex shrink-0 flex-col"
      >
        <PanelTabStrip
          workspaceId={workspaceId}
          tabs={tabs}
          activeKey={activeKey}
          onOpenCheckpoints={activeProject ? () => setCheckpointsOpen(true) : null}
        />
        <div className="relative min-h-0 flex-1">
          {mounted.map((key) => (
            <div key={`${workspaceId}|${key}`} hidden={key !== activeKey} className="absolute inset-0 flex flex-col">
              <TabBody tabKey={key} tab={tabs.find((tab) => tab.key === key) ?? null} workspaceId={workspaceId} />
            </div>
          ))}
        </div>
      </aside>
      {checkpointsOpen && activeProject && (
        <CheckpointsModal repoPath={activeProject.local_path} onClose={() => setCheckpointsOpen(false)} />
      )}
    </div>
  );
}

function TabBody({ tabKey, tab, workspaceId }: { tabKey: string; tab: PanelTab | null; workspaceId: string }) {
  if (tabKey === INBOX_KEY || !tab) return <AssistantInbox workspaceId={workspaceId} />;
  switch (tab.kind) {
    case "chat":
      return <PanelChat tabKey={tab.key} projectId={tab.projectId} conversationId={tab.conversationId} fresh={Boolean(tab.fresh)} />;
    case "pr":
      return <PrDocument tabKey={tab.key} target={{ kind: "project", projectId: tab.projectId }} pr={tab.pr} session={null} />;
    case "prLink":
      return (
        <PrDocument
          tabKey={tab.key}
          target={{ kind: "link", url: tab.session.url, workspaceId: tab.session.workspaceId }}
          pr={tab.session.pr}
          session={tab.session}
        />
      );
    case "analysis":
      return <AnalysisDocument tabKey={tab.key} projectId={tab.projectId} jobId={tab.jobId} />;
  }
}
