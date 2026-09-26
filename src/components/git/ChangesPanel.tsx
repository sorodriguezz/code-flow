import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Columns2,
  FileText,
  FolderTree,
  GitCommitHorizontal,
  List,
  ListMinus,
  ListPlus,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Copy,
  History,
} from "lucide-react";
import { AiSparkles } from "../common/AiGlyph";
import type { LucideIcon } from "lucide-react";
import { useRepoStore } from "../../state/repoStore";
import { useBlameStore } from "../../state/blameStore";
import { useLayoutStore } from "../../state/layoutStore";
import { DiffView } from "./DiffView";
import { EmptyState } from "../common/EmptyState";
import { FileGlyph } from "../common/FileGlyph";
import { ResizeHandle } from "../common/ResizeHandle";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { BouncingDots } from "../common/BouncingDots";
import { generateCommitMessage, getFileDiff, getStagedDiff, scanStagedSecrets } from "../../lib/tauri/commands";
import { useTaskModelLabel } from "../ai/ModelTag";
import { diffToText } from "../../lib/diffText";
import { parseClaudeError, type ClaudeErrorInfo } from "../../lib/claudeError";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { FileHistoryModal } from "./FileHistoryModal";
import { fileStatusColor, fileStatusLabelKey, fileStatusLetter } from "../../lib/fileStatus";
import { buildFileTree, type FileTreeNode } from "../../lib/buildFileTree";
import { splitPath } from "../../lib/splitPath";
import { useT } from "../../state/languageStore";
import { ConflictsBanner } from "./ConflictsBanner";
import { SecretScanModal } from "./SecretScanModal";
import { useUiStore } from "../../state/uiStore";
import { openAnalysis } from "../../lib/aiPanelNav";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { riseDelay } from "../../lib/rise";
import { useMinimumSpin } from "../../lib/useMinimumSpin";
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

/**
 * A cheap identity for "this file's change, as git currently sees it right now".
 *
 * The store's `workingDiff`/`stagedDiff` are rebuilt from scratch on every watcher tick, so their
 * objects have a fresh identity several times a second even when nothing about the file moved.
 * Keying the full-context fetch below on that identity would put an IPC round trip on every tick —
 * exactly the cost this whole change exists to remove. So the fetch is keyed on the *content* of
 * the change instead: every added and removed line verbatim, plus the hunk headers that place them.
 * Two ticks that found the same diff produce the same string and nothing is refetched; any real
 * edit changes it and the pane reloads.
 *
 * Context lines are deliberately left out — they are what the narrow diff is missing, so including
 * them would make the signature depend on the very thing it cannot see.
 *
 * (`EditorPane` carries its own copy of this for its diff tab. Worth lifting into `lib/diffText.ts`
 * if a third caller ever appears.)
 */
function diffSignature(file: FileDiffInfo | undefined): string | null {
  if (!file) return null;
  const parts: string[] = [file.status, file.new_path ?? "", file.old_path ?? ""];
  for (const hunk of file.hunks) {
    parts.push(hunk.header);
    for (const line of hunk.lines) {
      if (line.origin !== " ") parts.push(`${line.origin}${line.old_lineno ?? ""}:${line.new_lineno ?? ""}:${line.content}`);
    }
  }
  return parts.join("\0");
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
              style={riseDelay(i)}
              className="cf-rise flex items-center gap-2 rounded-md px-1.5 py-1 text-[12px] hover:bg-[var(--cf-hover)]"
            >
              <span className="flex-1 min-w-0 truncate">{c.summary}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-[var(--cf-text-muted)]">{c.short_id}</span>
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
  at = 0,
  displayName,
  onContextMenu,
}: {
  entry: FileStatusEntry;
  selected: boolean;
  onSelect: () => void;
  actions: RowAction[];
  /** Right-click. The hover buttons are the same verbs; this is where the ones that do not fit on
   *  a 26px row live — copy the path, open the file's history, reveal it on disk. */
  onContextMenu?: (event: React.MouseEvent) => void;
  /** Tree mode nests files under their directory, so indent by depth instead of showing
   * the full path — and show just the filename, since the path is implied by the nesting. */
  depth?: number;
  /** Place in the list it arrives with, which is all the entry animation needs to stagger. */
  at?: number;
  displayName?: string;
}) {
  const t = useT();
  // Tree mode already draws the folders as rows above this one, so there is nothing left for the
  // path half to say; the flat list is the only place it has to be spelled out.
  const { dir, name } = displayName ? { dir: "", name: displayName } : splitPath(entry.path);
  return (
    <div
      onClick={onSelect}
      onContextMenu={onContextMenu}
      /**
       * `content-visibility` lets the browser skip rendering a row that is nowhere near the
       * viewport and use the reserved 26px instead. A branch switch that lands two thousand changed
       * files used to build and lay out two thousand rows before the first frame; now it builds the
       * screenful you can see. Nothing is dropped from the DOM — the rows are all still there for
       * find-in-page, for the scrollbar and for selection.
       *
       * It also happens to fix the `cf-rise` stagger for free, and this is the reason to prefer it
       * over any cap on the animation: a skipped row does not run its animation at all, so the two
       * thousand simultaneous animations become the dozen on screen, and every row the user can
       * actually watch still rises exactly as it always did.
       *
       * `auto` before the size so the browser swaps in each row's real height after its first
       * render; 26px is what one of these rows measures (13px text, `py-1`, a 13px glyph).
       *
       * Chromium has this; Safari only from 18.0, where it is a silent no-op and the panel behaves
       * exactly as before. The win is Windows and current macOS.
       */
      style={{
        ...(depth ? { paddingLeft: depth * 14 } : null),
        ...riseDelay(at),
        contentVisibility: "auto",
        containIntrinsicSize: "auto 26px",
      }}
      className={`cf-rise group flex items-center gap-2 rounded-md px-2 py-1 text-[13px] cursor-pointer ${
        selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"
      }`}
    >
      {/* The shared letter and colour (`lib/fileStatus`): `?` untracked, `U` only for a conflict —
          this list used to take the first letter of the English word, so "U" meant untracked here
          and conflicted in the commit list one tab away. */}
      <span
        title={t(fileStatusLabelKey(entry.status))}
        className="w-4 shrink-0 text-center font-mono text-[11px] font-bold"
        style={{ color: fileStatusColor(entry.status) }}
      >
        {fileStatusLetter(entry.status)}
      </span>
      <FileGlyph path={entry.path} />
      {/* The name at full contrast and the folders behind it dimmed, in that order: the row is read
          for the filename, and the path is what tells two files called `index.ts` apart — needed,
          but not the thing you look at first.

          Which half gives up its width is the whole trick. Both truncate, and the path is weighted
          to shrink about ten thousand times faster than the name, so narrowing the panel eats the
          path from its end — `src/components/g…` — and only ever reaches the filename once there is
          no path left to take. Flexbox does the measuring, which is what makes it react to every
          way a row's width changes at once: dragging the list's resize handle, the diff pane opening
          beside it, the editor dock's own handle, and the window itself. */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono" title={entry.path}>
        <span className="min-w-0 truncate text-[12px]">{name}</span>
        {dir && (
          <span className="min-w-0 shrink-[9999] truncate text-[11px] text-[var(--cf-text-muted)]">
            {dir}
          </span>
        )}
      </span>
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
  onContextMenu,
}: {
  entries: FileStatusEntry[];
  isSelected: (entry: FileStatusEntry) => boolean;
  onSelectEntry: (entry: FileStatusEntry) => void;
  buildActions: (entry: FileStatusEntry) => RowAction[];
  onContextMenu?: (event: React.MouseEvent, entry: FileStatusEntry) => void;
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

  const renderNode = (node: FileTreeNode, depth: number, at: number): React.ReactNode => {
    if (node.type === "file") {
      return (
        <FileRow
          key={node.entry.path}
          entry={node.entry}
          selected={isSelected(node.entry)}
          onSelect={() => onSelectEntry(node.entry)}
          actions={buildActions(node.entry)}
          onContextMenu={(event) => onContextMenu?.(event, node.entry)}
          depth={depth}
          at={at}
          displayName={node.name}
        />
      );
    }
    const collapsed = collapsedDirs.has(node.path);
    return (
      <div key={node.path}>
        <div
          onClick={() => toggleDir(node.path)}
          style={{ paddingLeft: depth * 14, ...riseDelay(at) }}
          className="cf-rise flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
        >
          {collapsed ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
          {/* The same glyph the explorer draws for this folder, rather than a plain outline: a
              folder icon the user chose a rule for should look like itself wherever it appears. */}
          <FileGlyph path={node.path} isFolder open={!collapsed} size={12} />
          <span className="truncate">{node.name}</span>
        </div>
        {!collapsed && node.children.map((child, index) => renderNode(child, depth + 1, index))}
      </div>
    );
  };

  return <>{tree.map((node, index) => renderNode(node, 0, index))}</>;
}

/**
 * The Changes screen: staged and unstaged lists, the row actions that move files between them,
 * and the commit box.
 *
 * Rendered in two places, and the callbacks are what tell them apart. On its own screen it takes
 * no props and owns the whole flow — clicking a row opens that file's diff in the pane beside the
 * list. Docked in the editor (`EditorView`'s right panel) it gets `onOpenFile`/`onOpenDiff` and
 * hands both off instead: the editor already *is* a place to read a file, so a diff pane squeezed
 * into a 300px dock would be a worse copy of the one next door. Everything else — the sections,
 * the stage/discard buttons, the AI message, the secret scan — is the same component either way,
 * which is the point of doing it with two props rather than a second panel.
 */
export function ChangesPanel({
  onOpenFile,
  onOpenDiff,
  headerAction,
}: {
  /** Open this file in the editor, at its first changed line. Its presence is what puts the panel
   * in docked mode: rows navigate instead of selecting, and the built-in diff pane never opens. */
  onOpenFile?: (path: string, line?: number) => void;
  /** Open this file's before/after side-by-side view. Only offered alongside `onOpenFile`. */
  onOpenDiff?: (path: string) => void;
  /**
   * A control for the container, rendered at the end of the header row.
   *
   * The editor's dock uses it for its own close button. That button used to live in a rail beside
   * the panel, which cost a permanent 36px column of nothing down the full height of the window
   * and held the panel off the edge it's docked to. A panel's close control belongs in the panel.
   */
  headerAction?: ReactNode;
} = {}) {
  const docked = !!onOpenFile;
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
  const clearSelection = useCallback(() => setSelected(null), []);
  const [viewMode, setViewMode] = useState<"list" | "tree">("list");
  /**
   * Local, rather than the store's `busy`.
   *
   * `busy` is set by every guarded repo action there is — a stage, a discard, a push — so binding
   * the spinner to it would have this button spin for work it did not start, and stop spinning
   * when something else finished. It is the *button's* own round trip that it reports.
   *
   * Floored, and through the same hook the explorer's Refresh uses, so the two buttons in the same
   * window behave identically rather than one of them looking alive only because its work happens
   * to be slower.
   */
  const [refreshing, runRefreshing] = useMinimumSpin();
  const openInEditor = useUiStore((s) => s.openInEditor);
  const [message, setMessage] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<ClaudeErrorInfo | null>(null);
  /** The right-click menu on a changed file, and where to draw it. */
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** The file whose history is open, if any. */
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [secretHits, setSecretHits] = useState<SecretHit[] | null>(null);
  const secretScanEnabled = usePreferencesStore((s) => s.secretScanEnabled);
  const [pending, setPending] = useState<{ path: string; kind: "stage" | "unstage" | "discard" | "all" } | null>(
    null,
  );
  const t = useT();
  /** The engine and model the ✨ button will use, from the routing table — see `useTaskModelLabel`.
   * `"commit"` is the key Rust's `AiTask::Commit` reports, which is what `generate_commit_message`
   * loads its config from; naming any other task here would put a confident lie in the tooltip. */
  const commitModel = useTaskModelLabel("commit");
  /** Same, for the 🛡 button. `"analyze"` is `AiTask::Analyze`'s key — the task the change analysis
   *  actually routes through. Worth the second line for the same reason the commit button's is, and
   *  one more: when the run fails it fails as `failed to launch 'opencode'`, a sentence naming a
   *  binary the user never chose by that name and cannot connect to anything on this screen. */
  const analyzeModel = useTaskModelLabel("analyze");

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

  /**
   * The selected file's entry in the store's bulk arrays. **Not what the diff pane renders** — those
   * arrays are fetched at a narrow context now (see `LIST_DIFF_CONTEXT_LINES` in `repoStore`), and
   * the pane's split mode rebuilds whole file texts out of the hunks, which at three lines of
   * context would draw almost the entire file as deleted. This is only here to notice that the
   * file's change has actually moved, so the full-context copy below can be refetched.
   */
  const selectedNarrow = useMemo(() => {
    if (!selected) return undefined;
    const pool = selected.staged ? stagedDiff : workingDiff;
    return pool.find((f) => (f.new_path ?? f.old_path) === selected.path);
  }, [selected, stagedDiff, workingDiff]);
  const selectedSignature = useMemo(() => diffSignature(selectedNarrow), [selectedNarrow]);

  /** The selected file at full file context, straight from git — `null` while it is on its way,
   * `[]` when that path has no diff on that side any more (staged, discarded or committed out from
   * under the row, which `DiffView` already draws as "no changes"). */
  const [selectedDiff, setSelectedDiff] = useState<FileDiffInfo[] | null>(null);
  /**
   * Bumped by the refresh button, and only by it.
   *
   * The fetch below already re-runs whenever the file's change moves, which covers everything the
   * watcher can see. This covers what it cannot: a file that has dropped out of the narrow arrays
   * has no signature at all, and a binary file's signature never moves however much its bytes do —
   * so for those two the content-derived key is a constant, and the pane would go on showing what
   * it fetched when the row was first clicked.
   */
  const [diffNonce, setDiffNonce] = useState(0);

  // Blanking is keyed on the *selection* alone, and refetching on the selection plus the signature.
  // That split is what keeps both halves of the feel right: picking a different file must never
  // leave the previous file's diff on screen while the new one is in flight, but a watcher tick on
  // the file you are already reading refetches underneath the pane without flashing it away.
  useEffect(() => {
    setSelectedDiff(null);
  }, [selected]);

  /**
   * Drops the selection when the file it names stops having a change on that side.
   *
   * The discard-all button hand-patches exactly this case a few hundred lines down, and that was enough
   * while every route to it went through this component's own buttons. It no longer is: the editor's
   * change peek stages and discards from the gutter, so a file can leave `status` entirely without this
   * panel's `setSelected` ever being called — leaving the list scrolled to a row that is gone, the pane
   * beside it holding "no changes" for a file with none, and the whole layout still pinned to
   * `listWidth` for a diff nobody can act on.
   *
   * Keyed on `status` rather than on the diff arrays because it is asking about *existence*, not about
   * content — a watcher tick that only changed some lines leaves the row exactly where it was, and this
   * effect finds the path and does nothing.
   */
  useEffect(() => {
    if (!selected) return;
    const pool = selected.staged ? (status?.staged ?? []) : [...(status?.unstaged ?? []), ...(status?.untracked ?? [])];
    if (!pool.some((entry) => entry.path === selected.path)) setSelected(null);
  }, [status, selected]);

  useEffect(() => {
    if (!repoPath || !selected) return;
    const { path, staged } = selected;
    let cancelled = false;
    // One file, at the whole-file context this pane has always been fed — the cost that used to be
    // paid for every changed file on every refresh is now paid for the one being looked at.
    getFileDiff(repoPath, path, staged)
      .then((file) => {
        if (!cancelled) setSelectedDiff(file ? [file] : []);
      })
      .catch(() => {
        // A diff that fails to load is not worth a toast on top of whatever else just went wrong
        // with the repository — the pane says "no changes", which is also what it said before this
        // was a fetch at all when the file had dropped out of the list.
        if (!cancelled) setSelectedDiff([]);
      });
    return () => {
      cancelled = true;
    };
    // `diffNonce` is deliberately here and *not* on the blanking effect above: adding it there
    // would make the refresh button flash this pane empty for the length of a round trip.
  }, [repoPath, selected, selectedSignature, diffNonce]);

  // Open the file in the app's own Editor tab (at the first changed line) instead of handing it
  // to the OS default app — the point is to inspect the change in place, not to leave the app.
  // Docked, the editor is already on screen and hands us the opener, so it takes the file straight
  // into the group the user is working in rather than switching views to reach itself.
  const openFile = (relPath: string, staged: boolean) => {
    const pool = staged ? stagedDiff : workingDiff;
    const files = pool.filter((f) => (f.new_path ?? f.old_path) === relPath);
    const line = firstChangedLine(files);
    if (onOpenFile) onOpenFile(relPath, line);
    else openInEditor(relPath, line);
  };

  /** What clicking the row itself does. Selecting drives the diff pane beside the list, which
   * only exists on the standalone screen; docked, the click is the "open it" gesture. */
  const selectRow = (entry: FileStatusEntry, staged: boolean) => {
    if (docked) openFile(entry.path, staged);
    else setSelected({ path: entry.path, staged });
  };

  /** Leads every row's actions. On the standalone screen the row click already opens the diff
   * beside the list, so the odd one out is "open the file"; docked those swap over — the click
   * opens the file, and this is how you get to the before/after. */
  const leadAction = (entry: FileStatusEntry, staged: boolean): RowAction =>
    docked
      ? { icon: Columns2, title: t("changes.openDiff"), onClick: () => onOpenDiff?.(entry.path) }
      : { icon: Code2, title: t("changes.openInEditor"), onClick: () => openFile(entry.path, staged) };

  if (!status) {
    return <EmptyState icon={FileText} title={t("changes.noRepo")} />;
  }

  const buildStagedActions = (entry: FileStatusEntry): RowAction[] => {
    const isPending = pending?.path === entry.path;
    const blocked = pending !== null && !isPending;
    return [
      leadAction(entry, true),
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
      leadAction(entry, false),
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

  /**
   * Right-click on a changed file.
   *
   * The row's hover buttons already carry stage/unstage/discard — a menu that repeated only those
   * would be a second way to press the same three buttons. What is here that is not there is
   * everything a 26px row has no room for: the path, the file's own history, and the file on disk.
   */
  const openFileMenu = (event: React.MouseEvent, entry: FileStatusEntry, staged: boolean) => {
    event.preventDefault();
    const items: MenuItem[] = [
      {
        label: staged ? t("changes.unstage") : t("changes.stage"),
        icon: staged ? Minus : Plus,
        onClick: () =>
          staged
            ? void runAction(entry.path, "unstage", () => unstageFile(entry.path))
            : void runAction(entry.path, "stage", () => stageFile(entry.path)),
      },
      {
        label: t("changes.openInEditor"),
        icon: Code2,
        onClick: () => openFile(entry.path, staged),
      },
      {
        label: t("changes.menuHistory"),
        icon: History,
        separated: true,
        onClick: () => setHistoryPath(entry.path),
      },
      {
        label: t("changes.menuCopyPath"),
        icon: Copy,
        onClick: () => {
          void navigator.clipboard
            .writeText(entry.path)
            .then(() => pushSuccessToast(t("common.copied")))
            .catch((e: unknown) => pushErrorToast(String(e)));
        },
      },
    ];

    // Only where it means something: a staged file's change is already in the index, and
    // "discard" on it would be the wrong verb for `git restore --staged`.
    if (!staged) {
      items.push({
        label: t("changes.discardChanges"),
        icon: Trash2,
        danger: true,
        separated: true,
        onClick: () =>
          void (async () => {
            if (await confirmAction(t("changes.discardConfirm", { path: entry.path }))) {
              void runAction(entry.path, "discard", () => discardFile(entry.path));
            }
          })(),
      });
    }

    setFileMenu({ x: event.clientX, y: event.clientY, items });
  };

  const generateWithAi = async () => {
    if (!repoPath) return;
    setAiError(null);
    setAiBusy(true);
    try {
      // Deliberately **not** the store's `stagedDiff`. That one is fetched at three lines of
      // context (see `LIST_DIFF_CONTEXT_LINES` in `repoStore`), and handing the model keyhole views
      // of each change instead of the surrounding code is a real, silent downgrade in the messages
      // it writes — a perf change has no business costing that. So this one caller still pays for
      // whole-file context, once, on an explicit click, rather than several times a second.
      const full = await getStagedDiff(repoPath);
      const text = await generateCommitMessage(diffToText(full));
      setMessage(text);
    } catch (e) {
      setAiError(parseClaudeError(String(e)));
    } finally {
      setAiBusy(false);
    }
  };

  /**
   * Re-read the repository from disk, because the user asked.
   *
   * `refreshAll` and not `refreshStatus`: the reason to reach for this is "the app is out of step
   * with the repository", and a working copy that drifted has very often had its branch, its
   * stash list or its commit graph drift with it — refreshing only the file lists would answer
   * half the question and leave the other half looking just as stale as before the click.
   *
   * Deliberately *not* silent, unlike the watcher's own refreshes: this one was asked for, so the
   * indicators an action is entitled to are the right ones to show.
   */
  const forceRefresh = () =>
    runRefreshing(async () => {
      await useRepoStore.getState().refreshAll();
      // Blame is keyed on `headOid` and nothing else, so a working copy that drifted underneath
      // us — the case this button exists for — leaves every cached annotation answering for a
      // commit that may no longer be HEAD. Eight entries at most; dropping them costs one
      // recomputation of whatever happens to be on screen.
      useBlameStore.getState().clear();
      // And the pane beside the list, which holds its own full-context copy of the selected file.
      setDiffNonce((n) => n + 1);
    });

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
      <div className="relative flex min-h-0 flex-1">
      {/* Fixed-width only while it has a neighbour. With no file selected there is no diff pane to
          share the row with, so the list takes the whole width rather than leaving a placeholder
          where the diff would have been. */}
      <div
        style={selected ? { width: listWidth } : undefined}
        className={`flex flex-col overflow-hidden bg-[var(--cf-surface)] ${
          selected ? "shrink-0" : "min-w-0 flex-1"
        }`}
      >
        <div className="flex items-center justify-between gap-1.5 border-b border-[var(--cf-border)] px-3 py-2">
          <span className="min-w-0 truncate text-[12px] font-semibold text-[var(--cf-text-muted)]">
            {t("changes.changes")}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* The way back when the watcher has not seen something.
                Everything here normally arrives on its own — `App.tsx` refreshes the repository on
                every `repo:fs-changed` — but the watcher is not a promise. It drops whole trees by
                name (`IGNORED_DIRS` in `watcher.rs`), and a working copy on a network share, an
                SMB mount or a container bind mount produces no filesystem events at all on macOS.
                In any of those the panel is showing a repository that has moved on with no way to
                say so, which is exactly the state a manual refresh exists for. */}
            <button
              onClick={() => void forceRefresh()}
              disabled={refreshing}
              title={`${t("changes.refresh")} — ${t("changes.refreshHint")}`}
              aria-label={t("changes.refresh")}
              className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:opacity-40"
            >
              <RefreshCw size={12} className={refreshing ? "animate-spin" : undefined} />
            </button>
            <div className="flex items-center gap-0.5 rounded-md border border-[var(--cf-border)] p-0.5">
              <button
                onClick={() => setViewMode("list")}
                title={t("changes.listView")}
                className={`flex h-[22px] w-[22px] items-center justify-center rounded-md ${
                  viewMode === "list"
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)]"
                }`}
              >
                <List size={12} />
              </button>
              <button
                onClick={() => setViewMode("tree")}
                title={t("changes.treeView")}
                className={`flex h-[22px] w-[22px] items-center justify-center rounded-md ${
                  viewMode === "tree"
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)]"
                }`}
              >
                <FolderTree size={12} />
              </button>
            </div>
            {/* Last in the row, so "close this panel" sits where a panel's close control belongs —
                see `headerAction`. Nothing on the standalone screen passes one. */}
            {headerAction}
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
                  className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-accent)] disabled:opacity-30"
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
                onSelectEntry={(entry) => selectRow(entry, true)}
                buildActions={(entry) => buildStagedActions(entry)}
                onContextMenu={(event, entry) => openFileMenu(event, entry, true)}
              />
            ) : (
              status.staged.map((entry, at) => (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  at={at}
                  selected={selected?.path === entry.path && selected.staged}
                  onSelect={() => selectRow(entry, true)}
                  actions={buildStagedActions(entry)}
                  onContextMenu={(event) => openFileMenu(event, entry, true)}
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
                      // Its own tab in the assistant — whatever else is open there stays open.
                      const projectId = useWorkspaceStore.getState().activeProjectId;
                      if (projectId) openAnalysis(projectId, { run: true });
                    }}
                    data-tour="changes-analyze"
                    title={[t("analyze.button"), analyzeModel].join("\n")}
                    className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-accent)]"
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
                    className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)] disabled:opacity-30"
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
                    className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-accent)] disabled:opacity-30"
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
                onSelectEntry={(entry) => selectRow(entry, false)}
                buildActions={(entry) => buildUnstagedActions(entry)}
                onContextMenu={(event, entry) => openFileMenu(event, entry, false)}
              />
            ) : (
              unstagedAndUntracked.map((entry, at) => (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  at={at}
                  selected={selected?.path === entry.path && !selected.staged}
                  onSelect={() => selectRow(entry, false)}
                  actions={buildUnstagedActions(entry)}
                  onContextMenu={(event) => openFileMenu(event, entry, false)}
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
              // Which engine is about to write the message, on the second line. Routing lives in
              // Settings → AI, three screens from here, so the only place this is answerable is the
              // button itself — and "why is this message suddenly terrible" is a question about the
              // model far more often than about the diff.
              title={[
                status.staged.length === 0 ? t("changes.stageFirst") : t("changes.generateWithAi"),
                commitModel,
              ].join("\n")}
              className="absolute right-1 top-1 flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-accent)] hover:bg-[var(--cf-accent-soft)] disabled:opacity-30"
            >
              {/* The orb, not a spinner: this is a model writing the message. */}
              {aiBusy ? <ThinkingOrb size="sm" /> : <AiSparkles size={13} />}
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
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--cf-accent-fill)] py-1.5 text-[13px] font-medium text-[var(--cf-on-accent)] disabled:opacity-40"
          >
            {scanning && <Loader2 size={13} className="animate-spin" />}
            {scanning ? t("secrets.scanning") : t("changes.commit")}{" "}
            {!scanning && status.staged.length > 0 ? `(${status.staged.length})` : ""}
          </button>
        </div>
      </div>

      {selected && (
        <>
          <ResizeHandle
            axis="x"
            value={listWidth}
            min={LIST_MIN}
            max={LIST_MAX}
            onChange={(w) => setSize("changesListWidth", w)}
            onCommit={(w) => commitSize("changesListWidth", w)}
          />

          <div className="min-h-0 flex-1 overflow-hidden bg-[var(--cf-surface)]">
            {/* The same wait the stash diff shows while its own fetch is out — a file's diff is a
                round trip now rather than a slice of an array the watcher already paid for, and a
                pane that blanks for it would read as broken. `null` is "on its way", `[]` is
                "nothing to show", which `DiffView` draws as its own empty state. */}
            {selectedDiff ? (
              <DiffView files={selectedDiff} onClose={clearSelection} />
            ) : (
              <div className="flex h-full items-center justify-center">
                <BouncingDots />
              </div>
            )}
          </div>
        </>
      )}
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

      {fileMenu && (
        <ContextMenu x={fileMenu.x} y={fileMenu.y} items={fileMenu.items} onClose={() => setFileMenu(null)} />
      )}

      {historyPath && <FileHistoryModal path={historyPath} onClose={() => setHistoryPath(null)} />}
    </div>
  );
}
