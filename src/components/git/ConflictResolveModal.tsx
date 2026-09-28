import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Editor from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
// Monaco's one-time wiring: the bundled copy (no CDN fetch, so this works offline), the language
// workers and the theme definitions. Every module that puts an editor on screen states its own
// dependency, which is what keeps the 4 MB editor out of the entry chunk.
import "../../lib/monacoSetup";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, GitMerge, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { AiSparkles } from "../common/AiGlyph";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { resolveConflictSide, resolveConflictWithAi } from "../../lib/tauri/commands";
import * as gitApi from "../../lib/tauri/gitCommands";
import type { ConflictDetail } from "../../lib/tauri/gitCommands";
import { useRepoStore } from "../../state/repoStore";
import { useThemeStore } from "../../state/themeStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { parseClaudeError } from "../../lib/claudeError";
import { describeGitError, GIT_ERROR, hasTag } from "../../lib/gitErrors";
import { useFileLanguage } from "../../lib/useFileLanguage";
import { useT } from "../../state/languageStore";
import { buttonClass, iconButtonClass } from "../common/Button";
import {
  blockAt,
  parseConflicts,
  resolveBlock,
  stepBlock,
  type ConflictBlock,
  type ConflictChoice,
} from "../../lib/conflictMarkers";

/**
 * The three-way conflict editor: every version of one conflicted file, and the result being built.
 *
 * Ours, base and theirs sit side by side along the top — read-only, straight from the index's three
 * stages — and the result underneath is the file as it will be written: git's markers and all, until
 * each conflict is settled. The bar between them walks the conflicts (‹ ›) and settles the one the
 * cursor is on: ours, theirs, or both in either order. Anything can also be typed by hand; the buttons
 * read the markers out of whatever is there (see `lib/conflictMarkers`), so the two never disagree.
 * "Mark resolved" writes the result and stages it.
 *
 * **The AI resolver lives here now.** It used to be a dialog of its own that proposed a whole file and
 * accepted it in one click. Here its proposal is written into the result pane like any other edit —
 * one undo takes it back — and nothing reaches the disk until the same "mark resolved" every other
 * resolution goes through.
 *
 * A conflict with no text to merge — binary, or deleted on one side — gets the choices that make
 * sense for it (keep a side, or delete) instead of a result pane that would be a lie.
 *
 * Portalled to `document.body` at the dialog layer (`z-40`), for the reason the previous version of
 * this file wrote down: the Changes view sits inside `.cf-ambient-bg`, whose `isolation: isolate`
 * would trap the dialog under the app's chrome.
 */

const PANE_OPTIONS: MonacoEditorNS.IStandaloneEditorConstructionOptions = {
  readOnly: true,
  fontSize: 12,
  minimap: { enabled: false },
  lineNumbersMinChars: 3,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: "none",
};

const RESULT_OPTIONS: MonacoEditorNS.IStandaloneEditorConstructionOptions = {
  fontSize: 13,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
};

/** The result pane's conflict colours — decorations need real class names, so they live here. */
const DECORATION_CSS = `
.cf-cm-marker { background: color-mix(in oklab, var(--cf-text-faint) 22%, transparent); }
.cf-cm-ours { background: color-mix(in oklab, var(--cf-success) 16%, transparent); }
.cf-cm-base { background: color-mix(in oklab, var(--cf-warning) 14%, transparent); }
.cf-cm-theirs { background: color-mix(in oklab, var(--cf-ref-remote, var(--cf-accent)) 18%, transparent); }
`;

function decorationsFor(blocks: ConflictBlock[]): MonacoEditorNS.IModelDeltaDecoration[] {
  const out: MonacoEditorNS.IModelDeltaDecoration[] = [];
  const whole = (from: number, to: number, className: string) => {
    if (to < from) return;
    out.push({
      range: { startLineNumber: from + 1, startColumn: 1, endLineNumber: to + 1, endColumn: 1 },
      options: { isWholeLine: true, className },
    });
  };
  for (const block of blocks) {
    const oursStart = block.startLine + 1;
    const oursEnd = oursStart + block.ours.length - 1;
    whole(block.startLine, block.startLine, "cf-cm-marker");
    whole(oursStart, oursEnd, "cf-cm-ours");
    let separator = oursEnd + 1;
    if (block.base !== null) {
      whole(separator, separator, "cf-cm-marker");
      const baseStart = separator + 1;
      whole(baseStart, baseStart + block.base.length - 1, "cf-cm-base");
      separator = baseStart + block.base.length;
    }
    whole(separator, separator, "cf-cm-marker");
    whole(separator + 1, block.endLine - 1, "cf-cm-theirs");
    whole(block.endLine, block.endLine, "cf-cm-marker");
  }
  return out;
}

export function ConflictResolveModal({
  filePath,
  onClose,
  autoAi = false,
}: {
  filePath: string;
  onClose: () => void;
  /** Start the AI proposal as soon as the file is loaded — the banner's "AI" button. */
  autoAi?: boolean;
}) {
  const t = useT();
  const repoPath = useRepoStore((s) => s.repoPath);
  const theme = useThemeStore((s) => s.monacoTheme);

  const [detail, setDetail] = useState<ConflictDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [initial, setInitial] = useState<string | null>(null);
  const [cursorLine, setCursorLine] = useState(0);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiProposed, setAiProposed] = useState(false);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const decorationIds = useRef<string[]>([]);
  /** A replacement asked for before the result editor mounted — applied the moment it does. */
  const pendingResult = useRef<string | null>(null);
  const autoStarted = useRef(false);

  const language = useFileLanguage(filePath, detail?.ours ?? detail?.theirs ?? "");
  const blocks = useMemo(() => parseConflicts(text), [text]);
  const busy = saving || aiBusy;

  /** The result as the editor holds it right now — `text` trails it by a render. */
  const currentText = useCallback(() => editorRef.current?.getModel()?.getValue() ?? text, [text]);

  /** Replaces the result as one undoable edit, so a button (or the AI) can be taken back with ⌘Z. */
  const replaceResult = useCallback((next: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) {
      pendingResult.current = next;
      setText(next);
      return;
    }
    editor.pushUndoStop();
    editor.executeEdits("cf-conflict", [{ range: model.getFullModelRange(), text: next, forceMoveMarkers: true }]);
    editor.pushUndoStop();
  }, []);

  const runAi = useCallback(async () => {
    if (!repoPath) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const proposal = await resolveConflictWithAi(repoPath, filePath);
      replaceResult(proposal);
      setAiProposed(true);
    } catch (e) {
      setAiError(parseClaudeError(String(e)).message);
    } finally {
      setAiBusy(false);
    }
  }, [repoPath, filePath, replaceResult]);

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await gitApi.getConflictDetail(repoPath, filePath);
        if (cancelled) return;
        let start = loaded.working ?? "";
        // The working copy is what git wrote plus whatever was already typed into it, so it is where
        // the result starts — unless it is gone, in which case the stages are merged again.
        if (loaded.kind === "text" && loaded.working === null) {
          start = await gitApi.getConflictMergeText(repoPath, filePath).catch(() => "");
        }
        if (cancelled) return;
        setDetail(loaded);
        setText(start);
        setInitial(start);
      } catch (e) {
        if (!cancelled) setLoadError(describeGitError(e, t));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `t` is stable for a language; the file is what this is about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, filePath]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    decorationIds.current = editor.deltaDecorations(decorationIds.current, decorationsFor(blocks));
  }, [blocks]);

  /** The conflict the bar acts on: the one under the cursor, else the next one down, else the last. */
  const active = useMemo(() => {
    if (blocks.length === 0) return -1;
    const at = blockAt(blocks, cursorLine);
    if (at !== -1) return at;
    const next = blocks.findIndex((b) => b.startLine > cursorLine);
    return next === -1 ? blocks.length - 1 : next;
  }, [blocks, cursorLine]);

  const goTo = (index: number) => {
    const block = blocks[index];
    const editor = editorRef.current;
    if (!block || !editor) return;
    editor.setPosition({ lineNumber: block.startLine + 1, column: 1 });
    editor.revealLineInCenterIfOutsideViewport(block.startLine + 1);
    editor.focus();
  };

  const step = (direction: 1 | -1) => goTo(stepBlock(blocks, cursorLine, direction));

  const accept = (choice: ConflictChoice) => {
    const now = currentText();
    const fresh = parseConflicts(now);
    const block = fresh[Math.min(active, fresh.length - 1)];
    if (!block) return;
    replaceResult(resolveBlock(now, block, choice));
    const editor = editorRef.current;
    if (editor) {
      editor.setPosition({ lineNumber: block.startLine + 1, column: 1 });
      editor.revealLineInCenterIfOutsideViewport(block.startLine + 1);
    }
  };

  const restart = async () => {
    if (!repoPath) return;
    try {
      replaceResult(await gitApi.getConflictMergeText(repoPath, filePath));
      setAiProposed(false);
    } catch (e) {
      pushErrorToast(describeGitError(e, t));
    }
  };

  const refreshRepo = async () => {
    const repo = useRepoStore.getState();
    await Promise.all([repo.refreshMergeState(), repo.refreshStatus()]);
  };

  const settle = async (work: () => Promise<void>) => {
    setSaving(true);
    try {
      await work();
      await refreshRepo();
      pushSuccessToast(t("conflictEditor.resolved", { path: filePath }));
      onClose();
    } catch (e) {
      pushErrorToast(describeGitError(e, t));
      // Somebody else resolved it meanwhile: there is nothing left for this editor to do.
      if (hasTag(e, GIT_ERROR.conflictGone)) {
        await refreshRepo().catch(() => {});
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  const markResolved = async () => {
    if (!repoPath) return;
    const result = currentText();
    const left = parseConflicts(result).length;
    if (left > 0) {
      const ok = await confirmAction(
        t("conflictEditor.markersLeft", { n: String(left) }),
        true,
        t("conflictEditor.markResolved"),
      );
      if (!ok) return;
    }
    await settle(() => gitApi.resolveConflictWithText(repoPath, filePath, result));
  };

  const keepSide = (side: "ours" | "theirs") =>
    settle(async () => {
      if (!repoPath) return;
      await resolveConflictSide(repoPath, filePath, side);
    });

  const resolveDeleted = async () => {
    if (!repoPath) return;
    if (!(await confirmAction(t("conflictEditor.deleteConfirm", { path: filePath }), true, t("conflictEditor.delete")))) return;
    await settle(() => gitApi.resolveConflictDeleted(repoPath, filePath));
  };

  const close = async () => {
    if (busy) return;
    if (initial !== null && detail?.kind === "text" && currentText() !== initial) {
      if (!(await confirmAction(t("conflictEditor.discardEdits"), true, t("conflictEditor.close")))) return;
    }
    onClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape inside an editor belongs to the editor — it closes a suggestion or the find widget.
      const inEditor = event.target instanceof Element && event.target.closest(".monaco-editor");
      if (event.key === "Escape" && !inEditor) void close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pane = (label: string, value: string | null, missing: string) => (
    <div className="flex min-h-0 min-w-0 flex-col border-r border-[var(--cf-border)] last:border-r-0">
      <div className="flex h-7 shrink-0 items-center px-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
        {label}
      </div>
      <div className="min-h-0 flex-1">
        {value === null ? (
          <div className="flex h-full items-center justify-center px-3 text-center text-[12px] text-[var(--cf-text-faint)]">
            {missing}
          </div>
        ) : (
          <Editor height="100%" language={language} value={value} theme={theme} options={PANE_OPTIONS} />
        )}
      </div>
    </div>
  );

  const renderBody = () => {
    if (loadError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <AlertTriangle size={18} className="text-[var(--cf-danger)]" />
          <p className="max-w-[520px] text-[12px] text-[var(--cf-text)]">{loadError}</p>
        </div>
      );
    }
    if (!detail || initial === null) {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader2 size={18} className="animate-spin text-[var(--cf-accent)]" />
        </div>
      );
    }
    if (detail.kind !== "text") {
      const message =
        detail.kind === "binary"
          ? t("conflictEditor.binary")
          : detail.kind === "deleted_by_us"
            ? t("conflictEditor.deletedByUs")
            : t("conflictEditor.deletedByThem");
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="max-w-[480px] text-[13px] text-[var(--cf-text)]">{message}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {detail.ours_present && (
              <button type="button" disabled={busy} onClick={() => void keepSide("ours")} className={buttonClass()}>
                {t("conflicts.keepOurs")}
              </button>
            )}
            {detail.theirs_present && (
              <button type="button" disabled={busy} onClick={() => void keepSide("theirs")} className={buttonClass()}>
                {t("conflicts.keepTheirs")}
              </button>
            )}
            {detail.kind !== "binary" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void resolveDeleted()}
                className={buttonClass({ variant: "danger-ghost" })}
              >
                <Trash2 size={13} />
                {t("conflictEditor.delete")}
              </button>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="grid h-[34%] min-h-[120px] shrink-0 grid-cols-3 border-b border-[var(--cf-border)]">
          {pane(t("conflictEditor.ours"), detail.ours, t("conflictEditor.noSide"))}
          {pane(t("conflictEditor.base"), detail.base, t("conflictEditor.noBase"))}
          {pane(t("conflictEditor.theirs"), detail.theirs, t("conflictEditor.noSide"))}
        </div>
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-sunken)] px-2.5">
          <span className="text-[12px] tabular-nums text-[var(--cf-text-muted)]">
            {blocks.length === 0
              ? t("conflictEditor.noneLeft")
              : t("conflictEditor.counter", { n: String(active + 1), total: String(blocks.length) })}
          </span>
          <button
            type="button"
            disabled={blocks.length === 0}
            onClick={() => step(-1)}
            title={t("conflictEditor.prev")}
            aria-label={t("conflictEditor.prev")}
            className={iconButtonClass({ size: "xs" })}
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            disabled={blocks.length === 0}
            onClick={() => step(1)}
            title={t("conflictEditor.next")}
            aria-label={t("conflictEditor.next")}
            className={iconButtonClass({ size: "xs" })}
          >
            <ChevronRight size={14} />
          </button>
          <span className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
          {(
            [
              ["ours", t("conflictEditor.acceptOurs")],
              ["theirs", t("conflictEditor.acceptTheirs")],
              ["both-ours-first", t("conflictEditor.acceptBothOursFirst")],
              ["both-theirs-first", t("conflictEditor.acceptBothTheirsFirst")],
            ] as [ConflictChoice, string][]
          ).map(([choice, label]) => (
            <button
              key={choice}
              type="button"
              disabled={blocks.length === 0 || busy}
              onClick={() => accept(choice)}
              className={buttonClass({ variant: "ghost", size: "sm" })}
            >
              {label}
            </button>
          ))}
          <span className="flex-1" />
          {aiProposed && !aiBusy && (
            <span className="truncate text-[11px] text-[var(--cf-text-faint)]" title={t("conflictEditor.aiReviewHint")}>
              {t("conflictEditor.aiProposed")}
            </span>
          )}
          {aiError && (
            <span className="max-w-[260px] truncate text-[11px] text-[var(--cf-danger)]" title={aiError}>
              {aiError}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1">
          <Editor
            height="100%"
            language={language}
            defaultValue={initial}
            theme={theme}
            options={{ ...RESULT_OPTIONS, readOnly: aiBusy }}
            onChange={(value) => setText(value ?? "")}
            onMount={(editor) => {
              editorRef.current = editor;
              decorationIds.current = editor.deltaDecorations([], decorationsFor(parseConflicts(initial)));
              editor.onDidChangeCursorPosition((event) => setCursorLine(event.position.lineNumber - 1));
              const first = parseConflicts(initial)[0];
              if (first) {
                editor.setPosition({ lineNumber: first.startLine + 1, column: 1 });
                editor.revealLineInCenter(first.startLine + 1);
              }
              if (pendingResult.current !== null) {
                const model = editor.getModel();
                if (model) editor.executeEdits("cf-conflict", [{ range: model.getFullModelRange(), text: pendingResult.current }]);
                pendingResult.current = null;
              }
              // The banner's "AI" opens the editor with the proposal already on its way — started here,
              // once there is a result pane to put it in, and never for a binary conflict (no pane).
              if (autoAi && !autoStarted.current) {
                autoStarted.current = true;
                void runAi();
              }
            }}
          />
        </div>
      </div>
    );
  };

  const textConflict = detail?.kind === "text" && initial !== null;

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => void close()}>
      <style>{DECORATION_CSS}</style>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="flex h-[90vh] w-[1200px] max-w-[96vw] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow-modal)]"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] pl-3.5 pr-2">
          <GitMerge size={15} className="shrink-0 text-[var(--cf-warning)]" />
          <span className="text-[13px] font-semibold text-[var(--cf-text)]">{t("conflictEditor.title")}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">{filePath}</span>
          {textConflict && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runAi()}
                title={t("conflictEditor.aiHint")}
                className={buttonClass({ variant: "ghost", size: "sm" })}
              >
                {/* The orb, not a spinner: this is a model writing the resolution. */}
                {aiBusy ? <ThinkingOrb size="sm" /> : <AiSparkles size={13} />}
                {t("conflicts.aiResolveTitle")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void restart()}
                title={t("conflictEditor.restartHint")}
                aria-label={t("conflictEditor.restart")}
                className={iconButtonClass({ size: "sm" })}
              >
                <RotateCcw size={13} />
              </button>
            </>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void close()}
            aria-label={t("conflictEditor.close")}
            className={iconButtonClass({ size: "sm" })}
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1">{renderBody()}</div>

        {textConflict && (
          <div className="flex h-12 shrink-0 items-center justify-end gap-2 border-t border-[var(--cf-border)] px-3">
            <button type="button" disabled={busy} onClick={() => void close()} className={buttonClass({ variant: "ghost" })}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void markResolved()}
              className={buttonClass({ variant: "primary" })}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              {t("conflictEditor.markResolved")}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
