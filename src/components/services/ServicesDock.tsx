import { memo, useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, CirclePlay, Pencil, Plus, SplitSquareHorizontal, TerminalSquare, X } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { TerminalPane } from "../terminal/TerminalPane";
import { ProfileMenu } from "../terminal/ProfileMenu";
import { confirmCloseTerminal } from "../terminal/confirmClose";
import { ServiceEditor } from "./ServiceEditor";
import { ServiceImportModal } from "./ServiceImportModal";
import { ServiceConsole } from "./ServiceConsole";
import { PortsPanel } from "./PortsPanel";
import { HeaderButton, PortsRow, SectionHeader, ServiceActions, ServiceList } from "./ServiceList";
import { useLayoutStore } from "../../state/layoutStore";
import { useT } from "../../state/languageStore";
import { STATUS_TONE, useServicesStore } from "../../state/servicesStore";
import { activeGroup, useTerminalStore, type DockView, type TerminalTab } from "../../state/terminalStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";
import { useShortcutHint } from "../../lib/useShortcutHint";
import { isMainWindow } from "../../lib/windowIdentity";
import { folderName, relativeInside } from "../../lib/folderPath";
import type { ServiceRow } from "../../types/services";

const MIN_HEIGHT = 140;
const MAX_HEIGHT = 720;

/**
 * The bottom panel: the shells of the repository on screen, and the services of the workspace —
 * two panels in one dock.
 *
 * # Two panels, one dock
 *
 * Services and terminals were one panel, services above and shells below, and it had grown heavy:
 * the user split it (2026-09-30). In the main window each is a panel of its own now, with its own
 * button at the foot of the projects panel (`SidebarFoot`), and the dock shows one of them at a time
 * (`terminalStore.dockView`). They still share this component, and that is the point of it: the
 * shells stay mounted for as long as the dock is open, whichever panel is showing, so a look at a
 * service's console and back finds a terminal exactly as it was — scrollback, the command still
 * running, all of it. Two docks would unmount one to show the other.
 *
 * Each panel's title row says what it is and carries its actions — "Terminales · repo" with `+` and
 * the shell menu, "Servicios" with detect / group / service — so neither list has a heading of its
 * own: the same word twice, one line apart, was a complaint once already.
 *
 * The scopes are what they were: a **service** belongs to the workspace, because the thing being
 * started is a system and a system spans repositories; a **terminal** belongs to the repository it
 * was opened in. Switching repository changes the terminals and leaves the services alone.
 *
 * # In a satellite
 *
 * Services are main-window-only — one window may start processes (see `servicesStore`) — so a
 * repository window has the terminals alone, exactly as before the split: "Terminal" on top, and
 * the list's own "Terminales · repo" heading with its actions. The split was asked for the main
 * window.
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
    void confirmCloseTerminal(tabId).then((ok) => {
      if (ok) void useTerminalStore.getState().close(projectId, tabId);
    });
  }, [projectId, tabId]);
  return <TerminalPane sessionId={tabId} visible={visible} onClose={close} />;
});

/** What the services panel's pane shows: one service's console, or the machine's ports. `null`
 *  until something is picked. */
type ServiceSelection = { kind: "service"; id: string } | { kind: "ports" };

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
  const dockView = useTerminalStore((s) => s.dockView);
  const hidePanel = useTerminalStore((s) => s.hidePanel);
  const height = useLayoutStore((s) => s.sizes.terminalPanelHeight);
  const listWidth = useLayoutStore((s) => s.sizes.servicesListWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const services = useServicesStore((s) => s.services);
  const groups = useServicesStore((s) => s.groups);
  const runtimeMap = useServicesStore((s) => s.runtime);
  const loadServices = useServicesStore((s) => s.load);

  /** Services exist only where they can be started. See the note at the top. */
  const showServices = isMainWindow();
  /** The panel on screen — always the terminals in a satellite, which has nothing else. */
  const view: DockView = showServices ? dockView : "terminal";

  const [selection, setSelection] = useState<ServiceSelection | null>(null);
  /** The service whose console the pane shows, when that is what is picked. */
  const selectedId = selection?.kind === "service" ? selection.id : null;
  const setSelectedId = (id: string) => setSelection({ kind: "service", id });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [importing, setImporting] = useState(false);

  const activeProjectId = project?.id ?? null;
  const activeProj = activeProjectId ? byProject[activeProjectId] : undefined;
  const visibleIds = activeGroup(activeProj);

  useEffect(() => {
    if (showServices && workspaceId) void loadServices(workspaceId);
  }, [showServices, workspaceId, loadServices]);

  /**
   * Opening the terminal opens a shell, exactly as it did when this was the terminal dock.
   *
   * The reason to press ⌃` is to type a command, and "no terminals open — click + to start one" is
   * a button press standing between the user and that. Keyed on the project rather than on the tab
   * count, so closing the last terminal leaves it closed instead of spawning its replacement on the
   * spot — and so StrictMode's double-invoked effects cannot open two.
   *
   * The terminal panel only: opening the services is not asking for a shell, and one opened then
   * would also pull the dock over to the terminals (`openNew` shows them) — away from the services
   * that were just asked for.
   */
  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    if (view !== "terminal" || !project || autoOpened.current.has(project.id)) return;
    if ((activeProj?.tabs.length ?? 0) > 0) return;
    autoOpened.current.add(project.id);
    void openNew(project.id, project.local_path).catch((e: unknown) => pushErrorToast(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, view]);

  /**
   * A shell in a folder picked from the disk — the subfolder three levels down that `+` (the
   * repository's root) cannot reach without a `cd`. The picker opens at the repository; anywhere
   * is allowed, it is a shell, and it is filed under this repository like every terminal here.
   */
  const openInFolder = async () => {
    // Captured before the dialog: the active repository can change while it is open.
    const target = project;
    if (!target) return;
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: target.local_path });
    if (typeof picked !== "string") return;
    await openNew(target.id, picked).catch((e: unknown) => pushErrorToast(String(e)));
  };

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const commitRename = () => {
    const id = renamingId;
    setRenamingId(null);
    if (id && project) rename(project.id, id, renameValue);
  };

  // Every terminal ever opened stays mounted, hidden unless the terminals are the panel on screen and
  // it belongs to the active project and to its current split — so switching project, or looking at
  // the services, never kills a shell or loses its scrollback.
  const allPanes = Object.entries(byProject).flatMap(([projectId, proj]) =>
    proj.tabs.map((tab) => ({
      projectId,
      tab,
      visible: view === "terminal" && projectId === activeProjectId && visibleIds.includes(tab.id),
    })),
  );

  const selectedService = selectedId ? (services.find((s) => s.id === selectedId) ?? null) : null;
  const servicesEmpty = services.length === 0 && groups.length === 0;

  /** The terminal panel's two ways in: a shell in the repository, or one of the other shells (and
   *  "in a folder…"). In the panel's title row in the main window, in the list's heading in a
   *  satellite — see the note at the top. */
  const terminalActions = (
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
        onPick={(profileId) => project && void openNew(project.id, project.local_path, { profileId })}
        onOpenInFolder={() => void openInFolder()}
      />
    </>
  );
  const terminalsLabel = project ? t("terminal.forRepo", { name: project.name }) : t("terminal.title");
  /** What the title row calls the panel. A satellite keeps the one name it always had, with the
   *  list's heading below it naming the repository. */
  const panelTitle = view === "services" ? t("services.title") : showServices ? terminalsLabel : t("terminal.panelTitle");

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
        {/* The panel on screen and what it covers — the one heading it has. The list below does not
            repeat it: "Servicios" twice, one line apart, was the complaint that once named the
            combined panel after neither half. */}
        {view === "services" ? (
          <CirclePlay size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <TerminalSquare size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        )}
        {/* The name gives way last: capped rather than shrinkable, so a narrow dock cuts the summary
            beside it before it cuts "Servicios" — and a long repository name still ends in "…". */}
        <span className="mr-2 max-w-[60%] shrink-0 truncate text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
          {panelTitle}
        </span>

        {view === "services" && services.length > 0 && (runningHere > 0 || failedHere > 0) && (
          <span className="flex min-w-0 items-center gap-2.5 overflow-hidden whitespace-nowrap text-[11px] text-[var(--cf-text-muted)]">
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
                onClick={() => setSelectedId(firstFailed)}
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

        {showServices && view === "terminal" && terminalActions}

        <button
          onClick={hidePanel}
          title={t("terminal.hide")}
          className="ml-1 flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
        >
          <ChevronDown size={13} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* The list. Vertical rather than the strip of tabs this panel used to have, because a
            service needs a status dot, a port and a group above it — none of which fit on a tab. */}
        <div
          className="flex min-h-0 shrink-0 flex-col border-r border-[var(--cf-border)]"
          style={{ width: listWidth }}
        >
          {view === "services" ? (
            <>
              {/* Detect, new group, new service: small, at the top of the column they act on — not in
                  the panel's title row, where they sat over the console and read as its controls.
                  Not while the list is empty: its two buttons are the same choice with words on them. */}
              {!servicesEmpty && (
                <div className="flex shrink-0 items-center justify-end gap-0.5 px-1.5 pt-1">
                  <ServiceActions
                    size="sm"
                    onNew={(groupId) => setEditing({ service: null, groupId })}
                    onImport={() => setImporting(true)}
                  />
                </div>
              )}
              {/* The services on top, scrolling on their own; the row into the machine's listening
                  ports pinned under them, at the foot of the column, whatever the list's length. */}
              <div className="min-h-0 flex-1 overflow-y-auto">
                <ServiceList
                  heading={false}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onEdit={(service) => setEditing({ service, groupId: service.group_id })}
                  onNew={(groupId) => setEditing({ service: null, groupId })}
                  onImport={() => setImporting(true)}
                />
              </div>
              <div className="flex shrink-0 flex-col border-t border-[var(--cf-border)]">
                <PortsRow selected={selection?.kind === "ports"} onSelect={() => setSelection({ kind: "ports" })} />
              </div>
            </>
          ) : (
            <div className={`min-h-0 flex-1 overflow-y-auto ${showServices ? "pt-1" : ""}`}>
              {!showServices && <SectionHeader icon={TerminalSquare} label={terminalsLabel} actions={terminalActions} />}
              {!project && (
                <p className="px-2.5 py-2 text-[11px] text-[var(--cf-text-muted)]">
                  {t("terminal.noProject")}
                </p>
              )}
              {/* Said in the list, not only in the pane: a list with nothing in it reads as one
                  still loading. */}
              {project && (activeProj?.tabs.length ?? 0) === 0 && (
                <button
                  onClick={() => void openNew(project.id, project.local_path).catch((e: unknown) => pushErrorToast(String(e)))}
                  className={`${showServices ? "ml-4" : "ml-6"} py-0.5 text-left text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]`}
                >
                  {t("terminal.noneOpen")}
                </button>
              )}
              {(activeProj?.tabs ?? []).map((tab) => (
                <TerminalRow
                  key={tab.id}
                  tab={tab}
                  where={project ? whereOf(project.local_path, tab.cwd) : ""}
                  inSplit={visibleIds.includes(tab.id)}
                  selected={visibleIds.includes(tab.id)}
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
                    if (project) focusTab(project.id, tab.id);
                  }}
                  onSplit={() =>
                    project && void openNew(project.id, project.local_path, { split: true })
                  }
                  onClose={() =>
                    project &&
                    void confirmCloseTerminal(tab.id).then((ok) => {
                      if (ok) void closeTab(project.id, tab.id);
                    })
                  }
                />
              ))}
            </div>
          )}
        </div>

        <ResizeHandle
          axis="x"
          value={listWidth}
          min={160}
          max={400}
          onChange={(w) => setSize("servicesListWidth", w)}
          onCommit={(w) => commitSize("servicesListWidth", w)}
        />

        {/* The pane area. Every terminal stays mounted here whichever panel is up; with the
            services on screen, a service's console or the ports mount on top of them. */}
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {view === "services" ? (
            selection?.kind === "ports" ? (
              <PortsPanel onOpenService={setSelectedId} />
            ) : selectedService ? (
              <ServiceConsole
                key={selectedService.id}
                service={selectedService}
                onEdit={() => setEditing({ service: selectedService, groupId: selectedService.group_id })}
              />
            ) : services.length > 0 ? (
              <EmptyState icon={CirclePlay} title={t("services.pickOne")} />
            ) : null
          ) : !project ? (
            <div className="absolute inset-0">
              <EmptyState icon={TerminalSquare} title={t("terminal.noProject")} />
            </div>
          ) : (activeProj?.tabs.length ?? 0) === 0 ? (
            <div className="absolute inset-0">
              <EmptyState icon={TerminalSquare} title={t("terminal.emptyHint")} />
            </div>
          ) : null}
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
          onSaved={(saved) => setSelectedId(saved.id)}
        />
      )}
      {importing && workspaceId && (
        <ServiceImportModal
          workspaceId={workspaceId}
          onClose={() => setImporting(false)}
          onImported={(first) => first && setSelectedId(first.id)}
        />
      )}
    </div>
  );
}

/** Where a shell stands, as its row says it: nothing at the repository's root, where `+` opens every
 *  one of them; the path below it otherwise; the folder's own name when it is outside. */
function whereOf(root: string, cwd: string): string {
  const rel = relativeInside(root, cwd);
  return rel === null ? folderName(cwd) : rel;
}

/** One ad-hoc shell in the list. Everything the old tab strip's tab could do, in a row. */
function TerminalRow({
  tab,
  where,
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
  /** The folder the shell was opened in, when it is not the repository's root — three shells all
   *  called `zsh` are told apart by where they stand. See `whereOf`. */
  where: string;
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
            <span className="min-w-0 flex-1 truncate" title={where ? `${tab.title} — ${tab.cwd}` : tab.title}>
              {tab.title}
              {where && <span className="ml-1.5 font-mono text-[11px] opacity-70">{where}</span>}
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
