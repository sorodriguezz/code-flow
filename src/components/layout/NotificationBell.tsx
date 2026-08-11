import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Bell, CircleAlert, CircleCheck, Info, Trash2, Volume2, VolumeX, X } from "lucide-react";
import {
  followNotification,
  NOTIFICATION_SOURCE_LABEL,
  useNotificationStore,
  type AppNotification,
} from "../../state/notificationStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { playNotificationSound, previewNotificationSound } from "../../lib/notificationSound";
import { pushErrorToast } from "../../state/toastStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { riseDelay } from "../../lib/rise";

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

/** How long the arrival burst runs before the dot settles into its resting pulse. Long enough to
 * catch an eye that was elsewhere, short enough that it is over by the time you look. */
const BURST_MS = 2400;

/**
 * The unread dot, and the small performance it puts on when something lands.
 *
 * Two states, deliberately different in volume, because they answer different questions:
 *
 * - **Arrival** — the bell swings, the dot springs in past its own size, and two rings ripple out
 *   of it. This is the only moment the user is not looking, so it is the only moment worth being
 *   loud in.
 * - **Resting** — once the burst is over the dot keeps a slow breath and a soft halo, roughly one
 *   cycle every two seconds. Enough to be found on a glance across the window, calm enough to sit
 *   in a status bar for an hour without becoming something to resent. A ripple that never stopped
 *   would be wallpaper within a minute, and then the *next* arrival would say nothing at all.
 *
 * The rings are capped at 3× a 6px dot on purpose: the footer is 32px tall and this sits in its
 * top-right corner, so anything larger paints outside the bar and depends on no ancestor ever
 * clipping.
 */
function UnreadDot({ burst }: { burst: number }) {
  return (
    <span className="pointer-events-none absolute right-0.5 top-0.5 h-[6px] w-[6px]">
      {/* Ripples. Keyed by the burst so a second notification restarts them mid-flight rather than
          waiting politely for the first one to finish. */}
      {[0, 1].map((index) => (
        <motion.span
          key={`${burst}-${index}`}
          className="absolute inset-0 rounded-full bg-[var(--cf-accent)]"
          initial={{ scale: 1, opacity: 0.5 }}
          animate={{ scale: 3, opacity: 0 }}
          transition={{ duration: 1.05, delay: index * 0.4, ease: "easeOut" }}
        />
      ))}

      {/* The halo breathes for as long as there is anything unread. Opacity and scale only — a
          `box-shadow` in `color-mix()` is not something an animation can interpolate anyway.

          CSS rather than framer-motion, and that is the whole point: this loop and the one below
          run for as long as *anything* is unread, which is the resting state here. Driving them
          from JS meant a rAF loop that never quiesced, and scaling this blurred layer from the
          main thread re-rasterized the blur every frame. `cf-bell-halo`/`cf-bell-breath` in
          `index.css` are the same keyframes at the same 2.2s ease-in-out, composited. */}
      <span className="cf-bell-halo absolute -inset-[3px] rounded-full bg-[var(--cf-accent)] blur-[3px]" />

      {/* Two nested spans rather than one: the outer one breathes forever, the inner one springs in
          once per arrival. Keyframes that did both would have to re-derive the resting loop from
          wherever the spring left off. Which is also why only the outer one moved to CSS — the
          spring is finite, belongs to the arrival, and stays where it was. */}
      <span className="cf-bell-breath absolute inset-0">
        <motion.span
          key={burst}
          className="block h-full w-full rounded-full bg-[var(--cf-accent)] ring-2 ring-[var(--cf-surface)]"
          initial={{ scale: 0.2 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 700, damping: 14 }}
        />
      </span>
    </span>
  );
}

/**
 * The notification centre, hung off the end of the status bar.
 *
 * It answers one question — "did the thing I walked away from finish?" — and the panel is built
 * around the four parts of that answer: **where** it happened (the menu, so you know where to go
 * back to), **what** it did, **when** it finished, and **whose** workspace it was. Toasts can't do
 * this job: they expire, and the whole point is that nobody was looking.
 *
 * It spans every workspace rather than the active one, which is what makes the workspace name on
 * each row load-bearing and what the go button is crossing when it switches. The alternative — one
 * list per workspace — hides finished work behind the very act of looking somewhere else, which is
 * exactly what a notification is meant to survive.
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
  /* Every workspace's, with each row naming its own — this panel is the one place the app answers
     "did anything finish?", and an answer scoped to whichever workspace happens to be open is one
     the user has to ask again in every other workspace to trust. Following a row crosses back over
     on its own, so the stores holding one workspace at a time is a thing the button handles rather
     than a reason to hide the row. */
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((w) => [w.id, w.name])),
    [workspaces],
  );
  const remove = useNotificationStore((s) => s.remove);
  const clear = useNotificationStore((s) => s.clear);
  const markAllSeen = useNotificationStore((s) => s.markAllSeen);
  const soundEnabled = usePreferencesStore((s) => s.notificationSoundEnabled);
  const setSoundEnabled = usePreferencesStore((s) => s.setNotificationSoundEnabled);

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

  /**
   * The arrival: a counter bumped whenever the unread count *grows*, used as the animation key so a
   * second notification restarts the ripples instead of queueing behind the first, and the one
   * place the sound is played.
   *
   * It rides the count rather than the item list because that is the thing the dot is about — a
   * notification arriving already-seen (there is no such thing today, but nothing stops one) is not
   * news, and a removal that lowers the count is not either. Sound and animation hanging off the
   * same signal is what keeps them from ever disagreeing about what an arrival is.
   */
  const [burst, setBurst] = useState(0);
  const [bursting, setBursting] = useState(false);
  const previousUnseen = useRef(unseen);
  useEffect(() => {
    const grew = unseen > previousUnseen.current;
    previousUnseen.current = unseen;
    // Re-runs when the preference changes too, which is harmless: the count did not grow, so this
    // returns before anything sounds. Toggling the setting is not an arrival.
    if (!grew) return;
    // Above the reduced-motion gate, deliberately. Someone who asked the system for less movement
    // did not ask for less sound — the two settings mean different things, and folding them
    // together would silently take the feature away from the users most likely to want it.
    if (soundEnabled) playNotificationSound();
    if (reduceMotion) return;
    setBurst((n) => n + 1);
    setBursting(true);
    const timer = setTimeout(() => setBursting(false), BURST_MS);
    return () => clearTimeout(timer);
  }, [unseen, reduceMotion, soundEnabled]);

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
        data-tour="notification-bell"
        title={label}
        onClick={() => (open ? close() : setOpen(true))}
        className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-black/[0.05] dark:hover:bg-white/[0.08] ${
          open ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
        }`}
      >
        {/* The bell swings from its crown, the way one actually rung would. Keyed by the burst so
            the swing restarts on each arrival; between bursts it is an ordinary static icon. */}
        <motion.span
          key={burst}
          className="flex items-center justify-center"
          style={{ transformOrigin: "50% 15%" }}
          animate={bursting ? { rotate: [0, -16, 12, -8, 5, -2, 0] } : { rotate: 0 }}
          transition={bursting ? { duration: 0.8, ease: "easeInOut" } : { duration: 0 }}
        >
          <Bell size={13} />
        </motion.span>
        {/* Just a dot: the count is in the tooltip and the panel header. A number this small in a
            24px button is unreadable, and the question the bell answers is yes/no. */}
        {unseen > 0 &&
          (reduceMotion ? (
            <span className="absolute right-0.5 top-0.5 h-[6px] w-[6px] rounded-full bg-[var(--cf-accent)] ring-2 ring-[var(--cf-surface)]" />
          ) : (
            <UnreadDot burst={burst} />
          ))}
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
              <div className="ml-auto flex items-center gap-0.5">
                {/* Outside the `items.length` guard the clear button sits behind: an empty panel is
                    exactly where someone goes to turn the sound on *before* the next run finishes,
                    and a control that appears only once there is something to hear is a control
                    they can only find too late. */}
                <button
                  type="button"
                  aria-pressed={soundEnabled}
                  onClick={() => {
                    const next = !soundEnabled;
                    void setSoundEnabled(next);
                    // Turning it on plays it. Partly so the choice is informed — nobody should have
                    // to wait for a random background job to learn what they just agreed to — and
                    // partly because this click is a user gesture, which is what an `AudioContext`
                    // needs to be born unsuspended. See `lib/notificationSound`.
                    if (next) previewNotificationSound();
                  }}
                  title={soundEnabled ? t("notifications.soundDisable") : t("notifications.soundEnable")}
                  aria-label={soundEnabled ? t("notifications.soundDisable") : t("notifications.soundEnable")}
                  className={`flex items-center rounded-md p-1 hover:bg-black/[0.05] dark:hover:bg-white/[0.06] ${
                    soundEnabled ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
                  }`}
                >
                  {soundEnabled ? <Volume2 size={12} /> : <VolumeX size={12} />}
                </button>
                {items.length > 0 && (
                  <button
                    type="button"
                    onClick={clear}
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.06]"
                  >
                    <Trash2 size={11} />
                    {t("notifications.clearAll")}
                  </button>
                )}
              </div>
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
                {items.map((item, at) => (
                  <Row
                    key={item.id}
                    item={item}
                    at={at}
                    locale={locale}
                    workspaceName={item.workspaceId ? (workspaceNames.get(item.workspaceId) ?? null) : null}
                    foreign={item.workspaceId !== null && item.workspaceId !== activeWorkspaceId}
                    onRemove={() => remove(item.id)}
                    onFollowed={() => setOpen(false)}
                  />
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
 * One entry: where it happened, what it did, when it finished, and which workspace it belonged to.
 *
 * The origin is a chip rather than prose because it is the field the eye scans — with a mixed list
 * (a fetch, two generations, a review) the menu name is what separates them.
 */
function Row({
  item,
  at,
  locale,
  workspaceName,
  foreign,
  onRemove,
  onFollowed,
}: {
  item: AppNotification;
  /** Place in the list it arrives with, which is all the entry animation needs to stagger. */
  at: number;
  locale: string;
  /** `null` when the notification predates any workspace, or when the one it names has since been
   *  deleted — the two cases the footer line has nothing to say about. */
  workspaceName: string | null;
  /** In some *other* workspace than the one on screen. Only changes what the button's tooltip
   *  promises: the jump itself works the same either way. */
  foreign: boolean;
  onRemove: () => void;
  /** Closes the panel. Following a notification means going somewhere, and a panel left open over
   *  the destination is one the user has to dismiss before they can look at what they came for. */
  onFollowed: () => void;
}) {
  const t = useT();
  const Icon = STATUS_ICON[item.status];
  const finished = new Date(item.finishedAt);
  /* A deleted workspace is nowhere to go, so the button goes rather than fails on click. The
     entry stays: it is still a true record of something that finished. */
  const followable = item.target && !(foreign && workspaceName === null);
  const goLabel =
    foreign && workspaceName
      ? t("notifications.goOtherWorkspace", { name: workspaceName })
      : t("notifications.go");

  return (
    <div
      style={riseDelay(at)}
      className={`cf-rise group relative flex items-start gap-2 border-b border-[var(--cf-border)] px-3 py-2 last:border-b-0 ${
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
            readable, and "14:32" alone is a lie once the app has been open overnight. The workspace
            closes the line because the list spans all of them — without it two identical "Fetch
            finished" rows are indistinguishable, and the button under them goes to different
            places. Truncated rather than wrapped: a long workspace name should cost the name, not
            the timestamp, which is why the name is the flexible half of the row. */}
        <p className="mt-0.5 flex items-baseline gap-1 text-[10px] text-[var(--cf-text-muted)]">
          <span className="shrink-0 tabular-nums">
            {finished.toLocaleDateString(locale, { day: "2-digit", month: "short" })}
            {" · "}
            {finished.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
          </span>
          {workspaceName && (
            <>
              <span className="shrink-0">—</span>
              <span className="min-w-0 truncate font-medium" title={workspaceName}>
                {workspaceName}
              </span>
            </>
          )}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {followable && (
          <button
            type="button"
            onClick={() => {
              onFollowed();
              void followNotification(item).catch((e: unknown) => pushErrorToast(String(e)));
            }}
            title={goLabel}
            aria-label={goLabel}
            className="rounded p-0.5 text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-accent)]"
          >
            <ArrowRight size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          title={t("notifications.remove")}
          aria-label={t("notifications.remove")}
          className="rounded p-0.5 text-[var(--cf-text-muted)] opacity-0 transition-opacity hover:text-[var(--cf-danger)] focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
