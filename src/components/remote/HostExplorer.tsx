import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  Download,
  Bookmark,
  Folder,
  FolderDot,
  FolderOpen,
  FolderPlus,
  FolderTree,
  History,
  Monitor,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Settings2,
  Terminal,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { ResizeHandle } from "../common/ResizeHandle";
import { Tooltip } from "../common/Tooltip";
import { buttonClass, iconButtonClass } from "../common/Button";
import {
  explorerClass,
  explorerHeadClass,
  explorerTitleClass,
  fieldClass,
  rowClass,
} from "../common/recipes";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { useRemoteDragStore } from "../../state/remoteDragStore";
import {
  HostDot,
  KindGlyph,
  OsGlyph,
  SEARCH_INPUT,
  SEARCH_WRAP,
  TEXTAREA,
  ToolbarButton,
} from "./remoteChrome";
import { useHostMenu, useNewConnectionMenu, useOpenPrimary } from "./hostMenu";
import {
  groupHosts,
  hostMatches,
  UNGROUPED,
  useHostLiveness,
  useRemoteStore,
} from "../../state/remoteStore";
import { useLayoutStore } from "../../state/layoutStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { riseDelay } from "../../lib/rise";
import {
  capabilities,
  describeHost,
  hasAddress,
  isAzureKind,
  isCloudKind,
  parseHostSpec,
  type RemoteHostRow,
} from "../../types/remote";

/** What a right-click put on screen: a point, a list, and optionally the question the list answers.
 *  One shape for both the tree's own menus and the (+)'s. */
interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
  heading?: string;
}

const WIDTH_MIN = 200;
const WIDTH_MAX = 480;

/**
 * The host inventory: groups, hosts, and the snippet library under them.
 *
 * The tree is one level deep on purpose. `group_name` is free text on the host row rather than a
 * folder table (see the column's comment in `migrations`), so a group exists exactly while
 * something is in it — there is no empty folder to clean up, and no move operation, only a field.
 * What that gives up is nesting; what it buys is that the whole hierarchy is derived, so it can
 * never disagree with the rows.
 *
 * A host row is three actions, not one. Shell, forwards and screen are peers — which one you want
 * is why you came to this machine — so they are on the row rather than behind a right-click, and
 * they appear on hover so twelve idle hosts don't show thirty-six buttons.
 */
export function HostExplorer({ onImport }: { onImport: () => void }) {
  const width = useLayoutStore((s) => s.sizes.remoteSidebarWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  return (
    <>
      <div data-tour="remote-hosts" style={{ width }} className={`${explorerClass} overflow-hidden`}>
        <HostList onImport={onImport} />
        <HistoryList />
        <SnippetList />
      </div>
      {/* `seamless`: the explorer draws its own hairline, and a seam a pixel beside it doubled it. */}
      <ResizeHandle
        axis="x"
        value={width}
        min={WIDTH_MIN}
        max={WIDTH_MAX}
        seamless
        onChange={(value) => setSize("remoteSidebarWidth", value)}
        onCommit={(value) => void commitSize("remoteSidebarWidth", value)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

function HostList({ onImport }: { onImport: () => void }) {
  const hosts = useRemoteStore((s) => s.hosts);
  const query = useRemoteStore((s) => s.query);
  const setQuery = useRemoteStore((s) => s.setQuery);
  const collapsed = useRemoteStore((s) => s.collapsedGroups);
  const tagFilter = useRemoteStore((s) => s.tagFilter);
  const tagMode = useRemoteStore((s) => s.tagMode);
  const toggleGroup = useRemoteStore((s) => s.toggleGroup);
  const folders = useRemoteStore((s) => s.groups);
  const createGroup = useRemoteStore((s) => s.createGroup);
  const refresh = useRemoteStore((s) => s.refresh);
  const openAllForwards = useRemoteStore((s) => s.openAllForwards);
  const openLog = useRemoteStore((s) => s.openLog);
  const loading = useRemoteStore((s) => s.loading);
  const newConnectionMenu = useNewConnectionMenu();
  const t = useT();

  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);

  // Released over the search box, the toolbar, or off the window entirely: none of those are drop
  // targets, but every one of them still ends the drag. Without this the body keeps `cf-dragging`
  // and the next click lands on a tree that thinks it is still being dragged.
  useEffect(() => {
    const cancel = () => {
      if (!useRemoteDragStore.getState().drag && !useRemoteDragStore.getState().origin) return;
      useRemoteDragStore.getState().end();
      setDragCursor(false);
    };
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []);

  const visible = useMemo(
    () => hosts.filter((host) => hostMatches(host, query, tagFilter, tagMode)),
    [hosts, query, tagFilter, tagMode],
  );
  // The folder rows are passed unfiltered on purpose: a group is hidden by a search only when it
  // has no matching hosts, and an *empty* group has none either way. Dropping it while filtering
  // would make the user's own folder vanish the moment they typed.
  const groups = useMemo(
    () => groupHosts(visible, query.trim() || tagFilter.length > 0 ? [] : folders),
    [visible, folders, query, tagFilter],
  );

  /**
   * The (+): which kind of connection, asked before anything is created.
   *
   * A single "New host" could only ever make one thing — an SSH row — and left the user to find the
   * Type selector, and then the Screen tab, to turn it into what they actually came for. Asking
   * first costs one click and decides the whole shape of the row: see `NEW_CONNECTIONS`.
   */
  const openNewMenu = (x: number, y: number, group = "") =>
    setMenu({ x, y, heading: t("remote.newConnection"), items: newConnectionMenu(group) });

  /** The tree's own background menu — the only place "New group" can live, since an empty tree has
   *  no group heading to right-click. */
  const treeMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    const { clientX: x, clientY: y } = event;
    setMenu({
      x,
      y,
      items: [
        // Two steps rather than six entries here: this menu is also where "New group" lives, and a
        // background menu that opened with the whole connection catalogue would bury it.
        { label: `${t("remote.newConnection")}…`, icon: Plus, onClick: () => openNewMenu(x, y) },
        { label: t("remote.newGroup"), icon: FolderPlus, onClick: () => setCreatingGroup(true) },
      ],
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={explorerHeadClass}>
        <span className={`${explorerTitleClass} flex-1`}>
          <span className="truncate">{t("remote.hosts")}</span>
        </span>
        <ToolbarButton
          icon={Waypoints}
          label={t("remote.allForwards")}
          onClick={openAllForwards}
          size="sm"
        />
        <ToolbarButton icon={ScrollText} label={t("remote.log")} onClick={openLog} size="sm" />
        <ToolbarButton
          icon={Download}
          label={t("remote.importSshConfig")}
          onClick={onImport}
          size="sm"
        />
        <ToolbarButton
          icon={RefreshCw}
          label={t("remote.refresh")}
          onClick={() => void refresh()}
          disabled={loading}
          size="sm"
        />
        {/* Anchored to the button, not to the pointer: a menu that opened wherever the cursor was
            when it happened to be over a toolbar reads as a right-click that fired by accident. */}
        <ToolbarButton
          icon={Plus}
          label={t("remote.newConnection")}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openNewMenu(rect.left, rect.bottom + 4);
          }}
          size="sm"
        />
      </div>

      <div className="shrink-0 px-2.5 pb-1.5">
        <label className={SEARCH_WRAP}>
          <Search size={13} className="shrink-0 text-[var(--cf-text-faint)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("remote.searchHosts")}
            className={SEARCH_INPUT}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("remote.clear")}
              className="-mr-1.5 inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-faint)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
            >
              <X size={12} />
            </button>
          )}
        </label>
      </div>

      <div
        role="tree"
        onContextMenu={treeMenu}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2.5 pt-0.5"
      >
        {creatingGroup && (
          <div className="flex h-[26px] items-center gap-1.5 px-1.5">
            <FolderPlus size={14} className="shrink-0 text-[var(--cf-text-faint)]" />
            <InlineInput
              value=""
              onCommit={(value) => {
                setCreatingGroup(false);
                if (value.trim()) void createGroup(value);
              }}
              onCancel={() => setCreatingGroup(false)}
            />
          </div>
        )}
        {groups.length === 0 && !creatingGroup ? (
          <p className="px-3 py-6 text-center text-[12px] text-[var(--cf-text-faint)]">
            {hosts.length === 0 ? t("remote.noHostsYet") : t("remote.noHostsMatch")}
          </p>
        ) : (
          groups.map(([group, members]) => (
            <GroupSection
              key={group || "__ungrouped__"}
              group={group}
              hosts={members}
              // A filtered tree ignores collapse: hiding a match because its group happened to be
              // collapsed is a search that lies about what it found.
              collapsed={!query.trim() && tagFilter.length === 0 && collapsed.includes(group)}
              onToggle={() => toggleGroup(group)}
              onNewHere={(x, y) => openNewMenu(x, y, group)}
              onNewGroup={() => setCreatingGroup(true)}
              onMenu={setMenu}
            />
          ))
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          heading={menu.heading}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function GroupSection({
  group,
  hosts,
  collapsed,
  onToggle,
  onNewHere,
  onNewGroup,
  onMenu,
}: {
  group: string;
  hosts: RemoteHostRow[];
  collapsed: boolean;
  onToggle: () => void;
  onNewHere: (x: number, y: number) => void;
  onNewGroup: () => void;
  onMenu: (menu: OpenMenu | null) => void;
}) {
  const renameGroup = useRemoteStore((s) => s.renameGroup);
  const deleteGroup = useRemoteStore((s) => s.deleteGroup);
  const hoverDrag = useRemoteDragStore((s) => s.hover);
  const dragging = useRemoteDragStore((s) => s.drag !== null);
  const isTarget = useRemoteDragStore((s) => s.drag !== null && s.overGroup === group && s.overHostId === null);
  const commitDrop = useDrop();
  const [renaming, setRenaming] = useState(false);
  const t = useT();

  const label = group || t("remote.ungrouped");

  /**
   * Deleting a folder, with the one thing worth confirming spelled out.
   *
   * The hosts survive — the backend moves them to ungrouped and never deletes them — so the prompt
   * says exactly that rather than the generic "are you sure": the fear this dialog exists to
   * answer is "am I about to lose my machines", and the answer is no.
   */
  const removeGroup = async () => {
    const message =
      hosts.length > 0
        ? t("remote.deleteGroupWithHosts")
            .replace("{name}", label)
            .replace("{count}", String(hosts.length))
        : t("remote.deleteGroupConfirm").replace("{name}", label);
    if (await confirmAction(message, true, t("remote.delete"))) void deleteGroup(group);
  };

  return (
    <div className="py-0.5">
      <div
        role="treeitem"
        aria-expanded={!collapsed}
        tabIndex={0}
        // Dropping on the heading means "into this group, at the end" — the move that has no row to
        // aim at, and the only way to reach an empty-looking collapsed group.
        onPointerEnter={() => hoverDrag(null, group)}
        onPointerUp={() => commitDrop(group, null)}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const { clientX: x, clientY: y } = e;
          onMenu({
            x,
            y,
            items: [
              {
                label: `${t("remote.newHostHere")}…`,
                icon: Plus,
                onClick: () => onNewHere(x, y),
              },
              { label: t("remote.newGroup"), icon: FolderPlus, onClick: onNewGroup },
              // Renaming or deleting the ungrouped bucket is meaningless: it is the absence of a
              // group, so renaming it would write a literal name onto every host that deliberately
              // has none, and deleting it would have nothing to delete.
              ...(group === UNGROUPED
                ? []
                : [
                    {
                      label: t("remote.renameGroup"),
                      icon: Pencil,
                      onClick: () => setRenaming(true),
                      separated: true,
                    },
                    {
                      label: t("remote.deleteGroup"),
                      icon: Trash2,
                      danger: true,
                      onClick: () => void removeGroup(),
                    },
                  ]),
            ],
          });
        }}
        className={`group flex h-[26px] w-full cursor-default items-center gap-1.5 rounded-md px-1.5 text-left text-[var(--cf-text-muted)] outline-none transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)] ${
          isTarget
            ? "bg-[var(--cf-accent-soft)] ring-1 ring-[var(--cf-accent)]"
            : dragging
              ? ""
              : "hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        }`}
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--cf-text-faint)]">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </span>
        {/* The mark that says this row is a container rather than a machine.
            Without it a group heading and a host row differ only by weight and by the count on the
            right, which is not enough to tell them apart at a glance in a tree that is mostly hosts.

            Deliberately **not** `FolderOpen`: in this workspace that glyph already means "browse
            this host's files" — it is on the SFTP entry in `hostMenu` and on the files action a few
            hundred lines down — and one picture meaning two things inside one panel is worse than
            no picture. `FolderDot` marks the ungrouped bucket, which is not a folder anybody made:
            it is where hosts with no group fall, and it cannot be renamed or deleted like the rest.

            Outside the rename branch, so the row keeps its shape while the name is being typed. */}
        {group ? (
          <Folder size={14} className="shrink-0" />
        ) : (
          <FolderDot size={14} className="shrink-0" />
        )}
        {renaming ? (
          <InlineInput
            value={group}
            onCommit={(value) => {
              setRenaming(false);
              if (value.trim()) void renameGroup(group, value.trim());
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{label}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)]">
              {hosts.length}
            </span>
          </>
        )}
      </div>

      {!collapsed &&
        hosts.map((host, at) => (
          <HostRow key={host.id} host={host} at={at} onMenu={onMenu} />
        ))}
    </div>
  );
}

/**
 * One host.
 *
 * `memo`'d, and it holds without any work at the call site: its three props are the store's own row
 * object, its index, and `setMenu` — a state setter, so stable by construction. Everything else the
 * row reacts to it subscribes to itself, narrowly, and *that* is what the memo protects. Hovering a
 * row mid-drag writes `overHostId`, which re-renders the group heading and with it every host under
 * it; before this, dragging one host repainted the whole tree at pointer-event rate to move a single
 * one-pixel line.
 */
function HostRowBase({
  host,
  at,
  onMenu,
}: {
  host: RemoteHostRow;
  at: number;
  onMenu: (menu: OpenMenu | null) => void;
}) {
  const openSession = useRemoteStore((s) => s.openSession);
  const openForwards = useRemoteStore((s) => s.openForwards);
  const openScreen = useRemoteStore((s) => s.openScreen);
  const openSftp = useRemoteStore((s) => s.openSftp);
  const openAzure = useRemoteStore((s) => s.openAzure);
  const openPrimary = useOpenPrimary();
  const renameHost = useRemoteStore((s) => s.renameHost);
  const setRenamingHost = useRemoteStore((s) => s.setRenamingHost);
  const openDetails = useRemoteStore((s) => s.openDetails);
  const renamingHostId = useRemoteStore((s) => s.renamingHostId);
  const selectHost = useRemoteStore((s) => s.selectHost);
  const selected = useRemoteStore((s) => s.selectedHostId === host.id);
  // One rule for what this dot draws, shared with the tree and the other gallery layout — the three
  // copies of it had already drifted from the menu's own idea of "live".
  const { session, active, busy } = useHostLiveness(host.id);
  const hostMenu = useHostMenu();
  const t = useT();

  const press = useRemoteDragStore((s) => s.press);
  const begin = useRemoteDragStore((s) => s.begin);
  const hoverDrag = useRemoteDragStore((s) => s.hover);
  const beingDragged = useRemoteDragStore((s) => s.drag?.hostId === host.id);
  const isTarget = useRemoteDragStore((s) => s.drag !== null && s.overHostId === host.id);
  const commitDrop = useDrop();

  const spec = useMemo(() => parseHostSpec(host), [host]);
  const renaming = renamingHostId === host.id;
  // What this host can be asked to do, by kind. An FTP host has files and nothing else, a jailed
  // SFTP account has no shell, and a screen host has neither — so the row doesn't offer any of
  // them. The backend refuses each independently (`RemoteHostSpec::require_shell` and friends);
  // this is what keeps the user from ever meeting that refusal.
  const can = capabilities(spec);
  const incomplete = !hasAddress(spec);

  /**
   * Everything a host row can do, routed through one place.
   *
   * A host with no address can do none of it, and the useful response is not an error saying so —
   * it is the editor, open, on the field that is missing. A newly created host is exactly this
   * case, so without it the first thing a new user does produces a failure.
   */
  const act = (run: () => void) => (incomplete ? openDetails(host.id) : run());

  // What double-click and Enter do. Shared with the gallery's cards and the editor's Connect
  // button — see `useOpenPrimary`, which is where the "what is the biggest thing this host is"
  // order lives now that three places ask it.
  const activate = () => openPrimary(host, spec);

  const detail = describeHost(spec);

  return (
    <div
      role="treeitem"
      tabIndex={0}
      title={detail || undefined}
      aria-selected={selected}
      onPointerDown={(e) => {
        // Left button only, and never while renaming — the inline input needs the press to place a
        // caret, not to pick the row up.
        if (e.button !== 0 || renaming) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        press(host.id, host.group_name, e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        const origin = useRemoteDragStore.getState().origin;
        if (!origin || useRemoteDragStore.getState().drag) return;
        // The threshold is what keeps a click from being a one-pixel drag.
        if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < DRAG_THRESHOLD) return;
        begin();
        setDragCursor(true);
        // Capture is released so the rows the pointer crosses receive their own enter events —
        // with it held, every move would keep reporting this row.
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerEnter={() => hoverDrag(host.id, host.group_name)}
      onPointerUp={() => commitDrop(host.group_name, host.id)}
      onClick={() => selectHost(host.id)}
      onDoubleClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          activate();
        } else if (e.key === "F2") {
          e.preventDefault();
          setRenamingHost(host.id);
        }
      }}
      // `stopPropagation` is what makes this menu the one you get. Without it the event reached the
      // tree's own background handler, which set its "New connection / New group" menu over the
      // top — so right-clicking a host offered everything except the things you can do to a host.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu({
          x: e.clientX,
          y: e.clientY,
          items: hostMenu(host, { onRename: () => setRenamingHost(host.id) }),
        });
      }}
      style={riseDelay(at)}
      className={rowClass(
        selected,
        `cf-rise group h-[30px] cursor-default pl-5 pr-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)] ${
          beingDragged ? "opacity-40" : ""
        } ${
          // A line above the row, not a fill: the drop lands *before* this host, and a filled row
          // would say "into this one" — which is what a folder tree means by it, and this isn't one.
          isTarget ? "border-t border-[var(--cf-accent)]" : "border-t border-transparent"
        }`,
      )}
    >
      {/* The host's own colour, always drawn — this is the one the picker sets, and until now it
          only reached the state dot (which is grey unless something is *running*) and the active
          tab. A colour that appears once you have already connected cannot answer the question it
          exists for, which is "is this production?" asked *before* connecting. A short bar at the
          row's edge rather than a fill: it reads at a glance and does not fight the selected-row
          background for the same pixels. */}
      {host.color?.trim() && (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-[7px] left-[3px] top-[7px] w-0.5 rounded-full"
          style={{ background: host.color }}
        />
      )}
      <HostDot session={session} active={active} busy={busy} color={host.color} />
      {/* Both glyphs, never one: the OS says what the machine is, the kind says what this app can
          do with it. A Linux box reachable only over FTP is a penguin *and* a globe, and dropping
          either loses whichever half the user was scanning for. */}
      <OsGlyph os={spec.os} size={14} />
      <KindGlyph kind={spec.kind} size={14} />

      {renaming ? (
        <InlineInput
          value={host.name}
          onCommit={(value) => void renameHost(host.id, value)}
          onCancel={() => setRenamingHost(null)}
        />
      ) : (
        <>
          <span className={`min-w-0 flex-1 truncate ${selected ? "font-medium" : ""}`}>
            {host.name}
          </span>
          {/* Said on the row, not discovered by clicking: a host with no address looks exactly
              like a working one otherwise, and the three actions beside it all lead to the same
              editor. Hidden on hover so it doesn't fight the buttons for the same pixels. */}
          {incomplete && (
            <span className="shrink-0 text-[11px] text-[var(--cf-text-faint)] group-hover:hidden">
              {t(isCloudKind(spec.kind) ? "remote.needsAccount" : "remote.needsAddress")}
            </span>
          )}

          {/* Shown on hover *and* on the selected row. Hover-only was the wrong call: it left a
              tree of idle hosts looking like rows with nothing you can do to them, and gave the
              row you are actually working on no more affordance than the eleven you aren't. They
              stay in the tab order either way — an action that only exists on hover is an action a
              keyboard cannot reach. */}
          <span
            className={`flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
              selected ? "opacity-100" : "opacity-0"
            }`}
          >
            {can.shell && (
              <RowAction
                icon={Terminal}
                label={t("remote.openShell")}
                onClick={() => act(() => void openSession(host.id))}
              />
            )}
            {isAzureKind(spec.kind) ? (
              <RowAction
                icon={Cloud}
                label={t("remote.azOpenAccount")}
                onClick={() => act(() => openAzure(host.id))}
              />
            ) : (
              can.files && (
                <RowAction
                  icon={FolderOpen}
                  label={t("remote.files")}
                  onClick={() => act(() => openSftp(host.id))}
                />
              )
            )}
            {can.forwards && (
              <RowAction
                icon={Waypoints}
                label={t("remote.portForwards")}
                onClick={() => act(() => openForwards(host.id))}
              />
            )}
            {can.screen && (
              <RowAction
                icon={Monitor}
                label={t("remote.openScreen")}
                onClick={() => act(() => void openScreen(host.id))}
              />
            )}
            <RowAction
              icon={Settings2}
              label={t("remote.editHost")}
              onClick={() => openDetails(host.id)}
            />
          </span>
        </>
      )}
    </div>
  );
}

const HostRow = memo(HostRowBase);

/**
 * Ends a drag, wherever it was released.
 *
 * A hook rather than a handler on each row, because both the rows and the group headings drop, and
 * the tidy-up (clear the drag, drop the grabbing cursor) has to happen on every release including
 * the ones that land on nothing.
 */
function useDrop() {
  const dropHost = useRemoteStore((s) => s.dropHost);
  const endDrag = useRemoteDragStore((s) => s.end);

  return (group: string, beforeHostId: string | null) => {
    const drag = useRemoteDragStore.getState().drag;
    endDrag();
    setDragCursor(false);
    if (!drag || drag.hostId === beforeHostId) return;
    void dropHost(drag.hostId, group, beforeHostId);
  };
}

function RowAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Terminal;
  label: string;
  onClick: () => void;
}) {
  return (
    // Same reason the db explorer's chevron stops its own press: the host row captures the pointer
    // on `pointerdown` to tell a click from a drag, and a captured pointer delivers the `click` to
    // whatever holds the capture. Without this the row swallowed all three of these buttons — they
    // highlighted on hover and did nothing at all when pressed. Stopped *outside* the tooltip, so
    // the tooltip still hears the press and puts itself away.
    <span className="contents" onPointerDown={(e) => e.stopPropagation()}>
      <Tooltip label={label}>
        <button
          type="button"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className={iconButtonClass({ size: "xs" })}
        >
          <Icon size={13} />
        </button>
      </Tooltip>
    </span>
  );
}

/** The inline editor a rename happens in. Selects on mount, commits on Enter or blur, cancels on
 *  Escape — the shape every rename in this app already has. */
function InlineInput({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(false);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(draft);
  };

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          committed.current = true;
          onCancel();
        }
      }}
      onFocus={(e) => e.currentTarget.select()}
      className="h-[22px] min-w-0 flex-1 rounded-md border border-[var(--cf-accent)] bg-[var(--cf-field)] px-1.5 text-[13px] text-[var(--cf-text)] outline-none shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]"
    />
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** The two sections at the foot of the explorer open from a heading shaped like the tree's own
 *  group rows, so the column reads as one list of things with the hosts first. */
const FOOT_HEAD =
  "flex h-[26px] min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]";

/** A command or a snippet under its heading, indented to the heading's label. */
const FOOT_ROW =
  "cf-rise group flex h-7 items-center gap-1 rounded-md pl-[26px] pr-1 transition-colors duration-100 hover:bg-[var(--cf-hover)]";

/**
 * The commands typed in this workspace's sessions, and the two things you do with one.
 *
 * **Save** turns it into a snippet — the whole reason this exists. You got a command right once;
 * retyping it to make it reusable is the step worth deleting. **Paste** sends it to the focused
 * session, which is the other half: the command you want is usually the one you ran on the *other*
 * machine ten minutes ago.
 *
 * It records keystrokes, not the shell's own history (see `typedLines` for why), so the heading
 * says "typed" rather than "ran" — a list that claimed more than it knows would be wrong exactly
 * when tab completion or history recall was involved.
 */
function HistoryList() {
  const history = useRemoteStore((s) => s.history);
  const clearHistory = useRemoteStore((s) => s.clearHistory);
  const createSnippet = useRemoteStore((s) => s.createSnippet);
  const runSnippet = useRemoteStore((s) => s.runSnippet);
  const [open, setOpen] = useState(false);
  const t = useT();

  return (
    <div className="shrink-0 border-t border-[var(--cf-border)] px-2 py-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className={FOOT_HEAD}
        >
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--cf-text-faint)]">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          <History size={14} className="shrink-0" />
          <span className="min-w-0 truncate">{t("remote.history")}</span>
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)]">
            {history.length}
          </span>
        </button>
        {open && history.length > 0 && (
          <ToolbarButton icon={Trash2} label={t("remote.clearHistory")} onClick={clearHistory} />
        )}
      </div>

      {open && (
        <div className="max-h-56 overflow-auto pb-0.5">
          {history.length === 0 ? (
            <p className="px-2 py-3 text-[11px] leading-relaxed text-[var(--cf-text-faint)]">
              {t("remote.noHistory")}
            </p>
          ) : (
            history.map((entry, at) => (
              <div
                key={entry.id}
                title={`${entry.hostName}: ${entry.body}`}
                style={riseDelay(at)}
                className={FOOT_ROW}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--cf-text)]">
                  {entry.body}
                </span>
                <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <RowAction
                    icon={Play}
                    label={t("remote.paste")}
                    onClick={() => void runSnippet(entry.body)}
                  />
                  <RowAction
                    icon={Bookmark}
                    label={t("remote.saveAsSnippet")}
                    // Named after the command itself, trimmed: a snippet called "New snippet" is a
                    // snippet nobody finds again, and the command is the best name available.
                    onClick={() => void createSnippet(entry.body.slice(0, 40), entry.body)}
                  />
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

/**
 * The snippet library, docked under the tree the way the SQL history is under the database
 * explorer.
 *
 * Workspace-scoped rather than per-host, because that is the whole point: "tail the app log" is
 * written once and run on whichever machine is misbehaving today. Running one sends it to the
 * *focused session*, which is why it lives here rather than in a modal — you pick the host in the
 * tab strip and the command in this list, and neither choice has to be re-made to change the other.
 */
function SnippetList() {
  const snippets = useRemoteStore((s) => s.snippets);
  const createSnippet = useRemoteStore((s) => s.createSnippet);
  const deleteSnippet = useRemoteStore((s) => s.deleteSnippet);
  const saveSnippet = useRemoteStore((s) => s.saveSnippet);
  const runSnippet = useRemoteStore((s) => s.runSnippet);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const t = useT();

  return (
    <div className="shrink-0 border-t border-[var(--cf-border)] px-2 py-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className={FOOT_HEAD}
        >
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--cf-text-faint)]">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          <FolderTree size={14} className="shrink-0" />
          <span className="min-w-0 truncate">{t("remote.snippets")}</span>
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)]">
            {snippets.length}
          </span>
        </button>
        <ToolbarButton
          icon={Plus}
          label={t("remote.newSnippet")}
          onClick={() => {
            setOpen(true);
            void createSnippet(t("remote.newSnippetName"), "");
          }}
        />
      </div>

      {open && (
        <div className="max-h-56 overflow-auto pb-0.5">
          {snippets.length === 0 ? (
            <p className="px-2 py-3 text-[11px] text-[var(--cf-text-faint)]">
              {t("remote.noSnippets")}
            </p>
          ) : (
            snippets.map((snippet, at) =>
              editingId === snippet.id ? (
                <div key={snippet.id} className="space-y-1.5 rounded-md bg-[var(--cf-hover)] p-2">
                  <input
                    value={snippet.name}
                    onChange={(e) => void saveSnippet({ ...snippet, name: e.target.value })}
                    className={fieldClass({ size: "sm", className: "w-full" })}
                  />
                  <textarea
                    value={snippet.body}
                    rows={3}
                    onChange={(e) => void saveSnippet({ ...snippet, body: e.target.value })}
                    placeholder={t("remote.snippetPlaceholder")}
                    className={`${TEXTAREA} font-mono`}
                  />
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => void deleteSnippet(snippet.id)}
                      className={buttonClass({ variant: "danger-ghost", size: "sm" })}
                    >
                      {t("common.delete")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className={buttonClass({ variant: "secondary", size: "sm" })}
                    >
                      {t("remote.done")}
                    </button>
                  </div>
                </div>
              ) : (
                <div key={snippet.id} style={riseDelay(at)} className={FOOT_ROW}>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">
                    {snippet.name}
                  </span>
                  <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <RowAction
                      icon={Play}
                      label={t("remote.runSnippet")}
                      onClick={() => void runSnippet(snippet.body)}
                    />
                    <RowAction
                      icon={Pencil}
                      label={t("remote.edit")}
                      onClick={() => setEditingId(snippet.id)}
                    />
                  </span>
                </div>
              ),
            )
          )}
        </div>
      )}
    </div>
  );
}
