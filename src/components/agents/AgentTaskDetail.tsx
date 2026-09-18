import { useEffect, useRef, useState } from "react";
import {
  Bot,
  CircleCheck,
  GitCompare,
  Link2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import { AGENT_STATUS } from "./agentStatus";
import { AgentModelMenu } from "./AgentModelMenu";
import { ChainStrip } from "./ChainStrip";
import { ContinueWithModal } from "./ContinueWithModal";
import { useChainStore } from "../../state/chainStore";
import { AiRunLog } from "../ai/AiRunLog";
import { ChatMessageBubble } from "../chat/ChatMessageBubble";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { Select } from "../common/Select";
import { useAgentsStore } from "../../state/agentsStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { useUiStore } from "../../state/uiStore";
import { useActiveProjects, useWorkspaceStore } from "../../state/workspaceStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";

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
  const [continuing, setContinuing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [logExpanded, setLogExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = live?.messages ?? [];
  const sending = live?.sending ?? false;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, sending, taskId]);

  // The overflow menu portals to `document.body`, and this view is hidden rather than unmounted —
  // left open, it would float over whatever the user switched to.
  useEffect(() => {
    if (activeView !== "agents") setMenu(null);
  }, [activeView]);

  if (!task) return null;

  const status = sending ? "running" : task.status;
  const { icon: StatusIcon, color, labelKey } = AGENT_STATUS[status];
  // Once a turn has run, the engine session and the files it touched both belong to this repo.
  const locked = task.turns > 0;

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
    {
      // Only once it has said something: a chain seeded with an empty handoff is the one shape
      // this feature refuses to produce.
      label: t("agents.continueWith"),
      icon: Link2,
      separated: true,
      onClick: () => setContinuing(true),
    },
    {
      label: t("agents.openChanges"),
      icon: GitCompare,
      // Whatever the agent changed is in that repository's working copy, and reviewing it is the
      // Changes view's job — reimplementing a diff here would be a second one to keep in step.
      onClick: () => {
        void focusProject(task.workspace_id, task.project_id).then(() => setActiveView("changes"));
      },
    },
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
      {/* 29px to the pixel, like every other panel header in the app (`px-2 py-1` around a 20px
          toolbar button): the three columns of this view sit in one flex row, so a middle bar that
          sizes itself off its own title lands its text and its bottom rule several pixels below the
          rails either side of it. Height fixed rather than padded, because the tallest thing in here
          is the 24px repository picker, which a 20px content box would squash. */}
      <div className="flex h-[29px] shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
        <Bot size={14} className="shrink-0 text-[var(--cf-accent)]" />

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
            className="min-w-0 flex-1 rounded-md border border-[var(--cf-accent)] bg-transparent px-1.5 py-0.5 text-[12px] outline-none"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => setRenaming(task.title)}
            title={task.goal || task.title}
            className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold"
          >
            {task.title || t("agents.newTask")}
          </button>
        )}

        <span className={`flex shrink-0 items-center gap-1.5 text-[11px] ${color}`}>
          {status === "running" ? <ThinkingOrb size="sm" /> : <StatusIcon size={12} />}
          <span className="truncate">{t(labelKey)}</span>
        </span>
        {task.turns > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
            {t("agents.turnsN", { n: task.turns })}
          </span>
        )}

        <span className="w-[180px] shrink-0" title={locked ? t("agents.repoLocked") : t("agents.repositoryHint")}>
          <Select
            size="sm"
            disabled={locked}
            value={task.project_id}
            ariaLabel={t("agents.repository")}
            onChange={(value) => void useAgentsStore.getState().setProject(taskId, value)}
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
          />
        </span>

        <button
          type="button"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.right - 4, y: rect.bottom + 2 });
          }}
          title={t("api.moreActions")}
          aria-label={t("api.moreActions")}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
        >
          <MoreHorizontal size={13} />
        </button>
      </div>

      <ChainStrip taskId={taskId} />

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !sending && (
          <p className="whitespace-pre-wrap rounded-lg border border-dashed border-[var(--cf-border)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
            {task.goal}
          </p>
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
            expanded={logExpanded}
            onToggle={() => setLogExpanded((v) => !v)}
          />
        )}
      </div>

      <AgentComposer taskId={taskId} />

      {menu && <ContextMenu x={menu.x} y={menu.y} items={overflow} onClose={() => setMenu(null)} />}
      {continuing && <ContinueWithModal taskId={taskId} onClose={() => setContinuing(false)} />}
    </>
  );
}

/** Enter sends, Shift+Enter breaks the line — the same contract as the AI panel's chat box. */
function AgentComposer({ taskId }: { taskId: string }) {
  const t = useT();
  const task = useAgentsStore((s) => s.tasks.find((candidate) => candidate.id === taskId) ?? null);
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

  if (!task) return null;

  const submit = () => {
    if (!input.trim() || sending || blockedBy || chainLocked) return;
    useAgentsStore.getState().send(taskId, input);
    setInput("");
  };

  return (
    <div className="shrink-0 border-t border-[var(--cf-border)] px-3 py-2">
      <textarea
        value={input}
        rows={3}
        disabled={chainLocked}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={chainLocked ? t("agents.chainComposerLocked") : t("agents.followUpPlaceholder")}
        className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <AgentModelMenu taskId={taskId} />
        {blockedBy && (
          <span className="min-w-0 truncate text-[10.5px] text-[var(--cf-warning)]">
            {t("agents.busyInRepo", { name: repoName })}
          </span>
        )}
        {sending ? (
          <button
            type="button"
            onClick={() => void useAgentsStore.getState().stop(taskId)}
            disabled={cancelling}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)] disabled:opacity-50"
          >
            <Square size={9} className="fill-current" />
            {cancelling ? t("ai.stopping") : t("ai.stop")}
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!input.trim() || blockedBy !== null || chainLocked}
            title={t("agents.send")}
            aria-label={t("agents.send")}
            className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--cf-accent)] text-white hover:brightness-110 disabled:opacity-40"
          >
            <Send size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
