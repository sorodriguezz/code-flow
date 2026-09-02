import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, CornerUpLeft, Minus, Square, X } from "lucide-react";
import { isMac as platformIsMac, usePlatform } from "../../lib/platform";
import { getWindowStatus, subscribeWindowStatus, toggleMaximize } from "../../lib/windowControls";
import { broadcast } from "../../lib/windowBus";
import { WINDOW } from "../../lib/windowIdentity";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import { Tooltip } from "../common/Tooltip";

const win = getCurrentWindow();

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
 * # The workspace chip is a readout, not a control
 *
 * It says which workspace this window's contents belong to and cannot change it: the workspace
 * follows the main window, always. Showing it is what makes that rule visible rather than merely
 * true — the alternative is a window whose contents change and nothing on screen saying why.
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

      <span className="truncate font-medium text-[var(--cf-text)]">{name}</span>

      {workspace && (
        <span
          className="flex shrink-0 items-center gap-1.5 rounded border border-[var(--cf-border)] px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)]"
          title={t("windows.followsMain")}
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: workspace.color }} />
          {workspace.name}
        </span>
      )}

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

/** The rail's own label key for an app id. Kept beside the bar rather than imported from `AppRail`,
 *  which is shell and must not be reachable from a satellite's bundle. */
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
    default:
      return "windows.unknownApp" as const;
  }
}
