import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Bookmark,
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
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { ResizeHandle } from "../common/ResizeHandle";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { useRemoteDragStore } from "../../state/remoteDragStore";
import { CARD, HostDot, KindGlyph, OsGlyph, ToolbarButton } from "./remoteChrome";
import { useHostMenu, useNewConnectionMenu } from "./hostMenu";
import { groupHosts, hostMatches, UNGROUPED, useRemoteStore } from "../../state/remoteStore";
import { useLayoutStore } from "../../state/layoutStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { riseDelay } from "../../lib/rise";
import {
  capabilities,
  describeHost,
  hasAddress,
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
      <div
        data-tour="remote-hosts"
        style={{ width }}
        className={`flex shrink-0 flex-col overflow-hidden ${CARD}`}
      >
        <HostList onImport={onImport} />
        <HistoryList />
        <SnippetList />
      </div>
      <ResizeHandle
        axis="x"
        value={width}
        min={WIDTH_MIN}
        max={WIDTH_MAX}
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
    () => hosts.filter((host) => hostMatches(host, query, tagFilter)),
    [hosts, query, tagFilter],
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
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1.5">
        <span className="flex-1 text-[12px] font-medium text-[var(--cf-text)]">
          {t("remote.hosts")}
        </span>
        <ToolbarButton
          icon={Waypoints}
          label={t("remote.allForwards")}
          onClick={openAllForwards}
        />
        <ToolbarButton icon={ScrollText} label={t("remote.log")} onClick={openLog} />
        <ToolbarButton icon={Download} label={t("remote.importSshConfig")} onClick={onImport} />
        <ToolbarButton
          icon={RefreshCw}
          label={t("remote.refresh")}
          onClick={() => void refresh()}
          disabled={loading}
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
        />
      </div>

      <div className="shrink-0 px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1">
          <Search size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("remote.searchHosts")}
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--cf-text-muted)]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("remote.clear")}
              className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div
        role="tree"
        onContextMenu={treeMenu}
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-2"
      >
        {creatingGroup && (
          <div className="flex items-center gap-1 px-1.5 py-[3px]">
            <FolderPlus size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
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
          <p className="px-3 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">
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
        className={`group flex w-full cursor-default items-center gap-1 rounded-md px-1.5 py-[3px] text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)] ${
          isTarget
            ? "bg-[var(--cf-accent-soft)] ring-1 ring-[var(--cf-accent)]"
            : dragging
              ? ""
              : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        }`}
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--cf-text-muted)]">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </span>
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
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--cf-text-muted)]">
              {label}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
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

function HostRow({
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
  const renameHost = useRemoteStore((s) => s.renameHost);
  const setRenamingHost = useRemoteStore((s) => s.setRenamingHost);
  const openDetails = useRemoteStore((s) => s.openDetails);
  const renamingHostId = useRemoteStore((s) => s.renamingHostId);
  const selectHost = useRemoteStore((s) => s.selectHost);
  const selected = useRemoteStore((s) => s.selectedHostId === host.id);
  const hasSession = useRemoteStore((s) =>
    s.tabs.some((tab) => tab.kind === "session" && tab.hostId === host.id && !tab.exited),
  );
  const hasForward = useRemoteStore((s) => s.forwards.some((f) => f.host_id === host.id));
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
  // What this host can be asked to do, by kind. An FTP host has files and nothing else, and a
  // jailed SFTP account has no shell — so the menu doesn't offer either. The backend refuses the
  // same three independently (`RemoteHostSpec::require_shell` and friends); this is what keeps the
  // user from ever meeting that refusal.
  const can = capabilities(spec);
  const hasScreen = can.screen && spec.screen.protocol !== "none";
  const incomplete = !hasAddress(spec);

  /**
   * Everything a host row can do, routed through one place.
   *
   * A host with no address can do none of it, and the useful response is not an error saying so —
   * it is the editor, open, on the field that is missing. A newly created host is exactly this
   * case, so without it the first thing a new user does produces a failure.
   */
  const act = (run: () => void) => (incomplete ? openDetails(host.id) : run());

  /**
   * What double-click and Enter do: the shell where there is one, the file browser otherwise.
   *
   * Not "open a shell and let it fail" — on a file-only host there is no shell to open, and the
   * row's *point* is the files. Same gesture, same meaning ("show me this machine"), different
   * thing on the other side.
   */
  const openPrimary = () =>
    act(() => (can.shell ? void openSession(host.id) : openSftp(host.id)));

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
      onDoubleClick={openPrimary}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          openPrimary();
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
      className={`cf-rise group flex w-full cursor-default items-center gap-1.5 rounded-md py-[3px] pl-5 pr-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)] ${
        beingDragged ? "opacity-40" : ""
      } ${
        // A line above the row, not a fill: the drop lands *before* this host, and a filled row
        // would say "into this one" — which is what a folder tree means by it, and this isn't one.
        isTarget ? "border-t border-[var(--cf-accent)]" : "border-t border-transparent"
      } ${selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"}`}
    >
      <HostDot session={hasSession} active={hasForward} color={host.color} />
      {/* Both glyphs, never one: the OS says what the machine is, the kind says what this app can
          do with it. A Linux box reachable only over FTP is a penguin *and* a globe, and dropping
          either loses whichever half the user was scanning for. */}
      <OsGlyph os={spec.os} size={13} />
      <KindGlyph kind={spec.kind} size={13} />

      {renaming ? (
        <InlineInput
          value={host.name}
          onCommit={(value) => void renameHost(host.id, value)}
          onCancel={() => setRenamingHost(null)}
        />
      ) : (
        <>
          <span
            className={`min-w-0 flex-1 truncate text-[12px] ${
              selected ? "font-medium text-[var(--cf-accent)]" : "text-[var(--cf-text)]"
            }`}
          >
            {host.name}
          </span>
          {/* Said on the row, not discovered by clicking: a host with no address looks exactly
              like a working one otherwise, and the three actions beside it all lead to the same
              editor. Hidden on hover so it doesn't fight the buttons for the same pixels. */}
          {incomplete && (
            <span className="shrink-0 text-[10px] text-[var(--cf-text-muted)] group-hover:hidden">
              {t("remote.needsAddress")}
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
            <RowAction
              icon={FolderOpen}
              label={t("remote.files")}
              onClick={() => act(() => openSftp(host.id))}
            />
            {can.forwards && (
              <RowAction
                icon={Waypoints}
                label={t("remote.portForwards")}
                onClick={() => act(() => openForwards(host.id))}
              />
            )}
            {hasScreen && (
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
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      // Same reason the db explorer's chevron stops its own press: the host row captures the
      // pointer on `pointerdown` to tell a click from a drag, and a captured pointer delivers the
      // `click` to whatever holds the capture. Without this the row swallowed all three of these
      // buttons — they highlighted on hover and did nothing at all when pressed.
      onPointerDown={(e) => e.stopPropagation()}
      className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-accent)] dark:hover:bg-white/[0.08]"
    >
      <Icon size={12} />
    </button>
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
      className="min-w-0 flex-1 rounded border border-[var(--cf-accent)] bg-transparent px-1 py-px text-[12px] outline-none"
    />
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

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
    <div className="shrink-0 border-t border-[var(--cf-border)]">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <History size={11} />
          {t("remote.history")}
          <span className="tabular-nums">({history.length})</span>
        </button>
        {open && history.length > 0 && (
          <ToolbarButton icon={Trash2} label={t("remote.clearHistory")} onClick={clearHistory} />
        )}
      </div>

      {open && (
        <div className="max-h-56 overflow-auto border-t border-[var(--cf-border)]">
          {history.length === 0 ? (
            <p className="px-3 py-4 text-center text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
              {t("remote.noHistory")}
            </p>
          ) : (
            history.map((entry, at) => (
              <div
                key={entry.id}
                title={`${entry.hostName}: ${entry.body}`}
                style={riseDelay(at)}
                className="cf-rise group flex items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text)]">
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
    <div className="shrink-0 border-t border-[var(--cf-border)]">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <FolderTree size={11} />
          {t("remote.snippets")}
          <span className="tabular-nums">({snippets.length})</span>
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
        <div className="max-h-56 overflow-auto border-t border-[var(--cf-border)]">
          {snippets.length === 0 ? (
            <p className="px-3 py-4 text-center text-[11px] text-[var(--cf-text-muted)]">
              {t("remote.noSnippets")}
            </p>
          ) : (
            snippets.map((snippet, at) =>
              editingId === snippet.id ? (
                <div key={snippet.id} className="space-y-1 border-b border-[var(--cf-border)] p-2 last:border-b-0">
                  <input
                    value={snippet.name}
                    onChange={(e) => void saveSnippet({ ...snippet, name: e.target.value })}
                    className="w-full rounded border border-[var(--cf-border)] bg-transparent px-1.5 py-1 text-[12px] outline-none focus:border-[var(--cf-accent)]"
                  />
                  <textarea
                    value={snippet.body}
                    rows={3}
                    onChange={(e) => void saveSnippet({ ...snippet, body: e.target.value })}
                    placeholder={t("remote.snippetPlaceholder")}
                    className="w-full resize-y rounded border border-[var(--cf-border)] bg-transparent px-1.5 py-1 font-mono text-[11px] outline-none focus:border-[var(--cf-accent)]"
                  />
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => void deleteSnippet(snippet.id)}
                      className="rounded px-1.5 py-0.5 text-[11px] text-[var(--cf-danger)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                    >
                      {t("common.delete")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                    >
                      {t("remote.done")}
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  key={snippet.id}
                  style={riseDelay(at)}
                  className="cf-rise group flex items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text)]">
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
