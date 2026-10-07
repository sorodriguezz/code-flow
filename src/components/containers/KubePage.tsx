import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { CheckCircle2, Cloud, Crosshair, KeyRound, LogIn, Loader2, MoreHorizontal, Play, Plus, Trash2, XCircle } from "lucide-react";
import { Button } from "../common/Button";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { RowAction, StateDot, ago } from "./containerBits";
import { kubeMenu } from "./containerActions";
import { KubeTestLine, kubeHintText } from "./KubeAddCluster";
import { DataTable, EmptyLine, LiveMark, NO_ROWS, PageHead, PageToolbar, SearchField, Td, Th, trClass } from "./ui";
import { containersKubeAksStatus, containersKubeOrigins, containersKubeRemove, containersKubeTest, containersKubeUseAzureCli } from "../../lib/tauri/containersCommands";
import { confirmAction } from "../../state/confirmStore";
import { useContainersJobsStore } from "../../state/containersJobsStore";
import { listKey, useContainersStore } from "../../state/containersStore";
import { useLanguageStore, useT, type Translate } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { AksStatus, KubeContextOrigin, KubeRow, KubeTest, RuntimeInfo } from "../../types/containers";

/**
 * Kubernetes as tables — one per kind, with the columns `kubectl get` would print for it (a pod's
 * node and restarts, a deployment's replicas and images, a service's IPs and ports) — and the
 * cluster's own page: whether it answers, where its context comes from, and, for the ones added from
 * here, the way to take them out again.
 */

type Column = { label: TranslationKey | string; width?: number; align?: "left" | "right"; render: (row: KubeRow) => ReactNode };

type ServicePort = { name?: string; port?: number; targetPort?: unknown; nodePort?: unknown; protocol?: string };

/** `80:30080/TCP` the way `kubectl get svc` prints a port — the node port only when there is one. */
const portText = (p: ServicePort) => `${p.port ?? ""}${p.nodePort ? `:${String(p.nodePort)}` : ""}/${p.protocol || "TCP"}`;

const text = (value: unknown): string => (value === null || value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value));
const mono = (value: unknown) => <span className="font-mono text-[11.5px] text-[var(--cf-text-muted)]">{text(value) || "—"}</span>;

function columnsOf(kind: string): Column[] {
  switch (kind) {
    case "pods":
      return [
        { label: "containers.m.kube.col.ready", width: 70, render: (r) => r.ready },
        { label: "containers.m.kube.col.restarts", width: 80, align: "right", render: (r) => (r.restarts ? <span className={r.restarts > 5 ? "text-[var(--cf-warning)]" : ""}>{r.restarts}</span> : "0") },
        { label: "containers.m.kube.col.node", render: (r) => mono(r.extra.node) },
        { label: "IP", width: 120, render: (r) => mono(r.extra.ip) },
      ];
    case "deployments":
    case "statefulsets":
      return [
        { label: "containers.m.kube.col.ready", width: 70, render: (r) => r.ready },
        { label: "containers.m.kube.col.upToDate", width: 90, align: "right", render: (r) => text(r.extra.updated) || "0" },
        { label: "containers.m.kube.col.available", width: 90, align: "right", render: (r) => text(r.extra.available) || "0" },
        { label: "containers.m.col.image", render: (r) => mono(r.extra.images) },
      ];
    case "daemonsets":
      return [
        { label: "containers.m.kube.col.ready", width: 70, render: (r) => r.ready },
        { label: "containers.m.col.image", render: (r) => mono(r.extra.images) },
      ];
    case "jobs":
      return [
        { label: "containers.m.kube.col.active", width: 70, align: "right", render: (r) => text(r.extra.active) || "0" },
        { label: "containers.m.kube.col.failed", width: 70, align: "right", render: (r) => text(r.extra.failed) || "0" },
        { label: "containers.m.col.image", render: (r) => mono(r.extra.images) },
      ];
    case "cronjobs":
      return [
        { label: "containers.m.kube.col.schedule", render: (r) => mono(r.extra.schedule) },
        { label: "containers.m.kube.col.suspended", width: 90, render: (r) => (r.extra.suspend ? "✓" : "") },
        { label: "containers.m.kube.col.active", width: 70, align: "right", render: (r) => text(r.extra.active) || "0" },
        { label: "containers.m.kube.col.lastRun", width: 110, render: (r) => <Ago stamp={text(r.extra.lastSchedule)} /> },
      ];
    case "services":
      return [
        { label: "containers.m.kube.col.type", width: 100, render: (r) => text(r.extra.type) },
        { label: "containers.m.kube.col.clusterIp", width: 120, render: (r) => mono(r.extra.clusterIP) },
        { label: "containers.m.kube.col.externalIp", width: 130, render: (r) => mono(r.extra.externalIP) },
        { label: "containers.m.col.ports", render: (r) => mono((Array.isArray(r.extra.ports) ? (r.extra.ports as ServicePort[]) : []).map(portText)) },
      ];
    case "ingresses":
      return [
        { label: "containers.m.kube.col.class", width: 90, render: (r) => text(r.extra.class) },
        { label: "containers.m.kube.col.hosts", render: (r) => mono(r.extra.hosts) },
        { label: "containers.m.kube.col.address", width: 130, render: (r) => mono(r.extra.address) },
        { label: "TLS", width: 50, render: (r) => (r.extra.tls ? "✓" : "") },
      ];
    case "configmaps":
      return [{ label: "containers.m.kube.col.keys", render: (r) => mono(r.extra.keys) }];
    case "secrets":
      return [
        { label: "containers.m.kube.col.type", width: 200, render: (r) => mono(r.extra.type) },
        { label: "containers.m.kube.col.keys", render: (r) => mono(r.extra.keys) },
      ];
    case "persistentvolumeclaims":
      return [
        { label: "containers.m.kube.col.capacity", width: 90, render: (r) => text(r.extra.capacity) },
        { label: "containers.m.kube.col.storageClass", width: 130, render: (r) => mono(r.extra.storageClass) },
        { label: "containers.m.kube.col.volume", render: (r) => mono(r.extra.volume) },
      ];
    case "nodes":
      return [
        { label: "containers.m.kube.col.roles", width: 120, render: (r) => text(r.extra.roles) },
        { label: "containers.m.kube.col.version", width: 100, render: (r) => mono(r.extra.version) },
        { label: "containers.m.kube.col.os", width: 110, render: (r) => mono(r.extra.os) },
        { label: "CPU", width: 50, align: "right", render: (r) => text(r.extra.cpu) },
        { label: "containers.stat.memory", width: 100, align: "right", render: (r) => text(r.extra.memory) },
        { label: "IP", width: 120, render: (r) => mono(r.extra.internalIP) },
      ];
    case "events":
      return [
        { label: "containers.m.kube.col.object", width: 200, render: (r) => mono(r.extra.object) },
        { label: "containers.m.kube.col.message", render: (r) => <span className="line-clamp-2 text-[11.5px] text-[var(--cf-text-muted)]">{text(r.extra.message)}</span> },
      ];
    default:
      return [];
  }
}

function Ago({ stamp }: { stamp: string }) {
  const language = useLanguageStore((s) => s.language);
  return <span className="text-[var(--cf-text-muted)]">{stamp ? ago(stamp, language) : "—"}</span>;
}

/** One kind of one cluster as a table. */
export function KubeKindPage({ kind }: { kind: string }) {
  const t = useT();
  const context = useContainersStore((s) => s.contextOf("kubernetes"));
  const namespace = useContainersStore((s) => s.namespaceOf(context));
  const list = useContainersStore((s) => s.lists[listKey("kubernetes", context, s.namespaceOf(context), kind)]);
  const reach = useContainersStore((s) => s.reach[context ?? ""]);
  const act = useContainersStore((s) => s.act);
  const select = useContainersStore((s) => s.select);
  const setNav = useContainersStore((s) => s.setNav);
  const rows = (list?.rows ?? NO_ROWS) as KubeRow[];
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const columns = useMemo(() => columnsOf(kind), [kind]);
  const cluster = kind === "nodes" || kind === "namespaces";
  const showNamespace = !cluster && !namespace;
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(needle) || r.namespace.toLowerCase().includes(needle) || r.status.toLowerCase().includes(needle));
  }, [rows, query]);
  const open = (row: KubeRow) => select({ runtime: "kubernetes", context, namespace: row.namespace || null, object: kind as never, id: row.name, name: row.name });
  const openMenu = (event: ReactMouseEvent, row: KubeRow) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: event.type === "contextmenu" ? event.clientX : rect.left,
      y: event.type === "contextmenu" ? event.clientY : rect.bottom + 2,
      items: kubeMenu({ kind, row, context, t, act, select: () => open(row) }),
    });
  };
  const failing = rows.filter((r) => r.tone === "bad").length;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead
        title={t(`containers.kind.${kind}` as TranslationKey)}
        sub={[context, cluster ? null : namespace || t("containers.allNamespaces"), rows.length ? String(rows.length) : null, failing ? t("containers.m.kube.failing", { count: failing }) : null].filter(Boolean).join(" · ")}
      />
      <PageToolbar>
        <SearchField value={query} onChange={setQuery} placeholder={t("containers.m.kube.search")} />
        <div className="flex-1" />
        {reach?.ok !== false && <LiveMark />}
      </PageToolbar>
      {reach && !reach.ok ? (
        <EmptyLine>
          {t("containers.clusterUnreachable", { reason: reach.text })}{" "}
          {/* The cluster's page tries it again and words what went wrong, with what fixes it. */}
          <button onClick={() => setNav({ runtime: "kubernetes", section: "overview" })} className="text-[var(--cf-accent)] hover:underline">
            {t("containers.m.kube.seeWhy")}
          </button>
        </EmptyLine>
      ) : list?.error ? (
        <EmptyLine>{list.error}</EmptyLine>
      ) : shown.length === 0 ? (
        <EmptyLine>{!list ? t("containers.m.loading") : rows.length ? t("containers.m.kube.noMatch") : t("containers.m.kube.none")}</EmptyLine>
      ) : (
        <DataTable minWidth={720}>
          <thead>
            <tr>
              <Th>{t("containers.m.col.name")}</Th>
              {showNamespace && <Th width={140}>{t("containers.namespace")}</Th>}
              <Th width={150}>{t("containers.m.col.state")}</Th>
              {columns.map((c) => (
                <Th key={String(c.label)} width={c.width} align={c.align}>
                  {String(c.label).startsWith("containers.") ? t(c.label as TranslationKey) : c.label}
                </Th>
              ))}
              <Th width={70}>{t("containers.m.kube.col.age")}</Th>
              <Th align="right" width={40} />
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={`${row.namespace}/${row.name}`} className={trClass(false)} onClick={() => open(row)} onContextMenu={(e) => openMenu(e, row)}>
                <Td className="max-w-[280px]">
                  <span className="block truncate font-medium text-[var(--cf-text)]" title={row.name}>
                    {row.name}
                  </span>
                </Td>
                {showNamespace && <Td>{mono(row.namespace)}</Td>}
                <Td>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <StateDot tone={row.tone} />
                    <span className={`truncate ${row.tone === "bad" ? "text-[var(--cf-danger)]" : "text-[var(--cf-text)]"}`} title={row.status}>
                      {row.status || "—"}
                    </span>
                  </span>
                </Td>
                {columns.map((c) => (
                  <Td key={String(c.label)} align={c.align}>
                    {c.render(row)}
                  </Td>
                ))}
                <Td>
                  <Ago stamp={row.created} />
                </Td>
                <Td align="right">
                  <RowAction label={t("containers.m.moreActions")} onClick={(e) => openMenu(e, row)}>
                    <MoreHorizontal size={13} />
                  </RowAction>
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** The cluster's page: does it answer, what it runs, where its context lives, and removal. */
export function KubeOverviewPage({ runtime, onAddCluster }: { runtime: RuntimeInfo; onAddCluster: () => void }) {
  const t = useT();
  const context = useContainersStore((s) => s.contextOf("kubernetes"));
  const setContext = useContainersStore((s) => s.setContext);
  const detect = useContainersStore((s) => s.detect);
  const act = useContainersStore((s) => s.act);
  const checkReach = useContainersStore((s) => s.checkReach);
  const startJob = useContainersJobsStore((s) => s.start);
  const history = useContainersJobsStore((s) => s.history);
  const [origins, setOrigins] = useState<KubeContextOrigin[] | null>(null);
  const [tests, setTests] = useState<Record<string, KubeTest | "testing">>({});
  const [switching, setSwitching] = useState<string | null>(null);
  const loadOrigins = () =>
    containersKubeOrigins()
      .then(setOrigins)
      .catch(() => setOrigins([]));
  useEffect(() => {
    void loadOrigins();
  }, [runtime.contexts.length]);
  const test = async (name: string) => {
    setTests((all) => ({ ...all, [name]: "testing" }));
    const result = await containersKubeTest(name).catch((e: unknown) => ({ ok: false, version: null, error: String(e), hint: null }) as KubeTest);
    setTests((all) => ({ ...all, [name]: result }));
  };
  // The cluster on screen is tried once by itself; the rest when asked.
  useEffect(() => {
    if (context && tests[context] === undefined) void test(context);
  }, [context]); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async (name: string) => {
    if (!(await confirmAction(t("containers.m.kube.confirmRemove", { name }), true, t("containers.remove")))) return;
    try {
      await containersKubeRemove(name);
      pushSuccessToast(t("containers.m.kube.removed", { name }));
      await detect();
      void loadOrigins();
    } catch (e) {
      pushErrorToast(String(e));
    }
  };
  const originOf = (name: string) => origins?.find((o) => o.context === name);
  /** Tried again, here and in the navigation's dot, once its sign-in is sorted. */
  const retry = (name: string) => {
    void test(name);
    void checkReach(name);
  };
  // A device code shows in the jobs panel, where the person signs in; the token kubelogin then
  // keeps is what every later kubectl uses. A sign-in — or a cluster started in Azure — tries the
  // cluster again when it ends, however it ended: the row then says what stands in the way now.
  const signIn = (name: string) =>
    void startJob(t("containers.m.kube.signingIn", { name }), { kind: "kubeLogin", runtime: "kubernetes", context: name, target: name }, { meta: { context: name } });
  const lastSeen = useRef(Date.now());
  useEffect(() => {
    const fresh = history.filter((past) => (past.kind === "kubeLogin" || past.kind === "aksStart") && past.at > lastSeen.current);
    if (fresh.length === 0) return;
    lastSeen.current = Math.max(...fresh.map((past) => past.at));
    for (const past of fresh) if (past.meta.context) retry(past.meta.context);
  }, [history]); // eslint-disable-line react-hooks/exhaustive-deps
  /** `az aks start` for a cluster Azure says is stopped — minutes of work, and costs again once it
   *  runs, so it asks first. */
  const startAks = async (context: string, status: AksStatus) => {
    const where = aksWhere(status);
    if (!(await confirmAction(t("containers.m.kube.aks.startConfirm", { name: status.name, where }), false, t("containers.m.kube.aks.startConfirmButton")))) return;
    void startJob(
      t("containers.m.kube.aks.starting", { name: status.name }),
      { kind: "aksStart", runtime: "kubernetes", context, target: status.name, resourceGroup: status.resourceGroup, subscription: status.subscription },
      { meta: { context } },
    );
  };
  /** Microsoft's own fix for a device code nobody sees: kubelogin rewrites the user to sign in with
   *  `az login`'s session — in the user's kubeconfig, so it asks first. */
  const switchToAzureCli = async (name: string) => {
    const file = originOf(name)?.file || "~/.kube/config";
    if (!(await confirmAction(t("containers.m.kube.azureCliConfirm", { name, file }), false, t("containers.m.kube.azureCliConfirmButton")))) return;
    setSwitching(name);
    try {
      await containersKubeUseAzureCli(name);
      pushSuccessToast(t("containers.m.kube.azureCliDone", { name }));
      retry(name);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSwitching(null);
    }
  };
  /** Makes it the context of every kubectl on this computer — only one of the user's own: a cluster
   *  added here lives in CodeFlow's kubeconfig, which a terminal's kubectl does not read. */
  const pointKubectl = (name: string) =>
    void act({ runtime: "kubernetes", context: name, object: "contexts", action: "useContext", ids: [name], label: t("containers.done.useContext", { name }), refresh: [] }).then(() => void detect());
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("containers.m.kube.clusters")} sub={runtime.version ? `kubectl ${runtime.version}` : undefined}>
        <Button size="sm" variant="primary" onClick={onAddCluster}>
          <Plus size={13} />
          {t("containers.m.addCluster")}
        </Button>
      </PageHead>
      {runtime.contexts.length === 0 ? (
        <EmptyLine>{t("containers.noContexts")}</EmptyLine>
      ) : (
        <DataTable minWidth={680}>
          <thead>
            <tr>
              <Th>{t("containers.m.cluster")}</Th>
              <Th>{t("containers.m.kube.col.server")}</Th>
              <Th width={200}>{t("containers.m.kube.col.connection")}</Th>
              <Th width={170}>{t("containers.m.kube.col.origin")}</Th>
              <Th align="right" width={150} />
            </tr>
          </thead>
          <tbody>
            {runtime.contexts.map((c) => {
              const result = tests[c.name];
              const origin = originOf(c.name);
              const failed = result && result !== "testing" && !result.ok ? result : null;
              return (
                <Fragment key={c.name}>
                <tr className={trClass(c.name === context)}>
                  <Td>
                    <button onClick={() => setContext("kubernetes", c.name)} className="flex min-w-0 items-center gap-1.5 text-left">
                      <span className="truncate font-medium text-[var(--cf-text)]">{c.name}</span>
                      {c.name === runtime.currentContext && (
                        <span className="shrink-0 rounded bg-[var(--cf-hover)] px-1 text-[10px] text-[var(--cf-text-muted)]" title={t("containers.m.kube.currentHint")}>
                          {t("containers.m.kube.current")}
                        </span>
                      )}
                    </button>
                  </Td>
                  <Td className="max-w-[260px]">
                    <span className="block truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]" title={c.detail}>
                      {c.detail || "—"}
                    </span>
                  </Td>
                  <Td>
                    {result === "testing" ? (
                      <span className="flex items-center gap-1.5 text-[var(--cf-text-muted)]">
                        <Loader2 size={11} className="animate-spin" />
                        {t("containers.connecting")}
                      </span>
                    ) : result?.ok ? (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <CheckCircle2 size={12} className="shrink-0 text-[var(--cf-success)]" />
                        <span className="truncate text-[var(--cf-text)]">{result.version ? `Kubernetes ${result.version}` : t("containers.m.kube.reachable")}</span>
                      </span>
                    ) : failed ? (
                      <span className="flex min-w-0 items-center gap-1.5" title={[kubeHintText(t, failed.hint), failed.error].filter(Boolean).join("\n")}>
                        <XCircle size={12} className="shrink-0 text-[var(--cf-danger)]" />
                        <span className="truncate text-[var(--cf-danger)]">{t("containers.m.kube.unreachable")}</span>
                      </span>
                    ) : (
                      <span className="text-[var(--cf-text-faint)]">—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="truncate text-[11.5px] text-[var(--cf-text-muted)]" title={origin?.file}>
                      {origin ? (origin.managed ? t("containers.m.kube.addedHere") : t("containers.m.kube.yourKubeconfig")) : "—"}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => void test(c.name)} disabled={result === "testing"}>
                        {t("containers.m.kube.test")}
                      </Button>
                      {origin && !origin.managed && c.name !== runtime.currentContext && (
                        <RowAction label={t("containers.kube.useContext")} onClick={() => pointKubectl(c.name)}>
                          <Crosshair size={12} />
                        </RowAction>
                      )}
                      {origin?.managed && (
                        <RowAction label={t("containers.m.kube.remove")} danger onClick={() => void remove(c.name)}>
                          <Trash2 size={12} />
                        </RowAction>
                      )}
                    </span>
                  </Td>
                </tr>
                {failed && (
                  <tr>
                    <td colSpan={5} className="border-b border-[color-mix(in_srgb,var(--cf-border)_55%,transparent)] px-3 pb-2.5 pt-1.5">
                      <KubeTestLine test={failed} />
                      {failed.hint === "azDeviceCode" && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <Button size="sm" variant="secondary" onClick={() => signIn(c.name)} title={t("containers.m.kube.signInHint")}>
                            <LogIn size={12} />
                            {t("containers.m.kube.signIn")}
                          </Button>
                          <Button size="sm" variant="secondary" disabled={switching === c.name} onClick={() => void switchToAzureCli(c.name)} title={t("containers.m.kube.azureCliHint")}>
                            {switching === c.name ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
                            {t("containers.m.kube.azureCli")}
                          </Button>
                        </div>
                      )}
                      {(failed.hint === "aksDns" || failed.hint === "aksUnreachable") && <AksCheck context={c.name} onStart={(status) => void startAks(c.name, status)} />}
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}

/** Where an AKS cluster lives: its resource group and subscription. */
function aksWhere(status: AksStatus): string {
  return [status.resourceGroup, status.subscriptionName || status.subscription].filter(Boolean).join(" · ");
}

/** What Azure's answer means for a cluster that does not answer — the first that applies. */
function aksVerdict(t: Translate, status: AksStatus): string {
  if (!status.found) return t("containers.m.kube.aks.notFound", { name: status.name });
  const where = aksWhere(status);
  if (status.power === "Stopped") return t("containers.m.kube.aks.stopped", { where });
  if (/^(starting|stopping|updating|upgrading|creating|deleting|scaling)$/i.test(status.provisioning)) return t("containers.m.kube.aks.busy", { state: status.provisioning, where });
  if (!status.addressCurrent) return t("containers.m.kube.aks.moved", { where });
  if (status.private) return t("containers.m.kube.aks.private", { where });
  if (status.authorizedRanges.length > 0) return t("containers.m.kube.aks.ranges", { ranges: status.authorizedRanges.join(", "), where });
  return t("containers.m.kube.aks.running", { where });
}

/**
 * «Revisar en Azure» under an AKS cluster that does not answer: `az` is asked what became of it —
 * stopped, private, behind a list of addresses, moved to a new one, or gone — and a stopped one can
 * be started from here.
 */
function AksCheck({ context, onStart }: { context: string; onStart: (status: AksStatus) => void }) {
  const t = useT();
  const [state, setState] = useState<AksStatus | "checking" | { error: string } | null>(null);
  const check = async () => {
    setState("checking");
    try {
      setState(await containersKubeAksStatus(context));
    } catch (e) {
      setState({ error: String(e) });
    }
  };
  const status = state && state !== "checking" && !("error" in state) ? state : null;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="secondary" disabled={state === "checking"} onClick={() => void check()} title={t("containers.m.kube.aks.checkHint")}>
          {state === "checking" ? <Loader2 size={12} className="animate-spin" /> : <Cloud size={12} />}
          {t("containers.m.kube.aks.check")}
        </Button>
        {status?.found && status.power === "Stopped" && (
          <Button size="sm" variant="secondary" onClick={() => onStart(status)}>
            <Play size={12} />
            {t("containers.m.kube.aks.start")}
          </Button>
        )}
      </div>
      {status && <p className="text-[12px] leading-snug text-[var(--cf-text)]">{aksVerdict(t, status)}</p>}
      {state && state !== "checking" && "error" in state && <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-[var(--cf-danger)]">{state.error}</p>}
    </div>
  );
}
