import {
  ArrowRightLeft,
  Copy,
  Download,
  Eraser,
  ExternalLink,
  FileCode2,
  Pause,
  Pencil,
  Play,
  PlayCircle,
  RotateCcw,
  RotateCw,
  Scaling,
  ShieldOff,
  Shield,
  Skull,
  Square,
  Trash2,
  Undo2,
  ArrowUpFromLine,
  ArrowDownToLine,
} from "lucide-react";
import type { MenuItem } from "../common/ContextMenu";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { pushSuccessToast } from "../../state/toastStore";
import { useContainersStore } from "../../state/containersStore";
import { useContainersJobsStore } from "../../state/containersJobsStore";
import { openExternalUrl } from "../../lib/tauri/commands";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ContainerRow, ImageRow, KubeRow, NetworkRow, RuntimeId } from "../../types/containers";

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;
type Act = ReturnType<typeof useContainersStore.getState>["act"];

export function runtimeLabel(id: RuntimeId, t: T): string {
  return t(`containers.runtime.${id}` as TranslationKey);
}

/** Where an action lands, for a confirmation to name — the context, or the runtime when it has none.
 *  A destructive confirmation says where: the same pod names live in staging and in prod. */
function where(runtime: RuntimeId, context: string | null, t: T): string {
  return context || runtimeLabel(runtime, t);
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).catch(() => {});
}

function projectOptions(rows: ContainerRow[]) {
  const first = rows.find((r) => r.projectDir || r.configFiles);
  return { projectDir: first?.projectDir ?? "", configFiles: first?.configFiles ?? "" };
}

/** Everything that can be done to an engine's row, as a context menu — confirmations included. Every
 *  action goes to `context`, the one the row was read from (see `containersStore`). */
export function engineMenu(args: {
  runtime: RuntimeId;
  context: string | null;
  object: "container" | "image" | "volume" | "network" | "project";
  row?: ContainerRow;
  project?: { name: string; rows: ContainerRow[] };
  id?: string;
  image?: ImageRow;
  network?: NetworkRow;
  t: T;
  act: Act;
  select: () => void;
}): MenuItem[] {
  const { runtime, context, object, t, act } = args;
  const ctr = runtime === "ctr";
  const place = where(runtime, context, t);
  if (object === "container" && args.row) {
    const row = args.row;
    const run = (action: string, label: TranslationKey) => () => void act({ runtime, context, object, action, ids: [row.id], label: t(label, { name: row.name }) });
    const items: MenuItem[] = [];
    if (row.state === "running") {
      items.push({ label: t("containers.stop"), icon: Square, onClick: run("stop", "containers.done.stop") });
      if (!ctr) items.push({ label: t("containers.restart"), icon: RotateCw, onClick: run("restart", "containers.done.restart") });
      if (!ctr) items.push({ label: t("containers.pause"), icon: Pause, onClick: run("pause", "containers.done.pause") });
      items.push({ label: t("containers.kill"), icon: Skull, onClick: run("kill", "containers.done.kill") });
    } else if (row.state === "paused") {
      items.push({ label: t("containers.unpause"), icon: Play, onClick: run("unpause", "containers.done.unpause") });
    } else {
      items.push({ label: t("containers.start"), icon: Play, onClick: run("start", "containers.done.start") });
    }
    for (const port of row.ports.filter((p) => p.hostPort)) {
      items.push({ label: t("containers.openPort", { port: String(port.hostPort) }), icon: ExternalLink, onClick: () => void openExternalUrl(`http://localhost:${port.hostPort}`), separated: items.length > 0 && port === row.ports.find((p) => p.hostPort) });
    }
    if (!ctr) {
      items.push({
        label: t("containers.rename"),
        icon: Pencil,
        separated: true,
        onClick: () =>
          void promptAction(t("containers.renamePrompt"), { initial: row.name }).then((name) => {
            if (name && name !== row.name) void act({ runtime, context, object, action: "rename", ids: [row.id], options: { name }, label: t("containers.done.rename", { name }) });
          }),
      });
    }
    items.push({ label: t("containers.copyId"), icon: Copy, separated: ctr, onClick: () => copy(row.id) });
    items.push({ label: t("containers.copyName"), icon: Copy, onClick: () => copy(row.name) });
    items.push({
      label: t("containers.remove"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: () =>
        void confirmAction(t("containers.confirmRemoveContainer", { name: row.name, context: place }), true, t("containers.remove")).then((ok) => {
          if (ok) void act({ runtime, context, object, action: "remove", ids: [row.id], label: t("containers.done.remove", { name: row.name }) });
        }),
    });
    return items;
  }
  if (object === "project" && args.project) {
    const { name, rows } = args.project;
    const options = projectOptions(rows);
    const canUp = !!options.configFiles;
    const run = (action: string, label: TranslationKey) => () => void act({ runtime, context, object, action, ids: [name], options, label: t(label, { name }) });
    // `up` and `pull` can take minutes and print as they go: they run as jobs, where that shows.
    const job = (kind: "composeUp" | "composePull", title: TranslationKey, done: TranslationKey, refresh: string[]) => () =>
      void useContainersJobsStore
        .getState()
        .start(t(title, { name }), { kind, runtime, context, target: name, projectDir: options.projectDir, configFiles: options.configFiles }, { refresh, done: t(done, { name }) });
    const up = rows.some((r) => r.state === "running");
    const items: MenuItem[] = [];
    if (canUp)
      items.push({ label: t("containers.project.up"), icon: ArrowUpFromLine, onClick: job("composeUp", "containers.m.compose.upping", "containers.done.up", ["containers", "images", "volumes", "networks"]) });
    if (up) {
      items.push({ label: t("containers.project.restart"), icon: RotateCw, onClick: run("restart", "containers.done.restart") });
      items.push({ label: t("containers.project.stop"), icon: Square, onClick: run("stop", "containers.done.stop") });
    } else {
      items.push({ label: t("containers.project.start"), icon: Play, onClick: run("start", "containers.done.start") });
    }
    if (canUp) items.push({ label: t("containers.project.pull"), icon: Download, onClick: job("composePull", "containers.m.compose.pulling", "containers.done.pull", ["images"]) });
    items.push({
      label: t("containers.project.down"),
      icon: ArrowDownToLine,
      danger: true,
      separated: true,
      onClick: () =>
        void confirmAction(t("containers.confirmDown", { name, context: place }), true, t("containers.project.down")).then((ok) => {
          if (ok) void act({ runtime, context, object, action: "down", ids: [name], options, label: t("containers.done.down", { name }) });
        }),
    });
    return items;
  }
  if (object === "image" && args.image) {
    const image = args.image;
    const ref = image.dangling ? image.id : image.reference;
    const items: MenuItem[] = [];
    if (!ctr && !image.dangling) {
      items.push({
        label: t("containers.image.run"),
        icon: PlayCircle,
        onClick: () =>
          void promptAction(t("containers.image.runPrompt", { name: ref }), { placeholder: "8080:80", allowEmpty: true, confirmLabel: t("containers.image.runConfirm") }).then((ports) => {
            if (ports === null) return;
            void act({ runtime, context, object: "image", action: "run", ids: [ref], options: { ports }, label: t("containers.done.run", { name: ref }), refresh: ["containers"] });
          }),
      });
      items.push({
        label: t("containers.image.pull"),
        icon: Download,
        onClick: () =>
          void useContainersJobsStore
            .getState()
            .start(t("containers.m.images.pulling", { name: ref }), { kind: "pull", runtime, context, target: ref }, { refresh: ["images"], done: t("containers.done.pull", { name: ref }), runImage: ref }),
      });
    }
    items.push({ label: t("containers.copyId"), icon: Copy, separated: items.length > 0, onClick: () => copy(image.id) });
    items.push({
      label: t("containers.remove"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: () =>
        void confirmAction(t("containers.confirmRemoveImage", { name: ref, context: place }), true, t("containers.remove")).then((ok) => {
          if (ok) void act({ runtime, context, object: "image", action: "remove", ids: [ref], label: t("containers.done.remove", { name: ref }) });
        }),
    });
    return items;
  }
  if ((object === "volume" || object === "network") && args.id) {
    const id = args.id;
    if (object === "network" && args.network?.builtin) return [{ label: t("containers.copyName"), icon: Copy, onClick: () => copy(id) }];
    return [
      { label: t("containers.copyName"), icon: Copy, onClick: () => copy(id) },
      {
        label: t("containers.remove"),
        icon: Trash2,
        danger: true,
        separated: true,
        onClick: () =>
          void confirmAction(t(object === "volume" ? "containers.confirmRemoveVolume" : "containers.confirmRemoveNetwork", { name: id, context: place }), true, t("containers.remove")).then((ok) => {
            if (ok) void act({ runtime, context, object, action: "remove", ids: [id], label: t("containers.done.remove", { name: id }) });
          }),
      },
    ];
  }
  return [];
}

/** The runtime's own menu: cleaning up what nothing uses — in `context`. */
export function pruneMenu(runtime: RuntimeId, context: string | null, t: T, act: Act): MenuItem[] {
  if (runtime === "ctr" || runtime === "kubernetes") return [];
  const prune = (object: string, confirm: TranslationKey, label: TranslationKey, options?: Record<string, unknown>) => () =>
    void confirmAction(t(confirm, { context: where(runtime, context, t) }), true, t("containers.prune.confirm")).then((ok) => {
      if (ok) void act({ runtime, context, object, action: "prune", ids: [], label: t(label), options });
    });
  return [
    { label: t("containers.prune.containers"), icon: Eraser, onClick: prune("container", "containers.prune.confirmContainers", "containers.prune.doneContainers") },
    { label: t("containers.prune.images"), icon: Eraser, onClick: prune("image", "containers.prune.confirmImages", "containers.prune.doneImages") },
    { label: t("containers.prune.volumes"), icon: Eraser, onClick: prune("volume", "containers.prune.confirmVolumes", "containers.prune.doneVolumes") },
    { label: t("containers.prune.networks"), icon: Eraser, onClick: prune("network", "containers.prune.confirmNetworks", "containers.prune.doneNetworks") },
  ];
}

/** A Kubernetes object's menu, by kind. Every action goes to `context`, the one the row was read from —
 *  never kubeconfig's current one, which a terminal can switch meanwhile. */
export function kubeMenu(args: { kind: string; row: KubeRow; context: string | null; t: T; act: Act; select: () => void }): MenuItem[] {
  const { kind, row, context, t, act } = args;
  const ns = row.namespace || null;
  const place = where("kubernetes", context, t);
  const run = (action: string, label: TranslationKey, options?: Record<string, unknown>) => () =>
    void act({ runtime: "kubernetes", context, object: kind, action, ids: [row.name], namespace: ns, options: { ...(options ?? {}), namespace: row.namespace }, label: t(label, { name: row.name }) });
  const items: MenuItem[] = [];
  if (kind === "deployments" || kind === "statefulsets") {
    items.push({
      label: t("containers.kube.scale"),
      icon: Scaling,
      onClick: () =>
        void promptAction(t("containers.kube.scalePrompt", { name: row.name }), {
          initial: String(row.extra.replicas ?? 1),
          validate: (value) => (/^\d+$/.test(value.trim()) ? null : t("containers.kube.scaleInvalid")),
        }).then((value) => {
          if (value !== null) run("scale", "containers.done.scale", { replicas: Number(value) })();
        }),
    });
  }
  if (kind === "deployments" || kind === "statefulsets" || kind === "daemonsets") {
    items.push({ label: t("containers.kube.restart"), icon: RotateCw, onClick: run("restart", "containers.done.rolloutRestart") });
    items.push({
      label: t("containers.kube.undo"),
      icon: Undo2,
      onClick: () =>
        void confirmAction(t("containers.kube.confirmUndo", { name: row.name, context: place }), false, t("containers.kube.undo")).then((ok) => {
          if (ok) run("undo", "containers.done.undo")();
        }),
    });
  }
  if (kind === "cronjobs") {
    items.push({ label: t("containers.kube.trigger"), icon: Play, onClick: run("trigger", "containers.done.trigger") });
    items.push(
      row.extra.suspend
        ? { label: t("containers.kube.resume"), icon: RotateCcw, onClick: run("resume", "containers.done.resume") }
        : { label: t("containers.kube.suspend"), icon: Pause, onClick: run("suspend", "containers.done.suspend") },
    );
  }
  if (kind === "nodes") {
    items.push(
      row.extra.unschedulable
        ? { label: t("containers.kube.uncordon"), icon: Shield, onClick: run("uncordon", "containers.done.uncordon") }
        : { label: t("containers.kube.cordon"), icon: ShieldOff, onClick: run("cordon", "containers.done.cordon") },
    );
  }
  if (kind === "pods" || kind === "services" || kind === "deployments") {
    const ports = kubePorts(kind, row);
    if (ports.length > 0) {
      items.push({
        label: t("containers.kube.portForward"),
        icon: ArrowRightLeft,
        onClick: () => void askForward(kind, row, ports, context, t),
      });
    }
  }
  items.push({ label: t("containers.copyName"), icon: Copy, separated: items.length > 0, onClick: () => copy(row.name) });
  items.push({ label: t("containers.kube.copyGet"), icon: FileCode2, onClick: () => copy(`kubectl get ${kind} ${row.name}${row.namespace ? ` -n ${row.namespace}` : ""} -o yaml`) });
  if (kind !== "events") {
    items.push({
      label: t("containers.kube.delete"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: () =>
        void confirmAction(
          kind === "namespaces"
            ? t("containers.kube.confirmDeleteNamespace", { name: row.name, context: place })
            : t("containers.kube.confirmDelete", { kind: t(`containers.kind.${kind}` as TranslationKey), name: row.name, namespace: row.namespace || "—", context: place }),
          true,
          t("containers.kube.delete"),
        ).then((ok) => {
          if (ok) run("delete", "containers.done.delete")();
        }),
    });
  }
  return items;
}

/** The ports a pod's containers, a service or a deployment's template declare. */
export function kubePorts(kind: string, row: KubeRow): number[] {
  const out = new Set<number>();
  if (kind === "services") {
    for (const p of (row.extra.ports as { port?: number }[] | undefined) ?? []) if (p.port) out.add(p.port);
  } else if (kind === "pods") {
    for (const c of (row.extra.containers as { ports?: { containerPort?: number }[] }[] | undefined) ?? []) for (const p of c.ports ?? []) if (p.containerPort) out.add(p.containerPort);
  }
  return [...out];
}

async function askForward(kind: string, row: KubeRow, ports: number[], context: string | null, t: T) {
  const answer = await promptAction(t("containers.kube.forwardPrompt", { name: row.name, ports: ports.join(", ") }), {
    initial: String(ports[0] ?? ""),
    validate: (value) => (/^\d+(:\d+)?$/.test(value.trim()) ? null : t("containers.kube.forwardInvalid")),
  });
  if (!answer) return;
  // `8080` forwards that port to a free local one; `9000:8080` picks the local port too.
  const [first, second] = answer.trim().split(":");
  const remotePort = Number(second ?? first);
  const localPort = second ? Number(first) : 0;
  const view = await useContainersStore.getState().openForward({ context, kind, name: row.name, namespace: row.namespace, remotePort, localPort });
  if (view) pushSuccessToast(t("containers.kube.forwardReady", { local: view.localPort, name: row.name, remote: view.remotePort }));
}
