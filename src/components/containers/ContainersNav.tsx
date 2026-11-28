import { useEffect, useMemo, type ReactNode } from "react";
import {
  Activity,
  Blocks,
  Cloud,
  HeartPulse,
  ScrollText,
  Boxes,
  Box,
  Hammer,
  ShieldCheck,
  GitBranchPlus,
  Store,
  HardDrive,
  Layers,
  LayoutDashboard,
  Loader2,
  Network,
  List,
  Plus,
  RefreshCw,
  ShipWheel,
  Unplug,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { Select } from "../common/Select";
import { rowClass, sectionLabelClass } from "../common/recipes";
import { RowAction, RuntimeGlyph, StateDot } from "./containerBits";
import { runtimeLabel } from "./containerActions";
import { firstRead } from "./pageModel";
import { disconnectCluster } from "./KubePage";
import { AiVisibilityToggle } from "./AiVisibility";
import { useToolSetupStore } from "../../state/toolSetupStore";
import { useAzureStore } from "../../state/azureStore";
import { listKey, useContainersStore, type EngineSection } from "../../state/containersStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ContainerRow, RuntimeId, RuntimeInfo } from "../../types/containers";

/**
 * The manager's left column. On top, every provider this computer has — each runtime, Azure when
 * `az` is installed — one row each with its state and what it is pointed at; under them, only the
 * active provider's pages. They used to stack in one scrolling column, and whatever came last
 * (Azure, under a cluster's twenty kinds) sat out of sight below the fold (user, 2026-11-19: «siento
 * que está todo muy escondido ya que va quedando abajo»). A provider's row goes back to the page
 * last opened in it.
 */

const ENGINE_SECTIONS: { id: EngineSection; icon: LucideIcon; label: TranslationKey }[] = [
  { id: "overview", icon: LayoutDashboard, label: "containers.m.section.overview" },
  { id: "containers", icon: Box, label: "containers.section.containers" },
  { id: "images", icon: Layers, label: "containers.section.images" },
  { id: "volumes", icon: HardDrive, label: "containers.section.volumes" },
  { id: "networks", icon: Network, label: "containers.section.networks" },
  { id: "compose", icon: Blocks, label: "containers.m.section.compose" },
  { id: "build", icon: Hammer, label: "containers.m.section.build" },
  { id: "envs", icon: GitBranchPlus, label: "containers.envs.title" },
  { id: "market", icon: Store, label: "containers.market.title" },
  { id: "sandboxes", icon: ShieldCheck, label: "containers.sandbox.nav" },
];

/** The kinds, in the groups `kubectl api-resources` would put them in. */
const KUBE_GROUPS: { label: TranslationKey; kinds: string[] }[] = [
  { label: "containers.m.kube.workloads", kinds: ["pods", "deployments", "statefulsets", "daemonsets", "jobs", "cronjobs"] },
  { label: "containers.m.kube.network", kinds: ["services", "ingresses"] },
  { label: "containers.m.kube.config", kinds: ["configmaps", "secrets", "persistentvolumeclaims"] },
  { label: "containers.m.kube.cluster", kinds: ["nodes", "namespaces", "events"] },
];

/** Where a provider's row goes the first time: its overview (Azure has none: its resources). */
const FIRST_SECTION = (id: string) => (id === "azure" ? "resources" : "overview");

export function ContainersNav({ onAddCluster, onAddEngine }: { onAddCluster: () => void; onAddEngine: () => void }) {
  const t = useT();
  const runtimes = useContainersStore((s) => s.runtimes);
  const detected = useContainersStore((s) => s.detected);
  const detecting = useContainersStore((s) => s.detecting);
  const detect = useContainersStore((s) => s.detect);
  const pulse = useContainersStore((s) => s.pulse);
  const azureFound = useAzureStore((s) => s.found);
  const nav = useNav();
  useAzureDetection();
  const hasKube = runtimes.some((r) => r.id === "kubernetes");
  const active = runtimes.find((r) => r.id === nav.runtime);
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
      <div className="flex h-8 shrink-0 items-center gap-1 pl-3 pr-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
          {detecting ? t("containers.detecting") : t("containers.m.providers")}
        </span>
        <RowAction label={t("containers.m.addEngine")} onClick={onAddEngine}>
          <Plus size={12} />
        </RowAction>
        <RowAction label={t("containers.refresh")} onClick={() => void refresh()}>
          {detecting ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
        </RowAction>
      </div>
      <div className="shrink-0 px-1.5 pb-2">
        {!detected && (
          <p className="flex items-center gap-1.5 px-1.5 py-2 text-[11.5px] text-[var(--cf-text-muted)]">
            <Loader2 size={11} className="animate-spin" />
            {t("containers.detecting")}
          </p>
        )}
        {detected && runtimes.length === 0 && !azureFound && <p className="px-1.5 py-2 text-[11.5px] text-[var(--cf-text-muted)]">{t("containers.noRuntimes")}</p>}
        {(runtimes.length > 0 || azureFound) && (
          <div role="tablist" aria-label={t("containers.m.providers")} className="flex flex-col gap-0.5 rounded-lg bg-[var(--cf-surface)] p-1 shadow-[inset_0_0_0_1px_var(--cf-border)]">
            {runtimes.map((runtime) => (runtime.id === "kubernetes" ? <KubeTab key={runtime.id} runtime={runtime} /> : <EngineTab key={runtime.id} runtime={runtime} />))}
            {azureFound && <AzureTab />}
            {detected && !hasKube && (
              <button onClick={onAddCluster} className={rowClass(false, "h-8 text-[12px] text-[var(--cf-text-muted)]")}>
                <Plus size={13} className="shrink-0" />
                {t("containers.m.addCluster")}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="mx-3 shrink-0 border-t border-[var(--cf-border)]" />
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 pt-1">
        {active?.id === "kubernetes" && <KubeNav runtime={active} onAddCluster={onAddCluster} />}
        {active && active.id !== "kubernetes" && <EngineNav runtime={active} />}
        {nav.runtime === "azure" && azureFound && <AzureNav />}
      </div>
    </div>
  );
}

/** Azure's detection and its subscriptions, read whether or not its pages are open: its row above
 *  shows only once `az` is found, and says which subscription the pages read. */
function useAzureDetection() {
  const azInstalled = useToolSetupStore((s) => s.tools?.find((tool) => tool.id === "az")?.installed);
  const found = useAzureStore((s) => s.found);
  const detect = useAzureStore((s) => s.detect);
  const loadPrefs = useAzureStore((s) => s.loadPrefs);
  const loadSubscriptions = useAzureStore((s) => s.loadSubscriptions);
  useEffect(() => {
    void loadPrefs().then(() => {
      const found = useAzureStore.getState().found;
      if (found === null || (azInstalled !== undefined && azInstalled !== found)) return detect();
    });
  }, [loadPrefs, detect, azInstalled]);
  // `az account list` reads az's own profile; the groups ask Azure — only once the pages are open.
  useEffect(() => {
    if (found) void loadSubscriptions();
  }, [found, loadSubscriptions]);
}

/** Goes to a provider, at the page last opened in it. */
function useOpenProvider() {
  const setNav = useContainersStore((s) => s.setNav);
  return (id: RuntimeId | "azure") => {
    const { prefs, runtimes } = useContainersStore.getState();
    const known = new Set<string>(id === "kubernetes" ? ["overview", "topology", "helm", ...KUBE_GROUPS.flatMap((g) => g.kinds)] : id === "azure" ? AZURE_SECTIONS.map((s) => s.id) : ENGINE_SECTIONS.map((s) => s.id));
    const last = prefs.sections?.[id];
    if (id !== "azure" && !runtimes.some((r) => r.id === id)) return;
    setNav({ runtime: id, section: last && known.has(last) ? last : FIRST_SECTION(id) });
  };
}

/** One provider's row in the switcher: its mark, its name, what it is pointed at, its state. */
function ProviderTab({ selected, onClick, glyph, label, detail, state }: { selected: boolean; onClick: () => void; glyph: ReactNode; label: string; detail?: string; state?: ReactNode }) {
  return (
    <button role="tab" aria-selected={selected} onClick={onClick} className={rowClass(selected, "h-8 pr-1.5")}>
      {selected && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-[var(--cf-accent)]" />}
      {glyph}
      <span className="shrink-0 text-[12.5px] font-semibold">{label}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text-faint)]">{detail}</span>
      {state}
    </button>
  );
}

function EngineTab({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const nav = useNav();
  const open = useOpenProvider();
  const context = useContainersStore((s) => s.contextOf(runtime.id));
  const detail = runtime.contexts.length > 1 && context ? context : (runtime.provider ?? "");
  return (
    <ProviderTab
      selected={nav.runtime === runtime.id}
      onClick={() => open(runtime.id)}
      glyph={<RuntimeGlyph id={runtime.id} size={14} />}
      label={runtimeLabel(runtime.id, t)}
      detail={detail}
      state={<StateDot tone={runtime.running ? "ok" : "idle"} title={runtime.running ? t("containers.running") : (runtime.problem ?? t("containers.notRunningHint"))} />}
    />
  );
}

function KubeTab({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const nav = useNav();
  const open = useOpenProvider();
  const context = useContainersStore((s) => s.contextOf("kubernetes"));
  const reach = useContainersStore((s) => s.reach[context ?? ""]);
  const checkReach = useContainersStore((s) => s.checkReach);
  // Its state on the row whether or not its pages are open — an answer kept a while, not asked anew.
  useEffect(() => {
    if (context) void checkReach(context);
  }, [context, checkReach]);
  return (
    <ProviderTab
      selected={nav.runtime === "kubernetes"}
      onClick={() => open("kubernetes")}
      glyph={<RuntimeGlyph id={runtime.id} size={14} />}
      label={runtimeLabel(runtime.id, t)}
      detail={context ?? t("containers.m.kube.notConnected")}
      state={context && reach ? <StateDot tone={reach.ok ? "ok" : "bad"} title={reach.ok ? reach.text : t("containers.clusterUnreachable", { reason: reach.text })} /> : undefined}
    />
  );
}

function AzureTab() {
  const t = useT();
  const nav = useNav();
  const open = useOpenProvider();
  const subscriptions = useAzureStore((s) => s.subscriptions);
  const subscription = useAzureStore((s) => s.prefs.subscription);
  const name = subscriptions.value?.contexts.find((s) => s.id === subscription)?.name;
  return (
    <ProviderTab
      selected={nav.runtime === "azure"}
      onClick={() => open("azure")}
      glyph={<Cloud size={14} className="shrink-0 text-[var(--cf-accent)]" />}
      label="Azure"
      detail={name ?? t("azure.readOnly")}
      state={subscriptions.loading ? <Loader2 size={11} className="animate-spin text-[var(--cf-text-muted)]" /> : undefined}
    />
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
    <button onClick={onClick} aria-current={selected ? "page" : undefined} className={rowClass(selected, `h-7 text-[12.5px] ${dim ? "opacity-60" : ""}`)}>
      <Icon size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count !== null && <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)]">{count}</span>}
    </button>
  );
}

/** The active provider's own row over its pages: what can be done to it as a whole. */
function PanelHead({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-1.5 px-2">
      <span className="min-w-0 truncate text-[12.5px] font-semibold">{title}</span>
      {detail && <span className="min-w-0 truncate text-[11px] text-[var(--cf-text-faint)]">{detail}</span>}
      <span className="flex-1" />
      {children}
    </div>
  );
}

/** An engine that is not running: said once, with its Start button, over the pages it cannot fill. */
function EngineStopped({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const startRuntime = useContainersStore((s) => s.startRuntime);
  const starting = useContainersStore((s) => s.starting[runtime.id]);
  return (
    <div className="mx-1 mb-1.5 flex items-center gap-2 rounded-lg bg-[var(--cf-hover)] px-2.5 py-2 shadow-[inset_0_0_0_1px_var(--cf-border)]">
      <StateDot tone="idle" />
      <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{runtime.problem ?? t("containers.notRunningHint")}</span>
      {runtime.start && (
        <button
          onClick={() => void startRuntime(runtime)}
          disabled={starting}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          {starting && <Loader2 size={10} className="animate-spin" />}
          {starting ? t("containers.startingRuntime") : t("containers.startRuntime")}
        </button>
      )}
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
      <PanelHead title={runtimeLabel(runtime.id, t)} detail={runtime.contexts.find((c) => c.name === context)?.provider ?? runtime.provider ?? undefined}>
        <AiVisibilityToggle kind="engines" id={runtime.id} name={runtimeLabel(runtime.id, t)} />
      </PanelHead>
      {!runtime.running && <EngineStopped runtime={runtime} />}
      {runtime.contexts.length > 1 && (
        <div className="px-1 pb-1">
          <Select
            size="sm"
            value={context ?? ""}
            onChange={(next) => setContext(runtime.id, next)}
            options={runtime.contexts.map((c) => ({ value: c.name, label: c.provider && c.provider.toLowerCase() !== c.name.toLowerCase() ? `${c.name} · ${c.provider}` : c.name }))}
            ariaLabel={t("containers.context")}
          />
        </div>
      )}
      {ENGINE_SECTIONS.map((section) => (
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
      <PanelHead title={runtimeLabel(runtime.id, t)}>
        {context && reach ? <StateDot tone={reach.ok ? "ok" : "bad"} title={reach.ok ? reach.text : t("containers.clusterUnreachable", { reason: reach.text })} /> : undefined}
      </PanelHead>
      <div className="flex items-center gap-1 px-1 pb-1">
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
        {context && <AiVisibilityToggle kind="kube" id={context} name={context} />}
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
        <div className="px-1 pb-1">
          <Select
            size="sm"
            value={namespace}
            onChange={(next) => setNamespace(context, next)}
            options={[{ value: "", label: t("containers.allNamespaces") }, ...(namespaces ?? []).map((n) => ({ value: n, label: n }))]}
            ariaLabel={t("containers.namespace")}
          />
        </div>
      )}
      {context && (
        <NavRow
          icon={LayoutDashboard}
          label={t("containers.m.section.overview")}
          selected={here && nav.section === "overview"}
          onClick={() => setNav({ runtime: "kubernetes", section: "overview" })}
        />
      )}
      {context && (
        <NavRow icon={Waypoints} label={t("containers.topo.title")} selected={here && nav.section === "topology"} onClick={() => setNav({ runtime: "kubernetes", section: "topology" })} />
      )}
      {context && <NavRow icon={ShipWheel} label={t("containers.helm.title")} selected={here && nav.section === "helm"} onClick={() => setNav({ runtime: "kubernetes", section: "helm" })} />}
      {context &&
        KUBE_GROUPS.map((group) => (
          <div key={group.label}>
            <div className={`${sectionLabelClass} pl-2 pt-2 text-[10px]`}>{t(group.label)}</div>
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

/** The Azure pages, beside the runtimes whenever `az` is installed: the subscription and group they
 *  read, and what there is to look at. Nothing here changes a resource. */
const AZURE_SECTIONS: { id: string; icon: LucideIcon; label: TranslationKey }[] = [
  { id: "resources", icon: List, label: "azure.section.resources" },
  { id: "topology", icon: Waypoints, label: "azure.section.topology" },
  { id: "health", icon: HeartPulse, label: "azure.section.health" },
  { id: "activity", icon: Activity, label: "azure.section.activity" },
  { id: "query", icon: ScrollText, label: "azure.section.query" },
];

function AzureNav() {
  const t = useT();
  const nav = useNav();
  const setNav = useContainersStore((s) => s.setNav);
  const found = useAzureStore((s) => s.found);
  const subscriptions = useAzureStore((s) => s.subscriptions);
  const prefs = useAzureStore((s) => s.prefs);
  const setSubscription = useAzureStore((s) => s.setSubscription);
  const setGroup = useAzureStore((s) => s.setGroup);
  const groups = useAzureStore((s) => s.groups[s.prefs.subscription]);
  const loadGroups = useAzureStore((s) => s.loadGroups);
  const here = nav.runtime === "azure";
  useEffect(() => {
    if (found && here && prefs.subscription) void loadGroups(prefs.subscription);
  }, [found, here, prefs.subscription, loadGroups]);
  if (!found) return null;
  const subs = subscriptions.value?.contexts ?? [];
  return (
    <div>
      <PanelHead title="Azure" detail={t("azure.readOnly")}>
        {subscriptions.loading && <Loader2 size={11} className="animate-spin text-[var(--cf-text-muted)]" />}
      </PanelHead>
      {subs.length > 0 && (
        <div className="flex items-center gap-1 px-1 pb-1">
          <div className="min-w-0 flex-1">
            <Select size="sm" value={prefs.subscription} onChange={setSubscription} options={subs.map((s) => ({ value: s.id, label: s.name }))} ariaLabel={t("azure.subscription")} />
          </div>
          {prefs.subscription && (
            <AiVisibilityToggle kind="azure" id={prefs.subscription} name={subs.find((s) => s.id === prefs.subscription)?.name ?? prefs.subscription} />
          )}
        </div>
      )}
      {subs.length > 0 && (
        <div className="px-1 pb-1">
          <Select
            size="sm"
            value={prefs.group}
            onChange={setGroup}
            options={[{ value: "", label: t("azure.allGroups") }, ...(groups?.value ?? []).map((g) => ({ value: g.id, label: g.name }))]}
            ariaLabel={t("azure.group")}
          />
        </div>
      )}
      {AZURE_SECTIONS.map((section) => (
        <NavRow key={section.id} icon={section.icon} label={t(section.label)} selected={here && nav.section === section.id} onClick={() => setNav({ runtime: "azure", section: section.id })} />
      ))}
    </div>
  );
}
