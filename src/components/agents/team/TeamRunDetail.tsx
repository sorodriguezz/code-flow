import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, CircleHelp, GitBranch, MessagesSquare, Network, Pause, Play, Send, Square, Trash2, Users, X } from "lucide-react";
import { GhostButton, PrimaryButton } from "../../api/ApiModal";
import { Select } from "../../common/Select";
import { fieldClass } from "../../common/recipes";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import { AiRunLog } from "../../ai/AiRunLog";
import { ThinkingOrb } from "../../common/ThinkingOrb";
import { useAgentsStore } from "../../../state/agentsStore";
import { useTeamStore } from "../../../state/teamStore";
import { useT } from "../../../state/languageStore";
import type { TeamItem, TeamMessage, TeamRunState } from "../../../types/team";
import { itemKindKey, memberColor, messageKindKey, statusTone } from "./teamLook";

const TeamGraph = lazy(() => import("./TeamGraph"));

type View = "graph" | "channel" | "members";

/**
 * One team run: what it waits for, and three views of the same state — the graph (who works on
 * what, what waits on what), the channel (every handoff, question, review and decision, in order)
 * and the members side by side with what each one is doing right now.
 */
export function TeamRunDetail({ runId }: { runId: string }) {
  const t = useT();
  const state = useTeamStore((s) => s.states[runId]);
  const [view, setView] = useState<View>("graph");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    void useTeamStore.getState().refresh(runId);
  }, [runId]);

  if (!state) return <div className="flex h-full items-center justify-center text-[12px] text-[var(--cf-text-muted)]">{"…"}</div>;
  const { run } = state;
  const questions = state.messages.filter((m) => m.kind === "question" && m.to_id === "user" && !m.answer);
  const tone = statusTone(run.status);
  const store = useTeamStore.getState();
  const selectedItem = state.items.find((i) => i.id === selected) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <Users size={15} className="shrink-0 text-[var(--cf-text-muted)]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{run.title}</p>
          <p className="truncate text-[11px] text-[var(--cf-text-muted)]">
            {run.team_name} · <span className={tone.text}>{t(`team.runStatus.${run.status}` as never)}</span> · {t("team.dispatches", { n: String(run.dispatches), max: String(run.policy.max_dispatches) })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-[var(--cf-border)] p-0.5">
          <ViewButton active={view === "graph"} onClick={() => setView("graph")} icon={<Network size={13} />} label={t("team.viewGraph")} />
          <ViewButton active={view === "channel"} onClick={() => setView("channel")} icon={<MessagesSquare size={13} />} label={t("team.viewChannel")} badge={questions.length} />
          <ViewButton active={view === "members"} onClick={() => setView("members")} icon={<Users size={13} />} label={t("team.viewMembers")} />
        </div>
        {run.status === "running" && (
          <IconButton title={t("team.pause")} onClick={() => void store.control(runId, "pause")}>
            <Pause size={14} />
          </IconButton>
        )}
        {run.status === "paused" && (
          <IconButton title={t("team.resume")} onClick={() => void store.control(runId, "resume")}>
            <Play size={14} />
          </IconButton>
        )}
        {(run.status === "running" || run.status === "paused" || run.status === "gated") && (
          <IconButton title={t("team.abort")} onClick={() => void store.control(runId, "abort")}>
            <Square size={13} />
          </IconButton>
        )}
        <IconButton
          title={t("team.deleteRun")}
          onClick={() => {
            if (window.confirm(t("team.deleteRunConfirm"))) void store.removeRun(runId);
          }}
        >
          <Trash2 size={14} />
        </IconButton>
        <IconButton title={t("common.close")} onClick={() => void store.select(null)}>
          <X size={14} />
        </IconButton>
      </header>

      <RepoStrip state={state} />
      {run.status === "gated" && <GateBanner state={state} />}
      {run.status === "paused" && run.last_reason && <p className="shrink-0 border-b border-[var(--cf-border)] px-3 py-1.5 text-[11.5px] text-[var(--cf-warning)]">{t(run.last_reason as never)}</p>}
      {questions.length > 0 && view !== "channel" && (
        <button type="button" onClick={() => setView("channel")} className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)] px-3 py-1.5 text-left text-[12px]">
          <CircleHelp size={13} className="text-[var(--cf-warning)]" />
          {t("team.questionsWaiting", { n: String(questions.length) })}
        </button>
      )}

      <div className="relative min-h-0 flex-1">
        {view === "graph" && (
          <div className="flex h-full min-h-0">
            <div className="relative min-w-0 flex-1">
              <Suspense fallback={null}>
                <TeamGraph state={state} selected={selected} onSelect={setSelected} />
              </Suspense>
            </div>
            {selectedItem && <ItemPanel state={state} item={selectedItem} onClose={() => setSelected(null)} />}
          </div>
        )}
        {view === "channel" && <Channel state={state} />}
        {view === "members" && <Members state={state} onOpenItem={(id) => { setSelected(id); setView("graph"); }} />}
      </div>
    </div>
  );
}

function ViewButton({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={`flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] ${active ? "bg-[var(--cf-accent-soft)] text-[var(--cf-text)]" : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"}`}
    >
      {icon}
      <span className="hidden xl:inline">{label}</span>
      {!!badge && <span className="rounded-full bg-[var(--cf-warning)] px-1 text-[10px] leading-4 text-white">{badge}</span>}
    </button>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]">
      {children}
    </button>
  );
}

function RepoStrip({ state }: { state: TeamRunState }) {
  const t = useT();
  return (
    <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-b border-[var(--cf-border)] px-3 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
      {state.repos.map((r) => (
        <span key={r.project_id} className="flex items-center gap-1" title={r.integration_path}>
          <GitBranch size={11} />
          <span className="text-[var(--cf-text)]">{r.name}</span>
          <span className="font-mono">{r.integration_branch}</span>
          <ArrowRight size={10} />
          <span className="font-mono">{r.target_branch}</span>
          {r.status !== "ready" && <span className={r.status === "merged" ? "text-[var(--cf-success)]" : r.status === "failed" ? "text-[var(--cf-danger)]" : ""}>· {t(`team.repoStatus.${r.status}` as never)}</span>}
        </span>
      ))}
    </div>
  );
}

function GateBanner({ state }: { state: TeamRunState }) {
  const t = useT();
  const { run } = state;
  const [comment, setComment] = useState("");
  const store = useTeamStore.getState();
  const gate = run.gate;
  const planned = gate === "plan" ? state.items.filter((i) => i.status === "pending" && !["plan", "final", "answer"].includes(i.kind)) : [];
  const [yes, no] =
    gate === "plan"
      ? [t("team.gate.approvePlan"), t("team.gate.rejectPlan")]
      : gate.startsWith("item:")
        ? [t("team.gate.approveItem"), t("team.gate.skipItem")]
        : gate === "merge"
          ? [t("team.gate.merge"), t("team.gate.leave")]
          : gate.startsWith("review:")
            ? [t("team.gate.integrateAnyway"), t("team.gate.discard")]
            : [t("team.gate.continue"), t("team.gate.fail")];
  return (
    <div className="shrink-0 space-y-2 border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-warning)_8%,transparent)] px-3 py-2">
      <p className="text-[12.5px]">{run.gate_note || t("team.gate.waiting")}</p>
      {planned.length > 0 && (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto text-[12px]">
          {planned.map((i) => (
            <li key={i.id} className="flex gap-1.5">
              <span className="font-mono text-[var(--cf-text-muted)]">{i.key}</span>
              <span className="font-medium">{i.member_name}</span>
              <span className="min-w-0 truncate">{i.title}</span>
              {i.depends_on.length > 0 && <span className="text-[var(--cf-text-faint)]">← {i.depends_on.map((d) => state.items.find((x) => x.id === d)?.key ?? "?").join(", ")}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("team.gate.comment")} className={fieldClass({ size: "sm", className: "min-w-0 flex-1" })} />
        <GhostButton onClick={() => void store.decide(run.id, false, comment)}>{no}</GhostButton>
        <PrimaryButton onClick={() => void store.decide(run.id, true, comment)}>{yes}</PrimaryButton>
      </div>
    </div>
  );
}

function ItemPanel({ state, item, onClose }: { state: TeamRunState; item: TeamItem; onClose: () => void }) {
  const t = useT();
  const live = useAgentsStore((s) => (item.task_id ? s.live[item.task_id] : undefined));
  const [doneText, setDoneText] = useState("");
  const store = useTeamStore.getState();
  const repo = state.repos.find((r) => r.project_id === item.project_id);
  const tone = statusTone(item.status);
  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-[var(--cf-border)] bg-[var(--cf-surface)]">
      <div className="flex items-start gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium">{item.title}</p>
          <p className="text-[11px] text-[var(--cf-text-muted)]">
            <span className="font-mono">{item.key}</span> · {item.member_name} · {t(itemKindKey(item.kind))} · <span className={tone.text}>{t(`team.status.${item.status}` as never)}</span>
          </p>
        </div>
        <IconButton title={t("common.close")} onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2 text-[12px]">
        {repo && (
          <p className="text-[11px] text-[var(--cf-text-muted)]">
            {repo.name}
            {item.branch && (
              <>
                {" · "}
                <span className="font-mono">{item.branch}</span>
              </>
            )}
            {item.merged && <span className="text-[var(--cf-success)]"> · {t("team.merged")}</span>}
          </p>
        )}
        {item.status === "running" && live?.sending && live.runId && <AiRunLog runId={live.runId} running startedAt={live.runStartedAt} density="panel" defaultOpen />}
        {item.status === "running" && item.run_in === "terminal" && (
          <div className="space-y-1.5 rounded-md border border-[var(--cf-border)] p-2">
            <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("team.terminalHint")}</p>
            <textarea rows={2} value={doneText} onChange={(e) => setDoneText(e.target.value)} placeholder={t("team.terminalDonePlaceholder")} className={fieldClass({ size: "sm", className: "h-auto w-full resize-y py-1" })} />
            <PrimaryButton onClick={() => void store.finishTerminalItem(item.run_id, item.id, doneText)}>
              <CheckCircle2 size={13} />
              {t("team.terminalDone")}
            </PrimaryButton>
          </div>
        )}
        <Section label={t("team.instruction")}>{item.instruction}</Section>
        {item.feedback && <Section label={t("team.feedback")}>{item.feedback}</Section>}
        {item.last_error && item.status !== "done" && <Section label={t("team.lastError")} tone="danger">{item.last_error}</Section>}
        {item.output_text && <Section label={t("team.output")}>{item.output_text}</Section>}
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-[var(--cf-border)] px-3 py-2">
        {item.task_id && (
          <GhostButton onClick={() => void useAgentsStore.getState().select(item.task_id)}>
            <MessagesSquare size={13} />
            {t("team.openConversation")}
          </GhostButton>
        )}
        {["error", "cancelled", "skipped"].includes(item.status) && <GhostButton onClick={() => void store.control(item.run_id, `retry:${item.id}`)}>{t("team.retry")}</GhostButton>}
        {["pending", "gated", "error", "waiting"].includes(item.status) && <GhostButton onClick={() => void store.control(item.run_id, `skip:${item.id}`)}>{t("team.skip")}</GhostButton>}
      </div>
    </aside>
  );
}

function Section({ label, tone, children }: { label: string; tone?: "danger"; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-0.5 text-[10.5px] uppercase tracking-wide text-[var(--cf-text-muted)]">{label}</p>
      <div className={`max-h-72 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed ${tone === "danger" ? "text-[var(--cf-danger)]" : ""}`}>{children}</div>
    </div>
  );
}

function Channel({ state }: { state: TeamRunState }) {
  const t = useT();
  const { run } = state;
  const [to, setTo] = useState("all");
  const [body, setBody] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const colorOf = useMemo(() => new Map(run.members.map((m, i) => [m.id, memberColor(i)])), [run.members]);
  const providerOf = useMemo(() => new Map(run.members.map((m) => [m.id, m.provider])), [run.members]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [state.messages.length]);
  const send = () => {
    if (!body.trim()) return;
    void useTeamStore.getState().note(run.id, to, body);
    setBody("");
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2">
        {state.messages.map((m) => (
          <MessageRow key={m.id} message={m} color={colorOf.get(m.from_id)} provider={providerOf.get(m.from_id)} />
        ))}
        <div ref={end} />
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-3 py-2">
        <div className="w-40 shrink-0">
          <Select
            value={to}
            onChange={setTo}
            ariaLabel={t("team.noteTo")}
            options={[
              { value: "all", label: t("team.toAll") },
              ...(run.lead ? [{ value: "lead", label: t("team.toLead") }] : []),
              ...run.members.filter((m) => m.id !== run.lead).map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
        </div>
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder={t("team.notePlaceholder")}
          className={fieldClass({ size: "sm", className: "min-w-0 flex-1" })}
        />
        <IconButton title={t("team.send")} onClick={send}>
          <Send size={13} />
        </IconButton>
      </div>
    </div>
  );
}

function MessageRow({ message: m, color, provider }: { message: TeamMessage; color?: string; provider?: string }) {
  const t = useT();
  const [answer, setAnswer] = useState("");
  const asking = m.kind === "question" && m.to_id === "user" && !m.answer;
  const system = m.from_id === "system";
  const fromUser = m.from_id === "user";
  if (m.kind === "status") {
    return (
      <p className="flex items-center gap-1.5 pl-1 text-[11px] text-[var(--cf-text-faint)]">
        <span className="h-1 w-1 rounded-full" style={{ background: color ?? "var(--cf-text-faint)" }} />
        <span style={{ color }}>{m.from_name}</span> {m.body}
      </p>
    );
  }
  return (
    <div
      className={`rounded-lg border px-2.5 py-1.5 ${asking ? "border-[var(--cf-warning)] bg-[color-mix(in_oklab,var(--cf-warning)_8%,transparent)]" : "border-[var(--cf-border)]"} ${fromUser ? "ml-10 bg-[var(--cf-accent-soft)]" : ""}`}
    >
      <div className="flex items-center gap-1.5 text-[11px]">
        {provider && <ProviderGlyph providerId={provider} size={11} />}
        <span className="font-medium" style={{ color: system ? "var(--cf-text-muted)" : color }}>
          {fromUser ? t("team.you") : m.from_name}
        </span>
        <ArrowRight size={10} className="text-[var(--cf-text-faint)]" />
        <span className="text-[var(--cf-text-muted)]">{m.to_id === "user" ? t("team.you") : m.to_name}</span>
        <span className="rounded bg-[var(--cf-surface-2)] px-1 text-[10px] text-[var(--cf-text-muted)]">{t(messageKindKey(m.kind))}</span>
        <span className="ml-auto text-[10px] text-[var(--cf-text-faint)]">{new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">{m.body}</p>
      {m.answer && (
        <p className="mt-1 border-l-2 border-[var(--cf-accent)] pl-2 text-[12px] text-[var(--cf-text-muted)]">
          {t("team.answered")}: {m.answer}
        </p>
      )}
      {asking && (
        <div className="mt-1.5 space-y-1.5">
          {m.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {m.options.map((o) => (
                <button key={o} type="button" onClick={() => void useTeamStore.getState().answer(m.run_id, m.id, o)} className="h-6 rounded-full border border-[var(--cf-border)] px-2 text-[11.5px] hover:border-[var(--cf-accent)] hover:bg-[var(--cf-accent-soft)]">
                  {o}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-1.5">
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && answer.trim()) void useTeamStore.getState().answer(m.run_id, m.id, answer);
              }}
              placeholder={t("team.answerPlaceholder")}
              className={fieldClass({ size: "sm", className: "min-w-0 flex-1" })}
            />
            <PrimaryButton onClick={() => answer.trim() && void useTeamStore.getState().answer(m.run_id, m.id, answer)} disabled={!answer.trim()}>
              {t("team.answer")}
            </PrimaryButton>
          </div>
        </div>
      )}
    </div>
  );
}

function Members({ state, onOpenItem }: { state: TeamRunState; onOpenItem: (id: string) => void }) {
  const t = useT();
  const live = useAgentsStore((s) => s.live);
  return (
    <div className="flex h-full min-h-0 gap-2 overflow-x-auto p-2">
      {state.run.members.map((m, index) => {
        const mine = state.items.filter((i) => i.member_id === m.id);
        const running = mine.filter((i) => i.status === "running");
        const color = memberColor(index);
        return (
          <section key={m.id} className="flex w-[300px] shrink-0 flex-col overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
            <header className="border-b border-[var(--cf-border)] px-2.5 py-2" style={{ borderTop: `3px solid ${color}` }}>
              <div className="flex items-center gap-1.5">
                <ProviderGlyph providerId={m.provider} size={13} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{m.name}</span>
                {m.id === state.run.lead && <span className="rounded bg-[var(--cf-surface-2)] px-1 text-[10px]">{t("team.lead")}</span>}
                {running.length > 0 && <ThinkingOrb size="sm" />}
              </div>
              <p className="truncate text-[11px] text-[var(--cf-text-muted)]">
                {m.role || "—"} · {m.model}
                {m.effort ? ` · ${m.effort}` : ""} · {t(m.run_in === "terminal" ? "team.runTerminal" : "team.runHeadless")}
              </p>
            </header>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
              {running.map((i) => {
                const l = i.task_id ? live[i.task_id] : undefined;
                return (
                  <div key={i.id} className="space-y-1">
                    <button type="button" onClick={() => onOpenItem(i.id)} className="w-full truncate text-left text-[12px] font-medium hover:underline">
                      {i.title}
                    </button>
                    {l?.sending && l.runId ? (
                      <AiRunLog runId={l.runId} running startedAt={l.runStartedAt} density="panel" defaultOpen />
                    ) : (
                      <p className="text-[11px] text-[var(--cf-text-muted)]">{t(i.run_in === "terminal" ? "team.inTerminal" : "team.starting")}</p>
                    )}
                  </div>
                );
              })}
              <ul className="space-y-0.5">
                {mine
                  .filter((i) => i.status !== "running")
                  .map((i) => (
                    <li key={i.id}>
                      <button type="button" onClick={() => onOpenItem(i.id)} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11.5px] hover:bg-[var(--cf-hover)]">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusTone(i.status).dot}`} />
                        <span className="min-w-0 flex-1 truncate">{i.title}</span>
                        <span className="text-[10px] text-[var(--cf-text-faint)]">{t(`team.status.${i.status}` as never)}</span>
                      </button>
                    </li>
                  ))}
              </ul>
              {mine.length === 0 && <p className="text-[11px] text-[var(--cf-text-faint)]">{t("team.idle")}</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
