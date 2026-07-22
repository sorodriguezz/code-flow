import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronLeft, ChevronRight, Minus, Search, Sidebar as SidebarIcon, Square, X, Zap } from "lucide-react";
import { usePlatform } from "../../lib/platform";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";

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

export function TitleBar() {
  const platform = usePlatform();
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const isMac = platform === "macos";
  const t = useT();

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
        <button className="flex h-7 w-7 items-center justify-center rounded-md text-black/60 hover:bg-black/10 dark:text-white/70">
          <Search size={16} />
        </button>
        <div className="flex items-center gap-0.5">
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-black/40 hover:bg-black/10 dark:text-white/50">
            <ChevronLeft size={16} />
          </button>
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-black/40 hover:bg-black/10 dark:text-white/50">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-black/60 hover:bg-black/10 dark:text-white/70">
          <Zap size={13} />
          {t("titlebar.aiActions")}
        </button>
        {!isMac && <WindowsControls />}
      </div>
    </header>
  );
}
