/**
 * «Comparar equipos»: the same task given to several teams from the same commit, side by side.
 *
 * Each team runs on a branch of its own and nothing lands; when they close, the same checks run
 * on every result. What is compared is what a run already says about itself — checks passed,
 * tasks delivered, attempts, cost, time, size of the change — one row per measure, one column per
 * team, the best of each row marked. The runs are ordinary runs: «Ver corrida» opens one live.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowUpRight, CircleDashed, GitBranch, GitCommitHorizontal, Hand, Loader2, Plus, RefreshCw, Scale, ShieldCheck, Trash2, Trophy, XCircle } from "lucide-react";
import { useTeamStore } from "../../../state/teamStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { pushErrorToast } from "../../../state/toastStore";
import { confirmAction } from "../../../state/confirmStore";
import { teamEvalDelete, teamEvalScore, teamEvalStart, teamEvals, type TeamEval, type TeamEvalEntry } from "../../../lib/tauri/teamCommands";
import { TeamAvatar } from "../kit/Avatar";
import { Btn, Chip, Empty, IconBtn, Label, Modal, SelectBox, SOFT, ToggleChip, field, type Tone } from "../kit/ui";
import { money, useCrewStore, useL } from "../state";

type L = (es: string, en: string) => string;
const MAX_TEAMS = 4;
const NO_PROJECTS: never[] = [];

function statusLook(entry: TeamEvalEntry, l: L): { label: string; tone: Tone; icon: typeof Loader2; spin?: boolean } {
  switch (entry.status) {
    case "running":
      return { label: l("Trabajando", "Working"), tone: "accent", icon: Loader2, spin: true };
    case "gated":
      return { label: l("Te espera", "Waiting on you"), tone: "warn", icon: Hand };
    case "paused":
      return { label: l("En pausa", "Paused"), tone: "warn", icon: CircleDashed };
    case "done":
      return entry.scored ? { label: l("Terminó", "Finished"), tone: "ok", icon: ShieldCheck } : { label: l("Puntuando", "Scoring"), tone: "info", icon: Loader2, spin: true };
    case "aborted":
      return { label: l("Cancelada", "Aborted"), tone: "neutral", icon: XCircle };
    case "failed":
      return { label: l("No empezó", "Did not start"), tone: "bad", icon: AlertTriangle };
    default:
      return { label: l("Corrida borrada", "Run deleted"), tone: "neutral", icon: CircleDashed };
  }
}

function minutes(n: number, l: L): string {
  if (n <= 0) return "—";
  if (n < 1) return l("< 1 min", "< 1 min");
  if (n < 60) return `${Math.round(n)} min`;
  return `${Math.floor(n / 60)} h ${Math.round(n % 60)} min`;
}

/** One measure of the comparison: how each entry reads, and which value is the best of the row. */
interface Measure {
  key: string;
  label: string;
  hint: string;
  text: (entry: TeamEvalEntry) => React.ReactNode;
  /** The number the row is compared by; `null` when the entry has none. */
  value: (entry: TeamEvalEntry) => number | null;
  better: "higher" | "lower";
}

function ChecksCell({ entry, total }: { entry: TeamEvalEntry; total: number }) {
  const l = useL();
  if (total === 0) return <span className="text-[var(--cf-text-faint)]">—</span>;
  if (entry.scores.length === 0) return <span className="text-[var(--cf-text-faint)]">{entry.status === "done" ? l("puntuando…", "scoring…") : "—"}</span>;
  return (
    <span className="flex items-center gap-1.5">
      <span className="tabular-nums">{entry.passed}/{total}</span>
      <span className="flex items-center gap-[3px]">
        {entry.scores.map((score, index) => (
          <span
            key={index}
            title={`${score.command}\n${score.result === "passed" ? l("Pasó", "Passed") : score.result === "failed" ? l("Falló", "Failed") : l("No se pudo correr aislada", "Could not run isolated")}${score.detail && score.result !== "passed" ? `\n\n${score.detail.slice(0, 600)}` : ""}`}
            className="h-[7px] w-[7px] rounded-full"
            style={{ background: score.result === "passed" ? "var(--cf-success)" : score.result === "failed" ? "var(--cf-danger)" : "var(--cf-border-strong)" }}
          />
        ))}
      </span>
    </span>
  );
}

function measuresOf(view: TeamEval, l: L): Measure[] {
  const total = view.checks.length;
  const delivered = (e: TeamEvalEntry) => e.status === "done";
  return [
    {
      key: "checks",
      label: l("Verificaciones", "Checks"),
      hint: l("Las mismas pruebas, corridas sobre el resultado de cada equipo", "The same tests, run on each team's result"),
      text: (e) => <ChecksCell entry={e} total={total} />,
      value: (e) => (total > 0 && e.scores.length > 0 ? e.passed : null),
      better: "higher",
    },
    {
      key: "tasks",
      label: l("Tareas entregadas", "Tasks delivered"),
      hint: l("Tareas de trabajo que terminaron, de las que el equipo se propuso", "Work tasks that finished, of those the team set itself"),
      text: (e) => (e.tasksTotal > 0 ? <span className="tabular-nums">{e.tasksDone}/{e.tasksTotal}</span> : <span className="text-[var(--cf-text-faint)]">—</span>),
      value: (e) => (e.tasksTotal > 0 ? e.tasksDone / e.tasksTotal : null),
      better: "higher",
    },
    {
      key: "retries",
      label: l("Reintentos", "Retries"),
      hint: l("Intentos más allá del primero: cuánto hubo que rehacer", "Attempts beyond the first: how much had to be redone"),
      text: (e) => (e.tasksTotal > 0 ? <span className="tabular-nums">{e.retries}</span> : <span className="text-[var(--cf-text-faint)]">—</span>),
      value: (e) => (delivered(e) ? e.retries : null),
      better: "lower",
    },
    {
      key: "cost",
      label: l("Costo", "Cost"),
      hint: l("Lo que gastaron sus agentes", "What its agents spent"),
      text: (e) => (e.usd > 0 ? <span className="tabular-nums">{money(e.usd)}</span> : <span className="text-[var(--cf-text-faint)]">—</span>),
      value: (e) => (delivered(e) && e.usd > 0 ? e.usd : null),
      better: "lower",
    },
    {
      key: "time",
      label: l("Tiempo de agentes", "Agent time"),
      hint: l("Minutos de trabajo sumados entre sus agentes", "Minutes of work added up across its agents"),
      text: (e) => <span className="tabular-nums">{minutes(e.minutes, l)}</span>,
      value: (e) => (delivered(e) && e.minutes > 0 ? e.minutes : null),
      better: "lower",
    },
    {
      key: "diff",
      label: l("Tamaño del cambio", "Size of the change"),
      hint: l("Lo que cambió respecto del commit de partida. No es mejor ni peor por sí solo.", "What changed against the starting commit. Neither better nor worse by itself."),
      text: (e) =>
        e.files > 0 ? (
          <span className="tabular-nums">
            <span className="text-[var(--cf-success)]">+{e.insertions}</span> <span className="text-[var(--cf-danger)]">−{e.deletions}</span>
            <span className="text-[var(--cf-text-faint)]"> · {e.files === 1 ? l("1 archivo", "1 file") : l(`${e.files} archivos`, `${e.files} files`)}</span>
          </span>
        ) : (
          <span className="text-[var(--cf-text-faint)]">{e.status === "done" && e.scored ? l("sin cambios", "no changes") : "—"}</span>
        ),
      value: () => null,
      better: "lower",
    },
  ];
}

function bestOf(measure: Measure, entries: TeamEvalEntry[]): number | null {
  const values = entries.map(measure.value).filter((v): v is number => v !== null);
  // A row where everyone is the same, or only one team has a value, has no best.
  if (values.length < 2 || values.every((v) => v === values[0])) return null;
  return measure.better === "higher" ? Math.max(...values) : Math.min(...values);
}

function EvalCard({ view, onChanged }: { view: TeamEval; onChanged: () => void }) {
  const l = useL();
  const crew = useCrewStore();
  const measures = useMemo(() => measuresOf(view, l), [view, l]);
  const columns = `minmax(118px, 150px) repeat(${view.entries.length}, minmax(148px, 1fr))`;
  const stateLook: [string, Tone] = view.state === "running" ? [l("En curso", "In progress"), "accent"] : view.state === "scoring" ? [l("Puntuando", "Scoring"), "info"] : view.winner ? [l("Decidida", "Decided"), "ok"] : [l("Sin ganador", "No winner"), "neutral"];

  const openRun = (runId: string) => {
    crew.setSpace("en-vivo");
    void useTeamStore.getState().select(runId);
  };
  const remove = async () => {
    if (!(await confirmAction(l("¿Quitar esta comparación? Sus corridas se quedan en la lista de corridas.", "Remove this comparison? Its runs stay in the run list.")))) return;
    try {
      await teamEvalDelete(view.id);
      onChanged();
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <motion.article layout transition={SOFT} className="flex min-w-0 flex-col rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]">
      <header className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"><Scale className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <b className="truncate text-[13.5px]" title={view.title}>{view.title}</b>
            <Chip tone={stateLook[1]}>{stateLook[0]}</Chip>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[var(--cf-text-muted)]">
            <span className="inline-flex items-center gap-1"><GitBranch className="h-3 w-3" />{view.projectName || l("repositorio", "repository")} · {view.baseBranch}</span>
            <span className="inline-flex items-center gap-1 font-mono" title={l("El commit del que partieron todos los equipos", "The commit every team started from")}><GitCommitHorizontal className="h-3 w-3" />{view.baseSha.slice(0, 7)}</span>
            <span>{new Date(view.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
          </span>
          {view.goal !== view.title && <span className="mt-1 line-clamp-2 text-[12px] leading-snug text-[var(--cf-text-muted)]" title={view.goal}>{view.goal}</span>}
        </span>
        <IconBtn title={l("Quitar la comparación (sus corridas se quedan)", "Remove the comparison (its runs stay)")} icon={Trash2} danger onClick={() => void remove()} />
      </header>

      <div className="overflow-x-auto border-t border-[var(--cf-border)]">
        <div role="table" aria-label={l("Resultados por equipo", "Results by team")} className="grid min-w-fit text-[12px]" style={{ gridTemplateColumns: columns }}>
          {/* Who */}
          <span role="columnheader" className="border-b border-[var(--cf-border)] px-3 py-2.5" />
          {view.entries.map((entry) => {
            const won = view.winner !== "" && entry.runId === view.winner;
            const look = statusLook(entry, l);
            return (
              <span role="columnheader" key={entry.teamId} className={`flex min-w-0 flex-col gap-1.5 border-b border-l border-[var(--cf-border)] px-3 py-2.5 ${won ? "bg-[color-mix(in_oklab,var(--cf-success)_7%,transparent)]" : ""}`}>
                <span className="flex items-center gap-2">
                  <TeamAvatar size={22} />
                  <b className="min-w-0 flex-1 truncate text-[12.5px]" title={entry.teamName}>{entry.teamName}</b>
                  {won && <span title={l("El mejor resultado: más verificaciones, luego más tareas, luego menos costo", "The best result: more checks, then more tasks, then less cost")} className="grid h-[20px] w-[20px] shrink-0 place-items-center rounded-full bg-[var(--cf-success)] text-white"><Trophy className="h-3 w-3" /></span>}
                  {!won && entry.rank > 1 && <span title={l("Su lugar en la comparación", "Its place in the comparison")} className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)]">{entry.rank}.º</span>}
                </span>
                <span><Chip tone={look.tone} icon={look.icon} className={look.spin ? "[&>svg]:animate-spin" : ""}>{look.label}</Chip></span>
              </span>
            );
          })}

          {/* What each measure says */}
          {measures.map((measure, row) => {
            const best = bestOf(measure, view.entries);
            const last = row === measures.length - 1;
            return (
              <span role="row" key={measure.key} className="contents">
                <span role="rowheader" title={measure.hint} className={`px-3 py-2 text-[11.5px] text-[var(--cf-text-muted)] ${last ? "" : "border-b border-[var(--cf-border)]"}`}>{measure.label}</span>
                {view.entries.map((entry) => {
                  const won = view.winner !== "" && entry.runId === view.winner;
                  const top = best !== null && measure.value(entry) === best;
                  return (
                    <span role="cell" key={entry.teamId} className={`flex items-center gap-1.5 border-l border-[var(--cf-border)] px-3 py-2 ${last ? "" : "border-b"} ${won ? "bg-[color-mix(in_oklab,var(--cf-success)_7%,transparent)]" : ""} ${top ? "font-semibold text-[var(--cf-text)]" : ""}`}>
                      {measure.text(entry)}
                      {top && <span title={l("El mejor valor de esta fila", "The best value of this row")} className="ml-auto shrink-0 rounded-[5px] bg-[var(--cf-accent-soft)] px-1.5 py-[1px] text-[10px] font-medium leading-[14px] text-[var(--cf-accent)]">{l("mejor", "best")}</span>}
                    </span>
                  );
                })}
              </span>
            );
          })}

          {/* Where to look */}
          <span className="border-t border-[var(--cf-border)] px-3 py-2" />
          {view.entries.map((entry) => {
            const won = view.winner !== "" && entry.runId === view.winner;
            return (
              <span key={entry.teamId} className={`flex min-w-0 items-center border-l border-t border-[var(--cf-border)] px-2 py-1.5 ${won ? "bg-[color-mix(in_oklab,var(--cf-success)_7%,transparent)]" : ""}`}>
                {entry.error ? (
                  <span className="line-clamp-2 px-1 text-[11.5px] leading-snug text-[var(--cf-danger)]" title={entry.error}>{entry.error}</span>
                ) : entry.status === "gone" ? (
                  <span className="px-1 text-[11.5px] text-[var(--cf-text-faint)]">{l("La corrida ya no existe", "The run no longer exists")}</span>
                ) : (
                  <Btn small kind="ghost" icon={ArrowUpRight} title={l("Abre la corrida de este equipo: su canal, sus tareas y su código", "Opens this team's run: its channel, its tasks and its code")} onClick={() => openRun(entry.runId)}>{l("Ver corrida", "See run")}</Btn>
                )}
              </span>
            );
          })}
        </div>
      </div>

      {view.checks.length > 0 && (
        <footer className="flex flex-wrap items-center gap-1.5 border-t border-[var(--cf-border)] px-3.5 py-2 text-[11.5px] text-[var(--cf-text-muted)]">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
          <span>{l("Puntúan:", "Scored by:")}</span>
          {view.checks.map((command) => <code key={command} className="rounded bg-[var(--cf-sunken)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--cf-text)]">{command}</code>)}
        </footer>
      )}
    </motion.article>
  );
}

function NewEvalDialog({ onClose, onStarted }: { onClose: () => void; onStarted: () => void }) {
  const l = useL();
  const workspaceId = useTeamStore((s) => s.workspaceId);
  const teams = useTeamStore((s) => s.teams);
  const projects = useWorkspaceStore((s) => (workspaceId ? s.projectsByWorkspace[workspaceId] : undefined)) ?? NO_PROJECTS;
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(() => (projects.some((p) => p.id === activeProjectId) ? activeProjectId ?? "" : projects[0]?.id ?? ""));
  const [branch, setBranch] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [checks, setChecks] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = goal.trim().length > 0 && projectId !== "" && picked.length >= 2;

  const toggle = (id: string) => setPicked((now) => (now.includes(id) ? now.filter((x) => x !== id) : now.length >= MAX_TEAMS ? now : [...now, id]));
  const start = async () => {
    if (!workspaceId || !ready || busy) return;
    setBusy(true);
    try {
      await teamEvalStart({ workspaceId, title: title.trim(), goal: goal.trim(), projectId, targetBranch: branch.trim(), teamIds: picked, checks: checks.split("\n").map((line) => line.trim()).filter(Boolean) });
      onStarted();
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={l("Nueva comparación", "New comparison")}
      subtitle={l("La misma tarea, para varios equipos, desde el mismo commit", "The same task, for several teams, from the same commit")}
      leading={<span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"><Scale className="h-5 w-5" /></span>}
      onClose={onClose}
      footer={
        <>
          <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
            {picked.length < 2
              ? l("Elige al menos dos equipos.", "Pick at least two teams.")
              : l(`Empiezan ${picked.length} corridas a la vez: cada una gasta lo suyo. Ninguna integra nada en tu rama.`, `${picked.length} runs start at once: each spends its own. None merges anything into your branch.`)}
          </span>
          <Btn kind="ghost" onClick={onClose}>{l("Cancelar", "Cancel")}</Btn>
          <Btn kind="primary" icon={Scale} disabled={!ready || busy} onClick={() => void start()}>{busy ? l("Empezando…", "Starting…") : l("Comparar", "Compare")}</Btn>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <Label>{l("La tarea", "The task")}</Label>
        <textarea autoFocus rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={l("Lo que cada equipo tiene que lograr, igual para todos", "What each team has to achieve, the same for all")} className={`${field} h-auto resize-y py-2 leading-snug`} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={l("Nombre de la comparación (opcional)", "Name of the comparison (optional)")} className={field} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_200px]">
        <div className="flex flex-col gap-1.5">
          <Label>{l("Repositorio", "Repository")}</Label>
          <SelectBox value={projectId} onChange={setProjectId} ariaLabel={l("Repositorio", "Repository")}>
            {projects.length === 0 && <option value="">{l("No hay repositorios en este workspace", "No repositories in this workspace")}</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </SelectBox>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{l("Desde la rama", "From branch")}</Label>
          <input value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} placeholder={l("La que está abierta", "The one checked out")} title={l("Se fija su commit de ahora: todos los equipos parten de ahí aunque la rama avance", "Its commit is pinned now: every team starts there even if the branch moves on")} className={`${field} font-mono text-[12px]`} />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>{l(`Equipos (${picked.length} de ${MAX_TEAMS})`, `Teams (${picked.length} of ${MAX_TEAMS})`)}</Label>
        <div className="flex flex-wrap gap-1.5">
          {teams.map((team) => (
            <ToggleChip key={team.id} on={picked.includes(team.id)} onClick={() => toggle(team.id)} title={picked.includes(team.id) ? l("Quitar de la comparación", "Remove from the comparison") : picked.length >= MAX_TEAMS ? l(`Como máximo ${MAX_TEAMS} equipos`, `At most ${MAX_TEAMS} teams`) : l(`${team.members.length} miembros`, `${team.members.length} members`)}>
              {team.name}
            </ToggleChip>
          ))}
          {teams.length < 2 && <span className="text-[12px] text-[var(--cf-text-muted)]">{l("Necesitas al menos dos equipos. Créalos en «Equipos».", "You need at least two teams. Create them under «Teams».")}</span>}
        </div>
        <span className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{l("Cada equipo corre con sus propias reglas, sin aprobaciones que esperar: nadie se queda detenido a mitad de la comparación.", "Each team runs with its own rules and no approvals to wait for: nobody stops halfway through the comparison.")}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>{l("Con qué se puntúa", "What scores it")}</Label>
        <textarea rows={2} value={checks} onChange={(e) => setChecks(e.target.value)} spellCheck={false} placeholder={l("Un comando por línea. Vacío: las pruebas detectadas en el repositorio.", "One command per line. Empty: the tests detected in the repository.")} className={`${field} h-auto resize-y py-2 font-mono text-[12px] leading-snug`} />
        <span className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{l("Los mismos comandos se corren sobre el resultado de cada equipo cuando termina. Sin ellos se compara por tareas entregadas, costo y tiempo.", "The same commands run on each team's result when it finishes. Without them it is compared by tasks delivered, cost and time.")}</span>
      </div>
    </Modal>
  );
}

export function LabView() {
  const l = useL();
  const workspaceId = useTeamStore((s) => s.workspaceId);
  const runs = useTeamStore((s) => s.runs);
  const teamCount = useTeamStore((s) => s.teams.length);
  const [evals, setEvals] = useState<TeamEval[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const scoring = useRef(new Set<string>());

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      setEvals(await teamEvals(workspaceId));
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setEvals(null);
    void load();
  }, [load]);

  // The runs move in the backend; whenever one of them changes status, the comparison reads again.
  const pulse = useMemo(() => runs.map((run) => `${run.id}:${run.status}:${run.gate}`).join("|"), [runs]);
  useEffect(() => {
    if (evals !== null) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulse]);

  // Results that closed and have no verdict yet get one, once.
  useEffect(() => {
    for (const view of evals ?? []) {
      if (view.state !== "scoring" || scoring.current.has(view.id)) continue;
      scoring.current.add(view.id);
      void teamEvalScore(view.id)
        .then((scored) => setEvals((now) => (now ?? []).map((v) => (v.id === scored.id ? scored : v))))
        .catch((e) => pushErrorToast(String(e)))
        .finally(() => scoring.current.delete(view.id));
    }
  }, [evals]);

  // Cost and time of a run that is still going do not arrive as events: look again while one is.
  const live = (evals ?? []).some((view) => view.state === "running");
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  if (evals === null) {
    return error ? (
      <Empty icon={AlertTriangle} title={l("No se pudieron leer las comparaciones", "The comparisons could not be read")} hint={error}>
        <Btn kind="primary" icon={RefreshCw} onClick={() => void load()}>{l("Reintentar", "Retry")}</Btn>
      </Empty>
    ) : (
      <div className="grid flex-1 place-items-center text-[12px] text-[var(--cf-text-muted)]">{l("Cargando comparaciones…", "Loading comparisons…")}</div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {evals.length === 0 ? (
        <Empty
          icon={Scale}
          title={l("Compara equipos con la misma tarea", "Compare teams on the same task")}
          hint={l(
            "Dale la misma tarea a dos o más equipos desde el mismo commit. Cada uno trabaja en su propia rama, sin integrar nada, y al terminar se corren las mismas pruebas sobre cada resultado. Ves lado a lado cuál pasó más verificaciones, cuánto costó y cuánto tuvo que rehacer.",
            "Give the same task to two or more teams from the same commit. Each works on its own branch, merging nothing, and when they finish the same tests run on each result. You see side by side which passed more checks, what it cost and how much it had to redo.",
          )}
        >
          <Btn kind="primary" icon={Plus} disabled={teamCount < 2} title={teamCount < 2 ? l("Necesitas al menos dos equipos", "You need at least two teams") : l("Elige la tarea, el repositorio y los equipos", "Pick the task, the repository and the teams")} onClick={() => setCreating(true)}>{l("Nueva comparación", "New comparison")}</Btn>
        </Empty>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3.5 py-2">
            <span className="text-[11.5px] text-[var(--cf-text-faint)]">
              {evals.length === 1 ? l("1 comparación", "1 comparison") : l(`${evals.length} comparaciones`, `${evals.length} comparisons`)}
              {live && <> · {l("hay equipos trabajando", "teams are at work")}</>}
            </span>
            <span className="flex-1" />
            <Btn small kind="ghost" icon={RefreshCw} disabled={loading} title={l("Vuelve a leer los resultados", "Reads the results again")} onClick={() => void load()}>{l("Actualizar", "Refresh")}</Btn>
            <Btn small kind="primary" icon={Plus} onClick={() => setCreating(true)}>{l("Nueva comparación", "New comparison")}</Btn>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
            {evals.map((view) => <EvalCard key={view.id} view={view} onChanged={() => void load()} />)}
          </div>
        </>
      )}
      {creating && <NewEvalDialog onClose={() => setCreating(false)} onStarted={() => void load()} />}
    </div>
  );
}
