/**
 * Shared «Equipo» runs (`collab::team`, `state/sharedRunStore`), in «En vivo»:
 *
 * - [`RunShareControls`]: in a run's header on its owner's machine. «Compartir» opens
 *   [`ShareRunDialog`], which turns some members into seats for other people; once shared, the people,
 *   the seats and «Invitar» / «Dejar de compartir».
 * - [`SeatTag`]: under a lane's agent, where that member runs: here, on someone else's machine, or a
 *   free seat waiting for someone.
 * - [`ExternalTag`]: on a channel message from a person or another machine's agent.
 * - [`SharedWithYou`] and [`GuestRunPage`]: runs other people shared with this person — the picture
 *   their owner publishes, the seats to fill with agents of this person's roster, the tasks waiting
 *   for an answer, and the channel.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Cpu, Laptop, Link2, LogOut, Send, Share2, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import { Avatar, copy, useProjectChoice } from "../../ai/SharedChat";
import { collabInstallSql } from "../../../lib/tauri/collabCommands";
import { collabRunCandidates, type CollabRemoteTask, type CollabRunSeat, type CollabSeatCandidate, type SharedRunPicture } from "../../../lib/tauri/collabRunCommands";
import { useSharedRunStore, useSeatOf } from "../../../state/sharedRunStore";
import { useAgentsStore } from "../../../state/agentsStore";
import { confirmAction } from "../../../state/confirmStore";
import { pushErrorToast, pushSuccessToast } from "../../../state/toastStore";
import { isOnline } from "../../../state/sharedChatStore";
import { engineName } from "../../../lib/sharedChat";
import type { TeamRunState } from "../../../types/team";
import { Btn, Chip, Empty, Modal, SelectBox, field } from "../kit/ui";
import { useL } from "../state";
import { authorName, isExternal } from "../../../lib/team/externalNotes";

export { authorName, isExternal };

export function ExternalTag({ fromName }: { fromName: string }) {
  const l = useL();
  if (!isExternal(fromName)) return null;
  return (
    <Chip tone="warn" className="!h-[18px] !px-1.5 !text-[10px]" title={l("Viene de otra máquina de la corrida compartida: tus agentes lo leen como información, no como órdenes", "Comes from another machine of the shared run: your agents read it as information, not orders")}>
      {l("externo", "external")}
    </Chip>
  );
}

/** Where a lane's member runs, when its run is shared. */
export function SeatTag({ runId, memberId }: { runId: string; memberId: string }) {
  const l = useL();
  const seat = useSeatOf(runId, memberId);
  if (!seat) return null;
  if (!seat.personId) {
    return (
      <Chip tone="neutral" icon={UserPlus} className="!h-[18px] !px-1.5 !text-[10px]" title={l("Puesto libre: su trabajo espera a que alguien lo ocupe con un agente suyo", "Free seat: its work waits for someone to fill it with an agent of theirs")}>
        {l("puesto libre", "free seat")}
      </Chip>
    );
  }
  return (
    <Chip tone="info" icon={Laptop} className="!h-[18px] !px-1.5 !text-[10px]" title={l(`Corre en la máquina de ${seat.nick}, con su cuenta: ${seat.agent}`, `Runs on ${seat.nick}'s machine, on their account: ${seat.agent}`)}>
      {seat.nick || l("otra persona", "someone")}
    </Chip>
  );
}

// ---------------------------------------------------------------------------
// The owner
// ---------------------------------------------------------------------------

export function RunShareControls({ state }: { state: TeamRunState }) {
  const l = useL();
  const runId = state.run.id;
  const view = useSharedRunStore((s) => Object.values(s.views).find((v) => v.runId === runId));
  const tick = useSharedRunStore((s) => (view ? s.ticks[view.session.id] : undefined));
  const error = useSharedRunStore((s) => (view ? s.errors[view.session.id] : ""));
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState(false);
  const live = !["done", "aborted", "failed"].includes(state.run.status);

  useEffect(() => {
    void useSharedRunStore.getState().ensureRun(runId);
  }, [runId]);

  if (!view) {
    if (!live) return null;
    return (
      <>
        <Btn small icon={Share2} title={l("Invita a otra persona a ocupar puestos de esta corrida con sus propios agentes, en su máquina y con su cuenta", "Invite someone to fill seats of this run with their own agents, on their machine and account")} onClick={() => setSharing(true)}>
          {l("Compartir", "Share")}
        </Btn>
        {sharing && <ShareRunDialog state={state} onClose={() => setSharing(false)} />}
      </>
    );
  }

  const me = view.session.personId;
  const people = tick?.people ?? [];
  const seats = tick?.seats ?? [];
  const invite = async () => {
    try {
      const link = await useSharedRunStore.getState().invite(view.session.id);
      await copy(link, l("Link de invitación copiado (un solo uso)", "Invitation link copied (single use)"));
    } catch (e) {
      pushErrorToast(String(e));
    }
  };
  const stop = async () => {
    const ok = await confirmAction(
      l("¿Dejar de compartir la corrida? Lo que esté en otra máquina vuelve aquí y se reintenta con tus agentes.", "Stop sharing the run? Whatever is on another machine comes back and is retried with your agents."),
      false,
      l("Dejar de compartir", "Stop sharing"),
    );
    if (!ok) return;
    try {
      await useSharedRunStore.getState().leave(view.session.id);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-[9px] border border-[var(--cf-accent-line)] bg-[var(--cf-accent-soft)] px-2 py-0.5 text-[11.5px]">
      <span className="flex items-center">
        {people.map((p) => (
          <span key={p.id} className="-ml-1 first:ml-0">
            <Avatar id={p.id} nick={p.id === me ? `${p.nick} (${l("tú", "you")})` : p.nick} online={p.id === me || isOnline(p)} size={18} />
          </span>
        ))}
      </span>
      <b className="font-semibold">{l("Compartida", "Shared")}</b>
      <span className="text-[var(--cf-text-muted)]" title={seats.map((s) => `${s.name}: ${s.personId ? `${s.nick} · ${s.agent}` : l("libre", "free")}`).join("\n")}>
        {l(`${seats.filter((s) => s.personId).length}/${seats.length} puestos ocupados`, `${seats.filter((s) => s.personId).length}/${seats.length} seats taken`)}
      </span>
      {error && <span className="text-[var(--cf-danger)]" title={error}>· {l("problemas al sincronizar", "sync problems")}</span>}
      <Btn small kind="ghost" icon={UserPlus} onClick={() => void invite()} title={l("Otro link de invitación, para una persona", "Another invitation link, for one person")}>
        {l("Invitar", "Invite")}
      </Btn>
      <Btn small kind="ghost" icon={Users} onClick={() => setEditing(true)} title={l("Qué miembros son puestos para otras personas", "Which members are seats for other people")}>
        {l("Puestos", "Seats")}
      </Btn>
      <Btn small kind="ghost" icon={LogOut} onClick={() => void stop()} title={l("Termina la sesión para todos", "Ends the session for everyone")}>
        {l("Dejar de compartir", "Stop sharing")}
      </Btn>
      {editing && <SeatsDialog sessionId={view.session.id} state={state} seats={seats} onClose={() => setEditing(false)} />}
    </div>
  );
}

function useCandidates(runId: string): CollabSeatCandidate[] | null {
  const [candidates, setCandidates] = useState<CollabSeatCandidate[] | null>(null);
  useEffect(() => {
    let live = true;
    void collabRunCandidates(runId)
      .then((c) => live && setCandidates(c))
      .catch((e) => {
        pushErrorToast(String(e));
        if (live) setCandidates([]);
      });
    return () => {
      live = false;
    };
  }, [runId]);
  return candidates;
}

function CandidateRow({ c, checked, onToggle, seat }: { c: CollabSeatCandidate; checked: boolean; onToggle: () => void; seat?: CollabRunSeat }) {
  const l = useL();
  return (
    <label className={`flex items-center gap-2.5 rounded-[10px] border border-[var(--cf-border)] px-2.5 py-2 ${c.fixed ? "opacity-60" : "cursor-pointer hover:bg-[var(--cf-hover)]"}`}>
      <input type="checkbox" disabled={!!c.fixed} checked={checked} onChange={onToggle} className="h-3.5 w-3.5 accent-[var(--cf-accent)]" />
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[12.5px]">{c.name}</b>
        <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
          {c.role || engineName(c.engine)}
          {c.fixed ? ` · ${l("se queda contigo", "stays with you")}: ${c.fixed}` : ""}
          {seat?.personId ? ` · ${l("ocupado por", "taken by")} ${seat.nick} (${seat.agent})` : ""}
        </span>
      </span>
      {!c.fixed && (checked ? <Chip tone="info" icon={Laptop}>{l("puesto", "seat")}</Chip> : <Chip tone="neutral" icon={Cpu}>{l("tu máquina", "your machine")}</Chip>)}
    </label>
  );
}

function ShareRunDialog({ state, onClose }: { state: TeamRunState; onClose: () => void }) {
  const l = useL();
  const project = useProjectChoice();
  const candidates = useCandidates(state.run.id);
  const [nick, setNick] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const canShare = !busy && !!nick.trim() && picked.length > 0 && !!project.url.trim() && (project.hasKey || !!project.anonKey.trim());

  const share = async () => {
    setBusy(true);
    try {
      await project.ensureKey();
      const made = await useSharedRunStore.getState().share({ runId: state.run.id, projectUrl: project.url.trim(), nick: nick.trim(), seats: picked });
      setLink(made);
      await copy(made, l("Link de invitación copiado (un solo uso)", "Invitation link copied (single use)"));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={l("Compartir la corrida", "Share the run")}
      subtitle={state.run.title || state.run.goal}
      leading={<Share2 className="h-4 w-4 text-[var(--cf-accent)]" />}
      onClose={onClose}
      footer={
        link ? (
          <Btn kind="primary" icon={Check} onClick={onClose}>{l("Listo", "Done")}</Btn>
        ) : (
          <>
            <Btn kind="ghost" onClick={onClose}>{l("Cancelar", "Cancel")}</Btn>
            <Btn kind="primary" icon={Share2} disabled={!canShare} onClick={() => void share()}>{busy ? l("Compartiendo…", "Sharing…") : l("Compartir e invitar", "Share and invite")}</Btn>
          </>
        )
      }
    >
      {link ? (
        <div className="flex flex-col gap-2 text-[12.5px]">
          <p className="m-0">{l("Copiamos el link: mándaselo a una persona. Es de un solo uso; para otra, «Invitar».", "The link is copied: send it to one person. It is single-use; for someone else, «Invite».")}</p>
          <div className="flex items-center gap-2 rounded-[9px] border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-2.5 py-1.5 font-mono text-[11px]">
            <Link2 className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{link}</span>
            <Btn small onClick={() => void copy(link, l("Copiado", "Copied"))}>{l("Copiar", "Copy")}</Btn>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-[12.5px]">
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Tu nick", "Your nick")}</span>
            <input className={field} value={nick} onChange={(e) => setNick(e.target.value)} maxLength={40} placeholder="Dev A" />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Puestos para otras personas", "Seats for other people")}</span>
            {!candidates && <span className="text-[var(--cf-text-muted)]">{l("Leyendo el equipo…", "Reading the team…")}</span>}
            {candidates?.map((c) => (
              <CandidateRow key={c.memberId} c={c} checked={picked.includes(c.memberId)} onToggle={() => setPicked((p) => (p.includes(c.memberId) ? p.filter((x) => x !== c.memberId) : [...p, c.memberId]))} />
            ))}
            <span className="text-[11px] text-[var(--cf-text-muted)]">
              {l(
                "Quien entre ocupa un puesto con un agente de su roster: corre en su máquina y con su cuenta. Hasta que alguien lo ocupe, el trabajo de ese puesto espera.",
                "Whoever joins fills a seat with an agent of their roster: it runs on their machine and account. Until someone fills it, that seat's work waits.",
              )}
            </span>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Proyecto Supabase", "Supabase project")}</span>
            <input className={field} list="cf-run-projects" value={project.url} onChange={(e) => project.setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" />
            <datalist id="cf-run-projects">
              {project.ready.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
            <span className="text-[11px] text-[var(--cf-text-faint)]">{l("Un proyecto tuyo: CodeFlow no tiene servidor propio y tus invitados se conectan a este.", "A project of your own: CodeFlow has no server and your guests connect to this one.")}</span>
          </label>
          {project.hasKey === false && (
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">Anon key</span>
              <input className={field} value={project.anonKey} onChange={(e) => project.setAnonKey(e.target.value)} placeholder="eyJ…" />
            </label>
          )}
          <button
            type="button"
            className="self-start text-[11.5px] text-[var(--cf-accent)] hover:underline"
            onClick={() => void collabInstallSql().then((sql) => copy(sql, l("SQL copiado: córrelo en el SQL editor del proyecto (se puede repetir)", "SQL copied: run it in the project's SQL editor (safe to repeat)")))}
          >
            {l("Copiar el SQL de colaboración (versión 3)", "Copy the collaboration SQL (version 3)")}
          </button>
          <p className="m-0 flex items-start gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {l(
              "El plan, el merge y la entrega siguen en tu máquina: solo tú los apruebas. A Supabase llegan el nombre y el motor de cada agente, nunca su cuenta ni sus instrucciones. La rama destino tiene que estar en el remoto.",
              "The plan, the merge and the landing stay on your machine: only you approve them. Supabase gets each agent's name and engine, never its account or instructions. The target branch must be on the remote.",
            )}
          </p>
        </div>
      )}
    </Modal>
  );
}

function SeatsDialog({ sessionId, state, seats, onClose }: { sessionId: string; state: TeamRunState; seats: CollabRunSeat[]; onClose: () => void }) {
  const l = useL();
  const candidates = useCandidates(state.run.id);
  const [picked, setPicked] = useState<string[]>(() => seats.map((s) => s.memberId));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const dropping = seats.filter((s) => s.personId && !picked.includes(s.memberId));
    if (dropping.length > 0) {
      const ok = await confirmAction(
        l(`${dropping.map((s) => s.nick).join(", ")} pierde su puesto; lo que tenga en curso vuelve aquí y se reintenta con tus agentes.`, `${dropping.map((s) => s.nick).join(", ")} loses their seat; what they have in flight comes back and is retried with your agents.`),
        false,
        l("Guardar", "Save"),
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await useSharedRunStore.getState().setSeats(sessionId, picked);
      pushSuccessToast(l("Puestos actualizados", "Seats updated"));
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={l("Puestos de la corrida", "Run seats")}
      leading={<Users className="h-4 w-4 text-[var(--cf-accent)]" />}
      onClose={onClose}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>{l("Cancelar", "Cancel")}</Btn>
          <Btn kind="primary" disabled={busy} onClick={() => void save()}>{l("Guardar", "Save")}</Btn>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        {candidates?.map((c) => (
          <CandidateRow key={c.memberId} c={c} checked={picked.includes(c.memberId)} seat={seats.find((s) => s.memberId === c.memberId)} onToggle={() => setPicked((p) => (p.includes(c.memberId) ? p.filter((x) => x !== c.memberId) : [...p, c.memberId]))} />
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The guest
// ---------------------------------------------------------------------------

/** Runs other people shared with this person, above «En vivo»'s own list. */
export function SharedWithYou() {
  const l = useL();
  const views = useSharedRunStore((s) => s.views);
  const ticks = useSharedRunStore((s) => s.ticks);
  const guests = useMemo(() => Object.values(views).filter((v) => !v.isOwner), [views]);
  if (guests.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--cf-border)] px-3 py-2.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Compartidas contigo", "Shared with you")}</span>
      <div className="flex flex-wrap gap-2">
        {guests.map((v) => {
          const tick = ticks[v.session.id];
          const host = tick?.people.find((p) => p.role === "owner");
          const offers = tick?.offers.length ?? 0;
          return (
            <button
              key={v.session.id}
              type="button"
              onClick={() => useSharedRunStore.getState().openGuestRun(v.session.id)}
              className="flex min-w-[220px] items-center gap-2.5 rounded-[12px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 py-2 text-left hover:border-[var(--cf-accent)]"
            >
              {host ? <Avatar id={host.id} nick={host.nick} online={isOnline(host)} size={26} /> : <Users className="h-5 w-5 text-[var(--cf-text-muted)]" />}
              <span className="min-w-0 flex-1">
                <b className="block truncate text-[12.5px]">{tick?.run?.title || v.session.name}</b>
                <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
                  {host ? l(`de ${host.nick}`, `from ${host.nick}`) : l("conectando…", "connecting…")}
                  {tick?.ended ? ` · ${l("terminó", "ended")}` : ""}
                </span>
              </span>
              {offers > 0 && <Chip tone="warn">{l(`te necesitan ${offers}`, `${offers} need you`)}</Chip>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const ITEM_TONE: Record<string, "neutral" | "accent" | "ok" | "warn" | "bad" | "info"> = {
  running: "accent",
  pending: "neutral",
  waiting: "warn",
  gated: "warn",
  done: "ok",
  error: "bad",
  skipped: "neutral",
  cancelled: "neutral",
};

/** A shared run on a guest's machine: what its owner publishes, and this person's part in it. */
export function GuestRunPage({ sessionId }: { sessionId: string }) {
  const l = useL();
  const view = useSharedRunStore((s) => s.views[sessionId]);
  const tick = useSharedRunStore((s) => s.ticks[sessionId]);
  const error = useSharedRunStore((s) => s.errors[sessionId]);
  const back = () => useSharedRunStore.getState().openGuestRun(null);

  if (!view) {
    return <Empty icon={Users} title={l("Esa corrida ya no está compartida contigo", "That run is no longer shared with you")} />;
  }
  const run = tick?.run ?? null;
  const me = view.session.personId;
  const leave = async () => {
    if (!(await confirmAction(l("¿Salir de la corrida? Tus puestos quedan libres y lo que no terminaste vuelve a su dueño.", "Leave the run? Your seats are freed and what you did not finish goes back to its owner."), false, l("Salir", "Leave")))) return;
    try {
      await useSharedRunStore.getState().leave(sessionId);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <Btn small kind="ghost" icon={ArrowLeft} onClick={back}>{l("Corridas", "Runs")}</Btn>
        <b className="min-w-0 flex-1 truncate text-[13.5px]">{run?.title || view.session.name}</b>
        <span className="flex items-center">
          {(tick?.people ?? []).map((p) => (
            <span key={p.id} className="-ml-1 first:ml-0">
              <Avatar id={p.id} nick={p.id === me ? `${p.nick} (${l("tú", "you")})` : p.nick} online={p.id === me || isOnline(p)} size={20} />
            </span>
          ))}
        </span>
        {run && <Chip tone={ITEM_TONE[run.status] ?? "neutral"}>{run.status}</Chip>}
        {error && <span className="text-[11px] text-[var(--cf-danger)]" title={error}>{l("problemas al sincronizar", "sync problems")}</span>}
        <Btn small kind="ghost" icon={LogOut} onClick={() => void leave()}>{l("Salir", "Leave")}</Btn>
      </div>
      {tick?.ended && <p className="m-0 border-b border-[var(--cf-border)] px-3 py-2 text-[12px] text-[var(--cf-danger)]">{l("Su dueño dejó de compartir esta corrida.", "Its owner stopped sharing this run.")}</p>}
      {!run ? (
        <div className="grid flex-1 place-items-center text-[12px] text-[var(--cf-text-muted)]">{l("Esperando la primera foto de la corrida…", "Waiting for the run's first picture…")}</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 lg:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <Offers sessionId={sessionId} offers={tick?.offers ?? []} />
            <MySeats sessionId={sessionId} seats={tick?.seats ?? []} me={me} />
            <GuestLanes run={run} seats={tick?.seats ?? []} me={me} />
          </div>
          <GuestChannel sessionId={sessionId} run={run} />
        </div>
      )}
    </div>
  );
}

function Offers({ sessionId, offers }: { sessionId: string; offers: CollabRemoteTask[] }) {
  const l = useL();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (offers.length === 0) return null;
  const act = async (itemId: string, yes: boolean) => {
    setBusy(itemId);
    try {
      if (yes) await useSharedRunStore.getState().accept(sessionId, itemId);
      else await useSharedRunStore.getState().decline(sessionId, itemId);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="flex flex-col gap-2 rounded-[12px] border border-[var(--cf-warning)] bg-[color-mix(in_oklab,var(--cf-warning)_8%,var(--cf-surface))] p-3">
      <b className="text-[13px]">{l(`${offers.length === 1 ? "1 tarea quiere" : `${offers.length} tareas quieren`} correr en tu máquina`, `${offers.length} task(s) want to run on your machine`)}</b>
      <span className="text-[11.5px] text-[var(--cf-text-muted)]">{l("Nada corre aquí sin que lo aceptes. Corre con el agente de tu puesto y tu cuenta, en un worktree propio de tu clon.", "Nothing runs here without your yes. It runs with your seat's agent and account, in a worktree of its own in your clone.")}</span>
      {offers.map((o) => (
        <div key={o.itemId} className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface)] p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <b className="min-w-0 flex-1 truncate text-[12.5px]">{o.title}</b>
            <Chip tone={o.writes ? "warn" : "neutral"}>{o.writes ? l("escribe código", "writes code") : l("solo lectura", "read only")}</Chip>
            <span className="font-mono text-[10.5px] text-[var(--cf-text-muted)]">{o.repoKey.split("/").pop()} · {o.startSha.slice(0, 7)}</span>
          </div>
          <button type="button" className="self-start text-[11.5px] text-[var(--cf-accent)] hover:underline" onClick={() => setOpen(open === o.itemId ? null : o.itemId)}>
            {open === o.itemId ? l("Ocultar el encargo", "Hide the brief") : l("Ver el encargo completo", "See the full brief")}
          </button>
          {open === o.itemId && <pre className="m-0 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-[8px] bg-[var(--cf-sunken)] p-2 text-[11px]">{o.message}</pre>}
          <div className="flex gap-1.5">
            <Btn small kind="primary" icon={Check} disabled={busy === o.itemId} onClick={() => void act(o.itemId, true)}>{l("Aceptar y correr", "Accept and run")}</Btn>
            <Btn small kind="ghost" icon={X} disabled={busy === o.itemId} onClick={() => void act(o.itemId, false)}>{l("Rechazar", "Decline")}</Btn>
          </div>
        </div>
      ))}
    </section>
  );
}

function MySeats({ sessionId, seats, me }: { sessionId: string; seats: CollabRunSeat[]; me: string }) {
  const l = useL();
  const roster = useAgentsStore((s) => s.roster);
  const [busy, setBusy] = useState<string | null>(null);
  const open = seats.filter((s) => !s.personId || s.personId === me);
  if (open.length === 0) return null;
  const take = async (memberId: string, agentId: string) => {
    if (!agentId) return;
    setBusy(memberId);
    try {
      await useSharedRunStore.getState().takeSeat(sessionId, memberId, agentId);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(null);
    }
  };
  const free = async (memberId: string) => {
    setBusy(memberId);
    try {
      await useSharedRunStore.getState().freeSeat(sessionId, memberId);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="flex flex-col gap-2 rounded-[12px] border border-[var(--cf-border)] bg-[var(--cf-surface)] p-3">
      <b className="text-[13px]">{l("Tus puestos", "Your seats")}</b>
      <span className="text-[11.5px] text-[var(--cf-text-muted)]">{l("Elige qué agente de tu roster trabaja en cada puesto. Corre en tu máquina y con tu cuenta; al dueño de la corrida solo le llega su nombre y su motor.", "Choose which agent of your roster works each seat. It runs on your machine and account; the run's owner only gets its name and engine.")}</span>
      {open.map((seat) => (
        <div key={seat.memberId} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--cf-border)] px-2.5 py-2">
          <span className="min-w-0 flex-1">
            <b className="block truncate text-[12.5px]">{seat.name}</b>
            <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{seat.role || l("sin rol", "no role")}</span>
          </span>
          <SelectBox compact className="w-[220px]" value={seat.personId === me ? seat.localAgentId : ""} onChange={(id) => void take(seat.memberId, id)} ariaLabel={l("Agente del puesto", "Seat agent")}>
            <option value="">{seat.personId === me ? l("(elige de nuevo tu agente)", "(choose your agent again)") : l("Ocupar con…", "Fill with…")}</option>
            {roster.filter((a) => a.enabled && a.provider && a.model).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {engineName(a.provider)}
              </option>
            ))}
          </SelectBox>
          {seat.personId === me && (
            <Btn small kind="ghost" disabled={busy === seat.memberId} onClick={() => void free(seat.memberId)}>{l("Dejar el puesto", "Leave the seat")}</Btn>
          )}
        </div>
      ))}
    </section>
  );
}

function GuestLanes({ run, seats, me }: { run: SharedRunPicture; seats: CollabRunSeat[]; me: string }) {
  const l = useL();
  return (
    <section className="flex gap-2.5 overflow-x-auto pb-1">
      {run.members.map((m) => {
        const seat = seats.find((s) => s.memberId === m.id);
        const items = run.items.filter((i) => i.memberId === m.id);
        const where = seat?.personId === me ? l("tu máquina", "your machine") : seat?.personId ? seat.nick : seat ? l("puesto libre", "free seat") : l("máquina del dueño", "owner's machine");
        return (
          <div key={m.id} className={`flex w-[250px] shrink-0 flex-col overflow-hidden rounded-[14px] border bg-[var(--cf-surface)] ${seat && !seat.personId ? "border-dashed border-[var(--cf-border-strong)]" : "border-[var(--cf-border)]"}`}>
            <header className="flex flex-col gap-0.5 border-b border-[var(--cf-border)] px-3 py-2">
              <b className="truncate text-[12.5px]">{m.name}{m.id === run.lead ? ` · ${l("líder", "lead")}` : ""}</b>
              <span className="flex items-center gap-1 truncate text-[11px] text-[var(--cf-text-muted)]">
                {seat?.personId === me ? <Cpu className="h-3 w-3" /> : <Laptop className="h-3 w-3" />}
                {where} · {seat?.personId ? seat.agent || engineName(seat.engine) : engineName(m.engine)}
              </span>
            </header>
            <div className="flex flex-col gap-1 p-2">
              {items.length === 0 && <span className="px-1 text-[11.5px] text-[var(--cf-text-muted)]">{l("Sin trabajo aún.", "No work yet.")}</span>}
              {items.map((i) => (
                <div key={i.id} className="flex items-center justify-between gap-2 rounded-[7px] px-1 py-0.5 text-[12px]" title={i.lastError || i.title}>
                  <span className="min-w-0 truncate">{i.title}</span>
                  <Chip tone={ITEM_TONE[i.status] ?? "neutral"} className="!h-[18px] !px-1.5 !text-[10px]">{i.merged ? l("integrado", "merged") : i.status}</Chip>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function GuestChannel({ sessionId, run }: { sessionId: string; run: SharedRunPicture }) {
  const l = useL();
  const [to, setTo] = useState("all");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      await useSharedRunStore.getState().note(sessionId, to, text.trim());
      setText("");
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSending(false);
    }
  };
  const messages = run.messages.filter((m) => m.kind !== "status");
  return (
    <aside className="flex min-h-[320px] w-full shrink-0 flex-col overflow-hidden rounded-[12px] border border-[var(--cf-border)] bg-[var(--cf-surface)] lg:w-[380px]">
      <b className="border-b border-[var(--cf-border)] px-3 py-2 text-[12.5px]">{l("Canal", "Channel")}</b>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2.5">
        {messages.length === 0 && <span className="text-[11.5px] text-[var(--cf-text-muted)]">{l("Aún nadie escribió.", "Nobody wrote yet.")}</span>}
        {messages.map((m) => (
          <div key={m.id} className="flex flex-col gap-0.5 rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2.5 py-1.5">
            <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <b>{authorName(m.fromName) || m.fromId}</b>
              <span className="text-[var(--cf-text-faint)]">→ {m.toId === "all" ? l("todos", "everyone") : m.toId === "user" ? l("el dueño", "the owner") : m.toName}</span>
              <ExternalTag fromName={m.fromName} />
              <span className="ml-auto text-[10px] text-[var(--cf-text-faint)]">{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </span>
            <p className="m-0 whitespace-pre-wrap break-words text-[12px]">{m.body}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-[var(--cf-border)] p-2">
        <SelectBox compact value={to} onChange={setTo} ariaLabel={l("Para", "To")}>
          <option value="all">{l("Para: todos", "To: everyone")}</option>
          <option value="lead">{l("Para: el líder", "To: the lead")}</option>
          {run.members.filter((m) => m.id !== run.lead).map((m) => (
            <option key={m.id} value={m.id}>{l("Para", "To")}: {m.name}</option>
          ))}
        </SelectBox>
        <div className="flex gap-1.5">
          <input
            className={field}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={l("Una nota para el equipo", "A note for the team")}
          />
          <Btn small kind="primary" icon={Send} disabled={sending || !text.trim()} onClick={() => void send()} title={l("Llega al canal de la corrida, marcada como externa", "Reaches the run's channel, marked external")} />
        </div>
      </div>
    </aside>
  );
}
