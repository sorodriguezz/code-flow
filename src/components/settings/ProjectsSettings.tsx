import { useEffect, useRef, useState } from "react";
import {
  Briefcase,
  Check,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { ColorSwatchPicker } from "../common/ColorSwatchPicker";
import { useToastStore } from "../../state/toastStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { SettingsHeader } from "../api/settingsChrome";

/** The repository being dragged, and where it would land if the pointer were released now. */
interface RowDrag {
  workspaceId: string;
  id: string;
  /** Index in the workspace's list the row would take. `null` while the pointer is over nothing
   *  this drag can land on — another workspace's list, or off the panel entirely. */
  overIndex: number | null;
}

/**
 * The index a drop at `y` lands on, from the rows the list rendered.
 *
 * Measured off the DOM rather than tracked per row, because the answer is "above or below the
 * midpoint of whichever row you are over" and that needs the geometry either way. Rows are tagged
 * with `data-project-row` so this can find them without threading refs through every one.
 */
function dropIndexAt(list: HTMLElement | null, y: number): number | null {
  if (!list) return null;
  const rows = [...list.querySelectorAll<HTMLElement>("[data-project-row]")];
  if (rows.length === 0) return null;
  const box = list.getBoundingClientRect();
  // A pointer well outside the list is not hovering a gap in it.
  if (y < box.top - 24 || y > box.bottom + 24) return null;
  for (const [at, row] of rows.entries()) {
    const rect = row.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return at;
  }
  return rows.length;
}

/**
 * The line that says where the row would land, as classes for the row it is drawn against.
 *
 * Above the row whose gap is targeted; below the last one for a drop at the end, which has no row
 * after it to hang a top line on. Nothing is drawn against the row being dragged — it is already
 * marked by being faded, and a line touching it would point at the gap it is currently filling.
 */
function insertionLine(
  drag: RowDrag | null,
  workspaceId: string,
  id: string,
  at: number,
  count: number,
): string {
  if (drag?.workspaceId !== workspaceId || drag.overIndex === null || drag.id === id) return "";
  if (drag.overIndex === at) return "shadow-[0_-2px_0_0_var(--cf-accent)]";
  if (drag.overIndex >= count && at === count - 1) return "shadow-[0_2px_0_0_var(--cf-accent)]";
  return "";
}

export function ProjectsSettings() {
  const t = useT();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);
  const loadProjects = useWorkspaceStore((s) => s.loadProjects);
  const removeProject = useWorkspaceStore((s) => s.removeProject);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const setWorkspaceColor = useWorkspaceStore((s) => s.setWorkspaceColor);
  const setProjectColor = useWorkspaceStore((s) => s.setProjectColor);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const [newName, setNewName] = useState("");
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  // Which workspace is being renamed, and the half-typed name — one at a time, so opening a
  // second row's field closes the first rather than leaving two drafts on screen.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const reorderProject = useWorkspaceStore((s) => s.reorderProject);
  const [drag, setDrag] = useState<RowDrag | null>(null);
  /** One entry per workspace, so a drag can measure the list it started in. */
  const listRefs = useRef<Record<string, HTMLDivElement | null>>({});

  /**
   * The whole reorder gesture, on `window` so it keeps tracking when the pointer leaves the row.
   *
   * Pointer events and not HTML5 drag-and-drop, for the reason the editor tabs and the file tree
   * are the same: Tauri's native drag handler on the webview swallows those events before the page
   * sees them (see `lib/pointerDrag.ts`). A press that never travels `DRAG_THRESHOLD` is not a
   * drag, so a click on the handle does nothing rather than reordering by a pixel of jitter.
   */
  const beginDrag = (e: React.PointerEvent, workspaceId: string, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = { x: e.clientX, y: e.clientY };
    let started = false;

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_THRESHOLD) return;
        started = true;
        setDragCursor(true);
      }
      setDrag({ workspaceId, id, overIndex: dropIndexAt(listRefs.current[workspaceId], ev.clientY) });
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!started) return;
      setDragCursor(false);
      setDrag(null);
      const to = dropIndexAt(listRefs.current[workspaceId], ev.clientY);
      // Dropped on nothing — the row stays where it was, like every list that does this.
      if (to !== null) void reorderProject(workspaceId, id, to);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const startRename = (id: string, name: string) => {
    setRenamingId(id);
    setDraftName(name);
  };

  const commitRename = async () => {
    if (!renamingId) return;
    const trimmed = draftName.trim();
    // An empty field means "changed my mind", not "call it nothing" — same as leaving the name
    // untouched, both just close the field.
    if (trimmed) await renameWorkspace(renamingId, trimmed);
    setRenamingId(null);
  };

  // `projectsByWorkspace` is normally only populated for whichever workspace is/was active
  // (the sidebar only ever needs that one) — this overview lists every workspace's projects
  // at once, so it has to fetch the ones nobody's switched into yet itself.
  useEffect(() => {
    for (const ws of workspaces) {
      if (!projectsByWorkspace[ws.id]) void loadProjects(ws.id);
    }
  }, [workspaces, projectsByWorkspace, loadProjects]);
  // Collapsed by default — a workspace with dozens of repos would otherwise dump all of
  // them on screen the moment Settings opens. Membership means "expanded", so any workspace
  // not yet toggled (including newly added ones) starts collapsed.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const copyPath = async (path: string) => {
    await navigator.clipboard.writeText(path);
    setCopiedPath(path);
    useToastStore.getState().pushToast(t("settings.pathCopied"), "success");
    setTimeout(() => setCopiedPath((prev) => (prev === path ? null : prev)), 1500);
  };

  return (
    <section>
      <SettingsHeader title={t("settings.projectsTitle")} hint={t("settings.projectsHint")} />
      <div className="space-y-4">
        {workspaces.map((ws) => {
          const projects = projectsByWorkspace[ws.id] ?? [];
          const isOnlyWorkspace = workspaces.length <= 1;
          const hasProjects = projects.length > 0;
          const disableRemoveWorkspace = isOnlyWorkspace || hasProjects;
          const removeWorkspaceTitle = isOnlyWorkspace
            ? t("settings.onlyWorkspace")
            : hasProjects
              ? t("settings.removeWorkspaceHasProjects")
              : t("settings.removeWorkspace");

          const expanded = expandedIds.has(ws.id);

          return (
            <div key={ws.id} className="rounded-lg border border-[var(--cf-border)] p-2.5">
              <div className={`flex items-center gap-2 text-[13px] font-medium ${expanded ? "mb-2" : ""}`}>
                {renamingId === ws.id ? (
                  // In place of the row's own label, so the name is edited where it is read. No
                  // commit on blur: the tick and Escape/× are the two answers, and a blur-commit
                  // would save the draft the moment you reached for ×.
                  <>
                    <Briefcase size={13} style={{ color: ws.color }} className="shrink-0" />
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void commitRename();
                        // Stopped here so it doesn't reach the Settings window's own Escape
                        // handler, which would close the whole thing mid-rename.
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setRenamingId(null);
                        }
                      }}
                      aria-label={t("settings.renameWorkspace")}
                      className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 text-[13px] font-normal outline-none focus:border-[var(--cf-accent)]"
                    />
                    <button
                      onClick={() => void commitRename()}
                      disabled={!draftName.trim()}
                      title={t("common.save")}
                      className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] disabled:opacity-30"
                    >
                      <Check size={13} />
                    </button>
                    <button
                      onClick={() => setRenamingId(null)}
                      title={t("common.cancel")}
                      className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                    >
                      <X size={13} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => toggleExpanded(ws.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      {expanded ? (
                        <ChevronDown size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
                      ) : (
                        <ChevronRight size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
                      )}
                      <Briefcase size={13} style={{ color: ws.color }} className="shrink-0" />
                      <span className="flex-1 truncate">{ws.name}</span>
                      {!expanded && (
                        <span className="shrink-0 rounded-full bg-black/[0.05] px-1.5 py-0.5 text-[10px] font-normal text-[var(--cf-text-muted)] dark:bg-white/[0.08]">
                          {projects.length}
                        </span>
                      )}
                    </button>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => startRename(ws.id, ws.name)}
                        title={t("settings.renameWorkspace")}
                        className="text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
                      >
                        <Pencil size={13} />
                      </button>
                      <ColorSwatchPicker value={ws.color} onChange={(color) => setWorkspaceColor(ws.id, color)} />
                      <button
                        onClick={async () => {
                          if (await confirmAction(t("settings.removeWorkspaceConfirm", { name: ws.name }))) {
                            void removeWorkspace(ws.id);
                          }
                        }}
                        disabled={disableRemoveWorkspace}
                        title={removeWorkspaceTitle}
                        className="text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)] disabled:opacity-30"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </>
                )}
              </div>

              {expanded && (
                <div
                  ref={(el) => {
                    listRefs.current[ws.id] = el;
                  }}
                  className="space-y-1.5"
                >
                  {projects.map((p, at) => (
                    <div
                      key={p.id}
                      data-project-row
                      className={`rounded-md border px-2.5 py-1.5 transition-colors ${
                        drag?.id === p.id
                          ? "border-[var(--cf-accent)] opacity-40"
                          : "border-[var(--cf-border)]"
                      } ${insertionLine(drag, ws.id, p.id, at, projects.length)}`}
                    >
                      <div className="flex items-center gap-2 text-[12px]">
                        {/* A handle rather than the whole row: the row carries a colour picker, a
                            bin and a copy-the-path button, and a press anywhere on it that might
                            turn into a drag makes all three feel unreliable. */}
                        <span
                          onPointerDown={(e) => beginDrag(e, ws.id, p.id)}
                          title={t("settings.reorderProject")}
                          aria-label={t("settings.reorderProject")}
                          className="-ml-1 shrink-0 cursor-grab touch-none text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] active:cursor-grabbing"
                        >
                          <GripVertical size={13} />
                        </span>
                        <ColorSwatchPicker value={p.color} onChange={(color) => setProjectColor(p.id, ws.id, color)} />
                        <span className="flex-1 truncate font-medium">{p.name}</span>
                        <button
                          onClick={async () => {
                            if (await confirmAction(t("settings.removeProjectConfirm", { name: p.name }))) {
                              void removeProject(p.id, ws.id);
                            }
                          }}
                          title={t("settings.removeProject")}
                          className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <button
                        onClick={() => copyPath(p.local_path)}
                        title={t("settings.copyPath")}
                        className="mt-1.5 flex w-full min-w-0 items-center gap-1 truncate text-left text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
                      >
                        {copiedPath === p.local_path && <Check size={11} className="shrink-0 text-[var(--cf-success)]" />}
                        <span className="truncate">{copiedPath === p.local_path ? t("settings.pathCopied") : p.local_path}</span>
                      </button>
                    </div>
                  ))}
                  {projects.length === 0 && (
                    <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.noProjectsInWorkspace")}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex gap-1.5 border-t border-[var(--cf-border)] pt-3">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t("settings.newWorkspaceNamePlaceholder")}
          className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
        />
        <button
          disabled={!newName.trim()}
          onClick={async () => {
            await addWorkspace(newName.trim(), "briefcase", "#6366f1");
            setNewName("");
          }}
          className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] disabled:opacity-40 dark:hover:bg-white/[0.04]"
        >
          <Plus size={13} />
          {t("settings.addWorkspace")}
        </button>
      </div>
    </section>
  );
}
