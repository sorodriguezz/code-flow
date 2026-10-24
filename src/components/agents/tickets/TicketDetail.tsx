import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { ArrowRightLeft, ExternalLink, GitBranch, GitPullRequest, Play, RotateCcw } from "lucide-react";
import { ContextMenu, type MenuItem } from "../../common/ContextMenu";
import { buttonClass } from "../../common/Button";
import { chipClass } from "../../common/recipes";
import { StartTicketDialog } from "./StartTicketDialog";
import { TicketTypeGlyph, stateTone } from "./TicketsSection";
import { useTicketStore, TARGET_STATES_KEY } from "../../../state/ticketStore";
import { useActiveProjects } from "../../../state/workspaceStore";
import { pushErrorToast } from "../../../state/toastStore";
import { useT } from "../../../state/languageStore";
import { getSetting, openExternalUrl, setSetting } from "../../../lib/tauri/commands";
import { boardLabelKey } from "../../../lib/boardLabel";
import { displayKey, ticketUid } from "../../../lib/tickets/ticketKeys";
import {
  ticketsDetail,
  ticketsMove,
  ticketsStates,
  type Ticket,
  type TicketDetail as Detail,
  type TicketState,
} from "../../../lib/tauri/ticketCommands";

/** Board HTML is someone else's markup: sanitised before it is drawn, links kept. */
function clean(html: string): string {
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

/** The key the per-board target states are stored under — `board_key` in `boards/tickets.rs`. */
function boardKey(ticket: Ticket): string {
  return `${ticket.provider.toLowerCase()}:${ticket.account.toLowerCase()}:${ticket.container_id || ticket.project}`;
}

type Targets = Record<string, { review?: string; done?: string }>;

async function readTargets(): Promise<Targets> {
  const raw = await getSetting(TARGET_STATES_KEY).catch(() => null);
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Targets) : {};
  } catch {
    return {};
  }
}

/**
 * One ticket in the middle column: what it asks (description, acceptance criteria, the recent
 * conversation), where its code is (branch, worktree, pull request), and the three things to do
 * with it — «Empezar», «Abrir en el navegador», «Mover a…».
 */
export function TicketDetail({ uid }: { uid: string }) {
  const t = useT();
  const ticket = useTicketStore((s) => s.tickets.find((candidate) => ticketUid(candidate) === uid) ?? null);
  const links = useTicketStore((s) => s.links);
  const lastMove = useTicketStore((s) => s.lastMove[uid]);
  const repos = useActiveProjects();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; states: TicketState[]; targets: Targets } | null>(null);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (!ticket) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    void ticketsDetail(ticket)
      .then((read) => !cancelled && setDetail(read))
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
    // Re-read when the ticket changes identity, not on every refresh of the list around it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  const mine = useMemo(() => links.filter((link) => link.ticket_uid === uid), [links, uid]);

  if (!ticket) {
    return <p className="px-6 py-6 text-[12px] text-[var(--cf-text-faint)]">{t("tickets.gone")}</p>;
  }

  const openMoveMenu = async (x: number, y: number) => {
    try {
      const [states, targets] = await Promise.all([ticketsStates(ticket), readTargets()]);
      setMenu({ x, y, states, targets });
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const move = async (state: string) => {
    setMoving(true);
    try {
      const moved = await ticketsMove(ticket, state);
      useTicketStore.getState().applyMove(moved);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setMoving(false);
    }
  };

  const setTarget = async (which: "review" | "done", state: string) => {
    const targets = await readTargets();
    const key = boardKey(ticket);
    const current = targets[key] ?? {};
    // Picking the one already set clears it, back to the automatic choice.
    const next = { ...current, [which]: current[which] === state ? undefined : state };
    await setSetting(TARGET_STATES_KEY, JSON.stringify({ ...targets, [key]: next })).catch(() => undefined);
  };

  const menuItems = (states: TicketState[], targets: Targets): MenuItem[] => {
    const configured = targets[boardKey(ticket)] ?? {};
    const moves: MenuItem[] = states
      .filter((state) => state.name !== ticket.state)
      .map((state) => ({ label: state.name, onClick: () => void move(state.name) }));
    const pick = (which: "review" | "done", label: string): MenuItem => ({
      label,
      separated: which === "review",
      onClick: () => undefined,
      children: states.map((state) => ({
        label: configured[which] === state.name ? `✓ ${state.name}` : state.name,
        onClick: () => void setTarget(which, state.name),
      })),
    });
    return states.length === 0 ? [] : [...moves, pick("review", t("tickets.reviewTarget")), pick("done", t("tickets.doneTarget"))];
  };

  const shown = detail?.ticket ?? ticket;
  const facts = [
    `${t(boardLabelKey(shown.provider))} · ${shown.project}`,
    shown.work_item_type,
    shown.sprint,
    shown.priority && `${t("tickets.priority")} ${shown.priority}`,
  ].filter(Boolean);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-[var(--cf-border)] px-5 pb-3 pt-4">
        <div className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
          <TicketTypeGlyph ticket={shown} />
          <span className="font-mono">{displayKey(shown)}</span>
          <span className={chipClass(stateTone(shown.state_category))}>{shown.state || "—"}</span>
          {lastMove && lastMove.from && (
            <button
              type="button"
              onClick={() => void useTicketStore.getState().undo(uid)}
              className="inline-flex items-center gap-1 text-[11.5px] text-[var(--cf-accent)] hover:underline"
            >
              <RotateCcw size={11} />
              {t("tickets.undo", { state: lastMove.from })}
            </button>
          )}
        </div>
        <h2 className="mt-1.5 text-[15px] font-semibold leading-snug text-[var(--cf-text)]">{shown.title}</h2>
        <p className="mt-1 truncate text-[12px] text-[var(--cf-text-muted)]">{facts.join(" · ")}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setStarting(true)} className={buttonClass({ variant: "primary", size: "sm" })}>
            <Play size={13} />
            {t("tickets.start")}
          </button>
          <button
            type="button"
            onClick={() => void openExternalUrl(shown.url)}
            disabled={!shown.url}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            <ExternalLink size={13} />
            {t("tickets.openInBrowser")}
          </button>
          <button
            type="button"
            disabled={moving}
            onClick={(e) => void openMoveMenu(e.clientX, e.clientY)}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            <ArrowRightLeft size={13} />
            {t("tickets.moveTo")}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {mine.length > 0 && (
          <section className="space-y-1">
            {mine.map((link) => (
              <div key={link.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--cf-text-muted)]">
                <span className="inline-flex items-center gap-1">
                  <GitBranch size={12} />
                  <span className="font-mono text-[var(--cf-text)]">{link.branch}</span>
                </span>
                <span>{repos.find((repo) => repo.id === link.project_id)?.name ?? ""}</span>
                {link.pr_url && (
                  <button
                    type="button"
                    onClick={() => void openExternalUrl(link.pr_url)}
                    className="inline-flex items-center gap-1 text-[var(--cf-accent)] hover:underline"
                  >
                    <GitPullRequest size={12} />#{link.pr_id}
                  </button>
                )}
                <span className={chipClass(link.stage === "done" ? "ok" : link.stage === "review" ? "warn" : "neutral")}>
                  {t(link.stage === "done" ? "tickets.stageDone" : link.stage === "review" ? "tickets.stageReview" : "tickets.stageStarted")}
                </span>
              </div>
            ))}
          </section>
        )}

        {error && <p className="text-[12px] text-[var(--cf-danger)]">{error}</p>}
        {!detail && !error && <p className="text-[12px] text-[var(--cf-text-faint)]">{t("tickets.loading")}</p>}
        {detail && (
          <>
            <Block label={t("tickets.description")} html={detail.description_html} empty={t("tickets.emptyField")} />
            {detail.acceptance_criteria_html.trim() && (
              <Block label={t("tickets.criteria")} html={detail.acceptance_criteria_html} empty={t("tickets.emptyField")} />
            )}
            {detail.comments.length > 0 && (
              <section>
                <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                  {t("tickets.comments")}
                </p>
                <div className="space-y-2.5">
                  {detail.comments.map((comment, at) => (
                    <div key={at} className="border-l-2 border-[var(--cf-border)] pl-3">
                      <p className="text-[11.5px] text-[var(--cf-text-muted)]">
                        <span className="font-medium text-[var(--cf-text)]">{comment.author}</span>
                        {comment.created_at && ` · ${comment.created_at.slice(0, 10)}`}
                      </p>
                      <div
                        className="cf-markdown-preview break-words text-[12px] [&>:first-child]:mt-0 [&>:last-child]:mb-0"
                        dangerouslySetInnerHTML={{ __html: clean(comment.body_html) }}
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {starting && <StartTicketDialog ticket={shown} onClose={() => setStarting(false)} />}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          heading={t("tickets.moveTo")}
          items={menuItems(menu.states, menu.targets)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function Block({ label, html, empty }: { label: string; html: string; empty: string }) {
  return (
    <section>
      <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">{label}</p>
      {html.trim() ? (
        <div
          className="cf-markdown-preview break-words text-[12.5px] [&>:first-child]:mt-0 [&>:last-child]:mb-0"
          dangerouslySetInnerHTML={{ __html: clean(html) }}
        />
      ) : (
        <p className="text-[12px] text-[var(--cf-text-faint)]">{empty}</p>
      )}
    </section>
  );
}
