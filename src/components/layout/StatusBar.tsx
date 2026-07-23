import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, CloudUpload, Download, Folder, GitBranch, Loader2, RefreshCw, Settings, TerminalSquare, Upload } from "lucide-react";
import { useRepoStore } from "../../state/repoStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { useTerminalStore } from "../../state/terminalStore";
import { useFetchTimerStore } from "../../state/fetchTimerStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { useT } from "../../state/languageStore";
import { BranchSwitcherModal } from "./BranchSwitcherModal";

export function StatusBar() {
  const project = useWorkspaceStore((s) => s.activeProject());
  const status = useRepoStore((s) => s.status);
  const branches = useRepoStore((s) => s.branches);
  const remoteOp = useRepoStore((s) => s.remoteOp);
  const fetch = useRepoStore((s) => s.fetch);
  const pull = useRepoStore((s) => s.pull);
  const push = useRepoStore((s) => s.push);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const toggleSettings = useUiStore((s) => s.toggleSettings);
  const terminalPanelOpen = useTerminalStore((s) => s.panelOpen);
  const toggleTerminalPanel = useTerminalStore((s) => s.togglePanel);
  const remainingSeconds = useFetchTimerStore((s) => s.remainingSeconds);
  const autoFetchSeconds = usePreferencesStore((s) => s.autoFetchSeconds);
  const [showBranchModal, setShowBranchModal] = useState(false);
  const t = useT();

  const settingsButton = (
    <button
      onClick={toggleSettings}
      title={t("statusbar.settings")}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-black/[0.05] dark:hover:bg-white/[0.08] ${
        settingsOpen ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
      }`}
    >
      <Settings size={13} />
    </button>
  );

  const terminalButton = (
    <button
      onClick={toggleTerminalPanel}
      title={t("terminal.toggle")}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-black/[0.05] dark:hover:bg-white/[0.08] ${
        terminalPanelOpen ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
      }`}
    >
      <TerminalSquare size={13} />
    </button>
  );

  if (!project) {
    return (
      <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 text-[12px] text-[var(--cf-text-muted)]">
        {settingsButton}
        {terminalButton}
        <span>{t("statusbar.openProject")}</span>
      </footer>
    );
  }

  const current = branches.find((b) => b.is_head);
  const changedCount =
    (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0) + (status?.untracked.length ?? 0);
  const hasUpstream = !!current?.upstream;

  const handleManualFetch = () => {
    void fetch();
    if (autoFetchSeconds) useFetchTimerStore.getState().setRemaining(autoFetchSeconds);
  };

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 text-[12px] text-[var(--cf-text-muted)]">
      {settingsButton}
      {terminalButton}

      <span
        className="flex shrink-0 items-center gap-1 truncate font-medium text-[var(--cf-text)]"
        title={project.local_path}
      >
        <Folder size={11} style={{ color: project.color }} />
        <span className="max-w-[140px] truncate">{project.name}</span>
      </span>
      <span className="h-3 w-px shrink-0 bg-[var(--cf-border)]" />

      <button
        onClick={() => setShowBranchModal(true)}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-[var(--cf-text)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
      >
        <GitBranch size={12} />
        {status?.current_branch ?? (status?.is_detached ? t("statusbar.detachedHead") : "—")}
        <ChevronDown size={11} className="text-[var(--cf-text-muted)]" />
      </button>

      {current && (current.ahead > 0 || current.behind > 0) && (
        <span className="flex items-center gap-1">
          {current.ahead > 0 && (
            <span className="flex items-center gap-0.5">
              <ArrowUp size={11} />
              {current.ahead}
            </span>
          )}
          {current.behind > 0 && (
            <span className="flex items-center gap-0.5">
              <ArrowDown size={11} />
              {current.behind}
            </span>
          )}
        </span>
      )}

      {changedCount > 0 && (
        <span>
          {changedCount} {changedCount === 1 ? t("statusbar.change") : t("statusbar.changes")}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        <button
          disabled={remoteOp !== null}
          onClick={handleManualFetch}
          title={remainingSeconds !== null ? t("statusbar.nextFetch", { n: remainingSeconds }) : t("statusbar.fetch")}
          className="flex h-6 items-center gap-1 rounded-md px-2 hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
        >
          {remoteOp === "fetch" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          {t("statusbar.fetch")}
          {remainingSeconds !== null && <span className="tabular-nums text-[10px]">{remainingSeconds}s</span>}
        </button>

        {!hasUpstream ? (
          <button
            disabled={remoteOp !== null}
            onClick={() => push(true)}
            title={t("statusbar.publishTo")}
            className="flex h-6 items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 text-white hover:brightness-110 disabled:opacity-40"
          >
            {remoteOp === "push" ? <Loader2 size={12} className="animate-spin" /> : <CloudUpload size={12} />}
            {t("statusbar.publish")}
          </button>
        ) : (
          <>
            <button
              disabled={remoteOp !== null}
              onClick={() => pull()}
              title={t("statusbar.pullFrom")}
              className="flex h-6 items-center gap-1 rounded-md px-2 hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
            >
              {remoteOp === "pull" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              {t("statusbar.pull")}
              {(current?.behind ?? 0) > 0 && <span className="font-semibold">↓{current?.behind}</span>}
            </button>
            <button
              disabled={remoteOp !== null}
              onClick={() => push(false)}
              title={t("statusbar.pushTo")}
              className="flex h-6 items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 text-white hover:brightness-110 disabled:opacity-40"
            >
              {remoteOp === "push" ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              {t("statusbar.push")}
              {(current?.ahead ?? 0) > 0 && <span className="font-semibold">↑{current?.ahead}</span>}
            </button>
          </>
        )}
      </div>

      {showBranchModal && <BranchSwitcherModal onClose={() => setShowBranchModal(false)} />}
    </footer>
  );
}
