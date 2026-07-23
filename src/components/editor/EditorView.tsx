import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { Code2, Columns2, Eye, FileCode, Folder, GitBranch, Loader2, Save } from "lucide-react";
import { FileTree } from "./FileTree";
import { MarkdownPreview } from "./MarkdownPreview";
import { DbmlDiagram } from "./DbmlDiagram";
import { readFileText, writeFileText } from "../../lib/tauri/commands";
import { languageForPath } from "../../lib/monacoLanguage";
import { parseDbml } from "../../lib/dbml";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useThemeStore } from "../../state/themeStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore } from "../../state/uiStore";
import { ResizeHandle } from "../common/ResizeHandle";
import { EmptyState } from "../common/EmptyState";
import { BouncingDots } from "../common/BouncingDots";
import { useT } from "../../state/languageStore";
import type { FileDiffInfo } from "../../types/domain";

const TREE_MIN = 200;
const TREE_MAX = 480;

type PreviewKind = "markdown" | "dbml" | null;
type ViewMode = "code" | "preview" | "split";

function previewKindFor(path: string | null): PreviewKind {
  if (!path) return null;
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".dbml")) return "dbml";
  return null;
}

function resolveCssColor(varName: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
}

/** Groups a file diff's added/current lines (origin "+", which for a modified line is its
 * *new* content — exactly what the editor is currently showing) into contiguous ranges, so
 * a 40-line block of changes becomes one decoration instead of 40. */
function changedLineRanges(fileDiff: FileDiffInfo | undefined): { start: number; end: number }[] {
  if (!fileDiff) return [];
  const lines: number[] = [];
  for (const hunk of fileDiff.hunks) {
    for (const line of hunk.lines) {
      if (line.origin === "+" && line.new_lineno) lines.push(line.new_lineno);
    }
  }
  lines.sort((a, b) => a - b);
  const ranges: { start: number; end: number }[] = [];
  for (const n of lines) {
    const last = ranges[ranges.length - 1];
    if (last && n === last.end + 1) last.end = n;
    else ranges.push({ start: n, end: n });
  }
  return ranges;
}

export function EditorView() {
  const t = useT();
  const project = useWorkspaceStore((s) => s.activeProject());
  const currentBranch = useRepoStore((s) => s.status?.current_branch ?? null);
  const status = useRepoStore((s) => s.status);
  const changedPaths = useMemo(() => {
    const map = new Map<string, string>();
    if (status) {
      // Untracked/unstaged first, then staged overwrites — an already-staged edit that's
      // since changed further should show its current (unstaged) status, not the stale one.
      for (const e of status.untracked) map.set(e.path, e.status);
      for (const e of status.unstaged) map.set(e.path, e.status);
      for (const e of status.staged) if (!map.has(e.path)) map.set(e.path, e.status);
    }
    return map;
  }, [status]);
  const resolved = useThemeStore((s) => s.resolved);
  const workingDiff = useRepoStore((s) => s.workingDiff);
  const stagedDiff = useRepoStore((s) => s.stagedDiff);
  const pendingEditorPath = useUiStore((s) => s.pendingEditorPath);
  const clearPendingEditorPath = useUiStore((s) => s.clearPendingEditorPath);
  const treeWidth = useLayoutStore((s) => s.sizes.editorTreeWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationIdsRef = useRef<string[]>([]);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollSyncGuardRef = useRef<"editor" | "preview" | null>(null);
  // Bumped every time a Monaco instance actually finishes mounting — the code panel remounts
  // Monaco whenever it toggles away and back (loading spinner, preview-only mode), which would
  // otherwise leave effects keyed on `[ranges]`/`[viewMode]` alone reading a stale/disposed
  // `editorRef.current` if they happened to fire before the new instance was ready.
  const [editorReady, setEditorReady] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("code");

  const previewKind = previewKindFor(selectedPath);
  const dbmlSchema = useMemo(() => (previewKind === "dbml" ? parseDbml(content) : null), [previewKind, content]);

  // Same "unstaged wins, else staged" priority as the file tree's own indicator, so the
  // gutter/minimap markers always match whatever status letter that file is showing there.
  const fileDiff = useMemo(() => {
    if (!selectedPath) return undefined;
    return (
      workingDiff.find((f) => (f.new_path ?? f.old_path) === selectedPath) ??
      stagedDiff.find((f) => (f.new_path ?? f.old_path) === selectedPath)
    );
  }, [selectedPath, workingDiff, stagedDiff]);

  const ranges = useMemo(() => changedLineRanges(fileDiff), [fileDiff]);

  // Marks changed lines directly on Monaco's own minimap + overview ruler + gutter, rather
  // than a bespoke strip — this *is* the "code map" the Changes tab has, just reused where
  // Monaco already renders one.
  const applyDecorations = useCallback(() => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    if (!ed || !mon) return;
    const color = resolveCssColor("--cf-success", "#22c55e");
    const decorations: MonacoEditorNS.IModelDeltaDecoration[] = ranges.map((r) => ({
      range: new mon.Range(r.start, 1, r.end, 1),
      options: {
        isWholeLine: true,
        className: "cf-editor-changed-line",
        linesDecorationsClassName: "cf-editor-changed-gutter",
        minimap: { color, position: mon.editor.MinimapPosition.Inline },
        overviewRuler: { color, position: mon.editor.OverviewRulerLane.Left },
      },
    }));
    decorationIdsRef.current = ed.deltaDecorations(decorationIdsRef.current, decorations);
  }, [ranges]);

  const handleMount: OnMount = (editorInstance, monacoInstance) => {
    editorRef.current = editorInstance;
    monacoRef.current = monacoInstance;
    // A fresh instance has no relationship to whatever decoration ids the previous (now
    // disposed) one returned, so start clean instead of trying to reuse them.
    decorationIdsRef.current = [];
    applyDecorations();
    setEditorReady((n) => n + 1);
  };

  // Re-applies decorations when the diff/theme changes *while the same Monaco instance stays
  // mounted* (e.g. after a save refreshes the diff). The mount-time application above is what
  // covers file switches, since those unmount/remount Monaco and this effect's deps don't
  // change across that transition.
  useEffect(() => {
    applyDecorations();
  }, [applyDecorations, resolved]);

  // Split view: keep the Monaco pane and the rendered preview pane scrolling together,
  // proportionally (their line heights don't correspond 1:1, so this syncs by scroll ratio
  // rather than by line number). Re-attaches whenever Monaco (re)mounts.
  useEffect(() => {
    if (viewMode !== "split") return;
    const ed = editorRef.current;
    const previewEl = previewScrollRef.current;
    if (!ed || !previewEl) return;

    const fromEditor = () => {
      if (scrollSyncGuardRef.current === "preview") {
        scrollSyncGuardRef.current = null;
        return;
      }
      const denom = ed.getScrollHeight() - ed.getLayoutInfo().height;
      const ratio = denom > 0 ? ed.getScrollTop() / denom : 0;
      scrollSyncGuardRef.current = "editor";
      previewEl.scrollTop = ratio * (previewEl.scrollHeight - previewEl.clientHeight);
    };
    const fromPreview = () => {
      if (scrollSyncGuardRef.current === "editor") {
        scrollSyncGuardRef.current = null;
        return;
      }
      const denom = previewEl.scrollHeight - previewEl.clientHeight;
      const ratio = denom > 0 ? previewEl.scrollTop / denom : 0;
      const editorDenom = ed.getScrollHeight() - ed.getLayoutInfo().height;
      scrollSyncGuardRef.current = "preview";
      ed.setScrollTop(ratio * editorDenom);
    };

    const disposable = ed.onDidScrollChange(fromEditor);
    previewEl.addEventListener("scroll", fromPreview);
    return () => {
      disposable.dispose();
      previewEl.removeEventListener("scroll", fromPreview);
    };
  }, [viewMode, selectedPath, editorReady]);

  const dirty = content !== originalContent;

  const openFile = useCallback(
    async (path: string) => {
      if (!project) return;
      setLoading(true);
      setSelectedPath(path);
      try {
        const text = await readFileText(project.local_path, path);
        setContent(text);
        setOriginalContent(text);
      } catch (e) {
        const message = t("editor.failedToOpen", { error: String(e) });
        setContent(message);
        setOriginalContent(message);
      } finally {
        setLoading(false);
      }
    },
    [project],
  );

  const save = useCallback(async () => {
    if (!project || !selectedPath || content === originalContent) return;
    setSaving(true);
    try {
      await writeFileText(project.local_path, selectedPath, content);
      setOriginalContent(content);
      // The Changes tab (and any conflict-resolution flow) reads git status from
      // repoStore, which has no way to know a file changed on disk outside of a git
      // command — refresh it explicitly so a save here shows up immediately there.
      void useRepoStore.getState().refreshStatus();
    } finally {
      setSaving(false);
    }
  }, [project, selectedPath, content, originalContent]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);

  // Otherwise switching projects leaves the previously open file's content on screen —
  // everything else (branch, file tree, status) points at the new repo, but the editor
  // pane itself was still showing a file that belongs to the one you just left.
  useEffect(() => {
    setSelectedPath(null);
    setContent("");
    setOriginalContent("");
  }, [project?.local_path]);

  // A `.dbml`/`.md` view mode chosen for one file shouldn't carry over to the next file
  // opened, especially since most files don't have a preview at all.
  useEffect(() => {
    setViewMode("code");
  }, [selectedPath]);

  useEffect(() => {
    if (pendingEditorPath) {
      void openFile(pendingEditorPath);
      clearPendingEditorPath();
    }
  }, [pendingEditorPath, openFile, clearPendingEditorPath]);

  if (!project) {
    return <EmptyState icon={FileCode} title={t("editor.noProject")} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--cf-border)] px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)]">
        <span className="flex items-center gap-1.5 font-medium text-[var(--cf-text)]">
          <Folder size={12} />
          {project.name}
        </span>
        {currentBranch && (
          <span className="flex items-center gap-1">
            <GitBranch size={12} />
            {currentBranch}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div style={{ width: treeWidth }} className="shrink-0 overflow-auto border-r border-[var(--cf-border)]">
          <FileTree
            repoPath={project.local_path}
            selectedPath={selectedPath}
            onSelectFile={openFile}
            changedPaths={changedPaths}
          />
        </div>
        <ResizeHandle
          axis="x"
          value={treeWidth}
          min={TREE_MIN}
          max={TREE_MAX}
          onChange={(w) => setSize("editorTreeWidth", w)}
          onCommit={(w) => commitSize("editorTreeWidth", w)}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedPath ? (
          <>
            <div className="flex items-center justify-between border-b border-[var(--cf-border)] px-3 py-1.5">
              <span className="truncate font-mono text-[12px] text-[var(--cf-text-muted)]">
                {selectedPath}
                {dirty ? " •" : ""}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                {previewKind && (
                  <div className="flex items-center gap-0.5 rounded-md border border-[var(--cf-border)] p-0.5">
                    <button
                      onClick={() => setViewMode("code")}
                      title={t("editor.viewCode")}
                      className={`flex h-5 w-5 items-center justify-center rounded ${
                        viewMode === "code" ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
                      }`}
                    >
                      <Code2 size={12} />
                    </button>
                    <button
                      onClick={() => setViewMode("split")}
                      title={t("editor.viewSplit")}
                      className={`flex h-5 w-5 items-center justify-center rounded ${
                        viewMode === "split" ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
                      }`}
                    >
                      <Columns2 size={12} />
                    </button>
                    <button
                      onClick={() => setViewMode("preview")}
                      title={t("editor.viewPreview")}
                      className={`flex h-5 w-5 items-center justify-center rounded ${
                        viewMode === "preview" ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
                      }`}
                    >
                      <Eye size={12} />
                    </button>
                  </div>
                )}
                <button
                  onClick={save}
                  disabled={!dirty || saving}
                  className="flex items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 py-0.5 text-[12px] text-white disabled:opacity-40"
                >
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  {t("editor.save")}
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {loading ? (
                <div className="flex h-full items-center justify-center">
                  <BouncingDots />
                </div>
              ) : viewMode === "preview" ? (
                previewKind === "markdown" ? (
                  <MarkdownPreview content={content} />
                ) : (
                  <DbmlDiagram schema={dbmlSchema!} />
                )
              ) : viewMode === "split" ? (
                <div className="flex h-full">
                  <div className="min-w-0 flex-1 border-r border-[var(--cf-border)]">
                    <Editor
                      height="100%"
                      language={languageForPath(selectedPath)}
                      value={content}
                      theme={resolved === "dark" ? "vs-dark" : "vs"}
                      onChange={(value) => setContent(value ?? "")}
                      onMount={handleMount}
                      options={{ minimap: { enabled: true }, fontSize: 13, automaticLayout: true }}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    {previewKind === "markdown" ? (
                      <MarkdownPreview content={content} ref={previewScrollRef} />
                    ) : (
                      <DbmlDiagram schema={dbmlSchema!} ref={previewScrollRef} />
                    )}
                  </div>
                </div>
              ) : (
                <Editor
                  height="100%"
                  language={languageForPath(selectedPath)}
                  value={content}
                  theme={resolved === "dark" ? "vs-dark" : "vs"}
                  onChange={(value) => setContent(value ?? "")}
                  onMount={handleMount}
                  options={{ minimap: { enabled: true }, fontSize: 13, automaticLayout: true }}
                />
              )}
            </div>
          </>
          ) : (
            <EmptyState icon={FileCode} title={t("editor.selectFile")} subtitle={t("editor.selectFileHint")} />
          )}
        </div>
      </div>
    </div>
  );
}
