import { motion } from "framer-motion";
import { ChevronDown, Plus, SplitSquareHorizontal, TerminalSquare, X } from "lucide-react";
import { activeGroup, useTerminalStore } from "../../state/terminalStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useLayoutStore } from "../../state/layoutStore";
import { ResizeHandle } from "../common/ResizeHandle";
import { TerminalPane } from "./TerminalPane";
import { useT } from "../../state/languageStore";
import { EmptyState } from "../common/EmptyState";

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 640;

/** Rendered by App.tsx inside an `AnimatePresence` so mount/unmount slides the dock in/out. */
export function TerminalDock() {
  const t = useT();
  const project = useWorkspaceStore((s) => s.activeProject());
  const byProject = useTerminalStore((s) => s.byProject);
  const openNew = useTerminalStore((s) => s.openNew);
  const closeTab = useTerminalStore((s) => s.close);
  const focus = useTerminalStore((s) => s.focus);
  const togglePanel = useTerminalStore((s) => s.togglePanel);
  const height = useLayoutStore((s) => s.sizes.terminalPanelHeight);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const activeProjectId = project?.id ?? null;
  const activeProj = activeProjectId ? byProject[activeProjectId] : undefined;
  const visibleIds = activeGroup(activeProj);

  // Every terminal ever opened — across every project — stays mounted (hidden via CSS unless
  // it belongs to the active project *and* is part of its currently active split group), so
  // switching projects never kills a shell or discards its scrollback; only explicitly closing
  // a tab does.
  const allPanes = Object.entries(byProject).flatMap(([projectId, proj]) =>
    proj.tabs.map((tab) => ({
      projectId,
      tab,
      visible: projectId === activeProjectId && visibleIds.includes(tab.id),
    })),
  );

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height, opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="flex shrink-0 flex-col overflow-hidden border-t border-[var(--cf-border)] bg-[var(--cf-surface)]"
    >
      <ResizeHandle
        axis="y"
        value={height}
        min={MIN_HEIGHT}
        max={MAX_HEIGHT}
        invert
        onChange={(h) => setSize("terminalPanelHeight", h)}
        onCommit={(h) => commitSize("terminalPanelHeight", h)}
      />
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2">
        <TerminalSquare size={13} className="mr-1 shrink-0 text-[var(--cf-text-muted)]" />
        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          {(activeProj?.tabs ?? []).map((tab) => {
            const isVisible = visibleIds.includes(tab.id);
            return (
              <div
                key={tab.id}
                onClick={() => project && focus(project.id, tab.id)}
                className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] ${
                  isVisible
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                }`}
              >
                {tab.title}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (project) void closeTab(project.id, tab.id);
                  }}
                  title={t("terminal.close")}
                  className="text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
        <button
          onClick={() => project && void openNew(project.id, project.local_path)}
          disabled={!project}
          title={t("terminal.new")}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
        >
          <Plus size={13} />
        </button>
        <button
          onClick={() => project && void openNew(project.id, project.local_path, { split: true })}
          disabled={!project || (activeProj?.tabs.length ?? 0) === 0}
          title={t("terminal.split")}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
        >
          <SplitSquareHorizontal size={13} />
        </button>
        <button
          onClick={togglePanel}
          title={t("terminal.hide")}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
        >
          <ChevronDown size={13} />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1">
        {!project ? (
          <div className="absolute inset-0">
            <EmptyState icon={TerminalSquare} title={t("terminal.noProject")} />
          </div>
        ) : (activeProj?.tabs.length ?? 0) === 0 ? (
          <div className="absolute inset-0">
            <EmptyState icon={TerminalSquare} title={t("terminal.emptyHint")} />
          </div>
        ) : null}
        {allPanes.map(({ tab, visible }) => (
          <div
            key={tab.id}
            className={
              visible
                ? `flex min-w-0 flex-1 flex-col ${tab.id !== visibleIds[visibleIds.length - 1] ? "border-r border-[var(--cf-border)]" : ""}`
                : "hidden"
            }
          >
            <TerminalPane sessionId={tab.id} visible={visible} />
          </div>
        ))}
      </div>
    </motion.div>
  );
}
