/**
 * Pieces of a live run's page: the gate that waits for you, and one item opened.
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, GitBranch, GitFork, GitMerge, Hand, Hourglass, Link2Off, MessageSquare, MessagesSquare, RotateCcw, ShieldAlert, ShieldCheck, SkipForward, SquareTerminal, X } from "lucide-react";
import { useTeamStore } from "../../../state/teamStore";
import { useAgentsStore } from "../../../state/agentsStore";
import { useBenchStore } from "../../../state/benchStore";
import { AiRunLog } from "../../ai/AiRunLog";
import { Markdown } from "../../common/Markdown";
import { readableTeamText } from "../../../lib/team/teamText";
import { danglingDeps, INFRA_PROVIDER, type TeamItem, type TeamRunState } from "../../../types/team";
import { AgentAvatar } from "../kit/Avatar";
import { Btn, Chip, Label, SOFT, field } from "../kit/ui";
import { useCrewStore, useL } from "../state";
import { DoneChecklist } from "./DoneChecklist";
import { ITEM_KIND, isWorking, itemLook } from "./look";

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
  const weakenedTests = impact?.version.startsWith("tests-") ?? false;
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
      : kind === "impact" && weakenedTests ? [l("Aprobar: la tarea lo pedía", "Approve: the task asked for it"), l("Rechazar la tarea", "Reject the task")]
      : kind === "impact" ? [l("Aprobar cambios", "Approve changes"), l("Rechazar cambios", "Reject changes")]
      : gate === "plan"
      ? [l("Aprobar el plan", "Approve the plan"), l("Pedir otro", "Ask for another")]
      : gate.startsWith("item:")
        ? [l("Aprobar", "Approve"), l("Saltar", "Skip")]
        : kind === "deps"
        ? [l("Seguir sin esa dependencia", "Go on without that dependency"), l("Omitir la tarea", "Skip the task")]
        : kind === "sandbox"
        ? [l("Reintentar aislado", "Try again, isolated"), l("Verificar en este equipo", "Check on this computer")]
        : gate === "merge"
          ? run.policy.integrate === "pr"
            ? [state.repos.some((r) => r.status === "failed") ? l("Reintentar el PR", "Retry the PR") : l("Abrir PR", "Open PR"), l("Dejar en su rama", "Leave on its branch")]
            : [l("Integrar", "Merge"), l("Dejar en su rama", "Leave on its branch")]
          : gate.startsWith("review:")
            ? [l("Integrar igual", "Merge anyway"), l("Descartar", "Discard")]
            : gate === "budget"
              ? [l("Seguir (+50% de presupuesto)", "Go on (+50% budget)"), l("Parar aquí", "Stop here")]
              : [l("Seguir", "Continue"), l("Darla por fallida", "Mark it failed")];
  const title =
    kind === "impact" && weakenedTests ? l("Las pruebas quedaron más débiles", "The tests got weaker")
      : kind === "impact" ? l("Cambios de impacto", "High-impact changes")
      : kind === "amend" ? l("Ajuste propuesto por el líder", "Amendment proposed by the lead")
      : kind === "amend_failed" ? l("El ajuste necesita atención", "The amendment needs attention")
      : gate === "plan" ? l("El líder propone este plan", "The lead proposes this plan") : gate === "merge" ? (run.policy.integrate === "pr" ? l("Listo para abrir el PR", "Ready to open the PR") : l("Listo para integrar", "Ready to merge")) : gate === "budget" ? l("Llegó al presupuesto", "Budget reached") : kind === "deps" ? l("Depende de una tarea que no existe", "It depends on a task that does not exist") : kind === "sandbox" ? l("No se pudo verificar con aislamiento", "The checks could not run isolated") : gate.startsWith("stuck:") ? l("Se atascó", "It got stuck") : l("Te espera", "Waiting on you");

  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={SOFT} className="cf-crew-waiting mx-3 mt-3 flex shrink-0 flex-col gap-2 rounded-[14px] border border-[var(--cf-warning)] bg-[color-mix(in_oklab,var(--cf-warning)_8%,var(--cf-surface))] p-3" style={{ ["--cf-crew-c" as string]: "var(--cf-warning)" }}>
      <div className="flex items-center gap-2">
        <Hand className="h-4 w-4 text-[var(--cf-warning)]" />
        <b className="text-[13px]">{title}</b>
      </div>
      {run.gate_note && <p className="m-0 whitespace-pre-wrap text-[12.5px]">{run.gate_note}</p>}
      {kind === "sandbox" && (
        <p className="m-0 flex items-start gap-1.5 rounded-[8px] bg-[var(--cf-surface)] px-2 py-1.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
          <ShieldAlert className="mt-[1px] h-3.5 w-3.5 shrink-0 text-[var(--cf-warning)]" />
          <span>{l("El equipo pide que las verificaciones corran en un contenedor. Abre tu motor de contenedores y reintenta; o deja que esta corrida las ejecute en este equipo, con tu usuario y tu red. Nada se ha ejecutado todavía.", "The team asks for its checks to run in a container. Open your container engine and try again; or let this run execute them on this computer, as your user and on your network. Nothing has run yet.")}</span>
        </p>
      )}
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
          {(impact.reasons ?? []).length > 0 && (
            <ul className="m-0 list-disc space-y-0.5 pl-4">
              {(impact.reasons ?? []).map((reason, index) => <li key={index} className="break-words">{reason}</li>)}
            </ul>
          )}
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
        {/* A choice between two ways to go on has nothing to comment on. */}
        {kind === "sandbox" || kind === "deps"
          ? <span className="flex-1" />
          : <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={l("Comentario (opcional): qué cambiar, qué cuidar…", "Comment (optional): what to change, what to watch…")} className={`${field} min-w-[200px] flex-1`} />}
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
    other: l("CodeFlow lo intenta de nuevo", "CodeFlow is trying again"),
  };
  const infra = recovery?.provider === INFRA_PROVIDER;
  const missing = item.status === "pending" ? danglingDeps(item, state.items) : [];
  const phase = item.status === "running" ? item.intelligence?.phase : "";
  const agent = roster.find((a) => a.id === member?.agent_id);
  const [es, en, tone] = itemLook(item);
  const [kes, ken] = ITEM_KIND[item.kind] ?? ITEM_KIND.work;

  return (
    <motion.aside initial={{ x: 30, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={SOFT} className="absolute inset-y-0 right-0 z-10 flex w-[min(380px,100%)] flex-col border-l border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-modal)]">
      <div className="flex items-start gap-2.5 border-b border-[var(--cf-border)] px-3 py-2.5">
        {member && <AgentAvatar agent={{ id: member.agent_id, icon: member.icon || agent?.icon, color: member.color || agent?.color }} size={32} state={isWorking(item) ? "thinking" : item.status === "waiting" || phase === "queued" ? "waiting" : "idle"} />}
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
        {phase === "queued" && (
          <div className="flex items-start gap-2 rounded-[10px] border border-dashed border-[var(--cf-border-strong)] px-2.5 py-2 text-[12px] text-[var(--cf-text-muted)]">
            <Hourglass className="mt-[2px] h-3.5 w-3.5 shrink-0" />
            <span>
              <b className="block font-medium text-[var(--cf-text)]">{l("En cola: su turno aún no empieza", "Queued: its turn has not started")}</b>
              {l("Espera un cupo del límite de turnos a la vez. No gasta tokens ni tiempo del presupuesto mientras espera.", "It waits for a slot under the limit of turns at once. It spends no tokens or budget time while it waits.")}
            </span>
          </div>
        )}
        {phase === "verifying" && (
          <div className="flex items-start gap-2 rounded-[10px] border border-[color-mix(in_oklab,var(--cf-blue)_35%,var(--cf-border))] bg-[color-mix(in_oklab,var(--cf-blue)_6%,var(--cf-surface))] px-2.5 py-2 text-[12px] text-[var(--cf-text-muted)]">
            <ShieldCheck className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[var(--cf-blue)]" />
            <span>
              <b className="block font-medium text-[var(--cf-text)]">{l("El agente terminó; CodeFlow verifica su trabajo", "The agent finished; CodeFlow is verifying its work")}</b>
              {l("Corre las pruebas del repositorio sobre el cambio. Si fallan, la tarea vuelve al agente con el error.", "It runs the repository's tests on the change. If they fail, the task goes back to the agent with the error.")}
            </span>
          </div>
        )}
        {missing.length > 0 && (
          <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--cf-warning)] bg-[color-mix(in_oklab,var(--cf-warning)_7%,var(--cf-surface))] px-2.5 py-2 text-[12px]">
            <span className="flex items-start gap-2">
              <Link2Off className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[var(--cf-warning)]" />
              <span>
                <b className="block font-medium">{l("Depende de una tarea que no existe", "It depends on a task that does not exist")}</b>
                <span className="text-[var(--cf-text-muted)]">
                  {l("El plan la hizo esperar a ", "The plan made it wait for ")}
                  {missing.map((name, index) => <span key={name}>{index > 0 && ", "}<code className="rounded bg-[var(--cf-sunken)] px-1 font-mono text-[11px] text-[var(--cf-text)]">{name}</code></span>)}
                  {l(", que no está en ningún plan. No empieza hasta que decidas.", ", which is in no plan. It does not start until you decide.")}
                </span>
              </span>
            </span>
            <span className="flex flex-wrap gap-1.5 pl-[22px]">
              <Btn small kind="primary" title={l("La tarea empieza sin esperar a esa dependencia", "The task starts without waiting for that dependency")} onClick={() => void store.control(item.run_id, `undep:${item.id}`)}>{l("Seguir sin ella", "Go on without it")}</Btn>
              <Btn small kind="ghost" icon={SkipForward} title={l("Omite la tarea; lo que dependa de ella sigue", "Skips the task; what depends on it goes on")} onClick={() => void store.control(item.run_id, `skip:${item.id}`)}>{l("Omitir la tarea", "Skip the task")}</Btn>
            </span>
          </div>
        )}
        {item.status === "gated" && !!item.intelligence?.sandbox_hold && (
          <div className="flex items-start gap-2 rounded-[10px] border border-[var(--cf-warning)] bg-[color-mix(in_oklab,var(--cf-warning)_7%,var(--cf-surface))] px-2.5 py-2 text-[12px]">
            <ShieldAlert className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[var(--cf-warning)]" />
            <span>
              <b className="block font-medium">{l("Sus verificaciones esperan un contenedor", "Its checks wait for a container")}</b>
              <span className="text-[var(--cf-text-muted)]">{item.intelligence.sandbox_hold} {l("El trabajo del agente está guardado; no se ha verificado ni se ha ejecutado nada en este equipo. Decide arriba.", "The agent's work is kept; nothing has been checked or run on this computer. Decide above.")}</span>
            </span>
          </div>
        )}
        {item.intelligence?.outcome === "partial" && (
          <div className="rounded-[10px] border border-[var(--cf-warning)] bg-[color-mix(in_oklab,var(--cf-warning)_7%,var(--cf-surface))] px-2.5 py-2 text-[12px]">
            <b className="block font-medium">{l("La rama cerró incompleta", "The branch closed incomplete")}</b>
            <span className="text-[var(--cf-text-muted)]">{l("Algunas de sus tareas fallaron o se cancelaron. Lo entregado sigue adelante; revisa abajo qué quedó sin hacer.", "Some of its tasks failed or were cancelled. What was delivered goes on; see below what was left undone.")}</span>
          </div>
        )}
        {isWorking(item) && live?.sending && live.runId && <AiRunLog runId={live.runId} running startedAt={live.runStartedAt} density="panel" defaultOpen />}
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
          <div className={`rounded-[10px] border p-2.5 text-[12px] ${infra ? "border-[var(--cf-border-strong)]" : "border-[var(--cf-warning)]"}`}>
            <b className="font-medium">{infra ? l("CodeFlow no pudo preparar su carpeta de trabajo", "CodeFlow could not prepare its working folder") : recoveryLabel[recovery.kind] ?? recoveryLabel.other}</b>
            {infra
              ? <p className="mt-1 mb-0 text-[var(--cf-text-muted)]">{l("Lo intenta de nuevo solo. No cuenta como intento del agente ni gasta turnos.", "It tries again on its own. It does not count as an attempt of the agent's or spend turns.")}</p>
              : <p className="mt-1 mb-0 text-[var(--cf-text-muted)]">{recovery.provider} · {recovery.model}</p>}
            {recovery.resume_at && <p className="mt-1 mb-0 text-[var(--cf-text-muted)]">{infra ? l("Próximo intento", "Next try") : l("Reanudación prevista", "Scheduled resume")} · {new Date(recovery.resume_at * 1000).toLocaleTimeString()}</p>}
          </div>
        )}
        <DoneChecklist state={state} item={item} />
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
        {item.kind === "work" && !!item.started_at && (
          <Btn small kind="ghost" icon={GitFork} title={l("Empieza otra corrida desde justo antes de esta tarea, para hacerla de otra forma o con otro equipo. Esta corrida no se toca.", "Starts another run from just before this task, to do it another way or with another team. This run is not touched.")} onClick={() => crew.open({ kind: "fork", runId: state.run.id, itemId: item.id })}>{l("Bifurcar desde aquí", "Fork from here")}</Btn>
        )}
        {["pending", "gated", "error", "waiting"].includes(item.status) && !item.intelligence?.impact && !(item.kind === "amend" && item.status === "gated") && <Btn small icon={SkipForward} title={l("La omite y deja seguir a las que dependen de ella", "Skips it and lets dependent tasks go on")} onClick={() => void store.control(item.run_id, `skip:${item.id}`)}>{l("Saltar", "Skip")}</Btn>}
      </div>
    </motion.aside>
  );
}
