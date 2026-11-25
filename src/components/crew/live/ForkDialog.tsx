/**
 * «Bifurcar»: start a new run from where another one was — from just before one of its tasks, or
 * from what it has integrated — to try the rest another way or with another team.
 *
 * The fork is an ordinary run on branches of its own (`codeflow/fork-…`): it lands there, and the
 * original run, what it delivered and its target branch are never touched. This dialog only asks
 * what the fork is for and who does it.
 */
import { useState } from "react";
import { GitBranch, GitFork, ListChecks, ShieldCheck } from "lucide-react";
import { useTeamStore } from "../../../state/teamStore";
import { pushErrorToast } from "../../../state/toastStore";
import { teamForkRun } from "../../../lib/tauri/teamCommands";
import { Btn, Label, Modal, SelectBox, field } from "../kit/ui";
import { useCrewStore, useL } from "../state";

export function ForkDialog({ runId, itemId }: { runId: string; itemId?: string }) {
  const l = useL();
  const crew = useCrewStore();
  const state = useTeamStore((s) => s.states[runId]);
  const teams = useTeamStore((s) => s.teams);
  const [goal, setGoal] = useState("");
  const [teamId, setTeamId] = useState("");
  const [busy, setBusy] = useState(false);
  if (!state) return null;
  const { run } = state;
  const item = itemId ? state.items.find((i) => i.id === itemId) : undefined;
  // What is already in the code the fork starts from: the same rule the engine applies.
  const kept = state.items.filter((i) => i.kind === "work" && i.status === "done" && i.merged && (!item || (i.finished_at && i.finished_at <= item.started_at)));
  const sameTeam = !teamId || teamId === run.team_id;

  const fork = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const forked = await teamForkRun({ runId, itemId, goal: goal.trim() || undefined, teamId: teamId || undefined });
      const store = useTeamStore.getState();
      await store.load(run.workspace_id);
      await store.select(forked.run.id);
      crew.close();
      crew.setSpace("en-vivo");
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={l("Bifurcar la corrida", "Fork the run")}
      subtitle={item ? l(`Desde justo antes de «${item.title}»`, `From just before «${item.title}»`) : l(`Desde lo que «${run.title}» lleva integrado`, `From what «${run.title}» has integrated`)}
      leading={<span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"><GitFork className="h-5 w-5" /></span>}
      onClose={() => crew.close()}
      footer={
        <>
          <span className="flex-1" />
          <Btn kind="ghost" onClick={() => crew.close()}>{l("Cancelar", "Cancel")}</Btn>
          <Btn kind="primary" icon={GitFork} disabled={busy} title={l("Crea la corrida nueva y la abre", "Creates the new run and opens it")} onClick={() => void fork()}>{busy ? l("Bifurcando…", "Forking…") : l("Bifurcar", "Fork")}</Btn>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <Label>{l("Qué debe lograr la bifurcación", "What the fork is for")}</Label>
        <textarea
          autoFocus
          rows={3}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={item ? l(`Otra forma de hacer «${item.title}»… (vacío: el mismo objetivo)`, `Another way to do «${item.title}»… (empty: the same goal)`) : l("Vacío: el mismo objetivo de la corrida", "Empty: the run's own goal")}
          className={`${field} h-auto resize-y py-2 leading-snug`}
        />
        <span className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
          {l("Se le dice al equipo qué estaba hecho en ese punto para que planifique solo lo que falta.", "The team is told what was done at that point, so it plans only what is left.")}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>{l("Quién la hace", "Who does it")}</Label>
        <SelectBox value={teamId || run.team_id} onChange={(id) => setTeamId(id === run.team_id ? "" : id)} ariaLabel={l("Equipo de la bifurcación", "The fork's team")}>
          {!teams.some((t) => t.id === run.team_id) && <option value={run.team_id}>{run.team_name}</option>}
          {teams.map((t) => <option key={t.id} value={t.id}>{t.id === run.team_id ? l(`${t.name} (el mismo)`, `${t.name} (the same)`) : t.name}</option>)}
        </SelectBox>
        <span className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
          {sameTeam
            ? l("El mismo equipo, con las reglas con las que corrió la original.", "The same team, with the rules the original ran with.")
            : l("Otro equipo, con sus propias reglas, sobre el mismo punto de partida.", "Another team, with its own rules, from the same starting point.")}
        </span>
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 rounded-[12px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 text-[12px] leading-snug">
        <li className="flex items-start gap-2">
          <ListChecks className="mt-[1px] h-3.5 w-3.5 shrink-0 text-[var(--cf-text-muted)]" />
          <span>
            {kept.length === 0
              ? l("Parte sin nada del trabajo de la corrida original.", "It starts with none of the original run's work.")
              : kept.length === 1
                ? l("Parte con 1 tarea ya hecha en el código: ", "It starts with 1 task already in the code: ")
                : l(`Parte con ${kept.length} tareas ya hechas en el código: `, `It starts with ${kept.length} tasks already in the code: `)}
            {kept.slice(0, 4).map((i, index) => <span key={i.id}>{index > 0 && ", "}<b className="font-medium">{i.title}</b></span>)}
            {kept.length > 4 && l(` y ${kept.length - 4} más`, ` and ${kept.length - 4} more`)}
            {kept.length > 0 && "."}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <GitBranch className="mt-[1px] h-3.5 w-3.5 shrink-0 text-[var(--cf-text-muted)]" />
          <span>{l("Trabaja y entrega en una rama propia, ", "It works and delivers on a branch of its own, ")}<code className="rounded bg-[var(--cf-sunken)] px-1 font-mono text-[11px]">codeflow/fork-…</code>{l(". Tú decides después si la integras.", ". You decide later whether to merge it.")}</span>
        </li>
        <li className="flex items-start gap-2">
          <ShieldCheck className="mt-[1px] h-3.5 w-3.5 shrink-0 text-[var(--cf-success)]" />
          <span>{l("La corrida original sigue como está: ni sus tareas, ni lo que entregó, ni su rama destino se tocan.", "The original run stays as it is: its tasks, what it delivered and its target branch are not touched.")}</span>
        </li>
      </ul>
    </Modal>
  );
}
