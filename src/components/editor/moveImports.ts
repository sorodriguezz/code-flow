import { currentRepoPath, didRenameFiles, willRenameFiles, type PathRename } from "../../lib/lsp/client";
import { relPathFromFileUri } from "../../lib/lsp/protocol";
import {
  scriptKind,
  tsAbsolute,
  tsIsRunning,
  tsNotify,
  tsOpenFiles,
  tsRelPath,
  tsRequest,
  tsServedProject,
} from "../../lib/tsserver";
import {
  applyEditPlan,
  applyToOpenTabs,
  defaultApplyDeps,
  mergeOutcomes,
  mergePlans,
  planLspEdit,
  planTsFileEdits,
  remapPlan,
  type ApplyOutcome,
  type EditPlan,
  type TsFileEdits,
} from "../../lib/workspaceEdit";
import { islandPaths } from "../../lib/editorIslands";
import { useEditorPanelStore } from "../../state/editorPanelStore";
import { useToastStore } from "../../state/toastStore";
import { useRepoStore } from "../../state/repoStore";
import { translate } from "../../state/languageStore";
import { editResults } from "./renameFlow";

/**
 * Moving a file in the explorer without breaking the files that import it.
 *
 * # What was broken
 *
 * A rename or a drag in the tree moved the file and re-pointed its tab, and that was all: every
 * `import … from "./user"` that named it now named nothing, and the first anyone heard of it was the
 * build. The servers that could have said so were running the whole time — tsserver has answered
 * `getEditsForFileRename` since TypeScript 2.9, and LSP's `workspace/willRenameFiles` is the same
 * question for every other language (rust-analyzer rewrites the `mod` line that names a module).
 *
 * # Asked before, applied after
 *
 * The question is asked **before** anything moves, which is the one moment both answers are sure to
 * be right: every importer still resolves to the file where it is, so the server's picture of the
 * project is the true one. (LSP puts `willRename` there for the same reason. Asked after, tsserver
 * would be answering mid-way through noticing the file vanish, and what it can find then depends on
 * how far its watcher got.) The cost is that the move waits on the answer — a fraction of a second on
 * a warm server — and a server that takes longer than `PLAN_TIMEOUT_MS` is gone around, with a toast
 * saying so, rather than holding the explorer hostage.
 *
 * Then the move, exactly as before. Then the edits, in a fixed order (`finishMoves`):
 *
 * 1. **Open tabs, under the paths they still have.** A moved file that is open in a tab keeps its tab
 *    under the old path until the editor re-points it, and its buffer — which may hold unsaved work,
 *    and is what the server answered about — is where its own new imports belong. Synchronously
 *    (`applyToOpenTabs`), so nothing can re-point the tab first.
 * 2. **The tabs re-pointed** (`repoint`, the editor's `onPathMoved`) — carrying the buffers just edited.
 * 3. **Every other file on disk**, through the checked write after a restore point, at the path it has
 *    *now*: a file inside a moved folder is written where it went.
 *
 * Each move's edits are kept apart until it has landed: a move the backend refused takes its own
 * edits with it, since they describe imports of a path that never came to exist.
 *
 * # When nothing imported it
 *
 * Nothing is said. Most renames touch no import, and a toast per rename saying so would be noise.
 */

/** How long a move waits on the servers' answer before going ahead without it. A warm tsserver
 *  answers in well under a second; this is for a cold one still loading a large project. */
const PLAN_TIMEOUT_MS = 8_000;

const NOTHING: EditPlan = { files: [], outside: [], unsupported: 0 };

/** What the servers said a set of moves would need, asked before any of them happened. */
export interface MovePlan {
  /** Per move, by where it starts — so a move that then fails takes only its own edits with it. */
  byFrom: Map<string, { to: string; plan: EditPlan }>;
  /** The moves no server answered for in time. */
  unanswered: string[];
}

/**
 * Asks tsserver and every language server that wants to know what moving each of `moves` breaks.
 * Call it before moving anything; `finishMoves` applies the answer once the moves are done.
 */
export async function planMoves(repoPath: string, moves: readonly PathRename[]): Promise<MovePlan> {
  const byFrom = new Map<string, { to: string; plan: EditPlan }>();
  const unanswered: string[] = [];
  await Promise.all(
    moves.map(async (move) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PLAN_TIMEOUT_MS);
      });
      const asked = Promise.all([fromTsserver(repoPath, move), fromLanguageServers(repoPath, move)]).then(mergePlans);
      const plan = await Promise.race([asked, late]);
      clearTimeout(timer);
      if (plan) byFrom.set(move.from, { to: move.to, plan });
      else unanswered.push(move.from);
    }),
  );
  return { byFrom, unanswered };
}

/**
 * tsserver's answer for one move — the importers of a moved file or folder, and the moved file's own
 * relative imports when it changes folder.
 *
 * Only for script files and folders: tsserver resolves imports of scripts, and an import of a
 * stylesheet or an image is not something it rewrites. A file it has not been handed — no tab open
 * on it — is handed over for the question and taken back after, so the project it belongs to is the
 * one asked about (in a monorepo, the package whose files import it may not be loaded otherwise).
 */
async function fromTsserver(repoPath: string, move: PathRename): Promise<EditPlan> {
  const served = tsServedProject();
  if (!tsIsRunning() || served?.repoPath !== repoPath) return NOTHING;
  const kind = move.isDir ? null : scriptKind(move.from);
  if (!move.isDir && !kind) return NOTHING;
  const oldFilePath = tsAbsolute(repoPath, move.from);
  const newFilePath = tsAbsolute(repoPath, move.to);
  // Not one a floating editor holds: that window's own sync has it open in the same server, and an
  // `open` and `close` from here would take it out from under it.
  const borrowed = kind !== null && !tsOpenFiles.has(oldFilePath) && !islandPaths(served.projectId).has(move.from);
  if (borrowed) await tsNotify("open", { file: oldFilePath, scriptKindName: kind }).catch(() => undefined);
  try {
    const edits = await tsRequest<TsFileEdits[]>("getEditsForFileRename", { oldFilePath, newFilePath });
    return planTsFileEdits(edits ?? [], tsRelPath);
  } catch {
    return NOTHING;
  } finally {
    // Unless a tab opened it meanwhile, in which case the document sync owns it now.
    if (borrowed && !tsOpenFiles.has(oldFilePath)) void tsNotify("close", { file: oldFilePath }).catch(() => undefined);
  }
}

/** Every language server's answer for one move — `workspace/willRenameFiles`, asked of the servers
 *  that declared an interest in a path like it (`lib/lsp/fileOperations`). */
async function fromLanguageServers(repoPath: string, move: PathRename): Promise<EditPlan> {
  if (currentRepoPath() !== repoPath) return NOTHING;
  const answers = await willRenameFiles([move]);
  return mergePlans(answers.map((edit) => planLspEdit(edit, (uri) => relPathFromFileUri(repoPath, uri))));
}

/** Where `path` is after `moves` — itself, when none of them took it along. */
function movedPath(path: string, moves: readonly PathRename[]): string {
  for (const move of moves) {
    if (path === move.from) return move.to;
    if (path.startsWith(`${move.from}/`)) return `${move.to}${path.slice(move.from.length)}`;
  }
  return path;
}

/**
 * After the moves: re-points the editor's tabs (`repoint`, for every move, whether or not anything
 * imported it — this replaces the explorer's own call) with the imports applied around it in the
 * order the header gives. Returns as soon as the tabs are re-pointed; the files on disk follow, and
 * report when they are done.
 *
 * `moved` is what actually moved, with where it landed. A move whose destination is not the one it
 * was planned for has its edits dropped: they were written for the other path.
 */
export function finishMoves(
  repoPath: string,
  planned: MovePlan,
  moved: readonly PathRename[],
  repoint?: (from: string, to: string) => void,
): void {
  const plan = mergePlans(
    moved.flatMap((move) => {
      const entry = planned.byFrom.get(move.from);
      return entry && entry.to === move.to ? [entry.plan] : [];
    }),
  );
  const deps = defaultApplyDeps(repoPath);
  // Decided before anything changes: after the re-pointing below, the editor's idea of which paths
  // are open is on its way from one set of names to the other.
  const forDisk = plan.files.filter((file) => !deps.host?.isOpen(file.path));
  const inBuffers = applyToOpenTabs(plan, deps);
  for (const move of moved) repoint?.(move.from, move.to);
  if (moved.length > 0) didRenameFiles(moved);
  // Only the moves that happened: one the backend refused broke nothing, answered or not.
  const unanswered = planned.unanswered.filter((from) => moved.some((move) => move.from === from));
  void applyEditPlan(remapPlan({ ...plan, files: forDisk }, (path) => movedPath(path, moved)), deps).then((onDisk) =>
    report(plan, mergeOutcomes(inBuffers, onDisk), moved, unanswered),
  );
}

/** The last segment of a repo-relative path. */
const nameOf = (path: string) => path.split("/").pop() ?? path;

/** Says what the imports came to — the same toast and panel a rename gets (`renameFlow`), and
 *  nothing at all when no file imported what moved. */
function report(plan: EditPlan, outcome: ApplyOutcome, moved: readonly PathRename[], unanswered: readonly string[]) {
  const toast = useToastStore.getState().pushToast;
  for (const from of unanswered) toast(translate("editor.importsTimedOut", { name: nameOf(from) }), "error");
  const troubled = outcome.conflicts.length > 0 || outcome.failed.length > 0;
  if (outcome.changes === 0 && !troubled) return;
  const summary = translate("editor.renameSummary", { changes: outcome.changes, files: outcome.applied.length });
  const names = moved.map((move) => nameOf(move.to));
  const name = names.length > 2 ? `${names.slice(0, 2).join(", ")}…` : names.join(", ");
  if (outcome.applied.length > 1 || troubled) {
    useEditorPanelStore
      .getState()
      .showResults(
        editResults(plan, outcome, translate("editor.importsTitle", { name, summary }), (path) =>
          translate("editor.importsConflict", { path }),
        ),
      );
  }
  const message = translate("editor.importsUpdated", { summary });
  toast(troubled ? `${message} · ${translate("editor.renameIncomplete")}` : message, troubled ? "error" : "success");
  // The Changes panel and the tree read git status, which knows nothing of a write it did not see.
  if (outcome.applied.some((file) => !file.inBuffer)) void useRepoStore.getState().refreshStatus();
}
