import { useEffect, useState } from "react";
import { Route } from "lucide-react";
import { pipelineAvailability } from "../../lib/tauri/commands";
import { selectedDetail, selectedDetailBusy, selectedDetailError, useCiStore } from "../../state/ciStore";
import { useT } from "../../state/languageStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { JobLogPane } from "./JobLogPane";
import { RunActions } from "./RunActions";
import { RunGraph } from "./RunGraph";
import { RunList } from "./RunList";
import type { PipelineAvailability, PipelineRun } from "../../types/domain";

/**
 * One shared empty array, not a fresh `[]` per read.
 *
 * A selector that builds a new object every time it runs is an infinite render loop under
 * zustand 5 + React 19: `useSyncExternalStore` re-runs the selector after every commit and
 * compares with `Object.is`, so a literal `[]` is "changed" forever. The repo already knows —
 * see `EMPTY_PRS` in `Sidebar.tsx`, whose comment describes exactly this — and the states that
 * never recover on their own are the ones that matter: a project whose fetch failed keeps
 * `runsByProject[id]` undefined permanently.
 */
const EMPTY_RUNS: PipelineRun[] = [];

/**
 * The Pipelines tab.
 *
 * Two columns, and the right one split in half horizontally — which is the whole layout argument
 * of this screen. Jobs cannot live in a narrow middle column: four jobs that ran simultaneously,
 * stacked in a 250px list, read as four steps in sequence, and that is precisely the thing this
 * screen exists to stop implying. So the run's structure gets the full width above, and the log
 * gets it below.
 *
 * The tab only exists while the repository is linked to a connected host — see `TabBar` — but this
 * still checks, because the tab's gate is a cheap re-derivation of `linked_repo`'s precedence in
 * TypeScript and this is the answer from the function that precedence lives in. When they disagree
 * (a project linked while the app was running, a connection removed in Settings), this is the one
 * that is right, and it is the one that can say *why*.
 */
export function PipelinesView() {
  const project = useWorkspaceStore((s) => s.activeProject());
  const activeView = useUiStore((s) => s.activeView);
  const branch = useRepoStore((s) => s.status?.current_branch ?? null);
  const listWidth = useLayoutStore((s) => s.sizes.pipelinesListWidth);
  const graphHeight = useLayoutStore((s) => s.sizes.pipelinesGraphHeight);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const projectId = project?.id ?? null;

  const load = useCiStore((s) => s.load);
  const watch = useCiStore((s) => s.watch);
  const fetched = useCiStore((s) => (projectId ? s.fetchedProjects[projectId] === true : false));
  const error = useCiStore((s) => (projectId ? (s.errorByProject[projectId] ?? "") : ""));
  const runs = useCiStore((s) => (projectId ? (s.runsByProject[projectId] ?? EMPTY_RUNS) : EMPTY_RUNS));
  const rawDetail = useCiStore(selectedDetail);
  const rawDetailBusy = useCiStore(selectedDetailBusy);
  const rawDetailError = useCiStore(selectedDetailError);
  const selection = useCiStore((s) => s.selection);
  const t = useT();

  // The selection is global to the store and survives a repository switch — deliberately, so that
  // coming back to a repo finds it where you left it. What must *not* survive is showing it: until
  // the new repository's own run is picked, the graph and the log below would still be the previous
  // repo's. Derived during render rather than cleared in an effect, because a child's effects run
  // before the parent's — `useWorkflowNeeds` would already have read a workflow file for the wrong
  // run and cached it under the wrong key.
  const mine = selection?.projectId === projectId;
  const detail = mine ? rawDetail : undefined;
  // Only "loading" for a run of *this* repository, on the same reasoning as `detail` above: the
  // selection outlives a repository switch, and a spinner for the previous repo's run would be a
  // promise this pane has no intention of keeping.
  const detailBusy = mine && rawDetailBusy;
  const detailError = mine ? rawDetailError : "";

  const [availability, setAvailability] = useState<PipelineAvailability | null>(null);
  // One clock for the whole pane, refreshed on each poll rather than on a ticker of its own: the
  // elapsed time of a running job only has to be as fresh as the data behind it.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void pipelineAvailability(projectId)
      .then((result) => {
        if (!cancelled) setAvailability(result);
      })
      .catch(() => {
        if (!cancelled) setAvailability(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // The first load happens on arrival rather than on mount, because this view is never unmounted
  // once visited (`App.tsx` hides it instead) — an effect keyed only on the project would never
  // run again after the first visit.
  useEffect(() => {
    if (activeView !== "pipelines" || !projectId || fetched) return;
    void load(projectId);
  }, [activeView, projectId, fetched, load]);

  // Started on the first visit and never stopped, because leaving the tab is exactly when the poll
  // earns its keep: it is what notices a run finishing and files the notification. `watch` decides
  // for itself how much to do while the tab is off screen — see the note in `ciStore.watch`.
  useEffect(() => watch(), [watch]);

  useEffect(() => {
    setNow(Date.now());
  }, [runs, detail]);

  if (!project) return null;

  if (availability && availability.provider !== null && !availability.connected) {
    return (
      <EmptyState
        icon={Route}
        title={t("pipelines.notConnectedTitle")}
        subtitle={t("pipelines.notConnectedBody", { host: availability.host ?? "" })}
      />
    );
  }

  const job = detail?.jobs.find((candidate) => candidate.id === selection?.jobId);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-bg)]">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          data-tour="pipelines-list"
          style={{ width: listWidth }}
          className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-[var(--cf-surface)]"
        >
          <RunList projectId={project.id} currentBranch={branch} />
        </div>

        <ResizeHandle
          axis="x"
          value={listWidth}
          min={220}
          max={460}
          onChange={(value) => setSize("pipelinesListWidth", value)}
          onCommit={(value) => commitSize("pipelinesListWidth", value)}
        />

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--cf-surface)]">
          {fetched && runs.length === 0 && !error ? (
            <EmptyState
              icon={Route}
              title={t("pipelines.emptyTitle")}
              subtitle={t("pipelines.emptyBody")}
            />
          ) : error && runs.length === 0 ? (
            <EmptyState icon={Route} title={t("pipelines.errorTitle")} subtitle={error} />
          ) : (
            <>
              {/* Above the waterfall rather than inside it: the verbs act on the *run*, and the
                  graph is one of three things showing it. */}
              {detail?.run && (
                <div data-tour="pipelines-actions">
                  <RunActions projectId={project.id} run={detail.run} />
                </div>
              )}

              <div
                data-tour="pipelines-graph"
                style={{ height: graphHeight }}
                className="flex shrink-0 flex-col overflow-hidden border-b border-[var(--cf-border)]"
              >
                <RunGraph
                  projectId={project.id}
                  localPath={project.local_path}
                  detail={detail}
                  loading={detailBusy}
                  error={detailError}
                  now={now}
                />
              </div>

              <ResizeHandle
                axis="y"
                value={graphHeight}
                min={140}
                max={520}
                onChange={(value) => setSize("pipelinesGraphHeight", value)}
                onCommit={(value) => commitSize("pipelinesGraphHeight", value)}
              />

              <div data-tour="pipelines-log" className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {/* `loading` covers the gap the log pane cannot see out of: until the run's detail
                    lands there are no jobs, so `job` is undefined and the pane would say "pick a
                    job" about a run that is still being fetched. */}
                <JobLogPane job={job} loading={detailBusy && job === undefined} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
