import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { ChevronDown, ChevronUp, Pencil, Plus, Settings2, SplitSquareHorizontal, TerminalSquare, X } from "lucide-react";
import { activeGroup, useTerminalStore, type TerminalTab } from "../../state/terminalStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useUiStore } from "../../state/uiStore";
import { ResizeHandle } from "../common/ResizeHandle";
import { TerminalPane } from "./TerminalPane";
import { useT } from "../../state/languageStore";
import { EmptyState } from "../common/EmptyState";
import { listShellProfiles } from "../../lib/tauri/commands";
import type { ShellProfile } from "../../types/domain";

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 640;

/**
 * The shell picker hanging off the `+` button, VS Code style: `+` opens the default profile,
 * the caret lists every shell found on this machine plus a way into the settings section.
 *
 * Profiles are re-fetched every time the menu opens rather than held in a store — the list is
 * small, and reading it fresh means a shell installed while the app was running, or a profile
 * just added in Settings, is in the menu without a restart or any invalidation plumbing.
 */
function ProfileMenu({ onPick, disabled }: { onPick: (profileId: string) => void; disabled: boolean }) {
  const t = useT();
  const openSettings = useUiStore((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ShellProfile[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; bottom: number; maxHeight: number } | null>(null);

  // The menu has to live in a portal, not beside the trigger: the dock's own container is
  // `overflow-hidden` (it animates its height open and closed), so anything positioned above the
  // toolbar gets clipped away to nothing. Same reason — and same fix — as `Select`.
  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      // Right-aligned to the trigger, growing upward: the dock sits at the bottom of the window,
      // so there is never room below it.
      right: Math.max(4, window.innerWidth - rect.right),
      bottom: window.innerHeight - rect.top + 4,
      maxHeight: Math.max(120, rect.top - 12),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    void listShellProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // Both nodes, since the menu is no longer a descendant of the trigger's wrapper.
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={t("terminal.selectProfile")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-6 w-4 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
      >
        <ChevronUp size={11} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: "fixed", right: pos.right, bottom: pos.bottom, maxHeight: pos.maxHeight }}
            className="z-[9999] min-w-[200px] overflow-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]"
          >
            <p className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("terminal.profilesHeading")}
            </p>
            {profiles.map((profile) => (
              <button
                key={profile.id}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onPick(profile.id);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-[var(--cf-text)] hover:bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)]"
              >
                <TerminalSquare size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                <span className="truncate">{profile.name}</span>
              </button>
            ))}
            <div className="my-1 border-t border-[var(--cf-border)]" />
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openSettings("terminal");
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-[var(--cf-text-muted)] hover:bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)] hover:text-[var(--cf-text)]"
            >
              <Settings2 size={12} className="shrink-0" />
              <span className="truncate">{t("terminal.configureProfiles")}</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Rendered by App.tsx inside an `AnimatePresence` so mount/unmount slides the dock in/out. */
export function TerminalDock() {
  const t = useT();
  const project = useWorkspaceStore((s) => s.activeProject());
  const byProject = useTerminalStore((s) => s.byProject);
  const openNew = useTerminalStore((s) => s.openNew);
  const closeTab = useTerminalStore((s) => s.close);
  const focus = useTerminalStore((s) => s.focus);
  const rename = useTerminalStore((s) => s.rename);
  const togglePanel = useTerminalStore((s) => s.togglePanel);
  const height = useLayoutStore((s) => s.sizes.terminalPanelHeight);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const activeProjectId = project?.id ?? null;
  const activeProj = activeProjectId ? byProject[activeProjectId] : undefined;
  const visibleIds = activeGroup(activeProj);

  // Inline tab renaming — same start/commit-on-blur-or-Enter/cancel-on-Escape shape the
  // activity list uses, so both rename affordances in the app behave identically.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const startRename = (tab: TerminalTab) => {
    setRenamingId(tab.id);
    setRenameValue(tab.title);
  };

  const commitRename = () => {
    const id = renamingId;
    setRenamingId(null);
    if (id && project) rename(project.id, id, renameValue);
  };

  // Every terminal ever opened — across every project — stays mounted (hidden via CSS unless
  // it belongs to the active project *and* is part of its currently active split group), so
  // switching projects never kills a shell or discards its scrollback; only explicitly closing
  // a tab does.
  const allPanes = Object.entries(byProject).flatMap(([projectId, proj]) =>
    proj.tabs.map((tab) => ({
      projectId,
      tab,
      visible: projectId === activeProjectId && visibleIds.includes(tab.id),
    })),
  );

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height, opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="flex shrink-0 flex-col overflow-hidden border-t border-[var(--cf-border)] bg-[var(--cf-surface)]"
    >
      <ResizeHandle
        axis="y"
        value={height}
        min={MIN_HEIGHT}
        max={MAX_HEIGHT}
        invert
        onChange={(h) => setSize("terminalPanelHeight", h)}
        onCommit={(h) => commitSize("terminalPanelHeight", h)}
      />
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2">
        <TerminalSquare size={13} className="mr-1 shrink-0 text-[var(--cf-text-muted)]" />
        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          {(activeProj?.tabs ?? []).map((tab) => {
            const isVisible = visibleIds.includes(tab.id);
            const isRenaming = renamingId === tab.id;
            return (
              <div
                key={tab.id}
                onClick={() => project && !isRenaming && focus(project.id, tab.id)}
                // Guarded: while the editor is open this same handler still sees double
                // clicks bubbling out of the input, and re-starting the rename would reset
                // the field to the old title mid-edit.
                onDoubleClick={() => !isRenaming && startRename(tab)}
                className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] ${
                  isVisible
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                }`}
              >
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setRenamingId(null);
                    }}
                    className="w-28 min-w-0 rounded-sm border border-[var(--cf-accent)] bg-transparent px-1 text-[12px] text-[var(--cf-text)] outline-none"
                  />
                ) : (
                  <>
                    {/* Titled by hand, so it can be any length — truncate and let the tooltip
                        carry the full text rather than letting one tab shove the rest away. */}
                    <span className="max-w-[150px] truncate" title={tab.title}>
                      {tab.title}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(tab);
                      }}
                      title={t("terminal.rename")}
                      className="text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-accent)] group-hover:opacity-100"
                    >
                      <Pencil size={10} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (project) void closeTab(project.id, tab.id);
                      }}
                      title={t("terminal.close")}
                      className="text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                    >
                      <X size={11} />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <button
          onClick={() => project && void openNew(project.id, project.local_path)}
          disabled={!project}
          title={t("terminal.new")}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
        >
          <Plus size={13} />
        </button>
        <ProfileMenu
          disabled={!project}
          onPick={(profileId) => project && void openNew(project.id, project.local_path, { profileId })}
        />
        <button
          onClick={() => project && void openNew(project.id, project.local_path, { split: true })}
          disabled={!project || (activeProj?.tabs.length ?? 0) === 0}
          title={t("terminal.split")}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
        >
          <SplitSquareHorizontal size={13} />
        </button>
        <button
          onClick={togglePanel}
          title={t("terminal.hide")}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
        >
          <ChevronDown size={13} />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1">
        {!project ? (
          <div className="absolute inset-0">
            <EmptyState icon={TerminalSquare} title={t("terminal.noProject")} />
          </div>
        ) : (activeProj?.tabs.length ?? 0) === 0 ? (
          <div className="absolute inset-0">
            <EmptyState icon={TerminalSquare} title={t("terminal.emptyHint")} />
          </div>
        ) : null}
        {allPanes.map(({ tab, visible }) => (
          <div
            key={tab.id}
            className={
              visible
                ? `flex min-w-0 flex-1 flex-col ${tab.id !== visibleIds[visibleIds.length - 1] ? "border-r border-[var(--cf-border)]" : ""}`
                : "hidden"
            }
          >
            <TerminalPane sessionId={tab.id} visible={visible} />
          </div>
        ))}
      </div>
    </motion.div>
  );
}
