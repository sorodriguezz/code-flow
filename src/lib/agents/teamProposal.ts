/**
 * A proposed team in words (`team::designer`'s `Proposal`): what each thing to keep in mind says
 * in the user's language, how the team runs in a handful of facts, and where each seat sits under
 * the lead. Pure — the review dialog draws from it.
 */
import type { TeamProposalFlag, TeamProposalSeat } from "../tauri/teamCommands";
import type { TeamPolicy } from "../../types/team";

type L = (es: string, en: string) => string;

/** A flag in the user's words. */
export function flagText(flag: TeamProposalFlag, l: L): string {
  switch (flag.kind) {
    case "model_unchecked":
      return l(`No se pudo comprobar que el modelo de «${flag.who}» (${flag.what}) exista: si no existe, sus turnos fallarán. Lo puedes cambiar en Agentes.`, `«${flag.who}»'s model (${flag.what}) could not be checked: if it does not exist, its turns will fail. You can change it in Agents.`);
    case "agent_off":
      return l(`«${flag.who}» está apagado en tu roster.`, `«${flag.who}» is switched off in your roster.`);
    case "sublead_alone":
      return l(`«${flag.who}» figura como sub-líder, pero nadie le reporta.`, `«${flag.who}» is marked as a sub-lead, and nobody reports to it.`);
    case "no_engine":
      return l("Pide verificaciones aisladas y no hay un motor de contenedores en marcha: la corrida se detendrá a preguntarte antes de verificar.", "It asks for isolated checks and no container engine is running: a run will stop and ask you before it checks anything.");
    case "nobody_writes":
      return l("Ningún puesto puede escribir: este equipo investiga y revisa, no cambia código.", "No seat may write: this team investigates and reviews, it does not change code.");
    case "read_only_unenforced":
      return l(`«${flag.who}» no debe escribir, pero ${flag.what} no lo impide: solo se le pide.`, `«${flag.who}» must not write, but ${flag.what} does not enforce it: it is only asked not to.`);
    case "unmetered":
      return l(`«${flag.who}» corre en ${flag.what}, que no publica su consumo, y el equipo no pone tope de minutos.`, `«${flag.who}» runs on ${flag.what}, which publishes no consumption, and the team sets no cap on minutes.`);
    case "guarantees_block":
      return l("Con las garantías en «Exigir», el equipo no arrancará hasta que se cierren los puntos de abajo.", "With guarantees set to «Require», the team will not start until the points below are closed.");
    case "merge_unasked":
      return l("El trabajo terminado se integra en la rama de destino sin preguntarte.", "Finished work is merged into the target branch without asking you.");
  }
}

/** How the team runs, in the handful of facts worth reading before saying yes. */
export function policyFacts(policy: TeamPolicy, reviewer: string, l: L): { label: string; value: string }[] {
  const asks = (on: boolean) => (on ? l("te pregunta", "asks you") : l("no pregunta", "does not ask"));
  return [
    { label: l("El plan", "The plan"), value: asks(policy.approve_plan) },
    {
      label: l("Al integrar", "Integrating"),
      value: `${policy.integrate === "pr" ? l("abre un pull request", "opens a pull request") : policy.integrate === "branch" ? l("lo deja en una rama", "leaves it on a branch") : l("a la rama de destino", "into the target branch")} · ${asks(policy.approve_merge)}`,
    },
    { label: l("Revisión", "Review"), value: policy.review.enabled ? l(`${reviewer || "un miembro"} lee cada cambio`, `${reviewer || "a member"} reads every change`) : l("sin revisor", "no reviewer") },
    { label: l("En paralelo", "At once"), value: l(`hasta ${policy.max_parallel} tareas`, `up to ${policy.max_parallel} tasks`) },
    { label: l("Verificaciones", "Checks"), value: policy.sandbox === "checks" ? l("aisladas en un contenedor", "isolated in a container") : l("en este equipo", "on this computer") },
    { label: l("Ritmo", "Pace"), value: policy.single_pass ? l("una pasada por agente", "one pass per agent") : l("itera hasta cerrar", "iterates until done") },
  ];
}

/** Hops from the lead: the lead and the advisor sit at 0, whoever answers to the lead at 1. */
export function seatDepth(seat: TeamProposalSeat, seats: TeamProposalSeat[]): number {
  if (seat.lead || seat.advisor) return 0;
  let depth = 1;
  let current = seat;
  while (current.reportsTo && depth < 4) {
    const boss = seats.find((s) => s.name === current.reportsTo);
    if (!boss || boss.lead) break;
    current = boss;
    depth++;
  }
  return depth;
}
