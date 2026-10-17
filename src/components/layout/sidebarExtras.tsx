import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GitPullRequest, Pin } from "lucide-react";
import type { Project } from "../../types/domain";
import type { ProjectMenuContext } from "./projectMenu";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useRepoStore } from "../../state/repoStore";
import { useRepoSummaryStore } from "../../state/repoSummaryStore";
import { useSidebarLayout, useSidebarLayoutStore, type SidebarGroup } from "../../state/sidebarLayoutStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { useAiPanelStore } from "../../state/aiPanelStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { translate, useT } from "../../state/languageStore";
import { openInVsCode } from "../../lib/tauri/commands";
import { ContextMenu } from "../common/ContextMenu";
import { WorkspaceGlyph } from "./WorkspaceGlyph";

/**
 * The verbs both forms of a repository in the panel offer from their right-click — the unfolded
 * row and the folded chip — beyond `projectMenu`'s own: rename, colour, pin, group, VS Code and
 * moving to another workspace. One hook so folding the panel never takes a verb away.
 */
export function useProjectArrangement(project: Project): {
  extras: Partial<ProjectMenuContext>;
  moveOpen: boolean;
  closeMove: () => void;
} {
  const t = useT();
  const workspaceId = project.workspace_id;
  const layout = useSidebarLayout(workspaceId);
  const otherWorkspaces = useWorkspaceStore((s) => s.workspaces.filter((w) => w.id !== workspaceId).length);
  const [moveOpen, setMoveOpen] = useState(false);
  const store = useSidebarLayoutStore.getState();

  const extras: Partial<ProjectMenuContext> = {
    onOpenVsCode: () => void openInVsCode(project.local_path).catch((e: unknown) => pushErrorToast(String(e))),
    onRename: async () => {
      const name = await promptAction(t("sidebar.renameProjectPrompt"), { initial: project.name, confirmLabel: t("sidebar.wsRename") });
      if (name && name !== project.name) {
        await useWorkspaceStore
          .getState()
          .renameProject(project.id, workspaceId, name)
          .catch((e: unknown) => pushErrorToast(String(e)));
      }
    },
    onColor: (color) =>
      void useWorkspaceStore
        .getState()
        .setProjectColor(project.id, workspaceId, color)
        .catch((e: unknown) => pushErrorToast(String(e))),
    pinned: layout.pinned.includes(project.id),
    onTogglePin: () => store.togglePinned(workspaceId, project.id),
    groups: layout.groups.map((g) => ({ id: g.id, name: g.name })),
    groupId: layout.groupOf[project.id] && layout.groups.some((g) => g.id === layout.groupOf[project.id]) ? layout.groupOf[project.id] : null,
    onSetGroup: (groupId) => store.setGroup(workspaceId, project.id, groupId),
    onNewGroup: async () => {
      const name = await promptAction(t("sidebar.newGroupPrompt"), { confirmLabel: t("sidebar.menuNewGroup").replace("…", "") });
      if (!name) return;
      const id = store.createGroup(workspaceId, name);
      store.setGroup(workspaceId, project.id, id);
    },
    onMove: otherWorkspaces > 0 ? () => setMoveOpen(true) : undefined,
  };
  return { extras, moveOpen, closeMove: () => setMoveOpen(false) };
}

/** Whether a model is running in this repository, and whether the assistant holds a result for it
 *  nobody has read. Both read off stores that already know — runs carry their project in their
 *  notification target, unread marks are keyed by tab. */
export function useProjectActivity(projectId: string): { busy: boolean; unread: boolean } {
  const busy = useAiRunStore((s) =>
    Object.entries(s.active).some(([runId, running]) => running && s.aboutByRun[runId]?.target?.projectId === projectId),
  );
  const unread = useAiPanelStore((s) =>
    Object.values(s.tabsByWorkspace).some((tabs) =>
      tabs.some((tab) => s.unread[tab.key] !== undefined && "projectId" in tab && tab.projectId === projectId),
    ),
  );
  return { busy, unread };
}

/**
 * The numbers beside a repository's name: its branch, files with changes, commits to push and to
 * pull, open pull requests, and a dot for a model working in it or a result left unread. The open
 * repository reads its live state from `repoStore`; the rest the panel's minute-by-minute summary.
 * Hidden while the row is hovered, where its own actions take the place.
 */
export function ProjectBadges({ project, isActive }: { project: Project; isActive: boolean }) {
  const t = useT();
  const summary = useRepoSummaryStore((s) => s.byPath[project.local_path]);
  const prs = useRepoSummaryStore((s) => s.prsByProject[project.id]);
  const liveStatus = useRepoStore((s) => (isActive ? s.status : null));
  const liveHead = useRepoStore((s) => (isActive ? (s.branches.find((b) => b.is_head && !b.is_remote) ?? null) : null));
  const { busy, unread } = useProjectActivity(project.id);

  const changed = liveStatus
    ? new Set([...liveStatus.staged, ...liveStatus.unstaged, ...liveStatus.untracked].map((f) => f.path)).size
    : (summary?.changed ?? 0);
  const conflicted = liveStatus ? liveStatus.conflicted.length : (summary?.conflicted ?? 0);
  const branch = liveStatus ? liveStatus.current_branch : (summary?.branch ?? null);
  const ahead = liveHead ? liveHead.ahead : (summary?.ahead ?? null);
  const behind = liveHead ? liveHead.behind : (summary?.behind ?? null);

  return (
    <span className="relative flex shrink-0 items-center gap-1.5 text-[10.5px] tabular-nums text-[var(--cf-text-faint)] group-hover:hidden">
      {busy && <span title={t("sidebar.badgeBusy")} className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--cf-accent-fill)]" />}
      {!busy && unread && <span title={t("sidebar.badgeUnread")} className="h-1.5 w-1.5 rounded-full bg-[var(--cf-accent-fill)]" />}
      {/* Not on the open row: its branch is the first thing unfolded under it. */}
      {branch && !isActive && <span className="max-w-[72px] truncate font-mono">{branch}</span>}
      {conflicted > 0 && (
        <span title={t("sidebar.badgeConflicted", { n: conflicted })} className="text-[var(--cf-danger)]">
          !{conflicted}
        </span>
      )}
      {changed > 0 && (
        <span title={t("sidebar.badgeChanged", { n: changed })} className="text-[var(--cf-warning)]">
          ●{changed}
        </span>
      )}
      {(ahead ?? 0) > 0 && (
        <span title={t("sidebar.badgeAhead", { n: ahead ?? 0 })} className="flex items-center">
          <ArrowUp size={9} />
          {ahead}
        </span>
      )}
      {(behind ?? 0) > 0 && (
        <span title={t("sidebar.badgeBehind", { n: behind ?? 0 })} className="flex items-center">
          <ArrowDown size={9} />
          {behind}
        </span>
      )}
      {prs && prs.count > 0 && (
        <span
          title={`${t("sidebar.badgePrs", { n: prs.count })}${prs.fresh > 0 ? ` · ${t("sidebar.badgePrsNew", { n: prs.fresh })}` : ""}`}
          className={`flex items-center gap-0.5 ${prs.fresh > 0 ? "text-[var(--cf-accent)]" : ""}`}
        >
          <GitPullRequest size={9} />
          {prs.count}
          {prs.more ? "+" : ""}
        </span>
      )}
    </span>
  );
}

/** A group's heading in the panel: its name and count, a click folds it, the right-click renames
 *  or deletes it (its repositories go back to the ungrouped list). */
export function GroupHeader({ workspaceId, group, count }: { workspaceId: string; group: SidebarGroup; count: number }) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const store = useSidebarLayoutStore.getState();
  return (
    <>
      <button
        type="button"
        onClick={() => store.toggleGroup(workspaceId, group.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        aria-expanded={!group.collapsed}
        className="mt-1.5 flex w-full items-center gap-1 rounded-md px-1 py-0.5 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
      >
        {group.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span className="min-w-0 flex-1 truncate">{group.name}</span>
        <span className="tabular-nums text-[var(--cf-text-faint)]">{count}</span>
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          heading={group.name}
          items={[
            {
              label: t("sidebar.renameGroup"),
              onClick: async () => {
                const name = await promptAction(t("sidebar.newGroupPrompt"), { initial: group.name });
                if (name) store.renameGroup(workspaceId, group.id, name);
              },
            },
            { label: t("sidebar.deleteGroup"), danger: true, onClick: () => store.deleteGroup(workspaceId, group.id) },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** The heading over the pinned repositories. */
export function PinnedHeader() {
  const t = useT();
  return (
    <div className="mt-0.5 flex items-center gap-1 px-1 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
      <Pin size={11} />
      {t("sidebar.pinned")}
    </div>
  );
}

/**
 * While a repository is being dragged in the panel, the other workspaces stand ready beside it: let
 * go over one and the repository moves there — the drag that the move dialog used to be the only
 * way to do. Found by `data-drop-workspace` under the pointer when the hold ends (`onDropOutside`
 * in `useHoldReorder`), so nothing here listens for the drop itself; it only lights the target.
 */
export function MoveDropStrip({ projectWorkspaceId, anchor }: { projectWorkspaceId: string; anchor: DOMRect | null }) {
  const t = useT();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const others = useMemo(() => workspaces.filter((w) => w.id !== projectWorkspaceId), [workspaces, projectWorkspaceId]);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-drop-workspace]");
      setHover(target?.dataset.dropWorkspace ?? null);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  if (others.length === 0 || !anchor) return null;
  return createPortal(
    <div
      style={{ left: anchor.right + 8, top: anchor.top }}
      className="cf-fade-in fixed z-[10000] flex w-[200px] flex-col gap-1 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1.5 shadow-[var(--cf-shadow)]"
    >
      <p className="px-1 pb-0.5 text-[11px] text-[var(--cf-text-muted)]">{t("sidebar.moveDropHint")}</p>
      {others.map((ws) => (
        <div
          key={ws.id}
          data-drop-workspace={ws.id}
          className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-[12px] ${
            hover === ws.id
              ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
              : "border-dashed border-[var(--cf-border)] text-[var(--cf-text)]"
          }`}
        >
          <WorkspaceGlyph name={ws.name} icon={ws.icon} color={ws.color} size={18} />
          <span className="min-w-0 truncate">{ws.name}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** Moves a dropped repository and says where it went. */
export async function moveProjectByDrop(project: Project, workspaceId: string): Promise<void> {
  const target = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!target || workspaceId === project.workspace_id) return;
  try {
    await useWorkspaceStore.getState().moveProject(project.id, project.workspace_id, workspaceId);
    pushSuccessToast(translate("sidebar.movedTo", { name: target.name }));
  } catch (e) {
    pushErrorToast(String(e));
  }
}
