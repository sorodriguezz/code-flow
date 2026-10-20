import { useEffect, useRef, useState } from "react";
import { Crown, LayoutGrid, Maximize2, Send, X } from "lucide-react";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import { AiRunLog } from "../../ai/AiRunLog";
import { buttonClass, iconButtonClass } from "../../common/Button";
import { EmptyState } from "../../common/EmptyState";
import { Tooltip } from "../../common/Tooltip";
import { fieldClass, toolbarClass } from "../../common/recipes";
import { BenchTerminalPane } from "../TerminalBench";
import { RowMark, ROW_STATE, TallyText, useRowLive, useRowTally } from "./rowStatus";
import { agentName } from "../agentName";
import { useAgentsStore } from "../../../state/agentsStore";
import { useBenchStore } from "../../../state/benchStore";
import { useWorktreeViewStore } from "../../../state/worktreeViewStore";
import { confirmAction } from "../../../state/confirmStore";
import { useT } from "../../../state/languageStore";
import { folderName, type WorktreeRow } from "../../../lib/agents/worktreeRows";

/**
 * Several agents at once, each in a card — the «compare» half of running agents in parallel.
 *
 * A card is the agent's own surface shrunk, not a summary of it: a CLI running in a terminal shows
 * that terminal, live; a chat shows its run's steps while it works and its last answer once it has
 * stopped. Under each, a box to answer that one agent; above them all, one box that sends the same
 * words to every agent that is free — the same follow-up typed once, which is the point of a race.
 */
export function WorktreeGrid({ rows, raceId, onOpen }: { rows: WorktreeRow[]; raceId: string | null; onOpen: (row: WorktreeRow) => void }) {
  const t = useT();
  const setDisplay = useWorktreeViewStore((s) => s.setDisplay);
  const withTask = rows.filter((row) => row.task);
  const [text, setText] = useState("");
  /** How many of the last broadcast were refused — busy, or their repository taken. */
  const [refused, setRefused] = useState(0);

  const broadcast = () => {
    const message = text.trim();
    if (message === "") return;
    const store = useAgentsStore.getState();
    let missed = 0;
    for (const row of withTask) {
      const task = row.task;
      if (!task) continue;
      if (store.live[task.id]?.sending || !store.send(task.id, message)) missed += 1;
    }
    setRefused(missed);
    setText("");
  };

  return (
    <>
      <div className={toolbarClass}>
        <LayoutGrid size={15} className="shrink-0 text-[var(--cf-accent)]" />
        <p className="min-w-0 truncate text-[14px] font-semibold">
          {raceId ? t("wt.gridRace", { n: withTask.length }) : t("wt.gridAllN", { n: withTask.length })}
        </p>
        <span className="flex-1" />
        <Tooltip label={t("wt.gridClose")}>
          <button type="button" onClick={() => setDisplay("one")} aria-label={t("wt.gridClose")} className={iconButtonClass()}>
            <X size={15} />
          </button>
        </Tooltip>
      </div>

      {withTask.length > 1 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) broadcast();
            }}
            placeholder={t("wt.broadcastPlaceholder", { n: withTask.length })}
            aria-label={t("wt.broadcastPlaceholder", { n: withTask.length })}
            className={fieldClass({ size: "sm", className: "min-w-0 flex-1" })}
          />
          <button type="button" disabled={text.trim() === ""} onClick={broadcast} className={buttonClass({ variant: "primary", size: "sm" })}>
            <Send size={12} />
            {t("wt.broadcast")}
          </button>
          {refused > 0 && <span className="shrink-0 text-[11.5px] text-[var(--cf-text-muted)]">{t("wt.broadcastRefused", { n: refused })}</span>}
        </div>
      )}

      {withTask.length === 0 ? (
        <EmptyState icon={LayoutGrid} title={t("wt.gridEmpty")} subtitle={t("wt.gridEmptyHint")} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))" }}>
            {withTask.map((row) => (
              <GridCard key={row.key} row={row} rivals={raceId ? withTask.filter((other) => other.key !== row.key) : []} onOpen={onOpen} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function GridCard({ row, rivals, onOpen }: { row: WorktreeRow; rivals: WorktreeRow[]; onOpen: (row: WorktreeRow) => void }) {
  const t = useT();
  const task = row.task;
  const { state, sending, unread } = useRowLive(row, false);
  const counted = useRowTally(row, sending);
  const mode = useWorktreeViewStore((s) => (task ? (s.agentMode[task.id] ?? "chat") : "chat"));
  const cliId = useWorktreeViewStore((s) => s.cliTerminal[row.key] ?? "");
  const terminal = useBenchStore((s) => (cliId ? (s.terminals.find((candidate) => candidate.id === cliId) ?? null) : null));
  const [reply, setReply] = useState("");

  useEffect(() => {
    if (task) void useAgentsStore.getState().ensureLoaded(task.id);
  }, [task]);

  if (!task) return null;

  const send = () => {
    const message = reply.trim();
    if (message === "") return;
    if (useAgentsStore.getState().send(task.id, message)) setReply("");
  };

  const keep = () => {
    void confirmAction(
      t("agents.race.keepConfirm", { name: agentName(task.agent_name, task.provider, t), n: rivals.length }),
      true,
      t("agents.race.keepAction"),
    ).then((ok) => {
      if (!ok) return;
      // One by one: each delete takes its own worktree with it when clean, and one failing must not
      // stop the rest — the same rule the race panel follows.
      for (const rival of rivals) if (rival.task) void useAgentsStore.getState().remove(rival.task.id);
    });
  };

  return (
    <div
      className={`flex h-[340px] min-w-0 flex-col overflow-hidden rounded-lg border bg-[var(--cf-surface)] ${
        state === "asking" ? "border-[var(--cf-warning)]" : "border-[var(--cf-border)]"
      }`}
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] pl-2.5 pr-1">
        <RowMark row={row} state={state} size={13} />
        <span className="min-w-0 truncate font-mono text-[12.5px] font-semibold">{row.branch || folderName(row.path)}</span>
        <ProviderGlyph providerId={task.provider} size={12} />
        <span className={`shrink-0 text-[11.5px] ${ROW_STATE[state].color}`}>{t(ROW_STATE[state].labelKey)}</span>
        {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--cf-accent)]" />}
        <span className="flex-1" />
        <TallyText value={counted} />
        {rivals.length > 0 && (
          <Tooltip label={t("agents.race.keepHint", { n: rivals.length })}>
            <button type="button" onClick={keep} aria-label={t("agents.race.keep")} className={iconButtonClass({ size: "sm" })}>
              <Crown size={13} />
            </button>
          </Tooltip>
        )}
        <Tooltip label={t("wt.gridOpen")}>
          <button type="button" onClick={() => onOpen(row)} aria-label={t("wt.gridOpen")} className={iconButtonClass({ size: "sm" })}>
            <Maximize2 size={13} />
          </button>
        </Tooltip>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {mode === "cli" && terminal ? (
          <BenchTerminalPane bare terminal={terminal} visible focused={false} onFocus={() => undefined} onClose={() => undefined} />
        ) : (
          <CardTranscript taskId={task.id} goal={task.goal} />
        )}
      </div>

      {!(mode === "cli" && terminal) && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-[var(--cf-border)] p-1.5">
          <input
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
            }}
            disabled={sending}
            placeholder={t("wt.replyPlaceholder")}
            aria-label={t("wt.replyPlaceholder")}
            className={fieldClass({ size: "sm", className: "min-w-0 flex-1" })}
          />
          <button type="button" disabled={sending || reply.trim() === ""} onClick={send} aria-label={t("chat.send")} className={iconButtonClass({ size: "sm" })}>
            <Send size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

/** While a turn runs, its steps; once it has stopped, the last answer — or the goal, before any. */
function CardTranscript({ taskId, goal }: { taskId: string; goal: string }) {
  const live = useAgentsStore((s) => s.live[taskId]);
  const scroller = useRef<HTMLDivElement>(null);
  const last = [...(live?.messages ?? [])].reverse().find((message) => message.role === "assistant");
  const sending = live?.sending ?? false;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [last?.content, sending]);

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
      {sending && live?.runId ? (
        <AiRunLog runId={live.runId} running startedAt={live.runStartedAt} density="panel" defaultOpen />
      ) : (
        <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--cf-text-muted)]">{last?.content || goal}</p>
      )}
    </div>
  );
}
