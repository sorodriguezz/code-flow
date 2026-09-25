import { ChevronDown, GitBranch, Lock } from "lucide-react";
import { NotificationBell } from "./NotificationBell";
import { RemoteActions } from "../git/RemoteActions";
import { AgentActivity } from "./AgentActivity";
import { ServicesActivity } from "./ServicesActivity";
import { CompletionActivity } from "./CompletionActivity";
import { BatteryMeter } from "./BatteryMeter";
import { SystemMeter } from "./SystemMeter";
import { UsageMeter } from "./UsageMeter";
import { useRepoStore } from "../../state/repoStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import { useShortcutHint } from "../../lib/useShortcutHint";

export function StatusBar() {
  const project = useWorkspaceStore((s) => s.activeProject());
  const status = useRepoStore((s) => s.status);
  const branches = useRepoStore((s) => s.branches);
  const toggleBranchSwitcher = useUiStore((s) => s.toggleBranchSwitcher);
  const t = useT();
  const hint = useShortcutHint();

  if (!project) {
    return (
      <footer className="flex h-7 shrink-0 items-center gap-2 pl-[24.5px] pr-2 text-[12px] text-[var(--cf-text-muted)]">
        <span>{t("statusbar.openProject")}</span>
        {/* Also here, with no project open: agent runs, generations and API work are scoped to the
            workspace, not to a repository, so they can finish while this bar is in its empty state. */}
        <div className="cf-bar-group ml-auto flex items-center">
          <AgentActivity />
          <ServicesActivity />
          <CompletionActivity />
          <SystemMeter />
          <BatteryMeter />
          <UsageMeter />
          <NotificationBell />
        </div>
      </footer>
    );
  }

  const current = branches.find((b) => b.is_head);

  return (
    <footer className="flex h-7 shrink-0 items-center gap-2.5 pl-[24.5px] pr-2 text-[12px] text-[var(--cf-text-muted)]">
      {/* The settings and services buttons that used to open this row sit at the foot of the
          projects panel now (`SidebarFoot`, 2026-09-25), so the repository leads it — and starts
          on their axis, not against the window's edge (the user's ask): `24.5px` puts the 7px dot's
          centre on 28, the centre of the column those two buttons stand in, folded or not. */}
      {/* Never truncated. This is the answer to "which repository am I about to push?", and a name
          cut at 140px turned two repos that share a prefix — `acme-api-gateway` and
          `acme-api-gateway-v2` — into the same label on the one bar that is always on screen.
          `whitespace-nowrap` so a long name stays one line in an 8px-tall bar; what gives instead
          is the branch beside it, which the git actions to the right are pinned against by their
          own `shrink-0`. */}
      <span
        className="flex shrink-0 items-center gap-1 whitespace-nowrap font-medium text-[var(--cf-text)]"
        title={project.local_path}
      >
        <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: project.color }} />
        {project.name}
      </span>
      <span className="h-3 w-px shrink-0 bg-[var(--cf-border)]" />

      {/* Sized to its name, not to the bar. It is allowed to *use* whatever room is left — nothing
          between here and the bell grows — but it does not claim it: with `flex-1` the button's box
          stretched to the far edge and carried the git actions with it, which put them against the
          right rim of the window instead of beside the branch they act on. `min-w-0` is what still
          lets the name truncate when the bar genuinely runs out of room. */}
      <button
        onClick={toggleBranchSwitcher}
        title={hint("branch.switcher", t("shortcuts.cmdBranchSwitcher"))}
        className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-[var(--cf-text)] hover:bg-[var(--cf-hover)]"
      >
        <GitBranch size={12} className="shrink-0" />
        {/* The one thing on this bar that gives when it runs out of room. A branch name is recovered
            from the switcher this button opens, and a truncated one still says which branch it is —
            they differ at the start (`feature/…`, `hotfix/…`), unlike repository names that share a
            prefix and differ at the end. */}
        <span className="min-w-0 truncate text-left">
          {status?.current_branch ?? (status?.is_detached ? t("statusbar.detachedHead") : "—")}
        </span>
        {current?.is_locked && (
          <span
            className="text-[var(--cf-warning)]"
            title={current.locked_by_rule ? t("branch.lockedByRuleBadge") : t("branch.lockedBadge")}
          >
            <Lock size={11} />
          </span>
        )}
        <ChevronDown size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
      </button>

      <RemoteActions />

      {/* The line blame that sat here moved to the Editor's own status line (2026-09-25), with the
          caret, indentation and line endings: it is about the file being read, not the repository —
          see `EditorStatusLine`. */}

      {/* The one thing on the right. It is not a git action — it reports on agent runs, generations
          and API work, which are the workspace's business rather than this repository's — and it is
          the only control here that speaks while you are looking somewhere else. */}
      {/* Beside the bell, and for the same reason it is here rather than in a settings screen:
          both report on work the app did while you were looking somewhere else.

          The order is what each one asks of the reader. The agent pill comes first because it is
          the only one that is ever *about to be clicked* — it is a way back to work in flight, and
          it is only there while there is any. Then the three machine readings, then the battery,
          then the limits, then the bell: from "something of mine is happening" through "this box is
          busy" to "here is what already finished".

          `cf-bar-group` draws the hairline between each of them — and only between the ones that
          are actually on screen, which is why it is a sibling rule and not six separators. */}
      <div className="cf-bar-group ml-auto flex shrink-0 items-center">
        <AgentActivity />
        <ServicesActivity />
        <CompletionActivity />
        <SystemMeter />
        <BatteryMeter />
        <UsageMeter />
        <NotificationBell />
      </div>
    </footer>
  );
}
