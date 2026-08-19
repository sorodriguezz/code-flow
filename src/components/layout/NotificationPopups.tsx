import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import {
  followNotification,
  NOTIFICATION_SOURCE_LABEL,
  useNotificationStore,
  type AppNotification,
} from "../../state/notificationStore";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";

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

function Popup({
  item,
  workspace,
  foreign,
  onDismiss,
}: {
  item: AppNotification;
  /** The workspace the click will land in, by name and colour — resolved by the parent's
   *  [`homeOf`], not read off the stamp, so the card names where it is actually going. `null` when
   *  there is no such workspace to name, and also when the one it resolves to has since been
   *  deleted — the card has nothing truthful to draw in either case, exactly as the bell's row
   *  does not. */
  workspace: { name: string; color: string } | null;
  /** Finished somewhere other than the workspace on screen. This is the whole reason the card
   *  carries the attribution at all: without it, work that landed in another workspace is drawn
   *  identically to work that landed here, and the click moves the window with no warning. */
  foreign: boolean;
  onDismiss: () => void;
}) {
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

  /**
   * Whether the card is still offering to take you there — the bell's guard, applied here too.
   *
   * `enterWorkspace` throws `notifications.workspaceGone` when the destination workspace has been
   * deleted since the run finished, and its comment calls that path unreachable because the bell
   * hides its go button. It counted one of the two ways in: this card followed unconditionally, so
   * a deleted workspace became a rejected promise nobody was holding while the card slid away as
   * though the jump had worked — the failure invisible, and the entry already gone from the screen
   * that reported it. The row stays in the bell either way; it is still a true record.
   *
   * Because the parent resolves the destination the same way `enterWorkspace` will, this is the
   * exact negation of that throw's condition rather than an approximation of it: `foreign` is its
   * `crossing`, and a `null` workspace is its "not in the list".
   */
  const followable = Boolean(item.target) && !(foreign && workspace === null);
  /* Foreign work says so before the click, because following it moves the whole window — and a card
     that cannot be followed says why, rather than looking like a button that does nothing. */
  const goLabel = followable
    ? foreign && workspace
      ? t("notifications.goOtherWorkspace", { name: workspace.name })
      : undefined
    : item.target
      ? t("notifications.workspaceGone")
      : undefined;

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
        title={goLabel}
        onClick={() => {
          // Following closes the card: the thing it was pointing at is now on screen, so leaving a
          // duplicate of the pointer floating over it is noise.
          //
          // Awaited through `void … .catch(...)` rather than fired and forgotten: the jump crosses
          // workspaces and loads the destination's stores, so it can fail long after this handler
          // has returned, and the only place left to say so is a toast.
          if (followable) void followNotification(item).catch((e: unknown) => pushErrorToast(String(e)));
          onDismiss();
        }}
        // A card with nowhere to go is still worth being able to get rid of, so the click stays and
        // only the jump is dropped — but the accent hover goes with it, since a hover state is a
        // promise to take you somewhere and this one could not keep it.
        className={`flex w-full items-start gap-2 px-3 py-2.5 text-left ${
          followable ? "hover:bg-[var(--cf-accent)]/6" : ""
        }`}
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
          {/* Where it came from, and — since a run outlives the screen it was started from — where
              it happened. The workspace closes the line rather than opening it because the source
              is the field the eye scans; the dot is the workspace's own identity colour, the same
              one the switcher, the sidebar and the status bar's live rows draw it with, so the two
              halves of "a wiki page finished, in Cliente B" are recognised without being read.

              Nothing is drawn for a notification stamped with no workspace, matching the bell's
              row: unlike a *live* row in the status bar, a card that is gone in four seconds has
              nothing to disambiguate itself against, and an italic "No workspace" on a phone-driven
              run would be the longest thing on the line. */}
          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--cf-text-muted)]">
            <span className="shrink-0 uppercase tracking-wide">
              {t(NOTIFICATION_SOURCE_LABEL[item.source])}
            </span>
            {workspace && (
              <>
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: workspace.color }}
                />
                <span className="min-w-0 truncate" title={workspace.name}>
                  {workspace.name}
                </span>
                {foreign && (
                  // The one thing the name alone cannot say: this is not where you are standing.
                  <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--cf-text)_10%,transparent)] px-1 text-[9px] font-semibold uppercase tracking-wide">
                    {t("agents.liveElsewhere")}
                  </span>
                )}
              </>
            )}
          </span>
        </span>
      </button>
    </motion.div>
  );
}

export function NotificationPopups() {
  const items = useNotificationStore((s) => s.items);
  /* Resolved here rather than in the card so the list is read once per render instead of once per
     card, and — more to the point — so a workspace renamed or deleted while three cards are on
     screen updates all of them: they are views of the same selectors, not of a name each one copied
     when it arrived. */
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  /* Every workspace's project list this session has loaded — the map that turns a target's
     `projectId` into the workspace it belongs to. Read for the same reason `enterWorkspace` reads
     it: see [`homeOf`]. */
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);

  /**
   * Where a notification lives, resolved exactly the way following it will resolve it.
   *
   * The stamp alone is not that answer. `enterWorkspace` takes `workspaceOfProject(target.projectId)
   * ?? stamp` — a project knows which workspace it is in, and that outranks a stamp recorded from
   * wherever the user happened to be standing. A card that resolved only the stamp would get both
   * of its jobs wrong in the case the stamp is the stale half: it would label a jump "here" that is
   * about to move the window to the project's workspace, and — worse, because this card acts and
   * then vanishes — its `followable` guard would refuse a jump that `enterWorkspace` would have
   * made, on the grounds that a workspace nothing is going to navigate to has been deleted.
   *
   * Resolving it here makes the name on the card a promise the click keeps, and makes the guard
   * below the exact negation of the throw it exists to avoid. `AgentActivity`'s `homeOf` does the
   * same for the live rows; the bell's row resolves the stamp only, which is survivable there
   * because the row stays on screen and the arrow is the only thing riding on it.
   */
  const homeOf = useMemo(() => {
    const byId = new Map(workspaces.map((w) => [w.id, w] as const));
    const workspaceOfProject = (projectId: string): string | null => {
      for (const [workspaceId, projects] of Object.entries(projectsByWorkspace)) {
        if (projects.some((p) => p.id === projectId)) return workspaceId;
      }
      return null;
    };
    return (item: AppNotification) => {
      const projectId = item.target?.projectId;
      const home = (projectId ? workspaceOfProject(projectId) : null) ?? item.workspaceId;
      return {
        // `null` both for a notification stamped with no workspace and for one naming a workspace
        // deleted since — the two cases the card has nothing truthful to draw, and the two the
        // guard below treats alike.
        workspace: home ? (byId.get(home) ?? null) : null,
        foreign: home !== null && home !== activeWorkspaceId,
      };
    };
  }, [workspaces, projectsByWorkspace, activeWorkspaceId]);
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
        {visible.map((item) => {
          const { workspace, foreign } = homeOf(item);
          return (
            <Popup
              key={item.id}
              item={item}
              workspace={workspace}
              foreign={foreign}
              onDismiss={() =>
                setVisible((current) => current.filter((entry) => entry.id !== item.id))
              }
            />
          );
        })}
      </AnimatePresence>
    </div>
  );
}
