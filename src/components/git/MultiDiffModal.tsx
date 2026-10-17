import { useEffect, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { ChevronDown, ChevronRight, Files } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { fileAtRevision, getCommitDiff, readFileText } from "../../lib/tauri/commands";
import { FILE_STATUS_LETTER_CLASS, fileStatusColor, fileStatusLabelKey, fileStatusLetter } from "../../lib/fileStatus";
import { useFileLanguage } from "../../lib/useFileLanguage";
import { useMultiDiffStore, type MultiDiffRequest } from "../../state/multiDiffStore";
import { useRepoStore } from "../../state/repoStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import "../../lib/monacoSetup";

/** Files drawn at most; the rest are named in a line at the end. */
const MAX_FILES = 150;
/** A side past this is not drawn — a lockfile or a bundle is no diff to scroll through. */
const MAX_CHARS = 1_000_000;

interface Entry {
  path: string;
  /** Where the original side lives when the file was renamed. */
  oldPath: string;
  status: string;
}

/** The two sides of one file, read when its section first comes into view. */
async function sidesOf(request: MultiDiffRequest, entry: Entry): Promise<{ original: string; modified: string }> {
  const { repoPath } = request;
  if (request.kind === "working") {
    const [original, modified] = await Promise.all([
      entry.status === "untracked" || entry.status === "added" ? null : fileAtRevision(repoPath, "HEAD", entry.oldPath),
      entry.status === "deleted" ? null : readFileText(repoPath, entry.path).catch(() => null),
    ]);
    return { original: original ?? "", modified: modified ?? "" };
  }
  const [original, modified] = await Promise.all([
    entry.status === "added" ? null : fileAtRevision(repoPath, `${request.oid}^`, entry.oldPath).catch(() => null),
    entry.status === "deleted" ? null : fileAtRevision(repoPath, request.oid, entry.path),
  ]);
  return { original: original ?? "", modified: modified ?? "" };
}

function Section({ request, entry }: { request: MultiDiffRequest; entry: Entry }) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [folded, setFolded] = useState(false);
  const [sides, setSides] = useState<{ original: string; modified: string } | null>(null);
  const [failed, setFailed] = useState("");
  const [height, setHeight] = useState(120);
  const language = useFileLanguage(entry.path, sides?.modified ?? "");

  // Read and drawn only once it is near the screen: a hundred Monaco diffs at once is a frozen window.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((item) => item.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    void sidesOf(request, entry)
      .then((next) => live && setSides(next))
      .catch((e: unknown) => live && setFailed(String(e)));
    return () => {
      live = false;
    };
  }, [visible, request, entry]);

  const tooLarge = sides !== null && Math.max(sides.original.length, sides.modified.length) > MAX_CHARS;

  /** The section is as tall as the diff once unchanged regions fold away — one scroll, not two. */
  const onMount = (diff: MonacoEditorNS.IStandaloneDiffEditor) => {
    const measure = () =>
      setHeight(Math.max(60, diff.getModifiedEditor().getContentHeight(), diff.getOriginalEditor().getContentHeight()) + 4);
    diff.getModifiedEditor().onDidContentSizeChange(measure);
    diff.getOriginalEditor().onDidContentSizeChange(measure);
    measure();
  };

  return (
    <div ref={ref} className="border-b border-[var(--cf-border)]">
      <button
        type="button"
        onClick={() => setFolded((v) => !v)}
        className="sticky top-0 z-10 flex w-full items-center gap-2 bg-[var(--cf-surface)] px-3 py-1.5 text-left text-[12px] hover:bg-[var(--cf-hover)]"
      >
        {folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <span
          style={{ color: fileStatusColor(entry.status) }}
          className={FILE_STATUS_LETTER_CLASS}
          title={t(fileStatusLabelKey(entry.status))}
        >
          {fileStatusLetter(entry.status)}
        </span>
        <span className="min-w-0 truncate font-mono text-[var(--cf-text)]">{entry.path}</span>
        {entry.oldPath !== entry.path && (
          <span className="min-w-0 truncate font-mono text-[11px] text-[var(--cf-text-faint)]">← {entry.oldPath}</span>
        )}
      </button>
      {!folded &&
        (failed ? (
          <p className="px-4 py-2 text-[12px] text-[var(--cf-danger)]">{failed}</p>
        ) : tooLarge ? (
          <p className="px-4 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("multiDiff.tooLarge")}</p>
        ) : sides ? (
          <div style={{ height }}>
            <DiffEditor
              height="100%"
              language={language}
              original={sides.original}
              modified={sides.modified}
              theme={monacoTheme}
              onMount={onMount}
              options={{
                readOnly: true,
                fontSize: 12,
                renderSideBySide: true,
                useInlineViewWhenSpaceIsLimited: true,
                automaticLayout: true,
                maxComputationTime: 2000,
                scrollBeyondLastLine: false,
                // The page scrolls, not each diff: a wheel over a section must move the list.
                scrollbar: { vertical: "hidden", handleMouseWheel: false, alwaysConsumeMouseWheel: false },
                minimap: { enabled: false },
                hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 10 },
              }}
            />
          </div>
        ) : (
          <div className="h-[120px] bg-[var(--cf-sunken)]" />
        ))}
    </div>
  );
}

/**
 * «Ver todos los cambios»: every changed file one under another in a single scroll, each with its
 * unchanged stretches folded — VS Code's multi-file diff. The working tree against HEAD (staged and
 * not), or one commit against its first parent.
 */
export function MultiDiffModal() {
  const t = useT();
  const request = useMultiDiffStore((s) => s.request);
  const status = useRepoStore((s) => s.status);
  const [entries, setEntries] = useState<Entry[] | null>(null);

  useEffect(() => {
    if (!request) return;
    let live = true;
    setEntries(null);
    if (request.kind === "working") {
      const seen = new Map<string, Entry>();
      for (const [list, fallback] of [
        [status?.staged, null],
        [status?.unstaged, null],
        [status?.untracked, "untracked"],
      ] as const) {
        for (const file of list ?? []) {
          if (!seen.has(file.path)) seen.set(file.path, { path: file.path, oldPath: file.path, status: fallback ?? file.status });
        }
      }
      setEntries([...seen.values()].sort((a, b) => a.path.localeCompare(b.path)));
    } else {
      void getCommitDiff(request.repoPath, request.oid)
        .then((files) => {
          if (!live) return;
          setEntries(
            files
              .filter((file) => !file.binary)
              .map((file) => {
                const path = file.new_path ?? file.old_path ?? "";
                return { path, oldPath: file.old_path ?? path, status: file.status };
              }),
          );
        })
        .catch(() => live && setEntries([]));
    }
    return () => {
      live = false;
    };
    // The working tree's list is taken once, when opened: a list that reshuffled under the reader
    // as the watcher fired would lose their place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (!request) return null;
  const shown = entries?.slice(0, MAX_FILES) ?? [];
  const rest = (entries?.length ?? 0) - shown.length;

  return (
    <ApiModal
      icon={Files}
      title={t("multiDiff.title")}
      subtitle={
        request.kind === "working"
          ? t("multiDiff.working", { n: entries?.length ?? 0 })
          : t("multiDiff.commit", { summary: request.summary, n: entries?.length ?? 0 })
      }
      width="max-w-[1400px]"
      height="h-[90vh]"
      onClose={() => useMultiDiffStore.getState().close()}
    >
      <div className="min-h-0 flex-1 overflow-auto">
        {entries === null ? (
          <div className="h-full bg-[var(--cf-sunken)]" />
        ) : entries.length === 0 ? (
          <p className="p-4 text-[12px] text-[var(--cf-text-muted)]">{t("multiDiff.empty")}</p>
        ) : (
          <>
            {shown.map((entry) => (
              <Section key={`${entry.oldPath}>${entry.path}`} request={request} entry={entry} />
            ))}
            {rest > 0 && <p className="p-3 text-[12px] text-[var(--cf-text-muted)]">{t("multiDiff.more", { n: rest })}</p>}
          </>
        )}
      </div>
    </ApiModal>
  );
}
