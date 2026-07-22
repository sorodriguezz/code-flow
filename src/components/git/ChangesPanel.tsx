import { useMemo, useState } from "react";
import { Clock, ExternalLink, FileText, GitCommitHorizontal, Loader2, Minus, Plus, RotateCcw, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRepoStore } from "../../state/repoStore";
import { useLayoutStore } from "../../state/layoutStore";
import { DiffView } from "./DiffView";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { generateCommitMessage, openInDefaultApp } from "../../lib/tauri/commands";
import { diffToText } from "../../lib/diffText";
import { parseClaudeError, type ClaudeErrorInfo } from "../../lib/claudeError";
import { useT } from "../../state/languageStore";
import { ConflictsBanner } from "./ConflictsBanner";
import type { FileStatusEntry } from "../../types/domain";

const LIST_MIN = 220;
const LIST_MAX = 520;

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
                onClick={() => {
                  if (window.confirm(t("changes.undoConfirm", { summary: c.summary }))) {
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
}

function FileRow({
  entry,
  selected,
  onSelect,
  actions,
}: {
  entry: FileStatusEntry;
  selected: boolean;
  onSelect: () => void;
  actions: RowAction[];
}) {
  return (
    <div
      onClick={onSelect}
      className={`group flex items-center gap-2 rounded-md px-2 py-1 text-[13px] cursor-pointer ${
        selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      <span className="w-4 shrink-0 text-center text-[10px] uppercase text-[var(--cf-text-muted)]">
        {entry.status[0]}
      </span>
      <span className="flex-1 min-w-0 truncate font-mono text-[12px]">{entry.path}</span>
      <span className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
        {actions.map((action, i) => (
          <button
            key={i}
            title={action.title}
            onClick={(e) => {
              e.stopPropagation();
              action.onClick();
            }}
            className={`text-[var(--cf-text-muted)] ${action.danger ? "hover:text-[var(--cf-danger)]" : "hover:text-[var(--cf-accent)]"}`}
          >
            <action.icon size={13} />
          </button>
        ))}
      </span>
    </div>
  );
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
  const commitChanges = useRepoStore((s) => s.commitChanges);
  const busy = useRepoStore((s) => s.busy);
  const merging = useRepoStore((s) => s.merging);
  const listWidth = useLayoutStore((s) => s.sizes.changesListWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<ClaudeErrorInfo | null>(null);
  const t = useT();

  const unstagedAndUntracked = useMemo(
    () => [...(status?.unstaged ?? []), ...(status?.untracked ?? [])],
    [status],
  );

  const selectedDiff = useMemo(() => {
    if (!selected) return [];
    const pool = selected.staged ? stagedDiff : workingDiff;
    return pool.filter((f) => (f.new_path ?? f.old_path) === selected.path);
  }, [selected, stagedDiff, workingDiff]);

  const openFile = (relPath: string) => {
    if (!repoPath) return;
    void openInDefaultApp(repoPath, relPath);
  };

  if (!status) {
    return <EmptyState icon={FileText} title={t("changes.noRepo")} />;
  }

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {merging && <ConflictsBanner />}
      <div className="relative flex min-h-0 flex-1">
      <div style={{ width: listWidth }} className="flex shrink-0 flex-col border-r border-[var(--cf-border)]">
        <div className="flex items-center justify-between border-b border-[var(--cf-border)] px-3 py-2">
          <span className="text-[12px] font-semibold text-[var(--cf-text-muted)]">{t("changes.changes")}</span>
        </div>

        <div className="flex-1 overflow-auto p-2">
          <UnpushedCommitsSection />

          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[11px] font-semibold uppercase text-[var(--cf-text-muted)]">
                {t("changes.staged")} ({status.staged.length})
              </span>
              {status.staged.length > 0 && (
                <button onClick={() => unstageAll()} className="text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]">
                  {t("changes.unstageAll")}
                </button>
              )}
            </div>
            {status.staged.map((entry) => (
              <FileRow
                key={entry.path}
                entry={entry}
                selected={selected?.path === entry.path && selected.staged}
                onSelect={() => setSelected({ path: entry.path, staged: true })}
                actions={[
                  { icon: ExternalLink, title: t("changes.openFile"), onClick: () => openFile(entry.path) },
                  { icon: Minus, title: t("changes.unstage"), onClick: () => unstageFile(entry.path) },
                ]}
              />
            ))}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[11px] font-semibold uppercase text-[var(--cf-text-muted)]">
                {t("changes.changes")} ({unstagedAndUntracked.length})
              </span>
              {unstagedAndUntracked.length > 0 && (
                <button onClick={() => stageAll()} className="text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]">
                  {t("changes.stageAll")}
                </button>
              )}
            </div>
            {unstagedAndUntracked.map((entry) => (
              <FileRow
                key={entry.path}
                entry={entry}
                selected={selected?.path === entry.path && !selected.staged}
                onSelect={() => setSelected({ path: entry.path, staged: false })}
                actions={[
                  { icon: ExternalLink, title: t("changes.openFile"), onClick: () => openFile(entry.path) },
                  { icon: Plus, title: t("changes.stage"), onClick: () => stageFile(entry.path) },
                  { icon: RotateCcw, title: t("changes.discardChanges"), danger: true, onClick: () => discardFile(entry.path) },
                ]}
              />
            ))}
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
            disabled={busy || aiBusy || !message.trim() || status.staged.length === 0}
            onClick={async () => {
              await commitChanges(message.trim());
              setMessage("");
            }}
            className="mt-2 w-full rounded-md bg-[var(--cf-accent)] py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {t("changes.commit")} {status.staged.length > 0 ? `(${status.staged.length})` : ""}
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

      <div className="flex-1 overflow-auto">
        {selected ? (
          <DiffView files={selectedDiff} />
        ) : (
          <EmptyState icon={FileText} title={t("changes.selectFile")} subtitle={t("changes.selectFileHint")} />
        )}
      </div>
      </div>
    </div>
  );
}
