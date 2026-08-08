import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Briefcase, Check, ChevronDown, Plus } from "lucide-react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import { useDismissOnOutside } from "../../lib/useDismissOnOutside";
import { DEFAULT_WORKSPACE_COLOR } from "../../lib/workspaceColors";
import { Tooltip } from "../common/Tooltip";

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
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const t = useT();

  const active = workspaces.find((w) => w.id === activeWorkspaceId);
  const color = active?.color ?? DEFAULT_WORKSPACE_COLOR;
  const name = active?.name ?? "CodeFlow";

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
    await addWorkspace(newName.trim(), "briefcase", "#6366f1");
    setNewName("");
    setCreating(false);
  };

  /** The workspace's own tile. The only thing left of the trigger once the panel is folded, and the
   *  same square the project chips below it are — a rail reads as a column of one kind of thing. */
  const tile = (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white"
      style={{ background: color }}
    >
      <Briefcase size={13} />
    </span>
  );

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
          leading={<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
        >
          <button onClick={toggle} aria-label={name} aria-expanded={open} className="flex">
            {tile}
          </button>
        </Tooltip>
      ) : (
        <button
          onClick={toggle}
          aria-expanded={open}
          className="flex h-8 w-full items-center gap-2 rounded-lg py-1 pl-1 pr-1.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        >
          {tile}
          <span className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold">{name}</span>
          <ChevronDown size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
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
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                onClick={() => {
                  setActiveWorkspace(ws.id);
                  dismiss();
                }}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] ${
                  ws.id === activeWorkspaceId
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                }`}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: ws.color }} />
                <span className="truncate">{ws.name}</span>
              </button>
            ))}

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
                  className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 text-[13px] outline-none focus:border-[var(--cf-accent)]"
                />
                <button onClick={create} className="text-[var(--cf-accent)]">
                  <Check size={15} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
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
    </div>
  );
}
