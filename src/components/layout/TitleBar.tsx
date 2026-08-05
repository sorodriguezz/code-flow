import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Glasses,
  MessageCircle,
  Minus,
  Search,
  Sidebar as SidebarIcon,
  Sparkles,
  Square,
  X,
  Zap,
} from "lucide-react";
import { usePlatform } from "../../lib/platform";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useNavigationStore } from "../../state/navigationStore";
import { usePrStore } from "../../state/prStore";
import { useT } from "../../state/languageStore";
import { goHistory } from "../../lib/shortcuts";
import { useShortcutHint } from "../../lib/useShortcutHint";
import { toggleMaximize } from "../../lib/windowControls";

const win = getCurrentWindow();

/// On macOS the traffic lights are the real system buttons (see `tauri.macos.conf.json`:
/// `titleBarStyle: Overlay` keeps native decorations — and with them the rounded window
/// corners and the green button's real fullscreen behavior — while letting the webview draw
/// under the title bar). They're drawn by AppKit *over* the webview, so all this bar has to do
/// is leave a gap wide enough not to collide with them: they run from x=20 to roughly x=74.
function MacControlsSpacer() {
  return <div aria-hidden className="w-[62px]" />;
}

function WindowsControls() {
  /**
   * Whether the window is maximized, so the button can say which of the two things it does.
   *
   * Read from the window rather than toggled locally: the OS maximizes it too — double-clicking the
   * drag region, or dragging it to the top edge — and a flag flipped only by this button would then
   * be describing the opposite of what is on screen.
   */
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const sync = () => void win.isMaximized().then(setMaximized).catch(() => {});
    sync();
    void win.onResized(sync).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="flex items-center">
      <button
        aria-label="Minimize"
        onClick={() => win.minimize()}
        className="flex h-9 w-11 items-center justify-center text-[var(--cf-text)]/70 hover:bg-black/10"
      >
        <Minus size={14} />
      </button>
      <button
        aria-label={maximized ? "Restore" : "Maximize"}
        // Rejections are logged rather than dropped: every window command here is gated by the
        // capability file, and a missing one fails as a rejected promise with nothing on screen
        // to show for it — which is exactly how this button shipped doing nothing at all.
        onClick={() => void toggleMaximize().catch((e) => console.error("toggleMaximize", e))}
        className="flex h-9 w-11 items-center justify-center text-[var(--cf-text)]/70 hover:bg-black/10"
      >
        {maximized ? <Copy size={11} className="-scale-x-100" /> : <Square size={12} />}
      </button>
      <button
        aria-label="Close"
        onClick={() => win.close()}
        className="flex h-9 w-11 items-center justify-center text-[var(--cf-text)]/70 hover:bg-red-500 hover:text-white"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function AiActionsMenu({ onClose }: { onClose: () => void }) {
  const t = useT();
  const openAiPanel = useUiStore((s) => s.openAiPanel);
  const openPrLinkModal = useUiStore((s) => s.openPrLinkModal);
  const project = useWorkspaceStore((s) => s.activeProject());
  const selectedPr = usePrStore((s) => s.selectedPr);
  const reviewPr = usePrStore((s) => s.reviewPr);

  const openChat = () => {
    openAiPanel();
    onClose();
  };

  const reviewFromLink = () => {
    openPrLinkModal();
    onClose();
  };

  // Same rule as the PR panel: a merged or closed pull request is settled and takes no more
  // actions. Without this the menu would be a way around the panel's own lock.
  const prSettled = selectedPr?.status === "merged" || selectedPr?.status === "closed";

  const reviewCurrentPr = () => {
    if (!project || !selectedPr || prSettled) return;
    openAiPanel();
    reviewPr({ kind: "project", projectId: project.id }, selectedPr.id);
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute right-0 top-full z-20 mt-1 w-60 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]">
        <button
          onClick={openChat}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--cf-text)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        >
          <MessageCircle size={13} />
          {t("titlebar.openChat")}
        </button>
        <button
          onClick={reviewCurrentPr}
          disabled={!selectedPr || prSettled}
          title={prSettled ? t("pr.stateLockedHint") : undefined}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--cf-text)] hover:bg-black/[0.03] disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-white/[0.04]"
        >
          <Sparkles size={13} />
          <span className="min-w-0 flex-1 truncate">
            {selectedPr ? t("titlebar.reviewCurrentPr", { title: selectedPr.title }) : t("titlebar.noPrSelected")}
          </span>
        </button>
        {/* Works with no project open and no PR selected — that's the point: the link is the
            only input needed. */}
        <button
          onClick={reviewFromLink}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--cf-text)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        >
          <Glasses size={13} />
          {t("prLink.menuItem")}
        </button>
      </div>
    </>
  );
}

export function TitleBar() {
  const platform = usePlatform();
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const openCommandPalette = useUiStore((s) => s.openCommandPalette);
  const canGoBack = useNavigationStore((s) => s.canGoBack);
  const canGoForward = useNavigationStore((s) => s.canGoForward);
  const isMac = platform === "macos";
  const t = useT();
  const hint = useShortcutHint();
  const [showAiMenu, setShowAiMenu] = useState(false);

  return (
    <header
      // `deep`, not a bare attribute: the bar's controls live inside two flex wrappers, and a bare
      // attribute only drags on direct hits to the header itself — every gap inside a wrapper was
      // dead. `deep` drags from anywhere in the subtree, and Tauri's handler still steps aside for
      // buttons, links, inputs and anything with an interactive role, so no control loses a click.
      data-tauri-drag-region="deep"
      className="relative flex h-11 shrink-0 items-center justify-between px-3"
      style={{ background: "var(--cf-titlebar-gradient)" }}
    >
      <div className="flex items-center gap-3">
        {isMac ? <MacControlsSpacer /> : <div className="w-2" />}
        <button
          onClick={toggleSidebar}
          title={hint("panel.sidebar", t("titlebar.toggleSidebar"))}
          className="flex h-7 w-7 items-center justify-center rounded-md text-black/60 hover:bg-black/10 dark:text-white/70"
        >
          <SidebarIcon size={16} />
        </button>
        <button
          onClick={() => openCommandPalette("all")}
          title={hint("app.commandPalette", t("titlebar.search"))}
          className="flex h-7 w-7 items-center justify-center rounded-md text-black/60 hover:bg-black/10 dark:text-white/70"
        >
          <Search size={16} />
        </button>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => goHistory("back")}
            disabled={!canGoBack}
            title={hint("nav.back", t("titlebar.goBack"))}
            className="flex h-7 w-7 items-center justify-center rounded-md text-black/40 hover:bg-black/10 disabled:opacity-30 disabled:hover:bg-transparent dark:text-white/50"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => goHistory("forward")}
            disabled={!canGoForward}
            title={hint("nav.forward", t("titlebar.goForward"))}
            className="flex h-7 w-7 items-center justify-center rounded-md text-black/40 hover:bg-black/10 disabled:opacity-30 disabled:hover:bg-transparent dark:text-white/50"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* Opted out of the header's drag region: the open menu hangs a full-screen backdrop and a
            popover off this wrapper, and both are plain divs — under `deep` they would turn a press
            anywhere on screen into a window drag instead of closing the menu. */}
        <div data-tauri-drag-region="false" className="relative">
          <button
            onClick={() => setShowAiMenu((v) => !v)}
            className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-black/60 hover:bg-black/10 dark:text-white/70"
          >
            <Zap size={13} />
            {t("titlebar.aiActions")}
          </button>
          {showAiMenu && <AiActionsMenu onClose={() => setShowAiMenu(false)} />}
        </div>
        {!isMac && <WindowsControls />}
      </div>
    </header>
  );
}
