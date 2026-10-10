import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotionConfig } from "framer-motion";
import { Briefcase, FolderGit2 } from "lucide-react";
import { monogram, monogramStyle } from "../../lib/monogram";
import { openable } from "../../lib/shortcuts";
import { shortcutBlockedByDialog } from "../../lib/useFocusTrap";
import { DEFAULT_WORKSPACE_COLOR } from "../../lib/workspaceColors";
import { useDataDirsStore } from "../../state/dataDirsStore";
import { chordHeld, LOCK_ARROWS, lockAxisFor, useSwitcherLockStore, type LockAxis } from "../../state/switcherLockStore";
import { useT } from "../../state/languageStore";
import { useTourStore } from "../../state/tourStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

type LockKind = LockAxis;

interface LockItem {
  id: string;
  name: string;
  color: string;
  /** How many repositories a workspace holds, when they have been read. */
  repos?: number;
}

interface Lock {
  kind: LockKind;
  items: LockItem[];
}

/** Degrees between two names on the drum, and the drum's radius in px — together, one row's height. */
const STEP = 26;
const RADIUS = 96;
/** Rows drawn either side of the window. */
const SPAN = 3;
/** The lock opening before the switch lands — long enough to be seen, short enough to stay out of
 *  the way. */
const UNLOCK_MS = 170;

const wrap = (index: number, length: number) => ((index % length) + length) % length;

/**
 * How visible a row is, `offset` rows from the window: it fades with its angle — and, on a drum
 * holding fewer names than it draws rows, out before the row where a name would come round a second
 * time. Three repositories are three rows, not five with two of them twice; an even count leaves one
 * name over, and it goes below, where ↓ rolls.
 */
function rowOpacity(offset: number, count: number): number {
  const reach = (offset < 0 ? Math.floor((count - 1) / 2) : Math.ceil((count - 1) / 2)) + 1;
  return Math.max(0, Math.min(1 - (Math.abs(offset) * STEP) / 80, reach - Math.abs(offset)));
}

/**
 * Which lock a keystroke opens: each axis has its own chord, recorded in Settings
 * (`switcherLockStore`; Ctrl+Shift+Alt for both by default, ⌃⇧⌥ on macOS — Control literally
 * there, which is why this is not a registry shortcut: `Mod` is ⌘) — ←/→ with the workspaces'
 * chord, ↑/↓ with the repositories'. With any other modifier as well, or only the other axis's
 * chord, the keystroke is somebody else's. Read at the keystroke, so a new chord applies at once.
 */
const lockFor = (e: KeyboardEvent, repos: boolean): LockKind | null =>
  lockAxisFor(useSwitcherLockStore.getState().chords, e, repos);

/** Whether the open lock's own chord is still held — letting go of any of its keys is the switch. */
const held = (kind: LockKind, e: KeyboardEvent) => {
  const chord = useSwitcherLockStore.getState().chords[kind];
  return chord !== null && chordHeld(chord, e);
};

/** The workspaces as the switcher lists them, and where the current one sits. */
function workspaceLock(): { items: LockItem[]; at: number } {
  const { workspaces, activeWorkspaceId, projectsByWorkspace } = useWorkspaceStore.getState();
  const items = workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    color: ws.color || DEFAULT_WORKSPACE_COLOR,
    repos: projectsByWorkspace[ws.id]?.length,
  }));
  return { items, at: Math.max(0, items.findIndex((item) => item.id === activeWorkspaceId)) };
}

/** This workspace's repositories that can be opened here — the same stops ⌘⇧PageDown makes. */
function repoLock(): { items: LockItem[]; at: number } {
  const { activeWorkspaceId, projectsByWorkspace, activeProjectId } = useWorkspaceStore.getState();
  const projects = (activeWorkspaceId ? (projectsByWorkspace[activeWorkspaceId] ?? []) : []).filter(openable);
  const items = projects.map((project) => ({ id: project.id, name: project.name, color: project.color }));
  return { items, at: Math.max(0, items.findIndex((item) => item.id === activeProjectId)) };
}

/**
 * The combination lock: a drum of workspaces — or of this workspace's repositories — rolled with
 * the arrows while a chord is held, and switched to only when the chord is let go.
 *
 * **Out of the way on purpose** (the user's ask, 2026-10-01): in no menu or tour, and not in the
 * shortcut registry — its chord is not one `Mod` can spell, and it acts on *keyup*, which no
 * registry command does. Its one appearance is the row in Settings → Shortcuts where its chord is
 * changed (asked for 2026-10-05).
 *
 * - The workspaces' chord with ←/→, the repositories' chord with ↑/↓ — two rows in Settings, both
 *   Ctrl+Shift+Alt (⌃⇧⌥ on macOS) until changed. Once a lock is up, it is its own chord that keeps
 *   it up.
 * - The first arrow opens it on what is current; the next ones roll it, round and round like a
 *   lock's wheel — → and ↓ forward, ← and ↑ back, on the same upright drum. Letting go of the chord
 *   switches — never before. Escape, or the window losing focus, leaves everything as it was.
 * - Listened for in the capture phase, so it works over the editor, a terminal and a text field
 *   alike — which means those never see the chord's arrows in this window. Hence three modifiers by
 *   default: the old Ctrl+Shift was select-by-word on Windows and Linux.
 *
 * One per window, and each window switches its own workspace — an island included (`repos={false}`
 * there: an app window has no repository to show). A repository window mounts none: it holds one
 * repository and must not be turned into another.
 */
export function SwitcherLock({ repos = true }: { repos?: boolean }) {
  const t = useT();
  const reduceMotion = useReducedMotionConfig();
  useEffect(() => {
    void useSwitcherLockStore.getState().init();
  }, []);
  const [lock, setLock] = useState<Lock | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  /** Where the drum is going (a whole number of rows, unbounded — wrapped when read) and where it is. */
  const target = useRef(0);
  const [pos, setPos] = useState(0);
  const posRef = useRef(0);
  const frame = useRef(0);
  const lockRef = useRef<Lock | null>(null);
  lockRef.current = lock;
  /** A switch decided and still landing — the lock opening. Another chord then waits for it. */
  const landing = useRef(false);

  const animate = useCallback(() => {
    cancelAnimationFrame(frame.current);
    if (reduceMotion) {
      posRef.current = target.current;
      setPos(target.current);
      return;
    }
    const step = () => {
      const distance = target.current - posRef.current;
      posRef.current = Math.abs(distance) < 0.003 ? target.current : posRef.current + distance * 0.24;
      setPos(posRef.current);
      if (posRef.current !== target.current) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [reduceMotion]);

  const close = useCallback(() => {
    cancelAnimationFrame(frame.current);
    lockRef.current = null;
    setLock(null);
    setUnlocking(false);
  }, []);

  useEffect(() => {
    const blocked = () =>
      useSwitcherLockStore.getState().recording !== null ||
      useTourStore.getState().active ||
      (useDataDirsStore.getState().status !== null && !useDataDirsStore.getState().status?.ok) ||
      shortcutBlockedByDialog("workspace.switcher");

    const commit = () => {
      const current = lockRef.current;
      if (!current) return;
      const pick = current.items[wrap(target.current, current.items.length)];
      lockRef.current = null;
      landing.current = true;
      const apply = () => {
        const store = useWorkspaceStore.getState();
        if (current.kind === "workspace" && pick.id !== store.activeWorkspaceId) store.setActiveWorkspace(pick.id);
        if (current.kind === "repo" && pick.id !== store.activeProjectId) store.setActiveProject(pick.id);
        landing.current = false;
        close();
      };
      if (reduceMotion) {
        apply();
        return;
      }
      setUnlocking(true);
      window.setTimeout(apply, UNLOCK_MS);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const current = lockRef.current;
      if (current) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close();
          return;
        }
        if (e.key.startsWith("Arrow") && held(current.kind, e)) {
          // Every arrow is the lock's while it is up: the other axis does nothing, rather than
          // reaching the editor or the field underneath.
          e.preventDefault();
          e.stopPropagation();
          const [back, forward] = LOCK_ARROWS[current.kind];
          if (e.key === back || e.key === forward) {
            target.current += e.key === back ? -1 : 1;
            animate();
          }
        }
        return;
      }
      if (e.repeat || landing.current) return;
      const kind = lockFor(e, repos);
      if (!kind || blocked()) return;
      const { items, at } = kind === "workspace" ? workspaceLock() : repoLock();
      // Nothing to switch to: the keys go on to whatever else wants them.
      if (items.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      target.current = at;
      posRef.current = at;
      setPos(at);
      setUnlocking(false);
      const next = { kind, items };
      lockRef.current = next;
      setLock(next);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const current = lockRef.current;
      if (current && !held(current.kind, e)) commit();
    };

    // The window losing focus mid-roll — another app, a dialog of the system's — is not a choice.
    const onBlur = () => {
      if (lockRef.current) close();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      cancelAnimationFrame(frame.current);
    };
  }, [repos, reduceMotion, animate, close]);

  if (!lock) return null;

  const base = Math.round(pos);
  const picked = lock.items[wrap(target.current, lock.items.length)];
  const label = t(lock.kind === "workspace" ? "lock.workspaces" : "lock.repositories");
  const KindIcon = lock.kind === "workspace" ? Briefcase : FolderGit2;

  return (
    <div
      role="dialog"
      aria-label={label}
      className="cf-fade-in pointer-events-none fixed inset-0 z-[90] flex items-center justify-center bg-black/25"
    >
      {/* Read out as it rolls: the drum itself is a picture. */}
      <span className="sr-only" aria-live="polite">
        {picked.name}
      </span>
      <div className="relative" aria-hidden>
        {/* The shackle, which lifts when the chord is let go. */}
        <div
          className="absolute -top-9 left-1/2 h-12 w-24 rounded-t-full border-[7px] border-b-0 border-[var(--cf-border-strong)]"
          style={{
            marginLeft: -48,
            transformOrigin: "100% 100%",
            transform: unlocking ? "translateY(-9px) rotate(-16deg)" : undefined,
            transition: reduceMotion ? undefined : "transform 160ms cubic-bezier(.2,.9,.3,1.3)",
          }}
        />
        <div className="relative h-[236px] w-[320px] rounded-2xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3.5 shadow-[var(--cf-shadow)]">
          <span className="absolute -top-3 left-1/2 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] text-[var(--cf-text-muted)]">
            <KindIcon size={12} />
          </span>
          <div className="relative h-full overflow-hidden rounded-xl bg-[var(--cf-surface)]" style={{ perspective: 560 }}>
            {/* Pushed back by its own radius, so the row facing you sits in the drum's plane at its
                own size — at the radius in front it came out a fifth wider and lost its edges. */}
            <div className="absolute inset-0" style={{ transformStyle: "preserve-3d", transform: `translateZ(-${RADIUS}px)` }}>
              {Array.from({ length: SPAN * 2 + 1 }, (_, slot) => {
                const k = slot - SPAN;
                const index = wrap(base + k, lock.items.length);
                const item = lock.items[index];
                const angle = (base + k - pos) * STEP;
                const centred = index === wrap(target.current, lock.items.length);
                return (
                  <div
                    key={slot}
                    className="absolute inset-x-0 top-1/2 -mt-[22px] flex h-11 items-center gap-2.5 px-4 text-[14px]"
                    style={{
                      transform: `rotateX(${-angle}deg) translateZ(${RADIUS}px)`,
                      opacity: rowOpacity(base + k - pos, lock.items.length),
                      backfaceVisibility: "hidden",
                    }}
                  >
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[11px] font-semibold"
                      style={monogramStyle(item.color)}
                    >
                      {lock.kind === "workspace" ? <Briefcase size={13} /> : monogram(item.name)}
                    </span>
                    <span className={`min-w-0 flex-1 truncate ${centred ? "font-semibold text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}>
                      {item.name}
                    </span>
                    {item.repos !== undefined && (
                      <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--cf-text-faint)]">
                        {t("lock.repoCount", { n: item.repos })}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {/* The lock's window: what is in it when the chord is let go is where you go. */}
            <div
              className="absolute inset-x-2 top-1/2 h-12 -translate-y-1/2 rounded-[10px] border-[1.5px] border-[var(--cf-accent)]"
              style={{
                background: unlocking ? "color-mix(in oklab, var(--cf-accent) 16%, transparent)" : undefined,
                transition: reduceMotion ? undefined : "background 140ms ease-out",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
