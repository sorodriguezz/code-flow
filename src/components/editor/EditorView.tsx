import { useCallback, useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { FileCode, Folder, GitBranch, Loader2, Save } from "lucide-react";
import { FileTree } from "./FileTree";
import { readFileText, writeFileText } from "../../lib/tauri/commands";
import { languageForPath } from "../../lib/monacoLanguage";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useThemeStore } from "../../state/themeStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore } from "../../state/uiStore";
import { ResizeHandle } from "../common/ResizeHandle";
import { EmptyState } from "../common/EmptyState";
import { BouncingDots } from "../common/BouncingDots";
import { useT } from "../../state/languageStore";

const TREE_MIN = 200;
const TREE_MAX = 480;

export function EditorView() {
  const t = useT();
  const project = useWorkspaceStore((s) => s.activeProject());
  const currentBranch = useRepoStore((s) => s.status?.current_branch ?? null);
  const resolved = useThemeStore((s) => s.resolved);
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
          <FileTree repoPath={project.local_path} selectedPath={selectedPath} onSelectFile={openFile} />
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
              <button
                onClick={save}
                disabled={!dirty || saving}
                className="flex items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 py-0.5 text-[12px] text-white disabled:opacity-40"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                {t("editor.save")}
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {loading ? (
                <div className="flex h-full items-center justify-center">
                  <BouncingDots />
                </div>
              ) : (
                <Editor
                  height="100%"
                  language={languageForPath(selectedPath)}
                  value={content}
                  theme={resolved === "dark" ? "vs-dark" : "vs"}
                  onChange={(value) => setContent(value ?? "")}
                  options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
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
