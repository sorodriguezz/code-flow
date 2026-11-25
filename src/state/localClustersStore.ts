import { create } from "zustand";
import { containersLocalClusters, containersLocalTools } from "../lib/tauri/containersLocalCommands";
import { useContainersJobsStore, type ContainerJob } from "./containersJobsStore";
import { useContainersStore } from "./containersStore";
import { localContextOf } from "../components/containers/localModel";
import type { LocalAction, LocalClusterSpec, LocalClusters, LocalTools } from "../types/containersLocal";

/**
 * The clusters kind, k3d and minikube run on this computer, and which of those tools (and Helm) are
 * installed — read when a page that shows them opens, and again whenever one of their jobs ends.
 *
 * Making, starting, stopping and deleting one is a job of the manager's (`containersJobsStore`): a
 * `localCluster` session whose output stays on screen however long it takes. What happens when it
 * ends is decided here, from the job's own data — the store follows the jobs, it is not handed a
 * callback by the page that started one (that page may be gone by then): the contexts are read
 * again (the tool wrote or removed one in the user's kubeconfig), the list too, and a cluster just
 * created becomes the one the Kubernetes pages show.
 */

interface LocalClustersState {
  tools: LocalTools | null;
  list: LocalClusters | null;
  loading: boolean;
  /** Reads the tools (once) and the clusters. */
  load: (opts?: { tools?: boolean }) => Promise<void>;
  /** Starts the job that does `spec`; its key. */
  run: (title: string, spec: LocalClusterSpec) => Promise<number>;
}

export const useLocalClustersStore = create<LocalClustersState>((set, get) => ({
  tools: null,
  list: null,
  loading: false,

  load: async (opts = {}) => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const tools = get().tools === null || opts.tools ? await containersLocalTools().catch(() => null) : get().tools;
      const list = tools && (tools.kind || tools.k3d || tools.minikube) ? await containersLocalClusters().catch((e) => ({ clusters: [], errors: [String(e)] })) : { clusters: [], errors: [] };
      set({ tools, list });
    } finally {
      set({ loading: false });
    }
  },

  run: (title, spec) =>
    useContainersJobsStore.getState().start(
      title,
      { kind: "localCluster", runtime: spec.tool, context: null, target: spec.name, localCluster: spec },
      { meta: { tool: spec.tool, action: spec.action, name: spec.name, context: localContextOf(spec.tool, spec.name) } },
    ),
}));

/** What a finished local-cluster job leaves to do. */
async function afterJob(job: ContainerJob) {
  const containers = useContainersStore.getState();
  await containers.detect();
  void useLocalClustersStore.getState().load();
  const action = job.options.meta?.action as LocalAction | undefined;
  const context = job.options.meta?.context;
  if (job.code === 0 && action === "create" && context) {
    const kube = useContainersStore.getState().runtimes.find((r) => r.id === "kubernetes");
    if (kube?.contexts.some((c) => c.name === context)) {
      useContainersStore.getState().setContext("kubernetes", context);
      useContainersStore.getState().setNav({ runtime: "kubernetes", section: "overview" });
    }
  }
}

const handled = new Set<number>();
useContainersJobsStore.subscribe((state) => {
  for (const job of state.jobs) {
    if (!job.ended || job.request.kind !== "localCluster" || handled.has(job.key)) continue;
    handled.add(job.key);
    void afterJob(job);
  }
});
