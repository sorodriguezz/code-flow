import { lazy, Suspense, useEffect } from "react";
import { ResizeHandle } from "../common/ResizeHandle";
import { ViewSkeleton } from "../common/ViewSkeleton";
import { explorerClass } from "../common/recipes";
import { FlowExplorer } from "./FlowExplorer";
import { FlowVaultDialog } from "./FlowVaultDialog";
import { FlowCollabDialog } from "./FlowCollabDialog";
import { FlowRunFormDialog } from "./RunForm";
import { ScheduleView } from "./ScheduleView";
import { TablesView } from "./TablesView";
import { TrustDialog } from "./TrustDialog";
import { ensureFlowRunEvents, useFlowRunsStore } from "../../state/flowRunsStore";
import { ensureFlowsStoreLoaded, useFlowsStore } from "../../state/flowsStore";
import { useFlowVaultStore } from "../../state/flowVaultStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useLayoutStore } from "../../state/layoutStore";

/** The canvas and React Flow arrive the first time a flow is opened, not with the app. */
const FlowEditor = lazy(() => import("./FlowEditor").then((m) => ({ default: m.FlowEditor })));

/** The empty canvas: the same dotted well the editor draws, with nothing on it. */
const DOTS = {
  backgroundImage: "radial-gradient(color-mix(in oklab, var(--cf-text) 14%, transparent) 1px, transparent 1.4px)",
  backgroundSize: "20px 20px",
} as const;

/**
 * Flujos — node-based automations. The explorer on the left, the open flow's canvas beside it (or
 * its executions). With no flow open the canvas is simply empty — the explorer's `+` is the way in.
 */
export function FlowsView() {
  const loading = useFlowsStore((s) => s.loading);
  const activeId = useFlowsStore((s) => s.activeId);
  const pane = useFlowRunsStore((s) => s.pane);
  const sidebarWidth = useLayoutStore((s) => s.sizes.flowsSidebarWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    void ensureFlowsStoreLoaded();
    ensureFlowRunEvents();
  }, []);

  // Credentials for the HTTP node's picker, variables for the dialog — per workspace.
  useEffect(() => {
    if (workspaceId) void useFlowVaultStore.getState().load(workspaceId);
  }, [workspaceId]);

  // The unsaved edit, written when the window hides and when the view goes away.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void useFlowsStore.getState().flush({ interactive: false });
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      void useFlowsStore.getState().flush({ interactive: false });
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 bg-[var(--cf-surface)]" data-tour="flows-view">
      <div style={{ width: sidebarWidth }} className={explorerClass}>
        {loading ? <ViewSkeleton /> : <FlowExplorer />}
      </div>
      <ResizeHandle
        axis="x"
        value={sidebarWidth}
        min={200}
        max={460}
        onChange={(value) => setSize("flowsSidebarWidth", value)}
        onCommit={(value) => commitSize("flowsSidebarWidth", value)}
      />
      <div className="relative flex min-w-0 flex-1 flex-col">
        {pane === "schedule" ? (
          <ScheduleView />
        ) : pane === "tables" ? (
          <TablesView />
        ) : activeId ? (
          <Suspense fallback={<ViewSkeleton />}>
            <FlowEditor />
          </Suspense>
        ) : (
          <div className="h-full bg-[var(--cf-sunken)]" style={DOTS} />
        )}
      </div>
      <FlowVaultDialog />
      <TrustDialog />
      {/* Here rather than in the explorer: a flow's share dialog opens it too. */}
      <FlowCollabDialog />
      <FlowRunFormDialog />
    </div>
  );
}
