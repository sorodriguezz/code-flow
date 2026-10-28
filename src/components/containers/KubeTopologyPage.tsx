import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ExternalLink, Loader2, RefreshCw, X } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Button } from "../common/Button";
import { RowAction, StateDot, useInterval } from "./containerBits";
import { EmptyLine, LoadingLine, PageHead, PageToolbar, SearchField } from "./ui";
import { KUBE_DETAIL_KINDS, kubeLayer } from "./topologyModel";
import type { GraphEdge, GraphNode } from "./TopologyCanvas";
import { containersKubeTopology } from "../../lib/tauri/containersCommands";
import { useContainersStore } from "../../state/containersStore";
import { useT, type Translate } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { KubeTopology, TopoIssue, TopoNode } from "../../types/containers";

const TopologyCanvas = lazy(() => import("./TopologyCanvas"));

/** What each kind is called on a node — Kubernetes' own names, the same in every language. */
const BADGE: Record<string, string> = {
  ingresses: "Ingress",
  services: "Service",
  deployments: "Deployment",
  statefulsets: "StatefulSet",
  daemonsets: "DaemonSet",
  replicasets: "ReplicaSet",
  jobs: "Job",
  cronjobs: "CronJob",
  pods: "Pod",
  persistentvolumeclaims: "PVC",
  configmaps: "ConfigMap",
  secrets: "Secret",
  horizontalpodautoscalers: "HPA",
};

/** Read once per context and namespace while the app runs, so a visit back draws at once. */
const KEPT = new Map<string, KubeTopology>();

export function issueText(t: Translate, issue: TopoIssue): string {
  switch (issue.code) {
    case "noPods":
      return t("containers.topo.issue.noPods", { selector: issue.detail });
    case "missing":
      return t("containers.topo.issue.missing");
    default:
      return t("containers.topo.issue.failing", { count: issue.detail });
  }
}

const EDGE_LABEL: Record<string, TranslationKey> = {
  routes: "containers.topo.edge.routes",
  selects: "containers.topo.edge.selects",
  owns: "containers.topo.edge.owns",
  mounts: "containers.topo.edge.mounts",
  env: "containers.topo.edge.env",
  pull: "containers.topo.edge.pull",
  claims: "containers.topo.edge.claims",
  scales: "containers.topo.edge.scales",
};

/**
 * «Topología»: how the namespace's objects hang together — ingress → service → workload → pods,
 * and the ConfigMaps, Secrets and claims each uses (`containers::topology`). What is wrong shows on
 * the node and in the list beside it; a node opens the object's own page.
 */
export function KubeTopologyPage() {
  const t = useT();
  const context = useContainersStore((s) => s.contextOf("kubernetes"));
  const namespace = useContainersStore((s) => s.namespaceOf(context));
  const setNav = useContainersStore((s) => s.setNav);
  const select = useContainersStore((s) => s.select);
  const key = `${context ?? ""}|${namespace}`;
  const [topo, setTopo] = useState<KubeTopology | null>(() => KEPT.get(key) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPods, setShowPods] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  const read = useCallback(() => {
    setLoading(true);
    void containersKubeTopology(context, namespace || null)
      .then((next) => {
        KEPT.set(key, next);
        setTopo(next);
        setError(null);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [context, namespace, key]);
  useEffect(() => {
    setTopo(KEPT.get(key) ?? null);
    setPicked(null);
    read();
  }, [key, read]);
  useInterval(read, 30_000, !!context);

  const flagged = useMemo(() => new Set((topo?.issues ?? []).map((i) => i.node)), [topo]);
  const { nodes, edges } = useMemo(() => {
    if (!topo) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    const needle = query.trim().toLowerCase();
    // Pods are counted on their workload unless asked for — or failing, which is what one looks for.
    const ownedPods = new Set(topo.edges.filter((e) => e.kind === "owns").map((e) => e.to));
    let shown = topo.nodes.filter((n) => showPods || n.kind !== "pods" || !ownedPods.has(n.id) || n.tone === "bad");
    if (needle) {
      const hits = new Set(shown.filter((n) => n.name.toLowerCase().includes(needle)).map((n) => n.id));
      const near = new Set(hits);
      for (const e of topo.edges) {
        if (hits.has(e.from)) near.add(e.to);
        if (hits.has(e.to)) near.add(e.from);
      }
      shown = shown.filter((n) => near.has(n.id));
    }
    const ids = new Set(shown.map((n) => n.id));
    const podsOf = new Map<string, number>();
    for (const e of topo.edges) if (e.kind === "owns") podsOf.set(e.from, (podsOf.get(e.from) ?? 0) + 1);
    const graphNodes: GraphNode[] = shown.map((n) => ({
      id: n.id,
      title: n.name,
      sub: [n.missing ? t("containers.topo.missing") : n.status, n.ready, podsOf.get(n.id) && !showPods ? t("containers.topo.pods", { count: podsOf.get(n.id) ?? 0 }) : "", n.detail]
        .filter(Boolean)
        .join(" · "),
      badge: BADGE[n.kind] ?? n.kind,
      tone: n.tone,
      layer: kubeLayer(n.kind),
      band: n.namespace,
      ghost: n.missing,
      flagged: flagged.has(n.id),
    }));
    return { nodes: graphNodes, edges: topo.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  }, [topo, showPods, query, flagged, t]);

  const node = picked ? topo?.nodes.find((n) => n.id === picked) : undefined;
  const open = (n: TopoNode) => {
    setNav({ runtime: "kubernetes", section: n.kind });
    select({ runtime: "kubernetes", context, namespace: n.namespace || null, object: n.kind as never, id: n.name, name: n.name });
  };
  const issues = topo?.issues ?? [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead
        title={t("containers.topo.title")}
        sub={[context, namespace || t("containers.allNamespaces"), topo ? t("containers.topo.count", { nodes: topo.nodes.length, links: topo.edges.length }) : null, issues.length ? t("containers.topo.problems", { count: issues.length }) : null]
          .filter(Boolean)
          .join(" · ")}
      >
        <RowAction label={t("containers.refresh")} onClick={read}>
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </RowAction>
      </PageHead>
      <PageToolbar>
        <SearchField value={query} onChange={setQuery} placeholder={t("containers.topo.search")} />
        <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
          <Checkbox checked={showPods} onChange={setShowPods} />
          {t("containers.topo.showPods")}
        </label>
        <div className="flex-1" />
        {topo && topo.warnings.length > 0 && (
          <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-[var(--cf-warning)]" title={topo.warnings.join("\n")}>
            <AlertTriangle size={11} className="shrink-0" />
            {t("containers.topo.unreadable", { count: topo.warnings.length })}
          </span>
        )}
      </PageToolbar>
      {error && !topo ? (
        <EmptyLine>{error}</EmptyLine>
      ) : !topo ? (
        <LoadingLine />
      ) : topo.nodes.length === 0 ? (
        <EmptyLine>{t("containers.m.kube.none")}</EmptyLine>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1">
            <Suspense fallback={<LoadingLine />}>
              <TopologyCanvas nodes={nodes} edges={edges} bandLabel={(band) => band || t("containers.topo.clusterWide")} selected={picked} onSelect={setPicked} />
            </Suspense>
          </div>
          {(node || issues.length > 0) && (
            <aside className="flex w-[270px] shrink-0 flex-col overflow-y-auto border-l border-[var(--cf-border)] bg-[var(--cf-surface)] p-3 text-[12px]">
              {node ? (
                <NodeInfo topo={topo} node={node} onPick={setPicked} onOpen={open} onClose={() => setPicked(null)} />
              ) : (
                <>
                  <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">{t("containers.topo.problemsTitle")}</h4>
                  {issues.map((issue, i) => {
                    const target = topo.nodes.find((n) => n.id === issue.node);
                    return (
                      <button key={i} onClick={() => setPicked(issue.node)} className="mb-1 flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-[var(--cf-hover)]">
                        <AlertTriangle size={11} className="mt-0.5 shrink-0 text-[var(--cf-warning)]" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-[var(--cf-text)]">
                            {BADGE[target?.kind ?? ""] ?? ""} {target?.name ?? issue.node}
                          </span>
                          <span className="text-[11px] text-[var(--cf-text-muted)]">{issueText(t, issue)}</span>
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

function NodeInfo({ topo, node, onPick, onOpen, onClose }: { topo: KubeTopology; node: TopoNode; onPick: (id: string) => void; onOpen: (node: TopoNode) => void; onClose: () => void }) {
  const t = useT();
  const byId = new Map(topo.nodes.map((n) => [n.id, n]));
  const out = topo.edges.filter((e) => e.from === node.id);
  const into = topo.edges.filter((e) => e.to === node.id);
  const issues = topo.issues.filter((i) => i.node === node.id);
  const link = (id: string, kind: string, label: string, arrow: string) => {
    const other = byId.get(id);
    return (
      <button key={`${arrow}${id}${kind}`} onClick={() => onPick(id)} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-[var(--cf-hover)]">
        <StateDot tone={other?.tone ?? "idle"} />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-[var(--cf-text-muted)]">{arrow} {t(EDGE_LABEL[kind] ?? "containers.topo.edge.routes")} </span>
          <span className="text-[var(--cf-text)]">{BADGE[other?.kind ?? ""] ?? ""} {other?.name ?? id}</span>
          {label && <span className="text-[var(--cf-text-faint)]"> · {label}</span>}
        </span>
      </button>
    );
  };
  return (
    <>
      <div className="mb-2 flex items-start gap-1.5">
        <StateDot tone={node.tone} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-[var(--cf-text)]" title={node.name}>
            {node.name}
          </div>
          <div className="text-[11px] text-[var(--cf-text-muted)]">{[BADGE[node.kind] ?? node.kind, node.namespace, node.missing ? t("containers.topo.missing") : node.status, node.ready].filter(Boolean).join(" · ")}</div>
        </div>
        <RowAction label={t("containers.topo.close")} onClick={onClose}>
          <X size={12} />
        </RowAction>
      </div>
      {node.detail && <p className="mb-2 break-words font-mono text-[11px] text-[var(--cf-text-muted)]">{node.detail}</p>}
      {issues.map((issue, i) => (
        <p key={i} className="mb-2 flex items-start gap-1.5 text-[11.5px] text-[var(--cf-warning)]">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          {issueText(t, issue)}
        </p>
      ))}
      {!node.missing && KUBE_DETAIL_KINDS.has(node.kind) && (
        <Button size="sm" className="mb-3 self-start" onClick={() => onOpen(node)}>
          <ExternalLink size={11} />
          {t("containers.topo.open")}
        </Button>
      )}
      {out.length > 0 && <div className="mb-2">{out.map((e) => link(e.to, e.kind, e.label, "→"))}</div>}
      {into.length > 0 && <div>{into.map((e) => link(e.from, e.kind, e.label, "←"))}</div>}
    </>
  );
}
