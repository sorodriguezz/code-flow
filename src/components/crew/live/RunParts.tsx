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
import { Markdown } from "../../common/Markdown";
import { readableTeamText } from "../../../lib/team/teamText";
import type { TeamItem, TeamRunState } from "../../../types/team";
import { AgentAvatar } from "../kit/Avatar";
import { Btn, Chip, Label, SOFT, field } from "../kit/ui";
import { useCrewStore, useL } from "../state";
import { ITEM_KIND, ITEM_STATUS } from "./look";

export function GateCard({ state }: { state: TeamRunState }) {
  const l = useL();
  const { run } = state;
  const [comment, setComment] = useState("");
  const [deciding, setDeciding] = useState(false);
  const gate = run.gate;
  const [kind, gatedId] = gate.split(":");
  const gated = state.items.find((item) => item.id === gatedId);
  const amendment = kind === "amend" ? gated?.intelligence?.amendment : null;
  const impact = kind === "impact" ? gated?.intelligence?.impact : null;
  const decide = async (approve: boolean) => {
    if (deciding) return;
    setDeciding(true);
    try {
      await useTeamStore.getState().decide(run.id, approve, comment, gate);
    } finally {
      setDeciding(false);
    }
  };
  const planned = gate === "plan" ? state.items.filter((i) => i.status === "pending" && !["plan", "final", "answer", "advise"].includes(i.kind)) : [];
  const [yes, no] =
    kind === "amend" ? [l("Aplicar ajuste", "Apply amendment"), l("Mantener el plan", "Keep current plan")]
      : kind === "amend_failed" ? [l("Reintentar ajuste", "Retry amendment"), l("Mantener el plan", "Keep current plan")]
      : kind === "impact" ? [l("Aprobar cambios", "Approve changes"), l("Rechazar cambios", "Reject changes")]
      : gate === "plan"
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
    kind === "impact" ? l("Cambios de impacto", "High-impact changes")
      : kind === "amend" ? l("Ajuste propuesto por el líder", "Amendment proposed by the lead")
      : kind === "amend_failed" ? l("El ajuste necesita atención", "The amendment needs attention")
      : gate === "plan" ? l("El líder propone este plan", "The lead proposes this plan") : gate === "merge" ? l("Listo para integrar", "Ready to merge") : gate === "budget" ? l("Llegó al presupuesto", "Budget reached") : gate.startsWith("stuck:") ? l("Se atascó", "It got stuck") : l("Te espera", "Waiting on you");

  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={SOFT} className="cf-crew-waiting mx-3 mt-3 flex shrink-0 flex-col gap-2 rounded-[14px] border border-[var(--cf-warning)] bg-[color-mix(in_oklab,var(--cf-warning)_8%,var(--cf-surface))] p-3" style={{ ["--cf-crew-c" as string]: "var(--cf-warning)" }}>
      <div className="flex items-center gap-2">
        <Hand className="h-4 w-4 text-[var(--cf-warning)]" />
        <b className="text-[13px]">{title}</b>
      </div>
      {run.gate_note && <p className="m-0 whitespace-pre-wrap text-[12.5px]">{run.gate_note}</p>}
      {amendment && (
        <div className="max-h-52 space-y-1 overflow-auto rounded-lg bg-[var(--cf-surface)] p-2 text-[12px]">
          <p className="m-0 font-medium">{gated?.instruction}</p>
          {amendment.summary && <p className="m-0 whitespace-pre-wrap">{amendment.summary}</p>}
          {amendment.cancel.length > 0 && <p className="m-0">{l("Retira", "Removes")} · {amendment.cancel.join(", ")}</p>}
          {amendment.items.map((item) => (
            <div key={item.key} className="border-t border-[var(--cf-border)] pt-1">
              <b>{item.title}</b> · {run.members.find((member) => member.id === item.member_id)?.name}
              {item.replaces && <span> · {l("Reemplaza o corrige", "Replaces or updates")} {item.replaces}</span>}
              {item.criteria.map((criterion, index) => <div key={index}>• {criterion}</div>)}
            </div>
          ))}
        </div>
      )}
      {impact && (
        <div className="space-y-1 text-[12px]">
          <b>{gated?.title}</b>
          <div className="break-words">{impact.files.join(" · ")}</div>
          {impact.diff && <pre className="max-h-52 overflow-auto rounded-lg bg-[var(--cf-sunken)] p-2 text-[11px]">{impact.diff}</pre>}
        </div>
      )}
      {planned.length > 0 && (
        <ol className="m-0 flex max-h-48 list-none flex-col gap-1 overflow-auto p-0">
          {planned.map((i) => {
            const member = run.members.find((m) => m.id === i.member_id);
            return (
              <li key={i.id} className="flex items-center gap-2 rounded-[8px] bg-[var(--cf-surface)] px-2 py-1 text-[12px]">
                {member && <AgentAvatar agent={{ id: member.agent_id, icon: member.icon, color: member.color }} size={20} />}
                <b className="shrink-0">{i.member_name}</b>
                <div className="min-w-0 flex-1">
                  <span className="block truncate">{i.title}</span>
                  {i.intelligence?.criteria.map((criterion, index) => (
                    <span key={index} className="block text-[11px] text-[var(--cf-text-muted)]">• {criterion}</span>
                  ))}
                </div>
                {i.depends_on.length > 0 && <span className="shrink-0 text-[11px] text-[var(--cf-text-faint)]">← {i.depends_on.map((d) => state.items.find((x) => x.id === d)?.key ?? "?").join(", ")}</span>}
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={l("Comentario (opcional): qué cambiar, qué cuidar…", "Comment (optional): what to change, what to watch…")} className={`${field} min-w-[200px] flex-1`} />
        <Btn kind="ghost" disabled={deciding} onClick={() => void decide(false)}>{no}</Btn>
        <Btn kind="primary" disabled={deciding || (kind === "impact" && !impact) || (kind === "amend" && !amendment)} icon={CheckCircle2} onClick={() => void decide(true)}>{yes}</Btn>
      </div>
    </motion.div>
  );
}

function Section({ label, tone, text }: { label: string; tone?: "bad"; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      {tone === "bad" ? (
        <div className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[9px] bg-[var(--cf-sunken)] p-2 text-[12px] leading-relaxed text-[var(--cf-danger)]">{text}</div>
      ) : (
        <Markdown source={readableTeamText(text)} className="cf-markdown-chat cf-crew-msg max-h-72 select-text overflow-auto break-words rounded-[9px] bg-[var(--cf-sunken)] p-2.5 text-[12.5px]" />
      )}
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
  const substitute = state.run.members.find((m) => m.id === item.intelligence?.substitute);
  const recovery = item.intelligence?.recovery;
  const recoveryLabel = {
    quota: l("Cuota agotada", "Quota exhausted"),
    auth_required: l("Renueva la sesión", "Renew sign-in"),
    cli_missing: l("Instala o configura el motor", "Install or configure the engine"),
    cli_busy: l("Motor ocupado", "Engine busy"),
    overloaded: l("Proveedor saturado", "Provider overloaded"),
  };
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
            {substitute
              ? <span className="text-[var(--cf-violet)]">{l("Suplente", "Substitute")} · {substitute.name} · {substitute.provider} · {item.model || substitute.model}{substitute.effort && ` · ${substitute.effort}`}</span>
              : item.model && <span className="font-mono text-[var(--cf-violet)]">· {item.model}</span>}
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
        {item.instruction && <Section label={l("Instrucción", "Instruction")} text={item.instruction} />}
        {!!item.intelligence?.paths.length && <Section label={l("Archivos previstos", "Expected files")} text={item.intelligence.paths.map((path) => `- \`${path}\``).join("\n")} />}
        {recovery && (
          <div className="rounded-lg border border-[var(--cf-warning)] p-2 text-[12px]">
            <b>{recoveryLabel[recovery.kind]}</b>
            <p className="mt-1 mb-0">{recovery.provider} · {recovery.model}</p>
            {recovery.resume_at && <p className="mt-1 mb-0">{l("Reanudación prevista", "Scheduled resume")} · {new Date(recovery.resume_at * 1000).toLocaleString()}</p>}
          </div>
        )}
        {!!item.intelligence?.criteria.length && <Section label={l("Criterios de aceptación", "Acceptance criteria")} text={item.intelligence.criteria.map((criterion) => `- ${criterion}`).join("\n")} />}
        {!!item.intelligence?.evidence.length && (
          <div className="flex flex-col gap-1.5">
            <Label>{l("Evidencia de verificación", "Verification evidence")}</Label>
            {item.intelligence.evidence.map((evidence, index) => (
              <details key={`${index}-${evidence.label}`} className="rounded-lg border border-[var(--cf-border)] px-2 py-1.5 text-[12px]">
                <summary className="cursor-pointer break-words">
                  <b>{evidence.label}</b> · {evidence.result === "passed" ? l("Prueba aprobada", "Check passed")
                    : evidence.result === "regression" ? l("Regresión", "Regression")
                      : evidence.result === "preexisting" ? l("Fallo presente en la base", "Failure present in baseline")
                        : evidence.result === "reported" ? l("Reportado por el agente", "Reported by the agent")
                          : evidence.result === "unverified" ? l("Sin evidencia", "No evidence")
                            : l("Falló sin comparación concluyente", "Failed without a conclusive comparison")}
                </summary>
                {evidence.detail && <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words text-[11px]">{evidence.detail}</pre>}
              </details>
            ))}
          </div>
        )}
        {item.feedback && <Section label={l("Devolución", "Feedback")} text={item.feedback} />}
        {item.last_error && item.status !== "done" && <Section label={l("Último error", "Last error")} tone="bad" text={item.last_error} />}
        {item.output_text && <Section label={l("Lo que entregó", "What it handed over")} text={item.output_text} />}
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-[var(--cf-border)] p-2.5">
        {member ? (
          <Btn small icon={MessageSquare} title={l("Abre la conversación de esta tarea con quien la hizo; puedes seguir hablándole ahí", "Opens this task's conversation with whoever did it; you can keep talking to it there")} onClick={() => crew.open({ kind: "chat", runId: state.run.id, memberId: member.id, taskId: item.task_id || undefined })}>{l("Conversación", "Conversation")}</Btn>
        ) : (
          item.task_id && <Btn small icon={MessagesSquare} title={l("Abre la conversación completa de la tarea", "Opens the task's full conversation")} onClick={() => crew.open({ kind: "task", id: item.task_id })}>{l("Conversación", "Conversation")}</Btn>
        )}
        {(["error", "cancelled", "skipped"].includes(item.status) || recovery) && <Btn small icon={RotateCcw} title={l("Vuelve a intentar la tarea desde su carpeta de trabajo", "Retries the task in its worktree")} onClick={() => void store.control(item.run_id, `retry:${item.id}`)}>{l("Reintentar", "Retry")}</Btn>}
        {["pending", "gated", "error", "waiting"].includes(item.status) && !item.intelligence?.impact && !(item.kind === "amend" && item.status === "gated") && <Btn small icon={SkipForward} title={l("La omite y deja seguir a las que dependen de ella", "Skips it and lets dependent tasks go on")} onClick={() => void store.control(item.run_id, `skip:${item.id}`)}>{l("Saltar", "Skip")}</Btn>}
      </div>
    </motion.aside>
  );
}
