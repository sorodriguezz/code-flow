import { ArrowDown, ArrowUp, ChevronDown, CloudUpload, Download, Folder, GitBranch, Loader2, Lock, RefreshCw, Settings, Sparkles, TerminalSquare, Upload } from "lucide-react";
import { NotificationBell } from "./NotificationBell";
import { useRepoStore } from "../../state/repoStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { useTerminalStore } from "../../state/terminalStore";
import { useFetchTimerStore } from "../../state/fetchTimerStore";
import { useT } from "../../state/languageStore";
import { canPublish, canPull, canPush, fetchNow, pullNow, pushNow } from "../../lib/gitActions";
import { useShortcutHint } from "../../lib/useShortcutHint";

export function StatusBar() {
  const project = useWorkspaceStore((s) => s.activeProject());
  const status = useRepoStore((s) => s.status);
  const branches = useRepoStore((s) => s.branches);
  const remoteOp = useRepoStore((s) => s.remoteOp);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const toggleSettings = useUiStore((s) => s.toggleSettings);
  const terminalPanelOpen = useTerminalStore((s) => s.panelOpen);
  const toggleTerminalPanel = useTerminalStore((s) => s.togglePanel);
  const aiPanelOpen = useUiStore((s) => s.aiPanelOpen);
  const toggleAiPanel = useUiStore((s) => s.toggleAiPanel);
  const remainingSeconds = useFetchTimerStore((s) => s.remainingSeconds);
  const toggleBranchSwitcher = useUiStore((s) => s.toggleBranchSwitcher);
  const t = useT();
  const hint = useShortcutHint();

  const settingsButton = (
    <button
      onClick={toggleSettings}
      title={hint("app.settings", t("statusbar.settings"))}
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
      title={hint("panel.terminal", t("terminal.toggle"))}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-black/[0.05] dark:hover:bg-white/[0.08] ${
        terminalPanelOpen ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
      }`}
    >
      <TerminalSquare size={13} />
    </button>
  );

  const aiPanelButton = (
    <button
      onClick={toggleAiPanel}
      title={hint("panel.ai", t("statusbar.aiPanel"))}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-black/[0.05] dark:hover:bg-white/[0.08] ${
        aiPanelOpen ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
      }`}
    >
      <Sparkles size={13} />
    </button>
  );

  if (!project) {
    return (
      <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 text-[12px] text-[var(--cf-text-muted)]">
        {settingsButton}
        {terminalButton}
        {aiPanelButton}
        <span>{t("statusbar.openProject")}</span>
        {/* Also here, with no project open: agent runs, generations and API work are scoped to the
            workspace, not to a repository, so they can finish while this bar is in its empty state. */}
        <div className="ml-auto flex items-center">
          <NotificationBell />
        </div>
      </footer>
    );
  }

  const current = branches.find((b) => b.is_head);
  const changedCount =
    (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0) + (status?.untracked.length ?? 0);
  const behind = current?.behind ?? 0;
  const ahead = current?.ahead ?? 0;
  // Availability comes from `lib/gitActions` so these buttons and the keyboard shortcuts that do
  // the same thing can't disagree about when there's nothing to do.
  const pullEnabled = canPull(current);
  const pushEnabled = canPush(current);
  const publishable = canPublish(current);

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 text-[12px] text-[var(--cf-text-muted)]">
      {settingsButton}
      {terminalButton}
      {aiPanelButton}

      {/* Never truncated. This is the answer to "which repository am I about to push?", and a name
          cut at 140px turned two repos that share a prefix — `acme-api-gateway` and
          `acme-api-gateway-v2` — into the same label on the one bar that is always on screen.
          `whitespace-nowrap` so a long name stays one line in an 8px-tall bar; what gives instead
          is the branch and the counters in the middle, which the git actions to the right are
          pinned against by their own `shrink-0`. */}
      <span
        className="flex shrink-0 items-center gap-1 whitespace-nowrap font-medium text-[var(--cf-text)]"
        title={project.local_path}
      >
        <Folder size={11} style={{ color: project.color }} />
        {project.name}
      </span>
      <span className="h-3 w-px shrink-0 bg-[var(--cf-border)]" />

      <button
        onClick={toggleBranchSwitcher}
        title={hint("branch.switcher", t("shortcuts.cmdBranchSwitcher"))}
        className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-[var(--cf-text)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
      >
        <GitBranch size={12} className="shrink-0" />
        {/* The one thing on this bar that gives when it runs out of room. A branch name is recovered
            from the switcher this button opens, and a truncated one still says which branch it is —
            they differ at the start (`feature/…`, `hotfix/…`), unlike repository names that share a
            prefix and differ at the end. */}
        <span className="min-w-0 truncate">
          {status?.current_branch ?? (status?.is_detached ? t("statusbar.detachedHead") : "—")}
        </span>
        {current?.is_locked && (
          <span className="text-[var(--cf-warning)]" title={t("branch.lockedBadge")}>
            <Lock size={11} />
          </span>
        )}
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

      {/* `shrink-0`: these are the bar's actions, and a repository with a long name must not be able
          to squeeze fetch/pull/push off the end of it. */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button
          disabled={remoteOp !== null}
          onClick={fetchNow}
          title={
            remainingSeconds !== null
              ? t("statusbar.nextFetch", { n: remainingSeconds })
              : hint("git.fetch", t("statusbar.fetch"))
          }
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

        {publishable ? (
          <button
            disabled={remoteOp !== null}
            onClick={pushNow}
            title={hint("git.push", t("statusbar.publishTo"))}
            className="flex h-6 items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 text-white hover:brightness-110 disabled:opacity-40"
          >
            {remoteOp === "push" ? <Loader2 size={12} className="animate-spin" /> : <CloudUpload size={12} />}
            {t("statusbar.publish")}
          </button>
        ) : (
          <>
            <button
              disabled={remoteOp !== null || !pullEnabled}
              onClick={pullNow}
              title={pullEnabled ? hint("git.pull", t("statusbar.pullFrom")) : t("statusbar.nothingToPull")}
              className="flex h-6 items-center gap-1 rounded-md px-2 hover:bg-black/[0.05] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-white/[0.08] dark:disabled:hover:bg-transparent"
            >
              {remoteOp === "pull" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              {t("statusbar.pull")}
              {behind > 0 && <span className="font-semibold">↓{behind}</span>}
            </button>
            <button
              disabled={remoteOp !== null || !pushEnabled}
              onClick={pushNow}
              // A locked branch is a different reason for the same greyed-out button, and
              // "nothing to push" would be the wrong explanation for it.
              title={
                pushEnabled
                  ? hint("git.push", t("statusbar.pushTo"))
                  : current?.is_locked
                    ? t("branch.lockedCannotPush", { name: current.name })
                    : t("statusbar.nothingToPush")
              }
              className="flex h-6 items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
            >
              {remoteOp === "push" ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              {t("statusbar.push")}
              {ahead > 0 && <span className="font-semibold">↑{ahead}</span>}
            </button>
          </>
        )}

        <NotificationBell />
      </div>
    </footer>
  );
}
