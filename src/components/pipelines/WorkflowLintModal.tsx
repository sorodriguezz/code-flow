import { useEffect, useState } from "react";
import { AlertTriangle, CircleX, FileCheck2, LoaderCircle } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { chipClass, rowClass, sectionLabelClass } from "../common/recipes";
import { ciActionlint, listDir, readFileText, type ActionlintHit } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { lintWorkflow, type LintIssue, type LintMessage } from "./workflowLint";

interface Row {
  path: string;
  line: number;
  column: number;
  text: string;
  severity: "error" | "warning";
  /** `codeflow`, or actionlint's rule name. */
  source: string;
}

const WORKFLOWS = ".github/workflows";

/**
 * The repository's GitHub workflows, checked before a push finds out: the app's own checks (see
 * `workflowLint`), plus actionlint's when it is installed. Every finding opens its file at its line.
 */
export function WorkflowLintModal({ localPath, onClose }: { localPath: string; onClose: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [files, setFiles] = useState(0);
  const [actionlint, setActionlint] = useState<"ran" | "missing" | "failed">("missing");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const word = (message: LintMessage): string => {
      switch (message.key) {
        case "yaml":
          return t("pipelines.lint.yaml", { detail: message.detail });
        case "unknownTopKey":
          return t("pipelines.lint.unknownTopKey", { name: message.name });
        case "unknownJobKey":
          return t("pipelines.lint.unknownJobKey", { job: message.job, name: message.name });
        case "missingRunsOn":
          return t("pipelines.lint.missingRunsOn", { job: message.job });
        case "missingSteps":
          return t("pipelines.lint.missingSteps", { job: message.job });
        case "unknownNeed":
          return t("pipelines.lint.unknownNeed", { job: message.job, need: message.need });
        case "needsItself":
          return t("pipelines.lint.needsItself", { job: message.job });
        case "needsCycle":
          return t("pipelines.lint.needsCycle", { jobs: message.jobs });
        case "stepUsesAndRun":
          return t("pipelines.lint.stepUsesAndRun", { job: message.job, step: message.step });
        case "stepNeither":
          return t("pipelines.lint.stepNeither", { job: message.job, step: message.step });
        case "notMapping":
          return t("pipelines.lint.notMapping");
        case "missingOn":
          return t("pipelines.lint.missingOn");
        case "missingJobs":
          return t("pipelines.lint.missingJobs");
        case "unclosedExpression":
          return t("pipelines.lint.unclosedExpression");
      }
    };
    void (async () => {
      try {
        const entries = await listDir(localPath, WORKFLOWS).catch(() => []);
        const paths = entries.filter((e) => !e.is_dir && /\.ya?ml$/i.test(e.name)).map((e) => `${WORKFLOWS}/${e.name}`);
        const own: LintIssue[] = [];
        for (const path of paths) {
          const text = await readFileText(localPath, path).catch(() => null);
          if (text !== null) own.push(...lintWorkflow(path, text));
        }
        let external: ActionlintHit[] | null = null;
        let state: "ran" | "missing" | "failed" = "missing";
        try {
          external = await ciActionlint(localPath);
          state = external ? "ran" : "missing";
        } catch {
          state = "failed";
        }
        const all: Row[] = [
          ...own.map((issue) => ({ path: issue.path, line: issue.line, column: issue.column, text: word(issue.message), severity: issue.severity, source: "codeflow" })),
          ...(external ?? []).map((hit) => ({
            path: hit.filepath.replace(/\\/g, "/").replace(/^\.\//, ""),
            line: hit.line,
            column: hit.column,
            text: hit.message,
            severity: "error" as const,
            source: hit.kind,
          })),
        ];
        // actionlint reports YAML errors too: one finding per place, its wording kept.
        const seen = new Set<string>();
        const unique = all
          .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || (a.source === "codeflow" ? 1 : -1))
          .filter((row) => {
            const key = `${row.path}:${row.line}:${row.source === "codeflow" ? "" : row.source}`;
            if (row.source === "codeflow" && seen.has(`${row.path}:${row.line}:syntax-check`)) return false;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        if (!live) return;
        setFiles(paths.length);
        setActionlint(state);
        setRows(unique);
      } catch (e) {
        if (live) setError(String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [localPath, t]);

  const byFile = new Map<string, Row[]>();
  for (const row of rows ?? []) byFile.set(row.path, [...(byFile.get(row.path) ?? []), row]);

  return (
    <ApiModal icon={FileCheck2} title={t("pipelines.lint.title")} subtitle={WORKFLOWS} width="max-w-2xl" height="h-[70vh]" onClose={onClose}>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {error ? (
          <p className="p-2 text-[12.5px] text-[var(--cf-danger)]">{error}</p>
        ) : !rows ? (
          <div className="flex items-center gap-2 p-2 text-[12.5px] text-[var(--cf-text-muted)]">
            <LoaderCircle size={14} className="animate-spin" />
            {t("pipelines.lint.running")}
          </div>
        ) : files === 0 ? (
          <p className="p-2 text-[12.5px] text-[var(--cf-text-muted)]">{t("pipelines.lint.noFiles")}</p>
        ) : (
          <>
            <p className="px-1 pb-2 text-[12px] text-[var(--cf-text-muted)]">
              {rows.length === 0 ? t("pipelines.lint.clean", { n: files }) : t("pipelines.lint.found", { n: rows.length, files })}{" "}
              {actionlint === "ran" ? t("pipelines.lint.withActionlint") : actionlint === "failed" ? t("pipelines.lint.actionlintFailed") : t("pipelines.lint.noActionlint")}
            </p>
            {[...byFile.entries()].map(([path, list]) => (
              <div key={path}>
                <div className={sectionLabelClass}>{path}</div>
                {list.map((row, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => {
                      useUiStore.getState().openInEditor(row.path, row.line);
                      onClose();
                    }}
                    className={rowClass(false, "min-h-[34px] items-start gap-2 py-1.5")}
                  >
                    {row.severity === "error" ? (
                      <CircleX size={13} className="mt-0.5 shrink-0 text-[var(--cf-danger)]" />
                    ) : (
                      <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--cf-warning)]" />
                    )}
                    <span className="w-10 shrink-0 pt-px text-right font-mono text-[11px] tabular-nums text-[var(--cf-text-faint)]">{row.line}</span>
                    <span className="min-w-0 flex-1 whitespace-normal text-left text-[12.5px]">{row.text}</span>
                    {row.source !== "codeflow" && <span className={chipClass("neutral", "shrink-0 font-mono")}>{row.source}</span>}
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </ApiModal>
  );
}
