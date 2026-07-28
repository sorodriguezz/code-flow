import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  FileText,
  Folder,
  FolderTree,
  GitCommitHorizontal,
  List,
  ListMinus,
  ListPlus,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRepoStore } from "../../state/repoStore";
import { useLayoutStore } from "../../state/layoutStore";
import { DiffView } from "./DiffView";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { generateCommitMessage, scanStagedSecrets } from "../../lib/tauri/commands";
import { diffToText } from "../../lib/diffText";
import { parseClaudeError, type ClaudeErrorInfo } from "../../lib/claudeError";
import { confirmAction } from "../../state/confirmStore";
import { fileStatusLabelKey } from "../../lib/fileStatus";
import { buildFileTree, type FileTreeNode } from "../../lib/buildFileTree";
import { useT } from "../../state/languageStore";
import { ConflictsBanner } from "./ConflictsBanner";
import { SecretScanModal } from "./SecretScanModal";
import { useUiStore } from "../../state/uiStore";
import { usePrStore } from "../../state/prStore";
import { useAnalyzeUiStore } from "../../state/analyzeUiStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import type { FileDiffInfo, FileStatusEntry, SecretHit } from "../../types/domain";

const LIST_MIN = 220;
const LIST_MAX = 520;

/** 1-based line of the first change in a file's diff, so opening it in the editor lands on the
 * change instead of at the top of the file. A deleted line has no counterpart on the new side —
 * fall back to the first line the hunk does map, and to the file top when it maps none. */
function firstChangedLine(files: FileDiffInfo[]): number | undefined {
  for (const file of files) {
    for (const hunk of file.hunks) {
      const changed = hunk.lines.find((l) => l.origin !== " " && l.new_lineno !== null);
      if (changed?.new_lineno) return changed.new_lineno;
      const anchor = hunk.lines.find((l) => l.new_lineno !== null);
      if (anchor?.new_lineno) return anchor.new_lineno;
    }
  }
  return undefined;
}

function UnpushedCommitsSection() {
  const unpushedCommits = useRepoStore((s) => s.unpushedCommits);
  const undoCommit = useRepoStore((s) => s.undoCommit);
  const busy = useRepoStore((s) => s.busy);
  const t = useT();

  if (unpushedCommits.length === 0) return null;

  return (
    <div className="mb-3">
      <CollapsibleSection
        icon={GitCommitHorizontal}
        title={t("changes.unpushedCommits", { n: unpushedCommits.length })}
        defaultOpen
      >
        <p className="mb-1.5 px-1 text-[11px] text-[var(--cf-text-muted)]">{t("changes.unpushedHint")}</p>
        <div className="space-y-0.5">
          {unpushedCommits.map((c, i) => (
            <div
              key={c.id}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[12px] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <span className="flex-1 min-w-0 truncate">{c.summary}</span>
              <span className="shrink-0 font-mono text-[10px] text-[var(--cf-text-muted)]">{c.short_id}</span>
              <button
                disabled={i !== 0 || busy}
                title={i === 0 ? t("changes.undoThis") : t("changes.undoAboveFirst")}
                onClick={async () => {
                  if (await confirmAction(t("changes.undoConfirm", { summary: c.summary }))) {
                    void undoCommit(c.id);
                  }
                }}
                className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)] disabled:opacity-30"
              >
                <RotateCcw size={12} />
              </button>
            </div>
          ))}
        </div>
      </CollapsibleSection>
    </div>
  );
}

interface RowAction {
  icon: LucideIcon;
  title: string;
  onClick: () => void;
  danger?: boolean;
  /** This specific action is the one currently in flight — swaps its icon for a spinner. */
  pending?: boolean;
  /** A *different* action (on this row or another) is in flight — dims and blocks clicks
   * so two git-index-mutating actions can never race each other. */
  disabled?: boolean;
}

function FileRow({
  entry,
  selected,
  onSelect,
  actions,
  depth = 0,
  displayName,
}: {
  entry: FileStatusEntry;
  selected: boolean;
  onSelect: () => void;
  actions: RowAction[];
  /** Tree mode nests files under their directory, so indent by depth instead of showing
   * the full path — and show just the filename, since the path is implied by the nesting. */
  depth?: number;
  displayName?: string;
}) {
  const t = useT();
  return (
    <div
      onClick={onSelect}
      style={depth ? { paddingLeft: depth * 14 } : undefined}
      className={`group flex items-center gap-2 rounded-md px-2 py-1 text-[13px] cursor-pointer ${
        selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      <span
        title={t(fileStatusLabelKey(entry.status))}
        className="w-4 shrink-0 text-center text-[10px] uppercase text-[var(--cf-text-muted)]"
      >
        {entry.status[0]}
      </span>
      <span className="flex-1 min-w-0 truncate font-mono text-[12px]">{displayName ?? entry.path}</span>
      <span
        className={`flex shrink-0 items-center gap-1 ${
          actions.some((a) => a.pending) ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        {actions.map((action, i) => (
          <button
            key={i}
            title={action.title}
            disabled={action.disabled}
            onClick={(e) => {
              e.stopPropagation();
              action.onClick();
            }}
            className={`text-[var(--cf-text-muted)] disabled:opacity-30 ${
              action.danger ? "hover:text-[var(--cf-danger)]" : "hover:text-[var(--cf-accent)]"
            }`}
          >
            {action.pending ? <Loader2 size={13} className="animate-spin" /> : <action.icon size={13} />}
          </button>
        ))}
      </span>
    </div>
  );
}

function FileTreeSection({
  entries,
  isSelected,
  onSelectEntry,
  buildActions,
}: {
  entries: FileStatusEntry[];
  isSelected: (entry: FileStatusEntry) => boolean;
  onSelectEntry: (entry: FileStatusEntry) => void;
  buildActions: (entry: FileStatusEntry) => RowAction[];
}) {
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildFileTree(entries), [entries]);

  const toggleDir = (path: string) =>
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNode = (node: FileTreeNode, depth: number): React.ReactNode => {
    if (node.type === "file") {
      return (
        <FileRow
          key={node.entry.path}
          entry={node.entry}
          selected={isSelected(node.entry)}
          onSelect={() => onSelectEntry(node.entry)}
          actions={buildActions(node.entry)}
          depth={depth}
          displayName={node.name}
        />
      );
    }
    const collapsed = collapsedDirs.has(node.path);
    return (
      <div key={node.path}>
        <div
          onClick={() => toggleDir(node.path)}
          style={{ paddingLeft: depth * 14 }}
          className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        >
          {collapsed ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
          <Folder size={12} className="shrink-0" />
          <span className="truncate">{node.name}</span>
        </div>
        {!collapsed && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return <>{tree.map((node) => renderNode(node, 0))}</>;
}

export function ChangesPanel() {
  const repoPath = useRepoStore((s) => s.repoPath);
  const status = useRepoStore((s) => s.status);
  const workingDiff = useRepoStore((s) => s.workingDiff);
  const stagedDiff = useRepoStore((s) => s.stagedDiff);
  const stageFile = useRepoStore((s) => s.stageFile);
  const unstageFile = useRepoStore((s) => s.unstageFile);
  const stageAll = useRepoStore((s) => s.stageAll);
  const unstageAll = useRepoStore((s) => s.unstageAll);
  const discardFile = useRepoStore((s) => s.discardFile);
  const discardAll = useRepoStore((s) => s.discardAll);
  const commitChanges = useRepoStore((s) => s.commitChanges);
  const busy = useRepoStore((s) => s.busy);
  const merging = useRepoStore((s) => s.merging);
  const listWidth = useLayoutStore((s) => s.sizes.changesListWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "tree">("list");
  const openAiPanel = useUiStore((s) => s.openAiPanel);
  const openInEditor = useUiStore((s) => s.openInEditor);
  const [message, setMessage] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<ClaudeErrorInfo | null>(null);
  const [scanning, setScanning] = useState(false);
  const [secretHits, setSecretHits] = useState<SecretHit[] | null>(null);
  const secretScanEnabled = usePreferencesStore((s) => s.secretScanEnabled);
  const [pending, setPending] = useState<{ path: string; kind: "stage" | "unstage" | "discard" | "all" } | null>(
    null,
  );
  const t = useT();

  // Feedback for the row action buttons is otherwise invisible until refreshStatus() comes
  // back (stage/unstage/discard all trigger a full status+diff refresh) — set the pending
  // state synchronously on click so the button shows a spinner immediately, and block the
  // other git-mutating buttons meanwhile so two of them can never race the same index.
  const runAction = async (path: string, kind: "stage" | "unstage" | "discard" | "all", fn: () => Promise<void>) => {
    setPending({ path, kind });
    try {
      await fn();
    } finally {
      setPending(null);
    }
  };

  const unstagedAndUntracked = useMemo(
    () => [...(status?.unstaged ?? []), ...(status?.untracked ?? [])],
    [status],
  );

  const selectedDiff = useMemo(() => {
    if (!selected) return [];
    const pool = selected.staged ? stagedDiff : workingDiff;
    return pool.filter((f) => (f.new_path ?? f.old_path) === selected.path);
  }, [selected, stagedDiff, workingDiff]);

  // Open the file in the app's own Editor tab (at the first changed line) instead of handing it
  // to the OS default app — the point is to inspect the change in place, not to leave the app.
  const openFile = (relPath: string, staged: boolean) => {
    const pool = staged ? stagedDiff : workingDiff;
    const files = pool.filter((f) => (f.new_path ?? f.old_path) === relPath);
    openInEditor(relPath, firstChangedLine(files));
  };

  if (!status) {
    return <EmptyState icon={FileText} title={t("changes.noRepo")} />;
  }

  const buildStagedActions = (entry: FileStatusEntry): RowAction[] => {
    const isPending = pending?.path === entry.path;
    const blocked = pending !== null && !isPending;
    return [
      { icon: Code2, title: t("changes.openInEditor"), onClick: () => openFile(entry.path, true) },
      {
        icon: Minus,
        title: t("changes.unstage"),
        onClick: () => runAction(entry.path, "unstage", () => unstageFile(entry.path)),
        pending: isPending && pending?.kind === "unstage",
        disabled: blocked,
      },
    ];
  };

  const buildUnstagedActions = (entry: FileStatusEntry): RowAction[] => {
    const isPending = pending?.path === entry.path;
    const blocked = pending !== null && !isPending;
    return [
      { icon: Code2, title: t("changes.openInEditor"), onClick: () => openFile(entry.path, false) },
      {
        icon: Plus,
        title: t("changes.stage"),
        onClick: () => runAction(entry.path, "stage", () => stageFile(entry.path)),
        pending: isPending && pending?.kind === "stage",
        disabled: blocked,
      },
      {
        // A trash can, not a circular arrow: discarding throws the change away (and deletes the
        // file outright when it's untracked) — the arrow reads as "reload/restart" and undersells it.
        icon: Trash2,
        title: t("changes.discardChanges"),
        danger: true,
        onClick: async () => {
          if (await confirmAction(t("changes.discardConfirm", { path: entry.path }))) {
            void runAction(entry.path, "discard", () => discardFile(entry.path));
          }
        },
        pending: isPending && pending?.kind === "discard",
        disabled: blocked,
      },
    ];
  };

  const generateWithAi = async () => {
    setAiError(null);
    setAiBusy(true);
    try {
      const text = await generateCommitMessage(diffToText(stagedDiff));
      setMessage(text);
    } catch (e) {
      setAiError(parseClaudeError(String(e)));
    } finally {
      setAiBusy(false);
    }
  };

  const performCommit = async () => {
    await commitChanges(message.trim());
    setMessage("");
  };

  // Commit entry point: run the pre-commit secret scan first (when enabled). If it finds
  // credential-looking content, hold the commit and surface the SecretScanModal instead. A scan
  // that itself errors must not block committing — fall through to the commit in that case.
  const handleCommit = async () => {
    if (secretScanEnabled && repoPath) {
      setScanning(true);
      try {
        const hits = await scanStagedSecrets(repoPath);
        if (hits.length > 0) {
          setSecretHits(hits);
          return;
        }
      } catch {
        // scan failed — don't stand in the way of the commit
      } finally {
        setScanning(false);
      }
    }
    await performCommit();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {merging && <ConflictsBanner />}
      <div className="relative flex min-h-0 flex-1 gap-1.5 p-2">
      <div
        style={{ width: listWidth }}
        className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--cf-border)] px-3 py-2">
          <span className="text-[12px] font-semibold text-[var(--cf-text-muted)]">{t("changes.changes")}</span>
          <div className="flex items-center gap-0.5 rounded-md border border-[var(--cf-border)] p-0.5">
            <button
              onClick={() => setViewMode("list")}
              title={t("changes.listView")}
              className={`flex h-5 w-5 items-center justify-center rounded ${
                viewMode === "list" ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
              }`}
            >
              <List size={12} />
            </button>
            <button
              onClick={() => setViewMode("tree")}
              title={t("changes.treeView")}
              className={`flex h-5 w-5 items-center justify-center rounded ${
                viewMode === "tree" ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
              }`}
            >
              <FolderTree size={12} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-2">
          <UnpushedCommitsSection />

          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[11px] font-semibold uppercase text-[var(--cf-text-muted)]">
                {t("changes.staged")} ({status.staged.length})
              </span>
              {status.staged.length > 0 && (
                <button
                  onClick={() => runAction("__unstage_all__", "all", () => unstageAll())}
                  disabled={pending !== null && pending.path !== "__unstage_all__"}
                  title={t("changes.unstageAll")}
                  className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] disabled:opacity-30"
                >
                  {pending?.path === "__unstage_all__" ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <ListMinus size={13} />
                  )}
                </button>
              )}
            </div>
            {viewMode === "tree" ? (
              <FileTreeSection
                entries={status.staged}
                isSelected={(entry) => selected?.path === entry.path && !!selected.staged}
                onSelectEntry={(entry) => setSelected({ path: entry.path, staged: true })}
                buildActions={(entry) => buildStagedActions(entry)}
              />
            ) : (
              status.staged.map((entry) => (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  selected={selected?.path === entry.path && selected.staged}
                  onSelect={() => setSelected({ path: entry.path, staged: true })}
                  actions={buildStagedActions(entry)}
                />
              ))
            )}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[11px] font-semibold uppercase text-[var(--cf-text-muted)]">
                {t("changes.changes")} ({unstagedAndUntracked.length})
              </span>
              <div className="flex items-center gap-1">
                {unstagedAndUntracked.length > 0 && (
                  <button
                    onClick={() => {
                      usePrStore.getState().selectPr(null);
                      useAnalyzeUiStore.getState().show();
                      openAiPanel();
                    }}
                    title={t("analyze.button")}
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
                  >
                    <ShieldCheck size={13} />
                  </button>
                )}
                {unstagedAndUntracked.length > 0 && (
                  <button
                    onClick={async () => {
                      const ok = await confirmAction(
                        t("changes.discardAllConfirm", { n: unstagedAndUntracked.length }),
                        true,
                        t("changes.discardAll"),
                      );
                      if (!ok) return;
                      // The selected file may be one of the ones about to vanish — drop the
                      // selection rather than leaving the diff pane on a file that no longer differs.
                      if (selected && !selected.staged) setSelected(null);
                      void runAction("__discard_all__", "all", () => discardAll());
                    }}
                    disabled={pending !== null && pending.path !== "__discard_all__"}
                    title={t("changes.discardAll")}
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)] disabled:opacity-30"
                  >
                    {pending?.path === "__discard_all__" ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                  </button>
                )}
                {unstagedAndUntracked.length > 0 && (
                  <button
                    onClick={() => runAction("__stage_all__", "all", () => stageAll())}
                    disabled={pending !== null && pending.path !== "__stage_all__"}
                    title={t("changes.stageAll")}
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] disabled:opacity-30"
                  >
                    {pending?.path === "__stage_all__" ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <ListPlus size={13} />
                    )}
                  </button>
                )}
              </div>
            </div>
            {viewMode === "tree" ? (
              <FileTreeSection
                entries={unstagedAndUntracked}
                isSelected={(entry) => selected?.path === entry.path && !selected.staged}
                onSelectEntry={(entry) => setSelected({ path: entry.path, staged: false })}
                buildActions={(entry) => buildUnstagedActions(entry)}
              />
            ) : (
              unstagedAndUntracked.map((entry) => (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  selected={selected?.path === entry.path && !selected.staged}
                  onSelect={() => setSelected({ path: entry.path, staged: false })}
                  actions={buildUnstagedActions(entry)}
                />
              ))
            )}
          </div>
        </div>

        <div className="border-t border-[var(--cf-border)] p-2">
          <div className="relative">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("changes.commitMessage")}
              rows={3}
              disabled={aiBusy}
              className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 pr-7 text-[13px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
            />
            <button
              onClick={generateWithAi}
              disabled={aiBusy || status.staged.length === 0}
              title={status.staged.length === 0 ? t("changes.stageFirst") : t("changes.generateWithAi")}
              className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-accent)] hover:bg-[var(--cf-accent-soft)] disabled:opacity-30"
            >
              {aiBusy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            </button>
          </div>
          {aiError &&
            (aiError.isQuotaExceeded ? (
              <div className="mt-1.5 flex items-start gap-2 rounded-md bg-[color-mix(in_oklab,var(--cf-warning)_14%,transparent)] px-2 py-1.5 text-[11px] text-[var(--cf-text)]">
                <Clock size={13} className="mt-0.5 shrink-0 text-[var(--cf-warning)]" />
                <span>
                  {t("changes.quotaMessage")}{" "}
                  {aiError.resetHint ? t("changes.quotaRetry", { hint: aiError.resetHint }) : t("changes.quotaRetryLater")}
                </span>
              </div>
            ) : (
              <p className="mt-1 text-[11px] text-[var(--cf-danger)]">{aiError.message}</p>
            ))}
          <button
            disabled={busy || aiBusy || scanning || !message.trim() || status.staged.length === 0}
            onClick={handleCommit}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--cf-accent)] py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {scanning && <Loader2 size={13} className="animate-spin" />}
            {scanning ? t("secrets.scanning") : t("changes.commit")}{" "}
            {!scanning && status.staged.length > 0 ? `(${status.staged.length})` : ""}
          </button>
        </div>
      </div>

      <ResizeHandle
        axis="x"
        value={listWidth}
        min={LIST_MIN}
        max={LIST_MAX}
        onChange={(w) => setSize("changesListWidth", w)}
        onCommit={(w) => commitSize("changesListWidth", w)}
      />

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]">
        {selected ? (
          <DiffView files={selectedDiff} />
        ) : (
          <EmptyState icon={FileText} title={t("changes.selectFile")} subtitle={t("changes.selectFileHint")} />
        )}
      </div>
      </div>
      {secretHits && (
        <SecretScanModal
          hits={secretHits}
          onCancel={() => setSecretHits(null)}
          onCommitAnyway={async () => {
            setSecretHits(null);
            await performCommit();
          }}
        />
      )}
    </div>
  );
}
