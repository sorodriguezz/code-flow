import { useEffect } from "react";
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { MODEL_SCHEME, relPathFromModelUri } from "../../lib/editorModel";
import { useReviewerStore } from "../../state/reviewerStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import type { Project } from "../../types/domain";
import type { ReviewerIssue, ReviewerSeverity } from "../../lib/tauri/reviewerCommands";

/** The markers' owner — SonarQube's, apart from the language servers' and the compiler's. */
const OWNER = "sonarqube";

/** Warnings, never errors: a finding of the last review is advice about code that may have moved
 *  since, and a red squiggle is what the compiler says about code that does not build. */
function severityOf(monaco: Monaco, severity: ReviewerSeverity): number {
  return severity === "low" || severity === "info" ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Warning;
}

/** The project a model belongs to — the segment after the scheme (`modelPathForId`). */
function projectOf(uri: { scheme: string; path: string }): string | null {
  if (uri.scheme !== MODEL_SCHEME) return null;
  const raw = uri.path.replace(/^\/+/, "");
  const slash = raw.indexOf("/");
  return slash < 0 ? null : raw.slice(0, slash);
}

function markersFor(monaco: Monaco, model: editor.ITextModel, issues: ReviewerIssue[]): editor.IMarkerData[] {
  const lines = model.getLineCount();
  return issues.map((issue) => {
    // A finding with no line is about the file: the first line carries it.
    const line = Math.min(Math.max(issue.line ?? 1, 1), lines);
    return {
      startLineNumber: line,
      startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1,
      endLineNumber: line,
      endColumn: model.getLineMaxColumn(line),
      message: issue.message,
      code: issue.rule,
      source: "SonarQube",
      severity: severityOf(monaco, issue.severity),
    };
  });
}

let installed = false;

/**
 * The last review's issues as squiggles in the editor (Revisor, R4): every open file of a project
 * with a report gets its findings at their lines, under their own owner so the language servers'
 * markers are left alone. They follow the report — a new review, a triage — and a file opened later
 * gets them as its model is created. Latched like the LSP diagnostics: one listener for the app.
 */
export function useReviewerMarkers(monaco: Monaco | null, project: Project): void {
  // The report is read when the Revisor tab opens; an editor opened first reads it itself, so the
  // squiggles do not wait for a visit to the tab. Only with the Revisor switched on.
  const enabled = usePreferencesStore((s) => s.reviewerEnabled);
  useEffect(() => {
    if (!enabled || useReviewerStore.getState().runs[project.id]) return;
    void useReviewerStore.getState().loadProject(project).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, project.id]);

  useEffect(() => {
    if (!monaco || installed) return;
    installed = true;
    const apply = (model: editor.ITextModel) => {
      const projectId = projectOf(model.uri);
      if (!projectId) return;
      const relPath = relPathFromModelUri(model.uri, projectId);
      const issues = relPath ? (useReviewerStore.getState().runs[projectId]?.summary?.issues ?? []).filter((i) => i.path === relPath) : [];
      monaco.editor.setModelMarkers(model, OWNER, issues.length ? markersFor(monaco, model, issues) : []);
    };
    monaco.editor.onDidCreateModel(apply);
    for (const model of monaco.editor.getModels()) apply(model);
    useReviewerStore.subscribe((state, previous) => {
      if (state.runs === previous.runs) return;
      for (const model of monaco.editor.getModels()) apply(model);
    });
  }, [monaco]);
}
