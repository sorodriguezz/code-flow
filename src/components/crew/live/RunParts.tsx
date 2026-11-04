/**
 * Pieces of a live run's page: the gate that waits for you, and one item opened.
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, GitBranch, GitMerge, Hand, MessageSquare, MessagesSquare, RotateCcw, SkipForward, SquareTerminal, X } from "lucide-react";
import { useTeamStore } from "../../../state/teamStore";
import { useAgentsStore } from "../../../state/agentsStore";
import { useBenchStore } from "../../../state/benchStore";
import { AiRunLog } from "../../ai/AiRunLog";
import type { TeamItem, TeamRunState } from "../../../types/team";
import { AgentAvatar } from "../kit/Avatar";
import { Btn, Chip, Label, SOFT, field } from "../kit/ui";
import { useCrewStore, useL } from "../state";
import { ITEM_KIND, ITEM_STATUS } from "./look";

export function GateCard({ state }: { state: TeamRunState }) {
  const l = useL();
  const { run } = state;
  const [comment, setComment] = useState("");
  const gate = run.gate;
  const planned = gate === "plan" ? state.items.filter((i) => i.status === "pending" && !["plan", "final", "answer", "advise"].includes(i.kind)) : [];
  const [yes, no] =
    gate === "plan"
      ? [l("Aprobar el plan", "Approve the plan"), l("Pedir otro", "Ask for another")]
      : gate.startsWith("item:")
        ? [l("Aprobar", "Approve"), l("Saltar", "Skip")]
        : gate === "merge"
          ? [l("Integrar", "Merge"), l("Dejar en su rama", "Leave on its branch")]
          : gate.startsWith("review:")
            ? [l("Integrar igual", "Merge anyway"), l("Descartar", "Discard")]
            : gate === "budget"
              ? [l("Seguir (+50% de presupuesto)", "Go on (+50% budget)"), l("Parar aquí", "Stop here")]
              : [l("Seguir", "Continue"), l("Darla por fallida", "Mark it failed")];
  const title =
    gate === "plan" ? l("El líder propone este plan", "The lead proposes this plan") : gate === "merge" ? l("Listo para integrar", "Ready to merge") : gate === "budget" ? l("Llegó al presupuesto", "Budget reached") : gate.startsWith("stuck:") ? l("Se atascó", "It got stuck") : l("Te espera", "Waiting on you");

  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={SOFT} className="cf-crew-waiting mx-3 mt-3 flex shrink-0 flex-col gap-2 rounded-[14px] border border-[var(--cf-warning)] bg-[color-mix(in_oklab,var(--cf-warning)_8%,var(--cf-surface))] p-3" style={{ ["--cf-crew-c" as string]: "var(--cf-warning)" }}>
      <div className="flex items-center gap-2">
        <Hand className="h-4 w-4 text-[var(--cf-warning)]" />
        <b className="text-[13px]">{title}</b>
      </div>
      {run.gate_note && <p className="m-0 whitespace-pre-wrap text-[12.5px]">{run.gate_note}</p>}
      {planned.length > 0 && (
        <ol className="m-0 flex max-h-48 list-none flex-col gap-1 overflow-auto p-0">
          {planned.map((i) => {
            const member = run.members.find((m) => m.id === i.member_id);
            return (
              <li key={i.id} className="flex items-center gap-2 rounded-[8px] bg-[var(--cf-surface)] px-2 py-1 text-[12px]">
                {member && <AgentAvatar agent={{ id: member.agent_id, icon: member.icon, color: member.color }} size={20} />}
                <b className="shrink-0">{i.member_name}</b>
                <span className="min-w-0 flex-1 truncate">{i.title}</span>
                {i.depends_on.length > 0 && <span className="shrink-0 text-[11px] text-[var(--cf-text-faint)]">← {i.depends_on.map((d) => state.items.find((x) => x.id === d)?.key ?? "?").join(", ")}</span>}
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={l("Comentario (opcional): qué cambiar, qué cuidar…", "Comment (optional): what to change, what to watch…")} className={`${field} min-w-[200px] flex-1`} />
        <Btn kind="ghost" title={l("No aprueba; el equipo recibe tu comentario", "Doesn't approve; the team gets your comment")} onClick={() => void useTeamStore.getState().decide(run.id, false, comment)}>{no}</Btn>
        <Btn kind="primary" icon={CheckCircle2} title={l("Aprueba y el equipo sigue adelante", "Approves and the team carries on")} onClick={() => void useTeamStore.getState().decide(run.id, true, comment)}>{yes}</Btn>
      </div>
    </motion.div>
  );
}

function Section({ label, tone, children }: { label: string; tone?: "bad"; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <div className={`max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[9px] bg-[var(--cf-sunken)] p-2 text-[12px] leading-relaxed ${tone === "bad" ? "text-[var(--cf-danger)]" : ""}`}>{children}</div>
    </div>
  );
}

export function ItemPanel({ state, item, onClose }: { state: TeamRunState; item: TeamItem; onClose: () => void }) {
  const l = useL();
  const crew = useCrewStore();
  const live = useAgentsStore((s) => (item.task_id ? s.live[item.task_id] : undefined));
  const roster = useAgentsStore((s) => s.roster);
  const [doneText, setDoneText] = useState("");
  const store = useTeamStore.getState();
  const repo = state.repos.find((r) => r.project_id === item.project_id);
  const member = state.run.members.find((m) => m.id === item.member_id);
  const agent = roster.find((a) => a.id === member?.agent_id);
  const [es, en, tone] = ITEM_STATUS[item.status] ?? ITEM_STATUS.pending;
  const [kes, ken] = ITEM_KIND[item.kind] ?? ITEM_KIND.work;

  return (
    <motion.aside initial={{ x: 30, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={SOFT} className="absolute inset-y-0 right-0 z-10 flex w-[min(380px,100%)] flex-col border-l border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-modal)]">
      <div className="flex items-start gap-2.5 border-b border-[var(--cf-border)] px-3 py-2.5">
        {member && <AgentAvatar agent={{ id: member.agent_id, icon: member.icon || agent?.icon, color: member.color || agent?.color }} size={32} state={item.status === "running" ? "thinking" : item.status === "waiting" ? "waiting" : "idle"} />}
        <div className="min-w-0 flex-1">
          <b className="block text-[13px] leading-snug">{item.title}</b>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
            <span className="font-mono">{item.key}</span>· {item.member_name || l("Líder", "Lead")} · {l(kes, ken)}
            <Chip tone={tone} title={l("Estado de la tarea", "Task status")}>{l(es, en)}</Chip>
            {item.attempts > 1 && <span>· {l(`intento ${item.attempts}`, `attempt ${item.attempts}`)}</span>}
            {item.model && <span className="font-mono text-[var(--cf-violet)]">· {item.model}</span>}
          </span>
        </div>
        <button type="button" title={l("Cierra este panel", "Closes this panel")} aria-label={l("Cerrar", "Close")} onClick={onClose} className="grid h-7 w-7 place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        {repo && (
          <span className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
            <GitBranch className="h-3.5 w-3.5" />
            {repo.name}
            {item.branch && <span className="font-mono">{item.branch}</span>}
            {item.merged && <Chip tone="ok" icon={GitMerge} title={l("Su trabajo ya se integró al repositorio", "Its work is already merged into the repository")}>{l("integrado", "merged")}</Chip>}
            {item.commit_sha && <span className="font-mono">{item.commit_sha.slice(0, 7)}</span>}
          </span>
        )}
        {item.status === "running" && live?.sending && live.runId && <AiRunLog runId={live.runId} running startedAt={live.runStartedAt} density="panel" defaultOpen />}
        {item.status === "running" && item.run_in === "terminal" && (
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--cf-border)] p-2.5">
            <span className="text-[12px] text-[var(--cf-text-muted)]">{l("Corre en una terminal del Taller. Cuando termine (o al escribir `cf done` allí) se cierra solo; también puedes cerrarlo aquí con un resumen.", "It runs in a Workshop terminal. When it finishes (or on `cf done` there) it closes itself; you can also close it here with a summary.")}</span>
            <textarea rows={2} value={doneText} onChange={(e) => setDoneText(e.target.value)} placeholder={l("Qué hizo, en pocas líneas", "What it did, in a few lines")} className={`${field} h-auto resize-y py-1.5`} />
            <div className="flex gap-1.5">
              <Btn small icon={SquareTerminal} title={l("Abre el taller en la terminal de esta tarea", "Opens the workshop at this task's terminal")} onClick={() => { crew.set({ workshopTab: "bench" }); crew.setSpace("taller"); void useBenchStore.getState().show(state.run.workspace_id); }}>{l("Ir a su terminal", "Go to its terminal")}</Btn>
              <Btn small kind="primary" icon={CheckCircle2} title={l("Marca la tarea como terminada con tu nota", "Marks the task as finished with your note")} onClick={() => void store.finishTerminalItem(item.run_id, item.id, doneText)}>{l("Está hecho", "It is done")}</Btn>
            </div>
          </div>
        )}
        {item.instruction && <Section label={l("Instrucción", "Instruction")}>{item.instruction}</Section>}
        {item.feedback && <Section label={l("Devolución", "Feedback")}>{item.feedback}</Section>}
        {item.last_error && item.status !== "done" && <Section label={l("Último error", "Last error")} tone="bad">{item.last_error}</Section>}
        {item.output_text && <Section label={l("Lo que entregó", "What it handed over")}>{item.output_text}</Section>}
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-[var(--cf-border)] p-2.5">
        {member && <Btn small icon={MessageSquare} title={l("Abre el chat de quien hace esta tarea", "Opens the chat of whoever does this task")} onClick={() => crew.open({ kind: "chat", runId: state.run.id, memberId: member.id })}>{l("Chat del miembro", "Member chat")}</Btn>}
        {item.task_id && <Btn small icon={MessagesSquare} title={l("Abre la conversación completa de la tarea", "Opens the task's full conversation")} onClick={() => crew.open({ kind: "task", id: item.task_id })}>{l("Conversación", "Conversation")}</Btn>}
        {["error", "cancelled", "skipped"].includes(item.status) && <Btn small icon={RotateCcw} title={l("Vuelve a ejecutar esta tarea desde cero", "Runs this task again from scratch")} onClick={() => void store.control(item.run_id, `retry:${item.id}`)}>{l("Reintentar", "Retry")}</Btn>}
        {["pending", "gated", "error", "waiting"].includes(item.status) && <Btn small icon={SkipForward} title={l("La omite y deja seguir a las que dependen de ella", "Skips it and lets dependent tasks go on")} onClick={() => void store.control(item.run_id, `skip:${item.id}`)}>{l("Saltar", "Skip")}</Btn>}
      </div>
    </motion.aside>
  );
}
