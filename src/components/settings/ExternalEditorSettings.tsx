import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Select, type SelectOption } from "../common/Select";
import { chipClass } from "../common/recipes";
import { PaneBlock } from "./settingsNav";
import { resolveEditor, useExternalEditorStore, type EditorScope } from "../../state/externalEditorStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { ExternalEditorState } from "../../lib/tauri/externalEditorCommands";

/**
 * «Workspaces y proyectos › Editor externo»: what «Abrir en …» opens a repository in — for the app,
 * for each workspace, and for each of its repositories, each level following the one above until it
 * chooses (user, 2026-10-21: «configurable en workspace y repositorios … cursor, vscode,
 * antigravity»). Only the editors this machine has are offered; one chosen and since uninstalled
 * stays listed, marked, so the choice is not silently swapped.
 *
 * Every workspace is a row that folds its repositories away — folded to start with, the open one
 * first — so the list stays short however many there are (user, 2026-10-22). Its own editor is on
 * the row itself, changeable folded.
 */

/** Where every picker on the pane starts, so they read as one column: a workspace's row is its
 *  8 px padding, its 220 px name and the 12 px gap. */
const PICKER_AT = 240;

function Row({ label, indent = 0, children }: { label: ReactNode; indent?: number; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 py-1.5">
      <span className="shrink-0 truncate text-[12.5px] text-[var(--cf-text)]" style={{ width: PICKER_AT - indent - 12 }}>
        {label}
      </span>
      <div className="w-[300px] min-w-0">{children}</div>
    </div>
  );
}

const labelOf = (state: ExternalEditorState, id: string) => state.editors.find((editor) => editor.id === id)?.label ?? id;

export function ExternalEditorSettings() {
  const t = useT();
  const state = useExternalEditorStore((s) => s.state);
  const choose = useExternalEditorStore((s) => s.choose);
  const activeId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  useEffect(() => {
    void useExternalEditorStore.getState().load();
  }, []);

  if (!state) return null;
  const installed = state.editors.filter((editor) => editor.installed);
  /** The editors to pick from, with the follow-the-level-above entry first — and `chosen`, if it is
   *  no longer installed, kept and marked. */
  const options = (follow: string, chosen: string | undefined): SelectOption[] => {
    const list: SelectOption[] = [{ value: "", label: follow }, ...installed.map((editor) => ({ value: editor.id, label: editor.label }))];
    if (chosen && !installed.some((editor) => editor.id === chosen)) list.push({ value: chosen, label: t("externalEditor.missing", { editor: labelOf(state, chosen) }) });
    return list;
  };
  const picker = (scope: EditorScope, value: string | undefined, follow: string, label: string) => (
    <Select size="sm" value={value ?? ""} onChange={(next) => void choose(scope, next || null)} options={options(follow, value)} ariaLabel={label} />
  );
  const appEditor = labelOf(state, resolveEditor(state));
  // The open workspace first, the rest in their own order.
  const ordered = [...workspaces].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId));

  return (
    <div>
      <PaneBlock title={t("externalEditor.defaultTitle")} hint={t("externalEditor.defaultHint")}>
        <Row label={t("externalEditor.editor")} indent={-1}>
          {picker({ kind: "default" }, state.default && state.default !== "auto" ? state.default : undefined, t("externalEditor.auto", { editor: labelOf(state, state.auto) }), t("externalEditor.defaultTitle"))}
        </Row>
      </PaneBlock>

      {ordered.length > 0 && (
        <PaneBlock title={t("externalEditor.workspacesTitle")} hint={t("externalEditor.workspacesHint")}>
          <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
            {ordered.map((workspace) => {
              const projects = projectsByWorkspace[workspace.id] ?? [];
              const expanded = open.has(workspace.id);
              const own = projects.filter((project) => state.projects[project.id]).length;
              const workspaceEditor = labelOf(state, resolveEditor(state, null, workspace.id));
              return (
                <div key={workspace.id} className="border-b border-[var(--cf-border)] last:border-b-0">
                  <div className="flex flex-wrap items-center gap-3 px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => toggle(workspace.id)}
                      aria-expanded={expanded}
                      disabled={projects.length === 0}
                      className="flex w-[220px] shrink-0 items-center gap-1.5 rounded-md py-1 text-left hover:text-[var(--cf-text)] disabled:cursor-default"
                    >
                      <ChevronRight
                        size={13}
                        className={`shrink-0 text-[var(--cf-text-faint)] transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-90" : ""} ${projects.length === 0 ? "opacity-0" : ""}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-[var(--cf-text)]">{workspace.name}</span>
                        <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
                          {projects.length === 1 ? t("externalEditor.repoCountOne") : t("externalEditor.repoCount", { n: projects.length })}
                          {own > 0 ? ` · ${t("externalEditor.ownCount", { n: own })}` : ""}
                        </span>
                      </span>
                    </button>
                    <div className="w-[300px] min-w-0">
                      {picker({ kind: "workspace", id: workspace.id }, state.workspaces[workspace.id], t("externalEditor.followApp", { editor: appEditor }), workspace.name)}
                    </div>
                  </div>
                  {expanded && (
                    <div className="border-t border-[var(--cf-border)] bg-[var(--cf-sunken)] py-1 pl-7 pr-2">
                      {projects.map((project) => (
                        <Row key={project.id} label={project.name} indent={28}>
                          {picker({ kind: "project", id: project.id }, state.projects[project.id], t("externalEditor.followWorkspace", { editor: workspaceEditor }), project.name)}
                        </Row>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </PaneBlock>
      )}

      <PaneBlock title={t("externalEditor.foundTitle")} hint={t("externalEditor.foundHint")}>
        {installed.length ? (
          <div className="flex flex-wrap gap-1.5">
            {installed.map((editor) => (
              <span key={editor.id} className={chipClass("neutral")}>
                {editor.label}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-[var(--cf-text-muted)]">{t("externalEditor.noneFound")}</p>
        )}
      </PaneBlock>
    </div>
  );
}
