import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileJson,
  GitBranch,
  GitPullRequestArrow,
  Unlink,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Globe,
  LayoutTemplate,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  Upload,
  Users,
  Waypoints,
  X,
} from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { explorerHeadClass, fieldClass, rowClass } from "../common/recipes";
import { nodeIcon } from "../../lib/flows/nodeIcons";
import { scopeMenuItems } from "../../lib/scopeMenu";
import type { FlowFolderRow } from "../../lib/tauri/flowsCommands";
import { confirmAction } from "../../state/confirmStore";
import { useFlowRunsStore } from "../../state/flowRunsStore";
import { useFlowsStore, type FlowItem } from "../../state/flowsStore";
import { useT } from "../../state/languageStore";
import { TemplatesDialog } from "./TemplatesDialog";
import { FlowShareDialog } from "./FlowShareDialog";
import { useFlowShareStore } from "../../state/flowShareStore";
import { promptAction } from "../../state/promptStore";
import { useFlowRepoStore } from "../../state/flowRepoStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/**
 * The workspace's flows: folders first, then the flows at the top level, each by name.
 *
 * A flow's row wears the glyph of the trigger it starts from — the one fact that says what kind of
 * automation it is before it is opened. A flow made global on another workspace's shelf sits at the
 * top level here, since the folder it is filed in belongs to that other workspace.
 */
export function FlowExplorer() {
  const flows = useFlowsStore((s) => s.flows);
  const folders = useFlowsStore((s) => s.folders);
  const collapsed = useFlowsStore((s) => s.collapsed);
  const query = useFlowsStore((s) => s.query);
  const activeId = useFlowsStore((s) => s.activeId);
  const pane = useFlowRunsStore((s) => s.pane);
  const workspaceId = useFlowsStore((s) => s.workspaceId);
  const catalogMap = useFlowsStore((s) => s.catalogMap);
  const t = useT();
  const [templatesFor, setTemplatesFor] = useState<{ folderId: string | null } | null>(null);
  const [shareFor, setShareFor] = useState<string | null>(null);
  const shares = useFlowShareStore((s) => s.shares);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; heading?: string } | null>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const repoEntries = useFlowRepoStore((s) => s.entries);
  const projects = useWorkspaceStore((s) => (workspaceId ? s.projectsByWorkspace[workspaceId] : undefined)) ?? [];
  const [repoOpen, setRepoOpen] = useState(true);

  // The repositories' flow files: read when the explorer shows, and again when the window comes back
  // — a `git pull` happens outside the app.
  useEffect(() => {
    void useFlowRepoStore.getState().scan(workspaceId);
    const onFocus = () => void useFlowRepoStore.getState().scan(useFlowsStore.getState().workspaceId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [workspaceId]);
  const unlinked = useMemo(() => repoEntries.filter((entry) => !entry.flowId && !entry.missing), [repoEntries]);

  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const matches = (flow: FlowItem) => !needle || flow.name.toLowerCase().includes(needle);
    const here = new Set(folders.map((folder) => folder.id));
    const sortedFolders = [...folders].sort(byName).map((folder) => ({
      folder,
      flows: flows.filter((flow) => flow.folder_id === folder.id && matches(flow)).sort(byName),
    }));
    const root = flows
      .filter((flow) => (!flow.folder_id || !here.has(flow.folder_id)) && matches(flow))
      .sort(byName);
    return {
      folders: needle ? sortedFolders.filter((group) => group.flows.length > 0) : sortedFolders,
      root,
    };
  }, [flows, folders, needle]);

  const store = () => useFlowsStore.getState();

  const triggerGlyph = (flow: FlowItem) => {
    const descriptor = flow.triggers[0] ? catalogMap.get(flow.triggers[0]) : undefined;
    return descriptor ? nodeIcon(descriptor.icon) : Waypoints;
  };

  const flowMenu = (event: ReactMouseEvent, flow: FlowItem) => {
    event.preventDefault();
    const anchor = { x: event.clientX, y: event.clientY };
    const own = flow.workspace_id === workspaceId;
    const items: MenuItem[] = [
      {
        label: t("flows.rename"),
        icon: Pencil,
        onClick: () =>
          void promptAction(t("flows.renamePrompt"), { initial: flow.name, confirmLabel: t("flows.rename") }).then(
            (value) => value && void store().renameFlow(flow.id, value),
          ),
      },
      { label: t("flows.duplicate"), icon: Copy, onClick: () => void store().duplicateFlow(flow.id) },
      { label: t("flows.export"), icon: Download, onClick: () => void store().exportFlow(flow.id) },
      { label: t("flows.share.menu"), icon: Users, onClick: () => setShareFor(flow.id) },
    ];
    // Kept in a repository: saved into its file, brought from it, or let go of it.
    const link = repoEntries.find((entry) => entry.flowId === flow.id);
    const repo = useFlowRepoStore.getState();
    if (link) {
      items.push(
        { label: t("flows.repo.save"), icon: GitBranch, separated: true, onClick: () => void repo.save(flow.id, null) },
        { label: t("flows.repo.pull"), icon: GitPullRequestArrow, disabled: link.missing, onClick: () => void repo.pull(flow.id) },
        { label: t("flows.repo.unlink"), icon: Unlink, onClick: () => void repo.unlink(flow.id) },
      );
    } else if (own && projects.length > 0) {
      items.push({
        label: t("flows.repo.saveIn"),
        icon: GitBranch,
        separated: true,
        onClick: () => {},
        children: [...projects]
          .sort(byName)
          .map((project) => ({ label: project.name, onClick: () => void repo.save(flow.id, project.id) })),
      });
    }
    if (flow.triggers.some((type) => type !== "trigger.manual")) {
      items.push({
        label: flow.active ? t("flows.active.pause") : t("flows.active.activate"),
        icon: flow.active ? Pause : Play,
        onClick: () => void store().setActive(flow.id, !flow.active),
      });
    }
    if (own && folders.length > 0) {
      items.push({
        label: t("flows.moveTo"),
        icon: FolderInput,
        onClick: () => {},
        children: [
          { label: t("flows.root"), onClick: () => void store().moveFlow(flow.id, null), disabled: !flow.folder_id },
          ...[...folders].sort(byName).map((folder) => ({
            label: folder.name,
            icon: Folder,
            onClick: () => void store().moveFlow(flow.id, folder.id),
            disabled: flow.folder_id === folder.id,
          })),
        ],
      });
    }
    items.push(
      ...scopeMenuItems({
        scope: flow.scope,
        anchor,
        openMenu: setMenu,
        onSetGlobal: (global) => void store().setScope(flow.id, global),
        onMoveToWorkspace: (target) => void store().moveToWorkspace(flow.id, target),
        separated: true,
      }),
      {
        label: t("flows.delete"),
        icon: Trash2,
        danger: true,
        separated: true,
        onClick: () =>
          void confirmAction(t("flows.deleteConfirm", { name: flow.name }), true, t("flows.delete")).then(
            (ok) => ok && void store().deleteFlow(flow.id),
          ),
      },
    );
    setMenu({ ...anchor, items });
  };

  const folderMenu = (event: ReactMouseEvent, folder: FlowFolderRow) => {
    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: t("flows.newFlowHere"), icon: Plus, onClick: () => void store().createFlow(folder.id) },
        { label: t("flows.importHere"), icon: Upload, onClick: () => void store().importFlow(folder.id) },
        { label: t("flows.tpl.here"), icon: LayoutTemplate, onClick: () => setTemplatesFor({ folderId: folder.id }) },
        {
          label: t("flows.rename"),
          icon: Pencil,
          onClick: () =>
            void promptAction(t("flows.renameFolderPrompt"), { initial: folder.name, confirmLabel: t("flows.rename") }).then(
              (value) => value && void store().renameFolder(folder.id, value),
            ),
        },
        {
          label: t("flows.delete"),
          icon: Trash2,
          danger: true,
          separated: true,
          onClick: () =>
            void confirmAction(t("flows.deleteFolderConfirm", { name: folder.name }), true, t("flows.delete")).then(
              (ok) => ok && void store().deleteFolder(folder.id),
            ),
        },
      ],
    });
  };

  const flowRow = (flow: FlowItem, nested: boolean) => {
    const Glyph = triggerGlyph(flow);
    return (
      <button
        key={flow.id}
        type="button"
        role="treeitem"
        aria-selected={flow.id === activeId}
        onClick={() => {
          void store().openFlow(flow.id);
          if (useFlowRunsStore.getState().pane === "schedule") useFlowRunsStore.getState().setPane("editor");
        }}
        onContextMenu={(event) => flowMenu(event, flow)}
        title={`${flow.name} · ${t("flows.nodeCount", { n: flow.node_count })}`}
        className={rowClass(flow.id === activeId, `h-7 ${nested ? "pl-7" : ""}`)}
      >
        <span className="relative shrink-0">
          <Glyph size={14} className="text-[var(--cf-text-muted)]" />
          {flow.active && (
            <span
              className="absolute -bottom-[2px] -right-[2px] h-[6px] w-[6px] rounded-full bg-[var(--cf-success)] shadow-[0_0_0_1.5px_var(--cf-surface)]"
              title={t("flows.active.on")}
            />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{flow.name}</span>
        {shares[flow.id] && (
          <span
            className={`shrink-0 ${shares[flow.id].conflict || shares[flow.id].lastError ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-faint)]"}`}
            title={shares[flow.id].conflict ? t("flows.share.conflictChip") : shares[flow.id].lastError || t("flows.share.shared")}
          >
            <Users size={12} />
          </span>
        )}
        {flow.scope === "global" && (
          <span className="shrink-0 text-[var(--cf-text-faint)]" title={t("flows.global")}>
            <Globe size={12} />
          </span>
        )}
        {linkBadge(flow.id)}
      </button>
    );
  };

  /** A linked flow's mark: which file it is, and — amber — that the two sides no longer agree. */
  const linkBadge = (flowId: string) => {
    const link = repoEntries.find((entry) => entry.flowId === flowId);
    if (!link) return null;
    const where = `${link.projectName} · ${link.path}`;
    const title = link.missing
      ? t("flows.repo.missing", { where })
      : link.fileChanged
        ? t("flows.repo.fileChanged", { where })
        : link.flowChanged
          ? t("flows.repo.flowChanged", { where })
          : t("flows.repo.linked", { where });
    return (
      <span className={`shrink-0 ${link.missing || link.fileChanged ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-faint)]"}`} title={title}>
        <GitBranch size={12} />
      </span>
    );
  };

  const empty = groups.root.length === 0 && groups.folders.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {templatesFor && <TemplatesDialog folderId={templatesFor.folderId} onClose={() => setTemplatesFor(null)} />}
      {shareFor && <FlowShareDialog flowId={shareFor} onClose={() => setShareFor(null)} />}
      <div className={explorerHeadClass}>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-muted)]">
          {t("flows.title")}
        </span>
        <button
          type="button"
          className={iconButtonClass({ size: "sm", active: pane === "schedule" })}
          title={t("flows.schedule.title")}
          aria-label={t("flows.schedule.title")}
          aria-pressed={pane === "schedule"}
          onClick={() => useFlowRunsStore.getState().setPane(pane === "schedule" ? "editor" : "schedule")}
          data-tour="flows-schedule-button"
        >
          <CalendarClock size={14} />
        </button>
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          title={t("flows.newFolder")}
          aria-label={t("flows.newFolder")}
          onClick={() =>
            void promptAction(t("flows.newFolderPrompt"), { confirmLabel: t("flows.create") }).then(
              (value) => value && void store().createFolder(value),
            )
          }
        >
          <FolderPlus size={14} />
        </button>
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          title={t("flows.import")}
          aria-label={t("flows.import")}
          onClick={() => void store().importFlow(null)}
          data-tour="flows-import"
        >
          <Upload size={14} />
        </button>
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          title={t("flows.tpl.title")}
          aria-label={t("flows.tpl.title")}
          onClick={() => setTemplatesFor({ folderId: null })}
        >
          <LayoutTemplate size={14} />
        </button>
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          title={t("flows.collab.title")}
          aria-label={t("flows.collab.title")}
          onClick={() => useFlowShareStore.getState().openCollab()}
          data-tour="flows-collab"
        >
          <Users size={14} />
        </button>
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          title={t("flows.newFlow")}
          aria-label={t("flows.newFlow")}
          onClick={() => void store().createFlow(null)}
          data-tour="flows-new"
        >
          <Plus size={15} />
        </button>
      </div>

      <div className="relative mx-2 mb-1.5 shrink-0" data-tour="flows-search">
        <Search
          size={12}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
        />
        <input
          ref={searchField}
          value={query}
          onChange={(event) => store().setQuery(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && store().setQuery("")}
          placeholder={t("flows.searchPlaceholder")}
          aria-label={t("flows.searchPlaceholder")}
          spellCheck={false}
          className={fieldClass({ size: "sm", className: "w-full pl-6 pr-6" })}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              store().setQuery("");
              searchField.current?.focus();
            }}
            aria-label={t("flows.clearSearch")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={12} />
          </button>
        )}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
        role="tree"
        aria-label={t("flows.title")}
        data-tour="flows-tree"
      >
        {groups.folders.map(({ folder, flows: inFolder }) => {
          // While searching, a folder with matches is shown open whatever its stored state.
          const open = needle ? true : !collapsed.includes(folder.id);
          return (
            <div key={folder.id} role="group">
              <button
                type="button"
                role="treeitem"
                aria-expanded={open}
                onClick={() => store().toggleFolder(folder.id)}
                onContextMenu={(event) => folderMenu(event, folder)}
                className={rowClass(false, "h-7 font-medium text-[var(--cf-text-muted)]")}
              >
                {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                {open ? <FolderOpen size={14} className="shrink-0" /> : <Folder size={14} className="shrink-0" />}
                <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-faint)]">{inFolder.length || ""}</span>
              </button>
              {open && inFolder.map((flow) => flowRow(flow, true))}
            </div>
          );
        })}
        {groups.root.map((flow) => flowRow(flow, false))}
        {empty && needle && <p className="px-2 py-4 text-center text-[12px] text-[var(--cf-text-muted)]">{t("flows.noMatches")}</p>}
        {/* Flow files in the repositories no flow here is linked to: one click brings one in. */}
        {unlinked.length > 0 && !needle && (
          <div role="group" className="mt-1">
            <button
              type="button"
              role="treeitem"
              aria-expanded={repoOpen}
              onClick={() => setRepoOpen((open) => !open)}
              className={rowClass(false, "h-7 font-medium text-[var(--cf-text-muted)]")}
              title={t("flows.repo.sectionHint")}
            >
              {repoOpen ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
              <GitBranch size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("flows.repo.section")}</span>
              <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-faint)]">{unlinked.length}</span>
            </button>
            {repoOpen &&
              unlinked.map((entry) => (
                <button
                  key={`${entry.projectId}/${entry.path}`}
                  type="button"
                  role="treeitem"
                  disabled={!!entry.error}
                  onClick={() => void useFlowRepoStore.getState().importFile(entry, null)}
                  title={entry.error ? `${entry.path}: ${entry.error}` : t("flows.repo.importHint", { name: entry.name, where: `${entry.projectName} · ${entry.path}` })}
                  className={rowClass(false, "h-7 pl-7 disabled:opacity-50")}
                >
                  <FileJson size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-[10.5px] text-[var(--cf-text-faint)]">{entry.projectName}</span>
                </button>
              ))}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} heading={menu.heading} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
