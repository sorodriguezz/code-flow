import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ClipboardPaste, Copy, ExternalLink, Eye, EyeOff, FolderOpen, Loader2, Play, Plus, Star, X } from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { chipClass, fieldClass, popoverClass } from "../common/recipes";
import { Dialog, Field, FormSection, NO_ROWS } from "./ui";
import { containersHubSearch, containersHubTags, containersRun, containersText } from "../../lib/tauri/containersCommands";
import { openExternalUrl } from "../../lib/tauri/commands";
import { listKey, useContainersStore } from "../../state/containersStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { ContainerRow, HubRepo, HubTag, ImageRow, NetworkRow, RestartPolicy, RunSpec, RuntimeInfo, VolumeRow } from "../../types/containers";

/**
 * «Ejecutar contenedor» — a `docker run -d` from a form, lite-dock's dialog: an image from this
 * engine or from Docker Hub (and the tag to run), the ports to publish (with the one another
 * container already holds pointed out, and a free one a click away), volumes, variables (a `.env`
 * pasted in one go), the restart policy, limits, and the command it all amounts to, to copy.
 */

type PortRow = { id: number; host: string; container: string; protocol: "tcp" | "udp" };
type VolumeFormRow = { id: number; kind: "volume" | "bind"; source: string; target: string; readOnly: boolean };
type EnvRow = { id: number; key: string; value: string; shown: boolean };

const SECRET = /(pass|pwd|secret|token|key|credential|auth)/i;
let seq = 0;
const nextId = () => ++seq;

/** The host side of a port row is `8080` or `127.0.0.1:8080`: the port is its last part. */
const hostPortOf = (host: string) => host.trim().split(":").pop() ?? "";

/** How a value reads in the command line shown — quoted only when a shell would need it. */
function quote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

const imageName = (reference: string) => (reference.includes(":") && !reference.endsWith("]") ? reference.slice(0, reference.lastIndexOf(":")) : reference);
/** A plain Docker Hub reference: no registry host in front (`ghcr.io/…`, `localhost:5000/…`). */
const onHub = (name: string) => {
  const first = name.split("/")[0];
  return !first.includes(".") && !first.includes(":") && first !== "localhost";
};
const hubUrl = (name: string) => (name.includes("/") ? `https://hub.docker.com/r/${name}` : `https://hub.docker.com/_/${name}`);

export function RunContainerDialog({ runtime, context, initialImage = "", onClose }: { runtime: RuntimeInfo; context: string | null; initialImage?: string; onClose: () => void }) {
  const t = useT();
  const refreshList = useContainersStore((s) => s.refreshList);
  const select = useContainersStore((s) => s.select);
  const images = (useContainersStore((s) => s.lists[listKey(runtime.id, context, null, "images")])?.rows ?? NO_ROWS) as ImageRow[];
  const volumes = (useContainersStore((s) => s.lists[listKey(runtime.id, context, null, "volumes")])?.rows ?? NO_ROWS) as VolumeRow[];
  const networks = (useContainersStore((s) => s.lists[listKey(runtime.id, context, null, "networks")])?.rows ?? NO_ROWS) as NetworkRow[];
  const containers = (useContainersStore((s) => s.lists[listKey(runtime.id, context, null, "containers")])?.rows ?? NO_ROWS) as ContainerRow[];

  const [image, setImage] = useState(initialImage);
  const [name, setName] = useState("");
  const [ports, setPorts] = useState<PortRow[]>([{ id: nextId(), host: "", container: "", protocol: "tcp" }]);
  const [publishAll, setPublishAll] = useState(false);
  const [vols, setVols] = useState<VolumeFormRow[]>([]);
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [restart, setRestart] = useState<RestartPolicy>("no");
  const [autoRemove, setAutoRemove] = useState(false);
  const [pullAlways, setPullAlways] = useState(false);
  const [network, setNetwork] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [command, setCommand] = useState("");
  const [memoryMb, setMemoryMb] = useState("");
  const [cpus, setCpus] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    for (const what of ["images", "volumes", "networks", "containers"]) void refreshList(runtime.id, what);
  }, [runtime.id, refreshList]);

  // ---- the image: this engine's, or Docker Hub's
  const [comboOpen, setComboOpen] = useState(false);
  const [hub, setHub] = useState<HubRepo[]>([]);
  const [hubLoading, setHubLoading] = useState(false);
  const [hubError, setHubError] = useState<string | null>(null);
  const [tags, setTags] = useState<HubTag[] | null>(null);
  const combo = useRef<HTMLDivElement>(null);
  const local = useMemo(() => images.filter((i) => !i.dangling && i.reference && !i.reference.includes("<none>")).map((i) => i.reference), [images]);
  const localMatches = useMemo(() => {
    const needle = image.trim().toLowerCase();
    if (!needle || local.some((r) => r.toLowerCase() === needle)) return local;
    return local.filter((r) => r.toLowerCase().includes(needle));
  }, [image, local]);
  const term = imageName(image.trim());
  useEffect(() => {
    if (!comboOpen || term.length < 2 || !onHub(term)) {
      setHub([]);
      setHubLoading(false);
      return;
    }
    let alive = true;
    setHubLoading(true);
    const timer = setTimeout(() => {
      containersHubSearch(term, 8)
        .then((found) => alive && (setHub(found), setHubError(null)))
        .catch((e: unknown) => alive && (setHub([]), setHubError(String(e))))
        .finally(() => alive && setHubLoading(false));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [term, comboOpen]);
  useEffect(() => {
    if (!comboOpen) return;
    const outside = (event: PointerEvent) => {
      if (combo.current && !combo.current.contains(event.target as Node)) setComboOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [comboOpen]);

  /** A local image's EXPOSE, as port rows — host port the same unless taken. */
  const prefillPorts = async (reference: string) => {
    try {
      const text = await containersText({ runtime: runtime.id, context, object: "image", id: reference, view: "inspect" });
      const doc = JSON.parse(text) as unknown;
      const first = Array.isArray(doc) ? doc[0] : doc;
      const exposed = Object.keys((first as { Config?: { ExposedPorts?: Record<string, unknown> } })?.Config?.ExposedPorts ?? {});
      if (!exposed.length) return;
      setPorts((current) => {
        if (current.some((p) => p.container.trim())) return current;
        const taken = new Set<string>();
        return exposed.map((spec) => {
          const [port, proto] = spec.split("/");
          const protocol = proto === "udp" ? "udp" : "tcp";
          let host = Number(port);
          while (usedPorts.has(`${host}/${protocol}`) || taken.has(`${host}/${protocol}`)) host += 1;
          taken.add(`${host}/${protocol}`);
          return { id: nextId(), host: String(host), container: port, protocol };
        });
      });
    } catch {
      // No EXPOSE to read: the rows stay as they are.
    }
  };
  const pickLocal = (reference: string) => {
    setImage(reference);
    setTags(null);
    setComboOpen(false);
    void prefillPorts(reference);
  };
  const pickHub = (repo: HubRepo) => {
    setImage(`${repo.name}:latest`);
    setComboOpen(false);
    setTags(null);
    containersHubTags(repo.name, 40)
      .then(setTags)
      .catch(() => setTags([]));
  };

  // ---- ports another container already holds
  const usedPorts = useMemo(() => {
    const used = new Map<string, string>();
    for (const row of containers) {
      if (row.state !== "running") continue;
      for (const port of row.ports) if (port.hostPort) used.set(`${port.hostPort}/${port.protocol === "udp" ? "udp" : "tcp"}`, row.name);
    }
    return used;
  }, [containers]);
  const clashOf = (row: PortRow) => {
    const port = hostPortOf(row.host);
    return port ? (usedPorts.get(`${port}/${row.protocol}`) ?? null) : null;
  };
  const freeFrom = (row: PortRow) => {
    let port = Number(hostPortOf(row.host)) + 1;
    const mine = new Set(ports.filter((p) => p.id !== row.id).map((p) => `${hostPortOf(p.host)}/${p.protocol}`));
    while (usedPorts.has(`${port}/${row.protocol}`) || mine.has(`${port}/${row.protocol}`)) port += 1;
    return port;
  };

  const pasteEnv = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const rows = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const at = line.indexOf("=");
          return {
            id: nextId(),
            key: line.slice(0, at).replace(/^export\s+/, "").trim(),
            value: line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, "$2"),
            shown: false,
          };
        });
      if (!rows.length) {
        pushErrorToast(t("containers.m.run.noEnvInClipboard"));
        return;
      }
      setEnv((current) => [...current.filter((r) => r.key.trim()), ...rows]);
      pushSuccessToast(t("containers.m.run.envPasted", { count: rows.length }));
    } catch {
      pushErrorToast(t("containers.m.run.clipboardFailed"));
    }
  };

  const number = (raw: string): number | null => {
    const value = Number(raw.trim().replace(",", "."));
    return raw.trim() && Number.isFinite(value) && value > 0 ? value : null;
  };
  const spec: RunSpec = {
    image: image.trim(),
    name: name.trim(),
    ports: ports.filter((p) => p.container.trim()).map((p) => ({ host: p.host.trim(), container: p.container.trim(), protocol: p.protocol })),
    publishAll,
    env: env.filter((r) => r.key.trim()).map((r) => ({ key: r.key.trim(), value: r.value })),
    volumes: vols.filter((v) => v.source.trim() && v.target.trim()).map((v) => ({ kind: v.kind, source: v.source.trim(), target: v.target.trim(), readOnly: v.readOnly })),
    restart: autoRemove ? "no" : restart,
    autoRemove,
    pull: pullAlways ? "always" : "missing",
    command: command.trim(),
    workdir: workdir.trim(),
    network,
    memoryMb: number(memoryMb),
    cpus: number(cpus),
  };

  const program = runtime.id === "podman" ? "podman" : runtime.id === "nerdctl" ? "nerdctl" : "docker";
  const preview = useMemo(() => {
    const parts = [program];
    if (context && runtime.id === "docker" && context !== runtime.currentContext) parts.push(`--context ${quote(context)}`);
    parts.push("run -d");
    if (spec.name) parts.push(`--name ${quote(spec.name)}`);
    if (spec.autoRemove) parts.push("--rm");
    else if (spec.restart !== "no") parts.push(`--restart ${spec.restart}`);
    if (spec.pull === "always") parts.push("--pull always");
    if (spec.publishAll) parts.push("-P");
    for (const p of spec.ports) parts.push(`-p ${p.host ? `${p.host}:` : ""}${p.container}${p.protocol === "udp" ? "/udp" : ""}`);
    for (const v of spec.volumes) parts.push(`-v ${quote(`${v.source}:${v.target}${v.readOnly ? ":ro" : ""}`)}`);
    for (const e of spec.env) parts.push(`-e ${quote(`${e.key}=${SECRET.test(e.key) && e.value ? "••••••" : e.value}`)}`);
    if (spec.network) parts.push(`--network ${quote(spec.network)}`);
    if (spec.workdir) parts.push(`-w ${quote(spec.workdir)}`);
    if (spec.memoryMb) parts.push(`--memory ${Math.round(spec.memoryMb)}m`);
    if (spec.cpus) parts.push(`--cpus ${spec.cpus}`);
    parts.push(spec.image || "<imagen>");
    if (spec.command) parts.push(spec.command);
    return parts.join(" ");
  }, [program, context, runtime.id, runtime.currentContext, spec.name, spec.autoRemove, spec.restart, spec.pull, spec.publishAll, spec.ports, spec.volumes, spec.env, spec.network, spec.workdir, spec.memoryMb, spec.cpus, spec.image, spec.command]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!spec.image || running) return;
    setRunning(true);
    try {
      const id = await containersRun(runtime.id, context, spec);
      pushSuccessToast(t("containers.done.run", { name: spec.image }));
      await refreshList(runtime.id, "containers");
      onClose();
      if (id && !spec.autoRemove) select({ runtime: runtime.id, context, namespace: null, object: "container", id, name: spec.name || id.slice(0, 12) });
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setRunning(false);
    }
  };

  const input = fieldClass({ size: "sm", className: "w-full" });
  const mono = fieldClass({ size: "sm", className: "w-full font-mono" });
  return (
    <Dialog
      title={t("containers.m.runContainer")}
      onClose={onClose}
      width={720}
      footer={
        <>
          <span className="mr-auto text-[11px] text-[var(--cf-text-faint)]">{t("containers.m.run.shortcut")}</span>
          <Button size="md" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="md" variant="primary" onClick={() => void submit()} disabled={!spec.image || running}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {running ? t("containers.m.run.running") : t("containers.m.run.run")}
          </Button>
        </>
      }
    >
      <div
        className="flex flex-col gap-4"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="grid grid-cols-[1fr_200px] gap-3">
          <Field label={t("containers.m.run.image")}>
            <div ref={combo} className="relative">
              <div className="flex gap-1">
                <input
                  autoFocus
                  value={image}
                  onChange={(e) => {
                    setImage(e.target.value);
                    setTags(null);
                    setComboOpen(true);
                  }}
                  onFocus={() => setComboOpen(true)}
                  onKeyDown={(e) => e.key === "Escape" && comboOpen && (e.stopPropagation(), setComboOpen(false))}
                  placeholder={t("containers.m.run.imagePlaceholder")}
                  spellCheck={false}
                  className={mono}
                />
                {tags && tags.length > 0 && (
                  <div className="w-[130px] shrink-0">
                    <Select
                      size="sm"
                      value={image.includes(":") ? image.slice(image.lastIndexOf(":") + 1) : "latest"}
                      onChange={(tag) => setImage(`${imageName(image)}:${tag}`)}
                      options={tags.map((tag) => ({ value: tag.name, label: tag.name }))}
                      ariaLabel={t("containers.m.run.tag")}
                    />
                  </div>
                )}
              </div>
              {comboOpen && (
                <div className={`${popoverClass} absolute left-0 right-0 top-full z-10 mt-1 max-h-[320px] overflow-y-auto`}>
                  <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t("containers.m.run.localImages")}</div>
                  {localMatches.length ? (
                    localMatches.map((reference) => (
                      <button key={reference} onClick={() => pickLocal(reference)} className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] hover:bg-[var(--cf-hover)]">
                        <span className="min-w-0 flex-1 truncate font-mono">{reference}</span>
                        <span className={chipClass("ok")}>{t("containers.m.run.downloaded")}</span>
                      </button>
                    ))
                  ) : (
                    <p className="px-2 py-1 text-[11.5px] text-[var(--cf-text-muted)]">{t("containers.m.run.noLocalMatch")}</p>
                  )}
                  <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                    Docker Hub
                    {hubLoading && <Loader2 size={10} className="animate-spin" />}
                  </div>
                  {hub.map((repo) => (
                    <div key={repo.name} className="flex items-start gap-1 rounded-md px-2 py-1 hover:bg-[var(--cf-hover)]">
                      <button onClick={() => pickHub(repo)} className="flex min-w-0 flex-1 flex-col text-left">
                        <span className="flex items-center gap-1.5 text-[12.5px]">
                          <span className="truncate font-mono font-medium">{repo.name}</span>
                          {repo.official && <span className={chipClass("accent")}>{t("containers.m.run.official")}</span>}
                          <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[11px] text-[var(--cf-text-muted)]">
                            <Star size={10} />
                            {repo.stars.toLocaleString()}
                          </span>
                        </span>
                        {repo.description && <span className="line-clamp-1 text-[11px] text-[var(--cf-text-muted)]">{repo.description}</span>}
                      </button>
                      <button onClick={() => void openExternalUrl(hubUrl(repo.name))} title={t("containers.m.run.viewOnHub")} className="mt-0.5 shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]">
                        <ExternalLink size={11} />
                      </button>
                    </div>
                  ))}
                  {!hubLoading && hub.length === 0 && (
                    <p className="px-2 py-1 text-[11.5px] text-[var(--cf-text-muted)]">
                      {hubError ?? (term.length < 2 ? t("containers.m.run.typeToSearch") : onHub(term) ? t("containers.m.run.noHubMatch") : t("containers.m.run.notOnHub"))}
                    </p>
                  )}
                </div>
              )}
            </div>
          </Field>
          <Field label={t("containers.m.run.name")}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("containers.m.run.optional")} spellCheck={false} className={mono} />
          </Field>
        </div>

        <FormSection
          title={t("containers.m.run.ports")}
          trailing={
            <button onClick={() => setPorts((p) => [...p, { id: nextId(), host: "", container: "", protocol: "tcp" }])} className="flex items-center gap-1 text-[11.5px] text-[var(--cf-accent)] hover:underline">
              <Plus size={11} />
              {t("containers.m.run.addPort")}
            </button>
          }
        >
          {ports.map((row) => {
            const clash = clashOf(row);
            return (
              <div key={row.id} className="flex flex-col gap-1">
                <div className="grid grid-cols-[1fr_auto_1fr_90px_auto] items-center gap-2">
                  <input
                    value={row.host}
                    onChange={(e) => setPorts((all) => all.map((p) => (p.id === row.id ? { ...p, host: e.target.value } : p)))}
                    placeholder={t("containers.m.run.hostPort")}
                    inputMode="numeric"
                    className={fieldClass({ size: "sm", className: `w-full font-mono ${clash ? "!border-[var(--cf-warning)]" : ""}` })}
                  />
                  <span className="text-[var(--cf-text-faint)]">→</span>
                  <input
                    value={row.container}
                    onChange={(e) => setPorts((all) => all.map((p) => (p.id === row.id ? { ...p, container: e.target.value } : p)))}
                    placeholder={t("containers.m.run.containerPort")}
                    inputMode="numeric"
                    className={mono}
                  />
                  <Select
                    size="sm"
                    value={row.protocol}
                    onChange={(protocol) => setPorts((all) => all.map((p) => (p.id === row.id ? { ...p, protocol: protocol as "tcp" | "udp" } : p)))}
                    options={[
                      { value: "tcp", label: "TCP" },
                      { value: "udp", label: "UDP" },
                    ]}
                    ariaLabel={t("containers.m.run.protocol")}
                  />
                  <button onClick={() => setPorts((all) => all.filter((p) => p.id !== row.id))} aria-label={t("containers.remove")} className="rounded p-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
                    <X size={13} />
                  </button>
                </div>
                {clash && (
                  <div className="flex items-center gap-2 rounded-md bg-[color-mix(in_srgb,var(--cf-warning)_12%,transparent)] px-2 py-1 text-[11.5px] text-[var(--cf-text)]">
                    <span className="min-w-0 flex-1">{t("containers.m.run.portTaken", { port: hostPortOf(row.host), name: clash })}</span>
                    <button onClick={() => setPorts((all) => all.map((p) => (p.id === row.id ? { ...p, host: String(freeFrom(row)) } : p)))} className="shrink-0 text-[var(--cf-accent)] hover:underline">
                      {t("containers.m.run.useFree", { port: freeFrom(row) })}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <label className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
            <Checkbox checked={publishAll} onChange={setPublishAll} />
            {t("containers.m.run.publishAll")}
          </label>
        </FormSection>

        <FormSection
          title={t("containers.m.run.volumes")}
          trailing={
            <button onClick={() => setVols((v) => [...v, { id: nextId(), kind: "volume", source: "", target: "", readOnly: false }])} className="flex items-center gap-1 text-[11.5px] text-[var(--cf-accent)] hover:underline">
              <Plus size={11} />
              {t("containers.m.run.addVolume")}
            </button>
          }
        >
          {vols.length === 0 && <p className="text-[11.5px] text-[var(--cf-text-faint)]">{t("containers.m.run.noVolumes")}</p>}
          {vols.map((row) => (
            <div key={row.id} className="grid grid-cols-[130px_1fr_auto_1fr_auto_auto] items-center gap-2">
              <Select
                size="sm"
                value={row.kind}
                onChange={(kind) => setVols((all) => all.map((v) => (v.id === row.id ? { ...v, kind: kind as "volume" | "bind", source: "" } : v)))}
                options={[
                  { value: "volume", label: t("containers.m.run.namedVolume") },
                  { value: "bind", label: t("containers.m.run.folder") },
                ]}
                ariaLabel={t("containers.m.run.volumeKind")}
              />
              <div className="flex min-w-0 gap-1">
                <input
                  value={row.source}
                  list={row.kind === "volume" ? `volumes-${row.id}` : undefined}
                  onChange={(e) => setVols((all) => all.map((v) => (v.id === row.id ? { ...v, source: e.target.value } : v)))}
                  placeholder={row.kind === "bind" ? "/Users/…/datos" : t("containers.m.run.volumeName")}
                  spellCheck={false}
                  className={mono}
                />
                {row.kind === "volume" && (
                  <datalist id={`volumes-${row.id}`}>
                    {volumes.map((v) => (
                      <option key={v.name} value={v.name} />
                    ))}
                  </datalist>
                )}
                {row.kind === "bind" && (
                  <button
                    onClick={async () => {
                      const dir = await openDialog({ directory: true, title: t("containers.m.run.pickFolder") });
                      if (typeof dir === "string") setVols((all) => all.map((v) => (v.id === row.id ? { ...v, source: dir } : v)));
                    }}
                    title={t("containers.m.run.pickFolder")}
                    className="shrink-0 rounded-md border border-[var(--cf-field-border)] px-1.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                  >
                    <FolderOpen size={13} />
                  </button>
                )}
              </div>
              <span className="text-[var(--cf-text-faint)]">→</span>
              <input
                value={row.target}
                onChange={(e) => setVols((all) => all.map((v) => (v.id === row.id ? { ...v, target: e.target.value } : v)))}
                placeholder="/datos"
                spellCheck={false}
                className={mono}
              />
              <label className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)]" title={t("containers.m.run.readOnlyHint")}>
                <Checkbox checked={row.readOnly} onChange={(readOnly) => setVols((all) => all.map((v) => (v.id === row.id ? { ...v, readOnly } : v)))} />
                {t("containers.m.run.readOnly")}
              </label>
              <button onClick={() => setVols((all) => all.filter((v) => v.id !== row.id))} aria-label={t("containers.remove")} className="rounded p-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
                <X size={13} />
              </button>
            </div>
          ))}
        </FormSection>

        <FormSection
          title={t("containers.m.run.env")}
          trailing={
            <span className="flex items-center gap-3">
              <button onClick={() => void pasteEnv()} className="flex items-center gap-1 text-[11.5px] text-[var(--cf-accent)] hover:underline">
                <ClipboardPaste size={11} />
                {t("containers.m.run.pasteEnv")}
              </button>
              <button onClick={() => setEnv((e) => [...e, { id: nextId(), key: "", value: "", shown: false }])} className="flex items-center gap-1 text-[11.5px] text-[var(--cf-accent)] hover:underline">
                <Plus size={11} />
                {t("containers.m.run.addEnv")}
              </button>
            </span>
          }
        >
          {env.length === 0 && <p className="text-[11.5px] text-[var(--cf-text-faint)]">{t("containers.m.run.noEnv")}</p>}
          {env.map((row) => {
            const secret = SECRET.test(row.key);
            return (
              <div key={row.id} className="grid grid-cols-[200px_1fr_auto] items-center gap-2">
                <input
                  value={row.key}
                  onChange={(e) => setEnv((all) => all.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))}
                  placeholder="CLAVE"
                  spellCheck={false}
                  className={mono}
                />
                <div className="flex min-w-0 gap-1">
                  <input
                    type={secret && !row.shown ? "password" : "text"}
                    value={row.value}
                    onChange={(e) => setEnv((all) => all.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))}
                    placeholder={t("containers.m.run.value")}
                    spellCheck={false}
                    className={mono}
                  />
                  {secret && (
                    <button
                      onClick={() => setEnv((all) => all.map((r) => (r.id === row.id ? { ...r, shown: !r.shown } : r)))}
                      aria-label={row.shown ? t("containers.hideValue") : t("containers.showValue")}
                      className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
                    >
                      {row.shown ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  )}
                </div>
                <button onClick={() => setEnv((all) => all.filter((r) => r.id !== row.id))} aria-label={t("containers.remove")} className="rounded p-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </FormSection>

        <FormSection title={t("containers.m.run.behaviour")}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("containers.m.run.restart")}>
              <Select
                size="sm"
                value={autoRemove ? "no" : restart}
                onChange={(value) => setRestart(value as RestartPolicy)}
                disabled={autoRemove}
                options={[
                  { value: "no", label: t("containers.m.run.restartNo") },
                  { value: "unless-stopped", label: t("containers.m.run.restartUnlessStopped") },
                  { value: "always", label: t("containers.m.run.restartAlways") },
                  { value: "on-failure", label: t("containers.m.run.restartOnFailure") },
                ]}
                ariaLabel={t("containers.m.run.restart")}
              />
            </Field>
            <Field label={t("containers.m.run.network")}>
              <Select
                size="sm"
                value={network}
                onChange={setNetwork}
                options={[{ value: "", label: t("containers.m.run.defaultNetwork") }, ...networks.filter((n) => n.name !== "none").map((n) => ({ value: n.name, label: n.name }))]}
                ariaLabel={t("containers.m.run.network")}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px] text-[var(--cf-text-muted)]">
            <label className="flex items-center gap-2" title={t("containers.m.run.autoRemoveHint")}>
              <Checkbox checked={autoRemove} onChange={setAutoRemove} />
              {t("containers.m.run.autoRemove")}
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={pullAlways} onChange={setPullAlways} />
              {t("containers.m.run.pullAlways")}
            </label>
          </div>
          <button onClick={() => setAdvanced((a) => !a)} className="flex w-fit items-center gap-1 text-[11.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
            <ChevronDown size={12} className={advanced ? "" : "-rotate-90"} />
            {t("containers.m.run.advanced")}
          </button>
          {advanced && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("containers.m.run.command")} hint={t("containers.m.run.commandHint")}>
                <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm start" spellCheck={false} className={mono} />
              </Field>
              <Field label={t("containers.m.run.workdir")}>
                <input value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="/app" spellCheck={false} className={mono} />
              </Field>
              <Field label={t("containers.m.run.memory")} hint={t("containers.m.run.noLimit")}>
                <input value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} placeholder="512" inputMode="numeric" className={input} />
              </Field>
              <Field label={t("containers.m.run.cpus")} hint={t("containers.m.run.noLimit")}>
                <input value={cpus} onChange={(e) => setCpus(e.target.value)} placeholder="1,5" inputMode="decimal" className={input} />
              </Field>
            </div>
          )}
        </FormSection>

        <FormSection
          title={t("containers.m.run.equivalent")}
          trailing={
            <button
              onClick={() => {
                void navigator.clipboard.writeText(preview).catch(() => {});
                pushSuccessToast(t("containers.m.run.copied"));
              }}
              className="flex items-center gap-1 text-[11.5px] text-[var(--cf-accent)] hover:underline"
            >
              <Copy size={11} />
              {t("containers.copyAll")}
            </button>
          }
        >
          <pre className="whitespace-pre-wrap break-all rounded-md bg-[var(--cf-hover)] px-2.5 py-2 font-mono text-[11.5px] text-[var(--cf-text)]">{preview}</pre>
        </FormSection>
      </div>
    </Dialog>
  );
}
