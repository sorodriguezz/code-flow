import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CircleX, Info, ListChecks, Loader2, TriangleAlert, X } from "lucide-react";
import { FileGlyph } from "../common/FileGlyph";
import { Tooltip } from "../common/Tooltip";
import { Segmented } from "../common/Segmented";
import { iconButtonClass } from "../common/Button";
import { countProblems, groupProblems, useProblemsStore, type ProblemSeverity } from "../../state/problemsStore";
import { useEditorPanelStore, type EditorPanelTab } from "../../state/editorPanelStore";
import { useT } from "../../state/languageStore";
import { checkTsProject } from "./useTypeScript";

/**
 * The panel under the editor groups: **Problemas** — every diagnostic every language server and
 * tsserver has reported, open files or not, grouped by file — and **Resultados**, the last "find all
 * references" or project-wide rename.
 *
 * Opened from the counts in the Editor's status line, by "Find All References", and by a rename that
 * touched more than one file. A click on a row opens the file at the position.
 */

/** Rows drawn at most. A project-wide check on a large repository can report thousands, and a list
 *  that long is read by filtering it, not by scrolling it. */
const MAX_ROWS = 2000;

const SEVERITY_ICON: Record<ProblemSeverity, { icon: typeof CircleX; className: string }> = {
  error: { icon: CircleX, className: "text-[var(--cf-danger)]" },
  warning: { icon: TriangleAlert, className: "text-[var(--cf-warning)]" },
  info: { icon: Info, className: "text-[var(--cf-accent)]" },
};

function splitPath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { name: path, dir: "" } : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

/** A file's row, heading its problems or results. */
function FileRow({
  path,
  count,
  collapsed,
  onToggle,
}: {
  path: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { name, dir } = splitPath(path);
  return (
    <button
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="flex h-[24px] w-full items-center gap-1.5 rounded-md pl-1.5 pr-2 text-left hover:bg-[var(--cf-hover)]"
    >
      {collapsed ? (
        <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
      ) : (
        <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
      )}
      <FileGlyph path={path} size={13} />
      <span className="shrink-0 text-[12px] text-[var(--cf-text)]">{name}</span>
      <span className="min-w-0 truncate text-[11px] text-[var(--cf-text-faint)]">{dir}</span>
      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)]">{count}</span>
    </button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-2 text-[12px] text-[var(--cf-text-muted)]">{children}</p>;
}

function ProblemsList({ onOpen }: { onOpen: (path: string, line: number, column?: number) => void }) {
  const t = useT();
  const byOwner = useProblemsStore((s) => s.byOwner);
  const show = useEditorPanelStore((s) => s.show);
  const files = useMemo(() => groupProblems(byOwner, show), [byOwner, show]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (files.length === 0) return <Empty>{t("editor.problemsNone")}</Empty>;
  let budget = MAX_ROWS;
  return (
    <>
      {files.map((file) => {
        if (budget <= 0) return null;
        const isCollapsed = collapsed[file.path] ?? false;
        const rows = isCollapsed ? [] : file.problems.slice(0, budget);
        budget -= rows.length + 1;
        return (
          <div key={file.path} className="pb-0.5">
            <FileRow
              path={file.path}
              count={file.problems.length}
              collapsed={isCollapsed}
              onToggle={() => setCollapsed((c) => ({ ...c, [file.path]: !isCollapsed }))}
            />
            {rows.map((problem, at) => {
              const { icon: Icon, className } = SEVERITY_ICON[problem.severity];
              const origin = [problem.source, problem.code].filter(Boolean).join(" ");
              return (
                <button
                  key={`${file.path}:${at}`}
                  onClick={() => onOpen(file.path, problem.line, problem.column)}
                  title={problem.message}
                  className="flex w-full items-center gap-2 rounded-md py-[3px] pl-7 pr-2 text-left hover:bg-[var(--cf-hover)]"
                >
                  <Icon size={13} className={`shrink-0 ${className}`} />
                  <span className="min-w-0 truncate text-[12px] text-[var(--cf-text)]">{problem.message}</span>
                  {origin && <span className="shrink-0 text-[11px] text-[var(--cf-text-faint)]">{origin}</span>}
                  <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-[var(--cf-text-faint)]">
                    {problem.line}:{problem.column}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

function ResultsList({ onOpen }: { onOpen: (path: string, line: number, column?: number) => void }) {
  const t = useT();
  const results = useEditorPanelStore((s) => s.results);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (!results) return <Empty>{t("editor.resultsNone")}</Empty>;
  let budget = MAX_ROWS;
  return (
    <>
      <p className="px-2 pb-1 pt-1.5 text-[11px] text-[var(--cf-text-faint)]">{results.title}</p>
      {results.notes.map((note) => (
        <p key={note} className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] text-[var(--cf-text-muted)]">
          <Info size={12} className="shrink-0" />
          <span className="min-w-0 truncate" title={note}>
            {note}
          </span>
        </p>
      ))}
      {results.groups.length === 0 && <Empty>{t("editor.resultsNone")}</Empty>}
      {results.groups.map((group) => {
        if (budget <= 0) return null;
        const isCollapsed = collapsed[group.path] ?? false;
        const rows = isCollapsed ? [] : group.items.slice(0, budget);
        budget -= rows.length + 1;
        return (
          <div key={group.path} className="pb-0.5">
            <FileRow
              path={group.path}
              count={group.items.length}
              collapsed={isCollapsed}
              onToggle={() => setCollapsed((c) => ({ ...c, [group.path]: !isCollapsed }))}
            />
            {rows.map((item, at) => (
              <button
                key={`${group.path}:${at}`}
                onClick={() => onOpen(group.path, item.line, item.column)}
                className="flex w-full items-baseline gap-2 rounded-md py-[3px] pl-7 pr-2 text-left hover:bg-[var(--cf-hover)]"
              >
                <span className="min-w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-[var(--cf-text-faint)]">
                  {item.line}
                </span>
                <span className="truncate font-mono text-[12px] text-[var(--cf-text-muted)]">{item.text}</span>
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
}

export function EditorBottomPanel({ onOpen }: { onOpen: (path: string, line: number, column?: number) => void }) {
  const t = useT();
  const tab = useEditorPanelStore((s) => s.tab);
  const show = useEditorPanelStore((s) => s.show);
  const toggleSeverity = useEditorPanelStore((s) => s.toggleSeverity);
  const canCheckProject = useEditorPanelStore((s) => s.canCheckProject);
  const checkingProject = useEditorPanelStore((s) => s.checkingProject);
  const byOwner = useProblemsStore((s) => s.byOwner);
  const counts = useMemo(() => countProblems(byOwner), [byOwner]);
  const total = counts.error + counts.warning + counts.info;

  const filters: { severity: ProblemSeverity; label: string }[] = [
    { severity: "error", label: t("editor.problemsErrors") },
    { severity: "warning", label: t("editor.problemsWarnings") },
    { severity: "info", label: t("editor.problemsInfos") },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--cf-border)] bg-[var(--cf-surface)]">
      <div className="flex h-8 shrink-0 items-center gap-1 px-2">
        <Segmented<EditorPanelTab>
          size="sm"
          layoutId="cf-editor-panel-tab"
          value={tab}
          onChange={(next) => useEditorPanelStore.setState({ tab: next })}
          options={[
            { value: "problems", label: total > 0 ? `${t("editor.problems")} ${total}` : t("editor.problems") },
            { value: "results", label: t("editor.results") },
          ]}
        />
        <div className="ml-auto flex items-center gap-0.5">
          {tab === "problems" && (
            <>
              {filters.map(({ severity, label }) => {
                const { icon: Icon, className } = SEVERITY_ICON[severity];
                return (
                  <Tooltip key={severity} side="top" label={label}>
                    <button
                      onClick={() => toggleSeverity(severity)}
                      aria-label={label}
                      aria-pressed={show[severity]}
                      className={`inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md px-1.5 text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] ${
                        show[severity] ? "" : "opacity-45"
                      }`}
                    >
                      <Icon size={12} className={className} />
                      <span className="text-[11px] tabular-nums">{counts[severity]}</span>
                    </button>
                  </Tooltip>
                );
              })}
              {canCheckProject && (
                <Tooltip side="top" label={t("editor.problemsCheckProject")} description={t("editor.problemsCheckProjectTip")}>
                  <button
                    onClick={() => void checkTsProject()}
                    disabled={checkingProject}
                    aria-label={t("editor.problemsCheckProject")}
                    className={iconButtonClass({ size: "xs" })}
                  >
                    {checkingProject ? <Loader2 size={13} className="animate-spin" /> : <ListChecks size={13} />}
                  </button>
                </Tooltip>
              )}
            </>
          )}
          <Tooltip side="top" label={t("editor.panelClose")}>
            <button
              onClick={() => useEditorPanelStore.getState().close()}
              aria-label={t("editor.panelClose")}
              className={iconButtonClass({ size: "xs" })}
            >
              <X size={13} />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-1.5">
        {tab === "problems" ? <ProblemsList onOpen={onOpen} /> : <ResultsList onOpen={onOpen} />}
      </div>
    </div>
  );
}
