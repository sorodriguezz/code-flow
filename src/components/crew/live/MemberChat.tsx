/**
 * One member of a run, up close: its own conversation with the CLI (where you can write to it
 * directly), what the channel says to and about it, and its items. The card it works for is a click
 * away, so the board and the chat stay one thing.
 */
import { Suspense, lazy, useMemo, useState } from "react";
import { Crown, Kanban, Lightbulb, ListChecks, MessageSquare, MessagesSquare, Star, X } from "lucide-react";
import { useTeamStore } from "../../../state/teamStore";
import { useAgentsStore } from "../../../state/agentsStore";
import { useBacklogStore } from "../../../state/backlogStore";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import { AgentAvatar } from "../kit/Avatar";
import { Btn, Chip, Drawer, Empty, Seg } from "../kit/ui";
import { useCrewStore, useL } from "../state";
import { Channel } from "./Channel";
import { ITEM_KIND, ITEM_STATUS } from "./look";

const AgentTaskDetail = lazy(() => import("../../agents/AgentTaskDetail").then((m) => ({ default: m.AgentTaskDetail })));

export function MemberChat({ runId, memberId }: { runId: string; memberId: string }) {
  const l = useL();
  const crew = useCrewStore();
  const state = useTeamStore((s) => s.states[runId]);
  const roster = useAgentsStore((s) => s.roster);
  const card = useBacklogStore((s) => s.items.find((i) => i.links.some((lnk) => lnk.kind === "team_run" && lnk.ref_id === runId)));
  const member = state?.run.members.find((m) => m.id === memberId);
  const items = useMemo(() => (state ? state.items.filter((i) => i.member_id === memberId) : []), [state, memberId]);
  // A member's items can share one conversation (a planner keeps its own); list each one once.
  const conversations = useMemo(() => {
    const seen = new Set<string>();
    const out: { taskId: string; title: string; live: boolean }[] = [];
    for (const i of [...items].reverse()) {
      if (!i.task_id || seen.has(i.task_id)) continue;
      seen.add(i.task_id);
      out.push({ taskId: i.task_id, title: i.title, live: i.status === "running" || i.status === "waiting" });
    }
    return out.sort((a, b) => Number(b.live) - Number(a.live));
  }, [items]);
  const [tab, setTab] = useState<"chat" | "channel" | "items">(conversations.length ? "chat" : "channel");
  const [taskId, setTaskId] = useState<string | null>(null);
  const shown = taskId ?? conversations[0]?.taskId ?? null;

  if (!state || !member) return null;
  const agent = roster.find((a) => a.id === member.agent_id);
  const working = items.some((i) => i.status === "running");
  const waiting = items.some((i) => i.status === "waiting");

  return (
    <Drawer onClose={crew.close} width={820} label="member">
      <header className="flex shrink-0 flex-col gap-2.5 border-b border-[var(--cf-border)] px-4 pb-2.5 pt-3.5">
        <div className="flex items-center gap-3">
          <AgentAvatar agent={{ id: member.agent_id, icon: member.icon || agent?.icon, color: member.color || agent?.color }} size={42} state={working ? "thinking" : waiting ? "waiting" : "idle"} />
          <div className="min-w-0 flex-1">
            <b className="flex items-center gap-1.5 text-[15px]">
              {member.name}
              {member.id === state.run.lead && <Crown className="h-3.5 w-3.5 text-[var(--cf-warning)]" />}
              {member.leads && <Star className="h-3.5 w-3.5 text-[var(--cf-accent)]" />}
              {member.advisor && <Lightbulb className="h-3.5 w-3.5 text-[var(--cf-violet)]" />}
            </b>
            <span className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
              <ProviderGlyph providerId={member.provider} size={11} />
              {member.model}
              {member.effort ? ` · ${member.effort}` : ""}
              {member.role ? ` · ${member.role}` : ""}
              <span>· {state.run.title || state.run.goal}</span>
            </span>
          </div>
          {card && <Btn small icon={Kanban} onClick={() => crew.open({ kind: "card", id: card.id })}><span className="max-w-[150px] truncate">{card.title}</span></Btn>}
          <button type="button" aria-label={l("Cerrar", "Close")} onClick={crew.close} className="grid h-[30px] w-[30px] place-items-center rounded-[8px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Seg
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "chat", label: l("Su conversación", "Its conversation"), icon: MessageSquare },
              { value: "channel", label: l("En el canal", "In the channel"), icon: MessagesSquare },
              { value: "items", label: l("Sus tareas", "Its tasks"), icon: ListChecks, badge: <span className="text-[10.5px] text-[var(--cf-text-faint)]">{items.length}</span> },
            ]}
          />
          {tab === "chat" && conversations.length > 1 && (
            <select value={shown ?? ""} onChange={(e) => setTaskId(e.target.value)} className="h-[28px] max-w-[260px] rounded-[8px] border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 text-[12px]">
              {conversations.map((c) => (
                <option key={c.taskId} value={c.taskId}>{c.live ? "● " : ""}{c.title}</option>
              ))}
            </select>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "chat" &&
          (shown ? (
            <Suspense fallback={null}>
              <AgentTaskDetail key={shown} taskId={shown} />
            </Suspense>
          ) : (
            <Empty icon={MessageSquare} title={l("Todavía no habló", "It has not spoken yet")} hint={l("Su conversación aparece en cuanto empieza su primera tarea.", "Its conversation shows up as soon as its first task starts.")} />
          ))}
        {tab === "channel" && <Channel state={state} memberId={member.id} />}
        {tab === "items" && (
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-3">
            {items.map((i) => {
              const [es, en, tone] = ITEM_STATUS[i.status];
              const [kes, ken] = ITEM_KIND[i.kind];
              return (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => {
                    if (i.task_id) {
                      setTaskId(i.task_id);
                      setTab("chat");
                    }
                  }}
                  className="flex items-center gap-2 rounded-[10px] border border-[var(--cf-border)] px-2.5 py-2 text-left hover:bg-[var(--cf-hover)]"
                >
                  <span className="font-mono text-[11px] text-[var(--cf-text-faint)]">{i.key}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{i.title}</span>
                  <span className="text-[11px] text-[var(--cf-text-muted)]">{l(kes, ken)}</span>
                  <Chip tone={tone}>{l(es, en)}</Chip>
                </button>
              );
            })}
            {items.length === 0 && <span className="text-[12.5px] text-[var(--cf-text-muted)]">{l("Sin tareas en esta corrida.", "No tasks in this run.")}</span>}
          </div>
        )}
      </div>
    </Drawer>
  );
}
