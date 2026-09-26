import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { isMac as platformIsMac, usePlatform } from "../../lib/platform";
import { useLayoutStore } from "../../state/layoutStore";
import { getWindowStatus, subscribeWindowStatus, toggleMaximize } from "../../lib/windowControls";
import { ChromeScope } from "./TabBar";

const win = getCurrentWindow();

/**
 * Whether the window is in macOS fullscreen — which is not the same thing as maximized, and is the
 * one state where the traffic lights are not on screen at all.
 *
 * Read from the window rather than tracked locally, for the reason `WindowsControls` gives below:
 * the green button, `⌃⌘F` and the menu bar all enter fullscreen without passing through this app.
 * `onResized` is the signal because entering and leaving fullscreen always resizes the window —
 * but the listener is not ours: `windowControls` runs one for the whole app and coalesces every
 * question about the window into a single batch per frame. This used to be its own subscription
 * doing its own `isFullscreen()` IPC on every WM_SIZE.
 *
 * Off macOS this is `false` and nothing is asked at all — the only consumer is the traffic-light
 * spacer, and there are no traffic lights anywhere else.
 */
function useIsFullscreen(): boolean {
  return useSyncExternalStore(
    subscribeWindowStatus,
    () => platformIsMac() && getWindowStatus().fullscreen,
  );
}

/// On macOS the traffic lights are the real system buttons (see `tauri.macos.conf.json`:
/// `titleBarStyle: Overlay` keeps native decorations — and with them the rounded window
/// corners and the green button's real fullscreen behavior — while letting the webview draw
/// under the title bar). They're drawn by AppKit *over* the webview, so all this bar has to do
/// is leave a gap wide enough not to collide with them: they run from x=20 to roughly x=74.
///
/// In fullscreen AppKit takes them away entirely — they only come back while the pointer is at the
/// top edge, over an overlay of its own — so the gap is reserved for nothing, and 62px of nothing
/// is what pushed the workspace name into the middle of an otherwise empty bar. There, as on
/// Windows and Linux, the bar has no spacer at all: see `leadingInset`.
function MacControlsSpacer() {
  return <div aria-hidden className="w-[62px]" />;
}

/**
 * The bar's left padding, which is what lines its first tile up with the projects panel below it.
 *
 * Wherever the traffic lights are not on screen — Windows, Linux, macOS in fullscreen — the bar's
 * first thing is the repository's (or the workspace's) 22px tile, and directly under it is the
 * projects panel's column of tiles. Before, the bar kept 12px of padding plus a 4px spacer and a
 * gap, so its tile sat 9px right of that column's axis and read as misaligned with everything
 * below it (user report, on Windows). Both crumbs put their tile 4px inside themselves, so:
 *
 * - folded, the panel is 56px wide and its tiles are centred on 28 — 13 + 4 + 11 = 28;
 * - unfolded, the workspace tile sits at `px-3` + its button's `pl-1` and is 28px wide, so its axis
 *   is 30 — 15 + 4 + 11 = 30.
 *
 * With the lights the column is theirs and nothing lines up with the panel: the old 12px stays.
 */
function leadingInset(lights: boolean, sidebarFolded: boolean): string {
  if (lights) return "pl-3";
  return sidebarFolded ? "pl-[13px]" : "pl-[15px]";
}

function WindowsControls() {
  /**
   * Whether the window is maximized, so the button can say which of the two things it does.
   *
   * Read from the window rather than toggled locally: the OS maximizes it too — double-clicking the
   * drag region, or dragging it to the top edge — and a flag flipped only by this button would then
   * be describing the opposite of what is on screen.
   *
   * Through `windowControls`' store rather than a subscription of its own, so the answer costs one
   * shared `isMaximized()` per frame instead of one per WM_SIZE. The icon still flips as soon as the
   * state does: the store publishes on the first frame after the event, which is sooner than the
   * IPC round-trip this used to wait for. A boolean and not the whole status object, so a fullscreen
   * change on macOS doesn't re-render these three buttons for nothing.
   */
  const maximized = useSyncExternalStore(subscribeWindowStatus, () => getWindowStatus().maximized);

  return (
    // `data-window-control` on each button: these three belong to the window rather than to the
    // app, and a modal backdrop or the tour's veil laid over them hands their presses back instead
    // of swallowing them. See `overlayDragRegion` — on macOS the traffic lights are AppKit's and
    // need none of this.
    // Full height and flush with the corner, the way Windows draws its own caption buttons: the
    // close button is aimed at by throwing the pointer into the top-right corner, and a 36px button
    // floating 4px inside the row turned that throw into a miss.
    <div className="flex self-stretch">
      <button
        aria-label="Minimize"
        data-window-control="minimize"
        onClick={() => win.minimize()}
        className="flex h-full w-[46px] items-center justify-center text-[var(--cf-text)]/70 hover:bg-[var(--cf-press)]"
      >
        <Minus size={14} />
      </button>
      <button
        aria-label={maximized ? "Restore" : "Maximize"}
        data-window-control="maximize"
        // Rejections are logged rather than dropped: every window command here is gated by the
        // capability file, and a missing one fails as a rejected promise with nothing on screen
        // to show for it — which is exactly how this button shipped doing nothing at all.
        onClick={() => void toggleMaximize().catch((e) => console.error("toggleMaximize", e))}
        className="flex h-full w-[46px] items-center justify-center text-[var(--cf-text)]/70 hover:bg-[var(--cf-press)]"
      >
        {maximized ? <Copy size={11} className="-scale-x-100" /> : <Square size={12} />}
      </button>
      <button
        aria-label="Close"
        data-window-control="close"
        onClick={() => win.close()}
        className="flex h-full w-[46px] items-center justify-center text-[var(--cf-text)]/70 hover:bg-red-500 hover:text-white"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function TitleBar() {
  const platform = usePlatform();
  const isMac = platform === "macos";
  const fullscreen = useIsFullscreen();
  const sidebarFolded = useLayoutStore((s) => s.flags.sidebarCollapsed);
  const lights = isMac && !fullscreen;

  return (
    <header
      // `deep`, not a bare attribute: the bar's controls live inside two flex wrappers, and a bare
      // attribute only drags on direct hits to the header itself — every gap inside a wrapper was
      // dead. `deep` drags from anywhere in the subtree, and Tauri's handler still steps aside for
      // buttons, links, inputs and anything with an interactive role, so no control loses a click.
      data-tauri-drag-region="deep"
      // `z-30` makes the whole bar one layer above the panels below it, which is what the menus it
      // owns need: the workspace switcher hangs its list down over the sidebar, and the sidebar's
      // fold button rides its seam at `z-20` — same root stacking context, same z, and the sidebar
      // comes later in the DOM, so the button was painting through the open menu. Lifting the bar
      // rather than each popover keeps the rule in one place, and stays under the modals (`z-50`)
      // and the tour's veil, which have to cover the title bar in turn.
      //
      // No background: the row is part of the frame now (see the note atop `index.css`). The brand
      // wash it wore was the loudest thing on screen at all times, and it framed nothing.
      className={`relative z-30 flex h-11 shrink-0 items-center gap-2 ${leadingInset(lights, sidebarFolded)} ${
        isMac ? "pr-2" : ""
      }`}
    >
      {/* Nothing but the room the traffic lights need.

          Search and the two history arrows are gone, and the workspace switcher before them moved
          to the head of the projects panel. Search and history keep their keyboard shortcuts —
          `app.commandPalette`, `nav.back`, `nav.forward` — and the palette is also reachable from
          every place that opens it; three buttons in the corner were three permanent pixels for
          what a chord already does. */}
      {lights && (
        <div className="flex shrink-0 items-center">
          <MacControlsSpacer />
        </div>
      )}

      {/* The title bar and the repository tab bar used to be two rows: 44px holding one button and
          40px holding the tabs. One row now, and 40px handed back to the work on every screen. The
          stretch after the scope is the window's drag handle — `deep` reaches it, and Tauri's
          handler still stops at every button. */}
      <ChromeScope />
      <div className="min-w-0 flex-1 self-stretch" />

      {/* The "Acciones IA" menu that ended this row is gone (2026-09-25): each of its rows had a
          quicker door already — the assistant's own button, a pull request's own tab to review it,
          and the assistant's "+" menu (or the palette, or ⌘⇧L) to review one from its link. That button took
          the menu's place here for a day, then moved to the foot of the app rail, where it reads as
          the app it opens — see `AssistantButton` in `AppRail`. */}
      {!isMac && (
        <div className="flex shrink-0 items-center self-stretch">
          <WindowsControls />
        </div>
      )}
    </header>
  );
}
