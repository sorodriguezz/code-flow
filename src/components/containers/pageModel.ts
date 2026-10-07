import type { ContainerRow, ContainerStats, ImageRow } from "../../types/containers";

/**
 * What the manager's pages work out from the lists the engines print — which containers an image
 * serves, an engine's Compose projects, the name Compose would give a folder, a tag worth building —
 * kept apart from the pages so every rule can be checked without an engine or a DOM.
 */

// ------------------------------------------------------------------------------------- images

/** `docker.io/library/nginx:1` → `nginx:1`. Podman spells Docker Hub's names in full and Docker does
 *  not, and a container names its image the way the engine that made it does. */
export function shortReference(reference: string): string {
  return reference.trim().replace(/^docker\.io\/library\//, "").replace(/^docker\.io\//, "");
}

const HEX = /^[0-9a-f]+$/;

/**
 * The containers made from an image, by any name it goes by: its reference, its repository alone (a
 * container started as `nginx` runs `nginx:latest`), Docker Hub's long spelling, or its id — what `ps`
 * prints once the tag has moved on to a newer image, and the only name a dangling image has.
 */
export function imageUsers(image: ImageRow, containers: ContainerRow[]): ContainerRow[] {
  const id = image.id.replace(/^sha256:/, "").toLowerCase();
  const names = new Set<string>();
  if (!image.dangling && image.reference) {
    names.add(shortReference(image.reference));
    if (image.tag === "latest") names.add(shortReference(image.repository));
  }
  return containers.filter((row) => {
    const used = row.image.trim();
    if (!used) return false;
    const bare = used.replace(/^sha256:/, "").toLowerCase();
    // Twelve characters at least, so a short tag that happens to be hex (`cafe`) is never an id.
    if (id.length >= 12 && bare.length >= 12 && HEX.test(bare) && (id.startsWith(bare) || bare.startsWith(id))) return true;
    return names.has(shortReference(used));
  });
}

/** How many containers use an image: the engine's own count when it prints one (Podman does, Docker
 *  says `N/A`), else the ones `imageUsers` finds. */
export function imageUseCount(image: ImageRow, users: ContainerRow[]): number {
  return image.containers ?? users.length;
}

/**
 * A history step's command, readable: Docker records metadata steps as `/bin/sh -c #(nop)  CMD […]`
 * and shell steps as `/bin/sh -c apt-get …`; what the Dockerfile said was `CMD […]` and `RUN apt-get …`.
 * BuildKit's history is written that way already and passes through.
 */
export function layerCommand(createdBy: string): string {
  const text = createdBy.trim().replace(/\s+/g, " ");
  const nop = /^\/bin\/sh -c #\(nop\) ?(.*)$/.exec(text);
  if (nop) return nop[1].trim();
  const shell = /^\/bin\/sh -c (.*)$/.exec(text);
  if (shell) return `RUN ${shell[1].trim()}`;
  return text;
}

// ---------------------------------------------------------------------------------- references

const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const HOST_PART = "[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?";
const HOST = `${HOST_PART}(?:\\.${HOST_PART})*(?::[0-9]+)?`;
const TAG = "[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}";
const NAME_AND_TAG = new RegExp(`^(?:${HOST}/)?${COMPONENT}(?:/${COMPONENT})*(?::${TAG})?$`);

/** `name[:tag]` as an engine accepts it for `build -t`: lower-case path components, an optional
 *  registry in front (`localhost:5000/app`), an optional tag. A digest has no place in a build's tag. */
export function validImageTag(value: string): boolean {
  const tag = value.trim();
  return tag.length > 0 && tag.length <= 255 && NAME_AND_TAG.test(tag);
}

/** An image reference a pull can be given: no spaces, not a flag. The engine judges the rest — and
 *  says so in the job's own output. */
export function pullableReference(value: string): boolean {
  const ref = value.trim();
  return ref.length > 0 && !ref.startsWith("-") && !/\s/.test(ref);
}

/** A reference without its tag — `nginx:1.27` → `nginx`, `localhost:5000/app` stays whole. */
export function imageName(reference: string): string {
  const colon = reference.lastIndexOf(":");
  return colon > reference.lastIndexOf("/") ? reference.slice(0, colon) : reference;
}

/** A plain Docker Hub name: no registry host in front (`ghcr.io/…`, `localhost:5000/…`). */
export function onDockerHub(name: string): boolean {
  const first = name.split("/")[0];
  return !first.includes(".") && !first.includes(":") && first !== "localhost";
}

export function dockerHubUrl(name: string): string {
  return name.includes("/") ? `https://hub.docker.com/r/${name}` : `https://hub.docker.com/_/${name}`;
}

/** A volume or network name an engine takes: two characters at least, a letter or digit first, then
 *  letters, digits, `_`, `.` or `-` (Docker refuses a one-letter volume name). */
export function validObjectName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(value.trim());
}

// ------------------------------------------------------------------------------------- compose

export interface ComposeProject {
  name: string;
  rows: ContainerRow[];
  running: number;
  services: string[];
  /** The folder and files it was started from, as its labels name them (`""` when they do not). */
  projectDir: string;
  configFiles: string;
}

/** An engine's Compose projects, as its containers' labels tell them. The folder and files come from
 *  the first container that names them — Compose writes the same ones on every container. */
export function composeProjects(rows: ContainerRow[]): ComposeProject[] {
  const byName = new Map<string, ContainerRow[]>();
  for (const row of rows) {
    if (!row.project) continue;
    const members = byName.get(row.project);
    if (members) members.push(row);
    else byName.set(row.project, [row]);
  }
  return [...byName.entries()]
    .map(([name, members]) => {
      const named = members.find((r) => r.projectDir || r.configFiles);
      return {
        name,
        rows: members,
        running: members.filter((r) => r.state === "running").length,
        services: [...new Set(members.map((r) => r.service).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
        projectDir: named?.projectDir ?? "",
        configFiles: named?.configFiles ?? "",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What a project action takes besides its name — the options `act` passes to Compose. */
export function composeOptions(project: Pick<ComposeProject, "projectDir" | "configFiles">) {
  return { projectDir: project.projectDir, configFiles: project.configFiles };
}

/** The folder a file is in, whichever separator its path uses. */
export function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut < 0) return "";
  if (cut === 0) return path.slice(0, 1);
  // `C:\compose.yaml` is in `C:\`, not in `C:`.
  if (cut === 2 && /^[A-Za-z]:/.test(path)) return path.slice(0, 3);
  return path.slice(0, cut);
}

/** The last part of a path, a trailing separator ignored. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

/** A name Compose takes for `-p`: lower-case letters, digits, `-` and `_`, starting with a letter or digit. */
export const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]*$/;

/** The name Compose gives a project started from `dir` without `-p`: the folder's, lower-cased, with
 *  what it does not take dropped. `""` when nothing of it is usable — the caller asks for one. */
export function composeProjectName(dir: string): string {
  return baseName(dir)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[^a-z0-9]+/, "");
}

/** `path` relative to `base` when it is inside it — what a build's `-f` reads best as — else as it is. */
export function relativeTo(base: string, path: string): string {
  const root = base.replace(/[\\/]+$/, "");
  if (!root || !path.startsWith(root)) return path;
  const sep = path.charAt(root.length);
  return sep === "/" || sep === "\\" ? path.slice(root.length + 1) : path;
}

// ------------------------------------------------------------------------------------- networks

export interface NetworkFacts {
  subnets: string[];
  gateways: string[];
  internal: boolean | null;
  /** Who is attached and at which address — Docker lists them; Podman's inspect may not. */
  containers: { name: string; ip: string }[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): string => (typeof value === "string" ? value : "");

/** A network's addressing and members, out of its inspect document — Docker's `IPAM.Config` and
 *  `Containers`, or Podman's `subnets` and `containers`. `null` when the text is not one. */
export function networkFacts(text: string): NetworkFacts | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const net = Array.isArray(doc) ? doc[0] : doc;
  if (!isObject(net)) return null;
  const subnets: string[] = [];
  const gateways: string[] = [];
  const ipam = isObject(net.IPAM) && Array.isArray(net.IPAM.Config) ? net.IPAM.Config : [];
  for (const entry of [...ipam, ...(Array.isArray(net.subnets) ? net.subnets : [])]) {
    if (!isObject(entry)) continue;
    const subnet = strings(entry.Subnet) || strings(entry.subnet);
    const gateway = strings(entry.Gateway) || strings(entry.gateway);
    if (subnet) subnets.push(subnet);
    if (gateway) gateways.push(gateway);
  }
  const internal = typeof net.Internal === "boolean" ? net.Internal : typeof net.internal === "boolean" ? net.internal : null;
  const members = isObject(net.Containers) ? net.Containers : isObject(net.containers) ? net.containers : {};
  const containers = Object.values(members)
    .filter(isObject)
    .map((member) => {
      let ip = strings(member.IPv4Address);
      if (!ip && isObject(member.interfaces)) {
        // Podman: { interfaces: { eth0: { subnets: [{ ipnet: "10.88.0.2/16" }] } } }
        for (const nic of Object.values(member.interfaces)) {
          const first = isObject(nic) && Array.isArray(nic.subnets) ? nic.subnets.find(isObject) : undefined;
          if (first) {
            ip = strings(first.ipnet);
            break;
          }
        }
      }
      return { name: strings(member.Name) || strings(member.name), ip: ip.replace(/\/\d+$/, "") };
    })
    .filter((member) => member.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { subnets, gateways, internal, containers };
}

// ---------------------------------------------------------------------------------------- stats

/** The live sample for a row — the engine prints short ids, the list long ones. */
export function statsFor(stats: ContainerStats[], row: ContainerRow): ContainerStats | undefined {
  return stats.find((s) => s.id && (row.id.startsWith(s.id) || s.id.startsWith(row.id) || s.name === row.name));
}

/** The row a live sample belongs to, for opening it. */
export function rowOfStats(rows: ContainerRow[], sample: ContainerStats): ContainerRow | undefined {
  return rows.find((row) => !!sample.id && (row.id.startsWith(sample.id) || sample.id.startsWith(row.id) || sample.name === row.name));
}

/** The busiest few, by CPU or by memory. */
export function topByUsage(stats: ContainerStats[], by: "cpu" | "memory", limit = 5): ContainerStats[] {
  return [...stats].sort((a, b) => (by === "cpu" ? b.cpuPercent - a.cpuPercent : b.memUsage - a.memUsage)).slice(0, limit);
}
