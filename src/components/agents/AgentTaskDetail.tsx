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
import { buttonClass, iconButtonClass } from "../common/Button";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { fieldClass, toolbarClass } from "../common/recipes";
import { Select } from "../common/Select";
import { Tooltip } from "../common/Tooltip";
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

        <span className={`flex shrink-0 items-center gap-1.5 text-[12px] font-medium ${color}`}>
          <StatusIcon size={14} />
          <span className="truncate">{t(labelKey)}</span>
        </span>
        {task.turns > 0 && (
          <span className="shrink-0 text-[12px] tabular-nums text-[var(--cf-text-faint)]">
            {t("agents.turnsN", { n: task.turns })}
          </span>
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

      <ChainStrip taskId={taskId} />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {/* One column of a readable width, like every transcript in the app. */}
        <div className="mx-auto w-full max-w-[760px] space-y-3.5">
          {messages.length === 0 && !sending && (
            <p className="whitespace-pre-wrap rounded-lg border border-dashed border-[var(--cf-border-strong)] px-3.5 py-3 text-[13px] leading-relaxed text-[var(--cf-text-muted)]">
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
    // A card rather than a box under a rule: the field and the controls that decide how it is sent
    // (the model, the send) read as one object, the way the chat's composer does.
    <div className="shrink-0 px-4 pb-4 pt-2">
      <div className="mx-auto w-full max-w-[760px] rounded-[12px] border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 pb-2 pt-2.5 shadow-[var(--cf-shadow-lift)] transition-[border-color,box-shadow] duration-100 focus-within:border-[var(--cf-accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]">
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
          aria-label={t("agents.followUpPlaceholder")}
          className="block w-full resize-none bg-transparent text-[13px] leading-relaxed text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)] disabled:opacity-50"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <AgentModelMenu taskId={taskId} />
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
            <Tooltip label={t("agents.send")}>
              <button
                type="button"
                onClick={submit}
                disabled={!input.trim() || blockedBy !== null || chainLocked}
                aria-label={t("agents.send")}
                className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--cf-accent)] text-[var(--cf-on-accent)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-accent)_86%,var(--cf-text))] disabled:pointer-events-none disabled:opacity-40"
              >
                <Send size={14} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
