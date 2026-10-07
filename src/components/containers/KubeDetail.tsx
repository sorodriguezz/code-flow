import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRightLeft, Check, Eye, EyeOff, ExternalLink, Loader2, Play, RefreshCw, RotateCw, Scaling, Trash2 } from "lucide-react";
import { Select } from "../common/Select";
import { Checkbox } from "../common/Checkbox";
import { SessionPane } from "./SessionPane";
import { BackButton, DetailHeader, NO_ROWS } from "./ContainersDetail";
import { DetailTabs, Facts, HeaderAction, RowAction, SectionTitle, StateDot, TextView, ago } from "./containerBits";
import { kubeMenu, kubePorts } from "./containerActions";
import { containersApply, containersText } from "../../lib/tauri/containersCommands";
import { openExternalUrl } from "../../lib/tauri/commands";
import { confirmAction } from "../../state/confirmStore";
import { listKey, useContainersStore } from "../../state/containersStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ContainerSelection, KubeRow } from "../../types/containers";

type KubeTab = "logs" | "terminal" | "info" | "describe" | "yaml";

/** The tabs a kind has: logs where something prints, a shell where something runs. */
function tabsFor(kind: string): KubeTab[] {
  switch (kind) {
    case "pods":
      return ["logs", "terminal", "info", "describe", "yaml"];
    case "deployments":
    case "statefulsets":
    case "daemonsets":
    case "jobs":
      return ["info", "logs", "describe", "yaml"];
    case "events":
      return ["info"];
    default:
      return ["info", "describe", "yaml"];
  }
}

function singular(kind: string) {
  return kind.replace(/s$/, "");
}

export function KubeDetail({ selection }: { selection: ContainerSelection }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const kind = selection.object;
  const namespace = useContainersStore((s) => s.namespaceOf(selection.context));
  const row = useContainersStore((s) =>
    ((s.lists[listKey("kubernetes", selection.context, namespace, kind)]?.rows ?? []) as KubeRow[]).find((r) => r.name === selection.id && (r.namespace || null) === (selection.namespace || null)),
  );
  const act = useContainersStore((s) => s.act);
  const select = useContainersStore((s) => s.select);
  const tabs = tabsFor(kind);
  const [tab, setTab] = useState<KubeTab>(tabs[0]);
  const [visited, setVisited] = useState<Set<KubeTab>>(new Set([tabs[0]]));
  const containers = (row?.extra.containers as { name: string; image: string; ready: boolean; restarts: number; state: string; lastState: string }[] | undefined) ?? [];
  const [container, setContainer] = useState<string>("");
  const [previous, setPrevious] = useState(false);
  useEffect(() => setVisited((v) => (v.has(tab) ? v : new Set([...v, tab]))), [tab]);
  if (!row) return <p className="p-4 text-[12px] text-[var(--cf-text-muted)]">{t("containers.gone")}</p>;

  // Its actions go to the context it was selected in — never to whatever kubeconfig says now.
  const menu = kubeMenu({ kind, row, context: selection.context, t, act, select: () => select(selection) });
  const byLabel = (key: TranslationKey) => menu.find((item) => item.label === t(key));
  const ns = row.namespace || null;
  const logTarget = kind === "pods" ? row.name : `${singular(kind)}/${row.name}`;
  const ports = kubePorts(kind, row);

  const headerActions: ReactNode[] = [];
  const scale = byLabel("containers.kube.scale");
  const restart = byLabel("containers.kube.restart");
  const trigger = byLabel("containers.kube.trigger");
  const forward = byLabel("containers.kube.portForward");
  if (scale) headerActions.push(<HeaderAction key="scale" icon={<Scaling size={11} />} label={t("containers.kube.scale")} onClick={scale.onClick} />);
  if (restart) headerActions.push(<HeaderAction key="restart" icon={<RotateCw size={11} />} label={t("containers.kube.restart")} onClick={restart.onClick} />);
  if (trigger) headerActions.push(<HeaderAction key="trigger" icon={<Play size={11} />} label={t("containers.kube.trigger")} onClick={trigger.onClick} />);
  if (forward) headerActions.push(<HeaderAction key="forward" icon={<ArrowRightLeft size={11} />} label={t("containers.kube.portForward")} onClick={forward.onClick} />);
  const remove = menu.find((item) => item.danger);
  if (remove && kind === "pods") headerActions.push(<HeaderAction key="delete" danger icon={<Trash2 size={11} />} label={t("containers.kube.delete")} onClick={remove.onClick} />);

  return (
    <>
      <DetailHeader
        leading={
          <span className="flex items-center gap-1.5">
            <BackButton label={t("containers.m.backToList")} />
            <StateDot tone={row.tone} title={row.status} />
          </span>
        }
        title={kind === "events" ? row.status : row.name}
        subtitle={[t(`containers.kind.${kind}` as TranslationKey), row.namespace, row.status, row.ready && `${t("containers.fact.ready")} ${row.ready}`, row.restarts ? `↻ ${row.restarts}` : null, row.created && ago(row.created, language)]
          .filter(Boolean)
          .join(" · ")}
        menu={menu}
      >
        {headerActions}
      </DetailHeader>
      <DetailTabs
        tabs={tabs.map((id) => ({ id, label: t(`containers.tab.${id}` as TranslationKey) }))}
        value={tab}
        onChange={setTab}
        trailing={
          kind === "pods" && (tab === "logs" || tab === "terminal") ? (
            <span className="flex items-center gap-2 text-[11px] text-[var(--cf-text-muted)]">
              {tab === "logs" && (
                <label className="flex items-center gap-1">
                  <Checkbox checked={previous} onChange={setPrevious} />
                  {t("containers.previous")}
                </label>
              )}
              {containers.length > 1 && (
                <div className="w-[140px]">
                  <Select
                    size="sm"
                    value={container}
                    onChange={setContainer}
                    options={[...(tab === "logs" ? [{ value: "", label: t("containers.allContainers") }] : []), ...containers.map((c) => ({ value: c.name, label: c.name }))]}
                    ariaLabel={t("containers.container")}
                  />
                </div>
              )}
            </span>
          ) : null
        }
      />
      <div className="relative flex min-h-0 flex-1">
        {visited.has("logs") && tabs.includes("logs") && (
          <SessionPane
            visible={tab === "logs"}
            liveToken={`${row.restarts ?? 0}|${row.status}`}
            request={{ kind: "logs", runtime: "kubernetes", context: selection.context, namespace: ns, target: logTarget, container: container || null, tail: 500, previous }}
          />
        )}
        {visited.has("terminal") && tabs.includes("terminal") && (
          <SessionPane
            visible={tab === "terminal"}
            request={{ kind: "exec", runtime: "kubernetes", context: selection.context, namespace: ns, target: row.name, container: container || containers[0]?.name || null }}
          />
        )}
        {tab === "info" && <KubeInfo kind={kind} row={row} ports={ports} selection={selection} />}
        {(tab === "describe" || tab === "yaml") && <KubeText key={tab} selection={selection} kind={kind} name={row.name} namespace={ns} view={tab} />}
      </div>
    </>
  );
}

function KubeInfo({ kind, row, ports, selection }: { kind: string; row: KubeRow; ports: number[]; selection: ContainerSelection }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  // Both derived outside the selectors, which must return what the store already holds (see `NO_ROWS`).
  const allForwards = useContainersStore((s) => s.forwards);
  const forwards = useMemo(
    () => allForwards.filter((f) => f.name === row.name && f.namespace === row.namespace && f.kind === kind),
    [allForwards, row.name, row.namespace, kind],
  );
  const pods = (useContainersStore((s) => s.lists[listKey("kubernetes", selection.context, s.namespaceOf(selection.context), "pods")]?.rows) ?? NO_ROWS) as KubeRow[];
  const select = useContainersStore((s) => s.select);
  const e = row.extra;
  const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]).map(String).join(", ") : value ? String(value) : null);
  const selector = (e.selector as Record<string, string> | undefined) ?? {};
  const owned = useMemo(() => {
    const entries = Object.entries(selector);
    if (!entries.length || !["deployments", "statefulsets", "daemonsets", "services", "jobs"].includes(kind)) return [];
    return pods.filter((p) => p.namespace === row.namespace && entries.every(([k, v]) => p.labels[k] === v));
  }, [pods, selector, kind, row.namespace]);
  const rows: [string, ReactNode][] = [
    [t("containers.fact.namespace"), row.namespace || null],
    [t("containers.fact.status"), row.status],
    [t("containers.fact.ready"), row.ready || null],
    [t("containers.fact.restarts"), row.restarts !== null && kind === "pods" ? String(row.restarts) : null],
    [t("containers.fact.created"), row.created ? `${new Date(row.created).toLocaleString()} (${ago(row.created, language)})` : null],
  ];
  switch (kind) {
    case "pods":
      rows.push([t("containers.fact.node"), list(e.node)], [t("containers.fact.ip"), list(e.ip)], [t("containers.fact.owner"), list(e.owner)]);
      break;
    case "deployments":
    case "statefulsets":
      rows.push([t("containers.fact.replicas"), list(e.replicas)], [t("containers.fact.updated"), list(e.updated)], [t("containers.fact.available"), list(e.available)], [t("containers.fact.images"), list(e.images)]);
      break;
    case "daemonsets":
    case "jobs":
      rows.push([t("containers.fact.images"), list(e.images)]);
      if (kind === "jobs") rows.push([t("containers.fact.failed"), list(e.failed)], [t("containers.fact.active"), list(e.active)]);
      break;
    case "cronjobs":
      rows.push([t("containers.fact.schedule"), <span className="font-mono">{list(e.schedule)}</span>], [t("containers.fact.lastSchedule"), e.lastSchedule ? new Date(String(e.lastSchedule)).toLocaleString() : null], [t("containers.fact.active"), list(e.active)]);
      break;
    case "services":
      rows.push([t("containers.fact.type"), list(e.type)], [t("containers.fact.clusterIP"), list(e.clusterIP)], [t("containers.fact.externalIP"), list(e.externalIP)]);
      break;
    case "ingresses":
      rows.push(
        [t("containers.fact.class"), list(e.class)],
        [
          t("containers.fact.hosts"),
          ((e.hosts as string[] | undefined) ?? []).length ? (
            <span className="flex flex-wrap gap-2">
              {(e.hosts as string[]).map((host) => (
                <button key={host} onClick={() => void openExternalUrl(`${e.tls ? "https" : "http"}://${host}`)} className="inline-flex items-center gap-1 text-[var(--cf-accent)] hover:underline">
                  {host}
                  <ExternalLink size={9} />
                </button>
              ))}
            </span>
          ) : null,
        ],
        [t("containers.fact.address"), list(e.address)],
      );
      break;
    case "configmaps":
    case "secrets":
      rows.push([t("containers.fact.keys"), list(e.keys)], [t("containers.fact.type"), kind === "secrets" ? list(e.type) : null]);
      break;
    case "persistentvolumeclaims":
      rows.push([t("containers.fact.capacity"), list(e.capacity)], [t("containers.fact.volume"), list(e.volume)], [t("containers.fact.storageClass"), list(e.storageClass)], [t("containers.fact.accessModes"), list(e.accessModes)]);
      break;
    case "nodes":
      rows.push([t("containers.fact.roles"), list(e.roles)], [t("containers.fact.version"), list(e.version)], [t("containers.fact.ip"), list(e.internalIP)], [t("containers.fact.os"), list(e.os)], [t("containers.fact.cpu"), list(e.cpu)], [t("containers.fact.memory"), list(e.memory)]);
      break;
    case "events":
      rows.push([t("containers.fact.type"), list(e.type)], [t("containers.fact.object"), list(e.object)], [t("containers.fact.message"), list(e.message)], [t("containers.fact.count"), row.restarts ? String(row.restarts) : null]);
      break;
  }
  const podContainers = (e.containers as { name: string; image: string; ready: boolean; restarts: number; state: string; lastState: string }[] | undefined) ?? [];
  const conditions = (e.conditions as { type: string; status: string; reason: string; message: string }[] | undefined) ?? [];
  const servicePorts = (e.ports as { name: string; port: number; targetPort: unknown; nodePort: unknown; protocol: string }[] | undefined) ?? [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <Facts rows={rows} />
      {podContainers.length > 0 && (
        <>
          <SectionTitle>{t("containers.fact.containers")}</SectionTitle>
          <table className="w-full text-[12px]">
            <tbody>
              {podContainers.map((c) => (
                <tr key={c.name}>
                  <td className="w-4 py-0.5">
                    <StateDot tone={c.ready ? "ok" : c.state.startsWith("running") ? "warn" : "bad"} />
                  </td>
                  <td className="py-0.5 pr-3 text-[var(--cf-text)]">{c.name}</td>
                  <td className="py-0.5 pr-3 font-mono text-[11px] text-[var(--cf-text-muted)]">{c.image}</td>
                  <td className="py-0.5 pr-3 text-[var(--cf-text-muted)]">{c.state}</td>
                  <td className="py-0.5 text-[var(--cf-text-muted)]">{c.restarts ? `↻ ${c.restarts}${c.lastState ? ` (${c.lastState})` : ""}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {servicePorts.length > 0 && (
        <>
          <SectionTitle>{t("containers.fact.ports")}</SectionTitle>
          <ul className="flex flex-col gap-0.5 font-mono text-[11.5px] text-[var(--cf-text)]">
            {servicePorts.map((p) => (
              <li key={`${p.port}/${p.protocol}`}>
                {p.name ? `${p.name}: ` : ""}
                {p.port}
                {p.targetPort !== null && p.targetPort !== undefined ? ` → ${String(p.targetPort)}` : ""}
                {p.nodePort ? ` (node ${String(p.nodePort)})` : ""} /{p.protocol}
              </li>
            ))}
          </ul>
        </>
      )}
      {conditions.length > 0 && (
        <>
          <SectionTitle>{t("containers.fact.conditions")}</SectionTitle>
          <ul className="flex flex-col gap-0.5 text-[11.5px]">
            {conditions.map((c) => (
              <li key={c.type} className="flex items-center gap-2" title={c.message}>
                {c.status === "True" ? <Check size={11} className="text-[var(--cf-success)]" /> : <StateDot tone="warn" />}
                <span className="text-[var(--cf-text)]">{c.type}</span>
                <span className="truncate text-[var(--cf-text-muted)]">{c.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {owned.length > 0 && (
        <>
          <SectionTitle>{t("containers.kind.pods")}</SectionTitle>
          <ul className="flex flex-col gap-0.5 text-[12px]">
            {owned.map((p) => (
              <li key={p.name}>
                <button onClick={() => select({ runtime: "kubernetes", context: selection.context, namespace: p.namespace || null, object: "pods", id: p.name, name: p.name })} className="flex items-center gap-2 hover:underline">
                  <StateDot tone={p.tone} />
                  <span className="text-[var(--cf-text)]">{p.name}</span>
                  <span className="text-[var(--cf-text-muted)]">
                    {p.status} · {p.ready}
                    {p.restarts ? ` · ↻${p.restarts}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {ports.length > 0 && forwards.length > 0 && (
        <>
          <SectionTitle>{t("containers.section.forwards")}</SectionTitle>
          <ul className="flex flex-col gap-0.5 text-[12px]">
            {forwards.map((f) => (
              <li key={f.id} className="flex items-center gap-2">
                <StateDot tone={f.status === "active" ? "ok" : "bad"} />
                <button onClick={() => void openExternalUrl(`http://localhost:${f.localPort}`)} className="text-[var(--cf-accent)] hover:underline">
                  localhost:{f.localPort}
                </button>
                <span className="text-[var(--cf-text-muted)]">→ {f.remotePort}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {Object.keys(row.labels).length > 0 && (
        <>
          <SectionTitle>{t("containers.fact.labels")}</SectionTitle>
          <ul className="flex flex-col gap-0.5 font-mono text-[11px] text-[var(--cf-text-muted)]">
            {Object.entries(row.labels).map(([k, v]) => (
              <li key={k} className="truncate">
                {k}=<span className="text-[var(--cf-text)]">{v}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** `kubectl describe`, or the object's YAML — which can be edited and applied back. */
function KubeText({ selection, kind, name, namespace, view }: { selection: ContainerSelection; kind: string; name: string; namespace: string | null; view: "describe" | "yaml" }) {
  const t = useT();
  const refreshList = useContainersStore((s) => s.refreshList);
  const [text, setText] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [tick, setTick] = useState(0);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    containersText({ runtime: "kubernetes", context: selection.context, namespace, object: kind, id: name, view, reveal })
      .then((value) => {
        if (cancelled) return;
        setText(value);
        setDraft(null);
      })
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [selection.context, namespace, kind, name, view, reveal, tick]);
  const dirty = draft !== null && draft !== text;
  // A masked Secret cannot be applied back: its values are dots.
  const editable = view === "yaml" && !(kind === "secrets" && !reveal);
  const apply = async () => {
    if (!dirty || !draft) return;
    const ok = await confirmAction(t("containers.kube.confirmApply", { context: selection.context ?? "" }), false, t("containers.kube.apply"));
    if (!ok) return;
    setApplying(true);
    try {
      const out = await containersApply(selection.context, namespace, draft);
      pushSuccessToast(out || t("containers.kube.applied"));
      setTick((n) => n + 1);
      void refreshList("kubernetes", kind);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setApplying(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-1 px-2 pt-1">
        {view === "yaml" && kind === "secrets" && (
          <button onClick={() => setReveal((r) => !r)} className="mr-auto flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
            {reveal ? <EyeOff size={11} /> : <Eye size={11} />}
            {reveal ? t("containers.hideValues") : t("containers.showValues")}
          </button>
        )}
        {editable && dirty && (
          <HeaderAction primary icon={applying ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} label={t("containers.kube.apply")} disabled={applying} onClick={() => void apply()} />
        )}
        <RowAction label={t("containers.refresh")} onClick={() => setTick((n) => n + 1)}>
          <RefreshCw size={11} />
        </RowAction>
      </div>
      {error ? (
        <p className="p-4 text-[12px] text-[var(--cf-danger)]">{error}</p>
      ) : text === null ? (
        <div className="flex flex-1 items-center justify-center text-[var(--cf-text-muted)]">
          <Loader2 size={14} className="animate-spin" />
        </div>
      ) : (
        <TextView value={draft ?? text} language={view === "yaml" ? "yaml" : "plaintext"} editable={editable} onChange={setDraft} />
      )}
    </div>
  );
}
