import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, ChevronDown, Copy, CornerUpLeft, GitBranch, Lock, Minus, Square, X } from "lucide-react";
import { useShortcutHint } from "../../lib/useShortcutHint";
import { isMac as platformIsMac, usePlatform } from "../../lib/platform";
import { getWindowStatus, subscribeWindowStatus, toggleMaximize } from "../../lib/windowControls";
import { broadcast } from "../../lib/windowBus";
import { WINDOW } from "../../lib/windowIdentity";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { RemoteActions } from "../git/RemoteActions";
import { useT } from "../../state/languageStore";
import { Tooltip } from "../common/Tooltip";
import type { Workspace } from "../../types/domain";

const win = getCurrentWindow();

/**
 * The branch list, behind a `lazy` boundary.
 *
 * The same component the shell opens from its status bar, and deliberately the same one: switching
 * branch, bringing a remote branch down, fetching and pulling one you are not standing on are four
 * sets of rules about when each is possible, and a second list would be a second place for them to
 * be *nearly* right. It imports only `repoStore`, `languageStore` and lucide — nothing of the shell
 * — so it costs this bundle nothing that a satellite does not already carry.
 *
 * `lazy` because most windows never open it: the whole point of `window.html` is that a satellite
 * starts small, and a dialog nobody has asked for should not be in the first paint.
 */
const BranchSwitcherModal = lazy(() =>
  import("./BranchSwitcherModal").then((m) => ({ default: m.BranchSwitcherModal })),
);

/**
 * A satellite's title bar: what this window holds, which workspace that is, and the way back.
 *
 * # Why it is not `TitleBar`
 *
 * The main bar carries the workspace switcher, the search box, the AI actions menu, back/forward
 * and the chat toggle — every one of which is a way to make the window show something else, which
 * is the one thing a satellite must not offer. Sharing the component and hiding two-thirds of it
 * would leave the shell's imports in this window's bundle, which is the cost `window.html` exists
 * to avoid.
 *
 * # The workspace chip is a control, for an app window
 *
 * This window holds its own workspace and does not follow the main one — see `SatelliteApp` — so
 * the chip that says which workspace it is on is also how you change it. That is the whole point of
 * a second window: keep Notes on one workspace while the shell goes somewhere else.
 *
 * A **repository** window gets the readout instead. Its workspace is a fact about the repository it
 * holds rather than a choice, so a picker there would be offering to put the window somewhere its
 * own contents are not.
 *
 * # Why a repository window carries fetch, pull and push
 *
 * Because the window is otherwise a dead end for them. Those three live in the main window's status
 * bar, which a satellite does not have, so a detached repository had four working tabs — graph,
 * changes, editor, pipelines — and no way to reach its remote: you went back to the main window,
 * selected that repository *there*, pressed fetch, and came back. That is precisely the round trip
 * detaching the window was meant to remove.
 *
 * They are not a shell affordance in the way the switcher is. Every one of them acts on the
 * repository this window already holds, through this window's own `repoStore` — nothing here can
 * make the window show something else, which is the line the rest of this bar is drawn along. See
 * `RemoteActions`, which is the same control the status bar renders.
 *
 * The branch comes with them, and it is a **control**, not the readout it started as. It began as a
 * readout because push and pull are about the current branch and three buttons with no subject
 * named anywhere on the window are three buttons you have to guess at — that reasoning still holds
 * and is why the branch is here at all. What it got wrong was the next step: having been told which
 * branch this window is on, the only way to be on another one was to go back to the main window,
 * select this repository *there*, switch, and come back. That is the same round trip the three
 * buttons beside it exist to remove, and the graph tab below does not close it either — it can
 * check a branch out, but it cannot bring a remote one down as a local one, and it cannot fetch or
 * pull a branch you are not standing on.
 *
 * So it opens `BranchSwitcherModal`, the shell's own list, which does all four. That does not make
 * it a shell affordance: like fetch, pull and push, everything in it acts on the repository this
 * window already holds, through this window's own `repoStore`. Nothing in it can make the window
 * show a *different* repository, which is the line the rest of this bar is drawn along.
 */

function WindowsControls() {
  const maximized = useSyncExternalStore(subscribeWindowStatus, () => getWindowStatus().maximized);
  return (
    // `data-window-control` for the same reason the main bar's carry it: these belong to the window
    // rather than the app, and an overlay laid across them must hand their presses back.
    <div className="flex items-center">
      <button
        aria-label="Minimize"
        data-window-control="minimize"
        onClick={() => win.minimize()}
        className="flex h-9 w-11 items-center justify-center text-[var(--cf-text)]/70 hover:bg-black/10"
      >
        <Minus size={14} />
      </button>
      <button
        aria-label={maximized ? "Restore" : "Maximize"}
        data-window-control="maximize"
        onClick={() => void toggleMaximize().catch((e) => console.error("toggleMaximize", e))}
        className="flex h-9 w-11 items-center justify-center text-[var(--cf-text)]/70 hover:bg-black/10"
      >
        {maximized ? <Copy size={11} className="-scale-x-100" /> : <Square size={12} />}
      </button>
      <button
        aria-label="Close"
        data-window-control="close"
        onClick={() => win.close()}
        className="flex h-9 w-11 items-center justify-center text-[var(--cf-text)]/70 hover:bg-red-500 hover:text-white"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function SatelliteTitleBar() {
  // Through the hook so the component re-renders if the answer ever arrives late, and compared
  // here rather than calling `isMac()` directly — same value, one source.
  const isMac = usePlatform() === "macos";
  const fullscreen = useSyncExternalStore(
    subscribeWindowStatus,
    () => platformIsMac() && getWindowStatus().fullscreen,
  );
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null);
  const projects = useWorkspaceStore((s) =>
    s.activeWorkspaceId ? s.projectsByWorkspace[s.activeWorkspaceId] : undefined,
  );
  const t = useT();

  const spec = WINDOW.satellite;
  /** What the bar says this window is. A repository's name is user data and is shown as-is; an
   *  app's is a translated label, looked up from the same key the rail uses. */
  const name =
    spec?.kind === "repo"
      ? (projects?.find((p) => p.id === spec.refId)?.name ?? t("windows.repoElsewhereShort"))
      : t(appTitleKey(spec?.refId ?? ""));

  /** Sends this window's contents back to the main window: bring that one forward, then close this.
   *  The order matters — closing first leaves the desk showing whatever was behind, which reads as
   *  the thing having been thrown away rather than put back. */
  const reattach = () => {
    broadcast({ kind: "focus-main" });
    void win.close();
  };

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 select-none items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-bg-elevated)] pr-1 text-[12px]"
    >
      {/* On macOS the traffic lights are AppKit's own, drawn over the webview — all this bar has to
          do is leave them room. In fullscreen they are gone, so the gap is not reserved. */}
      {isMac && <div aria-hidden className={fullscreen ? "w-1" : "w-[62px]"} />}
      {!isMac && <div aria-hidden className="w-2" />}

      {/* `min-w-0` so it actually gives when the bar runs out of room: as a flex item its
          default `min-width: auto` makes `truncate` a no-op, which was invisible while this
          bar held three things and is not now that a repository window also carries a branch
          and three buttons. */}
      <span className="min-w-0 truncate font-medium text-[var(--cf-text)]">{name}</span>

      {workspace &&
        (spec?.kind === "repo" ? (
          <span
            className="flex shrink-0 items-center gap-1.5 rounded border border-[var(--cf-border)] px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)]"
            title={t("windows.workspaceOfRepo")}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: workspace.color }} />
            {workspace.name}
          </span>
        ) : (
          <WorkspacePicker current={workspace} />
        ))}

      {spec?.kind === "repo" && <RepoRemote />}

      <div className="flex-1" data-tauri-drag-region />

      <Tooltip side="bottom" label={t("windows.reattach")} description={t("windows.reattachHint")}>
        <button
          onClick={reattach}
          aria-label={t("windows.reattach")}
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--cf-text-muted)] transition-colors hover:bg-black/[0.05] hover:text-[var(--cf-accent)] dark:hover:bg-white/[0.08]"
        >
          <CornerUpLeft size={13} />
        </button>
      </Tooltip>

      {!isMac && <WindowsControls />}
    </div>
  );
}

/**
 * The current branch and the three remote actions, for a repository window.
 *
 * Left of the drag region and right after the workspace chip, so the bar reads the way the main
 * window's status bar does: repository, then branch, then what you can do to its remote.
 *
 * Nothing at all until the branches have loaded — `setRepoPath` refreshes them on mount, and a
 * skeleton for a row of icons in a 36px bar would be more movement than the thing it stands in for.
 */
function RepoRemote() {
  const branch = useRepoStore((s) => s.branches.find((entry) => entry.is_head) ?? null);
  const detached = useRepoStore((s) => s.status?.is_detached ?? false);
  const name = useRepoStore((s) => s.status?.current_branch ?? null);
  /**
   * From `uiStore`, not local state, and the reason is the keyboard.
   *
   * `uiStore` is per webview, so this window's flag is its own — the shell's ⌘⇧B does not reach it
   * and cannot open this. What sharing the *field* buys is that `branch.switcher`'s existing `run`
   * works here untouched (see `useRemoteActionShortcuts`), so the chord this button's tooltip
   * promises is the chord that opens it, in both windows, with one binding to rebind.
   */
  const switcherOpen = useUiStore((s) => s.branchSwitcherOpen);
  const toggleSwitcher = useUiStore((s) => s.toggleBranchSwitcher);
  const closeSwitcher = useUiStore((s) => s.closeBranchSwitcher);
  const t = useT();
  const hint = useShortcutHint();

  if (!name && !detached) return null;

  return (
    <>
      <button
        type="button"
        onClick={toggleSwitcher}
        // The chord works in this window too — `useRemoteActionShortcuts` does not bind it, but the
        // hint is what tells the user the switcher is the same one they know from the shell.
        title={hint("branch.switcher", t("shortcuts.cmdBranchSwitcher"))}
        aria-haspopup="dialog"
        className="flex min-w-0 shrink items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
      >
        <GitBranch size={11} className="shrink-0" />
        <span className="min-w-0 truncate">{name ?? t("statusbar.detachedHead")}</span>
        {/* The explanation for a greyed-out push, in the same glyph the status bar uses. Without it
            the button is disabled with its reason only in a tooltip. */}
        {branch?.is_locked && (
          <span
            className="shrink-0 text-[var(--cf-warning)]"
            title={branch.locked_by_rule ? t("branch.lockedByRuleBadge") : t("branch.lockedBadge")}
          >
            <Lock size={10} />
          </span>
        )}
        <ChevronDown size={10} className="shrink-0 opacity-70" />
      </button>
      <RemoteActions />
      {/* No fallback: the dialog is the whole of what this renders, and a skeleton of it flashing
          over the window for the length of one chunk fetch is more movement than the wait. */}
      {switcherOpen && (
        <Suspense fallback={null}>
          <BranchSwitcherModal onClose={closeSwitcher} />
        </Suspense>
      )}
    </>
  );
}

/**
 * This window's workspace, and the way to change it.
 *
 * Built here rather than reusing the shell's switcher for the reason in the module note: the shell
 * must not be reachable from this bundle. It is a plain popover over `workspaces` — a satellite has
 * no drag-to-reorder, no rename, no colour picker, none of which belong in a window holding one
 * thing.
 *
 * `setActiveWorkspace` and not `followWorkspace`: this *is* a choice, so it is recorded under this
 * window's own key and the window opens here next time.
 */
function WorkspacePicker({ current }: { current: Workspace }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const [open, setOpen] = useState(false);
  const t = useT();

  // Close on anything that is not this control. `pointerdown` rather than `click` so a press that
  // starts on the window's drag region does not leave the menu hanging while the window moves.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const menuRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("windows.switchWorkspace")}
        className="flex items-center gap-1.5 rounded border border-[var(--cf-border)] px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-text)]"
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: current.color }} />
        {current.name}
        <ChevronDown size={11} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-[calc(100%+4px)] z-50 max-h-[320px] min-w-[180px] overflow-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] py-1 shadow-[var(--cf-shadow)]"
        >
          {workspaces.map((entry) => (
            <button
              key={entry.id}
              role="menuitemradio"
              aria-checked={entry.id === current.id}
              onClick={() => {
                setOpen(false);
                if (entry.id !== current.id) setActiveWorkspace(entry.id);
              }}
              className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] transition-colors hover:bg-[var(--cf-accent-soft)] ${
                entry.id === current.id ? "text-[var(--cf-accent)]" : "text-[var(--cf-text)]"
              }`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: entry.color }} />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {entry.id === current.id && <Check size={12} className="shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The rail's own label key for an app id. Kept beside the bar rather than imported from `AppRail`,
 *  which is shell and must not be reachable from a satellite's bundle. */
// One more list of the rail's apps, and the twelfth place a new one has to be registered. It is the
// easiest to miss because forgetting it breaks nothing visible *inside* the window: the view renders
// from `SatelliteApp`'s own map, so a detached chat drew the whole chat correctly under a title bar
// announcing that this version did not know what the window held. If you are adding an app, the
// symptom to look for is exactly that mismatch.
function appTitleKey(refId: string) {
  switch (refId) {
    case "api:requests":
      return "tabbar.api" as const;
    case "api:database":
      return "tabbar.databases" as const;
    case "agents":
      return "tabbar.agents" as const;
    case "stories":
      return "tabbar.stories" as const;
    case "remote":
      return "tabbar.remote" as const;
    case "notes":
      return "tabbar.notes" as const;
    case "diagrams":
      return "tabbar.diagrams" as const;
    case "vault":
      return "tabbar.vault" as const;
    case "chat":
      return "tabbar.chat" as const;
    default:
      return "windows.unknownApp" as const;
  }
}
