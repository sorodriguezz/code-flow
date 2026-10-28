import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, ExternalLink, Loader2, Play, RefreshCw, X } from "lucide-react";
import { Button } from "../common/Button";
import { Select } from "../common/Select";
import { SessionPane } from "./SessionPane";
import { LogAnalysisPanel, LogTools } from "./LogTools";
import { DetailTabs, Facts, RowAction, SectionTitle, StateDot, TextView, ago, useInterval } from "./containerBits";
import { DataTable, EmptyLine, LoadingLine, PageHead, PageToolbar, SearchField, Td, Th, trClass } from "./ui";
import { CopyText } from "./pageBits";
import { KQL_PRESETS, azureIdName, azureLayer, azureLogKind, azureTone, azureTypeLabel, cellText } from "./topologyModel";
import type { GraphNode } from "./TopologyCanvas";
import { azureActivity, azureQuery, azureShow, azureWorkspaces } from "../../lib/tauri/azureCommands";
import { healthById, scopeKey, useAzureStore } from "../../state/azureStore";
import { useContainersStore } from "../../state/containersStore";
import { logAnalysisKey } from "../../state/containersLogAiStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { AzActivity, AzHealth, AzQueryResult, AzResource, AzTopology, AzWorkspace } from "../../types/containers";

const TopologyCanvas = lazy(() => import("./TopologyCanvas"));

/**
 * Azure, looked at: the resources of the subscription and group picked in the navigation, their
 * Resource Health, the activity log, a resource's own logs, Log Analytics queries, and how the
 * resources connect (`containers::azure`). Read-only from top to bottom — the only buttons here read.
 */

const EDGE_LABEL: Record<string, TranslationKey> = {
  ref: "azure.edge.ref",
  host: "azure.edge.host",
  setting: "azure.edge.setting",
  vault: "azure.edge.vault",
};

/** The scope the pages read, and its line under each page's title. */
function useScope() {
  const t = useT();
  const prefs = useAzureStore((s) => s.prefs);
  const subscriptions = useAzureStore((s) => s.subscriptions);
  const name = subscriptions.value?.contexts.find((c) => c.id === prefs.subscription)?.name ?? prefs.subscription;
  return { ...prefs, key: scopeKey(prefs.subscription, prefs.group), label: [name, prefs.group || t("azure.allGroups")].filter(Boolean).join(" · ") };
}

/** The scope's resources and health, read when a page needs them and again every minute on screen. */
function useResources() {
  const scope = useScope();
  const resources = useAzureStore((s) => s.resources[scope.key]);
  const health = useAzureStore((s) => s.health[scope.key]);
  const loadResources = useAzureStore((s) => s.loadResources);
  const loadHealth = useAzureStore((s) => s.loadHealth);
  useEffect(() => {
    if (!scope.subscription) return;
    void loadResources();
    void loadHealth();
  }, [scope.key, scope.subscription, loadResources, loadHealth]);
  useInterval(
    () => {
      void loadResources();
      void loadHealth();
    },
    60_000,
    !!scope.subscription,
  );
  const byId = useMemo(() => healthById(health?.value), [health]);
  return { scope, resources, health, byId, refresh: () => void Promise.all([loadResources(true), loadHealth(true)]) };
}

export function AzurePane({ section }: { section: string }) {
  const t = useT();
  const found = useAzureStore((s) => s.found);
  const subscriptions = useAzureStore((s) => s.subscriptions);
  const subscription = useAzureStore((s) => s.prefs.subscription);
  const selected = useAzureStore((s) => s.selected);
  if (found === false) return <EmptyLine>{t("azure.notInstalled")}</EmptyLine>;
  if (subscriptions.error) return <EmptyLine>{t("azure.signIn", { reason: subscriptions.error })}</EmptyLine>;
  if (!subscription) return subscriptions.at === 0 || subscriptions.loading ? <LoadingLine /> : <EmptyLine>{t("azure.noSubscriptions")}</EmptyLine>;
  if (selected) return <AzureResourceDetail resource={selected} />;
  switch (section) {
    case "topology":
      return <AzureTopologyPage />;
    case "health":
      return <AzureHealthPage />;
    case "activity":
      return <AzureActivityPage />;
    case "query":
      return <AzureQueryPage />;
    default:
      return <AzureResourcesPage />;
  }
}

function HealthMark({ resource, health }: { resource: AzResource; health?: AzHealth }) {
  const tone = azureTone(health?.state, resource.state);
  const text = health ? health.state : resource.state;
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={health?.summary || resource.state}>
      <StateDot tone={tone} />
      <span className={`truncate ${tone === "bad" ? "text-[var(--cf-danger)]" : "text-[var(--cf-text)]"}`}>{text || "—"}</span>
    </span>
  );
}

function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <RowAction label={t("containers.refresh")} onClick={onClick}>
      {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
    </RowAction>
  );
}

// ------------------------------------------------------------------------------------ resources

function AzureResourcesPage() {
  const t = useT();
  const { scope, resources, health, byId, refresh } = useResources();
  const select = useAzureStore((s) => s.select);
  const [query, setQuery] = useState("");
  const rows = resources?.value ?? [];
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(needle) || azureTypeLabel(r.type, r.flavor).toLowerCase().includes(needle) || r.group.toLowerCase().includes(needle));
  }, [rows, query]);
  const failing = rows.filter((r) => azureTone(byId.get(r.id.toLowerCase())?.state, r.state) === "bad").length;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("azure.section.resources")} sub={[scope.label, rows.length ? String(rows.length) : null, failing ? t("containers.m.kube.failing", { count: failing }) : null].filter(Boolean).join(" · ")}>
        <RefreshButton loading={!!resources?.loading || !!health?.loading} onClick={refresh} />
      </PageHead>
      <PageToolbar>
        <SearchField value={query} onChange={setQuery} placeholder={t("azure.search")} />
      </PageToolbar>
      {resources?.error && !resources.value ? (
        <EmptyLine>{resources.error}</EmptyLine>
      ) : !resources?.value ? (
        <LoadingLine />
      ) : shown.length === 0 ? (
        <EmptyLine>{rows.length ? t("containers.m.kube.noMatch") : t("azure.none")}</EmptyLine>
      ) : (
        <DataTable minWidth={720}>
          <thead>
            <tr>
              <Th>{t("containers.m.col.name")}</Th>
              <Th width={190}>{t("azure.col.type")}</Th>
              {!scope.group && <Th width={170}>{t("azure.group")}</Th>}
              <Th width={110}>{t("azure.col.location")}</Th>
              <Th width={140}>{t("containers.m.col.state")}</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={trClass(false, true)} onClick={() => select(r)}>
                <Td className="max-w-[300px]">
                  <span className="block truncate font-medium text-[var(--cf-text)]" title={r.id}>
                    {r.name}
                  </span>
                </Td>
                <Td>
                  <span className="truncate text-[var(--cf-text-muted)]" title={r.type}>
                    {azureTypeLabel(r.type, r.flavor)}
                  </span>
                </Td>
                {!scope.group && <Td>{<span className="truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]">{r.group}</span>}</Td>}
                <Td>
                  <span className="text-[var(--cf-text-muted)]">{r.location}</span>
                </Td>
                <Td>
                  <HealthMark resource={r} health={byId.get(r.id.toLowerCase())} />
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------- detail

type DetailTab = "summary" | "properties" | "activity" | "logs" | "connections";

function AzureResourceDetail({ resource }: { resource: AzResource }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const select = useAzureStore((s) => s.select);
  const health = useAzureStore((s) => healthById(s.health[scopeKey(s.prefs.subscription, s.prefs.group)]?.value).get(resource.id.toLowerCase()));
  const logKind = azureLogKind(resource.type);
  const tabs: DetailTab[] = ["summary", "properties", "activity", ...(logKind ? (["logs"] as DetailTab[]) : []), "connections"];
  const [tab, setTab] = useState<DetailTab>("summary");
  const [visited, setVisited] = useState<Set<DetailTab>>(new Set(["summary"]));
  const logText = useRef<(() => string) | null>(null);
  useEffect(() => setVisited((v) => (v.has(tab) ? v : new Set([...v, tab]))), [tab]);
  const label = azureTypeLabel(resource.type, resource.flavor);
  const about = ["Origen: Azure", `Recurso: ${resource.name} (${label}, ${resource.type})`, `Grupo: ${resource.group}`, resource.location && `Ubicación: ${resource.location}`, health && `Salud: ${health.state} ${health.summary}`]
    .filter(Boolean)
    .join("\n");
  const analysisKey = logAnalysisKey(["azure", resource.id]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-2">
        <RowAction label={t("containers.m.backToList")} onClick={() => select(null)}>
          <ArrowLeft size={14} />
        </RowAction>
        <StateDot tone={azureTone(health?.state, resource.state)} title={health?.summary || resource.state} />
        <h3 className="min-w-0 truncate text-[13px] font-semibold text-[var(--cf-text)]" title={resource.id}>
          {resource.name}
        </h3>
        <span className="min-w-0 truncate text-[11.5px] text-[var(--cf-text-muted)]">{[label, resource.group, resource.location, health?.state ?? resource.state].filter(Boolean).join(" · ")}</span>
      </div>
      <DetailTabs
        tabs={tabs.map((id) => ({ id, label: t(`azure.tab.${id}` as TranslationKey) }))}
        value={tab}
        onChange={setTab}
        trailing={tab === "logs" && logKind === "stream" ? <LogTools read={() => logText.current?.() ?? ""} subject={resource.name} about={about} analysisKey={analysisKey} /> : null}
      />
      <div className="relative flex min-h-0 flex-1">
        {tab === "summary" && (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <Facts
              rows={[
                [t("azure.col.type"), `${label} (${resource.type})`],
                [t("azure.fact.kind"), resource.flavor],
                ["SKU", resource.sku],
                [t("azure.group"), resource.group],
                [t("azure.col.location"), resource.location],
                [t("azure.fact.provisioning"), resource.state],
                [t("azure.fact.health"), health ? [health.state, health.summary, health.since && ago(health.since, language)].filter(Boolean).join(" · ") : ""],
                ["Id", <CopyText key="id" text={resource.id} toast={t("azure.idCopied")} title={t("azure.copyId")} />],
              ]}
            />
            {Object.keys(resource.tags).length > 0 && (
              <>
                <SectionTitle>{t("azure.fact.tags")}</SectionTitle>
                <Facts rows={Object.entries(resource.tags)} />
              </>
            )}
          </div>
        )}
        {tab === "properties" && <Properties id={resource.id} />}
        {tab === "activity" && <ActivityList resource={resource.id} />}
        {visited.has("logs") && logKind === "stream" && (
          <SessionPane visible={tab === "logs"} request={{ kind: "azureLogs", runtime: "azure", context: null, target: resource.id, tail: 200 }} textRef={logText} />
        )}
        {tab === "logs" && logKind === "stream" && <LogAnalysisPanel analysisKey={analysisKey} />}
        {tab === "logs" && logKind === "cluster" && <ClusterLogs resource={resource} />}
        {tab === "connections" && <Connections resource={resource} />}
      </div>
    </div>
  );
}

function Properties({ id }: { id: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void azureShow(id)
      .then((value) => live && setText(JSON.stringify(value, null, 2)))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [id]);
  if (error) return <EmptyLine>{error}</EmptyLine>;
  if (text === null) return <LoadingLine />;
  return <TextView value={text} language="json" />;
}

/** An AKS cluster's logs are its pods': the Kubernetes pages, on its context when there is one. */
function ClusterLogs({ resource }: { resource: AzResource }) {
  const t = useT();
  const runtimes = useContainersStore((s) => s.runtimes);
  const setContext = useContainersStore((s) => s.setContext);
  const setNav = useContainersStore((s) => s.setNav);
  const setDialog = useContainersStore((s) => s.setDialog);
  const contexts = runtimes.find((r) => r.id === "kubernetes")?.contexts ?? [];
  const match = contexts.find((c) => c.name === resource.name) ?? contexts.find((c) => c.name.includes(resource.name));
  return (
    <div className="flex flex-col items-start gap-2 p-3 text-[12px] text-[var(--cf-text-muted)]">
      {match ? (
        <Button
          size="sm"
          onClick={() => {
            setContext("kubernetes", match.name);
            setNav({ runtime: "kubernetes", section: "topology" });
          }}
        >
          <ExternalLink size={11} />
          {t("azure.openCluster", { context: match.name })}
        </Button>
      ) : (
        <>
          <span>{t("azure.clusterNotAdded")}</span>
          <Button size="sm" onClick={() => setDialog("cluster")}>
            {t("containers.m.addCluster")}
          </Button>
        </>
      )}
    </div>
  );
}

function Connections({ resource }: { resource: AzResource }) {
  const t = useT();
  const subscription = useAzureStore((s) => s.prefs.subscription);
  const topo = useAzureStore((s) => s.topology[scopeKey(s.prefs.subscription, resource.group)]);
  const loadTopology = useAzureStore((s) => s.loadTopology);
  const select = useAzureStore((s) => s.select);
  const resources = useAzureStore((s) => s.resources[scopeKey(s.prefs.subscription, s.prefs.group)]?.value);
  useEffect(() => {
    void loadTopology(false, resource.group);
  }, [subscription, resource.group, loadTopology]);
  if (topo?.error && !topo.value) return <EmptyLine>{topo.error}</EmptyLine>;
  if (!topo?.value) return <LoadingLine>{t("azure.topo.reading")}</LoadingLine>;
  const graph = topo.value;
  const byId = new Map(graph.nodes.map((n) => [n.id.toLowerCase(), n]));
  const own = resource.id.toLowerCase();
  const out = graph.edges.filter((e) => e.from.toLowerCase() === own);
  const into = graph.edges.filter((e) => e.to.toLowerCase() === own);
  const row = (id: string, kind: string, label: string, arrow: string) => {
    const other = byId.get(id.toLowerCase());
    const known = resources?.find((r) => r.id.toLowerCase() === id.toLowerCase());
    return (
      <button
        key={`${arrow}${id}${kind}`}
        disabled={!known}
        onClick={() => known && select(known)}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left enabled:hover:bg-[var(--cf-hover)]"
      >
        <span className="w-4 shrink-0 text-[var(--cf-text-muted)]">{arrow}</span>
        <span className="min-w-0 flex-1 truncate">
          <span className="text-[var(--cf-text)]">{other?.name ?? azureIdName(id)}</span>
          <span className="text-[var(--cf-text-muted)]"> · {azureTypeLabel(other?.type ?? "", other?.flavor)}</span>
          <span className="text-[var(--cf-text-faint)]">
            {" "}
            · {t(EDGE_LABEL[kind] ?? "azure.edge.ref")}
            {label && `: ${label}`}
          </span>
        </span>
      </button>
    );
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[12px]">
      {out.length === 0 && into.length === 0 && <p className="text-[var(--cf-text-muted)]">{t("azure.topo.noLinks")}</p>}
      {out.length > 0 && <SectionTitle>{t("azure.topo.uses")}</SectionTitle>}
      {out.map((e) => row(e.to, e.kind, e.label, "→"))}
      {into.length > 0 && <SectionTitle>{t("azure.topo.usedBy")}</SectionTitle>}
      {into.map((e) => row(e.from, e.kind, e.label, "←"))}
    </div>
  );
}

// ------------------------------------------------------------------------------------- topology

function AzureTopologyPage() {
  const t = useT();
  const { scope, byId, resources } = useResources();
  const topo = useAzureStore((s) => s.topology[scope.key]);
  const loadTopology = useAzureStore((s) => s.loadTopology);
  const select = useAzureStore((s) => s.select);
  const [picked, setPicked] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    setPicked(null);
    void loadTopology();
  }, [scope.key, loadTopology]);
  const graph: AzTopology | null = topo?.value ?? null;
  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as GraphNode[], edges: [] as AzTopology["edges"] };
    const needle = query.trim().toLowerCase();
    let shown = graph.nodes;
    if (needle) {
      const hits = new Set(shown.filter((n) => n.name.toLowerCase().includes(needle) || azureTypeLabel(n.type, n.flavor).toLowerCase().includes(needle)).map((n) => n.id));
      const near = new Set(hits);
      for (const e of graph.edges) {
        if (hits.has(e.from)) near.add(e.to);
        if (hits.has(e.to)) near.add(e.from);
      }
      shown = shown.filter((n) => near.has(n.id));
    }
    const ids = new Set(shown.map((n) => n.id));
    return {
      nodes: shown.map<GraphNode>((n) => {
        const health = byId.get(n.id.toLowerCase());
        return {
          id: n.id,
          title: n.name,
          sub: [health?.state ?? n.state, n.location].filter(Boolean).join(" · "),
          badge: azureTypeLabel(n.type, n.flavor),
          tone: azureTone(health?.state, n.state),
          layer: azureLayer(n.type),
          band: n.group,
          ghost: n.external,
          flagged: health?.state === "Unavailable" || health?.state === "Degraded",
        };
      }),
      edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    };
  }, [graph, query, byId]);
  const node = picked ? graph?.nodes.find((n) => n.id === picked) : undefined;
  const known = node ? resources?.value?.find((r) => r.id.toLowerCase() === node.id.toLowerCase()) : undefined;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("azure.section.topology")} sub={[scope.label, graph ? t("containers.topo.count", { nodes: graph.nodes.length, links: graph.edges.length }) : null].filter(Boolean).join(" · ")}>
        <RefreshButton loading={!!topo?.loading} onClick={() => void loadTopology(true)} />
      </PageHead>
      <PageToolbar>
        <SearchField value={query} onChange={setQuery} placeholder={t("azure.search")} />
        <div className="flex-1" />
        {graph && graph.warnings.length > 0 && (
          <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-[var(--cf-warning)]" title={graph.warnings.join("\n")}>
            <AlertTriangle size={11} className="shrink-0" />
            {t("containers.topo.unreadable", { count: graph.warnings.length })}
          </span>
        )}
      </PageToolbar>
      {topo?.error && !graph ? (
        <EmptyLine>{topo.error}</EmptyLine>
      ) : !graph ? (
        <LoadingLine>{t("azure.topo.reading")}</LoadingLine>
      ) : graph.nodes.length === 0 ? (
        <EmptyLine>{t("azure.none")}</EmptyLine>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1">
            <Suspense fallback={<LoadingLine />}>
              <TopologyCanvas nodes={nodes} edges={edges} bandLabel={(band) => band} selected={picked} onSelect={setPicked} />
            </Suspense>
          </div>
          {node && (
            <aside className="flex w-[270px] shrink-0 flex-col overflow-y-auto border-l border-[var(--cf-border)] bg-[var(--cf-surface)] p-3 text-[12px]">
              <div className="mb-2 flex items-start gap-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-[var(--cf-text)]" title={node.id}>
                    {node.name}
                  </div>
                  <div className="text-[11px] text-[var(--cf-text-muted)]">{[azureTypeLabel(node.type, node.flavor), node.group, node.external ? t("azure.topo.outside") : null].filter(Boolean).join(" · ")}</div>
                </div>
                <RowAction label={t("containers.topo.close")} onClick={() => setPicked(null)}>
                  <X size={12} />
                </RowAction>
              </div>
              {known && (
                <Button size="sm" className="mb-3 self-start" onClick={() => select(known)}>
                  <ExternalLink size={11} />
                  {t("containers.topo.open")}
                </Button>
              )}
              {graph.edges
                .filter((e) => e.from === node.id || e.to === node.id)
                .map((e, i) => {
                  const outgoing = e.from === node.id;
                  const other = graph.nodes.find((n) => n.id === (outgoing ? e.to : e.from));
                  return (
                    <button key={i} onClick={() => other && setPicked(other.id)} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-[var(--cf-hover)]">
                      <span className="w-4 shrink-0 text-[var(--cf-text-muted)]">{outgoing ? "→" : "←"}</span>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="text-[var(--cf-text)]">{other?.name ?? azureIdName(outgoing ? e.to : e.from)}</span>
                        <span className="text-[var(--cf-text-faint)]">
                          {" "}
                          · {t(EDGE_LABEL[e.kind] ?? "azure.edge.ref")}
                          {e.label && `: ${e.label}`}
                        </span>
                      </span>
                    </button>
                  );
                })}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------------------- health

function AzureHealthPage() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const { scope, resources, health, refresh } = useResources();
  const select = useAzureStore((s) => s.select);
  const rows = useMemo(() => {
    const byId = new Map((resources?.value ?? []).map((r) => [r.id.toLowerCase(), r]));
    const order = (state: string) => ({ Unavailable: 0, Degraded: 1, Unknown: 2 })[state] ?? 3;
    return (health?.value ?? []).map((h) => ({ h, r: byId.get(h.id.toLowerCase()) })).sort((a, b) => order(a.h.state) - order(b.h.state) || (a.r?.name ?? a.h.id).localeCompare(b.r?.name ?? b.h.id));
  }, [resources, health]);
  const bad = rows.filter((x) => x.h.state !== "Available").length;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("azure.section.health")} sub={[scope.label, rows.length ? String(rows.length) : null, bad ? t("azure.health.notAvailable", { count: bad }) : null].filter(Boolean).join(" · ")}>
        <RefreshButton loading={!!health?.loading} onClick={refresh} />
      </PageHead>
      {health?.error && !health.value ? (
        <EmptyLine>{health.error}</EmptyLine>
      ) : !health?.value ? (
        <LoadingLine />
      ) : rows.length === 0 ? (
        <EmptyLine>{t("azure.health.none")}</EmptyLine>
      ) : (
        <DataTable minWidth={720}>
          <thead>
            <tr>
              <Th>{t("containers.m.col.name")}</Th>
              <Th width={170}>{t("azure.col.type")}</Th>
              <Th width={120}>{t("containers.m.col.state")}</Th>
              <Th>{t("azure.health.summary")}</Th>
              <Th width={90}>{t("azure.health.since")}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ h, r }) => (
              <tr key={h.id} className={trClass(false, !!r)} onClick={() => r && select(r)}>
                <Td className="max-w-[260px]">
                  <span className="block truncate font-medium text-[var(--cf-text)]" title={h.id}>
                    {r?.name ?? azureIdName(h.id)}
                  </span>
                </Td>
                <Td>
                  <span className="truncate text-[var(--cf-text-muted)]">{r ? azureTypeLabel(r.type, r.flavor) : ""}</span>
                </Td>
                <Td>
                  <span className="flex items-center gap-1.5">
                    <StateDot tone={azureTone(h.state, "")} />
                    {h.state}
                  </span>
                </Td>
                <Td>
                  <span className="line-clamp-2 text-[11.5px] text-[var(--cf-text-muted)]">{h.summary}</span>
                </Td>
                <Td>
                  <span className="text-[var(--cf-text-muted)]">{h.since ? ago(h.since, language) : "—"}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------- activity

const HOURS = [1, 24, 168];

function ActivityList({ resource, hours = 24 }: { resource: string | null; hours?: number }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const { subscription, group } = useAzureStore((s) => s.prefs);
  const [rows, setRows] = useState<AzActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    void azureActivity(subscription, group || null, resource, hours)
      .then((list) => live && setRows(list))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [subscription, group, resource, hours, nonce]);
  if (error) return <EmptyLine>{error}</EmptyLine>;
  if (!rows) return <LoadingLine />;
  if (rows.length === 0)
    return (
      <EmptyLine>
        {t("azure.activity.none")}{" "}
        <button className="text-[var(--cf-accent)] hover:underline" onClick={() => setNonce((n) => n + 1)}>
          {t("containers.refresh")}
        </button>
      </EmptyLine>
    );
  return (
    <DataTable minWidth={720}>
      <thead>
        <tr>
          <Th width={90}>{t("azure.activity.when")}</Th>
          <Th>{t("azure.activity.operation")}</Th>
          <Th width={150}>{t("containers.m.col.state")}</Th>
          {!resource && <Th width={170}>{t("azure.activity.resource")}</Th>}
          <Th width={170}>{t("azure.activity.caller")}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e, i) => {
          const failed = /fail/i.test(e.status) || e.level === "Error";
          return (
            <tr key={i} className={trClass(false)} title={e.message || undefined}>
              <Td>
                <span className="text-[var(--cf-text-muted)]">{e.time ? ago(e.time, language) : "—"}</span>
              </Td>
              <Td>
                <span className="block truncate text-[var(--cf-text)]">{e.operation}</span>
                {failed && e.message && <span className="line-clamp-2 text-[11px] text-[var(--cf-danger)]">{e.message}</span>}
              </Td>
              <Td>
                <span className={`flex items-center gap-1.5 ${failed ? "text-[var(--cf-danger)]" : ""}`}>
                  <StateDot tone={failed ? "bad" : /succe/i.test(e.status) ? "ok" : "idle"} />
                  <span className="truncate">{e.status}</span>
                </span>
              </Td>
              {!resource && (
                <Td>
                  <span className="block truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]" title={e.resource}>
                    {azureIdName(e.resource)}
                  </span>
                </Td>
              )}
              <Td>
                <span className="block truncate text-[var(--cf-text-muted)]">{e.caller}</span>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
}

function AzureActivityPage() {
  const t = useT();
  const scope = useScope();
  const [hours, setHours] = useState(24);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("azure.section.activity")} sub={scope.label}>
        <div className="w-[130px]">
          <Select size="sm" value={String(hours)} onChange={(v) => setHours(Number(v))} options={HOURS.map((h) => ({ value: String(h), label: t(`azure.hours.${h}` as TranslationKey) }))} ariaLabel={t("azure.window")} />
        </div>
      </PageHead>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ActivityList key={`${scope.key}|${hours}`} resource={null} hours={hours} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------- query

function AzureQueryPage() {
  const t = useT();
  const scope = useScope();
  const [workspaces, setWorkspaces] = useState<AzWorkspace[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [hours, setHours] = useState(24);
  const [kql, setKql] = useState(KQL_PRESETS[0].query);
  const [result, setResult] = useState<AzQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    let live = true;
    setWorkspaces(null);
    void azureWorkspaces(scope.subscription)
      .then((list) => {
        if (!live) return;
        setWorkspaces(list);
        setWorkspace((current) => (list.some((w) => w.customerId === current) ? current : (list.find((w) => !scope.group || w.group === scope.group) ?? list[0])?.customerId ?? ""));
      })
      .catch((e: unknown) => live && setListError(String(e)));
    return () => {
      live = false;
    };
  }, [scope.subscription, scope.group]);
  const run = () => {
    if (!workspace || !kql.trim() || running) return;
    setRunning(true);
    setError(null);
    void azureQuery(workspace, kql, hours)
      .then(setResult)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setRunning(false));
  };
  const asText = () => (result ? [result.columns.join("\t"), ...result.rows.map((row) => row.map(cellText).join("\t"))].join("\n") : "");
  const chosen = workspaces?.find((w) => w.customerId === workspace);
  const analysisKey = logAnalysisKey(["azure-query", workspace, kql]);
  const about = ["Origen: Azure Log Analytics", chosen && `Workspace: ${chosen.name}`, `Ventana: últimas ${hours} h`, `Consulta KQL:\n${kql}`].filter(Boolean).join("\n");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("azure.section.query")} sub={scope.label}>
        {result && <LogTools read={asText} subject={chosen?.name ?? "query"} about={about} analysisKey={analysisKey} />}
      </PageHead>
      {listError ? (
        <EmptyLine>{listError}</EmptyLine>
      ) : !workspaces ? (
        <LoadingLine />
      ) : workspaces.length === 0 ? (
        <EmptyLine>{t("azure.query.noWorkspaces")}</EmptyLine>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <PageToolbar>
              <div className="w-[200px]">
                <Select size="sm" value={workspace} onChange={setWorkspace} options={workspaces.map((w) => ({ value: w.customerId, label: w.name }))} ariaLabel={t("azure.query.workspace")} />
              </div>
              <div className="w-[130px]">
                <Select size="sm" value={String(hours)} onChange={(v) => setHours(Number(v))} options={HOURS.map((h) => ({ value: String(h), label: t(`azure.hours.${h}` as TranslationKey) }))} ariaLabel={t("azure.window")} />
              </div>
              <div className="w-[190px]">
                <Select
                  size="sm"
                  value=""
                  onChange={(v) => v && setKql(v)}
                  placeholder={t("azure.query.presets")}
                  options={KQL_PRESETS.map((p) => ({ value: p.query, label: t(p.label as TranslationKey) }))}
                  ariaLabel={t("azure.query.presets")}
                />
              </div>
              <div className="flex-1" />
              <Button size="sm" variant="primary" onClick={run} disabled={running || !kql.trim()}>
                {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                {t("azure.query.run")}
              </Button>
            </PageToolbar>
            <textarea
              value={kql}
              onChange={(e) => setKql(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  run();
                }
              }}
              spellCheck={false}
              aria-label="KQL"
              className="h-[96px] shrink-0 resize-y border-b border-[var(--cf-border)] bg-transparent px-3 py-2 font-mono text-[12px] text-[var(--cf-text)] outline-none"
            />
            {error ? <EmptyLine>{error}</EmptyLine> : running && !result ? <LoadingLine /> : result ? <QueryTable result={result} /> : null}
          </div>
          {result && <LogAnalysisPanel analysisKey={analysisKey} />}
        </div>
      )}
    </div>
  );
}

function QueryTable({ result }: { result: AzQueryResult }): ReactNode {
  const t = useT();
  if (result.rows.length === 0) return <EmptyLine>{t("azure.query.noRows")}</EmptyLine>;
  return (
    <>
      <p className="shrink-0 px-3 py-1 text-[11px] text-[var(--cf-text-muted)]">{t(result.cut ? "azure.query.rowsCut" : result.rows.length === 1 ? "azure.query.rowsOne" : "azure.query.rows", { count: result.rows.length })}</p>
      <DataTable minWidth={Math.max(480, result.columns.length * 140)}>
        <thead>
          <tr>
            {result.columns.map((c) => (
              <Th key={c}>{c}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className={trClass(false)}>
              {row.map((cell, j) => (
                <Td key={j}>
                  <span className="line-clamp-3 break-all font-mono text-[11.5px] text-[var(--cf-text)]">{cellText(cell)}</span>
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </DataTable>
    </>
  );
}
