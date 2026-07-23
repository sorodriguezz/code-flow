import { useEffect, useState } from "react";
import { Briefcase, Check, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { ColorSwatchPicker } from "../common/ColorSwatchPicker";
import { useToastStore } from "../../state/toastStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";

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
  const [newName, setNewName] = useState("");
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

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
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t("settings.projectsTitle")}</h3>
      </div>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.projectsHint")}</p>
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
              </div>

              {expanded && (
                <div className="space-y-1.5">
                  {projects.map((p) => (
                    <div key={p.id} className="rounded-md border border-[var(--cf-border)] px-2.5 py-1.5">
                      <div className="flex items-center gap-2 text-[12px]">
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
