import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Minus, Plus, Undo2, X } from "lucide-react";
import type { ChangeBlock } from "../../lib/diffBlocks";
import { lineClasses } from "../../lib/diffText";
import { confirmAction } from "../../state/confirmStore";
import { useRepoStore } from "../../state/repoStore";
import { useT } from "../../state/languageStore";
import type { HunkRef } from "../../types/domain";

/** The header row, in pixels: one 20px control with a little air either side. */
const PEEK_HEADER_HEIGHT = 28;
/** One rendered code row — `text-[12px]` at `leading-[18px]`, matching what the body sets. */
const PEEK_LINE_HEIGHT = 18;
/** The header plus about two rows: below this the panel is chrome with nothing under it. */
const PEEK_MIN_HEIGHT = 86;
/**
 * Past this the body scrolls *inside* the zone rather than growing it.
 *
 * The clamp is the load-bearing half of the estimate: a view zone's height is real layout, so a
 * 400-line hunk without it would push the rest of the file seven thousand pixels down and leave the
 * user scrolling through a panel to reach the code it is about.
 */
const PEEK_MAX_HEIGHT = 320;
/**
 * How many rows of the hunk the body draws before it stops counting.
 *
 * A hunk has no size limit. Three lines of context does not stop a 2,000-line paste from being one
 * hunk, and an untracked file's single "hunk" is the *entire file* — which is the case that makes this
 * necessary rather than tidy: a new file draws one unbroken bar down the whole gutter, so a click
 * anywhere on that bar is a click that would build one DOM row per line of it, inside Monaco's
 * view-zone container, synchronously. On a generated file — a lockfile, a migration dump — that is a
 * frozen click for a panel 320px tall that could never have shown them.
 *
 * 300 is well past the ~18 rows the panel can actually display, so scrolling a real hunk still reaches
 * the end of it; past that the tail is summarised. What this caps is strictly what is *drawn*:
 * `hunkRef()` sends `block.lines` whole, so the button still acts on the entire hunk and the backend
 * still fingerprints against every line of it.
 */
const PEEK_MAX_ROWS = 300;

/**
 * How tall a peek for a hunk of `lineCount` rows will be.
 *
 * Same estimator-plus-clamp shape as `DiffView`'s `unifiedHunkHeight`/`splitHeightOf`, and the same
 * caveat applies: a long line wraps and takes two rows, so this is a guess. Unlike `DiffView`'s it
 * cannot be corrected after the fact by the browser — Monaco is told the height, not asked — which is
 * why the body carries its own `overflow-y: auto` instead of relying on the number being right.
 */
export function peekHeightOf(lineCount: number): number {
  return Math.min(
    PEEK_MAX_HEIGHT,
    Math.max(PEEK_MIN_HEIGHT, PEEK_HEADER_HEIGHT + lineCount * PEEK_LINE_HEIGHT + 8),
  );
}

/**
 * The inline change peek: one hunk of the open file's uncommitted change, drawn at the line it
 * belongs to, with the three git verbs that act on exactly that hunk.
 *
 * Rendered into a Monaco **view zone** through `createPortal` (see `EditorPane`), which is what lets
 * it sit at its line and scroll with the file for free. The alternatives were both tried on paper and
 * both rejected in the design: a nested `DiffEditor` is two models, a worker diff and a tokenizer
 * pass for 3-12 rows we already have in hand, and a content/overlay widget would be clipped, because
 * this is the one editor in the app that does not spread `OVERFLOW_SAFE_OPTIONS` and it sits inside an
 * `overflow-hidden` pane.
 *
 * Everything destructive is gated twice: on `busy`, which is the *only* interlock shared with the
 * Changes panel (its own `pending` is local state a gutter click never touches), and on a confirm that
 * names the line range. Nothing here builds a patch — the hunk is handed back verbatim so the backend
 * can recognise its own, or refuse; see `HunkRef`.
 */
export function ChangePeek({
  path,
  status,
  staged,
  block,
  blockIndex,
  total,
  onNext,
  onPrev,
  onClose,
}: {
  /** Repo-relative, POSIX-separated — the form every git command here speaks. */
  path: string;
  /** `FileDiffInfo.status`. Decides whether the buttons act on a hunk or on the whole file. */
  status: string;
  /** Which side the diff came from, which flips `+` to `−` and hides discard entirely. */
  staged: boolean;
  block: ChangeBlock;
  blockIndex: number;
  total: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const busy = useRepoStore((s) => s.busy);
  /** Local only to keep the pressed button spinning until its `refreshStatus` lands — `busy` covers
   *  the disabling, but it cannot say *which* of the three was pressed. */
  const [running, setRunning] = useState(false);

  /**
   * Escape, in the **bubble** phase and on `window`.
   *
   * Bubble rather than capture for the reason `useGlobalShortcuts` gives about its own handler:
   * Monaco's find and suggest widgets must get Escape first, and they stop it from reaching here when
   * they take it. Same shape as `InlineEditWidget`'s.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * Whether this "hunk" is really the whole file.
   *
   * An untracked, deleted or type-changed file arrives as a single all-`+` or all-`-` hunk, and the
   * backend refuses those by name (`HUNK_UNSUPPORTED`) rather than guessing — `stage_file` already
   * does the right thing for each, including the `index.remove_path` a deletion needs. So the button
   * routes to the whole-file action instead, and discard is hidden: `discard_file_changes` sets only
   * `cb.force()` and never `remove_untracked`, so discarding an untracked file is a no-op today while
   * the Changes panel's trash can promises deletion. That is a pre-existing bug with its own fix; this
   * panel must not spread it by offering a second button that silently does nothing.
   */
  const wholeFile = status !== "modified";
  const canDiscard = !staged && !wholeFile;

  const hunkRef = (): HunkRef => ({ file_path: path, header: block.header, lines: block.lines });

  const run = async (action: () => Promise<void>) => {
    setRunning(true);
    try {
      await action();
    } finally {
      setRunning(false);
    }
    // Unconditionally, and after the store has refreshed: on success the hunk this panel was about no
    // longer exists on this side, and on failure the toast is the report and a panel still offering the
    // button that just failed invites pressing it again.
    onClose();
  };

  // Read imperatively rather than subscribed: these are stable store actions, and subscribing to five
  // of them would re-render this panel on every unrelated field of a store the watcher rewrites several
  // times a second. `busy` above is the one thing here that has to be reactive.
  const onStageClick = () => {
    const store = useRepoStore.getState();
    if (staged) {
      void run(() => (wholeFile ? store.unstageFile(path) : store.unstageHunk(hunkRef())));
      return;
    }
    void run(() => (wholeFile ? store.stageFile(path) : store.stageHunk(hunkRef())));
  };

  const onDiscardClick = async () => {
    const ok = await confirmAction(
      block.firstLine === block.lastLine
        ? t("peek.discardHunkConfirmOne", { path, line: block.firstLine })
        : t("peek.discardHunkConfirm", { path, from: block.firstLine, to: block.lastLine }),
      true,
      t("peek.discardHunk"),
    );
    if (!ok) return;
    void run(() => useRepoStore.getState().discardHunk(hunkRef()));
  };

  const disabled = busy || running;
  const name = path.split("/").pop() ?? path;
  const counter = total === 1 ? t("peek.counterOne") : t("peek.counter", { n: blockIndex + 1, total });

  /** One button, so the five agree about size, hover and the disabled treatment. */
  const control = (
    key: string,
    Icon: typeof Plus,
    label: string,
    onClick: () => void,
    opts?: { danger?: boolean; spinning?: boolean; enabled?: boolean },
  ) => (
    <button
      key={key}
      onClick={onClick}
      disabled={opts?.enabled !== undefined ? !opts.enabled : disabled}
      title={label}
      aria-label={label}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] disabled:opacity-30 ${
        opts?.danger
          ? "hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.08]"
          : "hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
      }`}
    >
      {opts?.spinning ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />}
    </button>
  );

  return (
    // `--cf-surface-raised`/`--cf-border`/`--cf-shadow` are the tokens `applyThemeVars` *does* rewrite
    // per code theme, so the panel picks up Dracula's and Solarized's surfaces without a fork here —
    // the same reason `ConfirmModal` uses them.
    <div className="flex h-full flex-col overflow-hidden border-y border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]">
      <div className="flex h-7 shrink-0 items-center gap-2 px-2.5 text-[11px] text-[var(--cf-text-muted)]">
        <span className="truncate text-[var(--cf-text)]">{name}</span>
        <span className="shrink-0 opacity-60">·</span>
        <span className="truncate">{staged ? t("peek.titleStaged") : t("peek.title")}</span>
        <span className="shrink-0 opacity-60">·</span>
        <span className="shrink-0 tabular-nums">{counter}</span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {control(
            "stage",
            staged ? Minus : Plus,
            staged ? t("peek.unstageHunk") : t("peek.stageHunk"),
            onStageClick,
            { spinning: running },
          )}
          {/* `Undo2` rather than the `Trash2` the Changes panel argues for, and the divergence is
              deliberate. That argument is about a *file*: discarding one deletes it outright when it is
              untracked, so the arrow undersells it. At hunk scope it inverts — nothing is deleted, the
              operation really is "put these lines back", and a trash can beside a `+` reads as "delete
              the file". The destructive weight is carried by the confirm dialog naming the range. */}
          {canDiscard &&
            control("discard", Undo2, t("peek.discardHunk"), () => void onDiscardClick(), { danger: true })}
          {/* Always wrapping and never gated on `busy`, even mid-action: navigating touches nothing git
              owns, and the counter is the affordance that says you came back round. One rule for these
              and for ⌥F5/⇧⌥F5, so the two can't disagree about where "next" goes. Off only when there is
              nowhere to go — with one change, wrapping would land back here and an arrow that visibly
              does nothing is worse than one that is plainly unavailable. */}
          {control("next", ArrowDown, t("peek.nextChange"), onNext, { enabled: total > 1 })}
          {control("prev", ArrowUp, t("peek.prevChange"), onPrev, { enabled: total > 1 })}
          {/* Dismissing is never blocked. A panel you cannot close because some unrelated git operation
              is in flight elsewhere in the app is a trap, not an interlock. */}
          {control("close", X, t("peek.close"), onClose, { enabled: true })}
        </div>
      </div>
      {/* The hunk itself, drawn the way the Changes screen's unified pane draws one — `lineClasses`
          from `lib/diffText.ts`, shared so the two can never tint a `+` differently. `--cf-text` is
          set explicitly because this sits inside Monaco's DOM, where the inherited colour is a
          token-highlighting class rather than the app's body text. */}
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[18px] text-[var(--cf-text)]">
        {wholeFile && !staged && status === "untracked" && (
          <div className="px-2.5 py-1 text-[var(--cf-text-muted)]">{t("peek.wholeFileNew")}</div>
        )}
        {block.lines.slice(0, PEEK_MAX_ROWS).map((line, i) => (
          <div key={i} className={`flex gap-2.5 px-2.5 ${lineClasses(line.origin)}`}>
            <span className="w-7 shrink-0 select-none text-right text-[var(--cf-text-muted)]">
              {line.old_lineno ?? ""}
            </span>
            <span className="w-7 shrink-0 select-none text-right text-[var(--cf-text-muted)]">
              {line.new_lineno ?? ""}
            </span>
            <span className="whitespace-pre">
              {line.origin === "+" || line.origin === "-" ? line.origin : " "}
              {line.content}
            </span>
          </div>
        ))}
        {block.lines.length > PEEK_MAX_ROWS && (
          <div className="px-2.5 py-1 text-[var(--cf-text-muted)]">
            {t("peek.moreLines", { n: block.lines.length - PEEK_MAX_ROWS })}
          </div>
        )}
      </div>
    </div>
  );
}
