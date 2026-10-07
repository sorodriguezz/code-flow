import { Scalar, stringify } from "yaml";
import type { TranslationKey } from "../../lib/i18n/translations";
import { COMPOSE_PROJECT, pullableReference, relativeTo } from "./pageModel";

/**
 * «Nuevo compose»: a Compose file put together from a form — the services, each from an image (this
 * engine's or Docker Hub's) or from a Dockerfile, with the ports it publishes, its variables, its
 * volumes and the services it starts after — and written out as YAML every Compose reads: Docker's
 * (Go, YAML 1.2) and podman-compose (PyYAML, YAML 1.1, where `22:22` is a number and `yes` a
 * boolean). Pure, so the YAML and the checks are tested without a DOM.
 */

export type ComposeRestart = "" | "unless-stopped" | "always" | "on-failure";

export interface ComposePort {
  id: number;
  /** `8080`, `127.0.0.1:8080`, or empty for a port of the engine's choosing. */
  host: string;
  container: string;
  protocol: "tcp" | "udp";
}

export interface ComposeEnv {
  id: number;
  key: string;
  value: string;
}

export interface ComposeMount {
  id: number;
  kind: "volume" | "bind";
  /** A volume's name, or a folder of this computer. */
  source: string;
  target: string;
  readOnly: boolean;
}

export interface ComposeService {
  /** Stable while the form is open: what `dependsOn` and the list hold, so a rename breaks neither. */
  id: number;
  /** Its key under `services:` — the name the others reach it by on the project's network, too. */
  name: string;
  from: "image" | "build";
  image: string;
  /** The build's folder; `.` is the Compose file's own. */
  context: string;
  /** Empty for the engine's default (`Dockerfile`, or Podman's `Containerfile`). */
  dockerfile: string;
  ports: ComposePort[];
  env: ComposeEnv[];
  mounts: ComposeMount[];
  dependsOn: number[];
  /** Empty for Compose's own default, which is never to restart. */
  restart: ComposeRestart;
  command: string;
  containerName: string;
}

export interface ComposeDraft {
  /** The file's `name:`; empty leaves the project named after its folder, as Compose does. */
  name: string;
  services: ComposeService[];
}

let seq = 0;
export const nextId = () => ++seq;

export const emptyDraft = (): ComposeDraft => ({ name: "", services: [] });

export function newService(name = "", from: ComposeService["from"] = "image"): ComposeService {
  return { id: nextId(), name, from, image: "", context: ".", dockerfile: "", ports: [], env: [], mounts: [], dependsOn: [], restart: "", command: "", containerName: "" };
}

// -------------------------------------------------------------------------------------- presets

interface Preset {
  id: string;
  label: string;
  image: string;
  ports: [host: string, container: string][];
  env?: [key: string, value: string][];
  /** Named volumes: `[name, path in the container]`. */
  volumes?: [name: string, target: string][];
  restart?: ComposeRestart;
}

/**
 * The services a project most often runs beside its own code, ready to go. Images without a tag —
 * the latest, as `docker run` takes them — rather than versions of ours that age; the tag list from
 * Docker Hub is a click away in the form. Passwords are development ones, there to be changed.
 */
export const COMPOSE_PRESETS: Preset[] = [
  {
    id: "postgres",
    label: "PostgreSQL",
    image: "postgres",
    ports: [["5432", "5432"]],
    env: [
      ["POSTGRES_USER", "postgres"],
      ["POSTGRES_PASSWORD", "postgres"],
      ["POSTGRES_DB", "app"],
    ],
    // The parent of `data`, not `data` itself: from 18 on the image keeps its cluster under
    // `/var/lib/postgresql/<major>/docker` and refuses to start over a volume mounted at `…/data`;
    // older majors write `…/data`, which is inside this volume too.
    volumes: [["pgdata", "/var/lib/postgresql"]],
    restart: "unless-stopped",
  },
  {
    id: "mysql",
    label: "MySQL",
    image: "mysql",
    ports: [["3306", "3306"]],
    env: [
      ["MYSQL_ROOT_PASSWORD", "root"],
      ["MYSQL_DATABASE", "app"],
    ],
    volumes: [["mysqldata", "/var/lib/mysql"]],
    restart: "unless-stopped",
  },
  {
    id: "mariadb",
    label: "MariaDB",
    image: "mariadb",
    ports: [["3306", "3306"]],
    env: [
      ["MARIADB_ROOT_PASSWORD", "root"],
      ["MARIADB_DATABASE", "app"],
    ],
    volumes: [["mariadbdata", "/var/lib/mysql"]],
    restart: "unless-stopped",
  },
  {
    id: "mongo",
    label: "MongoDB",
    image: "mongo",
    ports: [["27017", "27017"]],
    env: [
      ["MONGO_INITDB_ROOT_USERNAME", "root"],
      ["MONGO_INITDB_ROOT_PASSWORD", "root"],
    ],
    volumes: [["mongodata", "/data/db"]],
    restart: "unless-stopped",
  },
  { id: "redis", label: "Redis", image: "redis", ports: [["6379", "6379"]], volumes: [["redisdata", "/data"]], restart: "unless-stopped" },
  {
    id: "rabbitmq",
    label: "RabbitMQ",
    // The tag that adds the management UI on 15672 — a variant, not a version.
    image: "rabbitmq:management",
    ports: [
      ["5672", "5672"],
      ["15672", "15672"],
    ],
    env: [
      ["RABBITMQ_DEFAULT_USER", "app"],
      ["RABBITMQ_DEFAULT_PASS", "app"],
    ],
    volumes: [["rabbitmqdata", "/var/lib/rabbitmq"]],
    restart: "unless-stopped",
  },
  { id: "nginx", label: "Nginx", image: "nginx", ports: [["8080", "80"]] },
  { id: "adminer", label: "Adminer", image: "adminer", ports: [["8081", "8080"]] },
  {
    id: "mailpit",
    label: "Mailpit",
    image: "axllent/mailpit",
    ports: [
      ["8025", "8025"],
      ["1025", "1025"],
    ],
  },
];

/** A name no service of the draft has yet: `redis`, then `redis-2`… */
export function freeName(draft: ComposeDraft, wanted: string): string {
  const taken = new Set(draft.services.map((service) => service.name.trim()));
  if (!taken.has(wanted)) return wanted;
  let n = 2;
  while (taken.has(`${wanted}-${n}`)) n += 1;
  return `${wanted}-${n}`;
}

/** The host ports the draft's services publish, as `8080/tcp` → the service publishing it. */
export function publishedPorts(draft: ComposeDraft, except?: number): Map<string, string> {
  const used = new Map<string, string>();
  for (const service of draft.services) {
    if (service.id === except) continue;
    for (const port of service.ports) {
      const host = hostPortOf(port.host);
      if (host) used.set(`${host}/${port.protocol}`, service.name.trim());
    }
  }
  return used;
}

/** A preset as a new service of `draft`: a name of its own, and host ports no other service takes. */
export function presetService(draft: ComposeDraft, presetId: string): ComposeService {
  const preset = COMPOSE_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) throw new Error(`no preset ${presetId}`);
  const service = newService(freeName(draft, preset.id));
  const used = publishedPorts(draft);
  service.image = preset.image;
  service.restart = preset.restart ?? "";
  service.ports = preset.ports.map(([host, container]) => {
    let port = Number(host);
    while (used.has(`${port}/tcp`)) port += 1;
    used.set(`${port}/tcp`, service.name);
    return { id: nextId(), host: String(port), container, protocol: "tcp" };
  });
  service.env = (preset.env ?? []).map(([key, value]) => ({ id: nextId(), key, value }));
  // A second PostgreSQL gets a volume of its own, not the first one's data.
  const volumes = new Set(draft.services.flatMap((other) => other.mounts.filter((m) => m.kind === "volume").map((m) => m.source.trim())));
  service.mounts = (preset.volumes ?? []).map(([name, target]) => {
    let source = name;
    for (let n = 2; volumes.has(source); n++) source = `${name}${n}`;
    volumes.add(source);
    return { id: nextId(), kind: "volume", source, target, readOnly: false };
  });
  return service;
}

// -------------------------------------------------------------------------------------- checks

export interface ComposeProblem {
  /** The service it is about, or `null` for the file. */
  service: number | null;
  key: TranslationKey;
  params?: Record<string, string | number>;
}

/** What Compose takes as a service's name. */
export const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const PORT = /^\d{1,5}(-\d{1,5})?$/;
const HOST_IP = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:]+\])$/;
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const ENV_KEY = /^[^\s=]+$/;

/** The host side of a port row is `8080` or `127.0.0.1:8080`: the port is its last part. */
export const hostPortOf = (host: string) => host.trim().split(":").pop() ?? "";

const portOk = (value: string) => PORT.test(value) && value.split("-").every((part) => Number(part) >= 1 && Number(part) <= 65535);
function hostOk(value: string): boolean {
  const at = value.lastIndexOf(":");
  if (at < 0) return portOk(value);
  return HOST_IP.test(value.slice(0, at)) && portOk(value.slice(at + 1));
}

/** Everything that would stop Compose from reading or starting the file, first problem first. */
export function composeProblems(draft: ComposeDraft): ComposeProblem[] {
  const out: ComposeProblem[] = [];
  if (draft.services.length === 0) out.push({ service: null, key: "containers.m.compose.b.noServices" });
  if (draft.name.trim() && !COMPOSE_PROJECT.test(draft.name.trim())) out.push({ service: null, key: "containers.m.compose.nameInvalid" });

  const counts = new Map<string, number>();
  for (const service of draft.services) counts.set(service.name.trim(), (counts.get(service.name.trim()) ?? 0) + 1);
  const published = new Map<string, string>();

  draft.services.forEach((service, index) => {
    const name = service.name.trim() || `#${index + 1}`;
    const add = (key: TranslationKey, params: Record<string, string | number> = {}) => out.push({ service: service.id, key, params: { name, ...params } });
    if (!service.name.trim()) add("containers.m.compose.b.nameMissing");
    else if (!SERVICE_NAME.test(service.name.trim())) add("containers.m.compose.b.nameInvalid");
    else if ((counts.get(service.name.trim()) ?? 0) > 1) add("containers.m.compose.b.nameTaken");

    if (service.from === "image") {
      if (!service.image.trim()) add("containers.m.compose.b.imageMissing");
      else if (!pullableReference(service.image)) add("containers.m.compose.b.imageInvalid");
    } else if (!service.context.trim()) add("containers.m.compose.b.contextMissing");

    for (const port of service.ports) {
      const host = port.host.trim();
      const container = port.container.trim();
      if (!host && !container) continue;
      if (!portOk(container) || (host && !hostOk(host))) {
        add("containers.m.compose.b.portInvalid", { port: container || host });
        continue;
      }
      if (!host) continue;
      const key = `${hostPortOf(host)}/${port.protocol}`;
      const other = published.get(key);
      if (other !== undefined) add("containers.m.compose.b.portTaken", { port: hostPortOf(host), other });
      else published.set(key, name);
    }
    for (const row of service.env) {
      if (!row.key.trim() && !row.value) continue;
      if (!ENV_KEY.test(row.key.trim())) add("containers.m.compose.b.envInvalid", { key: row.key.trim() || "—" });
    }
    for (const mount of service.mounts) {
      const source = mount.source.trim();
      const target = mount.target.trim();
      if (!source && !target) continue;
      if (!source) add("containers.m.compose.b.sourceMissing");
      else if (mount.kind === "volume" && !VOLUME_NAME.test(source)) add("containers.m.compose.b.volumeInvalid", { volume: source });
      if (!target.startsWith("/")) add("containers.m.compose.b.targetInvalid", { target: target || "—" });
    }
  });

  // A cycle in `depends_on` is refused outright ("dependency cycle detected").
  const byId = new Map(draft.services.map((service) => [service.id, service]));
  const state = new Map<number, "visiting" | "done">();
  const visit = (id: number): boolean => {
    if (state.get(id) === "done") return false;
    if (state.get(id) === "visiting") return true;
    state.set(id, "visiting");
    const looped = (byId.get(id)?.dependsOn ?? []).some((next) => byId.has(next) && visit(next));
    state.set(id, "done");
    return looped;
  };
  for (const service of draft.services) {
    state.clear();
    if (visit(service.id)) {
      out.push({ service: service.id, key: "containers.m.compose.b.cycle", params: { name: service.name.trim() || "?" } });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------- YAML

/** Double-quoted whatever the reader: Docker's documentation asks for ports as strings, and PyYAML
 *  reads an unquoted `22:22` as the number 1342. */
function quoted(value: string): Scalar {
  const scalar = new Scalar(value);
  scalar.type = "QUOTE_DOUBLE";
  return scalar;
}

/** A folder as the file should hold it: `./sub` when it is inside the file's own folder (the file
 *  moves with its project that way), as given otherwise. */
function local(path: string, baseDir: string): string {
  const trimmed = path.trim();
  if (!baseDir) return trimmed;
  if (trimmed.replace(/[\\/]+$/, "") === baseDir.replace(/[\\/]+$/, "")) return ".";
  const inside = relativeTo(baseDir, trimmed);
  return inside === trimmed ? trimmed : `./${inside.replace(/\\/g, "/")}`;
}

/** A bind mount's source. Compose takes a bare word for a volume's name, so a folder has to read as
 *  a path: absolute, `~`, or starting with `.`. */
function bindSource(path: string, baseDir: string): string {
  const source = local(path, baseDir);
  return /^([/~.]|[A-Za-z]:[\\/]|\\\\)/.test(source) ? source : `./${source}`;
}

/** The draft as the Compose file, its folder being `baseDir` (unknown until saved: then paths stay
 *  as typed). */
export function composeYaml(draft: ComposeDraft, baseDir = ""): string {
  const names = new Map(draft.services.map((service) => [service.id, service.name.trim()]));
  const volumes = new Set<string>();
  const services: Record<string, unknown> = {};
  draft.services.forEach((service, index) => {
    const name = service.name.trim() || `service-${index + 1}`;
    const out: Record<string, unknown> = {};
    if (service.from === "build") {
      const context = local(service.context || ".", baseDir) || ".";
      out.build = service.dockerfile.trim() ? { context, dockerfile: service.dockerfile.trim() } : context;
    } else {
      out.image = service.image.trim();
    }
    if (service.containerName.trim()) out.container_name = service.containerName.trim();
    if (service.restart) out.restart = service.restart;
    if (service.command.trim()) out.command = service.command.trim();
    const ports = service.ports
      .filter((port) => port.container.trim())
      .map((port) => quoted(`${port.host.trim() ? `${port.host.trim()}:` : ""}${port.container.trim()}${port.protocol === "udp" ? "/udp" : ""}`));
    if (ports.length) out.ports = ports;
    const env = service.env.filter((row) => row.key.trim());
    if (env.length) out.environment = Object.fromEntries(env.map((row) => [row.key.trim(), row.value]));
    const mounts = service.mounts
      .filter((mount) => mount.source.trim() && mount.target.trim())
      .map((mount) => {
        const source = mount.kind === "volume" ? mount.source.trim() : bindSource(mount.source, baseDir);
        if (mount.kind === "volume") volumes.add(source);
        return `${source}:${mount.target.trim()}${mount.readOnly ? ":ro" : ""}`;
      });
    if (mounts.length) out.volumes = mounts;
    const after = [...new Set(service.dependsOn.map((id) => names.get(id)).filter((other): other is string => !!other && other !== service.name.trim()))];
    if (after.length) out.depends_on = after;
    services[name] = out;
  });
  const doc: Record<string, unknown> = {};
  if (draft.name.trim()) doc.name = draft.name.trim();
  doc.services = services;
  // Every named volume declared once at the top, as Compose wants them.
  if (volumes.size) doc.volumes = Object.fromEntries([...volumes].map((volume) => [volume, null]));
  return stringify(doc, { version: "1.1", lineWidth: 0, nullStr: "" });
}

/** `dir/file` with the separator `dir` already uses. */
export function joinPath(dir: string, file: string): string {
  if (!dir) return file;
  if (/[\\/]$/.test(dir)) return dir + file;
  return dir + (dir.includes("\\") && !dir.includes("/") ? "\\" : "/") + file;
}
