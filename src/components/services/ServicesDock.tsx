import { memo, useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ChevronDown,
  ChevronRight,
  CirclePlay,
  FolderPlus,
  Pencil,
  Plus,
  RotateCw,
  SplitSquareHorizontal,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { Tooltip } from "../common/Tooltip";
import { TerminalPane } from "../terminal/TerminalPane";
import { ProfileMenu } from "../terminal/ProfileMenu";
import { ServiceEditor } from "./ServiceEditor";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useT } from "../../state/languageStore";
import { STATUS_TONE, deriveRunning, useServicesStore } from "../../state/servicesStore";
import { activeGroup, useTerminalStore, type TerminalTab } from "../../state/terminalStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";
import { openExternalUrl } from "../../lib/tauri/commands";
import { useShortcutHint } from "../../lib/useShortcutHint";
import { isMainWindow } from "../../lib/windowIdentity";
import { servicePorts, type ServiceRow, type ServiceStatus } from "../../types/services";
import type { RunningService } from "../../state/servicesStore";

const MIN_HEIGHT = 140;
const MAX_HEIGHT = 720;

/**
 * The bottom panel: everything this workspace has running, and everything it can start.
 *
 * # Why services and terminals are one panel
 *
 * They were two lists of the same thing in two places. Both are a process in a folder printing into
 * a pty; the only difference is whether somebody wrote it down. Splitting them meant the daily move
 * — start the group, then open a shell against one of them to poke at it — crossed a rail, a view
 * and a panel. Here it is one list.
 *
 * The split that remains is the one that is real, and it is visible rather than explained: a
 * **service** belongs to the workspace, because the thing being started is a system and a system
 * spans repositories. A **terminal** belongs to the repository it was opened in, because a shell in
 * the frontend folder is about the frontend. Switching repository changes the second section and
 * leaves the first alone, which is exactly what those two scopes mean.
 *
 * # In a satellite
 *
 * Services are main-window-only — one window may start processes (see `servicesStore`) — so a
 * repository window renders the terminals half alone, under its own heading. Same component, one
 * section shorter; the name follows the main case rather than the degenerate one.
 */

/** Kept out of the dock's own render so a burst of output in one pane cannot re-render the others:
 *  the props are ids and a boolean, and the callback comes from a store action that never changes. */
const DockPane = memo(function DockPane({
  projectId,
  tabId,
  visible,
}: {
  projectId: string;
  tabId: string;
  visible: boolean;
}) {
  const close = useCallback(() => {
    void useTerminalStore.getState().close(projectId, tabId);
  }, [projectId, tabId]);
  return <TerminalPane sessionId={tabId} visible={visible} onClose={close} />;
});

/** What the pane area is showing: one service's console, or the active split of terminals. */
type Selection = { kind: "service"; id: string } | { kind: "terminals" };

export function ServicesDock() {
  const t = useT();
  const shortcutHint = useShortcutHint();
  const project = useWorkspaceStore((s) => s.activeProject());
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const byProject = useTerminalStore((s) => s.byProject);
  const openNew = useTerminalStore((s) => s.openNew);
  const closeTab = useTerminalStore((s) => s.close);
  const focusTab = useTerminalStore((s) => s.focus);
  const rename = useTerminalStore((s) => s.rename);
  const togglePanel = useTerminalStore((s) => s.togglePanel);
  const height = useLayoutStore((s) => s.sizes.terminalPanelHeight);
  const listWidth = useLayoutStore((s) => s.sizes.servicesListWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const services = useServicesStore((s) => s.services);
  const groups = useServicesStore((s) => s.groups);
  // Subscribed to the two maps, then derived — see `deriveRunning`. This is what makes a service
  // started in another workspace reachable at all: the list above holds one workspace, and a
  // process does not stop because you looked somewhere else.
  const runtimeMap = useServicesStore((s) => s.runtime);
  const runningInfo = useServicesStore((s) => s.runningInfo);
  const loadServices = useServicesStore((s) => s.load);
  const addGroup = useServicesStore((s) => s.addGroup);
  const stopAll = useServicesStore((s) => s.stopAll);

  /** Services exist only where they can be started. See the note at the top. */
  const showServices = isMainWindow();

  const [selection, setSelection] = useState<Selection>({ kind: "terminals" });
  const [editing, setEditing] = useState<ServiceRow | "new" | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [resizing, setResizing] = useState(false);

  const activeProjectId = project?.id ?? null;
  const activeProj = activeProjectId ? byProject[activeProjectId] : undefined;
  const visibleIds = activeGroup(activeProj);

  useEffect(() => {
    if (showServices && workspaceId) void loadServices(workspaceId);
  }, [showServices, workspaceId, loadServices]);

  /**
   * Opening the panel opens a shell, exactly as it did when this was the terminal dock.
   *
   * The reason to press ⌃` is to type a command, and "no terminals open — click + to start one" is
   * a button press standing between the user and that. Keyed on the project rather than on the tab
   * count, so closing the last terminal leaves it closed instead of spawning its replacement on the
   * spot — and so StrictMode's double-invoked effects cannot open two.
   */
  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    if (!project || autoOpened.current.has(project.id)) return;
    if ((activeProj?.tabs.length ?? 0) > 0) return;
    autoOpened.current.add(project.id);
    void openNew(project.id, project.local_path).catch((e: unknown) => pushErrorToast(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const commitRename = () => {
    const id = renamingId;
    setRenamingId(null);
    if (id && project) rename(project.id, id, renameValue);
  };

  // Every terminal ever opened stays mounted, hidden unless it belongs to the active project and to
  // its current split — so switching project never kills a shell or loses its scrollback.
  const allPanes = Object.entries(byProject).flatMap(([projectId, proj]) =>
    proj.tabs.map((tab) => ({
      projectId,
      tab,
      visible:
        selection.kind === "terminals" &&
        projectId === activeProjectId &&
        visibleIds.includes(tab.id),
    })),
  );

  const newGroup = async () => {
    if (!workspaceId) return;
    const name = await promptAction(t("services.newGroup"), {
      placeholder: t("services.groupNamePlaceholder"),
      confirmLabel: t("services.createGroup"),
    });
    if (name?.trim()) await addGroup(workspaceId, name.trim());
  };

  const ungrouped = services.filter((s) => !s.group_id);
  const sections = [
    ...(ungrouped.length ? [{ id: null as string | null, name: t("services.ungrouped"), services: ungrouped }] : []),
    ...groups.map((group) => ({
      id: group.id,
      name: group.name,
      services: services.filter((s) => s.group_id === group.id),
    })),
  ];

  const elsewhere = deriveRunning(runtimeMap, runningInfo, workspaceId).filter((r) => r.foreign);

  const selectedService =
    selection.kind === "service" ? (services.find((s) => s.id === selection.id) ?? null) : null;
  /** Subscribed, not read with `getState()`: this is the one status on screen that has to change
   *  as the service does, and a snapshot taken during render never would. */
  const selectedStatus = useServicesStore((s) =>
    selection.kind === "service" ? (s.runtime[selection.id]?.status ?? "stopped") : "stopped",
  );

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height, opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      // Off while dragging: `animate` eases toward every height the drag hands it, so the panel
      // would trail the pointer by the whole duration.
      transition={resizing ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }}
      data-tour="terminal-dock"
      // Shrinkable, and `min-h-0` with it: at `shrink-0` a panel taller than the room left in the
      // column overflows under the status bar, which paints on top — taking the prompt with it.
      className="flex min-h-0 flex-col overflow-hidden bg-[var(--cf-surface)]"
    >
      <ResizeHandle
        axis="y"
        value={height}
        min={MIN_HEIGHT}
        max={MAX_HEIGHT}
        invert
        onChange={(h) => setSize("terminalPanelHeight", h)}
        onCommit={(h) => commitSize("terminalPanelHeight", h)}
        onDragChange={setResizing}
      />

      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2">
        {showServices ? (
          <CirclePlay size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <TerminalSquare size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        )}
        <span className="mr-2 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
          {showServices ? t("services.title") : t("terminal.title")}
        </span>

        {/* What the header says about the selection, so the panel names what the pane is showing
            rather than leaving it to be inferred from a highlighted row. */}
        {selectedService && (
          <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
            <span
              aria-hidden
              className={`h-2 w-2 shrink-0 rounded-full ${selectedStatus === "starting" ? "animate-pulse" : ""}`}
              style={{ background: STATUS_TONE[selectedStatus] }}
            />
            <span className="truncate text-[var(--cf-text)]">{selectedService.name}</span>
            <span className="shrink-0 text-[var(--cf-text-muted)]">
              {t(`services.status.${selectedStatus}` as "services.status.ready")}
            </span>
          </span>
        )}

        <div className="flex-1" />

        {showServices && services.length > 0 && (
          <Tooltip side="top" label={t("services.stopAll")} description={t("services.stopAllHint")}>
            <button
              onClick={() => void stopAll()}
              aria-label={t("services.stopAll")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.08]"
            >
              <Square size={12} />
            </button>
          </Tooltip>
        )}
        <button
          onClick={togglePanel}
          title={t("terminal.hide")}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
        >
          <ChevronDown size={13} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* The list. Vertical rather than the strip of tabs this panel used to have, because a
            service needs a status dot, a port and a group above it — none of which fit on a tab. */}
        <div
          className="flex min-h-0 shrink-0 flex-col overflow-y-auto border-r border-[var(--cf-border)]"
          style={{ width: listWidth }}
        >
          {showServices && (
            <>
              <SectionHeader
                icon={CirclePlay}
                label={t("services.title")}
                actions={
                  <>
                    <HeaderButton onClick={() => void newGroup()} label={t("services.newGroup")}>
                      <FolderPlus size={11} />
                    </HeaderButton>
                    <HeaderButton onClick={() => setEditing("new")} label={t("services.newService")}>
                      <Plus size={11} />
                    </HeaderButton>
                  </>
                }
              />
              {services.length === 0 && (
                <button
                  onClick={() => setEditing("new")}
                  className="mx-1.5 mb-1 rounded border border-dashed border-[var(--cf-border)] px-2 py-2 text-left text-[11px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                >
                  {t("services.dockEmpty")}
                </button>
              )}
              {sections.map((section) => (
                <GroupSection
                  key={section.id ?? "ungrouped"}
                  groupId={section.id}
                  name={section.name}
                  services={section.services}
                  collapsed={collapsed.has(section.id ?? "ungrouped")}
                  onToggle={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      const key = section.id ?? "ungrouped";
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  selectedId={selection.kind === "service" ? selection.id : null}
                  onSelect={(id) => setSelection({ kind: "service", id })}
                  onEdit={setEditing}
                />
              ))}
            </>
          )}

          {/* Still running, just not from here. Without this the panel would be telling the truth
              about one workspace while six containers ran in another, unreachable — no console, no
              stop, and a status-bar count that had to guess. The row is a way *back*, not a remote
              control: it stops, or it takes you to where the service lives. */}
          {showServices && elsewhere.length > 0 && (
            <>
              <SectionHeader icon={CirclePlay} label={t("services.elsewhere")} />
              {elsewhere.map((run) => (
                <ElsewhereRow key={run.id} run={run} />
              ))}
            </>
          )}

          <SectionHeader
            icon={TerminalSquare}
            label={project ? t("terminal.forRepo", { name: project.name }) : t("terminal.title")}
            actions={
              <>
                <HeaderButton
                  onClick={() => project && void openNew(project.id, project.local_path)}
                  disabled={!project}
                  label={shortcutHint("terminal.new", t("terminal.new"))}
                >
                  <Plus size={11} />
                </HeaderButton>
                <ProfileMenu
                  disabled={!project}
                  onPick={(profileId) =>
                    project && void openNew(project.id, project.local_path, { profileId })
                  }
                />
              </>
            }
          />
          {!project && (
            <p className="px-2.5 py-2 text-[11px] text-[var(--cf-text-muted)]">
              {t("terminal.noProject")}
            </p>
          )}
          {(activeProj?.tabs ?? []).map((tab) => (
            <TerminalRow
              key={tab.id}
              tab={tab}
              inSplit={visibleIds.includes(tab.id)}
              selected={selection.kind === "terminals" && visibleIds.includes(tab.id)}
              renaming={renamingId === tab.id}
              renameValue={renameValue}
              onRenameChange={setRenameValue}
              onRenameStart={() => {
                setRenamingId(tab.id);
                setRenameValue(tab.title);
              }}
              onRenameCommit={commitRename}
              onRenameCancel={() => setRenamingId(null)}
              onSelect={() => {
                setSelection({ kind: "terminals" });
                if (project) focusTab(project.id, tab.id);
              }}
              onSplit={() =>
                project && void openNew(project.id, project.local_path, { split: true })
              }
              onClose={() => project && void closeTab(project.id, tab.id)}
            />
          ))}
        </div>

        <ResizeHandle
          axis="x"
          value={listWidth}
          min={160}
          max={400}
          onChange={(w) => setSize("servicesListWidth", w)}
          onCommit={(w) => commitSize("servicesListWidth", w)}
        />

        {/* The pane area. Every terminal stays mounted here whatever is selected; a service's
            console mounts on top of them when one is picked. */}
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {selection.kind === "service" ? (
            <ServiceConsole service={selectedService} />
          ) : (
            <>
              {!project ? (
                <div className="absolute inset-0">
                  <EmptyState icon={TerminalSquare} title={t("terminal.noProject")} />
                </div>
              ) : (activeProj?.tabs.length ?? 0) === 0 ? (
                <div className="absolute inset-0">
                  <EmptyState icon={TerminalSquare} title={t("terminal.emptyHint")} />
                </div>
              ) : null}
            </>
          )}
          {allPanes.map(({ projectId, tab, visible }) => (
            <div
              key={tab.id}
              className={
                visible
                  ? `flex min-w-0 flex-1 flex-col ${tab.id !== visibleIds[visibleIds.length - 1] ? "border-r border-[var(--cf-border)]" : ""}`
                  : "hidden"
              }
            >
              {/* The pane's own project, not the selected one: every project's terminals are
                  mounted here at once, and closing one from its menu has to reach the store under
                  the id it actually belongs to. */}
              <DockPane projectId={projectId} tabId={tab.id} visible={visible} />
            </div>
          ))}
        </div>
      </div>

      {editing && workspaceId && (
        <ServiceEditor
          workspaceId={workspaceId}
          service={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </motion.div>
  );
}

function SectionHeader({
  icon: Icon,
  label,
  actions,
}: {
  icon: typeof CirclePlay;
  label: string;
  actions?: React.ReactNode;
}) {
  return (
    // Not sticky. Two sticky headers in one scroll container pin on top of each other rather than
    // pushing, and the list is short enough that scrolling past a heading is not a way to get lost.
    <div className="flex items-center gap-1 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1 first:border-t-0">
      <Icon size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
      <span className="min-w-0 flex-1 truncate text-[10px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
        {label}
      </span>
      {actions}
    </div>
  );
}

function HeaderButton({
  onClick,
  label,
  disabled,
  children,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-40 dark:hover:bg-white/[0.08]"
    >
      {children}
    </button>
  );
}

function GroupSection({
  groupId,
  name,
  services,
  collapsed,
  onToggle,
  selectedId,
  onSelect,
  onEdit,
}: {
  groupId: string | null;
  name: string;
  services: ServiceRow[];
  collapsed: boolean;
  onToggle: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (service: ServiceRow) => void;
}) {
  const startGroup = useServicesStore((s) => s.startGroup);
  const renameGroup = useServicesStore((s) => s.renameGroup);
  const removeGroup = useServicesStore((s) => s.removeGroup);
  const t = useT();

  const rename = async () => {
    if (!groupId) return;
    const next = await promptAction(t("services.renameGroup"), { initial: name });
    if (next?.trim()) await renameGroup(groupId, next.trim());
  };

  const remove = async () => {
    if (!groupId) return;
    // Spelled out, because the obvious fear is the wrong one: the services survive, only the
    // folder goes.
    if (await confirmAction(t("services.deleteGroupConfirm", { name }))) await removeGroup(groupId);
  };

  return (
    <div>
      <div className="group/section flex items-center gap-1 px-2 py-0.5">
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] text-[var(--cf-text-muted)]"
        >
          {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
          <span className="truncate">{name}</span>
          <span className="shrink-0 tabular-nums opacity-60">{services.length}</span>
        </button>
        {/* Always drawn, not hover-revealed: starting the group is the button this panel exists
            for. The two that only edit the filing are the ones that hide. */}
        <Tooltip side="top" label={t("services.startGroup")} description={t("services.startGroupHint")}>
          <button
            onClick={() => void startGroup(groupId)}
            aria-label={`${name} — ${t("services.startGroup")}`}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-success)] dark:hover:bg-white/[0.08]"
          >
            <CirclePlay size={11} />
          </button>
        </Tooltip>
        {groupId && (
          <>
            <button
              onClick={() => void rename()}
              title={t("services.renameGroup")}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:bg-black/[0.05] group-hover/section:opacity-100 dark:hover:bg-white/[0.08]"
            >
              <Pencil size={10} />
            </button>
            <button
              onClick={() => void remove()}
              title={t("services.deleteGroup")}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:bg-black/[0.05] hover:text-[var(--cf-danger)] group-hover/section:opacity-100 dark:hover:bg-white/[0.08]"
            >
              <Trash2 size={10} />
            </button>
          </>
        )}
      </div>
      {!collapsed &&
        services.map((service) => (
          <ServiceRowItem
            key={service.id}
            service={service}
            selected={service.id === selectedId}
            onSelect={() => onSelect(service.id)}
            onEdit={() => onEdit(service)}
          />
        ))}
    </div>
  );
}

function ServiceRowItem({
  service,
  selected,
  onSelect,
  onEdit,
}: {
  service: ServiceRow;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const runtime = useServicesStore((s) => s.runtime[service.id]);
  const services = useServicesStore((s) => s.services);
  const start = useServicesStore((s) => s.start);
  const stop = useServicesStore((s) => s.stop);
  const restart = useServicesStore((s) => s.restart);
  const remove = useServicesStore((s) => s.remove);
  const t = useT();

  const status: ServiceStatus = runtime?.status ?? "stopped";
  const running = status === "ready" || status === "starting";
  const ports = servicePorts(service);
  const blocker = runtime?.blockedBy
    ? services.find((s) => s.id === runtime.blockedBy)?.name
    : null;

  return (
    <div
      className={`group/row flex items-center gap-1.5 px-2 py-[3px] pl-4 text-[12px] ${
        selected
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-text)]"
          : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      <button onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${status === "starting" ? "animate-pulse" : ""}`}
          style={{ background: STATUS_TONE[status] }}
        />
        <span className="min-w-0 flex-1 truncate">{service.name}</span>
        <span className="sr-only">{t(`services.status.${status}` as "services.status.ready")}</span>
      </button>

      {/* Why nothing is happening, on the row that is not happening. */}
      {status === "waiting" && blocker && (
        <span className="shrink-0 truncate text-[10px] opacity-70">{blocker}</span>
      )}

      {ports.length > 0 && status === "ready" && (
        <button
          onClick={() => void openExternalUrl(`http://localhost:${ports[0]}`)}
          title={`http://localhost:${ports[0]}`}
          className="shrink-0 rounded border border-[var(--cf-border)] px-1 text-[10px] tabular-nums text-[var(--cf-accent)] hover:border-[var(--cf-accent)]"
        >
          :{ports[0]}
        </button>
      )}

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/row:opacity-100">
        {running ? (
          <>
            <RowButton onClick={() => void restart(service.id)} label={t("services.restart")}>
              <RotateCw size={10} />
            </RowButton>
            <RowButton onClick={() => void stop(service.id)} label={t("services.stop")} danger>
              <Square size={10} />
            </RowButton>
          </>
        ) : (
          <RowButton onClick={() => void start(service.id)} label={t("services.start")}>
            <CirclePlay size={10} />
          </RowButton>
        )}
        <RowButton onClick={onEdit} label={t("services.edit")}>
          <Pencil size={10} />
        </RowButton>
        <RowButton
          onClick={async () => {
            if (await confirmAction(t("services.deleteConfirm", { name: service.name }))) {
              await remove(service.id);
            }
          }}
          label={t("services.delete")}
          danger
        >
          <Trash2 size={10} />
        </RowButton>
      </div>
    </div>
  );
}

/**
 * A service running in a workspace other than the one on screen.
 *
 * Two things only. **Stop** works from here because stopping is addressed to a session id and needs
 * no context — and because the whole reason you found this row is that you forgot it was running.
 * **Go there** switches workspace, which is the honest way to reach everything else: its console,
 * its dependencies, its editor. Anything more would be operating a service through a keyhole.
 */
function ElsewhereRow({ run }: { run: RunningService }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const stop = useServicesStore((s) => s.stop);
  const t = useT();

  const workspace = workspaces.find((w) => w.id === run.workspaceId) ?? null;

  return (
    <div className="group/row flex items-center gap-1.5 px-2 py-[3px] pl-4 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${run.status === "starting" ? "animate-pulse" : ""}`}
        style={{ background: STATUS_TONE[run.status] }}
      />
      <span className="min-w-0 flex-1 truncate">{run.name}</span>
      {/* The workspace it belongs to, by its own colour — the same dot the switcher and the
          satellites' title bars use, so "which one is that" is answered the same way everywhere. */}
      {workspace && (
        <button
          onClick={() => setActiveWorkspace(workspace.id)}
          title={t("services.goToWorkspace", { name: workspace.name })}
          className="flex shrink-0 items-center gap-1 rounded border border-[var(--cf-border)] px-1 text-[10px] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: workspace.color }} />
          <span className="max-w-[70px] truncate">{workspace.name}</span>
        </button>
      )}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/row:opacity-100">
        <RowButton onClick={() => void stop(run.id)} label={t("services.stop")} danger>
          <Square size={10} />
        </RowButton>
      </div>
    </div>
  );
}

/** One ad-hoc shell in the list. Everything the old tab strip's tab could do, in a row. */
function TerminalRow({
  tab,
  inSplit,
  selected,
  renaming,
  renameValue,
  onRenameChange,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onSelect,
  onSplit,
  onClose,
}: {
  tab: TerminalTab;
  /** Part of the split currently on screen — drawn on every member, not just the focused one, so a
   *  split reads as the pair it is. */
  inSplit: boolean;
  selected: boolean;
  renaming: boolean;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameStart: () => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onSelect: () => void;
  onSplit: () => void;
  onClose: () => void;
}) {
  const t = useT();

  return (
    <div
      onDoubleClick={() => !renaming && onRenameStart()}
      className={`group/row flex items-center gap-1.5 px-2 py-[3px] pl-4 text-[12px] ${
        selected
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-text)]"
          : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      {renaming ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={onRenameCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRenameCommit();
            else if (e.key === "Escape") onRenameCancel();
          }}
          className="min-w-0 flex-1 rounded-sm border border-[var(--cf-accent)] bg-transparent px-1 text-[12px] text-[var(--cf-text)] outline-none"
        />
      ) : (
        <>
          <button onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <TerminalSquare
              size={10}
              className={`shrink-0 ${inSplit ? "text-[var(--cf-accent)]" : "opacity-60"}`}
            />
            <span className="min-w-0 flex-1 truncate" title={tab.title}>
              {tab.title}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/row:opacity-100">
            <RowButton onClick={onSplit} label={t("terminal.split")}>
              <SplitSquareHorizontal size={10} />
            </RowButton>
            <RowButton onClick={onRenameStart} label={t("terminal.rename")}>
              <Pencil size={10} />
            </RowButton>
            <RowButton onClick={onClose} label={t("terminal.close")} danger>
              <X size={10} />
            </RowButton>
          </div>
        </>
      )}
    </div>
  );
}

function RowButton({
  onClick,
  label,
  danger,
  children,
}: {
  onClick: () => void;
  label: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
      className={`flex h-4 w-4 items-center justify-center rounded hover:bg-black/[0.05] dark:hover:bg-white/[0.08] ${
        danger ? "hover:text-[var(--cf-danger)]" : "hover:text-[var(--cf-text)]"
      }`}
    >
      {children}
    </button>
  );
}

/** The selected service's console, or its command and a play button when it is not running. */
function ServiceConsole({ service }: { service: ServiceRow | null }) {
  const runtime = useServicesStore((s) => (service ? s.runtime[service.id] : undefined));
  const start = useServicesStore((s) => s.start);
  const t = useT();

  if (!service) return <EmptyState icon={CirclePlay} title={t("services.pickOne")} />;

  if (!runtime?.sessionId) {
    return (
      <EmptyState
        icon={CirclePlay}
        title={t("services.notRunning")}
        subtitle={
          runtime?.error
            ? runtime.error.startsWith("services.")
              ? t(runtime.error as "services.exited")
              : runtime.error
            : service.command
        }
        action={
          <button
            onClick={() => void start(service.id)}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white"
          >
            <CirclePlay size={13} />
            {t("services.start")}
          </button>
        }
      />
    );
  }

  return (
    <div className="min-w-0 flex-1">
      {/* Keyed on the session, so a restart builds a fresh terminal rather than appending the new
          process's output under the dead one's. */}
      <TerminalPane key={runtime.sessionId} sessionId={runtime.sessionId} visible />
    </div>
  );
}
