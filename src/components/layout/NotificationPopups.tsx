import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import {
  followNotification,
  NOTIFICATION_SOURCE_LABEL,
  useNotificationStore,
  type AppNotification,
} from "../../state/notificationStore";
import { useT } from "../../state/languageStore";

/**
 * The small card that slides in when something finishes, and takes itself away again.
 *
 * # Why this watches the store instead of being pushed to
 *
 * There are already twenty-odd `notify(...)` call sites, and the app also has a separate toast
 * channel that several of them use as well. Adding a third thing for each of them to remember
 * would guarantee that some completions get a popup and some do not, for no reason a user could
 * work out — and would have missed the newest source entirely, since notifications raised by a
 * paired phone come from an event handler that no call site knows about.
 *
 * Subscribing to the store instead means every notification gets this, including ones added later,
 * and no existing code changes. The entry stays in the bell's history either way: this is a second
 * *view* of the same rows, not a second store.
 *
 * # Why it is not the existing toast
 *
 * A toast is for something that just failed in front of you and needs acknowledging. This is for
 * work that finished while you were looking elsewhere — a different tone, a different lifetime, and
 * it carries the source and the target so it can be followed. Merging them would mean one of the
 * two behaving wrongly.
 */

const STATUS_ICON = {
  success: CircleCheck,
  error: CircleAlert,
  info: Info,
} as const;

const STATUS_COLOR = {
  success: "var(--cf-success)",
  error: "var(--cf-danger)",
  info: "var(--cf-accent)",
} as const;

/**
 * How long a card stays.
 *
 * Long enough to read a title and a detail without hurrying — measured on the longest strings this
 * can show, which are the `remote.action.*` ones. An error stays roughly twice as long: it is the
 * one kind you may want to act on, and re-opening the bell to re-read something that vanished is
 * the failure this whole component exists to avoid.
 */
const DWELL_MS = 4200;
const DWELL_ERROR_MS = 8000;

/**
 * How many cards can be on screen at once.
 *
 * A burst — a chain finishing five steps, or a phone doing several things in a row — must not
 * become a column that covers the window it is reporting on. Beyond this the oldest is retired
 * early; it is still in the bell.
 */
const MAX_VISIBLE = 3;

function Popup({ item, onDismiss }: { item: AppNotification; onDismiss: () => void }) {
  const t = useT();
  const reduced = useReducedMotion();
  const Icon = STATUS_ICON[item.status];
  // Held so hovering keeps the card while a pointer is over it — reading something and having it
  // leave mid-sentence is worse than it never appearing.
  const [held, setHeld] = useState(false);

  /**
   * The dismiss, reached through a ref so the dwell timer does not depend on a closure's identity.
   *
   * The parent rebuilds `onDismiss` on every one of its own renders, and it renders whenever any
   * notification arrives — or whenever *another card dismisses itself* and rewrites the visible
   * list. With `onDismiss` in the dependency array below, each of those cleared and re-armed the
   * timeout of every card on screen, so a burst kept pushing the whole stack's deadline forward: a
   * chain finishing ten steps left three cards covering the window far longer than `DWELL_MS`,
   * which is the opposite of what `MAX_VISIBLE` is there to guarantee.
   */
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    if (held) return;
    const id = setTimeout(() => dismiss.current(), item.status === "error" ? DWELL_ERROR_MS : DWELL_MS);
    return () => clearTimeout(id);
  }, [held, item.status]);

  return (
    <motion.div
      layout
      initial={reduced ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.96 }}
      animate={reduced ? { opacity: 1 } : { opacity: 1, x: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      className="pointer-events-auto w-[300px] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
    >
      <button
        type="button"
        onClick={() => {
          // Following closes the card: the thing it was pointing at is now on screen, so leaving a
          // duplicate of the pointer floating over it is noise.
          followNotification(item);
          onDismiss();
        }}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-[var(--cf-accent)]/6"
      >
        <Icon size={14} className="mt-0.5 shrink-0" style={{ color: STATUS_COLOR[item.status] }} />
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium leading-snug text-[var(--cf-text)]">
            {t(item.titleKey, item.params)}
          </span>
          {item.detail && (
            <span className="mt-0.5 block truncate text-[11px] text-[var(--cf-text-muted)]">
              {item.detail}
            </span>
          )}
          <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t(NOTIFICATION_SOURCE_LABEL[item.source])}
          </span>
        </span>
      </button>
    </motion.div>
  );
}

export function NotificationPopups() {
  const items = useNotificationStore((s) => s.items);
  const [visible, setVisible] = useState<AppNotification[]>([]);
  /**
   * The newest id this component has already shown.
   *
   * Initialised on the first render rather than to `null`, so that opening a window onto a store
   * that already has history does not fire twenty cards at once. Only what arrives *after* mount
   * is new.
   */
  const seenUpTo = useRef<string | null>(null);
  const initialised = useRef(false);

  useEffect(() => {
    if (!initialised.current) {
      initialised.current = true;
      seenUpTo.current = items[0]?.id ?? null;
      return;
    }
    // `items` is newest-first, so everything ahead of the last id we showed is new. An id that is
    // no longer present (the entry was removed, or fell off the 100-item cap) means everything on
    // screen is new — taking the whole list would be wrong, so it is clamped to the cap.
    const index = items.findIndex((item) => item.id === seenUpTo.current);
    const fresh = index === -1 ? items.slice(0, MAX_VISIBLE) : items.slice(0, index);
    if (fresh.length === 0) return;
    seenUpTo.current = items[0]?.id ?? null;
    // Oldest of the batch first, so a burst reads top-to-bottom in the order it happened.
    setVisible((current) => [...current, ...fresh.slice().reverse()].slice(-MAX_VISIBLE));
  }, [items]);

  if (visible.length === 0) return null;

  return (
    // Below the toast container's `z-50` and offset under it: when both fire at once they stack
    // rather than overlap, and the toast — which is the more urgent of the two — stays on top.
    <div className="pointer-events-none fixed bottom-10 right-3 z-40 flex flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {visible.map((item) => (
          <Popup
            key={item.id}
            item={item}
            onDismiss={() => setVisible((current) => current.filter((entry) => entry.id !== item.id))}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
