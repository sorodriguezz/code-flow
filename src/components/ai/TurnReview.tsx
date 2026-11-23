import { memo, useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, ChevronDown, ChevronRight, ExternalLink, FileDiff, FolderGit2, Loader2, RotateCcw, Undo2 } from "lucide-react";
import { aiCheckpointFile, restoreAiCheckpointPaths, restoreAiTurn, type ReviewedEdit, type TurnFile } from "../../lib/tauri/commands";
import { shortRepoNames } from "../../lib/repoShortNames";
import { lineHunks, type LineHunk } from "../../lib/liveGutter";
import type { TurnChanges } from "../../state/chatStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { useUiStore } from "../../state/uiStore";
import { confirmAction } from "../../state/confirmStore";
import { focusEditorOn } from "../../lib/editorIslands";
import { recordExperience } from "../../lib/tauri/experiencesCommands";
import { useT } from "../../state/languageStore";

/**
 * What a chat turn changed, inside its answer, hunk by hunk — keep it or put it back.
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

/** Whether `latest` — the file read again just before a hunk is written — is the very file the hunk
 *  was drawn from. Anything else and its line numbers may point at other code. */
export function sameFileAsRead(read: TurnFile, latest: TurnFile | null): boolean {
  return !!latest && !latest.binary && latest.revision === read.revision && latest.after === read.after;
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

/** One repository's part of a turn: where it is, its checkpoint, and the files the turn changed. */
export interface TurnChangePart {
  repoPath: string;
  /** The repository's name, when the turn says it — the workspace chat's turns touch several. */
  repo?: string;
  checkpointId: string;
  paths: string[];
}

/** Lines a file (or a repository's files) gained and lost in the turn. */
interface Stats {
  added: number;
  removed: number;
}

/** A repository's files listed before «Ver N más». */
const SHOWN_FILES = 8;

/** File names shown while the card is folded, per repository. */
const PEEK_ONE = 4;
const PEEK_MANY = 3;

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
}

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/**
 * Everything one turn changed, in every repository it touched — one card inside the answer, before
 * its footer (user ask, 2026-11-23). It replaced one box per repository under the turn, outside the
 * answer's column and lined up with the avatar, plus a loose «Deshacer el turno en N repositorios»
 * button for the turns that touched several.
 *
 * Folded, it already says what changed: how many files, in which repository, and the first few by
 * name. Opened, each repository is a section of files grouped by folder, each marked new, changed or
 * deleted with its lines added and removed, and its diff a click away. The files are read only then
 * — under every answer of a long transcript, reading them all up front would be the cost — so the
 * line totals appear once the card is open.
 *
 * «Deshacer todo» puts every file back as it was before the turn, in every repository, and always
 * asks first: it is the one button here that can throw away a whole turn's work in one click.
 *
 * `projectId`: the repository chat's own project, where its one part opens. The workspace chat's
 * parts find theirs by path.
 */
export const TurnChangesCard = memo(function TurnChangesCard({ parts, projectId }: { parts: readonly TurnChangePart[]; projectId?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Bumped after «Deshacer todo», so every section reads what is on disk now. */
  const [epoch, setEpoch] = useState(0);
  const [stats, setStats] = useState<Record<string, Stats | null>>({});
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);
  const multi = parts.length > 1;
  const files = parts.reduce((n, part) => n + part.paths.length, 0);
  const label = (part: TurnChangePart) => part.repo || baseName(part.repoPath);
  const short = useMemo(() => shortRepoNames(parts.map(label)), [parts]);
  const where = (part: TurnChangePart): { canOpen: boolean; openProjectId?: string } => {
    if (projectId) return { canOpen: true, openProjectId: projectId };
    const project = Object.values(projectsByWorkspace)
      .flat()
      .find((p) => samePath(p.local_path, part.repoPath));
    // Only the active repository's files open in place; another one is switched to first.
    return { canOpen: !!project, openProjectId: project && project.id !== activeProjectId ? project.id : undefined };
  };
  const known = parts.map((part) => stats[part.repoPath]);
  const totals = known.every((s): s is Stats => !!s)
    ? known.reduce((sum, s) => ({ added: sum.added + s.added, removed: sum.removed + s.removed }), { added: 0, removed: 0 })
    : null;

  const undoAll = async () => {
    if (busy) return;
    // The checkpoint is each file before the turn, so this also reverts whatever was written after
    // it — a later turn's edits, the user's own — which is why it asks, with the counts.
    const ok = await confirmAction(
      multi ? t("turnReview.undoTurnConfirm", { files, count: parts.length }) : t("turnReview.discardAllConfirm", { count: files }),
      true,
      multi ? t("turnReview.undoTurn", { count: parts.length }) : t("turnReview.discardAll"),
    );
    if (!ok) return;
    setBusy(true);
    try {
      const restored = await restoreAiTurn(parts.map(({ repoPath, checkpointId, paths }) => ({ repoPath, checkpointId, paths })));
      pushSuccessToast(t("turnReview.undoTurnDone", { files: restored.length }));
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setBusy(false);
      setStats({});
      setEpoch((n) => n + 1);
    }
  };

  return (
    <div className="min-w-0 overflow-hidden rounded-[10px] bg-[var(--cf-surface-raised)] text-[12px] shadow-[inset_0_0_0_1px_var(--cf-border)]">
      <div className="flex min-w-0 items-center gap-2 py-1.5 pl-2.5 pr-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1.5 text-left font-semibold text-[var(--cf-text)]"
        >
          <FileDiff size={12} className="shrink-0 text-[var(--cf-accent)]" />
          <span className="truncate">
            {multi ? t("turnReview.titleRepos", { count: files, repos: parts.length }) : t("turnReview.titleFiles", { count: files })}
          </span>
        </button>
        {open && totals && <Totals stats={totals} />}
        {!multi && (
          <span
            title={parts[0].repoPath}
            className="inline-flex min-w-0 max-w-[14rem] items-center gap-1 rounded-full bg-[var(--cf-hover)] px-1.5 py-px text-[11px] text-[var(--cf-text-muted)]"
          >
            <FolderGit2 size={10} className="shrink-0" />
            <span className="truncate">{label(parts[0])}</span>
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void undoAll()}
          disabled={busy}
          title={t("turnReview.discardAllHint")}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)] disabled:opacity-50"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
          {t("turnReview.undoAll")}
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? t("turnReview.hideFiles") : t("turnReview.showFiles")}
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        >
          <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {!open && (
        // What changed, before anything is read: the first few files by name, per repository.
        <div className="flex min-w-0 flex-wrap gap-1 px-2.5 pb-2">
          {parts.map((part) => {
            const shown = part.paths.slice(0, multi ? PEEK_MANY : PEEK_ONE);
            const rest = part.paths.length - shown.length;
            const chip = "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-px text-[11px] shadow-[inset_0_0_0_1px_var(--cf-border)]";
            return (
              <span key={part.repoPath} className="contents">
                {multi && (
                  <span title={label(part)} className={`${chip} text-[var(--cf-text-muted)]`}>
                    <FolderGit2 size={10} className="shrink-0" />
                    <span className="truncate">{short.get(label(part))} · {part.paths.length}</span>
                  </span>
                )}
                {shown.map((path) => (
                  <span key={path} title={path} className={`${chip} font-mono text-[var(--cf-text)]`}>
                    <span className="truncate">{baseName(path)}</span>
                  </span>
                ))}
                {rest > 0 && <span className={`${chip} text-[var(--cf-text-muted)]`}>{t("turnReview.more", { count: rest })}</span>}
              </span>
            );
          })}
        </div>
      )}
      {open && (
        <div className="border-t border-[var(--cf-border)] px-1 pb-1.5 pt-0.5">
          {parts.map((part) => (
            <TurnRepoSection
              key={`${part.repoPath}:${epoch}`}
              repoPath={part.repoPath}
              label={multi ? (short.get(label(part)) ?? label(part)) : null}
              fullLabel={label(part)}
              changes={{ checkpointId: part.checkpointId, paths: part.paths }}
              {...where(part)}
              // One repository: its files straight away. Several: one line each, opened on a click —
              // a long list of every repository's files at once was the noise (user ask, 2026-11-23).
              startOpen={!multi}
              onStats={(next) => setStats((was) => (was[part.repoPath] === next ? was : { ...was, [part.repoPath]: next }))}
            />
          ))}
        </div>
      )}
    </div>
  );
}, sameParts);

/** The card's props compare by what they say, not by identity: the repository chat builds its one
 *  part per render, and this card sits under every answer of a transcript that re-renders per token. */
function sameParts(a: { parts: readonly TurnChangePart[]; projectId?: string }, b: { parts: readonly TurnChangePart[]; projectId?: string }): boolean {
  if (a.parts === b.parts && a.projectId === b.projectId) return true;
  return (
    a.projectId === b.projectId &&
    a.parts.length === b.parts.length &&
    a.parts.every((part, i) => {
      const other = b.parts[i];
      return part.repoPath === other.repoPath && part.repo === other.repo && part.checkpointId === other.checkpointId && part.paths === other.paths;
    })
  );
}

/**
 * One repository's files in the card: grouped by folder, each with its diff. With `label` — a turn
 * that touched several repositories — it opens with the repository's name, its totals and its own
 * «Descartar», which asks first too.
 */
function TurnRepoSection({
  repoPath,
  label,
  fullLabel,
  changes,
  canOpen,
  openProjectId,
  startOpen,
  onStats,
}: {
  repoPath: string;
  startOpen: boolean;
  label: string | null;
  fullLabel: string;
  changes: TurnChanges;
  canOpen: boolean;
  openProjectId?: string;
  onStats: (stats: Stats | null) => void;
}) {
  const t = useT();
  const [kept, setKept] = useState(() => readKept(changes.checkpointId));
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<Record<string, { version: number; file: TurnFile; stats: Stats }>>({});
  /** Bumped after every discard, so each file re-reads what is on disk now. */
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState(startOpen);
  const [all, setAll] = useState(false);

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
  const discardAll = async () => {
    if (!allReady || busy) return;
    const ok = await confirmAction(t("turnReview.discardRepoConfirm", { count: changes.paths.length, repo: fullLabel }), true, t("turnReview.discardAll"));
    if (!ok) return;
    void discard(changes.paths.map((path) => ({ path, expectedRevision: reviewed[path].file.revision, content: null })));
  };

  // This repository's totals, for the card's header, once every file has been read.
  const totals = useMemo<Stats | null>(() => {
    if (!allReady) return null;
    return changes.paths.reduce(
      (sum, path) => ({ added: sum.added + reviewed[path].stats.added, removed: sum.removed + reviewed[path].stats.removed }),
      { added: 0, removed: 0 },
    );
  }, [allReady, changes.paths, reviewed]);
  useEffect(() => {
    onStats(totals);
    // `onStats` is a fresh closure each render of the card; what it reports is `totals`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totals]);

  // One flat list, sorted by path so a folder's files sit together — each row names its folder in
  // grey beside the file, where a heading per folder (most holding one file) doubled the rows.
  const sorted = useMemo(() => [...changes.paths].sort((a, b) => a.localeCompare(b)), [changes.paths]);

  if (gone) {
    return <p className="px-2 py-1.5 text-[11px] text-[var(--cf-text-faint)]">{t("turnReview.gone")}</p>;
  }

  return (
    <div className="min-w-0">
      {label && (
        // The repository as one line: its name, how many files, its totals once read — and, on
        // hover, putting all of its files back (which asks first).
        <div className="group/repo flex h-[28px] min-w-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-[var(--cf-hover)]">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px]"
          >
            <ChevronRight size={12} className={`shrink-0 text-[var(--cf-text-faint)] transition-transform ${open ? "rotate-90" : ""}`} />
            <FolderGit2 size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
            <span title={fullLabel} className="truncate font-medium text-[var(--cf-text)]">{label}</span>
            <span className="shrink-0 text-[11px] text-[var(--cf-text-faint)]">{t("turnReview.fileCount", { count: changes.paths.length })}</span>
          </button>
          {totals && <Totals stats={totals} />}
          <button
            type="button"
            onClick={() => void discardAll()}
            disabled={busy || !allReady}
            title={t("turnReview.discardRepoHint")}
            aria-label={t("turnReview.discardRepoHint")}
            className="hidden h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)] disabled:opacity-50 group-focus-within/repo:flex group-hover/repo:flex"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="mx-1 my-1 flex items-start gap-2 rounded-md px-1.5 py-1 text-[11px] text-[var(--cf-danger)]">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button type="button" onClick={refresh} disabled={busy} className="shrink-0 text-[var(--cf-accent)]">
            {t("turnReview.refresh")}
          </button>
        </div>
      )}
      {/* Mounted while folded too: the rows read their files, and the repository's line shows its
          totals without being opened. */}
      <div className={open ? (label ? "pb-1 pl-4" : "pt-1") : "hidden"}>
        {sorted.map((path, index) => (
          <div key={path} className={!all && index >= SHOWN_FILES ? "hidden" : undefined}>
            <TurnFileRow
              repoPath={repoPath}
              checkpointId={changes.checkpointId}
              path={path}
              version={version}
              kept={kept}
              onKeep={keep}
              busy={busy}
              onDiscard={discard}
              onRetry={refresh}
              onLoaded={(file, stats) =>
                setReviewed((current) => {
                  const next = { ...current };
                  if (file && stats) next[path] = { version, file, stats };
                  else delete next[path];
                  return next;
                })
              }
              onGone={() => setGone(true)}
              canOpen={canOpen}
              openProjectId={openProjectId}
            />
          </div>
        ))}
        {sorted.length > SHOWN_FILES && (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            className="ml-1.5 mt-0.5 rounded-md px-1.5 py-0.5 text-[11.5px] text-[var(--cf-accent)] hover:bg-[var(--cf-hover)]"
          >
            {all ? t("turnReview.showFewer") : t("turnReview.showMore", { count: sorted.length - SHOWN_FILES })}
          </button>
        )}
      </div>
    </div>
  );
}

/** «+12 −3», green and red; a side with nothing is left out. */
function Totals({ stats }: { stats: Stats }) {
  return (
    <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
      {stats.added > 0 && <span className="text-[var(--cf-success)]">+{stats.added}</span>}
      {stats.added > 0 && stats.removed > 0 && " "}
      {stats.removed > 0 && <span className="text-[var(--cf-danger)]">−{stats.removed}</span>}
    </span>
  );
}

/** How a file came out of the turn: created, deleted, or changed. */
function statusOf(file: TurnFile): "A" | "D" | "M" {
  if (file.before === null) return "A";
  if (file.after === null) return "D";
  return "M";
}

const STATUS_TONE: Record<"A" | "D" | "M", string> = {
  A: "var(--cf-success)",
  D: "var(--cf-danger)",
  M: "var(--cf-warning)",
};

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
  openProjectId,
}: {
  canOpen: boolean;
  openProjectId?: string;
  repoPath: string;
  checkpointId: string;
  path: string;
  version: number;
  kept: Set<string>;
  onKeep: (key: string) => void;
  busy: boolean;
  onDiscard: (edits: ReviewedEdit[]) => Promise<void>;
  onRetry: () => void;
  onLoaded: (file: TurnFile | null, stats: Stats | null) => void;
  onGone: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<TurnFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hunkError, setHunkError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setHunkError(null);
    setError(null);
    onLoaded(null, null);
    aiCheckpointFile(repoPath, checkpointId, path)
      .then((next) => {
        if (!cancelled) setFile(next);
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
  // Reported once the hunks are known, so the section can add them up.
  useEffect(() => {
    if (file) onLoaded(file, { added, removed });
    // `onLoaded` is a fresh closure each render of the parent; what it reports is the file read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, added, removed]);
  const name = baseName(path);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const unchanged = file !== null && !file.binary && hunks.length === 0;
  const status = file ? statusOf(file) : null;
  const canDiff = !!file && !file.binary && !unchanged;

  const discardFile = async () => {
    if (!file || busy) return;
    await onDiscard([{ path, expectedRevision: file.revision, content: null }]);
  };

  /** Puts one hunk's "before" lines back in place of its "now" lines, in the file as read. */
  const discardHunk = async (hunk: LineHunk) => {
    if (!file || busy) return;
    if (file.after === null) return discardFile();
    // The hunk was drawn from the file as it was read when this row loaded. Read it again right
    // before writing: if anything touched it since (the user typing, a later turn), the line numbers
    // may point at other code, so refuse rather than splice into the wrong place.
    setHunkError(null);
    const latest = await aiCheckpointFile(repoPath, checkpointId, path).catch(() => null);
    if (!sameFileAsRead(file, latest)) {
      setHunkError(t("turnReview.hunkChanged"));
      return;
    }
    const now = splitLines(file.after);
    const before = splitLines(file.before ?? "");
    const next = [...now.slice(0, hunk.bufferStart), ...before.slice(hunk.baseStart, hunk.baseEnd), ...now.slice(hunk.bufferEnd)];
    await onDiscard([{ path, expectedRevision: file.revision, content: next.join(eolOf(file.after)) }]);
  };

  const action = "flex h-5 w-[22px] items-center justify-center rounded text-[var(--cf-text-muted)]";
  return (
    <div className="min-w-0">
      <div className="group relative flex h-[26px] min-w-0 items-center gap-2 rounded-md px-1.5 hover:bg-[var(--cf-hover)]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!canDiff}
          aria-expanded={canDiff ? open : undefined}
          title={path}
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
        >
          <span
            className="flex w-3 shrink-0 justify-center font-mono text-[10.5px] font-bold"
            style={status ? { color: STATUS_TONE[status] } : undefined}
            title={status ? t(`turnReview.status${status}`) : undefined}
          >
            {status ?? <Loader2 size={10} className="animate-spin text-[var(--cf-text-faint)]" />}
          </span>
          <span
            className={`shrink-0 truncate font-mono text-[11.5px] ${
              unchanged || status === "D" ? "text-[var(--cf-text-faint)] line-through" : "text-[var(--cf-text)]"
            }`}
          >
            {name}
          </span>
          {dir && <span className="min-w-0 truncate text-[10.5px] text-[var(--cf-text-faint)]">{dir}</span>}
        </button>
        {error ? (
          <AlertCircle size={11} className="shrink-0 text-[var(--cf-danger)]" />
        ) : file === null ? null : file.binary ? (
          <span className="shrink-0 text-[10.5px] text-[var(--cf-text-faint)]">{t("turnReview.binary")}</span>
        ) : unchanged ? (
          <span className="shrink-0 text-[10.5px] text-[var(--cf-text-faint)]">{t("turnReview.reverted")}</span>
        ) : (
          <Totals stats={{ added, removed }} />
        )}
        {/* On hover, over the end of the row: the diff, the editor, and putting this file back. */}
        <span className="absolute right-1 top-1/2 z-[1] hidden -translate-y-1/2 items-center gap-px rounded-md bg-[var(--cf-surface-raised)] p-px shadow-[0_0_0_1px_var(--cf-border)] group-focus-within:flex group-hover:flex">
          {canDiff && (
            <button type="button" onClick={() => setOpen((v) => !v)} title={t("turnReview.showDiff")} aria-label={t("turnReview.showDiff")} className={`${action} hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]`}>
              <FileDiff size={12} />
            </button>
          )}
          {canOpen && file && !file.binary && file.after !== null && (
            <button
              type="button"
              onClick={() => {
                const line = (hunks[0]?.bufferStart ?? 0) + 1;
                if (openProjectId) void focusEditorOn(openProjectId).then(() => useUiStore.getState().openInEditor(path, line));
                else useUiStore.getState().openInEditor(path, line);
              }}
              title={t("turnReview.open")}
              aria-label={t("turnReview.open")}
              className={`${action} hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]`}
            >
              <ExternalLink size={12} />
            </button>
          )}
          {file && !unchanged && (
            <button
              type="button"
              onClick={() => void discardFile()}
              disabled={busy}
              title={t("turnReview.discardFile")}
              aria-label={t("turnReview.discardFile")}
              className={`${action} hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)] disabled:opacity-50`}
            >
              <Undo2 size={12} />
            </button>
          )}
        </span>
      </div>
      {error && (
        <div role="alert" className="mb-1 ml-6 flex items-start gap-2 px-1 text-[11px] text-[var(--cf-danger)]">
          <span className="min-w-0 flex-1 break-words">{t("turnReview.readFailed", { error })}</span>
          <button type="button" onClick={onRetry} disabled={busy} className="flex shrink-0 items-center gap-1 text-[var(--cf-accent)]">
            <RotateCcw size={11} />{t("turnReview.retry")}
          </button>
        </div>
      )}
      {hunkError && (
        <div role="alert" className="mb-1 ml-6 flex items-start gap-2 px-1 text-[11px] text-[var(--cf-danger)]">
          <span className="min-w-0 flex-1 break-words">{hunkError}</span>
          <button type="button" onClick={onRetry} disabled={busy} className="flex shrink-0 items-center gap-1 text-[var(--cf-accent)]">
            <RotateCcw size={11} />{t("turnReview.refresh")}
          </button>
        </div>
      )}
      {open && file && !file.binary && (
        <div className="mb-1.5 ml-6 mr-1 space-y-1">
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
  const rows = (lines: string[], sign: "-" | "+", from: number) => {
    const shown = lines.slice(0, MAX_HUNK_LINES);
    const tone =
      sign === "-"
        ? "bg-[color-mix(in_oklab,var(--cf-danger)_13%,transparent)] text-[var(--cf-text)]"
        : "bg-[color-mix(in_oklab,var(--cf-success)_13%,transparent)] text-[var(--cf-text)]";
    return (
      <>
        {shown.map((line, i) => (
          // The line's number before the turn (removed) or after it (added), in the gutter that
          // side has — so a hunk can be found in the file, and read against it.
          <div key={`${sign}${i}`} className={`flex ${tone}`}>
            <span className="w-9 shrink-0 select-none pr-1.5 text-right text-[var(--cf-text-faint)]">{sign === "-" ? from + i : ""}</span>
            <span className="w-9 shrink-0 select-none pr-1.5 text-right text-[var(--cf-text-faint)]">{sign === "+" ? from + i : ""}</span>
            <span className={`w-3.5 shrink-0 select-none ${sign === "-" ? "text-[var(--cf-danger)]" : "text-[var(--cf-success)]"}`}>{sign === "-" ? "−" : "+"}</span>
            <span className="whitespace-pre pr-2">{line || " "}</span>
          </div>
        ))}
        {lines.length > shown.length && (
          <div className="px-1.5 text-[var(--cf-text-faint)]">{t("turnReview.moreLines", { count: lines.length - shown.length })}</div>
        )}
      </>
    );
  };
  return (
    <div className="overflow-hidden rounded-[7px] border border-[var(--cf-border)]">
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
      <div className="select-text overflow-x-auto font-mono text-[11px] leading-[1.5]">
        {/* As wide as its longest line, so a row's tint runs under the whole line while scrolling. */}
        <div className="w-max min-w-full">
          {rows(removed, "-", hunk.baseStart + 1)}
          {rows(added, "+", hunk.bufferStart + 1)}
        </div>
      </div>
    </div>
  );
}
