import { useState, type MouseEvent, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  CirclePlay,
  Container,
  Copy,
  FolderPlus,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  Radar,
  RotateCw,
  Square,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { Tooltip } from "../common/Tooltip";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { useT } from "../../state/languageStore";
import { deriveRunning, isActive, useServicesStore, type RunningService } from "../../state/servicesStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { runsContainers, serviceDetectedPorts, type ServiceRow, type ServiceRuntime } from "../../types/services";
import { PortChip, StatusGlyph, portsFor, rowHint, shortDuration, statusLabel, useElapsed } from "./serviceBits";
import { buttonClass } from "../common/Button";

/**
 * A menu glyph that holds still.
 *
 * `ContextMenu` spins a *disabled* item's `icon`, because elsewhere disabled means "in flight". Here
 * it means "nothing to do right now" — restart a group with nothing running — and a spinning glyph
 * on it reads as work happening when none is. `leading` is drawn as given, so it goes through that.
 */
const still = (Icon: LucideIcon) => <Icon size={13} className="mt-[2px] shrink-0 opacity-70" />;

/**
 * The services half of the dock's list: groups of services, the Ports view, and whatever is still
 * running in another workspace.
 *
 * A group is a unit of work in both directions — it starts in dependency order and stops in the
 * reverse — so its header carries both verbs, drawn rather than hover-revealed: they are what the
 * panel is for.
 */
export function ServiceList({
  selectedId,
  portsSelected,
  onSelect,
  onSelectPorts,
  onEdit,
  onNew,
  onImport,
}: {
  selectedId: string | null;
  portsSelected: boolean;
  onSelect: (id: string) => void;
  onSelectPorts: () => void;
  onEdit: (service: ServiceRow) => void;
  onNew: (groupId: string | null) => void;
  onImport: () => void;
}) {
  const t = useT();
  const services = useServicesStore((s) => s.services);
  const groups = useServicesStore((s) => s.groups);
  const runtime = useServicesStore((s) => s.runtime);
  const addGroup = useServicesStore((s) => s.addGroup);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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
      id: group.id as string | null,
      name: group.name,
      services: services.filter((s) => s.group_id === group.id),
    })),
  ];
  const elsewhere = deriveRunning(runtime, workspaceId).filter((r) => r.foreign);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const empty = services.length === 0 && groups.length === 0;

  return (
    <>
      <SectionHeader
        icon={CirclePlay}
        label={t("services.title")}
        // Not while the list is empty: the card below offers the same two ways in, with words on
        // them, and three bare glyphs above it were the same choice asked twice.
        actions={
          empty ? null : (
            <>
              <HeaderButton onClick={onImport} label={t("services.detect")} description={t("services.detectHint")}>
                <Radar size={11} />
              </HeaderButton>
              <HeaderButton onClick={() => void newGroup()} label={t("services.newGroup")} description={t("services.newGroupHint")}>
                <FolderPlus size={11} />
              </HeaderButton>
              <HeaderButton onClick={() => onNew(null)} label={t("services.newService")} description={t("services.newServiceHint")}>
                <Plus size={11} />
              </HeaderButton>
            </>
          )
        }
      />

      {/* The two ways in, and nothing around them. This sits above the terminals in every
          workspace without services, so it is kept to what can be pressed: no box, no heading, no
          paragraph — the user took each of those out. The Detect button's tooltip still says what
          it reads. Centred under the heading rather than hung off its left edge (the user's ask,
          2026-09-25): alone in the section, two buttons pushed left read as a row that ran out. */}
      {services.length === 0 && (
        <div className="mx-2 mb-1.5 mt-1 flex flex-wrap justify-center gap-1.5">
          <Tooltip side="top" label={t("services.detect")} description={t("services.detectHint")}>
            <button
              onClick={onImport}
              className={buttonClass({ variant: "primary", size: "sm" })}
            >
              <Radar size={11} />
              {t("services.detect")}
            </button>
          </Tooltip>
          <button
            onClick={() => onNew(null)}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            <Plus size={11} />
            {t("services.createByHand")}
          </button>
        </div>
      )}

      {sections.map((section) => (
        <GroupSection
          key={section.id ?? "ungrouped"}
          groupId={section.id}
          name={section.name}
          services={section.services}
          runtime={runtime}
          collapsed={collapsed.has(section.id ?? "ungrouped")}
          onToggle={() => toggle(section.id ?? "ungrouped")}
          selectedId={selectedId}
          onSelect={onSelect}
          onEdit={onEdit}
          onNew={() => onNew(section.id)}
        />
      ))}

      {/* Machine-wide, which is why it sits after the groups rather than in one: it answers "what
          is on port 3000" whether or not a service of this workspace put it there. */}
      <Tooltip side="right" label={t("services.ports.title")} description={t("services.ports.hint")}>
        <button
          onClick={onSelectPorts}
          className={`mx-1 mt-1 flex items-center gap-1.5 rounded-md px-2 py-[3px] text-left text-[12px] ${
            portsSelected
              ? "bg-[var(--cf-accent-soft)] text-[var(--cf-text)]"
              : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
          }`}
        >
          <Network size={11} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("services.ports.title")}</span>
          <ChevronRight size={11} className="shrink-0 opacity-50" />
        </button>
      </Tooltip>

      {/* Still running, just not from here — a way *back*, not a remote control: it stops, or it
          takes you to where the service lives. */}
      {elsewhere.length > 0 && (
        <>
          <SectionHeader icon={CirclePlay} label={t("services.elsewhere")} />
          {elsewhere.map((run) => (
            <ElsewhereRow key={run.id} run={run} />
          ))}
        </>
      )}
    </>
  );
}

export function SectionHeader({
  icon: Icon,
  label,
  actions,
}: {
  icon: typeof CirclePlay;
  label: string;
  actions?: ReactNode;
}) {
  return (
    // Not sticky. Two sticky headers in one scroll container pin on top of each other rather than
    // pushing, and the list is short enough that scrolling past a heading is not a way to get lost.
    <div className="mt-1 flex items-center gap-1 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1 first:mt-0 first:border-t-0">
      <Icon size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
        {label}
      </span>
      {actions}
    </div>
  );
}

export function HeaderButton({
  onClick,
  label,
  description,
  disabled,
  children,
}: {
  onClick: () => void;
  label: string;
  description?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip side="top" label={label} description={description}>
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md shrink-0 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:opacity-40"
      >
        {children}
      </button>
    </Tooltip>
  );
}

function GroupSection({
  groupId,
  name,
  services,
  runtime,
  collapsed,
  onToggle,
  selectedId,
  onSelect,
  onEdit,
  onNew,
}: {
  groupId: string | null;
  name: string;
  services: ServiceRow[];
  runtime: Record<string, ServiceRuntime>;
  collapsed: boolean;
  onToggle: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (service: ServiceRow) => void;
  onNew: () => void;
}) {
  const t = useT();
  const startGroup = useServicesStore((s) => s.startGroup);
  const stopGroup = useServicesStore((s) => s.stopGroup);
  const restartGroup = useServicesStore((s) => s.restartGroup);
  const renameGroup = useServicesStore((s) => s.renameGroup);
  const removeGroup = useServicesStore((s) => s.removeGroup);
  const [menu, setMenu] = useState<{ x: number; y: number; anchor?: DOMRect } | null>(null);

  const states = services.map((s) => runtime[s.id]);
  const activeCount = states.filter(isActive).length;
  // A one-shot that finished is up for the group's purposes: it did what it was for, and what waits
  // for it can go. Counting it as "down" is what kept a fully started group offering to start.
  const upCount = states.filter((r) => r?.status === "ready" || r?.status === "completed").length;
  const leftToStart = states.filter((r) => !isActive(r) && r?.status !== "completed").length;
  const anyFailed = states.some((r) => r?.status === "failed");
  const anyBusy = states.some((r) => r && ["waiting", "starting", "stopping", "restarting"].includes(r.status));
  const allUp = services.length > 0 && upCount === services.length;
  const summaryTone = anyFailed
    ? "var(--cf-danger)"
    : anyBusy
      ? "var(--cf-warning)"
      : allUp
        ? "var(--cf-success)"
        : "var(--cf-text-muted)";

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

  const menuItems: MenuItem[] = [
    { label: t("services.startGroup"), leading: still(CirclePlay), onClick: () => void startGroup(groupId), disabled: !services.length },
    { label: t("services.restartGroup"), leading: still(RotateCw), onClick: () => void restartGroup(groupId), disabled: !activeCount },
    { label: t("services.stopGroup"), leading: still(Square), onClick: () => void stopGroup(groupId), disabled: !activeCount },
    { label: t("services.newServiceHere"), icon: Plus, onClick: onNew, separated: true },
    ...(groupId
      ? [
          { label: t("services.renameGroup"), icon: Pencil, onClick: () => void rename() },
          { label: t("services.deleteGroup"), icon: Trash2, danger: true, onClick: () => void remove() },
        ]
      : []),
  ];

  return (
    <div className="mb-0.5">
      <div
        className="group/section flex select-none items-center gap-1 px-2 pb-0.5 pt-1"
        onContextMenu={(e: MouseEvent) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-medium text-[var(--cf-text)]"
        >
          {collapsed ? (
            <ChevronRight size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
          ) : (
            <ChevronDown size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
          )}
          <span className="truncate">{name}</span>
          <span
            className="shrink-0 text-[10.5px] font-normal tabular-nums"
            style={{ color: summaryTone }}
            title={
              activeCount > 0 || upCount > 0
                ? t("services.groupCountHint", { up: upCount, total: services.length })
                : services.length === 1
                  ? t("services.groupIdleHintOne")
                  : t("services.groupIdleHint", { count: services.length })
            }
          >
            {activeCount > 0 || upCount > 0 ? `${upCount}/${services.length}` : services.length}
          </span>
        </button>
        {/* Drawn, not hover-revealed: starting and stopping the group are what this panel is for.
            Start stays while anything is down; stop appears once anything is up. */}
        {leftToStart > 0 && (
          <HeaderButton onClick={() => void startGroup(groupId)} label={t("services.startGroup")} description={t("services.startGroupHint")}>
            <CirclePlay size={11} className="text-[var(--cf-success)]" />
          </HeaderButton>
        )}
        {activeCount > 0 && (
          <HeaderButton onClick={() => void stopGroup(groupId)} label={t("services.stopGroup")} description={t("services.stopGroupHint")}>
            <Square size={10} className="text-[var(--cf-danger)]" />
          </HeaderButton>
        )}
        <button
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom, anchor: rect });
          }}
          aria-label={t("services.moreActions")}
          className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md shrink-0 text-[var(--cf-text-muted)] opacity-0 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] focus:opacity-100 group-hover/section:opacity-100"
        >
          <MoreHorizontal size={12} />
        </button>
      </div>
      {!collapsed &&
        services.map((service) => (
          <ServiceRowItem
            key={service.id}
            service={service}
            runtime={runtime[service.id]}
            selected={service.id === selectedId}
            onSelect={() => onSelect(service.id)}
            onEdit={() => onEdit(service)}
          />
        ))}
      {!collapsed && services.length === 0 && (
        <button
          onClick={onNew}
          className="ml-6 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
        >
          {t("services.emptyGroup")}
        </button>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchor={menu.anchor ? { top: menu.anchor.top, bottom: menu.anchor.bottom, left: menu.anchor.left, right: menu.anchor.right, align: "end" } : undefined}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function ServiceRowItem({
  service,
  runtime,
  selected,
  onSelect,
  onEdit,
}: {
  service: ServiceRow;
  runtime: ServiceRuntime | undefined;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const t = useT();
  const services = useServicesStore((s) => s.services);
  const start = useServicesStore((s) => s.start);
  const stop = useServicesStore((s) => s.stop);
  const restart = useServicesStore((s) => s.restart);
  const remove = useServicesStore((s) => s.remove);
  const add = useServicesStore((s) => s.add);
  const [menu, setMenu] = useState<{ x: number; y: number; anchor?: DOMRect } | null>(null);

  const status = runtime?.status ?? "stopped";
  const active = isActive(runtime);
  const elapsed = useElapsed(status === "starting" ? runtime?.startedAt : null);
  const { ports, live } = portsFor(runtime, serviceDetectedPorts(service));
  const nameOf = (id: string) => services.find((s) => s.id === id)?.name ?? null;
  const blocker = runtime?.blockedBy ? nameOf(runtime.blockedBy) : null;
  const hint = rowHint(service, runtime, nameOf, t);

  const confirmRemove = async () => {
    if (await confirmAction(t("services.deleteConfirm", { name: service.name }))) await remove(service.id);
  };

  const duplicate = () =>
    void add({ ...service, id: "", name: t("services.copyOf", { name: service.name }), detected_ports: "[]" });

  const items: MenuItem[] = [
    active
      ? { label: t("services.stop"), leading: still(Square), onClick: () => void stop(service.id), disabled: status === "stopping" }
      : { label: t("services.start"), icon: CirclePlay, onClick: () => void start(service.id) },
    { label: t("services.restart"), leading: still(RotateCw), onClick: () => void restart(service.id), disabled: !active },
    { label: t("services.edit"), icon: Pencil, onClick: onEdit, separated: true },
    { label: t("services.duplicate"), icon: Copy, onClick: duplicate },
    { label: t("services.delete"), icon: Trash2, danger: true, onClick: () => void confirmRemove() },
  ];

  let meta: ReactNode = null;
  if (status === "waiting") {
    meta = (
      <span className="min-w-0 shrink truncate text-[10.5px] text-[var(--cf-text-muted)]">
        {blocker ? `↳ ${blocker}` : statusLabel(status, t)}
      </span>
    );
  } else if (status === "starting") {
    meta = (
      <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-warning)]">
        {elapsed !== null ? shortDuration(elapsed) : ""}
      </span>
    );
  } else if (status === "restarting") {
    meta = <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-warning)]">↻ {runtime?.restarts}/3</span>;
  } else if (status === "stopping") {
    meta = <span className="shrink-0 text-[10.5px] text-[var(--cf-warning)]">{statusLabel(status, t)}</span>;
  } else if (status === "failed") {
    meta = (
      <span className="shrink-0 text-[10.5px] text-[var(--cf-danger)]">
        {runtime?.error === "dependencyFailed" || runtime?.error === "dependencyStopped"
          ? `↳ ${blocker ?? "?"}`
          : runtime?.exitCode !== null && runtime?.exitCode !== undefined
            ? t("services.exitCodeShort", { code: runtime.exitCode })
            : statusLabel(status, t)}
      </span>
    );
  }

  return (
    <div
      onClick={onSelect}
      onDoubleClick={() => !active && void start(service.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      // The glyph's shape says the state to someone who has learnt the shapes; this says it to
      // everyone else, along with what the state is waiting on.
      title={hint}
      className={`group/row mx-1 flex cursor-pointer select-none items-center gap-1.5 rounded-md py-[3px] pl-4 pr-1 text-[12px] ${
        selected
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-text)]"
          : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
      }`}
    >
      <StatusGlyph status={status} />
      <span className={`min-w-0 flex-1 truncate ${active || selected ? "text-[var(--cf-text)]" : ""}`}>{service.name}</span>
      <span className="sr-only">{statusLabel(status, t)}</span>
      {runsContainers(service.command) && (
        <Container size={10} className="shrink-0 opacity-50" aria-hidden />
      )}
      {meta}
      {!meta && ports.length > 0 && (
        <span className="flex shrink-0 items-center gap-0.5">
          <PortChip port={ports[0]} dim={!live} />
          {ports.length > 1 && <span className="text-[10.5px] tabular-nums opacity-60">+{ports.length - 1}</span>}
        </span>
      )}

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/row:opacity-100">
        {active ? (
          <>
            <RowButton onClick={() => void restart(service.id)} label={t("services.restart")}>
              <RotateCw size={10} />
            </RowButton>
            <RowButton onClick={() => void stop(service.id)} label={t("services.stop")} danger>
              <Square size={9} />
            </RowButton>
          </>
        ) : (
          <RowButton onClick={() => void start(service.id)} label={t("services.start")}>
            <CirclePlay size={11} />
          </RowButton>
        )}
        <RowButton
          onClick={(e) => {
            onSelect();
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom, anchor: rect });
          }}
          label={t("services.moreActions")}
        >
          <MoreHorizontal size={11} />
        </RowButton>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchor={menu.anchor ? { top: menu.anchor.top, bottom: menu.anchor.bottom, left: menu.anchor.left, right: menu.anchor.right, align: "end" } : undefined}
          items={items}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * A service running in a workspace other than the one on screen.
 *
 * Two things only. **Stop** works from here because stopping needs no context — and because the
 * whole reason you found this row is that you forgot it was running. **Go there** switches
 * workspace, which is the honest way to reach everything else.
 */
function ElsewhereRow({ run }: { run: RunningService }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const stop = useServicesStore((s) => s.stop);
  const t = useT();

  const workspace = workspaces.find((w) => w.id === run.workspaceId) ?? null;

  return (
    <div className="group/row mx-1 flex select-none items-center gap-1.5 rounded-md py-[3px] pl-4 pr-1 text-[12px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
      <StatusGlyph status={run.status} />
      <span className="min-w-0 flex-1 truncate">{run.name}</span>
      {workspace && (
        <button
          onClick={() => setActiveWorkspace(workspace.id)}
          title={t("services.goToWorkspace", { name: workspace.name })}
          className="flex shrink-0 items-center gap-1 rounded border border-[var(--cf-border)] px-1 text-[10.5px] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: workspace.color }} />
          <span className="max-w-[70px] truncate">{workspace.name}</span>
        </button>
      )}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/row:opacity-100">
        <RowButton onClick={() => void stop(run.id)} label={t("services.stop")} danger>
          <Square size={9} />
        </RowButton>
      </div>
    </div>
  );
}

function RowButton({
  onClick,
  label,
  danger,
  children,
}: {
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  label: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      title={label}
      aria-label={label}
      className={`flex h-[18px] w-[18px] items-center justify-center rounded hover:bg-[var(--cf-press)] ${
        danger ? "hover:text-[var(--cf-danger)]" : "hover:text-[var(--cf-text)]"
      }`}
    >
      {children}
    </button>
  );
}
