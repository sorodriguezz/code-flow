import { useCallback, useRef, useState } from "react";
import { Briefcase, Check, ChevronDown, Plus } from "lucide-react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import { useDismissOnOutside } from "../../lib/useDismissOnOutside";
import { DEFAULT_WORKSPACE_COLOR } from "../../lib/workspaceColors";

/**
 * Which workspace everything else on screen belongs to, and the way to change it.
 *
 * It lives in the **title bar** rather than at the top of the sidebar, which is where it used to be.
 * Two reasons, and the second is the one that made it necessary: the sidebar now folds down to a
 * rail of project chips, and a control inside a panel that can fold is a control that can be folded
 * away — this one names the scope of the whole window, so it has to outlive the panel. And a
 * workspace is not a property of the repository list; sitting on top of that list said it was.
 */
export function WorkspaceSwitcher() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const t = useT();

  const active = workspaces.find((w) => w.id === activeWorkspaceId);

  /**
   * Clicking anywhere else puts it away — it was staying open over whatever you clicked next.
   *
   * The half-typed name of a new workspace goes with it. Reopening to find a name you had already
   * abandoned, in a field you had already left, is worse than starting it again.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => {
    setOpen(false);
    setCreating(false);
    setNewName("");
  }, []);
  useDismissOnOutside(open, dismiss, [rootRef]);

  return (
    // Opted out of the title bar's drag region, like the AI menu at the other end: the open menu is
    // a plain div, and under `deep` a press on it would start dragging the window instead of
    // picking a workspace.
    <div
      ref={rootRef}
      data-tour="workspace-switcher"
      data-tauri-drag-region="false"
      className="relative"
    >
      <button
        onClick={() => (open ? dismiss() : setOpen(true))}
        title={t("sidebar.workspaces")}
        // The cap grows with the window rather than being a fixed 220px: maximized there is room
        // for a workspace called something real, and a name that truncates identically at every
        // window size is a cap that isn't measuring anything. Still capped, because past ~360px the
        // name starts pushing the search and history buttons out of the corner they live in.
        //
        // `h-8` in a 44px bar. It sits a notch above the 28px buttons beside it on purpose: those
        // are actions, this one names what the whole window is showing, and it is the only control
        // in the corner that carries a colour of its own. The row is `items-center`, so the extra
        // four pixels grow either way from the same centre line and nothing beside it moves.
        className="flex h-8 max-w-[min(26vw,360px)] items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-black/10"
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white"
          style={{ background: active?.color ?? DEFAULT_WORKSPACE_COLOR }}
        >
          <Briefcase size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold">
          {active?.name ?? "CodeFlow"}
        </span>
        <ChevronDown size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
      </button>

      {open && (
        // Hangs off the left edge rather than stretching to the trigger's width: the trigger is
        // sized by whatever the workspace happens to be called, and a menu that changed width with
        // it would move its own rows every time you switched.
        <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1.5 shadow-[var(--cf-shadow)]">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => {
                setActiveWorkspace(ws.id);
                setOpen(false);
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
                  if (e.key === "Enter" && newName.trim()) {
                    await addWorkspace(newName.trim(), "briefcase", "#6366f1");
                    setNewName("");
                    setCreating(false);
                  } else if (e.key === "Escape") {
                    setCreating(false);
                  }
                }}
                placeholder={t("sidebar.workspaceName")}
                className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 text-[13px] outline-none focus:border-[var(--cf-accent)]"
              />
              <button
                onClick={async () => {
                  if (!newName.trim()) return;
                  await addWorkspace(newName.trim(), "briefcase", "#6366f1");
                  setNewName("");
                  setCreating(false);
                }}
                className="text-[var(--cf-accent)]"
              >
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
        </div>
      )}
    </div>
  );
}
