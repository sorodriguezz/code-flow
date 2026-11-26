/**
 * «Permisos y aislamiento»: what a team's agents may do without asking, where the app runs its
 * checks, and what each member's provider can really be held to.
 *
 * The permissions are the chat's two, for the whole team: «Restringido» (the default — anything
 * destructive waits for a yes) or «Completo» (nothing is asked), for a proof of concept or a
 * throwaway repository. Only chosen here: a team a model designs or a file brings starts restricted.
 *
 * Two things a team used to take on faith. A check is code an agent just wrote, run by the app:
 * here the team chooses whether it runs on this computer or in a container that cannot touch it.
 * And «this member must not write» or «this run has a budget» only hold where the provider lets
 * the app enforce them; the list below says, member by member, where it does not — before a run
 * starts, not after.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleSlash, Container, Gauge, MonitorSmartphone, PencilLine, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useAgentsStore } from "../../../state/agentsStore";
import { providerCaps, type ProviderCaps } from "../../../lib/tauri/commands";
import { teamSandboxStatus, type TeamSandboxStatus } from "../../../lib/tauri/teamCommands";
import type { Team, TeamPolicy } from "../../../types/team";
import { AgentAvatar } from "../kit/Avatar";
import { Panel, Seg, field } from "../kit/ui";
import { useL } from "../state";

let capsCache: ProviderCaps[] | null = null;

/** What a member needs of its provider and does not get — the engine's own rule
 *  (`provider_caps::gaps`), so the editor and the run say the same thing. */
export function memberGaps(caps: ProviderCaps | undefined, writes: boolean, bounded: boolean): ("read_only" | "meter")[] {
  if (!caps) return [];
  const gaps: ("read_only" | "meter")[] = [];
  if (!writes && !caps.guarantees.readOnly) gaps.push("read_only");
  if (!caps.guarantees.metered && !bounded) gaps.push("meter");
  return gaps;
}

function EngineLine({ status, onRefresh, busy, wanted }: { status: TeamSandboxStatus | null; onRefresh: () => void; busy: boolean; wanted: boolean }) {
  const l = useL();
  const [color, text] = !status
    ? ["var(--cf-border-strong)", l("Buscando un motor de contenedores…", "Looking for a container engine…")]
    : status.available
      ? ["var(--cf-success)", l(`${status.engine} en marcha`, `${status.engine} is running`)]
      : status.problem === "stopped"
        ? ["var(--cf-warning)", l(`${status.engine || "El motor"} está instalado pero no responde`, `${status.engine || "The engine"} is installed but not answering`)]
        : ["var(--cf-text-faint)", l("No hay motor de contenedores en este equipo", "No container engine on this computer")];
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
      <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${status?.available ? "" : wanted && status ? "cf-crew-waiting" : ""}`} style={{ background: color }} />
      <span className="min-w-0 flex-1 truncate" style={wanted && status && !status.available ? { color: "var(--cf-warning)" } : undefined}>{text}</span>
      <button type="button" disabled={busy} title={l("Vuelve a preguntar al motor de contenedores", "Asks the container engine again")} aria-label={l("Volver a mirar", "Look again")} onClick={onRefresh} className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[6px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] disabled:opacity-50">
        <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} />
      </button>
    </span>
  );
}

export function SafetyPanel({ team, set, open, onToggle }: { team: Team; set: (patch: Partial<TeamPolicy>, now?: boolean) => void; open: boolean; onToggle: () => void }) {
  const l = useL();
  const roster = useAgentsStore((s) => s.roster);
  const p = team.policy;
  const sandbox = p.sandbox ?? "off";
  const guarantees = p.guarantees ?? "warn";
  const permissions = p.permissions ?? "restricted";
  const full = permissions === "full";
  const [status, setStatus] = useState<TeamSandboxStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [caps, setCaps] = useState<ProviderCaps[] | null>(capsCache);

  const look = useCallback(async (fresh: boolean) => {
    setBusy(true);
    try {
      setStatus(await teamSandboxStatus(fresh));
    } catch {
      setStatus({ available: false, engine: "", problem: "none" });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void look(false);
    if (!capsCache) {
      void providerCaps().then((all) => {
        capsCache = all;
        setCaps(all);
      }).catch(() => setCaps([]));
    }
  }, [open, look]);

  const bounded = (p.unmetered_minutes ?? 0) > 0 || (p.budget_minutes ?? 0) > 0;
  const members = useMemo(
    () =>
      team.members.map((m) => {
        const agent = roster.find((a) => a.id === m.agent_id);
        const cap = caps?.find((c) => c.id === agent?.provider);
        return { member: m, agent, label: cap?.label ?? agent?.provider ?? "", gaps: agent ? memberGaps(cap, m.edits, bounded) : [] };
      }),
    [team.members, roster, caps, bounded],
  );
  const open_gaps = members.reduce((n, m) => n + m.gaps.length, 0);
  const badge = (sandbox === "checks" && status && !status.available) || (guarantees !== "off" && open_gaps > 0);

  return (
    <Panel
      title={<span className="inline-flex items-center gap-1.5">{l("Permisos y aislamiento", "Permissions and isolation")}{full && <span title={l("Los agentes de este equipo no preguntan antes de nada", "This team's agents ask before nothing")} className="rounded-full bg-[color-mix(in_oklab,var(--cf-warning)_16%,transparent)] px-1.5 py-[1px] text-[10px] font-medium text-[var(--cf-warning)]">{l("Completo", "Full")}</span>}{badge && <span title={l("Hay algo que revisar aquí", "There is something to look at here")} className="h-[6px] w-[6px] rounded-full bg-[var(--cf-warning)]" />}</span>}
      icon={Container}
      open={open}
      onToggle={onToggle}
    >
      <div className={`flex flex-col gap-2 rounded-[10px] border bg-[var(--cf-surface-raised)] p-2.5 ${full ? "border-[color-mix(in_oklab,var(--cf-warning)_45%,var(--cf-border))]" : "border-[var(--cf-border)]"}`}>
        <span className="text-[12.5px] font-medium">{l("Permisos de los agentes", "Agent permissions")}</span>
        <Seg
          size="sm"
          full
          value={permissions}
          onChange={(value) => set({ permissions: value })}
          options={[
            { value: "restricted" as const, label: l("Restringido", "Restricted"), icon: ShieldCheck, title: l("Trabajan solos, pero lo destructivo espera tu sí", "They work on their own, but anything destructive waits for your yes") },
            { value: "full" as const, label: l("Completo", "Full"), icon: ShieldAlert, title: l("No preguntan nada: pensado para una prueba de concepto o un repositorio desechable", "They ask nothing: meant for a proof of concept or a throwaway repository") },
          ]}
        />
        <span className={`flex items-start gap-1.5 text-[11.5px] leading-snug ${full ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-muted)]"}`}>
          {full && <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" />}
          <span>
            {full
              ? l("Los agentes no te preguntan nada: ejecutan comandos destructivos (rm -rf, force-push, borrar una tabla…), usan credenciales guardadas y hacen acciones de la app que borran o sobrescriben, también dentro de un script. Vale para las nuevas corridas y para el chat y las llamadas con el equipo. Las corridas en marcha conservan su configuración. Los miembros de solo lectura conservan los permisos de su rol.", "The agents ask you nothing: they run destructive commands (rm -rf, force-push, dropping a table…), use saved credentials and take app actions that delete or overwrite, inside a script too. It applies to new runs and to team chats and calls. Runs under way keep their existing settings. Read-only members keep their role permissions.")
              : l("Los agentes ejecutan comandos y editan solos, pero un comando destructivo, usar una credencial guardada o una acción de la app que borra o sobrescribe espera tu sí. Dentro de un script esas acciones no corren: el agente las pide de una en una.", "The agents run commands and edit on their own, but a destructive command, using a saved credential or an app action that deletes or overwrites waits for your yes. Inside a script those actions do not run: the agent asks for them one at a time.")}
          </span>
        </span>
      </div>

      <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2.5">
        <span className="text-[12.5px] font-medium">{l("Dónde corren las verificaciones", "Where the checks run")}</span>
        <Seg
          size="sm"
          full
          value={sandbox}
          onChange={(value) => set({ sandbox: value })}
          options={[
            { value: "off" as const, label: l("En este equipo", "On this computer"), icon: MonitorSmartphone, title: l("Las pruebas y la instalación de dependencias corren aquí, con tu usuario", "The tests and the dependency install run here, as your user") },
            { value: "checks" as const, label: l("En un contenedor", "In a container"), icon: Container, title: l("Cada verificación corre en un contenedor, sobre una copia del código", "Each check runs in a container, on a copy of the code") },
          ]}
        />
        <EngineLine status={status} busy={busy} wanted={sandbox === "checks"} onRefresh={() => void look(true)} />
        <span className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
          {sandbox === "off"
            ? l("Lo que un agente acaba de escribir se ejecuta con tu usuario, tus archivos y tu red. Es lo más rápido y lo que hacías hasta ahora.", "What an agent just wrote runs as your user, with your files and your network. It is the fastest, and what you did until now.")
            : l("Cada verificación corre sobre una copia del código, sin red, sin permisos de administrador y con límites de memoria y procesos; las dependencias se instalan dentro. Nada de lo que haga llega a tu carpeta. Si el motor no está, la corrida se detiene y te pregunta: nunca pasa a este equipo por su cuenta.", "Each check runs on a copy of the code, with no network, no admin rights and memory and process limits; dependencies install inside. Nothing it does reaches your folder. If the engine is not there, the run stops and asks you: it never falls back to this computer on its own.")}
        </span>
        {sandbox === "checks" && (
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-[var(--cf-text-muted)]">{l("Imagen", "Image")}</span>
            <input
              value={p.sandbox_image ?? ""}
              onChange={(e) => set({ sandbox_image: e.target.value }, false)}
              onBlur={(e) => set({ sandbox_image: e.target.value.trim() })}
              spellCheck={false}
              placeholder={l("Automática, según el repositorio", "Automatic, from the repository")}
              title={l("Vacío: Node, Rust, Go o Python según lo que sea el repositorio. Pon aquí la tuya si las pruebas necesitan algo más.", "Empty: Node, Rust, Go or Python by what the repository is. Put your own here if the tests need more.")}
              className={`${field} h-[28px] font-mono !text-[11.5px]`}
            />
          </label>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2.5">
        <span className="text-[12.5px] font-medium">{l("Lo que cada proveedor garantiza", "What each provider guarantees")}</span>
        <Seg
          size="sm"
          full
          value={guarantees}
          onChange={(value) => set({ guarantees: value })}
          options={[
            { value: "off" as const, label: l("No mirar", "Ignore"), title: l("La corrida empieza sin comprobar nada de esto", "The run starts without checking any of this") },
            { value: "warn" as const, label: l("Avisar", "Flag"), title: l("La corrida empieza y deja el aviso en el canal", "The run starts and leaves the notice in the channel") },
            { value: "block" as const, label: l("Exigir", "Require"), title: l("La corrida no empieza mientras quede un hueco", "The run does not start while a gap is open") },
          ]}
        />
        <ul className="m-0 flex list-none flex-col gap-0 overflow-hidden rounded-[8px] border border-[var(--cf-border)] p-0">
          {members.map(({ member, agent, label, gaps }) => (
            <li key={member.id} className="flex items-start gap-2 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1.5 first:border-t-0">
              <span className="mt-0.5 shrink-0">{agent ? <AgentAvatar agent={agent} size={20} /> : <span className="grid h-5 w-5 place-items-center rounded-[6px] border border-dashed border-[var(--cf-border-strong)]"><CircleSlash className="h-3 w-3 text-[var(--cf-text-faint)]" /></span>}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <b className="truncate text-[12px] font-medium">{member.name || agent?.name || l("Miembro", "Member")}</b>
                  <span className="shrink-0 text-[11px] text-[var(--cf-text-faint)]">{label || l("sin agente", "no agent")}</span>
                </span>
                {gaps.length === 0 ? (
                  <span className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
                    <CheckCircle2 className="h-3 w-3 text-[var(--cf-success)]" />
                    {member.edits ? l("Escribe, como pide el equipo", "Writes, as the team asks") : l("Solo lectura, impuesta por su proveedor", "Read-only, enforced by its provider")}
                  </span>
                ) : (
                  gaps.map((gap) => (
                    <span key={gap} className="flex items-start gap-1 text-[11px] leading-snug text-[var(--cf-warning)]">
                      {gap === "read_only" ? <PencilLine className="mt-[1px] h-3 w-3 shrink-0" /> : <Gauge className="mt-[1px] h-3 w-3 shrink-0" />}
                      {gap === "read_only"
                        ? l(`No debe escribir, pero ${label} no lo impide: solo se le pide`, `It must not write, but ${label} does not prevent it: it is only asked`)
                        : l(`${label} no publica su consumo y el equipo no pone tope de minutos`, `${label} publishes no consumption and the team sets no minutes cap`)}
                    </span>
                  ))
                )}
              </span>
            </li>
          ))}
          {members.length === 0 && <li className="px-2 py-2 text-[11.5px] text-[var(--cf-text-muted)]">{l("El equipo aún no tiene miembros.", "The team has no members yet.")}</li>}
        </ul>
        <span className="flex items-start gap-1.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
          {open_gaps > 0 && guarantees !== "off" ? <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0 text-[var(--cf-warning)]" /> : <ShieldCheck className="mt-[1px] h-3.5 w-3.5 shrink-0 text-[var(--cf-text-faint)]" />}
          <span>
            {guarantees === "off"
              ? l("No se comprueba: un miembro de solo lectura podría escribir si su proveedor no lo impide.", "Not checked: a read-only member could write if its provider does not prevent it.")
              : open_gaps === 0
                ? l("Sin huecos: lo que el equipo pide de cada miembro, su proveedor lo hace cumplir.", "No gaps: what the team asks of each member, its provider enforces.")
                : guarantees === "warn"
                  ? l("La corrida empieza igual y deja estos huecos anotados en el canal. Se cierran cambiando el proveedor del agente o poniendo un tope de minutos en Presupuesto.", "The run starts anyway and notes these gaps in the channel. Close them by changing the agent's provider or setting a minutes cap under Budget.")
                  : l("Con huecos abiertos la corrida no empieza. Se cierran cambiando el proveedor del agente o poniendo un tope de minutos en Presupuesto.", "With open gaps the run does not start. Close them by changing the agent's provider or setting a minutes cap under Budget.")}
          </span>
        </span>
      </div>
    </Panel>
  );
}
