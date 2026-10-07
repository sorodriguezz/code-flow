import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ArrowUpFromLine, ClipboardPaste, Copy, Eye, EyeOff, FileCode2, FolderOpen, Hammer, Package, Plus, RotateCcw, Save, X } from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { RowAction, StateDot, TextView } from "./containerBits";
import { Dialog, Field, FormSection, NO_ROWS } from "./ui";
import { ImageCombo, menuAt, type MenuState } from "./pageBits";
import {
  COMPOSE_PRESETS,
  composeProblems,
  composeYaml,
  emptyDraft,
  freeName,
  hostPortOf,
  joinPath,
  newService,
  nextId,
  presetService,
  publishedPorts,
  type ComposeDraft,
  type ComposeProblem,
  type ComposeRestart,
  type ComposeService,
} from "./composeFile";
import { baseName, composeProjectName, dirOf } from "./pageModel";
import { writeFileBytes } from "../../lib/tauri/commands";
import { confirmAction } from "../../state/confirmStore";
import { listKey, useContainersStore } from "../../state/containersStore";
import { useT } from "../../state/languageStore";
import { useRepoStore } from "../../state/repoStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { ContainerRow, VolumeRow, RuntimeInfo } from "../../types/containers";

/**
 * «Nuevo compose» — a Compose file built from a form and saved where the user says: the services on
 * the left (empty, from a Dockerfile, or one of the usual ones — PostgreSQL, Redis… — ready to go),
 * the picked one's form on the right with the run dialog's image search (this engine's images and
 * Docker Hub's), and the YAML it all amounts to a click away. «Save and bring up» saves, then
 * brings it up as one of the manager's jobs, like «Up from a file».
 *
 * The model and the YAML are `composeFile.ts`'s. A draft closed without saving — Escape, a click
 * beside the dialog — is kept until the app closes, so the next «New compose» opens on it.
 */

let kept: ComposeDraft | null = null;
/** Where the last one was saved, so the next save starts there. */
let lastDir: string | null = null;

type View = "form" | "yaml";

const SECRET = /(pass|pwd|secret|token|key|credential|auth)/i;

export function ComposeBuilderDialog({
  runtime,
  context,
  onClose,
  onUp,
}: {
  runtime: RuntimeInfo;
  context: string | null;
  onClose: () => void;
  /** Brings the saved file up: the project's name, its folder, the file. */
  onUp: (name: string, dir: string, file: string) => void;
}) {
  const t = useT();
  const repoPath = useRepoStore((s) => s.repoPath);
  const refreshList = useContainersStore((s) => s.refreshList);
  const [draft, setDraft] = useState<ComposeDraft>(() => kept ?? emptyDraft());
  const [selected, setSelected] = useState<number | null>(() => (kept ?? draft).services[0]?.id ?? null);
  const [view, setView] = useState<View>("form");
  const [menu, setMenu] = useState<MenuState>(null);
  const [saving, setSaving] = useState(false);

  // Whatever is on screen when the dialog goes, unless it was saved — see the module note.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const saved = useRef(false);
  useEffect(
    () => () => {
      const last = draftRef.current;
      kept = saved.current || (!last.name.trim() && last.services.length === 0) ? null : last;
    },
    [],
  );

  useEffect(() => {
    if (!runtime.running) return;
    for (const what of ["images", "volumes", "containers"]) void refreshList(runtime.id, what);
  }, [runtime.id, runtime.running, refreshList]);

  const problems = useMemo(() => composeProblems(draft), [draft]);
  const yaml = useMemo(() => composeYaml(draft), [draft]);
  const troubled = useMemo(() => new Set(problems.map((problem) => problem.service).filter((id): id is number => id !== null)), [problems]);
  const describe = (problem: ComposeProblem) => t(problem.key, problem.params);
  const current = draft.services.find((service) => service.id === selected) ?? null;

  const add = (service: ComposeService) => {
    setDraft((was) => ({ ...was, services: [...was.services, service] }));
    setSelected(service.id);
    setView("form");
  };
  const addItems = (): MenuItem[] => [
    { label: t("containers.m.compose.b.empty"), icon: Package, onClick: () => add(newService(freeName(draft, "app"))) },
    { label: t("containers.m.compose.b.fromDockerfile"), icon: Hammer, onClick: () => add(newService(freeName(draft, "app"), "build")) },
    ...COMPOSE_PRESETS.map((preset, index) => ({ label: preset.label, separated: index === 0, onClick: () => add(presetService(draft, preset.id)) })),
  ];
  const update = (id: number, change: Partial<ComposeService>) =>
    setDraft((was) => ({ ...was, services: was.services.map((service) => (service.id === id ? { ...service, ...change } : service)) }));
  const remove = (id: number) => {
    const at = draft.services.findIndex((service) => service.id === id);
    const rest = draft.services.filter((service) => service.id !== id).map((service) => ({ ...service, dependsOn: service.dependsOn.filter((other) => other !== id) }));
    setDraft({ ...draft, services: rest });
    if (selected === id) setSelected(rest[Math.min(at, rest.length - 1)]?.id ?? null);
  };
  const reset = async () => {
    if (!(await confirmAction(t("containers.m.compose.b.resetConfirm"), true, t("containers.m.compose.b.reset")))) return;
    setDraft(emptyDraft());
    setSelected(null);
  };

  const save = async (andUp: boolean) => {
    if (problems.length > 0 || saving) return;
    setSaving(true);
    try {
      const path = await saveDialog({
        title: t("containers.m.compose.b.saveTitle"),
        defaultPath: joinPath(lastDir ?? repoPath ?? "", "compose.yaml"),
        filters: [{ name: "Compose", extensions: ["yaml", "yml"] }],
      });
      if (!path) return;
      const dir = dirOf(path);
      // Written for its folder: a bind mount or a build inside it reads as `./…`, so the project
      // can move with its file.
      await writeFileBytes(path, new TextEncoder().encode(composeYaml(draft, dir)));
      saved.current = true;
      lastDir = dir;
      pushSuccessToast(t("containers.m.compose.b.saved", { file: baseName(path) }));
      onClose();
      if (andUp) onUp(draft.name.trim() || composeProjectName(dir) || "app", dir, path);
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={t("containers.m.compose.b.title")}
      onClose={onClose}
      width={940}
      footer={
        <>
          <span className="mr-auto min-w-0 truncate text-[11.5px] text-[var(--cf-text-muted)]" title={problems.map(describe).join("\n") || undefined}>
            {problems[0] ? describe(problems[0]) : ""}
          </span>
          <Button size="md" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="md" variant="secondary" onClick={() => void save(false)} disabled={problems.length > 0 || saving}>
            <Save size={13} />
            {t("containers.m.compose.b.save")}
          </Button>
          <Button
            size="md"
            variant="primary"
            onClick={() => void save(true)}
            disabled={problems.length > 0 || saving || !runtime.running}
            title={runtime.running ? undefined : (runtime.problem ?? t("containers.notRunningHint"))}
          >
            <ArrowUpFromLine size={13} />
            {t("containers.m.compose.b.saveUp")}
          </Button>
        </>
      }
    >
      <div className="flex h-[min(600px,calc(100vh-11rem))] min-h-[360px] flex-col gap-3">
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("containers.m.compose.b.project")}</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase() })}
            placeholder={t("containers.m.compose.b.projectPlaceholder")}
            spellCheck={false}
            aria-label={t("containers.m.compose.b.project")}
            className={fieldClass({ size: "sm", className: "w-[220px] font-mono" })}
          />
          <div className="flex-1" />
          <Segmented
            layoutId="compose-builder-view"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "form", label: t("containers.m.compose.b.form") },
              { value: "yaml", label: "YAML" },
            ]}
          />
        </div>

        {view === "yaml" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--cf-border)]">
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-2.5">
              <FileCode2 size={13} className="text-[var(--cf-text-muted)]" />
              <span className="font-mono text-[11.5px] text-[var(--cf-text-muted)]">compose.yaml</span>
              <div className="flex-1" />
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(yaml).then(() => pushSuccessToast(t("containers.m.compose.b.copied")), (e: unknown) => pushErrorToast(String(e)));
                }}
                className="flex items-center gap-1 text-[11.5px] text-[var(--cf-accent)] hover:underline"
              >
                <Copy size={11} />
                {t("containers.copyAll")}
              </button>
            </div>
            <TextView value={yaml} language="yaml" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-[var(--cf-border)]">
            <div className="flex w-[210px] shrink-0 flex-col border-r border-[var(--cf-border)] bg-[var(--cf-sunken)]">
              <div className="flex h-8 shrink-0 items-center gap-0.5 pl-2.5 pr-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t("containers.m.compose.b.services")}</span>
                <div className="flex-1" />
                {draft.services.length > 0 && (
                  <RowAction label={t("containers.m.compose.b.reset")} onClick={() => void reset()}>
                    <RotateCcw size={12} />
                  </RowAction>
                )}
                <RowAction label={t("containers.m.compose.b.addService")} onClick={(e) => setMenu(menuAt(e, addItems()))}>
                  <Plus size={13} />
                </RowAction>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
                {draft.services.map((service) => (
                  <div
                    key={service.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelected(service.id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSelected(service.id))}
                    className={`group flex h-[38px] cursor-pointer items-center gap-2 rounded-md px-2 ${
                      service.id === selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate font-mono text-[12px] ${service.name.trim() ? "text-[var(--cf-text)]" : "text-[var(--cf-text-faint)]"}`}>
                        {service.name.trim() || t("containers.m.compose.b.unnamed")}
                      </span>
                      <span className="block truncate text-[10.5px] text-[var(--cf-text-muted)]">
                        {service.from === "build" ? `Dockerfile · ${service.context.trim() || "."}` : service.image.trim() || "—"}
                      </span>
                    </span>
                    {troubled.has(service.id) && <StateDot tone="warn" title={problems.filter((p) => p.service === service.id).map(describe).join("\n")} />}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(service.id);
                      }}
                      aria-label={t("containers.m.compose.b.removeService")}
                      title={t("containers.m.compose.b.removeService")}
                      className="shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] opacity-0 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)] focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3">
              {current ? (
                <ServiceForm
                  key={current.id}
                  runtime={runtime}
                  context={context}
                  draft={draft}
                  service={current}
                  onChange={(change) => update(current.id, change)}
                />
              ) : (
                // No services yet: the ways to add one, as the controls they are.
                <div className="flex flex-wrap gap-1.5">
                  {addItems().map((item) => (
                    <Button key={item.label} size="sm" variant="secondary" onClick={item.onClick}>
                      {item.icon ? <item.icon size={12} /> : <Plus size={12} />}
                      {item.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </Dialog>
  );
}

/** One service's form. Keyed by the service, so the image search and its tags start fresh for each. */
function ServiceForm({
  runtime,
  context,
  draft,
  service,
  onChange,
}: {
  runtime: RuntimeInfo;
  context: string | null;
  draft: ComposeDraft;
  service: ComposeService;
  onChange: (change: Partial<ComposeService>) => void;
}) {
  const t = useT();
  const engineVolumes = (useContainersStore((s) => s.lists[listKey(runtime.id, context, null, "volumes")])?.rows ?? NO_ROWS) as VolumeRow[];
  const containers = (useContainersStore((s) => s.lists[listKey(runtime.id, context, null, "containers")])?.rows ?? NO_ROWS) as ContainerRow[];
  const [shown, setShown] = useState<Set<number>>(() => new Set());
  const others = draft.services.filter((other) => other.id !== service.id);

  // Host ports already taken: by a running container of this engine (a warning, with a free one a
  // click away), or by another service of this file (which Compose would refuse: a problem).
  const running = useMemo(() => {
    const used = new Map<string, string>();
    for (const row of containers) {
      if (row.state !== "running") continue;
      for (const port of row.ports) if (port.hostPort) used.set(`${port.hostPort}/${port.protocol === "udp" ? "udp" : "tcp"}`, row.name);
    }
    return used;
  }, [containers]);
  const inFile = useMemo(() => publishedPorts(draft, service.id), [draft, service.id]);
  const freeFrom = (portId: number, from: string, protocol: string) => {
    const mine = new Set(service.ports.filter((p) => p.id !== portId).map((p) => `${hostPortOf(p.host)}/${p.protocol}`));
    let port = Number(hostPortOf(from)) + 1;
    while (running.has(`${port}/${protocol}`) || inFile.has(`${port}/${protocol}`) || mine.has(`${port}/${protocol}`)) port += 1;
    return port;
  };
  const volumeNames = useMemo(
    () => [...new Set([...engineVolumes.map((v) => v.name), ...draft.services.flatMap((s) => s.mounts.filter((m) => m.kind === "volume" && m.source.trim()).map((m) => m.source.trim()))])],
    [engineVolumes, draft.services],
  );

  const pasteEnv = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const rows = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const at = line.indexOf("=");
          return { id: nextId(), key: line.slice(0, at).replace(/^export\s+/, "").trim(), value: line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, "$2") };
        });
      if (!rows.length) {
        pushErrorToast(t("containers.m.run.noEnvInClipboard"));
        return;
      }
      onChange({ env: [...service.env.filter((row) => row.key.trim()), ...rows] });
      pushSuccessToast(t("containers.m.run.envPasted", { count: rows.length }));
    } catch {
      pushErrorToast(t("containers.m.run.clipboardFailed"));
    }
  };

  const mono = fieldClass({ size: "sm", className: "w-full font-mono" });
  const link = "flex items-center gap-1 text-[11.5px] text-[var(--cf-accent)] hover:underline";
  const removeButton = "rounded p-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Field label={t("containers.m.compose.b.service")}>
          <input value={service.name} onChange={(e) => onChange({ name: e.target.value.trim() })} placeholder="app" spellCheck={false} className={mono} />
        </Field>
        <div className="flex flex-col gap-1">
          <span className="text-[11.5px] text-[var(--cf-text-muted)]">{t("containers.m.compose.b.source")}</span>
          <Segmented
            layoutId={`compose-source-${service.id}`}
            size="sm"
            value={service.from}
            onChange={(from) => onChange({ from })}
            options={[
              { value: "image", label: t("containers.m.run.image") },
              { value: "build", label: "Dockerfile" },
            ]}
          />
        </div>
      </div>
      {service.from === "image" ? (
        <Field label={t("containers.m.run.image")}>
          <ImageCombo runtime={runtime} context={context} value={service.image} onChange={(image) => onChange({ image })} />
        </Field>
      ) : (
        <div className="grid grid-cols-[1fr_200px] gap-3">
          <Field label={t("containers.m.compose.b.context")} hint={t("containers.m.compose.b.contextHint")}>
            <div className="flex min-w-0 gap-1">
              <input value={service.context} onChange={(e) => onChange({ context: e.target.value })} placeholder="." spellCheck={false} className={mono} />
              <button
                onClick={async () => {
                  const dir = await openDialog({ directory: true, title: t("containers.m.run.pickFolder") });
                  if (typeof dir === "string") onChange({ context: dir });
                }}
                title={t("containers.m.run.pickFolder")}
                aria-label={t("containers.m.run.pickFolder")}
                className="shrink-0 rounded-md border border-[var(--cf-field-border)] px-1.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                <FolderOpen size={13} />
              </button>
            </div>
          </Field>
          <Field label="Dockerfile">
            <input value={service.dockerfile} onChange={(e) => onChange({ dockerfile: e.target.value })} placeholder="Dockerfile" spellCheck={false} className={mono} />
          </Field>
        </div>
      )}

      <FormSection
        title={t("containers.m.run.ports")}
        trailing={
          <button onClick={() => onChange({ ports: [...service.ports, { id: nextId(), host: "", container: "", protocol: "tcp" }] })} className={link}>
            <Plus size={11} />
            {t("containers.m.run.addPort")}
          </button>
        }
      >
        {service.ports.length === 0 && <p className="text-[11.5px] text-[var(--cf-text-faint)]">{t("containers.m.compose.b.noPorts")}</p>}
        {service.ports.map((row) => {
          const key = `${hostPortOf(row.host)}/${row.protocol}`;
          const clash = hostPortOf(row.host) ? (inFile.get(key) ?? null) : null;
          const busy = hostPortOf(row.host) && !clash ? (running.get(key) ?? null) : null;
          const set = (change: Partial<typeof row>) => onChange({ ports: service.ports.map((p) => (p.id === row.id ? { ...p, ...change } : p)) });
          return (
            <div key={row.id} className="flex flex-col gap-1">
              <div className="grid grid-cols-[1fr_auto_1fr_90px_auto] items-center gap-2">
                <input
                  value={row.host}
                  onChange={(e) => set({ host: e.target.value })}
                  placeholder={t("containers.m.run.hostPort")}
                  inputMode="numeric"
                  className={fieldClass({ size: "sm", className: `w-full font-mono ${clash || busy ? "!border-[var(--cf-warning)]" : ""}` })}
                />
                <span className="text-[var(--cf-text-faint)]">→</span>
                <input value={row.container} onChange={(e) => set({ container: e.target.value })} placeholder={t("containers.m.run.containerPort")} inputMode="numeric" className={mono} />
                <Select
                  size="sm"
                  value={row.protocol}
                  onChange={(protocol) => set({ protocol: protocol as "tcp" | "udp" })}
                  options={[
                    { value: "tcp", label: "TCP" },
                    { value: "udp", label: "UDP" },
                  ]}
                  ariaLabel={t("containers.m.run.protocol")}
                />
                <button onClick={() => onChange({ ports: service.ports.filter((p) => p.id !== row.id) })} aria-label={t("containers.remove")} className={removeButton}>
                  <X size={13} />
                </button>
              </div>
              {(clash || busy) && (
                <div className="flex items-center gap-2 rounded-md bg-[color-mix(in_srgb,var(--cf-warning)_12%,transparent)] px-2 py-1 text-[11.5px] text-[var(--cf-text)]">
                  <span className="min-w-0 flex-1">
                    {clash ? t("containers.m.compose.b.portInFile", { port: hostPortOf(row.host), name: clash }) : t("containers.m.run.portTaken", { port: hostPortOf(row.host), name: busy ?? "" })}
                  </span>
                  <button onClick={() => set({ host: String(freeFrom(row.id, row.host, row.protocol)) })} className="shrink-0 text-[var(--cf-accent)] hover:underline">
                    {t("containers.m.run.useFree", { port: freeFrom(row.id, row.host, row.protocol) })}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </FormSection>

      <FormSection
        title={t("containers.m.run.env")}
        trailing={
          <span className="flex items-center gap-3">
            <button onClick={() => void pasteEnv()} className={link}>
              <ClipboardPaste size={11} />
              {t("containers.m.run.pasteEnv")}
            </button>
            <button onClick={() => onChange({ env: [...service.env, { id: nextId(), key: "", value: "" }] })} className={link}>
              <Plus size={11} />
              {t("containers.m.run.addEnv")}
            </button>
          </span>
        }
      >
        {service.env.length === 0 && <p className="text-[11.5px] text-[var(--cf-text-faint)]">{t("containers.m.run.noEnv")}</p>}
        {service.env.map((row) => {
          const secret = SECRET.test(row.key);
          const visible = shown.has(row.id);
          const set = (change: Partial<typeof row>) => onChange({ env: service.env.map((r) => (r.id === row.id ? { ...r, ...change } : r)) });
          return (
            <div key={row.id} className="grid grid-cols-[200px_1fr_auto] items-center gap-2">
              <input value={row.key} onChange={(e) => set({ key: e.target.value })} placeholder="CLAVE" spellCheck={false} className={mono} />
              <div className="flex min-w-0 gap-1">
                <input type={secret && !visible ? "password" : "text"} value={row.value} onChange={(e) => set({ value: e.target.value })} placeholder={t("containers.m.run.value")} spellCheck={false} className={mono} />
                {secret && (
                  <button
                    onClick={() =>
                      setShown((was) => {
                        const next = new Set(was);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      })
                    }
                    aria-label={visible ? t("containers.hideValue") : t("containers.showValue")}
                    className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
                  >
                    {visible ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                )}
              </div>
              <button onClick={() => onChange({ env: service.env.filter((r) => r.id !== row.id) })} aria-label={t("containers.remove")} className={removeButton}>
                <X size={13} />
              </button>
            </div>
          );
        })}
      </FormSection>

      <FormSection
        title={t("containers.m.run.volumes")}
        trailing={
          <button onClick={() => onChange({ mounts: [...service.mounts, { id: nextId(), kind: "volume", source: "", target: "", readOnly: false }] })} className={link}>
            <Plus size={11} />
            {t("containers.m.run.addVolume")}
          </button>
        }
      >
        {service.mounts.length === 0 && <p className="text-[11.5px] text-[var(--cf-text-faint)]">{t("containers.m.run.noVolumes")}</p>}
        {service.mounts.map((row) => {
          const set = (change: Partial<typeof row>) => onChange({ mounts: service.mounts.map((m) => (m.id === row.id ? { ...m, ...change } : m)) });
          return (
            <div key={row.id} className="grid grid-cols-[130px_1fr_auto_1fr_auto_auto] items-center gap-2">
              <Select
                size="sm"
                value={row.kind}
                onChange={(kind) => set({ kind: kind as "volume" | "bind", source: "" })}
                options={[
                  { value: "volume", label: t("containers.m.run.namedVolume") },
                  { value: "bind", label: t("containers.m.run.folder") },
                ]}
                ariaLabel={t("containers.m.run.volumeKind")}
              />
              <div className="flex min-w-0 gap-1">
                <input
                  value={row.source}
                  list={row.kind === "volume" ? `compose-volumes-${row.id}` : undefined}
                  onChange={(e) => set({ source: e.target.value })}
                  placeholder={row.kind === "bind" ? "./datos" : t("containers.m.run.volumeName")}
                  spellCheck={false}
                  className={mono}
                />
                {row.kind === "volume" && (
                  <datalist id={`compose-volumes-${row.id}`}>
                    {volumeNames.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                )}
                {row.kind === "bind" && (
                  <button
                    onClick={async () => {
                      const dir = await openDialog({ directory: true, title: t("containers.m.run.pickFolder") });
                      if (typeof dir === "string") set({ source: dir });
                    }}
                    title={t("containers.m.run.pickFolder")}
                    aria-label={t("containers.m.run.pickFolder")}
                    className="shrink-0 rounded-md border border-[var(--cf-field-border)] px-1.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                  >
                    <FolderOpen size={13} />
                  </button>
                )}
              </div>
              <span className="text-[var(--cf-text-faint)]">→</span>
              <input value={row.target} onChange={(e) => set({ target: e.target.value })} placeholder="/datos" spellCheck={false} className={mono} />
              <label className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)]" title={t("containers.m.run.readOnlyHint")}>
                <Checkbox checked={row.readOnly} onChange={(readOnly) => set({ readOnly })} />
                {t("containers.m.run.readOnly")}
              </label>
              <button onClick={() => onChange({ mounts: service.mounts.filter((m) => m.id !== row.id) })} aria-label={t("containers.remove")} className={removeButton}>
                <X size={13} />
              </button>
            </div>
          );
        })}
      </FormSection>

      {others.length > 0 && (
        <FormSection title={t("containers.m.compose.b.dependsOn")}>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {others.map((other) => (
              <label key={other.id} className="flex cursor-pointer items-center gap-1.5 font-mono text-[12px] text-[var(--cf-text)]">
                <Checkbox
                  checked={service.dependsOn.includes(other.id)}
                  onChange={(on) => onChange({ dependsOn: on ? [...service.dependsOn, other.id] : service.dependsOn.filter((id) => id !== other.id) })}
                />
                {other.name.trim() || t("containers.m.compose.b.unnamed")}
              </label>
            ))}
          </div>
        </FormSection>
      )}

      <FormSection title={t("containers.m.run.behaviour")}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("containers.m.run.restart")}>
            <Select
              size="sm"
              value={service.restart}
              onChange={(restart) => onChange({ restart: restart as ComposeRestart })}
              options={[
                { value: "", label: t("containers.m.run.restartNo") },
                { value: "unless-stopped", label: t("containers.m.run.restartUnlessStopped") },
                { value: "always", label: t("containers.m.run.restartAlways") },
                { value: "on-failure", label: t("containers.m.run.restartOnFailure") },
              ]}
              ariaLabel={t("containers.m.run.restart")}
            />
          </Field>
          <Field label={t("containers.m.compose.b.containerName")}>
            <input value={service.containerName} onChange={(e) => onChange({ containerName: e.target.value.trim() })} placeholder={t("containers.m.run.optional")} spellCheck={false} className={mono} />
          </Field>
        </div>
        <Field label={t("containers.m.run.command")} hint={t("containers.m.run.commandHint")}>
          <input value={service.command} onChange={(e) => onChange({ command: e.target.value })} placeholder="npm start" spellCheck={false} className={mono} />
        </Field>
      </FormSection>
    </div>
  );
}
