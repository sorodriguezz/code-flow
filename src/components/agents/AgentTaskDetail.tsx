import { useEffect, useRef, useState } from "react";
import {
  Bot,
  CircleCheck,
  FolderOpen,
  GitBranch,
  GitCompare,
  History,
  Flag,
  Frame,
  Link2,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCcw,
  Send,
  Square,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { AGENT_STATUS } from "./agentStatus";
import { AgentModelMenu } from "./AgentModelMenu";
import { TaskPlanningBar, planningMenuItems } from "./taskPlanning";
import { ChainStrip } from "./ChainStrip";
import { ContinueWithModal } from "./ContinueWithModal";
import { RacePanel } from "./RacePanel";
import { TaskReviewPanel } from "./TaskReviewPanel";
import { useChainStore } from "../../state/chainStore";
import { AiRunLog } from "../ai/AiRunLog";
import { CheckpointsModal } from "../ai/CheckpointsModal";
import { ChatMessageBubble } from "../chat/ChatMessageBubble";
import { buttonClass, iconButtonClass } from "../common/Button";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { fieldClass, toolbarClass } from "../common/recipes";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { Tooltip } from "../common/Tooltip";
import { registerDictationSend } from "../../state/dictationStore";
import { DictationBar, DictationMic, useDictatingHere } from "../dictation/DictationControls";
import { useAgentsStore } from "../../state/agentsStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { reviewOf, useTaskReviewStore, type TaskTab } from "../../state/taskReviewStore";
import { useTerminalStore } from "../../state/terminalStore";
import { useUiStore } from "../../state/uiStore";
import { useActiveProjects, useWorkspaceStore } from "../../state/workspaceStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { scrollBehavior } from "../../lib/motion";
import { revealInFileManager } from "../../lib/tauri/commands";
import { openPathAsProject } from "../../lib/openAsProject";
import { buildDesignNote, shortLabel } from "../../lib/agents/designNote";
import { useDesignStore } from "../../state/designStore";
import { promptAction } from "../../state/promptStore";

/**
 * One task, open: who is doing it, where, what has been said so far, and the box to say the next
 * thing.
 *
 * The header carries the two facts that decide what a turn will actually do — the agent and the
 * repository — because both are fixed the moment the task has run and it should be obvious *before*
 * that, not discovered afterwards. The repository especially: an agent edits that working copy
 * directly, and the picker naming it is what says so.
 */
export function AgentTaskDetail({ taskId }: { taskId: string }) {
  const t = useT();
  const task = useAgentsStore((s) => s.tasks.find((candidate) => candidate.id === taskId) ?? null);
  const live = useAgentsStore((s) => s.live[taskId]);
  const projects = useActiveProjects();
  const setActiveView = useUiStore((s) => s.setActiveView);
  const activeView = useUiStore((s) => s.activeView);
  const focusProject = useWorkspaceStore((s) => s.focusProject);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** The transcript, or the review of what the agent changed. Reset on every task: a task opened
   *  from a notification should land on what was said, not on a diff of a repository the reader has
   *  not placed yet. */
  const [tab, setTab] = useState<TaskTab>("chat");
  const [continuing, setContinuing] = useState(false);
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = live?.messages ?? [];
  const sending = live?.sending ?? false;
  // The working copy the turns edit — where its restore points live. Read off the task's own
  // workspace rather than the one on screen: a task opened from a notification can belong to
  // another one.
  const repo = useWorkspaceStore((s) =>
    task ? ((s.projectsByWorkspace[task.workspace_id] ?? []).find((p) => p.id === task.project_id) ?? null) : null,
  );
  // A task with a worktree of its own edits that folder, so its restore points are there too.
  const worktree = task?.worktree_path ?? "";
  const repoPath = worktree || (repo?.local_path ?? "");
  // Another task already running in this repository — the Run button waits for it like the
  // composer's send does.
  const repoTaken = useAgentsStore((s) => (task ? s.runningInProject(task.project_id, task.id) !== null : false));
  /** What the review tab has waiting to be sent — drawn on its segment, so a review left half
   *  written is visible from the transcript. */
  const pendingNotes = useTaskReviewStore((s) => {
    const review = reviewOf(s, taskId);
    return review.comments.length + (review.general.trim() === "" ? 0 : 1);
  });

  useEffect(() => setTab("chat"), [taskId]);
  // «Review this one» in the race panel lands here: it selects the task and leaves a request, which
  // this consumes. After the reset above, so the request wins over it on the render that arrives
  // with the new task.
  const takeOpenRequest = useTaskReviewStore((s) => s.takeOpenRequest);
  useEffect(() => {
    const asked = takeOpenRequest(taskId);
    if (asked) setTab(asked);
  }, [takeOpenRequest, taskId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: scrollBehavior() });
  }, [messages.length, sending, taskId]);

  // The overflow menu portals to `document.body`, and this view is hidden rather than unmounted —
  // left open, it would float over whatever the user switched to.
  useEffect(() => {
    if (activeView !== "agents") setMenu(null);
  }, [activeView]);

  if (!task) return null;

  const status = sending ? "running" : task.status;
  const { icon: StatusIcon, color, labelKey } = AGENT_STATUS[status];
  // Once a turn has run, the engine session and the files it touched both belong to this repo. A
  // worktree belongs to the repository it was made from from the start.
  const locked = task.turns > 0 || !!worktree;
  /** The review replaces the transcript *and* its composer: see `TaskReviewPanel`. Guarded by the
   *  same condition the control is, so a tab left on the review cannot outlive it. */
  const reviewing = tab === "review" && repoPath !== "" && task.turns > 0;
  /** The race this task was started as part of, or `""` — see `lib/agents/race`. */
  const raceId = (task.batch_id ?? "").trim();

  const commitRename = () => {
    if (renaming !== null) void useAgentsStore.getState().rename(taskId, renaming);
    setRenaming(null);
  };

  const overflow: MenuItem[] = [
    {
      label: t("agents.rename"),
      icon: Pencil,
      onClick: () => setRenaming(task.title),
    },
    {
      label: t(status === "done" ? "agents.reopen" : "agents.markDone"),
      icon: status === "done" ? RotateCcw : CircleCheck,
      onClick: () => void useAgentsStore.getState().setStatus(taskId, status === "done" ? "idle" : "done"),
    },
    // A chain's step is archived with its plan, never alone.
    ...planningMenuItems(
      task,
      t,
      Object.values(useChainStore.getState().briefsByChain).some((briefs) => briefs.some((brief) => brief.task_id === taskId)),
    ),
    {
      // Only once it has said something: a chain seeded with an empty handoff is the one shape
      // this feature refuses to produce.
      label: t("agents.continueWith"),
      icon: Link2,
      separated: true,
      onClick: () => setContinuing(true),
    },
    // Whatever the agent changed is in the repository's working copy, and reviewing it there — with
    // staging, discarding and committing to hand — is the Changes view's job. The review tab beside
    // the transcript is the other half of the same answer, and the only one a worktree task has.
    ...(worktree
      ? [
          {
            // The review tab reads the *uncommitted* diff. An agent that committed its work leaves
            // that clean, and the commits are on the worktree's own branch — which only the git
            // views can read, and only once the folder is a repository of this workspace.
            label: t("agents.openWorktreeAsRepo"),
            icon: GitBranch,
            onClick: () => {
              void openPathAsProject(worktree, null, task.worktree_branch || undefined).then(() =>
                setActiveView("changes"),
              );
            },
          },
          {
            // Its edits are in its own folder, not in the repository's working copy the Changes view
            // shows; the branch carries them back once committed.
            label: t("agents.revealWorktree"),
            icon: FolderOpen,
            onClick: () => void revealInFileManager(worktree),
          },
        ]
      : [
          {
            label: t("agents.openChanges"),
            icon: GitCompare,
            onClick: () => {
              void focusProject(task.workspace_id, task.project_id).then(() => setActiveView("changes"));
            },
          },
        ]),
    {
      // Design mode: the app this task is editing, in a window, with alt-click picking the element
      // to talk about. The address is asked for rather than guessed — a dev server's port is the
      // one thing this app cannot know — and remembered for next time.
      label: t("design.open"),
      icon: Frame,
      onClick: () => {
        const store = useDesignStore.getState();
        void promptAction(t("design.urlPrompt"), {
          initial: store.lastUrl || "http://localhost:1420",
          placeholder: "http://localhost:1420",
          confirmLabel: t("design.openAction"),
          validate: (value) =>
            /^https?:\/\/\S+$/.test(value.trim()) ? null : t("design.urlInvalid"),
        }).then((url) => {
          if (url) void store.show(url);
        });
      },
    },
    ...(repoPath
      ? [
          {
            // A shell standing where the agent worked: the one thing a reviewer reaches for that
            // neither the diff nor the transcript can do — run the tests, see it fail, say so.
            label: t("agents.openTerminalHere"),
            icon: TerminalSquare,
            onClick: () => {
              void focusProject(task.workspace_id, task.project_id).then(async () => {
                await useTerminalStore
                  .getState()
                  .openNew(task.project_id, repoPath, { title: task.worktree_branch || repo?.name });
                setActiveView("changes");
              });
            },
          },
        ]
      : []),
    // Every turn takes a restore point before it edits anything; this is where an agent's edits are
    // undone from, without leaving the task for the AI panel. The same list the panel opens.
    ...(repoPath
      ? [
          {
            label: t("checkpoints.title"),
            icon: History,
            onClick: () => setCheckpointsOpen(true),
          },
        ]
      : []),
    {
      label: t("agents.deleteTask"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: () => {
        void confirmAction(t("agents.deleteConfirm", { name: task.title })).then((ok) => {
          if (ok) void useAgentsStore.getState().remove(taskId);
        });
      },
    },
  ];

  return (
    <>
      {/* The shared 44px toolbar, level with the explorer's head beside it: the columns of this
          view sit in one flex row, so a middle bar that sized itself off its own title would land
          its text and its bottom rule off the line the rails either side of it draw. The status is
          words and a static glyph — while a turn runs, the orb is on the task's row in the tree and
          on the run card below, and a third copy up here would only add motion. */}
      <div className={toolbarClass}>
        <Bot size={16} className="shrink-0 text-[var(--cf-accent)]" />

        {renaming !== null ? (
          <input
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(null);
            }}
            className={fieldClass({ size: "sm", className: "flex-1 font-semibold" })}
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => setRenaming(task.title)}
            title={task.goal || task.title}
            className="min-w-0 flex-1 truncate rounded-md text-left text-[14px] font-semibold"
          >
            {task.title || t("agents.newTask")}
          </button>
        )}

        {/* Only once there is something beside the transcript to look at: a task on its first turn
            has no diff, and a control whose other half is always empty teaches the wrong thing
            about where changes show up. A racer is the exception — its race is worth reading before
            it has said anything itself. */}
        {(raceId !== "" || (repoPath !== "" && task.turns > 0)) && (
          <Segmented
            size="sm"
            layoutId={`task-tab-${taskId}`}
            value={tab}
            onChange={setTab}
            ariaLabel={t("agents.review.tabs")}
            options={[
              { value: "chat", icon: MessagesSquare, title: t("agents.review.conversation") },
              {
                value: "review",
                icon: GitCompare,
                title: t("agents.review.tab"),
                // A task that has not run has nothing to review; its race may still have.
                disabled: repoPath === "" || task.turns === 0,
                label:
                  pendingNotes > 0 ? (
                    <span className="tabular-nums">{pendingNotes}</span>
                  ) : undefined,
              },
              // Only for a task that was started as one of several on the same goal: there is
              // nothing to compare a task against itself.
              ...(raceId !== ""
                ? [{ value: "race" as const, icon: Flag, title: t("agents.race.tab") }]
                : []),
            ]}
          />
        )}

        <span className={`flex shrink-0 items-center gap-1.5 text-[12px] font-medium ${color}`}>
          <StatusIcon size={14} />
          <span className="truncate">{t(labelKey)}</span>
        </span>
        {task.turns > 0 && (
          <span className="shrink-0 text-[12px] tabular-nums text-[var(--cf-text-faint)]">
            {t("agents.turnsN", { n: task.turns })}
          </span>
        )}

        {worktree && (
          <Tooltip label={t("agents.worktreeAt", { path: worktree })}>
            <span className="flex min-w-0 max-w-[200px] shrink items-center gap-1 text-[12px] text-[var(--cf-text-muted)]">
              <GitBranch size={13} className="shrink-0" />
              <span className="truncate font-mono text-[11.5px]">{task.worktree_branch}</span>
            </span>
          </Tooltip>
        )}

        <Tooltip label={locked ? t("agents.repoLocked") : t("agents.repositoryHint")}>
          <span className="w-[180px] shrink-0">
            <Select
              size="sm"
              disabled={locked}
              value={task.project_id}
              ariaLabel={t("agents.repository")}
              onChange={(value) => void useAgentsStore.getState().setProject(taskId, value)}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
            />
          </span>
        </Tooltip>

        <Tooltip label={t("api.moreActions")}>
          <button
            type="button"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right - 4, y: rect.bottom + 2 });
            }}
            aria-haspopup="menu"
            aria-label={t("api.moreActions")}
            className={iconButtonClass()}
          >
            <MoreHorizontal size={15} />
          </button>
        </Tooltip>
      </div>

      <TaskPlanningBar task={task} />
      <ChainStrip taskId={taskId} />

      {tab === "race" && raceId !== "" ? (
        <RacePanel batchId={raceId} />
      ) : reviewing ? (
        <TaskReviewPanel taskId={taskId} repoPath={repoPath} />
      ) : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {/* One column of a readable width, like every transcript in the app. */}
            <div className="mx-auto w-full max-w-[760px] space-y-3.5">
              {messages.length === 0 && !sending && (
                <div className="rounded-lg border border-dashed border-[var(--cf-border-strong)] px-3.5 py-3">
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--cf-text-muted)]">{task.goal}</p>
                  {/* A task that has never run — its first turn was refused because the repository was
                      busy, or it was never sent — has its goal on screen and nothing that sends it. The
                      composer below would work, but only by retyping the goal into it. */}
                  {task.turns === 0 && live?.loaded !== false && (
                    <Tooltip label={repoTaken ? t("agents.busyInRepo", { name: repo?.name ?? "" }) : t("agents.runTaskHint")}>
                      <button
                        type="button"
                        disabled={repoTaken || !task.goal.trim()}
                        onClick={() => void useAgentsStore.getState().send(taskId, task.goal)}
                        className={buttonClass({ variant: "primary", size: "sm", className: "mt-2.5" })}
                      >
                        <Play size={12} />
                        {t("agents.runTask")}
                      </button>
                    </Tooltip>
                  )}
                </div>
              )}
              {messages.map((message, i) => (
                // The panel's own bubble, lifted into `components/chat` and shared by all three
                // transcripts. `stamp="compact"` is what this thread has always drawn: the header above
                // already names the agent, the repository and the model, and repeating the duration and
                // the CLI version under every turn was noise here in a way it is not in the AI panel.
                <ChatMessageBubble key={i} message={message} stamp="compact" />
              ))}
              {sending && live?.runId && (
                <AiRunLog
                  runId={live.runId}
                  running
                  startedAt={live.runStartedAt}
                />
              )}
            </div>
          </div>
          <DesignPickCard taskId={taskId} />
          <AgentComposer taskId={taskId} />
        </>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={overflow} onClose={() => setMenu(null)} />}
      {continuing && <ContinueWithModal taskId={taskId} onClose={() => setContinuing(false)} />}
      {checkpointsOpen && repoPath && (
        <CheckpointsModal repoPath={repoPath} onClose={() => setCheckpointsOpen(false)} />
      )}
    </>
  );
}

/** Enter sends, Shift+Enter breaks the line — the same contract as the AI panel's chat box. */
function AgentComposer({ taskId }: { taskId: string }) {
  const t = useT();
  const task = useAgentsStore((s) => s.tasks.find((candidate) => candidate.id === taskId) ?? null);
  // A hybrid run's execute step: this app runs it from the chain, against the local model, and there
  // is no engine here anyone could follow up with — so the box and the model menu are not offered.
  const localExec = task?.provider === "local-exec";
  const live = useAgentsStore((s) => s.live[taskId]);
  const runId = live?.runId ?? null;
  const cancelling = useAiRunStore((s) => (runId ? (s.cancelling[runId] ?? false) : false));
  // Subscribed rather than read once: another task in the same repository can start at any moment,
  // and the send button has to go dead when it does. A primitive, so the selector stays stable.
  const blockedBy = useAgentsStore((s) => {
    if (!task) return null;
    const other = s.tasks.find(
      (candidate) =>
        candidate.project_id === task.project_id &&
        candidate.id !== taskId &&
        (s.live[candidate.id]?.sending ?? false),
    );
    return other?.id ?? null;
  });
  const repoName = useWorkspaceStore((s) => {
    const projects = s.activeWorkspaceId ? (s.projectsByWorkspace[s.activeWorkspaceId] ?? []) : [];
    return projects.find((p) => p.id === task?.project_id)?.name ?? "";
  });
  // A chain step's answer is what gets handed to the next agent, so a follow-up typed here while
  // the chain is mid-step would silently not be the thing that carries forward. The box locks; the
  // Stop button below does not, because it is the only way to halt an agent that is editing files.
  const chainLocked = useChainStore((s) => {
    for (const chain of s.chains) {
      if (chain.status !== "running") continue;
      if ((s.stepsByChain[chain.id] ?? []).some((step) => step.task_id === taskId)) return true;
    }
    return false;
  });
  // Always starts empty. The goal is already on screen — as the dashed block above while nothing
  // has run, and as the user's own bubble the moment the first turn is sent — so a copy down here
  // was duplicate text that read as an unsent draft sitting under a turn already in flight.
  //
  // It used to be seeded from `task.goal` and then cleared by watching for the first turn to start,
  // which made an empty composer depend on winning a race: the dialog creates the task and sends
  // its goal as two store writes, and this box mounts somewhere in between. Nothing is left for the
  // seed to serve either — `NewTaskModal` sends the goal as it creates the task, and no code path
  // produces `status: "draft"`, so there is no such thing as a task waiting to be sent.
  const [input, setInput] = useState("");
  const sending = live?.sending ?? false;
  // A follow-up the backend turned away (another turn took the repository first) comes back here,
  // unless something new has been typed since — that is the user's newer thought, and wins.
  const bounced = useAgentsStore((s) => s.bounced[taskId]);
  useEffect(() => {
    if (bounced === undefined) return;
    const text = useAgentsStore.getState().takeBounced(taskId);
    if (text) setInput((current) => (current.trim() ? current : text));
  }, [bounced, taskId]);

  // «Dictar», above the early return so the hooks run on every render: stop-and-send runs the
  // submit of the render that holds the transcript, registered again each render because the box
  // is not there while the task is loading.
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const submitRef = useRef<() => void>(() => {});
  useEffect(() => registerDictationSend(boxRef.current, () => submitRef.current()));
  const dictating = useDictatingHere(boxRef);

  if (!task) return null;

  const submit = () => {
    if (!input.trim() || sending || blockedBy || chainLocked || localExec) return;
    // Cleared only for a send the store took: its guards are read fresh and can refuse one that
    // `blockedBy` — a render behind — waved through, and emptying the box then lost the message.
    if (useAgentsStore.getState().send(taskId, input)) setInput("");
  };
  submitRef.current = submit;

  return (
    // A card rather than a box under a rule: the field and the controls that decide how it is sent
    // (the model, the send) read as one object, the way the chat's composer does.
    <div className="shrink-0 px-4 pb-4 pt-2">
      <div className="mx-auto w-full max-w-[760px] rounded-[12px] border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 pb-2 pt-2.5 shadow-[var(--cf-shadow-lift)] transition-[border-color,box-shadow] duration-100 focus-within:border-[var(--cf-accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]">
        <textarea
          ref={boxRef}
          data-ai-input="inline"
          value={input}
          rows={3}
          disabled={chainLocked || localExec}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Not while an IME is composing: that Enter confirms a candidate (Japanese, Chinese,
            // accented input on some layouts), and sending there shipped half a word. `keyCode 229`
            // is the same condition for the WebKit builds that report it instead — the same guard
            // the chat and panel composers use.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            localExec
              ? t("agents.localExecComposerLocked")
              : chainLocked
                ? t("agents.chainComposerLocked")
                : t("agents.followUpPlaceholder")
          }
          aria-label={t("agents.followUpPlaceholder")}
          className="block w-full resize-none bg-transparent text-[13px] leading-relaxed text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)] disabled:opacity-50"
        />
        {dictating ? (
          <div className="mt-1.5 flex items-center gap-2">
            <DictationBar />
          </div>
        ) : (
        <div className="mt-1.5 flex items-center gap-2">
          {!localExec && <AgentModelMenu taskId={taskId} />}
          {blockedBy && (
            <span className="min-w-0 truncate text-[11px] text-[var(--cf-warning)]">
              {t("agents.busyInRepo", { name: repoName })}
            </span>
          )}
          {sending ? (
            <button
              type="button"
              onClick={() => void useAgentsStore.getState().stop(taskId)}
              disabled={cancelling}
              className={buttonClass({ variant: "secondary", size: "sm", className: "ml-auto" })}
            >
              <Square size={10} className="fill-current" />
              {cancelling ? t("ai.stopping") : t("ai.stop")}
            </button>
          ) : (
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {!(chainLocked || localExec) && <DictationMic field={boxRef} className="h-7 w-7" iconSize={14} />}
              <Tooltip label={t("agents.send")}>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!input.trim() || blockedBy !== null || chainLocked || localExec}
                  aria-label={t("agents.send")}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--cf-accent-fill)] text-[var(--cf-on-accent)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-accent-fill)_86%,var(--cf-text))] disabled:pointer-events-none disabled:opacity-40"
                >
                  <Send size={14} />
                </button>
              </Tooltip>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

/**
 * The element picked in design mode, offered to this task.
 *
 * It sits directly above the composer because that is what it becomes: a turn. Drawn only while
 * there is a pick, and cleared by sending it or by dismissing it — see `designStore` for why only
 * the last one is kept.
 */
function DesignPickCard({ taskId }: { taskId: string }) {
  const t = useT();
  const pick = useDesignStore((s) => s.pick);
  const sending = useAgentsStore((s) => s.live[taskId]?.sending ?? false);
  if (!pick) return null;

  const send = () => {
    const message = buildDesignNote(pick, {
      intro: t("design.noteIntro"),
      markup: t("design.noteMarkup"),
      styles: t("design.noteStyles"),
      where: t("design.noteWhere"),
    });
    // Cleared only on a send the store took: a refused turn that dropped the pick would mean
    // walking back to the preview and picking it again.
    if (message && useAgentsStore.getState().send(taskId, message)) useDesignStore.getState().clear();
  };

  return (
    <div className="shrink-0 px-4 pt-2">
      <div className="mx-auto flex w-full max-w-[760px] items-center gap-2 rounded-lg border border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] px-3 py-1.5">
        <Frame size={13} className="shrink-0 text-[var(--cf-accent)]" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--cf-text)]">
          {shortLabel(pick.selector)}
        </span>
        <button
          type="button"
          disabled={sending}
          onClick={send}
          className={buttonClass({ variant: "primary", size: "sm" })}
        >
          {t("design.sendToAgent")}
        </button>
        <button
          type="button"
          onClick={() => useDesignStore.getState().clear()}
          className={buttonClass({ variant: "ghost", size: "sm" })}
        >
          {t("design.dismiss")}
        </button>
      </div>
    </div>
  );
}
