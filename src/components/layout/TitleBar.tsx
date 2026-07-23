import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronLeft,
  ChevronRight,
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
import { CommandPalette } from "./CommandPalette";

const win = getCurrentWindow();

function MacControls() {
  return (
    <div className="flex items-center gap-2 pl-4">
      <button
        aria-label="Close"
        onClick={() => win.close()}
        className="h-3 w-3 rounded-full bg-[#ff5f57] hover:brightness-90"
      />
      <button
        aria-label="Minimize"
        onClick={() => win.minimize()}
        className="h-3 w-3 rounded-full bg-[#febc2e] hover:brightness-90"
      />
      <button
        aria-label="Maximize"
        onClick={() => win.toggleMaximize()}
        className="h-3 w-3 rounded-full bg-[#28c840] hover:brightness-90"
      />
    </div>
  );
}

function WindowsControls() {
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
        aria-label="Maximize"
        onClick={() => win.toggleMaximize()}
        className="flex h-9 w-11 items-center justify-center text-[var(--cf-text)]/70 hover:bg-black/10"
      >
        <Square size={12} />
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
  const project = useWorkspaceStore((s) => s.activeProject());
  const selectedPr = usePrStore((s) => s.selectedPr);
  const reviewPr = usePrStore((s) => s.reviewPr);

  const openChat = () => {
    openAiPanel();
    onClose();
  };

  const reviewCurrentPr = () => {
    if (!project || !selectedPr) return;
    openAiPanel();
    reviewPr(project.id, selectedPr.id);
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
          disabled={!selectedPr}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--cf-text)] hover:bg-black/[0.03] disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-white/[0.04]"
        >
          <Sparkles size={13} />
          <span className="min-w-0 flex-1 truncate">
            {selectedPr ? t("titlebar.reviewCurrentPr", { title: selectedPr.title }) : t("titlebar.noPrSelected")}
          </span>
        </button>
      </div>
    </>
  );
}

export function TitleBar() {
  const platform = usePlatform();
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);
  const canGoBack = useNavigationStore((s) => s.canGoBack);
  const canGoForward = useNavigationStore((s) => s.canGoForward);
  const isMac = platform === "macos";
  const t = useT();
  const [showSearch, setShowSearch] = useState(false);
  const [showAiMenu, setShowAiMenu] = useState(false);

  const goBack = () => {
    const entry = useNavigationStore.getState().back();
    if (!entry) return;
    setActiveView(entry.view);
    if (entry.projectId) setActiveProject(entry.projectId);
  };

  const goForward = () => {
    const entry = useNavigationStore.getState().forward();
    if (!entry) return;
    setActiveView(entry.view);
    if (entry.projectId) setActiveProject(entry.projectId);
  };

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-11 shrink-0 items-center justify-between px-3"
      style={{ background: "var(--cf-titlebar-gradient)" }}
    >
      <div className="flex items-center gap-3">
        {isMac ? <MacControls /> : <div className="w-2" />}
        <button
          onClick={toggleSidebar}
          className="flex h-7 w-7 items-center justify-center rounded-md text-black/60 hover:bg-black/10 dark:text-white/70"
        >
          <SidebarIcon size={16} />
        </button>
        <button
          onClick={() => setShowSearch(true)}
          title={t("titlebar.search")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-black/60 hover:bg-black/10 dark:text-white/70"
        >
          <Search size={16} />
        </button>
        <div className="flex items-center gap-0.5">
          <button
            onClick={goBack}
            disabled={!canGoBack}
            title={t("titlebar.goBack")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-black/40 hover:bg-black/10 disabled:opacity-30 disabled:hover:bg-transparent dark:text-white/50"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={goForward}
            disabled={!canGoForward}
            title={t("titlebar.goForward")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-black/40 hover:bg-black/10 disabled:opacity-30 disabled:hover:bg-transparent dark:text-white/50"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative">
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

      {showSearch && <CommandPalette onClose={() => setShowSearch(false)} />}
    </header>
  );
}
