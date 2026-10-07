import { useEffect, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { ContainersNav, useNav } from "./ContainersNav";
import { ContainersPage } from "./ContainersPage";
import { ContainersDetail } from "./ContainersDetail";
import { KubeKindPage, KubeOverviewPage } from "./KubePage";
import { KubeAddCluster } from "./KubeAddCluster";
import { AddEngineDialog } from "./AddEngineDialog";
import { OverviewPage } from "./OverviewPage";
import { ImagesPage } from "./ImagesPage";
import { VolumesPage } from "./VolumesPage";
import { NetworksPage } from "./NetworksPage";
import { ComposePage } from "./ComposePage";
import { BuildPage } from "./BuildPage";
import { JobsPanel } from "./JobsPanel";
import { StateDot, useInterval } from "./containerBits";
import { EmptyLine } from "./ui";
import { listKey, useContainersStore } from "../../state/containersStore";
import { useT } from "../../state/languageStore";
import type { ContainerRow } from "../../types/containers";

/**
 * The Contenedores panel of the bottom dock — Docker, Podman, containerd and Kubernetes, found on
 * this computer and operated through their own tools (see `src-tauri/src/containers`).
 *
 * A manager in lite-dock's shape: the list column is the navigation (each runtime and what it holds,
 * see `ContainersNav`), and the pane beside it is the page picked there — a table to act on, with a
 * row's detail page opening over it and a back arrow to return. IntelliJ's Services view is still the
 * principle: nothing is registered by hand, what exists is shown.
 */

/** Reads the lists while the panel is on screen; nothing while it is not. */
export function useContainersPulse(visible: boolean) {
  const loadPrefs = useContainersStore((s) => s.loadPrefs);
  const detect = useContainersStore((s) => s.detect);
  const pulse = useContainersStore((s) => s.pulse);
  const loadForwards = useContainersStore((s) => s.loadForwards);
  const detected = useContainersStore((s) => s.detected);
  useEffect(() => {
    if (!visible) return;
    void (async () => {
      await loadPrefs();
      if (!useContainersStore.getState().detected) await detect();
      await pulse();
      void loadForwards();
    })();
  }, [visible, loadPrefs, detect, pulse, loadForwards]);
  // The lists every few seconds; the runtimes themselves (one started, one stopped) less often.
  useInterval(() => void pulse(), 4000, visible && detected);
  useInterval(() => void detect(), 30000, visible && detected);
  useInterval(() => void loadForwards(), 5000, visible && detected);
}

/** The panel's title-row summary: how many containers run across the engines. */
export function ContainersSummary() {
  const t = useT();
  const runtimes = useContainersStore((s) => s.runtimes);
  const lists = useContainersStore((s) => s.lists);
  const contextOf = useContainersStore((s) => s.contextOf);
  let running = 0;
  let unhealthy = 0;
  for (const runtime of runtimes) {
    if (runtime.id === "kubernetes" || !runtime.running) continue;
    const rows = (lists[listKey(runtime.id, contextOf(runtime.id), null, "containers")]?.rows ?? []) as ContainerRow[];
    running += rows.filter((r) => r.state === "running").length;
    unhealthy += rows.filter((r) => r.health === "unhealthy").length;
  }
  if (running === 0 && unhealthy === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-2.5 overflow-hidden whitespace-nowrap text-[11px] text-[var(--cf-text-muted)]">
      {running > 0 && (
        <span className="flex items-center gap-1">
          <StateDot tone="ok" />
          {running === 1 ? t("containers.summaryOne") : t("containers.summary", { count: running })}
        </span>
      )}
      {unhealthy > 0 && (
        <span className="flex items-center gap-1 text-[var(--cf-danger)]">
          <StateDot tone="bad" />
          {t("containers.summaryUnhealthy", { count: unhealthy })}
        </span>
      )}
    </span>
  );
}

export function projectOptions(rows: ContainerRow[]) {
  const first = rows.find((r) => r.projectDir || r.configFiles);
  return { projectDir: first?.projectDir ?? "", configFiles: first?.configFiles ?? "" };
}

/** The navigation, in the dock's list column. */
export function ContainersList() {
  const setDialog = useContainersStore((s) => s.setDialog);
  return <ContainersNav onAddCluster={() => setDialog("cluster")} onAddEngine={() => setDialog("engine")} />;
}

/** The page picked in the navigation — or, over it, the detail of a row picked on that page. */
export function ContainersPane() {
  const t = useT();
  const detected = useContainersStore((s) => s.detected);
  const runtimes = useContainersStore((s) => s.runtimes);
  const selection = useContainersStore((s) => s.selection);
  const dialog = useContainersStore((s) => s.dialog);
  const setDialog = useContainersStore((s) => s.setDialog);
  const detect = useContainersStore((s) => s.detect);
  const setContext = useContainersStore((s) => s.setContext);
  const setNav = useContainersStore((s) => s.setNav);
  const kubeContext = useContainersStore((s) => s.contextOf("kubernetes"));
  const nav = useNav();
  const runtime = runtimes.find((r) => r.id === nav.runtime);
  let page: ReactNode;
  if (!detected) {
    page = (
      <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
        <Loader2 size={13} className="animate-spin" />
        {t("containers.detecting")}
      </div>
    );
  } else if (!runtime) {
    page = <EmptyLine>{t("containers.noRuntimes")}</EmptyLine>;
  } else if (selection && selection.runtime === runtime.id) {
    page = <ContainersDetail selection={selection} />;
  } else if (runtime.id === "kubernetes") {
    // Disconnected, a kind's page has no cluster to read: the clusters' page is where one is picked.
    page =
      nav.section === "overview" || !kubeContext ? <KubeOverviewPage runtime={runtime} onAddCluster={() => setDialog("cluster")} /> : <KubeKindPage kind={nav.section} />;
  } else {
    page = <EnginePage section={nav.section} runtimeId={runtime.id} />;
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {page}
      <JobsPanel />
      {dialog === "engine" && <AddEngineDialog onClose={() => setDialog(null)} />}
      {dialog === "cluster" && (
        <KubeAddCluster
          onClose={() => setDialog(null)}
          onAdded={(added) => {
            // The cluster just added is the one the user wants to look at: read the contexts again,
            // then open it. The dialog stays up for its warnings and its test.
            void detect().then(() => {
              const first = added.contexts[0];
              if (!first) return;
              setContext("kubernetes", first);
              setNav({ runtime: "kubernetes", section: "overview" });
            });
          }}
        />
      )}
    </div>
  );
}

/** One section of an engine. */
function EnginePage({ section, runtimeId }: { section: string; runtimeId: string }) {
  const runtime = useContainersStore((s) => s.runtimes.find((r) => r.id === runtimeId));
  if (!runtime) return null;
  switch (section) {
    case "overview":
      return <OverviewPage runtime={runtime} />;
    case "images":
      return <ImagesPage runtime={runtime} />;
    case "volumes":
      return <VolumesPage runtime={runtime} />;
    case "networks":
      return <NetworksPage runtime={runtime} />;
    case "compose":
      return <ComposePage runtime={runtime} />;
    case "build":
      return <BuildPage runtime={runtime} />;
    default:
      return <ContainersPage runtime={runtime} />;
  }
}
