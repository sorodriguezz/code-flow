import { useMemo, useState } from "react";
import {
  Cloud,
  Folder,
  FolderDot,
  FolderOpen,
  LayoutGrid,
  List,
  Monitor,
  Plus,
  Settings2,
  Terminal,
  Waypoints,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import { buttonClass, iconButtonClass } from "../common/Button";
import { chipClass } from "../common/recipes";
import { HostDot, KindGlyph, OsGlyph, Pill } from "./remoteChrome";
import { useHostMenu, useNewConnectionMenu, useOpenPrimary } from "./hostMenu";
import {
  allTags,
  groupHosts,
  hostMatches,
  useHostLiveness,
  useRemoteStore,
} from "../../state/remoteStore";
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

/**
 * What fills the main area when no session is open: the estate, as something to launch from.
 *
 * The tree on the left answers "where is that machine"; this answers "what have I got". They earn
 * their keep separately — the tree is a *narrow* column that has to stay scannable at thirty hosts,
 * so it shows a name and a dot and nothing else. Here there is room for the address, the tags and
 * three real buttons, which is what makes it a launcher rather than a second copy of the tree.
 *
 * Grid or list is the user's, and persisted: it is a habit about how you read a list, not something
 * you are doing right now (unlike the search box beside it).
 */
export function HostGallery() {
  const hosts = useRemoteStore((s) => s.hosts);
  const query = useRemoteStore((s) => s.query);
  const tagFilter = useRemoteStore((s) => s.tagFilter);
  const tagMode = useRemoteStore((s) => s.tagMode);
  const setTagMode = useRemoteStore((s) => s.setTagMode);
  const folders = useRemoteStore((s) => s.groups);
  const hostView = useRemoteStore((s) => s.hostView);
  const setHostView = useRemoteStore((s) => s.setHostView);
  const newConnectionMenu = useNewConnectionMenu();
  const t = useT();

  // The same menu the tree raises, on the same gesture. The gallery had none, which is the version
  // of this view where a host can be deleted from the sidebar and nowhere else — and the gallery is
  // the half of the workspace with room to actually read what you are deleting.
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; heading?: string } | null>(
    null,
  );

  const visible = useMemo(
    () => hosts.filter((host) => hostMatches(host, query, tagFilter, tagMode)),
    [hosts, query, tagFilter, tagMode],
  );

  /**
   * The gallery, cut into its groups — the same cut the tree makes, in a view that had none.
   *
   * The tree answers "where is that machine" by group, so a gallery that lists the same estate flat
   * makes the two disagree about how the estate is shaped: three DESA boxes and one QA box read as
   * four unrelated machines here and as two folders there.
   *
   * `folders` is passed only when nothing is filtering, exactly as `HostExplorer` does it. While a
   * search or a tag filter is on, an empty group heading would be a heading over nothing — it
   * claims the group has no matches when what it means is that the group is empty to begin with.
   */
  const sections = useMemo(() => {
    const filtering = query.trim().length > 0 || tagFilter.length > 0;
    let from = 0;
    return groupHosts(visible, filtering ? [] : folders).map(([group, members]) => {
      // The entrance stagger is a property of the *page*, not of a section: restarting it per group
      // would make the first card of every group rise at the same instant, so a four-group gallery
      // would animate in four columns rather than reading top to bottom. Accumulated here, once,
      // rather than searched for per card — which is the same answer at O(n) instead of O(n²).
      const section = { group, members, from };
      from += members.length;
      return section;
    });
  }, [visible, folders, query, tagFilter]);

  const openNewMenu = (x: number, y: number) =>
    setMenu({ x, y, heading: t("remote.newConnection"), items: newConnectionMenu() });

  if (hosts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        {/* The one thing to do on an empty estate, where the eye already is — and nothing else: an
            empty state is its button. What the estate is for goes in the tooltip, for whoever asks.
            The sidebar's (+) is the same menu, but an empty view that only *describes* the button
            is a dead end. */}
        <Tooltip label={t("remote.emptyTitle")} description={t("remote.emptySubtitle")} side="bottom">
          <button
            type="button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              openNewMenu(rect.left, rect.bottom + 4);
            }}
            className={buttonClass({ variant: "primary", size: "lg" })}
          >
            <Plus size={14} />
            {t("remote.newConnection")}
          </button>
        </Tooltip>
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

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onContextMenu={(event) => {
        event.preventDefault();
        openNewMenu(event.clientX, event.clientY);
      }}
    >
      <div className="flex min-h-11 shrink-0 items-center gap-2.5 px-4 py-2">
        <span className="shrink-0 text-[14px] font-semibold text-[var(--cf-text)]">
          {t("remote.hosts")}
          <span className="ml-1.5 text-[12px] font-normal tabular-nums text-[var(--cf-text-faint)]">
            {visible.length}
          </span>
        </span>
        <TagFilterRow />
        <Segmented
          className="ml-auto"
          size="sm"
          layoutId="remote-host-view"
          ariaLabel={t("remote.hosts")}
          value={hostView}
          onChange={setHostView}
          options={[
            { value: "grid", icon: LayoutGrid, title: t("remote.viewGrid") },
            { value: "list", icon: List, title: t("remote.viewList") },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="text-[12px] text-[var(--cf-text-faint)]">{t("remote.noHostsMatch")}</p>
            {/* The one empty result that is worth explaining rather than just reporting.
                Two or more tags under AND is the combination that returns nothing for a reason the
                screen otherwise keeps to itself — nothing is both DESA and QA — and the user has no
                way to tell "no machine matches" from "this filter cannot match anything". So it
                says which reading is in force and offers the other one, right here, instead of
                sending someone off to find a setting for a question they are asking now. */}
            {tagFilter.length > 1 && tagMode === "all" && (
              <button
                type="button"
                onClick={() => setTagMode("any")}
                className={buttonClass({ variant: "secondary", size: "sm" })}
              >
                {t("remote.tagsTryAny", { tags: tagFilter.join(", ") })}
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {sections.map(({ group, members, from }) => (
              <section key={group || "__ungrouped__"}>
                {/* Drawn even for a lone group, so the gallery never looks like it grouped some of
                    the estate and not the rest. The count is on the heading for the same reason the
                    tree puts it there: it is the one number that says whether you are looking at
                    all of a group or at what a filter left of it. */}
                <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                  {group ? (
                    <Folder size={13} className="shrink-0" />
                  ) : (
                    <FolderDot size={13} className="shrink-0" />
                  )}
                  <span className="min-w-0 truncate">{group || t("remote.ungrouped")}</span>
                  <span className="shrink-0 font-medium tabular-nums">{members.length}</span>
                </h3>
                {hostView === "grid" ? (
                  // `auto-fill` rather than `auto-fit`: with two hosts, `auto-fit` collapses the
                  // empty tracks and stretches those two across the whole window, which reads as a
                  // layout bug rather than as a grid. `auto-fill` keeps the column rhythm at any
                  // count — and now at any count *per group*, which is where it earns it: a group
                  // of one must not draw one card a screen wide.
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
                    {members.map((host, at) => (
                      <HostCard key={host.id} host={host} at={from + at} onMenu={setMenu} />
                    ))}
                  </div>
                ) : (
                  <div className="divide-y divide-[var(--cf-border)] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
                    {members.map((host, at) => (
                      <HostListRow key={host.id} host={host} at={from + at} onMenu={setMenu} />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
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

/** Raising the gallery's one menu, handed down to the cards. */
type SetMenu = (menu: { x: number; y: number; items: MenuItem[]; heading?: string } | null) => void;

/** What a right-click on a card or a row does. A hook so both drawings of a host raise the identical
 *  menu — see `useHostMenu`. */
function useCardMenu(onMenu: SetMenu) {
  const hostMenu = useHostMenu();
  const selectHost = useRemoteStore((s) => s.selectHost);

  return (host: RemoteHostRow) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    // Right-click focuses too: the panel, the status bar and the menu must all name the same host.
    selectHost(host.id);
    onMenu({ x: event.clientX, y: event.clientY, items: hostMenu(host) });
  };
}

/**
 * The tags in use, as toggles.
 *
 * Only rendered when tags exist at all: a filter row over an estate that has never been tagged is a
 * permanent empty control teaching nothing.
 */
export function TagFilterRow() {
  const hosts = useRemoteStore((s) => s.hosts);
  const tagFilter = useRemoteStore((s) => s.tagFilter);
  const toggleTag = useRemoteStore((s) => s.toggleTag);
  const clearTags = useRemoteStore((s) => s.clearTags);
  const tagMode = useRemoteStore((s) => s.tagMode);
  const setTagMode = useRemoteStore((s) => s.setTagMode);
  const t = useT();

  const tags = useMemo(() => allTags(hosts), [hosts]);
  if (tags.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {tags.map((tag) => {
        const on = tagFilter.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            aria-pressed={on}
            onClick={() => toggleTag(tag)}
            className={
              on
                ? chipClass("accent")
                : chipClass("neutral", "transition-colors duration-100 hover:text-[var(--cf-text)]")
            }
          >
            {tag}
          </button>
        );
      })}
      {/* Only from two tags on, because with one selected there is nothing to combine and the words
          "all" and "any" would describe the same result — a control that cannot change what you are
          looking at. It appears exactly when it starts to mean something. */}
      {tagFilter.length > 1 && (
        <Tooltip label={t(tagMode === "all" ? "remote.tagsAllHint" : "remote.tagsAnyHint")}>
          <button
            type="button"
            onClick={() => setTagMode(tagMode === "all" ? "any" : "all")}
            className="h-5 shrink-0 rounded px-1.5 text-[11px] text-[var(--cf-text-muted)] underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--cf-text)]"
          >
            {t(tagMode === "all" ? "remote.tagsAll" : "remote.tagsAny")}
          </button>
        </Tooltip>
      )}
      {tagFilter.length > 0 && (
        <button
          type="button"
          onClick={clearTags}
          className="h-5 shrink-0 rounded px-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          {t("remote.clear")}
        </button>
      )}
    </div>
  );
}

/** The three things you came to a machine for, wherever the host is drawn. */
function HostActions({ host }: { host: RemoteHostRow }) {
  const openSession = useRemoteStore((s) => s.openSession);
  const openForwards = useRemoteStore((s) => s.openForwards);
  const openScreen = useRemoteStore((s) => s.openScreen);
  const openSftp = useRemoteStore((s) => s.openSftp);
  const openAzure = useRemoteStore((s) => s.openAzure);
  const openDetails = useRemoteStore((s) => s.openDetails);
  const t = useT();

  const spec = parseHostSpec(host);
  const act = (run: () => void) => (hasAddress(spec) ? run() : openDetails(host.id));
  // Same table the tree uses, for the same reason: an FTP host has files and nothing else, and a
  // screen host has only its screen — so each gets one action rather than four, three of which
  // could not work.
  const can = capabilities(spec);

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {can.shell && (
        <Action icon={Terminal} label={t("remote.openShell")} onClick={() => act(() => void openSession(host.id))} />
      )}
      {/* An account's one button opens the account, not a file browser: its blob half is one of
          four pages, and the other three are not files. Which page it lands on is the rail's job
          from there. */}
      {isAzureKind(spec.kind) ? (
        <Action
          icon={Cloud}
          label={t("remote.azOpenAccount")}
          onClick={() => act(() => openAzure(host.id))}
        />
      ) : (
        can.files && (
          <Action icon={FolderOpen} label={t("remote.files")} onClick={() => act(() => openSftp(host.id))} />
        )
      )}
      {can.forwards && (
        <Action icon={Waypoints} label={t("remote.portForwards")} onClick={() => act(() => openForwards(host.id))} />
      )}
      {can.screen && (
        <Action icon={Monitor} label={t("remote.openScreen")} onClick={() => act(() => void openScreen(host.id))} />
      )}
      <Action icon={Settings2} label={t("remote.editHost")} onClick={() => openDetails(host.id)} />
    </span>
  );
}

function Action({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Terminal;
  label: string;
  onClick: () => void;
}) {
  return (
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
  );
}

/** The host's colour as a short bar at the card's or row's edge — the same mark the tree draws. */
function ColorEdge({ color }: { color: string }) {
  if (!color.trim()) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute bottom-[9px] left-[3px] top-[9px] w-0.5 rounded-full"
      style={{ background: color }}
    />
  );
}

function HostCard({ host, at, onMenu }: { host: RemoteHostRow; at: number; onMenu: SetMenu }) {
  const openPrimary = useOpenPrimary();
  const cardMenu = useCardMenu(onMenu);
  const selectHost = useRemoteStore((s) => s.selectHost);
  const selected = useRemoteStore((s) => s.selectedHostId === host.id);
  // One rule for what this dot draws, shared with the tree and the other gallery layout — the three
  // copies of it had already drifted from the menu's own idea of "live".
  const { session, active, busy } = useHostLiveness(host.id);
  const t = useT();

  const spec = parseHostSpec(host);
  const detail = describeHost(spec);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => selectHost(host.id)}
      onDoubleClick={() => openPrimary(host, spec)}
      onContextMenu={cardMenu(host)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          openPrimary(host, spec);
        }
      }}
      style={riseDelay(at)}
      className={`cf-rise group relative flex cursor-default flex-col gap-2 rounded-lg border py-3 pl-4 pr-3 text-left outline-none transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)] ${
        selected
          ? "border-[var(--cf-accent-line)] bg-[var(--cf-accent-soft)]"
          : "border-[var(--cf-border)] bg-[var(--cf-surface)] hover:border-[var(--cf-border-strong)]"
      }`}
    >
      {/* The host's own colour, always drawn — this is the one the picker sets, and until now it
          only reached the state dot (which is grey unless something is *running*) and the active
          tab. A colour that appears once you have already connected cannot answer the question it
          exists for, which is "is this production?" asked *before* connecting. A bar at the edge
          rather than a fill: it reads at a glance and does not fight the selected card's background
          for the same pixels. */}
      <ColorEdge color={host.color} />
      <div className="flex min-w-0 items-center gap-2">
        <HostDot session={session} active={active} busy={busy} color={host.color} />
        <OsGlyph os={spec.os} size={14} />
        <KindGlyph kind={spec.kind} size={14} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--cf-text)]">
          {host.name}
        </span>
      </div>

      <span className="min-w-0 truncate font-mono text-[12px] text-[var(--cf-text-muted)]">
        {detail || t(isCloudKind(spec.kind) ? "remote.needsAccount" : "remote.needsAddress")}
      </span>

      <div className="flex min-w-0 items-center gap-1">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 overflow-hidden">
          {/* The group carries a glyph and the tags don't, because they are not the same fact —
              see `Pill`. Drawn as two identical capsules, "test2" and "Test" were indistinguishable
              and neither said which was which. */}
          {host.group_name && (
            <Pill icon={Folder} title={t("remote.fieldGroup")}>
              {host.group_name}
            </Pill>
          )}
          {spec.tags.slice(0, 2).map((tag) => (
            <Pill key={tag} title={t("remote.fieldTags")}>
              {tag}
            </Pill>
          ))}
        </span>
        {/* On hover or on the selected card, matching the tree's rows. */}
        <span
          className={`transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
            selected ? "opacity-100" : "opacity-0"
          }`}
        >
          <HostActions host={host} />
        </span>
      </div>
    </div>
  );
}

function HostListRow({ host, at, onMenu }: { host: RemoteHostRow; at: number; onMenu: SetMenu }) {
  const openPrimary = useOpenPrimary();
  const cardMenu = useCardMenu(onMenu);
  const selectHost = useRemoteStore((s) => s.selectHost);
  const selected = useRemoteStore((s) => s.selectedHostId === host.id);
  // One rule for what this dot draws, shared with the tree and the other gallery layout — the three
  // copies of it had already drifted from the menu's own idea of "live".
  const { session, active, busy } = useHostLiveness(host.id);
  const t = useT();

  const spec = parseHostSpec(host);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => selectHost(host.id)}
      onDoubleClick={() => openPrimary(host, spec)}
      onContextMenu={cardMenu(host)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          openPrimary(host, spec);
        }
      }}
      style={riseDelay(at)}
      className={`cf-rise group relative flex h-9 cursor-default items-center gap-2 pl-4 pr-3 text-left outline-none transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)] ${
        selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"
      }`}
    >
      {/* The host's own colour, always drawn — see `HostCard`. */}
      <ColorEdge color={host.color} />
      <HostDot session={session} active={active} busy={busy} color={host.color} />
      <OsGlyph os={spec.os} size={14} />
      <KindGlyph kind={spec.kind} size={14} />
      <span className="w-[160px] shrink-0 truncate text-[13px] font-medium text-[var(--cf-text)]">
        {host.name}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--cf-text-muted)]">
        {describeHost(spec)}
      </span>
      <span className="hidden shrink-0 items-center gap-1 sm:flex">
        {host.group_name && (
          <Pill icon={Folder} title={t("remote.fieldGroup")}>
            {host.group_name}
          </Pill>
        )}
        {spec.tags.slice(0, 2).map((tag) => (
          <Pill key={tag} title={t("remote.fieldTags")}>
            {tag}
          </Pill>
        ))}
      </span>
      <span
        className={`shrink-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
          selected ? "opacity-100" : "opacity-0"
        }`}
      >
        <HostActions host={host} />
      </span>
    </div>
  );
}
