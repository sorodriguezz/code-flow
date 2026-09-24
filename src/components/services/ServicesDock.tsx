import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, CirclePlay, Pencil, Plus, SplitSquareHorizontal, TerminalSquare, X } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { TerminalPane } from "../terminal/TerminalPane";
import { ProfileMenu } from "../terminal/ProfileMenu";
import { ServiceEditor } from "./ServiceEditor";
import { ServiceImportModal } from "./ServiceImportModal";
import { ServiceConsole } from "./ServiceConsole";
import { PortsPanel } from "./PortsPanel";
import { HeaderButton, SectionHeader, ServiceList } from "./ServiceList";
import { useLayoutStore } from "../../state/layoutStore";
import { useT } from "../../state/languageStore";
import { STATUS_TONE, useServicesStore } from "../../state/servicesStore";
import { activeGroup, useTerminalStore, type TerminalTab } from "../../state/terminalStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";
import { useShortcutHint } from "../../lib/useShortcutHint";
import { isMainWindow } from "../../lib/windowIdentity";
import type { ServiceRow } from "../../types/services";

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
 * repository window renders the terminals half alone. Same component, one section shorter, and the
 * same name on top: the panel is "Terminal" in every window, and its sections name themselves.
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

/** What the pane area is showing: one service's console, the machine's ports, or the active split
 *  of terminals. */
type Selection = { kind: "service"; id: string } | { kind: "ports" } | { kind: "terminals" };

/** The editor's subject: a service to edit, or a new one filed under a group. */
type Editing = { service: ServiceRow | null; groupId: string | null };

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
  const runtimeMap = useServicesStore((s) => s.runtime);
  const loadServices = useServicesStore((s) => s.load);

  /** Services exist only where they can be started. See the note at the top. */
  const showServices = isMainWindow();

  const [selection, setSelection] = useState<Selection>({ kind: "terminals" });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [importing, setImporting] = useState(false);

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

  const selectedService =
    selection.kind === "service" ? (services.find((s) => s.id === selection.id) ?? null) : null;

  // What the header says about this workspace's services at a glance — the reason to look below.
  const here = services.map((service) => runtimeMap[service.id]).filter(Boolean);
  const runningHere = here.filter((r) => r!.alive).length;
  const failedHere = here.filter((r) => r!.status === "failed").length;
  const firstFailed = services.find((service) => runtimeMap[service.id]?.status === "failed")?.id ?? null;
  const busyHere = here.some((r) => ["waiting", "starting", "stopping", "restarting"].includes(r!.status));

  return (
    <div
      // The second sheet of the work column, under the view. It opens at its height with its
      // contents fading in — not by animating `height`, which relaid out the window every frame.
      style={{ height }}
      data-tour="terminal-dock"
      // Shrinkable, and `min-h-0` with it: at `shrink-0` a panel taller than the room left in the
      // column overflows under the status bar, which paints on top — taking the prompt with it.
      className="cf-sheet cf-panel-in flex min-h-0 flex-col"
    >
      <ResizeHandle
        axis="y"
        value={height}
        min={MIN_HEIGHT}
        max={MAX_HEIGHT}
        invert
        onChange={(h) => setSize("terminalPanelHeight", h)}
        onCommit={(h) => commitSize("terminalPanelHeight", h)}
        seamless
      />

      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2">
        {/* The panel's name, not its first section's: it holds Services *and* Terminals, and the
            list below already heads each of them. Naming the panel after one of them put the word
            "Servicios" twice on screen, one line apart. */}
        <TerminalSquare size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="mr-2 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("terminal.panelTitle")}
        </span>

        {showServices && services.length > 0 && (runningHere > 0 || failedHere > 0) && (
          <span className="flex min-w-0 items-center gap-2.5 text-[11px] text-[var(--cf-text-muted)]">
            {runningHere > 0 && (
              <span className="flex items-center gap-1">
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 rounded-full ${busyHere ? "animate-pulse" : ""}`}
                  style={{ background: busyHere ? STATUS_TONE.starting : STATUS_TONE.ready }}
                />
                {runningHere === 1
                  ? t("services.summaryRunningOne")
                  : t("services.summaryRunning", { count: runningHere })}
              </span>
            )}
            {/* A way to the problem, not only a count of it: the console of the first one that
                failed is where "why" is answered. */}
            {firstFailed && (
              <button
                onClick={() => setSelection({ kind: "service", id: firstFailed })}
                title={t("services.summaryFailedHint")}
                className="flex items-center gap-1 rounded px-1 text-[var(--cf-danger)] hover:bg-[color-mix(in_srgb,var(--cf-danger)_12%,transparent)]"
              >
                <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_TONE.failed }} />
                {t("services.summaryFailed", { count: failedHere })}
              </button>
            )}
          </span>
        )}

        <div className="flex-1" />

        <button
          onClick={togglePanel}
          title={t("terminal.hide")}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
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
            <ServiceList
              selectedId={selection.kind === "service" ? selection.id : null}
              portsSelected={selection.kind === "ports"}
              onSelect={(id) => setSelection({ kind: "service", id })}
              onSelectPorts={() => setSelection({ kind: "ports" })}
              onEdit={(service) => setEditing({ service, groupId: service.group_id })}
              onNew={(groupId) => setEditing({ service: null, groupId })}
              onImport={() => setImporting(true)}
            />
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
                  onPickAccount={(account, title) =>
                    project &&
                    void openNew(project.id, project.local_path, {
                      account: { provider: account.provider, accountId: account.id },
                      title,
                    }).catch((e: unknown) => pushErrorToast(String(e)))
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
          {/* Said in the list, not only in the pane: with a service selected the pane shows its
              console, and an empty heading with nothing under it reads as a list still loading. */}
          {project && (activeProj?.tabs.length ?? 0) === 0 && (
            <button
              onClick={() => void openNew(project.id, project.local_path).catch((e: unknown) => pushErrorToast(String(e)))}
              className="ml-6 py-0.5 text-left text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
            >
              {t("terminal.noneOpen")}
            </button>
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
            selectedService ? (
              <ServiceConsole
                key={selectedService.id}
                service={selectedService}
                onEdit={() => setEditing({ service: selectedService, groupId: selectedService.group_id })}
              />
            ) : (
              <EmptyState icon={CirclePlay} title={t("services.pickOne")} />
            )
          ) : selection.kind === "ports" ? (
            <PortsPanel onOpenService={(id) => setSelection({ kind: "service", id })} />
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
          service={editing.service}
          initialGroupId={editing.groupId}
          onClose={() => setEditing(null)}
          onSaved={(saved) => setSelection({ kind: "service", id: saved.id })}
        />
      )}
      {importing && workspaceId && (
        <ServiceImportModal
          workspaceId={workspaceId}
          onClose={() => setImporting(false)}
          onImported={(first) => first && setSelection({ kind: "service", id: first.id })}
        />
      )}
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
          : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
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
      className={`inline-flex h-[22px] w-[22px] items-center justify-center rounded-md hover:bg-[var(--cf-hover)] ${
        danger ? "hover:text-[var(--cf-danger)]" : "hover:text-[var(--cf-text)]"
      }`}
    >
      {children}
    </button>
  );
}
