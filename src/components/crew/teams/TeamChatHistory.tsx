import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Check, ChevronDown, History, Loader2, MessageSquarePlus, MessagesSquare, Trash2 } from "lucide-react";
import type { TeamChatSummary } from "../../../lib/tauri/teamCommands";
import { confirmAction } from "../../../state/confirmStore";
import { ago } from "../kit/time";
import { useL } from "../state";

const WIDTH = 328;
const EDGE = 8;

/** What a conversation is called in the list: its first words, or that it has none yet. */
export function chatTitle(item: TeamChatSummary, l: (es: string, en: string) => string): string {
  return item.title.trim() || l("Conversación sin mensajes", "Conversation with no messages");
}

/** The conversation a window turns to when `gone` is deleted: the most recent of the others. */
export function nextChat(items: TeamChatSummary[], gone: string): string | undefined {
  return items.find((item) => item.id !== gone)?.id;
}

/**
 * The team's conversations: go to one, or delete it.
 *
 * A menu of its own rather than a select, because a row here does two things — and deleting must
 * be reachable for every conversation, not only the one on screen. It stays open after a
 * deletion, so clearing several out is one visit.
 */
export function TeamChatHistory({ chatId, items, busy, compact, onPick, onNew, onDelete, agent = false }: {
  /** The conversations are one agent's rather than a team's: only the words change. */
  agent?: boolean;
  chatId: string;
  items: TeamChatSummary[];
  /** The team is answering the conversation on screen: that one cannot be deleted now. */
  busy: boolean;
  /** In a narrow header only the icon is left. */
  compact: boolean;
  onPick: (id: string) => void;
  /** Starts a new conversation with the team. */
  onNew: () => void;
  /** Deletes for good; resolves to whether it did. */
  onDelete: (item: TeamChatSummary) => Promise<boolean>;
}) {
  const l = useL();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const [removing, setRemoving] = useState("");
  /** A question is up: a click on it is not a click away from the menu. */
  const asking = useRef(false);
  const current = items.find((item) => item.id === chatId);

  const reposition = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    const down = below >= 260 || below >= rect.top;
    setPos({
      left: Math.max(EDGE, Math.min(rect.right - WIDTH, window.innerWidth - EDGE - WIDTH)),
      top: down ? rect.bottom + 6 : undefined,
      bottom: down ? undefined : window.innerHeight - rect.top + 6,
      maxHeight: Math.max(160, Math.min(420, (down ? below : rect.top) - 16)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (asking.current || trigger.current?.contains(target) || menu.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // The keyboard lands on the conversation on screen.
  useEffect(() => {
    if (open && pos) (menu.current?.querySelector<HTMLElement>("[data-current='true']") ?? menu.current?.querySelector<HTMLElement>("[data-row]"))?.focus({ preventScroll: false });
  }, [open, pos !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const onKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = [...(menu.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
    if (rows.length === 0) return;
    const at = rows.findIndex((row) => row === document.activeElement || row.parentElement?.contains(document.activeElement));
    rows[(at + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length].focus();
  };

  const remove = async (item: TeamChatSummary) => {
    const whole = chatTitle(item, l);
    const name = whole.length > 60 ? `${whole.slice(0, 60).trimEnd()}…` : whole;
    asking.current = true;
    const yes = await confirmAction(
      item.messages === 0
        ? l("¿Eliminar esta conversación sin mensajes?", "Delete this conversation with no messages?")
        : agent
          ? l(
              `¿Eliminar la conversación «${name}»? Se borran sus mensajes. Los cambios que el agente hizo en el repositorio se conservan.`,
              `Delete the conversation “${name}”? Its messages are removed. The changes the agent made in the repository stay.`,
            )
          : l(
              `¿Eliminar la conversación «${name}»? Se borran sus mensajes y lo que cada miembro respondió en ella. Los cambios que el equipo hizo en los repositorios se conservan.`,
              `Delete the conversation “${name}”? Its messages and what each member answered in it are removed. The changes the team made in the repositories stay.`,
            ),
      true,
      l("Eliminar", "Delete"),
    ).finally(() => { asking.current = false; });
    if (!yes) return;
    setRemoving(item.id);
    try { await onDelete(item); } finally { setRemoving(""); }
  };

  const label = agent ? l("Conversaciones con el agente", "Conversations with the agent") : l("Conversaciones del equipo", "Team conversations");
  const answering = agent ? l("El agente está respondiendo", "The agent is answering") : l("El equipo está respondiendo", "The team is answering");
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={current ? `${label}: ${chatTitle(current, l)}` : label}
        onClick={() => setOpen((was) => !was)}
        className={`flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-md border px-1.5 text-[12px] text-[var(--cf-text)] outline-none transition-[border-color,box-shadow,background-color] duration-100 ${
          open
            ? "border-[var(--cf-accent)] bg-[var(--cf-field)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]"
            : "border-[var(--cf-field-border)] bg-[var(--cf-field)] hover:border-[var(--cf-border-strong)] focus-visible:border-[var(--cf-accent)] focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]"
        }`}
      >
        <History className="h-3.5 w-3.5 shrink-0 text-[var(--cf-text-muted)]" />
        {/* An agent's conversations are told apart by when they were, not by a name: the header keeps
            that room for who the agent is. */}
        {!agent && <span className={`max-w-[120px] truncate @[700px]:max-w-[180px] ${compact ? "hidden @[520px]:inline" : ""}`}>{current ? chatTitle(current, l) : l("Historial", "History")}</span>}
        <span className={`rounded-full bg-[var(--cf-surface-raised)] px-1.5 text-[10.5px] font-medium tabular-nums text-[var(--cf-text-muted)] ${compact ? "hidden @[440px]:inline" : ""}`}>{items.length}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-[var(--cf-text-faint)] transition-transform ${open ? "rotate-180" : ""} ${compact ? "hidden @[520px]:block" : ""}`} />
      </button>
      {open && pos && createPortal(
        <motion.div
          ref={menu}
          role="dialog"
          aria-label={label}
          initial={{ opacity: 0, y: pos.top === undefined ? 4 : -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.12, ease: "easeOut" }}
          // Drawn outside the header but still its child for React: a press here must not reach
          // the window's grip and start a drag, nor a double click maximise it.
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={onKeys}
          style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, width: WIDTH, maxHeight: pos.maxHeight, transformOrigin: pos.top === undefined ? "bottom right" : "top right" }}
          className="z-[55] flex flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
            <MessagesSquare className="h-3.5 w-3.5 text-[var(--cf-text-muted)]" />
            <b className="text-[12px] font-semibold">{l("Conversaciones", "Conversations")}</b>
            <span className="ml-auto text-[11px] tabular-nums text-[var(--cf-text-muted)]">{items.length}</span>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto p-[5px]">
            {items.map((item) => {
              const here = item.id === chatId;
              const locked = here && busy;
              const name = chatTitle(item, l);
              const going = removing === item.id;
              return (
                <li key={item.id} className={`group relative flex items-center rounded-lg ${here ? "bg-[color-mix(in_oklab,var(--cf-accent)_12%,transparent)]" : "hover:bg-[color-mix(in_oklab,var(--cf-text)_6%,transparent)] focus-within:bg-[color-mix(in_oklab,var(--cf-text)_6%,transparent)]"} ${going ? "opacity-50" : ""}`}>
                  <button
                    type="button"
                    data-row
                    data-current={here}
                    aria-current={here || undefined}
                    disabled={going}
                    onClick={() => { if (!here) onPick(item.id); close(); }}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-2 pr-1 text-left outline-none focus-visible:shadow-[inset_0_0_0_2px_color-mix(in_oklab,var(--cf-accent)_55%,transparent)]"
                  >
                    <span className="grid h-4 w-4 shrink-0 place-items-center">{here && <Check className="h-3.5 w-3.5 text-[var(--cf-accent)]" />}</span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[12.5px] ${here ? "font-medium text-[var(--cf-accent)]" : item.title.trim() ? "text-[var(--cf-text)]" : "italic text-[var(--cf-text-muted)]"}`}>{name}</span>
                      <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
                        {ago(item.createdAt, l)}{item.messages > 0 ? ` · ${item.messages === 1 ? l("1 mensaje", "1 message") : l(`${item.messages} mensajes`, `${item.messages} messages`)}` : ""}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={locked || going}
                    onClick={() => void remove(item)}
                    aria-label={l(`Eliminar la conversación «${name}»`, `Delete the conversation “${name}”`)}
                    title={locked ? l(`${answering}: detén la respuesta para eliminarla`, `${answering}: stop it to delete this conversation`) : l("Eliminar conversación", "Delete conversation")}
                    className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-[var(--cf-text-muted)] opacity-0 outline-none transition-[opacity,color,background-color] duration-100 hover:bg-[color-mix(in_oklab,var(--cf-danger)_14%,transparent)] hover:text-[var(--cf-danger)] focus-visible:opacity-100 focus-visible:shadow-[0_0_0_2px_color-mix(in_oklab,var(--cf-danger)_45%,transparent)] disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[var(--cf-text-muted)] group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    {going ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="shrink-0 border-t border-[var(--cf-border)] p-[5px]">
            <button
              type="button"
              data-row
              disabled={busy}
              title={busy ? answering : undefined}
              onClick={() => { onNew(); close(); }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-[var(--cf-text)] outline-none hover:bg-[color-mix(in_oklab,var(--cf-text)_6%,transparent)] focus-visible:shadow-[inset_0_0_0_2px_color-mix(in_oklab,var(--cf-accent)_55%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <MessageSquarePlus className="h-4 w-4 shrink-0 text-[var(--cf-text-muted)]" />
              {l("Nueva conversación", "New conversation")}
            </button>
          </div>
        </motion.div>,
        document.body,
      )}
    </>
  );
}
