import { useEffect, useMemo, type ReactNode } from "react";
import {
  Blocks,
  Boxes,
  Box,
  Hammer,
  HardDrive,
  Layers,
  LayoutDashboard,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { Select } from "../common/Select";
import { rowClass, sectionLabelClass } from "../common/recipes";
import { RowAction, RuntimeGlyph, StateDot } from "./containerBits";
import { runtimeLabel } from "./containerActions";
import { firstRead } from "./pageModel";
import { disconnectCluster } from "./KubePage";
import { listKey, useContainersStore, type EngineSection } from "../../state/containersStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ContainerRow, RuntimeInfo } from "../../types/containers";

/**
 * The manager's left column: every runtime this computer has, and under it what it holds — an
 * engine's containers, images, volumes, networks, Compose projects and builds; a cluster's kinds.
 * One click opens the section as a page beside it (lite-dock's sidebar), where the tree this
 * replaced made every list a fold of the one before.
 */

const ENGINE_SECTIONS: { id: EngineSection; icon: LucideIcon; label: TranslationKey }[] = [
  { id: "overview", icon: LayoutDashboard, label: "containers.m.section.overview" },
  { id: "containers", icon: Box, label: "containers.section.containers" },
  { id: "images", icon: Layers, label: "containers.section.images" },
  { id: "volumes", icon: HardDrive, label: "containers.section.volumes" },
  { id: "networks", icon: Network, label: "containers.section.networks" },
  { id: "compose", icon: Blocks, label: "containers.m.section.compose" },
  { id: "build", icon: Hammer, label: "containers.m.section.build" },
];

/** The kinds, in the groups `kubectl api-resources` would put them in. */
const KUBE_GROUPS: { label: TranslationKey; kinds: string[] }[] = [
  { label: "containers.m.kube.workloads", kinds: ["pods", "deployments", "statefulsets", "daemonsets", "jobs", "cronjobs"] },
  { label: "containers.m.kube.network", kinds: ["services", "ingresses"] },
  { label: "containers.m.kube.config", kinds: ["configmaps", "secrets", "persistentvolumeclaims"] },
  { label: "containers.m.kube.cluster", kinds: ["nodes", "namespaces", "events"] },
];

export function ContainersNav({ onAddCluster, onAddEngine }: { onAddCluster: () => void; onAddEngine: () => void }) {
  const t = useT();
  const runtimes = useContainersStore((s) => s.runtimes);
  const detected = useContainersStore((s) => s.detected);
  const detecting = useContainersStore((s) => s.detecting);
  const detect = useContainersStore((s) => s.detect);
  const pulse = useContainersStore((s) => s.pulse);
  const hasKube = runtimes.some((r) => r.id === "kubernetes");
  /** Everything read again — the cluster too, whose answer is otherwise kept for a while. */
  const refresh = async () => {
    await detect();
    const store = useContainersStore.getState();
    const cluster = store.runtimes.some((r) => r.id === "kubernetes") ? store.contextOf("kubernetes") : null;
    if (cluster) {
      void store.checkReach(cluster, { force: true });
      void store.loadNamespaces(cluster, { force: true });
    }
    await pulse();
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 px-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text-faint)]">{detecting ? t("containers.detecting") : ""}</span>
        <RowAction label={t("containers.m.addEngine")} onClick={onAddEngine}>
          <Plus size={12} />
        </RowAction>
        <RowAction label={t("containers.refresh")} onClick={() => void refresh()}>
          {detecting ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
        </RowAction>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {!detected && (
          <p className="flex items-center gap-1.5 px-1.5 py-2 text-[11.5px] text-[var(--cf-text-muted)]">
            <Loader2 size={11} className="animate-spin" />
            {t("containers.detecting")}
          </p>
        )}
        {detected && runtimes.length === 0 && <p className="px-1.5 py-2 text-[11.5px] text-[var(--cf-text-muted)]">{t("containers.noRuntimes")}</p>}
        {runtimes.map((runtime) => (runtime.id === "kubernetes" ? <KubeNav key={runtime.id} runtime={runtime} onAddCluster={onAddCluster} /> : <EngineNav key={runtime.id} runtime={runtime} />))}
        {detected && !hasKube && (
          <button onClick={onAddCluster} className={rowClass(false, "mt-2 h-7 text-[12px] text-[var(--cf-text-muted)]")}>
            <Plus size={13} className="shrink-0" />
            {t("containers.m.addCluster")}
          </button>
        )}
      </div>
    </div>
  );
}

/** The page on screen, falling back like the store does when the one remembered is gone. */
export function useNav() {
  const prefsNav = useContainersStore((s) => s.prefs.nav);
  const runtimes = useContainersStore((s) => s.runtimes);
  return useMemo(() => useContainersStore.getState().nav(), [prefsNav, runtimes]); // eslint-disable-line react-hooks/exhaustive-deps
}

function NavRow({ icon: Icon, label, count, selected, onClick, dim }: { icon: LucideIcon; label: string; count?: ReactNode; selected: boolean; onClick: () => void; dim?: boolean }) {
  return (
    <button onClick={onClick} aria-current={selected ? "page" : undefined} className={rowClass(selected, `h-7 pl-6 text-[12.5px] ${dim ? "opacity-60" : ""}`)}>
      <Icon size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count !== null && <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)]">{count}</span>}
    </button>
  );
}

function RuntimeHead({ runtime, selected, onClick, extra }: { runtime: RuntimeInfo; selected: boolean; onClick: () => void; extra?: ReactNode }) {
  const t = useT();
  const startRuntime = useContainersStore((s) => s.startRuntime);
  const starting = useContainersStore((s) => s.starting[runtime.id]);
  return (
    <div className={rowClass(selected, "mt-1.5 h-8 cursor-pointer pr-1")} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onClick()}>
      <RuntimeGlyph id={runtime.id} size={14} />
      <span className="min-w-0 truncate text-[12.5px] font-semibold">{runtimeLabel(runtime.id, t)}</span>
      {runtime.provider && <span className="min-w-0 truncate text-[11px] text-[var(--cf-text-faint)]">{runtime.provider}</span>}
      <span className="flex-1" />
      {extra}
      {runtime.id !== "kubernetes" &&
        (runtime.running ? (
          <StateDot tone="ok" title={t("containers.running")} />
        ) : runtime.start ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void startRuntime(runtime);
            }}
            disabled={starting}
            className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-1.5 text-[11px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:opacity-60"
          >
            {starting && <Loader2 size={10} className="animate-spin" />}
            {starting ? t("containers.startingRuntime") : t("containers.startRuntime")}
          </button>
        ) : (
          <StateDot tone="idle" title={runtime.problem ?? t("containers.notRunningHint")} />
        ))}
    </div>
  );
}

function EngineNav({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const nav = useNav();
  const setNav = useContainersStore((s) => s.setNav);
  const context = useContainersStore((s) => s.contextOf(runtime.id));
  const setContext = useContainersStore((s) => s.setContext);
  const containers = useContainersStore((s) => s.lists[listKey(runtime.id, context, null, "containers")]);
  const images = useContainersStore((s) => s.lists[listKey(runtime.id, context, null, "images")]);
  const volumes = useContainersStore((s) => s.lists[listKey(runtime.id, context, null, "volumes")]);
  const networks = useContainersStore((s) => s.lists[listKey(runtime.id, context, null, "networks")]);
  const here = nav.runtime === runtime.id;
  const counts = useMemo(() => {
    const rows = (containers?.rows ?? []) as ContainerRow[];
    const running = rows.filter((r) => r.state === "running").length;
    const projects = new Set(rows.map((r) => r.project).filter(Boolean)).size;
    return { containers: rows.length ? `${running}/${rows.length}` : "", projects: projects || "" };
  }, [containers]);
  const countOf = (section: EngineSection): ReactNode => {
    if (!runtime.running) return undefined;
    switch (section) {
      case "containers":
        return counts.containers;
      case "images":
        return images?.rows.length || "";
      case "volumes":
        return volumes?.rows.length || "";
      case "networks":
        return networks?.rows.length || "";
      case "compose":
        return counts.projects;
      default:
        return undefined;
    }
  };
  return (
    <div>
      <RuntimeHead runtime={runtime} selected={here && nav.section === "overview"} onClick={() => setNav({ runtime: runtime.id, section: "overview" })} />
      {runtime.contexts.length > 1 && (
        <div className="py-0.5 pl-6 pr-1">
          <Select
            size="sm"
            value={context ?? ""}
            onChange={(next) => setContext(runtime.id, next)}
            options={runtime.contexts.map((c) => ({ value: c.name, label: c.name }))}
            ariaLabel={t("containers.context")}
          />
        </div>
      )}
      {ENGINE_SECTIONS.filter((s) => s.id !== "overview").map((section) => (
        <NavRow
          key={section.id}
          icon={section.icon}
          label={t(section.label)}
          count={countOf(section.id)}
          dim={!runtime.running}
          selected={here && nav.section === section.id}
          onClick={() => setNav({ runtime: runtime.id, section: section.id })}
        />
      ))}
    </div>
  );
}

function KubeNav({ runtime, onAddCluster }: { runtime: RuntimeInfo; onAddCluster: () => void }) {
  const t = useT();
  const nav = useNav();
  const setNav = useContainersStore((s) => s.setNav);
  const context = useContainersStore((s) => s.contextOf("kubernetes"));
  const setContext = useContainersStore((s) => s.setContext);
  const namespace = useContainersStore((s) => s.namespaceOf(context));
  const setNamespace = useContainersStore((s) => s.setNamespace);
  const namespaces = useContainersStore((s) => s.namespaces[context ?? ""]);
  const loadNamespaces = useContainersStore((s) => s.loadNamespaces);
  const reach = useContainersStore((s) => s.reach[context ?? ""]);
  const checkReach = useContainersStore((s) => s.checkReach);
  const activeList = useContainersStore((s) => (nav.runtime === "kubernetes" ? s.lists[listKey("kubernetes", context, s.namespaceOf(context), nav.section)] : undefined));
  // Read for the first time: a spinner where the count goes, not a 0 the cluster never said.
  const kindCount: ReactNode = !activeList ? null : firstRead(activeList) ? (activeList.loading ? <Loader2 size={10} className="animate-spin" /> : null) : activeList.rows.length;
  // Both keep their answer, so a dock opened again or a visit back asks the cluster nothing new.
  // A cluster known not to answer is not asked for its namespaces: they come once it does.
  useEffect(() => {
    if (!context) return;
    const known = useContainersStore.getState().reach[context];
    void checkReach(context);
    if (known?.ok !== false) void loadNamespaces(context);
  }, [context, checkReach, loadNamespaces]);
  const here = nav.runtime === "kubernetes";
  return (
    <div>
      <RuntimeHead
        runtime={runtime}
        selected={here && nav.section === "overview"}
        onClick={() => setNav({ runtime: "kubernetes", section: "overview" })}
        extra={context && reach ? <StateDot tone={reach.ok ? "ok" : "bad"} title={reach.ok ? reach.text : t("containers.clusterUnreachable", { reason: reach.text })} /> : undefined}
      />
      <div className="flex items-center gap-1 py-0.5 pl-6 pr-1">
        <div className="min-w-0 flex-1">
          {runtime.contexts.length > 0 ? (
            <Select
              size="sm"
              value={context ?? ""}
              onChange={(next) => setContext("kubernetes", next)}
              options={runtime.contexts.map((c) => ({ value: c.name, label: c.name }))}
              placeholder={t("containers.m.kube.notConnected")}
              ariaLabel={t("containers.m.cluster")}
            />
          ) : (
            <span className="text-[11.5px] text-[var(--cf-text-muted)]">{t("containers.m.noClusters")}</span>
          )}
        </div>
        {context && (
          <RowAction label={t("containers.m.kube.disconnectHint")} onClick={() => void disconnectCluster(t)}>
            <Unplug size={12} />
          </RowAction>
        )}
        <RowAction label={t("containers.m.addCluster")} onClick={onAddCluster}>
          <Plus size={12} />
        </RowAction>
      </div>
      {context && (
        <div className="py-0.5 pl-6 pr-1">
          <Select
            size="sm"
            value={namespace}
            onChange={(next) => setNamespace(context, next)}
            options={[{ value: "", label: t("containers.allNamespaces") }, ...(namespaces ?? []).map((n) => ({ value: n, label: n }))]}
            ariaLabel={t("containers.namespace")}
          />
        </div>
      )}
      {context &&
        KUBE_GROUPS.map((group) => (
          <div key={group.label}>
            <div className={`${sectionLabelClass} pl-6 pt-2 text-[10px]`}>{t(group.label)}</div>
            {group.kinds.map((kind) => (
              <NavRow
                key={kind}
                icon={Boxes}
                label={t(`containers.kind.${kind}` as TranslationKey)}
                count={here && nav.section === kind && kindCount !== null ? kindCount : undefined}
                selected={here && nav.section === kind}
                onClick={() => setNav({ runtime: "kubernetes", section: kind })}
              />
            ))}
          </div>
        ))}
    </div>
  );
}
