import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, ChevronDown, ChevronRight, ExternalLink, FileDiff, Loader2, RotateCcw, Undo2 } from "lucide-react";
import { FileGlyph } from "../common/FileGlyph";
import { aiCheckpointFile, restoreAiCheckpointPaths, type ReviewedEdit, type TurnFile } from "../../lib/tauri/commands";
import { lineHunks, type LineHunk } from "../../lib/liveGutter";
import type { TurnChanges } from "../../state/chatStore";
import { useUiStore } from "../../state/uiStore";
import { recordExperience } from "../../lib/tauri/experiencesCommands";
import { useT } from "../../state/languageStore";

/**
 * What a chat turn changed, under its answer, hunk by hunk — keep it or put it back.
 *
 * The turn's checkpoint (`claude_cmd::send_chat_message`) is the "before"; the file on disk is the
 * "now". So the review shows what differs from before the turn **today**: a later turn or the user's
 * own typing on the same lines shows up here too, which is what "discard" would have to put back.
 *
 * Discarding a hunk rewrites only its lines, from the file as it is now; discarding a file puts the
 * whole file back from the checkpoint (deleting it if the turn created it). "Keep" writes nothing —
 * it only folds the hunk away, remembered per turn on this machine.
 */

/** A hunk's lines are shown up to this many per side; past it the hunk says how many more. */
const MAX_HUNK_LINES = 40;

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Hunks kept, per turn: `"<path>:<baseStart>:<bufferStart>"`. Per-viewer, so localStorage. */
function keptKey(checkpointId: string): string {
  return `cf-turn-kept:${checkpointId}`;
}

function readKept(checkpointId: string): Set<string> {
  try {
    const raw = localStorage.getItem(keptKey(checkpointId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeKept(checkpointId: string, kept: Set<string>) {
  try {
    localStorage.setItem(keptKey(checkpointId), JSON.stringify([...kept]));
  } catch {
    // A private window or blocked storage: the hunk is still folded for this session.
  }
}

export function TurnReview({
  repoPath,
  changes,
  repoLabel,
  canOpen = true,
}: {
  repoPath: string;
  changes: TurnChanges;
  /** The repository's name, said in the title — the workspace chat's turns touch several. */
  repoLabel?: string;
  /** Whether a file can be opened in the editor — which shows the active repository only. */
  canOpen?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [kept, setKept] = useState(() => readKept(changes.checkpointId));
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<Record<string, { version: number; file: TurnFile }>>({});
  /** Bumped after every discard, so each file re-reads what is on disk now. */
  const [version, setVersion] = useState(0);

  const keep = (key: string) => {
    const next = new Set(kept);
    next.add(key);
    setKept(next);
    writeKept(changes.checkpointId, next);
    // A hunk kept is the turn's change accepted — evidence the backend keeps (`crate::experiences`).
    // Discards are recorded by the restore itself.
    const [path] = key.split(":");
    recordExperience({
      source: "turn_review",
      signal: "accepted",
      runRef: `checkpoint:${changes.checkpointId}`,
      repoPath,
      detail: { checkpoint: changes.checkpointId, path, hunk: key },
    });
  };

  const refresh = () => {
    setError(null);
    setVersion((v) => v + 1);
  };
  const discard = async (edits: ReviewedEdit[]) => {
    setBusy(true);
    setError(null);
    try {
      await restoreAiCheckpointPaths(repoPath, changes.checkpointId, edits);
      setVersion((v) => v + 1);
    } catch (error) {
      if (String(error).includes("no longer exists")) setGone(true);
      else if (String(error).startsWith("CHECKPOINT_CONFLICT:")) {
        setError(t("turnReview.conflict", { path: String(error).slice("CHECKPOINT_CONFLICT:".length) }));
      } else setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const allReady = changes.paths.every((path) => reviewed[path]?.version === version);
  const discardAll = () => {
    if (!allReady || busy) return;
    void discard(changes.paths.map((path) => ({ path, expectedRevision: reviewed[path].file.revision, content: null })));
  };

  if (gone) {
    return <p className="text-[11px] text-[var(--cf-text-faint)]">{t("turnReview.gone")}</p>;
  }

  return (
    <div className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[12px]">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
          <FileDiff size={12} className="shrink-0" />
          <span className="truncate">
            {repoLabel ? `${repoLabel} · ` : ""}
            {t("turnReview.title", { count: changes.paths.length })}
          </span>
        </button>
        {open && <button
          type="button"
          onClick={() => void discardAll()}
          disabled={busy || !allReady}
          title={t("turnReview.discardAllHint")}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)] disabled:opacity-50"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
          {t("turnReview.discardAll")}
        </button>}
      </div>
      {error && (
        <div role="alert" className="flex items-start gap-2 border-t border-[var(--cf-border)] px-2 py-2 text-[var(--cf-danger)]">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button type="button" onClick={refresh} disabled={busy} className="shrink-0 text-[var(--cf-accent)]">
            {t("turnReview.refresh")}
          </button>
        </div>
      )}
      {open && (
        <div className="border-t border-[var(--cf-border)] px-1 py-1">
          {changes.paths.map((path) => (
            <TurnFileRow
              key={path}
              repoPath={repoPath}
              checkpointId={changes.checkpointId}
              path={path}
              version={version}
              kept={kept}
              onKeep={keep}
              busy={busy}
              onDiscard={discard}
              onRetry={refresh}
              onLoaded={(file) => setReviewed((current) => {
                const next = { ...current };
                if (file) next[path] = { version, file };
                else delete next[path];
                return next;
              })}
              onGone={() => setGone(true)}
              canOpen={canOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TurnFileRow({
  repoPath,
  checkpointId,
  path,
  version,
  kept,
  onKeep,
  busy,
  onDiscard,
  onRetry,
  onLoaded,
  onGone,
  canOpen,
}: {
  canOpen: boolean;
  repoPath: string;
  checkpointId: string;
  path: string;
  version: number;
  kept: Set<string>;
  onKeep: (key: string) => void;
  busy: boolean;
  onDiscard: (edits: ReviewedEdit[]) => Promise<void>;
  onRetry: () => void;
  onLoaded: (file: TurnFile | null) => void;
  onGone: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<TurnFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError(null);
    onLoaded(null);
    aiCheckpointFile(repoPath, checkpointId, path)
      .then((next) => {
        if (!cancelled) {
          setFile(next);
          onLoaded(next);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (String(error).includes("no longer exists")) onGone();
        else setError(String(error));
      });
    return () => {
      cancelled = true;
    };
    // `onGone` is a fresh closure each render of the parent; the read only depends on the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, checkpointId, path, version]);

  const hunks = useMemo<LineHunk[]>(
    () => (file && !file.binary ? lineHunks(file.before ?? "", file.after ?? "") : []),
    [file],
  );
  const hunkKey = (h: LineHunk) => `${path}:${file?.revision}:${h.baseStart}:${h.bufferStart}`;
  const open_ = hunks.filter((h) => !kept.has(hunkKey(h)));
  const added = hunks.reduce((n, h) => n + h.bufferEnd - h.bufferStart, 0);
  const removed = hunks.reduce((n, h) => n + h.baseEnd - h.baseStart, 0);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const unchanged = file !== null && !file.binary && hunks.length === 0;

  const discardFile = async () => {
    if (!file || busy) return;
    await onDiscard([{ path, expectedRevision: file.revision, content: null }]);
  };

  /** Puts one hunk's "before" lines back in place of its "now" lines, in the file as read. */
  const discardHunk = async (hunk: LineHunk) => {
    if (!file || busy) return;
    if (file.after === null) return discardFile();
    const now = splitLines(file.after);
    const before = splitLines(file.before ?? "");
    const next = [...now.slice(0, hunk.bufferStart), ...before.slice(hunk.baseStart, hunk.baseEnd), ...now.slice(hunk.bufferEnd)];
    await onDiscard([{ path, expectedRevision: file.revision, content: next.join(eolOf(file.after)) }]);
  };

  return (
    <div>
      <div className="group flex h-[24px] items-center gap-1.5 rounded-md pl-1 pr-1 hover:bg-[var(--cf-hover)]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!file || file.binary || unchanged}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
        >
          {open ? (
            <ChevronDown size={11} className="shrink-0 text-[var(--cf-text-faint)]" />
          ) : (
            <ChevronRight size={11} className="shrink-0 text-[var(--cf-text-faint)]" />
          )}
          <FileGlyph path={path} size={12} />
          <span className={`shrink-0 ${unchanged ? "text-[var(--cf-text-faint)] line-through" : "text-[var(--cf-text)]"}`}>{name}</span>
          <span className="min-w-0 truncate text-[10.5px] text-[var(--cf-text-faint)]">{dir}</span>
        </button>
        {error ? (
          <AlertCircle size={11} className="shrink-0 text-[var(--cf-danger)]" />
        ) : file === null ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-[var(--cf-text-faint)]" />
        ) : file.binary ? (
          <span className="shrink-0 text-[10.5px] text-[var(--cf-text-faint)]">{t("turnReview.binary")}</span>
        ) : unchanged ? (
          <span className="shrink-0 text-[10.5px] text-[var(--cf-text-faint)]">{t("turnReview.reverted")}</span>
        ) : (
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
            <span className="text-[var(--cf-success)]">+{added}</span>{" "}
            <span className="text-[var(--cf-danger)]">−{removed}</span>
          </span>
        )}
        {canOpen && file && !file.binary && file.after !== null && (
          <button
            type="button"
            onClick={() => useUiStore.getState().openInEditor(path, (hunks[0]?.bufferStart ?? 0) + 1)}
            title={t("turnReview.open")}
            aria-label={t("turnReview.open")}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-text)] group-hover:opacity-100"
          >
            <ExternalLink size={11} />
          </button>
        )}
        {file && !unchanged && (
          <button
            type="button"
            onClick={() => void discardFile()}
            disabled={busy}
            title={t("turnReview.discardFile")}
            aria-label={t("turnReview.discardFile")}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-danger)] group-hover:opacity-100"
          >
            <Undo2 size={11} />
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="mb-1 ml-4 flex items-start gap-2 px-1 text-[11px] text-[var(--cf-danger)]">
          <span className="min-w-0 flex-1 break-words">{t("turnReview.readFailed", { error })}</span>
          <button type="button" onClick={onRetry} disabled={busy} className="flex shrink-0 items-center gap-1 text-[var(--cf-accent)]">
            <RotateCcw size={11} />{t("turnReview.retry")}
          </button>
        </div>
      )}
      {open && file && !file.binary && (
        <div className="mb-1 ml-4 space-y-1">
          {open_.length === 0 && hunks.length > 0 && (
            <p className="px-1 text-[11px] text-[var(--cf-text-faint)]">{t("turnReview.allKept")}</p>
          )}
          {open_.map((hunk) => (
            <HunkView
              key={`${hunk.baseStart}:${hunk.bufferStart}`}
              hunk={hunk}
              before={file.before ?? ""}
              after={file.after ?? ""}
              onKeep={() => onKeep(hunkKey(hunk))}
              onDiscard={() => void discardHunk(hunk)}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HunkView({
  hunk,
  before,
  after,
  onKeep,
  onDiscard,
  busy,
}: {
  hunk: LineHunk;
  before: string;
  after: string;
  onKeep: () => void;
  onDiscard: () => void;
  busy: boolean;
}) {
  const t = useT();
  const removed = splitLines(before).slice(hunk.baseStart, hunk.baseEnd);
  const added = splitLines(after).slice(hunk.bufferStart, hunk.bufferEnd);
  const rows = (lines: string[], sign: "-" | "+") => {
    const shown = lines.slice(0, MAX_HUNK_LINES);
    const tone =
      sign === "-"
        ? "bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] text-[var(--cf-text)]"
        : "bg-[color-mix(in_oklab,var(--cf-success)_10%,transparent)] text-[var(--cf-text)]";
    return (
      <>
        {shown.map((line, i) => (
          <div key={`${sign}${i}`} className={`whitespace-pre px-1.5 ${tone}`}>
            <span className="select-none text-[var(--cf-text-faint)]">{sign} </span>
            {line || " "}
          </div>
        ))}
        {lines.length > shown.length && (
          <div className="px-1.5 text-[var(--cf-text-faint)]">{t("turnReview.moreLines", { count: lines.length - shown.length })}</div>
        )}
      </>
    );
  };
  return (
    <div className="overflow-hidden rounded-md border border-[var(--cf-border)]">
      <div className="flex items-center gap-1 border-b border-[var(--cf-border)] bg-[var(--cf-surface-2)] px-1.5 py-0.5 text-[10.5px] text-[var(--cf-text-faint)]">
        <span className="min-w-0 flex-1 truncate font-mono">
          {t("turnReview.lines", { from: hunk.bufferStart + 1, to: Math.max(hunk.bufferEnd, hunk.bufferStart + 1) })}
        </span>
        <button
          type="button"
          onClick={onKeep}
          disabled={busy}
          className="flex items-center gap-0.5 rounded px-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-success)]"
        >
          <Check size={10} />
          {t("turnReview.keep")}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={busy}
          className="flex items-center gap-0.5 rounded px-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]"
        >
          <Undo2 size={10} />
          {t("turnReview.discard")}
        </button>
      </div>
      <div className="select-text overflow-x-auto font-mono text-[11px] leading-[1.45]">
        {rows(removed, "-")}
        {rows(added, "+")}
      </div>
    </div>
  );
}
