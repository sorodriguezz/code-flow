import { useEffect, useState } from "react";
import { Flag, FolderGit2, GitBranch, GitCompare, RefreshCw, TerminalSquare } from "lucide-react";
import { AGENT_STATUS } from "./agentStatus";
import { agentName } from "./agentName";
import { buttonClass, iconButtonClass } from "../common/Button";
import { EmptyState } from "../common/EmptyState";
import { Tooltip } from "../common/Tooltip";
import { useAgentsStore } from "../../state/agentsStore";
import { reviewOf, useTaskReviewStore } from "../../state/taskReviewStore";
import { useBenchStore } from "../../state/benchStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";
import { fieldClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { openPathAsProject } from "../../lib/openAsProject";
import { raceRunning, racersOf, tally } from "../../lib/agents/race";
import type { AgentTask } from "../../types/domain";

/**
 * The race, side by side: one goal, several agents, one worktree each, and what each of them did
 * to it.
 *
 * # What this is for
 *
 * Handing the same objective to three agents is cheap; *reading* three answers is not. Three
 * transcripts say what each one claims to have done, and the thing worth comparing is what each one
 * actually changed. So a column is a diff summary first — files, lines added, lines removed — with
 * the transcript one click away rather than the other way round.
 *
 * # What it deliberately does not do
 *
 * It does not merge, commit, or delete anything. The two actions offered are "read this one's diff"
 * and "open its worktree as a repository", and the second is what hands the work to the git views,
 * where keeping a branch is an informed, reversible act with the whole history in front of the
 * person doing it. An automatic "keep this one" would be a merge decided by a panel that has read
 * neither the branch it is merging into nor the state of anyone's working copy.
 */
export function RacePanel({ batchId }: { batchId: string }) {
  const t = useT();
  const tasks = useAgentsStore((s) => s.tasks);
  const racers = racersOf(tasks, batchId);
  // A **boolean** out of the selector, not the live map: the tree above re-renders whenever any
  // task's live state moves, and a workspace mid-race has three agents streaming several times a
  // second. Subscribing to `live` itself would redraw every column on every token.
  const running = useAgentsStore((s) =>
    raceRunning(
      racersOf(s.tasks, batchId),
      new Set(Object.keys(s.live).filter((id) => s.live[id]?.sending)),
    ),
  );

  if (racers.length === 0) {
    return <EmptyState icon={Flag} title={t("agents.race.gone")} subtitle={t("agents.race.goneHint")} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
        <Flag size={13} className="shrink-0 text-[var(--cf-accent)]" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text-muted)]">
          {t("agents.race.header", { n: racers.length })}
          {running ? ` · ${t("agents.race.stillRunning")}` : ""}
        </span>
        <Tooltip label={t("agents.review.refresh")}>
          <button
            type="button"
            aria-label={t("agents.review.refresh")}
            onClick={() => {
              for (const task of racers) {
                void useTaskReviewStore.getState().load(task.id, task.worktree_path ?? "");
              }
            }}
            className={iconButtonClass({ size: "sm" })}
          >
            <RefreshCw size={13} />
          </button>
        </Tooltip>
      </div>

      <RunAcross racers={racers} />

      {/* Columns, scrolled sideways rather than squeezed: three agents on a 900px pane is 300px
          each, and a diff summary stops being one below about 240. */}
      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3">
        {racers.map((task) => (
          <RaceColumn key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}

function RaceColumn({ task }: { task: AgentTask }) {
  const t = useT();
  const review = useTaskReviewStore((s) => reviewOf(s, task.id));
  const sending = useAgentsStore((s) => s.live[task.id]?.sending ?? false);
  const selected = useAgentsStore((s) => s.selectedId === task.id);
  const repoPath = useWorkspaceStore((s) => {
    const projects = s.projectsByWorkspace[task.workspace_id] ?? [];
    return projects.find((project) => project.id === task.project_id)?.local_path ?? "";
  });
  // A racer runs in a worktree; a task without one is reviewed against the repository it edits.
  const path = task.worktree_path || repoPath;
  const load = useTaskReviewStore((s) => s.load);

  // Read when the column appears, and again when this racer's turn ends — a finished agent's
  // column going stale is the one thing that would make the comparison wrong rather than merely
  // incomplete.
  useEffect(() => {
    void load(task.id, path);
  }, [load, task.id, path, sending]);

  const totals = tally(review.files);
  // The live flag *or* the stored status, the same rule the race header uses: a row still saying
  // `running` after the app was killed mid-turn is a column nobody should read as finished.
  const working = sending || task.status === "running";
  const { icon: StatusIcon, color } = AGENT_STATUS[working ? "running" : task.status];
  const notes = review.comments.length;

  return (
    <div
      className={`flex w-[280px] shrink-0 flex-col overflow-hidden rounded-xl border bg-[var(--cf-surface)] ${
        selected ? "border-[var(--cf-accent)]" : "border-[var(--cf-border)]"
      }`}
    >
      <div className="shrink-0 border-b border-[var(--cf-border)] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <StatusIcon size={13} className={`shrink-0 ${color}`} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--cf-text)]">
            {agentName(task.agent_name, task.provider, t)}
          </span>
          {notes > 0 && (
            <span className="shrink-0 rounded-full bg-[var(--cf-accent-fill)] px-1.5 text-[10.5px] font-semibold tabular-nums text-[var(--cf-on-accent)]">
              {notes}
            </span>
          )}
        </div>
        {task.worktree_branch && (
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--cf-text-faint)]">
            <GitBranch size={11} className="shrink-0" />
            <span className="min-w-0 truncate font-mono">{task.worktree_branch}</span>
          </p>
        )}
      </div>

      <div className="shrink-0 px-3 py-2">
        {review.error !== "" ? (
          <p className="text-[11.5px] leading-relaxed text-[var(--cf-danger)]">{review.error}</p>
        ) : (
          <p className="flex items-baseline gap-2 text-[12px]">
            <span className="tabular-nums text-[var(--cf-text)]">
              {t("agents.race.filesN", { n: totals.files })}
            </span>
            <span className="tabular-nums text-[var(--cf-success)]">+{totals.added}</span>
            <span className="tabular-nums text-[var(--cf-danger)]">−{totals.removed}</span>
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {review.files.length === 0 && !review.loading && review.error === "" && (
          <p className="px-1.5 py-1 text-[11.5px] leading-relaxed text-[var(--cf-text-faint)]">
            {working ? t("agents.race.working") : t("agents.review.noChanges")}
          </p>
        )}
        {review.files.map((file) => (
          <div key={file.path} className="flex items-center gap-1.5 px-1.5 py-[3px]" title={file.path}>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
              {file.path}
            </span>
            <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-success)]">+{file.added}</span>
            <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-danger)]">−{file.removed}</span>
          </div>
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-t border-[var(--cf-border)] p-1.5">
        <button
          type="button"
          onClick={() => {
            // The request first: `select` is what re-renders the detail pane, and the pane reads
            // the request as it lands on this task.
            useTaskReviewStore.getState().requestTab(task.id, "review");
            void useAgentsStore.getState().select(task.id);
          }}
          className={buttonClass({ variant: "secondary", size: "sm", className: "flex-1" })}
        >
          <GitCompare size={12} />
          {t("agents.race.review")}
        </button>
        <Tooltip label={t("agents.race.openWorktreeHint")}>
          <button
            type="button"
            disabled={!task.worktree_path}
            aria-label={t("agents.openWorktreeAsRepo")}
            onClick={() => void openPathAsProject(task.worktree_path ?? "", null, task.worktree_branch || undefined)}
            className={iconButtonClass({ size: "sm" })}
          >
            <FolderGit2 size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * One line, run in every racer's worktree at once.
 *
 * This is the answer to "what is a terminal for, here": `pnpm test` typed once lands as one bench
 * tab with a pane per worktree, each shell already standing in the right folder and named after its
 * branch. The alternative — three shells opened by hand, `cd` typed into each, the command typed
 * three times — is the work the comparison is supposed to save.
 *
 * It opens the bench rather than the repository dock on purpose: the bench is in *this* view, so the
 * panes appear where the columns they belong to are.
 */
function RunAcross({ racers }: { racers: AgentTask[] }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const folders = racers.filter((task) => (task.worktree_path ?? "") !== "");

  if (folders.length === 0) return null;

  const run = () => {
    if (!workspaceId || command.trim() === "" || running) return;
    setRunning(true);
    const bench = useBenchStore.getState();
    void bench
      .runAcross(
        workspaceId,
        folders.map((task) => ({ cwd: task.worktree_path ?? "", title: task.worktree_branch || task.title })),
        command,
      )
      .then((tabId) => {
        // Shown only once there is something to show: `show` with no tab would open an empty bench
        // over the comparison.
        if (tabId) void bench.show(workspaceId, tabId);
      })
      .catch((error: unknown) => pushErrorToast(String(error)))
      .finally(() => setRunning(false));
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
      <TerminalSquare size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
      <input
        value={command}
        onChange={(event) => setCommand(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) run();
        }}
        placeholder={t("agents.race.runPlaceholder")}
        aria-label={t("agents.race.runPlaceholder")}
        className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono" })}
      />
      <Tooltip label={t("agents.race.runHint", { n: folders.length })}>
        <button
          type="button"
          disabled={command.trim() === "" || running}
          onClick={run}
          className={buttonClass({ variant: "secondary", size: "sm" })}
        >
          {t("agents.race.runAll", { n: folders.length })}
        </button>
      </Tooltip>
    </div>
  );
}
