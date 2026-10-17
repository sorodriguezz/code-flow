import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Check, ChevronsUpDown, Palette, Pencil, Plus, Shapes, Trash2 } from "lucide-react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useDismissOnOutside } from "../../lib/useDismissOnOutside";
import { DEFAULT_WORKSPACE_COLOR, WORKSPACE_COLORS } from "../../lib/workspaceColors";
import { listProjects } from "../../lib/tauri/commands";
import { Tooltip } from "../common/Tooltip";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { fieldClass } from "../common/recipes";
import { INITIALS_ICON, WORKSPACE_ICONS, WorkspaceGlyph } from "./WorkspaceGlyph";

/** The workspaces with a model running in them right now — the dot on their row. */
function useBusyWorkspaces(): Set<string> {
  const active = useAiRunStore((s) => s.active);
  const about = useAiRunStore((s) => s.aboutByRun);
  return useMemo(() => {
    const busy = new Set<string>();
    for (const [runId, running] of Object.entries(active)) {
      const workspaceId = running ? about[runId]?.workspaceId : null;
      if (workspaceId) busy.add(workspaceId);
    }
    return busy;
  }, [active, about]);
}

/** Fixed, so the list doesn't change width with whatever the workspaces happen to be called — and
 *  so it can be positioned before it has been measured. */
const MENU_WIDTH = 256;

/**
 * Which workspace everything else on screen belongs to, and the way to change it.
 *
 * It sits at the **top of the projects panel**, above the first repository. It spent a while in the
 * title bar instead, on the argument that a control naming the scope of the whole window should not
 * live inside a panel that can fold away — and that is a real objection, answered here rather than
 * avoided: the switcher folds *with* the panel instead of disappearing into it. Collapsed it is the
 * workspace's coloured tile at the head of the rail of project chips, same 24px square, still the
 * way in to the list.
 *
 * Which leaves the argument that put it back: the thing directly underneath it is the list of
 * repositories it decides the contents of. Up in the title bar that relationship was something you
 * had to be told; here it is the reading order.
 *
 * The menu is **portalled**, and that is what makes any of this possible. The panel clips (it has
 * to — it is what the fold animates against) and it scrolls, so a list rendered in the flow would
 * be cut off at the rail's 50px and would scroll away with the projects. Portalled and positioned
 * against the trigger, it opens over the window at full width in either state.
 */
export function WorkspaceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);
  const busy = useBusyWorkspaces();
  const [open, setOpen] = useState(false);
  /** Repositories per workspace, read when the menu opens — the store only holds the ones whose
   *  workspace has been visited. */
  const [counts, setCounts] = useState<Record<string, number>>({});
  /** The workspace being renamed in place, and the name being typed. */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /** Where a row's right-click menu was opened, and for which workspace. */
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const t = useT();

  const active = workspaces.find((w) => w.id === activeWorkspaceId);
  const color = active?.color ?? DEFAULT_WORKSPACE_COLOR;
  const name = active?.name ?? "CodeFlow";
  const icon = active?.icon ?? INITIALS_ICON;
  const countOf = (id: string) => projectsByWorkspace[id]?.length ?? counts[id];

  /**
   * Clicking anywhere else puts it away — it was staying open over whatever you clicked next.
   *
   * The half-typed name of a new workspace goes with it. Reopening to find a name you had already
   * abandoned, in a field you had already left, is worse than starting it again.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => {
    setOpen(false);
    setCreating(false);
    setNewName("");
    setRenaming(null);
  }, []);
  // The menu is a portal, so it is not inside `rootRef` — without its own ref here every click on a
  // row would be an outside click, and the list would close before the row it landed on could act.
  useDismissOnOutside(open, dismiss, [rootRef, menuRef]);

  const toggle = () => {
    if (open) {
      dismiss();
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Left-aligned with the trigger, pulled back on itself only when that would run it off the
    // right edge — which the expanded panel never does and a 50px rail never needs.
    setAt({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
      top: rect.bottom + 4,
    });
    setOpen(true);
    // Read fresh each time it opens: a repository moved or added from another window since.
    void Promise.all(
      workspaces.map(async (ws) => [ws.id, (await listProjects(ws.id).catch(() => [])).length] as const),
    ).then((pairs) => setCounts(Object.fromEntries(pairs)));
  };

  // Anything that moves the trigger takes its menu with it, and the coordinates above were read
  // once. Folding the panel is the one that matters: the trigger changes shape *and* position, and
  // a list left hanging over where it used to be is a list pointing at nothing.
  useEffect(() => {
    if (!open) return;
    dismiss();
    // Deliberately keyed on `collapsed` alone — this is "the fold happened", not a subscription to
    // everything that could ever reposition it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", dismiss);
    return () => window.removeEventListener("resize", dismiss);
  }, [open, dismiss]);

  const create = async () => {
    if (!newName.trim()) return;
    // The same colour Settings gives a new workspace, and its initials rather than a briefcase —
    // the icon is the menu's to change.
    await addWorkspace(newName.trim(), INITIALS_ICON, DEFAULT_WORKSPACE_COLOR);
    setNewName("");
    setCreating(false);
  };

  const commitRename = async () => {
    if (!renaming) return;
    const next = renaming.name.trim();
    const current = workspaces.find((ws) => ws.id === renaming.id);
    setRenaming(null);
    if (!next || next === current?.name) return;
    await useWorkspaceStore.getState().renameWorkspace(renaming.id, next).catch((e: unknown) => pushErrorToast(String(e)));
  };

  /**
   * The row's right-click: everything Settings › Projects does to a workspace, where the workspace
   * is. Delete keeps Settings' two rules — never the last one, never one still holding repositories
   * — and says which applies instead of hiding the entry.
   */
  const rowMenuItems = (id: string): MenuItem[] => {
    const ws = workspaces.find((item) => item.id === id);
    if (!ws) return [];
    const store = useWorkspaceStore.getState();
    const index = workspaces.findIndex((item) => item.id === id);
    const held = countOf(id) ?? 0;
    const blocked = workspaces.length <= 1 ? t("sidebar.wsDeleteLast") : held > 0 ? t("sidebar.wsDeleteNotEmpty", { n: held }) : null;
    return [
      { label: t("sidebar.wsRename"), icon: Pencil, onClick: () => setRenaming({ id, name: ws.name }) },
      {
        label: t("sidebar.wsColor"),
        icon: Palette,
        onClick: () => {},
        children: WORKSPACE_COLORS.map((swatch) => ({
          label: swatch,
          swatch,
          checked: swatch.toLowerCase() === ws.color.toLowerCase(),
          onClick: () => void store.setWorkspaceColor(id, swatch).catch((e: unknown) => pushErrorToast(String(e))),
        })),
      },
      {
        label: t("sidebar.wsIcon"),
        icon: Shapes,
        onClick: () => {},
        children: [
          {
            label: t("sidebar.wsIconInitials"),
            leading: <WorkspaceGlyph name={ws.name} icon={INITIALS_ICON} color={ws.color} size={16} />,
            onClick: () => void store.setWorkspaceIcon(id, INITIALS_ICON).catch((e: unknown) => pushErrorToast(String(e))),
          },
          ...Object.keys(WORKSPACE_ICONS).map((key) => ({
            label: t(`sidebar.wsIcons.${key}` as TranslationKey),
            leading: <WorkspaceGlyph name={ws.name} icon={key} color={ws.color} size={16} />,
            onClick: () => void store.setWorkspaceIcon(id, key).catch((e: unknown) => pushErrorToast(String(e))),
          })),
        ],
      },
      {
        label: t("sidebar.wsMoveUp"),
        icon: ArrowUp,
        separated: true,
        disabled: index <= 0,
        onClick: () => void store.reorderWorkspace(id, index - 1),
      },
      {
        label: t("sidebar.wsMoveDown"),
        icon: ArrowDown,
        disabled: index >= workspaces.length - 1,
        onClick: () => void store.reorderWorkspace(id, index + 2),
      },
      {
        label: blocked ?? t("sidebar.wsDelete"),
        icon: Trash2,
        danger: blocked === null,
        separated: true,
        disabled: blocked !== null,
        onClick: async () => {
          if (!(await confirmAction(t("settings.removeWorkspaceConfirm", { name: ws.name })))) return;
          await store.removeWorkspace(id).catch((e: unknown) => pushErrorToast(String(e)));
        },
      },
    ];
  };

  /**
   * Folded, the tile is the whole switcher — and a scroll over it walks the workspaces, one per
   * notch, the way the switcher lock's chord does. Throttled so a trackpad's burst is one step.
   */
  const wheelAt = useRef(0);
  const onWheel = (event: React.WheelEvent) => {
    if (!collapsed || workspaces.length < 2 || Math.abs(event.deltaY) < 4) return;
    const now = Date.now();
    if (now - wheelAt.current < 350) return;
    wheelAt.current = now;
    const at = workspaces.findIndex((ws) => ws.id === activeWorkspaceId);
    const next = workspaces[(at + (event.deltaY > 0 ? 1 : -1) + workspaces.length) % workspaces.length];
    if (next) setActiveWorkspace(next.id);
  };

  /** The workspace's own tile. The only thing left of the trigger once the panel is folded, and the
   *  same square the project chips below it are — a rail reads as a column of one kind of thing. */
  const tile = <WorkspaceGlyph name={name} icon={icon} color={color} size={28} />;

  return (
    <div ref={rootRef} data-tour="workspace-switcher" className={collapsed ? "" : "w-full"}>
      {collapsed ? (
        // Folded there is no room for the name, so the name becomes the tooltip — the same trade
        // every chip in the rail underneath makes, down to the colour dot in front of it: a rail of
        // identically-shaped squares is told apart by colour, so the label that stands in for one
        // carries the same colour it does.
        <Tooltip
          side="right"
          label={name}
          description={workspaces.length > 1 ? t("sidebar.wsWheelHint") : undefined}
          leading={<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
        >
          <button onClick={toggle} onWheel={onWheel} aria-label={name} aria-expanded={open} className="flex">
            {tile}
          </button>
        </Tooltip>
      ) : (
        <button
          onClick={toggle}
          aria-expanded={open}
          className="flex h-9 w-full items-center gap-2.5 rounded-lg py-1 pl-1 pr-2 hover:bg-[var(--cf-hover)]"
        >
          {tile}
          <span className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold">{name}</span>
          <ChevronsUpDown size={14} className="shrink-0 text-[var(--cf-text-faint)]" />
        </button>
      )}

      {open &&
        at &&
        createPortal(
          <div
            ref={menuRef}
            style={{ left: at.left, top: at.top, width: MENU_WIDTH }}
            className="cf-fade-in fixed z-40 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1.5 shadow-[var(--cf-shadow)]"
          >
            {workspaces.map((ws) =>
              renaming?.id === ws.id ? (
                <div key={ws.id} className="flex items-center gap-1.5 px-1 py-1">
                  <WorkspaceGlyph name={renaming.name || ws.name} icon={ws.icon} color={ws.color} size={20} />
                  <input
                    autoFocus
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: ws.id, name: e.target.value })}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      else if (e.key === "Escape") setRenaming(null);
                    }}
                    aria-label={t("sidebar.wsRename")}
                    className={fieldClass({ size: "sm", className: "flex-1" })}
                  />
                </div>
              ) : (
                <button
                  key={ws.id}
                  data-drop-workspace={ws.id}
                  onClick={() => {
                    setActiveWorkspace(ws.id);
                    dismiss();
                  }}
                  // Renaming where the name is, as a file manager does.
                  onDoubleClick={() => setRenaming({ id: ws.id, name: ws.name })}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setRowMenu({ id: ws.id, x: event.clientX, y: event.clientY });
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] ${
                    ws.id === activeWorkspaceId
                      ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                      : "hover:bg-[var(--cf-hover)]"
                  }`}
                >
                  <WorkspaceGlyph name={ws.name} icon={ws.icon} color={ws.color} size={20} />
                  <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                  {/* A model running in it: work that outlives the screen it was started from has
                      to stay findable from here too. */}
                  {busy.has(ws.id) && (
                    <span title={t("sidebar.wsBusy")} className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--cf-accent-fill)]" />
                  )}
                  {countOf(ws.id) !== undefined && (
                    <span title={t("sidebar.wsRepoCount", { n: countOf(ws.id) ?? 0 })} className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)]">
                      {countOf(ws.id)}
                    </span>
                  )}
                </button>
              ),
            )}

            {creating ? (
              <div className="flex items-center gap-1.5 px-1 py-1">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === "Enter") await create();
                    else if (e.key === "Escape") setCreating(false);
                  }}
                  placeholder={t("sidebar.workspaceName")}
                  className={fieldClass({ size: "sm", className: "flex-1" })}
                />
                <button onClick={create} className="text-[var(--cf-accent)]">
                  <Check size={15} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
              >
                {/* Boxed to the same 10px the colour dots occupy, so this row's label starts on the
                    same column as the workspace names above it instead of half a character to their
                    left. The glyph itself is wider than its box and simply overhangs into the gap. */}
                <span className="flex w-2.5 shrink-0 justify-center">
                  <Plus size={14} />
                </span>
                {t("sidebar.newWorkspace")}
              </button>
            )}
          </div>,
          document.body,
        )}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          heading={workspaces.find((ws) => ws.id === rowMenu.id)?.name}
          items={rowMenuItems(rowMenu.id)}
          onClose={() => setRowMenu(null)}
        />
      )}
    </div>
  );
}
