import { GitCompare, X } from "lucide-react";
import { TaskReviewPanel } from "./TaskReviewPanel";
import { EmptyState } from "../common/EmptyState";
import { useAgentsStore } from "../../state/agentsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { PaneView } from "../../lib/bench/layout";

/**
 * A bench pane that is not a shell: today, the diff of an agent's working copy.
 *
 * # Why this exists
 *
 * The bench began as tiled terminals, and the tiling turned out to be the useful half. What you
 * want beside a shell running the tests is the diff those tests are about — not a second shell. So a
 * pane may hold a view, and this draws it with the same tile chrome the terminals wear, because four
 * panes should read as four panes whatever is inside them.
 *
 * # What it costs
 *
 * Nothing that runs. A view pane has no process, no shell and no timer: it reads the diff once when
 * it opens and again when the task's turn ends (`TaskReviewPanel`), and holds that task's review in
 * the store it already shares with the task's own Changes tab — so two panes on one task are one
 * read, not two. Closing it removes the leaf and nothing else.
 */
export function ViewPane({
  view,
  focused,
  onFocus,
  onClose,
}: {
  view: PaneView;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const task = useAgentsStore((s) => s.tasks.find((candidate) => candidate.id === view.taskId) ?? null);
  // The working copy the task edits: its own worktree, or the repository's — the same rule the
  // task's detail pane uses.
  const repoPath = useWorkspaceStore((s) => {
    if (!task) return "";
    if (task.worktree_path) return task.worktree_path;
    const projects = s.projectsByWorkspace[task.workspace_id] ?? [];
    return projects.find((project) => project.id === task.project_id)?.local_path ?? "";
  });

  return (
    <div
      onMouseDown={onFocus}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={{ boxShadow: focused ? "inset 2px 0 0 var(--cf-accent)" : undefined }}
    >
      <div className="flex shrink-0 items-center gap-1.5 px-2 py-0.5 text-[11px] text-[var(--cf-text-muted)]">
        <GitCompare size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {task ? t("bench.diffOf", { name: task.title }) : t("agents.review.tab")}
        </span>
        <button
          onClick={onClose}
          title={t("bench.removePane")}
          aria-label={t("bench.removePane")}
          className="shrink-0 hover:text-[var(--cf-danger)]"
        >
          <X size={11} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {!task || repoPath === "" ? (
          // The task was deleted while its pane was open. The pane stays — closing it from under
          // the user would take whatever is beside it with it if it were the last one.
          <EmptyState icon={GitCompare} title={t("bench.diffGone")} />
        ) : (
          <TaskReviewPanel taskId={task.id} repoPath={repoPath} />
        )}
      </div>
    </div>
  );
}
