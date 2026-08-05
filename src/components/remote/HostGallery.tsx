import { useMemo } from "react";
import {
  FolderOpen,
  LayoutGrid,
  List,
  Monitor,
  MonitorSmartphone,
  Settings2,
  Terminal,
  Waypoints,
} from "lucide-react";
import { HostDot, KindGlyph, OsGlyph, Pill } from "./remoteChrome";
import { allTags, hostMatches, useRemoteStore } from "../../state/remoteStore";
import { useT } from "../../state/languageStore";
import {
  capabilities,
  describeHost,
  hasAddress,
  parseHostSpec,
  type RemoteHostRow,
  type RemoteHostSpec,
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
  const hostView = useRemoteStore((s) => s.hostView);
  const setHostView = useRemoteStore((s) => s.setHostView);
  const t = useT();

  const visible = useMemo(
    () => hosts.filter((host) => hostMatches(host, query, tagFilter)),
    [hosts, query, tagFilter],
  );

  if (hosts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <MonitorSmartphone size={28} className="mb-2 shrink-0 text-[var(--cf-text-muted)]" />
        <p className="text-sm font-medium text-[var(--cf-text)]">{t("remote.emptyTitle")}</p>
        <p className="max-w-sm text-[13px] leading-relaxed text-[var(--cf-text-muted)]">
          {t("remote.emptySubtitle")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
        <span className="text-[12px] font-medium text-[var(--cf-text)]">
          {t("remote.hosts")}
          <span className="ml-1.5 tabular-nums text-[var(--cf-text-muted)]">{visible.length}</span>
        </span>
        <TagFilterRow />
        <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md bg-black/[0.04] p-0.5 dark:bg-white/[0.06]">
          <ViewButton
            icon={LayoutGrid}
            label={t("remote.viewGrid")}
            active={hostView === "grid"}
            onClick={() => setHostView("grid")}
          />
          <ViewButton
            icon={List}
            label={t("remote.viewList")}
            active={hostView === "list"}
            onClick={() => setHostView("list")}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {visible.length === 0 ? (
          <p className="py-10 text-center text-[12px] text-[var(--cf-text-muted)]">
            {t("remote.noHostsMatch")}
          </p>
        ) : hostView === "grid" ? (
          // `auto-fill` rather than `auto-fit`: with two hosts, `auto-fit` collapses the empty
          // tracks and stretches those two across the whole window, which reads as a layout bug
          // rather than as a grid. `auto-fill` keeps the column rhythm at any count.
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
            {visible.map((host) => (
              <HostCard key={host.id} host={host} />
            ))}
          </div>
        ) : (
          <div className="divide-y divide-[var(--cf-border)] overflow-hidden rounded-md border border-[var(--cf-border)]">
            {visible.map((host) => (
              <HostListRow key={host.id} host={host} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ViewButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof LayoutGrid;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
        active
          ? "bg-[var(--cf-surface)] text-[var(--cf-text)] shadow-sm"
          : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      }`}
    >
      <Icon size={13} />
    </button>
  );
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
            className={`shrink-0 rounded px-1.5 py-px text-[11px] transition-colors ${
              on
                ? "bg-[var(--cf-accent)] text-white"
                : "bg-black/[0.05] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] dark:bg-white/[0.07]"
            }`}
          >
            {tag}
          </button>
        );
      })}
      {tagFilter.length > 0 && (
        <button
          type="button"
          onClick={clearTags}
          className="shrink-0 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          {t("remote.clear")}
        </button>
      )}
    </div>
  );
}

/**
 * What activating a host opens: the shell where there is one, the file browser otherwise.
 *
 * A hook so the card and the list row share it — they are two drawings of the same object, and a
 * double-click meaning different things in the two would be a bug nobody would think to look for.
 */
function useOpenPrimary() {
  const openSession = useRemoteStore((s) => s.openSession);
  const openSftp = useRemoteStore((s) => s.openSftp);
  const openDetails = useRemoteStore((s) => s.openDetails);

  return (host: RemoteHostRow, spec: RemoteHostSpec) => {
    if (!hasAddress(spec)) return openDetails(host.id);
    if (capabilities(spec).shell) void openSession(host.id);
    else openSftp(host.id);
  };
}

/** The three things you came to a machine for, wherever the host is drawn. */
function HostActions({ host }: { host: RemoteHostRow }) {
  const openSession = useRemoteStore((s) => s.openSession);
  const openForwards = useRemoteStore((s) => s.openForwards);
  const openScreen = useRemoteStore((s) => s.openScreen);
  const openSftp = useRemoteStore((s) => s.openSftp);
  const openDetails = useRemoteStore((s) => s.openDetails);
  const t = useT();

  const spec = parseHostSpec(host);
  const act = (run: () => void) => (hasAddress(spec) ? run() : openDetails(host.id));
  // Same table the tree uses, for the same reason: an FTP host has files and nothing else, so it
  // gets one action rather than four, three of which could not work.
  const can = capabilities(spec);

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {can.shell && (
        <Action icon={Terminal} label={t("remote.openShell")} onClick={() => act(() => void openSession(host.id))} />
      )}
      <Action icon={FolderOpen} label={t("remote.files")} onClick={() => act(() => openSftp(host.id))} />
      {can.forwards && (
        <Action icon={Waypoints} label={t("remote.portForwards")} onClick={() => act(() => openForwards(host.id))} />
      )}
      {can.screen && spec.screen.protocol !== "none" && (
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
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-6 w-6 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-accent)] dark:hover:bg-white/[0.08]"
    >
      <Icon size={13} />
    </button>
  );
}

function HostCard({ host }: { host: RemoteHostRow }) {
  const openPrimary = useOpenPrimary();
  const selectHost = useRemoteStore((s) => s.selectHost);
  const selected = useRemoteStore((s) => s.selectedHostId === host.id);
  const hasSession = useRemoteStore((s) =>
    s.tabs.some((tab) => tab.kind === "session" && tab.hostId === host.id && !tab.exited),
  );
  const hasForward = useRemoteStore((s) => s.forwards.some((f) => f.host_id === host.id));
  const t = useT();

  const spec = parseHostSpec(host);
  const detail = describeHost(spec);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => selectHost(host.id)}
      onDoubleClick={() => openPrimary(host, spec)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          openPrimary(host, spec);
        }
      }}
      className={`group flex cursor-default flex-col gap-1.5 rounded-lg border p-2.5 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)] ${
        selected
          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
          : "border-[var(--cf-border)] hover:border-[var(--cf-accent)]/50"
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <HostDot session={hasSession} active={hasForward} color={host.color} />
        <OsGlyph os={spec.os} size={14} />
        <KindGlyph kind={spec.kind} size={13} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--cf-text)]">
          {host.name}
        </span>
      </div>

      <span className="min-w-0 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
        {detail || t("remote.needsAddress")}
      </span>

      <div className="flex min-w-0 items-center gap-1">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 overflow-hidden">
          {host.group_name && <Pill>{host.group_name}</Pill>}
          {spec.tags.slice(0, 2).map((tag) => (
            <Pill key={tag}>{tag}</Pill>
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

function HostListRow({ host }: { host: RemoteHostRow }) {
  const openPrimary = useOpenPrimary();
  const selectHost = useRemoteStore((s) => s.selectHost);
  const selected = useRemoteStore((s) => s.selectedHostId === host.id);
  const hasSession = useRemoteStore((s) =>
    s.tabs.some((tab) => tab.kind === "session" && tab.hostId === host.id && !tab.exited),
  );
  const hasForward = useRemoteStore((s) => s.forwards.some((f) => f.host_id === host.id));

  const spec = parseHostSpec(host);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => selectHost(host.id)}
      onDoubleClick={() => openPrimary(host, spec)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          openPrimary(host, spec);
        }
      }}
      className={`group flex cursor-default items-center gap-2 px-3 py-1.5 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)] ${
        selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      <HostDot session={hasSession} active={hasForward} color={host.color} />
      <OsGlyph os={spec.os} size={13} />
      <span className="w-[160px] shrink-0 truncate text-[12px] font-medium text-[var(--cf-text)]">
        {host.name}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
        {describeHost(spec)}
      </span>
      <span className="hidden shrink-0 items-center gap-1 sm:flex">
        {host.group_name && <Pill>{host.group_name}</Pill>}
        {spec.tags.slice(0, 2).map((tag) => (
          <Pill key={tag}>{tag}</Pill>
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
