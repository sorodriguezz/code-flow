import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Loader2, Play, Plus, RefreshCw, Square, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "../common/Button";
import { ToolInstallationLink } from "../common/ToolInstallationLink";
import { Segmented } from "../common/Segmented";
import { chipClass, fieldClass, sectionLabelClass } from "../common/recipes";
import { RowAction, StateDot } from "./containerBits";
import { Field } from "./ui";
import { LOCAL_TOOLS, MAX_WORKERS, freeClusterName, localContextOf, localTone, validClusterName } from "./localModel";
import { containersLocalPreview } from "../../lib/tauri/containersLocalCommands";
import { confirmAction } from "../../state/confirmStore";
import { useContainersJobsStore } from "../../state/containersJobsStore";
import { useContainersStore } from "../../state/containersStore";
import { useLocalClustersStore } from "../../state/localClustersStore";
import { useT, type Translate } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { LocalAction, LocalCluster, LocalClusterSpec, LocalTool } from "../../types/containersLocal";

/**
 * Kubernetes on this computer — kind, k3d or minikube, through their own CLIs (`containers/local.rs`).
 * «Agregar clúster» has a «Local» source that makes one; the clusters' page lists them under the
 * contexts with what only their tool can do (start, stop, delete). Everything else about a local
 * cluster is the Kubernetes pages': its context is in the user's kubeconfig like any other.
 */

const TOOL_HINT: Record<LocalTool, TranslationKey> = {
  kind: "containers.local.tool.kindHint",
  k3d: "containers.local.tool.k3dHint",
  minikube: "containers.local.tool.minikubeHint",
};

const VERSION_PLACEHOLDER: Record<LocalTool, string> = { kind: "v1.31.0", k3d: "v1.31.4-k3s1", minikube: "v1.31.0" };

export function InstallHint({ tool, onOpen }: { tool: LocalTool | "helm"; onOpen?: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
      <TriangleAlert size={13} className="shrink-0 text-[var(--cf-warning)]" />
      {t("installations.missingTool", { tool })}
      <ToolInstallationLink tool={tool} onOpen={onOpen} />
    </div>
  );
}

/** The jobs still running for one cluster — its buttons wait for them. */
function useBusy(cluster: { tool: string; name: string }): boolean {
  return useContainersJobsStore((s) => s.jobs.some((j) => !j.ended && j.request.kind === "localCluster" && j.options.meta?.tool === cluster.tool && j.options.meta?.name === cluster.name));
}

function jobTitle(t: Translate, action: LocalAction, tool: LocalTool, name: string): string {
  return t(`containers.local.job.${action}` as TranslationKey, { tool, name });
}

/** The «Local» source of «Agregar clúster»: which tool, the cluster's name and shape, the command. */
export function LocalClusterPane({ onClose }: { onClose: () => void }) {
  const t = useT();
  const tools = useLocalClustersStore((s) => s.tools);
  const list = useLocalClustersStore((s) => s.list);
  const load = useLocalClustersStore((s) => s.load);
  const run = useLocalClustersStore((s) => s.run);
  const [picked, setPicked] = useState<LocalTool | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [workers, setWorkers] = useState("0");
  const [version, setVersion] = useState("");
  const [port, setPort] = useState("");
  const [preview, setPreview] = useState<{ text: string } | { error: string } | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    void load({ tools: true });
  }, [load]);

  const installed = LOCAL_TOOLS.filter((tool) => tools?.[tool]);
  const tool: LocalTool = picked ?? installed[0] ?? "kind";
  const shownName = name ?? freeClusterName(list?.clusters ?? [], tool);
  const workerCount = Number.parseInt(workers, 10);
  const portNumber = port.trim() ? Number.parseInt(port, 10) : null;
  const badName = !validClusterName(shownName);
  const badWorkers = !Number.isInteger(workerCount) || workerCount < 0 || workerCount > MAX_WORKERS;
  const badPort = portNumber !== null && (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535);
  const spec = useMemo<LocalClusterSpec>(
    () => ({
      tool,
      action: "create",
      name: shownName,
      workers: badWorkers ? 0 : workerCount,
      version: version.trim() || null,
      ingressPort: tool === "k3d" && portNumber !== null && !badPort ? portNumber : null,
    }),
    [tool, shownName, workerCount, badWorkers, version, portNumber, badPort],
  );

  // What it will run, as the backend builds it — and why it would refuse, said before it is sent.
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      containersLocalPreview(spec)
        .then((text) => live && setPreview({ text }))
        .catch((error) => live && setPreview({ error: String(error) }));
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [spec]);

  const available = !!tools?.[tool];
  const canCreate = available && !badName && !badWorkers && !badPort && !!preview && "text" in preview && !starting;
  const create = async () => {
    if (!canCreate) return;
    setStarting(true);
    try {
      await run(jobTitle(t, "create", tool, spec.name), spec);
      onClose();
    } finally {
      setStarting(false);
    }
  };

  if (tools === null) {
    return (
      <p className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
        <Loader2 size={12} className="animate-spin" />
        {t("containers.local.looking")}
      </p>
    );
  }
  const input = fieldClass({ className: "w-full font-mono" });
  return (
    <div className="flex flex-col gap-3" onKeyDown={(e) => e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement) && void create()}>
      <p className="text-[12px] leading-relaxed text-[var(--cf-text-muted)]">{t("containers.local.lead")}</p>
      {installed.length === 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[12px] text-[var(--cf-text)]">{t("containers.local.noneInstalled")}</p>
          {LOCAL_TOOLS.map((tool) => (
            <InstallHint key={tool} tool={tool} onOpen={onClose} />
          ))}
        </div>
      )}
      {installed.length > 0 && (
        <>
          <Segmented<LocalTool>
            options={LOCAL_TOOLS.map((value) => ({ value, label: value, title: t(TOOL_HINT[value]) + (tools[value] ? "" : ` — ${t("containers.local.notInstalled")}`) }))}
            value={tool}
            onChange={(next) => {
              setPicked(next);
              if (next !== "k3d") setPort("");
            }}
            layoutId="cf-kube-local-tool"
            full
            ariaLabel={t("containers.local.tool")}
          />
          <p className="text-[11.5px] leading-snug text-[var(--cf-text-faint)]">{t(TOOL_HINT[tool])}</p>
          {!available && <InstallHint tool={tool} onOpen={onClose} />}
          {available && tool !== "minikube" && !tools.docker && (
            <p className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
              <TriangleAlert size={13} className="shrink-0 text-[var(--cf-warning)]" />
              {t("containers.local.needsDocker")}
            </p>
          )}
          <div className="grid grid-cols-[1fr_110px_150px] gap-3">
            <Field label={t("containers.local.name")} hint={badName ? <span className="text-[var(--cf-danger)]">{t("containers.local.badName")}</span> : t("containers.local.context", { context: localContextOf(tool, shownName) })}>
              <input autoFocus value={shownName} onChange={(e) => setName(e.target.value.trim())} spellCheck={false} className={input} />
            </Field>
            <Field label={tool === "k3d" ? t("containers.local.agents") : t("containers.local.workers")} hint={badWorkers ? <span className="text-[var(--cf-danger)]">0–{MAX_WORKERS}</span> : undefined}>
              <input type="number" min={0} max={MAX_WORKERS} value={workers} onChange={(e) => setWorkers(e.target.value)} className={input} />
            </Field>
            <Field label={t("containers.local.version")} hint={t("containers.local.versionHint")}>
              <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder={VERSION_PLACEHOLDER[tool]} spellCheck={false} className={input} />
            </Field>
          </div>
          {tool === "k3d" && (
            <Field label={t("containers.local.ingressPort")} hint={badPort ? <span className="text-[var(--cf-danger)]">{t("containers.local.badPort")}</span> : t("containers.local.ingressPortHint")} className="w-[220px]">
              <input value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))} placeholder="8080" inputMode="numeric" className={input} />
            </Field>
          )}
          {preview && (
            <div className="rounded-md bg-[var(--cf-sunken)] px-2.5 py-1.5 font-mono text-[11.5px] leading-snug shadow-[inset_0_0_0_1px_var(--cf-border)]">
              {"text" in preview ? <span className="break-all text-[var(--cf-text)]">$ {preview.text}</span> : <span className="break-words text-[var(--cf-danger)]">{preview.error}</span>}
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-[var(--cf-text-faint)]">{t("containers.local.takesMinutes")}</span>
            <Button size="md" variant="primary" onClick={() => void create()} disabled={!canCreate}>
              {starting ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              {t("containers.local.create")}
            </Button>
          </div>
        </>
      )}
      {(list?.clusters.length ?? 0) > 0 && (
        <div className="flex flex-col gap-1 border-t border-[var(--cf-border)] pt-3">
          <div className={sectionLabelClass}>{t("containers.local.title")}</div>
          <LocalClusterList onOpen={onClose} />
        </div>
      )}
    </div>
  );
}

/** The clusters the installed tools know, with what their tool can do to them. */
export function LocalClusterList({ onOpen }: { onOpen?: () => void }) {
  const t = useT();
  const list = useLocalClustersStore((s) => s.list);
  return (
    <div className="flex flex-col">
      {list?.errors.map((error) => (
        <p key={error} className="whitespace-pre-wrap break-words px-1 py-1 font-mono text-[11px] text-[var(--cf-danger)]">
          {error}
        </p>
      ))}
      {list?.clusters.map((cluster) => <LocalClusterRow key={`${cluster.tool}/${cluster.name}`} cluster={cluster} onOpen={onOpen} />)}
      {list && list.clusters.length === 0 && list.errors.length === 0 && <p className="px-1 py-1 text-[12px] text-[var(--cf-text-muted)]">{t("containers.local.none")}</p>}
    </div>
  );
}

function LocalClusterRow({ cluster, onOpen }: { cluster: LocalCluster; onOpen?: () => void }) {
  const t = useT();
  const run = useLocalClustersStore((s) => s.run);
  const kube = useContainersStore((s) => s.runtimes.find((r) => r.id === "kubernetes"));
  const current = useContainersStore((s) => s.contextOf("kubernetes"));
  const setContext = useContainersStore((s) => s.setContext);
  const setNav = useContainersStore((s) => s.setNav);
  const busy = useBusy(cluster);
  const known = kube?.contexts.some((c) => c.name === cluster.context) ?? false;
  const stateLabel =
    cluster.state === "running"
      ? t("containers.local.state.running")
      : cluster.state === "stopped"
        ? t("containers.local.state.stopped")
        : cluster.state === "partial"
          ? t("containers.local.state.partial")
          : "";
  const nodes =
    cluster.nodes > 0
      ? cluster.runningNodes !== null && cluster.runningNodes !== cluster.nodes
        ? t("containers.local.nodesRunning", { running: cluster.runningNodes, count: cluster.nodes })
        : t("containers.local.nodes", { count: cluster.nodes })
      : "";
  const act = async (action: LocalAction) => {
    if (action === "delete" && !(await confirmAction(t("containers.local.confirmDelete", { name: cluster.name, tool: cluster.tool, context: cluster.context }), true, t("containers.local.delete")))) return;
    void run(jobTitle(t, action, cluster.tool, cluster.name), { tool: cluster.tool, action, name: cluster.name });
  };
  const open = () => {
    setContext("kubernetes", cluster.context);
    setNav({ runtime: "kubernetes", section: "overview" });
    onOpen?.();
  };
  return (
    <div className="flex h-8 items-center gap-2 rounded-md px-1 hover:bg-[var(--cf-hover)]">
      {busy ? <Loader2 size={11} className="shrink-0 animate-spin text-[var(--cf-text-muted)]" /> : <StateDot tone={localTone(cluster.state)} title={stateLabel || undefined} />}
      <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--cf-text)]">{cluster.name}</span>
      <span className={chipClass("neutral")}>{cluster.tool}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-faint)]" title={cluster.version || undefined}>
        {[cluster.context, nodes, stateLabel].filter(Boolean).join(" · ")}
      </span>
      {known && cluster.context !== current && (
        <RowAction label={t("containers.local.open", { context: cluster.context })} onClick={open}>
          <ArrowRight size={12} />
        </RowAction>
      )}
      {cluster.canStop && cluster.state !== "running" && (
        <RowAction label={t("containers.local.start")} disabled={busy} onClick={() => void act("start")}>
          <Play size={12} />
        </RowAction>
      )}
      {cluster.canStop && cluster.state !== "stopped" && cluster.state !== "" && (
        <RowAction label={t("containers.local.stop")} disabled={busy} onClick={() => void act("stop")}>
          <Square size={11} />
        </RowAction>
      )}
      <RowAction label={t("containers.local.delete")} danger disabled={busy} onClick={() => void act("delete")}>
        <Trash2 size={12} />
      </RowAction>
    </div>
  );
}

/** Under the clusters' page's contexts: the local clusters, when a tool that makes them is installed. */
export function LocalClustersSection() {
  const t = useT();
  const tools = useLocalClustersStore((s) => s.tools);
  const list = useLocalClustersStore((s) => s.list);
  const loading = useLocalClustersStore((s) => s.loading);
  const load = useLocalClustersStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  const any = !!tools && (tools.kind || tools.k3d || tools.minikube);
  if (!any && !(list?.clusters.length ?? 0)) return null;
  return (
    <div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-[var(--cf-border)] px-3 pb-2 pt-1.5">
      <div className="flex h-7 items-center gap-1">
        <span className={`${sectionLabelClass} min-w-0 flex-1`}>{t("containers.local.title")}</span>
        <RowAction label={t("containers.refresh")} onClick={() => void load()}>
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
        </RowAction>
      </div>
      <LocalClusterList />
    </div>
  );
}
