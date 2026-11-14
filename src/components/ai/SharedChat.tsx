import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Copy, Eye, EyeOff, FileText, GitCommitHorizontal, Link2, Loader2, LogOut, Radio, Share2, UserPlus, Users, X } from "lucide-react";
import { ChatMessageBubble } from "../chat/ChatMessageBubble";
import { openWorkspaceChat } from "../../lib/aiPanelNav";
import { engineName, hueOf, initials } from "../../lib/sharedChat";
import {
  collabInstallSql,
  collabJoinPreview,
  collabSharePreview,
  type CollabJoinPreview,
  type CollabMessage,
  type CollabPerson,
  type CollabShareCandidate,
  type CollabSessionView,
  type CollabSkipReason,
} from "../../lib/tauri/collabCommands";
import { supabaseHasKey, supabaseSetAnonKey } from "../../lib/tauri/apiCommands";
import { useApiStore } from "../../state/apiStore";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { useLanguageStore } from "../../state/languageStore";
import { busyHolder, isOnline, useSharedChatStore } from "../../state/sharedChatStore";
import { presentPeers, useLiveStore, type LivePeer, type LiveTurn } from "../../state/liveStore";
import { projectOf } from "../../lib/collabLive/registry";
import { useUiStore } from "../../state/uiStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

/**
 * Shared workspace chats in the assistant panel (`.claude/plans/multiplayer-chat.md`, stage D):
 *
 * - [`SharedChatBar`]: under a chat's header strip. «Compartir» when the chat is not shared;
 *   otherwise the people, the session's files, a turn in progress elsewhere, conflicts, and the
 *   session's actions (invite, commit for the host, leave).
 * - [`ShareChatDialog`] / [`JoinChatDialog`]: opening and joining a session.
 * - [`OtherTurn`]: another person's question or answer, drawn between this machine's own messages.
 * - [`SharedChatJoinHost`]: the join dialog for a `codeflow://chat-join` link opened from outside.
 */

function useL() {
  const lang = useLanguageStore((s) => s.language);
  return (es: string, en: string) => (lang === "es" ? es : en);
}

const field =
  "h-[30px] w-full rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-field)] px-2 text-[12.5px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]";
const btn =
  "inline-flex h-[28px] items-center gap-1.5 rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-surface-raised)] px-2.5 text-[12px] font-medium text-[var(--cf-text)] hover:bg-[var(--cf-hover)] disabled:opacity-45";
const primary =
  "inline-flex h-[28px] items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 text-[12px] font-semibold text-[var(--cf-on-accent)] hover:opacity-90 disabled:opacity-45";
const chip = "inline-flex h-[20px] items-center gap-1 rounded-md px-1.5 text-[10.5px] font-semibold";

export async function copy(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    pushSuccessToast(done);
  } catch {
    pushErrorToast(text);
  }
}

export function Avatar({ id, nick, online = true, size = 20 }: { id: string; nick: string; online?: boolean; size?: number }) {
  const hue = hueOf(id);
  return (
    <span
      title={nick}
      className="relative inline-grid shrink-0 place-items-center rounded-full font-bold ring-2 ring-[var(--cf-surface)]"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `hsl(${hue} 70% 50% / 0.18)`,
        color: `hsl(${hue} 65% 45%)`,
        opacity: online ? 1 : 0.45,
      }}
    >
      {initials(nick)}
    </span>
  );
}

function Modal({ title, icon, onClose, children, footer }: { title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-[520px] max-w-full flex-col overflow-hidden rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-modal)]"
      >
        <header className="flex items-center gap-2.5 border-b border-[var(--cf-border)] px-4 py-3">
          {icon}
          <b className="flex-1 text-[14px]">{title}</b>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="grid h-7 w-7 place-items-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
            <X size={14} />
          </button>
        </header>
        <div className="flex min-h-0 flex-col gap-3 overflow-auto px-4 py-3.5 text-[12.5px]">{children}</div>
        <footer className="flex justify-end gap-2 border-t border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-4 py-3">{footer}</footer>
      </div>
    </div>
  );
}

function reasonLabel(reason: CollabSkipReason, l: (es: string, en: string) => string): string {
  switch (reason) {
    case "dependencies":
      return l("dependencias", "dependencies");
    case "build_output":
      return l("salida de build", "build output");
    case "secret":
      return l("secreto", "secret");
    case "symlink":
      return "symlink";
    case "too_large":
      return l("muy grande", "too large");
    default:
      return l("nombre no portable", "unportable name");
  }
}

/** The Supabase project to use: the API client's ready ones first, then whatever the user types. */
export function useProjectChoice() {
  const projects = useApiStore((s) => s.settings.supabaseProjects ?? []);
  const ready = projects.filter((p) => p.ready).map((p) => p.url);
  const [url, setUrl] = useState(ready[0] ?? "");
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [anonKey, setAnonKey] = useState("");
  useEffect(() => {
    if (!url.trim()) return setHasKey(null);
    let live = true;
    void supabaseHasKey(url.trim())
      .then((v) => live && setHasKey(v))
      .catch(() => live && setHasKey(false));
    return () => {
      live = false;
    };
  }, [url]);
  const ensureKey = async () => {
    if (hasKey) return;
    if (!anonKey.trim()) throw new Error("Falta la anon key del proyecto.");
    await supabaseSetAnonKey(url.trim(), anonKey.trim());
    setHasKey(true);
  };
  return { url, setUrl, ready, hasKey, anonKey, setAnonKey, ensureKey };
}

export function ShareChatDialog({
  workspaceId,
  chatId,
  defaultName,
  onClose,
}: {
  workspaceId: string;
  chatId: string;
  defaultName: string;
  onClose: () => void;
}) {
  const l = useL();
  const project = useProjectChoice();
  const [candidates, setCandidates] = useState<CollabShareCandidate[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [nick, setNick] = useState("");
  const [name, setName] = useState(defaultName || l("Chat compartido", "Shared chat"));
  const [history, setHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    void collabSharePreview(workspaceId)
      .then((list) => {
        setCandidates(list);
        setPicked(list.filter((c) => !c.problem).map((c) => c.projectId));
      })
      .catch((e) => {
        setCandidates([]);
        pushErrorToast(String(e));
      });
  }, [workspaceId]);

  const share = async () => {
    setBusy(true);
    try {
      await project.ensureKey();
      const created = await useSharedChatStore.getState().share({
        workspaceId,
        chatId,
        projectUrl: project.url.trim(),
        nick,
        name,
        projectIds: picked,
        includeHistory: history,
      });
      setLink(created);
    } catch (e) {
      pushErrorToast(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const canShare = !busy && !!nick.trim() && !!name.trim() && picked.length > 0 && !!project.url.trim() && (project.hasKey || !!project.anonKey.trim());

  return (
    <Modal
      title={link ? l("Chat compartido", "Chat shared") : l("Compartir este chat", "Share this chat")}
      icon={<Share2 size={15} className="text-[var(--cf-accent)]" />}
      onClose={onClose}
      footer={
        link ? (
          <>
            <button type="button" className={btn} onClick={() => void copy(link, l("Link copiado", "Link copied"))}>
              <Copy size={12} />
              {l("Copiar link", "Copy link")}
            </button>
            <button type="button" className={primary} onClick={onClose}>
              {l("Listo", "Done")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className={btn} onClick={onClose}>
              {l("Cancelar", "Cancel")}
            </button>
            <button type="button" className={primary} disabled={!canShare} onClick={() => void share()}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
              {l("Compartir", "Share")}
            </button>
          </>
        )
      }
    >
      {link ? (
        <>
          <p className="m-0">{l("Manda este link a una persona. Sirve una sola vez y vence en 24 horas; para otra persona, crea otro desde la barra del chat.", "Send this link to one person. It works once and expires in 24 hours; make another from the chat's bar for someone else.")}</p>
          <div className="flex items-center gap-2 rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-field)] px-2 py-1.5">
            <Link2 size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
            <code className="min-w-0 flex-1 truncate text-[11px]">{link}</code>
          </div>
          <p className="m-0 text-[var(--cf-text-muted)]">{l("Tus repos ya están en su copia de sesión: verás «· sesión» en el sidebar. Trabaja ahí mientras dure.", "Your repositories now have a session copy: look for «· session» in the sidebar. Work there while it lasts.")}</p>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Tu nick", "Your nick")}</span>
              <input className={field} value={nick} onChange={(e) => setNick(e.target.value)} placeholder="Dev A" maxLength={40} autoFocus />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Nombre de la sesión", "Session name")}</span>
              <input className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Proyecto Supabase", "Supabase project")}</span>
            <input className={field} list="cf-shared-projects" value={project.url} onChange={(e) => project.setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" />
            <datalist id="cf-shared-projects">
              {project.ready.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
            <span className="text-[11px] text-[var(--cf-text-faint)]">
              {l(
                "Un proyecto tuyo (el gratuito basta): CodeFlow no tiene servidor propio y tus invitados se conectan a este.",
                "A project of your own (the free tier is enough): CodeFlow has no server of its own and your guests connect to this one.",
              )}
            </span>
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
            onClick={() => void collabInstallSql().then((sql) => copy(sql, l("SQL copiado: córrelo una vez en el SQL editor del proyecto", "SQL copied: run it once in the project's SQL editor")))}
          >
            {l("Copiar el SQL de chats compartidos (una vez por proyecto)", "Copy the shared-chats SQL (once per project)")}
          </button>

          <div className="flex flex-col gap-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Repos de la sesión", "Session repositories")}</span>
            {!candidates && (
              <span className="flex items-center gap-1.5 text-[var(--cf-text-muted)]">
                <Loader2 size={12} className="animate-spin" />
                {l("Revisando repos…", "Checking repositories…")}
              </span>
            )}
            {candidates?.map((c) => {
              const on = picked.includes(c.projectId);
              const home = c.skipped.length;
              return (
                <label key={c.projectId} className={`flex items-start gap-2.5 rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2.5 py-2 ${c.problem ? "opacity-60" : "cursor-pointer"}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    disabled={!!c.problem}
                    checked={on}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.projectId] : p.filter((id) => id !== c.projectId)))}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <b className="text-[12.5px]">{c.name}</b>
                    <span className="text-[11.5px] text-[var(--cf-text-muted)]">
                      {c.problem ??
                        `${c.branch ?? "HEAD"} @ ${c.base?.slice(0, 7) ?? "?"} · ${c.uncommitted} ${l("archivos sin commit se incluyen", "uncommitted files included")}`}
                    </span>
                    {home > 0 && !c.problem && (
                      <span className="text-[11px] text-[var(--cf-text-faint)]" title={c.skipped.map((s) => `${s.path} (${reasonLabel(s.reason, l)})`).join("\n")}>
                        {l(`${home} se quedan en tu máquina`, `${home} stay on your machine`)}: {[...new Set(c.skipped.map((s) => reasonLabel(s.reason, l)))].join(", ")}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
            {l("Incluir lo que ya hablaste en este chat", "Include what this chat already says")}
          </label>
          <p className="m-0 text-[11.5px] text-[var(--cf-text-muted)]">
            {l(
              "Nunca viajan node_modules ni otras dependencias, lo ignorado por git, los .env y claves, ni tus cuentas de los motores. Cada uno responde con su propio motor y su cuota.",
              "node_modules and other dependencies, git-ignored files, .env files and keys, and your engine accounts never travel. Everyone answers with their own engine and quota.",
            )}
          </p>
        </>
      )}
    </Modal>
  );
}

export function JoinChatDialog({ workspaceId, initialLink, onClose }: { workspaceId: string; initialLink: string; onClose: () => void }) {
  const l = useL();
  const [text, setText] = useState(initialLink);
  const [preview, setPreview] = useState<CollabJoinPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [nick, setNick] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPreview(null);
    setProblem(null);
    if (!text.trim()) return;
    let live = true;
    void collabJoinPreview(workspaceId, text)
      .then((p) => live && setPreview(p))
      .catch((e) => live && setProblem(String(e)));
    return () => {
      live = false;
    };
  }, [text, workspaceId]);

  const missing = preview?.repos.filter((r) => !r.projectId) ?? [];
  const join = async () => {
    setBusy(true);
    try {
      const view = await useSharedChatStore.getState().join(workspaceId, text, nick);
      if (view.kind === "run") {
        // A shared «Equipo» run: it lives in Agents › En vivo, where its seats wait to be filled.
        const [{ useSharedRunStore }, { useCrewStore }, { useUiStore }] = await Promise.all([
          import("../../state/sharedRunStore"),
          import("../crew/crewStore"),
          import("../../state/uiStore"),
        ]);
        await useSharedRunStore.getState().load(workspaceId);
        useSharedRunStore.getState().openGuestRun(view.session.id);
        useCrewStore.getState().setSpace("en-vivo");
        useUiStore.getState().setActiveView("agents");
      } else {
        openWorkspaceChat(workspaceId, { conversationId: view.session.chatId });
      }
      pushSuccessToast(l(`Entraste a «${view.session.name}»`, `You joined «${view.session.name}»`));
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={l("Unirse a un chat compartido", "Join a shared chat")}
      icon={<Users size={15} className="text-[var(--cf-accent)]" />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {l("Cancelar", "Cancel")}
          </button>
          <button type="button" className={primary} disabled={busy || !preview || missing.length > 0 || !nick.trim()} onClick={() => void join()}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />}
            {l("Entrar", "Join")}
          </button>
        </>
      }
    >
      {!initialLink && (
        <label className="flex flex-col gap-1">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Link de invitación", "Invitation link")}</span>
          <input className={field} value={text} onChange={(e) => setText(e.target.value)} placeholder="codeflow://chat-join?d=…" autoFocus />
        </label>
      )}
      {problem && <p className="m-0 text-[var(--cf-danger)]">{problem}</p>}
      {preview && (
        <>
          <div className="rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 py-2">
            <b className="block text-[13px]">{preview.name}</b>
            <span className="text-[11.5px] text-[var(--cf-text-muted)]">
              {preview.kind === "run"
                ? l(`${preview.host} te invita a una corrida de Equipo: ocuparás puestos con agentes tuyos, en tu máquina y con tu cuenta`, `${preview.host} invites you to a team run: you will fill seats with your own agents, on your machine and account`)
                : l(`Te invita ${preview.host}`, `Invited by ${preview.host}`)}
            </span>
          </div>
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Repos que necesitas", "Repositories you need")}</span>
          {preview.repos.map((r) => (
            <div key={r.key} className="flex items-center gap-2 rounded-[10px] border border-[var(--cf-border)] px-2.5 py-1.5">
              <span className="min-w-0 flex-1">
                <b className="block text-[12.5px]">{r.name}</b>
                <code className="block truncate text-[11px] text-[var(--cf-text-muted)]">{r.key}</code>
              </span>
              {r.projectId ? (
                <span className={`${chip} bg-[color-mix(in_oklab,var(--cf-success)_15%,transparent)] text-[var(--cf-success)]`}>
                  <Check size={10} />
                  {l("lo tienes", "you have it")}
                </span>
              ) : (
                <span className={`${chip} bg-[color-mix(in_oklab,var(--cf-warning)_15%,transparent)] text-[var(--cf-warning)]`}>{l("falta en este workspace", "missing here")}</span>
              )}
            </div>
          ))}
          {missing.length > 0 && (
            <p className="m-0 text-[11.5px] text-[var(--cf-warning)]">
              {l("Clona o agrega esos repos a este workspace y vuelve a abrir el link. La invitación no se gasta hasta que entres.", "Clone or add those repositories to this workspace and open the link again. The invitation is not spent until you join.")}
            </p>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l("Tu nick", "Your nick")}</span>
            <input className={field} value={nick} onChange={(e) => setNick(e.target.value)} placeholder="Dev B" maxLength={40} />
          </label>
          <p className="m-0 text-[11.5px] text-[var(--cf-text-muted)]">
            {l(
              "Se crea una copia de sesión de cada repo, sobre la misma base que el anfitrión. Tu checkout no se toca. Tus turnos usan tu motor y tu cuota.",
              "A session copy of each repository is made on the host's base. Your own checkout is not touched. Your turns use your engine and quota.",
            )}
          </p>
        </>
      )}
    </Modal>
  );
}

/** The bar a chat shows under its header strip: «Compartir», or the live session. */
export function SharedChatBar({ workspaceId, chatId, title, persisted }: { workspaceId: string; chatId: string; title: string; persisted: boolean }) {
  const l = useL();
  const view = useSharedChatStore((s) => s.byChat[chatId]);
  const live = useSharedChatStore((s) => (view ? s.live[view.session.id] : undefined));
  const channel = useLiveStore((s) => (view ? s.sessions[view.session.id] : undefined));
  const [following, setFollowing] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [joining, setJoining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, setNow] = useState(0);

  // Asked whatever the chat holds: a chat joined a moment ago is shared before it has a message.
  useEffect(() => {
    void useSharedChatStore.getState().ensure(chatId);
  }, [chatId]);
  // Re-render every few seconds so "connected" follows the heartbeats.
  useEffect(() => {
    if (!view) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [view]);
  // «Seguir»: wherever the followed person goes, this editor goes too.
  const followedFile = following ? channel?.peers[following]?.file : null;
  useEffect(() => {
    if (!view || !followedFile) return;
    openSessionFile(view.session.id, followedFile.repoKey, followedFile.path);
  }, [view, followedFile?.repoKey, followedFile?.path]);

  if (!view) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1 text-[11px] text-[var(--cf-text-muted)]">
        <button
          type="button"
          disabled={!persisted}
          title={persisted ? l("Compartir este chat y sus repos con otra persona", "Share this chat and its repositories with someone") : l("Escribe la primera pregunta antes de compartir", "Ask the first question before sharing")}
          onClick={() => setSharing(true)}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:opacity-45"
        >
          <Share2 size={11} />
          {l("Compartir", "Share")}
        </button>
        <button type="button" onClick={() => setJoining(true)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]">
          <UserPlus size={11} />
          {l("Unirse con un link", "Join with a link")}
        </button>
        {sharing && <ShareChatDialog workspaceId={workspaceId} chatId={chatId} defaultName={title} onClose={() => setSharing(false)} />}
        {joining && <JoinChatDialog workspaceId={workspaceId} initialLink="" onClose={() => setJoining(false)} />}
      </div>
    );
  }

  const me = view.session.personId;
  const people: CollabPerson[] = live?.people ?? [];
  const peers = presentPeers(channel);
  const inFiles = peers.filter(([, p]) => p.file);
  const holder = busyHolder(live, me);
  const conflicts = live?.conflicts ?? [];
  const failing = (live?.errors.length ?? 0) > 0;

  const invite = async () => {
    try {
      const link = await useSharedChatStore.getState().invite(view.session.id);
      await copy(link, l("Link de invitación copiado (un solo uso)", "Invitation link copied (single use)"));
    } catch (e) {
      pushErrorToast(String(e));
    }
  };
  const commit = async () => {
    const message = await promptAction(l("Mensaje del commit de la sesión. Se sube la rama de sesión y todos pasan a la nueva base.", "Session commit message. The session branch is pushed and everyone moves to the new base."), {
      initial: `Sesión: ${view.session.name}`,
      confirmLabel: "Commit",
    });
    if (message === null) return;
    setBusy(true);
    try {
      const done = await useSharedChatStore.getState().commit(view.session.id, message);
      const made = done.filter((d) => d.commit);
      pushSuccessToast(made.length ? l(`Commit en ${made.map((d) => d.repo).join(", ")}: la sesión avanzó de base`, `Committed in ${made.map((d) => d.repo).join(", ")}`) : l("No había cambios para commitear", "Nothing to commit"));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };
  const leave = async () => {
    const hostNote = view.isOwner ? l(" Eres el anfitrión: la sesión termina para todos.", " You are the host: the session ends for everyone.") : "";
    const keep = await confirmAction(
      l(`¿Salir de «${view.session.name}»? Tu trabajo queda commiteado en la rama de la sesión de cada repo.${hostNote}`, `Leave «${view.session.name}»? Your work is committed on each repository's session branch.${hostNote}`),
      false,
      l("Salir y conservar la rama", "Leave and keep the branch"),
    );
    if (!keep) return;
    setBusy(true);
    try {
      const left = await useSharedChatStore.getState().leave(chatId, true);
      const kept = left.filter((x) => x.kept).map((x) => x.repo);
      pushSuccessToast(
        l(`Saliste. Ramas: ${left.map((x) => x.branch).join(", ")}`, `You left. Branches: ${left.map((x) => x.branch).join(", ")}`) +
          (kept.length ? l(` · ${kept.join(", ")}: la copia quedó en disco porque tenía archivos que no se comparten`, ` · ${kept.join(", ")}: the copy stayed on disk (unshared files)`) : ""),
      );
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-accent)_6%,var(--cf-surface))] px-3 py-1.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center">
          {people.map((p) => (
            <span key={p.id} className="-ml-1 first:ml-0">
              <Avatar id={p.id} nick={p.id === me ? `${p.nick} (tú)` : p.nick} online={p.id === me || isOnline(p)} />
            </span>
          ))}
        </span>
        <b className="truncate text-[11.5px] text-[var(--cf-text)]">{view.session.name}</b>
        <span
          className={`inline-flex items-center gap-1 ${channel?.connected ? "text-[var(--cf-teal)]" : "text-[var(--cf-text-faint)]"}`}
          title={
            channel?.connected
              ? l("Canal en vivo conectado: lo que se escribe en un archivo abierto llega al instante, con los cursores", "Live channel connected: typing in an open file arrives instantly, with cursors")
              : l("Sin canal en vivo: los archivos se sincronizan al guardar, cada pocos segundos", "No live channel: files sync on save, every few seconds")
          }
        >
          <span className={`h-1.5 w-1.5 rounded-full ${channel?.connected ? "bg-[var(--cf-teal)]" : "bg-[var(--cf-text-faint)]"}`} />
          {channel?.connected ? l("en vivo", "live") : l("sin vivo", "not live")}
        </span>
        <span className={`inline-flex items-center gap-1 ${failing ? "text-[var(--cf-danger)]" : "text-[var(--cf-teal)]"}`} title={live?.errors.join("\n")}>
          <Radio size={10} />
          {failing ? l("problemas al sincronizar", "sync problems") : l(`${live?.sessionFiles ?? 0} archivos en la sesión`, `${live?.sessionFiles ?? 0} files in the session`)}
        </span>
        {holder && (
          <span className="inline-flex items-center gap-1 text-[var(--cf-warning)]">
            <Loader2 size={10} className="animate-spin" />
            {l(`Turno de ${holder} en curso`, `${holder}'s turn in progress`)}
          </span>
        )}
        {live?.ended && <span className="text-[var(--cf-danger)]">{l("El anfitrión terminó la sesión", "The host ended the session")}</span>}
        <span className="ml-auto" />
        {view.isOwner && !live?.ended && (
          <button type="button" className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]" onClick={() => void invite()}>
            <UserPlus size={11} />
            {l("Invitar", "Invite")}
          </button>
        )}
        {view.isOwner && !live?.ended && (
          <button type="button" disabled={busy} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]" onClick={() => void commit()} title={l("Commit de lo compartido, push de la rama de sesión y nueva base para todos", "Commit what is shared, push the session branch and move everyone's base")}>
            <GitCommitHorizontal size={11} />
            Commit
          </button>
        )}
        <button type="button" disabled={busy} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]" onClick={() => void leave()}>
          <LogOut size={11} />
          {l("Salir", "Leave")}
        </button>
      </div>
      {inFiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-[var(--cf-text-muted)]">
          {inFiles.map(([id, peer]) => (
            <PeerFile
              key={id}
              id={id}
              peer={peer}
              following={following === id}
              onOpen={() => peer.file && openSessionFile(view.session.id, peer.file.repoKey, peer.file.path)}
              onFollow={() => setFollowing((f) => (f === id ? null : id))}
            />
          ))}
        </div>
      )}
      {conflicts.map((c) => (
        <div key={`${c.repoKey}/${c.path}`} className="flex flex-wrap items-center gap-2 rounded-md bg-[color-mix(in_oklab,var(--cf-warning)_14%,transparent)] px-2 py-1 text-[var(--cf-text)]">
          <AlertTriangle size={11} className="text-[var(--cf-warning)]" />
          <span className="min-w-0 flex-1 truncate">
            <code>{c.path}</code> {l(`cambió aquí y en la sesión${c.remoteBy ? ` (${c.remoteBy})` : ""} a la vez`, `changed here and in the session${c.remoteBy ? ` (${c.remoteBy})` : ""}`)}
          </span>
          <button type="button" className="rounded px-1.5 hover:bg-[var(--cf-hover)]" onClick={() => void useSharedChatStore.getState().resolve(view.session.id, c.repoKey, c.path, true).catch((e) => pushErrorToast(String(e)))}>
            {l("Quedarme con lo mío", "Keep mine")}
          </button>
          <button type="button" className="rounded px-1.5 hover:bg-[var(--cf-hover)]" onClick={() => void useSharedChatStore.getState().resolve(view.session.id, c.repoKey, c.path, false).catch((e) => pushErrorToast(String(e)))}>
            {l("Tomar lo de la sesión", "Take the session's")}
          </button>
        </div>
      ))}
    </div>
  );
}

/** Opens a file of the session in this window's editor, in its session project. */
function openSessionFile(sessionId: string, repoKey: string, path: string): void {
  const projectId = projectOf(sessionId, repoKey);
  if (!projectId) return;
  const workspace = useWorkspaceStore.getState();
  if (workspace.activeProjectId !== projectId) workspace.setActiveProject(projectId);
  useUiStore.getState().openInEditor(path);
}

/** Someone connected and the file they are in: open it once, or follow them around. */
function PeerFile({ id, peer, following, onOpen, onFollow }: { id: string; peer: LivePeer; following: boolean; onOpen: () => void; onFollow: () => void }) {
  const l = useL();
  if (!peer.file) return null;
  const name = peer.file.path.split("/").pop() ?? peer.file.path;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Avatar id={id} nick={peer.nick} size={14} online />
      <span>{peer.nick}</span>
      <button type="button" className="inline-flex min-w-0 items-center gap-0.5 rounded px-1 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]" title={peer.file.path} onClick={onOpen}>
        <FileText size={10} />
        <span className="max-w-[180px] truncate font-mono">{name}</span>
      </button>
      <button
        type="button"
        className={`inline-flex items-center gap-0.5 rounded px-1 ${following ? "bg-[var(--cf-accent-soft,var(--cf-hover))] text-[var(--cf-accent)]" : "hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"}`}
        title={following ? l(`Dejar de seguir a ${peer.nick}`, `Stop following ${peer.nick}`) : l(`Seguir a ${peer.nick}: tu editor va al archivo en que está`, `Follow ${peer.nick}: your editor goes to the file they are in`)}
        onClick={onFollow}
      >
        {following ? <EyeOff size={10} /> : <Eye size={10} />}
        {following ? l("Siguiendo", "Following") : l("Seguir", "Follow")}
      </button>
    </span>
  );
}

/** The answer another person's engine is writing right now, as it streams over the live channel. */
export function LiveOtherTurn({ id, turn }: { id: string; turn: LiveTurn }) {
  const l = useL();
  const bubble = useMemo(() => ({ role: "assistant" as const, content: turn.text, provider: turn.engine ?? undefined }), [turn.text, turn.engine]);
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
        <Avatar id={id} nick={turn.nick} size={16} />
        {l(`${engineName(turn.engine)} · con la cuenta de ${turn.nick}`, `${engineName(turn.engine)} · on ${turn.nick}'s account`)}
        {!turn.done && <Loader2 size={10} className="animate-spin" />}
      </span>
      <div className="opacity-95">
        <ChatMessageBubble message={bubble} />
      </div>
    </div>
  );
}

/** Another person's question or answer, in this machine's transcript. */
export function OtherTurn({ message }: { message: CollabMessage }) {
  const l = useL();
  const nick = message.body.nick ?? l("Alguien", "Someone");
  const isQuestion = message.kind === "user";
  const changed = (message.body.changes ?? []).filter((c) => c.paths?.length);
  const bubble = useMemo(
    () => ({
      role: isQuestion ? ("user" as const) : ("assistant" as const),
      content: message.body.text ?? "",
      createdAt: message.createdAt,
      provider: isQuestion ? undefined : message.body.engine,
    }),
    [isQuestion, message],
  );
  return (
    <div className="flex flex-col gap-1">
      <span className={`flex items-center gap-1.5 text-[10.5px] text-[var(--cf-text-muted)] ${isQuestion ? "justify-end" : ""}`}>
        <Avatar id={message.personId ?? nick} nick={nick} size={16} />
        {isQuestion ? nick : l(`${engineName(message.body.engine)} · con la cuenta de ${nick}`, `${engineName(message.body.engine)} · on ${nick}'s account`)}
      </span>
      <div className="opacity-95">
        <ChatMessageBubble message={bubble} />
      </div>
      {!isQuestion && changed.length > 0 && (
        <div className="rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2.5 py-1.5 text-[11px]">
          <span className="font-semibold text-[var(--cf-text-muted)]">{l("Cambios del turno, ya en tu copia", "Turn changes, already in your copy")}</span>
          {changed.map((c) => (
            <div key={c.repo ?? ""} className="truncate font-mono text-[10.5px]" title={c.paths.join("\n")}>
              {c.repo}: {c.paths.slice(0, 6).join(", ")}
              {c.paths.length > 6 ? ` +${c.paths.length - 6}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The join dialog for an invitation link opened from outside, in the main window. */
export function SharedChatJoinHost() {
  const pending = useSharedChatStore((s) => s.pendingJoin);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  if (!pending || !workspaceId) return null;
  return <JoinChatDialog workspaceId={workspaceId} initialLink={pending} onClose={() => useSharedChatStore.setState({ pendingJoin: null })} />;
}

export type { CollabSessionView };
