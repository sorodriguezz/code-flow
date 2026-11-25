/**
 * A team a chat proposed: read it, then create it or throw it away.
 *
 * A turn that may not change the app — plan mode, a CLI that only ever reads — can still design
 * a team (`team_create`); what it designed waits here for the user's own yes. Nothing exists
 * until «Crear equipo»: no agent in the roster, no team in the list. The backend checks the
 * proposal again on accept, against the workspace as it is by then.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Crown, Eye, FlaskConical, Glasses, Lightbulb, PenLine, ShieldAlert, Sparkles, Star, Trash2, UserRoundCheck, Workflow } from "lucide-react";
import { useTeamStore } from "../../../state/teamStore";
import { useT } from "../../../state/languageStore";
import { pushErrorToast } from "../../../state/toastStore";
import { modelDisplayLabel, providerDisplayLabel } from "../../../lib/aiProviders";
import { teamProposalAccept, teamProposalDismiss, type TeamProposal, type TeamProposalSeat } from "../../../lib/tauri/teamCommands";
import { flagText, policyFacts, seatDepth } from "../../../lib/agents/teamProposal";
import { AgentAvatar, TeamAvatar } from "../kit/Avatar";
import { Btn, Chip, Label, Modal, SPRING } from "../kit/ui";
import { useCrewStore, useL } from "../state";

function SeatRow({ seat, prompt, depth }: { seat: TeamProposalSeat; prompt?: string; depth: number }) {
  const l = useL();
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <motion.li layout transition={SPRING} className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]" style={{ marginLeft: depth * 22 }}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <AgentAvatar agent={{ id: seat.agent || seat.name, icon: seat.icon || undefined, color: seat.color || undefined }} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <b className="text-[13px]">{seat.name}</b>
            {seat.lead && <span title={l("Lidera: planifica el objetivo y reparte el trabajo", "Leads: plans the goal and hands out the work")}><Crown className="h-3.5 w-3.5 text-[var(--cf-warning)]" /></span>}
            {seat.subLead && <span title={l("Sub-líder: reparte el trabajo de su rama", "Sub-lead: hands out its branch's work")}><Star className="h-3.5 w-3.5 text-[var(--cf-accent)]" /></span>}
            {seat.advisor && <span title={l("Asesor: lee el plan y el resultado, no recibe tareas", "Advisor: reads the plan and the result, takes no tasks")}><Lightbulb className="h-3.5 w-3.5 text-[var(--cf-violet)]" /></span>}
            {seat.reviewer && <span title={l("Revisa cada cambio antes de integrarlo", "Reviews every change before it is integrated")}><Glasses className="h-3.5 w-3.5 text-[var(--cf-blue)]" /></span>}
            {seat.fresh ? (
              <Chip tone="accent" icon={Sparkles} title={l("Este agente no existe todavía: se crea al aceptar", "This agent does not exist yet: accepting creates it")}>{l("Agente nuevo", "New agent")}</Chip>
            ) : (
              <Chip icon={UserRoundCheck} title={l("Un agente que ya está en tu roster", "An agent already in your roster")}>{seat.agent}</Chip>
            )}
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-[var(--cf-text-muted)]">{seat.role}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--cf-text-faint)]">
            <span className="rounded-md bg-[var(--cf-hover)] px-1.5 py-0.5 text-[var(--cf-text-muted)]" title={l("El proveedor y el modelo con que trabaja", "The provider and model it works on")}>
              {providerDisplayLabel(seat.provider, t)} · {modelDisplayLabel(seat.provider, seat.model, t)}
            </span>
            <span className="inline-flex items-center gap-1" title={seat.edits ? l("Puede cambiar archivos", "May change files") : l("Solo lectura: investiga o revisa", "Read-only: investigates or reviews")}>
              {seat.edits ? <PenLine className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {seat.edits ? l("escribe", "writes") : l("solo lee", "read-only")}
            </span>
            <span>· {seat.repos.length ? seat.repos.join(", ") : l("todos los repositorios", "every repository")}</span>
            {seat.handsOn && <span>· {l("también toma tareas", "also takes tasks")}</span>}
          </div>
        </div>
        {prompt && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            title={l("Las instrucciones permanentes que tendrá este agente", "The standing instructions this agent will have")}
            className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
          >
            {l("Instrucciones", "Instructions")}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && prompt && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SPRING} className="overflow-hidden">
            <p className="mx-3 mb-3 max-h-[220px] overflow-y-auto whitespace-pre-wrap rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2 text-[12px] leading-relaxed text-[var(--cf-text)]">{prompt}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

export function ProposalBody({ proposal }: { proposal: TeamProposal }) {
  const l = useL();
  const { team, seats } = proposal;
  const reviewer = seats.find((s) => s.reviewer)?.name ?? "";
  const whenText = (when: string) => (when === "item" ? l("tras cada tarea", "after every task") : when === "agent" ? l("la corren los miembros", "run by the members") : l("al final, con todo integrado", "at the end, with everything integrated"));
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip>{l(`${seats.length} ${seats.length === 1 ? "puesto" : "puestos"}`, `${seats.length} ${seats.length === 1 ? "seat" : "seats"}`)}</Chip>
        {proposal.agents.length > 0 ? (
          <Chip tone="accent" icon={Sparkles}>{l(`Crea ${proposal.agents.length} ${proposal.agents.length === 1 ? "agente" : "agentes"}`, `Creates ${proposal.agents.length} ${proposal.agents.length === 1 ? "agent" : "agents"}`)}</Chip>
        ) : (
          <Chip icon={UserRoundCheck}>{l("Solo usa agentes que ya tienes", "Uses only agents you already have")}</Chip>
        )}
        {proposal.updating && <Chip tone="warn">{l("Reemplaza el equipo que ya existe con este nombre", "Replaces the team that already has this name")}</Chip>}
      </div>

      <section className="flex flex-col gap-1.5">
        <Label>{l("Quién lo forma", "Who is in it")}</Label>
        <ul className="flex flex-col gap-1.5">
          {seats.map((seat) => (
            <SeatRow key={seat.name} seat={seat} depth={seatDepth(seat, seats)} prompt={seat.fresh ? proposal.agents.find((a) => a.name === seat.agent)?.prompt : undefined} />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-1.5">
        <Label>{l("Qué verifica", "What it checks")}</Label>
        {team.policy.checks.length === 0 ? (
          <p className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
            <FlaskConical className="h-3.5 w-3.5 shrink-0" />
            {team.policy.auto_checks ? l("Las pruebas de cada repositorio, detectadas al lanzar la corrida.", "Each repository's own suites, detected when a run starts.") : l("Nada: no lista verificaciones y la detección está apagada.", "Nothing: it lists no checks and detection is off.")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {team.policy.checks.map((check, i) => (
              <li key={`${check.command}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
                <code className="rounded bg-[var(--cf-hover)] px-1.5 py-0.5 text-[11.5px]">{check.command}</code>
                <span className="text-[var(--cf-text-muted)]">{whenText(check.when)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <Label>{l("Cómo trabaja", "How it works")}</Label>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
          {policyFacts(team.policy, reviewer, l).map((fact) => (
            <div key={fact.label} className="flex items-baseline justify-between gap-3 border-b border-[var(--cf-border)] py-1">
              <dt className="shrink-0 text-[var(--cf-text-muted)]">{fact.label}</dt>
              <dd className="text-right">{fact.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {proposal.flags.length > 0 && (
        <section className="flex flex-col gap-1.5 rounded-lg border border-[color-mix(in_oklab,var(--cf-warning)_40%,transparent)] bg-[color-mix(in_oklab,var(--cf-warning)_8%,transparent)] px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-[12px] font-semibold"><ShieldAlert className="h-3.5 w-3.5 text-[var(--cf-warning)]" />{l("Ten en cuenta", "Keep in mind")}</span>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[12px] leading-snug text-[var(--cf-text-muted)]">
            {proposal.flags.map((flag, i) => (
              <li key={`${flag.kind}-${flag.who}-${i}`}>{flagText(flag, l)}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function TeamProposalDialog({ id }: { id: string }) {
  const l = useL();
  const crew = useCrewStore();
  const proposal = useTeamStore((s) => s.proposals.find((p) => p.id === id));
  const [busy, setBusy] = useState(false);

  // Accepted or thrown away from another window: there is nothing left to decide here.
  useEffect(() => {
    if (!proposal && !busy) crew.close();
  }, [proposal, busy, crew]);
  if (!proposal) return null;

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const team = await teamProposalAccept(id);
      const store = useTeamStore.getState();
      await store.load(team.workspace_id);
      crew.close();
      crew.setSpace("equipos");
      crew.set({ selectedTeamId: team.id, selectedMemberId: null });
    } catch (e) {
      pushErrorToast(String(e));
      setBusy(false);
    }
  };
  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    await teamProposalDismiss(id).catch((e: unknown) => pushErrorToast(String(e)));
    await useTeamStore.getState().loadProposals(proposal.workspaceId);
    crew.close();
  };

  return (
    <Modal
      wide
      title={proposal.team.name}
      subtitle={proposal.team.description}
      leading={<TeamAvatar size={40} />}
      onClose={() => crew.close()}
      footer={
        <>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-[var(--cf-text-faint)]">
            <Workflow className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{l("Lo propuso el chat. Nada existe hasta que lo crees, y nada corre hasta que lo lances.", "The chat proposed it. Nothing exists until you create it, and nothing runs until you launch it.")}</span>
          </span>
          <Btn kind="ghost" icon={Trash2} disabled={busy} title={l("Tira la propuesta: no se crea nada", "Throws the proposal away: nothing is created")} onClick={() => void dismiss()}>{l("Descartar", "Discard")}</Btn>
          <Btn kind="primary" icon={Sparkles} disabled={busy} title={l("Crea los agentes que falten y el equipo, tal como se ve aquí", "Creates the missing agents and the team, as shown here")} onClick={() => void accept()}>
            {busy ? l("Creando…", "Creating…") : proposal.updating ? l("Reemplazar equipo", "Replace team") : l("Crear equipo", "Create team")}
          </Btn>
        </>
      }
    >
      <ProposalBody proposal={proposal} />
    </Modal>
  );
}

/** The proposals waiting in this workspace, above the list of teams: a notice can be missed. */
export function ProposalBanner() {
  const l = useL();
  const crew = useCrewStore();
  const proposals = useTeamStore((s) => s.proposals);
  if (proposals.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-accent-soft)] px-3.5 py-2.5">
      {proposals.map((proposal) => (
        <div key={proposal.id} className="flex items-center gap-2.5">
          <Sparkles className="h-4 w-4 shrink-0 text-[var(--cf-accent)]" />
          <span className="min-w-0 flex-1 truncate text-[12.5px]">
            {proposal.updating ? l("El chat propone cambiar el equipo ", "The chat proposes changing the team ") : l("El chat propone el equipo ", "The chat proposes the team ")}
            <b>«{proposal.team.name}»</b>
            <span className="text-[var(--cf-text-muted)]">
              {" · "}
              {l(`${proposal.seats.length} ${proposal.seats.length === 1 ? "puesto" : "puestos"}`, `${proposal.seats.length} ${proposal.seats.length === 1 ? "seat" : "seats"}`)}
              {proposal.agents.length > 0 && l(`, ${proposal.agents.length} ${proposal.agents.length === 1 ? "agente nuevo" : "agentes nuevos"}`, `, ${proposal.agents.length} new ${proposal.agents.length === 1 ? "agent" : "agents"}`)}
            </span>
          </span>
          <Btn small kind="primary" title={l("Mira la propuesta completa antes de decidir", "See the whole proposal before deciding")} onClick={() => crew.open({ kind: "teamProposal", id: proposal.id })}>{l("Revisar", "Review")}</Btn>
        </div>
      ))}
    </div>
  );
}
