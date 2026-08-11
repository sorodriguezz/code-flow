import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, History, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import {
  aiCheckpointChangedPaths,
  deleteAiCheckpoint,
  listAiCheckpoints,
  restoreAiCheckpoint,
  type AiCheckpoint,
} from "../../lib/tauri/commands";
import { useRepoStore } from "../../state/repoStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { EmptyState } from "../common/EmptyState";

/** Maps the backend's stable action keys onto translated labels. An unknown key (an older
 * checkpoint, a kind added later) falls back to showing the raw key rather than nothing. */
const KIND_LABELS: Record<string, TranslationKey> = {
  chat: "checkpoints.kindChat",
  "fix-finding": "checkpoints.kindFix",
  "replace-all": "checkpoints.kindReplace",
};

/** The undo list: every snapshot taken before something was allowed to rewrite the working tree
 * — an AI run, a project-wide replace — with the files it would put back, one chevron away.
 * Snapshots that would restore nothing are dropped by the backend, so everything listed here is
 * a real, reversible change.
 *
 * The file lists used to be rendered inline for every row, which meant the modal could not open
 * without one full working-tree walk per checkpoint (twenty rows, twenty walks). They are folded
 * and fetched per row now — see `loadPaths` — and the restore confirmation does its own walk so
 * it can still tell the user exactly how many files it is about to overwrite. */
export function CheckpointsModal({ repoPath, onClose }: { repoPath: string; onClose: () => void }) {
  const t = useT();
  const [checkpoints, setCheckpoints] = useState<AiCheckpoint[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Rows the user has unfolded. Folding is not just visual here — see `loadPaths`. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  /** Path lists we fetched per row, and the rows whose fetch is still in the air. */
  const [paths, setPaths] = useState<Record<string, string[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(() => new Set());
  // Mirrors of the two above, so `reload`/`loadPaths` can read the current values without
  // taking them as deps and re-creating themselves on every fold, fetch and keystroke.
  const pathsRef = useRef<Record<string, string[]>>({});
  const expandedRef = useRef(expanded);
  /** Fetch per row that hasn't settled yet — a double-click on the chevron must not walk twice. */
  const inFlight = useRef(new Map<string, Promise<string[]>>());
  // Bumped whenever the cache is invalidated. A walk started before a restore answers about the
  // tree as it was, so its result must not land in the cache that describes the tree as it is.
  const cacheGen = useRef(0);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  /**
   * The changed paths for one row, cached.
   *
   * Why this isn't done for every row up front: each list costs a full working-tree walk with
   * recursive untracked on the backend, so pre-filling twenty rows is twenty walks just to open
   * a modal — exactly the cost this lazy fetch exists to avoid. Prefetching "just the visible
   * ones" would bring the same bill back. Only ask for what the user actually opened.
   */
  const loadPaths = useCallback(
    (id: string): Promise<string[]> => {
      const cached = pathsRef.current[id];
      if (cached) return Promise.resolve(cached);
      const running = inFlight.current.get(id);
      if (running) return running;

      const gen = cacheGen.current;
      const request = aiCheckpointChangedPaths(repoPath, id)
        .then((list) => {
          if (cacheGen.current === gen) {
            pathsRef.current = { ...pathsRef.current, [id]: list };
            setPaths(pathsRef.current);
          }
          return list;
        })
        .finally(() => {
          // Same guard: after an invalidation this row may already have a *newer* walk running,
          // and a stale one settling must not unregister it or stop its spinner. `reload` wiped
          // both maps, so there is nothing of ours left to clean up in that case.
          if (cacheGen.current !== gen) return;
          inFlight.current.delete(id);
          setLoadingPaths((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        });

      inFlight.current.set(id, request);
      setLoadingPaths((prev) => new Set(prev).add(id));
      return request;
    },
    [repoPath],
  );

  const reload = useCallback(async () => {
    const list = await listAiCheckpoints(repoPath).catch(() => []);
    setCheckpoints(list);

    // A restore rewrites the working tree, so every path list we cached describes a state that
    // no longer exists. Drop the cache wholesale rather than trying to guess which rows moved.
    cacheGen.current += 1;
    pathsRef.current = {};
    setPaths({});
    inFlight.current.clear();
    setLoadingPaths((prev) => (prev.size === 0 ? prev : new Set()));

    const alive = new Set(list.map((c) => c.id));
    setExpanded((prev) => {
      const kept = [...prev].filter((id) => alive.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
    // Rows the user still has open have to show something true again. Rows the backend already
    // answered for (it still fills `changed_paths` today) need no walk at all; the rest cost one
    // walk each — and only for what is literally on screen and unfolded.
    for (const checkpoint of list) {
      if (!expandedRef.current.has(checkpoint.id)) continue;
      if (Array.isArray(checkpoint.changed_paths)) continue;
      void loadPaths(checkpoint.id).catch(() => {});
    }
  }, [repoPath, loadPaths]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = (checkpoint: AiCheckpoint) => {
    const id = checkpoint.id;
    const opening = !expandedRef.current.has(id);
    // Built out here, not inside the updater: the updater has to stay pure (StrictMode calls it
    // twice) and `reload` reads the ref, so it must be current before the render commits.
    const next = new Set(expandedRef.current);
    if (opening) next.add(id);
    else next.delete(id);
    expandedRef.current = next;
    setExpanded(next);
    // Nothing to fetch when we already have a list: either from an earlier expand, or straight
    // off the list row while the backend keeps filling `changed_paths`. Re-asking would pay for
    // a walk to learn what we were just told.
    if (!opening) return;
    if (pathsRef.current[id] || Array.isArray(checkpoint.changed_paths)) return;
    void loadPaths(id).catch((e) => pushErrorToast(String(e)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const restore = async (checkpoint: AiCheckpoint) => {
    // The confirmation states how many files are about to be overwritten, and that number is
    // only knowable by walking the tree. So the walk happens here, on the click, instead of
    // being paid for every row at mount — the count is also *fresher* this way than the one the
    // list produced. The row spins while it resolves; that is why busyId is set before the ask.
    setBusyId(checkpoint.id);
    let changed: string[];
    try {
      changed = await loadPaths(checkpoint.id);
    } catch (e) {
      // Couldn't walk. Fall back to whatever the list row carried (today's behaviour, byte for
      // byte); with a backend that no longer sends it there is no honest count to show, and a
      // tree we can't even walk is not one we can restore into — so say so and stop.
      const listed = Array.isArray(checkpoint.changed_paths) ? checkpoint.changed_paths : null;
      if (!listed) {
        pushErrorToast(String(e));
        setBusyId(null);
        return;
      }
      changed = listed;
    }
    const ok = await confirmAction(t("checkpoints.confirmRestore", { n: changed.length }), true);
    if (!ok) {
      setBusyId(null);
      return;
    }
    try {
      const restored = await restoreAiCheckpoint(repoPath, checkpoint.id);
      useToastStore.getState().pushToast(t("checkpoints.restored", { n: restored.length }), "success");
      // The files changed on disk; the working diff and status the rest of the app shows are
      // now stale until they're re-read.
      void useRepoStore.getState().refreshAll();
      await reload();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (checkpoint: AiCheckpoint) => {
    setBusyId(checkpoint.id);
    try {
      await deleteAiCheckpoint(repoPath, checkpoint.id);
      await reload();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2.5">
          <History size={14} className="text-[var(--cf-accent)]" />
          <h2 className="text-[13px] font-semibold">{t("checkpoints.title")}</h2>
          <button onClick={onClose} className="ml-auto text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {checkpoints === null ? (
            <div className="flex justify-center py-8">
              <Loader2 size={16} className="animate-spin text-[var(--cf-text-muted)]" />
            </div>
          ) : checkpoints.length === 0 ? (
            <EmptyState icon={History} title={t("checkpoints.empty")} subtitle={t("checkpoints.emptyHint")} />
          ) : (
            <div className="space-y-2">
              {checkpoints.map((checkpoint) => {
                const kindKey = KIND_LABELS[checkpoint.kind];
                // What we know about this row's files right now. A fetched list wins over the
                // one the list command sent, because the fetched one is newer. `changed_paths`
                // is still read whenever it's there — this has to work with a backend that
                // sends it and with one that stops.
                const listed = Array.isArray(checkpoint.changed_paths)
                  ? checkpoint.changed_paths
                  : undefined;
                const changed = paths[checkpoint.id] ?? listed;
                const open = expanded.has(checkpoint.id);
                const loading = loadingPaths.has(checkpoint.id);
                return (
                  <div
                    key={checkpoint.id}
                    className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium">{kindKey ? t(kindKey) : checkpoint.kind}</span>
                      <span className="text-[11px] text-[var(--cf-text-muted)]">
                        {new Date(checkpoint.created_at * 1000).toLocaleString()}
                      </span>
                      <button
                        onClick={() => void restore(checkpoint)}
                        disabled={busyId !== null}
                        className="ml-auto flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-0.5 text-[11px] hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.04]"
                      >
                        {busyId === checkpoint.id ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <RotateCcw size={11} />
                        )}
                        {t("checkpoints.restore")}
                      </button>
                      <button
                        onClick={() => void remove(checkpoint)}
                        disabled={busyId !== null}
                        title={t("checkpoints.forget")}
                        className="text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)] disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    {/* The file list is one disclosure away instead of always on screen — the
                        same chevron idiom as CollapsibleSection. Nothing is hidden for good:
                        unfolding shows exactly the files this checkpoint would put back. */}
                    <button
                      onClick={() => toggle(checkpoint)}
                      aria-expanded={open}
                      className="mt-1.5 flex items-center gap-1 text-[10px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                    >
                      {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      {changed ? t("checkpoints.filesCount", { n: changed.length }) : t("checkpoints.files")}
                      {loading && <Loader2 size={10} className="animate-spin" />}
                    </button>
                    {open && changed && (
                      <ul className="mt-1 space-y-0.5">
                        {changed.slice(0, 6).map((path) => (
                          <li key={path} className="truncate font-mono text-[10px] text-[var(--cf-text-muted)]">
                            {path}
                          </li>
                        ))}
                        {changed.length > 6 && (
                          <li className="text-[10px] text-[var(--cf-text-muted)]">
                            {t("checkpoints.andMore", { n: changed.length - 6 })}
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
