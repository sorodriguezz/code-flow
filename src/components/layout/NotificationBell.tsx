import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { Bell, CircleAlert, CircleCheck, Info, Trash2, X } from "lucide-react";
import {
  NOTIFICATION_SOURCE_LABEL,
  useNotificationStore,
  type AppNotification,
} from "../../state/notificationStore";
import { useLanguageStore, useT } from "../../state/languageStore";

const PANEL_WIDTH = 340;

const STATUS_ICON = {
  success: CircleCheck,
  error: CircleAlert,
  info: Info,
} as const;

const STATUS_COLOR = {
  success: "var(--cf-success)",
  error: "var(--cf-danger)",
  info: "var(--cf-text-muted)",
} as const;

/**
 * The notification centre, hung off the end of the status bar.
 *
 * It answers one question — "did the thing I walked away from finish?" — and the panel is built
 * around the three parts of that answer: **where** it happened (the menu, so you know where to go
 * back to), **what** it did, and **when** it finished. Toasts can't do this job: they expire, and
 * the whole point is that nobody was looking.
 *
 * The dot means unread, and it clears when the panel *closes* rather than when it opens. Opening is
 * not reading — closing is the gesture that says you're done with the list — and marking on open
 * would wipe the per-row highlight in the same frame it appeared, so you could never tell which
 * entries were the new ones. The entries themselves stay until removed; being read is not a reason
 * to disappear.
 *
 * The panel opens *upward*: this lives in a footer pinned to the bottom of the window, so there is
 * never room below it.
 */
export function NotificationBell() {
  const t = useT();
  const locale = useLanguageStore((s) => (s.language === "es" ? "es-ES" : "en-US"));
  const items = useNotificationStore((s) => s.items);
  const remove = useNotificationStore((s) => s.remove);
  const clear = useNotificationStore((s) => s.clear);
  const markAllSeen = useNotificationStore((s) => s.markAllSeen);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; right: number; maxHeight: number } | null>(null);

  const unseen = items.reduce((n, item) => n + (item.seen ? 0 : 1), 0);
  const label =
    unseen > 0
      ? `${t("notifications.title")} — ${t("notifications.unseen", { n: unseen })}`
      : t("notifications.title");

  // Closing is what marks them read, so every path out of the panel goes through here — outside
  // click, Escape, and clicking the bell again all mean the same thing.
  const close = useCallback(() => {
    setOpen(false);
    markAllSeen();
  }, [markAllSeen]);

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      bottom: window.innerHeight - rect.top + 6,
      right: Math.max(8, window.innerWidth - rect.right),
      maxHeight: Math.max(200, rect.top - 24),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => (open ? close() : setOpen(true))}
        className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-black/[0.05] dark:hover:bg-white/[0.08] ${
          open ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
        }`}
      >
        <Bell size={13} />
        {/* Just a dot: the count is in the tooltip and the panel header. A number this small in a
            24px button is unreadable, and the question the bell answers is yes/no. */}
        {unseen > 0 && (
          <span className="absolute right-0.5 top-0.5 h-[6px] w-[6px] rounded-full bg-[var(--cf-accent)] ring-2 ring-[var(--cf-surface)]" />
        )}
      </button>

      {/* Rendered conditionally rather than through `AnimatePresence`, unlike the other menus here.
          This is a stylistic difference, not a workaround: an earlier version of this comment
          blamed framer-motion 12.42 on React 19.2 for never unmounting exiting children, and that
          is wrong. `AnimatePresence` only drops an exiting child once the child's exit animation
          reports completion, and framer-motion drives that from a `requestAnimationFrame` loop
          (`motion-dom`'s frameloop captures rAF at module init). A document that is hidden or
          occluded has rAF suspended, so the animation never finishes, `safeToRemove` is never
          called, and the panel stays mounted at opacity 0 with `pointer-events: auto`. That is a
          property of any rAF-driven animation, not of this library version — it clears itself on
          the first frame after the window renders again, and a window that isn't rendering can't
          be clicked in the meantime. Measuring the DOM from a backgrounded tab is what makes it
          look permanent. Without an exit animation there is simply nothing to wait on; the cost is
          the 100ms close animation. */}
      {open &&
        pos &&
        createPortal(
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-label={t("notifications.title")}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.97 }}
            animate={
              reduceMotion
                ? { opacity: 1, transition: { duration: 0.1 } }
                : { opacity: 1, y: 0, scale: 1, transition: { duration: 0.14, ease: "easeOut" } }
            }
            style={{
              position: "fixed",
              bottom: pos.bottom,
              right: pos.right,
              width: PANEL_WIDTH,
              maxWidth: "calc(100vw - 16px)",
              maxHeight: pos.maxHeight,
              transformOrigin: "bottom right",
            }}
            className="z-[9999] flex flex-col overflow-hidden rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
              <Bell size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
              <span className="text-[12px] font-semibold text-[var(--cf-text)]">
                {t("notifications.title")}
              </span>
              {unseen > 0 && (
                <span className="rounded-full bg-[var(--cf-accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--cf-accent)]">
                  {t("notifications.unseen", { n: unseen })}
                </span>
              )}
              {items.length > 0 && (
                <button
                  type="button"
                  onClick={clear}
                  className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.06]"
                >
                  <Trash2 size={11} />
                  {t("notifications.clearAll")}
                </button>
              )}
            </div>

            {items.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-[12px] font-medium text-[var(--cf-text)]">
                  {t("notifications.empty")}
                </p>
                <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                  {t("notifications.emptyHint")}
                </p>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {items.map((item) => (
                  <Row key={item.id} item={item} locale={locale} onRemove={() => remove(item.id)} />
                ))}
              </div>
            )}
          </motion.div>,
          document.body,
        )}
    </>
  );
}

/**
 * One entry: where it happened, what it did, and when it finished.
 *
 * The origin is a chip rather than prose because it is the field the eye scans — with a mixed list
 * (a fetch, two generations, a review) the menu name is what separates them.
 */
function Row({
  item,
  locale,
  onRemove,
}: {
  item: AppNotification;
  locale: string;
  onRemove: () => void;
}) {
  const t = useT();
  const Icon = STATUS_ICON[item.status];
  const finished = new Date(item.finishedAt);

  return (
    <div
      className={`group relative flex items-start gap-2 border-b border-[var(--cf-border)] px-3 py-2 last:border-b-0 ${
        item.seen ? "" : "bg-[color-mix(in_oklab,var(--cf-accent)_6%,transparent)]"
      }`}
    >
      {/* Unread gets a rail rather than only a tint: the tint alone is nearly invisible on some
          themes, and this is the thing the dot promised. */}
      {!item.seen && (
        <span className="absolute inset-y-1.5 left-0 w-[2.5px] rounded-r-full bg-[var(--cf-accent)]" />
      )}
      <Icon size={13} className="mt-[2px] shrink-0" style={{ color: STATUS_COLOR[item.status] }} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--cf-text)_8%,transparent)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t(NOTIFICATION_SOURCE_LABEL[item.source])}
          </span>
          <span className="min-w-0 truncate text-[12px] font-medium text-[var(--cf-text)]">
            {t(item.titleKey, item.params)}
          </span>
        </div>
        {item.detail && (
          <p className="mt-0.5 truncate text-[11px] text-[var(--cf-text-muted)]" title={item.detail}>
            {item.detail}
          </p>
        )}
        {/* Date *and* time, both always: a list that mixes today and yesterday needs the date to be
            readable, and "14:32" alone is a lie once the app has been open overnight. */}
        <p className="mt-0.5 text-[10px] tabular-nums text-[var(--cf-text-muted)]">
          {finished.toLocaleDateString(locale, { day: "2-digit", month: "short" })}
          {" · "}
          {finished.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
        </p>
      </div>

      <button
        type="button"
        onClick={onRemove}
        title={t("notifications.remove")}
        aria-label={t("notifications.remove")}
        className="shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] opacity-0 transition-opacity hover:text-[var(--cf-danger)] focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X size={12} />
      </button>
    </div>
  );
}
